/**
 * 按 JD 相关性重排区块与条目顺序（spec 4.5-02 的确定性半边，plan §4.5 判据一）。
 *
 * 顺序**不进模型**：让模型"顺便返回新顺序"会同时毁掉两件事——同一输入两次读数不一致
 * （4.4-07 已经判过这条），以及"重排依据可解释"变成模型的一句自述。界面要显示的是
 * 「这段被提前，因为它命中 JD 的 Kubernetes / 高并发」，这种依据只能来自代码手里的那份读数。
 *
 * 那份读数已经在 4.4 的输出里，本文件不新算任何分数（AGENTS.md §2.1 复用同一把尺子）：
 * `GapRequirementView.evidence` 带证据 id 与强度，`RequirementItem` 带被命中的 token。
 * 于是相关性分 = **它作为证据在报告里出现过的最大强度**；缺失项（evidence 恒为空）自然不影响任何分数。
 *
 * 三条设计（都不是风格偏好，是判据）：
 *
 * 1. **零分不动**：只有拿到证据的区块 / 条目参与提前，其余**保持基线原序**留在后段。
 *    这既避免把「教育背景」这类无实体区块随机搅动，也让"没有读数"与"读数最低"区分开；
 * 2. **依据随结果走**：每一个真正换了位置的对象都带一条 `ReorderBasis`（原下标 → 新下标 + 命中了哪几条要求）。
 *    被别人的提前挤到后面的零分对象同样在列，但它的 `hits` 为空、分数为 0——界面据此能说
 *    「它不是不相关，是没拿到据」，而不是假装它没动（4.5-02 的"引用命中项"落在这份结构上）；
 * 3. **纯函数且不改动入参**：返回的新数组里放的是同一批 `Section` / `Entry` 对象引用，
 *    本文件不改任何字段值——改写是 `generate-model.ts` 那条腿的事，两件事分开才能各自断言。
 *
 * 已知边界（写在 spec 的落地记录里，不假装没有）：`summary` 与 `education` 两个区块按 4.2 裁定二
 * **不产实体行**，因此在这里永远拿不到分、永远不被提前；它们的区块级切片是 4.4 学历比对的证据来源
 * （`origin === 'section_chunk'`），但那条证据回指的是切片而不是条目，映射不进文档位置。
 */
import type { ResumeDocument, Section } from '@auto-cc/plugin-resume-doc';
import type { KbEntityDraft } from './entities.js';
import type { GapRequirementView } from './requirements-compare.js';
import type { RequirementKind } from './requirements.js';

/** 一条重排依据里引用的一次命中（把 `RequirementItem` 的最小可读投影出来，界面直接拼文案）。 */
export interface ReorderHit {
  /** JD 里那条要求的代表词（来自受控词表或模型腿，不进本文件的判断）。 */
  readonly label: string;
  /** 四类之一，界面按类分组显示。 */
  readonly kind: RequirementKind;
  /** 该证据对这条要求的强度（0～1，来自 4.4 的同一把尺子）。 */
  readonly score: number;
  /** 命中的 token（升序）；年限与学历那两路是算术/档位判定，为空数组。 */
  readonly tokens: readonly string[];
}

/** 一个对象的位置变化与它的原因。 */
export interface ReorderBasis {
  /** 层级：区块之间换序，还是区块内的条目换序。 */
  readonly level: 'section' | 'entry';
  /** 换了位置的那个 id（区块 id 或条目 id，文档内唯一）。 */
  readonly id: string;
  /** 相关性分（= 它作为证据出现过的最大强度）；决定它排到哪儿的那个读数；被挤后的零分对象为 0。 */
  readonly score: number;
  /** 基线里的下标（条目层是它在本区块内的下标）。 */
  readonly fromIndex: number;
  /** 重排后的下标。 */
  readonly toIndex: number;
  /** 依据：它命中了 JD 的哪几条要求，按强度降序、平分按代表词字典序（两次运行同一份读数的必要条件）。 */
  readonly hits: readonly ReorderHit[];
}

/** 一次重排的读数。 */
export interface ReorderResult {
  /** 新区块序列（区块内的条目也已重排）；元素是入参里的同一批对象，未被复制。 */
  readonly sections: readonly Section[];
  /** 只含**真正换了位置**的对象；没动的不进这里，界面因此不会把"本来就在第一位"报成一次调整。 */
  readonly bases: readonly ReorderBasis[];
  /** 换过位的区块条数。 */
  readonly movedSections: number;
  /** 换过位的条目条数（跨区块合计）。 */
  readonly movedEntries: number;
}

/** 一个条目（或区块）的相关性读数。 */
interface Relevance {
  readonly score: number;
  readonly hits: readonly ReorderHit[];
}

