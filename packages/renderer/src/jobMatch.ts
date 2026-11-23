/**
 * 岗位「为什么在这一屏」的**确定性推导**（2026-11-23 管理员裁定：匹配理由必须是真理由）。
 *
 * 裁定否掉的两种写法：① 复述筛选条件（「这一屏按你的筛选条件取回」——那不是解释匹配）；
 * ② 调模型编一段「匹配度 92%」——本仓没有匹配打分，编数字就是对用户说谎（8.10-04 同一口径）。
 *
 * 所以这里只做**能逐项核对**的事：拿这一行的结构化字段与本次搜索条件比一遍，命中的给「种类 + 取值」；
 * 一条都不命中就说「未命中可解释的条件」，不硬凑。**本模块不产出任何上屏文案**（§5.5）：
 * 文案在语言包里按 `jd.matchHit.<kind>` 渲染，翻译与术语替换才不会漏掉这些理由。
 */
import type { JobRowView } from '@auto-cc/shared';

/** 本次搜索用的条件（与 `JobSearchCriteriaView` 同形；这里只用可比的几项）。 */
export type MatchCriteria = {
  keyword?: string;
  city?: string;
  cityDistrict?: string;
  experience?: string;
  degree?: string;
  salary?: string;
};

/** 一条可解释的命中：种类 + 取值（薪资那一条另带本岗位原文）。 */
export type MatchHit = {
  kind: 'keywordTitle' | 'keywordBody' | 'city' | 'district' | 'experience' | 'degree' | 'salary';
  value: string;
  /** 薪资相交时补「本岗位原文」，别的一律空串。 */
  extra: string;
};

/**
 * 从薪资原文里读出区间（单位：K/月）。
 * @param text 平台原文，如「15-25K·14薪」「3-5K」「20K以上」「面议」
 * @returns `[下界, 上界]`；面议或认不出时为 null
 */
export function salaryRangeOf(text: string): [number, number] | null {
  const numbers = text.replace(/,/g, '').match(/\d+(\.\d+)?/g);
  if (numbers === null || numbers.length === 0) return null;
  const values = numbers.map(Number).filter((value) => Number.isFinite(value));
  if (values.length === 0) return null;
  const low = Math.min(...values);
  const high = values.length > 1 ? Math.max(...values) : low;
  return [low, high];
}

/**
 * 按本次条件推导「这一行凭什么被选中」。
 * @param row 库内岗位行（抓取来的，不可信输入；这里只做字符串与数值比较）
 * @param criteria 本次搜索条件（人话标签，与知识包码表一致）
 * @returns 命中清单（关键词 → 城市/区 → 经验 → 学历 → 薪资）；空数组表示没有可解释的命中
 */
export function matchHits(row: JobRowView, criteria: MatchCriteria): MatchHit[] {
  const hits: MatchHit[] = [];
  const keyword = criteria.keyword?.trim() ?? '';
  if (keyword !== '') {
    if (row.title.includes(keyword)) hits.push({ kind: 'keywordTitle', value: keyword, extra: '' });
    else if (row.description.includes(keyword)) hits.push({ kind: 'keywordBody', value: keyword, extra: '' });
  }
  const city = criteria.city?.trim() ?? '';
  if (city !== '' && row.city.startsWith(city)) hits.push({ kind: 'city', value: city, extra: '' });
  const district = criteria.cityDistrict?.trim() ?? '';
  if (district !== '' && row.city.includes(district)) hits.push({ kind: 'district', value: district, extra: '' });
  const experience = criteria.experience?.trim() ?? '';
  if (experience !== '' && row.experience.replace(/\s+/g, '') === experience.replace(/\s+/g, '')) {
    hits.push({ kind: 'experience', value: experience, extra: '' });
  }
  const degree = criteria.degree?.trim() ?? '';
  if (degree !== '' && row.education.replace(/\s+/g, '') === degree.replace(/\s+/g, '')) {
    hits.push({ kind: 'degree', value: degree, extra: '' });
  }
  const salary = criteria.salary?.trim() ?? '';
  const wanted = salary === '' ? null : salaryRangeOf(salary);
  const actual = salaryRangeOf(row.salaryText);
  if (wanted !== null && actual !== null) {
    // 区间相交即算命中：这是「能核对」的口径，不推断「偏高/偏低」这类含义。
    const overlap = Math.min(wanted[1], actual[1]) - Math.max(wanted[0], actual[0]);
    if (overlap >= 0) hits.push({ kind: 'salary', value: salary, extra: row.salaryText });
  }
  return hits;
}
