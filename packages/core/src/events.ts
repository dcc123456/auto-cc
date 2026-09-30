/**
 * 跨进程的 cordis 事件契约（spec 1.4-03）。
 *
 * `Events` 的字符串键必须由模块增补声明，而全应用只有 `core` 允许接触 cordis
 * （见 eslint 的 CORDIS 限制），所以「哪些事件可以出进程」的声明集中在这里；
 * 网关侧另有 `RENDERER_EVENTS` 白名单，两者一起构成事件出口的双层收口。
 */

/**
 * 一条已脱敏日志的线格式；渲染层视图与主进程事件载荷共用同一形状。
 */
export interface LogLineView {
  ts: number;
  level: string;
  name: string;
  text: string;
}

/**
 * 插件失败事件（spec 1.5-07）。
 *
 * `stack` 是完整调用栈：界面上折叠显示，展开才看得见，所以它必须越过 IPC 边界，
 * 但不能进日志文本（日志只留 message，见 `kernel` 的 `record`）。
 */
export interface PluginErrorView {
  id: string;
  message: string;
  stack?: string;
  at: number;
}

/**
 * 会话登录态失效事件（spec 1.8-06）。
 *
 * 只带平台名与判定原因：这条载荷会被推到渲染层、也可能被 harness 原样写进证据文件，
 * 一旦带上 cookie 值就等于把登录凭证抄进截图（AGENTS.md §8.5）。
 */
export interface SessionExpiredEvent {
  platform: string;
  /** `missing` = 分区里根本没有会话 cookie；`expired` = 有但已过期。 */
  reason: 'missing' | 'expired';
  /** 判定基准时间戳（毫秒）。 */
  at: number;
}

/** 内嵌内核视图的一次加载失败（`did-fail-load`），1.8-09 要求它必须能被界面读到。 */
export interface KernelViewLoadError {
  code: number;
  description: string;
  url: string;
}

/**
 * 步骤槽位的 id。
 *
 * 2.4 起它是**计划里的节点 id**（`WorkflowNodeSpec.id`），不再是固定的一份六步清单：
 * 换一条计划就换一批槽位，界面按返回的 `steps` 画，仓库里因此不存在第二份步骤列表。
 * 曾经的 `WORKFLOW_STEP_IDS` 常量随 1.10 的六步占位流水线一起退场（plan §11.3 第 2 条）。
 */
export type WorkflowStepId = string;

/** run 的整体状态（spec 1.10-03 点名的五个态）。 */
export type WorkflowRunStatus = 'idle' | 'running' | 'paused' | 'failed' | 'done';

/** 单个步骤的状态；`pending` 也要出现在视图里，因为界面得显示"还没轮到"的槽位。 */
export type WorkflowStepStatus = 'pending' | 'running' | 'done' | 'failed';

/** 一个步骤槽位的读数（spec 1.10-06：状态 + 耗时）。 */
export type WorkflowStepView = {
  id: WorkflowStepId;
  status: WorkflowStepStatus;
  /** 开始时间戳（毫秒）；未开始为 null。 */
  startedAt: number | null;
  /** 结束时间戳（毫秒）；未结束为 null。 */
  finishedAt: number | null;
  /** 耗时毫秒；未结束为 null——不用 0 冒充「耗时为零」。 */
  durationMs: number | null;
  /** 失败原因文案，仅 `failed` 时非空。 */
  error: string | null;
};

/**
 * 停下来的原因（spec 2.1-08 / 2.4-06）。
 *
 * `missing` / `expired` 来自会话探测；`unobserved-side-effect` 是「上一次外发开始了但没观察到完成」，
 * 此时自动重放有发两遍的风险，只能等人确认（plan §11.3 第 5 条）；`manual-takeover` 是节点自己
 * 声明的接管点（验证码/风控一类，plan §11.8 的「不做识别与规避」）。
 */
export type WorkflowTakeoverReason = 'missing' | 'expired' | 'unobserved-side-effect' | 'manual-takeover';

/**
 * 人工接管点（spec 2.1-08 / 2.4-06）。
 *
 * 刻意是**结构化数据而不是一句话**：主进程拼好的中文文案进不了 i18n（AGENTS.md §5.5 要求
 * 页面每条文案都走语言包），而「卡在哪个对象、因为什么、停在第几步」才是界面组织句子需要的。
 */
