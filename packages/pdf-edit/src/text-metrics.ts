/**
 * 行的字形度量（spec 3.5-15）：让「替换字」与被盖住的那一行**一般大、一般高、一般字族**。
 *
 * 为什么这片逻辑要抽到 L2 而不是写在渲染层里：它是纯数，而渲染层没有测试面（离线证据只有四道门禁，
 * 行盒一错就只有"盖歪了/字浮在半空"这种活体才看得见的症状）。放这里，两条腿（画布与 `pdf-lib`）
 * 与单测吃的是同一句判据（AGENTS.md §2.5）。
 *
 * **口径照抄 pdf.js 6.3 自己的 TextLayer**（本机读的是 `pdfjs-dist@6.3.289/build/pdf.mjs` 的
 * `#appendText` 与 `#getAscent`，§6.2：三方库的算法以产物为准，不以博客转述为准）：
 * - 字高度 = 变换矩阵第三、四列的长度：`Math.hypot(transform[2], transform[3])`；
 * - 升部占比先用**画布量出的** `fontBoundingBoxAscent / (ascent + descent)`，量不到才依次回落到
 *   字体自带的 `ascent`、`1 + descent`（pdf.js 的 `descent` 是负数），最后兜 0.8；
 * - 行顶 = 基线 + 升部、行底 = 基线 − 降部。
 * 为什么抄它而不是自创：纸面上那张位图与"点中的那一行"都出自 pdf.js，行盒与它不一致就会盖歪，
 * 而 3.5-03 的判据正是「盖歪了会压住相邻文字」。
 */

/** 三种通用字族（CSS 的那三只关键字），也是导出侧能真正兑现的三种。 */
export const GENERIC_FONT_FAMILIES = ['serif', 'sans-serif', 'monospace'] as const;

/** 归一化后的字族提示。 */
export type FontFamilyHint = (typeof GENERIC_FONT_FAMILIES)[number];

/** 兜底升部占比（pdf.js 的 `DEFAULT_FONT_SIZE` 那一支量不到时用的同一个数）。 */
const FALLBACK_ASCENT_RATIO = 0.8;

/**
 * 从文本项的变换矩阵量出**字高度**（pt）。
 * @param transform pdf.js 的 `TextItem.transform`（六元仿射矩阵；它的声明是 `Array<any>`，所以这里按 `unknown` 收）
 * @returns `hypot(c, d)`；矩阵形状不合（缺项、非有限数）时回 0，由调用方按"量不出这一行"处理，不抛
 */
export function fontHeightPt(transform: readonly unknown[]): number {
  const c = transform[2];
  const d = transform[3];
  if (typeof c !== 'number' || typeof d !== 'number') return 0;
  if (!Number.isFinite(c) || !Number.isFinite(d)) return 0;
  return Math.hypot(c, d);
}

/** `ascentRatioOf` 的四个输入（前两个来自画布实测，后两个来自 pdf.js 的页级字体样式表）。 */
export interface AscentRatioInput {
  /** `measureText('').fontBoundingBoxAscent`（px，与 `measuredDescentPt` 同一次量出） */
  readonly measuredAscentPt?: number;
  /** `Math.abs(measureText('').fontBoundingBoxDescent)`（px） */
  readonly measuredDescentPt?: number;
  /** 字体样式表里的 `ascent`（比例，pdf.js 口径） */
  readonly styleAscent?: number;
  /** 字体样式表里的 `descent`（**负数**，pdf.js 口径） */
  readonly styleDescent?: number;
}

/**
 * 定出**升部占字高度的几成**——基线在行盒里落在哪，就由此决定。
 * @param input 四路读数（见 `AscentRatioInput`；缺哪一路就跳过哪一档）
 * @returns 落在 (0,1) 开区间里的比例；四路都给不出合用读数时回兜底值 0.8，**不回 undefined**
 *          （行盒总要有个基线，兜底这件事在 pdf.js 里也是同一句）
 */
export function ascentRatioOf(input: AscentRatioInput): number {
  const measuredAscent = finitePositive(input.measuredAscentPt);
  const measuredDescent = finitePositive(input.measuredDescentPt);
  if (measuredAscent !== undefined && measuredAscent + (measuredDescent ?? 0) > 0) {
    const ratio = measuredAscent / (measuredAscent + (measuredDescent ?? 0));
    const usable = inOpenUnit(ratio) ? ratio : undefined;
    if (usable !== undefined) return usable;
  }
  const fromStyle = finitePositive(input.styleAscent);
  if (fromStyle !== undefined && inOpenUnit(fromStyle)) return fromStyle;
  // 实测口径：pdf.js 的 `style.descent` 是负数（基线以下），所以 `1 + descent` 才是升部占比。
  const fromDescent = input.styleDescent;
  if (typeof fromDescent === 'number' && Number.isFinite(fromDescent)) {
    const ratio = 1 + fromDescent;
    if (inOpenUnit(ratio)) return ratio;
  }
  return FALLBACK_ASCENT_RATIO;
}

/**
 * 把 pdf.js 报的字族名归到**导出侧真能兑现**的三种通用字族。
 *
 * pdf.js 的 `styles[fontName].fontFamily` 有两种形状：非嵌入的标准字体给的是 CSS 关键字（`'serif'` 等），
 * 嵌入字体给的是声明名（常带子集前缀，如 `'ABCDEF+CalibriSerif'`）。子集前缀必须先摘，否则
 * 一个 `'ABCDEF+FooSerif'` 会因为开头的 `+` 而什么都匹配不上、被误判成无衬线。
 * 判序是**先无衬线后衬线**：`sans-serif` 这个字面里就含着 `serif`，反过来写会把三种通用字族全判成衬线。
 * @param raw 那一份声明名（`undefined` / 空串都当"没报字族"）
 * @returns 三种之一；认不出来即 `sans-serif`（与本片刻意不猜花哨字体的取向一致）
 */
export function fontFamilyHintOf(raw: string | undefined): FontFamilyHint {
  if (raw === undefined || raw.trim() === '') return 'sans-serif';
  const family = raw.replace(/^[A-Z]{6}\+/, '').toLowerCase();
  if (family.includes('monospace') || family.includes('courier')) return 'monospace';
  // `sans-serif` 里也含 `serif`，所以无衬线那一支必须先判（`NotoSansCJK` 这类连写的名字也靠这一条）。
  if (family.includes('sans')) return 'sans-serif';
  // 中文侧的衬线按声明名认：宋体（SimSun / Songti）、明体（Mincho / Ming）是简历里最常见的衬线。
  if (family.includes('serif') || family.includes('times') || family.includes('song')) return 'serif';
  if (family.includes('ming') || family.includes('sun')) return 'serif';
  return 'sans-serif';
}

/**
 * 读一个「只在正数时有意义」的度量。
 * @param value 待读的 `unknown` 级读数（三方库给的，一律先当不可信）
 * @returns 有限正数，否则 undefined
 */
function finitePositive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 判一个比例是否落在开区间 (0,1)——基线不能掉到行盒之外。
 * @param ratio 待判的比例
 * @returns 合用为 true
 */
function inOpenUnit(ratio: number): boolean {
  return Number.isFinite(ratio) && ratio > 0 && ratio < 1;
}
