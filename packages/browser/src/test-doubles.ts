/**
 * 页面/帧/视图/服务替身（仅测试用）。
 *
 * 抽出来有两个原因：`frame-channel`、`input-channel` 与三个服务用例都在搭同一套假帧树、假视图
 * 与假读数（AGENTS.md §2.2 的「第二次就得抽」），而且 Electron 把 `WebFrameMain.parent` / `.frames`
 * 声明成**只读 getter**，用例里直接赋值会撞 TS2540——所以「怎么写一帧」必须只有一个出口。
 *
 * 服务替身存在的原因相同：`browser.locate` / `browser.act` / `browser.risk` 只经 `asApp(ctx)` 取几样东西
 * （shell 的视图句柄、页面服务的快照、定位服务的结局、会话的响应观测口、登记处的风控判据），
 * 用真的 `Context` 挂这几个替身，服务层用例就不必装 Electron 窗口，同时 `ctx.emit` / `ctx.logger` 都是真的。
 *
 * 视图替身还带一张最小的事件表（`once` / `removeListener` + `fireViewEvent`）：`settleLoad` 那类
 * 「等装载落定」的逻辑必须在摘干净监听这件事上被断言，而断言的前提是能把事件喂进去。
 */
import type { AppError } from '@auto-cc/core';
import {
  Service,
  type AgentToolDeclaration,
  type AgentToolRegistry,
  type Context,
  type ToolEffect,
  type ToolResult,
} from '@auto-cc/core';
import type {
  KernelPageSnapshotView,
  LocateResultView,
  LocatedReading,
  PlatformMetaView,
  PlatformRegistryView,
} from '@auto-cc/shared';
import type { MainFrameResponseReading } from '@auto-cc/plugin-sessions';
import type { NativeImage, WebContents, WebFrameMain } from 'electron';
import { z } from 'zod';
import type { CdpCommand } from './input-channel.js';

/** 替身帧里可以被测试改写的字段（其余字段由 `fakeFrame` 一次性造好）。 */
export type WritableFrame = {
  url: string;
  parent: WebFrameMain | null;
  frames: WebFrameMain[];
  framesInSubtree: WebFrameMain[];
};

/**
 * 五类注入脚本的名字。
 *
 * 真实页面里一条通道只跑一种脚本，但替身帧只有一双 `executeJavaScript` 的手，
 * 而 `browser.act` 一次动作要在同一帧里连跑等待 → 定位 → 动作 → 回读四样，
 * 所以替身必须按源码认出手里拿的是哪一种。
 */
export type ScriptKind =
  'locate' | 'fingerprint' | 'wait' | 'domAction' | 'valueRead' | 'iframeRects' | 'clickArm' | 'clickReceipt';

/**
 * 从注入脚本源码认出它是哪一类。
 *
 * 认的是各脚本独有的那句常量声明（`locator-script.ts` 里逐条核对过），不是内容哈希——
 * 新增一类脚本时这里要跟着加一条，否则会误判成 `locate`。
 * @param source 待求值的表达式源码
 * @returns 脚本类别，未知归为 `locate`
 */
export function scriptKindOf(source: string): ScriptKind {
  if (source.includes("'fingerprint'")) return 'fingerprint';
  if (source.includes('const kind =')) return 'wait';
  if (source.includes('const action =')) return 'domAction';
  if (source.includes("const receiptKind = 'arm'")) return 'clickArm';
  if (source.includes("const receiptKind = 'read'")) return 'clickReceipt';
  if (source.includes('const target = findNode(')) return 'valueRead';
  if (source.includes("'iframe, frame'")) return 'iframeRects';
  return 'locate';
}

/** 一帧替身的构造参数。 */
export type FakeFrameOptions = {
  /** iframe 元素的 name 属性。 */
  name?: string;
  /** 求值成功时的固定返回值（不区分脚本类别时用这个，例如只跑 iframeRects 的坐标折算用例）。 */
  value?: unknown;
  /** 求值失败时的原因。 */
  error?: string;
  /** 按脚本类别分别给返回值；优先级高于 `value`，缺的类别回落到 `value`。 */
  scripts?: Partial<Record<ScriptKind, unknown>>;
  /**
   * 传进来就逐次记下送到的脚本源码原文。
   *
   * 与 `fakeView` 的同名参数共用一个数组时，就能断言「先盖遮罩 → 再取像素 → 最后摘掉」这种
   * 跨对象的先后——分开记就只看得到各自发了几次，顺序信息会丢。
   */
  calls?: string[];
};

