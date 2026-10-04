/**
 * 跨进程的 cordis 事件契约（spec 1.4-03）。
 *
 * `Events` 的字符串键必须由模块增补声明，而全应用只有 `core` 允许接触 cordis
 * （见 eslint 的 CORDIS 限制），所以「哪些事件可以出进程」的声明集中在这里；
 * 网关侧另有 `RENDERER_EVENTS` 白名单，两者一起构成事件出口的双层收口。
 */

import type { ZodType } from 'zod';

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

/** 风控信号的来源类别（spec 2.7-01）：两条独立取路，一个出口。 */
export type RiskSignalKind = 'http-status' | 'page-text';

/**
 * 一次风控信号（spec 2.7-01，由 `browser.risk` 发出）。
 *
 * 与 `SessionExpiredEvent` 同一条纪律：**只带判定数据，不带正文与 cookie**。
 * `detail` 是命中的那一条依据（状态码或知识包登记的风控字样本身），
 * 不是从页面上摘下来的一整句——页面正文里可能带着用户的手机号（AGENTS.md §8.5）。
 */
export interface RiskSignalEvent {
  platform: string;
  /** `http-status` = 主框架响应状态码命中；`page-text` = 状态行/标题/正文命中知识包 `risk.riskPattern`。 */
  kind: RiskSignalKind;
  /** 判定依据原文（如 `HTTP 403` 或命中的字样），界面把它当参数插进文案，不当句子拼。 */
  detail: string;
  /** 触发信号的那个地址。 */
  url: string;
  /** 判定时刻（毫秒）。 */
  at: number;
}

/**
 * 接管态的类型（spec 5.5-01 / 02 / 09）住在下面 `TakeoverReason` 那一节，
 * 与 `WorkflowTakeoverView` 相邻——那里是唯一的一份，这里不再另起一张。
 */

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

/**
 * 单个步骤的状态；`pending` 也要出现在视图里，因为界面得显示"还没轮到"的槽位。
 *
 * `skipped` 是 5.10-08 加的第二种「没执行却已结算」：分支图里没被取走的那一支既不是失败、
 * 也不许冒充已完成——它和「库里已有结局、这次不重放」在界面上必须是两个颜色，
 * 否则用户看不出这条 run 是走了一半还是走完了全部。
 */
export type WorkflowStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

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
 * 声明的接管点（验证码/风控一类，plan §11.8 的「不做识别与规避」）；`risk-control` 是**页面自己**
 * 露出风控迹象（HTTP 403/429 或知识包登记的风控字样）时被 `browser.risk` 打掉的那一次（spec 2.7-01）
 * ——与 `manual-takeover` 的区别是后者来自节点声明，前者来自现场观测，界面上要说的是不同的话。
 */
export type WorkflowTakeoverReason =
  'missing' | 'expired' | 'unobserved-side-effect' | 'manual-takeover' | 'risk-control';

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
 * 接管态的原因（spec 5.5-07）：哪一件事把页面交回给人手的。
 *
 * 三个值各有主人：`manual` 是人在界面上按「我来接手」（`actor` 为 `user`，5.5-01）；
 * `risk` 与 `session-expired` 由 `browser.takeover` 自己订阅那两条既有信号写下（`actor` 为 `system`，
 * 5.5-07）——**验证码也在 `risk` 里**，因为本项目的验证码判据就是风控文案那一条（2.7-c 的 `riskPattern`），
 * 不需要第二条通道。
 * 与 `WorkflowTakeoverReason` 是两份枚举而不是同一份：那一份描述的是工作流某一格的接管点
 * （含 `unobserved-side-effect`、`manual-takeover` 这种只有节点执行器才有的判据），这一份描述的是
 * **整块页面当前在谁手里**，两者共用会让「agent 这一路根本没有节点」这件事在类型上被抹平
 * （plan §7.3 决策 1），也会让这一份里出现没有写点的死值（AGENTS.md §2.4）。
 */
export type TakeoverReason = 'manual' | 'risk' | 'session-expired';

/** 这次接管由谁写下（5.5-09 的「谁在何时动了页面」里的「谁」）。 */
export type TakeoverActor = 'user' | 'system';

/** 接管事件表里的行类型：只有 `begin` / `end` 两种，一次接管一对。 */
export type TakeoverEventKind = 'begin' | 'end';

/**
 * 接管态的当前读数（spec 5.5-01 / 02 的唯一状态源对外形状）。
 *
 * 为什么在 core：它是 `browser/takeover-changed` 的载荷，而事件声明与跨进程视图只住在 L0
 * （`WorkflowTakeoverView`、`AgentRunView` 同处——渲染层不许 import 领域包，AGENTS.md §4.1）。
 * `beginCount` / `endCount` 是**这轮进程内**的次数，跨重启的账在 `takeover_events` 表里（号段 21）：
 * 视图要的是「现在屏上该写什么」，表要的是「谁在何时动过」，把两者拧成一份就会既读不清也审不明。
 */
export type TakeoverStateView = {
  /** 页面当前是否在人手里。 */
  isHeld: boolean;
  /** 因何接管；未接管时为 null。 */
  reason: TakeoverReason | null;
  /** 这轮接管开始的毫秒时刻；未接管时为 null（界面按它算「已经接管多久」）。 */
  startedAt: number | null;
  /** 本进程内成功进入接管的次数（幂等的连发不计数，见 `begin` 的注释）。 */
  beginCount: number;
  /** 本进程内成功解除接管的次数；与 `beginCount` 相等就是「此刻没有在途接管」。 */
  endCount: number;
};

/**
 * 发起一次接管的入参（spec 5.5-01）。
 *
 * 形状住在 L0 而不是浏览器包里：它是 `browser.takeover.begin` 的**跨进程入参**，而桥接契约只许
 * import core 的类型（`@auto-cc/shared` 与渲染层都不该认识领域包，AGENTS.md §4.1）。
 * `actor` 必填而不是缺省：谁写下这次接管是审计里那个「谁」（5.5-09），让调用点漏一个字段就变成猜测。
 */
export type TakeoverBeginInput = {
  /** 接管原因（形状见 `TakeoverReason`）。 */
  reason: TakeoverReason;
  /** 触发它的 run；不属于任何 run（人在页面上直接动手）时为 null 或省略。 */
  runId?: string | null;
  /** 停在哪个节点上；没有节点归属时省略。 */
  nodeId?: string | null;
  /** 这次表态来自人的手还是系统的观测。 */
  actor: TakeoverActor;
};

/**
 * 解除一次接管的入参（spec 5.5-01 / 09）：只用来把 `end` 行对上它结束的那一轮 `begin`。
 *
 * `actor` **省略按 `user` 记**——缺省是 user 不是猜测，而是 5.5 的口径本身：解除接管在 spec 里只有
 * 人的手（plan §7.3 决策 3「恢复是人的手」，系统自动解除就是把接管态变成建议态）。所以要走系统那一条
 * 必须显式写 `system`，于是审计里出现 `system` 的 end 行时，它指的一定是真有一条自动通道解除了接管。
 */
export type TakeoverEndInput = {
  /** 被解除的那轮接管所属的 run。 */
  runId?: string | null;
  /** 被解除的那轮接管停在的节点。 */
  nodeId?: string | null;
  /** 谁解除的；省略按 `user` 记，理由见类型头的注释。 */
  actor?: TakeoverActor;
};

/**
 * 一条接管审计行（spec 5.5-09）。
 *
 * `runId` / `nodeId` 可空：手动接管与循环停住都不隶属某一格，硬塞一个占位值会让审计把
 * 「不知道是谁的」读成「是那条 run 的」。
 */
export type TakeoverAuditRow = {
  id: number;
  kind: TakeoverEventKind;
  reason: TakeoverReason | null;
  actor: TakeoverActor | null;
  runId: string | null;
  nodeId: string | null;
  /** 这条事件写下的毫秒时刻。 */
  createdAt: number;
};

/**
 * 接管态的询问面（spec 5.5-02 的读路），实现方是 `browser.takeover`。
 *
 * 为什么形状声明在 L0：要用它的是判定口与循环（L3 对话层），而接管的事实归属是浏览器层（L2）。
 * agent 层 import 浏览器包会被 eslint 的 `AGENT_CAPABILITY` 直接拦掉（spec 5.1-08：那等于给 agent
 * 一条绕过注册表的路），所以 core 只声明「现问一次接管态」这一口，由实现方结构上满足——
 * 与 `PagePacer` / `ConsentGate` 同一套路。**只有读、没有 `begin` / `end`**：解除接管是人的手
 * （plan §7.3 决策 3），判定口与循环都不许自己把接管摘掉。
 */
