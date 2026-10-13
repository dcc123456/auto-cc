import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  EditorFontFamilyView,
  EditorFontWeightView,
  EditorMetricKeyView,
  EditorTextAlignView,
  ResumeEditorDesignPatchView,
  ResumeEditorDesignView,
  ResumeEditorView,
  ResumeLocaleView,
  ResumeSectionKindView,
} from '@auto-cc/shared';
import { useBridgeAction } from './useBridgeAction';

/**
 * 度量滑杆在界表两端各多摆出的**容差比例**（3.6-02 的判据原文是"滑杆到界外 → 提示截图"：
 * 滑杆若恰好停在界内，界外那条拒绝路径在界面上永远到不了。判界仍然只在主进程做一次（§2.5），
 * 这里长的只是可拖范围，越界的值一律由 `resume.editor.metric` 拒掉并回一句话术）。
 */
export const OUT_OF_BOUNDS_REACH = 0.25;

/**
 * 拖拽落点的下标：数"中心线在指针上方"的行数（spec 3.10-05 要求左列清单与纸面帧共用这一份实现）。
 * 行的来源两边不同（左列是 React 的 `rowRefs`，纸面是帧内 `querySelectorAll` 的节点），
 * 所以这里只收一个按行号取矩形的口；坐标**不做缩放换算**，调用方给哪一档坐标就按那一档判。
 * `moveSection` 的 `toIndex` 是**结果序列**（抽掉再插入）里的位置，所以中心线全部在指针上方时才加到末位。
 * @param clientY 指针纵坐标（px）
 * @param rectAt 第 `index` 行的矩形；取不到（还没量到）按"不在上方"处理
 * @param rowCount 当前行数
 * @returns 夹在 `[0, rowCount-1]` 的落点下标
 */
export const dropIndexOfPointer = (
  clientY: number,
  rectAt: (index: number) => DOMRect | undefined,
  rowCount: number,
): number => {
  let index = 0;
  for (let row = 0; row < rowCount; row += 1) {
    const rect = rectAt(row);
    if (rect && rect.top + rect.height / 2 < clientY) index += 1;
  }
  return Math.min(Math.max(index, 0), rowCount - 1);
};

/** 度量键的显示顺序与单位（单位只是标签，不参与判定）。 */
export const METRIC_ROWS: { key: EditorMetricKeyView; unit: 'pt' | 'mm' | 'ratio'; step: number }[] = [
  { key: 'baseFontPt', unit: 'pt', step: 0.5 },
  { key: 'lineHeight', unit: 'ratio', step: 0.05 },
  { key: 'topMm', unit: 'mm', step: 0.5 },
  { key: 'rightMm', unit: 'mm', step: 0.5 },
  { key: 'bottomMm', unit: 'mm', step: 0.5 },
  { key: 'leftMm', unit: 'mm', step: 0.5 },
];

/**
 * 色卡格里摆的那些色（spec 6.6-05）。
 * 摆的是**档**而不是自由输入：主进程那道 `#rrggbb` 判据（`editor-ops.ts` 的 `bad-color`）
 * 因此永远不需要在人面前报错——人挑不出一个不合法的颜色，也就没有"界面放行而保存被拒"的分叉（§2.5）。
 */
export const SWATCH_HEXES = [
  '#101820',
  '#1b2228',
  '#334155',
  '#64748b',
  '#f7f5f2',
  '#ffffff',
  '#a31621',
  '#b93b26',
  '#7c2d12',
  '#0b5c50',
  '#134e4a',
  '#1e3a8a',
  '#312e81',
  '#a16207',
  '#3f3f46',
] as const;

/** 「随模板」这一档的哨兵值：`DeskSegmented` 的值必须是字符串，而 null 在补丁里另有"取消那一格"的语义。 */
export const INHERIT = 'inherit';

