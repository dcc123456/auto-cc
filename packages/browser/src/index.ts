/**
 * `browser.page` 服务（spec 2.1）：内嵌内核视图的**页面操作入口**。
 *
 * 分工是刻意切开的，也是本包存在的全部理由：
 * - `shell`（L1）拥有视图：创建、摆位、销毁。它不知道 BOSS 是什么。
 * - `sessions`（L2）拥有会话：用哪个分区、开哪个地址、登录态还在不在。
 * - 本包（L2）拥有**页面**：在这个已经打开的页面里导航、读快照，2.2 起加点击/输入/定位，
 *   2.4 起加截图（只交 PNG 字节，落盘与保留期归调用方的证据目录）。
 *
 * 挂载与分区为什么不在这里：那两处已经有唯一入口（1.2-12 / 1.8），本包重复一遍就是
 * 第二套同类基础设施（AGENTS.md §2.5）。所以本包只**取用** shell 交出来的视图句柄。
 *
 * 两条边界：
 * 1. 导航目标是不可信输入，一律过 `resolveNavigableUrl`（只允许已登记平台的同源地址）；
 * 2. 页面内容只在页面里读（注入脚本），主进程不解析 HTML 字符串，因此不引入第二套 DOM 实现。
 */
import { Service, asApp, AppError, type Context } from '@auto-cc/core';
import type { ExtractRequest, ExtractResultView, KernelPageSnapshotView, PageScrollReading } from '@auto-cc/shared';
import type { SessionsService } from '@auto-cc/plugin-sessions';
import type { NativeImage, WebContents } from 'electron';
import { z } from 'zod';
import { evaluateInFrames, requireKernelContents, usableEvaluations, type KernelHost } from './frame-channel.js';
import { buildExtractScript, toExtractFrameReading } from './extract-script.js';
import {
  buildScrollScript,
  buildSnapshotScript,
  SNAPSHOT_HEADING_LIMIT,
  SNAPSHOT_TEXT_LIMIT,
  toScrollReading,
  toSnapshotReading,
} from './page-script.js';
import { resolveNavigableUrl } from './navigate-policy.js';

/**
 * 本包对 `sessions` 的全部诉求：读已登记平台的起始地址（导航许可名单的唯一来源）。
 *
 * 与 `sessions` 用 `Pick` 收 `shell` 同一条路：把「跨包能做什么」在类型上收成有限集，
 * 想加能力就得先改这一行，改动就会被看见（AGENTS.md §4.1 的分层方向）。
 */
type SessionRegistry = Pick<SessionsService, 'status'>;

