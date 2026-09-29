/**
 * `sessions` 服务（spec 1.8）：内置内核会话与登录态的唯一管理者。
 *
 * 分工是刻意切开的：**视图宿主仍在 `shell`**（它是全应用唯一的窗口/视图创建处），
 * 这里只决定「用哪个分区打开哪个地址」，以及从这个分区里读出来的登录态。
 * 因此本服务是仓库里第二处（也是领域层唯一一处）碰 `electron.session` 的地方，
 * 第三处出现就说明分区语义开始漂移（§2.7）。
 *
 * 两条硬约束：
 * 1. 判定只看 cookie 的存在与过期时间，**不向站点发探测请求**——真实平台上一发请求就是风控流量；
 * 2. cookie 的**值**从不离开 electron 边界（`summarizeCookies` 只留名字与过期时间），
 *    所以它既进不了日志，也进不了 harness 写出的证据文件（AGENTS.md §8.5）。
 */
import { session } from 'electron';
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import { partitionFor, type SessionPlatformView, type SessionsStatusView } from '@auto-cc/shared';
import type { ShellService } from '@auto-cc/shell';
import { z } from 'zod';
import { judgeAuth, summarizeCookies, type AuthVerdict } from './probe.js';

/**
 * 本包对 `shell` 的全部诉求：把视图挂到某分区、读回窗口侧的分区名。
 *
 * 用 `Pick` 收成两个方法而不是直接用 `ShellService`，是为了让「领域层反过来能驱动壳层做什么」
 * 这件事在类型上就有限集——将来想加能力，得先改这里，改动就会被看见（AGENTS.md §4.1 的分层方向）。
 */
type KernelHost = Pick<ShellService, 'mountKernelSite' | 'getStatus'>;

/** 一个平台的会话配置：P1 只有本地 fixture，P2 起在此加 boss / liepin。 */
const platformSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, '平台标识要用小写字母开头的短名，它会直接成为分区名'),
  startUrl: z.url(),
  sessionCookieName: z.string().min(1),
});

