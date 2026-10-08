import { ArrowDown, ArrowUp, Copy, Pencil, Redo2, Save, Trash2, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PdfEditDraft,
  PdfEditSession,
  PdfEditSessionLimits,
  PdfEditSessionOptions,
} from '@auto-cc/plugin-pdf-edit/edit-session';
import { createPdfEditSession } from '@auto-cc/plugin-pdf-edit/edit-session';
import type { AppErrorPayload, PdfOpenReceiptView, PdfSaveAsReceiptView, PdfTextBoxView } from '@auto-cc/shared';
import { useBridgeAction } from './useBridgeAction';
import { Banner, DeskButton, DeskField, deskReason } from './ui/controls';
import { useDeskThemeValue } from './theme';

/** 覆盖区的入参类型从会话自己的签名取：本包对外只开 `./edit-session` 一条窄出口，不再把 `overlay-writer` 也开出去。 */
type PdfOverlaySeed = Parameters<PdfEditSession['addOverlay']>[0];
type PdfOverlayRectSeed = PdfOverlaySeed['rect'];
type PdfPageMetrics = PdfEditSessionOptions['pageMetrics'];

/**
 * 画布的显示比例（PDF 点 → 画布像素）。
 * 它只决定"看得清不清楚"，**不参与任何判定**：面积、越界、字号那些尺度全部取自主进程的配置，
 * 换算比例进不了判据（否则缩放窗口就会改变另存的结果）。
 */
const CANVAS_SCALE = 0.75;

/** 会话尺度的四个键（与 `pdf-export` 的配置键同名，读数按这四个键现取）。 */
const LIMIT_KEYS = ['maxOverlays', 'maxPages', 'defaultTextSizePt', 'minAreaRatio'] as const;

/**
 * 把比例夹回 0..1：指针拖到页面外时线框该停在边上，而不是拖出一个负宽度的框。
 * @param value 页面内的相对位置
 */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 比例坐标 → 读数用的人话百分比（界面只展示，不用它反算任何东西）。
 * @param ratio 0..1 的比例
 */
function percentOf(ratio: number): string {
  return (Math.round(ratio * 1000) / 10).toFixed(1);
}

/**
 * 把指针位置换算成页面内的比例坐标。
 * @param clientX 指针视口横坐标（px）
 * @param clientY 指针视口纵坐标（px）
 * @param canvas 正在拖的那块画布；宽高为 0（视图未激活）时返回 undefined，不做除零
 */
function ratioOfPointer(clientX: number, clientY: number, canvas: HTMLCanvasElement) {
  const box = canvas.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return undefined;
  return { x: clamp01((clientX - box.left) / box.width), y: clamp01((clientY - box.top) / box.height) };
}

/**
 * 两点算一个矩形（拖拽的起点与落点谁在左上不限）。
 * @param from 起手点（比例）
 * @param to 落点（比例）
 */
function rectOfPoints(from: { x: number; y: number }, to: { x: number; y: number }): PdfOverlayRectSeed {
  return {
    xRatio: Math.min(from.x, to.x),
    yRatio: Math.min(from.y, to.y),
    widthRatio: Math.abs(to.x - from.x),
    heightRatio: Math.abs(to.y - from.y),
  };
}

/**
 * 把产物页序里的第 `from` 位与第 `to` 位换过来。
 * @param order 当前页序（产物逐页的来源页号）
 * @param from 起手下标
 * @param to 目标下标；越界时原样返回，会话会把原样那份判成"空编辑"
 */
