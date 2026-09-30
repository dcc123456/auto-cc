/**
 * 审计回看段：把「做过什么」两份既有事实并置到同一屏（spec 2.7-05）。
 *
 * **不是第三套存储**（plan §14.3 第 5 条）：上半段逐字转述 `usage_ledger`（时间 / 动作 / 目标 / 来源），
 * 下半段逐字转述 `workflow_nodes`（节点状态 / 尝试次数 / 错误 / 证据路径）。两边各自注明事实源，
 * 也不伪造统一时间线——账本行只证明「这一下成功了」（1.9 决策 1：失败不记账，写了就是假用量），
 * 节点行才带着失败与待接管那半张脸。
 *
 * 节点行的读数取 `workflow['runner.state']()`，读不到（本次进程还没跑过 run）时才回落到
 * `['runner.resumable']()` 的那条库里可续 run，并把用的是哪一份写在段首——
 * 界面因此不会把「上次中断的那个 run」说成「这次跑的」。
 */
import { ScanLine } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UsageSummaryView, WorkflowRunStateView } from '@auto-cc/shared';
import { formatClock } from './format';

/** 账本侧一次列多少行：用量面板那 5 行是给「今天用了多少」看的，这里要给「都干了什么」看。 */
const AUDIT_LEDGER_LIMIT = 20;

/** 节点行的事实源（写进界面，不让用户猜这段读的是内存还是库）。 */
type NodeSource = 'state' | 'resumable';

/**
 * 取节点行的两份读数，并按「内存优先、库里兜底」选一份。
 * @param bridge 渲染层桥接（纯浏览器调试态下可以是 undefined）
 * @returns 选中的 run 状态 + 它来自哪份读数；两份都读不到时为 null
 */
async function readRunState(
  bridge: Window['autoCC'],
): Promise<{ state: WorkflowRunStateView; source: NodeSource } | null> {
  const [stateReply, resumableReply] = await Promise.all([
    bridge?.workflow['runner.state'](),
    bridge?.workflow['runner.resumable'](),
  ]);
  if (stateReply?.ok && stateReply.value) return { state: stateReply.value, source: 'state' };
  if (resumableReply?.ok && resumableReply.value) return { state: resumableReply.value, source: 'resumable' };
  return null;
}

/**
 * 审计回看段（挂在用量面板下方，同页不同段，不新开视图）。
 */
export function AuditSection() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<UsageSummaryView>();
  const [run, setRun] = useState<{ state: WorkflowRunStateView; source: NodeSource } | null>(null);
  const bridge = window.autoCC;

  const read = useCallback(async () => {
    const [summaryReply, runReading] = await Promise.all([
      bridge?.usage['ledger.summary'](AUDIT_LEDGER_LIMIT),
      readRunState(bridge),
    ]);
    if (summaryReply?.ok) setSummary(summaryReply.value);
    setRun(runReading);
  }, [bridge]);

  useEffect(() => {
    void read();
  }, [read]);

  return (
    <div className="mt-4 border-t border-slate-800 pt-3" data-testid="audit-section">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-slate-300">
          <ScanLine size={14} />
          {t('audit.heading')}
        </h3>
        <button
          type="button"
          data-action="audit-refresh"
          onClick={() => void read()}
          className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
        >
          <ScanLine size={12} />
          {t('audit.refresh')}
        </button>
      </div>

      <h4 className="mt-2 text-[11px] font-semibold text-slate-400">
        {t('audit.ledgerHeading', { count: summary?.total ?? 0 })}
      </h4>
      <p className="text-[11px] text-slate-500" data-testid="audit-ledger-source">
        {t('audit.sourceLedger')} · {t('audit.ledgerRule')}
      </p>
      {(summary?.byAction.length ?? 0) > 0 ? (
        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400" data-testid="audit-by-action">
          {summary?.byAction.map((item) => (
            <li key={item.action} data-audit-action={item.action}>
              {t('audit.actionCount', { action: item.action, count: item.count })}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[11px] text-slate-500" data-testid="audit-by-action-empty">
          {t('audit.empty')}
        </p>
      )}

      {(summary?.recent.length ?? 0) > 0 ? (
        <ul className="mt-2 flex flex-col gap-0.5" data-testid="audit-rows">
          {summary?.recent.map((row) => (
            <li
              key={String(row.id)}
              className="break-all text-[11px] text-slate-400"
              data-audit-ledger-id={String(row.id)}
              data-audit-action-name={row.action}
            >
              {t('audit.ledgerRow', {
                time: formatClock(row.ts, t('audit.none')),
                action: row.action,
                target: row.targetId ?? t('audit.none'),
                result: t('audit.resultStored'),
                source: row.source ?? t('audit.none'),
                run: row.workflowRunId ?? t('audit.none'),
              })}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[11px] text-slate-500" data-testid="audit-rows-empty">
          {t('audit.empty')}
        </p>
      )}

      <h4 className="mt-3 text-[11px] font-semibold text-slate-400">{t('audit.nodesHeading')}</h4>
      {!run ? (
        <p className="mt-1 text-[11px] text-slate-500" data-testid="audit-nodes-idle">
          {t('audit.nodesIdle')}
        </p>
      ) : (
        <>
          <p className="text-[11px] text-slate-500" data-testid="audit-nodes-source" data-node-source={run.source}>
            {t('audit.sourceNodes')} ·{' '}
            {t(run.source === 'state' ? 'audit.nodesFromState' : 'audit.nodesFromResumable', {
              runId: run.state.runId,
              status: t(`audit.runStatus.${run.state.status}`),
            })}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5" data-testid="audit-node-rows">
            {run.state.nodes.map((node) => (
              <li
                key={`${run.state.runId}-${String(node.index)}`}
                className="break-all text-[11px] text-slate-400"
                data-node-index={node.index}
                data-node-status={node.status}
              >
                {t('audit.nodeRow', {
                  index: node.index,
                  kind: node.kind,
                  status: t(`audit.nodeStatus.${node.status}`),
                  attempts: node.attempts,
                  error: node.error ?? t('audit.none'),
                })}
                {node.evidenceRef && (
                  <span className="text-slate-500"> · {t('audit.nodeEvidence', { ref: node.evidenceRef })}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
