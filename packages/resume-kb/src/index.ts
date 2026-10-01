/**
 * `@auto-cc/plugin-resume-kb` 对外出口（AGENTS.md §4.2：`src/index.ts` 是唯一门面）。
 *
 * P4 的第一块地基：**简历文本 → P3.1 文档模型**的纯解析层（spec 4.1-02 / 4.1-03 / 4.1-04 / 4.1-05 / 4.1-09），
 * 以及它的两条依赖腿：**字节 → 文本**（spec 4.1-01，`pdfjs-dist` Apache-2.0 + `mammoth` BSD-2-Clause，
 * 许可与实测口径见 `docs/plans/04-resume-kb/plan.md` §1.1）。
 * `source.ts` / `sections.ts` / `period.ts` **不认识 cordis、也不打开自己的 SQLite 连接**——解析规则要能离线、
 * 逐字段断言；`parse-service.ts` 是本包唯一接触装配与入库（4.1-06 / 4.1-07 / 4.1-09 / 4.1-10）的文件，
 * 且入库只经 1.3 的共享 `store` 连接，判定的那三个纯函数文件不因装配而变脏。
 * 4.2 带来 `entities.ts`（实体派生）与 `evidence.ts`（反查打分），4.3-a 带来 `chunks.ts`（检索切片派生），
 * 4.3-b 带来 `search.ts`（切片 → 分数的合并排序）——
 * 同一个规矩：切分与派生是纯函数，落库与事务只在 `profile-service.ts`。
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
  KB_ENTITY_KINDS,
  deriveEntities,
  manualEntityId,
  payloadHashOf,
  type KbEntityDraft,
  type KbEntityKind,
} from './entities.js';
export {
  KB_PROFILE_MIGRATION_VERSION,
  KbProfileService,
  kbProfileSchema,
  type KbCreateInput,
  type KbEntityView,
  type KbExportResult,
  type KbImportMode,
  type KbImportResult,
  type KbProfileConfig,
  type KbRemoveResult,
  type KbSyncResult,
} from './profile-service.js';
// 反查结果的形状（4.2-03）：`EvidenceRef` 是将来 `kb.profile.evidenceFor` 过 IPC 的返回体，
// 所以只导出形状；`rankEvidence` / `evidenceTextOf` 属包内纯函数，不对外（§2.4 不导出无人调用的入口）。
// 备份编解码（`backup.ts`，4.2-08）同样只在包内被 `exportBackup` / `importBackup` 调用，格式对外只以
// 「服务方法的入参出参」呈现，不把 JSON Schema 变成第二个公开面。
// 切片的**形状**（`KbChunkView`）跟着 `listChunks()` 的返回值一起对外；`chunks.ts` 里的派生函数
// （`entityChunkOf` / `deriveSectionChunks` / `indexTokens`）不外露——切片只能由本包的写入路径产生，
// 让外面自己算一份就是开第二条写路径（§2.5）。
export { type EvidenceReason, type EvidenceRef } from './evidence.js';
export { type KbChunkKind, type KbChunkView } from './chunks.js';
// 检索读数的**形状**（4.3-01 / 02）：`search()` 是 service 的公开方法，4.3-c 要把它过 IPC 给界面与 agent，
// 所以对外只给结果形状；`buildFtsQuery` / `rankChunks` / `tokensOf` 属包内纯函数，不外露——
// 让外面自己拼 FTS5 表达式就是开第二条检索通道（§2.5），而且会绕开转义那条安全约束。
export { type KbSearchHit, type KbSearchReason, type KbSearchResult, type KbSearchStatus } from './search.js';
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