export type WorkflowTakeoverView = {
  /**
   * 接管对象的归属名：会话失效时是平台名（`boss`），未观察外发时是执行器名（`jd.greet`）。
   * 它不是翻译键也不是句子——界面只把它当参数插进文案，所以两种接管共用同一个字段。
   */
  subject: string;
  /** 判定依据；见 `WorkflowTakeoverReason`。 */
  reason: WorkflowTakeoverReason;
  /** 停在哪个步骤上等待接管。 */
  stepId: WorkflowStepId;
  /** 记下接管的时间戳（毫秒）。 */
  at: number;
};

/**
 * 一次 run 的完整可序列化状态（spec 1.10-03 / 1.10-05）。
 *
 * 刻意做成普通数据而不是解释器内部状态：界面读数、事件载荷、P2 落库共用同一形状，
 * 于是「续跑」就是把 `stepIndex` 指回去，不需要快照/还原那一层机制（plan §8.5 选型）。
 */
export type WorkflowRunView = {
  runId: string;
  status: WorkflowRunStatus;
  /** 当前步下标；`done` 时等于步数（越界一位），`idle`/`paused` 时指向要跑的那一步。 */
  stepIndex: number;
  steps: WorkflowStepView[];
  /** run 创建时间戳（毫秒）。 */
  startedAt: number;
  /**
   * 人工接管点（spec 2.1-08）；null 表示当前没有等待用户的事。
   * 它与 `status: 'paused'` 是两件事：暂停可以是用户自己点的，接管一定是机器被要求停手。
   */
  requiresHuman: WorkflowTakeoverView | null;
};

/**
 * 节点迁移的相位（spec 2.4-02 字面要的 `node.started/finished/failed`）。
 *
 * 刻意做成**字段而不是新事件名**：`workflow/progress` 已经被 1.10 的工作流面板与 1.11 的工具卡片
 * 订阅，再开一条频道就会出现「两个界面各拿到一半进度」（AGENTS.md §2.5 / plan §11.3 第 1 条）。
 * `retrying` 是 2.4-03 退避重试的那一次播报，不在 spec 字面里但缺了它界面只能显示「失败」。
 */
export type WorkflowNodePhase = 'started' | 'finished' | 'failed' | 'retrying';

/**
 * 一次进度推进的事件载荷（spec 1.10-04：界面进度是流式推送，不是轮询出来的）。
 *
 * 带整份 `run` 而不是增量：渲染层因此不自己推导状态，
 * 「面板与对话镜像同一个 runner」（1.10-08）就退化成同一段 JSON 渲染两次。
 */
export type WorkflowProgressEvent = {
  run: WorkflowRunView;
  /** 触发本次推送的步骤；run 级迁移（start / pause / resume）时为 null。 */
  stepId: WorkflowStepId | null;
  /** 节点迁移相位；run 级迁移时为 null（spec 2.4-02）。 */
  phase: WorkflowNodePhase | null;
  /** 面向用户的一句话说明，纯状态迁移时为 null。 */
  message: string | null;
};

/**
 * 一个节点的**声明**（spec 2.4-01）——计划里写死的东西，不是跑到一半的读数。
 *
 * `kind` 是 `string` 而不是联合类型，理由与 `LocatorRelocatedEvent.strategy` 同一条：
 * 合法的 kind 由 `workflow` 包的执行器注册表决定，而 `core` 在它之下，不能反向依赖。
 * 注册表里没有的 kind 在计划装配期就被拒绝（`INVALID_ARGUMENT`），不会跑到一半才发现。
 * @see docs/plans/02-browser-automation/plan.md §11.3 第 1 条
 */
export type WorkflowNodeSpec = {
  id: string;
  /** 执行器名：runner 按它分派，不认识任何平台（plan §3 规则 2）。 */
  kind: string;
  /**
   * 目标标识，参与幂等键 `runId + nodeId + target`（spec 2.4-06）。
   * 只读节点没有目标可去重，用空串——空串是「本节点不按目标去重」的唯一合法表示。
   */
  target: string;
  /** 节点参数：只允许声明值（数字/字符串/布尔），P2 不做 `{{var}}` 模板插值（plan §11.8）。 */
  params: Record<string, string | number | boolean>;
  /**
   * 危险性分级，直接复用工具的 `ToolEffect`（AGENTS.md §2.1：同一能力只有一个入口）。
   * `outbound` = 有外部副作用（打招呼/投递），执行前必须先声明、失败后禁止盲重放。
   */
  effect: ToolEffect;
  /** 本节点失败后额外尝试的次数；null = 用 `workflow.runner` 的全局 `retryTimes`。 */
  retryTimes: number | null;
  /** 声明为人工接管点：跑到这里就停住等用户，不做自动重试（spec 2.4-03 的例外分支）。 */
  requiresHuman: boolean;
};