export const sessionsSchema = z.strictObject({
  platforms: z.array(platformSchema).min(1),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type SessionsConfig = z.infer<typeof sessionsSchema>;

/** 一个平台一次读取的结果：界面读数 + 判定依据（`reason` 只用于事件，不进快照）。 */
type PlatformReading = { view: SessionPlatformView; verdict: AuthVerdict };

export class SessionsService extends Service {
  static provide = 'sessions';
  static Config = sessionsSchema;
  static inject = ['shell'];

  private readonly platforms: SessionsConfig['platforms'];

  constructor(ctx: Context, options: SessionsConfig) {
    super(ctx, 'sessions');
    // 必须接住第二个实参：cordis 传的是校验后的配置，只声明一个参数会让调用点报 TS2345。
    this.platforms = options.platforms;
  }

  /**
   * 壳层的视图宿主句柄。
   *
   * `Service.ctx` 的声明类型是 cordis 的 `Context`，看不到各包增补的服务名，所以走 `asApp` 收窄
   * （与 `plugins` 取 `kernel` 同一条路，见 §2.3 复用既有机制）。
   */
  private get host(): KernelHost {
    return asApp(this.ctx).shell;
  }

  /**
   * 所有平台的会话读数 + 内核视图当前承载的平台。
   * @returns 分区、落盘路径、cookie 名与登录判定的快照（spec 1.8-01 / 1.8-04）
   */
  status = async (): Promise<SessionsStatusView> => {
    const readings = await Promise.all(this.platforms.map((platform) => this.read(platform)));
    const currentPartition = this.host.getStatus().kernelViewPartition;
    return {
      platforms: readings.map((reading) => reading.view),
      // 活动平台按分区现读，而不是自己记一份状态：窗口销毁重建后读数会自动回到「没有活动平台」。
      activePlatform: readings.find((reading) => reading.view.partition === currentPartition)?.view.id ?? null,
    };
  };

  /**
   * 让内核视图按该平台的分区打开起始地址（spec 1.8-02 / 1.8-08）。
   * @param platform 平台标识，必须在 `cordis.yml` 的 `sessions.platforms` 里
   * @returns 挂载后的会话快照
   */
  open = async (platform: string): Promise<SessionsStatusView> => {
    const config = this.platformOrThrow(platform);
    const partition = partitionFor(config.id);
    this.host.mountKernelSite(partition, config.startUrl);
    this.ctx.logger.info(`内核视图已挂载会话：平台 ${config.id} · 分区 ${partition}`);
    return this.status();
  };

  /**
   * 只读 cookie 判登录态；判定为失效时顺带推 `session/expired`（spec 1.8-06）。
   * @param platform 平台标识
   * @returns 该平台的会话读数
   */
  probe = async (platform: string): Promise<SessionPlatformView> => {
    const config = this.platformOrThrow(platform);
    const reading = await this.read(config);
    if (reading.view.auth === 'expired' && reading.verdict.reason) {
      this.ctx.emit('session/expired', {
        platform: config.id,
        reason: reading.verdict.reason,
        at: Date.now(),
      });
      this.ctx.logger.warn(`会话失效：平台 ${config.id} 的原因 ${reading.verdict.reason}`);
    }
    return reading.view;
  };

  /**
   * 清掉该平台分区里的 cookie，用于「退出登录」（spec 1.8-04）。
   * @param platform 平台标识
   * @returns 清除之后的读数，`auth` 应为 `expired`、`cookieNames` 里不再有会话 cookie
   */
  logout = async (platform: string): Promise<SessionPlatformView> => {
    const config = this.platformOrThrow(platform);
    // 带 origin：`storages: ['cookies']` 已经把范围收到 cookie，但作用域是整个分区；
    // 将来同一分区可能承载同站的其他主机（登录页 / SSO 子域），「退出登录」只该忘记本平台那一份。
    await session
      .fromPartition(partitionFor(config.id))
      .clearStorageData({ storages: ['cookies'], origin: new URL(config.startUrl).origin });
    this.ctx.logger.info(`已清除会话 cookie：平台 ${config.id}`);
    return (await this.read(config)).view;
  };

  /** @param platform 平台标识 @returns 配置；未登记的平台以结构化错误失败，不静默返回空快照 */
  private platformOrThrow(platform: string) {
    const config = this.platforms.find((item) => item.id === platform);
    if (!config) {
      throw new AppError('PLATFORM_NOT_CONFIGURED', `未配置的平台：${platform}`, 'sessions', {
        known: this.platforms.map((item) => item.id),
      });
    }
    return config;
  }

  /**
   * 读取一个平台的分区现状。
   * @param config 平台配置
   * @returns 界面读数与判定依据
   */
  private async read(config: SessionsConfig['platforms'][number]): Promise<PlatformReading> {
    const partition = partitionFor(config.id);
    const platformSession = session.fromPartition(partition);
    const cookies = summarizeCookies(await platformSession.cookies.get({}));
    const verdict = judgeAuth(cookies, config.sessionCookieName, Date.now());
    return {
      verdict,
      view: {
        id: config.id,
        partition,
        startUrl: config.startUrl,
        isPersistent: platformSession.isPersistent(),
        storagePath: platformSession.getStoragePath() ?? null,
        cookieNames: cookies.map((cookie) => cookie.name),
        sessionCookieName: config.sessionCookieName,
        auth: verdict.auth,
        expiresAt: verdict.expiresAt,
      },
    };
  }

  [Service.init](): void {
    this.ctx.logger.info(
      `会话服务就绪：${this.platforms.length} 个平台（${this.platforms.map((item) => item.id).join(' / ')}）`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    sessions: SessionsService;
  }
}

export { judgeAuth, summarizeCookies } from './probe.js';
