import {
  AlignLeft,
  Briefcase,
  CircleUser,
  FolderKanban,
  GraduationCap,
  ListPlus,
  Pencil,
  Plus,
  Save,
  Shapes,
  Sparkles,
  Target,
  Trash2,
  Users,
  Wrench,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  GenerationRewriteRowView,
  KbIntentFieldRowKey,
  KbProfileFieldRowKey,
  KbReviewRowView,
  KbReviewSectionRowView,
  KbReviseOpView,
} from '@auto-cc/shared';
import { Banner, BLOCK_EDGE_CLASS, BLOCK_SURFACE_CLASS, DeskButton, DeskField, DeskTextarea, Tag } from './ui/controls';
import { DeskActionRow, DeskHint, DeskSection } from './ui/disclosure';
import { useBridgeAction } from './useBridgeAction';

/** 图标在这一格只当组头的记号用，尺寸统一 13px（与 `DeskTab` 同一档）。 */
type GroupIcon = ComponentType<{ size?: number; className?: string }>;

/**
 * 三处长度上限：与主进程 `CUSTOM_TITLE_MAX_CHARS` / `PROFILE_VALUE_MAX_CHARS` / `INTENT_VALUE_MAX_CHARS` 同值。
 * 界面这三只数只用来把输入框的 `maxLength` 与「按不动」的原因说成人话；真判据在主进程（§2.5），
 * 拦不住的形状保存时仍会被结构化拒绝并把原因显示在 Banner 上。
 */
const CUSTOM_TITLE_MAX_CHARS = 16;
const PROFILE_VALUE_MAX_CHARS = 60;
const INTENT_VALUE_MAX_CHARS = 40;

/** 邮箱形状（与主进程 `EMAIL_SHAPE` 同式）：只用来在保存前把那一格标红并说清原因。 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** 求职意向区块的稳定 id（主进程 `INTENT_SECTION_ID`）：它不是一只普通 custom 区块，改名与删除都不给。 */
const INTENT_SECTION_ID = 'intent';

/** 抬头四格的显示顺序：姓名先，联系方式随后（BOSS 式在线简历的同一顺序）。 */
const PROFILE_FIELDS: readonly KbProfileFieldRowKey[] = ['name', 'phone', 'email', 'location'];

/** 求职意向四格的显示顺序（主进程 `INTENT_FIELD_KEYS` 的同一顺序）。 */
const INTENT_FIELDS: readonly KbIntentFieldRowKey[] = ['expectRole', 'expectCity', 'expectSalary', 'expectStart'];

/** 条目字段键 → 文案键：认得的键给人话，认不得的直接显示键名（不猜、不吞信息）。 */
const FIELD_LABEL_KEY: Record<string, string> = {
  text: 'resumeForm.fieldText',
  achievement: 'resumeForm.fieldAchievement',
  description: 'resumeForm.fieldDescription',
  company: 'resumeForm.fieldCompany',
  role: 'resumeForm.fieldRole',
  period: 'resumeForm.fieldPeriod',
  school: 'resumeForm.fieldSchool',
  major: 'resumeForm.fieldMajor',
};

/** 求职意向四格 → 文案键（与条目字段分开一张表：这四格不在条目里，键名由主进程钉死，可以穷举）。 */
const INTENT_LABEL_KEY: Record<KbIntentFieldRowKey, string> = {
  expectRole: 'resumeForm.fieldExpectRole',
  expectCity: 'resumeForm.fieldExpectCity',
  expectSalary: 'resumeForm.fieldExpectSalary',
  expectStart: 'resumeForm.fieldExpectStart',
};

/** 抬头四格 → 文案键（这四格不在条目里，键名与条目字段不共用一张表）。 */
const PROFILE_LABEL_KEY: Record<KbProfileFieldRowKey, string> = {
  name: 'resumeForm.profileName',
  phone: 'resumeForm.profilePhone',
  email: 'resumeForm.profileEmail',
  location: 'resumeForm.profileLocation',
};

/**
 * 条目字段的显示次序：短标签（单位 / 职位 / 学校 / 专业 / 时间）在上，成段的正文在下。
 * 读回来的字段是按键名排序的（`normalize.ts`），直接照那个序摆会把「成果」排在「单位」前面。
 */
const FIELD_ORDER: Record<string, number> = {
  company: 0,
  role: 1,
  school: 2,
  major: 3,
  period: 4,
  text: 5,
  description: 6,
  achievement: 7,
};