/**
 * 主题预设（一次点击 = 一次调用 = 一个撤销单元，spec 6.6-05 的那一条）。
 * `default` 那一档把主题四格全部取消（`paragraph` 不动：段落样式是另一族表态）。
 */
export const THEME_PRESETS: { id: string; patch: ResumeEditorDesignPatchView }[] = [
  { id: 'default', patch: { inkHex: null, paperHex: null, accentHex: null, body: null } },
  {
    id: 'ink',
    patch: {
      inkHex: '#101820',
      paperHex: '#f7f5f2',
      accentHex: '#a31621',
      body: { fontFamily: 'serif', weight: 'normal' },
    },
  },
  {
    id: 'jade',
    patch: {
      inkHex: '#1b2228',
      paperHex: '#ffffff',
      accentHex: '#0b5c50',
      body: { fontFamily: 'sans', weight: 'normal' },
    },
  },
  {
    id: 'seal',
    patch: {
      inkHex: '#334155',
      paperHex: '#f7f5f2',
      accentHex: '#b93b26',
      body: { fontFamily: 'serif', weight: 'medium' },
    },
  },
];

/** 段落样式的六种区块种类（与 `resume.kind.*` 同一份枚举，界面不另列一套）。 */
export const PARAGRAPH_KINDS: readonly ResumeSectionKindView[] = [
  'summary',
  'experience',
  'education',
  'skills',
  'project',
  'campus',
];

/** 主题里的三格颜色轴（顺序即画面顺序）。 */
export const THEME_COLOR_AXES: readonly ('inkHex' | 'paperHex' | 'accentHex')[] = ['inkHex', 'paperHex', 'accentHex'];

/** 段落样式里的两格颜色轴（字色与底色）。 */
export const PARAGRAPH_COLOR_AXES: readonly ('inkHex' | 'backdropHex')[] = ['inkHex', 'backdropHex'];

/** 字族的两个档（清单来自 `model.ts` 的 `FONT_FAMILY_TOKENS`，过界那侧按同一串验收）。 */
export const FONT_FAMILY_TOKENS: readonly EditorFontFamilyView[] = ['sans', 'serif'];

/** 字重的四个档。 */
export const FONT_WEIGHT_TOKENS: readonly EditorFontWeightView[] = ['normal', 'medium', 'semibold', 'bold'];

/** 对齐的四个档。 */
export const TEXT_ALIGN_TOKENS: readonly EditorTextAlignView[] = ['left', 'center', 'right', 'justify'];

/**
 * 拼一格的**主题**颜色补丁（写成三个分支而不是 `{ [axis]: value }`：计算属性会让键退化成
 * `string`，那份补丁就到不了 `ResumeEditorDesignPatchView` 的形状了）。
 * @param axis 哪一格
 * @param value 新色，或 `null` 取消那一格
 * @returns 只含那一格的补丁
 */
export function themePatch(
  axis: 'inkHex' | 'paperHex' | 'accentHex',
  value: string | null,
): ResumeEditorDesignPatchView {
  if (axis === 'inkHex') return { inkHex: value };
  if (axis === 'paperHex') return { paperHex: value };
  return { accentHex: value };
}

/**
 * 拼一格的**段落**样式补丁。
 * @param kind 当前选中的区块种类（补丁里必填，主进程按它定位那一格）
 * @param axis 段落六条轴之一
 * @param value 新值，或 `null` 取消那一格
 * @returns 只带 `kind` 与那一条轴的补丁
 */
export function paragraphPatch(
  kind: ResumeSectionKindView,
  axis: 'sizePt' | 'weight' | 'align' | 'lineHeight' | 'inkHex' | 'backdropHex',
  value: string | number | null,
): ResumeEditorDesignPatchView {
  return { paragraph: { kind, [axis]: value } };
}

