/**
 * `sessions` 服务（spec 1.8）：内置内核会话与登录态的唯一管理者。
 *
 * 分工是刻意切开的：**视图宿主仍在 `shell`**（它是全应用唯一的窗口/视图创建处），
 * 这里只决定「用哪个分区打开哪个地址」，以及从这个分区里读出来的登录态。
 * 因此本服务是仓库里第二处（也是领域层唯一一处）碰 `electron.session` 的地方，
 * 第三处出现就说明分区语义开始漂移（§2.7）。
 * 2.7-01 起这里还多一个**同源**的口子：`observeMainFrameResponses` 观测的是分区里主文档的响应，
 * 与 cookie 同属「分区」这一层，所以观测口的归属跟着分区走；而「哪些状态码 / 哪些字样算风控」
 * 是页面判定，留在 `browser.risk`，这条边界一寸不越。
 * 2.7-06 起这里还是**首次风险签字**的归属：`automation_consents` 表（迁移 v6）与
 * `consentStatus` / `grantConsent` 两只服务口都在这，因为它同样是「这个平台现在是什么状况」的一部分。
 * 释放路径（打招呼 / 投递 / 抓取）经 `core` 声明的 `ConsentGate` 窄投影来问，不 import 本包（§4.1）。
 *
 * 两条硬约束：
 * 1. 判定只看 cookie 的存在与过期时间，**不向站点发探测请求**——真实平台上一发请求就是风控流量；
 * 2. cookie 的**值**从不离开 electron 边界（`summarizeCookies` 只留名字与过期时间），
 *    所以它既进不了日志，也进不了 harness 写出的证据文件（AGENTS.md §8.5）。
 *    响应观测同一条纪律：只交出状态码、状态行与地址，不交出请求/响应头。
 */
import { app, session, type WebRequestFilter } from 'electron';
import { AppError, asApp, Service, agentTool, registerAgentTools, type ConsentGate, type Context } from '@auto-cc/core';
import {
  partitionFor,
  type SessionConsentView,
  type SessionPlatformView,
  type SessionsStatusView,
} from '@auto-cc/shared';
import type { ShellService } from '@auto-cc/shell';
import type { StoreService } from '@auto-cc/plugin-store';
import { z } from 'zod';
import {
  consentMigration,
  CONSENT_MIGRATION_VERSION,
  consentScope,
  readConsentAt,
  writeConsent,
} from './consent-store.js';
import { judgeAuth, summarizeCookies, type AuthVerdict } from './probe.js';

/**
 * 本包对 `shell` 的全部诉求：把视图挂到某分区、读回窗口侧的分区名。
 *
 * 用 `Pick` 收成两个方法而不是直接用 `ShellService`，是为了让「领域层反过来能驱动壳层做什么」
 * 这件事在类型上就有限集——将来想加能力，得先改这里，改动就会被看见（AGENTS.md §4.1 的分层方向）。
 */
type KernelHost = Pick<ShellService, 'mountKernelSite' | 'unmountKernelSite' | 'getStatus'>;

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

/**
 * 分区里一次**主文档**响应的读数（spec 2.7-01）。
 *
 * 只有判定要用的四个数：地址、状态码、状态行、时刻。响应头里可能带着会话票据，
 * 所以它和 cookie 一样不许离开 electron 边界（AGENTS.md §8.5）。
 */
export type MainFrameResponseReading = {
  /** 这条响应来自哪个平台的分区（按分区名对号，因此同站多平台也不会认错） */
  platform: string;
  url: string;
  statusCode: number;
  statusLine: string;
  at: number;
};

/**
 * 观测用的过滤器：只要主文档。
 *
 * `types: ['mainFrame']` 是实测出来的必需项（plan §14.2 H 的 spike-1）：不带 `types` 时
 * 页面内的 XHR 与子帧都会各来一条，风控判定就会被自己的噪声淹掉。
 */
const MAIN_FRAME_FILTER: WebRequestFilter = { urls: ['http://*/*', 'https://*/*'], types: ['mainFrame'] };

export class SessionsService extends Service implements ConsentGate {
  static provide = 'sessions';
  static Config = sessionsSchema;
  // `store` 是 2.7-06 之后加上的：首次启用的风险签字必须跨重启，而「平台级、跨重启的状态」
  // 这一归属就是本服务（分区、登录态、平台清单都在这）。把它写成硬依赖而不是可选依赖，
  // 是因为签字记录存不下来时，释放路径必须停在「读不到」而不是默认「签过」。
  static inject = ['shell', 'store'];

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

