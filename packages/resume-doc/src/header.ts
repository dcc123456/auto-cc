/**
 * 条目首行 → 文档模型字段：抬头装配的纯函数（plan 03 §13 的 63-a，从 `resume-kb` 的 `sections.ts` 搬来）。
 *
 * 为什么住在这一层而不是解析层：这四支函数产出的 `company` / `role` / `period` / `school` 是**文档模型的字段键**
 * （`model.ts` 的 `SectionKind` 与 `factKeyOf` 都在这一层），而依赖方向是 kb→doc（`resume-kb` 声明
 * `@auto-cc/plugin-resume-doc`），反向会成环并被 eslint boundaries 拦。手动拆分条目（63-b）要在编辑器里
 * 按**同一条规则**重装拆出来那一半的抬头，复用只能建立在这个归属上（§2.1 一处真相，不许在编辑器里再写一份）。
 *
 * 行为与搬家前逐字相同：函数体、判据、注释口径一字未改，改的只有位置与 import。
 */
import { makeField, type Field, type SectionKind } from './model.js';
import { extractPeriod, type ParsedPeriod } from './period.js';
import { BULLET_MARK, keepPairedEmphasis, NESTED_INDENT } from './richtext.js';

/**
 * 行首装饰：Markdown 的 `#`、项目符号、有序列表号，以及中文简历惯用的汉字序号（`一、`、`（二）`、`第三章`）。
 *
 * 汉字序号那一支**必须带括号对或分隔符**（`（二）` / `二、` / `二.`），裸汉字数字不算序号：
 * 中文简历的正文行常以数字开头（「八年前端经验」「五年后端工程师」），旧写法把括号、右括号与分隔符
 * 三段全设成可选，于是行首那个「八」被当装饰吃掉，正文首字静默丢失（在线简历表单的求职意向正文里实测到）。
 */
