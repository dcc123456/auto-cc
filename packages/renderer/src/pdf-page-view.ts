/**
 * 真纸面的原件（spec 3.5-12，plan §10.5 / §10.9）：把一份 PDF 的字节画成人眼认得出的那一页，
 * 并把同一页里读得出的文字聚成**行盒**——一次装载同时供位图与文本层（AGENTS.md §2.5：
 * 「看得见纸」和「点得中那一行」必须是同一次解析的两个出口，不允许再开第二条通道）。
 *
 * 为什么 pdf.js 跑在渲染层而不是主进程：位图与行盒都是「给人看、给人点」的东西，主进程只该管字节
 * （`pdf.io.bytes`）与写出（`pdf.export.saveAs`）；而 sandbox 渲染层有 DOM 与 Worker，主进程反而没有画布。
 * 三条底线一条没动：不碰 Node、能力只过白名单、像素不过进程边界。
 *
 * 打包态的两条硬约束（plan §10.2 与 §10.9 的装机实测；dev 通过不算通过）：
 * ① worker 必须是**同源的真文件**——装机页是 `file://` 且 `script-src 'self'`（`scripts/build.ts` 的
 *    `RENDERER_CSP`），vite 的 `?worker&inline` 产出的 `blob:` worker 会被 CSP 挡掉，回退成主线程 fake worker；
 * ② worker 里的 `import()` 与 cmaps / 标准字体 / wasm 的 `fetch` 也全部按 `document.baseURI` 相对解析，
 *    所以这四类资源必须由 `vite-static-assets.ts` 原样搬进渲染层根目录下的 `pdfjs/` 树（两种运行态同一条路径）。
 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { backdropOfBand } from '@auto-cc/plugin-pdf-edit/overlay-colors';
import { PDFJS_ASSET_DIRS, PDFJS_PATH_PREFIX, PDFJS_WORKER_FILE } from './pdfjs-asset-tree';

/**
 * 页面上的一个矩形，用**比例坐标**表示（原点左上、y 向下、四值都在 0..1）。
 * 与主进程 `overlay-writer` 吃的那份 `PdfOverlayRect` 同一口径——行盒与覆盖区必须是同一套坐标，
 * 否则「点中的那一行」与「盖上去的位置」会差一个符号（这条口径原先由已退役的 `text-layout.ts` 持有，
 * 现在唯一消费者在这里，仍然只有一份）。
 */
export interface PdfPaperRect {
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
}

/**
 * 一行可点原文。
 * `fontSizePt` 取该行最大的字号（PDF 用户空间单位），就地改时交给会话当 `sizePt`——
 * 新字要与被盖住的那一行一般大，否则「就地」就是假的。
 */
export interface PdfTextLine {
  lineId: string;
  text: string;
  rect: PdfPaperRect;
  fontSizePt: number;
}

/**
 * 一页纸：度量 + 行盒 + 画自己的本领。
 * `paint` 刻意不收倍率参数——它按画布**当下量出的 CSS 宽度**决定铺多满（spec 6.4-12 的「装不下就整张缩小」），
 * 倍率这件事只有量的人（纸面视图）知道。
 */
export interface PdfPaperPage {
  /** 源页号（1 起，与 `pdf.io.open` 回执里的 `pages[].number` 同一口径）。 */
  pageNumber: number;
  /** 该页宽（pt）：行盒换算与覆盖区比例的分母。 */
  widthPt: number;
  /** 该页高（pt）。 */
  heightPt: number;
  /** 该页读得出的行（按基线聚合）；扫描型页为空数组。 */
  lines: readonly PdfTextLine[];
  /**
   * 把这一页画成真实纸面图像。
   * @param canvas 目标画布；位图宽高由本函数按 CSS 宽度与 devicePixelRatio 重设
   * @param cssWidthPx 画布应当铺满的 CSS 宽度（px）；非正数（视图未激活）时不动画布、回 -1
   * @returns 渲染耗时（ms，整数）；未画时回 -1，调用方据此显示「还没画」而不是「画了个 0ms」
   */
  paint(canvas: HTMLCanvasElement, cssWidthPx: number): Promise<number>;
  /**
   * 量出**这一块矩形周围的纸是什么颜色**（spec 3.5-14）：从这一页当下画在画布上的那张位图里，
   * 取矩形外扩一圈的像素，按逐通道中位数定色。
   * @param rect 比例矩形（就是将要盖住的那一区）
   * @returns `#rrggbb`；画布还没画过、读不回像素（视图未激活 / `getImageData` 被拒）或取样不足时
   *          回 undefined，由 `colorsOfOverlay` 那一句如实回落墨色，**绝不猜白**
   */
  sampleBackdrop(rect: PdfPaperRect): string | undefined;
}

