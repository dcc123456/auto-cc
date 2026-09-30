/**
 * `jd.capture` 服务（spec 2.3-01 / 2.3-06 / 2.3-07 / 2.3-08 / 2.3-11）：把「搜一次」编排成一轮抓取。
 *
 * 为什么这一层不归适配器：适配器只知道「这个站点这一屏长什么样」，而「滚到什么时候停、
 * 哪些条还要去读详情、单条失败要不要继续」是本产品的策略，换平台也不变。写在适配器里就等于
 * 每个平台抄一遍（AGENTS.md §2.2）。
 *
 * 两阶段是**必需**的，不是风格：`detail()` 会把视图导航到详情页，列表页就没了，所以滚动收集（阶段 A）
 * 必须整体先于逐条读详情（阶段 B）。顺序反了会在一半的位置重新打开搜索页，前功尽弃。
 *
 * 全程只读：一行 `entitlement.gate` 都不进（AGENTS.md §7.3 管的是外发），并且把本轮前后的账本行数
 * 一起带回读数（spec 2.3-11）——抓取若哪天不小心记了账，界面会直接显示两个数不相等。
 */
import {
  AppError,
  assertNotYielded,
  Service,
  asApp,
  executorRegistryOf,
  sleep,
  type Context,
  type WorkflowNodeExecutor,
} from '@auto-cc/core';
import type { CaptureFailureView, CaptureRunView, CaptureStatusView, JobSearchCriteriaView } from '@auto-cc/shared';
import type { BrowserPageService, JobDetail, JobSummary, PlatformRegistryService } from '@auto-cc/plugin-browser';
import type { UsageLedgerService } from '@auto-cc/plugin-entitlement';
import { z } from 'zod';
import { parsePostedAt, parseSalary } from './normalize.js';
import type { JdStoreService, JobDraft } from './jd-store.js';

