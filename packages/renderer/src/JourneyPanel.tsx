import { ClipboardList, LogIn, Search, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  JourneyIntentView,
  JourneyInterviewView,
  JourneyJobMatchView,
  JourneySearchView,
  JourneyTailorView,
  KbIntentFieldRowKey,
  ResumeDocSummaryView,
} from '@auto-cc/shared';
import { Banner, DeskButton, DeskField, DeskSelect, HAIRLINE_ROW_CLASS } from './ui/controls';
import { OutboundAuthorizationCard } from './OutboundAuthorizationCard';
import { DeskPathGuide, DeskSection } from './ui/disclosure';
import { isLocalSessionUrl } from './platform-choice';
import { platformLabel } from './platform-label';
import { advanceViewTrail } from './viewTrail';
import { useBridgeAction } from './useBridgeAction';

/** 求职意向四格的固定顺序（与 `kb.profile.revise` 的 `intent.field` 键、简历表单同一份）。 */
const INTENT_FIELDS: readonly KbIntentFieldRowKey[] = ['expectRole', 'expectCity', 'expectSalary', 'expectStart'];

/** 四格 → 语言包键：走查里那句「未填：expectRole, expectCity…」正是这里曾经直接甩键名的地方。 */
const INTENT_LABEL_KEY: Record<KbIntentFieldRowKey, string> = {
  expectRole: 'resumeForm.fieldExpectRole',
  expectCity: 'resumeForm.fieldExpectCity',
  expectSalary: 'resumeForm.fieldExpectSalary',
  expectStart: 'resumeForm.fieldExpectStart',
};

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
  const [intentDraft, setIntentDraft] = useState<Partial<Record<KbIntentFieldRowKey, string>>>({});
  // 当前真实平台的登录态：只用来决定「先登录 BOSS」这条指路要不要出现，不参与任何外发判定。
  const [loginPlatform, setLoginPlatform] = useState<{ id: string; isActive: boolean }>();
  const [scrollIntentPending, setScrollIntentPending] = useState(false);
  const intentRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState<JourneySearchView>();
  /**
   * 库内岗位（2026-11-24 N2）：授权候选不能只认 `journey.search` 的结果——
   * 新手常用岗位页的「搜索并入库」抓岗，那条链不写 journey 的 search 读数，于是授权格永远是空列表。
   * 这里直接读 `jd.store.list`，让抓来的岗位也能勾选、能定制、能开跑。
   */
  const [libraryJobs, setLibraryJobs] = useState<JourneyJobMatchView[]>([]);
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

  /** 读真实平台的登录态：只驱动那句「先登录 BOSS」的指路，读不到就不显示（不猜）。 */
  const readLogin = useCallback(async () => {
    const reply = await bridge?.sessions.status();
    if (!reply?.ok) return;
    const real = reply.value.platforms.find((item) => !isLocalSessionUrl(item.startUrl));
    setLoginPlatform(real ? { id: real.id, isActive: real.auth === 'active' } : undefined);
  }, [bridge]);

  useEffect(() => {
    void read();
    void readLogin();
  }, [read, readLogin]);

  /**
   * 这一格重新可见时重读简历清单（spec 10.10-02 的根因）。
   *
   * 面板挂在 `hidden` 的 section 里不会卸载（1.10-01），`useEffect` 的挂载读因此只跑一次：
   * 新手在简历页导入成功后切到岗位页，下拉里仍是导入前那份空清单，唯一的"解法"是重启（走查 K2）。
   * `IntersectionObserver` 在 `display:none → block` 时会报一次相交，正好是"人现在看着这一格"的时机。
   */
  /** 意向读到之后把草稿对齐成服务端那一份（人没改过的格子不该被下一次读取覆盖成空）。 */
  useEffect(() => {
    if (!intent) return;
    setIntentDraft({
      expectRole: intent.expectRole,
      expectCity: intent.expectCity,
      expectSalary: intent.expectSalary,
      expectStart: intent.expectStart,
    });
  }, [intent]);

  const { busy, notice, noticeTone, run, setNotice } = useBridgeAction(read);
  const canRun = docId !== '' && busy === undefined;
  const noDocReason = docId === '' ? 'JOURNEY_DOC_EMPTY' : undefined;

  /**
   * 读一份母版的意向；结果原样留在面板上，下游步骤都从同一份 docId 走。
   * @returns 无返回值；失败以提示条显示
   */
  const loadIntent = () =>
    void run(t('journeyMain.actionIntent'), () => bridge?.journey.intent(docId), {
      apply: (value) => {
        setIntent(value);
        // 结果条常常长在点击位置下方一屏（走查 K8「点完什么都没变」），读到就把它带进视口。
        setScrollIntentPending(true);
      },
      onError: () => setIntent(undefined),
    });

  /**
   * 保存求职意向四格：只提交改动过的格子，走 `kb.profile.revise` 的 `intent.field`，
   * 保存后重读意向，让缺口数当场下降（spec 10.10-03）。
   * @returns 无返回值；失败以提示条显示
   */
  const saveIntent = () => {
    if (!intent) return;
    const ops = INTENT_FIELDS.filter((field) => (intentDraft[field] ?? '') !== String(intent[field] ?? '')).map(
      (field) => ({ op: 'intent.field' as const, field, value: (intentDraft[field] ?? '').trim() }),
    );
    if (ops.length === 0) {
      setNotice(t('journeyMain.intentSaveNoop'), 'celadon');
      return;
    }
    void run(t('journeyMain.actionSaveIntent'), () => bridge?.kb['profile.revise'](docId, ops), {
      apply: () => {
        void loadIntent();
      },
    });
  };

  /** 结果条进入视口：`nearest` 保证已经在视口时不跳屏。 */
  useEffect(() => {
    if (!scrollIntentPending || !intent) return;
    intentRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setScrollIntentPending(false);
  }, [scrollIntentPending, intent]);

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
  /** 读库内岗位，拼成授权候选的形状（匹配计数是「没算过」，用 0 如实表示，不编数）。 */
  useEffect(() => {
    void (async () => {
      const reply = await bridge?.jd['store.list'](50, {});
      if (!reply?.ok) return;
      setLibraryJobs(
        reply.value.rows.map((row) => ({
          jobId: row.jobId,
          title: row.title,
          company: row.company,
          jdVersion: row.description === '' ? '' : `jd:${row.jobId}`,
          matchedCount: 0,
          partialCount: 0,
          missingCount: 0,
          requirements: [],
        })),
      );
    })();
  }, [bridge]);

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
      onOpenChange={(open) => {
        // 展开就是"人现在要读这一格"：重读母版清单与登录态（spec 10.10-02 的根因在这里收口）。
        if (open) {
          void read();
          void readLogin();
        }
      }}
    >
      <div className="flex flex-col gap-2">
        <p className="text-[11px] text-slate-500">{t('journeyMain.hint')}</p>

        {/* 这一屏的三问（spec 10.10-16）：我在哪 / 下一步 / 出口，三者都可读，出口与下一步都可点。 */}
        <DeskPathGuide
          testid="journey-path-guide"
          here={t('journeyMain.guideHere')}
          next={t('journeyMain.guideNext')}
          nextAction={
            docs.length === 0 ? (
              <DeskButton
                action="journey-go-resume"
                variant="line"
                compact
                onClick={() =>
                  advanceViewTrail({
                    sourceView: 'jobs',
                    sourceTitle: t('nav.jobs'),
                    targetView: 'resume',
                    targetTitle: t('desk.resume.title'),
                    targetDetail: t('journeyMain.goResume'),
                  })
                }
              >
                {t('journeyMain.goResume')}
              </DeskButton>
            ) : undefined
          }
          exit={t('journeyMain.guideExit')}
          exitAction={
            <DeskButton
              action="journey-back-chat"
              variant="ghost"
              compact
              onClick={() =>
                advanceViewTrail({
                  sourceView: 'jobs',
                  sourceTitle: t('nav.jobs'),
                  targetView: 'chat',
                  targetTitle: t('nav.chat'),
                  targetDetail: t('journeyMain.guideExitChat'),
                })
              }
            >
              {t('journeyMain.guideExitChat')}
            </DeskButton>
          }
        />

        {/* 没有母版时给一条**可点**的下一步（走查 K2：原先只有悬停提示里一句「还没有选择母版简历」）。 */}
        {docs.length === 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-amber" data-testid="journey-no-doc-next">
            <span>{t('journeyMain.reasonNoDoc')}</span>
            <DeskButton
              action="journey-go-resume-empty"
              variant="line"
              compact
              onClick={() =>
                advanceViewTrail({
                  sourceView: 'jobs',
                  sourceTitle: t('nav.jobs'),
                  targetView: 'resume',
                  targetTitle: t('desk.resume.title'),
                  targetDetail: t('journeyMain.goResume'),
                })
              }
            >
              {t('journeyMain.goResume')}
            </DeskButton>
          </div>
        ) : null}

        {/* 真实平台没登录时明说「先登录 BOSS」并给入口（spec 10.10-03）：否则「按意向搜岗」是按下去才知道要登录。 */}
        {loginPlatform && !loginPlatform.isActive ? (
          <Banner
            tone="amber"
            size="compact"
            markers={{ testid: 'journey-login-hint' }}
            actions={
              <DeskButton
                action="journey-go-login"
                variant="solid"
                compact
                onClick={() =>
                  advanceViewTrail({
                    sourceView: 'jobs',
                    sourceTitle: t('nav.jobs'),
                    targetView: 'trust',
                    targetTitle: t('desk.trust.title'),
                    targetDetail: platformLabel(t, loginPlatform.id),
                  })
                }
              >
                <LogIn size={12} />
                {t('journeyMain.goLogin', { platform: platformLabel(t, loginPlatform.id) })}
              </DeskButton>
            }
          >
            {t('journeyMain.loginHint', { platform: platformLabel(t, loginPlatform.id) })}
          </Banner>
        ) : null}

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

        {/* 禁用的原因写在**看得见**的地方（spec 10.10-18）：让「按得动」这件事有下一步，而不是只在悬停气泡里。 */}
        {docId !== '' && intent === undefined && busy === undefined ? (
          <p className="text-[11px] text-slate-400" data-testid="journey-search-reason">
            {t('journeyMain.reasonNoIntent')}
          </p>
        ) : null}

        {notice && (
          <Banner tone={noticeTone} size="compact" markers={{ testid: 'journey-notice' }} className="mt-2">
            {notice}
          </Banner>
        )}

        {intent && (
          <div
            ref={intentRef}
            className="mt-2 rounded-md border border-line bg-ink-900/50 px-2 py-1.5 text-[11px] text-slate-300"
            data-testid="journey-intent"
            data-resume-version={intent.resumeVersion}
            data-keyword={intent.criteria.keyword}
            data-city={intent.criteria.city ?? ''}
            data-missing-count={String(intent.missingFields.length)}
          >
            {t('journeyMain.intentLine', {
              role: intent.expectRole || t('journeyMain.none'),
              city: intent.expectCity || t('journeyMain.none'),
              version: intent.resumeVersion,
            })}
            {/* 缺口用人话点名 + 就地给四格（spec 10.10-03）：原先只甩一行 `expectRole, expectCity…` 键名。 */}
            {intent.missingFields.length > 0 ? (
              <p className="mt-1 text-amber" data-testid="journey-intent-gaps">
                {t('journeyMain.gapsTitle', {
                  fields: intent.missingFields
                    .map((field) =>
                      t(INTENT_LABEL_KEY[field as KbIntentFieldRowKey] ?? 'journeyMain.gapUnknown', { field }),
                    )
                    .join('、'),
                })}
              </p>
            ) : null}
            <div className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-4" data-testid="journey-intent-fields">
              {INTENT_FIELDS.map((field) => (
                <DeskField
                  key={field}
                  action={`journey-intent-${field}`}
                  data-testid={`journey-intent-${field}`}
                  label={t(INTENT_LABEL_KEY[field])}
                  value={intentDraft[field] ?? ''}
                  onValueChange={(next) => setIntentDraft((current) => ({ ...current, [field]: next }))}
                  placeholder={t(`resumeForm.intentPlaceholder.${field}`)}
                  maxLength={40}
                  className="w-full"
                />
              ))}
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <DeskButton
                action="journey-intent-save"
                variant="solid"
                compact
                busy={!!busy}
                disabled={!!busy}
                disabledReason={busy ? 'ACTION_BUSY' : undefined}
                disabledReasonLabel={busy ? t('journeyMain.reasonBusy') : undefined}
                onClick={saveIntent}
              >
                {t('journeyMain.actionSaveIntent')}
              </DeskButton>
              <span className="text-slate-500">{t('journeyMain.intentSaveHint')}</span>
            </div>
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
          jobs={search?.jobs.length ? search.jobs : libraryJobs}
        />
      </div>
    </DeskSection>
  );
}
