/**
 * 模板参数层（spec 3.2-01 / 3.2-03 / 3.2-05 / 3.2-07 的落地形态）。
 *
 * 为什么是"参数系统 + 预设数据"而不是 50 份 `render`：版面的差异全部落在这几条正交轴上
 * （抬头摆位 / 栏数 / 区块标题画法 / 条目行结构 / 强调色 / 密度 / 分隔线 / 技能呈现），
 * 每套模板只是这几条轴的一种取值组合。50 份复制粘贴的 `render` 就是 §2.2 禁止的第三处重复实现，
 * 而且改动一条轴要改 50 遍——真正会变的是这张轴表，不会变的是"每套模板的组合"。
 *
 * 数据边界（3.2-05）：本层只决定**怎么摆**，不读任何字段之外的信息——
 * 取值一律经 `toEntryView`（唯一的"读数据"实现，缺核心槽位照旧抛 `TemplateBindingError`），
 * 不截断、不补日期、不新造事实。双栏只是把区块按 kind 分到两栏里，条目内容与文档次序一字不改。
 */
import type { ResumeDocument, Section } from '../model.js';
import {
  escapeHtml,
  fieldLabel,
  sectionLabel,
  toEntryView,
  type Template,
  type TemplateContext,
  type TemplateLocale,
} from './bind.js';

/** 强调色族（取值必须是 `print-css.ts` 里已登记的 Tailwind 色相，不引入自定义色名）。 */
export type AccentHue =
  | 'neutral'
  | 'slate'
  | 'stone'
  | 'zinc'
  | 'gray'
  | 'sky'
  | 'teal'
  | 'emerald'
  | 'amber'
  | 'rose'
  | 'violet'
  | 'indigo'
  | 'red'
  | 'blue'
  | 'green';

/** 抬头摆法：简历最上面那 3–5 行的组织方式。 */
export type HeaderVariant = 'center' | 'left' | 'right' | 'split' | 'banner' | 'boxed' | 'stacked' | 'ruleUnder';

/** 区块标题画法。 */
export type HeadingVariant =
  'rule' | 'doubleRule' | 'bar' | 'block' | 'wide' | 'numbered' | 'leftBorder' | 'pill' | 'underlineShort';

/** 条目行结构：标题与时间同行两端，还是上下叠放。 */
export type EntryVariant = 'split' | 'stack';

/** 密度档：区块与条目之间的留白尺度。 */
export type Density = 'compact' | 'normal' | 'roomy';

/** 一套模板的全部版面取值（预设表里的每一行就是这一个对象）。 */
export interface TemplateSpec {
  /** 栏数：1 = 通栏，2 = 主栏 + 侧栏 */
  columns: 1 | 2;
  accent: AccentHue;
  header: HeaderVariant;
  heading: HeadingVariant;
  entry: EntryVariant;
  density: Density;
  /** 姓名与联系方式是否用衬线族（true = font-serif） */
  serif: boolean;
  /** 姓名字号（`text-*` 档名，不含 `text-` 前缀） */
  nameSize: '2xl' | '3xl' | '4xl' | '5xl' | 'xl' | '[28px]' | '[32px]';
  nameWeight: 'bold' | 'extrabold' | 'black' | 'semibold' | 'medium' | 'normal';
  /** 姓名是否全部大写（英文简历常见，中文不受影响） */
  nameCaps: boolean;
  /** 联系方式分隔符（只在单行摆法里用） */
  contactSep: ' · ' | ' | ' | ' / ' | ' • ';
  /** 条目之间是否画一条分隔线 */
  entryDivider: boolean;
  /** 技能/简介那类无标题区块的正文是否走两栏网格 */
  plainGrid: boolean;
}

/**
 * 注册表里实际存的形状：`Template` 契约 + 这一套自己的轴取值。
 *
 * 为什么要把 `spec` 挂上契约（而不是让预设表自己留着）：界面要按版式骨架画缩略图（spec 6.4-09），
 * 而骨架的**唯一**依据就是渲染时真正生效的那份轴——它只存在于这里。摘要层再抄一份轴表就是
 * 第二份事实（§2.5），改一条轴时界面上的小图会先于产物骗人。
 * `bind.ts` 的 `Template` 保持最小（只讲"怎么渲"），因为运行期扩展位不该被迫懂版面词汇。
 */
