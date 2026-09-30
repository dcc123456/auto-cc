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
 * 六个主线步骤的 id 与顺序（`docs/00-master-plan.md` §31 的概念表：搜索 / 建档 / 话术 /
 * 打招呼 / 按 JD 优化简历 / 择机投递）。
 *
 * 全仓库只在这里定义一次：runner 按它执行、界面按返回的 `steps` 渲染槽位。
 * 渲染层拿不到这个常量（也不该拿，见 `shared/bridge.ts` 的转出注释），所以它没有第二份步骤清单。
 */
export const WORKFLOW_STEP_IDS = ['search', 'profile', 'pitch', 'greet', 'tune', 'deliver'] as const;

export type WorkflowStepId = (typeof WORKFLOW_STEP_IDS)[number];

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
 * 人工接管点（spec 2.1-08）。
 *
 * 刻意是**结构化数据而不是一句话**：主进程拼好的中文文案进不了 i18n（AGENTS.md §5.5 要求
 * 页面每条文案都走语言包），而「哪个平台、因为什么、停在第几步」这三项才是界面组织句子需要的。
 */
export type WorkflowTakeoverView = {
  /** 需要接管的平台标识。 */
  platform: string;
  /** 判定依据，与 `SessionExpiredEvent.reason` 同集合。 */
  reason: 'missing' | 'expired';
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
 * 一次进度推进的事件载荷（spec 1.10-04：界面进度是流式推送，不是轮询出来的）。
 *
 * 带整份 `run` 而不是增量：渲染层因此不自己推导状态，
 * 「面板与对话镜像同一个 runner」（1.10-08）就退化成同一段 JSON 渲染两次。
 */
export type WorkflowProgressEvent = {
  run: WorkflowRunView;
  /** 触发本次推送的步骤；run 级迁移（start / pause / resume）时为 null。 */
  stepId: WorkflowStepId | null;
  /** 面向用户的一句话说明，P2 换成真实进度文案；纯状态迁移时为 null。 */
  message: string | null;
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
  }
}
