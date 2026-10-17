/**
 * 编辑器里的**一页纸**：pdf.js 真实位图为底，上面一层 DOM 对象层。
 *
 * 三层命中关系（E2）：
 * 1. 行盒热区（仅指针工具、仅源页有文本层时）——悬停描淡边，双击进就地改字；
 * 2. 已提交的文字对象——单击选中（可拖动/八手柄缩放）、双击改字；
 * 3. 文本框工具下在空白处橡皮筋拖框——松手即新建文本框并落光标。
 *
 * 坐标一律走**比例矩形**（相对显示面、原点左上），与主进程对象模型同一口径；
 * 拖拽过程只更新 `model.liveRects`（不进撤销栈），松手才提交一次会话动作。
 *
 * 渲染层铁律（AGENTS.md §5.1）：JSX 不写 `style`——所有运行期数值（位置/尺寸/字号/颜色/宽高比）
 * 都写进 CSS 自定义属性（ref 上 setProperty），class 里只留 Tailwind 任意值字面量。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DeskTextarea } from '../ui/controls';
import type { PdfEditorPageInput, PdfObjectRatioRect } from '@auto-cc/plugin-pdf-edit/object-model';
import type { PdfEditorModel } from './usePdfEditor';
import { cssAscentRatioOf, fontPxOf, fontFamilyCssOf, moveRect, resizeRect, rubberRect } from './editor-tools';
import { FloatingTextBar } from './FloatingTextBar';

type HandleKind = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: readonly HandleKind[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** 手柄在盒子上的定位（-translate-1/2 由类名补）。 */
const HANDLE_CLASS: Record<HandleKind, string> = {
  nw: 'left-0 top-0 cursor-nwse-resize',
  n: 'left-1/2 top-0 -translate-x-1/2 cursor-ns-resize',
  ne: 'right-0 top-0 cursor-nesw-resize',
  e: 'right-0 top-1/2 -translate-y-1/2 cursor-ew-resize',
  se: 'right-0 bottom-0 cursor-nwse-resize',
  s: 'left-1/2 bottom-0 -translate-x-1/2 cursor-ns-resize',
  sw: 'left-0 bottom-0 cursor-nesw-resize',
  w: 'left-0 top-1/2 -translate-y-1/2 cursor-ew-resize',
};

/** 位图宽度变化超过这个比例才真重画（拖把手缩放时先用 CSS 拉伸，停手再出清晰图）。 */
const REPAINT_WIDTH_DELTA = 0.06;

/**
 * 指针点 → 相对纸面的比例坐标（React 与原生 PointerEvent 同形，只收 clientX/Y 两个读数）。
 */
function ratioPointOf(event: { clientX: number; clientY: number }, surface: HTMLElement) {
  const rect = surface.getBoundingClientRect();
  return {
    xRatio: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    yRatio: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
}

/**
 * 一只可拖可缩放盒子（已提交对象或就地输入框共用）的拖拽会话。
 * 移动走 onLive 实时回传，松手按最后一帧 `last` 走 onCommit 一次。
 */
interface DragSession {
  mode: 'move' | HandleKind;
  startX: number;
  startY: number;
  origin: PdfObjectRatioRect;
  last: PdfObjectRatioRect;
  onLive: (rect: PdfObjectRatioRect) => void;
  onCommit: (rect: PdfObjectRatioRect) => void;
}

/**
 * 比例定位盒：把矩形四值写进四个 CSS 变量，位置/尺寸只由 Tailwind 任意值类消费。
 * 额外变量（字号/颜色/字族/基线/宽高比）走 `extraVars`，随渲染帧刷新。
 */
function RatioBox({
  rect,
  extraVars,
  className = '',
  children,
  onPointerDown,
  onDoubleClick,
  markers,
}: {
  rect: PdfObjectRatioRect;
  extraVars?: Record<string, string>;
  className?: string;
  children?: React.ReactNode;
  onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onDoubleClick?: (event: React.PointerEvent<HTMLDivElement>) => void;
  markers?: Record<string, string>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.setProperty('--re-x', `${rect.xRatio * 100}%`);
    node.style.setProperty('--re-y', `${rect.yRatio * 100}%`);
    node.style.setProperty('--re-w', `${rect.widthRatio * 100}%`);
    node.style.setProperty('--re-h', `${rect.heightRatio * 100}%`);
    if (extraVars) {
      for (const [key, value] of Object.entries(extraVars)) node.style.setProperty(key, value);
    }
  });
  return (
    <div
      ref={ref}
      {...markers}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      className={`absolute left-(--re-x) top-(--re-y) h-(--re-h) w-(--re-w) ${className}`}
    >
      {children}
    </div>
  );
}