/** 抓取用的目标平台与节奏：默认 BOSS，换平台只改 `cordis.yml`，本服务不写死。 */
export const jdCaptureSchema = z.strictObject({
  platform: z.string().min(1).default('boss'),
  /** 一次运行攒够多少条就停（spec 2.3-06 的「达目标条数」）。 */
  targetCount: z.number().int().min(1).max(200).default(20),
  /** 最多滚读几轮（「不死循环」的硬上限）。 */
  maxRounds: z.number().int().min(1).max(50).default(8),
  /** 每轮之间、每条详情之间的停顿（毫秒），给页面装载留时间，也是人类化节流的第一层。 */
  roundPauseMs: z.number().int().min(0).max(30_000).default(300),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type JdCaptureConfig = z.output<typeof jdCaptureSchema>;

/**
 * 本服务向 `workflow.executors` 登记时用的节点 `kind`（spec 2.4-01）。
 * 写在这里而不是 `workflow` 包：登记由有能力的一侧发起，`boss-basic` 计划里的 `jd.capture` 就靠这一行对上号。
 */
const JD_CAPTURE_KIND = 'jd.capture';

/** 本服务对 `platform.registry` 的诉求：按名字拿到适配器。 */
type RegistryGet = Pick<PlatformRegistryService, 'get'>;

/** 本服务对 `browser.page` 的诉求：只需要那一下滚动。 */
type PageScroll = Pick<BrowserPageService, 'scroll'>;

/** 本服务对 `jd.store` 的诉求：写一行、数一行。 */
type StoreWrite = Pick<JdStoreService, 'upsert' | 'count'>;

/**
 * 把一条列表页摘要拍成入库草稿（详情字段留空，等阶段 B 补）。
 * @param summary 适配器从一屏卡片读到的摘要
 * @returns 只有列表字段的 `JobDraft`；薪资在这里归一化，原文另存一列
 */
export function draftFromSummary(summary: JobSummary): JobDraft {
  return {
    platform: summary.platform,
    jobId: summary.jobId,
    title: summary.title,
    company: summary.company,
    salaryText: summary.salaryText,
    salary: summary.salaryText ? parseSalary(summary.salaryText) : null,
    city: summary.city,
    experience: summary.experience,
    education: summary.education,
    description: '',
    requirements: [],
    postedText: '',
    postedAt: null,
    sourceUrl: summary.detailUrl,
    capturedAt: summary.capturedAt,
    detailCapturedAt: null,
  };
}

/**
 * 把一条详情页读数拍成入库草稿（与摘要草稿同一套列表字段，再覆盖上详情读到的那几样）。
 * @param detail 适配器读完详情页得到的实体
 * @param nowMs 归一化发布时间的基准毫秒时间戳（「3 天前」要减在这上面）
 * @returns 带正文与任职要求的 `JobDraft`，`detailCapturedAt` 即本次读数时间
 */
export function draftFromDetail(detail: JobDetail, nowMs: number): JobDraft {
  return {
    ...draftFromSummary(detail.summary),
    description: detail.description,
    requirements: detail.requirements,
    postedText: detail.postedText,
    postedAt: parsePostedAt(detail.postedText, nowMs),
    detailCapturedAt: nowMs,
  };
}

/**
 * 把一次失败压成界面可读的一行原因。
 * @param error 捕获到的未知异常（页面脚本失败、契约拒绝都可能是别的形状）
 * @returns `Error` 取 `message`，其余取字符串形式；永不抛出
 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 停止判定的三种结局，界面据此说明「为什么停了」。 */
type StoppedBy = CaptureRunView['stoppedBy'];
export class JdCaptureService extends Service {
  static provide = 'jd.capture';
  static Config = jdCaptureSchema;
  static inject = ['platform.registry', 'browser.page', 'jd.store', 'usage.ledger'];

  private lastRun: CaptureRunView | null = null;

  constructor(
    ctx: Context,
    private readonly config: JdCaptureConfig,
  ) {
    super(ctx, 'jd.capture');
  }

  private get registry(): RegistryGet {
    return asApp(this.ctx)['platform.registry'];
  }

  private get page(): PageScroll {
    return asApp(this.ctx)['browser.page'];
  }

  private get store(): StoreWrite {
    return asApp(this.ctx)['jd.store'];
  }

  private get ledger(): Pick<UsageLedgerService, 'count'> {
    return asApp(this.ctx)['usage.ledger'];
  }

  /**
   * 发一条进度事件（spec 2.3-07）：面板的「第 N 轮 · 已入库 M 条」只由它推进，不靠轮询。
   * @param phase 列表轮次 / 逐条详情 / 收尾
   * @param round 已完成的轮数
   * @param containers 至今读到过的卡片数
   * @param stored 至今写入或更新的行数
   * @param target 本次的目标条数
   * @param currentTitle 阶段 B 正在读的岗位标题；阶段 A 为空串
   */
  private progress(
    phase: 'listing' | 'detail' | 'done',
    round: number,
    containers: number,
    stored: number,
    target: number,
    currentTitle: string,
  ): void {
    this.ctx.emit('jd/progress', { phase, round, containers, stored, target, currentTitle, at: Date.now() });
  }

  /**
   * 跑一轮抓取：搜索 → 滚动收集列表 → 逐条读详情 → 全部落库。
   *
   * 单条详情读失败只记进 `skipped`（spec 2.3-08），整轮继续；列表整页读不到不报错，
   * 它在阶段 A 就表现为「本轮零新增」，于是第二圈的无新内容判定把它停下来，不会空转到上限。
   * @param criteria 搜索条件（关键词必填，`limit` 在配置目标之内覆盖本次目标条数）
   * @param signal 协作让出信号（spec 2.4-07）：工作流暂停或被卸载时在中途收手；不传则一路跑完
   * @returns 本轮结局：轮数、入库行数、跳过明细、停止原因，外加本轮前后的账本行数
   * @throws 目标平台未登记时由 `platform.registry` 抛 `PLATFORM_NOT_REGISTERED`；关键词为空由适配器抛 `INVALID_ARGUMENT`；
   *         让出时抛 `WORKFLOW_STEP_FAILED`——runner 先看信号，因此这一条记为让出而不是节点失败（spec 2.4-09）
   */
  run = async (criteria: JobSearchCriteriaView, signal?: AbortSignal): Promise<CaptureRunView> => {
    const adapter = this.registry.get(this.config.platform);
    const target =
      criteria.limit && criteria.limit > 0
        ? Math.min(criteria.limit, this.config.targetCount)
        : this.config.targetCount;
    const ledgerRowsBefore = this.ledger.count();
    const collected = new Map<string, JobSummary>();
    const needsDetail: JobSummary[] = [];
    const touched = new Set<number>();
    const skipped: CaptureFailureView[] = [];
    let containers = 0;
    let rounds = 0;
    let stoppedBy: StoppedBy = 'max-rounds';

    await adapter.openSearch(criteria);
    while (rounds < this.config.maxRounds) {
      assertNotYielded(signal, JD_CAPTURE_KIND, '抓取');
      rounds += 1;
      const sizeBefore = collected.size;
      for (const summary of await adapter.readListing()) {
        containers += 1;
        // 无限滚动的页面把上一屏的卡片留在 DOM 里，同一条会被读到第二次；去重键用平台的 jobId。
        if (collected.has(summary.jobId)) continue;
        collected.set(summary.jobId, summary);
        const result = this.store.upsert(draftFromSummary(summary));
        touched.add(result.id);
        // 上一轮已经读到过详情的行不再跑详情页：重复抓取只补列表字段（spec 2.3-04 的实际收益）。
        if (!result.hasDetail) needsDetail.push(summary);
      }
      this.progress('listing', rounds, containers, touched.size, target, '');
      if (collected.size >= target) {
        stoppedBy = 'target-count';
        break;
      }
      if (collected.size === sizeBefore) {
        stoppedBy = 'no-new-content';
        break;
      }
      // 滚动是加载的扳机：无限滚动站点靠它长出下一屏，翻页站点靠它触发「加载更多」。
      await this.page.scroll();
      await sleep(this.config.roundPauseMs, signal);
    }

    for (const summary of needsDetail) {
      assertNotYielded(signal, JD_CAPTURE_KIND, '抓取');
      this.progress('detail', rounds, containers, touched.size, target, summary.title);
      try {
        const detail = await adapter.detail(summary.jobId);
        touched.add(this.store.upsert(draftFromDetail(detail, Date.now())).id);
      } catch (error) {
        // 一条读不到不等于整轮失败：把原因留给界面，继续下一条（spec 2.3-08）。
        skipped.push({ title: summary.title, sourceUrl: summary.detailUrl, reason: reasonOf(error) });
        continue;
      }
      await sleep(this.config.roundPauseMs, signal);
    }

    const run: CaptureRunView = {
      platform: adapter.meta.id,
      keyword: criteria.keyword,
      city: criteria.city ?? null,
      rounds,
      containers,
      stored: touched.size,
      skipped,
      stoppedBy,
      total: this.store.count(),
      finishedAt: Date.now(),
      ledgerRowsBefore,
      ledgerRowsAfter: this.ledger.count(),
    };
    this.lastRun = run;
    this.progress('done', rounds, containers, run.stored, target, '');
    this.ctx.logger.info(
      `JD 抓取结束：${run.platform}「${run.keyword}」滚 ${String(rounds)} 轮 · 读到 ${String(containers)} 张卡 · 入库 ${String(run.stored)} 行 · 跳过 ${String(skipped.length)} 条 · 停在 ${run.stoppedBy}`,
    );
    return run;
  };

  /**
   * 当期配置 + 最近一次运行（面板与验收脚本共用的一份读数）。
   * @returns 目标条数、轮数上限、间隔，以及最近一次运行；还没跑过时 `lastRun` 为 null
   */
  status = (): CaptureStatusView => ({
    targetCount: this.config.targetCount,
    maxRounds: this.config.maxRounds,
    roundPauseMs: this.config.roundPauseMs,
    lastRun: this.lastRun,
  });

  /**
   * 作为工作流节点（`kind: jd.capture`）时的执行函数（spec 2.4-01）。
   *
   * 参数名按**计划的口径**读（`query`/`city`/`target`），不强迫计划作者记住本服务的内部字段名；
   * 翻译只在这一处发生，`run()` 的形状与界面入口共用同一份，没有第二条路径（AGENTS.md §2.5）。
   * @param invocation 节点执行输入：参数从 `spec.params` 来，让出信号从 `signal` 来
   * @throws 缺 `query` 时 `INVALID_ARGUMENT`；抓取自身的失败照 `run()` 的语义向上抛，由 runner 判退避还是判失败
   */
  private executor: WorkflowNodeExecutor = async ({ spec, signal }) => {
    const query = spec.params.query;
    if (typeof query !== 'string' || query === '') {
      throw new AppError('INVALID_ARGUMENT', `节点 ${spec.id} 缺少参数 query，不知道要搜什么`, JD_CAPTURE_KIND, {
        nodeId: spec.id,
      });
    }
    const criteria: JobSearchCriteriaView = { keyword: query };
    if (typeof spec.params.city === 'string') criteria.city = spec.params.city;
    if (typeof spec.params.target === 'number') criteria.limit = spec.params.target;
    await this.run(criteria, signal);
  };

  [Service.init](): void {
    // 登记处是可选依赖：工作流没装时抓取本身照常能用（界面「搜索并入库」不经过它），只是没有节点可跑。
    const registry = executorRegistryOf(this.ctx);
    if (registry) {
      registry.register(JD_CAPTURE_KIND, this.executor);
      // 卸载时摘回登记：留下一个指向已销毁实例的函数，下一次点「跑一遍」得到的会是无法解释的错误。
      this.ctx.effect(() => () => registry.unregister(JD_CAPTURE_KIND));
    }
    this.ctx.logger.info(
      `JD 抓取编排就绪：平台 ${this.config.platform} · 目标 ${String(this.config.targetCount)} 条 · 上限 ${String(this.config.maxRounds)} 轮 · 间隔 ${String(this.config.roundPauseMs)}ms · 节点执行器${registry ? `已登记 ${JD_CAPTURE_KIND}` : '未登记（工作流未挂载）'}`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'jd.capture': JdCaptureService;
  }
}