export interface ResumeTemplate extends Template {
  /** 这套模板的版面取值：`renderWithSpec` 吃的就是它，界面画骨架读的也是它。 */
  readonly spec: TemplateSpec;
}

/** 侧栏收纳的区块种类（双栏模板把这三类摆到窄栏；其余进主栏）。 */
const SIDE_KINDS: Section['kind'][] = ['skills', 'education', 'summary'];

/** 密度档 → 区块与条目的留白 class。 */
const DENSITY_CLASSES: Record<Density, { section: string; entry: string; body: string }> = {
  compact: { section: 'mb-2.5', entry: 'mb-1.5', body: 'text-[11px]' },
  normal: { section: 'mb-4', entry: 'mb-2', body: 'text-sm' },
  roomy: { section: 'mb-6', entry: 'mb-3', body: 'text-sm' },
};

/**
 * 拼一行联系方式（可选字段缺失不占位，与 3.2-04「缺就空白、不瞎补」同口径）。
 * @param doc 简历文档
 * @param locale 语言（字段标签走 `fieldLabel`）
 * @param sep 分隔符（预设表给的哪一种）
 * @returns 已转义的一行文本
 */
function contactLine(doc: ResumeDocument, locale: TemplateLocale, sep: string): string {
  const { email, phone, location } = doc.profile.contact;
  const parts: string[] = [];
  if (email) parts.push(`${fieldLabel('email', locale)}: ${email}`);
  if (phone) parts.push(`${fieldLabel('phone', locale)}: ${phone}`);
  if (location) parts.push(`${fieldLabel('location', locale)}: ${location}`);
  return escapeHtml(parts.join(sep));
}

/**
 * 联系方式逐行列出（侧栏与 banner 抬头用，一个字段一行）。
 * @param doc 简历文档
 * @param lineClass 每一行的 class
 * @returns 若干 `<div>`，已转义
 */
function contactRows(doc: ResumeDocument, lineClass: string): string {
  const { email, phone, location } = doc.profile.contact;
  return [email, phone, location]
    .filter((value): value is string => Boolean(value))
    .map((value) => `<div class="${lineClass}">${escapeHtml(value)}</div>`)
    .join('');
}

/**
 * 渲染抬头（姓名 + 联系方式）那一段。
 * @param spec 该套模板的版面取值
 * @param doc 简历文档
 * @param ctx 渲染上下文
 * @returns HTML 串
 */
function renderHeader(spec: TemplateSpec, doc: ResumeDocument, ctx: TemplateContext): string {
  const name = escapeHtml(doc.profile.name);
  const nameClass = `text-${spec.nameSize} font-${spec.nameWeight}${spec.nameCaps ? ' uppercase tracking-wide' : ''}`;
  const line = contactLine(doc, ctx.locale, spec.contactSep);
  const inkText = `text-${spec.accent}-800`;

  switch (spec.header) {
    case 'center':
      return `<header class="mb-4 text-center"><h1 class="${nameClass} text-neutral-900">${name}</h1><p class="text-xs ${inkText}">${line}</p></header>`;
    case 'right':
      return `<header class="mb-4 text-right"><h1 class="${nameClass}">${name}</h1><p class="text-xs ${inkText}">${line}</p></header>`;
    case 'split':
      return `<header class="mb-4 flex items-end justify-between gap-4"><div><h1 class="${nameClass}">${name}</h1></div><div class="text-right text-xs ${inkText}">${contactRows(doc, 'leading-relaxed')}</div></header>`;
    case 'banner':
      return `<header class="mb-4 bg-${spec.accent}-800 px-4 py-3"><h1 class="${nameClass} text-white">${name}</h1><p class="text-xs text-white">${line}</p></header>`;
    case 'boxed':
      return `<header class="mb-4 border-2 border-${spec.accent}-700 px-4 py-3 text-center"><h1 class="${nameClass} text-${spec.accent}-900">${name}</h1><p class="text-xs text-neutral-600">${line}</p></header>`;
    case 'stacked':
      return `<header class="mb-4"><h1 class="${nameClass} text-neutral-900">${name}</h1>${contactRows(doc, `text-xs ${inkText} leading-relaxed`)}</header>`;
    case 'ruleUnder':
      return `<header class="mb-4 border-b-4 border-${spec.accent}-600 pb-2"><h1 class="${nameClass}">${name}</h1><p class="text-xs text-neutral-600">${line}</p></header>`;
    case 'left':
    default:
      return `<header class="mb-4"><h1 class="${nameClass}">${name}</h1><p class="text-xs ${inkText}">${line}</p></header>`;
  }
}

