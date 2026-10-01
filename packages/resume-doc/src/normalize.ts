/**
 * 归一化与内容 hash（spec 3.1-05）。
 *
 * 归一化的目的不是美化，而是让「同一份内容」无论字段以什么顺序、带不带首尾空白、可选值是 null
 * 还是缺省，都能得到**字节一致**的规范形——这样 diff（3.1-06）比对的是内容而非键序，
 * 快照（3.7）能拿 hash 判断「这次导出到底改没改内容」。幂等性是这条链的地基：
 * normalize(normalize(x)) 必须与 normalize(x) 逐字节相等（3.1-05 断言两次 hash 相等）。
 */
import { createHash } from 'node:crypto';
import type { Entry, Field, ResumeDocument, Section } from './model.js';

/** 键的规范顺序：字段对象按 key→value→locked→factKey 排，让 JSON.stringify 结果确定。 */
function canonicalField(field: Field): Field {
  return {
    key: field.key.trim(),
    value: field.value,
    locked: field.locked,
    factKey: field.factKey,
  };
}

/** 条目：id 规范 trim 后，字段按 key 字典序排（内容相同、顺序不同 → 归一后相同）。 */
function canonicalEntry(entry: Entry): Entry {
  return {
    id: entry.id.trim(),
    fields: [...entry.fields].map(canonicalField).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/** 区块：标题 trim，条目**保持原序**（条目顺序是用户意图，不排序）；空条目区块仍保留。 */
function canonicalSection(section: Section): Section {
  return {
    id: section.id.trim(),
    kind: section.kind,
    title: section.title.trim(),
    entries: section.entries.map(canonicalEntry),
  };
}

/**
 * 把文档归一化为规范形。
 * @param doc 任意合法简历文档（键序 / 空白 / 冗余可不规范）
 * @returns 规范化的新文档（不修改入参）；顶层字段以固定顺序重建，`updatedAt` 原样保留不参与内容 hash
 */
export function normalizeDocument(doc: ResumeDocument): ResumeDocument {
  return {
    id: doc.id.trim(),
    schemaVersion: doc.schemaVersion,
    profile: {
      name: doc.profile.name.trim(),
      contact: {
        email: doc.profile.contact.email?.trim() || null,
        phone: doc.profile.contact.phone?.trim() || null,
        location: doc.profile.contact.location?.trim() || null,
      },
    },
    layout: {
      pageSize: doc.layout.pageSize,
      margin: {
        topMm: doc.layout.margin.topMm,
        rightMm: doc.layout.margin.rightMm,
        bottomMm: doc.layout.margin.bottomMm,
        leftMm: doc.layout.margin.leftMm,
      },
      baseFontPt: doc.layout.baseFontPt,
      lineHeight: doc.layout.lineHeight,
      columns: doc.layout.columns,
    },
    sections: doc.sections.map(canonicalSection),
    metrics: { pages: doc.metrics.pages },
    updatedAt: doc.updatedAt,
  };
}

/** 内容 hash 覆盖的范围——**不含 `updatedAt`**：改了时间戳不该被算成改了内容。 */
type ContentSlice = Omit<ResumeDocument, 'updatedAt'>;

/**
 * 取文档的「内容切片」（去掉随时间变化的 `updatedAt`），用于稳定 hash。
 * @param doc 已归一化的文档
 * @returns 排除 `updatedAt` 的结构
 */
function contentSlice(doc: ResumeDocument): ContentSlice {
  return {
    id: doc.id,
    schemaVersion: doc.schemaVersion,
    profile: doc.profile,
    layout: doc.layout,
    sections: doc.sections,
    metrics: doc.metrics,
  };
}

/**
 * 计算文档内容 hash（sha256 十六进制）。
 *
 * 入参会先归一化，所以调用方不需要自己先 normalize；返回只取决于内容，与键序 / 空白无关。
 * @param doc 简历文档
 * @returns 64 位十六进制摘要
 */
export function contentHash(doc: ResumeDocument): string {
  const canonical = JSON.stringify(contentSlice(normalizeDocument(doc)));
  return createHash('sha256').update(canonical).digest('hex');
}
