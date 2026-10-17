/**
 * WPS 形态 PDF 编辑器的**唯一一份状态**（WPS 反转裁定后的新整页编辑轨）。
 *
 * 与 `usePdfView` 同一条纪律：纸由 pdf.js 画（`loadPdfPaper`），字节只走 `pdf.io.bytes`，
 * 写口只走 `pdf.export.saveEditor`（源文件只读、只另存新 PDF）；草稿是**纯内存**的对象表，
 * 撤销重放走主进程同包的 `createPdfEditorSession`（零 Node 依赖，渲染层直接 import）。
 *
 * 反伪装底线（spec 3.5-04）：就地改字是「垫纸色 + 重绘新字」，旧文字在文本层仍可复制搜索——
 * 本 hook 与界面任何读数都不使用「已删除原文」这一类说法。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppErrorPayload, PdfEditorObjectView, PdfEditorPageView } from '@auto-cc/shared';
import type {
  PdfEditorObjectInput,
  PdfEditorPageInput,
  PdfObjectRatioRect,
} from '@auto-cc/plugin-pdf-edit/object-model';
import type { FontFamilyHint } from '@auto-cc/plugin-pdf-edit/text-metrics';
import { createPdfEditorSession, type PdfEditorSession } from '@auto-cc/plugin-pdf-edit/object-session';
import type { PdfPaper, PdfPaperPage, PdfTextLine } from '../pdf-page-view';
import { loadPdfPaper } from '../pdf-page-view';
import {
  EDITOR_LIMITS,
  PAGE_WIDTH_100_PX,
  ZOOM_MAX_WIDTH_PX,
  ZOOM_MIN_WIDTH_PX,
  ZOOM_STEP,
  lineObjectId,
  nextObjectId,
} from './editor-tools';

/** 装载状态（与查看轨同一口径：idle/loading/ready/failed，外加没文件时编辑器根本不挂载）。 */
export type EditorLoadState = 'loading' | 'ready' | 'failed';

/** 双击行 / 双击对象后，盖在纸上的那只就地输入框。 */
export interface InlineEditState {
  /** 输入框所属页计划条目。 */
  pageId: string;
  /** 提交时写入（或更新）的对象 id——行盒改字是确定性 id，同一行反复改只更新一只对象。 */
  objectId: string;
  /** 行盒 id（就地改字时在；文本框新建时不在）。 */
  lineId?: string;
  /** 打开输入框那一刻的原文；改回原文等于撤销这一层盖写（删掉对象）。 */
  originalText: string;
  /** 输入框当下文字（受控）。 */
  value: string;
  /** 字号（pt）：行盒取该行读数，文本框取默认 11pt。 */
  fontSizePt: number;
  fontFamilyHint?: FontFamilyHint;
  /** 基线比例（行盒读数）；文本框省略，按矩形内正常排。 */
  baselineYRatio?: number;
  /** 垫纸色：有它写出的就是「就地改字」，没有就是文本框。 */
  backdropHex?: string;
  /** 墨色（用户在浮动条上改了才有；省略时引擎按量到的纸色自己定墨）。 */
  colorHex?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** 输入框矩形（比例）；行盒首次进编辑取行盒矩形，之后随对象本体走。 */
  rect: PdfObjectRatioRect;
  /** 这是不是一次「拖框新建文本框」（取消即什么都不留）。 */
  isNew: boolean;
}

/** 已解析页的纸面句柄登记项。 */
interface PaperEntry {
  status: 'loading' | 'ready';
  paper?: PdfPaperPage;
}

/** 把任意异常转成一句可展示的话（与查看轨同一句式）。 */
function reasonOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error);
}

/**
 * 编辑器模型。
 * @param filePath 要编辑的源 PDF 绝对路径（由 desk 的 PDF 查看档「在编辑器中打开」递进来）
 * @param onClose 人要求退出编辑器（脏态拦截通过后才真的卸载，由屏组件调 `discardAndClose`）
 */