/**
 * 改写替身帧的树结构字段。
 * @param frame `fakeFrame` 造出的替身
 * @param patch 要覆盖的字段（只写这些，不做整对象替换，免得丢掉 `executeJavaScript`）
 */
export function writeFrame(frame: WebFrameMain, patch: Partial<WritableFrame>): void {
  Object.assign(frame as unknown as WritableFrame, patch);
}

/**
 * 造一帧替身。
 * @param url 帧地址（跨源帧的 `WebFrameMain.url` 也能读到，所以坐标折算的用例要靠它对号）
 * @param options 见 `FakeFrameOptions`；省略 `error` 时 `executeJavaScript` 兑现为对应的值
 * @returns 替身帧，可直接传给本包的帧工具函数
 */
export function fakeFrame(url: string, options: FakeFrameOptions = {}): WebFrameMain {
  return {
    url,
    name: options.name ?? '',
    parent: null,
    top: null,
    frames: [],
    framesInSubtree: [],
    executeJavaScript: (source?: unknown) => {
      const script = typeof source === 'string' ? source : '';
      options.calls?.push(script);
      if (options.error !== undefined) return Promise.reject(new Error(options.error));
      if (options.scripts) {
        return Promise.resolve(options.scripts[scriptKindOf(script)]);
      }
      return Promise.resolve(options.value);
    },
  } as unknown as WebFrameMain;
}

/** 视图替身观察到的东西：CDP 命令序列与 attach 计数。 */
export type FakeViewLog = {
  commands: CdpCommand[];
  attachCalls: number;
  detachCalls: number;
  /** true 时 `attach` 抛错（别的客户端已占用这条调试通道）。 */
  attachFails?: boolean;
  /** true 时 `sendCommand` 抛错（命令被拒）。 */
  sendFails?: boolean;
  /**
   * 按 CDP 方法名给出的回包；没给的方法回 `{}`（与真实的空回包同形）。
   * 文件注入那条链要逐条喂回包（帧树、隔离世界 id、objectId、页面读数），
   * 而它的命令方法名互不重复，所以按方法名给值就够，不需要按第几次给。
   * 值给成 `Error` 表示**这条**方法被拒（只让某一步失败才断言得出「失败落在哪一步」）。
   */
  responses?: Record<string, unknown>;
  /** true 时视图已销毁。 */
  isDestroyed?: boolean;
};

/**
 * 造一份可观察的视图日志。
 * @returns 空日志对象，直接传给 `fakeView`
 */
export function fakeViewLog(): FakeViewLog {
  return { commands: [], attachCalls: 0, detachCalls: 0 };
}

/**
 * `capturePage()` 的三种预设结局（spec 2.4-04 的截图分支）。
 *
 * 默认（不给这个字段）回一张有内容的图：截图失败的两种形态——抛错与空图——才是要断言的分支，
 * 让「成功」成为不写参数时的自然结果，用例里就只写它真正要演的那一件事。
 */
export type FakeCapture = {
  /** true 时 `capturePage()` 抛错（视图已销毁 / 渲染进程没响应）。 */
  fails?: boolean;
  /** true 时回一张空图（页面还没绘制，或视图是隐藏的那一个）。 */
  empty?: boolean;
  /** 非空图的尺寸（像素）。 */
  width?: number;
  /** 图片高度（像素）。 */
  height?: number;
};

/** 一张「有内容」的假 PNG：只带文件签名，够断言「字节原样交出去了」。 */
export const FAKE_PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 按预设结局造一个 `NativeImage` 替身。
 * @param capture 截图结局；不给就当这一帧有画面（800×600）
 * @returns 只被 `browser.page` 的截图分支读到的三个方法（`capturePage()` 的返回形状）
 */
function fakeNativeImage(capture: FakeCapture | undefined): NativeImage {
  const isEmpty = capture?.empty === true;
  return {
    isEmpty: () => isEmpty,
    getSize: () => ({ width: isEmpty ? 0 : (capture?.width ?? 800), height: isEmpty ? 0 : (capture?.height ?? 600) }),
    toPNG: () => FAKE_PNG_BYTES,
  } as unknown as NativeImage;
}

/** 一张视图事件表：事件名 → 当前挂着的一次性回调集合。 */
type ViewEventTable = Map<string, Set<() => void>>;

