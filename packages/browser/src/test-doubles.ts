/**
 * 页面/帧/视图/服务替身（仅测试用）。
 *
 * 抽出来有两个原因：`frame-channel`、`input-channel` 与三个服务用例都在搭同一套假帧树、假视图
 * 与假读数（AGENTS.md §2.2 的「第二次就得抽」），而且 Electron 把 `WebFrameMain.parent` / `.frames`
 * 声明成**只读 getter**，用例里直接赋值会撞 TS2540——所以「怎么写一帧」必须只有一个出口。
 *
 * 服务替身存在的原因相同：`browser.locate` / `browser.act` 只经 `asApp(ctx)` 取三样东西
 * （shell 的视图句柄、页面服务的快照、定位服务的结局），用真的 `Context` 挂这几个替身，
 * 服务层用例就不必装 Electron 窗口，同时 `ctx.emit` / `ctx.logger` 都是真的。
 */
import type { AppError } from '@auto-cc/core';
import { Service, type Context } from '@auto-cc/core';
import type { LocateResultView, LocatedReading, SessionsStatusView } from '@auto-cc/shared';
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
export type ScriptKind = 'locate' | 'fingerprint' | 'wait' | 'domAction' | 'valueRead' | 'iframeRects';

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
      if (options.error !== undefined) return Promise.reject(new Error(options.error));
      if (options.scripts) {
        return Promise.resolve(options.scripts[scriptKindOf(typeof source === 'string' ? source : '')]);
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
  options: { url?: string; log?: FakeViewLog; capture?: FakeCapture } = {},
): WebContents {
  if (main) writeFrame(main, { framesInSubtree: subtree.length > 0 ? subtree : [main] });
  const url = options.url ?? 'http://127.0.0.1:10233/boss';
  const base = {
    mainFrame: main,
    isDestroyed: () => options.log?.isDestroyed === true,
    getURL: () => url,
    // 与真实 API 同形：`capturePage()` 返回 Promise，取不到画面是拒绝而不是同步抛出。
    capturePage: () => {
      if (options.capture?.fails) return Promise.reject(new Error('渲染进程没有响应截图请求'));
      return Promise.resolve(fakeNativeImage(options.capture));
    },
  };
  const log = options.log;
  if (!log) return base as unknown as WebContents;
  let attached = false;
  return {
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
  } as unknown as WebContents;
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
 * `sessions` 替身：只为凑齐 `browser.page` 的 `static inject`。
 *
 * 页面服务只经它读「已登记平台的起始地址」（导航许可名单的唯一来源），所以这里就给一条
 * fixture 平台的地址——测试用不到登录判定，而 `ctx.plugin` 会按 inject 名单要求服务先就位。
 */
export class FakeSessionsService extends Service {
  static provide = 'sessions';
  static Config = emptyConfig;

  constructor(ctx: Context) {
    super(ctx, 'sessions');
  }

  /** @returns 只有 fixture 一条平台的会话读数（其余字段按界面要的形状给固定值） */
  status = (): Promise<SessionsStatusView> =>
    Promise.resolve({
      platforms: [
        {
          id: 'fixture',
          partition: 'persist:fixture',
          startUrl: 'http://127.0.0.1:10233/boss',
          isPersistent: true,
          storagePath: null,
          cookieNames: [],
          sessionCookieName: 'fixture_session',
          auth: 'active' as const,
          expiresAt: null,
        },
      ],
      activePlatform: 'fixture',
    });
}

/**
 * `browser.page` 替身：只关心快照被读了几次——按 spec 2.2-04，成功时一次都不该读。
 */
export class FakePageService extends Service {
  static provide = 'browser.page';
  static Config = emptyConfig;

  snapshotCalls = 0;

  constructor(ctx: Context) {
    super(ctx, 'browser.page');
  }

  /** @returns 一份固定快照摘要（真实快照的形状由 page-script 的用例覆盖） */
  snapshot = (): Promise<Record<string, unknown>> => {
    this.snapshotCalls += 1;
    return Promise.resolve({
      title: '仿站',
      url: 'http://127.0.0.1:10233/boss',
      readyState: 'complete',
      elements: 1,
      text: '',
      headings: [],
      partition: 'persist:fixture',
    });
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
