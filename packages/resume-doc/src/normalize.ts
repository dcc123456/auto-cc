/**
 * 归一化与内容 hash（spec 3.1-05）。
 *
 * 归一化的目的不是美化，而是让「同一份内容」无论字段以什么顺序、带不带首尾空白、可选值是 null
 * 还是缺省，都能得到**字节一致**的规范形——这样 diff（3.1-06）比对的是内容而非键序，
 * 快照（3.7）能拿 hash 判断「这次导出到底改没改内容」。幂等性是这条链的地基：
 * normalize(normalize(x)) 必须与 normalize(x) 逐字节相等（3.1-05 断言两次 hash 相等）。
 */
import { createHash } from 'node:crypto';
import type { DocumentDesign, Entry, Field, ParagraphStyle, ResumeDocument, Section, SectionKind } from './model.js';

/** 段落样式的规范键序：界面按它列行，hash 也按它排，两处不再各定一次顺序。
 * `internal/design-slots.ts` 的六条轴按这份名单逐一 `key` 绑定，于是"规范序"与"CSS 槽位"永远是同一批轴。 */
export const PARAGRAPH_KIND_ORDER: readonly SectionKind[] = [
  'summary',
  'experience',
  'education',
  'skills',
  'project',
  'campus',
];

/** 一条段落样式里全部可设的轴（模型层的字段名；顺序即规范序）。 */
export type ParagraphStyleKey = 'sizePt' | 'weight' | 'align' | 'lineHeight' | 'inkHex' | 'backdropHex';

/** 段落样式的规范轴序：`canonicalParagraphStyle` 按它落键，`JSON.stringify` 的结果才确定。 */
export const PARAGRAPH_STYLE_KEYS: readonly ParagraphStyleKey[] = [
  'sizePt',
  'weight',
  'align',
  'lineHeight',
  'inkHex',
  'backdropHex',
];

/**
 * 把一条段落样式重建成规范形：按固定轴序落键、颜色转小写、空轴（undefined）整个键不出现。
 * @param style 用户给的那一档（可能只设了一条轴）
 * @returns 规范形；一条轴都没有时返回 null（调用方据此把这一格整个丢掉）
 */
function canonicalParagraphStyle(style: ParagraphStyle): ParagraphStyle | null {
  const out: Partial<Record<ParagraphStyleKey, string | number>> = {};
  for (const key of PARAGRAPH_STYLE_KEYS) {
    const value = style[key];
    if (value === undefined) continue;
    out[key] = typeof value === 'string' && value.startsWith('#') ? value.toLowerCase() : value;
  }
  return Object.keys(out).length === 0 ? null : (out as ParagraphStyle);
}

/**
 * 把文档主题重建成规范形（spec 6.6-01 的"可 diff、可 hash"半边）。
 * 三条规范：颜色一律小写；段落按 `PARAGRAPH_KIND_ORDER` 排；**空壳一律不出现**
 * （`{}`、只有空 body、只有空 paragraphs 都算空壳）——否则"没设样式"会因键序不同而算出两个 hash。
 * @param design 文档里的主题（可缺省）
 * @returns 规范形主题；整块为空时返回 undefined（于是 `layout` 上根本不出现这个键）
 */
function canonicalDesign(design: DocumentDesign | undefined): DocumentDesign | undefined {
  if (!design) return undefined;
  const out: DocumentDesign = {};
  if (design.inkHex !== undefined) out.inkHex = design.inkHex.toLowerCase();
  if (design.paperHex !== undefined) out.paperHex = design.paperHex.toLowerCase();
  if (design.accentHex !== undefined) out.accentHex = design.accentHex.toLowerCase();
  const body = design.body;
  if (body && (body.fontFamily !== undefined || body.sizePt !== undefined || body.weight !== undefined)) {
    out.body = {
      ...(body.fontFamily === undefined ? {} : { fontFamily: body.fontFamily }),
      ...(body.sizePt === undefined ? {} : { sizePt: body.sizePt }),
      ...(body.weight === undefined ? {} : { weight: body.weight }),
    };
  }
  const paragraphs: Partial<Record<SectionKind, ParagraphStyle>> = {};
  let hasParagraph = false;
  for (const kind of PARAGRAPH_KIND_ORDER) {
    const style = canonicalParagraphStyle(design.paragraphs?.[kind] ?? {});
    if (!style) continue;
    paragraphs[kind] = style;
    hasParagraph = true;
  }
  if (hasParagraph) out.paragraphs = paragraphs;
  return Object.keys(out).length === 0 ? undefined : out;
}

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
  const design = canonicalDesign(doc.layout.design);
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
      ...(design === undefined ? {} : { design }),
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