/**
 * 判"当前主题是不是这一套预设"（预设格的选中态用，不是判据——判界只在主进程做一次）。
 * @param design 投影里带回来的主题（`undefined` = 从没设过）
 * @param patch 那一套预设的补丁
 * @returns 预设里给出的每一格都对得上才算选中；全 null 那一套要求 `design` 整格不存在
 */
export function matchesPreset(design: ResumeEditorDesignView | undefined, patch: ResumeEditorDesignPatchView): boolean {
  if (patch.inkHex === null && patch.paperHex === null && patch.accentHex === null && patch.body === null) {
    return design === undefined;
  }
  // 正文档在这一支只认"预设给了具体档位"那一种：`null`（整组取消）只出现在上面那一套 default 里。
  const presetBody = typeof patch.body === 'object' ? patch.body : undefined;
  if (!design || (patch.body !== undefined && !presetBody)) return false;
  const bodySame =
    !presetBody ||
    ((design.body?.fontFamily ?? INHERIT) === (presetBody.fontFamily ?? INHERIT) &&
      (design.body?.weight ?? INHERIT) === (presetBody.weight ?? INHERIT));
  return (
    design.inkHex === patch.inkHex &&
    design.paperHex === patch.paperHex &&
    design.accentHex === patch.accentHex &&
    bodySame
  );
}

/** `useResumeEditor` 的入参。 */
export interface ResumeEditorSessionProps {
  /** 要编辑的简历文档 id（由持有它的那一处传入：desk 与整屏页共用同一份身份）。 */
  docId: string;
  /** 架上当前选中的那套版式（**唯一来源**是 desk，任何一档都不再自己长一只模板下拉，§2.5）。 */
  templateId: string;
  /** 架上当前选中的预览语言（同上）。 */
  locale: ResumeLocaleView;
  /** 每一次 draft 重出之后把 HTML 交给持有画面那一格（`undefined` = 这一版没渲出来，画空态不画残留）。 */
  onPreview: (html: string | undefined) => void;
}

/**
 * 简历排版会话的唯一持有者（spec 3.10-07）。
 *
 * 为什么抽在这一处：左列的编排面板与整屏编辑页要的是**同一份**会话（同一个 `docId` 的 draft、同一条撤销栈、
 * 同一张纸的预览 HTML）。从前这些状态长在 `ResumeEditor.tsx` 里，第二个界面就只能再抄一份状态机——
 * 两份 `view` 会各自漂（一处撤销了另一处还画着旧值），而撤销栈在主进程只有一条（§2.2/§2.5）。
 * 动作一律经 `useBridgeAction` 的 `run`：收尾必重读投影 + 重出预览，界面不猜主进程当下是什么。
 * @param props 见 `ResumeEditorSessionProps`
 * @returns 投影 `view`、九个动作、在途态与那句回执
 */
