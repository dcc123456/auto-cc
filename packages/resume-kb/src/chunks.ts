/**
 * 检索切片的派生规则（spec 4.3-11，plan §4.3 切片拆分的 4.3-a）。
 *
 * 纯函数：不认识 cordis、也不碰 SQLite，与 `entities.ts` 同构——「哪段文本变成一个可检索单元」
 * 因此能离线逐条断言，落库与事务收敛全在 `profile-service.ts`。
 *
 * **粒度 = 可引用粒度**（4.3-11 的判据）：只有两种切法，都没有滑窗。
 * - `entity`：一条知识库实体一条切片，`chunkId` 直接取 `entityId`——检索命中即引用，
 *   不需要「这段文字落在哪条实体的第几个窗口」这种二次映射（4.5 的事实锁定要靠它）。
 * - `section`：`summary / education / campus` 这三类**裁定二明确不建实体行**的区块，
 *   按区块内的 entry 一条一切片。`entities.ts` 头部注释把这三类的检索归属许给了 4.3-11，
 *   补不上它们就等于「简历里这三段永远检索不到」，那是能力缺口而不是简化。
 *
 * `tokens` 是**写入侧预分词**的结果（plan §4.3 预分词小节的口径 2）：内置 SQLite 没有 bigram tokenizer，
 * `trigram` 对两字查询恒不命中，所以把正文切成双字 token 再以空格连接入库，查询侧同一把尺子切，
 * `unicode61` 就能按空白切开——等价于自建 bigram 倒排，且零新依赖。
 */
import { createHash } from 'node:crypto';
import type { ResumeDocument, SectionKind } from '@auto-cc/plugin-resume-doc';
import { evidenceTextOf } from './evidence.js';
import { normalizeText, tokenSequence } from './tokenize.js';

/** 切片的两种来源，顺序即 `kb_chunks.chunk_kind` 的 CHECK 约束取值。 */
export const KB_CHUNK_KINDS = ['entity', 'section'] as const;

/** 切片来源种类。 */
export type KbChunkKind = (typeof KB_CHUNK_KINDS)[number];

/** 不建实体行、只能按区块级切片索引的三类区块（与 `entities.ts` 的裁定二互补）。 */
export const KB_SECTION_CHUNK_KINDS: readonly SectionKind[] = ['summary', 'education', 'campus'];

/** 派生出的一条切片（尚未落库的形态）。 */
export interface KbChunkDraft {
  /** 稳定 id：实体级等于 `entityId`，区块级由「文档 + 区块种类 + 条目槽位」复算，重复派生必然相同。 */
  readonly chunkId: string;
  readonly chunkKind: KbChunkKind;
  /** 来源简历文档 id；手工实体与它无关，为 `null`（同步按这一列清理区块级切片）。 */
  readonly sourceDocId: string | null;
  /** 仅区块级切片有值，界面据此说明「这段来自哪个区块」。 */
  readonly sectionKind: SectionKind | null;
  /** 参与排序与展示的原文（与 4.2-03 的反查文本同一口径：键排序后拼接）。 */
  readonly text: string;
  /** 写入侧预分词结果，交给 4.3-b 的 FTS5 虚表索引。 */
  readonly tokens: string;
  /** 归一化后的原文（NFKC + 小写），4.3-b 的**子串兜底通道**在这一列上做 `instr`（口径与理由见 `normalizeText`）。 */
  readonly normText: string;
}

/**
 * 正文 → 预分词串。
 * @param text 切片原文
 * @returns 以空格连接的有序 token（含重复，`tokenSequence` 的注释里记着为什么不能去重）；
 *          切不出 token 时返回空串——这条切片仍然入库，只是永远检索不到（保持与实体的 1:1，
 *          比「有的实体有切片、有的没有」这种要靠调用方记住的规则简单）
 */
export function indexTokens(text: string): string {
  return tokenSequence(text).join(' ');
}