/**
 * 视图替身的事件表（按对象身份索引，用例不经过它就看不到）。
 *
 * 真实 `WebContents` 继承自 EventEmitter，`settleLoad` 只用到 `once` / `removeListener` 两个方法，
 * 所以这里也只装这两个——装多了会把「页面服务其实只依赖这两个」这件事糊掉。
 */
const viewEvents = new WeakMap<WebContents, ViewEventTable>();

/**
 * 造视图替身。
 * @param main 顶层帧（null 表示还没有文档）
 * @param subtree `framesInSubtree` 的内容，含顶层；省略表示只有顶层
 * @param options `url` 是当前地址（失败快照的 `snapshotRef` 要用）；`log` 给了就附上调试器门面；
 *  `capture` 决定 `capturePage()` 的结局
 * @returns 替身句柄，可直接传给本包的取句柄 / 求值 / 输入函数
 */
export function fakeView(
  main: WebFrameMain | null,
  subtree: WebFrameMain[] = [],
  options: { url?: string; log?: FakeViewLog; capture?: FakeCapture; calls?: string[] } = {},
): WebContents {
  if (main) writeFrame(main, { framesInSubtree: subtree.length > 0 ? subtree : [main] });
  const url = options.url ?? 'http://127.0.0.1:10233/boss';
  const table: ViewEventTable = new Map();
  const base = {
    mainFrame: main,
    isDestroyed: () => options.log?.isDestroyed === true,
    getURL: () => url,
    // 与真实 API 同形：`capturePage()` 返回 Promise，取不到画面是拒绝而不是同步抛出。
    // `calls` 与帧替身共用同一个数组时记的是「取像素」这一步本身，用例据此判先后。
    capturePage: () => {
      options.calls?.push('capturePage');
      if (options.capture?.fails) return Promise.reject(new Error('渲染进程没有响应截图请求'));
      return Promise.resolve(fakeNativeImage(options.capture));
    },
    once: (channel: string, handler: () => void) => {
      const handlers = table.get(channel) ?? new Set<() => void>();
      handlers.add(handler);
      table.set(channel, handlers);
    },
    removeListener: (channel: string, handler: () => void) => {
      table.get(channel)?.delete(handler);
    },
  };
  const log = options.log;
  let attached = false;
  const view = (log
    ? {
        ...base,
        debugger: {
          attach: () => {
            log.attachCalls += 1;
            if (log.attachFails) throw new Error('另一个调试器已连接');
            attached = true;
          },
          isAttached: () => attached,
          detach: () => {
            log.detachCalls += 1;
            attached = false;
          },
          sendCommand: (method: string, params: Record<string, unknown>) => {
            if (log.sendFails) throw new Error('命令被拒');
            log.commands.push({ method, params });
            const response = log.responses?.[method] ?? {};
            // 值给成 Error 就是「这一条被拒」——与真实 debugger 一样走拒绝，而不是同步抛出。
            return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
          },
        },
      }
    : base) as unknown as WebContents;
  viewEvents.set(view, table);
  return view;
}

/**
 * 让视图替身发出一个装载事件（`settleLoad` 的两条成功/失败出口）。
 * @param contents `fakeView` 造出的替身
 * @param channel 事件名（`did-finish-load` / `did-fail-load`）
 * @throws 传进来的不是 `fakeView` 造的视图时抛错——静默返回会让用例「等不到事件」而误判成超时分支
 */
export function fireViewEvent(contents: WebContents, channel: string): void {
  const table = viewEvents.get(contents);
  if (!table) throw new Error('fireViewEvent 只认 fakeView 造出的视图');
  const handlers = [...(table.get(channel) ?? [])];
  // 与 EventEmitter 的 `once` 同形：触发一次就从表里摘掉。
  table.delete(channel);
  for (const handler of handlers) handler();
}

/**
 * 读出视图上**还挂着**回调的事件名（按字典序）。
 *
 * 存在的唯一理由：`settleLoad` 承诺「落定就把两条监听摘干净」，而不留监听这件事从外面看不见——
 * 一次导航挂一对、导航十次就攒二十个回调，Electron 只会.warn 一句，用例必须能直接数出来。
 * @param contents `fakeView` 造出的替身
 * @returns 仍有至少一个回调的事件名；`fireViewEvent` 造出的空表不计（表壳留下不算泄漏）
 * @throws 传进来的不是 `fakeView` 造的视图时抛错（同 `fireViewEvent`，静默回空数组会把「没监听」看成通过）
 */