/**
 * 一次节点执行的输入（spec 2.4-01 / 2.4-07）。
 *
 * 契约放在 `core` 而不是 `workflow` 包：登记这个动作发生在**被登记的那一侧**——
 * 各能力包（L2 领域）在自己的 init 里把 `jd.capture` 这类节点交给登记处，而登记处属于 L3 流水线。
 * 让 L2 去 import L3 就是反向依赖（AGENTS.md §4.1），所以这里只放形状，实现留在
 * `packages/workflow/src/executors.ts`。这与上面 `WorkflowNodeSpec.kind` 是 `string` 同一个理由。
 */
export type WorkflowNodeInvocation = {
  /** 本次 run 的 id，用于把外部动作与库里的行对上。 */
  runId: string;
  /** 计划里的节点声明（含参数）。 */
  spec: WorkflowNodeSpec;
  /** 第几次尝试，含首次，从 1 起；上限是 `1 + retryTimes`（spec 2.4-03）。 */
  attempt: number;
  /** 协作让出信号：暂停/卸载时它是 aborted，长任务必须在中途检查它。 */
  signal: AbortSignal;
};

/** 一个节点的执行函数；失败就抛，runner 据此走退避或判失败。 */
export type WorkflowNodeExecutor = (invocation: WorkflowNodeInvocation) => Promise<void>;

/**
 * `workflow.executors` 服务对能力包露出的最小形状（同 `PlatformRegistry` 之于平台包）。
 *
 * 登记是「最后写入者说话」而不是拒绝重复：插件可以被单独重启（1.5），若第二次登记就报错，
 * 被重启的那一侧将永远拿不回自己的节点。
 */
export interface WorkflowExecutorRegistry {
  /**
   * 登记一个执行器。
   * @param kind 节点声明里的执行器名（约定 `域.能力`，如 `jd.capture`）
   * @param executor 执行函数；同名重复登记以最后一次为准
   */
  register(kind: string, executor: WorkflowNodeExecutor): void;
  /**
   * 注销某个 `kind` 的执行器（能力包被卸载时调用，避免留下指向已销毁实例的函数）。
   * @param kind 执行器名
   * @returns 是否真的删掉了一条登记
   */
  unregister(kind: string): boolean;
  /**
   * 查一个执行器。
   * @param kind 执行器名
   * @returns 已登记的执行函数；没登记过则为 null（由调用方判「这条计划现在跑不了」）
   */
  resolve(kind: string): WorkflowNodeExecutor | null;
  /**
   * 当前登记了哪些执行器（诊断面板读它，用来回答「这条计划能不能跑」）。
   * @returns 按登记顺序的执行器名列表
   */
  list(): string[];
}

/** 一份计划（spec 2.4-01）：线性节点序列 + 由内容算出的指纹。 */
export type WorkflowPlanView = {
  id: string;
  nodes: WorkflowNodeSpec[];
  /**
   * 计划内容的稳定哈希（FNV-1a 口径，见 plan §11.2「跨计划串档」一行）。
   * 续跑时指纹不符就拒绝——计划改过之后从第 i 个节点瞎续比重新跑更糟。
   */
  fingerprint: string;
};

/** 单个节点的运行态；比步骤视图多出的几项正是 2.4-03/04/06 需要的读数。 */
export type WorkflowNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export type WorkflowNodeRunView = {
  index: number;
  nodeId: string;
  kind: string;
  effect: ToolEffect;
  status: WorkflowNodeStatus;
  /** 已尝试次数（含首次）；`1 + retryTimes` 是它的上限（spec 2.4-03）。 */
  attempts: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** 耗时毫秒（最后一次尝试的）；未结束为 null。 */
  durationMs: number | null;
  error: string | null;
  /** 失败证据的**相对路径**（userData 下）；没有证据文件时为 null（spec 2.4-04）。 */
  evidenceRef: string | null;
  /**
   * 外部副作用的声明位：`null` 没开始、`started` 已开始但没观察到完成、`done` 已完成。
   * `started` 是「拒绝自动重放」的唯一依据（plan §11.3 第 5 条）——它意味着可能已经发出去了。
   */
  sideEffect: null | 'started' | 'done';
};

