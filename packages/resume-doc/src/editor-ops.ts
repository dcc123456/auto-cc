/**
 * 排版编辑器的三个纯操作（spec 3.6-01 / 3.6-02 的判定半边，plan §8.3 的 `editor-ops.ts`）。
 *
 * 为什么单拎一个文件而不是写进 `schema.ts` 或 `doc-store.ts`：这一层只回答「这样改合不合法、
 * 合法之后新状态长什么样」，既不落库也不读配置，形状照已经验收的 `packages/pdf-edit/src/page-ops.ts`
 * （拒绝腿在前、合法才产新值、**不抛异常**）。服务层与编辑会话（`editor-session.ts`）共用这一份判据，
 * 于是"界面放行而保存被拒"这种分叉从一开始就不存在（AGENTS.md §2.5）。
 *
 * 两条边界口径（plan §8.1 第 2、3 条）：
 * - **度量上下界只加在这一层，不加进 `layoutSchema`**：`schema.ts` 那份是「一份文档合不合法」，
 *   已验收的 3.1/3.2 判据都挂在它上面；这里的界是「编辑器的滑杆允许推到哪儿」，是给**人的输入**设的界，
 *   把两者混进一处等于用新判据去追改旧判据（§2.4 的反面：老文档不该因为今天立了滑杆范围而变非法）。
 * - **模板不属于这里**：模板是渲染期的纯函数注册表（`template.ts`），文档模型里没有 templateId，
 *   所以「切模板」在这套代码里根本不是一次编辑，也就没有"切完丢数据"这件事可修。
 */
import type { Layout, PageMargin, Section } from './model.js';

/** 度量键：`Layout` 里那四个可由人推的数（边距拆成四条边，界面各一条滑杆）。 */
export type MetricKey = 'baseFontPt' | 'lineHeight' | keyof PageMargin;

/** 一条度量界：单位随键（pt / 倍数 / mm），界面摆滑杆读的就是这张表。 */
export interface MetricBound {
  readonly min: number;
  readonly max: number;
}

/**
 * 编辑器允许推到的界（spec 3.6-02「有边界约束」的那一句）。
 * 取值理由：`DEFAULT_LAYOUT`（10.5pt / 1.5 倍 / 上下 14mm、左右 16mm）必须落在正中，
 * 而 A4 简历的可读区间就这么宽——字号低于 6pt 打印出来是灰点、高于 24pt 一页装不下一条经历；
 * 边距低于 5mm 会被多数打印驱动裁掉、高于 40mm 就只剩半页纸；行距 1 倍是压到底、3 倍是空到没内容。
 */
export const EDITOR_METRIC_BOUNDS: Readonly<Record<MetricKey, MetricBound>> = {
  baseFontPt: { min: 6, max: 24 },
  lineHeight: { min: 1, max: 3 },
  topMm: { min: 5, max: 40 },
  bottomMm: { min: 5, max: 40 },
  leftMm: { min: 5, max: 40 },
  rightMm: { min: 5, max: 40 },
};

/** 被拒的原因（各自对应界面一句话，所以不合并成一个 code）。 */
export type EditorRejectionCode =
  'unknown-metric' | 'not-a-number' | 'out-of-bounds' | 'unknown-section' | 'unknown-entry' | 'index-out-of-range';

/** 一次操作的判定：通过给新值，否则给机器码与技术原因，**不抛异常**。 */
export type EditorOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: EditorRejectionCode; readonly detail: string };

/**
 * 构造拒绝项（收成一个口，避免六条腿各写一份而漏掉某个字段）。
 * @param code 机器码（界面按它选文案）
 * @param detail 技术原因（含具体数值，排查时用得上）
 * @returns 带 `ok: false` 的拒绝项
 */
function reject(code: EditorRejectionCode, detail: string): EditorOutcome<never> {
  return { ok: false, code, detail };
}

/**
 * 把一条度量改成新值。
 * @param layout 当前版面（不被修改）
 * @param key 要改的那条键（`baseFontPt` / `lineHeight` / 边距四条之一；`columns` 不在界内，它由模型级
 *            `layoutSchema` 的 1..2 管着，编辑器不给人一个只有两档的滑杆）
 * @param value 人推出来的新值（单位随键：pt、倍数、mm；界外与非有限数都拒）
 * @returns 通过给一份**新** `Layout`（其余键原样）；界外给 `out-of-bounds`，非数给 `not-a-number`，
 *          未知键给 `unknown-metric`
 */
