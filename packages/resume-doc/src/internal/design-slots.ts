/**
 * 样式层的**槽位表**（spec 6.6-01 / 6.6-02 的唯一判据出处）。
 *
 * 为什么要有这一张表：`layout.design` 里的一个值要一路走到三个地方才算生效——
 * ① 模板片段上挂的那个 class、② 打印样式表里那条读变量的规则、③ 产物文档 `:root` 里那只变量。
 * 三处各写一遍字符串，改一条轴就会有三份真相（AGENTS.md §2.5），而错的那一份恰好是**看不出来的那一种**：
 * class 挂上了、变量没发出去，产物就静默回到模板默认值。所以本表同时持有这三样，三个消费者各自从这里取。
 *
 * 一条贯穿全表的规矩：**类只在对应变量真的存在时才挂**。CSS 里 `color:var(--rz-ink)` 而该变量未定义时
 * 是"计算值非法"→ 该属性按 `unset` 处理（对 `color` 等于继承来一个浏览器默认黑），既不报错也不回落模板档，
 * 于是"没设这一条轴"会变成"悄悄变成黑色"。宁可少挂一个类，也不挂一只读空变量的规则。
 *
 * 分层：本文件不认识 HTML，只发"类名 + 变量名 + 声明"，因此放在 `internal/` 与 `print-css.ts` 同层。
 */
import type { DocumentDesign, FontWeightToken, ParagraphStyle, SectionKind } from '../model.js';
import { PARAGRAPH_KIND_ORDER, type ParagraphStyleKey } from '../normalize.js';

/** 字重档 → CSS 数值（`medium` / `semibold` 不是 CSS 关键字，必须换成数）。 */
const WEIGHT_NUMBERS: Record<FontWeightToken, string> = { normal: '400', medium: '500', semibold: '600', bold: '700' };

/** 一条段落轴：模型字段名、类名/变量名后缀、那条 CSS 声明怎么写、以及怎么从用户给的那一档里取值。 */
interface ParagraphAxis {
  /** 模型里的字段名（必须是 `normalize.ts` 规范序里那六个之一，于是两张表漂不了）。 */
  readonly key: ParagraphStyleKey;
  /** 拼进类名与变量名的短名（`size` → `rz-experience-size` / `--rz-p-experience-size`）。 */
  readonly token: string;
  readonly declaration: (varName: string) => string;
  /** 返回 undefined = 这条轴没设。 */
  readonly valueOf: (style: ParagraphStyle) => string | undefined;
}

/**
 * 六条段落轴：字号 / 字重 / 对齐 / 行距 / 文字色 / 文字底色。
 * 这一组就是用户在界面上能改的"段落样式"的全部（裁定第 3 条：粒度到段落为止，不做逐字段级）。
 * 区块种类那一维不在此重复登记：`normalize.ts` 的 `PARAGRAPH_KIND_ORDER` 是唯一清单（规范序与槽位表同源）。
 */
const PARAGRAPH_AXES: readonly ParagraphAxis[] = [
  {
    key: 'sizePt',
    token: 'size',
    declaration: (v) => `font-size:${v}`,
    valueOf: (s) => (s.sizePt === undefined ? undefined : `${String(s.sizePt)}pt`),
  },
  {
    key: 'weight',
    token: 'weight',
    declaration: (v) => `font-weight:${v}`,
    valueOf: (s) => (s.weight === undefined ? undefined : WEIGHT_NUMBERS[s.weight]),
  },
  { key: 'align', token: 'align', declaration: (v) => `text-align:${v}`, valueOf: (s) => s.align },
  {
    key: 'lineHeight',
    token: 'lh',
    declaration: (v) => `line-height:${v}`,
    valueOf: (s) => (s.lineHeight === undefined ? undefined : String(s.lineHeight)),
  },
  { key: 'inkHex', token: 'ink', declaration: (v) => `color:${v}`, valueOf: (s) => s.inkHex },
  { key: 'backdropHex', token: 'band', declaration: (v) => `background-color:${v}`, valueOf: (s) => s.backdropHex },
];

/** 一条槽位的完整形状：类名、变量名、声明。`print-css.ts` 与 `print-html.ts` 共用。 */
export interface DesignSlot {
  readonly className: string;
  readonly varName: string;
  readonly declaration: string;
}

/** 段落槽的类名（挂在**承着文字的那一格**上，不是挂在 `<section>` 或栏上——那些格子自己带 utility，继承顶不过去）。 */
function paragraphClassName(kind: SectionKind, axisToken: string): string {
  return `rz-${kind}-${axisToken}`;
}

