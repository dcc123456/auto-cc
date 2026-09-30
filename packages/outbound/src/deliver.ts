/**
 * `outbound.deliver` 服务（spec 2.6-01 / 02 / 03 / 05 / 06 / 07）：简历投递的唯一编排入口。
 *
 * 它按 plan §13.3 第 3 条切成两段：`stage` 只做**离开 app 之前**的准备工作（现问渠道、校验文件、
 * 算 hash、查幂等），不发、不落账、不进闸门；`commit` 才走打招呼那条顺序——额度先查后等 →
 * 频控（以账本最近一条 `deliver` 为钟）→ 审批（按档位）→ 渠道发送 → 页面回读 → `gate.perform`。
 * 切成两段是因为「仅辅助」档（2.6-06）要的正是这个中间态：界面上摆出「要递什么」但一个字都不发。
 *
 * 与打招呼的两处实质差别：
 * ① 多一道**页面二次校验**——库里那条 JD 是抓取那一刻的快照，只有页面能回答「现在还在不在收」，
 *    所以校验发生在适配器里（`DELIVER_TARGET_OFFLINE`），不在这里；
 * ② 多一个**等人**的环节——档位 `semi`（默认）在发送前必须有人在 app 内点确认，超时按拒绝。
 *    这台状态机做在本服务里而不是界面里：投递有两个入口（工作流节点、界面单发），
 *    把「等人」做在界面那一侧，第二个入口必然漏一套（AGENTS.md §2.5）。
 *
 * 和打招呼一样，它**不认识任何平台也不保存任何平台的手**：每次现向 `platform.registry` 问渠道
 * （plan §12.13 的教训——自己持表会被配置热重载清空）。
 */
import {
  AppError,
  asApp,
  assertNotYielded,
  deliverChannelsOf,
  executorRegistryOf,
  Service,
  sleep,
  type Context,
  type ResumeAttachment,
  type ResumeDeliveryChannel,
  type WorkflowNodeExecutor,
} from '@auto-cc/core';
import type {
  DeliverApprovalView,
  DeliverAttachmentView,
  DeliverReceiptView,
  DeliverRequestView,
} from '@auto-cc/shared';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** 额度键与账本动作名（`entitlement.gate` 按它数日上限，spec 2.6-02 / 03）。 */
export const DELIVER_ACTION = 'deliver';

/** 工作流节点名（plan §13.3 第 1 条）；与 `greeting.send` 同一命名口径。 */
export const DELIVER_NODE_KIND = 'resume.deliver';

/** 投递档位：直接复用 `AutonomyLevel`，不新造枚举（plan §13.3 第 3 条）。 */
const autonomyLevelSchema = z.enum(['suggest', 'semi', 'auto']);

/**
 * `suggest` 与 `auto` 之间的那一档是默认值：2.6 的整条主线就是「投递前问一句人」（spec 2.6-01），
 * 默认值一旦是 `auto`，装好 app 不做任何设置就会往真实站点上自动递简历。
 */