/**
 * 一条实体 → 一条切片。
 * @param entity 已落库或即将落库的实体（只需要 id / 来源 / 载荷三项）
 * @returns 切片草案；`chunkId` 就是 `entityId`，命中即可直接引用实体
 */
export function entityChunkOf(entity: {
  entityId: string;
  sourceDocId: string | null;
  payload: Readonly<Record<string, string>>;
}): KbChunkDraft {
  const text = evidenceTextOf(entity.payload);
  return {
    chunkId: entity.entityId,
    chunkKind: 'entity',
    sourceDocId: entity.sourceDocId,
    sectionKind: null,
    text,
    tokens: indexTokens(text),
    normText: normalizeText(text),
  };
}

/**
 * 区块级切片的稳定 id。
 *
 * 与 `entities.ts` 的 `entityIdOf` 同一形态（`前缀 + sha256 前 16 位`），三段输入都是确定量，
 * 所以同一份文档重复同步必然落回同一行，不会出现「每次同步切片全换一遍 id」。
 * @param sourceDocId 来源文档 id
 * @param sectionKind 区块种类
 * @param entryId 条目槽位（P3.1 文档模型自己的 entry id）
 * @returns `kbs-` + 16 位十六进制
 */
function sectionChunkId(sourceDocId: string, sectionKind: SectionKind, entryId: string): string {
  const digest = createHash('sha256').update(`${sourceDocId}\u0001${sectionKind}\u0001${entryId}`).digest('hex');
  return `kbs-${digest.slice(0, 16)}`;
}

/**
 * 由一份简历文档派生区块级切片（spec 4.3-11 里「按实体自然分层」之外的另一半）。
 * @param document 已通过 P3.1 校验的简历文档
 * @returns 只含 `summary / education / campus` 三类区块内 entry 的切片，顺序为文档里的区块顺序与条目顺序；
 *          这三类区块不存在时返回空数组，不报错（缺失区块本来就要能正常渲染，见 3.1-04）
 */
export function deriveSectionChunks(document: ResumeDocument): readonly KbChunkDraft[] {
  const drafts: KbChunkDraft[] = [];
  for (const section of document.sections) {
    if (!KB_SECTION_CHUNK_KINDS.includes(section.kind)) continue;
    for (const entry of section.entries) {
      const payload: Record<string, string> = {};
      for (const field of entry.fields) payload[field.key] = field.value;
      const text = evidenceTextOf(payload);
      drafts.push({
        chunkId: sectionChunkId(document.id, section.kind, entry.id),
        chunkKind: 'section',
        sourceDocId: document.id,
        sectionKind: section.kind,
        text,
        tokens: indexTokens(text),
        normText: normalizeText(text),
      });
    }
  }
  return drafts;
}

/** 一行的切片读数（`payload` 已经是拼好的 `text`，不再二次展开）。 */
export interface KbChunkView {
  readonly chunkId: string;
  readonly chunkKind: KbChunkKind;
  readonly sourceDocId: string | null;
  readonly sectionKind: SectionKind | null;
  readonly text: string;
  readonly tokens: string;
  /** 归一化原文；检索的子串通道在这一列上匹配，读数带它是为了让单测能直接断言「库里这一列确实归过一」。 */
  readonly normText: string;
  readonly updatedAt: number;
}

/** 切片行 → 读数。`chunkKind` 的窄化是有意的：写入只有 `entityChunkOf` 与 `deriveSectionChunks` 两条路。 */
export function chunkViewOf(row: {
  readonly chunk_id: string;
  readonly chunk_kind: string;
  readonly source_doc_id: string | null;
  readonly section_kind: string | null;
  readonly text: string;
  readonly tokens: string;
  readonly norm_text: string;
  readonly updated_at: number | bigint;
}): KbChunkView {
  return {
    chunkId: row.chunk_id,
    chunkKind: row.chunk_kind as KbChunkKind,
    sourceDocId: row.source_doc_id,
    sectionKind: row.section_kind as SectionKind | null,
    text: row.text,
    tokens: row.tokens,
    normText: row.norm_text,
    updatedAt: Number(row.updated_at),
  };
}