/** 零分对象被挤后时的读数：没有依据可给，但位置确实变了，所以仍要出一条 basis。 */
const NO_RELEVANCE: Relevance = { score: 0, hits: [] };

/**
 * 把 hits 排成稳定序列：强度降序 → 代表词字典序 → 类别表次序。
 *
 * 平分时的次序必须由读数本身决定，不能依赖 `Map` 的插入顺序（不同 JD 拆出同样的分数时界面要给出同一份依据）。
 * @param hits 未排序的命中列表（可以含重复的「类别 + 代表词」）
 * @returns 去重并排好的序列
 */
function sortHits(hits: readonly ReorderHit[]): ReorderHit[] {
  const byKey = new Map<string, ReorderHit>();
  for (const hit of hits) {
    const key = `${hit.kind}\u0001${hit.label}`;
    const kept = byKey.get(key);
    // 同一条要求在同一条证据里只该出现一次；出现多次时留强度高的那次读数。
    if (kept === undefined || hit.score > kept.score) byKey.set(key, hit);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      right.score - left.score || left.label.localeCompare(right.label, 'zh-CN') || left.kind.localeCompare(right.kind),
  );
}

/**
 * 把缺口报告的三态行折算成「文档条目 → 相关性」。
 *
 * 证据 id 只有能在 `drafts` 里对上 `entryId` 的那部分才进结果：库里的手工实体（`entryId === null`）、
 * 别份简历的实体、以及学历区块的切片证据都回指不到本文档的条目，忽略它们等于
 * "只按这份简历里真实存在的内容排序"（4.5-06 的证据反查也共用这条口径）。
 * @param rows 缺口报告的三态行（与 `items` 同序，本函数不重排它们）
 * @param drafts 由同一份文档派生出的实体草案（`deriveEntities(document)` 的返回）
 * @returns 条目 id → 相关性；未拿到任何证据的条目不在表里（读不到即 0 分）
 */
function relevanceOf(rows: readonly GapRequirementView[], drafts: readonly KbEntityDraft[]): Map<string, Relevance> {
  const entryOfEntity = new Map<string, string>();
  for (const draft of drafts) {
    if (draft.entryId !== null) entryOfEntity.set(draft.entityId, draft.entryId);
  }

  const collected = new Map<string, ReorderHit[]>();
  for (const row of rows) {
    for (const evidence of row.evidence) {
      const entryId = entryOfEntity.get(evidence.id);
      if (entryId === undefined) continue;
      const hit: ReorderHit = {
        label: row.item.label,
        kind: row.item.kind,
        score: evidence.score,
        tokens: evidence.matchedTokens,
      };
      const existing = collected.get(entryId);
      if (existing === undefined) collected.set(entryId, [hit]);
      else existing.push(hit);
    }
  }

  const entries = new Map<string, Relevance>();
  for (const [entryId, hits] of collected) {
    const sorted = sortHits(hits);
    // 一条经历同时撑「Kubernetes」和「高并发」时，它的相关性由强的那条决定，不是两条相加：
    // 求和会让"写得长的条目"仅仅因为命中条数多而排到前面，那是计数在替相关性做主。
    entries.set(entryId, { score: Math.max(...sorted.map((hit) => hit.score)), hits: sorted });
  }
  return entries;
}

/**
 * 按相关性把一组同类可排序对象分成「拿分的」与「零分的」两列，并对拿分的那列降序。
 *
 * 平分保持基线原序（稳定排序，判据一里写死的"不做二次猜测"）：这里显式把下标写进比较，
 * 不依赖 `Array.prototype.sort` 的稳定性——读代码的人不该去查引擎实现才敢确定结果。
 * @param items 待排序的对象序列（顺序即基线顺序）
 * @param scoreOf 取该对象的相关性分；无读数返回 0
 * @returns 新序列；零分对象保持原相对次序接在末尾
 */
function orderByScore<T>(items: readonly T[], scoreOf: (item: T) => number): T[] {
  const scored: Array<{ item: T; score: number; index: number }> = [];
  const untouched: T[] = [];
  items.forEach((item, index) => {
    const score = scoreOf(item);
    if (score > 0) scored.push({ item, score, index });
    else untouched.push(item);
  });
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  return [...scored.map((scoredItem) => scoredItem.item), ...untouched];
}

/**
 * 一组带 id 的对象 → id 到原下标的表（id 在文档内唯一，见 P3.1 的 `strictObject`）。
 * @param items 顺序即基线顺序的对象序列
 * @returns id → 下标；用于查"重排后它落到第几位"
 */
function indexById(items: readonly { id: string }[]): Map<string, number> {
  return new Map(items.map((item, index) => [item.id, index]));
}

