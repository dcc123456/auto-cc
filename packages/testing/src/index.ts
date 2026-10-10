export { CdpSession, listTargets, type CdpTarget, type TargetSpec } from './cdp.js';
export { decodePng, type Raster } from './png.js';
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
