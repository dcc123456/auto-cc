/**
 * 生成轨「产物结构读数 + 打印装配门面」（spec 3.3-03 / 3.3-07 / 3.3-09 的可单测半边；纯函数，不含 Electron）。
 *
 * 分层：`webContents.printToPDF` 依赖 `WebContents`（归 L1 `shell`），L2 `resume-doc` 禁止反向依赖 L1，
 * 且本包不含 electron 依赖——故这里只**产出**「一份可直接喂给 printToPDF 的完整 HTML + 打印选项」
 * （装配细节在 `./internal/print-html.ts`，本文件保持无 HTML，符合 3.1-10 的模型门面约束），
 * 以及对 printToPDF 返回 Buffer 的**字节级结构读数**（页数 / 是否内嵌字体 / 是否有可搜索文本层）。
 * 真正调用内核打印、落 userData、拼字体目录 URL 的执行器落在 shell，经依赖注入消费本层产物。
 */
import { buildPrintHtml, toPrintRequest } from './internal/print-html.js';

export type { PrintRequest, PrintRequestOptions } from './internal/print-html.js';

/** printToPDF 返回 Buffer 的字节级结构读数（供页数回写与产物完整性断言）。 */
export interface PdfInspection {
  /** 是否具备 `%PDF-` 文件头。 */
  isPdf: boolean;
  /** 页面对象数量（`/Type /Page`，不含 `/Type /Pages`）。 */
  pageCount: number;
  /** 是否内嵌了字体程序（`/FontFile` 或 `/FontFile2/3`）——非纯位图、非系统字体依赖的证据。 */
  hasEmbeddedFont: boolean;
  /** 是否含 `ToUnicode` 映射——文字可被复制/搜索（非光栅化拼页）的证据。 */
  hasTextLayer: boolean;
  /** 产物字节长度。 */
  byteLength: number;
}

/**
 * 对 printToPDF 产物做**无第三方解析**的字节级结构读数。
 * 只读 PDF 明文结构（对象字典里的 `/Type`、`/FontFile`、`/ToUnicode` 关键字），足以支撑页数回写（3.3-09）
 * 与「内嵌字体 / 可搜索文本层」的机制级判定（3.3-05 / 3.3-07），且**不引入 pdf-lib/mupdf 等重依赖**
 * （PDF 引擎属编辑轨 3.4 的选型，生成轨不应提前把它拽进来，见 plan §4「不得自建第二套 PDF 解析」）。
 * @param pdf printToPDF 返回的 Buffer / Uint8Array
 * @returns 结构读数；非 PDF（缺 `%PDF-` 头）时各布尔为 false、pageCount 为 0
 */
export function inspectPdf(pdf: Uint8Array): PdfInspection {
  const latin = Buffer.from(pdf).toString('latin1');
  const isPdf = latin.startsWith('%PDF-');
  return {
    isPdf,
    pageCount: isPdf ? (latin.match(/\/Type\s*\/Page(?!s)/g) || []).length : 0,
    hasEmbeddedFont: /\/FontFile[23]?\b/.test(latin),
    hasTextLayer: /\/ToUnicode\b/.test(latin),
    byteLength: pdf.length,
  };
}

/** 生成轨打印装配的单一门面（与 `resumeTemplate` 同款收敛，避免平铺别名造成 §2.5「两处都能用」）。 */
export const resumePrint = { buildHtml: buildPrintHtml, toRequest: toPrintRequest, inspectPdf };