/** 段落槽的变量名。 */
function paragraphVarName(kind: SectionKind, axisToken: string): string {
  return `--rz-p-${kind}-${axisToken}`;
}

/** 一条文档级轴：它挂在哪些元素上（可以零到两只类）、读哪只变量、以及怎么从主题里取这一条的值。 */
interface DocumentAxis {
  readonly classNames: readonly string[];
  readonly varName: string;
  /** 声明模板，收到自己的变量名。没有类槽的轴不发静态规则（值只经文档级 `body` 生效），所以可缺省。 */
  readonly declaration?: (varName: string) => string;
  /** 返回 undefined = 这条轴没设。 */
  readonly valueOf: (design: DocumentDesign) => string | undefined;
}

/** 文档级的五只类名。`ink` 一只变量两只类，其余一对一。 */
const INK_HOOK_CLASS = 'rz-design';
const INK_ROW_CLASS = 'rz-ink';
const HEADING_CLASS = 'rz-head';
const BODY_SIZE_CLASS = 'rz-body-size';
const BODY_WEIGHT_CLASS = 'rz-body-weight';

/**
 * 纸底色那只变量名。**没有**对应的 class 槽：它落在产物文档级的 `body{background-color:…}` 上——
 * 屏幕上那张纸的整个边距区（6.6-03 那条 `@media screen` 的 padding）与打印出去的整页底必须是同一个色，
 * 而这两处只有 `body` 盖得住。名字在这里定义一次，`print-html.ts` 拼规则时引用它，两处不再各写一遍。
 */
export const PAPER_VAR_NAME = '--rz-paper';

/**
 * 文档级轴：整份文档共用的那几条（墨色 / 强调色 / 正文字号 / 正文字重 / 纸底）。
 * 类名与变量名在这里各写**一遍**：`print-css.ts` 从这张表拿静态规则、`designVarEntries` 从这里发 `:root` 的值、
 * `rowClassesFor` / `headingClassFor` / `articleHookFor` 发的类串也都取自这里——于是"改一条轴"改的是同一处。
 *
 * 四条落点裁定：
 * - 墨色有**两只**类，读同一只变量：`rz-design` 挂在 `<article>` 上（顶掉它自带的 `text-neutral-900`，
 *   于是抬头里没有自带色的那几格——姓名、联系方式——靠继承跟上），`rz-ink` 挂在承着正文的那几格里
 *   顶掉模板自己写的 `text-neutral-700`。只挂前者不够：继承永远输给元素自己那一条 utility，
 *   于是"改了文字颜色而正文没动"。
 * - 强调色挂在区块标题上。它不进段落轴表：标题的画法是九支分支各有自带色，在每支里挂类不如统一由这一条管，
 *   而 `pill` 那一支是**色块上反白**，换色会直接看不见字，故由模板层豁免（`headingClassFor`）。
 * - 正文字号/字重是"整份文档的正文"那两档，段落级设了同一条轴时由 `rowClassesFor` 跳过。
 * - 纸底色见 `PAPER_VAR_NAME` 上那一段。
 */
const DOCUMENT_AXES: readonly DocumentAxis[] = [
  {
    classNames: [INK_HOOK_CLASS, INK_ROW_CLASS],
    varName: '--rz-ink',
    declaration: (v) => `color:${v}`,
    valueOf: (design) => design.inkHex,
  },
  {
    classNames: [HEADING_CLASS],
    varName: '--rz-accent',
    declaration: (v) => `color:${v}`,
    valueOf: (design) => design.accentHex,
  },
  {
    classNames: [BODY_SIZE_CLASS],
    varName: '--rz-body-size',
    declaration: (v) => `font-size:${v}`,
    valueOf: (design) => (design.body?.sizePt === undefined ? undefined : `${String(design.body.sizePt)}pt`),
  },
  {
    classNames: [BODY_WEIGHT_CLASS],
    varName: '--rz-body-weight',
    declaration: (v) => `font-weight:${v}`,
    valueOf: (design) => (design.body?.weight === undefined ? undefined : WEIGHT_NUMBERS[design.body.weight]),
  },
  { classNames: [], varName: PAPER_VAR_NAME, valueOf: (design) => design.paperHex },
];

/**
 * 全部静态规则（`print-css.ts` 逐条 `put()`，于是自动进 `PRINT_UTILITY_KEYS`，
 * 模板片段用到的每个 `rz-*` 都被机检覆盖）。规则本身恒定存在，**变量与类才是按需的**。
 */
