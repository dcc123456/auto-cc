import { GripVertical, Merge, Minus, Palette, Plus, Redo2, Save, Split, Timer, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ResumeSectionKindView } from '@auto-cc/shared';
import { Banner, DeskButton, DeskRange, DeskSegmented, DeskSwatch, deskReason } from './ui/controls';
import {
  FONT_FAMILY_TOKENS,
  FONT_WEIGHT_TOKENS,
  INHERIT,
  METRIC_ROWS,
  OUT_OF_BOUNDS_REACH,
  PARAGRAPH_COLOR_AXES,
  PARAGRAPH_KINDS,
  SWATCH_HEXES,
  TEXT_ALIGN_TOKENS,
  THEME_COLOR_AXES,
  THEME_PRESETS,
  dropIndexOfPointer,
  matchesPreset,
  paragraphPatch,
  themePatch,
  type useResumeEditor,
} from './useResumeEditor';

/** 一次拖拽的进行态：`fromIndex` 是起手的区块位置，`overIndex` 是此刻指针算出的落点（结果序列下标）。 */
interface DragState {
  fromIndex: number;
  overIndex: number;
}

/**
 * 排版编辑器的**纯表现层**（spec 3.13 裁定㊲：整页编辑是唯一编辑处，本片起本组件只画不改状态）。
 *
 * 形状照 5.10 画布那条已经走通的通道：**动作过桥、投影回来**——但那趟往返如今全在宿主传进来的
 * `session`（`useResumeEditor` 的返回值）里，本组件不自己调 hook（§2.2：会话只有一份，长在整页编辑那里）。
 * 简历正文一句都不到这边，界面手里的只有区块 id/kind、度量数、界表、dirty/可撤销位。
 * 因此这里**不判任何界**：滑杆拖到界外时改的是主进程的拒绝话术，不是本地的一次 `if`（§2.5）。
 *
 * 拖拽用 pointer 把手而不是原生 HTML5 DnD 或 @dnd-kit，选型与否决理由见 plan §8.2：
 * 本仓唯一被活体证明能驱动的拖拽通道是 CDP 派发的可信鼠标事件，而它走的就是 pointer 这一路。
 *
 * **画面不住在这里**（2026-10-10 起，spec 6.4-14 的④）：出纸的那张 iframe 由整页编辑的纸面持有，
 * draft 的打印 HTML 经 `session` 背后的 `onPreview` 直接交给宿主，本组件不经手。
 *
 * **关闭那一途也不在这里**（裁定㊲ / plan §3.35 的形状规则）：整页编辑自己已有「确认关闭」与三层 Esc，
 * 组件再摆一套就是第二条可用的关闭路（§2.4/§2.5），所以内置的关闭键与确认块整体删除。
 *
 * @param session 宿主（`ResumeEditPage`）持有的那一份编辑会话——投影、动作、在途态与回执都从它来
 */
