import { ScanSearch } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  GapEvidenceRowItem,
  GapModelStatusView,
  GapReportRowView,
  GapRequirementKindView,
  GapRequirementRowView,
  GapStateView,
  GapSuggestionRow,
} from '@auto-cc/shared';
import { ENTITY_KIND_LABEL_KEY } from './entity-kind-labels';
import { DeskButton, FIELD_CLASS } from './ui/controls';
import { useBridgeAction } from './useBridgeAction';

/** 三栏的栏序（spec 4.4-03）：栏是**状态**不是要求种类，一栏里的行序等于拆解的稳定序，界面不再二次排序。 */
const COLUMN_STATES: readonly GapStateView[] = ['matched', 'partial', 'missing'];

/** 状态 → 栏标题文案键。 */
const STATE_LABEL_KEY: Record<GapStateView, string> = {
  matched: 'gap.stateMatched',
  partial: 'gap.statePartial',
  missing: 'gap.stateMissing',
};

/** 状态 → 行的色带（颜色的唯一凭据是 `state`）：年限那行的 `score` 是「占总时长比例」，与词面覆盖不同量纲，拿它上色就会把"够了"画成红的。 */
const STATE_TONE: Record<GapStateView, string> = {
  matched: 'border-jade/40 bg-jade-wash',
  partial: 'border-amber/40 bg-amber-wash',
  missing: 'border-seal/45 bg-seal-wash',
};

/** 四类**要求** → 文案键（英文串不直接上界面，对齐 §5.5）。注意与 `ENTITY_KIND_LABEL_KEY` 是两套种类：那套是库内实体，这套是 JD 要求。 */
const REQUIREMENT_KIND_LABEL_KEY: Record<GapRequirementKindView, string> = {
  hard_skill: 'gap.kindHardSkill',
  soft_skill: 'gap.kindSoftSkill',
  education: 'gap.kindEducation',
  experience_years: 'gap.kindYears',
};

/** 模型腿结局 → 行的色调（五态五句文案，但"是好消息还是坏消息"只有三档）。 */
const MODEL_TONE: Record<GapModelStatusView, string> = {
  merged: 'text-slate-400',
  rejected: 'text-amber',
  failed: 'text-amber',
  unavailable: 'text-slate-500',
  disabled: 'text-slate-500',
};

/**
 * 取建议对象里的一个插值参数。
 * @param suggestion 建议（`non-null` 由 4.4-06 的结构断言保证）
 * @param name 参数名
 * @returns 参数字符串；缺失时给空串而不是 `undefined`——那会把 `undefined` 原样画到界面上
 */
function paramOf(suggestion: GapSuggestionRow, name: string): string {
  return String(suggestion.params[name] ?? '');
}

/**
 * 缺口报告面板（spec 4.4-05 的界面化身，plan §4.4-d 判据一~四）。
 *
 * 四件事在界面上是刻意的，读代码的人不该重新推断：
 * 1. **它不并进知识库面板**——那边回答"库里有什么"，这边回答"这份 JD 要我有什么"，两个方向
 *    合成一个面板就会互相挤掉对方的空态（`KbPanel` 已经 600 行，这是它的第 28 行理由）。
 * 2. **三栏是状态而不是种类**，栏内序等于 `report.rows` 的序：比对不重排，界面也不再排一遍
 *    （同一份读数排两次就会两次不一样，spec 4.4-07 的稳定序判据）。
 * 3. **计数只读主进程**：栏头的数字来自 `report.counts`，不在渲染层 `filter().length` 重算（§2.5）。
 * 4. **证据正文按需现取**：报告里只有 id，点一条才问一次 `kb.profile.evidenceBody`——
 *    一次比对不该把半本库推过进程边界。
 */
