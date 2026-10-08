import { ArrowUpDown, ListChecks, ShieldAlert, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  GapModelStatusView,
  GenerationAcceptRowResult,
  GenerationReorderRowView,
  GenerationRewriteRowView,
  GenerationRunRowView,
} from '@auto-cc/shared';
import {
  Banner,
  BLOCK_EDGE_CLASS,
  BLOCK_SURFACE_CLASS,
  DeskButton,
  DeskCheck,
  DeskDisclosure,
  DeskTextarea,
  type BannerTone,
} from './ui/controls';
import { useBridgeAction } from './useBridgeAction';
import { useViewTrail } from './viewTrail';

/** 模型腿结局 → 行的色调（与缺口面板同一分档：只有"是好消息还是坏消息"是三档，文案是五句）。 */
const MODEL_TONE: Record<GapModelStatusView, string> = {
  merged: 'text-slate-400',
  rejected: 'text-amber',
  failed: 'text-amber',
  unavailable: 'text-slate-500',
  disabled: 'text-slate-500',
};

/** 三种结局的语气档（`rejected` 是这条链的正常结局之一，不是故障，所以给提醒色而不是错误色）。 */
const OUTCOME_TONE: Record<GenerationRunRowView['receipt']['outcome'], BannerTone> = {
  rewritten: 'jade',
  reorder_only: 'celadon',
  rejected: 'amber',
};

/**
 * 定向生成预览面板（spec 4.5-02 / 05 / 09 / 11 的界面化身，plan §4.5 判据一 / 三）。
 *
 * 四件事在界面上是刻意的，读代码的人不该重新推断：
 * 1. **产物是提议态**：这个面板按下去之前，工作副本一个字都不会变（判据三）。唯一写盘的按钮是
 *    「接受选中的改写」，它调的是 `resume.generate.accept`——全 app 只有这一口会动那份文档。
 * 2. **逐项勾选默认全不选**：spec 写的是"逐项接受/回退"，默认全接受就等于让用户一路回车签完。
 * 3. **重排是整组接受 / 整组回退**，不给逐条开关：位置之间互相依赖，逐条回退会让"第几位"变成二次猜测。
 * 4. **改前那一栏是用户自己的话**：正文由主进程随改写行一起给（`originalText` 逐字取自工作副本），
 *    渲染层没有 `resume.doc.*` 口，也拿不到文档模型本体（判据二）。
 */
