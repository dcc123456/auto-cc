/**
 * 对话流里的工作流运行卡（spec 5.4-07）：把 `workflow.runner` 的进度同步显示到对话侧。
 *
 * 唯一状态源是 `useWorkflowRun()`——挂载读一次 `runner.current()` 快照，之后只由
 * `workflow/progress` 事件推进。本组件不数进度、不判状态、不起第二次轮询（AGENTS.md §2.3：
 * 对话里另起一次 `runner.state()` 就是第二个状态源，2.8-12 的机检会当场红）。
 * 与工作流面板的分工：那里是操作台（开始 / 暂停 / 重试 / 展开证据），这里只是「刚沉淀出来的
 * 那条计划此刻跑到哪了」的回显，所以一格步骤行都不复制（§2.2），要复制的只有同一份读数。
 * 表头那只 `chat-workflow-mirror` 徽标仍在（1.10-08 / 2.8-12 的验收钩子，plan 02 §15.8 点名过它），
 * 它答的是「两处是不是同一个 runner」，这张卡答的是「现在第几步」——同一个源，两个问题。
 */
import { useTranslation } from 'react-i18next';
import { Workflow as WorkflowIcon } from 'lucide-react';
import type { WorkflowRunView } from '@auto-cc/shared';
import type { WorkflowLiveReading } from './useWorkflowRun';
import { displayStepNumber } from './format';

/**
 * 一张插在对话流末尾的工作流进度卡。
 * @param run 主进程给的那份 run 读数（状态、步号、格子都由它决定）
 * @param live 最近一条播报（步骤 id + 那句话）； undefined 表示这次挂载后还没有事件进来
 * @returns 对话流里的一个 `<li>`
 */
export function WorkflowRunCard({ run, live }: { run: WorkflowRunView; live?: WorkflowLiveReading }) {
  const { t } = useTranslation();
  const totalSteps = run.steps.length;
  const stepNumber = displayStepNumber(run.stepIndex, totalSteps);

  return (
    <li
      data-testid="workflow-run-card"
      data-run-id={run.runId}
      data-run-status={run.status}
      data-step-index={String(stepNumber)}
      data-total-steps={String(totalSteps)}
      className="rounded-xl border border-slate-700 bg-slate-900/80 px-3 py-2 text-[11px]"
    >
      <header className="flex items-center gap-2">
        <WorkflowIcon size={13} />
        <h3 className="text-xs font-semibold text-slate-200">{t('chat.workflowRun.heading')}</h3>
        <span
          className="ml-auto rounded-md border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400"
          data-testid="workflow-run-status"
        >
          {/* 状态字面量来自 run，句子由语言包按 `workflow.status.*` 组织——与工作流面板同一份键，两处才说得出同样的话。 */}
          {t(`workflow.status.${run.status}`)}
        </span>
      </header>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
        <span data-testid="workflow-run-progress">
          {t('chat.workflowRun.progress', { index: stepNumber, total: totalSteps })}
        </span>
        {/* 播报里的步骤 id 是主进程给的那一格（run 级迁移时为 null，这一行就不画），界面不自己挑「当前步」。 */}
        {live?.stepId ? (
          <span data-testid="workflow-run-step">
            {t('chat.workflowRun.step', { step: t(`workflow.step.${live.stepId}`, live.stepId) })}
          </span>
        ) : null}
        <span className="break-all font-mono" data-testid="workflow-run-id">
          {t('chat.workflowRun.run', { id: run.runId })}
        </span>
      </div>

      {live?.message ? (
        <p className="mt-1 text-[10px] text-slate-400" data-testid="workflow-run-live">
          {t('workflow.live', { message: live.message })}
        </p>
      ) : null}
    </li>
  );
}
