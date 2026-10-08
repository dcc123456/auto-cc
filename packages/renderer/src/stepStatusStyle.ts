/**
 * 步骤状态 → 描边/文字配色（spec 1.10-03 的四种状态 + 5.10-08 的「已跳过」）。
 *
 * 抽出来是因为画布上的节点卡片和工作流面板里的步骤行**必须同色**：同一个 `run.steps` 的读数
 * 在两处显示成两种颜色，用户就没法把「哪一格在跑」对上「画布上哪个节点在亮」（AGENTS.md §2.5
 * 说的「两份事实」在这里的表现形式）。判定仍然一行都不做，状态整份来自 `workflow.runner`。
 * 五种状态各占一条 06 子计划的语义色：`skipped` 用琥珀（等人/本机态），不复用 `pending` 的灰——
 * 分支图里「这支没走」和「还没轮到」是两件事，都画成灰就等于告诉用户「这条 run 什么都没跑」。
 * 语气只上**描边与文字**，底材一律墨面（`BLOCK_SURFACE_CLASS`）：一次 run 里同时有 running/done/failed
 * 三行，底材跟着语气走就会长出色斑列，而稿上的行与卡片从不这样画（`shared.css:861-900`）。
 */
import type { WorkflowStepView } from '@auto-cc/shared';
import { BLOCK_EDGE_CLASS, BLOCK_SURFACE_CLASS } from './ui/controls';

export const STEP_STATUS_STYLE: Record<WorkflowStepView['status'], string> = {
  pending: `border-line-strong ${BLOCK_SURFACE_CLASS} text-slate-500`,
  running: `${BLOCK_EDGE_CLASS.celadon} ${BLOCK_SURFACE_CLASS} text-slate-100`,
  done: `${BLOCK_EDGE_CLASS.jade} ${BLOCK_SURFACE_CLASS} text-jade`,
  failed: `${BLOCK_EDGE_CLASS.seal} ${BLOCK_SURFACE_CLASS} text-seal`,
  skipped: `${BLOCK_EDGE_CLASS.amber} ${BLOCK_SURFACE_CLASS} text-amber`,
};