export function PdfEditorPageCanvas({ model, pageIndex }: { model: PdfEditorModel; pageIndex: number }) {
  const { t } = useTranslation();
  const entry: PdfEditorPageInput | undefined = model.pages[pageIndex];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const paintedWidthRef = useRef(0);
  const paintSeqRef = useRef(0);
  const paintChainRef = useRef<Promise<void>>(Promise.resolve());
  const dragRef = useRef<DragSession | undefined>(undefined);
  const [rubber, setRubber] = useState<PdfObjectRatioRect | undefined>(undefined);

  const paper = entry ? model.paperOf(entry.id) : undefined;
  // 挂载即登记懒解析（pdf.js 文本层与位图同源，见 pdf-page-view.ts）。
  useEffect(() => {
    if (entry) model.ensurePaper(entry);
  }, [entry, model.ensurePaper]);

  // 纸面宽高比（旋转 90/270 互换，E2 没有旋转操作，仍按真实读数给）。
  const widthPt = paper?.widthPt ?? 595.28;
  const heightPt = paper?.heightPt ?? 841.89;
  useEffect(() => {
    sheetRef.current?.style.setProperty('--re-ar', `${widthPt} / ${heightPt}`);
  }, [widthPt, heightPt]);

  const paintNow = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || !paper) return;
    const cssWidth = Math.round(canvas.clientWidth);
    if (cssWidth < 1) return;
    const seq = paintSeqRef.current + 1;
    paintSeqRef.current = seq;
    await paper.paint(canvas, cssWidth);
    if (seq !== paintSeqRef.current) return;
    paintedWidthRef.current = cssWidth;
  }, [paper]);

  const repaint = useCallback((): Promise<void> => {
    paintChainRef.current = paintChainRef.current.then(paintNow, paintNow);
    return paintChainRef.current;
  }, [paintNow]);

  // 纸面就绪、纸宽变化（缩放）都重画；容器宽观察器负责拖把手那一路的阈值重画。
  useEffect(() => {
    void repaint();
  }, [repaint, model.pageWidthPx]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => {
      const cssWidth = Math.round(canvas.clientWidth);
      if (
        cssWidth < 1 ||
        (paintedWidthRef.current > 0 &&
          Math.abs(cssWidth - paintedWidthRef.current) / paintedWidthRef.current <= REPAINT_WIDTH_DELTA)
      ) {
        return;
      }
      void repaint();
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [repaint]);

  /** 在纸面上开始一次拖拽（移动或手柄缩放），指针移到窗外也照收。 */
  const beginDrag = (
    event: React.PointerEvent,
    mode: DragSession['mode'],
    origin: PdfObjectRatioRect,
    onLive: DragSession['onLive'],
    onCommit: DragSession['onCommit'],
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const surface = sheetRef.current;
    if (!surface) return;
    const start = ratioPointOf(event, surface);
    const session: DragSession = { mode, startX: start.xRatio, startY: start.yRatio, origin, last: origin, onLive, onCommit };
    dragRef.current = session;

    const onMove = (moveEvent: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const point = ratioPointOf(moveEvent, surface);
      current.last =
        current.mode === 'move'
          ? moveRect(current.origin, point.xRatio - current.startX, point.yRatio - current.startY)
          : resizeRect(current.origin, current.mode, point);
      current.onLive(current.last);
    };
    const onUp = () => {
      const current = dragRef.current;
      dragRef.current = undefined;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      current?.onCommit(current.last);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /** 纸面空白处按下：文本框工具＝橡皮筋；指针工具＝点空白取消选中。 */
  const onSurfacePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const surface = event.currentTarget;
    if (model.inline) return;
    if (model.tool === 'text') {
      const start = ratioPointOf(event, surface);
      const onMove = (moveEvent: PointerEvent) => {
        const point = ratioPointOf(moveEvent, surface);
        setRubber({
          xRatio: Math.min(start.xRatio, point.xRatio),
          yRatio: Math.min(start.yRatio, point.yRatio),
          widthRatio: Math.abs(point.xRatio - start.xRatio),
          heightRatio: Math.abs(point.yRatio - start.yRatio),
        });
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setRubber((current) => {
          if (current) {
            const rect = rubberRect(
              { xRatio: current.xRatio, yRatio: current.yRatio },
              { xRatio: current.xRatio + current.widthRatio, yRatio: current.yRatio + current.heightRatio },
            );
            if (rect && entry) model.beginNewTextBox(entry.id, rect);
          }
          return undefined;
        });
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      return;
    }
    model.setSelectedId(undefined);
  };

  /** 已提交对象的拖拽：live 进 liveRects，松手提交一次会话动作。 */
  const beginObjectDrag = (
    event: React.PointerEvent,
    objectId: string,
    mode: DragSession['mode'],
    origin: PdfObjectRatioRect,
  ) => {
    beginDrag(
      event,
      mode,
      origin,
      (rect) => model.setLiveRect(objectId, rect),
      (rect) => {
        model.setLiveRect(objectId, undefined);
        model.commitRect(objectId, rect);
      },
    );
  };

  /** 就地输入框的拖拽：直接改 inline.rect（不碰会话，提交输入框时才入栈）。 */
  const beginInlineDrag = (event: React.PointerEvent, mode: DragSession['mode'], origin: PdfObjectRatioRect) => {
    beginDrag(
      event,
      mode,
      origin,
      (rect) => model.patchInline({ rect }),
      (rect) => model.patchInline({ rect }),
    );
  };

  if (!entry) return null;
  const pageObjects = model.objects.filter((object) => object.pageId === entry.id);
  const inlineOnThisPage = model.inline?.pageId === entry.id ? model.inline : undefined;
  const lineZonesActive = model.tool === 'pointer' && !model.inline;

  return (
    <div
      data-editor-page-index={pageIndex}
      data-page-id={entry.id}
      className="mx-auto w-(--re-page-w) shrink-0"
    >
      <div
        ref={sheetRef}
        className="relative aspect-(--re-ar) overflow-hidden rounded-sm bg-white shadow-sheet ring-1 ring-black/10"
      >
        {entry.kind === 'source' ? (
          <canvas
            ref={canvasRef}
            data-testid={`pdf-editor-canvas-${pageIndex}`}
            className="absolute inset-0 block h-full w-full"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center bg-white text-[11px] text-slate-300">
            {t('pdfEditor.blankPage')}
          </div>
        )}

        {/* 对象层（含行盒热区、对象、橡皮筋、就地输入框；都不挡位图的右键/复制）。 */}
        <div
          className="absolute inset-0"
          data-testid={`pdf-editor-surface-${pageIndex}`}
          onPointerDown={onSurfacePointerDown}
        >
          {/* 行盒热区：双击就地改字。平时透明，悬停才有淡蓝描边。 */}
          {lineZonesActive &&
            paper?.lines.map((line) => (
              <RatioBox
                key={line.lineId}
                rect={line.rect}
                markers={{ 'data-line-id': line.lineId }}
                className="cursor-text rounded-[1px] border border-transparent hover:border-blue-500/60 hover:bg-blue-500/5"
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  model.beginLineEdit(entry.id, line);
                }}
              />
            ))}

          {/* 已提交对象（E2 只有 text；E3 在此层扩 image/shape/highlight/note）。 */}
          {pageObjects.map((object) => {
            if (object.kind !== 'text') return null;
            const rect = model.liveRects[object.id] ?? object.rect;
            const selected = model.selectedId === object.id;
            const inPlace = object.backdropHex !== undefined;
            return (
              <RatioBox
                key={object.id}
                rect={rect}
                markers={{ 'data-object-id': object.id }}
                className={selected ? 'z-30' : 'z-20'}
                onPointerDown={(event) => {
                  // 任何工具下点对象都不应穿透到纸面（否则文本框工具会在对象背后拖出橡皮筋）。
                  event.stopPropagation();
                  if (model.inline) return;
                  model.setSelectedId(object.id);
                  if (model.tool === 'pointer') beginObjectDrag(event, object.id, 'move', rect);
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  model.beginObjectEdit(object);
                }}
              >
                <div
                  className={`h-full w-full overflow-hidden leading-none whitespace-pre-wrap ${
                    selected
                      ? 'outline outline-2 outline-blue-600'
                      : 'outline outline-1 outline-transparent hover:outline-blue-400/70'
                  } ${object.bold ? 'font-bold' : 'font-normal'} ${object.italic ? 'italic' : ''} ${
                    object.underline ? 'underline' : ''
                  } [font-family:var(--re-ff)] bg-(--re-bg) text-(--re-ink) text-[length:var(--re-fs)] ${
                    model.tool === 'pointer' ? 'cursor-move' : 'cursor-default'
                  }`}
                    ref={(node) => {
                      if (!node) return;
                      const familyCss = fontFamilyCssOf(object.fontFamilyHint);
                      node.style.setProperty('--re-fs', `${fontPxOf(object.sizePt ?? 11, model.pageWidthPx, widthPt)}px`);
                      node.style.setProperty('--re-ink', object.colorHex ?? '#1f2937');
                      node.style.setProperty('--re-bg', object.backdropHex ?? 'transparent');
                      node.style.setProperty('--re-ff', familyCss);
                      // 基线回拉按本机字体真实升部（行盒是照 PDF 内嵌字体升部量的，0.8 硬编码对 Helvetica 偏 1px+）。
                      node.style.setProperty('--re-asc', `-${cssAscentRatioOf(familyCss).toFixed(4)}em`);
                    }}
                >
                  {object.baselineYRatio !== undefined ? (
                    <span
                      className="absolute left-0 right-0 top-(--re-base) translate-y-[var(--re-asc)]"
                      ref={(node) => {
                        node?.style.setProperty(
                          '--re-base',
                          `${((object.baselineYRatio! - rect.yRatio) / rect.heightRatio) * 100}%`,
                        );
                      }}
                    >
                      {object.text}
                    </span>
                  ) : (
                    <span className="block px-[2px] py-[1px]">{object.text}</span>
                  )}
                </div>
                {selected && !model.inline && (
                  <>
                    {HANDLES.map((handle) => (
                      <span
                        key={handle}
                        className={`absolute z-30 h-2.5 w-2.5 rounded-full border border-blue-700 bg-white ${HANDLE_CLASS[handle]}`}
                        onPointerDown={(event) => beginObjectDrag(event, object.id, handle, rect)}
                      />
                    ))}
                  </>
                )}
                {selected && inPlace && <span className="sr-only">{t('pdfEditor.a11yInPlaceText')}</span>}
              </RatioBox>
            );
          })}

          {/* 文本框工具的橡皮筋。 */}
          {rubber && (
            <RatioBox
              rect={rubber}
              className="pointer-events-none z-30 border border-blue-600 bg-blue-500/10"
            />
          )}

          {/* 就地输入框（行盒改字 / 新建文本框同一只）。 */}
          {inlineOnThisPage && (
            <InlineEditor
              key={inlineOnThisPage.objectId}
              model={model}
              pageWidthPt={widthPt}
              pageHeightPt={heightPt}
              beginDrag={(event, mode) => beginInlineDrag(event, mode, inlineOnThisPage.rect)}
            />
          )}
        </div>
      </div>
      <p className="mt-1 text-center text-[11px] text-slate-400" data-testid={`pdf-editor-page-label-${pageIndex}`}>
        {t('pdfEditor.pageLabel', { index: pageIndex + 1, total: model.pages.length })}
        {entry.kind === 'source' && paper?.lines.length === 0 ? ` · ${t('pdfEditor.scannedHint')}` : ''}
      </p>
    </div>
  );
}

