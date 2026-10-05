/**
 * `pdf.export` 服务（plan §7.4 的另存腿；spec 3.5-02 / 3.5-09，并接住从 3.4-04/05/07 转移来的确定态）。
 *
 * 一句话：**源文件只读，产物是新文件**。整条链上唯一一次写盘发生在最后那一下 `rename`，
 * 且写的是 `<outPath>.part` 再改名（plan §7.10）——于是「抛错的时候磁盘上没有半成品」是结构上的必然，
 * 而不是一句承诺。这正是 3.5-05 那条「绝不产出看似改过实则含原文的文件」在降级路线下的替身。
 *
 * 为什么入参还是路径而不是「把 `pdf.io` 打开的那份文档递过来」：主进程不在两次调用之间存活的会话态
 * （plan §7.1 的存储行——覆盖区列表活在渲染层的 draft 里）。所以每次另存重新读一遍源文件，
 * 顺带把「源文件在此期间被人动过」这件事也读进来了。
 */
import { isAbsolute, resolve } from 'node:path';
import { rename, rm, writeFile } from 'node:fs/promises';
import { AppError, Service, type Context } from '@auto-cc/core';
import { readBoundedFile, sha256Hex } from '@auto-cc/core/file-read';
import { z } from 'zod';
import { PdfEditDocument } from './pdf-document.js';
import { planOverlays, type OverlayRejection, type PdfOverlayInput } from './overlay-writer.js';

/** `pdf.export` 的可调项：一条尺度一个键，代码内不留魔法数。 */
export const pdfExportSchema = z.strictObject({
  /** 与 `pdf.io` 同一量级的读取上限（见 `pdfIoSchema` 的理由）。 */
  maxBytes: z.number().int().min(1024).max(52_428_800).default(5_242_880),
  /** 单次另存允许的覆盖区条数：超出即拒，不做「画到第 N 区为止」这种半成品。 */
  maxOverlays: z.number().int().min(1).max(200).default(50),
  /** 覆盖区没自带字号时的默认字号（pt）。 */
  defaultTextSizePt: z.number().min(1).max(96).default(11),
  /** 覆盖区的最小面积（比例）：细到看不见的框多半是拖拽出错，拒掉比画上去好。 */
  minAreaRatio: z.number().min(0).max(1).default(0.0001),
});

export type PdfExportConfig = z.output<typeof pdfExportSchema>;

/** `saveAs` 的回执：产物路径 + 产物指纹 + 页数（界面据此提示"存好了"，见 plan §7.4）。 */
export interface PdfSaveAsReceipt {
  readonly outPath: string;
  /** 产物字节的 sha256。注意它**不等于**源文件哈希——源文件从头到尾没被写过（3.5-09）。 */
  readonly sha256: string;
  readonly pageCount: number;
}

/**
 * 另存腿的失败子原因（进 `AppError.details.code`）。
 * 覆盖区校验那几种复用 `OverlayRejection['code']` 的字面量，不另起一套说法。
 */
type SaveFailureCode =
  | 'out-path-not-absolute'
  | 'out-is-source'
  | OverlayRejection['code']
  | 'invalid-pdf'
  | 'encrypted'
  | 'empty'
  | 'draw-failed'
  | 'write-failed';

/**
 * 把覆盖区追加到既有 PDF 上并存成新文件。
 */
export class PdfExportService extends Service {
  static provide = 'pdf.export';
  static Config = pdfExportSchema;

  constructor(
    ctx: Context,
    private readonly options: PdfExportConfig,
  ) {
    super(ctx, 'pdf.export');
  }

  [Service.init](): void {
    this.ctx.logger.info(
      `[pdf-edit] pdf.export 就绪，单次上限 ${String(this.options.maxOverlays)} 个覆盖区、默认字号 ${String(this.options.defaultTextSizePt)} pt（中文叠加腿按裁定⑧ 未落）`,
    );
  }

