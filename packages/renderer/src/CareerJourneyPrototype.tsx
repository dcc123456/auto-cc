import {
  ArrowRight,
  Briefcase,
  CalendarCheck,
  Check,
  FileText,
  History,
  ListChecks,
  LoaderCircle,
  RotateCcw,
  Route,
  X,
} from 'lucide-react';
import { useReducer, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  careerJourneyReducer,
  INITIAL_JOURNEY_STATE,
  JOURNEY_STEPS,
  SAMPLE_FACT_IDS,
  SAMPLE_JOBS,
  samplePreparationForJob,
  selectedSampleJob,
} from './career-journey-prototype';
import { Banner, DeskButton, DeskSelect, Tag } from './ui/controls';
import { advanceViewTrail, type TopView } from './viewTrail';

/** 状态演示只改变展示层，不写 reducer 的样例业务事实。 */
const JOURNEY_SCENARIOS = ['normal', 'empty', 'loading', 'failed', 'risk', 'paused', 'recovered'] as const;
type JourneyScenario = (typeof JOURNEY_SCENARIOS)[number];

/** 状态语气与既有 Banner 四档一致，不新增颜色语义。 */
const SCENARIO_TONE = {
  empty: 'celadon',
  loading: 'celadon',
  failed: 'seal',
  risk: 'seal',
  paused: 'amber',
  recovered: 'jade',
} as const;

/** 版本条一格：空值由调用方翻成明确的未生成，不显示上一岗位的残留。 */
function ContextCell({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-ink-900/70 px-3 py-2" data-testid={testId}>
      <p className="text-[10px] text-slate-500">{label}</p>
      <p className="mt-1 break-all font-mono text-[11px] text-slate-200" data-context-value={value}>
        {value}
      </p>
    </div>
  );
}

/** 证据 ID 使用等宽小签，既可读也可由 DOM 逐条断言。 */
function SourceList({ ids }: { ids: readonly string[] }) {
  return (
    <span className="flex flex-wrap gap-1" data-testid="journey-source-list">
      {ids.map((id) => (
        <code key={id} className="rounded border border-line bg-ink-900 px-1.5 py-0.5 text-[10px] text-slate-300">
          {id}
        </code>
      ))}
    </span>
  );
}

interface StatePreviewProps {
  scenario: JourneyScenario;
  onScenarioChange: (scenario: JourneyScenario) => void;
  onRecover: () => void;
}

/** 七类状态的可操作演示：风控/暂停同时给出禁用原因和显式对账恢复入口。 */
function StatePreview({ scenario, onScenarioChange, onRecover }: StatePreviewProps) {
  const { t } = useTranslation();
  const blockedReason = scenario === 'risk' ? 'RISK_CONTROL_PAUSED' : scenario === 'paused' ? 'RUN_PAUSED' : undefined;
  const failureReason = scenario === 'failed' ? 'SAMPLE_READ_FAILED' : undefined;
  return (
    <div className="flex flex-col gap-2" data-testid="journey-state-preview" data-state={scenario}>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[11px] text-slate-400" htmlFor="journey-scenario">
          {t('journey.states.label')}
        </label>
        <DeskSelect
          action="journey-scenario"
          id="journey-scenario"
          aria-label={t('journey.states.label')}
          value={scenario}
          onValueChange={(value) => onScenarioChange(value as JourneyScenario)}
        >
          {JOURNEY_SCENARIOS.map((item) => (
            <option key={item} value={item}>
              {t(`journey.states.${item}`)}
            </option>
          ))}
        </DeskSelect>
        {scenario === 'normal' ? <Tag tone="celadon">{t('journey.states.normalHint')}</Tag> : null}
      </div>
      {scenario !== 'normal' ? (
        <Banner
          tone={SCENARIO_TONE[scenario]}
          size="compact"
          reason={blockedReason ?? failureReason}
          markers={{ scenario }}
          actions={
            <div className="flex flex-wrap gap-1">
              {blockedReason ? (
                <DeskButton
                  action="journey-blocked-action"
                  variant="seal"
                  compact
                  disabled
                  disabledReason={blockedReason}
                  disabledReasonLabel={t(`journey.states.reason.${blockedReason}`)}
                >
                  {t('journey.states.continueOutbound')}
                </DeskButton>
              ) : null}
              {scenario === 'loading' ? (
                <DeskButton
                  action="journey-loading-action"
                  compact
                  disabled
                  disabledReason="ACTION_IN_PROGRESS"
                  disabledReasonLabel={t('journey.states.reason.ACTION_IN_PROGRESS')}
                >
                  <LoaderCircle size={11} className="animate-spin" />
                  {t('journey.states.loadingAction')}
                </DeskButton>
              ) : null}
              {scenario === 'failed' || blockedReason ? (
                <DeskButton action="journey-recover" variant="jade" compact onClick={onRecover}>
                  <RotateCcw size={11} />
                  {t('journey.states.recoverAction')}
                </DeskButton>
              ) : null}
            </div>
          }
        >
          {t(`journey.states.${scenario}Hint`)}
        </Banner>
      ) : null}
    </div>
  );
}

