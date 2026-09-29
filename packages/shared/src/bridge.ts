/**
 * 渲染层与主进程之间的桥接契约（唯一真相源）。
 *
 * preload 依据 `RENDERER_ALLOWLIST` 生成代理对象，IPC 网关依据同一份名单校验入站调用，
 * 因此「渲染层能调什么」与「主进程允许什么」永远是同一个常量，不会漂移。
 */
import type {
  AppErrorPayload,
  KernelViewLoadError,
  LogLineView,
  PluginErrorView,
  SessionExpiredEvent,
  WorkflowProgressEvent,
  WorkflowRunView,
} from '@auto-cc/core';

/**
 * 错误载荷、日志行、插件失败、会话/视图事件与工作流 run 数据模型都定义在 `@auto-cc/core`
 * （那里是跨进程契约与 cordis 事件声明的归属地），这里原样转出，渲染层只认 `@auto-cc/shared`
 * 一个入口。转出**只用 `export type`**：core 会带进 cordis，而渲染层的 bundle 里不该出现它。
 * 步骤 id 常量 `WORKFLOW_STEP_IDS` 只有主进程执行器需要（界面渲染服务返回的 `run.steps`），
 * 所以不在此转出。
 */
export type {
  AppErrorPayload,
  KernelViewLoadError,
  LogLineView,
  PluginErrorView,
  SessionExpiredEvent,
  WorkflowProgressEvent,
  WorkflowRunStatus,
  WorkflowRunView,
  WorkflowStepId,
  WorkflowStepStatus,
  WorkflowStepView,
} from '@auto-cc/core';

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
  // 1.5 的运行时管理：一次快照 + 启停 + 配置读写 + 泄漏巡检。
  'plugins.status',
  'plugins.stop',
  'plugins.start',
  'plugins.readConfig',
  'plugins.saveConfig',
  'plugins.cycle',
  // 1.6 的自测通道：网关入站统计（1.6-12）与主进程侧目标对照（1.6-01 / 1.6-06）。
  'ipc.stats',
  'devtools.status',
  // 1.8 的内置内核会话：分区清单与登录态读数、打开站点、探测、登出。
  'sessions.status',
  'sessions.open',
  'sessions.probe',
  'sessions.logout',
  // 1.9 的外发额度闸门：判定、账本回看、以及唯一的外发样例入口。
  // 服务名带点（`域.能力`），所以界面侧拿到的是 `bridge.entitlement['gate.check']()`。
  'entitlement.gate.check',
  'usage.ledger.summary',
  'outbound.sample.send',
  // 1.10 的工作流 runner：五个动作口 + 一个只读快照。
  'workflow.runner.current',
  'workflow.runner.start',
  'workflow.runner.pause',
  'workflow.runner.resume',
  'workflow.runner.retryStep',
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
  /** 内核视图当前所占的会话分区；未挂载站点时是占位页的分区。 */
  kernelViewPartition: string;
  /** 内核视图当前 URL（占位页会以 `data:` 原样出现）。 */
  kernelViewUrl: string;
  /** 最近一次加载失败；成功加载后为 null，因此它总是「关于当前这个 URL」的。 */
  kernelViewLoadError: KernelViewLoadError | null;
  lastError: string | undefined;
};

/**
 * 一个平台的会话读数（spec 1.8-01 / 1.8-04 / 1.8-06）。
 *
 * 只带 cookie 的**名字**与过期时间，绝不含取值：这条快照会被渲染层显示、也会被 harness
 * 原样写进证据文件，一旦带上值就等于把登录凭证抄进日志与截图（AGENTS.md §8.5）。
 */
export type SessionPlatformView = {
  id: string;
  partition: string;
  startUrl: string;
  isPersistent: boolean;
  /** 分区在磁盘上的实际目录；in-memory 会话为 null，用于证明「落盘了」。 */
  storagePath: string | null;
  cookieNames: string[];
  /** 判定登录态所依据的 cookie 名。 */
  sessionCookieName: string;
  auth: 'active' | 'expired';
  /** 该 cookie 的过期时间戳（毫秒）；会话型 cookie 与缺席时为 null。 */
  expiresAt: number | null;
};

/** 会话总览：所有已配置平台 + 内核视图当前承载的是哪一个。 */
export type SessionsStatusView = { platforms: SessionPlatformView[]; activePlatform: string | null };

/**
 * 闸门一次判定的结果（spec 1.9-01）。
 *
 * `remaining` 用 `null` 表示「无限」而不是 `Infinity`：后者过不了 `structuredClone` 的语义期待，
 * 而且界面读到「剩余 ∞」和「剩余 0」的区别会被一个数字糊过去。
 * `reason` 只在被拒时非空，它是要**显示给用户看**的一句话，不是调试信息。
 */
export type GateDecisionView = { allowed: boolean; remaining: number | null; reason: string | null };