const LEADING_MARKUP =
  /^\s*(?:#{1,6}\s*|(?:[-+•·]|\*(?!\*))\s*|\d+[.、)]\s*|[（(【]\s*[一二三四五六七八九十百]+\s*[）)】]\s*[、.．:：]?\s*|[一二三四五六七八九十百]+\s*[、.．:：]\s*|第\s*[一二三四五六七八九十\d]+\s*[章节部分讲]\s*[、.．:：]?\s*)/u;

/** 条目内字段分隔：中英文竖线 / 间隔号 / 逗号分号 / 任意空白（英文公司名带空格会被切开，切多了就标待确认）。 */
const SEGMENT_SPLIT = /[|｜·•,，;；]|\s+/u;

/** 摘掉时间段后剩下的孤立标点（`-`、`至` 这类），不能让它冒充公司名进入模型。 */
const PUNCTUATION_ONLY = /^[-–—~～至到.,，;、|｜·•\s]+$/u;

/** 学位词表：教育区块里能识别出学位的那一段。 */
const DEGREE_TERM = /学士|硕士|博士|本科|大专|MBA|PhD|BSc|MSc/i;

/**
 * 去掉一行开头的 Markdown 标记与加粗符号，得到纯文字（**装饰一律删掉**那一支）。
 *
 * 与 `splitHeader` 一起住在这一层的理由：导入时"摘装饰 → 拆抬头"是**一条**规则的两步（`sections.ts`
 * 先剥装饰再喂 `splitHeader`），手动拆分（63-b）要对拆出来那一行说同一句话，
 * 只搬后半截会让编辑器把 `（二）` 当成公司名。
 * @param line 原始行
 * @returns 去掉装饰后的行文本（可能为空串）
 */
export function stripLineMarkup(line: string): string {
  return stripDecorations(line, false);
}

/**
 * 摘掉行首装饰与强调符号的公共骨架，`**` 的去留由调用方决定。
 * @param line 原始行
 * @param keepEmphasis true = 成对的 `**…**` 留给渲染层（正文那一支）；false = 连成对的一起删（抬头与标题判定）
 * @returns 处理后的行文本
 */
function stripDecorations(line: string, keepEmphasis: boolean): string {
  const withoutLeading = line.replace(LEADING_MARKUP, '');
  const withoutMarkers = keepEmphasis ? keepPairedEmphasis(withoutLeading) : withoutLeading.replace(/\*\*|__|`/g, '');
  return withoutMarkers.trim();
}

/** 行首**项目符号**那一族：只有真正的符号才算列表项——`1.` / `（二）` 这类序号在本语法里刻意不当列表
 * （它与 4.5-08 的数字守恒判据同族冲突，记账见 spec 4.5-15 的反向验证段），`**` 也不在这里被认成符号。
 *
 * 两个分支的空格要求不同，是实测形状逼出来的：pdf.js 的 `str` 会把同一行的两列直接拼起来（中间没有空格项时
 * 就是「•订单服务重构」），所以版面圆点那一族**不许**强制空格；而 ASCII 的 `-` / `+` / `*` 必须带空格——
 * 换行切断的日期片段（`-2024.06`）与区间（`~` 那族已在别处归零）不带空格，把它们当列表项会凭空造出一条条目。 */
const LEADING_BULLET = /^\s*(?:[•·‣◦▪●○]\s*|(?:[-+]|\*(?!\*))\s+)/u;

/**
 * 把一条**正文行**归一到封闭文法（spec 4.1-18；文法的定义只在 `src/richtext.ts` 那一处）。
 *
 * 与 `stripLineMarkup` 的分工必须说清：那一支的语义是「删掉装饰」，用于抬头装配与标题判定；
 * 这一支的语义是「识别并归一保留」——项目符号换成 `- `/`  - `，成对的 `**…**` 留给渲染层、
 * 落单的删掉（spec 4.1-18 原文的那半句），其余行的**行首装饰**处理与过去逐字相同。
 * 之所以只此一步：真实 PDF 文本层里本来就有 682 个符号字符（plan 03 §14 的 S1 读数），
 * 过去被删得一个不剩，纸面上就只剩自动换行。层级不靠猜符号，吃的是 `source.ts` 按左 x 写进来的缩进档。
 * @param line 原始行（可含行首缩进与项目符号）
 * @returns 带封闭标记的行；非符号行返回「只保留成对加重」的纯文本
 */
export function normalizeRichLine(line: string): string {
  const withoutIndent = line.replace(/^ +/u, '');
  if (!LEADING_BULLET.test(withoutIndent)) return stripDecorations(line, true);
  const deep = line.length - withoutIndent.length >= NESTED_INDENT.length;
  const matched = LEADING_BULLET.exec(withoutIndent)?.[0] ?? '';
  const rest = keepPairedEmphasis(withoutIndent.slice(matched.length).trim());
  // 一行只有符号没有内容（扫描件里偶见的装饰残块）：不产出空列表项，交回原判定。
  if (rest === '') return stripDecorations(line, true);
  return `${deep ? NESTED_INDENT : ''}${BULLET_MARK}${rest}`;
}

/**
 * 把归一化的时间转成写回简历 `period` 字段的标准文本。
 * @param period `parsePeriod` 的结果
 * @returns `2021-03 - 2023-11` 或 `2021-03 - 至今` 形态；两端都没认出来时返回 `null`（由调用方记待确认）
 */
export function periodText(period: ParsedPeriod): string | null {
  if (period.from === null && period.to === null) return null;
  const end = period.isCurrent ? '至今' : (period.to ?? '');
  if (period.from === null) return end === '' ? null : `- ${end}`;
  return end === '' ? period.from : `${period.from} - ${end}`;
}

/**
 * 把经历类区块的首行拆成「时间段」与「名称段」。
 *
 * 时间先整段摘掉再拆名字，是因为范围写法常跨空格（`2019 - 2022`）——若先按空白切开，
 * 孤立的 `-` 和半个年份就会冒充成公司名。摘完后仍剩下的标点段一并丢弃。
 * @param headerLine 区块内一条经历的首行
 * @returns 认出的时间（含 issues，供上层转待确认）与剩下的名称段；一个端点都没认出时 `period` 为 `null`
 */
export function splitHeader(headerLine: string): { period: ParsedPeriod | null; titles: string[] } {
  const { period, rest } = extractPeriod(headerLine);
  const titles = rest
    .split(SEGMENT_SPLIT)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && !PUNCTUATION_ONLY.test(segment));
  // `unparsable` 说明这行压根没有四位年份形态的东西：当作「没有时间」，不能拿整行当时间。
  const recognized = period.precision === 'none' && !period.isCurrent ? null : period;
  return { period: recognized, titles };
}

/**
 * 由「名称段」装配经历 / 项目 / 校园区块的 company / role 字段。
 * @param kind 区块种类（决定 `makeField` 的事实锁定判定）
 * @param titles 去掉时间段后剩下的段
 * @returns 字段数组；一段都没有时返回空数组，由调用方记 `missing-field`
 */
export function companyRoleFields(kind: SectionKind, titles: readonly string[]): Field[] {
  const [company, ...rest] = titles;
  if (company === undefined) return [];
  const fields = [makeField(kind, 'company', company)];
  const role = rest.join(' ');
  if (role !== '') fields.push(makeField(kind, 'role', role));
  return fields;
}

/**
 * 装配教育区块的 school / degree / major 字段。
 * @param titles 去掉时间段后剩下的段
 * @returns 字段数组；首段作学校，命中学位词的段作学位，其余拼成专业
 */
export function educationFields(titles: readonly string[]): Field[] {
  const [school, ...rest] = titles;
  if (school === undefined) return [];
  const fields = [makeField('education', 'school', school)];
  const degree = rest.find((segment) => DEGREE_TERM.test(segment));
  const majors = rest.filter((segment) => segment !== degree).join(' ');
  if (degree !== undefined) fields.push(makeField('education', 'degree', degree));
  if (majors !== '') fields.push(makeField('education', 'major', majors));
  return fields;
}