/**
 * 生成一条区块序列：区块之间按相关性换序，区块内的条目同样换序，并给出每一步的依据。
 *
 * **只换序、不改内容**（判据一 / 判据二的分界）：字段的改写发生在 `generate-model.ts`，
 * 两者的先后见 `generate-service.ts`。返回的 `Section` / `Entry` 与入参是同一批对象引用，
 * 只有内部条目换了序的区块会被浅拷贝一份（换新 `entries` 数组），内容逐字未变的区块返回原对象。
 * @param document 基线文档（已通过 P3.1 校验）
 * @param rows 缺口报告的三态行（4.4 的现成读数，本函数不重算分数）
 * @param drafts 同一份文档派生的实体草案（提供 证据 id → 条目 id 的唯一映射）
 * @returns 新区块序列 + 每个真正换位的对象的依据
 */
export function reorderDocument(
  document: ResumeDocument,
  rows: readonly GapRequirementView[],
  drafts: readonly KbEntityDraft[],
): ReorderResult {
  const entryRelevance = relevanceOf(rows, drafts);
  const bases: ReorderBasis[] = [];

  // 区块分由**文档结构**聚合，而不是由实体 kind 猜：一条 `achievement` 实体的 kind 是
  // 'achievement'，它住的区块却可能是 campus；只有 `section → entries` 这张表知道它在哪。
  const sectionRelevance = new Map<string, Relevance>();
  for (const section of document.sections) {
    let best = NO_RELEVANCE;
    for (const entry of section.entries) {
      const relevance = entryRelevance.get(entry.id);
      if (relevance !== undefined && relevance.score > best.score) best = relevance;
    }
    if (best.score > 0) sectionRelevance.set(section.id, best);
  }

  const sectionOrder = orderByScore(document.sections, (section) => sectionRelevance.get(section.id)?.score ?? 0);
  const reordered: Section[] = sectionOrder.map((section) => {
    const entryOrder = orderByScore(section.entries, (entry) => entryRelevance.get(entry.id)?.score ?? 0);
    const entryIndexAfter = indexById(entryOrder);
    let hasChanged = false;
    section.entries.forEach((entry, fromIndex) => {
      const toIndex = entryIndexAfter.get(entry.id) ?? fromIndex;
      if (toIndex === fromIndex) return;
      hasChanged = true;
      bases.push({
        level: 'entry',
        id: entry.id,
        ...(entryRelevance.get(entry.id) ?? NO_RELEVANCE),
        fromIndex,
        toIndex,
      });
    });
    return hasChanged ? { ...section, entries: entryOrder } : section;
  });

  const sectionIndexAfter = indexById(sectionOrder);
  for (const [fromIndex, section] of document.sections.entries()) {
    const toIndex = sectionIndexAfter.get(section.id) ?? fromIndex;
    if (toIndex === fromIndex) continue;
    bases.push({
      level: 'section',
      id: section.id,
      ...(sectionRelevance.get(section.id) ?? NO_RELEVANCE),
      fromIndex,
      toIndex,
    });
  }

  const movedSections = bases.filter((basis) => basis.level === 'section').length;
  return {
    sections: reordered,
    // 依据列表的次序也要可复现：先区块后条目、同级按原下标、再按 id，界面照这个顺序播"哪些被提前了"。
    bases: bases.sort(
      (left, right) =>
        (left.level === right.level ? 0 : left.level === 'section' ? -1 : 1) ||
        left.fromIndex - right.fromIndex ||
        left.id.localeCompare(right.id),
    ),
    movedSections,
    movedEntries: bases.length - movedSections,
  };
}

/**
 * 重排后仍要满足"这是一份合法文档"——本函数给的就是那句断言的可执行形式（4.5-01 的最低门槛）。
 *
 * 单独成函数而不是让各处测试自己写：重排只动数组顺序，因此**条目与字段的总数不变**是它的不变量；
 * 一旦哪天有人在这里顺手做"删掉不相关条目"的瘦身，这条断言会立刻发红（那是 4.5-07 的通道之一）。
 * @param before 基线文档
 * @param after 重排后的区块序列
 * @returns 条目总数与字段总数都与基线相等时为 true
 */
export function preservesAllEntries(before: ResumeDocument, after: readonly Section[]): boolean {
  const countOf = (sections: readonly Section[]): { entries: number; fields: number } => ({
    entries: sections.reduce((sum, section) => sum + section.entries.length, 0),
    fields: sections.reduce(
      (sum, section) => sum + section.entries.reduce((inner, entry) => inner + entry.fields.length, 0),
      0,
    ),
  });
  const left = countOf(before.sections);
  const right = countOf(after);
  return left.entries === right.entries && left.fields === right.fields;
}