export function viewListenerChannels(contents: WebContents): string[] {
  const table = viewEvents.get(contents);
  if (!table) throw new Error('viewListenerChannels 只认 fakeView 造出的视图');
  return [...table.entries()]
    .filter(([, handlers]) => handlers.size > 0)
    .map(([channel]) => channel)
    .sort();
}

/**
 * 造一份「带调试器门面」的视图替身，并把观察用的日志一起交出来。
 * @param options 视图的帧树、地址，以及 attach / sendCommand 是否失败
 *  （失败路径必须能演：CDP 用不了时要退回 DOM 通道，spec 2.2-12）
 * @returns 替身句柄与日志
 */
export function fakeDebuggerView(
  options: {
    main?: WebFrameMain | null;
    subtree?: WebFrameMain[];
    url?: string;
    attachFails?: boolean;
    sendFails?: boolean;
    isDestroyed?: boolean;
    responses?: Record<string, unknown>;
  } = {},
): { contents: WebContents; log: FakeViewLog } {
  const log: FakeViewLog = {
    commands: [],
    attachCalls: 0,
    detachCalls: 0,
    attachFails: options.attachFails,
    sendFails: options.sendFails,
    responses: options.responses,
    isDestroyed: options.isDestroyed,
  };
  return { contents: fakeView(options.main ?? null, options.subtree ?? [], { url: options.url, log }), log };
}

/**
 * 造一条页面读数（帧内脚本的返回形状）。
 *
 * 服务层用例喂的是**已经钳好的形状**，因为打分与判定由 `locator-spec.test.ts` 覆盖，
 * 这里要验的是服务怎么把判定拼成结局、什么时候自愈、什么时候发事件。
 * @param frameUrl 读数所属帧地址
 * @param overrides 与默认值的差异项（策略、下标、可见性、矩形……）
 * @returns 一条字段齐全的读数
 */
export function fakeReading(frameUrl: string, overrides: Partial<LocatedReading> = {}): LocatedReading {
  return {
    frameUrl,
    candidateIndex: 0,
    strategy: 'testId',
    siblingCount: 1,
    nodeIndex: 0,
    hitIndex: 0,
    visible: true,
    enabled: true,
    unobstructed: true,
    tagName: 'button',
    role: 'button',
    accessibleName: '打招呼',
    text: '打招呼',
    attributes: { 'data-testid': 'greet-button' },
    ancestorRoles: [],
    nearbyTexts: [],
    rect: { x: 10, y: 20, width: 100, height: 40 },
    ...overrides,
  };
}

const emptyConfig = z.strictObject({});

/**
 * `shell` 替身：只提供视图句柄与分区读数，正是 `requireKernelContents` 要的那两个方法。
 *
 * `contents` 是**可写字段**——用例先挂载、后换视图（例如「先没会话再开会话」）时，
 * 服务每次调用读到的都是最新值，这才有办法断言 `NO_KERNEL_SESSION` 那条分支。
 */
export class FakeShellService extends Service {
  static provide = 'shell';
  static Config = emptyConfig;

  contents: WebContents | null = null;

  constructor(ctx: Context) {
    super(ctx, 'shell');
  }

  /** @returns 当前挂载的内核视图；null 表示还没有会话 */
  kernelContents = (): WebContents | null => this.contents;

  /** @returns 只含界面要读的那一个字段 */
  getStatus = (): { kernelViewPartition: string } => ({
    kernelViewPartition: this.contents ? 'persist:fixture' : '',
  });
}

/**
 * `sessions` 替身：凑齐 `browser.page` 的 `static inject`，并替 `browser.risk` 演「分区里来了一条响应」。
 *
 * 页面服务只经它问「这个平台签过自动化风险确认没有」（导航许可的第二道闸门），所以这里给一个
 * 可写的签字集合——默认一个都没签，用例要放行真源就自己往里加。
 * 观测那条口子在真实现里挂在 Electron 分区上，替身把它降级成「记下来，等用例手动喂一条读数」，
 * 于是风控用例不需要 Electron 也能演完整条「响应 → 判据 → 事件」。
 */
export class FakeSessionsService extends Service {
  static provide = 'sessions';
  static Config = emptyConfig;

  /** 观测挂载的次数（同一时刻只应有一个独占者，spec 2.7-01）。 */
  observeCalls = 0;
  /** 摘除函数被调用的次数。 */
  unobserveCalls = 0;
  /** 已签字的平台名集合：用例直接往这里写，模拟「用户在风险确认卡上按过」。 */
  readonly consented = new Set<string>();

