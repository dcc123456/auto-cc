/**
 * `pdf.io` 服务（plan §7.4 的第一条口，spec 3.4-03 / 3.5-01 的打开半边）：
 * 用户键入的绝对路径 → 受字节上限约束的读取 → 装载 → 页数与每页宽高。
 *
 * 为什么渲染层只能给路径而不是文件本身：sandbox + contextIsolation 下渲染层没有读文件的通道，
 * 也没有 `showOpenDialog`（§8.1/§8.2，与 4.1 的导入通道同一口径，见 plan §7.1 的最后一条选型）。
 *
 * 本服务**不建表、不占迁移号段**（plan §7.1 的存储行）：编辑会话只活在一次操作里，产物是新文件，
 * 没有「跨重启还在」的状态要存——所以摘掉 `cordis.yml` 里这一行只是打不开文件，不会留下半截记录。
 * 3.5-a 到此为止：叠加内容与另存新文件在 3.5-b（`pdf.edit` / `pdf.export`），页面增删与撤销在 3.5-c。
 */
import { AppError, Service, type Context } from '@auto-cc/core';
import { readBoundedFile } from '@auto-cc/core/file-read';
import { z } from 'zod';
import { sniffImageMagic } from './object-model.js';
import { PdfEditDocument, type PdfPageMetric } from './pdf-document.js';

/** `pdf.io` 的可调项。 */
export const pdfIoSchema = z.strictObject({
  /**
   * 单次打开的字节上限。与 `resume.parse` 同量级（简历 PDF 就是这个尺寸区间），
   * 显式写在装配清单里而不是藏在代码默认值里，是为了让「误选了一份大文件」能在装配面板现场改小演示。
   */
  maxBytes: z.number().int().min(1024).max(52_428_800).default(5_242_880),
  /**
   * 单张插图的字节上限（WPS 形态编辑器：渲染层拖入图片前要先拿字节画预览）。
   * 与 `pdf.export` 另存侧的 `maxImageBytes` 同一档默认值——预览读得进、另存也读得进。
   */
  maxImageBytes: z.number().int().min(1024).max(31_457_280).default(10_485_760),
});

export type PdfIoConfig = z.output<typeof pdfIoSchema>;

/** `open` 的回执：来源哈希 + 页数 + 每页宽高（界面据此定纸栏的缩放与页号读数；真纸面的图像在渲染层画，见 3.5-12）。 */
export interface PdfOpenReceipt {
  /** 源文件的 sha256（3.5-09 断言「另存之后源文件仍是这一份」的基准）。 */
  readonly sourceHash: string;
  readonly pageCount: number;
  readonly pages: readonly PdfPageMetric[];
}

/** `imageBytes` 的回执：嗅探后的格式 + 字节（渲染层用同一份格式判据画预览，另存侧再读一次落盘）。 */
export interface PdfImageBytesReceipt {
  readonly format: 'png' | 'jpeg';
  readonly bytes: Uint8Array;
}

/**
 * 打开既有 PDF 的服务入口。
 */
export class PdfIoService extends Service {
  static provide = 'pdf.io';
  static Config = pdfIoSchema;

  constructor(
    ctx: Context,
    private readonly options: PdfIoConfig,
  ) {
    super(ctx, 'pdf.io');
  }

  [Service.init](): void {
    this.ctx.logger.info(
      `[pdf-edit] pdf.io 就绪，单次打开上限 ${String(this.options.maxBytes)} 字节（3.5-a 只有装载通道，叠加与另存在 3.5-b）`,
    );
  }