export interface TakeoverStateSource {
  /**
   * 现读接管态。
   * @returns 当前读数；不抛异常，也不返回「上一次问的时候是什么」——接管态只能现问（AGENTS.md §9 的 2.5 实测条）
   */
  held(): TakeoverStateView;
}

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
  /**
   * 刚刚被人工处理掉的那次接管（spec 2.8-11）：`resume` 时从 `requiresHuman` 归档过来，
   * 界面据此在对应格子上挂「已人工接管」——只有「正在等」的横幅的话，接管完就查不到痕迹了。
   * **只活在内存里**：接管点从来不入 `workflow_nodes`（plan §15.9 事实 7），
   * 所以跨进程重启续跑后它是 null，那是如实（重启后没人知道上一次谁接管过），不是漏写。
   */
  takeoverHandled: WorkflowTakeoverView | null;
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
  /**
   * 这个节点**声明**的出口名（spec 5.10-02/08，5.10-b 起）。省略 = 只有 `default` 一个出口，
   * 也就是 2.4 那三条线性计划原来的样子——不逐个补写、也不改指纹（见 `graphFingerprint` 的口径）。
   *
   * 刻意留在 `core` 且是**可选**字段：出口只有在真的连出边时才改变"哪一步会跑"，
   * 所以它是声明面而不是执行身份的一部分；执行语义由 `nodes + edges` 一起定（5.10-06）。
   */
  outputs?: readonly string[];
};

/** 线性节点序列里那条唯一的出口名（`default`），也是边的默认出口。 */
export const WORKFLOW_DEFAULT_OUTPUT = 'default';

/**
 * 一条执行边（spec 5.10-02）：从 `source` 节点的第 `sourceHandle` 个出口连到 `target` 节点。
 *
 * `id` 由投影方生成并保证图内唯一——画布要拿它做 React Flow 的 key，重排边时不能靠下标。
 */
export type WorkflowEdgeView = {
  id: string;
  /** 起点节点 id。 */
  source: string;
  /** 起点出口的 name；线性节点是 `default`，分支节点是它 `outputs` 里的一项。 */
  sourceHandle: string;
  /** 终点节点 id。 */
  target: string;
};

/**
 * 一份计划的**图**读数（spec 5.10-02）：节点 + 边 + 指纹。
 *
 * 与 `WorkflowPlanView` 的关系是"同一份语义的两种读法"，不是第二份真相：
 * 线性计划经 `projectPlanToGraph` 原样投影成一条链（b 片不动那三条计划声明），
 * 自定义图（5.10-e 落库）才是这张形状的第一个新来源。视图层位置走 `views` 通道，
 * 既不在这里、也不进指纹（5.10-06）。
 */
export type WorkflowGraphView = {
  id: string;
  nodes: WorkflowNodeSpec[];
  edges: WorkflowEdgeView[];
  /** 与 `WorkflowPlanView.fingerprint` 同一口径：线性投影与源计划必须算出同一个值。 */
  fingerprint: string;
};

/**
 * 画布上一个节点的落点（逻辑像素，可为负）——**视图层**通道，spec 5.10-06。
 *
 * 它单独一条通道、单独一列（`views_json`），且没有任何路径能把它喂进指纹：
 * 拖一下格子不许改变这条计划的执行身份。
 */
export type WorkflowNodePlacement = { nodeId: string; x: number; y: number };

/**
 * `workflow.graph.load` 的读数（spec 5.10-10）：画布重开时看到的那一张图。
 *
 * 两条来源合成一个读数是有意的：**能画的就是能存的**。内置计划与 5.4 沉淀行没有 `graph_json`，
 * 由 `plan_json` 线性投影现算（`isCustom: false`），于是 5.10-02 的"不重写即可作为图加载"
 * 在 IPC 这一侧同样成立，而不是只有单测里成立。
 */
export type WorkflowGraphLoadView = {
  planId: string;
  graph: WorkflowGraphView;
  placements: WorkflowNodePlacement[];
  /**
   * 覆盖保存的乐观并发凭据（5.10-e）：库里每成功保存一次就 +1。
   *
   * 它存在的意义是"同一张图被两个窗口各改一版"时后写的那一次要**看见**冲突，
   * 而不是静默把前一版的节点抹掉——画布的命令栈是进程内的，跨窗口它管不着。
   */
  revision: number;
  /** true = `graph_json` 是人在画布上存下来的真相；false = 由 `plan_json` 线性投影现算。 */
  isCustom: boolean;
};

/** `workflow.graph.save` 成功后的读数（界面用它把 revision 跟上，避免下一次保存被自己判成冲突）。 */
export type WorkflowGraphSaveView = { planId: string; revision: number; fingerprint: string; updatedAt: number };

/**
 * `workflow.graph.save` 的入参形状（spec 5.10-10）：人在画布上改完的那一版。
 *
 * 契约放这里而不是 `workflow` 包：`packages/shared` 的跨进程签名表要引用它，而渲染层只认
 * `@auto-cc/shared` 一个入口——签名与读数同侧，才不会出现「界面以为能传、服务不认」的两种形状。
 * 形状校验（含图本体）在服务侧一次做完，见 `workflow.graph` 的 `saveGraphInputSchema`。
 */
