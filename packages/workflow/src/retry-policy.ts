/**
 * 重试预算由节点的 `effect` 决定（spec 5.7-04）。
 *
 * 这条规则进代码之前的形状（plan §7.5.1 F6）：`maxAttempts = 1 + (spec.retryTimes ?? config.retryTimes)`，
 * 于是「外发步不自动重试」全靠计划里手抄一行 `retryTimes: 0`——而 `BOSS_E2E_PLAN` 的 `e2e-greet`
 * 恰恰漏了这行，它会真地把一句招呼重发两次。**靠人记得写的规则就是一条会被漏写的规则**，
 * 所以判据改成：外发（`outbound`）恒为一次尝试，非外发最多两次额外尝试。
 * 计划里的手写值只在不与这条冲突时生效。
 */
import type { WorkflowNodeSpec } from '@auto-cc/core';

/** 非外发步的额外尝试上限：spec 5.7-04 原文的「只读步自动重试 ≤2 次」。 */
export const READ_RETRY_CEILING = 2;

/** 一个节点这次该尝试几次，以及被 `effect` 压掉了多少原本写在手上的额外尝试。 */
export type RetryBudget = {
  /** 总尝试次数（含第一次），循环上界是 `attempt < attempts` */
  attempts: number;
  /** 计划里声明的额外尝试被压掉的差值；0 表示没压（界面与日志用它决定要不要说一句） */
  clampedAway: number;
};

/**
 * 取一个节点的重试预算。
 * @param spec 节点声明（读它的 `effect` 与可选的 `retryTimes`）
 * @param configRetryTimes 全局配置的额外尝试数（`workflow.runner` 的 `retryTimes`，省略声明时用它）
 * @returns 预算；外发步恒为 `{ attempts: 1 }`，非外发步为 `1 + min(声明 ?? 配置, 2)`
 */
export function retryBudgetFor(spec: WorkflowNodeSpec, configRetryTimes: number): RetryBudget {
  if (spec.effect === 'outbound') {
    const declared = spec.retryTimes ?? configRetryTimes;
    return { attempts: 1, clampedAway: Math.max(0, declared) };
  }
  const wanted = Math.min(spec.retryTimes ?? configRetryTimes, READ_RETRY_CEILING);
  return { attempts: 1 + Math.max(0, wanted), clampedAway: 0 };
}