/** 账本里的一行（spec 1.9-04 / 1.9-08）。 */
export type LedgerRowView = {
  id: number;
  action: string;
  targetId: string | null;
  /** P1 还没有工作流执行器，所以这一列多为 null；列存在本身就是接线面的证据。 */
  workflowRunId: string | null;
  /** 毫秒时间戳，本地时区。 */
  ts: number;
  /** 可空：未来接 SaaS 后区分「本地记账」与「远端授权」。 */
  source: string | null;
  /** 可空：远端账单/流水的外部 id。 */
  remoteRef: string | null;
};

/** 用量回看的聚合读数（spec 1.9-07）：总数、按天分组、按动作分组，外加最近几行。 */
export type UsageSummaryView = {
  total: number;
  /** 本地「今天」的条数，与闸门日额度用的是同一个日界。 */
  today: number;
  byDay: { day: string; count: number; actions: { action: string; count: number }[] }[];
  byAction: { action: string; count: number }[];
  recent: LedgerRowView[];
};

/** 一次外发样例的入参（spec 1.9-03 / 1.9-04）。 */
export type SendSampleRequest = {
  action: string;
  targetId: string;
  message: string;
  workflowRunId?: string | null;
};

/** 外发成功后的回执：账本行 + 对端计数（P1 的「确实发出去了」由 fixture 的收件数证明）。 */
export type SendReceiptView = {
  action: string;
  targetId: string;
  /** 本次落账的账本行 id；被拒时根本走不到回执（决策 1：被拒不记账）。 */
  ledgerId: number;
  /** fixture 侧累计收到的条数。 */
  delivered: number;
};

/**
 * 内嵌内核视图占位区宽度占客户区宽度的比例。
 * 主进程用它摆 `WebContentsView`，渲染层用它摆对应的 Tailwind 槽位，两侧必须同源。
 */
export const KERNEL_VIEW_WIDTH_RATIO = 0.38;

/**
 * app 界面自己占的会话分区。
 * 主窗口刻意不用 default session：给了显式分区之后，「界面读不到站点 cookie」是分区名不同
 * 带来的结构事实，而不是恰好没共享（spec 1.8-02）。
 */
export const APP_PARTITION = 'persist:app';

/**
 * 平台站点分区名的唯一生成处（spec 1.8-01）。
 * @param platform 平台标识（如 `fixture` / `boss`），必须是 ASCII 短名
 * @returns `persist:` 前缀的分区名 —— Chromium 据此把该会话的 cookie/storage 落盘
 */
export const partitionFor = (platform: string): string => `persist:${platform}`;

/**
 * 插件树节点（spec 1.3-01 / 1.3-09 / 1.3-10 的界面证据）。
 * 1.4 起由 `kernel.tree` 直连给出，不再经 shell 代理。
 * 1.5 起带 `stack`：面板折叠显示完整调用栈（spec 1.5-07）。
 */
export type PluginNodeView = {
  id: string;
  state: 'pending' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading';
  dependsOn: string[];
  keys: string[];
  error?: string;
  stack?: string;
};

/** 内核快照：树 + 清单自身的错误（清单写坏时树可能是空的）。 */
export type PluginTreeSnapshot = { nodes: PluginNodeView[]; manifestError?: string };

/**
 * 运行时指标（spec 1.5-01 / 1.5-08）。
 * `registrySize` 回基线是「不泄漏」的判据；`registryCounter` 是单调挂载序号，只用于展示。
 */
export type PluginMetricsView = {
  registrySize: number;
  registryCounter: number;
  effectTotal: number;
  effects: { id: string; effects: number }[];
  activeResources: number;
};

/** 调试面板的一次性快照：指标 + 卸载闸门 + 错误历史。 */
export type PluginStatusView = {
  metrics: PluginMetricsView;
  /** 不允许从界面卸载的插件 id；面板据此决定要不要给某一行摆 Stop 按钮。 */
  guarded: string[];
  errorCount: number;
  errors: PluginErrorView[];
};

/** 反复启停后的对照（spec 1.5-08）：三个漂移都为 0 才算没泄漏。 */
export type PluginCycleView = {
  id: string;
  rounds: number;
  before: PluginMetricsView;
  after: PluginMetricsView;
  sizeDrift: number;
  effectDrift: number;
  resourceDrift: number;
};

/** 面板配置编辑器的读取结果（spec 1.5-06）：`mounted` 为 false 时新配置要等 Start 才生效。 */
export type PluginConfigView = { id: string; values: Record<string, unknown>; mounted: boolean };

/** 日志出口状态：落盘路径与生效级别。 */
export type LogStatusView = { file?: string; level: string };

/**
 * 网关入站统计（spec 1.6-12）：面板与 harness 的「调用成功率」同源。
 * `denied` 只数白名单拒绝，不含服务内部抛出的业务错误——那类失败在错误历史里看。
 */
export type IpcStatsView = { inFlight: number; completed: number; denied: number };