export type WorkflowGraphSaveInput = {
  planId: string;
  graph: WorkflowGraphView;
  placements: WorkflowNodePlacement[];
  expectedRevision: number;
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

/**
 * 一次打招呼落到页面上的结局（由平台侧的渠道实现给出）。
 *
 * 只有两个字段是有意为之：编排层需要的全部信息就是「页面认不认这次发送」和「一句话说明卡在哪」，
 * 平台侧的其余细节（哪一步回读、状态行原文）都收在 `reason` 里，不许长进 core 的形状。
 */
export type GreetOutcome = {
  /** 页面是否真的把这条发出去了（适配器按回读判定，不是「点过了就算」） */
  sent: boolean;
  /** 结局说明：成功时说清是哪一段回读确认的，失败时说清卡在哪一段 */
  reason: string;
};

/**
 * 平台侧的打招呼渠道：编排层只需要「把这个目标发这段文字」。
 *
 * 它是 `PlatformAdapter.chat` 的**窄化投影**，不是第二套外发接口 —— core 是 L0，
 * 不该认识「岗位」「会话页」这些领域概念，所以只搬打招呼需要的这一个方法（plan §12.12 第 1 条）。
 */
export type GreetChannel = {
  /**
   * 往指定目标的会话里发一条文本。
   * @param targetId 会话对象标识（P2 是平台侧 jobid）
   * @param text 将要离开 app 的文本（编排层已在外面过过黑名单）
   * @returns 页面回读出的结局；传输层异常由实现方抛结构化错误，不用 `sent:false` 表达
   */
  send(targetId: string, text: string): Promise<GreetOutcome>;
};

/**
 * 「哪个平台现在能打招呼」的询问面，由 `platform.registry` 实现。
 *
 * 为什么是**问**而不是**登记**：渠道的真相就是适配器，另开一张渠道表等于把同一份事实存两处，
 * 而且新实例读不到旧实例的登记（实测：改一次上游插件配置会连带重建 `outbound.greet`，
 * 那张表当场清空，打招呼从此静默失败到重启为止）。每次外发现问一次，就没有这份状态要养。
 * 名字用 `platform.registry` 这个服务名索引，形状由 core 声明——outbound 与 browser 同级，
 * 让它们互相 import 会新开一条横向依赖（AGENTS.md §4.1）。
 */
export interface GreetChannelSource {
  /**
   * 按平台名要一个打招呼渠道。
   * @param platform 平台标识（与适配器 `meta.id` 同源）
   * @returns 渠道的窄投影；未登记该平台、或它没声明 `chat` 能力时为 null（不抛，由外发侧决定报什么码）
   */
  greetChannel(platform: string): GreetChannel | null;
  /**
   * 当前能打招呼的平台清单，用来回答「发不出去是因为没装平台包，还是因为适配器不支持」。
   * @returns 登记了适配器且声明 `chat` 能力的平台标识，按登记顺序
   */
  greetablePlatforms(): string[];
}

/**
 * 一份将要递出去的简历文件（spec 2.6-05）。
 *
 * 形状声明在 `core` 而不是 `shared`：适配器契约（`browser`）、投递编排（`outbound`）、
 * 界面视图（`shared`）三方都要用它，而 `core` 是这三者唯一的公共下层——放 `shared` 会让 L0 反向依赖，
 * 放 `browser` 会让 `outbound` 与 `browser` 横向 import（AGENTS.md §4.1）。
 * 四个字段全是原语，core 因此仍然不认识「岗位」「会话页」这些领域概念。
 */
export type ResumeAttachment = {
  /** 本机绝对路径：动作层按它把文件交给 CDP，编排层按它算 hash */
  path: string;
  /** 文件名（页面回读的要跟它比对，账本 `source` 也要带它） */
  fileName: string;
  /** 字节数：配置上限的判据，也是「塞进去的就是这几个字节」的读数 */
  sizeBytes: number;
  /** 整份文件的 sha256 十六进制小写；`source` 取前 12 位，将来 3.7 的简历 diff 按它对齐 */
  sha256: string;
};

/**
 * 投递的页面结局与打招呼的结局同形（页面认不认 + 一句说明），按 §2.2 复用而不是复制第二份。
 *
 * 独立命名是为了读得通：`sendResume` 返回一个 `GreetOutcome` 会让人以为发的是文字。
 */
export type DeliverOutcome = GreetOutcome;

/**
 * 平台侧的简历投递渠道：编排层只需要「把这个目标递这份文件」。
 *
 * 同 `GreetChannel`，是 `PlatformAdapter.sendResume` 的**窄化投影**而不是第二套外发接口
 * （plan §12.12 第 1 条的同一条理由：core 是 L0，不让它认识领域概念）。
 */
export type ResumeDeliveryChannel = {
  /**
   * 往指定目标递一份简历文件。
   * @param targetId 会话对象标识（P2 是平台侧 jobid）
   * @param attachment 编排层已经校验过（存在、是 pdf、在大小上限内）并算好 hash 的文件
   * @returns 页面回读出的结局；「目标已下架」这类结构性失败由实现方抛 `DELIVER_TARGET_OFFLINE`，不用 `sent:false` 表达
   */
  send(targetId: string, attachment: ResumeAttachment): Promise<DeliverOutcome>;
};

/**
 * 「哪个平台现在能递简历」的询问面，由 `platform.registry` 实现。
 *
 * 与 `GreetChannelSource` 同一条理由：渠道的真相就是适配器，另存一张表就会在适配器被重建时
 * 留下过期读数（plan §12.13），所以每次外发现问一次。
 */
export interface ResumeChannelSource {
  /**
   * 按平台名要一个投递渠道。
   * @param platform 平台标识（与适配器 `meta.id` 同源）
   * @returns 渠道的窄投影；未登记该平台、或它没声明 `sendResume` 能力时为 null（不抛，由外发侧决定报什么码）
   */
  deliverChannel(platform: string): ResumeDeliveryChannel | null;
  /**
   * 当前能递简历的平台清单，用来把「递不出去」说成是装配缺包还是适配器不支持。
   * @returns 登记了适配器且声明 `sendResume` 能力的平台标识，按登记顺序
   */
  deliverablePlatforms(): string[];
}

/**
 * 向量网关的可用性读数（spec 4.3-08）。
 *
 * 只露 `available` / `missing` / `model` 三项：`missing` 让界面能说清「是没配端点还是没配 key」，
 * 而 `model` 是知识库向量表的**失效判据**（换模型即整表重算，见 plan §4.3-d 实现形状 3），
 * 所以取向量的一方必须拿得到它，不能只问「能不能用」。
 */
export type EmbedStatusView = {
  available: boolean;
  /** 不可用的原因项，与 `llm.chat` 的 `LlmStatus.missing` 同一组词。 */
  missing: Array<'baseUrl' | 'model' | 'apiKey'>;
  model: string | null;
};

/**
 * 把一段文本变成向量的询问面（spec 4.3-07 / 08），实现方是 `llm.embed`。
 *
 * 为什么形状声明在 L0 而不是让 `resume-kb` 直接 import `@auto-cc/plugin-llm`：
 * 知识库（L2 领域）与模型出口（L2 领域）同级，互相 import 会新开一条横向依赖（AGENTS.md §4.1），
 * 而 `static inject = ['llm.embed']` 会把「向量增强」变成硬依赖——4.3-04 要的正是
 * 「没有 key、没有这个插件时检索照常」，所以这里与 `GreetChannelSource` / `PagePacer` 同套路：
 * core 声明最小形状，实现方结构上满足，调用方**用的时候按名字现问**（AGENTS.md §9 的 2.5 实测条）。
 */
export interface EmbedGateway {
  /**
   * 当前是否可用。**纯本地判定，一次网络都不发**（同 `llm.chat.status()`）。
   * @returns 可用性读数
   */
  status(): EmbedStatusView;
  /**
   * 把若干段文本编成向量。
   * @param texts 待编码文本（顺序即返回向量的顺序）；空数组时实现方**不发请求**
   * @returns 实际模型名、统一维度（无向量时为 null）与逐条向量
   * @throws 未配置时 `LLM_UNAVAILABLE`；网络 / 超时 / 非 2xx / 响应形态不合约定时 `LLM_REQUEST_FAILED`
   */
  embed(texts: readonly string[]): Promise<{ model: string; dim: number | null; vectors: number[][] }>;
}

/**
 * 对话网关的可用性读数（spec 4.4-02）。
 *
 * 与 `EmbedStatusView` 同三项，只去掉了 `llm.chat` 自己才有的 `endpoint`：
 * 取模型的一方要判的是「能不能用、缺哪样、用的哪个模型」，端点地址属于 `packages/llm` 的内部事实
 * （AGENTS.md §2.7：模型端点只出现在那一个包，零上行机检按这条扫）。
 */
export type ChatStatusView = {
  available: boolean;
  /** 不可用的原因项，与 `llm.chat` 的 `LlmStatus.missing` 同一组词。 */
  missing: Array<'baseUrl' | 'model' | 'apiKey'>;
  model: string | null;
};

/** 一次对话补全的入参（字段与 `llm.chat` 的 `chatRequestSchema` 逐字对齐，故调用点不用换名）。 */
export type ChatRequestView = {
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  maxTokens?: number | null;
  temperature?: number | null;
};

/** 一次对话补全的结果；token 用量只有模型侧才说得清，属 `llm.chat` 内部，不进本询问面。 */
export type ChatCompletionView = { text: string; model: string };

/**
 * 要一次对话补全的询问面（spec 4.4-02），实现方是 `llm.chat`。
 *
 * 为什么与 `EmbedGateway` 同套路而不是像 `outbound.script` 那样 `static inject`：
 * 话术生成没有"不装模型也能用"的形态（那里注释写明"装上半个不如不装"），而 JD 拆解**有**——
 * 词面腿（4.4-a）就是它的离线基线。硬注入会让摘掉 `llm` 包连带把 `kb.gap` 降成 PENDING，
 * 等于把"增强"做成"必需"（plan §4.4-b 证据 [2]）。
 */
export interface ChatGateway {
  /**
   * 当前是否可用，以及不可用时缺了哪几样。**纯本地判定，一次网络都不发**（同 `EmbedGateway.status`）。
   * @returns 可用性读数
   */
  status(): ChatStatusView;
  /**
   * 发一次对话补全。
   * @param request 消息序列（至少一条）与可选的单次覆盖
   * @returns 回复正文与实际用的模型名
   * @throws 未配置时 `LLM_UNAVAILABLE`（不发请求）；网络 / 超时 / 非 2xx / 空回复时 `LLM_REQUEST_FAILED`
   */
  complete(request: ChatRequestView): Promise<ChatCompletionView>;
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
 * 页面动作节奏的询问面（spec 2.7-04），实现方是 `outbound.throttle`。
 *
 * 为什么形状声明在 L0：`jd.capture`（L2 领域）要在两轮滚动之间停一停，而节奏的**唯一归属**
 * 是外发节流服务（L3）。让下层 import 上层会打破 AGENTS.md §4.1 的依赖方向，所以 core 只声明
 * 「取一次间隔」这一个方法，由 `outbound.throttle` 结构上满足——与 `GreetChannelSource` 同一套路。
 * 只露滚动这一格：把 `nextGapMs`（外发间隔）也露出来，L2 就能拿外发节奏去排页面动作，
 * 而滚动不是外发，不该占用外发的节流区间。
 */
export interface PagePacer {
  /**
   * 取下一次页面动作（滚动 / 换页）之前的停顿时长。
   * @returns 区间随机的整数毫秒；抽不到定值，所以界面不显示「固定间隔」（同条理由见 spec 2.7-04）
   */
  nextScrollGapMs(): number;
}

/**
 * 「这条岗位等到回复没有」的询问面（spec 5.7-03 的第一项输入），实现方是 `jd.store`。
 *
 * 为什么形状声明在 L0：要问这句话的是投递编排（L3 `outbound.deliver` 的择机规则），而回复事实的
 * 归属在会话消息表那一侧（L2 `jd.store` 从 `conversation_messages` 现算，2.5-14 的单一来源不动）。
 * 让 L3 横向 import `plugin-platform-boss` 会新开一条 AGENTS.md §4.1 禁止的依赖边，
 * 所以照 `GreetChannelSource` / `ConsentGate` 的套路：core 只声明这一个方法，实现方结构上满足即可。
 *
 * 只露「读」不露写：回复状态永远由消息流入决定，任何写入口都会变成第二套事实。
 */
export interface JdReplyStatusSource {
  /**
   * 某条岗位到现在为止有没有等到对方回复。
   * @param platform 平台标识（与 `jobs.platform` 同源）
   * @param jobId 平台侧岗位 id（与 `jobs.job_id` 同源，不是库内自增 id）
   * @returns true 至少回过一条；false 一条没回；**null 表示库里没有这条**——
   *          它不等于「没回复」，把不知道翻译成假会让择机规则静默挡掉本该递出去的简历
   */
  replyStatus(platform: string, jobId: string): boolean | null;
}

/**
 * 「这个岗位键在库里有没有一条记录」的询问面（spec 5.7-f），实现方是 `jd.store`。
 *
 * 为什么形状声明在 L0：要问这句话的是话术生成（L3 `outbound.script`），而岗位记录的归属在
 * L2 的 `jobs` 表那一侧。与 `JdReplyStatusSource` 同一个套路，但**不并入那一只**：
 * 那一只按 (平台, 岗位 id) 问回复，话术入参里只有 `jdId`、没有平台，
 * 借它返回值判「库里没有」等于替调用方决定"平台未知时算不算存在"。
 *
 * 同样只露读：存在性由 `jobs` 表决定，任何写入口都会变成第二套事实。
 */
export interface JdKeySource {
  /**
   * 一个平台侧岗位 id 在库里有没有对应记录（不区分平台，跨平台同名 id 取最近一条，与 `jd:` 引用同判据）。
   * @param jobId 平台侧岗位 id（与 `jobs.job_id` 同源，不是库内自增 id）
   * @returns true 库里至少有这条岗位；false 库里没有——话术不能凭空指向一个没抓到的岗位
   */
  hasJob(jobId: string): boolean;
}

/**
 * 首次启用自动化的风险签字（spec 2.7-06）的询问面，实现方是 `sessions`。
 *
 * 为什么形状声明在 L0：要问「这个平台签过字没有」的三方分别在外发编排（L3 `outbound.greet` /
 * `outbound.deliver`）与抓取编排（L2 `jd.capture`），而签字记录的归属是「平台级、跨重启的状态」
 * 那一层（L2 `sessions`，与分区、登录态同源）。让 L3 直接 import L2 的包、或让 `platform-boss`
 * 横向 import `sessions`，都会新开一条 AGENTS.md §4.1 禁止的依赖边——与 `GreetChannelSource`、
 * `PagePacer` 完全同一套路：core 只声明两个方法，实现方结构上满足即可。
 *
 * 只有两个方法也是有意为之：**不给写入口**。渲染层要签字只能调 `sessions.grantConsent`
 * （只接受平台名），这里露的是「读」和「不接受就抛」，于是释放路径的判据只有一条事实源。
 */
export interface ConsentGate {
  /**
   * 查一个平台是否已有签字记录。
   * @param platform 平台标识（与 `sessions.platforms` 同源）
   * @returns 已签为 true；没签、或该平台未登记时为 false（不抛，界面据此决定弹不弹确认）
   */
  hasConsent(platform: string): boolean;
  /**
   * 释放路径上的硬拦：没签过字就抛。
   * @param platform 平台标识
   * @throws 平台未登记时 `PLATFORM_NOT_CONFIGURED`（对一个不存在的平台谈「承担风险」没有意义）、
   *         该平台未签字时 `CONSENT_REQUIRED`（带平台名，界面按名字插进文案）；已签时静默返回
   */
  ensureConsent(platform: string): void;
}

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
 * 节点参数的取值域（与 `workflow.plan` 的 `nodeParamSchema` 同一口径：计划要能整体 JSON 落库，
 * 所以不接受嵌套对象）。放在 L0 是因为沉淀侧（agent）与存储侧（workflow）都要写它，
 * 而它两边都不该各自再声明一遍（AGENTS.md §2.2）。
 */
export type WorkflowParamValue = string | number | boolean;

/**
 * 「这个参数键算不算变量」的白名单（spec 5.4-04 的判据落点）。
 *
 * 放在 L0 一处、沉淀侧与界面侧都读它，是为了让"哪些值被换过、哪些还是上次的具体值"这件事
 * 只有一个答案；写成第二份列表就等于允许两边不一致。
 * **判定按键名，不按值长得像不像**（值形如"上海"也可能是岗位名的一部分），也不交给模型判断。
 *
 * 如实一条：spec 原文点名的"日期区间"在**当前 14 只工具的入参与 5 个节点 kind 的参数里都没有
 * 对应字段**（plan §5.4-b 已 grep 两侧），所以那一项在本片是空项——等真出现带日期入参的能力，
 * 往这张表加一个键名即可，不造一个假字段凑判据。
 */
export const WORKFLOW_VARIABLE_PARAM_KEYS = ['query', 'keyword', 'city', 'limit', 'target'] as const;

/**
 * 一条**已保存的自定义计划**的列表读数（spec 5.4-01 / 08）。
 *
 * 只有这一张表里的计划可以被重命名 / 复制 / 删除；内置那几条来自代码常量目录，
 * 它们的"读数"在 `WorkflowPlanOptionView` 里并排给出，不写进表（写了就得回答"改了重启算谁"）。
 *
 * 这里**没有** revision / version 一列：5.4 的写入口只有「新增、改名、复制、删除」，
 * 没有任何一处会改节点内容（那是 5.10 的编辑器），一个永远等于 1 的版本号是 §2.6 禁止的
 * 「为假想的未来做的抽象」——等真出现覆盖保存时再加，那时它才有消费者。
 */
export type SavedWorkflowPlanView = {
  id: string;
  name: string;
  fingerprint: string;
  nodeCount: number;
  /** 从哪条 agent run 沉淀来的；手工建的为 null。 */
  sourceRunId: string | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * 「这条计划现在能不能被跑」的并排读数（界面计划下拉的唯一素材，spec 5.4-03 的运行半边）。
 *
 * 内置与自定义合成一张是给界面的一个事实：**能选的就是能跑的**，
 * 分成两份清单就会长出"下拉里看得见、点下去说没有"的第二状态源（§2.5）。
 */
export type WorkflowPlanOptionView = {
  id: string;
  name: string;
  source: 'builtin' | 'custom';
  fingerprint: string;
  nodeCount: number;
};

/**
 * 一个节点参数的"变量 / 残留"读数（spec 5.4-04）。
 *
 * `isVariable` 由**键名白名单**判定（plan §5.4-b：`query`/`keyword`/`city`/`limit`/`target`），
 * 不是模型觉得像变量；剩下的都是"这次跑通用的那一个具体值"，界面按它标红，
 * 于是"沉淀下来的工作流只能复现上一次那一条"这件事是看得见的，而不是靠事后手工改。
 */
export type PlanParamReadoutView = {
  nodeId: string;
  paramKey: string;
  value: WorkflowParamValue;
  isVariable: boolean;
};

/**
 * 一次失败节点的证据读数（spec 2.8-04）。
 *
 * 它是 `writeEvidence` 落盘那份 JSON 的**读侧投影**，不是第二份事实：字段只从文件里取，
 * 主进程不在这里补任何判断。正文的脱敏发生在**写盘那一次**（唯一权威 `redactValue`），
 * 所以读侧不再掩第二遍——再掩一次会让人以为写侧没掩。
 * 截图走 data URL 而不是文件 URL：打包版 CSP 放行的是 `img-src 'self' data:`，`file:` 一律挡掉。
 */
export type WorkflowEvidenceView = {
  runId: string;
  nodeId: string;
  /** 判失败那一次是第几回尝试（与库里的 `attempts` 同源）。 */
  attempt: number;
  /** 判定时间戳（毫秒）。 */
  at: number;
  /** 错误码与截断过的一句话（`details` 不进这条：它是执行器原样塞的对象，形状不可信）。 */
  error: { code: string; message: string };
  /** 失败当时的页面读数；抓取时没有内核会话则为 null。 */
  page: { url: string; title: string; bodyText: string } | null;
  /**
   * 现场截图：取到了就是 data URL（打包版的 CSP 已放开 `img-src 'self' data:`，
   * 因此不需要为看一张图去开 `file:` 或自定义协议），取不到就只说原因。
   * 两个分支互斥写在类型里，界面不需要为「既没图也没原因」编一句话。
   */
  screenshot:
    | { dataUrl: string; width: number; height: number; bytes: number }
    | { omitted: 'missing' | 'unreadable' | 'too-large' };
  /** 证据文件的 userData 相对路径（审计段显示的那一串就是它）。 */
  ref: string;
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
 * `skipped` 是 5.5-08 补的第四态：这一步**由人在页面上做完了**，那只手一次都没被按。它既不是 `done`
 * （本 agent 没做成任何事，写成绿色「已完成」会把人做的功记到系统账上），也不是 `failed`
 * （事确实办成了，红色会让人以为要重跑）——界面必须有第四格，否则这一态只能被借画成一句谎话。
 */
export type ChatToolPartState = 'running' | 'done' | 'failed' | 'skipped';

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
  /** 成功后的统一结果读数（spec 5.1-11）；未结束与失败时为 null。 */
  output: ToolResult | null;
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
 * 一个会话的读数（含档位与标题）。
 *
 * 标题只有 `title` 这一位，且**只有人改得动**（`chat.session.rename` 是界面专属口，模型没有对应工具）：
 * 主进程从不替会话造一个名字——那等于把界面文案塞进数据库，i18n 就废了（1.11-08 的原始判断仍然成立，
 * 5.6-07 加的只是「人可以自己起一个」，所以 `title: null` 才是常态，界面用 i18n 那句默认称呼补上）。
 */
export type ChatSessionView = {
  id: string;
  autonomy: AutonomyLevel;
  createdAt: number;
  messageCount: number;
  /** 人给这条会话起的名字（进库之前已脱敏）；从没改过名时为 null，界面显示默认称呼 + id 短码 */
  title: string | null;
  /** 软删时间戳（毫秒）；未删为 null。删除只打这一位，消息与 run 的行一条都不动（spec 5.6-07） */
  deletedAt: number | null;
};

/**
 * 压缩时**现问**回来的关键事实卡（spec 5.6-02 的白名单，plan §7.4 决策三）。
 *
 * 每一位都是读的那一刻从真相取的，**不存进摘要行**：本地存第二份事实早晚会与真值不一致
 * （§9 那条 2.5-e 的教训），而 5.6-03 要的「数值逐字不变」如果靠从旧消息里摘数字就永远只是近似。
 * 取不到的那一位一律 `null` / 空数组，而不是猜一个——「这台机器没挂那只服务」与「额度是 0」是两件事。
 */
export type ChatFactCard = {
  /** 当前会话此刻的档位（库里的 `chat_session.autonomy`，认不出的值已收成最保守档） */
  autonomy: AutonomyLevel;
  /**
   * 各外发动作此刻还剩几条（`entitlement.gate.check()`）；`unlimited` 模式下该位为 null，闸门未挂载时整个数组为空。
   *
   * 动作名这里是 `string` 而不是 `QuotaAction`：那份名单住在契约包，而契约包反向依赖本包，
   * 把三个字面值抄到这里就是第二份会漂移的口径（§2.7）。给值的一侧（agent）从 `QUOTA_ACTIONS` 遍历，
   * 界面上这一位只当标签显示。
   */
  remainingByAction: { action: string; remaining: number | null }[];
  /** 这段会话最近一次 run 为什么停下（`agent_run.stop_reason`，枚举码不是文案）；没跑过为 null */
  lastStopReason: string | null;
  /** 被判定口拒掉的步：哪只工具、哪个拒因码（spec 5.6-02 的「被否决做法」） */
  refusedSteps: { toolId: string; code: string | null }[];
  /** 已经递过简历的目标 id（账本里 `deliver` 行的 `targetId`，spec 5.6-02 的「已投目标 id」） */
  deliveredTargetIds: string[];
};

/**
 * 一段被折叠的较早消息的读数（spec 5.6-02 / 04，号段 24）。
 *
 * 这一位**不存文案**：库里存的是覆盖区间与被折叠的消息 id，句子由界面用 i18n 拼（主进程不造文案，
 * 与 `ChatSessionView.title` 同一口径）。摘要是「折叠」的产物而不是「改写」：原文行一条都没动，
 * 所以 5.6-03（数值逐字相同）与 5.6-10（压缩失败不丢消息）由结构保证，最坏情况就是「没折」。
 */
export type ChatCompactionView = {
  id: string;
  sessionId: string;
  /** 被覆盖区间的左右端（毫秒，含左含右）：两条边界都是真存在过的消息时间戳 */
  fromTs: number;
  toTs: number;
  /** 被折叠掉的消息条数（界面上那句「N 条较早消息已压缩」的 N） */
  coveredCount: number;
  /** 折叠前后的 token 估计（同一把尺：`estimateTokens`），5.6-04 要的「下降可量化」就是这两个数 */
  tokensBefore: number;
  tokensAfter: number;
  createdAt: number;
  /** 读的那一刻现问回来的关键事实（不是折叠那一刻的快照，见 `ChatFactCard` 的注释） */
  factCard: ChatFactCard;
};

/** 界面首屏与重读时拿到的整份快照：当前会话 + 未被折叠的那段消息 + 压缩读数（没折过时为 null）。 */
export type ChatSnapshotView = {
  session: ChatSessionView;
  messages: ChatMessageView[];
  /** 最近一段有效压缩的读数；一条都没折过、或摘要行与被折叠的原文对不上（原文被外部删了）时为 null，界面上退回全文 */
  compaction: ChatCompactionView | null;
};

/**
 * 一份会话历史导出的顶层形状（spec 5.6-09）。
 *
 * 字段名一经落盘就是契约：`schemaVersion` 是这一份的版号，改名、删字段、加字段都要动它——
 * 人拿它做备份、将来别的工具读它，靠的就是「同一份版号下键名不会变」。
 * `messages` 给**库里全量原文**（含被折叠那一段）：折叠只是界面的呈现（5.6-04），落盘不是，
 * 「宁可长，不可丢」（5.6-10）在导出这一侧同样成立。
 * `compaction` 是那一行压缩读数（连同现问回来的事实卡）：没有它，读这份文件的人无法知道界面上为什么少了六条。
 */
export type ChatExportView = {
  schemaVersion: number;
  /** 导出时刻（毫秒），只说明"这一份是哪一刻的读数"，不参与任何判定 */
  exportedAt: number;
  session: ChatSessionView;
  compaction: ChatCompactionView | null;
  messages: ChatMessageView[];
};

/**
 * 一次导出的回执：界面或调用方拿到的"写到哪儿了"。
 * `path` 给绝对路径——桌面 app 里人是要按路径去文件夹里找这份文件的。
 */
export type ChatExportReceiptView = {
  sessionId: string;
  path: string;
  messageCount: number;
  /** 落盘字节数（不是字符数：掩码后的中文按 UTF-8 占多字节） */
  bytes: number;
};

/**
 * 流式增量事件载荷（spec 1.11-03 / 2.8-09）。
 *
 * 只带一个片段与两个 id：整份历史由 `chat.session.current()` 一次给全，事件只负责"字数在涨"。
 * 载荷刻意不传 parts 数组——那会让每片都带上整条消息，等于把流式退化成轮询的变体。
 * `tool` 是 2.8-c 补的那一位：卡片对象只在**两次状态跳变**上出现（开跑一次、落定一次），
 * 不随文本片重复，所以不违反上面那句。没有它，`执行中` 在界面上永远看不见——`ChatPanel`
 * 画的是本地 `liveStream`，而带卡片的那条 `live` 消息在快照里被 `isStreaming` 过滤掉了
 * （plan §15.8 落点 2）。
 */
export type ChatDeltaEvent = {
  sessionId: string;
  messageId: string;
  /** 本次新增的片段文本；`done` 时为空串。 */
  text: string;
  /** 该消息是否已结束；界面见到 true 才去重读快照，把工具卡片补上。 */
  done: boolean;
  /** 工具卡片的一次跳变（含最新状态）；纯文本推进的那一片不带这一位。 */
  tool?: ChatToolPart;
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
  /** 界面标题的语言包键（`agent.tool.labels.*`）——卡片只读它，不再自己存一份 id→键映射（spec 5.1-02） */
  titleKey: string;
  /** 给模型与调试面板看的说明，不是界面文案 */
  description: string;
  effect: ToolEffect;
  requiresConfirmation: boolean;
};

/**
 * 一次工具执行的**成功读数**（spec 5.1-11：结果统一为 `ToolResult`）。
 *
 * 三个字段各管一件事，缺任何一个都会退化成「界面自己猜结果」：
 * - `summary`：一句话说清这次做成了什么。卡片标题之外的那半句，也是调试面板与日志的读数；
 * - `value`：工具原本的结构化产出，模型与界面按它取字段（工具自己的返回形状不因本契约改变）；
 * - `evidenceRefs`：这次结果回指到哪些证据条目（账本行 / 库内实体 / 切片 / 快照 / 页面地址）。
 *   **空数组是有意义的读数**——「这次产出没有任何库内依据」，与 4.6-02 对话术证据的口径同源，
 *   不允许为了好看去凑一条，也不允许留 `undefined` 让界面分不清「没依据」与「没实现」。
 * @template V 工具自己的产出类型（默认 `unknown`，读侧按工具收窄）
 */
export type ToolResult<V = unknown> = {
  readonly summary: string;
  readonly value: V;
  readonly evidenceRefs: readonly string[];
};

/**
 * 组装一只工具的成功读数（16 个登记点共用，§2.2：同一逻辑第二次出现就抽公共层）。
 *
 * `evidenceRefs` 省略即空数组：把「没有依据」做成默认值，比让每只工具各写一遍 `[]` 更不容易漏，
 * 也比 `undefined` 好——字段永远在场，界面与断言不必区分两种「无」。
 * @param value 工具的结构化产出（必须可 JSON 序列化：它要落进消息 parts 并过 IPC）
 * @param init 摘要文案与证据引用；摘要说「做成了什么」，不重复 `value` 里已有的每个字段
 * @returns 三键齐备的 `ToolResult`
 */
export function toolResult<V>(value: V, init: { summary: string; evidenceRefs?: readonly string[] }): ToolResult<V> {
  return { summary: init.summary, value, evidenceRefs: init.evidenceRefs ?? [] };
}

/**
 * 一次工具调用的结果联合（spec 1.11-09：调不到的工具即报错，禁止用「已完成」的措辞掩盖）。
 *
 * 三类失败都**不抛异常**而走返回值：工具失败是对话流里要显示的一条内容（卡片红态 + 原因），
 * 不是要把整条消息抹掉的进程错误。
 *
 * 成功侧只有一种形状（spec 5.1-11）：`{ ok: true, result: ToolResult }`。刻意**不保留**
 * 「直接返回裸值」那条通路——那等于同一件事有两条口径，界面得按工具 id 分支去猜结果长什么样。
 * 失败侧必带 `code` + `message`：`message` 是要显示给用户看的原话，禁止吞错返 `undefined`
 * （注册表把实现的异常收成 `TOOL_FAILED`，实现自己不参与这层的措辞）。
 */
export type ToolCallReply =
  | { ok: true; result: ToolResult }
  | {
      ok: false;
      code: 'TOOL_NOT_REGISTERED' | 'TOOL_DISABLED' | 'TOOL_INPUT_INVALID' | 'TOOL_FAILED';
      message: string;
      /**
       * 实现自己抛出的结构化码（`AppError.code`，如 `LOCATE_FAILED` / `WAIT_TIMEOUT`），只在
       * `TOOL_FAILED` 那一支出现（spec 5.5-04）。为什么要把原码带上而不是让人去读 `message`：
       * 循环要按「这一步落空是不是因为页面变了」分支，靠匹配一句要显示给人看的中文原话分支
       * 就是措辞一改就静默失效；而 `code` 那一格仍留 `TOOL_FAILED`，界面对四种注册表结局的口径不变。
       */
      reasonCode?: string;
    };

/**
 * 「这只工具沉淀成工作流时对应哪个节点」的声明（spec 5.4-03 的前提，plan §5.4-a 落点）。
 *
 * 形状刻意是**数据而不是函数**：`params` / `target` 的值都是这只工具 `input` 里的点路径，
 * 于是 ① 机检读得动（`scripts/check-tool-contract.ts` 已经在扫 `agentTool({...})` 现场的字面量，
 * 换成闭包就只能"约定它大概对"），② 5.10.4 的算子表将来读同一处声明，不再长第二份映射。
 * 为什么不做成"按 id 猜 kind"：猜中的那次能跑，猜不中的那次会把一条跑得通的工作流说成沉淀成功，
 * 而 5.4-09 判的正是"导出计划里每一步都在对话里找得到对应卡片"。
 */
export type AgentToolWorkflowClause = {
  /** 节点执行器名，必须能在 `workflow.executors` 登记处解出（机检第 10 条 + 起跑前 `requireExecutable` 两道）。 */
  readonly kind: string;
  /** `节点参数键 → 工具入参点路径`；点路径必须能在本工具的 `input` schema 里对上。 */
  readonly params: Readonly<Record<string, string>>;
  /** `target` 的取值路径（参与幂等键 `runId+nodeId+target`）；省略即空串，表示这步不按目标去重。 */
  readonly target?: string;
};

/**
 * 一个工具的声明式契约（spec 2.8-08）。
 *
 * 形状放在 `core` 而不是 `agent`：登记方是 L2 的能力包（浏览器 / 会话 / 外发 / 平台），
 * 它们不允许 import L3 的对话插件（AGENTS.md §4.1），而「工具长什么样」必须两侧共认，
 * 否则就是两份定义（§2.5）。`input` 用 zod 不是为了好看：工具入参来自模型或渲染层，
 * 是系统边界上的不可信输入，必须在递给实现之前收一次窄（§2.6）。
 * @template I schema 解析后的入参类型（默认 `unknown`，注册处收窄）
 * @template R 本次产出（`ToolResult.value`）的类型（默认 `unknown`，由 `run` 的返回推出）
 */
export interface AgentToolDeclaration<I = unknown, R = unknown> {
  /** 全限定 id，约定 `域.动作` 且与服务口名一致（plan §15.1 决策 5） */
  readonly id: string;
  /**
   * 界面标题的语言包键（spec 5.1-02）。
   *
   * 它是**注册表里的一个键，不是文案**：卡片把这条键交给语言包解析，界面上就不该再有第二份 id→键映射。
   * 之前那份映射长在渲染层（`ChatPanel` 的 `TOOL_LABEL_KEY`），后果已经现场抓到过：
   * `resume.generate.run` 登记成了工具、却漏在那张表里，卡片于是显示「未登记的工具」。
   */
  readonly titleKey: string;
  /** 给模型与调试面板看的一句话说明：描述这只工具**做什么**，消费者是模型与开发者，不是界面文案 */
  readonly description: string;
  /** 入参 schema：调用前 `safeParse`，不过就以 `TOOL_INPUT_INVALID` 返回，绝不把脏值递给 `run` */
  readonly input: ZodType<I>;
  /** 副作用分级；`outbound` 必须同时 `requiresConfirmation: true`（plan §15.7 落点 4） */
  readonly effect: ToolEffect;
  /** 是否需要用户先批准再执行；P2 只登记值，强制属 P5 */
  readonly requiresConfirmation: boolean;
  /**
   * 「已登记但暂不开放」（spec 5.1-10）。省略即开放。
   *
   * 它不是「隐藏的开关」而是「收回的手」：`list()` 不列它，`call()` 也调不到它（`TOOL_DISABLED`）。
   * 只藏清单不拦调用会留下第二条通路——界面上看不见、模型不知道，但拼得出 id 的人照样能按下去，
   * 那是 §2.5 禁止的「两套都能用」，也让「工具面 = service 白名单」这句话失去意义。
   * 为什么留在注册表而不是直接不登记：登记是**能力包声明自己有这只手**，禁用是**装配/档位侧暂时收窄**，
   * 两件事分属两侧；做成不登记就把「能力存在但此刻不给用」这个事实丢了，日志与断言都无从对账。
   */
  readonly disabled?: boolean;
  /**
   * 这只手能不能沉淀成工作流节点（spec 5.4-03 的前提）。**省略即不可沉淀**，没有默认回落。
   *
   * 只在主进程内被 `agent.sediment` 现读（不进 `ToolDescriptorView`、不过 IPC）：它是"能力怎么被复用"
   * 的声明，不是界面上要画的读数；把它搬到进程边界另一侧，渲染层就得为一个用不上的字段拆壳（§2.6）。
   */
  readonly workflow?: AgentToolWorkflowClause;
  /**
   * 这一步**由人在页面上做完了**长什么样的一句话面文本（spec 5.5-08 的判据对象）。**省略即永不自动跳过**。
   *
   * 为什么是文本而不是选择器或闭包：判据要问的是「现在这页上有没有出现『已发出／已回复』这类结果」，
   * 而循环不认识浏览器、也不认识任何具体平台的选择器（plan §8 禁止在 agent 层写业务映射）。
   * 文本哨兵是这只手的主人（能力包）自己标定的一条页面事实，循环只做一次子串比对（`agent.loop` 的
   * `skipStepDoneByHuman`），比对的 haystack 是那次只读重读交回的**全部可读文本**，不是进 prompt 的那 80 字摘要。
   * 与 `workflow` 同一口径：**只在主进程内被现读**（`agent.tools.doneMarkerOf`），不进 `ToolDescriptorView`、
   * 不过 IPC——渲染层为一个用不上的字段拆壳没有收益（§2.6）。
   * 为什么默认不给：猜中的那次会把一次外发悄悄跳掉，猜不中的那次只是多问一句「要不要批准」；
   * 未标定因此取安全方向，而标定必须由人在装配侧（服务配置）显式写下那句页面原话。
   */
  readonly doneMarker?: string;
  /**
   * 实际执行。
   * @param params 已过 schema 的入参
   * @param signal 取消信号，实现必须协作式让出（与 runner 同一语义）
   * @returns `ToolResult`（spec 5.1-11）：摘要 + 结构化产出 + 证据引用；产出必须可 JSON 序列化
   *   （要落进消息 parts 并过 IPC）。**不许返回裸值**——那会让成功侧重新长出两种形状。
   */
  run(params: I, signal?: AbortSignal): Promise<ToolResult<R>>;
}

/**
 * 工具注册表对**登记方**暴露的窄面（`agentToolsOf` 的返回类型）。
 *
 * 刻意不含 `list` / `call`：那两个是给对话入口与界面读的，能力包只该往里放东西。
 */
export interface AgentToolRegistry {
  register<I, R>(tool: AgentToolDeclaration<I, R>): void;
  unregister(id: string): boolean;
}

/**
 * 一次 agent 任务的运行状态（spec 5.2-05）。
 *
 * 五态各有明确的进入条件，**不留「看起来像成功」的模糊位**：
 * - `proposed`：计划草案已出、用户还没确认，此时一步都不许执行（5.2-03）；
 * - `running`：已确认，正在「取步 → 判闸门 → 调工具 → 写观察」；
 * - `paused`：被叫停，或某一步被 `agent.policy` 拒了等表态（5.3 的审批口从这里接）；
 * - `completed`：**跑到的每一步都成功**才用它——它就是界面那句「做完了」的凭据；
 * - `failed`：有步失败/被拒，或撞到步数、token 上限。原因在 `stopReason`，不在状态名里。
 */
export const AGENT_RUN_STATUSES = ['proposed', 'running', 'paused', 'completed', 'failed'] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/**
 * 一步的落库状态（spec 5.2-02 / 05 / 08）。
 *
 * `pending` 是「行已经写下、动作还没回来」：它让中途叫停与崩溃后的重读都看得见进度，
 * 而不是只能等这一步变成终态。
 * `skipped` 是 5.5-08 补的第五态：**这只手一次都没被按**，因为人在接管期间已经把这件事做完了
 * （判据是那只手声明的 `doneMarker` 出现在恢复时那份新读数里）。它与 `refused` 的区别在谁也没拒绝它，
 * 与 `ok` 的区别在页面上那条结果不是本 agent 做的——`observation` 与 `evidence_refs` 必须能读出这两件事，
 * 所以生产者是 `agent.loop.skipStepDoneByHuman` 一处，别处不许凭空写这一态（§2.4 不留死枚举）。
 */
export const AGENT_STEP_STATUSES = ['pending', 'ok', 'failed', 'refused', 'skipped'] as const;

export type AgentStepStatus = (typeof AGENT_STEP_STATUSES)[number];

/**
 * 计划里的一步：模型说的部分 + 注册表说的部分**分开放**（spec 5.2-07）。
 *
 * `intent` / `input` / `toolId` 来自模型草案，属于不可信输入；`effect` / `requiresConfirmation`
 * 是循环从注册表现读的真相。模型若在草案里自称「这步只读、无需确认」，界面与判定都不看它一眼——
 * 这正是 5.2-07 要的形态：权限由代码判，措辞由模型写。
 * `effect` 允许为 null：那是「草案指了一只不存在的手」，此时策略直接拒，不猜名（与 5.1-05 同一口径）。
 */
export type AgentPlanStepView = {
  planStepIndex: number;
  toolId: string;
  input: unknown;
  /** 模型对这步的说明（是**内容**不是界面文案：模型产出的文本不进语言包，界面只显示外壳） */
  intent: string;
  effect: ToolEffect | null;
  requiresConfirmation: boolean;
};

/** 一步的执行记录（spec 5.2-05 要的 `planStepIndex/status/snapshotRefs` 都在这张读数上）。 */
export type AgentStepView = {
  runId: string;
  planStepIndex: number;
  toolId: string;
  status: AgentStepStatus;
  /** 这一步递给模型的上下文引用（`run:<runId>/step:<i>`），5.2-06 的「按引用传」就落在这一位 */
  snapshotRefs: string[];
  /** 观察摘要：成功是模型把工具读数收的一句，失败是注册表给的 code + 原话 */
  observation: string;
  /** 工具交回的证据引用（`ToolResult.evidenceRefs` 原样带上，空数组同样有意义） */
  evidenceRefs: string[];
  /** 耗时毫秒；还没跑完为 null（不用 0 冒充零耗时） */
  durationMs: number | null;
  /** 拒因或失败码（`POLICY_*` / `TOOL_*`），成功为 null */
  code: string | null;
};

/**
 * 一条证据引用点开之后的读数（spec 5.7-02）。
 *
 * 形状上最重要的一条是**`title` / `body` / `unavailableReason` 三者必有其一**：这只口对每一种引用
 * 都给确定结局（读到正文，或说清为什么读不到），从不抛错也从不留白。判据「每一步都能回溯」问的是
 * 结局确定，不是每条都能读到正文——循环合成的重读引用记的是时刻而不是文件，硬凑一个空视图才是说谎。
 * 文本由主进程按归属服务的字段拼出来，与观察摘要同一口径（是**内容**，不进语言包；界面只画外壳）。
 */
export type EvidenceRefView = {
  /** 引用原文，与 `AgentStepView.evidenceRefs` 里被点的那一条逐字相同 */
  ref: string;
  /** 引用前缀（`ledger` / `job` / `doc` …），路由表的键；界面只当数据画，不再据它分派（决策十一） */
  kind: string;
  /** 归属记录的标题行；读不到正文为 null */
  title: string | null;
  /** 归属记录的正文读数；读不到为 null */
  body: string | null;
  /** 为什么读不到（服务未挂载 / 库里没有这一行 / 这条引用本来就不落正文）；读到正文为 null */
  unavailableReason: string | null;
  /**
   * 归属记录的时刻（毫秒时间戳）；引用里带时刻的（`…@<毫秒>`）也填这一位。
   * 主进程只给数不给格式化后的字符串：本地时区与显示格式是界面的事，而账本 `dayKey` 那一课已经证明
   * 「把时区判定写进主进程」会让同一时刻在两条路上算出不同的日子（AGENTS.md §8.5 的口径同样适用）。
   */
  at: number | null;
};

/** 一次任务的整份读数：界面与日志都从这里取，run 行与步行的唯一投影（§2.5 一份口径）。 */
export type AgentRunView = {
  runId: string;
  sessionId: string;
  /** 用户原文（已去空）——桩模型与真模型都按它起草计划 */
  goal: string;
  status: AgentRunStatus;
  /** 起草时读到的档位快照；执行中改档位不改这一位（5.3 管档位提升的审计） */
  autonomy: AutonomyLevel;
  planStepIndex: number;
  plan: AgentPlanStepView[];
  steps: AgentStepView[];
  stepLimit: number;
  tokenBudget: number;
  tokensUsed: number;
  /** 循环为什么停下（`COMPLETED` / `USER_STOPPED` / `POLICY_REFUSED` / `STEP_LIMIT` / `TOKEN_LIMIT` / `MODEL_UNAVAILABLE`） */
  stopReason: string | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * 一步能不能沉淀、为什么不能（spec 5.4-02 / 09 的逐格读数）。
 *
 * `reason` 与 `AgentPauseView.reason` 同理是**服务侧产出的人读原话**，不进语言包：
 * 它的内容由工具声明与执行器登记处决定，界面只负责把它摆在正确的格子里（外壳文案才走 i18n）。
 * `node` 是投影出来的节点声明，`null` 表示这步压根没有可跑的对应节点——此时 `sedimentable` 必为 false。
 */
export type SedimentStepView = {
  planStepIndex: number;
  toolId: string;
  /** 这一步在 `agent_step` 里的状态原值（`pending` / `ok` / `failed` / `refused` / `skipped`，见 `AGENT_STEP_STATUSES`）。 */
  stepStatus: AgentStepStatus;
  sedimentable: boolean;
  reason: string | null;
  node: WorkflowNodeSpec | null;
  /** 这个节点里每个参数的"变量 / 残留"读数（spec 5.4-04）。 */
  params: PlanParamReadoutView[];
};

/**
 * 一次沉淀预览（spec 5.4-01 的界面素材，`agent.sediment.preview` 的返回）。
 *
 * 预览与落库走的是同一条投影（不是"界面先猜一版、服务再拒一版"）：界面上说得出的"能沉淀"，
 * `save()` 必然做得成；反过来 `save()` 拒的每一条原因都能在这张读数里先看见。
 */
export type SedimentPreviewView = {
  runId: string;
  goal: string;
  steps: SedimentStepView[];
  canSediment: boolean;
  /** 整段被拒的原话；可以沉淀时为 null。 */
  blockingReason: string | null;
};

/**
 * 一条「当前免确认」的读数（spec 5.3-07：界面上要能读出哪些动作已免确认）。
 *
 * 名单里只存「这只手免不免确认」这一件事，副作用级与标题键都是**现读注册表**的那份投影——
 * 在本表镜像一份 effect 就会在能力包被摘掉后说假话（AGENTS.md §2.5 + §9 的 2.5 实测）。
 * `descriptor` 为 null 就是那种情况：加白时这只手还在，如今不在开放面上了，界面按「未登记」画；
 * 判定口对它仍先给 `TOOL_UNAVAILABLE`，免确认名单不会因为一条陈旧记录而放行任何东西。
 */
export type ExemptToolView = {
  toolId: string;
  /** 加白时刻（毫秒） */
  addedAt: number;
  descriptor: ToolDescriptorView | null;
};

/**
 * 一次加白 / 撤白的审计读数（与 5.3-05 的档位变更审计同族）。
 *
 * `source` 只可能是 `'user'`：写入口只有界面上那一条，加白与撤销这两个口都不登记为 agent 工具
 * （5.3-04 防的是"agent 自己给自己放宽"，加白正是它的第二种形态）。
 */
export type ExemptAuditRow = {
  id: number;
  toolId: string;
  action: 'add' | 'revoke';
  source: string;
  createdAt: number;
};

/**
 * 一张暂停单分哪两类（spec 5.3-08）。
 *
 * 两类要问人的事根本不是一回事，所以界面是两张卡而不是一张卡两种按钮：
 * `approval` 问「这一步可以动手吗」（是/否），`elicitation` 问「这一步还缺哪些信息」（可多轮补充）。
 */
export type AgentPauseKind = 'approval' | 'elicitation';

/**
 * 一张正在等人的暂停单（spec 5.3-08 / 09）。
 *
 * 它同时是 `agent/pause-requested` 的载荷与 `agent.pause.pending()` 的现读形状——两者必须同一个类型，
 * 否则「错过事件之后刷新出来的卡片」会和飘过时的那张长成两副样子（与 `DeliverApprovalView` 同一条口径）。
 * `requestId` 是应答的路由键：交叉应答只能各归各的步，错 id / 重复 id 的应答在通道里是 no-op（5.3-09）。
 * `reason` / `missing` 是**服务侧产出的人读原话**，与 `AgentPlanStepView.intent` 同理不进语言包：
 * 它们的内容由判定与 schema 决定，不是界面能自己编的措辞。
 */
export type AgentPauseView = {
  requestId: string;
  runId: string;
  planStepIndex: number;
  toolId: string;
  kind: AgentPauseKind;
  /** 为什么停在这里（`approval` 是判定口原话，`elicitation` 是工具自己的契约原话） */
  reason: string;
  /** 这一步的入参还缺/错在哪些字段（`-` 表示整段不是对象）；`approval` 单恒为空数组 */
  missing: string[];
  /** 第几轮：`approval` 恒为 1，`elicitation` 每重新开一单加一（多轮=新单，不在一单里做分页） */
  round: number;
  /** 什么时候开始等人（毫秒时间戳） */
  requestedAt: number;
  /** 到点即拒（`requestedAt + pauseTimeoutMs`）：**没人表态永远不等于同意**（spec 5.3-10） */
  expiresAt: number;
};

/**
 * 人对一张暂停单的表态（spec 5.3-08）。
 *
 * 三种表态而不是「两类卡各有各的应答形状」，是因为两类卡都有**同一个放弃口**：
 * `elicitation` 的「放弃」与 `approval` 的「拒绝」在循环侧是同一种结局（这一步不执行），
 * 分两套类型就会逼调用方写两份分支去表达同一件事。
 * 一张单能接住哪几种表态由 `agent.pause` 按单自己的 `kind` 判（渲染层是系统边界，§2.6）。
 */
export type AgentPauseAnswer = { decision: 'approve' } | { decision: 'deny' } | { decision: 'supply'; text: string };

/**
 * 一张暂停单收掉的信号（spec 5.3-08 的界面半边：卡片要能从界面上消失）。
 *
 * 只有 id 与结局，不带内容——界面对话框里的正文它本来就有（`pending()` 那份），
 * 再推一遍就是第二份真相（§2.5）。
 */
export interface AgentPauseResolvedEvent {
  requestId: string;
  /** `answered` 是人的表态落了地；后两者都**不是一种表态**，界面要说「没人应答」而不是「用户拒绝了」 */
  outcome: 'answered' | 'timed-out' | 'cancelled';
}

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

/**
 * 一份简历附件摆在界面上的三要素（spec 2.6-01 / 05）。
 *
 * 刻意**不含绝对路径**：`ResumeAttachment.path` 里有用户名目录，而「递的是哪份文件」靠
 * 文件名 + 字节数 + hash 就够了（AGENTS.md §8 第 5 条：个人数据默认脱敏）。
 */
export interface DeliverAttachmentView {
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * 一张待确认的投递单（spec 2.6-01）：既是 `outbound/approval-requested` 的载荷，也是
 * `outbound.deliver.pending()` 现读出来的形状——两者必须是同一个类型，否则刷新后重画的卡片
 * 与飘过一次的事件会长成两副样子。
 */
export interface DeliverApprovalView {
  approvalId: string;
  platform: string;
  jobId: string;
  title: string;
  company: string;
  attachment: DeliverAttachmentView;
  /** 什么时候开始等人（毫秒时间戳） */
  requestedAt: number;
  /** 到点即拒（`requestedAt + approveTimeoutMs`）：没人表态永远不等于同意 */
  expiresAt: number;
}

/**
 * 知识库实体表被写入时由 `kb.profile` 发出（spec 4.2-06）。
 * 载荷刻意**不含实体内容**：界面拿到信号就重读 `kb.profile.list`，而不是在渲染层拼一份库的副本——
 * 两边都能算就等于两套真相（AGENTS.md §2.5）。
 */
export interface KbEntitiesChangedEvent {
  /** 触发这次变更的动作，界面按它取一句人话 */
  readonly action: 'create' | 'update' | 'remove' | 'sync' | 'import';
  /** 关联的简历文档 id；手工实体的增删不隶属任何文档，此时为 `null` */
  readonly docId: string | null;
  /** 受影响的行数，只进提示文案，不作为界面数据来源 */
  readonly changed: number;
  /** 变更发生的毫秒时间戳 */
  readonly at: number;
}

/**
 * 自定义计划库被写过时由 `workflow.runner` 发出（spec 5.4-01 的「存成后计划库出现新条目」）。
 * 载荷**不含计划内容**：计划库那一份真相在 `workflow_plans` 表里，界面收到信号就重读
 * `workflow.runner.plans`，不在渲染层留第二份列表（AGENTS.md §2.5 / §9 的 2.5 实测条）。
 */
export interface WorkflowPlansChangedEvent {
  /** 触发这次变更的动作，界面按它取一句人话 */
  readonly action: 'save' | 'rename' | 'remove';
  /** 这次写进 / 改掉 / 删掉的那条计划 id */
  readonly planId: string;
  /** 变更发生的毫秒时间戳 */
  readonly at: number;
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
     * 主框架响应状态码或页面字样命中风控判据时由 `browser.risk` 发出（spec 2.7-01）。
     * 这条是**唯一的出口**：状态码一路与文本一路都收敛到同一个事件名，
     * 于是「暂停」只需要在一处订阅（plan §14.3 第 1 条），而界面只拿到判定数据、自己组句子。
     */
    'browser/risk-signal'(event: RiskSignalEvent): void;
    /**
     * 页面「在谁手里」这件事发生变化时由 `browser.takeover` 发出（spec 5.5-01 / 02 / 09）。
     *
     * 载荷就是 `held()` 的那份读数、不另包一层：界面、判定口、循环读的是同一个形状，
     * 包一层就得在渲染层再推一次「现在到底谁在操作」，那是 §2.7 禁的第二份事实。
     * 幂等的那两次调用**不发**这一条（`begin` / `end` 的注释写着为什么），所以订阅方不会因为
     * 风控信号连发而被叫醒第三次。
     */
    'browser/takeover-changed'(event: TakeoverStateView): void;
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
     * agent 循环每推进一次（确认起跑 / 一步开始 / 一步结束 / 收尾）由 `agent.loop` 发出（spec 5.2-04）。
     * 载荷**就是** `agent.loop.read()` 那份 `AgentRunView`，不额外包一层：界面与日志读的是同一个形状，
     * 包一层就得在渲染层再推导一次「现在到底跑到第几步」，那是 §2.7 禁的第二份事实。
     */
    'agent/run-progress'(event: AgentRunView): void;
    /**
     * 循环里的某一步挂在人身上时由 `agent.pause` 发出（spec 5.3-08）。
     * 两类暂停共用这一条事件名，分型由载荷里的 `kind` 说——它们是同一条通道的两种问法，
     * 拆成两个事件名就会有两处订阅、两套「错过了怎么办」的逻辑（§2.2）。
     * 与投递单同一分工：事件负责「此刻提醒」，`agent.pause.pending()` 负责「错过了也还在」。
     */
    'agent/pause-requested'(event: AgentPauseView): void;
    /**
     * 一张暂停单收掉时由 `agent.pause` 发出（spec 5.3-08 的界面半边：卡片要消失得掉）。
     * 超时与让出也发这一条，且 `outcome` 说的就是"没人应答"——界面不许把它画成"用户拒绝了"。
     */
    'agent/pause-resolved'(event: AgentPauseResolvedEvent): void;
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
    /**
     * `semi` 档的投递在闸门之后、真正点发送之前挂起等人确认时由 `outbound.deliver` 发出
     * （spec 2.6-01）。载荷就是 `pending()` 能现读出来的那张单子，界面两条路都要能画出同一张卡片：
     * **事件负责「此刻提醒一下」，`pending()` 负责「错过了也还在」**。
     */
    'outbound/approval-requested'(event: DeliverApprovalView): void;
    /**
     * 知识库实体表发生任何写入（新建 / 编辑 / 删除 / 同步 / 导入备份）时由 `kb.profile` 发出
     * （spec 4.2-06）：编辑要即时生效，界面不靠用户重启或手动刷新，也不靠轮询 `list()`。
     */
    'kb/entities-changed'(event: KbEntitiesChangedEvent): void;
    /**
     * 计划库发生任何写入（沉淀存成 / 重命名 / 复制 / 删除）时由 `workflow.runner` 发出
     * （spec 5.4-01）：这些写入口有一处**不在计划库界面里**（对话侧的沉淀卡），
     * 只靠界面自己刷新就会漏掉那一类，所以刷新信号只能从写入口这一侧发。
     */
    'workflow/plans-changed'(event: WorkflowPlansChangedEvent): void;
  }
}
