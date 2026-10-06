/**
 * `pdf.layout` 服务（plan §7.4 的第二条口，spec 3.5-01 的「文本块识别结果可视」中**不过界的坐标半边**）：
 * 绝对路径 + 页号 → 这一页的文本块矩形（视觉比例坐标）。
 *
 * 脱敏口径（§8.4/§8.5 与 plan §7.4 末段）：回传的**只有矩形**，`str` 一个字符都不出进程边界。
 * plan §7.4 那张表原本写着 `transform/width/height/str`，本节按「整页原文不进渲染层」那半句的字面收窄：
 * 3.5-01 的判据要的是「看得见有哪些块」，线框本身就够了，界面上没有一处需要原文
 * （框选是人工画的，见降级裁定对 3.5-01 的改写），所以不把原文再搬一趟（§2.6）。
 *
 * 与 `pdf.io` 的分工：`pdf.io.open` 只认 pdf-lib（量页面），本服务额外要 pdf.js 的文本项。
 * 页面宽高仍然只问 pdf-lib 一份（`PdfEditDocument`），pdf.js 只用来取文本项——两侧若各报一套页面尺寸，
 * 线框与覆盖区就会错位，这正是 §2.5 禁止的「两个都能用」。
 *
 * 本服务**不建表、不占迁移号段**（plan §7.1 的存储行）：读数是一次查询的产物，不落地。
 */
import { AppError, Service, type Context } from '@auto-cc/core';
import { readBoundedFile } from '@auto-cc/core/file-read';
import { z } from 'zod';
import { PdfEditDocument } from './pdf-document.js';
import type { PdfOverlayRect } from './overlay-writer.js';
import { textItemRect, type PdfTextItemSlice } from './text-layout.js';

/** `pdf.layout` 的可调项。 */
export const pdfLayoutSchema = z.strictObject({
  /** 单次读取的字节上限，与 `pdf.io` / `resume.parse` 同量级并显式写在装配清单里。 */
  maxBytes: z.number().int().min(1024).max(52_428_800).default(5_242_880),
});

export type PdfLayoutConfig = z.output<typeof pdfLayoutSchema>;

/** 一个文本块的线框：`index` 是 pdf.js 给出的原始次序，界面用它做编号与标识。 */
export interface PdfTextBox {
  readonly index: number;
  readonly rect: PdfOverlayRect;
}

/** `textItems` 的回执：页号、源档页数与这一页的文本块矩形。 */
export interface PdfTextItemsReading {
  readonly pageNumber: number;
  readonly pageCount: number;
  readonly boxes: readonly PdfTextBox[];
}

/** 实测在 Node 主进程内取文本项必需的四项选项（与 `resume-kb/src/source.ts` 同一份，不关掉会在无 DOM 环境报错）。 */
const PDF_TEXT_OPTIONS = {
  isEvalSupported: false,
  useSystemFonts: true,
  disableFontFace: true,
  verbosity: 0,
} as const;

/** pdf.js 文档对象的切片——只声明这条链真用到的三个成员（口径照 `source.ts`，不依赖它的类型入口）。 */
interface PdfLayoutDocumentLike {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{ readonly items: readonly PdfTextItemSlice[] }>;
    cleanup(): void;
  }>;
}

/** pdf.js 的加载任务切片——释放入口在任务上而不是文档代理上（实测 6.3.289 的代理没有 `destroy`）。 */
interface PdfLayoutLoadingTaskLike {
  readonly promise: Promise<PdfLayoutDocumentLike>;
  destroy(): Promise<void>;
}

/**
 * 文本项坐标服务入口。
 */
export class PdfLayoutService extends Service {
  static provide = 'pdf.layout';
  static Config = pdfLayoutSchema;

  constructor(
    ctx: Context,
    private readonly options: PdfLayoutConfig,
  ) {
    super(ctx, 'pdf.layout');
  }

  [Service.init](): void {
    this.ctx.logger.info(
      `[pdf-edit] pdf.layout 就绪，单次读取上限 ${String(this.options.maxBytes)} 字节（只回矩形，原文不过界）`,
    );
  }

