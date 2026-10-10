/**
 * 从 PDF 的**算子流**里抽出一份带样式的页面模型（spec 3.8-01 的抽取腿）。
 *
 * 为什么走 `getOperatorList()` 而不是只用 `getTextContent()`：后者只给文字与位置，
 * 字色、色带、分隔线在它那里根本不存在（plan §0 那条根因：替换字用 `sans-serif` + `#0f172a`
 * 就是因为拿不到真值）。而"抽取→重建"这条路线的全部价值就在样式，所以必须读算子流。
 *
 * 一条如实的边界：这里的数字是**比例口径**（0..1 的 RGB 分量、pt 坐标），
 * 与 `overlay-writer.ts` 的 `PdfOverlayRect` 同一套比例，两套模型之间不出现第二次换算。
 */
/** `showText` 实参里的一格字形（只声明实测用到的三处，pdf.js 版本间漂移大）。 */
interface GlyphEntry {
  readonly unicode?: unknown;
  readonly fontChar?: unknown;
  readonly width?: unknown;
}

/** 节点矩阵（PDF 的 `[a b c d e f]`）。 */
type Matrix = [number, number, number, number, number, number];

/** 一条文字 run（一个 `Tj` 抽出来的那一格）。 */
export interface ExtractedRun {
  /** 逐字文本（由算子里的字符表拼回，不经 `getTextContent`）。 */
  readonly text: string;
  /** pdf.js 的全局字体 id（`g_d0_f1` 这一类），与 `getTextContent().styles` 的键同源。 */
  readonly fontName: string;
  /** 字号（pt，`Tf` 的第二实参）。 */
  readonly fontSizePt: number;
  /** 字族提示（`serif` / `sans-serif` / …，取自 `styles[fontName].fontFamily`；读不到为 null）。 */
  readonly fontFamilyHint: string | null;
  /** 基线起点（pt，PDF 坐标：原点在左下）。 */
  readonly baselineXPt: number;
  readonly baselineYPt: number;
  /** 这一格的宽度（pt，按字形 advance 累加 × 字号 × 设备缩放）。 */
  readonly widthPt: number;
  /** 这一格的高度（pt，等于字号 × 设备缩放；与 `fontHeight` 同口径）。 */
  readonly heightPt: number;
  /** 旋转角（度，由设备矩阵的线性部分反推；横排为 0）。 */
  readonly rotationDeg: number;
  /** 墨色（0..1 三分量）；算子里没写颜色或颜色空间认不出时为 null（不猜黑）。 */
  readonly colorRgb: readonly [number, number, number] | null;
}

/** 一条非文字元素（填充矩形 / 描边线）。 */
export interface ExtractedShape {
  /** `fill` = 色带与色块，`stroke` = 分隔线与边框。 */
  readonly kind: 'fill' | 'stroke';
  readonly xPt: number;
  readonly yPt: number;
  readonly widthPt: number;
  readonly heightPt: number;
  /** 颜色（0..1 三分量）；认不出时为 null。 */
  readonly colorRgb: readonly [number, number, number] | null;
}

/** 一页的抽取结果。 */
export interface ExtractedPage {
  readonly pageNumber: number;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly runs: readonly ExtractedRun[];
  readonly shapes: readonly ExtractedShape[];
}

/** 一次抽取的读数（判据分母都从这里取，不许在测试里另数一份）。 */
export interface ExtractionStats {
  /** `getTextContent()` 里**非空**那几条的条数（判据的分母）。 */
  readonly textContentItems: number;
  /** 算子流抽到的 run 数。 */
  readonly runsRecovered: number;
  /** 其中带色（`colorRgb` 非 null）的 run 数。 */
  readonly runsWithColor: number;
  /** 其中旋转角非 0 的 run 数——"已知丢失项"，不进恢复率分母。 */
  readonly rotatedRuns: number;
  /** 算子流里的填充/描边路径数（矩形判据的分母）。 */
  readonly paintOps: number;
  /** 抽到的形状数。 */
  readonly shapesRecovered: number;
}

/** 一份文档的抽取结果。 */
export interface ExtractedDocument {
  readonly pages: readonly ExtractedPage[];
  readonly stats: ExtractionStats;
}