export function useResumeEditor({ docId, templateId, locale, onPreview }: ResumeEditorSessionProps) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [view, setView] = useState<ResumeEditorView>();
  const [previewMs, setPreviewMs] = useState<number>();
  /** 主进程那句拒绝的原话（界外、坏颜色、越界种类都从这里出口，界面不自己判）。 */
  const [rejected, setRejected] = useState<string>();

  /**
   * 拉一次当前 draft 的预览 HTML 并计时（3.6-08 的读数来源就是这一趟跨进程往返）。
   * 它不走 `run`：`run` 结束会调 `read`，而 `read` 里就要调它——绕成递归的话每次动作会翻倍发调用。
   * 拿到之后**不在这里画**：交给 `onPreview`，由持有画面那一格去画（spec 6.4-14 的④）。
   */
  const refreshPreview = useCallback(async () => {
    if (!bridge) return;
    const started = performance.now();
    const reply = await bridge.resume['editor.preview'](docId);
    setPreviewMs(Math.round(performance.now() - started));
    onPreview(reply?.ok ? reply.value : undefined);
  }, [bridge, docId, onPreview]);

  /** 每个动作结束后一律重读投影 + 重取预览：界面不猜主进程当下的状态（AGENTS.md §2.5）。 */
  const read = useCallback(async () => {
    const reply = await bridge?.resume['editor.view'](docId);
    if (reply?.ok) setView(reply.value);
    await refreshPreview();
  }, [bridge, docId, refreshPreview]);

  const { busy, notice, noticeTone, run } = useBridgeAction(read);

  /**
   * 挂起时开一次会话（`open` 会放弃上一份未保存的 draft，正是裁定⑨"只拦不存"的另一半）。
   * 只在挂载与换文档时开：`run` 与 `t` 的引用每次渲染都变，放进依赖会反复重开会话并丢掉草稿。
   */
  useEffect(() => {
    void run(t('resume.editor.open'), () => bridge?.resume['editor.open'](docId), {
      apply: setView,
      describe: (value) => t('resume.editor.opened', { docId: value.docId }),
    });
  }, [docId]);

  /**
   * 改一条度量（基准字号 / 行距 / 四边距）。
   * @param key 度量键
   * @param value 新值（单位随键，界表见 `view.metricBounds`）
   */
  const setMetric = (key: EditorMetricKeyView, value: number) =>
    void run(t('resume.editor.metric'), () => bridge?.resume['editor.metric'](docId, key, value), {
      apply: (next) => {
        setView(next);
        setRejected(undefined);
      },
      describe: () => t('resume.editor.metricDone', { key: t(`resume.editor.units.${key}`), value }),
      onError: (error) => setRejected(error.message),
    });

  /**
   * 改一格样式（spec 6.6-05）。一次调用 = **一个撤销单元**，所以点一次预设发的是整套补丁而不是四次单格。
   *
   * 界面不判颜色形状、不判档位清单、不判数值界（AGENTS.md §2.5）：那三件事只在主进程的
   * `planDesign` 做一次，拒了就把那句原因原样摆出来。
   * @param axis 哪一格（回执与拒绝话术里要说清是哪一格）
   * @param patch 补丁（`null` = 取消那一格，回到模板默认档）
   */
  const applyDesign = (axis: string, patch: ResumeEditorDesignPatchView) =>
    void run(t('resume.editor.design'), () => bridge?.resume['editor.design'](docId, patch), {
      apply: (next) => {
        setView(next);
        setRejected(undefined);
      },
      describe: () => t('resume.editor.designDone', { axis: t(`resume.editor.axes.${axis}`) }),
      onError: (error) => setRejected(error.message),
    });

  /**
   * 换预览模板或语言（3.6-04）：它不碰文档，所以画面上只换排版而数据一字不变。
   * @param nextTemplateId 目标模板 id，不给表示不改
   * @param nextLocale 目标预览语言，不给表示不改
   */
  const useTemplate = (nextTemplateId?: string, nextLocale?: ResumeLocaleView) =>
    void run(t('resume.editor.use'), () => bridge?.resume['editor.use'](docId, nextTemplateId, nextLocale), {
      apply: (next) => {
        setView(next);
        setRejected(undefined);
      },
      describe: () => t('resume.editor.useDone', { template: nextTemplateId ?? nextLocale ?? '' }),
    });

  /**
   * 把会话里的预览模板/语言对齐到**架上那一份**（用户 2026-10-12 报的「编排显示的样式和预览不一致」根因）。
   * 唯一来源是 desk，差异出现时补一次 `resume.editor.use`——它不碰文档，因此不产生撤销单元（3.6-04 原样沿用）。
   */
  useEffect(() => {
    if (!view) return;
    if (view.templateId === templateId && view.locale === locale) return;
    useTemplate(templateId, locale);
    // `useTemplate` 每次渲染换引用（它闭包着 `run`），放进依赖会在无关动作后重发这一趟；
    // 判据只有上面那四个值，`run` 在途时这条 effect 本就因 view 不变而不会再发。
  }, [view, templateId, locale]);

  /**
   * 移一个区块（3.6-01）或一条条目（3.6-10 的同一颗口）。落点由调用量出：左列量行、整屏页量纸上的段矩形。
   * @param sectionId 要移的区块 id
   * @param toIndex 结果序列（抽掉再插入）里的位置
   * @param entryId 给定时移的是该区块里的这一条条目
   */
  const moveSection = (sectionId: string, toIndex: number, entryId?: string) => {
    // 回执那句"从第 N 到第 M"的 N 从投影里现查（它是唯一一份区块顺序，§2.2），调用方不必把起手下标递进来。
    const fromIndex = view?.sections.findIndex((section) => section.id === sectionId) ?? -1;
    void run(t('resume.editor.moveSection'), () => bridge?.resume['editor.move'](docId, sectionId, toIndex, entryId), {
      apply: (next) => {
        setView(next);
        setRejected(undefined);
      },
      describe: () => t('resume.editor.moved', { from: fromIndex + 1, to: toIndex + 1 }),
      onError: (error) => setRejected(error.message),
    });
  };

  /**
   * 拆一条（spec 3.6-10 / 裁定㉗ 第 1 条后半句）：过界的只有那**一个整数**（正文不许过界）。
   * @param sectionId 区块 id
   * @param entryId 条目 id
   * @param bodyLineIndex 留在前一条里的行数（从 1 起算）
   */
  const splitEntry = (sectionId: string, entryId: string, bodyLineIndex: number) =>
    void run(t('resume.editor.split'), () => bridge?.resume['editor.split'](docId, sectionId, entryId, bodyLineIndex), {
      apply: (next) => {
        setView(next);
        setRejected(undefined);
      },
      describe: () => t('resume.editor.splitDone', { line: bodyLineIndex }),
      onError: (error) => setRejected(error.message),
    });

  /**
   * 并一条（spec 3.6-10）：方向写死为"并回同区块的上一条"。
   * @param sectionId 区块 id
   * @param entryId 要并走的条目 id
   */
  const mergeEntry = (sectionId: string, entryId: string) =>
    void run(t('resume.editor.merge'), () => bridge?.resume['editor.merge'](docId, sectionId, entryId), {
      apply: (next) => {
        setView(next);
        setRejected(undefined);
      },
      describe: () => t('resume.editor.mergeDone'),
      onError: (error) => setRejected(error.message),
    });

  /**
   * 回退 / 重做一步（3.6-03）。
   * @param direction 方向：撤销或重做
   */
  const stepHistory = (direction: 'undo' | 'redo') =>
    void run(
      t(direction === 'undo' ? 'resume.editor.undo' : 'resume.editor.redo'),
      () => (direction === 'undo' ? bridge?.resume['editor.undo'](docId) : bridge?.resume['editor.redo'](docId)),
      {
        apply: setView,
        describe: () => t(direction === 'undo' ? 'resume.editor.undone' : 'resume.editor.redone'),
      },
    );

  /**
   * 保存到库（3.6-09 的另一半）：唯一的写入口是 `resume.editor.save`，界面手里没有正文，
   * 因此不可能绕过它去调 `resume.doc.save`。
   * 返回那条 Promise 而不是 `void`：「先等这一趟真落地再卸载」是裁定⑨ 之后唯一不留悬空草稿的顺序
   * （`ResumeEditor` 与整屏页的「保存并离开」都靠它，各自都不必再直接摸桥接）。
   */
  const save = () =>
    run(t('resume.editor.save'), () => bridge?.resume['editor.save'](docId), {
      apply: setView,
      describe: () => t('resume.editor.saved'),
    });

  return {
    view,
    rejected,
    previewMs,
    busy,
    notice,
    noticeTone,
    setMetric,
    applyDesign,
    useTemplate,
    moveSection,
    splitEntry,
    mergeEntry,
    stepHistory,
    save,
  };
}
