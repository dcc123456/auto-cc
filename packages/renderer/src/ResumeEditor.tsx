import { AlertTriangle, GripVertical, Redo2, Save, Timer, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EditorMetricKeyView, ResumeEditorView, ResumeLocaleView } from '@auto-cc/shared';
import { useBridgeAction } from './useBridgeAction';

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
 * @param docId 要编辑的简历文档 id（由 `ResumePanel` 的种子/导入结果给出）
 * @param onClose 人按"关闭编辑器"且拦截通过后要走的卸载动作（裁定⑪：拦截只做组件卸载这一层）
 */
export function ResumeEditor({ docId, onClose }: { docId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [view, setView] = useState<ResumeEditorView>();
  const [previewHtml, setPreviewHtml] = useState<string>();
  const [previewMs, setPreviewMs] = useState<number>();
  const [rejected, setRejected] = useState<string>();
  const [confirmClose, setConfirmClose] = useState(false);
  const [drag, setDrag] = useState<DragState>();
  /** 拖拽落点要读实时值：`pointerup` 的闭包里读 state 会拿到起手那一刻的旧落点。 */
  const dragRef = useRef<DragState | undefined>(undefined);
  /** 区块行的 DOM，用于按指针位置算落点下标。 */
  const rowRefs = useRef(new Map<number, HTMLDivElement>());

  /**
   * 拉一次当前 draft 的预览 HTML 并计时（3.6-08 的读数来源就是这一趟跨进程往返）。
   * 它不走 `run`：`run` 结束会调 `read`，而 `read` 里就要调它——绕成递归的话每次动作会翻倍发调用。
   */
  const refreshPreview = useCallback(async () => {
    if (!bridge) return;
    const started = performance.now();
    const reply = await bridge.resume['editor.preview'](docId);
    setPreviewMs(Math.round(performance.now() - started));
    if (reply?.ok) setPreviewHtml(reply.value);
  }, [bridge, docId]);

  /** 每个动作结束后一律重读投影 + 重取预览：界面不猜主进程当下的状态（AGENTS.md §2.5）。 */
  const read = useCallback(async () => {
    const reply = await bridge?.resume['editor.view'](docId);
    if (reply?.ok) setView(reply.value);
    await refreshPreview();
  }, [bridge, docId, refreshPreview]);

  const { busy, notice, run } = useBridgeAction(read);

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
   * 拖拽进行期间挂上 window 的 pointer 监听：move 算落点，up 提交那一次 `move`。
   * 落点没变（`overIndex === fromIndex`）时一个字节都不发——3.6-03 的"空编辑不进栈"判在主进程那侧，
   * 但界面也不该白跑一趟跨进程调用。
   */
  useEffect(() => {
    if (!drag) return;
    const rowCount = view?.sections.length ?? 0;
    if (rowCount === 0) return;
    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const overIndex = indexOfPointer(event.clientY, rowCount);
      if (overIndex === current.overIndex) return;
      const next = { fromIndex: current.fromIndex, overIndex };
      dragRef.current = next;
      setDrag(next);
    };
    const up = () => {
      const current = dragRef.current;
      dragRef.current = undefined;
      setDrag(undefined);
      if (!current || current.overIndex === current.fromIndex || !view) return;
      const section = view.sections[current.fromIndex];
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
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // 只由"是否正在拖"驱动：监听里读的是 ref 与本次渲染的快照，落点每次变化都重挂监听反而丢事件。
  }, [drag !== undefined]);

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
        className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-[11px] text-slate-400"
      >
        {t('resume.editor.loading')}
      </section>
    );
  }

  const rowCount = view.sections.length;
  const overThreshold = previewMs !== undefined && previewMs > view.timing.maxPreviewResponseMs;
  const isLargeDocument = rowCount > view.timing.largeDocumentSectionCount;

  return (
    <section data-testid="resume-editor" className="rounded-xl border border-indigo-900 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <GripVertical size={16} />
          {t('resume.editor.heading')}
          <span className="break-all text-[11px] font-normal text-slate-500">{view.docId}</span>
        </h3>
        <button
          type="button"
          data-action="close-editor"
          disabled={!!busy}
          onClick={requestClose}
          className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800 disabled:opacity-40"
        >
          <X size={12} />
          {t('resume.editor.close')}
        </button>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
        <span
          data-testid="resume-editor-dirty"
          data-dirty={String(view.isDirty)}
          className={
            view.isDirty
              ? 'rounded border border-amber-800 px-1 text-amber-300'
              : 'rounded border border-slate-700 px-1 text-slate-400'
          }
        >
          {t(view.isDirty ? 'resume.editor.dirty' : 'resume.editor.clean')}
        </span>
        <label className="flex items-center gap-1 text-slate-400">
          {t('resume.editor.template')}
          <select
            data-testid="resume-editor-template"
            value={view.templateId}
            disabled={!!busy}
            onChange={(event) => useTemplate(event.target.value)}
            className="rounded-md border border-slate-700 bg-slate-950 px-1 py-0.5 text-[11px] text-slate-200"
          >
            {view.templates.map((template) => (
              <option key={template} value={template}>
                {template}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-slate-400">
          {t('resume.editor.previewLocale')}
          <select
            data-testid="resume-editor-locale"
            value={view.locale}
            disabled={!!busy}
            onChange={(event) => useTemplate(undefined, event.target.value as ResumeLocaleView)}
            className="rounded-md border border-slate-700 bg-slate-950 px-1 py-0.5 text-[11px] text-slate-200"
          >
            <option value="zh-CN">zh-CN</option>
            <option value="en">en</option>
          </select>
        </label>
      </div>

      {confirmClose && (
        <div
          data-testid="resume-editor-close-confirm"
          className="mt-2 rounded-md border border-amber-900 bg-amber-950/30 p-3"
        >
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-200">
            <AlertTriangle size={14} />
            {t('resume.editor.closeConfirmTitle')}
          </p>
          <p className="mt-1 text-[11px] text-amber-200/70">{t('resume.editor.closeConfirmHint')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              data-action="close-save"
              disabled={!!busy}
              onClick={() => {
                // 先等保存那一趟跨进程往返真落地，再卸载：反过来会留下一份"看起来存了其实没存"的草稿
                // （裁定⑨ 之后界面没有第二次恢复入口，所以这一步的顺序不能马虎）。
                void bridge?.resume['editor.save'](docId).then(() => onClose());
              }}
              className="rounded-md border border-emerald-800 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-950 disabled:opacity-40"
            >
              {t('resume.editor.saveAndLeave')}
            </button>
            <button
              type="button"
              data-action="close-discard"
              onClick={() => onClose()}
              className="rounded-md border border-rose-800 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-950"
            >
              {t('resume.editor.discardAndLeave')}
            </button>
            <button
              type="button"
              data-action="close-stay"
              onClick={() => setConfirmClose(false)}
              className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
            >
              {t('resume.editor.keepEditing')}
            </button>
          </div>
        </div>
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
            className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950/60 px-2 py-1.5"
          >
            <span
              data-testid="resume-editor-handle"
              data-action="drag-section"
              onPointerDown={(event) => {
                event.preventDefault();
                const initial = { fromIndex: index, overIndex: index };
                dragRef.current = initial;
                setDrag(initial);
              }}
              className={
                drag?.fromIndex === index
                  ? 'cursor-grabbing rounded border border-indigo-600 px-1 text-indigo-300'
                  : 'cursor-grab rounded border border-slate-700 px-1 text-slate-400 hover:bg-slate-800'
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
                  ? 'flex-1 rounded border border-dashed border-indigo-500 px-1 py-0.5'
                  : 'flex-1 rounded border border-transparent px-1 py-0.5'
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
              <input
                data-testid={`resume-editor-metric-${row.key}`}
                type="range"
                min={Number((bound.min - reach).toFixed(2))}
                max={Number((bound.max + reach).toFixed(2))}
                step={row.step}
                value={current}
                disabled={!!busy}
                onChange={(event) => setMetric(row.key, Number(event.target.value))}
                className="w-44 accent-indigo-500"
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

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-action="undo"
          disabled={!view.canUndo || !!busy}
          onClick={() => stepHistory('undo')}
          className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800 disabled:opacity-40"
        >
          <Undo2 size={12} />
          {t('resume.editor.undo')}
        </button>
        <button
          type="button"
          data-action="redo"
          disabled={!view.canRedo || !!busy}
          onClick={() => stepHistory('redo')}
          className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800 disabled:opacity-40"
        >
          <Redo2 size={12} />
          {t('resume.editor.redo')}
        </button>
        <button
          type="button"
          data-action="save-editor"
          disabled={!view.isDirty || !!busy}
          onClick={save}
          className="flex items-center gap-1 rounded-md border border-emerald-800 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-950 disabled:opacity-40"
        >
          <Save size={12} />
          {t('resume.editor.save')}
        </button>
      </div>

      {rejected && (
        <p
          data-testid="resume-editor-rejected"
          className="mt-2 break-all rounded-md border border-rose-900 bg-rose-950/40 px-3 py-2 text-[11px] text-rose-200"
        >
          {t('resume.editor.rejected', { message: rejected })}
        </p>
      )}

      {notice && (
        <p
          data-testid="resume-editor-notice"
          className="mt-2 break-all rounded-md border border-slate-700 bg-slate-950/70 px-3 py-2 text-[11px] text-slate-300"
        >
          {notice}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
        <span
          data-testid="resume-editor-timing"
          data-over={String(overThreshold)}
          className={
            overThreshold
              ? 'flex items-center gap-1 rounded border border-amber-800 px-1 text-amber-300'
              : 'flex items-center gap-1 rounded border border-slate-700 px-1 text-slate-400'
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
            className="rounded border border-amber-900 px-1 text-[11px] text-amber-300"
          >
            {t('resume.editor.largeDocument', { count: rowCount, threshold: view.timing.largeDocumentSectionCount })}
          </span>
        )}
      </div>

      {previewHtml ? (
        <iframe
          data-testid="resume-editor-preview"
          title={t('resume.editor.heading')}
          sandbox=""
          srcDoc={previewHtml}
          className="mt-3 h-[520px] w-full rounded-md border border-slate-800 bg-white"
        />
      ) : (
        <p className="mt-3 text-[11px] text-slate-500" data-testid="resume-editor-preview-empty">
          {t('resume.editor.previewEmpty')}
        </p>
      )}
    </section>
  );
}