export function planMetric(layout: Layout, key: MetricKey, value: number): EditorOutcome<Layout> {
  const bound = EDITOR_METRIC_BOUNDS[key];
  if (bound === undefined) return reject('unknown-metric', `没有名为 ${key} 的可调度量`);
  // NaN 与 Infinity 都要挡：它们过得了 `<`/`>` 比较的两边都是 false，一路写进 `@page` 才在打印层炸。
  if (!Number.isFinite(value)) return reject('not-a-number', `值 ${String(value)} 不是有限数字`);
  if (value < bound.min || value > bound.max) {
    return reject('out-of-bounds', `${key}=${String(value)} 不在 ${String(bound.min)}…${String(bound.max)} 之内`);
  }
  const isMargin = key !== 'baseFontPt' && key !== 'lineHeight';
  if (isMargin) {
    return { ok: true, value: { ...layout, margin: { ...layout.margin, [key]: value } } };
  }
  return { ok: true, value: { ...layout, [key]: value } };
}

/**
 * 「把第 fromIndex 个搬到第 toIndex 位」的唯一一份落点数学（区块与条目共用）。
 *
 * 为什么要抽：区块重排与条目重排是同一件事的两次出现（AGENTS.md §2.2），差别只在作用域——
 * 条目只在自己那个区块里搬。语义是**先在原位置抽掉、再插到 toIndex**，所以 `toIndex` 指的是
 * 结果数组里的下标（人的直觉「拖到第 3 个位置」），而不是「跨过几个」。
 * @param items 待搬的序列（不被修改）
 * @param fromIndex 被搬项的现下标
 * @param toIndex 它在结果里的目标下标
 * @returns 通过给新数组；下标越界给 null（"搬到原地"由调用方按空编辑处理，见 `moveBy`）
 */
function reorderAt<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] | null {
  if (
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex) ||
    fromIndex < 0 ||
    fromIndex >= items.length ||
    toIndex < 0 ||
    toIndex >= items.length
  ) {
    return null;
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved as T);
  return next;
}

/**
 * 把某个区块搬到新区块序列里的第 toIndex 位（spec 3.6-01「区块拖拽重排」的数学半边）。
 * @param sections 当前区块序列（不被修改；顺序就是用户意图顺序，`normalize.ts` 与 diff 都不重排）
 * @param sectionId 被拖的那个区块 id
 * @param toIndex 落点下标
 * @returns 通过给新序列；查无此区块给 `unknown-section`，下标越界给 `index-out-of-range`
 */
export function planSectionMove(
  sections: readonly Section[],
  sectionId: string,
  toIndex: number,
): EditorOutcome<Section[]> {
  const fromIndex = sections.findIndex((section) => section.id === sectionId);
  if (fromIndex < 0) return reject('unknown-section', `文档里没有 id 为 ${sectionId} 的区块`);
  const next = reorderAt(sections, fromIndex, toIndex);
  if (next === null) {
    return reject('index-out-of-range', `落点 ${String(toIndex)} 不在 0…${String(sections.length - 1)} 之内`);
  }
  return { ok: true, value: next };
}

/**
 * 把区块里的某条条目搬到第 toIndex 位（条目级重排；只在**所属区块内**有效）。
 *
 * 为什么不许跨区块搬条目：条目是某个 kind 的一条记录（一段经历、一项技能），把它挪进别的区块
 * 改的就不是版面而是内容归类，那是 3.1 的文档模型语义，不在 3.6 这九条判据里。
 * @param sections 当前区块序列（不被修改）
 * @param sectionId 条目所在区块 id
 * @param entryId 被拖的条目 id
 * @param toIndex 条目在**该区块内**的目标下标
 * @returns 通过给新的区块序列（只换那一个区块）；查无区块/条目给 `unknown-section` / `unknown-entry`，
 *          下标越界给 `index-out-of-range`
 */
export function planEntryMove(
  sections: readonly Section[],
  sectionId: string,
  entryId: string,
  toIndex: number,
): EditorOutcome<Section[]> {
  const sectionIndex = sections.findIndex((section) => section.id === sectionId);
  if (sectionIndex < 0) return reject('unknown-section', `文档里没有 id 为 ${sectionId} 的区块`);
  const section = sections[sectionIndex] as Section;
  const entryIndex = section.entries.findIndex((entry) => entry.id === entryId);
  if (entryIndex < 0) {
    return reject('unknown-entry', `区块 ${sectionId} 里没有 id 为 ${entryId} 的条目`);
  }
  const movedEntries = reorderAt(section.entries, entryIndex, toIndex);
  if (movedEntries === null) {
    return reject('index-out-of-range', `落点 ${String(toIndex)} 不在 0…${String(section.entries.length - 1)} 之内`);
  }
  return {
    ok: true,
    value: sections.map((candidate, position) =>
      position === sectionIndex ? { ...candidate, entries: movedEntries } : candidate,
    ),
  };
}
