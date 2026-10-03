/**
 * 调度域的对外读数与外部端口形状（spec 5.7-05 / 06 / 09）。
 *
 * 为什么这些类型住在本包而不是 `@auto-cc/core`：core 的类型面是**跨包共用**的（`ChatExportView` 那种），
 * 而下面这几张视图今天只有一个生产者与一个消费者，都在调度域内。5.7-b 接界面时若渲染层要经
 * `cordis:call` 读它们，再按 §5.8 的契约口径把它们提到契约包——现在提前提就是第二份未使用的出口（§2.4）。
 */

/** 任务启用状态与"下一次什么时候跑"的合并读数，界面上那一行就来自它。 */
export type ScheduleJobView = {
  id: string;
  /** 用户给任务起的名字，只用于界面辨认，不参与任何判定 */
  name: string;
  /** 被触发的那条**已保存工作流**的 id（5.7-07：只能是它，不能是一段自由对话） */
  planId: string;
  /** cron 表达式原文；回显用，判定一律走重算（见 `internal/cron.ts`） */
  expression: string;
  isEnabled: boolean;
  /**
   * 下一个计划时刻（毫秒，绝对时间点，按运行机器本地时区算出）。
   * 停用任务为 null——它没有"下一次"，重新启用时按当时重算，于是停用期间自然越过的那些点不算"错过"。
   */
  nextRunAt: number | null;
  /** 上一次被处理掉的计划点（触发成功、被跳过、失败都算处理过），null = 从来没处理过 */
  lastPlannedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * 单次触发的结局。
 * `started` 只说"起跑口返回了一条 run"，不说"这轮工作流跑成了"——那是 `workflow` 侧的读数（5.7-02 的证据链）。
 */
export type ScheduleTriggerResult = 'started' | 'skipped' | 'failed';

/** 每一次触发都追加一行（5.7-06）：结果写在记录上而不是 job 行上，才答得出"失败有没有影响下一次"。 */
export type ScheduleTriggerView = {
  id: string;
  jobId: string;
  /** 这一次对应的那个计划点 */
  plannedAt: number;
  /** 实际动手的时刻（毫秒）；`skipped` 里"错过补记"那一条为 null，因为那一刻 app 根本没在跑 */
  firedAt: number | null;
  result: ScheduleTriggerResult;
  /** 跳过/失败的**原话**：额度拒因来自闸门，起跑失败的原因来自 `workflow.runner`，调度器不自己编 */
  reason: string | null;
  /** 起成功时 `workflow.runner` 给的 run id；其余为 null */
  workflowRunId: string | null;
  createdAt: number;
};

/**
 * 调度器眼里的"起跑口"（`workflow.runner` 的本包侧投影）。
 *
 * 只声明这两件事是有意的：调度能做的最远的一步就是"拿一个已存在的计划 id 起跑"，
 * 于是 5.7-07「不能触发自由对话任务」不是校验代码而是不存在那条路——端口上没有 `goal`，
 * 也没有 `agent.loop`，实现里想越权就得先改这个接口，而改它会在这次提交的测试里失败。
 * 返回类型写成 `{ runId }` 而不是真实的 `WorkflowRunView`：本包不认识工作流的节点模型（§4.1 禁止同级横向依赖）。
 */
export interface ScheduleLaunchPort {
  /** 当前可起跑的计划 id 清单（内置目录 + `workflow_plans` 的合并读数） */
  plans(): { id: string }[];
  /** 按计划 id 起跑；id 不存在或已有 run 在跑时**抛**结构化错误 */
  start(planId: string): { runId: string };
}

/**
 * 调度器眼里的"额度闸门"（`entitlement.gate` 的本包侧投影，只用到只读那一半）。
 *
 * `action` 这里是 `string` 而不是契约包的 `QuotaAction`：那份名单住在契约包，而本包不依赖它，
 * 抄一份枚举就是第二套额度事实（与 `packages/core/src/events.ts` 同一条口径）。
 * 名单来自本包的 `SCHEDULE_OUTBOUND_ACTIONS`，两处用同一个常量，不会漂移。
 */
export interface ScheduleQuotaPort {
  /** 只读判定：不许在这里记账，也不许在这里抛——真正的闸门仍在节点里由 `enforce` / `perform` 执行（§7.3） */
  check(
    action: string,
    context?: { nowMs?: number },
  ): { allowed: boolean; remaining: number | null; reason: string | null };
}
