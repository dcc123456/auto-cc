/**
 * `@auto-cc/plugin-resume-doc` 对外出口（AGENTS.md §4.2：`src/index.ts` 是唯一门面）。
 *
 * P3 生成轨的地基包：简历文档模型 + Schema + 归一化/hash + diff + 容错导入 + 落库服务 + 模板渲染（纯函数）。
 * 本包**不认识**打印 / 导出（那是 3.3 的活）——模板只交出「一份合法简历渲染成什么 HTML」，不碰 printToPDF、不落地字体子集。
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
  validateDocument,
  type FactViolation,
  type ReadableIssue,
  type ValidateResult,
} from './schema.js';
export { contentHash, normalizeDocument } from './normalize.js';
export { diff, type ChangeType, type DocDiff, type EntryChange, type FieldChange, type SectionChange } from './diff.js';
export { importExternal, type ImportResult, type ImportWarning } from './import.js';
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
