/**
 * 点一格节点弹出的运行读数（spec 5.10-12 的后半：attempts / 耗时 / 错误 / 证据）。
 *
 * 三条口径决定了它的形状：
 * ① **不二次拼装**——每一项逐字来自 `workflow_nodes` 那一行（经 `runner.state` 与其兜底口
 *    `runner.resumable`，与审计段同一份取数），证据正文复用 `NodeEvidenceSection`（2.8-04 那一口）。
 *    **参数不在这里**：点开一格时参数由 `OperatorParamForm` 那张卡摆出来（5.10-04 由描述表派生的那一套），
 *    同一件事在两处各显示一遍就是第二份事实（AGENTS.md §2.5）；
 * ② **只在点开那一刻读一次**——进度仍由 `workflow/progress` 推给画布（5.10-11），这里不起定时器、
 *    也不参与格子状态；关掉再点是唯一的重读方式，所以读数不会在用户没看的时候自己变；
 * ③ **用的是哪份读数要写出来**——内存里那次 run 与库里可续的那次是两件事，界面不替用户混着说（2.4-05 的口径），
 *    这一句与审计段共用 `NodeRunSourceLine`。
 */
import type { WorkflowNodeRunView } from '@auto-cc/shared';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NodeRunSourceLine } from './NodeRunSourceLine';
import { NodeEvidenceSection } from './WorkflowEvidence';
import { readNodeRunState, type NodeRunReading } from './runStateReading';

export interface WorkflowNodeDetailProps {
  /** 被点中的格子 id（与步骤镜像同源，不是用户输入） */
  nodeId: string;
  /** 格子的展示名，只用于标题 */
  label: string;
}

/**
 * 渲染一格的运行读数。
 * @param props 见 `WorkflowNodeDetailProps`
 * @returns attempts / 耗时 / 错误 + 证据展开段；库里没有这一行的落库读数时如实说没有
 */
export function WorkflowNodeDetail({ nodeId, label }: WorkflowNodeDetailProps) {
  const { t } = useTranslation();
  const [reading, setReading] = useState<NodeRunReading | null>(null);
  const bridge = window.autoCC;

  const read = useCallback(async () => {
    setReading(await readNodeRunState(bridge));
  }, [bridge]);

  useEffect(() => {
    void read();
  }, [read]);

  const row: WorkflowNodeRunView | undefined = reading?.state.nodes.find((node) => node.nodeId === nodeId);

  return (
    <div
      className="mt-3 rounded-xl border border-line bg-ink-950/40 p-3 text-[11px] text-slate-300"
      data-testid="canvas-node-detail"
      data-node-id={nodeId}
      data-node-source={reading?.source ?? 'none'}
    >
      <h4 className="text-xs font-semibold text-slate-300">{t('workflow.canvas.detail.heading', { label })}</h4>
      {reading ? (
        <NodeRunSourceLine reading={reading} testId="detail-source" />
      ) : (
        <p className="mt-1 text-[11px] text-slate-500" data-testid="detail-source">
          {t('workflow.canvas.detail.noRun')}
        </p>
      )}

      {row ? (
        <p
          className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1"
          data-testid="detail-run-row"
          data-node-status={row.status}
        >
          <span data-attempts={row.attempts}>{t('workflow.canvas.detail.attempts', { attempts: row.attempts })}</span>
          <span data-duration-ms={row.durationMs ?? ''}>
            {row.durationMs === null
              ? t('workflow.canvas.detail.durationPending')
              : t('workflow.canvas.detail.duration', { durationMs: row.durationMs })}
          </span>
          {row.error ? (
            <span className="text-seal" data-testid="detail-error">
              {t('workflow.canvas.detail.error', { error: row.error })}
            </span>
          ) : null}
        </p>
      ) : null}

      {reading && row?.evidenceRef ? <NodeEvidenceSection runId={reading.state.runId} nodeId={nodeId} /> : null}
    </div>
  );
}
