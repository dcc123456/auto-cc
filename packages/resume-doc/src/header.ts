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

/** 条目内字段分隔：中英文竖线 / 间隔号 / 逗号分号 / 任意空白（英文公司名带空格会被切开，切多了就标待确认）。 */
const SEGMENT_SPLIT = /[|｜·•,，;；]|\s+/u;

/** 摘掉时间段后剩下的孤立标点（`-`、`至` 这类），不能让它冒充公司名进入模型。 */
const PUNCTUATION_ONLY = /^[-–—~～至到.,，;、|｜·•\s]+$/u;

/** 学位词表：教育区块里能识别出学位的那一段。 */
const DEGREE_TERM = /学士|硕士|博士|本科|大专|MBA|PhD|BSc|MSc/i;

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
