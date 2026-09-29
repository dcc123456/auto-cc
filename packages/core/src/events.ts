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
  }
}