  /** store 服务句柄（签字表的落点）；连接尚未打开时由 `store.db` 的 getter 抛「尚未完成挂载」。 */
  private get store(): StoreService {
    return asApp(this.ctx).store;
  }

  /**
   * 读一个平台的首次风险确认状态（spec 2.7-06 的界面入口）。
   * @param platform 平台标识，必须在 `sessions.platforms` 里
   * @returns 签字读数；未签时 `granted:false`、`acknowledgedAt:null`，界面据此画确认卡片
   * @throws `PLATFORM_NOT_CONFIGURED`（未登记的平台，不静默回「没签」）
   */
  consentStatus = (platform: string): SessionConsentView => {
    return this.consentView(this.platformOrThrow(platform).id);
  };

  /**
   * 登记一次风险确认（spec 2.7-06）：用户在确认卡片上点「我承担」之后调这一句。
   *
   * 只接受平台名 —— scope 由主进程按 `automation:<platform>` 拼，渲染层传不进任意键，
   * 这张表因此不可能长出一个没登记过的主体来冒充「用户签过字」（plan §14.3 第 6 条）。
   * @param platform 平台标识
   * @returns 登记后的读数（首次时刻不会被第二次确认刷新，见 `writeConsent`）
   * @throws `PLATFORM_NOT_CONFIGURED`（未登记的平台）
   */
  grantConsent = (platform: string): SessionConsentView => {
    const config = this.platformOrThrow(platform);
    writeConsent(this.store.db, config.id, Date.now());
    const view = this.consentView(config.id);
    this.ctx.logger.info(`自动化风险确认已登记：平台 ${config.id} · 首次时刻 ${String(view.acknowledgedAt)}`);
    return view;
  };

  /**
   * 契约见 `ConsentGate.hasConsent`（spec 2.7-06 的释放路径判据）。
   * @param platform 平台标识
   * @returns 库里有这一行签字记录为 true；没签过、或该平台未登记，都为 false（不抛）
   */
  hasConsent = (platform: string): boolean => {
    return readConsentAt(this.store.db, platform) !== null;
  };

  /**
   * 契约见 `ConsentGate.ensureConsent`：释放路径上的硬拦。
   *
   * 放在 `sessions` 而不是每个调用方各写一句「查不到就抛」，是因为「什么算没签」只该有一处定义
   * （AGENTS.md §2.5）；打招呼、投递、抓取三条入口拿到的必须是同一个判据。
   * @param platform 平台标识
   * @throws 平台未登记时 `PLATFORM_NOT_CONFIGURED`（对一个不存在的平台谈「承担风险」没有意义，
   *         界面会画出一张永远签不成的卡片）、该平台没有签字记录时 `CONSENT_REQUIRED`（带平台名，界面按名字插进文案）
   */
  ensureConsent = (platform: string): void => {
    const config = this.platformOrThrow(platform);
    if (this.hasConsent(config.id)) return;
    throw new AppError(
      'CONSENT_REQUIRED',
      `平台 ${config.id} 还没有一份自动化风险确认记录，先确认承担该风险`,
      'sessions',
      { platform: config.id, scope: consentScope(config.id) },
    );
  };