export function GapPanel() {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [jdText, setJdText] = useState('');
  const [report, setReport] = useState<GapReportRowView>();
  /** 库缺失是**另一种**空态（不是"你不合格"），所以它自己占一个 state 而不是混进提示行。 */
  const [libraryMissing, setLibraryMissing] = useState(false);
  /** 已展开的证据正文：`null` = 问过但库里已经没有这条了（报告是现算的，可能停在旧读水上）。 */
  const [bodies, setBodies] = useState<Record<string, string | null>>({});

  const read = useCallback(async () => {
    // 面板没有"重读"这件事：报告是 JD × 库的现算投影，唯一的重读就是再按一次分析。
  }, []);

  const { busy, notice, run, setNotice } = useBridgeAction(read);

  /** 分析按不动只有两种原因：JD 那栏还空着，或上一条动作在途（07 稿④）。 */
  const analyzeReason = jdText.trim() === '' ? 'JD_EMPTY' : busy !== undefined ? 'ACTION_BUSY' : undefined;
  /** 原因码 → 人话（只给码不给这句话就是谎报）。 */
  const reasonLabel = (code?: string): string | undefined => (code === undefined ? undefined : t(`gap.reason.${code}`));

  /**
   * 库被改过之后上一份报告就是陈旧的（比对的据已经变了），所以清掉而不是留着让用户读旧读数。
   * 与 `KbPanel` 清检索结果同一口径（4.2-06 的即时生效）。
   */
  useEffect(() => {
    if (!bridge) return;
    return bridge.on('kb/entities-changed', () => {
      setReport(undefined);
      setBodies({});
      setNotice(t('gap.stale'));
    });
  }, [bridge, setNotice, t]);

  /**
   * 跑一次缺口报告（拆解 + 比对，全在主进程）。
   */
  const analyze = () => {
    setLibraryMissing(false);
    void run(t('gap.analyze'), () => bridge?.kb['gap.report'](jdText.trim()), {
      apply: (value) => {
        setReport(value);
        setBodies({});
      },
      onError: (error) => {
        if (error.code === 'KB_LIBRARY_MISSING') {
          setLibraryMissing(true);
          setReport(undefined);
        }
      },
      describe: (value) =>
        t('gap.done', { matched: value.counts.matched, partial: value.counts.partial, missing: value.counts.missing }),
    });
  };

  /**
   * 展开/收起一条证据的正文（4.4-05 的证据链跳转）：第一次点才去主进程取，取到过就复用。
   * @param evidence 报告里的一条证据引用
   */
  const toggleEvidence = (evidence: GapEvidenceRowItem) => {
    if (evidence.id in bodies) {
      setBodies((current) => {
        const next = { ...current };
        delete next[evidence.id];
        return next;
      });
      return;
    }
    void run(t('gap.evidence'), () => bridge?.kb['profile.evidenceBody'](evidence.id), {
      apply: (value) => setBodies((current) => ({ ...current, [evidence.id]: value?.text ?? null })),
    });
  };

  /**
   * 一条建议的文案。五个 key 各写一句 literal `t()` 调用，这样占位符与实参的对应由
   * `check-renderer-conventions` 机检（动态 key 查不到，等于把"漏一个插值"留给用户发现）。
   * @param row 非命中的比对行
   * @returns 一句人话；`suggestion` 为 `null`（命中行）时 `null`
   */
  const renderSuggestion = (row: GapRequirementRowView) => {
    const suggestion = row.suggestion;
    if (!suggestion) return null;
    switch (suggestion.key) {
      case 'add_evidence':
        return t('gap.suggestion.addEvidence', { label: paramOf(suggestion, 'label') });
      case 'strengthen_evidence':
        return t('gap.suggestion.strengthenEvidence', {
          label: paramOf(suggestion, 'label'),
          evidenceId: paramOf(suggestion, 'evidenceId'),
        });
      case 'years_gap':
        // `noPeriod` 是比对腿挂的标记位：库里一条带起止的经历都没有时，报「只有 0 年」会把
        // 「还没录简历」说成「年限不够」——两件事的下一步完全不同，所以各占一句独立文案。
        return suggestion.params['noPeriod'] === undefined
          ? t('gap.suggestion.yearsGap', {
              label: paramOf(suggestion, 'label'),
              required: paramOf(suggestion, 'required'),
              have: paramOf(suggestion, 'haveYears'),
            })
          : t('gap.suggestion.yearsNoPeriod', {
              label: paramOf(suggestion, 'label'),
              required: paramOf(suggestion, 'required'),
            });
      case 'education_gap':
        return t('gap.suggestion.educationGap', {
          required: paramOf(suggestion, 'requiredLabel'),
          have: paramOf(suggestion, 'haveRank'),
        });
      case 'education_missing':
        return t('gap.suggestion.educationMissing', { label: paramOf(suggestion, 'label') });
    }
  };

  /**
   * 模型腿的五种结局 → 五句文案（spec 4.4-02 的 V 半边）。
   *
   * 这里刻意不合成一句"这次没用上模型"：`rejected`（模型答了但一条都没收下）与 `disabled`
   * （配置关着）对用户的下一步完全不同，四种未并进来的原因也必须分别读得出来。
   * @param value 一次缺口报告的读数
   * @returns 一行播报
   */
  const renderModelLeg = (value: GapReportRowView) => {
    const reason = value.modelReason ?? '';
    switch (value.modelStatus) {
      case 'merged':
        return t('gap.modelMerged', { added: value.modelAdded, model: value.model ?? '' });
      case 'rejected':
        return t('gap.modelRejected', { dropped: value.modelDropped, reason });
      case 'failed':
        return t('gap.modelFailed', { reason });
      case 'unavailable':
        return t('gap.modelUnavailable', { reason });
      case 'disabled':
        return t('gap.modelDisabled');
    }
  };

  /**
   * 一栏里的比对行。
   * @param row 一条要求的比对结果
   * @returns 行节点
   */
  const renderRow = (row: GapRequirementRowView) => (
    <li
      key={`${row.item.kind}-${row.item.start}-${row.item.label}`}
      className={`rounded border p-2 ${STATE_TONE[row.state]}`}
    >
      <p data-gap-row={row.state} className="text-xs text-slate-200">
        <span className="text-slate-400">{t(REQUIREMENT_KIND_LABEL_KEY[row.item.kind])}</span> · {row.item.quote}
        {row.item.years !== null && <> · {t('gap.years', { years: row.item.years })}</>}
        <span className="text-slate-400"> · {t(row.item.via === 'model' ? 'gap.viaModel' : 'gap.viaLexicon')}</span>
      </p>
      {row.bestScore !== null && (
        <p className="text-[11px] text-slate-500">
          {t('gap.bestScore', { score: row.bestScore.toFixed(2) })}
          {row.item.kind === 'experience_years' && <> · {t('gap.scoreDisplayOnly')}</>}
        </p>
      )}
      {row.evidence.length > 0 && (
        <ul className="mt-1 flex flex-col gap-1">
          {row.evidence.map((evidence) => (
            <li key={evidence.id}>
              <button
                type="button"
                data-gap-evidence={evidence.id}
                onClick={() => toggleEvidence(evidence)}
                className="text-left text-[11px] text-slate-400 hover:text-celadon"
              >
                {t('gap.evidenceLine', {
                  id: evidence.id,
                  origin: t(evidence.origin === 'entity' ? 'gap.originEntity' : 'gap.originChunk'),
                  score: evidence.score.toFixed(2),
                })}
                {evidence.matchedTokens.length > 0 && <> · {evidence.matchedTokens.join(' / ')}</>}
              </button>
              {evidence.id in bodies && (
                <p data-gap-evidence-body={evidence.id} className="mt-1 text-[11px] leading-relaxed text-slate-500">
                  {bodies[evidence.id] ?? t('gap.evidenceGone')}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {row.suggestion !== null && (
        <p data-gap-suggestion={row.suggestion.key} className="mt-1 text-[11px] leading-relaxed text-slate-300">
          {renderSuggestion(row)}
        </p>
      )}
    </li>
  );

  return (
    <div data-testid="gap-panel" className="flex flex-col gap-4 rounded-lg border border-line bg-ink-950/60 p-4">
      <div className="flex items-center gap-2">
        <ScanSearch className="h-4 w-4 text-slate-300" />
        <h2 className="text-sm font-semibold text-slate-200">{t('gap.heading')}</h2>
      </div>
      <p className="text-xs leading-relaxed text-slate-400">{t('gap.hint')}</p>

      <div className="flex flex-col gap-2">
        <textarea
          data-gap-field="jd"
          value={jdText}
          onChange={(event) => setJdText(event.target.value)}
          rows={6}
          placeholder={t('gap.jdPlaceholder')}
          className={`${FIELD_CLASS} min-w-0`}
        />
        <div className="flex items-center gap-2">
          <DeskButton
            action="analyze"
            markers={{ 'gap-action': 'analyze' }}
            disabled={analyzeReason !== undefined}
            variant="line"
            compact
            busy={!!busy}
            disabledReason={analyzeReason}
            disabledReasonLabel={reasonLabel(analyzeReason)}
            onClick={analyze}
          >
            <ScanSearch size={12} />
            {t('gap.analyze')}
          </DeskButton>
          {report && (
            <span
              data-gap-model={report.modelStatus}
              className={`text-[11px] leading-relaxed ${MODEL_TONE[report.modelStatus]}`}
            >
              {renderModelLeg(report)}
            </span>
          )}
        </div>
      </div>

      {libraryMissing && (
        // 与"JD 太短"分开的确定空态：没有库就没有"缺口"这回事，这时候说"你不合格"是最坏的假读数。
        <p data-gap-library-missing className="text-xs leading-relaxed text-amber">
          {t('gap.libraryMissing')}
        </p>
      )}

      {report && report.rows.length === 0 && !libraryMissing && (
        <p data-gap-empty="no_requirements" className="text-xs leading-relaxed text-slate-400">
          {t('gap.noRequirements', { chars: report.inputChars })}
        </p>
      )}

      {report && report.entityCount === 0 && report.rows.length > 0 && (
        // 缺失一片时先问"库是不是空的"：0 条实体的报告里每条缺失都不说明能力，只说明还没录简历。
        <p data-gap-empty="no_entities" className="text-xs leading-relaxed text-amber">
          {t('gap.noEntities')}
        </p>
      )}

      {report && report.rows.length > 0 && (
        <>
          <p data-gap-summary className="text-xs text-slate-400">
            {t('gap.summary', {
              entities: report.entityCount,
              months: report.totalExperienceMonths,
              education: report.libraryEducationRank ?? t('gap.educationNone'),
              asOfMonth: report.asOfMonth,
              lexicon: report.lexiconVersion,
              prompt: report.promptVersion ?? t('gap.promptNone'),
            })}
          </p>
          <div className="grid grid-cols-3 gap-2">
            {COLUMN_STATES.map((state) => {
              const rowsInState = report.rows.filter((row) => row.state === state);
              return (
                <div
                  key={state}
                  data-gap-column={state}
                  className="flex min-w-0 flex-col gap-2 rounded border border-line p-2"
                >
                  <p className="text-xs font-semibold text-slate-300">
                    {t(STATE_LABEL_KEY[state])} · {report.counts[state]}
                  </p>
                  {rowsInState.length === 0 ? (
                    <p data-gap-column-empty={state} className="text-[11px] text-slate-600">
                      {t('gap.columnEmpty')}
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2">{rowsInState.map(renderRow)}</ul>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {report && report.highlights.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-slate-300">
            {t('gap.highlights')} · {report.highlights.length}
          </p>
          <ul className="flex flex-col gap-1">
            {report.highlights.map((highlight) => (
              <li
                key={highlight.entityId}
                data-gap-highlight={highlight.entityId}
                className="text-[11px] text-slate-400"
              >
                {highlight.entityId} ·{' '}
                <span className="text-slate-300">{t(ENTITY_KIND_LABEL_KEY[highlight.kind])}</span> ·{' '}
                {highlight.score.toFixed(2)} · {highlight.relatedTokens.join(' / ')}
              </li>
            ))}
          </ul>
          {/* 截断条数必须可见：只报"6 条亮点"而不说还有几条被阈值切掉，就是把读数假装完整。 */}
          {report.highlightsDropped > 0 && (
            <p data-gap-highlight-dropped className="text-[11px] text-slate-500">
              {t('gap.highlightsDropped', { count: report.highlightsDropped })}
            </p>
          )}
        </div>
      )}

      {notice && (
        <p data-gap-notice className="text-xs leading-relaxed text-slate-400">
          {notice}
        </p>
      )}
    </div>
  );
}