/**
 * 渲染一个区块标题（六种画法都在这一支函数里，预设表只挑画法编号）。
 * @param spec 版面取值
 * @param heading 已本地化的区块标题文案
 * @param ordinal 该区块在文档里的序位（`numbered` 画法用）
 * @returns HTML 串
 */
function renderHeading(spec: TemplateSpec, heading: string, ordinal: number): string {
  const label = escapeHtml(heading);
  const accentText = `text-${spec.accent}-700`;
  switch (spec.heading) {
    case 'doubleRule':
      return `<h2 class="mb-1 border-b-2 border-t-2 border-${spec.accent}-600 py-1 text-xs font-bold uppercase tracking-widest ${accentText}">${label}</h2>`;
    case 'bar':
      return `<h2 class="mb-1.5 bg-${spec.accent}-100 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-${spec.accent}-800">${label}</h2>`;
    case 'block':
      return `<h2 class="mb-1.5 inline-block border-b-2 border-${spec.accent}-600 text-sm font-extrabold uppercase tracking-wide">${label}</h2>`;
    case 'wide':
      return `<h2 class="mb-1 text-[11px] font-semibold uppercase tracking-widest text-neutral-500">${label}</h2>`;
    case 'numbered':
      return `<h2 class="mb-1.5 text-sm font-bold ${accentText}"><span class="mr-1 text-neutral-400">${String(ordinal).padStart(2, '0')}</span>${label}</h2>`;
    case 'leftBorder':
      return `<h2 class="mb-1.5 border-l-4 border-${spec.accent}-500 pl-2 text-sm font-bold uppercase tracking-wide">${label}</h2>`;
    case 'pill':
      return `<h2 class="mb-1.5 inline-block rounded-full bg-${spec.accent}-600 px-3 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">${label}</h2>`;
    case 'underlineShort':
      return `<h2 class="mb-1.5 text-sm font-bold tracking-wide">${label}</h2><div class="mb-1 h-0.5 w-10 bg-${spec.accent}-600"></div>`;
    case 'rule':
    default:
      return `<h2 class="mb-1 border-b border-${spec.accent}-300 pb-1 text-sm font-bold uppercase tracking-wide ${accentText}">${label}</h2>`;
  }
}

/**
 * 渲染一个区块（标题 + 其下所有条目）。
 * @param spec 版面取值
 * @param section 文档里的区块
 * @param ordinal 区块序位
 * @param ctx 渲染上下文
 * @param templateId 模板 id（绑定错误文案用）
 * @param densityClasses 当前密度档的留白 class
 * @returns HTML 串；区块无条目时整块不渲染（不留空标题）
 */
function renderSection(
  spec: TemplateSpec,
  section: Section,
  ordinal: number,
  ctx: TemplateContext,
  templateId: string,
  densityClasses: { section: string; entry: string; body: string },
): string {
  if (section.entries.length === 0) return '';
  const heading = renderHeading(spec, sectionLabel(section.kind, ctx.locale), ordinal);
  const isPlain = section.kind === 'summary' || section.kind === 'skills';
  const entries = section.entries
    .map((entry) =>
      isPlain
        ? renderPlainEntry(spec, section, entry, ctx, templateId)
        : renderEntry(spec, section, entry, ctx, templateId),
    )
    .join('');
  const inner = isPlain && spec.plainGrid ? `<div class="grid grid-cols-2 gap-x-4">${entries}</div>` : entries;
  return `<section class="${densityClasses.section}">${heading}${inner}</section>`;
}

/**
 * 渲染一条有标题结构的条目（经历 / 项目 / 校园 / 教育）。
 * @param spec 版面取值
 * @param section 所属区块
 * @param entry 条目
 * @param ctx 渲染上下文
 * @param templateId 模板 id
 * @returns HTML 串
 */