  /**
   * 组装一条签字读数（库里的原始时刻 → 界面视图）。
   * @param platform 已校验过登记的平台标识
   * @returns `SessionConsentView`
   */
  private consentView(platform: string): SessionConsentView {
    const acknowledgedAt = readConsentAt(this.store.db, platform);
    return { platform, scope: consentScope(platform), granted: acknowledgedAt !== null, acknowledgedAt };
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
   * 收回内核视图里的站点页面，退回占位页（spec 2.1-11 的「关」）。
   *
   * 与 `logout` 的区别是这条路径的全部意义：`close` 只关页面，分区里那份 cookie 一条都不动，
   * 重新打开还是登录态；`logout` 才清 cookie。把两件事混成一个按钮，用户关掉窗口就等于退出登录。
   * @returns 关闭之后的会话快照，`activePlatform` 为 null
   */
  close = async (): Promise<SessionsStatusView> => {
    this.host.unmountKernelSite();
    this.ctx.logger.info('内核视图已收回（分区与登录态保留）');
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

  /**
   * 观测每个已登记平台分区里**主文档**的响应（spec 2.7-01 的取路，plan §14.2 H 的 spike 实测）。
   *
   * 为什么这条口在 `sessions` 而不是调用方自己 `session.fromPartition`：分区语义的唯一归属就是本服务，
   * 观测点必须挂在同一个归属上；而「403/429 算不算风控」是页面判定，调用方（`browser.risk`）说了算。
   * 观测是**只读**的（`onResponseStarted` 的 listener 没有 callback），所以不存在「看一眼就把请求卡住」的形态。
   *
   * 一条必须记住的实测：**同一个会话的同一个 webRequest 事件只有一个 handler**，第二次注册直接覆盖第一个。
   * 因此这个槽位的独占者就是唯一的调用方，重复调用不会「多一个监听」，只会让前一个失效——
   * 所以返回摘除函数，由调用方在自己的 effect 里归还。
   *
   * 另一条同为实测的约束（2.7-c 运行期第一次挂载就是栽在这里）：`session.fromPartition` 在
   * `app.whenReady()` 之前直接抛「Session can only be received when app is ready」，而内核装配
   * 发生在 ready 之前（`shell` 也是自己在 launch 里等 ready）。所以本口是**异步**的：先等 ready，
   * 再把监听逐个分区挂上；调用方（`browser.risk`）在 init 里 await 它，摘除函数照旧归还。
   * @param listener 每条主框架响应调用一次；参数是只含判定数据的读数（不含响应头与 cookie）
   * @returns 摘除函数：调用后各分区不再回调，视图销毁与否都不影响（监听本来装在分区上）
   */
  observeMainFrameResponses = async (listener: (reading: MainFrameResponseReading) => void): Promise<() => void> => {
    await app.whenReady();
    const unbinds = this.platforms.map((platform) => {
      const platformSession = session.fromPartition(partitionFor(platform.id));
      platformSession.webRequest.onResponseStarted(MAIN_FRAME_FILTER, (details) => {
        listener({
          platform: platform.id,
          url: details.url,
          statusCode: details.statusCode,
          statusLine: details.statusLine,
          at: Date.now(),
        });
      });
      // 摘除用的还是同一个 filter 对象：`onResponseStarted(filter, null)` 实测不抛错且此后零回调。
      return () => platformSession.webRequest.onResponseStarted(MAIN_FRAME_FILTER, null);
    });
    this.ctx.logger.info(`主框架响应观测已挂载：${String(unbinds.length)} 个分区`);
    return () => {
      for (const unbind of unbinds) unbind();
    };
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

  /**
   * 把签字表的迁移登记进 `store.migrations` 并把表建出来（同 `usage.ledger` / `jd.store` 那条路）。
   *
   * 幂等是硬要求：`plugins.start('sessions')` 会重新构造本服务，无条件 push 会在共享清单里
   * 留下两个 `version: 6`，之后任何一次 `upgrade()` 都直接抛错（plan §8.4 决策 5）。
   */
  private ensureSchema(): void {
    const { migrations } = this.store;
    if (!migrations.some((item) => item.version === CONSENT_MIGRATION_VERSION)) {
      migrations.push(consentMigration);
    }
    this.store.upgrade();
  }

  [Service.init](): void {
    this.ensureSchema();
    const signed = this.platforms.filter((platform) => this.hasConsent(platform.id)).map((platform) => platform.id);
    const tools = registerAgentTools(this.ctx, [
      agentTool({
        id: 'sessions.open',
        titleKey: 'agent.tool.labels.sessionsOpen',
        description: '在指定平台的会话分区里打开内嵌视图（重启后沿用同一份登录态）',
        input: z.strictObject({ platform: z.string().min(1) }),
        effect: 'read',
        requiresConfirmation: false,
        run: ({ platform }) => this.open(platform),
      }),
    ]);
    this.ctx.logger.info(
      `会话服务就绪：${String(this.platforms.length)} 个平台（${this.platforms.map((item) => item.id).join(' / ')}）· 已确认自动化风险 ${signed.join(' / ') || '（尚无平台签过字，外发与抓取会被硬拦）'} · agent 工具登记 ${String(tools)} 个${tools === 0 ? '（注册表未挂载）' : ''}`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    sessions: SessionsService;
  }
}

export { judgeAuth, summarizeCookies } from './probe.js';