export function ResumeEditor({ session }: { session: ReturnType<typeof useResumeEditor> }) {
  const { t } = useTranslation();
  const {
    view,
    rejected,
    previewMs,
    busy,
    notice,
    noticeTone,
    setMetric,
    applyDesign,
    moveSection,
    splitEntry,
    mergeEntry,
    stepHistory,
    save,
  } = session;
  const [drag, setDrag] = useState<DragState>();
  /**
   * 每一条目当前拨到的**拆点行号**（键是 `区块id/条目id`）。
   * 它是纯界面状态：不进撤销栈（拆点还没落地时没有编辑可言），也不与投影里的条目表并成一份数组——
   * 条目的真相只有 `view.sections[].entries` 一份（§2.2）。
   */
  const [splitLines, setSplitLines] = useState<Record<string, number>>({});
  /** 段落样式当前调的那一类区块（默认最常改的那一类；它只是界面状态，不进撤销栈）。 */
  const [paragraphKind, setParagraphKind] = useState<ResumeSectionKindView>('experience');
  /** 拖拽落点要读实时值：`pointerup` 的闭包里读 state 会拿到起手那一刻的旧落点。 */
  const dragRef = useRef<DragState | undefined>(undefined);
  /** 进行中的拖拽监听的摘除口，供卸载时兜底。 */
  const detachRef = useRef<(() => void) | undefined>(undefined);
  /** 区块行的 DOM，用于按指针位置算落点下标。 */
  const rowRefs = useRef(new Map<number, HTMLDivElement>());

  /**
   * 把指针的纵坐标换算成落点下标——与纸面帧那一份共用 `dropIndexOfPointer`（spec 3.10-05 / §2.2）。
   * @param clientY 指针视口纵坐标（px）
   * @param rowCount 当前区块行数
   */
  const indexOfPointer = (clientY: number, rowCount: number) =>
    dropIndexOfPointer(clientY, (index) => rowRefs.current.get(index)?.getBoundingClientRect(), rowCount);

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
      moveSection(section.id, current.overIndex);
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
   * 把某一条目的拆点拨一格：只动界面状态，不发跨进程调用。
   *
   * 这里的上下界不是**第二份判定**：它就是投影里那一格的 `bodyLineCount`（上界 = 行数 - 1，
   * 因为"留下 0 行"或"全部留下"都拆不出第二条），主进程拿同一个数去拒越界（§2.5）。
   * @param key 条目键（`区块id/条目id`，同一条 id 不会跨区块串味）
   * @param delta 拨的方向（-1 / +1）
   * @param maxLine 可拨的上界
   */
  const stepSplitLine = (key: string, delta: number, maxLine: number) => {
    setSplitLines((current) => {
      const next = Math.min(Math.max((current[key] ?? 1) + delta, 1), maxLine);
      return next === current[key] ? current : { ...current, [key]: next };
    });
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
      <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
        <GripVertical size={16} />
        {t('resume.editor.heading')}
        <span className="break-all text-[11px] font-normal text-slate-500">{view.docId}</span>
      </h3>

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
        {/* 模板与语言的下拉从前长在这里，于是同一种选择有两处（这里的下拉 + 架上那一排），
            结果是「架上点了现代双栏、编排这张纸还是经典单栏」。唯一来源现在是 desk 的模板架，
            这一格只留 dirty 那一条读数（AGENTS.md §2.4：被替换的旧实现要删干净）。 */}
      </div>

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
                {index + 1} · {t(`resume.kind.${section.kind}`)} ·{' '}
                {t('resume.editor.entryCount', { count: section.entries.length })}
              </p>
              {/* 旧切法那一句要说人话（4.1-17 的界面半边 / 裁定㉗ 第 3 条「不回填」）：库里的老文档还是导入那一刻的形状，
                  这里既不谎称会自动重切，也不摆内部 id。 */}
              {section.entries.length === 1 && (
                <p className="mt-0.5 text-[11px] text-slate-500" data-testid="resume-editor-legacy-cut">
                  {t('resume.editor.legacyCutHint')}
                </p>
              )}
              <ul className="mt-1 space-y-1" data-testid="resume-editor-entry-list">
                {section.entries.map((entry, entryIndex) => {
                  const maxLine = Math.max(entry.bodyLineCount - 1, 1);
                  const stepped = splitLines[`${section.id}/${entry.id}`] ?? 1;
                  const line = Math.min(Math.max(stepped, 1), maxLine);
                  const canSplit = entry.bodyLineCount >= 2;
                  return (
                    <li
                      key={entry.id}
                      data-testid="resume-editor-entry"
                      data-entry-id={entry.id}
                      data-body-line-count={entry.bodyLineCount}
                      className="flex flex-wrap items-center gap-1.5"
                    >
                      <span className="text-[11px] text-slate-400">{entryIndex + 1}</span>
                      <span className="text-[11px] text-slate-600">
                        {t('resume.editor.bodyLines', { count: entry.bodyLineCount })}
                      </span>
                      {/* 行号步进器（spec 6.4-23 的形状约束①：正文不过界，界面只递得出行号）。
                          正文不足两行时这一格整只不画——拨头没有可拨的档，画出来只会多两只"按不动但说不出新理由"的键。 */}
                      {canSplit && (
                        <span className="flex items-center gap-1" data-testid="resume-editor-split-stepper">
                          <DeskButton
                            action="split-line-minus"
                            variant="ghost"
                            compact
                            busy={!!busy}
                            aria-label={t('resume.editor.splitLineMinus')}
                            {...dead(afterBusy(line <= 1, 'AT_FIRST_LINE'))}
                            onClick={() => stepSplitLine(`${section.id}/${entry.id}`, -1, maxLine)}
                          >
                            <Minus size={11} />
                          </DeskButton>
                          <span
                            className="text-[11px] text-slate-300"
                            data-testid="resume-editor-split-line"
                            data-line={line}
                            data-max={maxLine}
                          >
                            {t('resume.editor.splitLine', { line, max: maxLine })}
                          </span>
                          <DeskButton
                            action="split-line-plus"
                            variant="ghost"
                            compact
                            busy={!!busy}
                            aria-label={t('resume.editor.splitLinePlus')}
                            {...dead(afterBusy(line >= maxLine, 'AT_LAST_LINE'))}
                            onClick={() => stepSplitLine(`${section.id}/${entry.id}`, 1, maxLine)}
                          >
                            <Plus size={11} />
                          </DeskButton>
                        </span>
                      )}
                      <DeskButton
                        action="split-entry"
                        variant="line"
                        compact
                        busy={!!busy}
                        {...dead(afterBusy(!canSplit, 'NO_BODY_TO_SPLIT'))}
                        onClick={() => splitEntry(section.id, entry.id, line)}
                      >
                        <Split size={11} />
                        {t('resume.editor.split')}
                      </DeskButton>
                      <DeskButton
                        action="merge-entry"
                        variant="line"
                        compact
                        busy={!!busy}
                        {...dead(afterBusy(entryIndex === 0, 'NOTHING_TO_MERGE'))}
                        onClick={() => mergeEntry(section.id, entry.id)}
                      >
                        <Merge size={11} />
                        {t('resume.editor.merge')}
                      </DeskButton>
                    </li>
                  );
                })}
              </ul>
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
        <DeskButton
          action="save-editor"
          variant="amber"
          compact
          busy={!!busy}
          {...dead(saveReason)}
          onClick={() => {
            void save();
          }}
        >
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
