/**
 * 渲染层与主进程之间的桥接契约（唯一真相源）。
 *
 * preload 依据 `RENDERER_ALLOWLIST` 生成代理对象，IPC 网关依据同一份名单校验入站调用，
 * 因此「渲染层能调什么」与「主进程允许什么」永远是同一个常量，不会漂移。
 */
import type { AppErrorPayload, LogLineView } from '@auto-cc/core';

/**
 * 错误载荷与日志行定义在 `@auto-cc/core`（那里是跨进程契约与 cordis 事件声明的归属地），
 * 这里原样转出，渲染层继续只认 `@auto-cc/shared` 一个入口。
 */
export type { AppErrorPayload, LogLineView } from '@auto-cc/core';

/** 渲染层可调用的 `service.method` 全限定名白名单（spec 1.4-07 的唯一依据）。 */
export const RENDERER_ALLOWLIST = [
  'shell.getStatus',
  'shell.setKernelViewVisible',
  'shell.probeMainCrash',
  'shell.probeRedact',
  'kernel.tree',
  'log.tail',
  'log.status',
  'ipc.probeReject',
] as const;

export type BridgeCallId = (typeof RENDERER_ALLOWLIST)[number];

/**
 * 判定某个调用名是否在白名单内。
 * @param id 形如 `shell.getStatus` 的调用名，来自不可信输入（渲染层）
 * @returns 命中白名单为 true；未登记的能力一律 false
 */
export const isAllowedCall = (id: string): id is BridgeCallId => (RENDERER_ALLOWLIST as readonly string[]).includes(id);

/**
 * 一次桥接调用的线格式。
 *
 * `path` 是**未收窄的字符串**：入站数据来自渲染层，类型不能替它说话，
 * 是否合法由网关按 `isAllowedCall` 判定。
 */
export type BridgeRequest = { path: string; args: unknown[] };

/**
 * 桥接调用的统一回复形态：失败带结构化错误（code/path/message），
 * 裸 `Error` 过不了 structuredClone，消息会整条丢掉（spec 1.4-04）。
 */
export type BridgeReply<T> = { ok: true; value: T } | { ok: false; error: AppErrorPayload };

/** 主进程状态快照，供渲染层首屏与错误态展示。 */
export type ShellStatus = {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  windowVisible: boolean;
  kernelViewVisible: boolean;
  kernelViewBounds: { x: number; y: number; width: number; height: number };
  lastError: string | undefined;
};

/**
 * 内嵌内核视图占位区宽度占客户区宽度的比例。
 * 主进程用它摆 `WebContentsView`，渲染层用它摆对应的 Tailwind 槽位，两侧必须同源。
 */
export const KERNEL_VIEW_WIDTH_RATIO = 0.38;

/**
 * 插件树节点（spec 1.3-01 / 1.3-09 / 1.3-10 的界面证据）。
 * 1.4 起由 `kernel.tree` 直连给出，不再经 shell 代理。
 */
export type PluginNodeView = {
  id: string;
  state: 'pending' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading';
  dependsOn: string[];
  keys: string[];
  error?: string;
};

/** 内核快照：树 + 清单自身的错误（清单写坏时树可能是空的）。 */
export type PluginTreeSnapshot = { nodes: PluginNodeView[]; manifestError?: string };

/** 日志出口状态：落盘路径与生效级别。 */
export type LogStatusView = { file?: string; level: string };

/** 每个白名单调用的入参元组与返回值，渲染层类型的来源。 */
export interface BridgeSignatures {
  'shell.getStatus': { args: []; returns: ShellStatus };
  'shell.setKernelViewVisible': { args: [visible: boolean]; returns: { kernelViewVisible: boolean } };
  'shell.probeMainCrash': { args: []; returns: never };
  /** 仅开发态：写一条含敏感字段的日志，回读走 `log.tail` 与事件推送。 */
  'shell.probeRedact': { args: []; returns: { written: true } };
  'kernel.tree': { args: []; returns: PluginTreeSnapshot };
  'log.tail': { args: [limit?: number]; returns: LogLineView[] };
  'log.status': { args: []; returns: LogStatusView };
  /**
   * 仅开发态：按给定 path 走一遍网关，网关放行时带回返回值，网关拒绝时以结构化错误失败
   * （1.4-04 / 1.4-07）。返回值刻意是 `unknown` 而不是 `BridgeReply`——信封只有一层。
   */
  'ipc.probeReject': { args: [path: string]; returns: unknown };
}

/**
 * 编译期保险丝：白名单新增一项而 `BridgeSignatures` 忘了补签名，这里立刻报错，
 * 不会出现「主进程允许、渲染层无类型」的漂移。
 */
export type BridgeSignaturesCovered = { [K in BridgeCallId]: BridgeSignatures[K] };

/** 从 `service.method` 里取出服务名段。 */
type NamespaceOf<Id extends BridgeCallId> = Id extends `${infer Service}.${string}` ? Service : never;

/**
 * 由 `BridgeSignatures` 推导的命名空间形状：`service` 段 → `method` 段 → 调用。
 *
 * 必须先用 `NamespaceOf` 把命名空间提成一层键：在 mapped type 的值位置里 `K` 仍是原始的
 * 完整调用名，直接拿它去 `Extract<..., `${K}.${string}`>` 会一个都不命中，整个命名空间就变成 `{}`。
 */
export type BridgeNamespaces = {
  [Service in NamespaceOf<BridgeCallId>]: {
    [Id in Extract<BridgeCallId, `${Service}.${string}`> as Id extends `${Service}.${infer Method}` ? Method : never]: (
      ...args: BridgeSignatures[Id]['args']
    ) => Promise<BridgeReply<BridgeSignatures[Id]['returns']>>;
  };
};

/**
 * 主进程→渲染层的事件白名单（spec 1.4-03）：没登记的事件在网关处就不出进程。
 * 事件是「推」的，界面靠它自增，不轮询。
 */
export const RENDERER_EVENTS = ['log/line'] as const;

export type RendererEventName = (typeof RENDERER_EVENTS)[number];

/** 每个事件的载荷形状，preload 的 `on` 据此收窄类型。 */
export interface RendererEventSignatures {
  'log/line': LogLineView;
}

/** 与 `BridgeSignaturesCovered` 同样的保险丝：新增事件名必须补载荷类型。 */
export type RendererEventSignaturesCovered = { [K in RendererEventName]: RendererEventSignatures[K] };

export const isAllowedEvent = (name: string): name is RendererEventName =>
  (RENDERER_EVENTS as readonly string[]).includes(name);

/** 一次事件推送的线格式。 */
export type RendererEvent = {
  [K in RendererEventName]: { event: K; payload: RendererEventSignatures[K] };
}[RendererEventName];

/** `window.autoCC` 的形状：preload 依白名单生成，渲染层只认这一个出口。 */
export type RendererBridge = BridgeNamespaces & {
  /** 订阅主进程推送的事件（spec 1.4-03）；返回退订函数。 */
  on: <N extends RendererEventName>(event: N, handler: (payload: RendererEventSignatures[N]) => void) => () => void;
};
