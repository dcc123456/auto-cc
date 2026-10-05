/**
 * `@auto-cc/plugin-pdf-edit` 对外出口（AGENTS.md §4.2：`src/index.ts` 是唯一门面）。
 *
 * 轻编辑（降级路线，plan §7）的引擎腿：把**用户手里那份 PDF** 读进来、量出每页、再写出一份新 PDF。
 * 本包不认识 Electron、不建表、不碰生成轨的文档模型（plan §7.3 的依赖方向：禁止 import `resume-doc`）。
 * 3.5-a 交付装载与另存，3.5-b 前半（裁定⑧）交付覆盖区叠加；整页操作与撤销在 3.5-c，中文腿随字体资产再落。
 */
export { PdfEditDocument, type PdfLoadFailure, type PdfLoadOutcome, type PdfPageMetric } from './pdf-document.js';
export { PdfIoService, pdfIoSchema, type PdfIoConfig, type PdfOpenReceipt } from './io-service.js';
export { PdfExportService, pdfExportSchema, type PdfExportConfig, type PdfSaveAsReceipt } from './export-service.js';
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