interface CareerJourneyPrototypeProps {
  visible: boolean;
  onClose: () => void;
}

/**
 * 对话内的六步本地样例原型。组件只消费 reducer 与语言包，不触达真实服务。
 * @param visible 是否显示；隐藏仅改 display，状态与对话滚动位置都保留
 * @param onClose 返回对话消息流的回调
 * @returns 带版本条、六步内容、状态演示和非正式操作记录的主链工作区
 */
export function CareerJourneyPrototype({ visible, onClose }: CareerJourneyPrototypeProps) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(careerJourneyReducer, INITIAL_JOURNEY_STATE);
  const [scenario, setScenario] = useState<JourneyScenario>('normal');
  const selectedJob = selectedSampleJob(state);
  const preparation = selectedJob ? samplePreparationForJob(selectedJob) : undefined;
  const emptyVersion = t('journey.context.empty');

  /** 返回既有工作台并携带当前样例岗位标题，不新增顶级导航。 */
  const openWorkspace = (targetView: Extract<TopView, 'jobs' | 'resume' | 'trust'>) => {
    onClose();
    advanceViewTrail({
      sourceView: 'chat',
      sourceTitle: t('nav.chat'),
      sourceDetail: t('journey.prototype.title'),
      targetView,
      targetTitle: t(`desk.${targetView}.title`),
      targetDetail: selectedJob ? t(selectedJob.titleKey) : t('journey.prototype.sampleOnly'),
    });
  };

  let stepContent: ReactNode;
  switch (state.activeStep) {
    case 'resume':
      stepContent = (
        <section data-testid="journey-step-resume" className="flex flex-col gap-3">
          <div>
            <h4 className="text-sm font-semibold text-slate-50">{t('journey.resume.title')}</h4>
            <p className="mt-1 text-xs text-slate-400">{t('journey.resume.hint')}</p>
          </div>
          {!state.resumeVersion ? (
            <div
              className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center"
              data-testid="journey-empty"
            >
              <FileText size={22} className="mx-auto text-slate-500" aria-hidden="true" />
              <p className="mt-3 text-xs text-slate-300">{t('journey.resume.empty')}</p>
              <DeskButton
                action="journey-load-resume"
                variant="amber"
                className="mx-auto mt-4"
                onClick={() => dispatch({ type: 'LOAD_RESUME' })}
              >
                <FileText size={13} />
                {t('journey.resume.load')}
              </DeskButton>
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-line bg-ink-900/50 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Tag tone="jade">{t('journey.prototype.sampleOnly')}</Tag>
                  <code className="text-[11px] text-slate-300">{state.resumeVersion}</code>
                </div>
                <ul className="mt-3 flex flex-col gap-2" data-testid="journey-resume-facts">
                  {SAMPLE_FACT_IDS.map((factId) => (
                    <li key={factId} className="flex flex-col gap-1 border-b border-line pb-2 last:border-0 last:pb-0">
                      <SourceList ids={[factId]} />
                      <p className="text-xs leading-relaxed text-slate-200">{t(`journey.fixture.facts.${factId}`)}</p>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-xl border border-celadon/30 bg-ink-900/40 p-4">
                <p className="text-[11px] font-medium text-celadon-ink">{t('journey.resume.intentTitle')}</p>
                <p className="mt-2 text-xs leading-relaxed text-slate-200" data-testid="journey-intent">
                  {t('journey.fixture.intent')}
                </p>
              </div>
              <DeskButton
                action="journey-search"
                variant="solid"
                className="self-start"
                onClick={() => dispatch({ type: 'SEARCH_JOBS' })}
              >
                {t('journey.search.run')}
                <ArrowRight size={13} />
              </DeskButton>
            </>
          )}
        </section>
      );
      break;
    case 'search':
      stepContent = (
        <section data-testid="journey-step-search" className="flex flex-col gap-3">
          <div>
            <h4 className="text-sm font-semibold text-slate-50">{t('journey.search.title')}</h4>
            <p className="mt-1 text-xs text-slate-400">{t('journey.search.hint')}</p>
          </div>
          <Banner tone="celadon" size="compact">
            {t('journey.fixture.intent')}
          </Banner>
          {!state.isJobListVisible ? (
            <DeskButton
              action="journey-search"
              variant="solid"
              className="self-start"
              onClick={() => dispatch({ type: 'SEARCH_JOBS' })}
            >
              {t('journey.search.run')}
              <ArrowRight size={13} />
            </DeskButton>
          ) : (
            <div className="grid gap-3 lg:grid-cols-3" data-testid="journey-job-list" data-count={SAMPLE_JOBS.length}>
              {SAMPLE_JOBS.map((job) => (
                <article
                  key={job.id}
                  data-job-id={job.id}
                  data-jd-version={job.jdVersion}
                  className={`flex min-w-0 flex-col rounded-xl border p-3 ${
                    state.selectedJobId === job.id ? 'border-celadon/60 bg-ink-800' : 'border-line bg-ink-900/50'
                  }`}
                >
                  <Tag>{t('journey.prototype.fixtureJob')}</Tag>
                  <h5 className="mt-2 text-xs font-semibold text-slate-50">{t(job.titleKey)}</h5>
                  <p className="mt-1 text-[11px] text-slate-400">{t(job.companyKey)}</p>
                  <code className="mt-2 break-all text-[10px] text-slate-500">{job.jdVersion}</code>
                  <p className="mt-3 text-[11px] leading-relaxed text-slate-300">{t(job.summaryKey)}</p>
                  <ul className="mt-3 flex flex-col gap-1.5">
                    {job.matchReasonKeys.map((reasonKey) => (
                      <li key={reasonKey} className="flex items-start gap-1.5 text-[11px] text-jade-ink">
                        <Check size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <span>{t(reasonKey)}</span>
                      </li>
                    ))}
                  </ul>
                  <SourceList ids={job.requirementIds} />
                  <DeskButton
                    action="journey-select-job"
                    variant={state.selectedJobId === job.id ? 'jade' : 'line'}
                    compact
                    className="mt-3 self-start"
                    markers={{ 'job-id': job.id, 'jd-version': job.jdVersion }}
                    onClick={() => dispatch({ type: 'SELECT_JOB', jobId: job.id })}
                  >
                    {t('journey.search.select')}
                    <ArrowRight size={11} />
                  </DeskButton>
                </article>
              ))}
            </div>
          )}
        </section>
      );
      break;
    case 'tailor':
      stepContent = (
        <section data-testid="journey-step-tailor" className="flex flex-col gap-3">
          <div>
            <h4 className="text-sm font-semibold text-slate-50">{t('journey.tailor.title')}</h4>
            <p className="mt-1 text-xs text-slate-400">{t('journey.tailor.hint')}</p>
          </div>
          {!selectedJob ? (
            <Banner tone="amber" reason="JD_REQUIRED">
              {t('journey.tailor.empty')}
            </Banner>
          ) : (
            <>
              <div className="rounded-xl border border-line bg-ink-900/50 p-4">
                <p className="text-xs font-semibold text-slate-50">{t(selectedJob.titleKey)}</p>
                <p className="mt-1 text-[11px] text-slate-400">{t(selectedJob.summaryKey)}</p>
                <div className="mt-3">
                  <SourceList ids={selectedJob.requirementIds} />
                </div>
              </div>
              {!state.greetingKey ? (
                <DeskButton
                  action="journey-generate"
                  variant="amber"
                  className="self-start"
                  onClick={() => dispatch({ type: 'GENERATE_MATERIALS' })}
                >
                  <FileText size={13} />
                  {t('journey.tailor.generate')}
                </DeskButton>
              ) : (
                <>
                  <div className="grid gap-3 md:grid-cols-2" data-testid="journey-materials" data-fact-violations="0">
                    <article className="rounded-xl border border-line bg-ink-900/50 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Tag tone="jade">{t('journey.tailor.factLocked')}</Tag>
                        <Tag tone="jade">{t('journey.tailor.violations', { count: 0 })}</Tag>
                      </div>
                      <h5 className="mt-3 text-xs font-semibold text-slate-50">{t('journey.tailor.resumeTitle')}</h5>
                      <p className="mt-2 text-xs leading-relaxed text-slate-200">{t(selectedJob.tailoredKey)}</p>
                      <code className="mt-3 block break-all text-[10px] text-slate-500">
                        {state.tailoredResumeVersion}
                      </code>
                      <div className="mt-3">
                        <SourceList ids={[...SAMPLE_FACT_IDS, ...selectedJob.requirementIds]} />
                      </div>
                    </article>
                    <article className="rounded-xl border border-line bg-ink-900/50 p-4">
                      <Tag tone="amber">{t('journey.tailor.draftOnly')}</Tag>
                      <h5 className="mt-3 text-xs font-semibold text-slate-50">{t('journey.tailor.greetingTitle')}</h5>
                      <p className="mt-2 text-xs leading-relaxed text-slate-200" data-testid="journey-greeting">
                        {t(state.greetingKey)}
                      </p>
                      <div className="mt-3">
                        <SourceList ids={['experience', selectedJob.requirementIds[0] ?? selectedJob.jdVersion]} />
                      </div>
                    </article>
                  </div>
                  <DeskButton
                    action="journey-go-delivery"
                    variant="solid"
                    className="self-start"
                    onClick={() => dispatch({ type: 'GO_TO_STEP', step: 'delivery' })}
                  >
                    {t('journey.delivery.enter')}
                    <ArrowRight size={13} />
                  </DeskButton>
                </>
              )}
            </>
          )}
        </section>
      );
      break;
    case 'delivery':
      stepContent = (
        <section data-testid="journey-step-delivery" className="flex flex-col gap-3">
          <div>
            <h4 className="text-sm font-semibold text-slate-50">{t('journey.delivery.title')}</h4>
            <p className="mt-1 text-xs text-slate-400">{t('journey.delivery.hint')}</p>
          </div>
          {!state.tailoredResumeVersion || !selectedJob ? (
            <Banner tone="amber" reason="MATERIALS_REQUIRED">
              {t('journey.delivery.empty')}
            </Banner>
          ) : (
            <>
              <div className="rounded-xl border border-seal/35 bg-ink-900/50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Tag tone="seal">{t('journey.delivery.confirmationDemo')}</Tag>
                  <span className="font-mono text-xs text-slate-200" data-testid="journey-outbound-count">
                    {t('journey.delivery.outboundCount', { count: state.outboundAttempts })}
                  </span>
                </div>
                <dl className="mt-3 grid gap-2 text-[11px] sm:grid-cols-2">
                  <div>
                    <dt className="text-slate-500">{t('journey.delivery.target')}</dt>
                    <dd className="mt-1 text-slate-200">{t(selectedJob.titleKey)}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">{t('journey.delivery.resumeVersion')}</dt>
                    <dd className="mt-1 break-all font-mono text-slate-200">{state.tailoredResumeVersion}</dd>
                  </div>
                </dl>
              </div>
              {state.confirmation === 'idle' ? (
                <DeskButton
                  action="journey-request-confirmation"
                  variant="seal"
                  className="self-start"
                  onClick={() => dispatch({ type: 'REQUEST_CONFIRMATION' })}
                >
                  {t('journey.delivery.request')}
                </DeskButton>
              ) : null}
              {state.confirmation === 'pending' ? (
                <Banner
                  tone="amber"
                  reason="CONFIRMATION_REQUIRED"
                  markers={{ testid: 'journey-confirmation-pending' }}
                >
                  <span>{t('journey.delivery.pending')}</span>
                  <div className="flex w-full flex-wrap gap-2">
                    <DeskButton
                      action="journey-confirm-demo"
                      variant="seal"
                      compact
                      onClick={() => dispatch({ type: 'CONFIRM_DEMO' })}
                    >
                      {t('journey.delivery.confirmDemo')}
                    </DeskButton>
                    <DeskButton
                      action="journey-cancel-confirmation"
                      variant="line"
                      compact
                      onClick={() => dispatch({ type: 'CANCEL_CONFIRMATION' })}
                    >
                      {t('journey.delivery.cancel')}
                    </DeskButton>
                  </div>
                </Banner>
              ) : null}
              {state.confirmation === 'confirmed-demo' ? (
                <>
                  <Banner tone="jade" markers={{ testid: 'journey-confirmation-demo' }}>
                    {t('journey.delivery.confirmedDemo')}
                  </Banner>
                  <DeskButton
                    action="journey-go-interview"
                    variant="solid"
                    className="self-start"
                    onClick={() => dispatch({ type: 'GO_TO_STEP', step: 'interview' })}
                  >
                    {t('journey.interview.enter')}
                    <ArrowRight size={13} />
                  </DeskButton>
                </>
              ) : null}
            </>
          )}
        </section>
      );
      break;
    case 'interview':
      stepContent = (
        <section data-testid="journey-step-interview" className="flex flex-col gap-3">
          <div>
            <h4 className="text-sm font-semibold text-slate-50">{t('journey.interview.title')}</h4>
            <p className="mt-1 text-xs text-slate-400">{t('journey.interview.hint')}</p>
          </div>
          {state.confirmation !== 'confirmed-demo' || !selectedJob ? (
            <Banner tone="amber" reason="DEMO_CONFIRMATION_REQUIRED">
              {t('journey.interview.empty')}
            </Banner>
          ) : (
            <>
              <div className="rounded-xl border border-line bg-ink-900/50 p-4">
                <CalendarCheck size={20} className="text-celadon" aria-hidden="true" />
                <p className="mt-3 text-xs font-semibold text-slate-50">{t(selectedJob.titleKey)}</p>
                <p className="mt-2 text-xs leading-relaxed text-slate-300">{t('journey.interview.draftExplanation')}</p>
                {state.interviewDraftId ? (
                  <div className="mt-3" data-testid="journey-interview-draft">
                    <Tag tone="amber">{t('journey.interview.draftTag')}</Tag>
                    <code className="mt-2 block break-all text-[10px] text-slate-400">{state.interviewDraftId}</code>
                  </div>
                ) : null}
              </div>
              {!state.interviewDraftId ? (
                <DeskButton
                  action="journey-draft-interview"
                  variant="amber"
                  className="self-start"
                  onClick={() => dispatch({ type: 'DRAFT_INTERVIEW' })}
                >
                  <CalendarCheck size={13} />
                  {t('journey.interview.createDraft')}
                </DeskButton>
              ) : (
                <DeskButton
                  action="journey-generate-preparation"
                  variant="solid"
                  className="self-start"
                  onClick={() => dispatch({ type: 'GENERATE_PREPARATION' })}
                >
                  <ListChecks size={13} />
                  {t('journey.prepare.generate')}
                  <ArrowRight size={13} />
                </DeskButton>
              )}
            </>
          )}
        </section>
      );
      break;
    case 'prepare':
      stepContent = (
        <section data-testid="journey-step-prepare" className="flex flex-col gap-3">
          <div>
            <h4 className="text-sm font-semibold text-slate-50">{t('journey.prepare.title')}</h4>
            <p className="mt-1 text-xs text-slate-400">{t('journey.prepare.hint')}</p>
          </div>
          {!preparation || state.preparationJobId !== selectedJob?.id ? (
            <Banner tone="amber" reason="INTERVIEW_DRAFT_REQUIRED">
              {t('journey.prepare.empty')}
            </Banner>
          ) : (
            <>
              <article
                className="rounded-xl border border-line bg-ink-900/50 p-4"
                data-testid="journey-self-introduction"
              >
                <Tag tone="jade">{t('journey.prepare.sampleMaterial')}</Tag>
                <h5 className="mt-3 text-xs font-semibold text-slate-50">{t('journey.prepare.selfIntroduction')}</h5>
                <p className="mt-2 text-xs leading-relaxed text-slate-200">{t(preparation.selfIntroductionKey)}</p>
                <div className="mt-3">
                  <SourceList ids={[...SAMPLE_FACT_IDS, selectedJob.jdVersion]} />
                </div>
              </article>
              <div>
                <h5 className="text-xs font-semibold text-slate-50">{t('journey.prepare.questions')}</h5>
                <ol
                  className="mt-2 flex flex-col gap-2"
                  data-testid="journey-question-list"
                  data-count={preparation.questions.length}
                >
                  {preparation.questions.map((question, index) => (
                    <li
                      key={question.questionKey}
                      className="rounded-xl border border-line bg-ink-900/50 p-3"
                      data-question-index={index + 1}
                    >
                      <p className="text-xs font-medium text-slate-50">{t(question.questionKey)}</p>
                      <p className="mt-2 text-[11px] leading-relaxed text-slate-300">{t(question.answerKey)}</p>
                      <div className="mt-3">
                        <SourceList ids={question.sources} />
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
              <article className="rounded-xl border border-line bg-ink-900/50 p-4">
                <h5 className="text-xs font-semibold text-slate-50">{t('journey.prepare.checklist')}</h5>
                <ul className="mt-2 flex flex-col gap-2" data-testid="journey-preparation-checklist">
                  {preparation.checklistKeys.map((checklistKey) => (
                    <li key={checklistKey} className="flex items-start gap-2 text-[11px] text-slate-300">
                      <Check size={12} className="mt-0.5 shrink-0 text-jade-ink" aria-hidden="true" />
                      <span>{t(checklistKey)}</span>
                    </li>
                  ))}
                </ul>
              </article>
            </>
          )}
        </section>
      );
      break;
  }

  return (
    <section
      data-testid="career-journey-prototype"
      data-active-step={state.activeStep}
      data-resume-version={state.resumeVersion ?? ''}
      data-jd-version={selectedJob?.jdVersion ?? ''}
      data-tailored-version={state.tailoredResumeVersion ?? ''}
      data-outbound-attempts={state.outboundAttempts}
      className={`${visible ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3`}
    >
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Route size={17} className="text-celadon" aria-hidden="true" />
              <h3 className="text-sm font-semibold text-slate-50">{t('journey.prototype.title')}</h3>
              <Tag tone="amber">{t('journey.prototype.sampleBadge')}</Tag>
            </div>
            <p className="mt-1 text-[11px] text-slate-400">{t('journey.prototype.subtitle')}</p>
          </div>
          <div className="flex items-center gap-1">
            <DeskButton
              action="journey-reset"
              variant="ghost"
              compact
              onClick={() => {
                dispatch({ type: 'RESET' });
                setScenario('normal');
              }}
            >
              <RotateCcw size={12} />
              {t('journey.prototype.reset')}
            </DeskButton>
            <DeskButton
              action="journey-close"
              variant="line"
              compact
              aria-label={t('journey.prototype.close')}
              onClick={onClose}
            >
              <X size={13} />
            </DeskButton>
          </div>
        </header>

        <div className="grid gap-2 sm:grid-cols-3" data-testid="journey-context">
          <ContextCell
            label={t('journey.context.resume')}
            value={state.resumeVersion ?? emptyVersion}
            testId="journey-context-resume"
          />
          <ContextCell
            label={t('journey.context.jd')}
            value={selectedJob?.jdVersion ?? emptyVersion}
            testId="journey-context-jd"
          />
          <ContextCell
            label={t('journey.context.tailored')}
            value={state.tailoredResumeVersion ?? emptyVersion}
            testId="journey-context-tailored"
          />
        </div>

        <StatePreview scenario={scenario} onScenarioChange={setScenario} onRecover={() => setScenario('recovered')} />

        <nav
          aria-label={t('journey.steps.aria')}
          className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-ink-900/50 p-1 sm:grid-cols-3 xl:grid-cols-6"
        >
          {JOURNEY_STEPS.map((step, index) => (
            <DeskButton
              key={step}
              action="journey-step"
              variant={state.activeStep === step ? 'solid' : 'ghost'}
              compact
              className="w-full justify-start"
              markers={{ step, selected: String(state.activeStep === step) }}
              aria-current={state.activeStep === step ? 'step' : undefined}
              onClick={() => dispatch({ type: 'GO_TO_STEP', step })}
            >
              <span className="font-mono text-[10px] text-slate-500">{String(index + 1).padStart(2, '0')}</span>
              <span>{t(`journey.steps.${step}`)}</span>
            </DeskButton>
          ))}
        </nav>

        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_240px]">
          <div className="min-w-0 rounded-xl border border-line bg-ink-850/60 p-4">{stepContent}</div>
          <aside
            className="min-w-0 rounded-xl border border-line bg-ink-900/40 p-3"
            data-testid="journey-operation-log"
          >
            <div className="flex items-center gap-2">
              <History size={13} className="text-slate-400" aria-hidden="true" />
              <h4 className="text-[11px] font-semibold text-slate-200">{t('journey.log.title')}</h4>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{t('journey.log.hint')}</p>
            {state.events.length === 0 ? (
              <p className="mt-3 text-[11px] text-slate-500" data-testid="journey-log-empty">
                {t('journey.log.empty')}
              </p>
            ) : (
              <ol
                className="mt-3 flex flex-col gap-2"
                data-testid="journey-event-list"
                data-count={state.events.length}
              >
                {state.events.map((event, index) => (
                  <li
                    key={`${event.kind}-${event.jobId ?? 'none'}-${String(index)}`}
                    className="border-b border-line pb-2 text-[10.5px] leading-relaxed text-slate-300 last:border-0"
                  >
                    {t(`journey.events.${event.kind}`, { jobId: event.jobId ?? emptyVersion })}
                  </li>
                ))}
              </ol>
            )}
            <div className="mt-4 flex flex-col gap-1 border-t border-line pt-3">
              <DeskButton
                action="journey-open-jobs"
                variant="ghost"
                compact
                className="justify-start"
                onClick={() => openWorkspace('jobs')}
              >
                <Briefcase size={12} />
                {t('journey.links.jobs')}
              </DeskButton>
              <DeskButton
                action="journey-open-resume"
                variant="ghost"
                compact
                className="justify-start"
                onClick={() => openWorkspace('resume')}
              >
                <FileText size={12} />
                {t('journey.links.resume')}
              </DeskButton>
              <DeskButton
                action="journey-open-trust"
                variant="ghost"
                compact
                className="justify-start"
                onClick={() => openWorkspace('trust')}
              >
                <History size={12} />
                {t('journey.links.trust')}
              </DeskButton>
            </div>
          </aside>
        </div>
        <p className="pb-2 text-[10px] leading-relaxed text-slate-500">{t('journey.prototype.disclaimer')}</p>
      </div>
    </section>
  );
}