  /**
   * 打开一份 PDF 并只回度量读数。
   * @param filePath 用户给的**绝对路径**（渲染层没有读文件的通道，字节只在主进程侧落地）
   * @returns 页数与每页宽高；整页原文**不过进程边界**（plan §7.4 的边界约束）
   * @throws `AppError('PDF_EDIT_READ_FAILED')`——路径非法、读不出、超过上限、加密、结构损坏；
   *         `details.code` 给出是哪一种（`encrypted` / `invalid-pdf` / `empty`），界面据此给不同的话
   */
  async open(filePath: string): Promise<PdfOpenReceipt> {
    const bytes = readBoundedFile(filePath, { maxBytes: this.options.maxBytes, code: 'PDF_EDIT_READ_FAILED' });
    const loaded = await PdfEditDocument.load(bytes);
    if (loaded.status === 'failed') {
      throw new AppError('PDF_EDIT_READ_FAILED', openFailureMessage(loaded.reason, filePath), 'pdf.io.open', {
        code: loaded.reason === 'invalid' ? 'invalid-pdf' : loaded.reason,
        detail: loaded.detail,
        filePath,
      });
    }
    return {
      sourceHash: loaded.sourceHash,
      // 打开的是源文件，所以回执报的是源档页数与源档逐页度量（还没排过页）。
      pageCount: loaded.document.sourcePageCount,
      pages: loaded.document.sourcePageMetrics(),
    };
  }

  /**
   * 按同一份字节上限把整份 PDF 交给渲染层（spec 3.5-12 的真纸面：位图与文本层都在渲染层算）。
   *
   * 为什么这条口是必要的而不是"再多开一条读文件通道"：渲染层在 sandbox 下没有文件系统
   *（§8.1），而 pdf.js 要把页面画成真实图像就必须拿到字节。字节上限沿用 `open` 那一支 `maxBytes`，
   * 不在这里另立第二档尺度（§2.5：两处上限迟早漂）。本机实测 1MB 一次往返约 2ms、5MB 约 4ms，
   * 所以不分块、不做缓存（plan §10.4）。
   * @param filePath 用户给的**绝对路径**（与 `open` 同一口径，路径不过界的是"谁来读"）
   * @returns 整份文件的字节；一次调用一份，渲染层装载完交给 pdf.js
   * @throws `AppError('PDF_EDIT_READ_FAILED')`——路径非法、读不出或超过上限；处置与 `open` 完全相同，故共用一支码
   */
  bytes(filePath: string): Uint8Array {
    return readBoundedFile(filePath, { maxBytes: this.options.maxBytes, code: 'PDF_EDIT_READ_FAILED' });
  }

  /**
   * 按插图字节上限读出一张 PNG/JPEG 图片（WPS 形态编辑器的图片工具：渲染层 sandbox 下读不了文件）。
   *
   * 字节只用于**画预览**；另存时主进程按对象里的路径再读一次（`pdf.export.saveEditor`），
   * 不让大字节数组在一次另存的参数里随对象过第二次界。
   * @param filePath 用户经文件选择器选定的**绝对路径**
   * @returns 魔数嗅探到的格式 + 图片字节
   * @throws `AppError('PDF_EDIT_READ_FAILED')`——路径非法、读不出、超过 `maxImageBytes`；
   *         文件头不是 PNG/JPEG 时 `details.code` 为 `not-image`
   */
  imageBytes(filePath: string): PdfImageBytesReceipt {
    const bytes = readBoundedFile(filePath, {
      maxBytes: this.options.maxImageBytes,
      code: 'PDF_EDIT_READ_FAILED',
    });
    const format = sniffImageMagic(bytes);
    if (format === undefined) {
      throw new AppError(
        'PDF_EDIT_READ_FAILED',
        `只支持 PNG 与 JPEG 图片，这份文件不是：${filePath}`,
        'pdf.io.imageBytes',
        { code: 'not-image', filePath },
      );
    }
    return { format, bytes };
  }
}

/**
 * 三种装载失败的中文提示。
 * @param reason 失败种类
 * @param filePath 出错的路径（只回显，不读第二遍）
 * @returns 一句可以直接显示给用户的话
 */
function openFailureMessage(reason: 'empty' | 'encrypted' | 'invalid', filePath: string): string {
  if (reason === 'empty') return `这份文件是空的，打不开：${filePath}`;
  if (reason === 'encrypted') return `这份 PDF 是加密的，轻编辑不支持加密文件：${filePath}`;
  return `这份文件不是一份合法的 PDF：${filePath}`;
}

declare module '@auto-cc/core' {
  interface AppServices {
    'pdf.io': PdfIoService;
  }
}