/** 一次装载后的文档句柄。 */
export interface PdfPaper {
  /** 页数（pdf.js 自己的读数；与主进程 `pdf.io.open` 的回执应当一致，界面把两者都摆出来时以主进程那份为准）。 */
  pageCount: number;
  /**
   * 取某一页（首次取时解析该页文本层，之后复用同一份行盒）。
   * @param pageNumber 源页号（1 起）
   */
  page(pageNumber: number): Promise<PdfPaperPage>;
  /**
   * 释放这一份文档：先等 pdf.js 的 `destroy()` 收尾（它会摘掉这个 port 上的 PDFWorker 登记），
   * 再终止 worker 本体。换文件或关掉编辑器都要走这一条，否则一次「打开第二份文件」就撞
   * `Cannot use more than one PDFWorker per port`。
   */
  dispose(): Promise<void>;
}

/**
 * 拼出 `pdfjs/` 资源树里的一条 URL。
 * @param segments 前缀之后的路径段；最后一段是目录时要带结尾斜杠（pdf.js 自己会再拼文件名）
 * @returns 绝对 URL；开发态在 `http://127.0.0.1:5173/` 下、装机版在 `file://…/renderer/` 下各自落对位置
 */
function pdfjsUrl(...segments: string[]): string {
  return new URL(`${PDFJS_PATH_PREFIX}/${segments.join('/')}`, document.baseURI).href;
}

/** 资源目录的三条 URL（结尾斜杠是 pdf.js 的口径：它按 `cMapUrl + 文件名` 直接串）。 */
const CMAP_URL = pdfjsUrl(...PDFJS_ASSET_DIRS[0].split('/'), '');
const STANDARD_FONT_URL = pdfjsUrl(...PDFJS_ASSET_DIRS[1].split('/'), '');
const WASM_URL = pdfjsUrl(...PDFJS_ASSET_DIRS[2].split('/'), '');

/**
 * 读取数组或标量里的一个有限数。
 * pdf.js 的 `TextItem.transform` 声明是 `Array<any>`，类型检查器给的每个元素都是 `any`
 * （本包 lint 开着 `no-unsafe-*`），所以数值一律从 `unknown` 现取现判，不接受 `any` 读数。
 * @param value 待读的 `unknown`（数组按下标取，标量直接用）
 * @param index 下标（省略时按标量处理）
 * @returns 有限数，或 `null` 表示不是数
 */
function numberAt(value: unknown, index?: number): number | null {
  const source: unknown =
    index === undefined ? value : Array.isArray(value) ? (value as readonly unknown[])[index] : undefined;
  return typeof source === 'number' && Number.isFinite(source) ? source : null;
}

/**
 * 一行聚合过程中的可变态（同一基线上的若干文本项）。
 */
interface LineAccumulator {
  baselinePt: number;
  leftPt: number;
  rightPt: number;
  topPt: number;
  fontSizePt: number;
  parts: string[];
}

/**
 * 把 pdf.js 的文本项按基线聚成行。
 * 为什么要聚：pdf.js 给的是**片段**（同一行的中文常被拆成几段，跨字体还会再多几段），
 * 人眼的一行才是人要点的东西；聚完之后「点这一行」与「盖这一行」才是同一件事。
 * @param items 该页的文本项（只取真有文字的）
 * @param widthPt 页宽（pt）
 * @param heightPt 页高（pt）
 * @returns 自上而下的行盒列表
 */