  private listener: ((reading: MainFrameResponseReading) => void) | null = null;

  constructor(ctx: Context) {
    super(ctx, 'sessions');
  }

  /**
   * 契约见 `ConsentGate.hasConsent`：库里有没有这一行签字。
   * @param platform 平台标识
   * @returns 用例把它写进 `consenteds` 才是 true（默认全没签）
   */
  hasConsent = (platform: string): boolean => this.consented.has(platform);

  /**
   * 与真实现同形的观测口：只留最后一次挂进来的 listener，摘除时清空。
   * @param listener 主框架响应读数回调
   * @returns 摘除函数（真实现要等 app ready 才交出来，所以两边都是 Promise）
   */
  observeMainFrameResponses = (listener: (reading: MainFrameResponseReading) => void): Promise<() => void> => {
    this.observeCalls += 1;
    this.listener = listener;
    return Promise.resolve(() => {
      this.unobserveCalls += 1;
      if (this.listener === listener) this.listener = null;
    });
  };

  /**
   * 用例用的「分区里来了一条主框架响应」。
   * @param reading 响应读数；`platform` 缺省为 `fixture`（替身只登记了这一个平台）
   */
  fireMainFrameResponse = (reading: Partial<MainFrameResponseReading> & { url: string; statusCode: number }): void => {
    this.listener?.({
      platform: 'fixture',
      statusLine: '',
      at: 1,
      ...reading,
    });
  };
}

/**
 * `platform.registry` 替身：风控观测层只经它取「这个平台的风控文案判据」（spec 2.7-01），
 * 页面服务经它取导航许可名单（spec 8.1-05），所以这里给一个可写的平台清单。
 *
 * 真登记处的规则与渠道投影由 `platform-registry.test.ts` 覆盖，这里只给两个可写的读数，
 * 让风控用例能演「有判据 → 读页面」与「没判据 → 只按状态码判」两条分支。
 */
export class FakePlatformRegistryService extends Service {
  static provide = 'platform.registry';
  static Config = emptyConfig;

  /** 可写的风控判据；null 表示「这个平台没声明文案判据」。 */
  riskPattern: string | null = null;

  /** 可写的平台清单：用例直接往这里 push，模拟「某个平台包登记进来了」。 */
  readonly platforms: PlatformMetaView[] = [];

  constructor(ctx: Context) {
    super(ctx, 'platform.registry');
  }

  /** @param platform 平台标识 @returns 替身预设的判据（不区分平台） */
  riskPatternOf = (): string | null => this.riskPattern;

  /** @returns 替身当前那份可写清单（与真实现同形：只读投影、不含选择器） */
  list = (): PlatformRegistryView => ({ platforms: this.platforms });
}

/**
 * `browser.page` 替身：计数 + 可预设的快照读数。
 *
 * 定位与动作用例只关心快照被读了几次（spec 2.2-04 的「成功时一次都不该读」），
 * 风控用例则要喂一份「页面上写着安全验证」的正文，所以快照内容做成可覆盖的。
 */
export class FakePageService extends Service {
  static provide = 'browser.page';
  static Config = emptyConfig;

  snapshotCalls = 0;

  /** 覆盖快照里的任意字段（风控用例改 `bodyText` / `title`，其余保持默认的空页面）。 */
  snapshotOverride: Partial<KernelPageSnapshotView> = {};

  /** true 时 `snapshot()` 以拒绝失败：风控用例要演「正文读不到」这一支，而不是假设它永远读得到。 */
  snapshotFails = false;

  constructor(ctx: Context) {
    super(ctx, 'browser.page');
  }

  /**
   * 与真实页面服务同形：交出一个 Promise，读不到正文是**拒绝**而不是同步抛出。
   * @returns 一份字段齐全的页面快照，按 `snapshotOverride` 覆盖后交出
   */
  snapshot = (): Promise<KernelPageSnapshotView> => {
    this.snapshotCalls += 1;
    if (this.snapshotFails) return Promise.reject(new Error('替身按用例拒绝读取正文'));
    const snapshot: KernelPageSnapshotView = {
      title: '仿站',
      url: 'http://127.0.0.1:10233/boss',
      readyState: 'complete',
      elementCount: 1,
      textLength: 0,
      bodyText: '',
      headings: [],
      partition: 'persist:fixture',
      ...this.snapshotOverride,
    };
    return Promise.resolve(snapshot);
  };
}