function renderEntry(
  spec: TemplateSpec,
  section: Section,
  entry: ResumeDocument['sections'][number]['entries'][number],
  ctx: TemplateContext,
  templateId: string,
): string {
  const view = toEntryView(templateId, section, entry, ctx.locale);
  const classes = DENSITY_CLASSES[spec.density];
  const headingClass =
    spec.columns === 2 && SIDE_KINDS.includes(section.kind) ? 'text-[12px] font-bold' : 'text-[13px] font-bold';
  const meta = view.meta
    .map((value) => `<span class="text-[11px] font-medium text-${spec.accent}-700">${value}</span>`)
    .join('');
  const lines = view.lines
    .map(
      (line) =>
        `<div class="${classes.body} text-neutral-700${line.label === '' ? '' : ' flex gap-1'}">` +
        (line.label === '' ? '' : `<span class="shrink-0 text-neutral-500">${line.label}:</span>`) +
        `<span class="min-w-0">${line.value}</span></div>`,
    )
    .join('');
  const head =
    spec.entry === 'split'
      ? `<div class="flex items-baseline justify-between gap-2"><div class="${headingClass}">${view.heading}</div><div class="flex shrink-0 gap-2">${meta}</div></div>`
      : `<div class="${headingClass}">${view.heading}</div><div class="flex gap-2">${meta}</div>`;
  const divider = spec.entryDivider ? ' border-b border-neutral-200 pb-1.5' : '';
  return `<div class="resume-entry${divider} ${classes.entry}">${head}${lines}</div>`;
}

/**
 * 渲染一条无标题结构的条目（个人简介 / 技能那类自由正文）。
 * @param spec 版面取值
 * @param section 所属区块
 * @param entry 条目
 * @param ctx 渲染上下文
 * @param templateId 模板 id
 * @returns HTML 串
 */
function renderPlainEntry(
  spec: TemplateSpec,
  section: Section,
  entry: ResumeDocument['sections'][number]['entries'][number],
  ctx: TemplateContext,
  templateId: string,
): string {
  const view = toEntryView(templateId, section, entry, ctx.locale);
  const classes = DENSITY_CLASSES[spec.density];
  const isSkill = section.kind === 'skills';
  const chip = isSkill && spec.heading === 'pill';
  const body = view.lines
    .map(
      (line) =>
        `<div class="${chip ? `mr-1 mb-1 inline-block rounded-full bg-${spec.accent}-100 px-2 py-0.5 text-[11px] text-${spec.accent}-800` : `${classes.body} text-neutral-700`}${line.label === '' ? '' : ' flex gap-1'}">` +
        (line.label === '' ? '' : `<span class="shrink-0 text-neutral-500">${line.label}:</span>`) +
        `<span>${line.value}</span></div>`,
    )
    .join('');
  return `<div class="resume-entry ${classes.entry}">${body}</div>`;
}

/**
 * 按预设渲染整份文档（所有模板共用这一支装配函数，3.2-01「模板是纯函数」）。
 * @param doc 已通过校验的简历文档
 * @param ctx 渲染上下文（语言）
 * @param spec 该套模板的版面取值
 * @param templateId 模板 id（绑定错误文案用）
 * @returns A4 就绪的 HTML 片段
 */
export function renderWithSpec(
  doc: ResumeDocument,
  ctx: TemplateContext,
  spec: TemplateSpec,
  templateId: string,
): string {
  const classes = DENSITY_CLASSES[spec.density];
  const header = renderHeader(spec, doc, ctx);
  const sections = doc.sections;
  let body: string;

  if (spec.columns === 1) {
    body = sections.map((section, index) => renderSection(spec, section, index + 1, ctx, templateId, classes)).join('');
  } else {
    const side = sections.filter((section) => SIDE_KINDS.includes(section.kind));
    const main = sections.filter((section) => !SIDE_KINDS.includes(section.kind));
    // 栏内序位沿用区块在文档里的原序（双栏只是摆位变化，不重排数据，3.2-05）。
    const ordinalOf = (section: Section): number => sections.indexOf(section) + 1;
    const mainHtml = main
      .map((section) => renderSection(spec, section, ordinalOf(section), ctx, templateId, classes))
      .join('');
    const sideHtml = side
      .map((section) => renderSection(spec, section, ordinalOf(section), ctx, templateId, classes))
      .join('');
    body = `<div class="grid grid-cols-3 gap-x-6"><div class="col-span-2">${mainHtml}</div><div class="text-[12px]">${sideHtml}</div></div>`;
  }

  const frame = spec.header === 'boxed' ? 'border border-neutral-300 p-5' : '';
  return `<article class="${spec.serif ? 'font-serif' : 'font-sans'} text-neutral-900 ${frame}">${header}${body}</article>`;
}
