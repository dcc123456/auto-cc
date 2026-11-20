import { ClipboardList, Search, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  JourneyIntentView,
  JourneyInterviewView,
  JourneyJobMatchView,
  JourneySearchView,
  JourneyTailorView,
  ResumeDocSummaryView,
} from '@auto-cc/shared';
import { Banner, DeskButton, DeskSelect, HAIRLINE_ROW_CLASS } from './ui/controls';
import { OutboundAuthorizationCard } from './OutboundAuthorizationCard';
import { DeskSection } from './ui/disclosure';
import { useBridgeAction } from './useBridgeAction';

/**
 * 求职主链的界面化身（M2-B spec 10.3）：母版意向 → 按意向搜岗 → 可解释匹配 → 定制与招呼 → 面试材料。
 *
 * 它不是第八个顶级菜单，也不长第二套业务逻辑：每一颗按钮都直接打 `journey.*` 白名单口，
 * 而那几个口与 agent 工具、工作流节点共用同一组服务方法（AGENTS.md §5.9）。
 * 所有理由与来源都原样上屏（要求 id、事实 id 条数、版本三元组），让人能核对而不是只看“成功”。
 */
export function JourneyPanel() {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [docs, setDocs] = useState<ResumeDocSummaryView[]>([]);
  const [docId, setDocId] = useState('');
  const [intent, setIntent] = useState<JourneyIntentView>();
  const [search, setSearch] = useState<JourneySearchView>();
  const [job, setJob] = useState<JourneyJobMatchView>();
  const [tailor, setTailor] = useState<JourneyTailorView>();
  const [interview, setInterview] = useState<JourneyInterviewView>();

  const read = useCallback(async () => {
    const reply = await bridge?.resume['doc.list']();
    if (!reply?.ok) return;
    setDocs(reply.value);
    const master = reply.value.find((item) => item.parentDocId === null);
    setDocId((current) => (current !== '' ? current : (master?.id ?? '')));
  }, [bridge]);

  useEffect(() => {
    void read();
  }, [read]);

  const { busy, notice, noticeTone, run } = useBridgeAction(read);
  const canRun = docId !== '' && busy === undefined;
  const noDocReason = docId === '' ? 'JOURNEY_DOC_EMPTY' : undefined;

  /**
   * 读一份母版的意向；结果原样留在面板上，下游步骤都从同一份 docId 走。
   * @returns 无返回值；失败以提示条显示
   */
  const loadIntent = () =>
    void run(t('journeyMain.actionIntent'), () => bridge?.journey.intent(docId), {
      apply: (value) => setIntent(value),
      onError: () => setIntent(undefined),
    });

  /**
   * 按意向搜岗；不足三个时服务会失败，面板不补样例。
   * @returns 无返回值
   */
  const loadSearch = () =>
    void run(t('journeyMain.actionSearch'), () => bridge?.journey.search({ docId }), {
      apply: (value) => {
        setSearch(value);
        setIntent(value.intent);
        setJob(undefined);
        setTailor(undefined);
        setInterview(undefined);
      },
    });

  /**
   * 为选中岗位生成定制简历与招呼草稿；事实违规时服务整份失败。
   * @returns 无返回值
   */
  const loadTailor = () => {
    if (!job) return;
    void run(t('journeyMain.actionTailor'), () => bridge?.journey.tailor({ docId, jobId: job.jobId }), {
      apply: (value) => {
        setTailor(value);
        setInterview(undefined);
      },
    });
  };

  /**
   * 为选中岗位生成面试材料；断模型或来源冲突时服务明确失败。
   * @returns 无返回值
   */
  const loadInterview = () => {
    if (!job) return;
    void run(t('journeyMain.actionInterview'), () => bridge?.journey.interview({ docId, jobId: job.jobId }), {
      apply: setInterview,
    });
  };

  return (
    <DeskSection
      id="journey.panel"
      markers={{ testid: 'journey-panel' }}
      title={
        <span className="flex items-center gap-2">
          <ClipboardList size={14} />
          {t('journeyMain.heading')}
        </span>
      }
      summary={<span data-testid="journey-summary">{t('journeyMain.summary', { docs: docs.length })}</span>}
    >
      <p className="text-[11px] text-slate-500">{t('journeyMain.hint')}</p>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <DeskSelect
          action="journey-doc"
          label={t('journeyMain.docLabel')}
          value={docId}
          onValueChange={(value) => {
            setDocId(value);
            setIntent(undefined);
            setSearch(undefined);
            setJob(undefined);
            setTailor(undefined);
            setInterview(undefined);
          }}
          disabled={docs.length === 0}
          disabledReason={docs.length === 0 ? 'JOURNEY_NO_DOC' : undefined}
          disabledReasonLabel={docs.length === 0 ? t('journeyMain.reasonNoDoc') : undefined}
          className="min-w-[14rem]"
        >
          {docs.length === 0 ? <option value="">{t('journeyMain.noDocs')}</option> : null}
          {docs.map((doc) => (
            <option key={doc.id} value={doc.id}>
              {doc.parentDocId === null
                ? t('journeyMain.masterOption', { name: doc.name ?? doc.id })
                : t('journeyMain.variantOption', { name: doc.name ?? doc.id })}
            </option>
          ))}
        </DeskSelect>
        <DeskButton
          action="journey-intent"
          variant="line"
          compact
          busy={!!busy}
          disabled={!canRun}
          disabledReason={noDocReason ?? (busy ? 'ACTION_BUSY' : undefined)}
          disabledReasonLabel={
            docId === '' ? t('journeyMain.reasonNoDoc') : busy ? t('journeyMain.reasonBusy') : undefined
          }
          onClick={loadIntent}
        >
          {t('journeyMain.actionIntent')}
        </DeskButton>
        <DeskButton
          action="journey-search"
          variant="seal"
          compact
          busy={!!busy}
          disabled={!canRun || intent === undefined}
          disabledReason={
            noDocReason ?? (intent === undefined ? 'JOURNEY_INTENT_MISSING' : busy ? 'ACTION_BUSY' : undefined)
          }
          disabledReasonLabel={
            docId === ''
              ? t('journeyMain.reasonNoDoc')
              : intent === undefined
                ? t('journeyMain.reasonNoIntent')
                : busy
                  ? t('journeyMain.reasonBusy')
                  : undefined
          }
          onClick={loadSearch}
        >
          <Search size={12} />
          {t('journeyMain.actionSearch')}
        </DeskButton>
      </div>

      {notice && (
        <Banner tone={noticeTone} size="compact" markers={{ testid: 'journey-notice' }} className="mt-2">
          {notice}
        </Banner>
      )}

      {intent && (
        <div
          className="mt-2 rounded-md border border-line bg-ink-900/50 px-2 py-1.5 text-[11px] text-slate-300"
          data-testid="journey-intent"
          data-resume-version={intent.resumeVersion}
          data-keyword={intent.criteria.keyword}
          data-city={intent.criteria.city ?? ''}
        >
          {t('journeyMain.intentLine', {
            role: intent.expectRole || t('journeyMain.none'),
            city: intent.expectCity || t('journeyMain.none'),
            version: intent.resumeVersion,
          })}
          {intent.missingFields.length > 0 ? (
            <span className="ml-2 text-amber">
              {t('journeyMain.missingFields', { fields: intent.missingFields.join(', ') })}
            </span>
          ) : null}
        </div>
      )}

      {search && search.jobs.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1" data-testid="journey-jobs">
          {search.jobs.map((match) => (
            <li
              key={match.jobId}
              data-testid="journey-job"
              data-job-id={match.jobId}
              data-jd-version={match.jdVersion}
              data-matched={String(match.matchedCount)}
              data-partial={String(match.partialCount)}
              data-missing={String(match.missingCount)}
              className={`${HAIRLINE_ROW_CLASS} rounded-md border border-line px-2 py-1.5`}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 break-all text-[11px] text-slate-100">
                  {t('journeyMain.jobRow', { title: match.title, company: match.company })}
                </span>
                <span className="text-[11px] text-slate-400">
                  {t('journeyMain.matchCounts', {
                    matched: match.matchedCount,
                    partial: match.partialCount,
                    missing: match.missingCount,
                  })}
                </span>
                <DeskButton
                  action={`journey-select-${match.jobId}`}
                  variant={job?.jobId === match.jobId ? 'seal' : 'line'}
                  compact
                  busy={!!busy}
                  disabled={!!busy}
                  disabledReason={busy ? 'ACTION_BUSY' : undefined}
                  disabledReasonLabel={busy ? t('journeyMain.reasonBusy') : undefined}
                  className="ml-auto"
                  onClick={() => {
                    setJob(match);
                    setTailor(undefined);
                    setInterview(undefined);
                  }}
                >
                  {job?.jobId === match.jobId ? t('journeyMain.selected') : t('journeyMain.select')}
                </DeskButton>
              </div>
              <ul className="mt-1 flex flex-col gap-0.5">
                {match.requirements.map((requirement) => (
                  <li
                    key={requirement.requirementId}
                    data-testid="journey-requirement"
                    data-requirement-id={requirement.requirementId}
                    data-state={requirement.state}
                    data-fact-count={String(requirement.factIds.length)}
                    className="text-[11px] text-slate-400"
                  >
                    {t('journeyMain.requirementRow', {
                      label: requirement.label,
                      state: t(`journey.state.${requirement.state}`),
                      facts: requirement.factIds.length,
                    })}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {job && (
        <div className="mt-2 flex flex-wrap gap-2">
          <DeskButton
            action="journey-tailor"
            variant="seal"
            compact
            busy={!!busy}
            disabled={!!busy}
            disabledReason={busy ? 'ACTION_BUSY' : undefined}
            disabledReasonLabel={busy ? t('journeyMain.reasonBusy') : undefined}
            onClick={loadTailor}
          >
            <Wand2 size={12} />
            {t('journeyMain.actionTailor')}
          </DeskButton>
          <DeskButton
            action="journey-interview"
            variant="line"
            compact
            busy={!!busy}
            disabled={!!busy}
            disabledReason={busy ? 'ACTION_BUSY' : undefined}
            disabledReasonLabel={busy ? t('journeyMain.reasonBusy') : undefined}
            onClick={loadInterview}
          >
            <ClipboardList size={12} />
            {t('journeyMain.actionInterview')}
          </DeskButton>
        </div>
      )}

      {tailor && (
        <div
          className="mt-2 rounded-md border border-line bg-ink-900/50 px-2 py-1.5 text-[11px] text-slate-300"
          data-testid="journey-tailor"
          data-job-id={tailor.jobId}
          data-resume-version={tailor.resumeVersion}
          data-jd-version={tailor.jdVersion}
          data-tailored-version={tailor.tailoredResumeVersion ?? ''}
          data-violations={String(tailor.checks.violationCount)}
        >
          <p className="break-all">
            {t('journeyMain.tailorLine', {
              mastered: tailor.resumeVersion,
              variant: tailor.tailoredResumeVersion ?? t('journeyMain.none'),
            })}
          </p>
          {tailor.greeting ? (
            <p className="mt-0.5 break-all" data-testid="journey-greeting" data-origin={tailor.greeting.origin}>
              {t('journeyMain.greetingLine', {
                text: tailor.greeting.text,
                refs: tailor.greeting.evidenceRefs.join(', '),
              })}
            </p>
          ) : null}
        </div>
      )}

      {interview && (
        <div
          className="mt-2 rounded-md border border-line bg-ink-900/50 px-2 py-1.5 text-[11px] text-slate-300"
          data-testid="journey-interview"
          data-job-id={interview.jobId}
          data-jd-version={interview.jdVersion}
          data-qa-count={String(interview.qa.length)}
          data-checklist={String(interview.checklist.length)}
        >
          <p className="break-all">{t('journeyMain.introLine', { text: interview.selfIntro })}</p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {interview.qa.map((item, index) => (
              <li
                key={`${String(index)}-${item.question}`}
                data-testid="journey-qa"
                data-fact-ids={item.resumeFactIds.join(',')}
                data-requirement-ids={item.requirementIds.join(',')}
                className="text-[11px] text-slate-400"
              >
                {t('journeyMain.qaRow', { index: index + 1, question: item.question })}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-slate-400">
            {t('journeyMain.checklistLine', { items: interview.checklist.join(' · ') })}
          </p>
        </div>
      )}

      <OutboundAuthorizationCard
        platform={tailor?.platform ?? search?.platform ?? ''}
        masterVersion={tailor?.resumeVersion ?? intent?.resumeVersion ?? ''}
        tailoredVersion={tailor?.tailoredResumeVersion ?? ''}
        factCheckReceiptId={tailor?.factCheckReceiptId ?? ''}
        jobs={search?.jobs ?? []}
      />
    </DeskSection>
  );
}
