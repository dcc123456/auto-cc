import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, DatabaseBackup, Pause, Play, RefreshCw, Workflow } from 'lucide-react';
import type { WorkflowNodeRunView, WorkflowNodeSpec, WorkflowRunStateView } from '@auto-cc/shared';
import { displayStepNumber } from './format';
import { useBridgeAction } from './useBridgeAction';
import { useWorkflowRun } from './useWorkflowRun';

/** 节点行配色按落库状态取；`skipped` 是幂等闸门判「这个目标已经做过」的结果，不是失败。 */
const NODE_STATUS_STYLE: Record<WorkflowNodeRunView['status'], string> = {
  pending: 'border-slate-800 text-slate-500',
  running: 'border-sky-800 bg-sky-950/40 text-sky-200',
  done: 'border-emerald-900 bg-emerald-950/30 text-emerald-300',
  failed: 'border-rose-900 bg-rose-950/40 text-rose-200',
  skipped: 'border-slate-700 bg-slate-900 text-slate-400',
};

/**
 * 一次 run 里已经发生的重试次数（spec 2.4-03 的界面读数）。
 * @param nodes 落库的逐节点读数；没跑过的节点 `attempts` 是 0
 * @returns Σ(尝试次数 − 1)，即「除首次之外的尝试」总数，0 表示一次都没重试过
 */
const retriedTimes = (nodes: WorkflowNodeRunView[]): number =>
  nodes.reduce((sum, node) => sum + Math.max(0, node.attempts - 1), 0);

/**
 * 工作流执行器实验台：`workflow.runner` 的**落库真相**视图（spec 2.4-02 / 04 / 05 的截图靶子）。
 *
 * 与第二视图的 `WorkflowPanel` 不是两套逻辑：那里画的是内存镜像的槽位（随事件推），这里画的是
 * `workflow_runs` / `workflow_nodes` 两张表里的行——重试次数、证据相对路径、以及进程被 kill 之后
 * 库里那次可续的 run。两个面板都只调同一个 `workflow.runner`，界面里没有任何进度判断（AGENTS.md §5.9）。
 *
 * 重读时机是 `workflow/progress` 事件而不是轮询：每个节点的状态都在推进库里那一行之后才播报，
 * 所以事件到达时读库必然看得到刚写进去的那一行。
 */
