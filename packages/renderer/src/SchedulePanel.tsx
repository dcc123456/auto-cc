/**
 * 定时任务一节（spec 5.7-05 的"已保存工作流可建定时任务，任务列表可见启停" + 5.7-09 的"已跳过"标记）。
 *
 * 挂在**工作流视图**里、紧跟计划库：一条定时任务的定义就是"这条已保存计划 + 这个时刻"，
 * 拆到诊断视图去就要跨面板对计划名，而 §5.9 要求两个入口看到的是同一份事实。
 * 三张读数（任务、计划、触发记录）**每次现读**，界面不缓存第二份（§9 的 2.5 实测：
 * 热改配置会重建下游服务，本地存一份就静默变空）；计划下拉复用既有的 `workflow.runner.plans`，
 * 不为调度另开一条读计划的口（§2.1）。
 * cron 表达式在这里**只做填写**：能不能成立、下一个点是什么时候，一律由主进程求值后回读，
 * 界面不自己算第二遍（§2.5），于是"这条表达式永远不会跑"那句拒因原话能直接留在提示行里当证据。
 */
import { Ban, CalendarClock, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ScheduleJobView, ScheduleTriggerView, WorkflowPlanOptionView } from '@auto-cc/shared';
import { formatClock } from './format';
import { useBridgeAction } from './useBridgeAction';
import { Banner, DeskButton, DeskField, DeskSelect } from './ui/controls';

/** 快捷档位 → cron 表达式（5.7-05 判据原文的"每日 / 工作日 / 自定义"三种）。 */
const PRESET_EXPRESSIONS = {
  daily: '0 9 * * *',
  weekdays: '0 9 * * 1-5',
  custom: '',
} as const;

type PresetKey = keyof typeof PRESET_EXPRESSIONS;

/** 触发结局 → 语言包 key（`skipped` 就是 5.7-09 那句"已跳过"）。 */
const RESULT_KEYS: Record<ScheduleTriggerView['result'], string> = {
  started: 'schedule.resultStarted',
  skipped: 'schedule.resultSkipped',
  failed: 'schedule.resultFailed',
};

/** 手工"跑一次"之后的读数文案，同样按结局分三条（不拼 key：`t(\`schedule.${x}\`)` 让机检查不到这条文案）。 */
const RESULT_NOTICES: Record<ScheduleTriggerView['result'], string> = {
  started: 'schedule.startedNotice',
  skipped: 'schedule.skippedNotice',
  failed: 'schedule.failedNotice',
};

/**
 * 定时任务区块。
 * @returns 画在工作流面板里的「定时任务」一节
 */
