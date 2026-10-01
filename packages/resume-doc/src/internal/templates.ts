/**
 * 内置模板（spec 3.2-01 / 3.2-02 / 3.2-05 / 3.2-06 / 3.2-07 / 3.2-10）。
 *
 * **抽取来源记录（3.2-10）**：三套模板均为 **clean-room 重写**，未从 `ai-resume` 拷贝任何 HTML / 代码，
 * 只沿用「模板 = 纯函数 render(doc)=>HTML」这一形态思路（plan §0 默认走生成轨）。
 * 因无任何 ai-resume 代码进入本包，抽取许可问题在本片不被触发（`ai-resume` 仓库所有权确认仍是 3.3/3.4 抽取轨的 `[!]` 前置门禁，未在此放宽）。
 *
 * 每个 `render` 只读 `toEntryView` 拿好的数据视图，再用各自的 Tailwind utility class 拼排版——
 * 模板里不出现字符串截断 / 日期或数字推断 / 事实新造（3.2-05），也不写 `<style>` 或 `style="`（3.2-07）。
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

/** 头部联系方式：从可选的 email/phone/location 拼一行，缺失的不占位。 */
function contactLine(doc: ResumeDocument, locale: TemplateLocale, sep: string): string {
  const { email, phone, location } = doc.profile.contact;
  const parts: string[] = [];
  if (email) parts.push(`${fieldLabel('email', locale)}: ${email}`);
  if (phone) parts.push(`${fieldLabel('phone', locale)}: ${phone}`);
  if (location) parts.push(`${fieldLabel('location', locale)}: ${location}`);
  return escapeHtml(parts.join(sep));
}

/** 把一个条目的 EntryView 渲染成三套模板共用的「标题 / 副行 / 标签值行」结构串（仅排版）。 */
function entryBody(
  section: Section,
  entryId: string,
  locale: TemplateLocale,
  templateId: string,
  rowClass: string,
  headingClass: string,
  metaClass: string,
  lineClass: string,
): string {
  const entry = section.entries.find((item) => item.id === entryId);
  if (!entry) return '';
  const view = toEntryView(templateId, section, entry, locale);
  const heading = view.heading === '' ? '' : `<div class="${headingClass}">${view.heading}</div>`;
  const meta = view.meta.map((value) => `<span class="${metaClass}">${value}</span>`).join('');
  const lines = view.lines
    .map((line) => `<div class="${lineClass}"><span>${line.label}</span><span>${line.value}</span></div>`)
    .join('');
  return `<div class="resume-entry ${rowClass}">${heading}<div class="flex gap-2">${meta}</div>${lines}</div>`;
}

/** 经典模板：居中姓名抬头 + 分隔线式区块标题，正文两端对齐（时间靠右）。 */
const classic: Template = {
  id: 'classic',
  name: '经典单栏',
  origin: 'clean-room-rewrite',
  render(doc: ResumeDocument, ctx: TemplateContext): string {
    const locale = ctx.locale;
    const sections = doc.sections
      .map((section) => {
        const heading = sectionLabel(section.kind, locale);
        const items = section.entries
          .map((entry) =>
            entryBody(
              section,
              entry.id,
              locale,
              'classic',
              'mb-2 text-justify',
              'font-semibold',
              'text-sm text-neutral-500',
              'text-sm',
            ),
          )
          .join('');
        return `<section class="mb-4"><h2 class="border-b border-neutral-300 pb-1 text-base font-bold uppercase">${heading}</h2>${items}</section>`;
      })
      .join('');
    return `<article class="font-serif text-neutral-900"><header class="mb-4 text-center"><h1 class="text-2xl font-bold">${escapeHtml(doc.profile.name)}</h1><p class="text-sm text-neutral-600">${contactLine(doc, locale, ' · ')}</p></header>${sections}</article>`;
  },
};

/** 现代模板：左对齐大姓名 + 强调色区块标题，标题与时间同行（flex 两端）。 */
const modern: Template = {
  id: 'modern',
  name: '现代双列强调',
  origin: 'clean-room-rewrite',
  render(doc: ResumeDocument, ctx: TemplateContext): string {
    const locale = ctx.locale;
    const sections = doc.sections
      .map((section) => {
        const heading = sectionLabel(section.kind, locale);
        const items = section.entries
          .map((entry) =>
            entryBody(
              section,
              entry.id,
              locale,
              'modern',
              'mb-3',
              'font-semibold text-neutral-800',
              'text-xs font-medium text-sky-600',
              'text-sm text-neutral-700',
            ),
          )
          .join('');
        return `<section class="mb-5"><h2 class="mb-1 text-sm font-bold tracking-wide text-sky-700">${heading}</h2>${items}</section>`;
      })
      .join('');
    return `<article class="text-neutral-800"><header class="mb-4 border-l-4 border-sky-500 pl-3"><h1 class="text-3xl font-extrabold">${escapeHtml(doc.profile.name)}</h1><p class="text-sm text-neutral-500">${contactLine(doc, locale, '  |  ')}</p></header>${sections}</article>`;
  },
};

/** 极简模板：无装饰、纯堆叠，最小 class 面。 */
const minimal: Template = {
  id: 'minimal',
  name: '极简黑白',
  origin: 'clean-room-rewrite',
  render(doc: ResumeDocument, ctx: TemplateContext): string {
    const locale = ctx.locale;
    const sections = doc.sections
      .map((section) => {
        const heading = sectionLabel(section.kind, locale);
        const items = section.entries
          .map((entry) => entryBody(section, entry.id, locale, 'minimal', 'mb-2', 'font-medium', 'text-xs', 'text-sm'))
          .join('');
        return `<section class="mb-3"><h2 class="mb-1 text-sm font-medium">${heading}</h2>${items}</section>`;
      })
      .join('');
    return `<article class="text-neutral-900"><header class="mb-3"><h1 class="text-xl font-semibold">${escapeHtml(doc.profile.name)}</h1><p class="text-xs">${contactLine(doc, locale, ' / ')}</p></header>${sections}</article>`;
  },
};

/** 内置模板清单——新增一套只在此追加一条数据（`template.ts` 的 list/get/render 不改，3.2-03）。 */
export const BUILTIN_TEMPLATES: Template[] = [classic, modern, minimal];
