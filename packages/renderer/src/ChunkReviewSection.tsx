import { ListPlus, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KbReviewRowView, KbReviewSectionRowView, KbReviseOpView } from '@auto-cc/shared';
import { Banner, DeskButton, DeskField, DeskTextarea, Tag } from './ui/controls';
import { useBridgeAction } from './useBridgeAction';

/**
 * custom 要素标题长度上限（字）：与主进程 `CUSTOM_TITLE_MAX_CHARS` 同值。
 * 界面这一格只用来提前把「新增 / 改名」按成按不动态并给出原因；真判据在主进程，
 * 这里拦不住的形状保存时仍会被结构化拒绝并把原因显示在 Banner 上（一处事实在主进程，§2.5）。
 */
const CUSTOM_TITLE_MAX_CHARS = 16;

/** 条目字段键 → 文案键：认得的键给人话，认不得的直接显示键名（不猜、不吞信息）。 */
const FIELD_LABEL_KEY: Record<string, string> = {
  text: 'chunkReview.fieldText',
  achievement: 'chunkReview.fieldAchievement',
  description: 'chunkReview.fieldDescription',
  company: 'chunkReview.fieldCompany',
  role: 'chunkReview.fieldRole',
  period: 'chunkReview.fieldPeriod',
  school: 'chunkReview.fieldSchool',
  major: 'chunkReview.fieldMajor',
};

/** 区块种类 → 既有 `resume.kind.*` 文案键（固定六类与 custom 共用同一张表）。 */
const KIND_LABEL_KEY: Record<KbReviewSectionRowView['kind'], string> = {
  summary: 'resume.kind.summary',
  experience: 'resume.kind.experience',
  education: 'resume.kind.education',
  skills: 'resume.kind.skills',
  project: 'resume.kind.project',
  campus: 'resume.kind.campus',
  custom: 'resume.kind.custom',
};

/** `entryId → fieldKey → 改过的字`：只存与主进程读数逐字不同的格子。 */
type DirtyTexts = Readonly<Record<string, Record<string, string>>>;

export interface ChunkReviewSectionProps {
  /** desk 当前选中的简历 id；undefined = 还没选，这一格只给一句引导。 */
  readonly docId: string | undefined;
  /** 当前选中的是变体（按 JD 生成的那一支）：素材源头只能是母版，变体下整格只读引导。 */
  readonly isVariant: boolean;
}

/**
 * 要素核对（chunk review）：导入后把简历按要素拆成一块一块，用户在这一格里逐块查看修改。
 *
 * 两条刻意的分界，读代码的人不该重新推断：
 * 1. **真相只有母版**：读数来自 `kb.profile.review`，写字只走 `kb.profile.revise` 然后由主进程同趟
 *    sync 重建 chunk；界面不缓存"上次的内容"，每次动作结束都重读（`useBridgeAction` 的 read）。
 * 2. **结构操作即时落、改字攒一批**：增删条目 / 增删改名要素都是一次明确的点击，立即走 revise，
 *    新条目的 id 由主进程确定性生成、重读回来再改它的字——界面不猜 id（猜 id 就是第二份事实）；
 *    只有逐字修改攒在本地，由「保存」一颗键批量提交。保存前结构已落库、文字未落库，所以 Banner
 *    会一直挂着「还有 N 处文字没保存」，不存在"看着改了其实没了"的静默态。
 */
