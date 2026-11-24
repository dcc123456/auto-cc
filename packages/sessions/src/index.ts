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
import {
  AppError,
  asApp,
  isLoopbackHost,
  Service,
  agentTool,
  registerAgentTools,
  toolResult,
  type ConsentGate,
  type Context,
} from '@auto-cc/core';
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
import { judgeAuth, sessionExpiredReason, summarizeCookies, type AuthVerdict } from './probe.js';

/**
 * 本包对 `shell` 的全部诉求：把视图挂到某分区、读回窗口侧的分区名。
 *
 * 用 `Pick` 收成两个方法而不是直接用 `ShellService`，是为了让「领域层反过来能驱动壳层做什么」
 * 这件事在类型上就有限集——将来想加能力，得先改这里，改动就会被看见（AGENTS.md §4.1 的分层方向）。
 */
type KernelHost = Pick<ShellService, 'mountKernelSite' | 'unmountKernelSite' | 'getStatus'>;

/**
 * 全应用**唯一**的浏览分区（用户裁定 2026-11-22：不要「站点 / 任意网页」之分，内嵌的就是一个真实浏览器）。
 *
 * 一个分区 = 一个浏览器：登录态跨重启保留、不同源 cookie 按源隔离（浏览器自带），
 * 平台不再是分区维度，只剩「打开哪个 startUrl」这一层归属。
 */
const BROWSER_PARTITION = partitionFor('browser');

/**
 * 「先把浏览器开起来」时挂的空白页（2026-11-23 裁定）。
 *
 * 为什么不是某个平台的 startUrl：地址栏拿到的是**用户自己输的地址**，把它顶掉等于替用户导航。
 * 为什么不挂占位页：占位页属于壳层的占位态（分区为空），这里要的是一块真视图，好让下一次导航有地方落。
 */
const BROWSER_BLANK_PAGE = 'about:blank';

/**
 * 一个平台的会话配置。
 *
 * 登录判定用的是**信号族**（8.2-01）：真实站点上登录态是一族 cookie，而仿站只发一枚，
 * 单枚 cookie 名在真站恒判失效（`docs/acceptance/08-real-platform-driving/8.0-02-cookie-name-diff.txt`）。
 * 三个键都带 `.default()`，为的是让"未标定"成为可直接省略的写法——省略即 `authCookieNames: []`，
 * 判定得到 `unknown`：既不授权动作，也不谎报失效。族名单放在配置而不是代码里，是因为这份知识属于站点、
 * 会随改版失效；写死就等于把"某天起真站恒判 unknown"藏进一次发版。
 */
const platformSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, '平台标识要用小写字母开头的短名，它会直接成为分区名'),
  startUrl: z.url(),
  /** 登录票据族（any-of）；空数组 = 该平台未标定 ⇒ 判定只能是 `unknown`。 */
  authCookieNames: z.array(z.string().min(1)).default([]),
  /** 游客族：只有这些在场判 `expired`（游客态）。 */
  guestCookieNames: z.array(z.string().min(1)).default([]),
  /** 判活所需的登录族在场枚数；大于族名单长度时该平台永远判 `unknown`（保守，不是缺陷）。 */
  authMinPresence: z.number().int().min(1).default(1),
});

