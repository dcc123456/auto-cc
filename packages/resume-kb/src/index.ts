/**
 * `@auto-cc/plugin-resume-kb` 对外出口（AGENTS.md §4.2：`src/index.ts` 是唯一门面）。
 *
 * P4 的第一块地基：**简历文本 → P3.1 文档模型**的纯解析层（spec 4.1-02 / 4.1-03 / 4.1-04 / 4.1-05 / 4.1-09）。
 * 本包当前**不认识 cordis、不认识 SQLite**——解析规则要能离线、逐字段断言，装配成 `resume.parse` service
 * 与幂等入库（4.1-07 / 4.1-10）是下一片的事，届时只在 `src/` 里加一个 service 文件，不动这里的判定。
 * PDF / DOCX 的「字节 → 文本」两条腿（4.1-01）按 plan §1.1 的实测许可结论接 `pdfjs-dist`(Apache-2.0)
 * 与 `mammoth`(BSD-2-Clause)，同样落在下一片。
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
