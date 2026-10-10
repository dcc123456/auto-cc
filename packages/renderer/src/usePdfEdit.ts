/**
 * 「在既有 PDF 上改」这一轨的**唯一一份**状态（spec 3.5-12，plan §10.5）。
 *
 * 为什么要从面板里抽出来：2026-10-10 的裁定把画面搬进了右栏那一格（真纸面），控件留在左列，
 * 于是同一份编辑会话有**两个消费者**。原先它们同在一个组件里，state 就地长出来；
 * 拆成两格后若各存一份，就是「左边的清单」与「右边的纸」各说各话（AGENTS.md §2.5），
 * 所以 state 上抬到 desk，两边只转述。形状与排版编辑器那一条同规格：控件递上来、纸画出去。
 *
 * 会话仍在渲染层、字节仍在主进程（§7.14 定的那条没变）：界面手里只有 `pdf.io.open` 的量得结果、
 * `pdf.io.bytes` 送来的整份字节（只交给 pdf.js 解析，不二次加工）、以及本地那份 draft；
 * 另存是唯一的外发写盘动作，源文件全程只读（spec 3.5-09）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppErrorPayload, PdfOpenReceiptView, PdfSaveAsReceiptView } from '@auto-cc/shared';
import type {
  PdfEditDraft,
  PdfEditSession,
  PdfEditSessionLimits,
  PdfEditSessionOptions,
} from '@auto-cc/plugin-pdf-edit/edit-session';
import { createPdfEditSession } from '@auto-cc/plugin-pdf-edit/edit-session';
import type { PdfPaper, PdfPaperPage, PdfPaperRect, PdfTextLine } from './pdf-page-view';
import { loadPdfPaper } from './pdf-page-view';
import { useBridgeAction } from './useBridgeAction';

/** 页面度量的入参类型从会话自己的签名取：本包对外只开 `./edit-session` 一条窄出口，不再把 `overlay-writer` 也开出去。 */
type PdfPageMetrics = PdfEditSessionOptions['pageMetrics'];

/** 会话尺度的四个键（与 `pdf-export` 的配置键同名，读数按这四个键现取）。 */
const LIMIT_KEYS = ['maxOverlays', 'maxPages', 'defaultTextSizePt', 'minAreaRatio'] as const;

/**
 * 真纸面这一格的供料状态（左列与纸面都只转述它，不各自判一次）。
 * - `idle` 还没开文件
 * - `loading` 字节在途，或 pdf.js 正在解析这一页
 * - `ready` 纸上已经是这一页的真图
 * - `failed` 画不出来（字节读不到 / 文件结构损坏），原因摆在那一句读数里
 */
export type PdfPaperState = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * 就地改的那一行：点中的行 + 当前草稿。
 * 草稿预填**该行原文**（这是「就地」的两个字的全部含义：人改的是自己刚看见的那句话）。
 */
export interface PdfInlineEdit {
  line: PdfTextLine;
  text: string;
}

/**
 * 从 `pdf-export` 的运行时合并配置里取会话尺度。
 * 这四个数不许在界面里写死第二份：另存用的就是同一份配置，两边各存一份迟早漂（AGENTS.md §2.5）。
 * @param values `plugins.readConfig` 的 `values`（schema 补过默认值的生效读数）
 * @returns 四个键齐且为有限数时给尺度，否则 undefined（编辑入口此时不可用）
 */
function limitsOfValues(values: Record<string, unknown>): PdfEditSessionLimits | undefined {
  const picked = LIMIT_KEYS.map((key) => values[key]);
  if (!picked.every((value) => typeof value === 'number' && Number.isFinite(value))) return undefined;
  const [maxOverlays, maxPages, defaultTextSizePt, minAreaRatio] = picked as [number, number, number, number];
  return {
    maxOverlays: maxOverlays,
    maxPages: maxPages,
    defaultTextSizePt: defaultTextSizePt,
    minAreaRatio: minAreaRatio,
  };
}

/**
 * 两份尺度是否逐键相同（不同才需要重建会话）。
 * @param left 会话此刻用的那份
 * @param right 刚从主进程读到的那份
 */
function isSameLimits(left: PdfEditSessionLimits, right: PdfEditSessionLimits): boolean {
  return LIMIT_KEYS.every((key) => left[key] === right[key]);
}