export function GeneratePanel() {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [jdText, setJdText] = useState('');
  /**
   * 09 稿形态⑥（spec 6.2-24 + 6.4-05）：从岗位屏双击跳过来时带上那一条 JD。
   * 这一跳只做两件事——把正文落进下面那只本来就接受自由文本的输入框、把这一段滚进画面。
   * 生成仍然只有人按「生成定制版」才发起，本面板不写任何简历内容（「正文不过界」）。
   * 依赖写成整个 `trail`：它的身份每跳变一次，同一行双击第二次也要重新落文本与重新滚。
   */
  const trail = useViewTrail();
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!trail || trail.targetView !== 'resume') return;
    if (trail.seedJdText !== undefined) setJdText(trail.seedJdText);
    // 切格发生在父组件（App）的 effect 里，子先父后，所以本帧这段还挂在 `hidden` 下面，
    // 滚进画面要推到下一帧（否则是一次无效滚动，表现为"跳过去还在列表顶上"）。
    const frame = requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: 'start' }));
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [trail]);
  const [preview, setPreview] = useState<GenerationRunRowView>();
  /** 与 `preview.rewrites` 等长同序的勾选态：下标就是接受时回传的那份下标（界面看见哪行勾哪行）。 */
  const [checked, setChecked] = useState<boolean[]>([]);
  const [applyReorder, setApplyReorder] = useState(false);
  /** 上一次接受的读数：写盘之后提议态就用掉了，界面要留下"写过"的证据而不是假装还能再按一次。 */
  const [accepted, setAccepted] = useState<GenerationAcceptRowResult>();
  /** 接受被挡下来的三种口径各说一句不同的话，见 `onAcceptError`。 */
  const [blocked, setBlocked] = useState<string>();
  /** 证据正文按需现取（同缺口面板）：`null` = 问过但库里已经没有这条了。 */
  const [bodies, setBodies] = useState<Record<string, string | null>>({});

  const read = useCallback(async () => {
    // 面板没有"重读"：产物是一次生成的读数，重读就等于让用户对着一份已经用掉的提议态再表态。
  }, []);

  const { busy, notice, run, setNotice } = useBridgeAction(read);

  /**
   * 库或工作副本被改过之后，那份提议态的基线就不成立了（接受侧会以 stale 拒绝），
   * 所以界面直接清掉产物而不是留着让人按一次失败一次。
   */
  useEffect(() => {
    if (!bridge) return;
    return bridge.on('kb/entities-changed', () => {
      setPreview(undefined);
      setChecked([]);
      setBodies({});
      setNotice(t('generate.stale'));
    });
  }, [bridge, setNotice, t]);

  /** 一次生成的三种结局 → 一句播报（literal `t()` 三种各写一遍，占位符与实参由机检对齐）。 */
  const outcomeText = (value: GenerationRunRowView) => {
    switch (value.receipt.outcome) {
      case 'rewritten':
        return t('generate.outcomeRewritten', { count: value.rewrites.length });
      case 'reorder_only':
        return t('generate.outcomeReorderOnly', { moves: value.reorderBases.length });
      case 'rejected':
        return t('generate.outcomeRejected', { count: value.checks.violationCount });
    }
  };

  /**
   * 模型腿的五种结局 → 五句文案（spec 4.5-09 的播报半边：保守版要说清"为什么没有改写"）。
   * @param value 一次生成的读数
   * @returns 一行播报
   */
  const modelLegText = (value: GenerationRunRowView) => {
    const reason = value.receipt.modelReason ?? '';
    switch (value.receipt.modelStatus) {
      case 'merged':
        return t('generate.modelMerged', { model: value.receipt.model ?? '', dropped: value.receipt.rewritesDropped });
      case 'rejected':
        return t('generate.modelRejected', { dropped: value.receipt.rewritesDropped, reason });
      case 'failed':
        return t('generate.modelFailed', { reason });
      case 'unavailable':
        return t('generate.modelUnavailable', { reason });
      case 'disabled':
        return t('generate.modelDisabled');
    }
  };

  /**
   * 跑一次定向生成（拆解、重排、改写、事实校验全在主进程）。
   */
  const generate = () => {
    setBlocked(undefined);
    setAccepted(undefined);
    void run(t('generate.run'), () => bridge?.resume['generate.run'](jdText.trim()), {
      apply: (value) => {
        setPreview(value);
        setChecked(value.rewrites.map(() => false));
        setApplyReorder(false);
        setBodies({});
      },
      describe: (value) => outcomeText(value),
    });
  };

  /**
   * 把用户勾中的那些改写与（可选的）重排写进工作副本——本面板唯一一个会改文件的动作。
   */
  const accept = () => {
    if (!preview) return;
    const acceptedIndexes = checked.map((isChecked, index) => (isChecked ? index : -1)).filter((index) => index >= 0);
    void run(
      t('generate.accept'),
      () => bridge?.resume['generate.accept'](preview.receipt.id, { acceptedIndexes, applyReorder }),
      {
        apply: (value) => {
          setAccepted(value);
          // 提议态在一次接受之后就不在主进程里了（`accept()` 会把它删掉），留着界面只会诱导第二次失败。
          setPreview(undefined);
          setChecked([]);
        },
        onError: (error) => {
          // 三个码各对应一句不同的话，处置也不同：重生成 / 先看用户自己改的那版 / 这条组合没过校验。
          if (error.code === 'KB_GENERATION_PROPOSAL_MISSING') setBlocked(t('generate.errorMissing'));
          else if (error.code === 'KB_GENERATION_STALE_BASELINE') setBlocked(t('generate.errorStale'));
          else if (error.code === 'KB_GENERATION_CHECK_FAILED')
            setBlocked(t('generate.errorCheck', { message: error.message }));
          else setBlocked(t('generate.errorOther', { message: error.message }));
        },
      },
    );
  };

  /**
   * 一条改写的出处半边（4.5-06）：两种空态分开说，都不许伪装成"有依据"。
   * @param row 一行改写
   * @returns 出处 chips 或一句空态
   */
  const renderSources = (row: GenerationRewriteRowView) => {
    if (row.sourceEvidenceIds.length > 0) {
      return (
        <ul className="mt-1 flex flex-wrap gap-1">
          {row.sourceEvidenceIds.map((evidenceId) => (
            <li key={evidenceId}>
              <DeskDisclosure
                action={`generate-source-${evidenceId}`}
                data-generate-source={evidenceId}
                open={evidenceId in bodies}
                onClick={() => toggleSource(evidenceId)}
              >
                {t('generate.sourceLine', { id: evidenceId })}
              </DeskDisclosure>
              {evidenceId in bodies && (
                <p data-generate-source-body={evidenceId} className="text-[11px] leading-relaxed text-slate-500">
                  {bodies[evidenceId] ?? t('generate.sourceGone')}
                </p>
              )}
            </li>
          ))}
        </ul>
      );
    }
    return (
      <p
        data-generate-source-empty={row.entryModeled ? 'no_verbatim' : 'not_modeled'}
        className="mt-1 text-[11px] leading-relaxed text-slate-500"
      >
        {row.entryModeled ? t('generate.sourceNoVerbatim') : t('generate.sourceNotModeled')}
      </p>
    );
  };

  /**
   * 展开/收起一条出处的正文：第一次点才去主进程取（一份产物不该把半本库推过进程边界）。
   * @param evidenceId 实体 id
   */
  const toggleSource = (evidenceId: string) => {
    if (evidenceId in bodies) {
      setBodies((current) => {
        const next = { ...current };
        delete next[evidenceId];
        return next;
      });
      return;
    }
    void run(t('generate.source'), () => bridge?.kb['profile.evidenceBody'](evidenceId), {
      apply: (value) => setBodies((current) => ({ ...current, [evidenceId]: value?.text ?? null })),
    });
  };

  /**
   * 一条换位的依据（4.5-02 的"可解释"就是这一行：谁被挪了、从第几位到第几位、凭什么）。
   * @param basis 一次换位
   * @returns 行节点
   */
  const renderReorder = (basis: GenerationReorderRowView) => (
    <li key={`${basis.level}-${basis.id}`} className="rounded border border-line p-2">
      <p data-generate-reorder={basis.level} className="text-xs text-slate-200">
        <span className="text-slate-400">
          {t(basis.level === 'section' ? 'generate.levelSection' : 'generate.levelEntry')}
        </span>
        · {basis.label} · {t('generate.moved', { from: basis.fromIndex + 1, to: basis.toIndex + 1 })}
      </p>
      {/* 零分那一行的依据不是分数，是"被顶下来的"：把 `相关性 0.00` 摆在界面上，
          等于告诉用户"我们没理由就挪了它"，而真实原因是前面有更强的项前移（`orderByScore` 把零分留在原序）。 */}
      <p className="text-[11px] leading-relaxed text-slate-500">
        {basis.score > 0
          ? t('generate.reorderScore', { score: basis.score.toFixed(2) })
          : t('generate.reorderDisplaced')}
      </p>
      {basis.hits.length > 0 && (
        <p data-generate-reorder-hits={basis.id} className="mt-1 text-[11px] leading-relaxed text-slate-400">
          {basis.hits.map((hit) => `${hit.label}（${hit.tokens.join(' / ')} · ${hit.score.toFixed(2)}）`).join('；')}
        </p>
      )}
    </li>
  );

  const selectedCount = checked.filter((isChecked) => isChecked).length;
  const canAccept =
    preview !== undefined && preview.receipt.outcome !== 'rejected' && (selectedCount > 0 || applyReorder);
  /**
   * 「接受」按不动的原因分三句说（07 稿④）：还没有产物、产物被事实校验拒了、有产物但一条都没勾——
   * 合成一句「现在不能接受」就等于让人猜该先做哪一步。
   */
  const acceptReason =
    busy !== undefined
      ? 'ACTION_BUSY'
      : preview === undefined
        ? 'NO_PREVIEW'
        : preview.receipt.outcome === 'rejected'
          ? 'OUTCOME_REJECTED'
          : !canAccept
            ? 'NOTHING_SELECTED'
            : undefined;
  /** 原因码 → 人话。 */
  const reasonLabel = (code?: string): string | undefined =>
    code === undefined ? undefined : t(`generate.reason.${code}`);
  /** 生成按不动的两种原因：JD 那栏还空着，或上一条动作在途。 */
  const runReason = jdText.trim() === '' ? 'JD_EMPTY' : busy !== undefined ? 'ACTION_BUSY' : undefined;

  return (
    <div
      ref={panelRef}
      data-testid="generate-panel"
      data-generate-seed={trail && trail.targetView === 'resume' ? (trail.sourceDetail ?? 'none') : 'none'}
      className="flex flex-col gap-4 rounded-lg border border-line bg-ink-950/60 p-4"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-slate-300" />
        <h2 className="text-sm font-semibold text-slate-200">{t('generate.heading')}</h2>
      </div>
      <p className="text-xs leading-relaxed text-slate-400">{t('generate.hint')}</p>

      <div className="flex flex-col gap-2">
        <DeskTextarea
          action="generate-jd"
          data-generate-field="jd"
          value={jdText}
          onValueChange={setJdText}
          rows={6}
          placeholder={t('generate.jdPlaceholder')}
        />
        <div className="flex items-center gap-2">
          <DeskButton
            action="run"
            markers={{ 'generate-action': 'run' }}
            disabled={runReason !== undefined}
            variant="line"
            compact
            busy={!!busy}
            disabledReason={runReason}
            disabledReasonLabel={reasonLabel(runReason)}
            onClick={generate}
          >
            <Sparkles size={12} />
            {t('generate.run')}
          </DeskButton>
          {preview && (
            <span
              data-generate-model={preview.receipt.modelStatus}
              className={`text-[11px] leading-relaxed ${MODEL_TONE[preview.receipt.modelStatus]}`}
            >
              {modelLegText(preview)}
            </span>
          )}
        </div>
      </div>

      {accepted && (
        // 写盘之后的读数留在界面上：接受用掉了提议态，没有这一行用户就看不见"到底写了几处"。
        <Banner tone="jade" markers={{ 'generate-accepted': '' }}>
          <div className="w-full">
            <p>
              {t('generate.accepted', {
                applied: accepted.appliedRewrites,
                sections: accepted.movedSections,
                entries: accepted.movedEntries,
                at: accepted.updatedAt,
              })}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{t('generate.acceptedRebind')}</p>
          </div>
        </Banner>
      )}

      {blocked && (
        <p data-generate-blocked className="text-xs leading-relaxed text-amber">
          {blocked}
        </p>
      )}

      {preview && (
        <div
          data-generate-outcome={preview.receipt.outcome}
          className={`flex flex-col gap-2 rounded border p-2 ${BLOCK_EDGE_CLASS[OUTCOME_TONE[preview.receipt.outcome]]} ${BLOCK_SURFACE_CLASS}`}
        >
          <p className="text-xs text-slate-200">{outcomeText(preview)}</p>
          <p data-generate-receipt className="text-[11px] leading-relaxed text-slate-500">
            {t('generate.receipt', {
              docId: preview.receipt.docId,
              prompt: preview.receipt.promptVersion ?? t('generate.promptNone'),
              retried: preview.checks.retried ? t('generate.retriedYes') : t('generate.retriedNo'),
            })}
          </p>
        </div>
      )}

      {preview && preview.receipt.outcome === 'rejected' && (
        // 拒绝产出这条路径不给"接受"按钮：这时候连产物都没有，按下去只能失败（4.5-05 的界面口径）。
        <div data-generate-rejected className="flex flex-col gap-1">
          <p className="text-xs leading-relaxed text-amber">{t('generate.needsHuman')}</p>
          <ul className="flex flex-col gap-1">
            {preview.checks.violations.map((violation) => (
              <li key={violation} data-generate-violation className="text-[11px] leading-relaxed text-slate-300">
                {violation}
              </li>
            ))}
          </ul>
          {preview.checks.violationCount > preview.checks.violations.length && (
            <p className="text-[11px] text-slate-500">
              {t('generate.violationsTruncated', { total: preview.checks.violationCount })}
            </p>
          )}
        </div>
      )}

      {preview && preview.receipt.outcome !== 'rejected' && (
        <>
          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-1 text-xs font-semibold text-slate-300">
              <ListChecks className="h-3 w-3" />
              {t('generate.rewritesHeading', { total: preview.rewrites.length })}
            </p>
            {preview.rewrites.length === 0 ? (
              <p data-generate-rewrites-empty className="text-[11px] leading-relaxed text-slate-500">
                {t('generate.rewritesEmpty')}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {preview.rewrites.map((row, index) => (
                  <li
                    key={`${row.sectionId}-${row.entryId}-${row.fieldKey}`}
                    className="rounded border border-line bg-ink-900/40 p-2"
                  >
                    <label className="flex items-start gap-2">
                      <DeskCheck
                        action={`generate-check-${index}`}
                        data-generate-check={index}
                        checked={checked[index] === true}
                        onCheckedChange={(isChecked) =>
                          setChecked((current) => current.map((previous, i) => (i === index ? isChecked : previous)))
                        }
                      />
                      <span className="flex min-w-0 flex-col gap-1">
                        <span data-generate-location={index} className="text-[11px] text-slate-400">
                          {row.sectionTitle} · {row.entryLabel} · {row.fieldKey}
                        </span>
                        <span data-generate-original={index} className="text-xs leading-relaxed text-slate-400">
                          {row.originalText}
                        </span>
                        <span data-generate-rewritten={index} className="text-xs leading-relaxed text-slate-100">
                          {row.rewrittenText}
                        </span>
                        {renderSources(row)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-1 text-xs font-semibold text-slate-300">
              <ArrowUpDown className="h-3 w-3" />
              {t('generate.reorderHeading', { count: preview.reorderBases.length })}
            </p>
            {preview.reorderBases.length === 0 ? (
              <p data-generate-reorder-empty className="text-[11px] leading-relaxed text-slate-500">
                {t('generate.reorderEmpty')}
              </p>
            ) : (
              <>
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <DeskCheck
                    action="generate-reorder-apply"
                    data-generate-reorder-apply
                    checked={applyReorder}
                    onCheckedChange={setApplyReorder}
                  />
                  {t('generate.reorderApply', { count: preview.reorderBases.length })}
                </label>
                <ul className="flex flex-col gap-2">{preview.reorderBases.map(renderReorder)}</ul>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* 全 app 只有这一口会改那份工作副本，所以它是琥珀（本机写入）而不是描边；
                按不动的三种原因各说一句不同的话，见 `acceptReason`。 */}
            <DeskButton
              action="accept"
              markers={{ 'generate-action': 'accept' }}
              disabled={acceptReason !== undefined}
              variant="amber"
              compact
              busy={!!busy}
              disabledReason={acceptReason}
              disabledReasonLabel={reasonLabel(acceptReason)}
              onClick={accept}
            >
              <ShieldAlert size={12} />
              {t('generate.accept')}
            </DeskButton>
            <span data-generate-selected-count className="text-[11px] text-slate-500">
              {t('generate.selectedCount', { selected: selectedCount, total: preview.rewrites.length })}
            </span>
          </div>
        </>
      )}

      {notice && (
        <p data-generate-notice className="text-xs leading-relaxed text-slate-400">
          {notice}
        </p>
      )}
    </div>
  );
}