export function usePdfEditor(filePath: string, onClose: () => void) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [loadState, setLoadState] = useState<EditorLoadState>('loading');
  const [loadError, setLoadError] = useState<string>();
  const [fileName, setFileName] = useState('');

  /** 编辑会话（ref 持有，每次动作后把 draft 镜像到 state 驱动渲染）。 */
  const sessionRef = useRef<PdfEditorSession | undefined>(undefined);
  const [pages, setPages] = useState<readonly PdfEditorPageInput[]>([]);
  const [objects, setObjects] = useState<readonly PdfEditorObjectInput[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'celadon' | 'seal' | 'amber' }>();

  const [tool, setTool] = useState<'pointer' | 'text'>('pointer');
  const [selectedId, setSelectedId] = useState<string>();
  const [inline, setInline] = useState<InlineEditState>();
  /** 拖拽过程中的实时矩形（不进撤销栈）：key=对象 id，松手时才提交一次会话动作。 */
  const [liveRects, setLiveRects] = useState<Record<string, PdfObjectRatioRect>>({});
  /** 左右两条轨的开合（缩略图 / 属性卡）。 */
  const [thumbsOpen, setThumbsOpen] = useState(true);
  const [propsOpen, setPropsOpen] = useState(true);
  /** 脏态离开拦截框。 */
  const [guardOpen, setGuardOpen] = useState(false);
  /** 另存成功后的产物路径（提示行里给人看）。 */
  const [savedTo, setSavedTo] = useState<string>();

  /** 纸宽（px，缩放口径）；进屏先按 A4 100%，首帧量完容器再适应宽度。 */
  const [pageWidthPx, setPageWidthPx] = useState(PAGE_WIDTH_100_PX);
  /** 滚动位置照出的当下页（0 起）。 */
  const [currentPageIndex, setCurrentPageIndex] = useState(0);

  const paperDocRef = useRef<PdfPaper | null>(null);
  const papersRef = useRef<Map<string, PaperEntry>>(new Map());
  const [, setPaperTick] = useState(0);
  const loadSeqRef = useRef(0);

  /** 把会话当下状态镜像到 React（动作后调用；入栈动作同时把屏标脏）。 */
  const syncFromSession = useCallback((mutated: boolean) => {
    const session = sessionRef.current;
    if (!session) return;
    const draft = session.draft();
    setPages(draft.pages);
    setObjects(draft.objects);
    setCanUndo(session.canUndo());
    setCanRedo(session.canRedo());
    if (mutated) {
      setDirty(true);
      setSavedTo(undefined);
    }
  }, []);

  /** 装载：量页数 → 取字节 → pdf.js 解析 → 初始页计划（1..n 全是源页副本）。 */
  useEffect(() => {
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    let cancelled = false;
    const baseName = filePath.split(/[/\\]/).pop() ?? filePath;
    setFileName(baseName);

    async function boot() {
      const openReply = await bridge?.pdf?.['io.open'](filePath);
      if (cancelled || seq !== loadSeqRef.current) return;
      if (!openReply?.ok) {
        fail(openReply?.error);
        return;
      }
      const bytesReply = await bridge?.pdf?.['io.bytes'](filePath);
      if (cancelled || seq !== loadSeqRef.current) return;
      if (!bytesReply?.ok) {
        fail(bytesReply?.error);
        return;
      }
      let paper: PdfPaper;
      try {
        // pdf.js 会转移这块缓冲，之后不能二次解析。
        paper = await loadPdfPaper(bytesReply.value);
      } catch (error) {
        if (!cancelled && seq === loadSeqRef.current) {
          setLoadState('failed');
          setLoadError(reasonOf(error));
        }
        return;
      }
      if (cancelled || seq !== loadSeqRef.current) {
        void paper.dispose();
        return;
      }
      await paperDocRef.current?.dispose();
      paperDocRef.current = paper;
      const initialPages: PdfEditorPageInput[] = Array.from({ length: openReply.value.pageCount }, (_, index) => ({
        id: `pg-${index + 1}`,
        kind: 'source',
        sourcePageNumber: index + 1,
      }));
      papersRef.current = new Map();
      sessionRef.current = createPdfEditorSession(
        { pages: initialPages, objects: [] },
        {
          sourcePageCount: openReply.value.pageCount,
          limits: {
            maxPages: EDITOR_LIMITS.maxPages,
            maxObjects: EDITOR_LIMITS.maxObjects,
            defaultTextSizePt: EDITOR_LIMITS.defaultTextSizePt,
            minAreaRatio: EDITOR_LIMITS.minAreaRatio,
            defaultBlankWidthPt: EDITOR_LIMITS.defaultBlankWidthPt,
            defaultBlankHeightPt: EDITOR_LIMITS.defaultBlankHeightPt,
          },
        },
      );
      setPages(initialPages);
      setObjects([]);
      setLoadState('ready');
    }

    function fail(error: AppErrorPayload | undefined) {
      setLoadState('failed');
      setLoadError(
        error ? t('pdfEditor.loadFailedWith', { code: error.code, message: error.message }) : t('action.noBridge'),
      );
    }

    void boot();
    return () => {
      cancelled = true;
      loadSeqRef.current += 1;
      void paperDocRef.current?.dispose();
      paperDocRef.current = null;
    };
    // 编辑器按 filePath 单实例挂载，bridge/t 不需要重新触发装载（仓库未启用 exhaustive-deps 规则）。
  }, [filePath]);

  /**
   * 取某条页计划对应的纸面句柄（源页首次取时解析文本层并缓存；同一源页号的副本共用缓存）。
   * 组件靠 `paperTick` 重渲染拿到就绪结果。
   */
  const ensurePaper = useCallback((entry: PdfEditorPageInput): PdfPaperPage | undefined => {
    const doc = paperDocRef.current;
    if (!doc || entry.kind !== 'source') return undefined;
    const existing = papersRef.current.get(entry.id);
    if (existing?.status === 'ready') return existing.paper;
    if (existing?.status === 'loading') return undefined;
    papersRef.current.set(entry.id, { status: 'loading' });
    void doc.page(entry.sourcePageNumber).then((paper) => {
      papersRef.current.set(entry.id, { status: 'ready', paper });
      setPaperTick((tick) => tick + 1);
    });
    return undefined;
  }, []);

  /** 读一条页计划的当下纸面（不触发解析；未就绪回 undefined）。 */
  const paperOf = useCallback((pageId: string): PdfPaperPage | undefined => {
    const entry = papersRef.current.get(pageId);
    return entry?.status === 'ready' ? entry.paper : undefined;
  }, []);

  // ---- 对象动作（每个动作一条撤销单元）----

  const objectList = objects;
  const pageList = pages;

  const addObject = useCallback(
    (object: PdfEditorObjectInput): boolean => {
      const ok = sessionRef.current?.addObject(object) ?? false;
      if (ok) syncFromSession(true);
      return ok;
    },
    [syncFromSession],
  );

  const updateObject = useCallback(
    (object: PdfEditorObjectInput): boolean => {
      const ok = sessionRef.current?.updateObject(object) ?? false;
      if (ok) syncFromSession(true);
      return ok;
    },
    [syncFromSession],
  );

  const removeObject = useCallback(
    (id: string): boolean => {
      const ok = sessionRef.current?.removeObject(id) ?? false;
      if (ok) {
        syncFromSession(true);
        setSelectedId((current) => (current === id ? undefined : current));
        setInline((current) => (current?.objectId === id ? undefined : current));
      }
      return ok;
    },
    [syncFromSession],
  );

  const undo = useCallback((): boolean => {
    const ok = sessionRef.current?.undo() ?? false;
    if (ok) {
      syncFromSession(true);
      setSelectedId(undefined);
      setInline(undefined);
    }
    return ok;
  }, [syncFromSession]);

  const redo = useCallback((): boolean => {
    const ok = sessionRef.current?.redo() ?? false;
    if (ok) {
      syncFromSession(true);
      setSelectedId(undefined);
      setInline(undefined);
    }
    return ok;
  }, [syncFromSession]);

  // ---- 就地输入框 ----

  /** 双击一条原文行：进就地改字（已有盖写对象就改那一只）。 */
  const beginLineEdit = useCallback(
    (pageId: string, line: PdfTextLine) => {
      if (tool !== 'pointer') return;
      const id = lineObjectId(pageId, line.lineId);
      const existing = objectList.find((candidate) => candidate.id === id);
      const paper = paperOf(pageId);
      const backdrop = existing?.backdropHex ?? paper?.sampleBackdrop(line.rect);
      setTool('pointer');
      setInline({
        pageId,
        objectId: id,
        lineId: line.lineId,
        originalText: line.text,
        value: existing?.text ?? line.text,
        fontSizePt: existing?.sizePt ?? line.fontSizePt,
        fontFamilyHint: existing?.fontFamilyHint ?? line.fontFamilyHint,
        baselineYRatio: existing?.baselineYRatio ?? line.baselineRatio,
        backdropHex: backdrop,
        colorHex: existing?.colorHex,
        bold: existing?.bold,
        italic: existing?.italic,
        underline: existing?.underline,
        rect: existing?.rect ?? line.rect,
        isNew: false,
      });
    },
    [objectList, paperOf, tool],
  );

  /** 双击一只已有文字对象：在原框里改字。 */
  const beginObjectEdit = useCallback((object: PdfEditorObjectInput) => {
    if (object.kind !== 'text') return;
    setInline({
      pageId: object.pageId,
      objectId: object.id,
      originalText: object.text ?? '',
      value: object.text ?? '',
      fontSizePt: object.sizePt ?? EDITOR_LIMITS.defaultTextSizePt,
      fontFamilyHint: object.fontFamilyHint,
      baselineYRatio: object.baselineYRatio,
      backdropHex: object.backdropHex,
      colorHex: object.colorHex,
      bold: object.bold,
      italic: object.italic,
      underline: object.underline,
      rect: object.rect,
      isNew: false,
    });
  }, []);

  /**
   * 拖框新建文本框（工具＝text）：只挂一笔**待提交草稿**在就地输入框里（空文本过不了引擎的
   * text-required 判据，会话不收），矩形先由 inline.rect 画在纸上；commit 时连文字一起 addObject。
   */
  const beginNewTextBox = useCallback((pageId: string, rect: PdfObjectRatioRect): void => {
    const id = nextObjectId();
    setInline({
      pageId,
      objectId: id,
      originalText: '',
      value: '',
      fontSizePt: EDITOR_LIMITS.defaultTextSizePt,
      rect,
      isNew: true,
    });
  }, []);

  /** 输入框受控更新（字号/样式/文字/矩形都可能在编辑中被浮动条或拖框改）。 */
  const patchInline = useCallback((patch: Partial<InlineEditState>) => {
    setInline((current) => (current ? { ...current, ...patch } : current));
  }, []);

  /** 提交输入框：写对象（改回原文＝撤掉盖写；空文本框＝不落对象）。 */
  const commitInline = useCallback((): void => {
    setInline((current) => {
      if (!current) return current;
      const { value } = current;
      const existing = objectList.find((candidate) => candidate.id === current.objectId);
      const trimmed = value.trim();
      if (current.isNew) {
        if (trimmed !== '') {
          addObject({
            id: current.objectId,
            pageId: current.pageId,
            kind: 'text',
            rect: current.rect,
            text: value,
            sizePt: current.fontSizePt,
            fontFamilyHint: current.fontFamilyHint,
            colorHex: current.colorHex,
            bold: current.bold,
            italic: current.italic,
            underline: current.underline,
            baselineYRatio: current.baselineYRatio,
            ...(current.backdropHex !== undefined ? { backdropHex: current.backdropHex } : {}),
          });
        }
      } else if (trimmed === '') {
        // 空文本不留盖写层（行盒改字清空＝还原原文最稳妥的口径：删掉对象）。
        if (existing) removeObject(current.objectId);
      } else if (trimmed === current.originalText && current.lineId !== undefined && !current.colorHex) {
        // 行盒改字且文字与原文一致：这一层盖写没有意义，删掉（样式也还原）。
        if (existing) removeObject(current.objectId);
      } else if (existing) {
        updateObject({
          ...existing,
          rect: current.rect,
          text: value,
          sizePt: current.fontSizePt,
          fontFamilyHint: current.fontFamilyHint,
          colorHex: current.colorHex,
          bold: current.bold,
          italic: current.italic,
          underline: current.underline,
          baselineYRatio: current.baselineYRatio,
          ...(current.backdropHex !== undefined ? { backdropHex: current.backdropHex } : { backdropHex: undefined }),
        });
      } else {
        addObject({
          id: current.objectId,
          pageId: current.pageId,
          kind: 'text',
          rect: current.rect,
          text: value,
          sizePt: current.fontSizePt,
          fontFamilyHint: current.fontFamilyHint,
          colorHex: current.colorHex,
          bold: current.bold,
          italic: current.italic,
          underline: current.underline,
          baselineYRatio: current.baselineYRatio,
          ...(current.backdropHex !== undefined ? { backdropHex: current.backdropHex } : {}),
        });
      }
      return undefined;
    });
  }, [addObject, objectList, removeObject, updateObject]);

  /** Esc：取消编辑（新建框取消＝不落任何对象）。 */
  const cancelInline = useCallback(() => setInline(undefined), []);

  // ---- 拖拽（移动 / 缩放在画布组件里算几何，这里只收实时矩形与最终提交）----

  const setLiveRect = useCallback((id: string, rect: PdfObjectRatioRect | undefined) => {
    setLiveRects((current) => {
      const next = { ...current };
      if (rect === undefined) delete next[id];
      else next[id] = rect;
      return next;
    });
  }, []);

  /** 松手提交一次移动/缩放（只占一条撤销单元）。 */
  const commitRect = useCallback(
    (id: string, rect: PdfObjectRatioRect) => {
      setLiveRects((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      const existing = objectList.find((candidate) => candidate.id === id);
      const inlineIsThis = inline?.objectId === id;
      if (inlineIsThis) {
        setInline((current) => (current ? { ...current, rect } : current));
        return;
      }
      if (existing) updateObject({ ...existing, rect });
    },
    [inline?.objectId, objectList, updateObject],
  );

  // ---- 缩放 ----
  /** 人手动碰过缩放后，容器变宽（开合侧栏）不再自动适应，避免抢人刚设好的倍率。 */
  const manualZoomRef = useRef(false);

  const zoomBy = useCallback((factor: number) => {
    manualZoomRef.current = true;
    setPageWidthPx((width) => Math.min(ZOOM_MAX_WIDTH_PX, Math.max(ZOOM_MIN_WIDTH_PX, Math.round(width * factor))));
  }, []);
  const zoomIn = useCallback(() => zoomBy(ZOOM_STEP), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / ZOOM_STEP), [zoomBy]);
  const zoomActual = useCallback(() => {
    manualZoomRef.current = true;
    setPageWidthPx(PAGE_WIDTH_100_PX);
  }, []);
  /** 人点「适应宽度」：显式动作，之后同样不再被自动档改回去。 */
  const fitWidth = useCallback((containerWidthPx: number) => {
    manualZoomRef.current = true;
    if (containerWidthPx < 100) return;
    setPageWidthPx(Math.min(ZOOM_MAX_WIDTH_PX, Math.max(ZOOM_MIN_WIDTH_PX, containerWidthPx - 48)));
  }, []);
  /** 进屏 / 侧栏开合时的自动适应：只在人没手动碰过缩放时生效。 */
  const fitWidthAuto = useCallback((containerWidthPx: number) => {
    if (manualZoomRef.current || containerWidthPx < 100) return;
    setPageWidthPx(Math.min(ZOOM_MAX_WIDTH_PX, Math.max(ZOOM_MIN_WIDTH_PX, containerWidthPx - 48)));
  }, []);

  // ---- 另存（源文件只读，只写新文件）----

  const saveAs = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    if (!session || saving) return;
    const draft = session.draft();
    const base = fileName.replace(/\.pdf$/i, '') || 'document';
    const picked = await bridge?.shell.selectSaveFile({
      title: t('pdfEditor.savePickerTitle'),
      defaultFileName: `${base}-edited.pdf`,
      filters: [{ name: t('pdfEditor.pickerFilterPdf'), extensions: ['pdf'] }],
    });
    if (!picked?.ok || picked.value.filePath === null) return;
    const outPath = picked.value.filePath;
    setSaving(true);
    setNotice(undefined);
    const reply = await bridge?.pdf?.['export.saveEditor'](
      filePath,
      [...draft.pages] as PdfEditorPageView[],
      [...draft.objects] as PdfEditorObjectView[],
      outPath,
    );
    setSaving(false);
    if (reply?.ok) {
      setDirty(false);
      setSavedTo(outPath);
      setNotice({ text: t('pdfEditor.saved', { path: outPath }), tone: 'celadon' });
    } else {
      setNotice({
        text: reply
          ? t('pdfEditor.saveFailed', { code: reply.error.code, message: reply.error.message })
          : t('action.noBridge'),
        tone: 'seal',
      });
    }
  }, [bridge, fileName, filePath, saving, t]);

  /** 退出：有未保存改动先拦一道；没改动直接走。 */
  const requestClose = useCallback(() => {
    if (dirty) setGuardOpen(true);
    else onClose();
  }, [dirty, onClose]);

  const discardAndClose = useCallback(() => {
    setGuardOpen(false);
    onClose();
  }, [onClose]);

  // ---- 快捷键：撤销/重做/另存/删除（输入框聚焦时让字键归输入框）----

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (typing) return; // 输入框内的撤销交给浏览器（文字输入本身不进对象栈）
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        if (!typing) redo();
        return;
      }
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveAs();
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && !typing && selectedId !== undefined) {
        event.preventDefault();
        removeObject(selectedId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [redo, removeObject, saveAs, selectedId, undo]);

  const selectedObject = useMemo(
    () => objectList.find((candidate) => candidate.id === selectedId),
    [objectList, selectedId],
  );

  return {
    filePath,
    fileName,
    loadState,
    loadError,
    pages: pageList,
    objects: objectList,
    ensurePaper,
    paperOf,
    canUndo,
    canRedo,
    dirty,
    saving,
    notice,
    clearNotice: () => setNotice(undefined),
    tool,
    setTool,
    selectedId,
    setSelectedId,
    selectedObject,
    inline,
    beginLineEdit,
    beginObjectEdit,
    beginNewTextBox,
    patchInline,
    commitInline,
    cancelInline,
    liveRects,
    setLiveRect,
    commitRect,
    addObject,
    updateObject,
    removeObject,
    undo,
    redo,
    pageWidthPx,
    zoomIn,
    zoomOut,
    zoomActual,
    fitWidth,
    fitWidthAuto,
    currentPageIndex,
    setCurrentPageIndex,
    thumbsOpen,
    setThumbsOpen,
    propsOpen,
    setPropsOpen,
    saveAs,
    savedTo,
    guardOpen,
    requestClose,
    discardAndClose,
    cancelGuard: () => setGuardOpen(false),
  };
}

export type PdfEditorModel = ReturnType<typeof usePdfEditor>;
