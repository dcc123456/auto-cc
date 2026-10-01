/**
 * 文档 diff（spec 3.1-06）：条目级增删改 + 字段级变化，可驱动 3.7 的 diff 界面。
 *
 * 对齐靠稳定 id 而不是位置：区块按 `section.id`、条目按 `entry.id`、字段按 `field.key` 配对。
 * 这样 normalize 重排了字段顺序（3.1-05）也不会被误报成「删了又加」——只有内容真的变了才进 diff。
 * 比对前两侧都先归一化，diff 因此只反映语义差异。
 */
import type { Entry, Field, ResumeDocument, Section } from './model.js';
import { normalizeDocument } from './normalize.js';

/** 变更类型。 */
export type ChangeType = 'added' | 'removed' | 'modified';

/** 字段级变化：某个 key 的值从 before→after（added 时 before=null，removed 时 after=null）。 */
export interface FieldChange {
  key: string;
  change: ChangeType;
  before: string | null;
  after: string | null;
  /** 该字段是否事实锁定（diff 界面据此把篡改高亮成待确认，接 3.1-03）。 */
  locked: boolean;
}

/** 条目级变化：带该条目内部的字段变化列表（added/removed 时字段整块标同类型）。 */
export interface EntryChange {
  entryId: string;
  change: ChangeType;
  fields: FieldChange[];
}

/** 区块级变化：带该区块内的条目变化列表。 */
export interface SectionChange {
  sectionId: string;
  kind: Section['kind'];
  change: ChangeType;
  entries: EntryChange[];
}

/** diff 结果：只列出**有变化**的区块 / 条目 / 字段，无变化的不出现。 */
export interface DocDiff {
  sections: SectionChange[];
  /** 是否有任何变化（界面上的「无差异」态直接读这个，不必自己数）。 */
  isEmpty: boolean;
}

/** 取字段值；缺省返回 null。 */
function valueOf(entry: Entry | undefined, key: string): string | null {
  return entry?.fields.find((field) => field.key === key)?.value ?? null;
}

/** 取字段是否锁定；缺省 false。 */
function lockedOf(entry: Entry | undefined, key: string): boolean {
  return entry?.fields.find((field) => field.key === key)?.locked ?? false;
}

/** 列出该条目涉及的所有字段键（两侧并集，去重后按字典序，保证 diff 稳定）。 */
function fieldKeys(entry: Entry | undefined): string[] {
  return [...new Set(entry?.fields.map((field) => field.key) ?? [])].sort((a, b) => a.localeCompare(b));
}

/** 比对同一 id 的两个条目，产出字段级变化；全等返回 null（该条目无改动）。 */
function diffEntry(before: Entry | undefined, after: Entry | undefined): EntryChange | null {
  const keys = [...new Set([...fieldKeys(before), ...fieldKeys(after)])].sort((a, b) => a.localeCompare(b));
  const changes: FieldChange[] = [];
  for (const key of keys) {
    const b = valueOf(before, key);
    const a = valueOf(after, key);
    if (b === a) continue;
    const change: ChangeType = b === null ? 'added' : a === null ? 'removed' : 'modified';
    changes.push({ key, change, before: b, after: a, locked: lockedOf(after, key) || lockedOf(before, key) });
  }
  if (changes.length === 0 && before && after) return null;
  const entryId = after?.id ?? before?.id ?? '';
  // 整条目新增 / 删除：把它所有字段按 added/removed 标出。
  if (!before || !after) return { entryId, change: before ? 'removed' : 'added', fields: changes };
  return { entryId, change: 'modified', fields: changes };
}

/** 比对同一 id 的两个区块，产出条目级变化。 */
function diffSection(before: Section | undefined, after: Section | undefined): SectionChange | null {
  const beforeEntries = new Map<string, Entry>((before?.entries ?? []).map((entry) => [entry.id, entry]));
  const afterEntries = new Map<string, Entry>((after?.entries ?? []).map((entry) => [entry.id, entry]));
  const ids = [...new Set([...beforeEntries.keys(), ...afterEntries.keys()])];
  const entryChanges: EntryChange[] = [];
  for (const id of ids) {
    const change = diffEntry(beforeEntries.get(id), afterEntries.get(id));
    if (change) entryChanges.push(change);
  }
  if (before && after && entryChanges.length === 0) return null;
  const sectionId = after?.id ?? before?.id ?? '';
  const kind = (after ?? before)?.kind ?? 'summary';
  if (!before || !after) {
    // 整区块增删：其下每个条目按 added/removed 列出。
    const present = after ?? before;
    const type: ChangeType = after ? 'added' : 'removed';
    const synthesized: EntryChange[] = (present?.entries ?? []).map((entry) => ({
      entryId: entry.id,
      change: type,
      fields: entry.fields.map((field: Field) => ({
        key: field.key,
        change: type,
        before: type === 'added' ? null : field.value,
        after: type === 'added' ? field.value : null,
        locked: field.locked,
      })),
    }));
    return { sectionId, kind, change: type, entries: synthesized };
  }
  return { sectionId, kind, change: 'modified', entries: entryChanges };
}

/**
 * 计算两份简历文档的差异。
 * @param a 基线文档
 * @param b 对照文档
 * @returns 只含有变化部分的结构化 diff；两侧先各自归一化，故与字段顺序 / 空白无关
 */
export function diff(a: ResumeDocument, b: ResumeDocument): DocDiff {
  const left = normalizeDocument(a);
  const right = normalizeDocument(b);
  const beforeSections = new Map<string, Section>(left.sections.map((section) => [section.id, section]));
  const afterSections = new Map<string, Section>(right.sections.map((section) => [section.id, section]));
  const ids = [...new Set([...beforeSections.keys(), ...afterSections.keys()])];
  const sections: SectionChange[] = [];
  for (const id of ids) {
    const change = diffSection(beforeSections.get(id), afterSections.get(id));
    if (change) sections.push(change);
  }
  return { sections, isEmpty: sections.length === 0 };
}