function swapOrder(order: readonly number[], from: number, to: number): number[] {
  const next = [...order];
  const moved = next[from];
  const target = next[to];
  if (moved === undefined || target === undefined) return next;
  next[from] = target;
  next[to] = moved;
  return next;
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
 * 「在既有 PDF 上改」的渲染层第三视图（plan §7.5，spec 3.5-01 / 02 / 03 / 07 / 09 的界面化身）。
 *
 * 形状照 §7.14 定下的那一条：**会话在渲染层、字节在主进程**。界面手里的只有
 * `pdf.io.open` 的量得结果、`pdf.layout.textItems` 的比例矩形，以及本地那份 draft（覆盖区 + 页序）；
 * 整页原文一个字节都不进来，PDF 字节也不过进程边界。另存是唯一的外发写盘动作，走 `pdf.export.saveAs`，
 * 源文件全程只读、产物写到人另给的路径（spec 3.5-09）。
 *
 * 页面用 `<canvas>` 画而不是绝对定位的 DOM 框：线框与覆盖区的位置由那份文件的页面尺寸算出来，
 * 是**数据**而不是设计，Tailwind 的静态类表达不了（§5.1 禁内联 `style`，也没有可枚举的类可拼）。
 * 画布只负责"看得清"，一条判定都不在这里做。
 *
 * 文案口径受 §7.6 约束：说"改"必须同时说"原文字仍在文件里"，界面上不出现涂黑/删除原文这类字样。
 *
 * @param onClose 人按"关闭"时的卸载动作（draft 只活在内存，关掉即弃——与裁定⑨ 的"只拦不存"同一取向；
 *                3.6-09 那条未保存拦截的判据属于排版编辑器，本视图不认领）
 */
export function PdfEditPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const deskTheme = useDeskThemeValue();
  const bridge = window.autoCC;
  const [filePath, setFilePath] = useState('');
  const [receipt, setReceipt] = useState<PdfOpenReceiptView>();
  const [openError, setOpenError] = useState<AppErrorPayload>();
  const [boxes, setBoxes] = useState<PdfTextBoxView[]>([]);
  /** 线框取不到时的那句原因（主进程的话术）；它与 `notice` 分开摆，因为一个是读数、一个是动作回执。 */
  const [wireframeError, setWireframeError] = useState<string>();
  const [draft, setDraft] = useState<PdfEditDraft>({ overlays: [], pageOrder: [] });
  const [page, setPage] = useState(1);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [overlayText, setOverlayText] = useState('');
  const [outPath, setOutPath] = useState('');
  const [saveError, setSaveError] = useState<AppErrorPayload>();
  const [saved, setSaved] = useState<PdfSaveAsReceiptView>();
  const [rubber, setRubber] = useState<PdfOverlayRectSeed>();
  /** 会话尺度（从主进程现读）：为 undefined 时编辑不可用，界面不猜一个数。 */
  const [limits, setLimits] = useState<PdfEditSessionLimits>();
  /** 会话本体放在 ref 而不是 state：它是可变对象，进 state 会让每次动作都拷出一份历史。 */
  const sessionRef = useRef<PdfEditSession | null>(null);
  const limitsRef = useRef<PdfEditSessionLimits | undefined>(undefined);
  const receiptRef = useRef<PdfOpenReceiptView | undefined>(undefined);
  /** 动作结束后要重读的是**当下**这一页，而闭包里的 state 是起手那一刻的，故页号与路径各留一份 ref。 */
  const pageRef = useRef(1);
  const pathRef = useRef('');
  /** 覆盖区 id 的流水号：只保证唯一，被拒的动作也会消耗一个号（界面上没有"按 id 寻人"的入口）。 */
  const overlaySeqRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragStartRef = useRef<{ x: number; y: number } | undefined>(undefined);

  /**
   * 重读当前页的线框（spec 3.5-01）：主进程按路径现量，界面不缓存别页的块位置。
   * 失败只在提示区留一句话、不清空已有读数——"取不到"不该把人已经看见的东西抹掉。
   * 这里不用 `run` 的外壳：`run` 收尾会调 `read`，而 `read` 就是本函数，绕成递归每次动作都要多发一次调用
   *（与 3.6-b 那条预览不套 `run` 的口径同一条）。
   */
  const loadWireframe = useCallback(
    async (pageNumber = pageRef.current) => {
      if (pathRef.current === '') return;
      const reply = await bridge?.pdf?.['layout.textItems'](pathRef.current, pageNumber);
      if (reply?.ok) {
        setBoxes(reply.value.boxes);
        setWireframeError(undefined);
      } else if (reply) setWireframeError(reply.error.message);
    },
    [bridge],
  );

  /** 每个动作结束后一律重读主进程的读数（AGENTS.md §2.5：界面不猜它当下的状态）。 */
  const read = useCallback(async () => {
    await loadWireframe();
  }, [loadWireframe]);

  const { busy, notice, noticeTone, run, setNotice } = useBridgeAction(read);

  /**
   * 建 / 必要时重建编辑会话。
   * 会话要同时有**打开回执**（页面度量）与**尺度**才建得起来，所以这一句在两条腿各调一次。
   * 重建会丢掉撤销历史——只应在主进程尺度真的变了时发生（热改配置），此时判据变了，旧历史不再可比。
   */
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

  /**
   * 会话只回布尔（§7.14 的纯模型形态），界面要看的 draft 与两个历史位一律从会话现读。
   * 拷一份 draft 进 state：会话给的本就是副本，但数组进 state 前显式拷一次，免得日后有人改这里省掉一步。
   */
  function syncFromSession() {
    const session = sessionRef.current;
    if (!session) return;
    const current = session.draft();
    setDraft({ overlays: [...current.overlays], pageOrder: [...current.pageOrder] });
    setCanUndo(session.canUndo());
    setCanRedo(session.canRedo());
  }

  /** 挂起时取一次编辑尺度：尺度不在界面里写死，故这是本视图唯一的"进门先问一句"。 */
  useEffect(() => {
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
  }, [bridge]);

  /**
   * 打开一份 PDF（spec 3.4-03 / 3.5-01 的打开半边）：路径交给主进程，界面只收下页数与逐页宽高。
   * 换文件即弃掉上一份 draft——会话跟着重建，不出现"新文件配旧覆盖区"。
   */
  const openPdf = () => {
    const trimmed = filePath.trim();
    pathRef.current = trimmed;
    pageRef.current = 1;
    receiptRef.current = undefined;
    sessionRef.current = null;
    setPage(1);
    setBoxes([]);
    setWireframeError(undefined);
    setSaved(undefined);
    setOpenError(undefined);
    setDraft({ overlays: [], pageOrder: [] });
    void run(t('pdfEdit.open'), () => bridge?.pdf?.['io.open'](trimmed), {
      apply: (value) => {
        receiptRef.current = value;
        setReceipt(value);
        ensureSession();
      },
      onError: (error) => {
        setOpenError(error);
        receiptRef.current = undefined;
        setReceipt(undefined);
      },
      describe: (value) => t('pdfEdit.opened', { count: value.pageCount, hash: value.sourceHash.slice(0, 12) }),
    });
  };

  /**
   * 换到某一页：页号先落到 ref 再取线框，这样紧随其后的拖拽与另存用的就是人刚看的那一页。
   * @param pageNumber 目标**源页号**（1 起）
   */
  const showPage = (pageNumber: number) => {
    pageRef.current = pageNumber;
    setPage(pageNumber);
    void loadWireframe(pageNumber);
  };

  /**
   * 拖出一个新覆盖区并交进会话。
   * 监听在 `pointerdown` **当场**挂上，不挂在后续渲染的 effect 里（3.6 活体那条教训：
   * harness 把 down/move/up 在几毫秒里派发完，effect 等渲染提交时 `pointerup` 早就过去了）。
   * 合法性一律由会话判——会话用的就是另存那一份 `planOverlays`，界面这里不写第二条规则（§2.5）。
   * @param event 画布上的 `pointerdown`
   */
  const startOverlayDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const startPoint = ratioOfPointer(event.clientX, event.clientY, canvas);
    if (!startPoint) return;
    dragStartRef.current = startPoint;
    const move = (moveEvent: PointerEvent) => {
      const current = dragStartRef.current;
      const point = ratioOfPointer(moveEvent.clientX, moveEvent.clientY, canvas);
      if (!current || !point) return;
      setRubber(rectOfPoints(current, point));
    };
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const current = dragStartRef.current;
      const point = ratioOfPointer(upEvent.clientX, upEvent.clientY, canvas);
      dragStartRef.current = undefined;
      setRubber(undefined);
      if (!current || !point) return;
      commitOverlay(rectOfPoints(current, point));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /**
   * 把拖出来的矩形连同当前输入框里的文字交进会话。
   * @param rect 比例矩形
   */
  const commitOverlay = (rect: PdfOverlayRectSeed) => {
    const session = sessionRef.current;
    if (!session) return;
    const text = overlayText.trim();
    overlaySeqRef.current += 1;
    const ok = session.addOverlay({
      id: `ov-${overlaySeqRef.current}`,
      pageNumber: pageRef.current,
      rect,
      // 留空即只涂白底：`text` 这个键不出现，比写一个空串更接近"没有文字"这件事。
      ...(text === '' ? {} : { text }),
    });
    syncFromSession();
    if (!ok) setNotice(t('pdfEdit.overlayRejected'), 'seal');
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
   * 只在真的动了 draft 时才有可退的步，所以两颗按钮的可用性直接取会话的 `canUndo`/`canRedo`。
   * @param direction 方向
   */
  const stepHistory = (direction: 'undo' | 'redo') => {
    const session = sessionRef.current;
    if (!session) return;
    if (direction === 'undo' ? session.undo() : session.redo()) syncFromSession();
  };

  /**
   * 另存（spec 3.5-02 / 3.5-09）：把界面那份 draft 原样交给主进程，源文件只读、产物落人给的路径。
   * 失败时磁盘上没有半成品（plan §7.10），主进程那句中文原样摆在界面上——尺度在那一侧判，话术也在那一侧。
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
          t('pdfEdit.saved', {
            path: value.outPath,
            count: value.pageCount,
            hash: value.sha256.slice(0, 12),
          }),
      },
    );

  /** 当前这一页的度量（画布宽高与换算都取它；取不到就不画页面）。 */
  const pageMetric = receipt?.pages.find((candidate) => candidate.number === page);
  const canvasWidthPt = pageMetric ? Math.round(pageMetric.widthPt * CANVAS_SCALE) : 0;
  const canvasHeightPt = pageMetric ? Math.round(pageMetric.heightPt * CANVAS_SCALE) : 0;
  /** 是否已到产物页数上限——尺度还没读到时按"到顶"处理，此时另存/复制都无意义（会话根本建不起来）。 */
  const isAtPageCap = !limits || draft.pageOrder.length >= limits.maxPages;

  /**
   * 「按不动」必须带上原因码（07 稿④）。`busy` 排在每一条链首：在途时任何一颗都轮不到人按，
   * 这一档优先于该键自己的前置条件，和界面给出的转针读数一致。
   * 三件套的实现在 `deskReason`（墨案控件原件）——本面板与排版编辑器共用那一份，不各写一遍（§2.2）。
   */
  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;
  const { label: reasonLabel, reason: afterBusy, dead } = deskReason(t, 'pdfEdit', busyReason);
  const openReason = afterBusy(filePath.trim() === '', 'PATH_EMPTY');
  /** 另存的理由链三档：在途 → 尺度没读到（会话根本建不起来）→ 产物路径为空。顺序即优先级。 */
  const saveAsReason =
    busyReason ?? (!limits ? 'LIMITS_PENDING' : undefined) ?? (outPath.trim() === '' ? 'OUT_PATH_EMPTY' : undefined);

  /**
   * 把「这一页的线框 + 这一页的覆盖区 + 正在拖的橡皮筋」画到画布上。
   * 只由数据变化触发重绘，不做动画、不轮询（§7.10 的"画布进度只由事件推"同一取向）。
   *
   * 三种描边现取主题令牌（amber=将写进产物的草稿区、celadon=系统正跟你的手、slate-400=量到的原文），
   * 不在这里另留一套色阶；唯独纸面白与新字墨色**跟着产物走、不跟主题走**——画面上所见即另存所得，
   * 这两笔若随毡案翻浅，人和主进程看到的就是两份东西（spec 3.5-02）。
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const painter = canvas.getContext('2d');
    if (!painter) return;
    const width = canvas.width;
    const height = canvas.height;
    const tone = getComputedStyle(canvas);
    const wireframeTone = tone.getPropertyValue('--color-slate-400');
    const draftTone = tone.getPropertyValue('--color-amber');
    const draggingTone = tone.getPropertyValue('--color-celadon');
    painter.clearRect(0, 0, width, height);
    painter.fillStyle = '#ffffff';
    painter.fillRect(0, 0, width, height);
    // 线框：主进程量到的文本块位置，只描边不填，让人看清底下是原页面。
    painter.strokeStyle = wireframeTone;
    painter.lineWidth = 1;
    for (const box of boxes) {
      painter.strokeRect(
        box.rect.xRatio * width,
        box.rect.yRatio * height,
        box.rect.widthRatio * width,
        box.rect.heightRatio * height,
      );
    }
    // 覆盖区：白底 + 虚线边框（画面上所见即另存所得：白底盖住原文，新字写在白底上）。
    for (const overlay of draft.overlays) {
      if (overlay.pageNumber !== page) continue;
      const x = overlay.rect.xRatio * width;
      const y = overlay.rect.yRatio * height;
      const boxWidth = overlay.rect.widthRatio * width;
      const boxHeight = overlay.rect.heightRatio * height;
      painter.fillStyle = '#ffffff';
      painter.fillRect(x, y, boxWidth, boxHeight);
      painter.strokeStyle = draftTone;
      painter.setLineDash([4, 3]);
      painter.strokeRect(x, y, boxWidth, boxHeight);
      painter.setLineDash([]);
      if (overlay.text && limits) {
        painter.fillStyle = '#0f172a';
        painter.font = `${(overlay.sizePt ?? limits.defaultTextSizePt) * CANVAS_SCALE}px sans-serif`;
        painter.textBaseline = 'bottom';
        painter.fillText(overlay.text, x + 2, y + boxHeight - 2);
      }
    }
    if (rubber) {
      painter.strokeStyle = draggingTone;
      painter.setLineDash([3, 3]);
      painter.strokeRect(
        rubber.xRatio * width,
        rubber.yRatio * height,
        rubber.widthRatio * width,
        rubber.heightRatio * height,
      );
      painter.setLineDash([]);
    }
    // deskTheme 只是翻面后重画一次的扳机：取色一律走 getComputedStyle，这里不存第二份色值读数。
    // 为什么不能写成 `currentTheme()` 放进依赖数组：本面板挂在 App.tsx 的模块常量 PANELS 下，
    // 主题那颗开关改的是 App 自己的 state，子树拿到的是同一个元素引用、根本不重渲染（活体实测翻面后画布仍是旧色）。
  }, [boxes, draft, limits, page, rubber, deskTheme]);

  return (
    <section data-testid="pdf-edit-panel" className="mt-4 rounded-xl border border-line bg-ink-900/60 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Pencil size={16} />
          {t('pdfEdit.heading')}
        </h3>
        <DeskButton
          action="pdf-edit-close"
          variant="ghost"
          compact
          busy={!!busy}
          disabled={busyReason !== undefined}
          disabledReason={busyReason}
          disabledReasonLabel={reasonLabel(busyReason)}
          onClick={onClose}
        >
          <X size={12} />
          {t('pdfEdit.close')}
        </DeskButton>
      </div>

      <p className="mt-1 text-[11px] text-slate-500" data-testid="pdf-edit-path-hint">
        {t('pdfEdit.pathHint')}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <DeskField
          action="pdf-edit-path"
          data-testid="pdf-edit-path"
          value={filePath}
          onValueChange={setFilePath}
          placeholder={t('pdfEdit.pathPlaceholder')}
          className="min-w-[280px] flex-1"
        />
        <DeskButton
          action="pdf-edit-open"
          variant="line"
          compact
          busy={!!busy}
          disabled={openReason !== undefined}
          disabledReason={openReason}
          disabledReasonLabel={reasonLabel(openReason)}
          onClick={openPdf}
        >
          <Pencil size={12} />
          {t('pdfEdit.open')}
        </DeskButton>
      </div>

      {openError && (
        <Banner tone="seal" markers={{ testid: 'pdf-edit-open-error' }} className="mt-2 break-all">
          {t('pdfEdit.failed', { code: openError.code, message: openError.message })}
        </Banner>
      )}

      {/* 提示行是全 app 共用 `useBridgeAction.notice` 的那一句，语气按 6.2-18 裁定① 由同一层给出
          （成功青瓷、失败朱红、桥接缺失琥珀），形状只有一只原件。 */}
      {notice && (
        <Banner tone={noticeTone} markers={{ testid: 'pdf-edit-notice' }} className="mt-2 break-all">
          {notice}
        </Banner>
      )}

      {!receipt && (
        <p data-testid="pdf-edit-empty" className="mt-3 text-[11px] text-slate-500">
          {t('pdfEdit.empty')}
        </p>
      )}

      {receipt && (
        <>
          <p className="mt-2 break-all text-[11px] text-slate-400" data-testid="pdf-edit-receipt">
            {t('pdfEdit.sourceHash', { hash: receipt.sourceHash })} ·{' '}
            {t('pdfEdit.pageCount', { count: receipt.pageCount })}
          </p>
          {/* §7.6 的反伪装口径：这一句常驻，说"改"就必须同时说"原文仍在文件里"。 */}
          <p className="mt-1 text-[11px] text-amber" data-testid="pdf-edit-cover-hint">
            {t('pdfEdit.coverHint')}
          </p>
          {!limits && (
            <p className="mt-1 text-[11px] text-celadon" data-testid="pdf-edit-limits-pending">
              {t('pdfEdit.limitsPending')}
            </p>
          )}

          <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-start">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <DeskButton
                  action="pdf-edit-page-prev"
                  variant="line"
                  compact
                  busy={!!busy}
                  {...dead(afterBusy(page <= 1, 'FIRST_PAGE'))}
                  onClick={() => showPage(page - 1)}
                >
                  {t('pdfEdit.prev')}
                </DeskButton>
                <span data-testid="pdf-edit-page-reading" className="text-slate-300">
                  {t('pdfEdit.pageReading', { page, count: receipt.pageCount, boxes: boxes.length })}
                </span>
                <DeskButton
                  action="pdf-edit-page-next"
                  variant="line"
                  compact
                  busy={!!busy}
                  {...dead(afterBusy(page >= receipt.pageCount, 'LAST_PAGE'))}
                  onClick={() => showPage(page + 1)}
                >
                  {t('pdfEdit.next')}
                </DeskButton>
              </div>

              {wireframeError && (
                <p data-testid="pdf-edit-wireframe-error" className="break-all text-[11px] text-seal">
                  {t('pdfEdit.wireframeFailed', { message: wireframeError })}
                </p>
              )}

              {pageMetric ? (
                <canvas
                  ref={canvasRef}
                  data-testid="pdf-edit-canvas"
                  width={canvasWidthPt}
                  height={canvasHeightPt}
                  onPointerDown={startOverlayDrag}
                  className="rounded-md border border-line-strong bg-white"
                />
              ) : (
                <p className="text-[11px] text-slate-500">{t('pdfEdit.pageMetricMissing')}</p>
              )}

              <label className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                {t('pdfEdit.overlayText')}
                <DeskField
                  action="pdf-edit-overlay-text"
                  data-testid="pdf-edit-overlay-text"
                  value={overlayText}
                  onValueChange={setOverlayText}
                  className="w-[180px]"
                />
                <span className="text-slate-500">{t('pdfEdit.dragHint')}</span>
              </label>

              <div className="flex items-center gap-2">
                {/* 撤销 / 重做是本地同步动作，不挂 busy：它们在桥调用在途时照样按得动（原样保留，
                    唯一变化是"没步可退"现在说得出原因）。 */}
                <DeskButton
                  action="pdf-edit-undo"
                  variant="ghost"
                  compact
                  {...dead(canUndo ? undefined : 'NOTHING_TO_UNDO')}
                  onClick={() => stepHistory('undo')}
                >
                  <Undo2 size={12} />
                  {t('pdfEdit.undo')}
                </DeskButton>
                <DeskButton
                  action="pdf-edit-redo"
                  variant="ghost"
                  compact
                  {...dead(canRedo ? undefined : 'NOTHING_TO_REDO')}
                  onClick={() => stepHistory('redo')}
                >
                  <Redo2 size={12} />
                  {t('pdfEdit.redo')}
                </DeskButton>
              </div>
            </div>

            <div className="flex min-w-[260px] flex-1 flex-col gap-3">
              <div>
                <h4 className="text-[11px] font-semibold text-slate-300">{t('pdfEdit.overlays')}</h4>
                {draft.overlays.length === 0 ? (
                  <p className="mt-1 text-[11px] text-slate-500" data-testid="pdf-edit-overlays-empty">
                    {t('pdfEdit.overlaysEmpty')}
                  </p>
                ) : (
                  <ul className="mt-1 flex flex-col gap-1">
                    {draft.overlays.map((overlay) => (
                      <li
                        key={overlay.id}
                        data-testid={`pdfEdit-overlay-${overlay.id}`}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line bg-ink-950/70 px-2 py-1 text-[11px] text-slate-300"
                      >
                        <span className="break-all">
                          {t('pdfEdit.overlayRow', {
                            page: overlay.pageNumber,
                            x: percentOf(overlay.rect.xRatio),
                            y: percentOf(overlay.rect.yRatio),
                            w: percentOf(overlay.rect.widthRatio),
                            h: percentOf(overlay.rect.heightRatio),
                            text: overlay.text ?? t('pdfEdit.overlayBlank'),
                          })}
                        </span>
                        <DeskButton
                          action={`pdf-edit-remove-overlay-${overlay.id}`}
                          variant="ghost"
                          compact
                          busy={!!busy}
                          {...dead(busyReason)}
                          onClick={() => removeOverlay(overlay.id)}
                        >
                          <Trash2 size={11} />
                          {t('pdfEdit.removeOverlay')}
                        </DeskButton>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h4 className="text-[11px] font-semibold text-slate-300">{t('pdfEdit.pageOrder')}</h4>
                <p className="mt-1 text-[11px] text-slate-500">{t('pdfEdit.pageOrderHint')}</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {draft.pageOrder.map((sourcePage, index) => (
                    <li
                      key={`${index}-${sourcePage}`}
                      data-testid={`pdfEdit-page-row-${index}`}
                      // 窄列里让图标簇换到第二排：这一行的页码文案是**数据**（产物第几页对源第几页），
                      // 裁掉就等于把判定依据藏起来，比多出一排高更糟。
                      className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line bg-ink-950/70 px-2 py-1 text-[11px] text-slate-300"
                    >
                      <DeskButton
                        action={`pdf-edit-view-page-${sourcePage}`}
                        variant="line"
                        compact
                        busy={!!busy}
                        className="justify-start"
                        {...dead(busyReason)}
                        onClick={() => showPage(sourcePage)}
                      >
                        {t('pdfEdit.pageRow', { out: index + 1, source: sourcePage })}
                      </DeskButton>
                      <span className="flex items-center gap-1">
                        {/* 四只图标键没有文字，compact 的字号撑不出行高（活体读数 17px），显式对齐到同行那档 24px。 */}
                        <DeskButton
                          action={`pdf-edit-move-up-${index}`}
                          variant="solid"
                          compact
                          className="h-6"
                          busy={!!busy}
                          aria-label={t('pdfEdit.moveUp')}
                          {...dead(afterBusy(index === 0, 'FIRST_ROW'))}
                          onClick={() => setPageOrder(swapOrder(draft.pageOrder, index, index - 1))}
                        >
                          <ArrowUp size={11} />
                        </DeskButton>
                        <DeskButton
                          action={`pdf-edit-move-down-${index}`}
                          variant="solid"
                          compact
                          className="h-6"
                          busy={!!busy}
                          aria-label={t('pdfEdit.moveDown')}
                          {...dead(afterBusy(index === draft.pageOrder.length - 1, 'LAST_ROW'))}
                          onClick={() => setPageOrder(swapOrder(draft.pageOrder, index, index + 1))}
                        >
                          <ArrowDown size={11} />
                        </DeskButton>
                        <DeskButton
                          action={`pdf-edit-duplicate-${index}`}
                          variant="solid"
                          compact
                          className="h-6"
                          busy={!!busy}
                          aria-label={t('pdfEdit.duplicatePage')}
                          {...dead(afterBusy(isAtPageCap, 'AT_PAGE_CAP'))}
                          onClick={() =>
                            setPageOrder(
                              draft.pageOrder.flatMap((candidate, position) =>
                                position === index ? [candidate, candidate] : [candidate],
                              ),
                            )
                          }
                        >
                          <Copy size={11} />
                        </DeskButton>
                        <DeskButton
                          action={`pdf-edit-remove-page-${index}`}
                          variant="ghost"
                          compact
                          className="h-6"
                          busy={!!busy}
                          aria-label={t('pdfEdit.removePage')}
                          {...dead(afterBusy(draft.pageOrder.length <= 1, 'LAST_PAGE_REMAINING'))}
                          onClick={() => setPageOrder(draft.pageOrder.filter((_, position) => position !== index))}
                        >
                          <Trash2 size={11} />
                        </DeskButton>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[11px] text-slate-400" htmlFor="pdfEdit-out-path">
                  {t('pdfEdit.outPathLabel')}
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <DeskField
                    action="pdf-edit-out-path"
                    id="pdf-edit-out-path"
                    data-testid="pdf-edit-out-path"
                    value={outPath}
                    onValueChange={setOutPath}
                    placeholder={t('pdfEdit.outPathPlaceholder')}
                    className="min-w-[220px] flex-1"
                  />
                  <DeskButton
                    action="pdf-edit-save-as"
                    variant="amber"
                    compact
                    busy={!!busy}
                    {...dead(saveAsReason)}
                    onClick={saveAs}
                  >
                    <Save size={12} />
                    {t('pdfEdit.saveAs')}
                  </DeskButton>
                </div>
                <p className="text-[11px] text-slate-500">{t('pdfEdit.outPathHint')}</p>
              </div>
            </div>
          </div>

          {saveError && (
            <Banner tone="seal" markers={{ testid: 'pdf-edit-save-error' }} className="mt-2 break-all">
              {t('pdfEdit.failed', { code: saveError.code, message: saveError.message })}
            </Banner>
          )}

          {saved && (
            <Banner tone="jade" markers={{ testid: 'pdf-edit-saved' }} className="mt-2 break-all">
              {t('pdfEdit.saved', {
                path: saved.outPath,
                count: saved.pageCount,
                hash: saved.sha256.slice(0, 12),
              })}
            </Banner>
          )}
        </>
      )}
    </section>
  );
}