/** 替身没预设结局时的定位读数（与真服务的 `not-found` 分支同形）。 */
const NOT_FOUND_LOCATE_RESULT: LocateResultView = {
  status: 'not-found',
  spec: { description: '未预设', cardinality: 'single', candidates: [] },
  chosen: null,
  ranked: [],
  reason: '替身未预设定位结局',
  relocated: false,
  snapshotRef: 'fixture@0',
  snapshot: null,
  at: 0,
};

/**
 * `browser.locate` 替身：动作用例据此演「过线」与「没过线」两条分支。
 *
 * 定位本身的规则由 `locate-service.test.ts` 覆盖，重复跑一遍真定位只会让动作用例更难读（AGENTS.md §2.6）。
 */
export class FakeLocateService extends Service {
  static provide = 'browser.locate';
  static Config = emptyConfig;

  result: LocateResultView | null = null;

  constructor(ctx: Context) {
    super(ctx, 'browser.locate');
  }

  /** @returns 用例预设的定位结局；没预设就当「所有候选都没命中」 */
  find = (): Promise<LocateResultView> => Promise.resolve(this.result ?? NOT_FOUND_LOCATE_RESULT);
}

/**
 * 读结构化错误的附加数据。
 * @param error 抛出的错误（断言前先确认它是 AppError）
 * @returns `details` 按记录表读——它声明为 unknown，界面与测试都只能自己取键
 */
export function errorDetails(error: unknown): Record<string, unknown> {
  return (error as AppError).details as Record<string, unknown>;
}

/**
 * 假的 `agent.tools`：只做「往里放、往外摘」这两只手（spec 2.8-08 的登记表替身）。
 *
 * 不复用真 `AgentToolsService` 的原因是依赖方向：注册表属于 L3 对话插件，本包（L2）连测试都不该
 * import 它，而跨包共享一个测试替身要新建一个包（§4.3 得先在 plan 里记理由）。三个 L2 包各留一份
 * 这样的薄替身，与 `FakeSessionsService` 在 browser / outbound 各有一份是同一条先例。
 */
export class FakeAgentToolsService extends Service implements AgentToolRegistry {
  static provide = 'agent.tools';
  static Config = z.strictObject({});

  /** 收到的声明，`Map` 的迭代序即登记顺序。 */
  readonly declarations = new Map<string, AgentToolDeclaration>();

  /** 被摘回的 id，按摘除顺序（销毁那条用例的读数）。 */
  readonly removed: string[] = [];

  constructor(ctx: Context) {
    super(ctx, 'agent.tools');
  }

  /** 契约见 `AgentToolRegistry.register`。 */
  register<I>(tool: AgentToolDeclaration<I>): void {
    this.declarations.set(tool.id, tool);
  }

  /** 契约见 `AgentToolRegistry.unregister`。 */
  unregister(id: string): boolean {
    this.removed.push(id);
    return this.declarations.delete(id);
  }

  /**
   * 清单读数：id + 副作用分级 + 批准位，正是 2.8-08 判据要逐条核对的三样。
   * @returns 按登记顺序排列的元数据
   */
  list(): { id: string; effect: ToolEffect; requiresConfirmation: boolean }[] {
    return [...this.declarations.values()].map((tool) => ({
      id: tool.id,
      effect: tool.effect,
      requiresConfirmation: tool.requiresConfirmation,
    }));
  }

  /**
   * 复现真注册表的调用两步：先过声明自己的 schema，再打实现。
   *
   * 实现抛错时**原样上抛**（真注册表把它收成 `TOOL_FAILED`，那一步由 `agent` 包的用例断言），
   * 于是用例断言的是页面 / 定位 / 动作服务自己那批错误码。
   * @param id 工具 id
   * @param rawInput 未收窄的入参（来自模型或界面，按不可信输入处理）
   * @returns schema 通过时是实现产出的统一读数（spec 5.1-11 的 `ToolResult`）；不通过时带回 `INPUT_INVALID`，id 没登记带回 `NOT_REGISTERED`
   */
  async call(id: string, rawInput: unknown): Promise<{ ok: true; result: ToolResult } | { ok: false; reason: string }> {
    const tool = this.declarations.get(id);
    if (!tool) return { ok: false, reason: 'NOT_REGISTERED' };
    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) return { ok: false, reason: 'INPUT_INVALID' };
    return { ok: true, result: await tool.run(parsed.data) };
  }
}
