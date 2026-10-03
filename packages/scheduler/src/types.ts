/**
 * 调度域的外部端口形状（spec 5.7-06 / 07 的封闭接口）。
 *
 * 读数类型（`ScheduleJobView` / `ScheduleTriggerView` / `ScheduleTriggerResult`）**不住在这里**：
 * 5.7-b 接界面时它们要经 `cordis:call` 过进程边界，按 §5.8 的契约口径提到契约包 `@auto-cc/shared`
 * 定型一次，本包经它取同一份（口径与 `outbound` 用 `SendReceiptView` 一致）。这里再写一遍就是 §2.5
 * 禁止的第二份事实——两边字段一旦漂开，界面读到的和落库的就不再是同一件事。
 */
export type { ScheduleJobView, ScheduleTriggerResult, ScheduleTriggerView } from '@auto-cc/shared';

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

/**
 * 调度器眼里的"频控预检口"（`outbound.throttle` 的本包侧投影，spec 5.7-08 的频控那半边）。
 *
 * 与额度那只端口分开的理由是**判的东西不同**：闸门答「今天还能不能做」，这里答「此刻动手会不会被间隔按住」。
 * 两份读数都只读——预检不记账、不留痕（被拒流水只在 `gate.enforce` 那一个写入口产生，spec 5.3-12），
 * 所以"调度器跳过的这一跳"不会被算成一次尝试、也不会启动频控的钟。
 * 实现方是 `outbound.throttle`，它按区间**下界**判：只有必然还要等才拒，见那边的 `checkGap` 注释。
 */
export interface ScheduleThrottlePort {
  checkGap(
    action: string,
    context?: { nowMs?: number },
  ): { allowed: boolean; remainingMs: number; reason: string | null };
}