export function WorkflowLabPanel() {
  const { t } = useTranslation();
  const { run: mirror, live } = useWorkflowRun();
  const [state, setState] = useState<WorkflowRunStateView>();
  /** 库里那次可续的 run（进程重启后 `state` 还没有行，界面靠它显示「上次中断在第 i 个节点」）。 */
  const [resumable, setResumable] = useState<WorkflowRunStateView>();
  const [planNodes, setPlanNodes] = useState<WorkflowNodeSpec[]>();
  const bridge = window.autoCC;

  const read = useCallback(async () => {
    const [stateReply, resumableReply, nodesReply] = await Promise.all([
      bridge?.workflow['runner.state'](),
      bridge?.workflow['runner.resumable'](),
      bridge?.workflow['runner.nodes'](),
    ]);
    if (stateReply?.ok) setState(stateReply.value ?? undefined);
    if (resumableReply?.ok) setResumable(resumableReply.value ?? undefined);
    if (nodesReply?.ok) setPlanNodes(nodesReply.value);
  }, [bridge]);

  const { busy, notice, run: call } = useBridgeAction(read);

  useEffect(() => {
    void read();
  }, [read]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.on('workflow/progress', () => {
      void read();
    });
  }, [bridge, read]);

  /** 画的是哪一次 run：优先内存这次已落库的行，否则是库里那次可续的（已被判成中断/失败/暂停）。 */
  const shown = state ?? resumable;
  /** 界面显示的「第 i 个」：游标在跑完时等于节点数（越界一位），夹法与对话侧的运行卡同源（`format.ts`）。 */
  const currentNode = shown ? displayStepNumber(shown.nodeIndex, shown.totalNodes) : 0;

  return (
    <div className="flex flex-col gap-4" data-testid="workflow-lab">
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <Workflow size={16} />
            {t('workflow.lab.heading')}
          </h2>
          <button
            type="button"
            data-action="refresh"
            onClick={() => void read()}
            className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            <RefreshCw size={14} />
            {t('workflow.refresh')}
          </button>
        </div>

        <p className="mt-2 text-[11px] text-slate-500" data-testid="wf-lab-plan">
          {t('workflow.lab.planNodes', {
            count: planNodes?.length ?? 0,
            chain: (planNodes ?? []).map((node) => node.kind).join(' → '),
          })}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-action="run-once"
            disabled={busy !== undefined}
            onClick={() =>
              void call(t('workflow.lab.actionRunOnce'), () => bridge?.workflow['runner.start'](), {
                describe: (view) => t('workflow.nowStatus', { status: t(`workflow.status.${view.status}`) }),
              })
            }
            className="flex items-center gap-1 rounded-md border border-sky-800 px-2 py-1 text-[11px] text-sky-300 hover:bg-sky-950 disabled:opacity-40"
          >
            <Play size={12} />
            {t('workflow.lab.runOnce')}
          </button>
          <button
            type="button"
            data-action="pause"
            disabled={busy !== undefined || mirror?.status !== 'running'}
            onClick={() =>
              void call(t('workflow.actionPause'), () => bridge?.workflow['runner.pause'](), {
                describe: (view) => t('workflow.nowStatus', { status: t(`workflow.status.${view.status}`) }),
              })
            }
            className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            <Pause size={12} />
            {t('workflow.pause')}
          </button>
          {/* 动作名带 `workflow` 前缀：本视图在 `App.tsx` 里是用 CSS `hidden` 藏起来的常驻分支，
              与对话页的 `resume-run`（agent 循环续跑）同名时，一条 `[data-action="resume-run"]` 选择器
              会在 DOM 里同时命中两颗（5.7-d 实测踩过）。
              禁用判据取 `shown`（屏上有这次 run）而不是 `resumable`：5.10-07 要的是界面上**说出**
              「旧 run 不能续」那句原因，而那句原话只有服务侧知道（它比的指纹在库里）。
              在界面里比一次指纹再编一句文案就是第二份事实（§2.5），所以这里让按钮可点、
              把 `runner.resumeRun()` 的拒因原样落到提示行。 */}
          <button
            type="button"
            data-action="resume-workflow-run"
            disabled={busy !== undefined || !shown}
            onClick={() =>
              void call(t('workflow.lab.actionResumeRun'), () => bridge?.workflow['runner.resumeRun'](), {
                describe: (view) => t('workflow.nowStatus', { status: t(`workflow.status.${view.status}`) }),
              })
            }
            className="flex items-center gap-1 rounded-md border border-emerald-800 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-950 disabled:opacity-40"
          >
            <DatabaseBackup size={12} />
            {t('workflow.lab.resumeRun')}
          </button>
        </div>

        {notice && (
          <p
            className="mt-2 rounded-md border border-slate-700 bg-slate-950/70 px-3 py-2 text-[11px] text-slate-300"
            data-testid="wf-lab-notice"
          >
            {notice}
          </p>
        )}
        {live?.message && (
          <p className="mt-2 text-[11px] text-slate-400" data-testid="wf-lab-live">
            {t('workflow.live', { message: live.message })}
          </p>
        )}
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="text-xs font-semibold text-slate-300">{t('workflow.lab.storeHeading')}</h3>
        {!shown ? (
          <p className="mt-1 text-[11px] text-slate-500" data-testid="wf-lab-store-idle">
            {t('workflow.lab.storeIdle')}
          </p>
        ) : (
          <div className="mt-1 flex flex-col gap-1.5">
            <p
              className="text-[11px] text-slate-300"
              data-testid="wf-lab-progress"
              data-run-status={shown.status}
              data-node-index={String(shown.nodeIndex)}
              data-total-nodes={String(shown.totalNodes)}
              data-retried={String(retriedTimes(shown.nodes))}
            >
              {t('workflow.lab.progress', {
                index: currentNode,
                total: shown.totalNodes,
                retries: retriedTimes(shown.nodes),
                status: t(`workflow.status.${shown.status}`),
              })}
            </p>
            <p className="break-all text-[11px] text-slate-500" data-testid="wf-lab-run-id">
              {t('workflow.lab.runRow', {
                planId: shown.planId,
                runId: shown.runId,
                fingerprint: shown.planFingerprint,
              })}
            </p>
            {shown.lastError && (
              <p className="break-all text-[11px] text-rose-300" data-testid="wf-lab-last-error">
                <span className="inline-flex items-center gap-1">
                  <AlertCircle size={12} />
                  {shown.lastError}
                </span>
              </p>
            )}
            <ul className="flex flex-col gap-1" data-testid="wf-lab-nodes">
              {shown.nodes.map((node) => (
                <li
                  key={`${node.nodeId}-${String(node.index)}`}
                  data-node-id={node.nodeId}
                  data-node-status={node.status}
                  data-node-attempts={String(node.attempts)}
                  data-node-evidence={node.evidenceRef ?? ''}
                  className={`flex flex-col gap-0.5 rounded-lg border px-3 py-1.5 text-[11px] ${NODE_STATUS_STYLE[node.status]}`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="break-all">
                      <span className="font-mono text-xs">{String(node.index + 1)}</span>
                      {' · '}
                      {/* 节点 id 是计划数据：语言包缺条目时退回 id 本身，不漏出键名。 */}
                      {t(`workflow.step.${node.nodeId}`, node.nodeId)}
                      {' · '}
                      <span className="font-mono">{node.kind}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span>{t(`workflow.stepStatus.${node.status}`)}</span>
                      {node.attempts > 0
                        ? t('workflow.lab.attempts', { num: node.attempts, retries: node.attempts - 1 })
                        : null}
                      {node.durationMs !== null ? t('workflow.duration', { ms: node.durationMs }) : null}
                    </span>
                  </span>
                  {node.error && (
                    <span className="break-all text-rose-300" data-node-error={node.error}>
                      {node.error}
                    </span>
                  )}
                  {node.evidenceRef && (
                    <span className="break-all text-slate-400">
                      {t('workflow.lab.evidence', { ref: node.evidenceRef })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
