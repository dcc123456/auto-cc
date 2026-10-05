/**
 * `@auto-cc/plugin-resume-doc` 对外出口（AGENTS.md §4.2：`src/index.ts` 是唯一门面）。
 *
 * P3 生成轨的地基包：简历文档模型 + Schema + 归一化/hash + diff + 容错导入 + 落库服务 + 模板渲染（纯函数）+ 打印文档装配（纯函数）。
 * 本包**不认识 Electron**：打印层只交出「一份可直接喂给 `printToPDF` 的完整 HTML + 打印选项」与「对产物 Buffer 的结构读数」，
 * 真正调 `webContents.printToPDF` 的执行器落在 L1 `shell`（经依赖注入消费本层产物），见 plan §3.3 分层落点。
 */
export {
  createEmptyDocument,
  DEFAULT_LAYOUT,
  factKeyOf,
  makeField,
  RESUME_SCHEMA_VERSION,
  type Contact,
  type DocumentMetrics,
  type Entry,
  type FactKey,
  type Field,
  type Layout,
  type PageMargin,
  type PageSize,
  type Profile,
  type ResumeDocument,
  type Section,
  type SectionKind,
} from './model.js';
export {
  checkFactLock,
  documentSchema,
  FACT_VIOLATION_GATES,
  validateDocument,
  type FactViolation,
  type FactViolationGate,
  type ReadableIssue,
  type ValidateResult,
} from './schema.js';
export { contentHash, normalizeDocument } from './normalize.js';
export { diff, type ChangeType, type DocDiff, type EntryChange, type FieldChange, type SectionChange } from './diff.js';
export { importExternal, type ImportResult, type ImportWarning } from './import.js';
// 3.6-a 排版编辑器的模型腿：三条纯操作（唯一的判据入口）与一只编辑会话（历史走 core 那唯一一份栈）。
export {
  EDITOR_METRIC_BOUNDS,
  planEntryMove,
  planMetric,
  planSectionMove,
  type EditorOutcome,
  type EditorRejectionCode,
  type MetricBound,
  type MetricKey,
} from './editor-ops.js';
export {
  createResumeEditorSession,
  type ResumeEditorSession,
  type ResumeEditorSessionOptions,
} from './editor-session.js';
export {
  ResumeDocService,
  RESUME_DOC_MIGRATION_VERSION,
  type LoadResult,
  type ResumeDocConfig,
  type SaveResult,
} from './doc-store.js';
export {
  resumeTemplate,
  TemplateBindingError,
  type Template,
  type TemplateContext,
  type TemplateLocale,
  type TemplateOrigin,
} from './template.js';
export { resumePrint, type PdfInspection, type ResumePrintOptions, type ResumePrintRequest } from './print.js';
export {
  ResumeSnapshotService,
  RESUME_SNAPSHOT_MIGRATION_VERSION,
  type RestoreResult,
  type ResumeSnapshotConfig,
  type SnapshotMeta,
  type SnapshotReceipt,
} from './snapshot-store.js';
export { ResumeExportService, type ExportReceipt, type ResumeExportConfig } from './export-service.js';
