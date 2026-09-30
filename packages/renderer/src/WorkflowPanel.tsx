import { AlertCircle, Pause, Play, RefreshCw, RotateCw, ShieldAlert, Workflow as WorkflowIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BridgeReply, WorkflowRunView, WorkflowStepView } from '@auto-cc/shared';
import { useBridgeAction } from './useBridgeAction';
import { useWorkflowRun } from './useWorkflowRun';

/** 步骤行的配色按状态取，状态本身一律来自主进程返回的 `run.steps`（界面不自己判进度）。 */
const STEP_STATUS_STYLE: Record<WorkflowStepView['status'], string> = {
  pending: 'border-slate-800 text-slate-500',
  running: 'border-sky-800 bg-sky-950/40 text-sky-200',
  done: 'border-emerald-900 bg-emerald-950/30 text-emerald-300',
  failed: 'border-rose-900 bg-rose-950/40 text-rose-200',
};

/**
 * 工作流面板：`workflow.runner` 的界面镜像（spec 1.10 / 2.4-02）。
 *
 * 这里**没有**任何业务判断：槽位、状态、耗时全部来自主进程返回的 `run`（槽位数就是当前计划的
 * 节点数，换一条计划就换一批格子），进度靠 `workflow/progress` 事件推送（1.10-08）。
 * P2 换成真实的搜 JD / 生成话术 / 打招呼 / 投递时，本组件一行不用改。
 * 接管点（spec 2.1-08 / 2.4-06）也只是把 `run.requiresHuman` 这份**数据**按 `reason` 翻译成一句话：
 * 主进程不再拼中文句子，所以换语言时界面不会漏出中文硬编码。
 */
