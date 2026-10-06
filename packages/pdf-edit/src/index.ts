/**
 * `@auto-cc/plugin-pdf-edit` 对外出口（AGENTS.md §4.2：`src/index.ts` 是唯一门面）。
 *
 * 轻编辑（降级路线，plan §7）的引擎腿：把**用户手里那份 PDF** 读进来、量出每页、再写出一份新 PDF。
 * 本包不认识 Electron、不建表、不碰生成轨的文档模型（plan §7.3 的依赖方向：禁止 import `resume-doc`）。
 * 3.5-a 交付装载与另存，3.5-b 前半（裁定⑧）交付覆盖区叠加，3.5-c 前半交付页序（增删/重排），
 * 3.5-c 后半交付编辑会话（覆盖区增删改 + 页序 + 撤销重做，纯内存模型）；3.5-d 交付文本块线框（`pdf.layout`）；
 * 中文腿随字体资产再落。
 */
export { PdfEditDocument, type PdfLoadFailure, type PdfLoadOutcome, type PdfPageMetric } from './pdf-document.js';
export { PdfIoService, pdfIoSchema, type PdfIoConfig, type PdfOpenReceipt } from './io-service.js';
export { PdfExportService, pdfExportSchema, type PdfExportConfig, type PdfSaveAsReceipt } from './export-service.js';
export {
  PdfLayoutService,
  pdfLayoutSchema,
  type PdfLayoutConfig,
  type PdfTextBox,
  type PdfTextItemsReading,
} from './layout-service.js';
export { textItemRect, type PdfTextItemSlice } from './text-layout.js';
export {
  createPdfEditSession,
  type PdfEditDraft,
  type PdfEditSession,
  type PdfEditSessionLimits,
  type PdfEditSessionOptions,
} from './edit-session.js';
export { isIdentityOrder, planPageOrder, type PageOrderRejection, type PagePlanOutcome } from './page-ops.js';
export {
  isLatinOnly,
  planOverlays,
  toPageRect,
  type OverlayLimits,
  type OverlayPlanOutcome,
  type OverlayRejection,
  type PdfOverlayInput,
  type PdfOverlayRect,
  type PlannedOverlay,
} from './overlay-writer.js';
