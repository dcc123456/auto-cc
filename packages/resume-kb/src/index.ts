/**
 * `@auto-cc/plugin-resume-kb` 对外出口（AGENTS.md §4.2：`src/index.ts` 是唯一门面）。
 *
 * P4 的第一块地基：**简历文本 → P3.1 文档模型**的纯解析层（spec 4.1-02 / 4.1-03 / 4.1-04 / 4.1-05 / 4.1-09），
 * 以及它的两条依赖腿：**字节 → 文本**（spec 4.1-01，`pdfjs-dist` Apache-2.0 + `mammoth` BSD-2-Clause，
 * 许可与实测口径见 `docs/plans/04-resume-kb/plan.md` §1.1）。
 * `source.ts` / `sections.ts` / `period.ts` **不认识 cordis、也不打开自己的 SQLite 连接**——解析规则要能离线、
 * 逐字段断言；`parse-service.ts` 是本包唯一接触装配与入库（4.1-06 / 4.1-07 / 4.1-09 / 4.1-10）的文件，
 * 且入库只经 1.3 的共享 `store` 连接，判定的那三个纯函数文件不因装配而变脏。
 */
export { extractPeriod, parsePeriod, type ParsedPeriod, type PeriodIssue, type PeriodPrecision } from './period.js';
export {
  MIN_TEXT_CHAR_COUNT,
  parseResumeText,
  periodText,
  type ParsedResumeText,
  type ParseIssue,
  type ParseIssueCode,
  type ParseTextResult,
  type RejectedResumeText,
} from './sections.js';
export {
  RESUME_IMPORT_MIGRATION_VERSION,
  ResumeParseService,
  resumeParseSchema,
  type ImportReceipt,
  type ImportStatus,
  type PendingImportView,
  type ResumeParseConfig,
} from './parse-service.js';
export {
  detectFormat,
  extractSourceText,
  parseResumeSource,
  sourceHashOf,
  type ExtractedSourceText,
  type FailedSourceText,
  type ResumeSourceFormat,
  type ResumeSourceResult,
  type SourceFailureCode,
  type SourceTextResult,
} from './source.js';