/**
 * 落库视图专用的一次 run 状态。
 *
 * `interrupted` **不属于** 1.10 的 `WorkflowRunStatus`（那份状态集是界面在画的，不变），
 * 它是「进程被 kill 之后库里留下的孤儿 `running` 行」被启动扫描判出来的结果（plan §11.3 第 6 条）。
 * runner 把一个 interrupted 的 run 加载回来时映射成 `paused` + 接管点，界面因此不需要新增一个态。
 */
export type WorkflowRunStateStatus = WorkflowRunStatus | 'interrupted';

/**
 * 一次 run 的**可持久化**状态（spec 2.4-01 / 2.4-05）。
 *
 * 与 1.10 的 `WorkflowRunView` 分开的理由：那份是「界面按计划节点数画槽位」的镜像，这份是「进程没了
 * 也能接着跑」的真相。字段形状可以像，但生命周期不同——前者随事件推，后者随节点状态落库。
 */
export type WorkflowRunStateView = {
  runId: string;
  planId: string;
  planFingerprint: string;
  status: WorkflowRunStateStatus;
  /** 下一个要跑的节点下标；`done` 时等于节点数（越界一位，与 1.10 的 stepIndex 同口径）。 */
  nodeIndex: number;
  totalNodes: number;
  startedAt: number;
  finishedAt: number | null;
  lastError: string | null;
  nodes: WorkflowNodeRunView[];
};

/**
 * 某个执行器的历史聚合（spec 2.4-10，供 P5 看板与「选择器腐化率」同源使用）。
 *
 * 只从 `workflow_nodes` 一张表聚合出来（plan §11.3 第 4 条：不建第三张统计表）——
 * 一张表既是断点续跑的真相又是统计的原料，就不会出现「看板说的和续跑用的不是一回事」。
 */
export type WorkflowNodeStatsView = {
  /** 执行器名（`WorkflowNodeSpec.kind`）。 */
  kind: string;
  /** 该执行器留下读数的节点行数。 */
  nodes: number;
  done: number;
  failed: number;
  skipped: number;
  /**
   * 结束节点里「成功」的占比（0..1）；一个都没结束过时为 null——
   * 用 0 冒充「还没跑过」会让看板把「冷启动」显示成「全失败」。
   */
  successRate: number | null;
  /** 已结束节点的平均耗时（毫秒）；无样本为 null。 */
  avgDurationMs: number | null;
  /** 平均尝试次数（含首次）；重试率的直接读数。 */
  avgAttempts: number;
};

/**
 * 会话自治档位（master plan §1.7 第 3 条）。
 *
 * 三态取自 Claude Code 权限模式的保守子集（plan §8.6）：`suggest` = 只给计划不执行、
 * `semi` = 逐步确认、`auto` = 仅白名单动作 + 频控。P1 **只存档位不产生行为差异**（spec 1.11-07），
 * 但界面必须读得出当前档位——档位不可见就等于隐性全自动，那正是 §1.7 第 3 条禁止的形态。
 */
export type AutonomyLevel = 'suggest' | 'semi' | 'auto';

/** 自治档位的合法值；渲染层拿不到注册表，只能靠这份常量校验。 */
export const AUTONOMY_LEVELS = ['suggest', 'semi', 'auto'] as const;

/** 消息作者。P1 没有第三方/系统消息，两态够用。 */
export type ChatRole = 'user' | 'assistant';

/**
 * 工具卡片的一次执行状态（spec 1.11-06）。
 *
 * 命名与 AI SDK 的 `ToolUIPart` 状态对齐（`input-available` ≈ `running`、`output-error` ≈ `failed`），
 * 但不照抄它的全集：P1 没有「入参正在流式生成」这件事，也不做批准态（那是 P5 的策略层）。
 */
export type ChatToolPartState = 'running' | 'done' | 'failed';

/** 一条消息里的文本片段。 */
export type ChatTextPart = { kind: 'text'; text: string };