export function ChunkReviewSection({ docId, isVariant }: ChunkReviewSectionProps) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [view, setView] = useState<KbReviewRowView>();
  const [dirty, setDirty] = useState<DirtyTexts>({});
  const [newSectionTitle, setNewSectionTitle] = useState('');
  const [renameTitles, setRenameTitles] = useState<Record<string, string>>({});

  /** 从主进程重读母版要素结构；变体 / 未选 / 读不到都交 Banner 说原因，不猜一份假结构。 */
  const read = useCallback(async () => {
    if (!docId) {
      setView(undefined);
      return;
    }
    const reply = await bridge?.kb['profile.review'](docId);
    if (reply?.ok) setView(reply.value);
  }, [bridge, docId]);

  const { busy, notice, noticeTone, resultOf, run, setNotice } = useBridgeAction(read);

  // 换文档就把草稿整体作废：上一份的脏字与改名草稿不能带到这一份。
  useEffect(() => {
    setView(undefined);
    setDirty({});
    setNewSectionTitle('');
    setRenameTitles({});
    setNotice(undefined);
  }, [docId, setNotice]);

  useEffect(() => {
    void read();
    if (!bridge) return;
    return bridge.on('kb/entities-changed', (event) => {
      // 别的文档的重建信号与这一格无关（同屏 KbPanel 也订阅这一条，各取各的）。
      if (event.docId && docId && event.docId !== docId) return;
      void read();
    });
  }, [bridge, docId, read]);

  /** 某一字段的显示值：脏草稿压在主进程读数之上，保存成功后草稿随重读失效。 */
  const fieldValue = (entryId: string, fieldKey: string, original: string): string =>
    dirty[entryId]?.[fieldKey] ?? original;

  /** 改一格字：与原文相同就从脏表里撤掉（打开又原样输回去不算一处改动）。 */
  const patchText = (entryId: string, fieldKey: string, original: string, value: string): void => {
    setDirty((previous) => {
      const entryPatch = { ...(previous[entryId] ?? {}) };
      if (value === original) delete entryPatch[fieldKey];
      else entryPatch[fieldKey] = value;
      const next = { ...previous };
      if (Object.keys(entryPatch).length === 0) delete next[entryId];
      else next[entryId] = entryPatch;
      return next;
    });
  };

  /** 当前还活着的条目集合：结构操作（删条 / 删要素）落库后，脏表里指向已删条目的格子在保存时丢弃。 */
  const liveEntryIds = useMemo(() => {
    const ids = new Set<string>();
    for (const section of view?.sections ?? []) for (const entry of section.entries) ids.add(entry.id);
    return ids;
  }, [view]);

  /** 攒下的文字修改条数（只数当前仍存在的条目）。 */
  const dirtyCount = useMemo(
    () =>
      Object.entries(dirty).reduce(
        (sum, [entryId, fields]) => (liveEntryIds.has(entryId) ? sum + Object.keys(fields).length : sum),
        0,
      ),
    [dirty, liveEntryIds],
  );

  /** 把所有结构操作收成一批：固定顺序只影响主进程逐条套用的报错位次。 */
  const runRevise = (ops: readonly KbReviseOpView[], label: string, describe: (applied: number) => string): void => {
    if (!docId) return;
    void run(label, () => bridge?.kb['profile.revise'](docId, ops), {
      describe: (receipt) => describe(receipt.applied),
    });
  };

  /** 加条目：结构立即落库，主进程生成新条目 id 后重读回来，人再在空条目里打字（界面不猜 id）。 */
  const addEntry = (sectionId: string): void => {
    setNotice(undefined);
    runRevise([{ op: 'entry.create', sectionId }], t('chunkReview.entryAdd'), () => t('chunkReview.entryAdded'));
  };

  /** 删条目：立即落库；该条目里还没保存的脏字随重读自然消失。 */
  const removeEntry = (sectionId: string, entryId: string): void => {
    setNotice(undefined);
    runRevise([{ op: 'entry.remove', sectionId, entryId }], t('chunkReview.entryRemove'), () =>
      t('chunkReview.entryRemoved'),
    );
  };

  /** 新增 custom 要素：标题本地先拦空 / 超长，主进程仍有同一判据兜底。 */
  const addSection = (): void => {
    const title = newSectionTitle.trim();
    if (title === '' || title.length > CUSTOM_TITLE_MAX_CHARS) return;
    setNotice(undefined);
    runRevise([{ op: 'section.create', title }], t('chunkReview.sectionAdd'), () => {
      setNewSectionTitle('');
      return t('chunkReview.sectionAdded', { title });
    });
  };

  /** 删除整个 custom 要素（固定六类不出现这颗键——editor-ops 会拒，界面连按的机会都不给）。 */
  const removeSection = (sectionId: string): void => {
    setNotice(undefined);
    runRevise([{ op: 'section.remove', sectionId }], t('chunkReview.sectionRemove'), () =>
      t('chunkReview.sectionRemoved'),
    );
  };

  /** custom 改名：输入框值未变 / 空 / 超长时按不动，原因码挂在节点上。 */
  const renameSection = (section: KbReviewSectionRowView): void => {
    const title = (renameTitles[section.id] ?? '').trim();
    if (title === '' || title === section.title || title.length > CUSTOM_TITLE_MAX_CHARS) return;
    setNotice(undefined);
    runRevise([{ op: 'section.rename', sectionId: section.id, title }], t('chunkReview.sectionRename'), () =>
      t('chunkReview.sectionRenamed', { title }),
    );
  };

  /** 保存攒下的文字修改：一颗键一批 ops，任一条被拒则整批不落（主进程的整批语义）。 */
  const saveTexts = (): void => {
    if (!docId || dirtyCount === 0) return;
    const ops: KbReviseOpView[] = [];
    for (const section of view?.sections ?? []) {
      for (const entry of section.entries) {
        for (const field of entry.fields) {
          const changed = dirty[entry.id]?.[field.key];
          if (changed !== undefined && changed !== field.value) {
            ops.push({
              op: 'entry.text',
              sectionId: section.id,
              entryId: entry.id,
              fieldKey: field.key,
              value: changed,
            });
          }
        }
      }
    }
    setNotice(undefined);
    void run(t('chunkReview.save'), () => bridge?.kb['profile.revise'](docId, ops), {
      apply: () => setDirty({}),
      describe: (receipt) => t('chunkReview.saved', { applied: receipt.applied }),
    });
  };

  const newTitleDeadReason =
    newSectionTitle.trim() === ''
      ? { code: 'chunk-review-empty-title', label: t('chunkReview.sectionTitleNeeded') }
      : newSectionTitle.trim().length > CUSTOM_TITLE_MAX_CHARS
        ? {
            code: 'chunk-review-title-too-long',
            label: t('chunkReview.sectionTitleTooLong', { max: CUSTOM_TITLE_MAX_CHARS }),
          }
        : undefined;

  // 未选文档 / 选中的是变体：不给任何写控件，只说下一步去哪（变体不是素材源头）。
  if (!docId) {
    return (
      <div className="flex min-w-0 flex-col gap-2" data-testid="chunk-review">
        <p className="text-[11px] leading-relaxed text-slate-500" data-testid="chunk-review-empty">
          {t('chunkReview.empty')}
        </p>
      </div>
    );
  }
  if (isVariant) {
    return (
      <div className="flex min-w-0 flex-col gap-2" data-testid="chunk-review">
        <Banner tone="amber" markers={{ testid: 'chunk-review-variant' }}>
          {t('chunkReview.variantHint')}
        </Banner>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="chunk-review" data-doc-id={docId}>
      {notice && (
        <Banner tone={noticeTone} markers={{ testid: 'chunk-review-notice' }} className="break-all">
          {notice}
        </Banner>
      )}
      <p className="text-[11px] leading-relaxed text-slate-400">{t('chunkReview.hint')}</p>

      {view !== undefined && view.sections.length === 0 && (
        <p className="text-[11px] text-slate-500" data-testid="chunk-review-no-sections">
          {t('chunkReview.noSections')}
        </p>
      )}

      {view?.sections.map((section) => {
        const isCustom = section.kind === 'custom';
        const renameDraft = renameTitles[section.id] ?? section.title;
        const renameDead =
          renameDraft.trim() === ''
            ? { code: 'chunk-review-empty-title', label: t('chunkReview.sectionTitleNeeded') }
            : renameDraft.trim().length > CUSTOM_TITLE_MAX_CHARS
              ? {
                  code: 'chunk-review-title-too-long',
                  label: t('chunkReview.sectionTitleTooLong', { max: CUSTOM_TITLE_MAX_CHARS }),
                }
              : renameDraft.trim() === section.title
                ? { code: 'chunk-review-title-unchanged', label: t('chunkReview.sectionTitleUnchanged') }
                : undefined;
        return (
          <section
            key={section.id}
            data-testid="chunk-review-section"
            data-section-id={section.id}
            data-section-kind={section.kind}
            className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-ink-850 p-2"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Tag tone={isCustom ? 'amber' : 'celadon'}>{t(KIND_LABEL_KEY[section.kind])}</Tag>
              {isCustom ? (
                <>
                  <DeskField
                    action="chunk-review-rename-title"
                    className="min-w-0 flex-1"
                    value={renameDraft}
                    maxLength={CUSTOM_TITLE_MAX_CHARS * 2}
                    aria-label={t('chunkReview.sectionRename')}
                    onValueChange={(value) => setRenameTitles((previous) => ({ ...previous, [section.id]: value }))}
                  />
                  <DeskButton
                    action="chunk-review-rename"
                    compact
                    busy={busy === t('chunkReview.sectionRename')}
                    disabled={renameDead !== undefined}
                    disabledReason={renameDead?.code}
                    disabledReasonLabel={renameDead?.label}
                    onClick={() => renameSection(section)}
                  >
                    <Pencil size={12} aria-hidden />
                    {t('chunkReview.sectionRename')}
                  </DeskButton>
                  <DeskButton
                    action="chunk-review-remove-section"
                    variant="seal"
                    compact
                    busy={busy === t('chunkReview.sectionRemove')}
                    markers={{ section: section.id }}
                    onClick={() => removeSection(section.id)}
                  >
                    <Trash2 size={12} aria-hidden />
                    {t('chunkReview.sectionRemove')}
                  </DeskButton>
                </>
              ) : (
                <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{section.title}</span>
              )}
            </div>

            <ul className="flex min-w-0 flex-col gap-2">
              {section.entries.map((entry) => (
                <li
                  key={entry.id}
                  data-testid="chunk-review-entry"
                  data-entry-id={entry.id}
                  className="flex min-w-0 flex-col gap-1 rounded-md border border-line px-1.5 py-1"
                >
                  {entry.fields.map((field) => (
                    <label key={field.key} className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[11px] text-slate-500">
                        {t(FIELD_LABEL_KEY[field.key] ?? 'chunkReview.fieldUnknown', {
                          key: field.key,
                        })}
                      </span>
                      <DeskTextarea
                        action="chunk-review-text"
                        size="meta"
                        rows={Math.min(6, Math.max(1, field.value.split('\n').length))}
                        value={fieldValue(entry.id, field.key, field.value)}
                        onValueChange={(value) => patchText(entry.id, field.key, field.value, value)}
                      />
                    </label>
                  ))}
                  <div className="flex justify-end">
                    <DeskButton
                      action="chunk-review-remove-entry"
                      variant="seal"
                      compact
                      busy={busy === t('chunkReview.entryRemove')}
                      markers={{ section: section.id, entry: entry.id }}
                      onClick={() => removeEntry(section.id, entry.id)}
                    >
                      <Trash2 size={12} aria-hidden />
                      {t('chunkReview.entryRemove')}
                    </DeskButton>
                  </div>
                </li>
              ))}
            </ul>

            <div className="flex">
              <DeskButton
                action="chunk-review-add-entry"
                compact
                busy={busy === t('chunkReview.entryAdd')}
                markers={{ section: section.id }}
                onClick={() => addEntry(section.id)}
              >
                <ListPlus size={12} aria-hidden />
                {t('chunkReview.entryAdd')}
              </DeskButton>
            </div>
          </section>
        );
      })}

      {/* 新增 custom 要素：标题 + 一颗键；空 / 超长时按不动并给出原因（6.2-06）。 */}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg border border-dashed border-line p-2">
        <DeskField
          action="chunk-review-new-section-title"
          className="min-w-0 flex-1"
          placeholder={t('chunkReview.sectionAddPlaceholder')}
          value={newSectionTitle}
          maxLength={CUSTOM_TITLE_MAX_CHARS * 2}
          onValueChange={setNewSectionTitle}
        />
        <DeskButton
          action="chunk-review-add-section"
          compact
          busy={busy === t('chunkReview.sectionAdd')}
          disabled={newTitleDeadReason !== undefined}
          disabledReason={newTitleDeadReason?.code}
          disabledReasonLabel={newTitleDeadReason?.label}
          onClick={addSection}
        >
          <Plus size={12} aria-hidden />
          {t('chunkReview.sectionAdd')}
        </DeskButton>
      </div>

      {/* 保存条：有脏字才可按；保存前那句提醒常驻，结构改动与文字改动的落库时刻不一样，必须看得见。 */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <DeskButton
          action="chunk-review-save"
          variant="solid"
          busy={busy === t('chunkReview.save')}
          result={resultOf(t('chunkReview.save'))}
          doneLabel={t('chunkReview.saveDone')}
          disabled={dirtyCount === 0}
          disabledReason="chunk-review-no-change"
          disabledReasonLabel={t('chunkReview.noChange')}
          onClick={saveTexts}
        >
          <Save size={13} aria-hidden />
          {t('chunkReview.save')}
        </DeskButton>
        {dirtyCount > 0 && (
          <Tag tone="amber" data-testid="chunk-review-dirty">
            {t('chunkReview.dirty', { count: dirtyCount })}
          </Tag>
        )}
      </div>
    </div>
  );
}
