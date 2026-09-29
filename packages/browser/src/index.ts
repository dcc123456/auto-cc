/**
 * `browser.page` 服务（spec 2.1）：内嵌内核视图的**页面操作入口**。
 *
 * 分工是刻意切开的，也是本包存在的全部理由：
 * - `shell`（L1）拥有视图：创建、摆位、销毁。它不知道 BOSS 是什么。
 * - `sessions`（L2）拥有会话：用哪个分区、开哪个地址、登录态还在不在。
 * - 本包（L2）拥有**页面**：在这个已经打开的页面里导航、读快照，2.2 起加点击/输入/定位。
 *
 * 挂载与分区为什么不在这里：那两处已经有唯一入口（1.2-12 / 1.8），本包重复一遍就是
 * 第二套同类基础设施（AGENTS.md §2.5）。所以本包只**取用** shell 交出来的视图句柄。
 *
 * 两条边界：
 * 1. 导航目标是不可信输入，一律过 `resolveNavigableUrl`（只允许已登记平台的同源地址）；
 * 2. 页面内容只在页面里读（注入脚本），主进程不解析 HTML 字符串，因此不引入第二套 DOM 实现。
 */
import { Service, asApp, AppError, type Context } from '@auto-cc/core';
import type { KernelPageSnapshotView } from '@auto-cc/shared';
import type { SessionsService } from '@auto-cc/plugin-sessions';
import type { ShellService } from '@auto-cc/shell';
import type { WebContents } from 'electron';
import { z } from 'zod';
import { buildSnapshotScript, SNAPSHOT_HEADING_LIMIT, SNAPSHOT_TEXT_LIMIT, toSnapshotReading } from './page-script.js';
import { resolveNavigableUrl } from './navigate-policy.js';

/** 本包对 `shell` 的全部诉求：拿到内核视图的句柄 + 读它当前所在分区。 */
type KernelHost = Pick<ShellService, 'kernelContents' | 'getStatus'>;

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
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type BrowserPageConfig = z.output<typeof browserPageSchema>;

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
    const contents = this.requireContents();
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
    const contents = this.requireContents();
    const limit = maxChars ?? this.config.snapshotTextLimit;
    return this.readSnapshot(contents, limit);
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
   * 取当前可用的内核视图句柄。
   * @returns 未销毁的 `WebContents`
   * @throws 视图不存在或已销毁时 `NO_KERNEL_SESSION`——先 `sessions.open(platform)` 再说页面
   */
  private requireContents(): WebContents {
    const contents = this.host.kernelContents();
    if (!contents) {
      throw new AppError('NO_KERNEL_SESSION', '内核视图尚未挂载任何平台，先打开一个会话再操作页面', 'browser.page', {
        partition: this.host.getStatus().kernelViewPartition,
      });
    }
    return contents;
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
      )} 字`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'browser.page': BrowserPageService;
  }
}

export { resolveNavigableUrl } from './navigate-policy.js';
export { buildSnapshotScript, toSnapshotReading } from './page-script.js';
