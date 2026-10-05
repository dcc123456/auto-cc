/**
 * `pdf.io` 服务（plan §7.4 的第一条口，spec 3.4-03 / 3.5-01 的打开半边）：
 * 用户键入的绝对路径 → 受字节上限约束的读取 → 装载 → 页数与每页宽高。
 *
 * 为什么渲染层只能给路径而不是文件本身：sandbox + contextIsolation 下渲染层没有读文件的通道，
 * 也没有 `showOpenDialog`（§8.1/§8.2，与 4.1 的导入腿同一口径，见 plan §7.1 的最后一条选型）。
 *
 * 本服务**不建表、不占迁移号段**（plan §7.1 的存储行）：编辑会话只活在一次操作里，产物是新文件，
 * 没有「跨重启还在」的状态要存——所以摘掉 `cordis.yml` 里这一行只是打不开文件，不会留下半截记录。
 * 3.5-a 到此为止：叠加内容与另存新文件在 3.5-b（`pdf.edit` / `pdf.export`），页面增删与撤销在 3.5-c。
 */
import { AppError, Service, type Context } from '@auto-cc/core';
import { readBoundedFile } from '@auto-cc/core/file-read';
import { z } from 'zod';
import { PdfEditDocument, type PdfPageMetric } from './pdf-document.js';

/** `pdf.io` 的可调项。 */
export const pdfIoSchema = z.strictObject({
  /**
   * 单次打开的字节上限。与 `resume.parse` 同量级（简历 PDF 就是这个尺寸区间），
   * 显式写在装配清单里而不是藏在代码默认值里，是为了让「误选了一份大文件」能在装配面板现场改小演示。
   */
  maxBytes: z.number().int().min(1024).max(52_428_800).default(5_242_880),
});

export type PdfIoConfig = z.output<typeof pdfIoSchema>;

/** `open` 的回执：来源哈希 + 页数 + 每页宽高（界面据此画页面列表与线框，见 plan §7.5）。 */
export interface PdfOpenReceipt {
  /** 源文件的 sha256（3.5-09 断言「另存之后源文件仍是这一份」的基准）。 */
  readonly sourceHash: string;
  readonly pageCount: number;
  readonly pages: readonly PdfPageMetric[];
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
      `[pdf-edit] pdf.io 就绪，单次打开上限 ${String(this.options.maxBytes)} 字节（3.5-a 只有装载腿，叠加与另存在 3.5-b）`,
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
      pageCount: loaded.document.pageCount,
      pages: loaded.document.pageMetrics(),
    };
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