/** 这几个键是成段的话，用多行文本域；其余是短标签，用单行输入框。 */
const LONG_FIELD_KEYS: ReadonlySet<string> = new Set(['text', 'description', 'achievement']);

/** 区块种类 → 既有 `resume.kind.*` 文案键与组头图标（固定六类与 custom 共用同一张表）。 */
const KIND_VIEW: Record<KbReviewSectionRowView['kind'], { labelKey: string; icon: GroupIcon }> = {
  summary: { labelKey: 'resume.kind.summary', icon: AlignLeft },
  experience: { labelKey: 'resume.kind.experience', icon: Briefcase },
  education: { labelKey: 'resume.kind.education', icon: GraduationCap },
  skills: { labelKey: 'resume.kind.skills', icon: Wrench },
  project: { labelKey: 'resume.kind.project', icon: FolderKanban },
  campus: { labelKey: 'resume.kind.campus', icon: Users },
  custom: { labelKey: 'resume.kind.custom', icon: Shapes },
};

/**
 * 分组的先后：经历类在前（招聘方先读这两块），技能与校园随后，概述垫底，自定义最后。
 * 同一种类里保持文档原序（`Array.prototype.sort` 稳定），所以同一份简历每次读回来分组次序一致。
 */
const KIND_ORDER: Record<KbReviewSectionRowView['kind'], number> = {
  experience: 0,
  project: 1,
  education: 2,
  skills: 3,
  campus: 4,
  summary: 5,
  custom: 6,
};

/** `entryId → fieldKey → 改过的字`：只存与主进程读数逐字不同的格子。 */
type DirtyTexts = Readonly<Record<string, Record<string, string>>>;

/** 一份 AI 建议的定位键：改写行自带这三个字段，界面上按它贴到对应那一格旁边。 */
const suggestionKeyOf = (sectionId: string, entryId: string, fieldKey: string): string =>
  `${sectionId}\u0000${entryId}\u0000${fieldKey}`;

export interface ResumeFormPanelProps {
  /** desk 当前选中的简历 id；undefined = 还没选，这一格只给一句引导。 */
  readonly docId: string | undefined;
  /** 当前选中的是变体（按 JD 生成的那一支）：素材源头只能是母版，变体下整格只读引导。 */
  readonly isVariant: boolean;
  /**
   * 「按岗位改写」那一趟留下的改写建议（`GenerationRewriteRowView[]`，可为空）。
   * 读数由 desk 持有、经 `GeneratePanel.onPreview` 递上来：表单不自己跑第二条 LLM 通道（§2.5），
   * 它只做一件事——把某一条建议的文字填进对应那一格的**草稿**，落库仍走「保存」那一批。
   */
  readonly suggestions?: readonly GenerationRewriteRowView[];
}

/**
 * 在线简历表单（BOSS 式）：导入之后简历以「抬头 + 求职意向 + 各类经历」的分组表单呈现，人在这里改内容。
 *
 * 四条刻意的分界，读代码的人不该重新推断：
 * 1. **真相只有母版**：读数来自 `kb.profile.review`，写字只走 `kb.profile.revise`，改完由主进程同趟 sync
 *    重建素材与索引；界面不缓存"上次的内容"，每次动作结束都重读（`useBridgeAction` 的 read）。
 * 2. **打字只进草稿，落库要点「保存」**（裁定㉚）：抬头、求职意向、条目正文三类改动都攒在本地，
 *    一颗「保存」把它们收成**一批** op 提交——主进程的整批语义（任一条被拒则半条都不落）天然对上
 *    "一次保存"。结构操作（加条 / 删条 / 增删改名自定义要素）是一次明确的点击，立即落库。
 * 3. **新条目的 id 由主进程生成**：加一条之后重读回来再填字，界面不猜 id（猜 id 就是第二份事实）。
 * 4. **纸面编辑器管版面，这里管内容**：本表单不碰模板、不碰 PDF（用户 2026-10-26 的口径），
 *    两个入口在界面上分开写清。
 * @param props 见 `ResumeFormPanelProps`
 * @returns 一格分组表单；未选文档或选中变体时只给一句引导，不给任何写控件
 */
