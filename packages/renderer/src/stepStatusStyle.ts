/**
 * 步骤状态 → 描边/文字配色（spec 1.10-03 的四种状态）。
 *
 * 抽出来是因为画布上的节点卡片和工作流面板里的步骤行**必须同色**：同一个 `run.steps` 的读数
 * 在两处显示成两种颜色，用户就没法把「哪一格在跑」对上「画布上哪个节点在亮」（AGENTS.md §2.5
 * 说的「两份事实」在这里的表现形式）。判定仍然一行都不做，状态整份来自 `workflow.runner`。
 */
import type { WorkflowStepView } from '@auto-cc/shared';

export const STEP_STATUS_STYLE: Record<WorkflowStepView['status'], string> = {
  pending: 'border-slate-800 text-slate-500',
  running: 'border-sky-800 bg-sky-950/40 text-sky-200',
  done: 'border-emerald-900 bg-emerald-950/30 text-emerald-300',
  failed: 'border-rose-900 bg-rose-950/40 text-rose-200',
};