export const DESIGN_SLOT_RULES: readonly DesignSlot[] = [
  ...DOCUMENT_AXES.flatMap((axis) => {
    // 没有类槽就没有静态规则：这一支读变量的 CSS 由 `print-html.ts` 按文档级写法发（`body{…}`）。
    if (axis.declaration === undefined) return [];
    const declaration = axis.declaration(axis.varName);
    return axis.classNames.map((className) => ({ className, varName: axis.varName, declaration }));
  }),
  ...PARAGRAPH_KIND_ORDER.flatMap((kind) =>
    PARAGRAPH_AXES.map((axis) => {
      const varName = paragraphVarName(kind, axis.token);
      return { className: paragraphClassName(kind, axis.token), varName, declaration: axis.declaration(varName) };
    }),
  ),
];

/**
 * 把 `layout.design` 摊成"变量名 → 值"的一张表（`print-html.ts` 据此发 `:root{…}`）。
 * 没设的轴**不出现**，于是产物里既没有空变量也没有回落值——"没设"与"设成模板默认值"在 CSS 层是同一件事。
 * @param design 文档主题（可缺省）
 * @returns 变量名到 CSS 值的映射；无主题时是空对象
 */
export function designVarEntries(design: DocumentDesign | undefined): Record<string, string> {
  if (!design) return {};
  const vars: Record<string, string> = {};
  for (const axis of DOCUMENT_AXES) {
    const value = axis.valueOf(design);
    if (value !== undefined) vars[axis.varName] = value;
  }
  for (const kind of PARAGRAPH_KIND_ORDER) {
    const style = design.paragraphs?.[kind];
    if (!style) continue;
    for (const axis of PARAGRAPH_AXES) {
      const value = axis.valueOf(style);
      if (value !== undefined) vars[paragraphVarName(kind, axis.token)] = value;
    }
  }
  return vars;
}

/**
 * 承着文字的那一格该挂的全部样式层 class（段落级 + 文档级正文，段落级在前）。
 * 模板侧只认这一支函数：区块标题的强调色另有 `headingClassFor` 一支，"哪条轴挂在哪个元素"这两个决定
 * 就是样式层在模板里的全部落点，界面（6.6-05）与机检都照这两处对账。
 * @param design 文档主题
 * @param kind 当前区块种类
 * @returns 以空格开头的 class 串，无主题或没设任何相关轴时是空串
 */
export function rowClassesFor(design: DocumentDesign | undefined, kind: SectionKind): string {
  const style = design?.paragraphs?.[kind];
  let out = '';
  if (style) {
    for (const axis of PARAGRAPH_AXES) {
      if (axis.valueOf(style) !== undefined) out += ` ${paragraphClassName(kind, axis.token)}`;
    }
  }
  // 文档级正文：同一条轴上段落级已经设了就不挂这一只，否则会留下"谁赢看样式表顺序"这种隐式裁定。
  if (style?.sizePt === undefined && design?.body?.sizePt !== undefined) out += ` ${BODY_SIZE_CLASS}`;
  if (style?.weight === undefined && design?.body?.weight !== undefined) out += ` ${BODY_WEIGHT_CLASS}`;
  if (style?.inkHex === undefined && design?.inkHex !== undefined) out += ` ${INK_ROW_CLASS}`;
  return out;
}

/**
 * `<article>` 上那只钩子：抬头里的姓名没有自带色，只能靠继承跟上文档级墨色，而正文那几格顶不掉
 * （见 `DOCUMENT_AXES` 第一条）。与 `rz-ink` 读同一只变量，因此挂与不挂的判据完全同源。
 * @param design 文档主题
 * @returns 以空格开头的 class 串或未设主题时的空串
 */
export function articleHookFor(design: DocumentDesign | undefined): string {
  return design?.inkHex === undefined ? '' : ` ${INK_HOOK_CLASS}`;
}

/**
 * 区块标题该挂的强调色 class。
 * `pill` 那一支豁免：它画的是**色块上的反白字**（`bg-*-600 text-white`），把字色换成用户选的强调色
 * 就成了同色块上的同色字——不是"样式没生效"，是生效得看不见。这一条豁免写在模板层（`spec.heading` 在那儿）。
 * @param design 文档主题
 * @param reversedFill 该套标题画法是否为"实底色块 + 反白字"
 * @returns 以空格开头的 class 串或空串
 */
export function headingClassFor(design: DocumentDesign | undefined, reversedFill: boolean): string {
  return design?.accentHex !== undefined && !reversedFill ? ` ${HEADING_CLASS}` : '';
}