export function ScheduleSection() {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<ScheduleJobView[]>([]);
  const [triggers, setTriggers] = useState<ScheduleTriggerView[]>([]);
  const [plans, setPlans] = useState<WorkflowPlanOptionView[]>([]);
  const [preset, setPreset] = useState<PresetKey>('daily');
  const [name, setName] = useState('');
  const [planId, setPlanId] = useState('');
  const [expression, setExpression] = useState<string>(PRESET_EXPRESSIONS.daily);
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const bridge = window.autoCC;

  const read = useCallback(async () => {
    if (!bridge) return;
    const [jobReply, triggerReply, planReply] = await Promise.all([
      bridge.schedule['registry.jobs'](),
      bridge.schedule['registry.triggers'](undefined, 30),
      bridge.workflow['runner.plans'](),
    ]);
    if (jobReply.ok) setJobs(jobReply.value);
    if (triggerReply.ok) setTriggers(triggerReply.value);
    if (planReply.ok) setPlans(planReply.value);
  }, [bridge]);

  const { busy, notice, noticeTone, run: call } = useBridgeAction(read);
  /**
   * 归属色照流程屏那一条规则（plan §5 / §8.3）：`trigger-now` 让这条会外发的流程**立刻**动一次 → `seal`；
   * 新建任务、启停开关都只往本机的调度表里写 → `amber`；刷新只读 → `line`；
   * 删除的**入口**不涂朱砂（它只是把这一行换成确认态），落刀的是「确认删除」。
   */
  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;
  const reasonLabel = (code?: string): string | undefined =>
    code === undefined ? undefined : t(`schedule.reason.${code}`);
  const createReason =
    busyReason ??
    (name.trim().length === 0
      ? 'NAME_EMPTY'
      : planId === ''
        ? 'PLAN_MISSING'
        : expression.trim().length === 0
          ? 'EXPRESSION_EMPTY'
          : undefined);

  useEffect(() => {
    void read();
  }, [read]);

  /**
   * 换档位时把表达式填进输入框，但仍然让人可改。
   *
   * 不做成"选了就锁死"：判据里的"自定义"要能从这三个快捷值出发改一个字符（`0 9 * * 1-5` → `0 18 * * 1-5`），
   * 而不是另开一个输入口。
   * @param next 档位
   */
  const applyPreset = (next: PresetKey): void => {
    setPreset(next);
    if (PRESET_EXPRESSIONS[next] !== '') setExpression(PRESET_EXPRESSIONS[next]);
  };

  /**
   * 一条任务最近的触发读数（列表里那一行下面的小字）。
   * @param jobId 任务 id
   * @returns 按时刻倒序的最多两条
   */
  const recentTriggers = (jobId: string): ScheduleTriggerView[] =>
    triggers
      .filter((trigger) => trigger.jobId === jobId)
      .sort((left, right) => right.plannedAt - left.plannedAt)
      .slice(0, 2);

  /**
   * 计划 id → 界面上要显示的计划名（内置目录与沉淀出来的都在 `workflow.runner.plans` 那份读数里）。
   * @param id 任务引用的计划 id
   * @returns 计划名；计划已被删除时给出"未知计划"而不是空白——那正是这条任务下次会失败的原因
   */
  const planName = (id: string): string => plans.find((plan) => plan.id === id)?.name ?? t('schedule.planMissing');

  return (
    <div className="mt-3 rounded-lg border border-line bg-ink-950/40 px-3 py-2" data-testid="schedule-panel">
      <h3 className="flex items-center gap-2 text-xs font-semibold text-slate-300">
        <CalendarClock size={13} />
        {t('schedule.heading')}
      </h3>
      <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{t('schedule.hint')}</p>

      <div className="mt-2 flex flex-wrap items-end gap-2" data-testid="schedule-create">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-slate-400">{t('schedule.nameLabel')}</span>
          <DeskField
            action="schedule-name"
            data-testid="schedule-name-input"
            value={name}
            onValueChange={setName}
            placeholder={t('schedule.namePlaceholder')}
            className="min-w-32"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-slate-400">{t('schedule.planLabel')}</span>
          <DeskSelect
            action="schedule-plan"
            data-testid="schedule-plan-select"
            value={planId}
            onValueChange={setPlanId}
          >
            <option value="">{t('schedule.planDefault')}</option>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {/* 计划名的写法复用计划库那一条（§2.1）：同一份计划在两个下拉里长得不一样，就会被当成两件事 */}
                {t('workflow.plans.option', {
                  name: plan.name,
                  source: t(plan.source === 'custom' ? 'workflow.plans.sourceCustom' : 'workflow.plans.sourceBuiltin'),
                  count: plan.nodeCount,
                })}
              </option>
            ))}
          </DeskSelect>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-slate-400">{t('schedule.presetLabel')}</span>
          <DeskSelect
            action="schedule-preset"
            data-testid="schedule-preset-select"
            value={preset}
            onValueChange={(value) => applyPreset(value as PresetKey)}
          >
            <option value="daily">{t('schedule.presetDaily')}</option>
            <option value="weekdays">{t('schedule.presetWeekdays')}</option>
            <option value="custom">{t('schedule.presetCustom')}</option>
          </DeskSelect>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-slate-400">{t('schedule.expressionLabel')}</span>
          <DeskField
            action="schedule-expression"
            data-testid="schedule-expression-input"
            data-schedule-preset={preset}
            value={expression}
            onValueChange={(value) => {
              setExpression(value);
              setPreset('custom');
            }}
            className="min-w-28 font-mono"
          />
        </label>
        <DeskButton
          action="schedule-create"
          variant="amber"
          compact
          busy={!!busy}
          disabled={createReason !== undefined}
          disabledReason={createReason}
          disabledReasonLabel={reasonLabel(createReason)}
          onClick={() =>
            void call(
              t('schedule.actionCreate', { name: name.trim(), expression: expression.trim() }),
              () =>
                bridge?.schedule['registry.createJob']({ name: name.trim(), planId, expression: expression.trim() }),
              {
                describe: (job) =>
                  t('schedule.created', { name: job.name, next: formatClock(job.nextRunAt, t('schedule.none')) }),
              },
            ).then(() => {
              setName('');
            })
          }
        >
          <Plus size={11} />
          {t('schedule.createButton')}
        </DeskButton>
        <DeskButton
          action="schedule-refresh"
          variant="line"
          compact
          busy={!!busy}
          disabled={busyReason !== undefined}
          disabledReason={busyReason}
          disabledReasonLabel={reasonLabel(busyReason)}
          onClick={() => void read()}
        >
          <RefreshCw size={11} />
          {t('schedule.refresh')}
        </DeskButton>
      </div>

      {jobs.length === 0 ? (
        <p className="mt-2 text-[10px] text-slate-500" data-testid="schedule-empty">
          {t('schedule.empty')}
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1" data-testid="schedule-jobs-list">
          {jobs.map((job) => {
            const history = recentTriggers(job.id);
            return (
              <li
                key={job.id}
                data-job-id={job.id}
                data-job-enabled={job.isEnabled ? 'true' : 'false'}
                className="flex flex-col gap-1 rounded-md border border-line px-2 py-1 text-[11px]"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="break-all text-slate-200">{job.name}</span>
                  <span className="text-slate-500">{planName(job.planId)}</span>
                  <span className="font-mono text-slate-500">{job.expression}</span>
                  <span className={job.isEnabled ? 'text-jade' : 'text-slate-500'} data-job-next={job.nextRunAt ?? ''}>
                    {job.isEnabled
                      ? t('schedule.nextRun', { when: formatClock(job.nextRunAt, t('schedule.none')) })
                      : t('schedule.disabled')}
                  </span>
                  <span className="ml-auto flex items-center gap-1">
                    <DeskButton
                      action="schedule-trigger-now"
                      markers={{ 'job-id': job.id }}
                      variant="seal"
                      compact
                      busy={!!busy}
                      disabled={busyReason !== undefined}
                      disabledReason={busyReason}
                      disabledReasonLabel={reasonLabel(busyReason)}
                      onClick={() =>
                        void call(
                          t('schedule.actionTriggerNow', { name: job.name }),
                          () => bridge?.schedule['registry.triggerNow'](job.id),
                          { describe: (view) => t(RESULT_NOTICES[view.result], { reason: view.reason ?? '' }) },
                        )
                      }
                    >
                      <Play size={10} />
                      {t('schedule.triggerNow')}
                    </DeskButton>
                    <DeskButton
                      action="schedule-toggle"
                      markers={{ 'job-id': job.id }}
                      variant="amber"
                      compact
                      busy={!!busy}
                      disabled={busyReason !== undefined}
                      disabledReason={busyReason}
                      disabledReasonLabel={reasonLabel(busyReason)}
                      onClick={() =>
                        void call(
                          job.isEnabled
                            ? t('schedule.actionDisable', { name: job.name })
                            : t('schedule.actionEnable', { name: job.name }),
                          () => bridge?.schedule['registry.setEnabled'](job.id, !job.isEnabled),
                          {
                            describe: (view) =>
                              view.isEnabled
                                ? t('schedule.enabled', { next: formatClock(view.nextRunAt, t('schedule.none')) })
                                : t('schedule.disabledNotice', { name: view.name }),
                          },
                        )
                      }
                    >
                      <Ban size={10} />
                      {job.isEnabled ? t('schedule.disable') : t('schedule.enable')}
                    </DeskButton>
                    <DeskButton
                      action="schedule-remove"
                      markers={{ 'job-id': job.id }}
                      variant="line"
                      compact
                      busy={!!busy}
                      disabled={busyReason !== undefined}
                      disabledReason={busyReason}
                      disabledReasonLabel={reasonLabel(busyReason)}
                      onClick={() => setConfirmRemove(job.id)}
                    >
                      <Trash2 size={10} />
                      {t('schedule.remove')}
                    </DeskButton>
                  </span>
                </span>

                {confirmRemove === job.id ? (
                  <span className="flex flex-wrap items-center gap-1" data-testid="schedule-remove-confirm">
                    <span className="break-all text-amber">{t('schedule.confirmRemove', { name: job.name })}</span>
                    <DeskButton
                      action="schedule-remove-confirm"
                      markers={{ 'job-id': job.id }}
                      variant="seal"
                      compact
                      busy={!!busy}
                      disabled={busyReason !== undefined}
                      disabledReason={busyReason}
                      disabledReasonLabel={reasonLabel(busyReason)}
                      onClick={() =>
                        void call(
                          t('schedule.actionRemove', { name: job.name }),
                          () => bridge?.schedule['registry.removeJob'](job.id),
                          { describe: () => t('schedule.removed', { name: job.name }) },
                        ).then(() => setConfirmRemove(undefined))
                      }
                    >
                      {t('schedule.confirmButton')}
                    </DeskButton>
                    <DeskButton
                      action="schedule-remove-cancel"
                      variant="ghost"
                      compact
                      onClick={() => setConfirmRemove(undefined)}
                    >
                      {t('schedule.cancel')}
                    </DeskButton>
                  </span>
                ) : null}

                {history.length === 0 ? (
                  <span className="text-[10px] text-slate-600" data-testid="schedule-no-trigger">
                    {t('schedule.noTrigger')}
                  </span>
                ) : (
                  <ul className="flex flex-col gap-0.5" data-testid="schedule-triggers">
                    {history.map((trigger) => (
                      <li
                        key={trigger.id}
                        data-trigger-id={trigger.id}
                        data-trigger-result={trigger.result}
                        data-trigger-planned-at={trigger.plannedAt}
                        className="flex flex-wrap items-center gap-2 text-[10px]"
                      >
                        <span
                          className={
                            trigger.result === 'started'
                              ? 'text-jade'
                              : trigger.result === 'skipped'
                                ? 'text-amber'
                                : 'text-seal'
                          }
                        >
                          {t(RESULT_KEYS[trigger.result])}
                        </span>
                        <span className="text-slate-500">
                          {t('schedule.plannedAt', { when: formatClock(trigger.plannedAt, t('schedule.none')) })}
                        </span>
                        <span className="text-slate-500">
                          {t('schedule.firedAt', { when: formatClock(trigger.firedAt, t('schedule.neverFired')) })}
                        </span>
                        {trigger.workflowRunId ? (
                          <span
                            className="break-all font-mono text-slate-600"
                            data-trigger-run-id={trigger.workflowRunId}
                          >
                            {t('schedule.runId', { id: trigger.workflowRunId })}
                          </span>
                        ) : null}
                        {trigger.reason ? (
                          <span className="break-all text-slate-400" data-trigger-reason={trigger.reason}>
                            {trigger.reason}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {notice ? (
        <Banner tone={noticeTone} size="compact" markers={{ testid: 'schedule-notice' }} className="mt-2 break-all">
          {notice}
        </Banner>
      ) : null}
    </div>
  );
}
