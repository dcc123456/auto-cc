export { CdpSession, listTargets, type CdpTarget, type TargetSpec } from './cdp.js';
export { decodePng, type Raster } from './png.js';
// 最小 PNG 编码器（造插图夹具用；CRC 按规范算，产物是"任何解码器都读得懂的 PNG"）。
export { encodePng, gradientRgba } from './png-fixtures.js';
export { diffPng, type DiffBox, type DiffReport } from './diff.js';
export { archiveEvidence, evidenceName, SPEC_ID_PATTERN, type ArchivedFile } from './evidence.js';
export {
  minimalEncryptedPdf,
  minimalMultiPagePdf,
  minimalPdf,
  styledResumePdf,
  STYLED_PDF_BAND,
  STYLED_PDF_RULE,
  STYLED_PDF_RUNS,
  type StyledPdfExpectation,
} from './pdf-fixture.js';
export { pdfContentText } from './pdf-inspect.js';