  /**
   * 量出一份 PDF 某一页上的文本块矩形。
   * @param filePath 用户给的**绝对路径**（渲染层没有读文件的通道，与 `pdf.io.open` 同一口径）
   * @param pageNumber 页号，**从 1 起**（与 `PdfPageMetric.number` 同一个口径）
   * @returns 这一页的文本块矩形（视觉比例坐标，原点左上、y 向下）；图片型 PDF 返回空数组而不是失败
   * @throws `AppError('PDF_EDIT_READ_FAILED')`——`details.code` 为 `empty` / `encrypted` / `invalid-pdf`（装载阶段）、
   *         `page-out-of-range`（页号不是 1…页数的整数）、`layout-failed`（pdf.js 取文本项这一步失败）
   */
  async textItems(filePath: string, pageNumber: number): Promise<PdfTextItemsReading> {
    const bytes = readBoundedFile(filePath, { maxBytes: this.options.maxBytes, code: 'PDF_EDIT_READ_FAILED' });
    const loaded = await PdfEditDocument.load(bytes);
    if (loaded.status === 'failed') {
      throw new AppError('PDF_EDIT_READ_FAILED', `打不开这份文件，量不了文本块：${filePath}`, 'pdf.layout.textItems', {
        code: loaded.reason === 'invalid' ? 'invalid-pdf' : loaded.reason,
        detail: loaded.detail,
        filePath,
      });
    }
    const metrics = loaded.document.sourcePageMetrics();
    const page = metrics[pageNumber - 1];
    if (page === undefined || !Number.isInteger(pageNumber) || pageNumber < 1) {
      throw new AppError(
        'PDF_EDIT_READ_FAILED',
        `这份 PDF 只有 ${String(metrics.length)} 页，没有第 ${String(pageNumber)} 页`,
        'pdf.layout.textItems',
        { code: 'page-out-of-range', pageCount: metrics.length, pageNumber },
      );
    }
    // 交给 pdf.js 前复制一份：实测 `getDocument` 会移交（detach）传入的 ArrayBuffer，
    // 而上面那份字节已经先给 pdf-lib 量过页面，不能让它被抽走之后再用。
    const items = await readTextItems(bytes.slice(0), pageNumber, filePath);
    const boxes: PdfTextBox[] = [];
    for (const [offset, item] of items.entries()) {
      const rect = textItemRect(item, page);
      if (rect !== null) boxes.push({ index: offset, rect });
    }
    return { pageNumber, pageCount: metrics.length, boxes };
  }
}

/**
 * 用 pdf.js 取一页的文本项。
 * @param bytes PDF 字节（所有权已归本函数）
 * @param pageNumber 页号（1 起，越界由调用方先拦掉）
 * @param filePath 出错时回显的路径（不读第二遍）
 * @returns 文本项数组；抽不到就是空数组
 * @throws `AppError('PDF_EDIT_READ_FAILED')`，`details.code` 为 `layout-failed` / `invalid-pdf`
 */
async function readTextItems(bytes: Uint8Array, pageNumber: number, filePath: string): Promise<PdfTextItemSlice[]> {
  let loadingTask: PdfLayoutLoadingTaskLike | null = null;
  try {
    const pdfModule = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
      getDocument(source: unknown): PdfLayoutLoadingTaskLike;
    };
    loadingTask = pdfModule.getDocument({ data: bytes, ...PDF_TEXT_OPTIONS });
    const document = await loadingTask.promise;
    const page = await document.getPage(pageNumber);
    try {
      return [...(await page.getTextContent()).items];
    } finally {
      page.cleanup();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AppError('PDF_EDIT_READ_FAILED', `读不出这一页的文本块：${filePath}`, 'pdf.layout.textItems', {
      code: 'layout-failed',
      detail,
      pageNumber,
      filePath,
    });
  } finally {
    await loadingTask?.destroy();
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'pdf.layout': PdfLayoutService;
  }
}