/** 主进程侧看到的一个页面目标（spec 1.6-06 的对照项）。 */
export type DevtoolsTargetView = {
  id: number;
  title: string;
  url: string;
  /** 是否主窗口的 webContents；剩下的就是内嵌内核视图等兄弟目标。 */
  isMainWindow: boolean;
  /** 当前是否持有键盘焦点：harness 点完一下就靠它确认焦点真的落到了这个目标上。 */
  isFocused: boolean;
};

/** 自测通道读数（spec 1.6-01 / 1.6-08）：CDP 开在哪个端口、主进程有几个目标。 */
export type DevtoolsStatusView = {
  isPackaged: boolean;
  isCdpEnabled: boolean;
  cdpPort: number | null;
  targetCount: number;
  targets: DevtoolsTargetView[];
};

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
  /** 运行时快照：指标 + 卸载闸门 + 错误历史（spec 1.5-01 / 1.5-07）。 */
  'plugins.status': { args: []; returns: PluginStatusView };
  'plugins.stop': { args: [id: string]; returns: PluginNodeView };
  'plugins.start': { args: [id: string]; returns: PluginNodeView };
  'plugins.readConfig': { args: [id: string]; returns: PluginConfigView };
  /** 保存并即时生效（spec 1.5-06）；非法字段以 `CONFIG_INVALID` 结构化错误失败。 */
  'plugins.saveConfig': { args: [id: string, patch: Record<string, unknown>]; returns: PluginNodeView };
  /** 反复启停做泄漏巡检（spec 1.5-08）。 */
  'plugins.cycle': { args: [id: string, rounds?: number]; returns: PluginCycleView };
  /** 网关入站统计（spec 1.6-12）：在途 / 已完成 / 白名单拒绝。 */
  'ipc.stats': { args: []; returns: IpcStatsView };
  /** 主进程侧的自测通道读数（spec 1.6-01 / 1.6-06），与 CDP `/json/list` 交叉核对。 */
  'devtools.status': { args: []; returns: DevtoolsStatusView };
  /** 会话总览：分区、落盘路径、cookie 名与登录判定（spec 1.8-01 / 1.8-04）。 */
  'sessions.status': { args: []; returns: SessionsStatusView };
  /** 让内核视图按该平台的分区打开起始地址（spec 1.8-02 / 1.8-08）。 */
  'sessions.open': { args: [platform: string]; returns: SessionsStatusView };
  /** 只读 cookie 判登录态，不发站点请求；失效时顺带推 `session/expired`（spec 1.8-06）。 */
  'sessions.probe': { args: [platform: string]; returns: SessionPlatformView };
  /** 清掉该平台分区的 cookie，用于验收「退出登录即清除」（spec 1.8-04）。 */
  'sessions.logout': { args: [platform: string]; returns: SessionPlatformView };
  /**
   * 闸门判定（spec 1.9-01 / 1.9-02）。界面只用它显示剩余额度，
   * **放行口是 `entitlement.gate.perform`**，它不在白名单里也不该在：越过账本的外发正是 1.9-05 要拦的形态。
   */
  'entitlement.gate.check': { args: [action: string]; returns: GateDecisionView };
  /** 账本回看：总数、按天、按动作，外加最近几行（spec 1.9-07 / 1.9-08）。 */
  'usage.ledger.summary': { args: [recentLimit?: number]; returns: UsageSummaryView };
  /** 外发样例：唯一经过闸门的外发入口，目标只有本地 fixture（AGENTS.md §7.2）。 */
  'outbound.sample.send': { args: [request: SendSampleRequest]; returns: SendReceiptView };
  /**
   * 当前 run 的快照（spec 1.10-04）；挂载即是 `idle` 的六步快照，所以永不为 null，界面不必为空态另写一套。
   * P1 只有一个「当前 run」，所以四个动作口都不带 runId（plan §8.5「不做 run 历史列表」）。
   */
  'workflow.runner.current': { args: []; returns: WorkflowRunView };
  /** 起一个占位工作流（六步空转），返回初始状态。 */
  'workflow.runner.start': { args: []; returns: WorkflowRunView };
  /** 请求暂停：等当前步协作让出，不强杀（spec 1.10-05）。 */
  'workflow.runner.pause': { args: []; returns: WorkflowRunView };
  /** 从当前步续跑，不重置已完成步（spec 1.10-05）。 */
  'workflow.runner.resume': { args: []; returns: WorkflowRunView };
  /** 单独重试某一个失败步（spec 1.10-06）；步 id 来自界面，越界即结构化失败。 */
  'workflow.runner.retryStep': { args: [stepId: string]; returns: WorkflowRunView };
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
export const RENDERER_EVENTS = ['log/line', 'session/expired', 'shell/view-error', 'workflow/progress'] as const;

export type RendererEventName = (typeof RENDERER_EVENTS)[number];

/** 每个事件的载荷形状，preload 的 `on` 据此收窄类型。 */
export interface RendererEventSignatures {
  'log/line': LogLineView;
  'session/expired': SessionExpiredEvent;
  'shell/view-error': KernelViewLoadError;
  'workflow/progress': WorkflowProgressEvent;
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