/**
 * 盖在纸上的就地输入框：字号/字族/基线照行盒读数，Esc 取消、Ctrl/⌘+Enter 提交；
 * 行盒改字回车即提交（单行），文本框回车换行。
 */
function InlineEditor({
  model,
  pageWidthPt,
  pageHeightPt,
  beginDrag,
}: {
  model: PdfEditorModel;
  pageWidthPt: number;
  pageHeightPt: number;
  beginDrag: (event: React.PointerEvent, mode: DragSession['mode']) => void;
}) {
  const { t } = useTranslation();
  const inline = model.inline;
  useEffect(() => {
    // 光标落在文字末尾：双击改字时人通常从尾部接着改。DeskTextarea 不收 ref，
    // 而就地输入框全局只有一只，按 data-action 取节点即可。
    const node = document.querySelector<HTMLTextAreaElement>('[data-action="pdf-editor-inline-text"]');
    if (!node) return;
    const end = node.value.length;
    node.setSelectionRange(end, end);
  }, []);
  if (!inline) return null;

  const fontPx = fontPxOf(inline.fontSizePt, model.pageWidthPx, pageWidthPt);
  const familyCss = fontFamilyCssOf(inline.fontFamilyHint);
  // 行盒顶边是照 PDF 内嵌字体升部量的；textarea 里按本机字体排，两套基线之差用位移补回
  // （内边距会挤掉单行那 9 个像素的盒高，位移不参与排版也不产生滚动条）。
  const pageHeightPx = (model.pageWidthPx * pageHeightPt) / pageWidthPt;
  const isLineEdit = inline.baselineYRatio !== undefined;
  const verticalShiftPx = isLineEdit
    ? (inline.baselineYRatio! - inline.rect.yRatio) * pageHeightPx - cssAscentRatioOf(familyCss) * fontPx
    : 0;

  return (
    <RatioBox
      rect={inline.rect}
      className="z-40"
      markers={{ 'data-testid': 'pdf-editor-inline-input' }}
      extraVars={{
        // 字号/墨色/字族/基线修正挂在盒子上向 textarea 继承（AGENTS.md §5.1：JSX 不写 style）。
        // 底色不设：bare 档本就透明，输入框直接透出底下那张真实纸（蓝边/光环负责框出可编辑区）。
        '--re-fs': `${fontPx}px`,
        '--re-ink': inline.colorHex ?? '#1f2937',
        '--re-ff': familyCss,
        '--re-vshift': `${verticalShiftPx.toFixed(2)}px`,
      }}
      onPointerDown={(event) => beginDrag(event, 'move')}
    >
      <DeskTextarea
        action="pdf-editor-inline-text"
        bare
        autoFocus
        spellCheck={false}
        maxLength={2000}
        value={inline.value}
        onValueChange={(value) => model.patchInline({ value })}
        onBlur={() => model.commitInline()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            model.cancelInline();
            return;
          }
          if (event.key === 'Enter' && (inline.lineId !== undefined || event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            model.commitInline();
            return;
          }
          event.stopPropagation(); // 别触发全局撤销/删除快捷键
        }}
        onPointerDown={(event) => event.stopPropagation()}
        aria-label={t('pdfEditor.inlineAriaLabel')}
        className={`h-full w-full !border-blue-600 !leading-none overflow-hidden outline-none ring-2 ring-blue-600/30 ${
          // 行盒改字是「一行 PDF 文字」：不许折行（折出来的第二行会盖到下一行），横向溢出裁掉；
          // 文本框才允许在框内折行。
          isLineEdit ? 'translate-y-[var(--re-vshift)] whitespace-nowrap' : '!p-[2px] whitespace-pre-wrap'
        } ${inline.bold ? 'font-bold' : 'font-normal'} ${inline.italic ? 'italic' : ''} ${
          inline.underline ? 'underline' : ''
        } ![font-family:var(--re-ff)] !text-[length:var(--re-fs)] !text-(--re-ink)`}
      />
      {/* 编辑中也允许缩放框体（与选中对象同一组手柄）。 */}
      {HANDLES.map((handle) => (
        <span
          key={handle}
          className={`absolute z-40 h-2.5 w-2.5 rounded-full border border-blue-700 bg-white ${HANDLE_CLASS[handle]}`}
          onPointerDown={(event) => {
            event.stopPropagation();
            beginDrag(event, handle);
          }}
        />
      ))}
      <FloatingTextBar model={model} />
    </RatioBox>
  );
}