function linesOfItems(items: readonly PdfTextItemSlice[], widthPt: number, heightPt: number): PdfTextLine[] {
  const measured: { baseline: number; left: number; right: number; top: number; size: number; str: string }[] = [];
  for (const item of items) {
    if (item.str.trim() === '') continue;
    const left = numberAt(item.transform, 4);
    const baseline = numberAt(item.transform, 5);
    const width = numberAt(item.width);
    const height = numberAt(item.height);
    if (left === null || baseline === null || width === null || height === null) continue;
    // 字号取矩阵的 (a,b) 长度：水平文字它就是 em 大小，比 `height`（含升部降部的字身高）更贴近人说的「字号」。
    const a = numberAt(item.transform, 0) ?? 0;
    const b = numberAt(item.transform, 1) ?? 0;
    measured.push({
      baseline,
      left,
      right: left + width,
      top: baseline + height,
      size: Math.hypot(a, b) || height,
      str: item.str,
    });
  }
  // 先按基线再按左右排：同一行的判定用「基线差 ≤1.5pt」，比按 y 分桶更贴排字实际（同字号的两行至少差一行距）。
  measured.sort((one, two) => two.baseline - one.baseline || one.left - two.left);
  const groups: LineAccumulator[] = [];
  for (const piece of measured) {
    const tail = groups[groups.length - 1];
    if (tail && Math.abs(tail.baselinePt - piece.baseline) <= 1.5) {
      tail.leftPt = Math.min(tail.leftPt, piece.left);
      tail.rightPt = Math.max(tail.rightPt, piece.right);
      tail.topPt = Math.max(tail.topPt, piece.top);
      tail.fontSizePt = Math.max(tail.fontSizePt, piece.size);
      tail.parts.push(piece.str);
      continue;
    }
    groups.push({
      baselinePt: piece.baseline,
      leftPt: piece.left,
      rightPt: piece.right,
      topPt: piece.top,
      fontSizePt: piece.size,
      parts: [piece.str],
    });
  }
  // 组是**自下而上**长的（PDF 的 y 向上），摆回界面前翻成视觉顺序（原点左上、y 向下）。
  return groups.reverse().map((group, index): PdfTextLine => ({
    lineId: `L${index + 1}`,
    text: group.parts.join(''),
    fontSizePt: group.fontSizePt,
    rect: {
      xRatio: group.leftPt / widthPt,
      yRatio: (heightPt - group.topPt) / heightPt,
      widthRatio: (group.rightPt - group.leftPt) / widthPt,
      heightRatio: (group.topPt - group.baselinePt) / heightPt,
    },
  }));
}

/** pdf.js 文本项里本模块真要用的四个成员（不依赖它的类型入口，跨版本漂移时这里自己判形状）。 */
interface PdfTextItemSlice {
  str: string;
  transform: unknown;
  width: unknown;
  height: unknown;
}

/**
 * 量底色时，行盒向外扩多宽（**物理像素**，不是 CSS px：位图是按 devicePixelRatio 铺的）。
 * 3px 这一档是量出来的经验值——再窄就扫到这一行自己的抗锯齿边缘（那已经不是纸了），再宽就走进相邻那一行。
 */
const BACKDROP_GUTTER_PX = 3;
/** 环带上每隔几个像素取一个：一条 400px 宽的行盒外圈有几千个像素，中位数不需要那么多。 */
const BACKDROP_SAMPLE_STEP_PX = 2;
/** 少于这么多个取样就当"没量到"（回 undefined 走那句诚实回落，不猜一个数）。 */
const BACKDROP_MIN_SAMPLES = 24;

/**
 * 把比例矩形换成**这一页当下那张位图**上的环带几何（像素坐标，原点左上）。
 * @param canvas 已经画好这一页的画布（宽高是物理像素）
 * @param rect 将要盖住的那一区（比例）
 * @returns 带子的位置与尺寸，以及"盒"在带内坐标（取色时把内沿跳过）
 */
function backdropBandOf(canvas: HTMLCanvasElement, rect: PdfPaperRect) {
  const boxLeft = Math.round(rect.xRatio * canvas.width);
  const boxTop = Math.round(rect.yRatio * canvas.height);
  const boxRight = Math.round((rect.xRatio + rect.widthRatio) * canvas.width);
  const boxBottom = Math.round((rect.yRatio + rect.heightRatio) * canvas.height);
  const x0 = Math.max(0, Math.min(canvas.width - 1, boxLeft - BACKDROP_GUTTER_PX));
  const y0 = Math.max(0, Math.min(canvas.height - 1, boxTop - BACKDROP_GUTTER_PX));
  const x1 = Math.max(x0 + 1, Math.min(canvas.width, boxRight + BACKDROP_GUTTER_PX));
  const y1 = Math.max(y0 + 1, Math.min(canvas.height, boxBottom + BACKDROP_GUTTER_PX));
  return {
    x0,
    y0,
    width: x1 - x0,
    height: y1 - y0,
    innerX: boxLeft - x0,
    innerY: boxTop - y0,
    innerWidth: boxRight - boxLeft,
    innerHeight: boxBottom - boxTop,
  };
}