export const deliverSchema = z.strictObject({
  /** 当前档位（spec 2.6-01 / 06）：只准备 / 确认后发 / 免审批发 */
  autonomy: autonomyLevelSchema.default('semi'),
  /** 等人确认的时长上限（毫秒）；到点按**拒绝**处理——没人表态永远不等于同意 */
  approveTimeoutMs: z.number().int().min(0).max(3_600_000).default(120_000),
  /** 简历大小上限（字节）：超了连 stage 都过不去，不去页面上赌站点会不会收 */
  maxResumeBytes: z.number().int().min(1024).max(52_428_800).default(5_242_880),
  /** 默认简历路径；请求里没带 `filePath` 时用它（P3 之前的临时入口，plan §13.5） */
  resumeFile: z.string().min(1).optional(),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type DeliverConfig = z.output<typeof deliverSchema>;

/**
 * 投递请求的入站校验（渲染层与计划都是不可信来源，AGENTS.md §2.6）。
 *
 * `title` / `company` 只服务于确认卡片：JD 行的查询面还没接（plan §13.7 第 1 条），
 * 所以「递给谁」这句话由调用方带进来，而不是这里去库里猜。
 */
const deliverRequestSchema = z.strictObject({
  platform: z.string().min(1),
  jobId: z.string().min(1),
  filePath: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  company: z.string().min(1).optional(),
  workflowRunId: z.string().min(1).nullish(),
  nowMs: z.number().int().positive().optional(),
});

/**
 * 一次已备好、尚未发送的投递（`stage` 的产物，`commit` 的输入）。
 *
 * 它是**值对象**而不是句柄：里面没有任何指向页面的引用，所以「stage 完先去干别的、回来再 commit」
 * 不会因为适配器换人而失效——commit 时按 `platform` 现问渠道（同 plan §12.13）。
 */
export type StagedDelivery = {
  platform: string;
  jobId: string;
  title: string;
  company: string;
  attachment: ResumeAttachment;
  workflowRunId: string | null;
  /** 判定与落账的基准毫秒，冻结在 stage 那一刻：commit 侧不再读当前时间，等间隔才算得准 */
  nowMs: number;
  /** 账本 `source`：`resume:<sha256 前 12 位>@<文件名>`（spec 2.6-05，复用已有的 `source` 列） */
  source: string;
};

/** 一张在等的确认单。`settle` 由界面按钮、超时或让出三方之一调用，且只生效一次。 */
type PendingApproval = {
  view: DeliverApprovalView;
  settle: (approved: boolean) => void;
};

/** 一次确认的三种定局。 */
type ApprovalSettlement = { kind: 'approved' } | { kind: 'denied'; reason: string } | { kind: 'aborted' };

/**
 * 把节点参数里的字符串读出来（缺键或非字符串都返回 null，由调用方报缺参数）。
 * @param value `spec.params` 里的原始值（声明值类型是 string/number/boolean）
 * @returns 非空字符串本身，否则 null
 */
function paramString(value: string | number | boolean | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 附件摆在界面上的那三样（不含路径，理由见 `DeliverAttachmentView`）。
 * @param attachment 完整的附件读数
 * @returns 展示用的窄化视图
 */
function attachmentView(attachment: ResumeAttachment): DeliverAttachmentView {
  return { fileName: attachment.fileName, sizeBytes: attachment.sizeBytes, sha256: attachment.sha256 };
}

export class OutboundDeliverService extends Service {
  static provide = 'outbound.deliver';
  static Config = deliverSchema;
  // 闸门/账本/频控与打招呼同源；`platform.registry` 是硬依赖——没有平台层就没有递简历的手。
  // 与打招呼的差别是不需要 `outbound.script`：2.6-b 只递文件，不随信正文（plan §13.7 第 2 条）。
  static inject = ['entitlement.gate', 'usage.ledger', 'outbound.throttle', 'platform.registry'];

  /**
   * 在等的确认单。
   *
   * 为什么是内存 Map 而不是库里一张表：它是一次**等待**的状态，不是事实记录——投递的真相永远在
   * 账本那一行里（成功才有行）。做成表就要处理「进程死了谁把 in-flight 的单子收掉」，
   * 而超时按拒绝这条性质本来就把所有悬挂兜住了（plan §13.3 第 2 条）。
   */
  private readonly approvals = new Map<string, PendingApproval>();

  constructor(
    ctx: Context,
    private readonly config: DeliverConfig,
  ) {
    super(ctx, 'outbound.deliver');
  }

  /**
   * 闸门句柄：与打招呼共用同一个 `entitlement.gate`，只是动作键换成 `deliver`（spec 2.6-02）。
   * @returns 额度闸门服务实例
   */
  private get gate() {
    return asApp(this.ctx)['entitlement.gate'];
  }

  /**
   * 账本句柄：幂等判据与频控的钟都从它读，不在本服务里另存一份「上次什么时候发的」（§2.7）。
   * @returns 用量账本服务实例
   */
  private get ledger() {
    return asApp(this.ctx)['usage.ledger'];
  }

  /**
   * 准备好一次投递：现问渠道 → 校验文件 → 算 hash → 查幂等（spec 2.6-06 要的中间态）。
   * @param raw 请求（见 `deliverRequestSchema`）；`filePath` 省略时取配置里的 `resumeFile`
   * @returns 已备好的投递（含附件三要素与 `source`），**尚未发出、尚未进闸门、尚未落账**
   *          ——同步返回：这一段没有一处异步（读文件与算 hash 都是同步 API），所以不假装是 Promise
   * @throws `INVALID_ARGUMENT`（入参不合法、没给路径、文件读不出、不是 pdf、超过大小上限）、
   *         `OUTBOUND_CHANNEL_MISSING`（该平台没有带 sendResume 的适配器）、
   *         `OUTBOUND_ALREADY_SENT`（同 run 同 target 已经递过一次）
   */
  stage = (raw: unknown): StagedDelivery => {
    const parsed = deliverRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `投递请求不合法：${parsed.error.issues[0]?.message ?? ''}`,
        'outbound.deliver',
      );
    }
    const { platform, jobId, title, company } = parsed.data;
    const nowMs = parsed.data.nowMs ?? Date.now();
    const runId = parsed.data.workflowRunId ?? null;
    const filePath = parsed.data.filePath ?? this.config.resumeFile;
    if (!filePath) {
      throw new AppError(
        'INVALID_ARGUMENT',
        '没有要投递的简历文件：请求里没带 filePath，配置里也没设 resumeFile',
        'outbound.deliver',
        { jobId },
      );
    }

    // 渠道在准备工作里就问（同打招呼的理由）：平台名写错要在**读文件、算 hash 之前**就失败，
    // 而不是让人在界面上确认完一份永远递不出去的简历。
    const sources = deliverChannelsOf(this.ctx);
    if (!sources?.deliverChannel(platform)) {
      throw new AppError('OUTBOUND_CHANNEL_MISSING', `平台 ${platform} 现在没有可用的投递渠道`, 'outbound.deliver', {
        platform,
        deliverable: sources?.deliverablePlatforms() ?? [],
      });
    }
    const attachment = this.readAttachment(filePath);

    // 幂等判据与打招呼同一条：(action, target, run) 有没有落成过一行（spec 2.5-13 的口径搬到投递）。
    if (this.ledger.countFor(DELIVER_ACTION, jobId, runId) > 0) {
      throw new AppError(
        'OUTBOUND_ALREADY_SENT',
        `目标 ${jobId} 在本次运行里已经递过简历，不再重复发送`,
        'outbound.deliver',
        { jobId, workflowRunId: runId },
      );
    }
    return {
      platform,
      jobId,
      title: title ?? '',
      company: company ?? '',
      attachment,
      workflowRunId: runId,
      nowMs,
      // spec 2.6-05：hash 取前 12 位就够对上了——完整的 64 位串在账本里没人读，而 3.7 的 diff 按前缀能join。
      source: `resume:${attachment.sha256.slice(0, 12)}@${attachment.fileName}`,
    };
  };

  /**
   * 读并校验那份简历文件（spec 2.6-06 的「校验文件」半边）。
   * @param filePath 简历的绝对或相对路径
   * @returns 附件读数：路径、文件名、字节数、整份文件的 sha256（十六进制小写）
   * @throws `INVALID_ARGUMENT`——读不出（不存在/没权限/是个目录）、不是 `.pdf`、或超过 `maxResumeBytes`。
   *         三种都在这里合成一个码是有意的：对调用方来说它们都是「这份文件现在不能递」，
   *         区别只在 `message` 与 `details`，不值得为它开三个错误码
   */
  private readAttachment(filePath: string): ResumeAttachment {
    let sizeBytes: number;
    try {
      const stats = statSync(filePath);
      if (!stats.isFile()) throw new Error('不是一个文件');
      sizeBytes = stats.size;
    } catch (error) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `简历文件读不出：${filePath}（${error instanceof Error ? error.message : String(error)}）`,
        'outbound.deliver',
        { filePath },
      );
    }
    if (path.extname(filePath).toLowerCase() !== '.pdf') {
      throw new AppError('INVALID_ARGUMENT', `简历只支持 pdf，给的是 ${filePath}`, 'outbound.deliver', { filePath });
    }
    if (sizeBytes > this.config.maxResumeBytes) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `简历 ${String(sizeBytes)} 字节，超过上限 ${String(this.config.maxResumeBytes)} 字节`,
        'outbound.deliver',
        { filePath, sizeBytes },
      );
    }
    let content: Buffer;
    try {
      content = readFileSync(filePath);
    } catch (error) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `简历文件读取失败：${filePath}（${error instanceof Error ? error.message : String(error)}）`,
        'outbound.deliver',
        { filePath },
      );
    }
    return {
      path: filePath,
      fileName: path.basename(filePath),
      sizeBytes,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  }

  /**
   * 把一次已备好的投递真正发出去（spec 2.6-01 / 02 / 03 / 07 的落地半边）。
   *
   * 顺序与打招呼逐字对齐，中间只多一步审批：额度**先查后等**（到量即停，不该白等一个频控间隔）→
   * 频控 → 审批（按档位）→ 发送 → 页面回读 → `gate.perform` 落账。
   * @param staged `stage` 的产物
   * @param signal 让出信号，工作流节点路径用它响应暂停；界面路径传 undefined
   * @returns 投递回执（`committed` 恒为 true——没发出去一律以错误上浮）
   * @throws `QUOTA_EXCEEDED`（日额度到量，带剩余额度）、`OUTBOUND_APPROVAL_DENIED`（被拒或超时，
   *         此时页面动作次数为零、不落账不扣额度）、`DELIVER_TARGET_OFFLINE`（页面说这个岗位不收了）、
   *         `OUTBOUND_NOT_DELIVERED`（页面回读没确认，此时不落账）、
   *         `WORKFLOW_STEP_FAILED`（等待期间工作流让出）、
   *         `OUTBOUND_CHANNEL_MISSING`（stage 之后适配器被摘掉）
   */
  commit = async (staged: StagedDelivery, signal?: AbortSignal): Promise<DeliverReceiptView> => {
    const { platform, jobId, workflowRunId, nowMs, source, attachment } = staged;

    const decision = this.gate.check(DELIVER_ACTION, { nowMs });
    if (!decision.allowed) {
      throw new AppError(
        'QUOTA_EXCEEDED',
        decision.reason ?? `动作 ${DELIVER_ACTION} 的额度已用完`,
        'outbound.deliver',
        { action: DELIVER_ACTION, remaining: decision.remaining },
      );
    }

    // 频控的钟是账本里最近一条 deliver，与打招呼各数各的间隔（两套动作互不背锅）。
    const gap = asApp(this.ctx)['outbound.throttle'].nextGapMs();
    const lastSentAt = this.ledger.latestActionTs(DELIVER_ACTION);
    let waitedMs = 0;
    if (lastSentAt !== null) {
      const remaining = lastSentAt + gap - nowMs;
      if (remaining > 0) {
        await sleep(remaining, signal);
        waitedMs = remaining;
      }
    }
    // 让出检查点必须落在**发送之前**（spec 2.4-07）：`sleep` 在 abort 时是正常返回的，
    // 不在这里问一句，被暂停的那一步仍会把简历递出去。
    assertNotYielded(signal, 'outbound.deliver', '投递简历');

    if (this.config.autonomy !== 'auto') {
      await this.awaitApproval(staged, waitedMs, signal);
    }

    // 审批可能等了很久，渠道到这一刻才最后确认一次：中间适配器被摘掉过就要以「没有渠道」失败，
    // 而不是拿一只已销毁的实例往页面上点。
    const channel: ResumeDeliveryChannel | null = deliverChannelsOf(this.ctx)?.deliverChannel(platform) ?? null;
    if (!channel) {
      throw new AppError('OUTBOUND_CHANNEL_MISSING', `平台 ${platform} 现在没有可用的投递渠道`, 'outbound.deliver', {
        platform,
      });
    }

    const { value, ledgerId } = await this.gate.perform(
      DELIVER_ACTION,
      { targetId: jobId, workflowRunId, nowMs: nowMs + waitedMs, source },
      async () => {
        const outcome = await channel.send(jobId, attachment);
        // 页面没确认递出去就不该有账：闸门只在 task 成功后落账，抛在这里正好复用那条性质（spec 2.6-03）。
        if (!outcome.sent) {
          throw new AppError('OUTBOUND_NOT_DELIVERED', outcome.reason, 'outbound.deliver', { jobId });
        }
        return outcome.reason;
      },
    );
    this.ctx.logger.info(
      `简历已投递并落账：目标 ${jobId} · 文件 ${attachment.fileName}（${String(attachment.sizeBytes)} 字节）· 等待 ${String(waitedMs)}ms · 来源 ${source} · 账本行 ${String(ledgerId)}`,
    );
    return {
      platform,
      jobId,
      title: staged.title,
      company: staged.company,
      attachment: attachmentView(attachment),
      reason: value,
      ledgerId,
      waitedMs,
      source,
      committed: true,
    };
  };

  /**
   * 投递的唯一入口：`stage` + 按档位决定要不要 `commit`（spec 2.6-01 / 06）。
   * @param raw 请求，同 `stage`
   * @param signal 让出信号，透传给 `commit`
   * @returns 回执；档位为 `suggest` 时 `committed:false`、`ledgerId:null`，**账本一行都不增**
   * @throws 同 `stage` 与 `commit`；`semi` 档等人确认期间的三种定局见 `commit`
   */
  perform = async (raw: unknown, signal?: AbortSignal): Promise<DeliverReceiptView> => {
    const staged = this.stage(raw);
    if (this.config.autonomy === 'suggest') {
      // 「仅辅助」的意思就是到此为止：界面上摆出要递什么，那一下由用户自己点（spec 2.6-06）。
      return {
        platform: staged.platform,
        jobId: staged.jobId,
        title: staged.title,
        company: staged.company,
        attachment: attachmentView(staged.attachment),
        reason: `档位 suggest：已备好 ${staged.attachment.fileName}，未发送`,
        ledgerId: null,
        waitedMs: 0,
        source: staged.source,
        committed: false,
      };
    }
    return this.commit(staged, signal);
  };

  /**
   * 当前在等的确认单（spec 2.6-01 的「刷新面板不丢」半边）。
   *
   * 界面每次重渲染都现读一遍，而不是靠订阅事件补齐状态：事件只负责「此刻提醒一下」，
   * 这份读数负责「错过了也还在」。
   * @returns 按申请顺序的待确认单；一张都没有是空数组
   */
  pending = (): DeliverApprovalView[] => [...this.approvals.values()].map((entry) => entry.view);

  /**
   * 界面上那两个按钮打到这里（spec 2.6-01）。
   * @param approvalId 确认单 id，来自 `pending()` 或 `outbound/approval-requested` 事件
   * @param approved 用户是否点了确认
   * @returns 这张单子的岗位与文件三要素，让界面把「批了哪一份」画进结果卡片，不必自己缓存
   * @throws `APPROVAL_NOT_FOUND`——单子不存在（已定局、已超时，或服务在等待期间被重建过）。
   *         这里是 fail-closed：查不到就报结构化失败，绝不因为「找不到对应的那份」而放行任何一次投递
   */
  resolveApproval = (approvalId: string, approved: boolean): DeliverApprovalView => {
    const entry = this.approvals.get(approvalId);
    if (!entry) {
      throw new AppError('APPROVAL_NOT_FOUND', `确认单 ${approvalId} 已经不在等待中`, 'outbound.deliver', {
        approvalId,
        pending: [...this.approvals.keys()],
      });
    }
    entry.settle(approved);
    return entry.view;
  };

  /**
   * 挂起等人确认，并把这张单子登记进 `pending()`。
   * @param staged 待投递读数
   * @param waitedMs 为满足频控已经等了多久——只为了把确认单的展示时间算准，不参与任何判据
   * @param signal 让出信号：暂停要能立刻打断等待，且**不发送、不落账**（与打招呼的让出语义逐字一致）
   * @returns 确认通过时 resolve；被拒、超时或让出时以结构化错误 reject
   * @throws `OUTBOUND_APPROVAL_DENIED`（拒绝或超时）、`WORKFLOW_STEP_FAILED`（让出）
   */
  private awaitApproval(staged: StagedDelivery, waitedMs: number, signal?: AbortSignal): Promise<void> {
    const approvalId = randomUUID();
    const requestedAt = Date.now();
    const timeoutMs = this.config.approveTimeoutMs;
    return new Promise<void>((resolve, reject) => {
      const settle = (outcome: ApprovalSettlement): void => {
        if (!this.approvals.has(approvalId)) return; // 已经定局过一次（超时/让出/重复点击）：后到的表态不算数
        clearTimeout(timer);
        this.approvals.delete(approvalId);
        signal?.removeEventListener('abort', onAbort);
        if (outcome.kind === 'approved') {
          resolve();
          return;
        }
        if (outcome.kind === 'aborted') {
          reject(
            new AppError('WORKFLOW_STEP_FAILED', '工作流已让出，投递等待中止，未发送', 'outbound.deliver', {
              jobId: staged.jobId,
            }),
          );
          return;
        }
        reject(
          new AppError('OUTBOUND_APPROVAL_DENIED', `未投递：${outcome.reason}`, 'outbound.deliver', {
            approvalId,
            jobId: staged.jobId,
          }),
        );
      };
      const onAbort = (): void => settle({ kind: 'aborted' });
      const view: DeliverApprovalView = {
        approvalId,
        platform: staged.platform,
        jobId: staged.jobId,
        title: staged.title,
        company: staged.company,
        attachment: attachmentView(staged.attachment),
        requestedAt,
        expiresAt: requestedAt + timeoutMs,
      };
      this.approvals.set(approvalId, {
        view,
        // 界面那句「批 / 不批」定成什么；等待方不看界面，只看这个布尔。
        settle: (approved: boolean) =>
          settle(
            approved
              ? { kind: 'approved' }
              : { kind: 'denied', reason: `用户在确认卡片上点了拒绝（目标 ${staged.jobId}）` },
          ),
      });
      // 先登记再发事件：界面收到提醒后立刻 `pending()` 也必须能读回这张单子（spec 2.6-01）。
      this.ctx.emit('outbound/approval-requested', view);
      // 定时器与 `settle` 互相引用，但都不在定义时求值：超时回调只可能在下面这几行跑完之后才 fire。
      const timer = setTimeout(() => {
        settle({ kind: 'denied', reason: `等待确认超过 ${String(timeoutMs)}ms，按拒绝处理` });
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      // 让出可能在这之前就已经发生了（暂停与投递撞在同一拍）。
      if (signal?.aborted) settle({ kind: 'aborted' });
      this.ctx.logger.info(
        `等待投递确认：单 ${approvalId} · 目标 ${staged.jobId} · 文件 ${staged.attachment.fileName} · 频控已等待 ${String(waitedMs)}ms`,
      );
    });
  }

  /**
   * 作为工作流节点（`kind: resume.deliver`）时的执行函数。
   *
   * 参数名按计划口径读：`platform`/`job` 定位目标，`file` 是简历路径（省略则用配置的 `resumeFile`），
   * `title`/`company` 只进确认卡片。节点声明要 `effect: 'outbound'` + `retryTimes: 0`
   * （spec 2.6-07 的「已下架就不再试」正是靠后者落的，plan §13.4 第 3 条）。
   * @param invocation 节点执行输入：`runId` 参与幂等键，参数从 `spec.params` 来，让出信号从 `signal` 来
   * @throws 缺 `platform` 或 `job` 时 `INVALID_ARGUMENT`；其余失败语义同 `perform`
   */
  executeNode: WorkflowNodeExecutor = async ({ runId, spec, signal }) => {
    const platform = paramString(spec.params.platform);
    const jobId = paramString(spec.params.job);
    if (!platform || !jobId) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `节点 ${spec.id} 缺少参数${!platform ? ' platform' : ''}${!jobId ? ' job' : ''}，不知道该把简历递给谁`,
        DELIVER_NODE_KIND,
        { nodeId: spec.id },
      );
    }
    const request: DeliverRequestView = {
      platform,
      jobId,
      filePath: paramString(spec.params.file) ?? undefined,
      title: paramString(spec.params.title) ?? undefined,
      company: paramString(spec.params.company) ?? undefined,
      workflowRunId: runId,
    };
    const receipt = await this.perform(request, signal);
    if (!receipt.committed) {
      // 档位是 suggest 时节点**不能算这一步成功**：这一步什么都没做，记成完成就等于把
      // 「只准备」悄悄变成了「已投递」，断点续跑也就不会再回来跑它。
      throw new AppError(
        'OUTBOUND_APPROVAL_DENIED',
        `档位 suggest 不执行投递节点 ${spec.id}：只准备未发送（用界面上的确认卡片手动完成）`,
        DELIVER_NODE_KIND,
        { nodeId: spec.id },
      );
    }
  };

  [Service.init](): void {
    // 登记处是可选依赖：工作流没装时投递照样能从界面单次触发，只是没有节点可跑。
    const registry = executorRegistryOf(this.ctx);
    if (registry) {
      registry.register(DELIVER_NODE_KIND, this.executeNode);
      // 卸载时摘回登记：留下指向已销毁实例的函数，下一次跑工作流会得到无法解释的错误。
      this.ctx.effect(() => () => registry.unregister(DELIVER_NODE_KIND));
    }
    // 服务被重建（改配置热改）时，上一份 Map 里悬着的等待必须自己收掉：那些 await 的调用方
    // 已经跟着旧实例一起没了，让它们带着 timer 悬在事件循环里就是「重建即悬挂」（plan §13.3 第 2 条）。
    this.ctx.effect(() => () => this.disposeApprovals());
    const deliverable = deliverChannelsOf(this.ctx)?.deliverablePlatforms() ?? [];
    this.ctx.logger.info(
      `投递编排就绪：额度键 ${DELIVER_ACTION} · 档位 ${this.config.autonomy} · 确认超时 ${String(this.config.approveTimeoutMs)}ms · 当前可投递平台 ${deliverable.join(' / ') || '（平台层尚未登记带 sendResume 的适配器）'} · 节点执行器${registry ? `已登记 ${DELIVER_NODE_KIND}` : '未登记（工作流未挂载）'}`,
    );
  }

  /**
   * 收掉全部在等的确认单：清空定时器并按**拒绝**定局。
   *
   * 「服务要没了」不是用户同意了，所以这里绝不 resolve 任何一个等待（AGENTS.md §8 第 3 条的
   * 同一取向：不做任何可能被读成「默认放行」的处置）。
   */
  private disposeApprovals(): void {
    for (const entry of [...this.approvals.values()]) {
      entry.settle(false);
    }
    this.approvals.clear();
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'outbound.deliver': OutboundDeliverService;
  }
}
