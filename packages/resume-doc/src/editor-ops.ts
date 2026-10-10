/**
 * 排版编辑器的纯操作（spec 3.6-01 / 3.6-02 与 6.6-05 的判定半边，plan §8.3 的 `editor-ops.ts`）。
 *
 * 为什么单拎一个文件而不是写进 `schema.ts` 或 `doc-store.ts`：这一层只回答「这样改合不合法、
 * 合法之后新状态长什么样」，既不落库也不读配置，形状照已经验收的 `packages/pdf-edit/src/page-ops.ts`
 * （拒绝腿在前、合法才产新值、**不抛异常**）。服务层与编辑会话（`editor-session.ts`）共用这一份判据，
 * 于是"界面放行而保存被拒"这种分叉从一开始就不存在（AGENTS.md §2.5）。
 *
 * 三条边界口径（plan §8.1 第 2、3 条 + 6.6 补片）：
 * - **度量上下界只加在这一层，不加进 `layoutSchema`**：`schema.ts` 那份是「一份文档合不合法」，
 *   已验收的 3.1/3.2 判据都挂在它上面；这里的界是「编辑器的滑杆允许推到哪儿」，是给**人的输入**设的界，
 *   把两者混进一处等于用新判据去追改旧判据（§2.4 的反面：老文档不该因为今天立了滑杆范围而变非法）。
 * - **样式补丁是个例外，它要查"形状"**：预览吃的是**未保存的 draft**，而 `validateDocument` 只在保存那一刻跑，
 *   所以颜色的 `#rrggbb` 与档位枚举必须在这里就挡住，否则一个自由字符串会先一步进产物文档的 `<style>` 块。
 *   查的是 Schema 同一件事，因此模式也引用同一只（`HEX_COLOR_PATTERN`）、枚举引用 `model.ts` 那三份清单，
 *   不在此处再抄一遍字符串。
 * - **模板不属于这里**：模板是渲染期的纯函数注册表（`template.ts`），文档模型里没有 templateId，
 *   所以「切模板」在这套代码里根本不是一次编辑，也就没有"切完丢数据"这件事可修。
 */
import type {
  DocumentDesign,
  FontFamilyToken,
  FontWeightToken,
  Layout,
  PageMargin,
  ParagraphStyle,
  Section,
  SectionKind,
  TextAlignToken,
} from './model.js';
import { FONT_FAMILY_TOKENS, FONT_WEIGHT_TOKENS, TEXT_ALIGN_TOKENS } from './model.js';
import { PARAGRAPH_KIND_ORDER } from './normalize.js';
import { HEX_COLOR_PATTERN } from './schema.js';

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
  | 'unknown-metric'
  | 'not-a-number'
  | 'out-of-bounds'
  | 'unknown-section'
  | 'unknown-entry'
  | 'index-out-of-range'
  | 'bad-color'
  | 'bad-token'
  | 'unknown-kind';

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
 * 一次样式动作里的一条可空轴：给值是设，给 `null` 是**清掉**（这一条轴回到模板默认档），不给是不改。
 * 三种表态必须分得开——界面上"取消选中"与"这格我还没碰"是两件不同的事，
 * 而它们在产物里的差别是"少挂一只 `rz-*` 类"与"什么都没发生"。
 */
type Nullable<T> = T | null;

/** 正文字体三条轴的补丁形状。 */
export interface BodyStylePatch {
  fontFamily?: Nullable<FontFamilyToken>;
  sizePt?: Nullable<number>;
  weight?: Nullable<FontWeightToken>;
}

/** 一类区块的段落样式补丁（六条轴与 `ParagraphStyle` 一一对应）。 */
export interface ParagraphStylePatch {
  kind: SectionKind;
  sizePt?: Nullable<number>;
  weight?: Nullable<FontWeightToken>;
  align?: Nullable<TextAlignToken>;
  lineHeight?: Nullable<number>;
  inkHex?: Nullable<string>;
  backdropHex?: Nullable<string>;
}

/**
 * 一次样式动作的载荷（spec 6.6-05：界面一次调用 = 一个撤销单元，所以段落弹窗"整格保存"是一次调用）。
 * 五个入口各自可以带多条轴，`body: null` 与 `paragraph` 里的多格一次提交都合法。
 */
export interface DesignPatch {
  inkHex?: Nullable<string>;
  paperHex?: Nullable<string>;
  accentHex?: Nullable<string>;
  body?: Nullable<BodyStylePatch>;
  paragraph?: ParagraphStylePatch;
}