export function WorkflowPanel() {
  const { t } = useTranslation();
  const { run: current, live, refresh: read } = useWorkflowRun();
  const bridge = window.autoCC;

  const { busy, notice, run: call } = useBridgeAction(read);

  /**
   * 触发一个 runner 动作。
   *
   * 刻意**不**把接口返回值写进镜像：主进程是在 `start()` 返回之前就把 `step-started` 推出去了，
   * 所以返回值必然比已经收到的事件旧一帧，写回去会让界面闪回「全部待执行」（实测抓到过）。
   * 状态只由事件流与 `useBridgeAction` 收尾的那次重读决定。
   * @param label 动作标签（禁用态凭据 + 提示文案）
   * @param invoke 实际调用
   */
  const act = (label: string, invoke: () => Promise<BridgeReply<WorkflowRunView>> | undefined) =>
    void call(label, invoke, {
      describe: (view) => t('workflow.nowStatus', { status: t(`workflow.status.${view.status}`) }),
    });

  const status = current?.status;
  // idle（挂载后还没跑过）和 done（跑完一轮）都允许再起一次；中间态必须先暂停/重试。
  const canStart = !current || status === 'idle' || status === 'done';

  return (
    <section data-testid="workflow-panel" className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <WorkflowIcon size={16} />
          {t('workflow.heading')}
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

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-action="start"
          disabled={busy !== undefined || !canStart}
          onClick={() => act(t('workflow.actionStart'), () => bridge?.workflow['runner.start']())}
          className="flex items-center gap-1 rounded-md border border-sky-800 px-2 py-1 text-xs text-sky-300 hover:bg-sky-950 disabled:opacity-40"
        >
          <Play size={12} />
          {t('workflow.start')}
        </button>
        <button
          type="button"
          data-action="pause"
          disabled={busy !== undefined || status !== 'running'}
          onClick={() => act(t('workflow.actionPause'), () => bridge?.workflow['runner.pause']())}
          className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
        >
          <Pause size={12} />
          {t('workflow.pause')}
        </button>
        <button
          type="button"
          data-action="resume"
          disabled={busy !== undefined || status !== 'paused'}
          onClick={() => act(t('workflow.actionResume'), () => bridge?.workflow['runner.resume']())}
          className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
        >
          <Play size={12} />
          {t('workflow.resume')}
        </button>
        {current ? (
          <span className="ml-auto text-[11px] text-slate-500" data-testid="workflow-state">
            {t(`workflow.status.${current.status}`)}
            {' · '}
            <span className="break-all font-mono" data-testid="workflow-run-id">
              {current.runId}
            </span>
          </span>
        ) : null}
      </div>

      {notice && (
        <p
          className="mt-2 rounded-md border border-slate-700 bg-slate-950/70 px-3 py-2 text-[11px] text-slate-300"
          data-testid="workflow-notice"
        >
          {notice}
        </p>
      )}

      {current?.requiresHuman && (
        <div
          className="mt-2 rounded-md border border-amber-800 bg-amber-950 px-3 py-2 text-[11px] text-amber-200"
          data-testid="workflow-takeover"
          data-takeover-subject={current.requiresHuman.subject}
          data-takeover-reason={current.requiresHuman.reason}
          data-takeover-step={current.requiresHuman.stepId}
        >
          <p className="flex items-center gap-1 font-semibold">
            <ShieldAlert size={12} />
            {t('workflow.takeoverTitle')}
          </p>
          <p className="mt-1 break-all">
            {/* 接管原因有会话类与节点类两种，句子形状不同，所以按 reason 取条目而不是拼一句通用模板。 */}
            {t(`workflow.takeoverBody.${current.requiresHuman.reason}`, {
              subject: current.requiresHuman.subject,
              step: t(`workflow.step.${current.requiresHuman.stepId}`, current.requiresHuman.stepId),
            })}
          </p>
        </div>
      )}

      {live?.message && (
        <p className="mt-2 text-[11px] text-slate-400" data-testid="workflow-live">
          {t('workflow.live', { message: live.message })}
        </p>
      )}

      {current ? (
        <ul className="mt-3 flex flex-col gap-1.5" data-testid="workflow-steps">
          {current.steps.map((step, index) => (
            <li
              key={step.id}
              data-step-id={step.id}
              data-step-status={step.status}
              className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[11px] ${STEP_STATUS_STYLE[step.status]}`}
            >
              <span className="break-all">
                <span className="font-mono text-xs">{String(index + 1)}</span>
                {' · '}
                {/* 节点 id 是计划数据（外部输入）：语言包缺条目时退回显示 id 本身，而不是漏出 `workflow.step.xxx` 这种键名。 */}
                {t(`workflow.step.${step.id}`, step.id)}
                {step.error ? (
                  <span
                    className="ml-1 inline-flex items-center gap-1 break-all text-rose-300"
                    data-step-error={step.error}
                  >
                    <AlertCircle size={12} />
                    {step.error}
                  </span>
                ) : null}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {step.durationMs !== null ? (
                  <span data-step-duration={String(step.durationMs)}>
                    {t('workflow.duration', { ms: step.durationMs })}
                  </span>
                ) : null}
                <span>{t(`workflow.stepStatus.${step.status}`)}</span>
                {/* 两种「停在这一步」都要能从这一步出去：普通失败，以及挂着接管点的暂停
                    （spec 2.4-06 的未观察外发只有从这里走，否则用户在界面上只剩重新开跑一条路）。 */}
                {step.status === 'failed' || current.requiresHuman?.stepId === step.id ? (
                  <button
                    type="button"
                    data-action="retry"
                    data-step={step.id}
                    disabled={busy !== undefined}
                    onClick={() =>
                      act(t('workflow.actionRetry', { step: t(`workflow.step.${step.id}`, step.id) }), () =>
                        bridge?.workflow['runner.retryStep'](step.id),
                      )
                    }
                    className="flex items-center gap-1 rounded-md border border-rose-800 px-2 py-0.5 text-rose-200 hover:bg-rose-950 disabled:opacity-40"
                  >
                    <RotateCw size={12} />
                    {t('workflow.retry')}
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-[11px] text-slate-500" data-testid="workflow-loading">
          {t('workflow.loading')}
        </p>
      )}
    </section>
  );
}