export function ResumeFormPanel({ docId, isVariant, suggestions }: ResumeFormPanelProps) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [view, setView] = useState<KbReviewRowView>();
  const [dirty, setDirty] = useState<DirtyTexts>({});
  const [dirtyProfile, setDirtyProfile] = useState<Partial<Record<KbProfileFieldRowKey, string>>>({});
  const [dirtyIntent, setDirtyIntent] = useState<Partial<Record<KbIntentFieldRowKey, string>>>({});
  const [newSectionTitle, setNewSectionTitle] = useState('');
  const [renameTitles, setRenameTitles] = useState<Record<string, string>>({});

  /** 从主进程重读母版的抬头与要素结构；变体 / 未选 / 读不到都交 Banner 说原因，不猜一份假结构。 */
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
    setDirtyProfile({});
    setDirtyIntent({});
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

  /** 抬头某一格的原值（联系方式缺项是 `null`，界面上显示成空串）。 */
  const profileOriginal = useCallback(
    (field: KbProfileFieldRowKey): string => {
      if (!view) return '';
      return field === 'name' ? view.profile.name : (view.profile.contact[field] ?? '');
    },
    [view],
  );

  /** 求职意向区块（可能整块还没有：导入的原文里没写意向时它不存在，写第一格才由主进程补出来）。 */
  const intentEntry = useMemo(
    () => view?.sections.find((section) => section.id === INTENT_SECTION_ID)?.entries[0],
    [view],
  );

  /** 求职意向某一格的原值；区块或格子还不存在时是空串（不是"读不到"，是"还没写"）。 */
  const intentOriginal = useCallback(
    (field: KbIntentFieldRowKey): string =>
      intentEntry?.fields.find((candidate) => candidate.key === field)?.value ?? '',
    [intentEntry],
  );

  /** 意向区块里那段自由正文（导入时原文那一句）：只在有内容时显示，不长出一格空的。 */
  const intentNote = useMemo(() => {
    const note = intentEntry?.fields.find((candidate) => candidate.key === 'text');
    return note === undefined || note.value.trim() === '' ? undefined : note;
  }, [intentEntry]);

  /** 某一格此刻显示的值：草稿压在主进程读数之上，保存成功后草稿随重读失效。 */
  const fieldValue = (entryId: string, fieldKey: string, original: string): string =>
    dirty[entryId]?.[fieldKey] ?? original;

  /**
   * 改一格字：与原文相同就从草稿表里撤掉（打开又原样输回去不算一处改动）。
   * @param patch 草稿表的写入器（三类草稿共用这一条撤掉逻辑，只是各写各的表）
   * @param original 主进程读回来的原值
   * @param value 人刚敲进去的值
   */
  const patchEntryText = (entryId: string, fieldKey: string, original: string, value: string): void => {
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

  /** 改抬头一格（与原文相同即撤掉草稿）。 */
  const patchProfile = (field: KbProfileFieldRowKey, value: string): void => {
    const original = profileOriginal(field);
    setDirtyProfile((previous) => {
      const next = { ...previous };
      if (value === original) delete next[field];
      else next[field] = value;
      return next;
    });
  };

  /** 改求职意向一格（与原文相同即撤掉草稿）。 */
  const patchIntent = (field: KbIntentFieldRowKey, value: string): void => {
    const original = intentOriginal(field);
    setDirtyIntent((previous) => {
      const next = { ...previous };
      if (value === original) delete next[field];
      else next[field] = value;
      return next;
    });
  };

  /** 当前还活着的条目集合：结构操作（删条 / 删要素）落库后，草稿里指向已删条目的格子在保存时丢弃。 */
  const liveEntryIds = useMemo(() => {
    const ids = new Set<string>();
    for (const section of view?.sections ?? []) for (const entry of section.entries) ids.add(entry.id);
    return ids;
  }, [view]);

  /** 攒下的改动条数（条目那一部分只数当前仍存在的条目）。 */
  const entryDirtyCount = useMemo(
    () =>
      Object.entries(dirty).reduce(
        (sum, [entryId, fields]) => (liveEntryIds.has(entryId) ? sum + Object.keys(fields).length : sum),
        0,
      ),
    [dirty, liveEntryIds],
  );
  const profileDirtyCount = PROFILE_FIELDS.filter((field) => dirtyProfile[field] !== undefined).length;
  const intentDirtyCount = INTENT_FIELDS.filter((field) => dirtyIntent[field] !== undefined).length;
  const dirtyCount = entryDirtyCount + profileDirtyCount + intentDirtyCount;

  /** 建议按定位键索引：一格至多一条（主进程同一格只留最后一条改写）。 */
  const suggestionByKey = useMemo(() => {
    const index = new Map<string, GenerationRewriteRowView>();
    for (const row of suggestions ?? []) index.set(suggestionKeyOf(row.sectionId, row.entryId, row.fieldKey), row);
    return index;
  }, [suggestions]);

  /** 把一批结构操作交给主进程：固定顺序只影响逐条套用时的报错位次。 */
  const runRevise = (ops: readonly KbReviseOpView[], label: string, describe: (applied: number) => string): void => {
    if (!docId) return;
    void run(label, () => bridge?.kb['profile.revise'](docId, ops), {
      describe: (receipt) => describe(receipt.applied),
    });
  };

  /** 加一条：结构立即落库，主进程生成新条目 id 后重读回来，人再在空条目里打字（界面不猜 id）。 */
  const addEntry = (sectionId: string): void => {
    setNotice(undefined);
    runRevise([{ op: 'entry.create', sectionId }], t('resumeForm.entryAdd'), () => t('resumeForm.entryAdded'));
  };

  /** 删一条：立即落库；该条目里还没保存的草稿随重读自然消失。 */
  const removeEntry = (sectionId: string, entryId: string): void => {
    setNotice(undefined);
    runRevise([{ op: 'entry.remove', sectionId, entryId }], t('resumeForm.entryRemove'), () =>
      t('resumeForm.entryRemoved'),
    );
  };

  /** 新增自定义要素：标题本地先拦空 / 超长，主进程仍有同一判据兜底。 */
  const addSection = (): void => {
    const title = newSectionTitle.trim();
    if (title === '' || title.length > CUSTOM_TITLE_MAX_CHARS) return;
    setNotice(undefined);
    runRevise([{ op: 'section.create', title }], t('resumeForm.sectionAdd'), () => {
      setNewSectionTitle('');
      return t('resumeForm.sectionAdded', { title });
    });
  };

  /** 删除整个自定义要素（固定六类与求职意向都不出现这颗键——editor-ops 会拒，界面连按的机会都不给）。 */
  const removeSection = (sectionId: string): void => {
    setNotice(undefined);
    runRevise([{ op: 'section.remove', sectionId }], t('resumeForm.sectionRemove'), () =>
      t('resumeForm.sectionRemoved'),
    );
  };

  /** 自定义要素改名：输入框值未变 / 空 / 超长时按不动，原因码挂在节点上。 */
  const renameSection = (section: KbReviewSectionRowView): void => {
    const title = (renameTitles[section.id] ?? '').trim();
    if (title === '' || title === section.title || title.length > CUSTOM_TITLE_MAX_CHARS) return;
    setNotice(undefined);
    runRevise([{ op: 'section.rename', sectionId: section.id, title }], t('resumeForm.sectionRename'), () =>
      t('resumeForm.sectionRenamed', { title }),
    );
  };

  /**
   * 把一条 AI 建议填进对应那一格的草稿（不立刻落库）：落库仍由「保存」那一批走同一个写口。
   * @param row 一条改写建议（它的 `rewrittenText` 已过主进程的事实校验）
   * @param original 那一格此刻的原值，用于"改回原样就撤掉草稿"这条判定
   */
  const adoptSuggestion = (row: GenerationRewriteRowView, original: string): void => {
    patchEntryText(row.entryId, row.fieldKey, original, row.rewrittenText);
  };

  /** 姓名草稿（没改过就是原值）：空白时保存按不动——主进程会以 `empty-value` 拒掉整批。 */
  const nameDraft = (dirtyProfile.name ?? profileOriginal('name')).trim();
  /** 邮箱草稿：非空且形状不对时保存按不动（主进程同一判据是 `bad-email`）。 */
  const emailDraft = (dirtyProfile.email ?? profileOriginal('email')).trim();

  /**
   * 「保存」按不动的原因（6.2-06：按不动必须说得出为什么）。
   * 三种口径分开说：没有改动、姓名被清空、邮箱形状不对——合成一句「现在不能保存」等于让人猜哪一格错了。
   */
  const saveDeadReason =
    dirtyCount === 0
      ? 'resume-form-no-change'
      : nameDraft === ''
        ? 'resume-form-name-needed'
        : emailDraft !== '' && !EMAIL_SHAPE.test(emailDraft)
          ? 'resume-form-email-bad'
          : undefined;
  /** 原因码 → 人话（码的前缀在文案键里不重复出现，所以这里削掉它再拼键）。 */
  const saveDeadLabel =
    saveDeadReason === undefined ? undefined : t(`resumeForm.reason.${saveDeadReason.slice('resume-form-'.length)}`);

  /** 保存攒下的改动：抬头 → 求职意向 → 条目正文，一批 op，任一条被拒则整批不落（主进程的整批语义）。 */
  const save = (): void => {
    if (!docId || dirtyCount === 0 || saveDeadReason !== undefined) return;
    const ops: KbReviseOpView[] = [];
    for (const field of PROFILE_FIELDS) {
      const value = dirtyProfile[field];
      if (value !== undefined && value !== profileOriginal(field)) ops.push({ op: 'profile.field', field, value });
    }
    for (const field of INTENT_FIELDS) {
      const value = dirtyIntent[field];
      if (value !== undefined && value !== intentOriginal(field)) ops.push({ op: 'intent.field', field, value });
    }
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
    void run(t('resumeForm.save'), () => bridge?.kb['profile.revise'](docId, ops), {
      apply: () => {
        setDirty({});
        setDirtyProfile({});
        setDirtyIntent({});
      },
      describe: (receipt) => t('resumeForm.saved', { applied: receipt.applied }),
    });
  };

  /** 新增要素那颗键的按不动原因（空标题 / 超长）。 */
  const newTitleDeadReason =
    newSectionTitle.trim() === ''
      ? { code: 'resume-form-empty-title', label: t('resumeForm.sectionTitleNeeded') }
      : newSectionTitle.trim().length > CUSTOM_TITLE_MAX_CHARS
        ? {
            code: 'resume-form-title-too-long',
            label: t('resumeForm.sectionTitleTooLong', { max: CUSTOM_TITLE_MAX_CHARS }),
          }
        : undefined;

  /** 内容分组的次序：求职意向单独一组（它在下面第二格），其余按 `KIND_ORDER` 排。 */
  const contentSections = useMemo(() => {
    const rows = (view?.sections ?? []).filter((section) => section.id !== INTENT_SECTION_ID);
    return [...rows].sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]);
  }, [view]);

  /**
   * 一条 entry 里的字段按显示次序排（短标签在上、成段正文在下）。
   * @param fields 主进程读回来的字段序列（按键名排序）
   * @returns 同一批字段的显示序
   */
  const orderedFields = <T extends { readonly key: string }>(fields: readonly T[]): T[] =>
    [...fields].sort((left, right) => (FIELD_ORDER[left.key] ?? 99) - (FIELD_ORDER[right.key] ?? 99));

  /**
   * 一格字段：短标签走单行输入框，成段的话走多行文本域；改过的格子右侧挂一枚「未保存」记号，
   * 有 AI 建议时在格子下面长出那一块建议（采纳即填进草稿，不立刻落库）。
   * @param sectionId 区块 id（建议的定位键之一）
   * @param entryId 条目 id
   * @param field 主进程读回来的那一格（含 `locked` / `factKey`）
   * @returns 一格带标签的输入控件
   */
  const renderField = (
    sectionId: string,
    entryId: string,
    field: { key: string; value: string; locked: boolean },
  ): ReactNode => {
    const value = fieldValue(entryId, field.key, field.value);
    const isDirty = value !== field.value;
    const suggestion = suggestionByKey.get(suggestionKeyOf(sectionId, entryId, field.key));
    const label = (
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {t(FIELD_LABEL_KEY[field.key] ?? 'resumeForm.fieldUnknown', { key: field.key })}
        {field.locked && <Tag tone="amber">{t('resume.fieldLocked')}</Tag>}
        {isDirty && <Tag tone="celadon">{t('resumeForm.unsaved')}</Tag>}
      </span>
    );
    const shared = {
      action: 'resume-form-field',
      label,
      className: 'min-w-0',
      'data-field-key': field.key,
      'data-entry-id': entryId,
      'data-section-id': sectionId,
    };
    return (
      <div key={field.key} className="flex min-w-0 flex-col gap-1">
        {LONG_FIELD_KEYS.has(field.key) ? (
          <DeskTextarea
            {...shared}
            rows={Math.min(10, Math.max(2, value.split('\n').length + Math.floor(value.length / 28)))}
            value={value}
            onValueChange={(next) => patchEntryText(entryId, field.key, field.value, next)}
          />
        ) : (
          <DeskField
            {...shared}
            value={value}
            onValueChange={(next) => patchEntryText(entryId, field.key, field.value, next)}
          />
        )}
        {suggestion && (
          <div
            data-testid="resume-form-ai"
            data-ai-entry={entryId}
            data-ai-field={field.key}
            className={`flex min-w-0 flex-col gap-1 rounded-md border px-2 py-1.5 ${BLOCK_EDGE_CLASS.amber} ${BLOCK_SURFACE_CLASS}`}
          >
            <p className="flex min-w-0 items-center gap-1 text-[11px] text-slate-400">
              <Sparkles size={11} className="shrink-0 text-amber" aria-hidden />
              {t('resumeForm.aiSuggest', { section: suggestion.sectionTitle, entry: suggestion.entryLabel })}
            </p>
            <p className="text-xs leading-relaxed text-slate-200">{suggestion.rewrittenText}</p>
            <DeskActionRow>
              <DeskButton
                action="resume-form-ai-adopt"
                compact
                variant="amber"
                markers={{ entry: entryId, field: field.key }}
                onClick={() => adoptSuggestion(suggestion, field.value)}
              >
                <Plus size={12} aria-hidden />
                {t('resumeForm.aiAdopt')}
              </DeskButton>
            </DeskActionRow>
          </div>
        )}
      </div>
    );
  };

  // 未选文档 / 选中的是变体：不给任何写控件，只说下一步去哪（变体不是素材源头）。
  if (!docId) {
    return (
      <div className="flex min-w-0 flex-col gap-2" data-testid="resume-form">
        <p className="text-[11px] leading-relaxed text-slate-500" data-testid="resume-form-empty">
          {t('resumeForm.empty')}
        </p>
      </div>
    );
  }
  if (isVariant) {
    return (
      <div className="flex min-w-0 flex-col gap-2" data-testid="resume-form">
        <Banner tone="amber" markers={{ testid: 'resume-form-variant' }}>
          {t('resumeForm.variantHint')}
        </Banner>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="resume-form" data-doc-id={docId}>
      {notice && (
        <Banner tone={noticeTone} markers={{ testid: 'resume-form-notice' }} className="break-all">
          {notice}
        </Banner>
      )}

      {/* 三句说明收成三枚问号（2026-10-26 换装裁定「提示文案用 icon + 气泡」）：
          它们说的是"这一格怎么用"，不是当前读数，摊成三段正文会把表单往下推掉一屏。 */}
      <DeskActionRow className="items-start">
        <DeskHint id="resume-form-hint-draft" iconOnly label={t('resumeForm.hintDraftTitle')}>
          {t('resumeForm.hintDraft')}
        </DeskHint>
        <DeskHint id="resume-form-hint-fact" iconOnly label={t('resumeForm.hintFactTitle')}>
          {t('resumeForm.hintFact')}
        </DeskHint>
        {(suggestions?.length ?? 0) > 0 && (
          <DeskHint id="resume-form-hint-ai" iconOnly label={t('resumeForm.hintAiTitle')}>
            {t('resumeForm.hintAi', { count: suggestions?.length ?? 0 })}
          </DeskHint>
        )}
      </DeskActionRow>

      {view !== undefined && view.sections.length === 0 && (
        <p className="text-[11px] text-slate-500" data-testid="resume-form-no-sections">
          {t('resumeForm.noSections')}
        </p>
      )}

      {/* ① 基本信息：抬头四格。它是招聘方读到的第一行，所以永远排在最前、默认展开。 */}
      <DeskSection
        id="resume.form.profile"
        defaultOpen
        markers={{ testid: 'resume-form-group-profile' }}
        title={
          <span className="flex min-w-0 items-center gap-1.5">
            <CircleUser size={13} className="shrink-0 text-slate-400" aria-hidden />
            {t('resumeForm.groupProfile')}
          </span>
        }
        summary={
          view === undefined
            ? t('resumeForm.groupLoading')
            : view.profile.name.trim() === ''
              ? t('resumeForm.groupProfileEmpty')
              : view.profile.name
        }
      >
        <div className="flex min-w-0 flex-col gap-2">
          {PROFILE_FIELDS.map((field) => {
            const original = profileOriginal(field);
            const value = dirtyProfile[field] ?? original;
            const isInvalid =
              (field === 'name' && value.trim() === '') ||
              (field === 'email' && value.trim() !== '' && !EMAIL_SHAPE.test(value.trim()));
            return (
              <DeskField
                key={field}
                action="resume-form-profile"
                data-profile-field={field}
                label={
                  <span className="flex min-w-0 items-center gap-1">
                    {t(PROFILE_LABEL_KEY[field])}
                    {value !== original && <Tag tone="celadon">{t('resumeForm.unsaved')}</Tag>}
                  </span>
                }
                className="min-w-0"
                isInvalid={isInvalid}
                maxLength={PROFILE_VALUE_MAX_CHARS}
                placeholder={t(`resumeForm.profilePlaceholder.${field}`)}
                value={value}
                onValueChange={(next) => patchProfile(field, next)}
              />
            );
          })}
        </div>
      </DeskSection>

      {/* ② 求职意向：四格固定键。原文没写意向时这一块在主进程还不存在，写第一格才由 `intent.field` 补出来，
          所以界面这里照常给四格空位，不给"这一块还没有"的空态（那会让人以为要先去别处建一块）。 */}
      <DeskSection
        id="resume.form.intent"
        defaultOpen
        markers={{ testid: 'resume-form-group-intent' }}
        title={
          <span className="flex min-w-0 items-center gap-1.5">
            <Target size={13} className="shrink-0 text-slate-400" aria-hidden />
            {t('resumeForm.groupIntent')}
          </span>
        }
        summary={
          INTENT_FIELDS.map((field) => (dirtyIntent[field] ?? intentOriginal(field)).trim())
            .filter((value) => value !== '')
            .join(' · ') || t('resumeForm.groupIntentEmpty')
        }
      >
        <div className="flex min-w-0 flex-col gap-2">
          {INTENT_FIELDS.map((field) => {
            const original = intentOriginal(field);
            const value = dirtyIntent[field] ?? original;
            return (
              <DeskField
                key={field}
                action="resume-form-intent"
                data-intent-field={field}
                label={
                  <span className="flex min-w-0 items-center gap-1">
                    {t(INTENT_LABEL_KEY[field])}
                    {value !== original && <Tag tone="celadon">{t('resumeForm.unsaved')}</Tag>}
                  </span>
                }
                className="min-w-0"
                maxLength={INTENT_VALUE_MAX_CHARS}
                placeholder={t(`resumeForm.intentPlaceholder.${field}`)}
                value={value}
                onValueChange={(next) => patchIntent(field, next)}
              />
            );
          })}
          {intentNote && intentEntry && renderField(INTENT_SECTION_ID, intentEntry.id, intentNote)}
        </div>
      </DeskSection>

      {/* ③… 各类经历：一种要素一组，组内一条 entry 一张卡。空组默认收起（有内容才摊开）。 */}
      {contentSections.map((section) => {
        const isCustom = section.kind === 'custom';
        const viewOfKind = KIND_VIEW[section.kind];
        const Icon = viewOfKind.icon;
        const renameDraft = renameTitles[section.id] ?? section.title;
        const renameDead =
          renameDraft.trim() === ''
            ? { code: 'resume-form-empty-title', label: t('resumeForm.sectionTitleNeeded') }
            : renameDraft.trim().length > CUSTOM_TITLE_MAX_CHARS
              ? {
                  code: 'resume-form-title-too-long',
                  label: t('resumeForm.sectionTitleTooLong', { max: CUSTOM_TITLE_MAX_CHARS }),
                }
              : renameDraft.trim() === section.title
                ? { code: 'resume-form-title-unchanged', label: t('resumeForm.sectionTitleUnchanged') }
                : undefined;
        return (
          <DeskSection
            key={section.id}
            id={`resume.form.section.${section.id}`}
            defaultOpen={section.entries.length > 0}
            markers={{ testid: 'resume-form-group', section: section.id, kind: section.kind }}
            title={
              <span className="flex min-w-0 items-center gap-1.5">
                <Icon size={13} className="shrink-0 text-slate-400" aria-hidden />
                {isCustom && section.title.trim() !== '' ? section.title : t(viewOfKind.labelKey)}
                {isCustom && <Tag tone="amber">{t('resume.kind.custom')}</Tag>}
              </span>
            }
            summary={t('resumeForm.groupSummary', { count: section.entries.length })}
          >
            <div className="flex min-w-0 flex-col gap-2">
              {/* 自定义要素才有改名与整块删除：固定六类删了 kind 枚举就少一类，主进程会拒，界面连键都不给。 */}
              {isCustom && (
                <DeskActionRow>
                  <DeskField
                    action="resume-form-rename-title"
                    className="min-w-0 flex-1"
                    value={renameDraft}
                    maxLength={CUSTOM_TITLE_MAX_CHARS * 2}
                    aria-label={t('resumeForm.sectionRename')}
                    onValueChange={(value) => setRenameTitles((previous) => ({ ...previous, [section.id]: value }))}
                  />
                  <DeskButton
                    action="resume-form-rename"
                    compact
                    busy={busy === t('resumeForm.sectionRename')}
                    disabled={renameDead !== undefined}
                    disabledReason={renameDead?.code}
                    disabledReasonLabel={renameDead?.label}
                    onClick={() => renameSection(section)}
                  >
                    <Pencil size={12} aria-hidden />
                    {t('resumeForm.sectionRename')}
                  </DeskButton>
                  <DeskButton
                    action="resume-form-remove-section"
                    variant="seal"
                    compact
                    busy={busy === t('resumeForm.sectionRemove')}
                    markers={{ section: section.id }}
                    onClick={() => removeSection(section.id)}
                  >
                    <Trash2 size={12} aria-hidden />
                    {t('resumeForm.sectionRemove')}
                  </DeskButton>
                </DeskActionRow>
              )}

              {section.entries.length === 0 && (
                <p className="text-[11px] leading-relaxed text-slate-500">{t('resumeForm.groupEmpty')}</p>
              )}

              <ul className="flex min-w-0 flex-col gap-2">
                {section.entries.map((entry, position) => (
                  <li
                    key={entry.id}
                    data-testid="resume-form-entry"
                    data-entry-id={entry.id}
                    className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-ink-850 p-2"
                  >
                    <DeskActionRow className="justify-between">
                      <span className="text-[11px] text-slate-500">
                        {t('resumeForm.entryIndex', { index: position + 1 })}
                      </span>
                      <DeskButton
                        action="resume-form-remove-entry"
                        variant="seal"
                        compact
                        busy={busy === t('resumeForm.entryRemove')}
                        markers={{ section: section.id, entry: entry.id }}
                        onClick={() => removeEntry(section.id, entry.id)}
                      >
                        <Trash2 size={12} aria-hidden />
                        {t('resumeForm.entryRemove')}
                      </DeskButton>
                    </DeskActionRow>
                    {orderedFields(entry.fields).map((field) => renderField(section.id, entry.id, field))}
                  </li>
                ))}
              </ul>

              <DeskActionRow>
                <DeskButton
                  action="resume-form-add-entry"
                  compact
                  busy={busy === t('resumeForm.entryAdd')}
                  markers={{ section: section.id }}
                  onClick={() => addEntry(section.id)}
                >
                  <ListPlus size={12} aria-hidden />
                  {t('resumeForm.entryAdd')}
                </DeskButton>
              </DeskActionRow>
            </div>
          </DeskSection>
        );
      })}

      {/* 新增自定义要素：标题 + 一颗键；空 / 超长时按不动并给出原因（6.2-06）。 */}
      <DeskActionRow className="rounded-lg border border-dashed border-line p-2">
        <DeskField
          action="resume-form-new-section-title"
          className="min-w-0 flex-1"
          placeholder={t('resumeForm.sectionAddPlaceholder')}
          value={newSectionTitle}
          maxLength={CUSTOM_TITLE_MAX_CHARS * 2}
          onValueChange={setNewSectionTitle}
        />
        <DeskButton
          action="resume-form-add-section"
          compact
          busy={busy === t('resumeForm.sectionAdd')}
          disabled={newTitleDeadReason !== undefined}
          disabledReason={newTitleDeadReason?.code}
          disabledReasonLabel={newTitleDeadReason?.label}
          onClick={addSection}
        >
          <Plus size={12} aria-hidden />
          {t('resumeForm.sectionAdd')}
        </DeskButton>
      </DeskActionRow>

      {/* 保存条：有改动才可按；保存前那句提醒常驻——结构改动与文字改动的落库时刻不一样，必须看得见。 */}
      <DeskActionRow>
        <DeskButton
          action="resume-form-save"
          variant="solid"
          busy={busy === t('resumeForm.save')}
          result={resultOf(t('resumeForm.save'))}
          doneLabel={t('resumeForm.saveDone')}
          disabled={saveDeadReason !== undefined}
          disabledReason={saveDeadReason}
          disabledReasonLabel={saveDeadLabel}
          onClick={save}
        >
          <Save size={13} aria-hidden />
          {t('resumeForm.save')}
        </DeskButton>
        {dirtyCount > 0 && (
          <Tag tone="amber" data-testid="resume-form-dirty">
            {t('resumeForm.dirty', { count: dirtyCount })}
          </Tag>
        )}
      </DeskActionRow>
    </div>
  );
}