/**
 * 一条颜色轴的落点。
 * @param patch 这一格的补丁（`undefined` 不改 / `null` 清掉 / 字符串要过 `#rrggbb`）
 * @param current 现值
 * @param axis 轴名（写进拒绝理由，界面能把话说到哪一格）
 * @returns 通过给下一格的值（`undefined` = 这一格没有值），形状不合法给 `bad-color`
 */
function planColor(
  patch: Nullable<string> | undefined,
  current: string | undefined,
  axis: string,
): EditorOutcome<string | undefined> {
  if (patch === undefined) return { ok: true, value: current };
  if (patch === null) return { ok: true, value: undefined };
  if (!HEX_COLOR_PATTERN.test(patch)) return reject('bad-color', `${axis}=${patch} 不是 #rrggbb 六位十六进制`);
  return { ok: true, value: patch };
}

/**
 * 一条枚举轴的落点。
 * @param patch 这一格的补丁（`undefined` 不改 / `null` 清掉 / 其余必须在清单里）
 * @param current 现值
 * @param axis 轴名
 * @param tokens 合法取值清单（`model.ts` 那三份，界面与闸门同源）
 * @returns 通过给下一格的值，不在清单里给 `bad-token`（界面上不该出现自造档名）
 */
function planToken<T extends string>(
  patch: Nullable<T> | undefined,
  current: T | undefined,
  axis: string,
  tokens: readonly T[],
): EditorOutcome<T | undefined> {
  if (patch === undefined) return { ok: true, value: current };
  if (patch === null) return { ok: true, value: undefined };
  if (!tokens.includes(patch)) {
    return reject('bad-token', `${axis}=${patch} 不是 ${tokens.join('/')} 当中的一个`);
  }
  return { ok: true, value: patch };
}

/**
 * 一条数值轴的落点：非有限数与界外都拒，界由调用方给（字号/行距沿用度量那同一张界表）。
 * @param patch 这一格的补丁（`undefined` 不改 / `null` 清掉）
 * @param current 现值
 * @param axis 轴名
 * @param bound 界（`EDITOR_METRIC_BOUNDS` 里的那一档）
 * @returns 通过给下一格的值，非数给 `not-a-number`，界外给 `out-of-bounds`
 */
function planNumber(
  patch: Nullable<number> | undefined,
  current: number | undefined,
  axis: string,
  bound: MetricBound,
): EditorOutcome<number | undefined> {
  if (patch === undefined) return { ok: true, value: current };
  if (patch === null) return { ok: true, value: undefined };
  if (!Number.isFinite(patch)) return reject('not-a-number', `${axis}=${String(patch)} 不是有限数字`);
  if (patch < bound.min || patch > bound.max) {
    return reject('out-of-bounds', `${axis}=${String(patch)} 不在 ${String(bound.min)}…${String(bound.max)} 之内`);
  }
  return { ok: true, value: patch };
}

/**
 * 给一个对象挑出"真的有值"的那几格（样式层的全部纪律都在这一小步上：
 * 空壳不许留下 `design: {}`，否则 `'design' in layout` 会变 true，而产物与落地前逐字节相同这一条
 * 判据就再也对不上）。
 * @param entries 候选格（键 → 值或 undefined）
 * @returns 只含有值那些格的新对象；全空则是空对象
 */
