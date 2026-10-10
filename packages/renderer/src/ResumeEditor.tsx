import { GripVertical, Palette, Redo2, Save, Timer, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { Banner, DeskButton, DeskRange, DeskSegmented, DeskSelect, DeskSwatch, deskReason } from './ui/controls';

/**
 * 度量滑杆在界表两端各多摆出的**容差比例**（3.6-02 的判据原文是"滑杆到界外 → 提示截图"：
 * 滑杆若恰好停在界内，界外那条拒绝路径在界面上永远到不了。判界仍然只在主进程做一次（§2.5），
 * 这里长的只是可拖范围，越界的值一律由 `resume.editor.metric` 拒掉并回一句话术）。
 */
const OUT_OF_BOUNDS_REACH = 0.25;

/** 度量键的显示顺序与单位（单位只是标签，不参与判定）。 */
const METRIC_ROWS: { key: EditorMetricKeyView; unit: 'pt' | 'mm' | 'ratio'; step: number }[] = [
  { key: 'baseFontPt', unit: 'pt', step: 0.5 },
  { key: 'lineHeight', unit: 'ratio', step: 0.05 },
  { key: 'topMm', unit: 'mm', step: 0.5 },
  { key: 'rightMm', unit: 'mm', step: 0.5 },
  { key: 'bottomMm', unit: 'mm', step: 0.5 },
  { key: 'leftMm', unit: 'mm', step: 0.5 },
];

/** 一次拖拽的进行态：`fromIndex` 是起手的区块位置，`overIndex` 是此刻指针算出的落点（结果序列下标）。 */
interface DragState {
  fromIndex: number;
  overIndex: number;
}

/**
 * 色卡格里摆的那些色（spec 6.6-05）。
 * 摆的是**档**而不是自由输入：主进程那道 `#rrggbb` 判据（`editor-ops.ts` 的 `bad-color`）
 * 因此永远不需要在人面前报错——人挑不出一个不合法的颜色，也就没有"界面放行而保存被拒"的分叉（§2.5）。
 * 前三档是稿上的中性墨色与两档纸色，其余按墨案那套低饱和色相排。
 */
const SWATCH_HEXES = [
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
const INHERIT = 'inherit';

/**
 * 主题预设（一次点击 = 一次调用 = 一个撤销单元，spec 6.6-05 的那一条）。
 * `default` 那一档把主题四格全部取消（`paragraph` 不动：段落样式是另一族表态）。
 */
const THEME_PRESETS: { id: string; patch: ResumeEditorDesignPatchView }[] = [
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
const PARAGRAPH_KINDS: readonly ResumeSectionKindView[] = [
  'summary',
  'experience',
  'education',
  'skills',
  'project',
  'campus',
];

/** 主题里的三格颜色轴（顺序即画面顺序）。 */
const THEME_COLOR_AXES: readonly ('inkHex' | 'paperHex' | 'accentHex')[] = ['inkHex', 'paperHex', 'accentHex'];

/** 段落样式里的两格颜色轴（字色与底色）。 */
const PARAGRAPH_COLOR_AXES: readonly ('inkHex' | 'backdropHex')[] = ['inkHex', 'backdropHex'];

/** 字族的两个档（清单来自 `model.ts` 的 `FONT_FAMILY_TOKENS`，过界那侧按同一串验收）。 */
const FONT_FAMILY_TOKENS: readonly EditorFontFamilyView[] = ['sans', 'serif'];

/** 字重的四个档。 */
const FONT_WEIGHT_TOKENS: readonly EditorFontWeightView[] = ['normal', 'medium', 'semibold', 'bold'];

/** 对齐的四个档。 */
const TEXT_ALIGN_TOKENS: readonly EditorTextAlignView[] = ['left', 'center', 'right', 'justify'];

/**
 * 拼一格的**主题**颜色补丁（写成三个分支而不是 `{ [axis]: value }`：计算属性会让键退化成
 * `string`，那份补丁就到不了 `ResumeEditorDesignPatchView` 的形状了）。
 * @param axis 哪一格
 * @param value 新色，或 `null` 取消那一格
 * @returns 只含那一格的补丁
 */
function themePatch(axis: 'inkHex' | 'paperHex' | 'accentHex', value: string | null): ResumeEditorDesignPatchView {
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
function paragraphPatch(
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
function matchesPreset(design: ResumeEditorDesignView | undefined, patch: ResumeEditorDesignPatchView): boolean {
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

/**
 * 排版编辑器（spec 3.6 的界面化身，plan §8.3/§8.4 的 3.6-c）。
 *
 * 形状照 5.10 画布那条已经走通的通道：**动作过桥、投影回来**。简历正文一句都不到这边，
 * 界面手里的只有区块 id/kind、度量数、界表、dirty/可撤销位，以及一份打印 HTML 预览
 * （预览与导出同一个 builder，spec 3.3-01 的口径在编辑器里继续成立）。
 * 因此这里**不判任何界**：滑杆拖到界外时改的是主进程的拒绝话术，不是本地的一次 `if`（§2.5）。
 *
 * 拖拽用 pointer 把手而不是原生 HTML5 DnD 或 @dnd-kit，选型与否决理由见 plan §8.2：
 * 本仓唯一被活体证明能驱动的拖拽通道是 CDP 派发的可信鼠标事件，而它走的就是 pointer 这一路。
 *
 * **画面不住在这里**（2026-10-10 起，spec 6.4-14 的④）：这一版编辑器只长在左列，出纸的那张 iframe
 * 由纸面槽持有，本组件通过 `onPreview` 把 draft 的打印 HTML 交上去。理由是一条说谎的形状：
 * 编辑器自己养一张预览时，同一屏上同时存在"库里那份的预览"与"draft 的预览"两张纸，
 * 人改完滑杆要转到编辑器那一格才看得见结果（正是用户 2026-10-10 报的那件事）。
 *
 * @param docId 要编辑的简历文档 id（由 `ResumeDesk` 持有并传入）
 * @param onClose 人按"关闭编辑器"且拦截通过后要走的卸载动作（裁定⑪：拦截只做组件卸载这一层）
 * @param onPreview 每一次 draft 重出之后把 HTML 交给父级（`undefined` = 这一版没渲出来，画空态不画残留）；
 *   它是**单向的供料**，父级不回推，因此槽位里那张纸的身份仍由 desk 判
 */
export function ResumeEditor({
  docId,
  onClose,
  onPreview,
}: {
  docId: string;
  onClose: () => void;
  onPreview: (html: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [view, setView] = useState<ResumeEditorView>();
  const [previewMs, setPreviewMs] = useState<number>();
  const [rejected, setRejected] = useState<string>();
  const [confirmClose, setConfirmClose] = useState(false);
  const [drag, setDrag] = useState<DragState>();
  /** 段落样式当前调的那一类区块（默认最常改的那一类；它只是界面状态，不进撤销栈）。 */
  const [paragraphKind, setParagraphKind] = useState<ResumeSectionKindView>('experience');
  /** 拖拽落点要读实时值：`pointerup` 的闭包里读 state 会拿到起手那一刻的旧落点。 */
  const dragRef = useRef<DragState | undefined>(undefined);
  /** 进行中的拖拽监听的摘除口，供卸载时兜底。 */
  const detachRef = useRef<(() => void) | undefined>(undefined);
  /** 区块行的 DOM，用于按指针位置算落点下标。 */
  const rowRefs = useRef(new Map<number, HTMLDivElement>());

  /**
   * 拉一次当前 draft 的预览 HTML 并计时（3.6-08 的读数来源就是这一趟跨进程往返）。
   * 它不走 `run`：`run` 结束会调 `read`，而 `read` 里就要调它——绕成递归的话每次动作会翻倍发调用。
   * 拿到之后**不在本组件里画**：交一份给 `onPreview`，由右栏那张纸去画（spec 6.4-14 的④）。
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
   */
  useEffect(() => {
    void run(t('resume.editor.open'), () => bridge?.resume['editor.open'](docId), {
      apply: setView,
      describe: (value) => t('resume.editor.opened', { docId: value.docId }),
    });
    // 只在挂载时开一次：`run` 与 `t` 的引用每次渲染都变，把它们放进依赖会反复重开会话并丢掉草稿。
  }, [docId]);

  /**
   * 把指针的纵坐标换算成落点下标：数一下"中心线在指针上方"的行数。
   * `moveSection` 的 `toIndex` 是**结果序列**（抽掉再插入）里的位置，所以这里不加 1。
   * @param clientY 指针视口纵坐标（px）
   * @param rowCount 当前区块行数
   */
  const indexOfPointer = (clientY: number, rowCount: number) => {
    let index = 0;
    for (let row = 0; row < rowCount; row += 1) {
      const rect = rowRefs.current.get(row)?.getBoundingClientRect();
      if (rect && rect.top + rect.height / 2 < clientY) index += 1;
    }
    return Math.min(Math.max(index, 0), rowCount - 1);
  };

  /**
   * 拖拽的监听在 `pointerdown` **当场**挂上，不挂在后续渲染的 effect 里。
   *
   * 活体第一次跑 3.6-01 就是这么失败的：`harness drag` 把 down/move/up 在几毫秒里连着派发完，
   * 而 effect 要等这次渲染提交后才跑，`pointerup` 早就过去了——于是拖了个空、行数一字未改。
   * 落点没变（`overIndex === fromIndex`）时一个字节都不发：3.6-03 的"空编辑不进栈"判在主进程那侧，
   * 但界面也不该白跑一趟跨进程调用。
   * @param index 起手所在区块的行下标
   */
  const startDrag = (index: number) => {
    const sections = view?.sections;
    if (!sections || sections.length === 0) return;
    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const overIndex = indexOfPointer(event.clientY, sections.length);
      if (overIndex === current.overIndex) return;
      const next = { fromIndex: current.fromIndex, overIndex };
      dragRef.current = next;
      setDrag(next);
    };
    const detach = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      detachRef.current = undefined;
    };
    const up = () => {
      const current = dragRef.current;
      dragRef.current = undefined;
      setDrag(undefined);
      detach();
      if (!current || current.overIndex === current.fromIndex) return;
      const section = sections[current.fromIndex];
      if (!section) return;
      void run(
        t('resume.editor.moveSection'),
        () => bridge?.resume['editor.move'](docId, section.id, current.overIndex),
        {
          apply: (value) => {
            setView(value);
            setRejected(undefined);
          },
          describe: () => t('resume.editor.moved', { from: current.fromIndex + 1, to: current.overIndex + 1 }),
          onError: (error) => setRejected(error.message),
        },
      );
    };
    const initial = { fromIndex: index, overIndex: index };
    dragRef.current = initial;
    setDrag(initial);
    detachRef.current = detach;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** 卸载时摘掉进行中的监听：人在拖拽中途关掉编辑器，不该在 window 上留下孤儿监听。 */
  useEffect(
    () => () => {
      detachRef.current?.();
    },
    [],
  );

  /**
   * 改一条度量：界外与非有限值都由主进程拒，界面把那句原因原样摆出来并把滑杆弹回已提交的值。
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
   * `planDesign` 做一次，拒了就把那句原因原样摆出来。色卡因此只摆得出 `#rrggbb`，
   * 人挑不出一个不合法的颜色，也就不存在"界面放行、保存被拒"的分叉。
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
   * @param templateId 目标模板 id，不给表示不改
   * @param locale 目标预览语言，不给表示不改
   */
  const useTemplate = (templateId?: string, locale?: ResumeLocaleView) =>
    void run(t('resume.editor.use'), () => bridge?.resume['editor.use'](docId, templateId, locale), {
      apply: (next) => {
        setView(next);
        setRejected(undefined);
      },
      describe: () => t('resume.editor.useDone', { template: templateId ?? locale ?? '' }),
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
   */
  const save = () =>
    void run(t('resume.editor.save'), () => bridge?.resume['editor.save'](docId), {
      apply: setView,
      describe: () => t('resume.editor.saved'),
    });

  /**
   * "关闭编辑器"的判定（裁定⑪：只拦组件卸载这一层，app 关闭不在 3.6-09 的判据原文里）。
   * 干净就直接卸载；有未保存改动先摆确认块，人再选一次。
   */
  const requestClose = () => {
    if (view?.isDirty) setConfirmClose(true);
    else onClose();
  };

  if (!view) {
    return (
      <section
        data-testid="resume-editor"
        className="rounded-xl border border-line bg-ink-900/60 p-4 text-[11px] text-slate-400"
      >
        {t('resume.editor.loading')}
      </section>
    );
  }

  const rowCount = view.sections.length;
  const overThreshold = previewMs !== undefined && previewMs > view.timing.maxPreviewResponseMs;
  const isLargeDocument = rowCount > view.timing.largeDocumentSectionCount;
  /** 在途那一档优先级最高：这时任何键的理由都是"上一趟还没回来"，而不是它自己的业务条件。 */
  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;
  const { dead, label: reasonLabel, reason: afterBusy } = deskReason(t, 'resume.editor', busyReason);
  /** 各键的禁用理由：在途优先，其次才是它自己的业务条件（顺序即优先级，与第十二片同一条写法）。 */
  const undoReason = afterBusy(!view.canUndo, 'NOTHING_TO_UNDO');
  const redoReason = afterBusy(!view.canRedo, 'NOTHING_TO_REDO');
  const saveReason = afterBusy(!view.isDirty, 'NOTHING_TO_SAVE');

  /**
   * 样式层（spec 6.6-05）在这里只读投影：`design` 缺省 = 这份文档从没设过主题，产物随模板。
   * 段落那一格按**区块种类**定位（裁定第 3 条的粒度：文档主题 + 段落样式，不做逐字段级）。
   */
  const design = view.layout.design;
  const paragraphStyle = design?.paragraphs?.[paragraphKind];
  /** 预设格的选中态：只对得上那一套才涂选中；人自己拼出来的组合不是任何一套，于是空格都不涂。 */
  const activePresetId = THEME_PRESETS.find((preset) => matchesPreset(design, preset.patch))?.id;

  /**
   * 一行数值样式轴（字号 / 行距）：滑杆 + 读数 + 一颗「随模板」。
   *
   * 三条轴共用这一份画法（§2.2）：界表**沿用度量那一张**（`view.metricBounds`），
   * 滑杆两端同样各多摆一份容差，越界一律由主进程拒 —— 样式轴不另立第二份界（§2.5）。
   * 「随模板」这一格没设过时按不动，理由码 `ALREADY_FOLLOWING`：它不是坏了，是没什么可取消的。
   * @param axis 轴名（i18n 与 `data-testid` 的后缀）
   * @param row 这一行的界、当前读数与两条出口
   */
  const numericRow = (
    axis: string,
    row: {
      boundKey: 'baseFontPt' | 'lineHeight';
      step: number;
      unit: 'pt' | 'ratio';
      /** 这一格设过没有（`undefined` = 随模板，滑杆摆在它继承来的那一档上）。 */
      current: number | undefined;
      /** 随模板时滑杆显示的那一档：正文档跟 `layout.baseFontPt`，段落档跟它自己的父档。 */
      fallback: number;
      onChange: (value: number) => void;
      onClear: () => void;
    },
  ) => {
    const bound = view.metricBounds[row.boundKey];
    const reach = (bound.max - bound.min) * OUT_OF_BOUNDS_REACH;
    const shown = row.current ?? row.fallback;
    return (
      <div key={axis} className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
        <span data-testid={`resume-editor-design-label-${axis}`} className="w-28 shrink-0">
          {t(`resume.editor.axes.${axis}`)}
        </span>
        <DeskRange
          action={`resume-editor-design-${axis}`}
          data-testid={`resume-editor-design-${axis}`}
          min={Number((bound.min - reach).toFixed(2))}
          max={Number((bound.max + reach).toFixed(2))}
          step={row.step}
          value={shown}
          {...dead(busyReason)}
          onValueChange={(value) => row.onChange(Number(value))}
          className="w-40"
        />
        <span data-testid={`resume-editor-design-value-${axis}`} className="w-16 text-slate-300">
          {shown} {t(`resume.editor.unit.${row.unit}`)}
        </span>
        <DeskButton
          action={`resume-editor-design-${axis}-follow`}
          variant="ghost"
          compact
          busy={!!busy}
          {...dead(afterBusy(row.current === undefined, 'ALREADY_FOLLOWING'))}
          onClick={row.onClear}
        >
          {t('resume.editor.followTemplate')}
        </DeskButton>
      </div>
    );
  };

  return (
    <section data-testid="resume-editor" className="rounded-xl border border-line bg-ink-900/60 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <GripVertical size={16} />
          {t('resume.editor.heading')}
          <span className="break-all text-[11px] font-normal text-slate-500">{view.docId}</span>
        </h3>
        <DeskButton
          action="close-editor"
          variant="ghost"
          compact
          busy={!!busy}
          {...dead(busyReason)}
          onClick={requestClose}
        >
          <X size={12} />
          {t('resume.editor.close')}
        </DeskButton>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
        <span
          data-testid="resume-editor-dirty"
          data-dirty={String(view.isDirty)}
          className={
            view.isDirty
              ? 'rounded-chip border border-amber/45 px-1 text-amber'
              : 'rounded-chip border border-line px-1 text-slate-400'
          }
        >
          {t(view.isDirty ? 'resume.editor.dirty' : 'resume.editor.clean')}
        </span>
        <label className="flex items-center gap-1 text-slate-400">
          {t('resume.editor.template')}
          <DeskSelect
            action="resume-editor-template"
            data-testid="resume-editor-template"
            value={view.templateId}
            {...dead(busyReason)}
            onValueChange={(value) => useTemplate(value)}
          >
            {view.templates.map((template) => (
              <option key={template} value={template}>
                {template}
              </option>
            ))}
          </DeskSelect>
        </label>
        <label className="flex items-center gap-1 text-slate-400">
          {t('resume.editor.previewLocale')}
          <DeskSelect
            action="resume-editor-locale"
            data-testid="resume-editor-locale"
            value={view.locale}
            {...dead(busyReason)}
            onValueChange={(value) => useTemplate(undefined, value as ResumeLocaleView)}
          >
            <option value="zh-CN">zh-CN</option>
            <option value="en">en</option>
          </DeskSelect>
        </label>
      </div>

      {confirmClose && (
        <Banner tone="amber" markers={{ testid: 'resume-editor-close-confirm' }} className="mt-2">
          <div className="w-full">
            <p className="text-xs font-semibold">{t('resume.editor.closeConfirmTitle')}</p>
            <p className="mt-1 text-xs opacity-80">{t('resume.editor.closeConfirmHint')}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <DeskButton
                action="close-save"
                variant="amber"
                compact
                busy={!!busy}
                {...dead(busyReason)}
                onClick={() => {
                  // 先等保存那一趟跨进程往返真落地，再卸载：反过来会留下一份"看起来存了其实没存"的草稿
                  // （裁定⑨ 之后界面没有第二次恢复入口，所以这一步的顺序不能马虎）。
                  void bridge?.resume['editor.save'](docId).then(() => onClose());
                }}
              >
                {t('resume.editor.saveAndLeave')}
              </DeskButton>
              <DeskButton action="close-discard" variant="seal" compact onClick={() => onClose()}>
                {t('resume.editor.discardAndLeave')}
              </DeskButton>
              <DeskButton action="close-stay" variant="ghost" compact onClick={() => setConfirmClose(false)}>
                {t('resume.editor.keepEditing')}
              </DeskButton>
            </div>
          </div>
        </Banner>
      )}

      <h4 className="mt-3 text-[11px] font-semibold text-slate-300">{t('resume.editor.sections')}</h4>
      <p className="text-[11px] text-slate-500">{t('resume.editor.sectionsHint')}</p>
      <ul className="mt-2 space-y-1" data-testid="resume-editor-section-list">
        {view.sections.map((section, index) => (
          <li
            key={section.id}
            data-testid="resume-editor-section"
            data-section-id={section.id}
            data-index={index}
            className="flex items-center gap-2 rounded-control border border-line bg-ink-950/70 px-2 py-1.5"
          >
            <span
              data-testid="resume-editor-handle"
              data-action="drag-section"
              onPointerDown={(event) => {
                event.preventDefault();
                startDrag(index);
              }}
              className={
                drag?.fromIndex === index
                  ? 'cursor-grabbing rounded-chip border border-celadon/70 px-1 text-celadon'
                  : 'cursor-grab rounded-chip border border-line-strong px-1 text-slate-400 hover:bg-ink-800'
              }
            >
              <GripVertical size={14} />
            </span>
            <div
              data-testid="resume-editor-row"
              ref={(node) => {
                if (node) rowRefs.current.set(index, node);
                else rowRefs.current.delete(index);
              }}
              className={
                drag?.overIndex === index && drag?.fromIndex !== index
                  ? 'flex-1 rounded-chip border border-dashed border-celadon/70 px-1 py-0.5'
                  : 'flex-1 rounded-chip border border-transparent px-1 py-0.5'
              }
            >
              <p className="text-[11px] text-slate-300">
                {index + 1} · {t(`resume.kind.${section.kind}`)}
              </p>
              <p className="text-[11px] text-slate-600">
                {t('resume.editor.entryCount', { count: section.entryIds.length })}
              </p>
            </div>
          </li>
        ))}
      </ul>

      <h4 className="mt-4 text-[11px] font-semibold text-slate-300">{t('resume.editor.metrics')}</h4>
      <p className="text-[11px] text-slate-500">{t('resume.editor.metricsHint')}</p>
      <div className="mt-2 space-y-2">
        {METRIC_ROWS.map((row) => {
          const bound = view.metricBounds[row.key];
          const reach = (bound.max - bound.min) * OUT_OF_BOUNDS_REACH;
          const current =
            row.key === 'baseFontPt'
              ? view.layout.baseFontPt
              : row.key === 'lineHeight'
                ? view.layout.lineHeight
                : view.layout.margin[row.key];
          return (
            <label key={row.key} className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
              <span data-testid={`resume-editor-metric-label-${row.key}`} className="w-28 shrink-0">
                {t(`resume.editor.units.${row.key}`)}
              </span>
              <DeskRange
                action={`resume-editor-metric-${row.key}`}
                data-testid={`resume-editor-metric-${row.key}`}
                min={Number((bound.min - reach).toFixed(2))}
                max={Number((bound.max + reach).toFixed(2))}
                step={row.step}
                value={current}
                {...dead(busyReason)}
                onValueChange={(value) => setMetric(row.key, Number(value))}
                className="w-44"
              />
              <span data-testid={`resume-editor-metric-value-${row.key}`} className="w-16 text-slate-300">
                {current} {t(`resume.editor.unit.${row.unit}`)}
              </span>
              <span className="text-slate-600">
                {t('resume.editor.metricBound', {
                  min: bound.min,
                  max: bound.max,
                  unit: t(`resume.editor.unit.${row.unit}`),
                })}
              </span>
            </label>
          );
        })}
      </div>

      <h4 className="mt-4 flex items-center gap-1 text-[11px] font-semibold text-slate-300">
        <Palette size={12} />
        {t('resume.editor.theme')}
      </h4>
      <p className="text-[11px] text-slate-500">{t('resume.editor.themeHint')}</p>
      <div className="mt-2 space-y-2" data-testid="resume-editor-design">
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-28 shrink-0 text-[11px] text-slate-400">{t('resume.editor.axes.preset')}</span>
          <DeskSegmented
            action="resume-editor-design-preset"
            markers={{ testid: 'resume-editor-design-preset' }}
            value={activePresetId}
            options={THEME_PRESETS.map((preset) => ({
              value: preset.id,
              label: t(`resume.editor.preset.${preset.id}`),
            }))}
            onSelect={(id) => {
              const preset = THEME_PRESETS.find((candidate) => candidate.id === id);
              if (preset) applyDesign('preset', preset.patch);
            }}
            busy={!!busy}
            disabledReason={busyReason}
            disabledReasonLabel={reasonLabel(busyReason)}
          />
        </div>

        {THEME_COLOR_AXES.map((axis) => (
          <div key={axis} className="flex flex-wrap items-center gap-2">
            <span className="w-28 shrink-0 text-[11px] text-slate-400">{t(`resume.editor.axes.${axis}`)}</span>
            <DeskSwatch
              action={`resume-editor-design-${axis}`}
              markers={{ testid: `resume-editor-design-${axis}` }}
              hexes={SWATCH_HEXES}
              value={design?.[axis]}
              clearLabel={t('resume.editor.followTemplate')}
              nameOf={(hex) => t('resume.editor.swatchName', { hex })}
              onSelect={(hex) => applyDesign(axis, themePatch(axis, hex))}
              onClear={() => applyDesign(axis, themePatch(axis, null))}
              busy={!!busy}
              disabledReason={busyReason}
              disabledReasonLabel={reasonLabel(busyReason)}
            />
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <span className="w-28 shrink-0 text-[11px] text-slate-400">{t('resume.editor.axes.bodyFontFamily')}</span>
          <DeskSegmented
            action="resume-editor-design-family"
            markers={{ testid: 'resume-editor-design-family' }}
            value={design?.body?.fontFamily ?? INHERIT}
            options={[
              { value: INHERIT, label: t('resume.editor.followTemplate') },
              ...FONT_FAMILY_TOKENS.map((token) => ({ value: token, label: t(`resume.editor.family.${token}`) })),
            ]}
            onSelect={(value) =>
              applyDesign('bodyFontFamily', { body: { fontFamily: value === INHERIT ? null : value } })
            }
            busy={!!busy}
            disabledReason={busyReason}
            disabledReasonLabel={reasonLabel(busyReason)}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="w-28 shrink-0 text-[11px] text-slate-400">{t('resume.editor.axes.bodyWeight')}</span>
          <DeskSegmented
            action="resume-editor-design-weight"
            markers={{ testid: 'resume-editor-design-weight' }}
            value={design?.body?.weight ?? INHERIT}
            options={[
              { value: INHERIT, label: t('resume.editor.followTemplate') },
              ...FONT_WEIGHT_TOKENS.map((token) => ({ value: token, label: t(`resume.editor.weight.${token}`) })),
            ]}
            onSelect={(value) => applyDesign('bodyWeight', { body: { weight: value === INHERIT ? null : value } })}
            busy={!!busy}
            disabledReason={busyReason}
            disabledReasonLabel={reasonLabel(busyReason)}
          />
        </div>

        {numericRow('bodySizePt', {
          boundKey: 'baseFontPt',
          step: 0.5,
          unit: 'pt',
          current: design?.body?.sizePt,
          fallback: view.layout.baseFontPt,
          onChange: (value) => applyDesign('bodySizePt', { body: { sizePt: value } }),
          onClear: () => applyDesign('bodySizePt', { body: { sizePt: null } }),
        })}

        <p className="text-[11px] text-slate-500">{t('resume.editor.bodySizeHint')}</p>
      </div>

      <h4 className="mt-4 text-[11px] font-semibold text-slate-300">{t('resume.editor.paragraph')}</h4>
      <p className="text-[11px] text-slate-500">{t('resume.editor.paragraphHint')}</p>
      <div className="mt-2 space-y-2" data-testid="resume-editor-paragraph">
        <DeskSegmented
          action="resume-editor-paragraph-kind"
          markers={{ testid: 'resume-editor-paragraph-kind' }}
          value={paragraphKind}
          options={PARAGRAPH_KINDS.map((kind) => ({ value: kind, label: t(`resume.kind.${kind}`) }))}
          onSelect={setParagraphKind}
          busy={!!busy}
          disabledReason={busyReason}
          disabledReasonLabel={reasonLabel(busyReason)}
        />

        {numericRow('paragraphSizePt', {
          boundKey: 'baseFontPt',
          step: 0.5,
          unit: 'pt',
          current: paragraphStyle?.sizePt,
          fallback: design?.body?.sizePt ?? view.layout.baseFontPt,
          onChange: (value) => applyDesign('paragraphSizePt', paragraphPatch(paragraphKind, 'sizePt', value)),
          onClear: () => applyDesign('paragraphSizePt', paragraphPatch(paragraphKind, 'sizePt', null)),
        })}

        {numericRow('paragraphLineHeight', {
          boundKey: 'lineHeight',
          step: 0.05,
          unit: 'ratio',
          current: paragraphStyle?.lineHeight,
          fallback: view.layout.lineHeight,
          onChange: (value) => applyDesign('paragraphLineHeight', paragraphPatch(paragraphKind, 'lineHeight', value)),
          onClear: () => applyDesign('paragraphLineHeight', paragraphPatch(paragraphKind, 'lineHeight', null)),
        })}

        <div className="flex flex-wrap items-center gap-2">
          <span className="w-28 shrink-0 text-[11px] text-slate-400">{t('resume.editor.axes.paragraphWeight')}</span>
          <DeskSegmented
            action="resume-editor-paragraph-weight"
            markers={{ testid: 'resume-editor-paragraph-weight' }}
            value={paragraphStyle?.weight ?? INHERIT}
            options={[
              { value: INHERIT, label: t('resume.editor.followTemplate') },
              ...FONT_WEIGHT_TOKENS.map((token) => ({ value: token, label: t(`resume.editor.weight.${token}`) })),
            ]}
            onSelect={(value) => applyDesign('paragraphWeight', paragraphPatch(paragraphKind, 'weight', value))}
            busy={!!busy}
            disabledReason={busyReason}
            disabledReasonLabel={reasonLabel(busyReason)}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="w-28 shrink-0 text-[11px] text-slate-400">{t('resume.editor.axes.paragraphAlign')}</span>
          <DeskSegmented
            action="resume-editor-paragraph-align"
            markers={{ testid: 'resume-editor-paragraph-align' }}
            value={paragraphStyle?.align ?? INHERIT}
            options={[
              { value: INHERIT, label: t('resume.editor.followTemplate') },
              ...TEXT_ALIGN_TOKENS.map((token) => ({ value: token, label: t(`resume.editor.align.${token}`) })),
            ]}
            onSelect={(value) => applyDesign('paragraphAlign', paragraphPatch(paragraphKind, 'align', value))}
            busy={!!busy}
            disabledReason={busyReason}
            disabledReasonLabel={reasonLabel(busyReason)}
          />
        </div>

        {PARAGRAPH_COLOR_AXES.map((axis) => {
          /** 轴名在补丁里是 `inkHex`/`backdropHex`，在文案与 testid 里要带 `paragraph` 前缀（免得和主题那三格撞名）。 */
          const label = axis === 'inkHex' ? 'paragraphInkHex' : 'paragraphBackdropHex';
          return (
            <div key={axis} className="flex flex-wrap items-center gap-2">
              <span className="w-28 shrink-0 text-[11px] text-slate-400">{t(`resume.editor.axes.${label}`)}</span>
              <DeskSwatch
                action={`resume-editor-paragraph-${axis}`}
                markers={{ testid: `resume-editor-paragraph-${axis}` }}
                hexes={SWATCH_HEXES}
                value={paragraphStyle?.[axis]}
                clearLabel={t('resume.editor.followTemplate')}
                nameOf={(hex) => t('resume.editor.swatchName', { hex })}
                onSelect={(hex) => applyDesign(label, paragraphPatch(paragraphKind, axis, hex))}
                onClear={() => applyDesign(label, paragraphPatch(paragraphKind, axis, null))}
                busy={!!busy}
                disabledReason={busyReason}
                disabledReasonLabel={reasonLabel(busyReason)}
              />
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <DeskButton
          action="undo"
          variant="ghost"
          compact
          busy={!!busy}
          {...dead(undoReason)}
          onClick={() => stepHistory('undo')}
        >
          <Undo2 size={12} />
          {t('resume.editor.undo')}
        </DeskButton>
        <DeskButton
          action="redo"
          variant="ghost"
          compact
          busy={!!busy}
          {...dead(redoReason)}
          onClick={() => stepHistory('redo')}
        >
          <Redo2 size={12} />
          {t('resume.editor.redo')}
        </DeskButton>
        <DeskButton action="save-editor" variant="amber" compact busy={!!busy} {...dead(saveReason)} onClick={save}>
          <Save size={12} />
          {t('resume.editor.save')}
        </DeskButton>
      </div>

      {rejected && (
        <Banner tone="seal" markers={{ testid: 'resume-editor-rejected' }} className="mt-2 break-all">
          {t('resume.editor.rejected', { message: rejected })}
        </Banner>
      )}

      {notice && (
        <Banner tone={noticeTone} markers={{ testid: 'resume-editor-notice' }} className="mt-2 break-all">
          {notice}
        </Banner>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
        <span
          data-testid="resume-editor-timing"
          data-over={String(overThreshold)}
          className={
            overThreshold
              ? 'flex items-center gap-1 rounded-chip border border-amber/45 px-1 text-amber'
              : 'flex items-center gap-1 rounded-chip border border-line px-1 text-slate-400'
          }
        >
          <Timer size={12} />
          {overThreshold
            ? t('resume.editor.timingOver', { ms: previewMs ?? 0, max: view.timing.maxPreviewResponseMs })
            : t('resume.editor.timing', { ms: previewMs ?? 0, max: view.timing.maxPreviewResponseMs })}
        </span>
        {isLargeDocument && (
          <span
            data-testid="resume-editor-large-document"
            className="rounded-chip border border-amber/45 px-1 text-[11px] text-amber"
          >
            {t('resume.editor.largeDocument', { count: rowCount, threshold: view.timing.largeDocumentSectionCount })}
          </span>
        )}
      </div>
    </section>
  );
}