/**
 * 装载一份 PDF 的字节，得到真纸面的文档句柄。
 * @param bytes 整份文件的字节（`pdf.io.bytes` 的返回值）。注意 pdf.js 会把这块缓冲区**转移**给 worker，
 *              调用方此后不能再拿它做二次解析——要重取只能再走一次 `pdf.io.bytes`。
 * @returns 文档句柄；结构损坏或加密等失败由 pdf.js 抛错，调用方把它转成一句人话
 */
export async function loadPdfPaper(bytes: Uint8Array): Promise<PdfPaper> {
  const worker = new Worker(pdfjsUrl(PDFJS_WORKER_FILE), { type: 'module' });
  // 每次装载都换一只 worker：pdf.js 一个 port 只允许登记一个 PDFWorker，
  // 而换文件时上一份必须已经 `dispose()`，于是这里不存在「两个文档共用一只 worker」的中间态。
  GlobalWorkerOptions.workerPort = worker;
  const loadingTask: PDFDocumentLoadingTask = getDocument({
    data: bytes,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_URL,
    wasmUrl: WASM_URL,
  });
  let doc: PDFDocumentProxy;
  try {
    doc = await loadingTask.promise;
  } catch (error) {
    worker.terminate();
    throw error;
  }
  const cache = new Map<number, PdfPaperPage>();

  return {
    pageCount: doc.numPages,
    async page(pageNumber: number) {
      const cached = cache.get(pageNumber);
      if (cached) return cached;
      const proxy = await doc.getPage(pageNumber);
      const base = proxy.getViewport({ scale: 1 });
      const content = await proxy.getTextContent();
      // `'str' in item` 是 pdf.js 两种文本项（文字 / 标程内容）的分辨口，收窄后剩下的才是带坐标的那一种。
      const slices: PdfTextItemSlice[] = content.items
        .filter((item) => 'str' in item)
        .map((item) => ({ str: item.str, transform: item.transform, width: item.width, height: item.height }));
      /** 这一页当下画在哪块画布上（`paint` 写、`sampleBackdrop` 读）；还没画过即 null。 */
      let paintedCanvas: HTMLCanvasElement | null = null;
      const built: PdfPaperPage = {
        pageNumber,
        widthPt: base.width,
        heightPt: base.height,
        lines: linesOfItems(slices, base.width, base.height),
        async paint(canvas, cssWidthPx) {
          if (cssWidthPx < 1) return -1;
          const dpr = window.devicePixelRatio || 1;
          // 位图按物理像素铺（清晰度跟着 devicePixelRatio 走），CSS 宽度由容器给（画布挂 `w-full`）。
          const viewport = proxy.getViewport({ scale: (cssWidthPx * dpr) / base.width });
          const painter = canvas.getContext('2d');
          if (!painter) return -1;
          canvas.width = Math.max(1, Math.round(viewport.width));
          canvas.height = Math.max(1, Math.round(viewport.height));
          const started = performance.now();
          await proxy.render({ canvas, canvasContext: painter, viewport }).promise;
          // 记住"这一页当下画在哪块画布上"：底色就是从那张位图上量的（见 `sampleBackdrop`）。
          paintedCanvas = canvas;
          return Math.round(performance.now() - started);
        },
        sampleBackdrop(rect) {
          const canvas = paintedCanvas;
          const painter = canvas?.getContext('2d');
          const band = canvas ? backdropBandOf(canvas, rect) : undefined;
          if (!canvas || !painter || !band) return undefined;
          let pixels: ImageData;
          try {
            pixels = painter.getImageData(band.x0, band.y0, band.width, band.height);
          } catch {
            // 读不回像素（画布被隔离 / 尺寸为 0）：交回"没量到"，让两条腿一起走那句诚实回落。
            return undefined;
          }
          return backdropOfBand({
            // `ImageData` 的三个成员是原型上的 getter，展开运算拷不到，所以逐键给（活体踩过一次空带的）。
            data: pixels.data,
            width: pixels.width,
            height: pixels.height,
            innerX: band.innerX,
            innerY: band.innerY,
            innerWidth: band.innerWidth,
            innerHeight: band.innerHeight,
            stepPx: BACKDROP_SAMPLE_STEP_PX,
            minSamples: BACKDROP_MIN_SAMPLES,
          });
        },
      };
      cache.set(pageNumber, built);
      return built;
    },
    async dispose() {
      cache.clear();
      // 顺序固定：先 `destroy()`（pdf.js 摘掉 port 上的登记），再 `terminate()`（真的收掉线程）。
      await loadingTask.destroy();
      worker.terminate();
    },
  };
}
