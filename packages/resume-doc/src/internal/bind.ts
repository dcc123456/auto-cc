/**
 * 模板内部基元（spec 3.2-01 / 3.2-04 / 3.2-05 / 3.2-06）：标签 i18n、HTML 转义、数据绑定与错误定位。
 *
 * 为什么单独一层：三套模板要共享同一套「读数据」逻辑（缺哪个字段就报哪个区块+字段名），
 * 复制到每套模板里就是 §2.2 禁止的第二/第三份实现。绑定与本地化集中在本文件，
 * `../internal/templates.ts` 里的模板只剩「怎么排版」——用不同的 Tailwind class 拼同一条数据视图。
 *
 * 本文件不认识具体模板，也不 import 模板注册表，保证依赖单向：bind ← templates ← template.ts。
 */
import type { Entry, ResumeDocument, Section, SectionKind } from '../model.js';

/** 模板可用的界面语言——与渲染层语言包口径一致（§5.5 至少 zh-CN 与 en）。 */
export type TemplateLocale = 'zh-CN' | 'en';

/** 渲染上下文：目前只有语言。 */
export interface TemplateContext {
  locale: TemplateLocale;
}

/** 模板来源记录（3.2-10）：本套模板全部 clean-room 重写，未抽取 `ai-resume` 任何代码。 */
export type TemplateOrigin = 'clean-room-rewrite';

/** 一套模板的最小契约。`render` 必须是 `doc + ctx` 的纯函数。 */
export interface Template {
  id: string;
  /** 面向界面的展示名（非排版文案，故不进 i18n 标签表）。 */
  name: string;
  /** 抽取来源记录（3.2-10）。 */
  origin: TemplateOrigin;
  /**
   * 把文档渲染为一段 A4 就绪的 HTML 片段。
   * @param doc 已通过 Schema 校验的简历文档
   * @param ctx 渲染上下文（语言等）
   * @returns 只含 Tailwind utility class 的 HTML 字符串；核心槽位缺数据时抛 `TemplateBindingError`
   */
  render: (doc: ResumeDocument, ctx: TemplateContext) => string;
}

/**
 * 区块标题标签（按 kind 取，模板不写死中文——3.2-06）。
 * custom 的标签只是「文档没带 title 时」的兜底；正常情况下 custom 区块展示的是简历原文标题
 * （见 `displaySectionTitle`），不会走到这里。
 */
const SECTION_LABELS: Record<TemplateLocale, Record<SectionKind, string>> = {
  'zh-CN': {
    summary: '个人简介',
    experience: '工作经历',
    education: '教育背景',
    skills: '专业技能',
    project: '项目经历',
    campus: '校园经历',
    custom: '其他信息',
  },
  en: {
    summary: 'Summary',
    experience: 'Experience',
    education: 'Education',
    skills: 'Skills',
    project: 'Projects',
    campus: 'Campus',
    custom: 'Other',
  },
};

/** 字段键标签；未登记的键回退为键名本身（宁可露出键名，绝不渲染成空白）。 */
const FIELD_LABELS: Record<TemplateLocale, Record<string, string>> = {
  'zh-CN': {
    email: '邮箱',
    phone: '电话',
    location: '所在地',
    company: '公司',
    role: '职位',
    period: '时间',
    achievement: '成果',
    description: '描述',
    school: '学校',
    degree: '学历',
    major: '专业',
    skill: '技能',
    expectRole: '期望岗位',
    expectCity: '期望城市',
    expectSalary: '期望薪资',
    expectStart: '到岗时间',
  },
  en: {
    email: 'Email',
    phone: 'Phone',
    location: 'Location',
    company: 'Company',
    role: 'Role',
    period: 'Period',
    achievement: 'Achievement',
    description: 'Description',
    school: 'School',
    degree: 'Degree',
    major: 'Major',
    skill: 'Skill',
    expectRole: 'Target role',
    expectCity: 'Target city',
    expectSalary: 'Expected salary',
    expectStart: 'Availability',
  },
};

/**
 * 取区块的本地化标题标签。
 * @param kind 区块种类
 * @param locale 目标语言
 * @returns 该语言下的固定标签（非用户数据）
 */