/** 抽取失败时的确定态（与 `PdfEditDocument.load` 同一取向：不抛，回一个可判的码）。 */
export type ExtractResult =
  { status: 'extracted'; document: ExtractedDocument } | { status: 'failed'; code: 'invalid-pdf'; reason: string };

/** pdf.js 的加载口切片（只声明实测用到的三处，版本间漂移大，见 `resume-kb/src/source.ts` 同款写法）。 */
interface PdfPageLike {
  readonly view: readonly number[];
  getTextContent(): Promise<{ items: unknown[]; styles: Record<string, { fontFamily?: unknown }> }>;
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
  cleanup(): void;
}

interface PdfDocumentLike {
  readonly numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
}

interface PdfLoadingTaskLike {
  readonly promise: Promise<PdfDocumentLike>;
  destroy(): Promise<void>;
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * 取一条算子实参里的矩阵。
 *
 * 实测（pdf.js 6.3.289）两条算子的实参形状**不一样**：`transform` 是六个数平铺
 * （`[a,b,c,d,e,f]`），`setTextMatrix` 是"一个长度为 6 的数组套在里面"（`[[a,b,c,d,e,f]]`）。
 * 文档里没有这一条，按实测兼容两种形状，否则解出来全是 NaN。
 * @param args 算子实参
 * @returns 六条矩阵
 */
function matrixOf(args: unknown): Matrix {
  const outer = args as readonly unknown[];
  const inner = (Array.isArray(outer[0]) || ArrayBuffer.isView(outer[0]) ? outer[0] : outer) as readonly number[];
  return [Number(inner[0]), Number(inner[1]), Number(inner[2]), Number(inner[3]), Number(inner[4]), Number(inner[5])];
}

/**
 * 两个矩阵相乘（`m1 × m2`，与 PDF 的 `cm` / `Tm` 复合口径一致）。
 * @param m1 左矩阵
 * @param m2 右矩阵
 * @returns 复合矩阵
 */
function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * 把算子里的颜色实参归一成 0..1 的三分量。
 *
 * 实测（pdf.js 6.3.289）：`setFillRGBColor` 到算子流里已经是**一个 `#rrggbb` 字符串**，
 * 不是三个 0..255 的数——文档转述与 1.x 时代的形状都不同，这一条按实测写。
 * @param args 算子实参
 * @returns 三分量；认不出的颜色空间（`setFillColorN` 的 ICC / 分色）回 null，不猜
 */
function colorOf(args: unknown): [number, number, number] | null {
  const first = Array.isArray(args) ? (args as readonly unknown[])[0] : args;
  if (typeof first === 'string' && /^#[0-9a-f]{6}$/i.test(first)) {
    return [
      Number.parseInt(first.slice(1, 3), 16) / 255,
      Number.parseInt(first.slice(3, 5), 16) / 255,
      Number.parseInt(first.slice(5, 7), 16) / 255,
    ];
  }
  if (typeof first === 'number' && Number.isFinite(first)) {
    // `setFillGray`：一个 0..1 的标量。
    if (!Array.isArray(args) && first >= 0 && first <= 1) return [first, first, first];
    if (Array.isArray(args) && args.length === 1 && first >= 0 && first <= 1) return [first, first, first];
  }
  return null;
}

/**
 * 从一格的字符表拼回文本，并累加宽度（千分之一 em）。
 * @param chars `showText` 实参里的那个数组
 * @returns `{text, advancePerThousand}`；非字符项（如 `TJ` 里的位移数）按 0 计
 */
function textOf(chars: readonly unknown[]): { text: string; advancePerThousand: number } {
  let text = '';
  let advance = 0;
  for (const entry of chars) {
    if (typeof entry === 'number') {
      // `TJ` 数组里的裸数字是字距位移（千分之一 em，负值为前进）。
      advance += -entry;
      continue;
    }
    const glyph = entry as GlyphEntry;
    text +=
      typeof glyph.unicode === 'string' ? glyph.unicode : typeof glyph.fontChar === 'string' ? glyph.fontChar : '';
    advance += typeof glyph.width === 'number' ? glyph.width : 0;
  }
  return { text, advancePerThousand: advance };
}

/**
 * 走一遍一页的算子流，抽出文字 run 与形状。
 * @param list `getOperatorList()` 的返回
 * @param styles `getTextContent().styles`（字族提示的唯一来源，算子里没有）
 * @param ops pdf.js 的算子号表（**不在本包里抄第二份**，见 plan §6.2）
 * @returns 该页的 runs 与 shapes
 */
export function walkOperatorList(
  list: { fnArray: readonly number[]; argsArray: readonly unknown[] },
  styles: Record<string, { fontFamily?: unknown }>,
  ops: Record<string, number>,
): { runs: ExtractedRun[]; shapes: ExtractedShape[]; paintOps: number } {
  const runs: ExtractedRun[] = [];
  const shapes: ExtractedShape[] = [];
  let paintOps = 0;

  let ctm: Matrix = IDENTITY;
  let textMatrix: Matrix = IDENTITY;
  let lineMatrix: Matrix = IDENTITY;
  let fontName = '';
  let fontSizePt = 0;
  let fill: [number, number, number] | null = null;
  let stroke: [number, number, number] | null = null;
  let leading = 0;
  // `q`/`Q` 包住的不只是坐标，颜色同样要跟着进出（真实模板的"区块底色"就写在一对 `q…Q` 里，
  // 只栈 CTM 会让出栈之后的那一格继承到已经作废的底色）。
  const stateStack: { ctm: Matrix; fill: [number, number, number] | null; stroke: [number, number, number] | null }[] =
    [];

  for (let index = 0; index < list.fnArray.length; index += 1) {
    const raw = list.fnArray[index] as number;
    // `T*` 与两种"换行再画字"的合写算子，先按 PDF 口径推进行矩阵，再把带字的那两条当成一次 `Tj` 处理——
    // 否则这三条合写算子里的字会整格丢掉。
    if (raw === ops.nextLine || raw === ops.nextLineShowText || raw === ops.nextLineSetSpacingShowText) {
      lineMatrix = multiply([1, 0, 0, 1, 0, -leading], lineMatrix);
      textMatrix = lineMatrix;
    }
    const fn = raw === ops.nextLine ? -1 : raw === ops.nextLineShowText ? ops.showText : raw;
    const args = list.argsArray[index];
    switch (fn) {
      case ops.save:
        stateStack.push({ ctm, fill, stroke });
        break;
      case ops.restore: {
        const popped = stateStack.pop();
        if (popped) {
          ctm = popped.ctm;
          fill = popped.fill;
          stroke = popped.stroke;
        }
        break;
      }
      case ops.transform:
        ctm = multiply(ctm, matrixOf(args));
        break;
      case ops.beginText:
        textMatrix = IDENTITY;
        lineMatrix = IDENTITY;
        break;
      case ops.setFont: {
        const [name, size] = args as readonly [string, number];
        fontName = name;
        fontSizePt = size;
        break;
      }
      case ops.setFontSize:
        fontSizePt = (args as readonly number[])[0] as number;
        break;
      case ops.setTextMatrix: {
        const m = matrixOf(args);
        lineMatrix = m;
        textMatrix = m;
        break;
      }
      case ops.setLeading:
        leading = (args as readonly number[])[0] as number;
        break;
      case ops.moveText:
      case ops.setLeadingMoveText: {
        // PDF 口径：行矩阵先平移，文本矩阵跟着行矩阵走。`TD` 与 `Td` 的差别只在它还顺手把 leading
        // 改成 `-ty`，这一格不改掉的话，后面跟着的 `T*` 会按错的行距推进。
        const nums = args as readonly number[];
        const tx = Number(nums[0]);
        const ty = Number(nums[1]);
        if (fn === ops.setLeadingMoveText) leading = -ty;
        lineMatrix = multiply([1, 0, 0, 1, tx, ty], lineMatrix);
        textMatrix = lineMatrix;
        break;
      }
      case ops.setFillGray:
      case ops.setFillRGBColor:
      case ops.setFillCMYKColor:
      case ops.setFillColor:
      case ops.setFillColorN:
        fill = colorOf(args);
        break;
      case ops.setStrokeGray:
      case ops.setStrokeRGBColor:
      case ops.setStrokeCMYKColor:
      case ops.setStrokeColor:
      case ops.setStrokeColorN:
        stroke = colorOf(args);
        break;
      case ops.showText:
      case ops.showSpacedText:
      case ops.nextLineShowText:
      case ops.nextLineSetSpacingShowText: {
        const chars = (Array.isArray(args) ? args[0] : args) as readonly unknown[];
        const { text, advancePerThousand } = textOf(Array.isArray(chars) ? chars : []);
        if (text.length === 0) break;
        const device = multiply(multiply(textMatrix, ctm), [fontSizePt, 0, 0, fontSizePt, 0, 0]);
        const scaleX = Math.hypot(device[0], device[1]);
        const scaleY = Math.hypot(device[2], device[3]);
        runs.push({
          text,
          fontName,
          fontSizePt,
          fontFamilyHint:
            typeof styles[fontName]?.fontFamily === 'string' ? String(styles[fontName]?.fontFamily) : null,
          baselineXPt: device[4],
          baselineYPt: device[5],
          widthPt: (advancePerThousand / 1000) * scaleX,
          heightPt: scaleY,
          rotationDeg: (Math.atan2(device[1], device[0]) * 180) / Math.PI,
          colorRgb: fill,
        });
        break;
      }
      case ops.constructPath: {
        // 实测形状：`[<paint 算子号>, 扁平点列, minMax{x0,y0,x1,y1}]`——bbox 由 pdf.js 直接给出，
        // 不在本包里重算一遍路径（§2.6）。
        paintOps += 1;
        const paintOp = (args as readonly unknown[])[0] as number;
        const box = (args as readonly unknown[])[2] as { 0: number; 1: number; 2: number; 3: number } | undefined;
        if (!box) break;
        const isStroke = paintOp === ops.stroke || paintOp === ops.closeStroke || paintOp === ops.fillStroke;
        const x0 = Math.min(box[0], box[2]);
        const y0 = Math.min(box[1], box[3]);
        shapes.push({
          kind: isStroke ? 'stroke' : 'fill',
          xPt: x0,
          yPt: y0,
          widthPt: Math.abs(box[2] - box[0]),
          heightPt: Math.abs(box[3] - box[1]),
          colorRgb: isStroke ? stroke : fill,
        });
        break;
      }
      default:
        break;
    }
  }
  return { runs, shapes, paintOps };
}

/**
 * 抽取一份 PDF 的每一页内容（spec 3.8-01 的唯一入口；位图与算子流在同一份文档上各只读一次）。
 * @param bytes PDF 字节（所有权归本函数）
 * @returns `extracted` 带页面与读数；打不开时 `failed` + `invalid-pdf`（不抛异常）
 */
export async function extractPdfDocument(bytes: Uint8Array): Promise<ExtractResult> {
  let loadingTask: PdfLoadingTaskLike | null = null;
  try {
    const pdfModule = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
      getDocument(source: unknown): PdfLoadingTaskLike;
      OPS: Record<string, number>;
    };
    loadingTask = pdfModule.getDocument({
      data: bytes,
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0,
    });
    const document = await loadingTask.promise;
    const pages: ExtractedPage[] = [];
    let textContentItems = 0;
    let runsRecovered = 0;
    let runsWithColor = 0;
    let rotatedRuns = 0;
    let paintOps = 0;
    let shapesRecovered = 0;

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const list = await page.getOperatorList();
        const walked = walkOperatorList(list, content.styles, pdfModule.OPS);
        const view = page.view;
        pages.push({
          pageNumber,
          widthPt: Math.abs(Number(view[2]) - Number(view[0])),
          heightPt: Math.abs(Number(view[3]) - Number(view[1])),
          runs: walked.runs,
          shapes: walked.shapes,
        });
        textContentItems += content.items.filter((item) => {
          const record = item as { str?: unknown };
          return typeof record.str === 'string' && record.str.length > 0;
        }).length;
        runsRecovered += walked.runs.length;
        runsWithColor += walked.runs.filter((run) => run.colorRgb !== null).length;
        rotatedRuns += walked.runs.filter((run) => Math.abs(run.rotationDeg) > 0.01).length;
        paintOps += walked.paintOps;
        shapesRecovered += walked.shapes.length;
      } finally {
        page.cleanup();
      }
    }

    return {
      status: 'extracted',
      document: {
        pages,
        stats: { textContentItems, runsRecovered, runsWithColor, rotatedRuns, paintOps, shapesRecovered },
      },
    };
  } catch (error) {
    return {
      status: 'failed',
      code: 'invalid-pdf',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (loadingTask !== null) await loadingTask.destroy();
  }
}
