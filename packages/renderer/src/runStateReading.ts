/**
 * 节点行的取数（spec 2.4-03 / 04 的「内存优先、库里兜底」口径，从 `AuditSection` 抽出来的唯一实现）。
 *
 * 抽出来的理由是 AGENTS.md §2.2：这一段「先读本次进程的落库真相、读不到才回落到库里那条可续 run，
 * 并把用的是哪一份一起交出去」已经是第二次需要它（审计段 + 画布的点格弹层）。留在原地就会出现
 * 「两处对同一个 null 做出不同结论」——那正是本项目反复拦制的第二类真相。
 */
import type { WorkflowRunStateView } from '@auto-cc/shared';

/** 节点行的事实源：`state` 是本次进程的 run，`resumable` 是库里最近一次可续的那次。 */
export type NodeRunSource = 'state' | 'resumable';

/** 一次取数结果：选中那份 run 状态 + 它是从哪一口读来的（界面要把它显示出来，不让用户猜）。 */
export type NodeRunReading = { state: WorkflowRunStateView; source: NodeRunSource };

/**
 * 取节点行的两份读数，并按「内存优先、库里兜底」选一份。
 * @param bridge 渲染层桥接（纯浏览器调试态下可以是 undefined）
 * @returns 选中的 run 状态 + 它来自哪份读数；两份都读不到时为 null
 */
export async function readNodeRunState(bridge: Window['autoCC']): Promise<NodeRunReading | null> {
  const [stateReply, resumableReply] = await Promise.all([
    bridge?.workflow['runner.state'](),
    bridge?.workflow['runner.resumable'](),
  ]);
  if (stateReply?.ok && stateReply.value) return { state: stateReply.value, source: 'state' };
  if (resumableReply?.ok && resumableReply.value) return { state: resumableReply.value, source: 'resumable' };
  return null;
}