export function sectionLabel(kind: SectionKind, locale: TemplateLocale): string {
  return SECTION_LABELS[locale][kind] ?? SECTION_LABELS[locale].summary;
}

/**
 * 区块在纸面上真正展示的标题：custom 用文档里的原文标题（缺失时才回退 i18n 兜底），
 * 固定六类走 i18n 标签。模板与编辑器共用这一个判据，避免「PDF 是原文、界面是标签」两份口径。
 * @param section 待展示区块
 * @param locale 目标语言
 * @returns 已本地化 / 已取原文的纯文本标题（调用方插入 HTML 前仍需转义）
 */
export function displaySectionTitle(section: Section, locale: TemplateLocale): string {
  if (section.kind === 'custom') {
    const title = section.title.trim();
    return title !== '' ? title : sectionLabel('custom', locale);
  }
  return sectionLabel(section.kind, locale);
}

/**
 * 取字段键的本地化标签；未登记回退键名本身。
 * @param key 字段键
 * @param locale 目标语言
 * @returns 标签文案
 */
export function fieldLabel(key: string, locale: TemplateLocale): string {
  return FIELD_LABELS[locale][key] ?? key;
}

/**
 * HTML 转义：所有来自文档的数据（姓名 / 字段值）插入 HTML 前必须过这里。
 * 生成产物随后会被载入隐藏视图打印（3.3），不转义等于把注入面交给简历正文——这是渲染轨的系统边界防护。
 * @param raw 原始文本
 * @returns 转义 `& < > " '` 后的安全文本
 */
export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 数据绑定错误：模板声明的核心槽位在文档里缺失或为空，此处将渲染为空白（3.2-04）。 */
export class TemplateBindingError extends Error {
  readonly templateId: string;
  readonly sectionId: string;
  readonly sectionKind: SectionKind;
  readonly entryId: string;
  readonly fieldKey: string;
  constructor(templateId: string, section: Section, entry: Entry, fieldKey: string, locale: TemplateLocale) {
    super(
      `模板「${templateId}」在区块「${sectionLabel(section.kind, locale)}」(id: ${section.id}) 的条目 ${entry.id} 绑定字段「${fieldKey}」失败：数据缺失，此处将渲染为空白`,
    );
    this.name = 'TemplateBindingError';
    this.templateId = templateId;
    this.sectionId = section.id;
    this.sectionKind = section.kind;
    this.entryId = entry.id;
    this.fieldKey = fieldKey;
  }
}

/**
 * 核心槽位绑定：按 key 从条目取值，缺失或空串即抛可定位错误。
 * @param templateId 当前模板 id（错误文案用）
 * @param section 所属区块
 * @param entry 所属条目
 * @param fieldKey 字段键
 * @param locale 语言（错误文案标签用）
 * @returns 字段文本值；为空则不返回而是抛 `TemplateBindingError`
 */
export function bindField(
  templateId: string,
  section: Section,
  entry: Entry,
  fieldKey: string,
  locale: TemplateLocale,
): string {
  const value = entry.fields.find((field) => field.key === fieldKey)?.value;
  if (value === undefined || value === '') {
    throw new TemplateBindingError(templateId, section, entry, fieldKey, locale);
  }
  return value;
}

/**
 * 可选槽位绑定：装饰性展示项（如联系人的邮箱/电话）缺失即返回 null，不抛错。
 * @param entry 条目
 * @param fieldKey 字段键
 * @returns 有值返回字符串，缺省返回 null
 */
export function bindOptional(entry: Entry, fieldKey: string): string | null {
  const value = entry.fields.find((field) => field.key === fieldKey)?.value;
  return value === undefined || value === '' ? null : value;
}

/**
 * 一条「标签:值」展示格。
 * `key` 是**字段键**（不是本地化标签）：渲染轨要认出哪一格是那一类区块的正文（`bodyKeyOf`）才能只把
 * 它交给块级渲染（spec 3.9-02），而标签已经过了 i18n，按标签反推等于把语种当成排版条件。
 * `value` 是已转义的可打印文本，`raw` 是这一格的**原始值**——3.11 的打字锚点要它：纸面上的正文格是
 * `renderRichValue` 消化过的块级 HTML，`- ` 与 `**` 在 DOM 里已经是 `<li>` 与 `<strong>`，反推不回来。
 */
