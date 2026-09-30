/**
 * 闸门与账本共用的动作上下文（spec 1.9-01 / 1.9-04 / 2.5-09）。
 *
 * 三个字段都是「P5/P2 才用得上」的接线面，但各自都有当前用途，不是为假想预留：
 * `nowMs` 是日额度判定的基准（单测靠它造「昨天」与「今天」），
 * `targetId` 与 `workflowRunId` 直接进账本行（spec 1.9-04 要求的字段）。
 */
export type ActionContext = {
  /** 动作对象标识（P1 是 fixture 的岗位 id，P2 起是平台侧的 jobid）。 */
  targetId?: string | null;
  /** 属于哪一次工作流运行；P1 没有 runner，所以多为 null。 */
  workflowRunId?: string | null;
  /** 判定与落账的基准时间戳（毫秒）；省略则取当前时间。 */
  nowMs?: number;
  /**
   * 这条账由什么产生（spec 2.5-09 的可追溯来源，如 `v1:1001` = 模板版本 v1 为 JD 1001 产出的文案）。
   *
   * 由 `gate.perform` 原样透传给 `usage.ledger.record`：`perform` 落账时是 `record({ action, ...context })`，
   * 所以来源挂在上下文上就能进已有的 `source` 列，不必给闸门加第二个签名、也不必改建表。
   */
  source?: string | null;
};