/**
 * 把 pdf.js 抛出的任何东西转成一句可展示的成因。
 * pdf.js 的异常类型很多（结构损坏、加密、渲染被取消），界面只认「说了什么」，不在这里重判它是不是 PDF。
 * @param error 捕获到的异常
 */
function reasonOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error);
}

/**
 * PDF 编辑这一轨的模型。
 * @param active 纸面此刻是否在 PDF 这一档（desk 是唯一判别人）。为 false 时不读尺度、不建会话、
 *                并把上一份的 worker 与 draft 一起收掉——旧形状里「关掉面板就卸载」的等价物
 * @param onClose 人按「关闭」时的退档动作（draft 只活在内存，关掉即弃——与裁定⑨ 的「只拦不存」同一取向）
 */
export function usePdfEdit({ active, onClose }: { active: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [filePath, setFilePath] = useState('');
  const [receipt, setReceipt] = useState<PdfOpenReceiptView>();
  const [openError, setOpenError] = useState<AppErrorPayload>();
  const [draft, setDraft] = useState<PdfEditDraft>({ overlays: [], pageOrder: [] });
  const [page, setPage] = useState(1);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [overlayText, setOverlayText] = useState('');
  const [outPath, setOutPath] = useState('');
  const [saveError, setSaveError] = useState<AppErrorPayload>();
  const [saved, setSaved] = useState<PdfSaveAsReceiptView>();
  /** 正在拖的那只橡皮筋（进阶腿：先在左列写好字、再到纸上框位置）。 */
  const [rubber, setRubber] = useState<PdfPaperRect>();
  /** 就地改的目标行（点中一行才长出来；提交或 Esc 就收掉）。 */
  const [editing, setEditing] = useState<PdfInlineEdit>();
  /** 会话尺度（从主进程现读）：为 undefined 时编辑不可用，界面不猜一个数。 */
  const [limits, setLimits] = useState<PdfEditSessionLimits>();
  /** 当下这一页的真纸面句柄（画布与行盒都从它取）。 */
  const [paperPage, setPaperPage] = useState<PdfPaperPage>();
  const [paperState, setPaperState] = useState<PdfPaperState>('idle');
  const [paperError, setPaperError] = useState<string>();

  /** 会话本体放在 ref 而不是 state：它是可变对象，进 state 会让每次动作都拷出一份历史。 */
  const sessionRef = useRef<PdfEditSession | null>(null);
  const limitsRef = useRef<PdfEditSessionLimits | undefined>(undefined);
  const receiptRef = useRef<PdfOpenReceiptView | undefined>(undefined);
  /** 动作结束后要重读的是**当下**这一页，而闭包里的 state 是起手那一刻的，故页号与路径各留一份 ref。 */
  const pageRef = useRef(1);
  const pathRef = useRef('');
  /** 覆盖区 id 的流水号：只保证唯一，被拒的动作也会消耗一个号（界面上没有"按 id 寻人"的入口）。 */
  const overlaySeqRef = useRef(0);
  /** 真纸面那份文档句柄（一次装载同时供位图与行盒，见 `pdf-page-view.ts`）。 */
  const paperRef = useRef<PdfPaper | null>(null);
  /**
   * 装载的序列号：连开两份文件时，慢的那一趟回来必须整条丢弃
   * （否则上一份的 worker 会把这一份的画布盖掉，而界面上看着是「同一颗纸」）。
   */
  const paperSeqRef = useRef(0);

  /** 建 / 必要时重建编辑会话：要同时有打开回执（页面度量）与尺度才建得起来，所以两条腿各调一次。 */
  const ensureSession = () => {
    const metrics = receiptRef.current?.pages;
    const currentLimits = limitsRef.current;
    if (!metrics || !currentLimits) return;
    const previous = sessionRef.current?.draft();
    sessionRef.current = createPdfEditSession(
      previous ?? { overlays: [], pageOrder: metrics.map((metric) => metric.number) },
      { pageMetrics: metrics satisfies PdfPageMetrics, limits: currentLimits },
    );
    syncFromSession();
  };

  /** 会话只回布尔（§7.14 的纯模型形态），界面要看的 draft 与两个历史位一律从会话现读。 */
  function syncFromSession() {
    const session = sessionRef.current;
    if (!session) return;
    const current = session.draft();
    setDraft({ overlays: [...current.overlays], pageOrder: [...current.pageOrder] });
    setCanUndo(session.canUndo());
    setCanRedo(session.canRedo());
  }

  /** 真纸面不挂在全屏 `busy` 上：它是一条后台供料腿，走自己的状态读数（与纸面实时那条 effect 同一取向）。 */
  const loadPaper = useCallback(
    async (target: string) => {
      const seq = paperSeqRef.current + 1;
      paperSeqRef.current = seq;
      setPaperState('loading');
      setPaperError(undefined);
      setPaperPage(undefined);
      setEditing(undefined);
      const reply = await bridge?.pdf?.['io.bytes'](target);
      if (seq !== paperSeqRef.current) return;
      if (!reply?.ok) {
        setPaperState('failed');
        setPaperError(reply ? reply.error.message : t('action.noBridge'));
        return;
      }
      // pdf.js 会把这块缓冲区转移给 worker，所以 `reply.value` 到此为止，不再拿它做第二次解析。
      let paper: PdfPaper;
      try {
        paper = await loadPdfPaper(reply.value);
      } catch (error) {
        if (seq === paperSeqRef.current) {
          setPaperState('failed');
          setPaperError(reasonOf(error));
        }
        return;
      }
      // 换文件先收掉上一份：一个 worker port 只允许登记一个 PDFWorker，留着旧的就会当场抛错。
      await paperRef.current?.dispose();
      if (seq !== paperSeqRef.current) {
        void paper.dispose();
        return;
      }
      paperRef.current = paper;
      const view = await paper.page(pageRef.current);
      if (seq !== paperSeqRef.current) return;
      setPaperPage(view);
      setPaperState('ready');
    },
    [bridge, t],
  );

  /** 本轨的读数就是那份 paper 状态（由 `loadPaper` 自己写），所以动作收尾无需再发一次桥调用。 */
  const read = useCallback(() => Promise.resolve(), []);
  const { busy, notice, noticeTone, run, setNotice } = useBridgeAction(read);

  /** 进门先取一次编辑尺度：尺度不在界面里写死，故这是本轨唯一的「进门先问一句」；只在真的进了这一档时问。 */
  useEffect(() => {
    if (!active) return;
    void (async () => {
      const reply = await bridge?.plugins?.readConfig('pdf-export');
      if (!reply?.ok) return;
      const next = limitsOfValues(reply.value.values);
      if (!next) return;
      const previous = limitsRef.current;
      limitsRef.current = next;
      setLimits(next);
      if (previous && isSameLimits(previous, next)) return;
      ensureSession();
    })();
    // 只进门取一次：`busy`/`run` 每次渲染都换引用，放进依赖会在动作之间反复重建会话并白丢撤销历史。
  }, [active, bridge]);

  /** 退出这一档即回收：worker 与 draft 都不留在内存里冒充「还能接着改上一份」。 */
  useEffect(() => {
    if (active) return;
    paperSeqRef.current += 1;
    void paperRef.current?.dispose();
    paperRef.current = null;
    sessionRef.current = null;
    receiptRef.current = undefined;
    setReceipt(undefined);
    setDraft({ overlays: [], pageOrder: [] });
    setPaperPage(undefined);
    setPaperState('idle');
    setPaperError(undefined);
    setEditing(undefined);
    setRubber(undefined);
    setSaved(undefined);
    setSaveError(undefined);
  }, [active]);

  /**
   * 用给定路径打开一份 PDF（spec 3.4-03 / 3.5-01 / 3.5-12 的打开半边）：路径交给主进程量页数与逐页宽高，
   * 成功后立刻把整份字节取回来交给渲染层的 pdf.js 画纸。换文件即弃掉上一份 draft——会话跟着重建，
   * 不出现「新文件配旧覆盖区」。
   * @param target 人给的绝对路径（来自输入框或系统选文件面板）
   */
  const openPdfWith = (target: string) => {
    pathRef.current = target;
    pageRef.current = 1;
    receiptRef.current = undefined;
    sessionRef.current = null;
    setPage(1);
    setEditing(undefined);
    setSaved(undefined);
    setOpenError(undefined);
    setDraft({ overlays: [], pageOrder: [] });
    void run(t('pdfEdit.open'), () => bridge?.pdf?.['io.open'](target), {
      apply: (value) => {
        receiptRef.current = value;
        setReceipt(value);
        ensureSession();
        void loadPaper(target);
      },
      onError: (error) => {
        setOpenError(error);
        receiptRef.current = undefined;
        setReceipt(undefined);
      },
      describe: (value) => t('pdfEdit.opened', { count: value.pageCount, hash: value.sourceHash.slice(0, 12) }),
    });
  };

  /** 打开输入框里那条路径（`data-action="pdf-edit-open"` 走的就是这一句）。 */
  const openPdf = () => openPdfWith(filePath.trim());

  /**
   * 请系统弹「打开文件」面板并直接打开选中的那份 PDF（spec 3.5-01 的入口半边）。
   * 渲染层读不了文件系统（§8.1），所以这一步只能由主进程代问；人取消时保持原状（取消不是失败）。
   */
  const pickSourceFile = () =>
    void run(
      t('pdfEdit.pickFile'),
      () =>
        bridge?.shell.selectFile({
          title: t('pdfEdit.pickerTitle'),
          filters: [{ name: t('pdfEdit.pickerFilterPdf'), extensions: ['pdf'] }],
        }),
      {
        apply: (value) => {
          if (value.filePath === null) return;
          setFilePath(value.filePath);
          openPdfWith(value.filePath);
        },
        describe: (value) =>
          value.filePath === null ? t('pdfEdit.pickerCanceled') : t('pdfEdit.pickerPicked', { path: value.filePath }),
      },
    );

  /** 请系统弹「另存为」面板定产物落点（spec 3.5-09 的另存半边）；默认名取自源文件名。 */
  const pickSavePath = () =>
    void run(
      t('pdfEdit.pickSavePath'),
      () =>
        bridge?.shell.selectSaveFile({
          title: t('pdfEdit.savePickerTitle'),
          defaultFileName: sourceFileName(),
          filters: [{ name: t('pdfEdit.pickerFilterPdf'), extensions: ['pdf'] }],
        }),
      {
        apply: (value) => {
          if (value.filePath !== null) setOutPath(value.filePath);
        },
        describe: (value) =>
          value.filePath === null ? t('pdfEdit.pickerCanceled') : t('pdfEdit.pickerPicked', { path: value.filePath }),
      },
    );

  /**
   * 从当前输入的路径里取文件名（只用于另存建议名，不做任何存在性判断）。
   * @returns 末段文件名；路径为空时给一个固定建议名
   */
  function sourceFileName(): string {
    const segments = filePath.trim().split(/[\\/]/);
    return (segments[segments.length - 1] ?? '') !== '' ? (segments[segments.length - 1] as string) : 'edited.pdf';
  }

  /**
   * 换到某一页：页号先落到 ref 再取那一页的纸，这样紧随其后的点选与另存用的就是人刚看的那一页。
   * @param pageNumber 目标**源页号**（1 起）
   */
  const showPage = async (pageNumber: number) => {
    pageRef.current = pageNumber;
    setPage(pageNumber);
    setEditing(undefined);
    const paper = paperRef.current;
    if (!paper) return;
    const seq = paperSeqRef.current;
    const view = await paper.page(pageNumber);
    if (seq !== paperSeqRef.current || pageRef.current !== pageNumber) return;
    setPaperPage(view);
    setPaperState('ready');
  };

  /**
   * 把一个矩形连同要写的字交进会话（就地改与进阶拖动落位共用这一条腿）。
   * 合法性一律由会话判——会话用的就是另存那一份 `planOverlays`，界面这里不写第二条规则（§2.5）。
   * @param rect 比例矩形
   * @param text 要盖上去的新字；空串表示只涂白底（那时 `text` 这个键根本不出现）
   * @param sizePt 字号（pt）；省略即用配置缺省
   */
  const commitRect = (rect: PdfPaperRect, text: string, sizePt?: number) => {
    const session = sessionRef.current;
    if (!session) return;
    overlaySeqRef.current += 1;
    const ok = session.addOverlay({
      id: `ov-${overlaySeqRef.current}`,
      pageNumber: pageRef.current,
      rect,
      ...(text === '' ? {} : { text }),
      ...(sizePt === undefined ? {} : { sizePt }),
    });
    syncFromSession();
    if (!ok) setNotice(t('pdfEdit.overlayRejected'), 'seal');
  };

  /**
   * 点中一行 → 就地改：草稿预填该行原文。
   * @param line 纸上的那一行
   */
  const beginEdit = (line: PdfTextLine) => setEditing({ line, text: line.text });

  /** 敲键回报就地改的草稿。 */
  const changeEditText = (text: string) => setEditing((current) => (current ? { ...current, text } : current));

  /**
   * 提交就地改：覆盖区就是那一行的行盒，字号沿用那一行。
   * 原文一个字都不删——界面上那句「原文仍在文件里」跟着常驻（§7.6 的反伪装口径）。
   */
  const commitEdit = () => {
    const target = editing;
    if (!target) return;
    commitRect(target.line.rect, target.text.trim(), target.line.fontSizePt);
    setEditing(undefined);
  };

  /** 撤掉就地改（Esc / 按不动时人自己收）。 */
  const cancelEdit = () => setEditing(undefined);

  /**
   * 进阶腿：拖完一只橡皮筋后交进会话，文字取左列那行输入框（旧流程原样保留，只是降到进阶）。
   * @param rect 拖出来的比例矩形
   */
  const commitOverlay = (rect: PdfPaperRect) => {
    commitRect(rect, overlayText.trim());
    setRubber(undefined);
  };

  /**
   * 删掉一条覆盖区（id 来自界面刚列出的那一份，查无此 id 的情形不存在，故不另设提示）。
   * @param id 目标覆盖区标识
   */
  const removeOverlay = (id: string) => {
    if (sessionRef.current?.removeOverlay(id)) syncFromSession();
  };

  /**
   * 改产物页序（spec 3.5-07 的界面化身）：新数组交给会话，越界 / 空 / 超上限都由它判。
   * @param order 候选页序
   */
  const setPageOrder = (order: number[]) => {
    const session = sessionRef.current;
    if (!session) return;
    const ok = session.setPageOrder(order);
    syncFromSession();
    setNotice(ok ? t('pdfEdit.pageOrderDone') : t('pdfEdit.pageOrderRejected'), ok ? 'celadon' : 'seal');
  };

  /**
   * 回退 / 重做一步（spec 3.5-08 在界面上的那两颗按钮）。
   * @param direction 方向
   */
  const stepHistory = (direction: 'undo' | 'redo') => {
    const session = sessionRef.current;
    if (!session) return;
    if (direction === 'undo' ? session.undo() : session.redo()) syncFromSession();
  };

  /**
   * 另存（spec 3.5-02 / 3.5-09）：把界面那份 draft 原样交给主进程，源文件只读、产物落人给的路径。
   * 失败时磁盘上没有半成品（plan §7.10），主进程那句中文原样摆在界面上。
   */
  const saveAs = () =>
    void run(
      t('pdfEdit.saveAs'),
      () =>
        bridge?.pdf?.['export.saveAs'](
          pathRef.current,
          draft.overlays.map((overlay) => ({ ...overlay, rect: { ...overlay.rect } })),
          [...draft.pageOrder],
          outPath.trim(),
        ),
      {
        apply: (value) => {
          setSaved(value);
          setSaveError(undefined);
        },
        onError: setSaveError,
        describe: (value) =>
          t('pdfEdit.saved', { path: value.outPath, count: value.pageCount, hash: value.sha256.slice(0, 12) }),
      },
    );

  /** 是否已到产物页数上限——尺度还没读到时按「到顶」处理（会话根本建不起来，另存/复制都无意义）。 */
  const isAtPageCap = !limits || draft.pageOrder.length >= limits.maxPages;

  return {
    active,
    onClose,
    filePath,
    setFilePath,
    receipt,
    openError,
    draft,
    page,
    canUndo,
    canRedo,
    overlayText,
    setOverlayText,
    outPath,
    setOutPath,
    saveError,
    saved,
    rubber,
    setRubber,
    editing,
    limits,
    paperPage,
    paperState,
    paperError,
    isAtPageCap,
    busy,
    notice,
    noticeTone,
    setNotice,
    openPdf,
    pickSourceFile,
    pickSavePath,
    showPage,
    beginEdit,
    changeEditText,
    commitEdit,
    cancelEdit,
    commitOverlay,
    removeOverlay,
    setPageOrder,
    stepHistory,
    saveAs,
  };
}

/** 这一轨模型的形状（纸面视图与左列控件共用，见 `PdfPaperView.tsx` / `PdfEditPanel.tsx`）。 */
export type PdfEditModel = ReturnType<typeof usePdfEdit>;