/**
 * 一条消息里的工具调用片段（master plan §1.7 第 4 条：卡片属于那次回复的一部分）。
 *
 * `input` / `output` / `errorText` 三个字段名对齐上游（AI SDK 的 `ToolUIPart` 与 LangChain 的
 * `ToolMessage` 用的就是这三个），`state` 取它们的公共子集——见 plan §8.6。
 * 1.11-05 要求"P5 只注册工具、不改协议"，所以 `output` 现在就位：否则真工具回来时
 * 结果无处安放，协议就得加字段，"定型"那句话便不成立。
 */
export type ChatToolPart = {
  kind: 'tool';
  /** 本次调用的 id，P5 用它把结果与调用对上；P1 每次新生成。 */
  toolCallId: string;
  toolId: string;
  input: unknown;
  state: ChatToolPartState;
  /** 成功后的结果值；未结束与失败时为 null。 */
  output: unknown;
  /** 耗时毫秒；未结束为 null（不用 0 冒充「零耗时」）。 */
  durationMs: number | null;
  /** 失败原因（含 `TOOL_NOT_REGISTERED` 这类结构化 code 文案），成功时为 null。 */
  errorText: string | null;
};

/** 消息内容的一段：文本或工具卡片，顺序即渲染顺序。 */
export type ChatPart = ChatTextPart | ChatToolPart;

/** 一条已落库（或正在流式追加）的消息（spec 1.11-02 / 03 / 06 / 08）。 */
export type ChatMessageView = {
  id: string;
  sessionId: string;
  role: ChatRole;
  parts: ChatPart[];
  /** 毫秒时间戳，排序依据。 */
  createdAt: number;
  /** 助手消息是否还在吐字；1.11-02 的「运行中指示」直接读它。 */
  isStreaming: boolean;
};

/**
 * 一个会话的读数（含档位）。
 *
 * 没有 title 字段：会话标题要么来自模型总结（P1 没有模型），要么是界面文案（必须走 i18n，
 * 不能由主进程造一句中文塞进数据库）。P1 界面显示会话 id 短码与消息数就够 1.11-08 判定。
 */
export type ChatSessionView = {
  id: string;
  autonomy: AutonomyLevel;
  createdAt: number;
  messageCount: number;
};

/** 界面首屏与重读时拿到的整份快照：当前会话 + 它的消息。 */
export type ChatSnapshotView = { session: ChatSessionView; messages: ChatMessageView[] };

/**
 * 流式增量事件载荷（spec 1.11-03）。
 *
 * 只带一个片段与两个 id：整份历史由 `chat.session.current()` 一次给全，事件只负责"字数在涨"。
 * 载荷刻意不传 parts 数组——那会让每片都带上整条消息，等于把流式退化成轮询的变体。
 */
export type ChatDeltaEvent = {
  sessionId: string;
  messageId: string;
  /** 本次新增的片段文本；`done` 时为空串。 */
  text: string;
  /** 该消息是否已结束；界面见到 true 才去重读快照，把工具卡片补上。 */
  done: boolean;
};

/**
 * 工具副作用分级（master plan §1.7 第 2 条）。
 *
 * `read` = 搜索 / 读 JD / 查库；`local-write` = 建档或生成内容；`outbound` = 打招呼 / 投递 / 发消息。
 * 只有 `outbound` 必须逐级确认并经过 `entitlement.gate`（AGENTS.md §7.3）。这一位是**必填字段**而不是
 * 注释：MCP 的 annotation 规范自己写明客户端必须视其为不可信，所以它当不了闸门（plan §8.6）。
 */
export const TOOL_EFFECTS = ['read', 'local-write', 'outbound'] as const;

export type ToolEffect = (typeof TOOL_EFFECTS)[number];

/** 工具注册表对外可见的元数据（`run` 与 schema 实例过不了 IPC，也不该过）。 */
export type ToolDescriptorView = {
  id: string;
  description: string;
  effect: ToolEffect;
  requiresConfirmation: boolean;
};

/**
 * 一次工具调用的结果联合（spec 1.11-09：调不到的工具即报错，禁止用「已完成」的措辞掩盖）。
 *
 * 三类失败都**不抛异常**而走返回值：工具失败是对话流里要显示的一条内容（卡片红态 + 原因），
 * 不是要把整条消息抹掉的进程错误。
 */