function compact<T extends object>(entries: { [K in keyof T]: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/**
 * 应用一次样式补丁（spec 6.6-05 的判定半边）。
 * @param layout 当前版面（不被修改）
 * @param patch 要改的那几格（见 `DesignPatch`；同一格给 `null` 就是取消它）
 * @returns 通过给一份**新** `Layout`：补丁全空或全被取消时连 `design` 键都不留（与"从未设过主题"同一形状）；
 *          颜色形状非法给 `bad-color`，档位不在清单里给 `bad-token`，数值界外给 `out-of-bounds` / `not-a-number`，
 *          段落种类不认识给 `unknown-kind`
 */
export function planDesign(layout: Layout, patch: DesignPatch): EditorOutcome<Layout> {
  const current = layout.design;
  const ink = planColor(patch.inkHex, current?.inkHex, 'inkHex');
  if (!ink.ok) return ink;
  const paper = planColor(patch.paperHex, current?.paperHex, 'paperHex');
  if (!paper.ok) return paper;
  const accent = planColor(patch.accentHex, current?.accentHex, 'accentHex');
  if (!accent.ok) return accent;

  // 正文三条轴：`body: null` 是整格取消，给了某几格则其余格沿用现值。
  let body: DocumentDesign['body'];
  if (patch.body !== null) {
    const family = planToken(patch.body?.fontFamily, current?.body?.fontFamily, 'body.fontFamily', FONT_FAMILY_TOKENS);
    if (!family.ok) return family;
    const size = planNumber(patch.body?.sizePt, current?.body?.sizePt, 'body.sizePt', EDITOR_METRIC_BOUNDS.baseFontPt);
    if (!size.ok) return size;
    const weight = planToken(patch.body?.weight, current?.body?.weight, 'body.weight', FONT_WEIGHT_TOKENS);
    if (!weight.ok) return weight;
    body = compact<{ fontFamily?: FontFamilyToken; sizePt?: number; weight?: FontWeightToken }>({
      fontFamily: family.value,
      sizePt: size.value,
      weight: weight.value,
    });
  }

  let paragraphs: Partial<Record<SectionKind, ParagraphStyle>> = current?.paragraphs ?? {};
  const paragraph = patch.paragraph;
  if (paragraph) {
    if (!PARAGRAPH_KIND_ORDER.includes(paragraph.kind)) {
      return reject('unknown-kind', `没有 ${paragraph.kind} 这一类区块（可改的是 ${PARAGRAPH_KIND_ORDER.join('/')}）`);
    }
    const kind = paragraph.kind;
    const style = current?.paragraphs?.[kind];
    const size = planNumber(paragraph.sizePt, style?.sizePt, `${kind}.sizePt`, EDITOR_METRIC_BOUNDS.baseFontPt);
    if (!size.ok) return size;
    const weight = planToken(paragraph.weight, style?.weight, `${kind}.weight`, FONT_WEIGHT_TOKENS);
    if (!weight.ok) return weight;
    const align = planToken(paragraph.align, style?.align, `${kind}.align`, TEXT_ALIGN_TOKENS);
    if (!align.ok) return align;
    const lineHeight = planNumber(
      paragraph.lineHeight,
      style?.lineHeight,
      `${kind}.lineHeight`,
      EDITOR_METRIC_BOUNDS.lineHeight,
    );
    if (!lineHeight.ok) return lineHeight;
    const kindInk = planColor(paragraph.inkHex, style?.inkHex, `${kind}.inkHex`);
    if (!kindInk.ok) return kindInk;
    const backdrop = planColor(paragraph.backdropHex, style?.backdropHex, `${kind}.backdropHex`);
    if (!backdrop.ok) return backdrop;
    const nextStyle = compact<ParagraphStyle>({
      sizePt: size.value,
      weight: weight.value,
      align: align.value,
      lineHeight: lineHeight.value,
      inkHex: kindInk.value,
      backdropHex: backdrop.value,
    });
    // 六条轴全被取消时这一类整格消失，而不是留下一只 `{}`（否则 `'experience' in paragraphs` 会说谎）。
    paragraphs =
      Object.keys(nextStyle).length === 0 ? withoutKind(paragraphs, kind) : { ...paragraphs, [kind]: nextStyle };
  }

  const design = compact<DocumentDesign>({
    inkHex: ink.value,
    paperHex: paper.value,
    accentHex: accent.value,
    body: body && Object.keys(body).length > 0 ? body : undefined,
    paragraphs: Object.keys(paragraphs).length > 0 ? paragraphs : undefined,
  });
  // 全空时要把这一格**删掉**而不是设成 `undefined`：展开一个 `design: undefined` 会把键留下，
  // 于是 `'design' in layout` 说真话而产物里根本没有样式块——"从没设过主题"与"设过又清空"必须同形。
  if (Object.keys(design).length === 0) {
    const stripped: Layout = { ...layout };
    delete stripped.design;
    return { ok: true, value: stripped };
  }
  return { ok: true, value: { ...layout, design } };
}

/**
 * 从段落样式表里去掉一类区块那一格。
 * @param paragraphs 当前表（不被修改）
 * @param kind 要删的那一类
 * @returns 新表（不含那一格）
 */
function withoutKind(paragraphs: Partial<Record<SectionKind, ParagraphStyle>>, kind: SectionKind) {
  const next: Partial<Record<SectionKind, ParagraphStyle>> = { ...paragraphs };
  delete next[kind];
  return next;
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