export interface EntryLine {
  key: string;
  label: string;
  value: string;
  raw: string;
}

/**
 * 条目视图：模板共用的「读好了的数据」中间形——把一份条目规整成标题格 + 副行格 + 标签值格。
 * 三套模板拿同一个 EntryView，各自只决定用什么 Tailwind class 包起来（3.2-05：模板只排版不加工数据）。
 *
 * 标题为什么不是一只拼好的字符串（3.11 改的这条形状）：`公司 · 职位` 在纸面上是**一格一键**的打字坐标，
 * 连成一个节点后就没人知道用户点的是公司还是职位，递回主进程等于猜。于是这里递出有序的两格，
 * ` · ` 那一个分隔符由模板层在格与格之间连——可见文本与过去逐字相同，只是节点换了。
 */
export interface EntryView {
  /** 主标题的构成格（经历/项目/校园是 公司 + 职位，教育是学校；简介/技能为空）。 */
  title: EntryLine[];
  /** 副行格（如时间）。 */
  meta: EntryLine[];
  /** 标签值格（成果 / 描述 / 学历等可选信息）。 */
  lines: EntryLine[];
}

/**
 * 把一格装成展示格：`value` 转义、`raw` 留着（两个消费者各要一样，见 `EntryLine`）。
 * @param key 字段键
 * @param label 已本地化的标签（不带冒号；不配标签的格传空串）
 * @param raw 文档里的原始值（未转义）
 * @returns 展示格
 */
function toLine(key: string, label: string, raw: string): EntryLine {
  return { key, label, value: escapeHtml(raw), raw };
}

/**
 * 按区块种类把条目规整成展示视图（唯一的「读数据」实现，被所有模板复用）。
 * 核心槽位（经历/项目/校园的 公司+职位、教育的 学校）用 `bindField`——缺了就报可定位错误（3.2-04）；
 * 其余为可选展示（`bindOptional`）。summary / skills 逐字段平铺，不设必选槽。
 * @param templateId 当前模板 id（错误文案用）
 * @param section 所属区块
 * @param entry 条目
 * @param locale 语言
 * @returns 规整好的 EntryView（`value` 已转义，`raw` 未转义）
 */
export function toEntryView(templateId: string, section: Section, entry: Entry, locale: TemplateLocale): EntryView {
  const title: EntryLine[] = [];
  const meta: EntryLine[] = [];
  const lines: EntryLine[] = [];

  /** 必选槽：缺失照旧抛 `TemplateBindingError`（错误文案要的是"哪个区块的哪一格"）。 */
  const pushRequired = (target: EntryLine[], key: string): void => {
    target.push(toLine(key, '', bindField(templateId, section, entry, key, locale)));
  };
  /** 可选槽：这一格没有值就整个不出现（3.1-04 的容错）。 */
  const pushOptional = (target: EntryLine[], key: string, label: string): void => {
    const value = bindOptional(entry, key);
    if (value !== null) target.push(toLine(key, label, value));
  };

  if (section.kind === 'experience' || section.kind === 'project' || section.kind === 'campus') {
    pushRequired(title, 'company');
    pushRequired(title, 'role');
    pushOptional(meta, 'period', '');
    pushOptional(lines, 'achievement', fieldLabel('achievement', locale));
    pushOptional(lines, 'description', fieldLabel('description', locale));
  } else if (section.kind === 'education') {
    pushRequired(title, 'school');
    pushOptional(meta, 'period', '');
    pushOptional(lines, 'degree', fieldLabel('degree', locale));
    pushOptional(lines, 'major', fieldLabel('major', locale));
  } else {
    // summary / skills / custom：无必选槽，逐字段平铺。自由正文键 `text` 不配标签（否则会把键名 "text" 印进 PDF），
    // 其余仍走 fieldLabel——未登记键名照旧露出，与 `fieldLabel` 的「绝不渲染空白」口径一致。
    for (const field of entry.fields) {
      if (field.value === '') continue;
      lines.push(toLine(field.key, field.key === 'text' ? '' : fieldLabel(field.key, locale), field.value));
    }
  }
  return { title, meta, lines };
}