export type ToolCallReply =
  | { ok: true; value: unknown }
  | { ok: false; code: 'TOOL_NOT_REGISTERED' | 'TOOL_INPUT_INVALID' | 'TOOL_FAILED'; message: string };

/**
 * 定位层「由指纹自愈重找到元素」的事件载荷（spec 2.2-05）。
 *
 * `strategy` 这里是 `string` 而不是那八个策略名的联合：联合定义在 `@auto-cc/shared`，
 * 而 `core` 在它之下（不能反向依赖），所以这条契约只承诺「一个策略名」。
 * 发送方（`browser.locate`）传的一定是联合里的成员，界面只把它当文本显示。
 */
export interface LocatorRelocatedEvent {
  /** 定位声明的描述，界面据此说明是哪个控件被重找了 */
  description: string;
  strategy: string;
  /** 自愈候选的最终得分 */
  score: number;
  /** 命中的那一帧地址；跨源帧也照原样带回 */
  frameUrl: string;
  /** 原始候选的失败原因，便于对照「改版改掉了什么」 */
  because: string;
  at: number;
}

/** `jd/progress` 事件载荷：抓取面板实时显示「第 N 轮 · 已入库 M 条」（spec 2.3-07）。 */
export interface JdProgressEvent {
  /** 当前阶段：列表抽取 / 详情读取 / 整轮结束 */
  phase: 'listing' | 'detail' | 'done';
  /** 第几轮（从 1 开始）；`done` 阶段沿用最后一轮的值 */
  round: number;
  /** 本轮在页面上看到的容器数 */
  containers: number;
  /** 到本次推送为止已入库的条数 */
  stored: number;
  /** 本次运行的目标条数 */
  target: number;
  /** 当前正在处理的岗位标题；列表阶段为空串 */
  currentTitle: string;
  /** 推送时间戳（毫秒） */
  at: number;
}

declare module 'cordis' {
  interface Events {
    /** `log` 服务每写出一条已脱敏日志时发出，IPC 网关节据此推给渲染层。 */
    'log/line'(line: LogLineView): void;
    /**
     * 某个插件进入 FAILED 状态时由 `kernel` 发出，`plugins` 服务据此累积错误历史。
     * 这里声明的是**进程内**事件：它没进 `RENDERER_EVENTS`，因此不会出进程。
     */
    'plugin/error'(error: PluginErrorView): void;
    /**
     * 某平台的登录态被探测为失效时由 `sessions` 发出（spec 1.8-06）。
     * 载荷刻意只有平台名与原因，没有任何 cookie 值（AGENTS.md §8.5）。
     */
    'session/expired'(event: SessionExpiredEvent): void;
    /**
     * 内嵌内核视图的主文档加载失败时由 `shell` 发出（spec 1.8-09）。
     * 界面不能靠轮询 `shell.getStatus` 看到它：`sessions.open` 先返回、失败事件后到，
     * 那次读数里错误位还是空的，所以错误态必须由事件推进来。
     */
    'shell/view-error'(error: KernelViewLoadError): void;
    /**
     * 工作流每推进一次（起步 / 步骤开始 / 步骤结束 / 暂停 / 续跑）由 `workflow.runner` 发出
     * （spec 1.10-04）。载荷是整份 run 状态，界面不自己推导。
     */
    'workflow/progress'(event: WorkflowProgressEvent): void;
    /**
     * 助手回复每吐出一片由 `chat.session` 发出（spec 1.11-03）。
     * 载荷只有增量片段与两个 id，界面不靠它重建整份历史。
     */
    'chat/delta'(event: ChatDeltaEvent): void;
    /**
     * 一次定位由「上一次成功留下的指纹」自愈重找到元素时由 `browser.locate` 发出（spec 2.2-05）。
     * 2.7 的选择器腐化率只统计这一条来源，漏发就等于宣称站点没有改版。
     */
    'locator/relocated'(event: LocatorRelocatedEvent): void;
    /**
     * JD 抓取每推进一次（一轮列表抽取结束 / 一条详情读完 / 整次运行收尾）由 `jd.capture` 发出
     * （spec 2.3-07）。面板不轮询 `jd.capture.status` 来「感觉进度」，进度只由事件推进来。
     */
    'jd/progress'(event: JdProgressEvent): void;
  }
}