  /**
   * 另存一份带覆盖区的 PDF。
   * @param filePath 源文件的**绝对路径**（只读，本方法不打开它第二回、不写它一个字节）
   * @param overlays 渲染层 draft 里的覆盖区（不可信输入：越界、超量、非拉丁文字都在这里被挡下）
   * @param outPath 产物路径（**绝对**，且不许等于源文件）
   * @returns 产物路径、产物 sha256 与页数
   * @throws `AppError('PDF_EDIT_SAVE_FAILED')`——上述任何一种失败；抛出时磁盘上没有 `<outPath>` 也没有 `<outPath>.part`
   */
  async saveAs(filePath: string, overlays: readonly PdfOverlayInput[], outPath: string): Promise<PdfSaveAsReceipt> {
    // 先判"别把产物写到源文件上"，再去读文件：这条是 3.5-09 的第一道闸，代价只是一次字符串比较。
    if (!isAbsolute(outPath))
      throw this.failure('out-path-not-absolute', `产物路径必须是绝对路径：${outPath}`, outPath);
    if (resolve(outPath) === resolve(filePath)) {
      throw this.failure('out-is-source', `产物路径与源文件相同，轻编辑不允许就地改：${filePath}`, outPath);
    }

    const bytes = readBoundedFile(filePath, { maxBytes: this.options.maxBytes, code: 'PDF_EDIT_SAVE_FAILED' });
    const loaded = await PdfEditDocument.load(bytes);
    if (loaded.status === 'failed') {
      throw this.failure(
        loaded.reason === 'invalid' ? 'invalid-pdf' : loaded.reason,
        `这份文件没法拿来另存：${filePath}（${loaded.detail}）`,
        outPath,
        loaded.detail,
      );
    }

    const planned = planOverlays(overlays, loaded.document.pageMetrics(), {
      maxOverlays: this.options.maxOverlays,
      defaultTextSizePt: this.options.defaultTextSizePt,
      minAreaRatio: this.options.minAreaRatio,
    });
    if (!planned.ok) {
      throw this.failure(planned.code, `这些覆盖区没法画上去：${planned.detail}`, outPath, planned.detail);
    }

    // 绘制 + 生成合在一个 try 里：pdf-lib 在 `save()` 时才把内容流拼出来，
    // 任何一步抛错都必须在落盘之前，这样"失败不落半成品"不需要额外的清理逻辑。
    let product: Uint8Array;
    try {
      await loaded.document.applyOverlays(planned.overlays);
      product = await loaded.document.save();
    } catch (error) {
      throw this.failure(
        'draw-failed',
        `生成 PDF 失败，没有写出任何文件：${filePath}`,
        outPath,
        error instanceof Error ? error.message : String(error),
      );
    }

    // 字节全在内存里了才开始碰磁盘；`rename` 是这一步唯一的"可见"动作，之前 `<outPath>` 一直不存在。
    const partPath = `${outPath}.part`;
    try {
      await writeFile(partPath, product);
      await rename(partPath, outPath);
    } catch (error) {
      // `force: true`：`writeFile` 自己失败时 `part` 根本不存在，这里不该因为 ENOENT 再抛一次盖掉真原因。
      await rm(partPath, { force: true });
      throw this.failure(
        'write-failed',
        `没能写到 ${outPath}`,
        filePath,
        error instanceof Error ? error.message : String(error),
      );
    }

    return { outPath, sha256: sha256Hex(product), pageCount: loaded.document.pageCount };
  }

  /**
   * 构造本服务的失败：一个码 + 一句中文 + 子原因，界面只写一处分支。
   * @param code 子原因（见 `SaveFailureCode`）
   * @param message 可以直接显示给用户的一句话
   * @param outPath 用户要写入的位置（放进 `details`，便于排查"是不是路径给错了"）
   * @param detail 技术原文（只在 `details` 里，不进界面）
   * @returns 待抛出的 `AppError`
   */
  private failure(code: SaveFailureCode, message: string, outPath: string, detail?: string): AppError {
    return new AppError(
      'PDF_EDIT_SAVE_FAILED',
      message,
      'pdf.export.saveAs',
      detail === undefined ? { code, outPath } : { code, outPath, detail },
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'pdf.export': PdfExportService;
  }
}