export const browserPageSchema = z.strictObject({
  /** 一次导航等待页面装载完成的上限（毫秒）；超时不报错，由快照读数如实反映 `readyState`。 */
  navigateTimeoutMs: z.number().int().min(500).max(30_000).default(10_000),
  /** 单次快照取回的正文上限（字符）。 */
  snapshotTextLimit: z.number().int().min(200).max(50_000).default(SNAPSHOT_TEXT_LIMIT),
  /** 一次批量抽取最多回传多少个容器（条）。 */
  extractRowLimit: z.number().int().min(1).max(100).default(12),
  /** 抽取时单个字段正文的上限（字符）。 */
  extractTextLimit: z.number().int().min(50).max(20_000).default(4000),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type BrowserPageConfig = z.output<typeof browserPageSchema>;

/**
 * 一帧像素现场（spec 2.4-04 的失败截图）。
 *
 * 这里**只交字节，不交路径**：写到哪儿、留多久是调用方的事（工作流的证据目录归 `workflow.runner`
 * 管，含保留与清理），页面服务一旦知道自己要落盘就多了一份状态，也就有了第二套文件管理（AGENTS.md §2.5）。
 */
export type PageScreenshotView = {
  /** 图片宽度（像素，按视图的 DIP 尺寸） */
  width: number;
  /** 图片高度（像素） */
  height: number;
  /** 编码后的 PNG 字节 */
  png: Buffer;
};

export class BrowserPageService extends Service {
  static provide = 'browser.page';
  static Config = browserPageSchema;
  static inject = ['shell', 'sessions'];

  constructor(
    ctx: Context,
    private readonly config: BrowserPageConfig,
  ) {
    super(ctx, 'browser.page');
  }

  /**
   * 让内核视图导航到同源的新地址，并在装载结束（或超时）后回一份快照。
   * @param url 目标地址（不可信输入）；协议必须 http/https，且源要属于已登记平台的起始地址同源
   * @returns 导航落定后的页面快照
   * @throws 目标被许可判定拒绝时 `NAVIGATE_URL_REJECTED`；没有已挂载会话时 `NO_KERNEL_SESSION`
   */
  navigate = async (url: string): Promise<KernelPageSnapshotView> => {
    const contents = requireKernelContents(this.host, 'browser.page');
    const startUrls = (await this.sessions.status()).platforms.map((platform) => platform.startUrl);
    const target = resolveNavigableUrl(url, startUrls);
    const settled = this.settleLoad(contents);
    await contents.loadURL(target.href);
    const outcome = await settled;
    this.ctx.logger.info(`内核视图已导航：${target.href}（装载 ${outcome}）`);
    return this.readSnapshot(contents);
  };

  /**
   * 读取当前内核视图所在页面的快照。
   * @param maxChars 本次取回的正文上限；省略用配置的 `snapshotTextLimit`
   * @returns 标题 / 地址 / 装载态 / 元素数 / 正文节选 / 主要标题
   * @throws 没有已挂载会话时 `NO_KERNEL_SESSION`；页面注入失败时 `PAGE_SCRIPT_FAILED`
   */
  snapshot = async (maxChars?: number): Promise<KernelPageSnapshotView> => {
    const contents = requireKernelContents(this.host, 'browser.page');
    const limit = maxChars ?? this.config.snapshotTextLimit;
    return this.readSnapshot(contents, limit);
  };

  /**
   * 在整棵帧树里做一次「容器 × 字段」批量抽取（spec 2.3-01）。
   *
   * 一次跨进程求值读回所有卡片，而不是逐字段调 `browser.locate`：后者在一页 12 张卡 × 6 个字段
   * 的情况下是 72 次求值，每次重扫一遍 DOM。抽取**不打分、不自愈、不 fail-closed**（plan §10.3）：
   * 命不中的字段带回 `matched:false`，整轮抓取不会因为一个字段缺席而中止。
   * @param request 容器声明 + 字段声明（候选顺序即优先级；字段在容器子树内解析）
   * @returns 合并后的行（跨帧按「顶层帧在前」的全局序号重编）、容器总数、是否被上限截断、逐帧结局
   * @throws 字段声明为空时 `INVALID_ARGUMENT`；没有已挂载会话时 `NO_KERNEL_SESSION`；所有帧都读失败时 `PAGE_SCRIPT_FAILED`
   */
  extract = async (request: ExtractRequest): Promise<ExtractResultView> => {
    const contents = requireKernelContents(this.host, 'browser.page');
    const fields = Array.isArray(request.fields) ? request.fields : [];
    if (fields.length === 0) {
      throw new AppError('INVALID_ARGUMENT', '批量抽取至少要声明一个字段', 'browser.page', {
        container: request.container?.description ?? '（未声明）',
      });
    }
    const source = buildExtractScript(request.container, fields, {
      textLimit: this.config.extractTextLimit,
      rowLimit: this.config.extractRowLimit,
    });
    const evaluations = await evaluateInFrames(contents, source, true);
    const usable = usableEvaluations(evaluations, 'browser.page');
    const rows: ExtractResultView['rows'] = [];
    let containers = 0;
    let truncated = false;
    for (const evaluation of usable) {
      const reading = toExtractFrameReading(evaluation.value);
      containers += reading.containers;
      truncated ||= reading.truncated;
      for (const row of reading.rows) {
        rows.push({ ...row, containerIndex: rows.length, frameUrl: evaluation.frameUrl });
      }
    }
    this.ctx.logger.info(
      `批量抽取完成：容器 ${String(containers)} 个 · 回传 ${String(rows.length)} 行 · 帧 ${String(usable.length)}/${String(evaluations.length)}`,
    );
    return {
      rows,
      containers,
      truncated,
      frames: evaluations.map((item) => ({ url: item.frameUrl, ok: item.error === null, error: item.error })),
    };
  };

  /**
   * 把当前页面滚到底部并回读滚动位置（spec 2.3-06 的无限滚动扳机）。
   *
   * 只对顶层文档生效：列表在 iframe 里的站点需要的是「那个帧的窗口」滚到底，本方法不做这件事，
   * 这一缺口在 spec 的验收记录里如实挂着（同 2.2-09 的处理方式）。
   * @returns 滚动后的 `scrollY` / `scrollHeight` / 是否已到底
   * @throws 没有已挂载会话时 `NO_KERNEL_SESSION`；页面注入失败时 `PAGE_SCRIPT_FAILED`
   */
  scroll = async (): Promise<PageScrollReading> => {
    const contents = requireKernelContents(this.host, 'browser.page');
    let raw: unknown;
    try {
      raw = await contents.executeJavaScript(buildScrollScript(), true);
    } catch (error) {
      throw new AppError(
        'PAGE_SCRIPT_FAILED',
        `页面滚动失败：${error instanceof Error ? error.message : String(error)}`,
        'browser.page',
        { url: contents.getURL() },
      );
    }
    return toScrollReading(raw);
  };

  /**
   * 抓一帧当前内核视图的像素（spec 2.4-04 的失败现场截图）。
   *
   * 走视图自己的 `webContents.capturePage()` 而不是窗口级截图：失败证据恰恰常在「主窗口被别的窗口
   * 挡住 / 内核视图是隐藏的那一个」时取，而窗口级截图在那种情况下回的是空图（1.6 spike 实测）。
   * 本方法**不落盘**，字节交给调用方决定写到哪（见 `PageScreenshotView`）。
   * @returns PNG 字节与像素尺寸
   * @throws 没有已挂载会话时 `NO_KERNEL_SESSION`；截图抛错或回空图（视图还没绘制出内容）时 `PAGE_SCREENSHOT_FAILED`
   */
  screenshot = async (): Promise<PageScreenshotView> => {
    const contents = requireKernelContents(this.host, 'browser.page');
    let image: NativeImage;
    try {
      image = await contents.capturePage();
    } catch (error) {
      throw new AppError(
        'PAGE_SCREENSHOT_FAILED',
        `内核视图截图失败：${error instanceof Error ? error.message : String(error)}`,
        'browser.page',
        { url: contents.getURL() },
      );
    }
    if (image.isEmpty()) {
      // 空图不是「截图这件事没做成」而是「这一帧根本没有画面」：留个 null 位比塞一张白图有用。
      throw new AppError(
        'PAGE_SCREENSHOT_FAILED',
        '内核视图当前没有可截取的画面（页面尚未绘制或视图已隐藏）',
        'browser.page',
        {
          url: contents.getURL(),
        },
      );
    }
    const { width, height } = image.getSize();
    return { width, height, png: image.toPNG() };
  };

  /**
   * 壳层的视图宿主句柄（见 `KernelHost` 注释：这里刻意只取两个方法）。
   * @returns shell 服务实例
   */
  private get host(): KernelHost {
    return asApp(this.ctx).shell;
  }

  /**
   * 会话服务的登记面（见 `SessionRegistry` 注释：只读平台清单，不碰分区）。
   * @returns sessions 服务实例
   */
  private get sessions(): SessionRegistry {
    return asApp(this.ctx).sessions;
  }

  /**
   * 在页面里执行读取脚本并补上分区信息。
   * @param contents 目标视图句柄
   * @param maxChars 正文取回上限（字符），先钳到配置上限，避免一次调用要回整站内存
   * @returns 界面与 harness 共用的那份页面快照
   */
  private async readSnapshot(
    contents: WebContents,
    maxChars = this.config.snapshotTextLimit,
  ): Promise<KernelPageSnapshotView> {
    const limit = Math.min(Math.max(1, Math.trunc(maxChars)), this.config.snapshotTextLimit);
    let raw: unknown;
    try {
      raw = await contents.executeJavaScript(buildSnapshotScript(limit, SNAPSHOT_HEADING_LIMIT), true);
    } catch (error) {
      throw new AppError(
        'PAGE_SCRIPT_FAILED',
        `页面读取失败：${error instanceof Error ? error.message : String(error)}`,
        'browser.page',
        { url: contents.getURL() },
      );
    }
    const reading = toSnapshotReading(raw);
    return { ...reading, partition: this.host.getStatus().kernelViewPartition };
  }

  /**
   * 等这一次导航装载落定。
   *
   * 监听器必须在三条出口（成功 / 失败 / 超时）里都摘掉：`once` 只保证触发过一次，
   * 而超时那条永远不会触发，留着就是每次导航泄漏一对监听（spec 2.1-11 数的正是这个）。
   * @param contents 目标视图句柄
   * @returns 落定方式；`timeout` 不是错误，页面仍会继续装载，由快照读数反映真实进度
   */
  private settleLoad(contents: WebContents): Promise<'loaded' | 'failed' | 'timeout'> {
    return new Promise((resolve) => {
      const finish = (outcome: 'loaded' | 'failed' | 'timeout'): void => {
        clearTimeout(timer);
        contents.removeListener('did-finish-load', onLoaded);
        contents.removeListener('did-fail-load', onFailed);
        resolve(outcome);
      };
      const onLoaded = (): void => finish('loaded');
      const onFailed = (): void => finish('failed');
      const timer = setTimeout(() => finish('timeout'), this.config.navigateTimeoutMs);
      contents.once('did-finish-load', onLoaded);
      contents.once('did-fail-load', onFailed);
    });
  }

  [Service.init](): void {
    this.ctx.logger.info(
      `页面操作服务就绪：导航超时 ${String(this.config.navigateTimeoutMs)}ms · 快照正文上限 ${String(
        this.config.snapshotTextLimit,
      )} 字 · 抽取上限 ${String(this.config.extractRowLimit)} 条 × ${String(this.config.extractTextLimit)} 字`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'browser.page': BrowserPageService;
  }
}

export { resolveNavigableUrl } from './navigate-policy.js';
export {
  buildScrollScript,
  buildSnapshotScript,
  toScrollReading,
  toSnapshotReading,
  type PageSnapshotReading,
} from './page-script.js';
export {
  buildExtractScript,
  toExtractFrameReading,
  type ExtractFrameReading,
  type ExtractLimits,
} from './extract-script.js';
export { BrowserLocateService, browserLocateSchema, type BrowserLocateConfig } from './locate-service.js';
export { BrowserActService, browserActSchema, type BrowserActConfig } from './act-service.js';
export { PlatformRegistryService } from './platform-registry.js';
export {
  knowledgePackSchema,
  parseKnowledgePack,
  type JobDetail,
  type JobSearchCriteria,
  type JobSummary,
  type KnowledgePack,
  type OutboundResult,
  type PlatformAdapter,
  type ReplyMessage,
} from './platform-contract.js';
export {
  buildFingerprintScanScript,
  buildLocateScript,
  buildWaitScript,
  buildDomActionScript,
  buildValueReadScript,
  toLocatedReadings,
  toWaitReading,
  toDomActionReading,
} from './locator-script.js';
export { validateSpec, decideLocate, scoreByFingerprint, toRankedCandidates } from './locator-spec.js';
