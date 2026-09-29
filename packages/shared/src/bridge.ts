/**
 * 渲染层与主进程之间的桥接契约（唯一真相源）。
 *
 * preload 依据 `RENDERER_ALLOWLIST` 生成代理对象，主进程依据同一份名单校验入站调用，
 * 因此「渲染层能调什么」与「主进程允许什么」永远是同一个常量，不会漂移。
 */

/** 渲染层可调用的 `service.method` 全限定名白名单。 */
export const RENDERER_ALLOWLIST = [
  'shell.getStatus',
  'shell.setKernelViewVisible',
  'shell.probeMainCrash',
  'shell.probeIllegalCall',
] as const;

export type BridgeCallId = (typeof RENDERER_ALLOWLIST)[number];

/**
 * 判定某个调用名是否在白名单内。
 * @param id 形如 `shell.getStatus` 的调用名，来自不可信输入（渲染层）
 * @returns 命中白名单为 true；未登记的能力一律 false
 */
export const isAllowedCall = (id: string): id is BridgeCallId => (RENDERER_ALLOWLIST as readonly string[]).includes(id);

/** 一次桥接调用的载荷。 */
export type BridgeRequest = { id: BridgeCallId; args: unknown[] };

/** 桥接调用的统一回复形态：失败带可读原因，不抛裸异常跨过进程边界。 */
export type BridgeReply<T> = { ok: true; value: T } | { ok: false; error: string };

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

/** 每个白名单调用的入参元组与返回值，渲染层类型的来源。 */
export interface BridgeSignatures {
  'shell.getStatus': { args: []; returns: ShellStatus };
  'shell.setKernelViewVisible': { args: [visible: boolean]; returns: { kernelViewVisible: boolean } };
  'shell.probeMainCrash': { args: []; returns: never };
  'shell.probeIllegalCall': { args: []; returns: BridgeReply<unknown> };
}

/**
 * 编译期保险丝：白名单新增一项而 `BridgeSignatures` 忘了补签名，这里立刻报错，
 * 不会出现「主进程允许、渲染层无类型」的漂移。
 */
export type BridgeSignaturesCovered = { [K in BridgeCallId]: BridgeSignatures[K] };

/** `window.autoCC` 的形状：preload 依白名单生成，渲染层只认这一个出口。 */
export interface RendererBridge {
  shell: {
    getStatus: () => Promise<BridgeReply<ShellStatus>>;
    setKernelViewVisible: (visible: boolean) => Promise<BridgeReply<{ kernelViewVisible: boolean }>>;
    probeMainCrash: () => Promise<BridgeReply<never>>;
    probeIllegalCall: () => Promise<BridgeReply<unknown>>;
  };
}