export const sessionsSchema = z.strictObject({
  platforms: z.array(platformSchema).min(1),
  /**
   * 允不允许**自动化**把内核视图挂到非本机地址（2026-11-24 红线事故）。
   *
   * 事故里两条接触点是**会话挂载**（`sessions.open` 直接把真站 startUrl 装进视图），只拦导航挡不住它。
   * 缺省 false：自动化只能挂本机靶站，真实站点由人在会话面板里自己点（那条路走 `source:'user'`）。
   * 人工在场跑真实链路时才显式打开，用完即关。
   */
  allowRealAutomation: z.boolean().default(false),
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
    this.allowRealAutomation = options.allowRealAutomation;
  }

  /** 自动化能不能把视图挂到非回环 startUrl（装配侧显式例外，缺省关）。 */
  private readonly allowRealAutomation: boolean;

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
   * 起那唯一一个浏览器会话（2026-11-23 裁定：地址栏输网址不该先让人去「运行记录」点开会话）。
   *
   * 与 `open(platform)` 的分工：那是「去某个平台的起始页」，这条是「先把浏览器开起来」——
   * 地址栏拿到的是用户自己输的地址，不该被任何平台的 `startUrl` 顶掉，所以这里只挂一块空白页，
   * 真正的地址由调用方紧接着经**唯一那条导航口**（`browser.page.navigate`）过去。
   * 已经有会话时**什么都不做**：重建视图会丢掉页面上正在进行的一切（占位页那一态除外，
   * 它的分区是空串，本来就没有页面）。
   * @returns 起好之后的会话快照
   */
  ensureBrowser = async (): Promise<SessionsStatusView> => {
    if (this.host.getStatus().kernelViewPartition !== '') return this.status();
    // 与 `open` 同一个理由先迁移：起会话这一刻正是「新代码第一次碰这份 userData」的时刻。
    await this.mergeLegacyPartitions();
    this.host.mountKernelSite(BROWSER_PARTITION, BROWSER_BLANK_PAGE);
    this.ctx.logger.info(`已起单一浏览器会话（分区 ${BROWSER_PARTITION} · 空白页），等待调用方导航`);
    return this.status();
  };

  /**
   * 让内核视图按该平台的分区打开起始地址（spec 1.8-02 / 1.8-08）。
   * @param platform 平台标识，必须在 `cordis.yml` 的 `sessions.platforms` 里
   * @returns 挂载后的会话快照
   */
  open = async (platform: string, source: 'user' | 'automation' = 'automation'): Promise<SessionsStatusView> => {
    const config = this.platformOrThrow(platform);
    // 会话挂载也是一条「自动化把真站装进视图」的路（2026-11-24 事故里两周接触点就是它）：
    // 非回环 startUrl 只在**人**点的这条路上放行，其余一律 fail-closed，除非装配侧显式打开 allowRealAutomation。
    const startHost = new URL(config.startUrl).hostname;
    if (source !== 'user' && !isLoopbackHost(startHost) && !this.allowRealAutomation) {
      throw new AppError(
        'REAL_PLATFORM_AUTOMATION_BLOCKED',
        `自动化不把内核视图挂到非本机地址：${config.startUrl}（host ${startHost}）。` +
          '真实平台只由人自己在会话面板里打开；确需人工在场跑自动化，先由装配侧显式打开 allowRealAutomation',
        'sessions',
        { pack: config.id, host: startHost, action: 'mount' },
      );
    }
    // 第一次打开前把旧的分平台登录态并进来（只 boss/fixture，web 不并）。
    await this.mergeLegacyPartitions();
    // 一个浏览器分区：平台只决定「打开哪个地址」，不再各开一份登录态（2026-11-22 裁定）。
    this.host.mountKernelSite(BROWSER_PARTITION, config.startUrl);
    this.ctx.logger.info(`内核视图已挂载会话：平台 ${config.id} · 分区 ${BROWSER_PARTITION} · ${config.startUrl}`);
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
   *
   * `unknown` 这一态**刻意不推**（spec 8.2-01）：它说的是"我没有足够证据"，而这条事件的语义是
   * "会话结束了，去重登"。真站上未标定/改版时推它，得到的就是 8.0-01 记下的那条假失效→接管循环。
   * @param platform 平台标识
   * @returns 该平台的会话读数
   */
  probe = async (platform: string): Promise<SessionPlatformView> => {
    const config = this.platformOrThrow(platform);
    const reading = await this.read(config);
    if (reading.view.auth === 'expired') {
      const reason = sessionExpiredReason(reading.verdict);
      this.ctx.emit('session/expired', { platform: config.id, reason, at: Date.now() });
      // 细分依据只进日志：事件的 reason 是界面与接管认得的两个码，而"到底是游客态还是全过期"
      // 是排查标定名单是否该跟着站点改版时唯一有用的数。
      this.ctx.logger.warn(
        `会话失效：平台 ${config.id} · 事件原因 ${reason} · 判定依据 ${reading.verdict.reasons.join('、')}`,
      );
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
      .fromPartition(BROWSER_PARTITION)
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
    // 只有**一个**分区了（2026-11-22 裁定），所以只挂一次；同一个 session 的同名事件只有一个 handler，
    // 按平台循环注册会互相覆盖（§9 的实测），平台归属改成按响应的 origin 反查。
    const browserSession = session.fromPartition(BROWSER_PARTITION);
    const origins = this.platforms.map((platform) => ({ id: platform.id, origin: new URL(platform.startUrl).origin }));
    browserSession.webRequest.onResponseStarted(MAIN_FRAME_FILTER, (details) => {
      let origin: string;
      try {
        origin = new URL(details.url).origin;
      } catch {
        return;
      }
      const owner = origins.find((row) => row.origin === origin);
      // 未登记来源的响应不交给风控判定：它不是任何平台的会话，归错平台会把别的站点算到平台头上。
      if (!owner) return;
      listener({
        platform: owner.id,
        url: details.url,
        statusCode: details.statusCode,
        statusLine: details.statusLine,
        at: Date.now(),
      });
    });
    this.ctx.logger.info(
      `主框架响应观测已挂载：分区 ${BROWSER_PARTITION}（按 origin 归属 ${String(origins.length)} 个平台）`,
    );
    return () => {
      // 摘除用的还是同一个 filter 对象：`onResponseStarted(filter, null)` 实测不抛错且此后零回调。
      browserSession.webRequest.onResponseStarted(MAIN_FRAME_FILTER, null);
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
  /** 迁移只跑一次（每次进程一遍）：cookie 逐条比对后复制，天然幂等。 */
  private legacyPartitionsMerged = false;

  /**
   * 把**旧的分平台分区**里的 cookie 并进单一浏览分区（2026-11-22 裁定）。
   *
   * 三条硬边界：
   * 1. **只并 `persist:boss` / `persist:fixture`**；`persist:web`（任意网页模式那套）**绝不并入**——
   *    不可信来源的 cookie 不该进主浏览器分区；
   * 2. 幂等：目标分区里已有「同名 + 同域 + 同路径」的 cookie 就跳过，所以重复跑只是空转；
   * 3. 旧分区**保留不删**（只读回滚点）。`localStorage` / IndexedDB 迁不了（Electron 没有跨分区导出 API），
   *    依赖它们的站点会要求重新登录——这条写进日志，不装成无缝迁移。
   */
  private async mergeLegacyPartitions(): Promise<void> {
    if (this.legacyPartitionsMerged) return;
    this.legacyPartitionsMerged = true;
    const target = session.fromPartition(BROWSER_PARTITION);
    const present = new Set((await target.cookies.get({})).map((row) => `${row.name}|${row.domain}|${row.path}`));
    let copied = 0;
    for (const legacy of ['boss', 'fixture'] as const) {
      const source = session.fromPartition(partitionFor(legacy));
      for (const row of await source.cookies.get({})) {
        // domain 在 Electron 的类型里可缺省（宿主 cookie）；缺了就跳过——没有域就写不回目标分区。
        if (row.domain === undefined) continue;
        const key = `${row.name}|${row.domain}|${row.path}`;
        if (present.has(key)) continue;
        try {
          await target.cookies.set({
            url: `${row.secure ? 'https' : 'http'}://${row.domain.replace(/^\./u, '')}${row.path}`,
            name: row.name,
            value: row.value,
            domain: row.domain,
            path: row.path,
            secure: row.secure,
            httpOnly: row.httpOnly,
            ...(row.expirationDate === undefined ? {} : { expirationDate: row.expirationDate }),
            ...(row.sameSite === undefined ? {} : { sameSite: row.sameSite }),
          });
          present.add(key);
          copied += 1;
        } catch (error) {
          this.ctx.logger.warn(
            `旧分区 cookie 迁移跳过一条（${legacy}/${row.name}）：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    this.ctx.logger.info(
      `浏览分区迁移完成：并进 ${String(copied)} 条 cookie（来源 boss/fixture；web 分区不并、localStorage 不迁）`,
    );
  }

  private async read(config: SessionsConfig['platforms'][number]): Promise<PlatformReading> {
    const partition = BROWSER_PARTITION;
    const platformSession = session.fromPartition(partition);
    // 共用一个分区之后，登录态必须**按该平台自己的源**读：不带 url 会把别的站点的 cookie 算进来。
    const cookies = summarizeCookies(await platformSession.cookies.get({ url: new URL(config.startUrl).origin }));
    const verdict = judgeAuth(
      cookies,
      {
        authCookieNames: config.authCookieNames,
        guestCookieNames: config.guestCookieNames,
        authMinPresence: config.authMinPresence,
      },
      Date.now(),
    );
    return {
      verdict,
      view: {
        id: config.id,
        partition,
        startUrl: config.startUrl,
        isPersistent: platformSession.isPersistent(),
        storagePath: platformSession.getStoragePath() ?? null,
        cookieNames: cookies.map((cookie) => cookie.name),
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
        // 工具面与界面打的是同一个 `open()`（§5.9 不许各长一套）；这里只负责把读数换成统一结果（5.1-11）。
        // 摘要不写「登录成功」——`open` 只保证会话分区在，登录态由读数里的 status 自己说。
        run: async ({ platform }) => {
          const status = await this.open(platform);
          return toolResult(status, {
            summary: `已打开 ${platform} 的会话分区，当前活动平台 ${status.activePlatform ?? '（无）'}，可读平台 ${String(status.platforms.length)} 个`,
            evidenceRefs: [`session:${platform}`],
          });
        },
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
