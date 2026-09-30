/**
 * JD 字段的**纯归一化**（spec 2.3-02 / 2.3-03）。
 *
 * 放在 `platform-boss` 而不是 `browser`：`browser` 只负责「把页面读成文本」，
 * 而「25-40K·14薪 意味着什么」是招聘领域的判断，换平台时要换的是这套规则的解释，
 * 不是页面通道（plan §10.3 规则 3）。
 *
 * 全部是纯函数：不碰 `Date.now()`（时间基准由调用方注入）、不碰 DOM、不碰数据库，
 * 所以 2.3-03 的每条判据都能在单测里逐个字符串断言，不需要开窗口。
 *
 * 一条铁律：**归一化不做「猜不出来就编」的事**。读不懂的薪资回 `isNegotiable:true` + 中性值，
 * 读不懂的时间回 `null`，原文永远另存一列——界面要能对照「我们读到的」与「我们理解的」。
 */
import type { SalaryView } from '@auto-cc/shared';

/** 面议类写法：这几一种是「没有公开数字」的同一种意思，不是解析失败。 */
const NEGOTIABLE = /(面议|面谈|电议|薪资待定)/;

/** 全角数字与全角横杠：站点（尤其仿站的手写数据）混用很常见，先折叠成半角再解析。 */
const FULL_WIDTH_ASCII = /[\uFF01-\uFF5E]/g;
const DASH = /[-–—~～]/;

/** 数字（允许小数，因为「1.8-2.5万」是真实写法）。 */
const NUMBER = String.raw`\d+(?:\.\d+)?`;

/**
 * 折叠空白并去掉零宽字符。
 *
 * 页面 `innerText` 会带换行、不间断空格和（少数站点）零宽字符，直接落库会让「同一岗位」
 * 因为空白差异变成两行——而幂等键正是 URL + 标题（spec 2.3-04）。
 * @param raw 页面读回的原始文本（可以为 null / 非字符串）
 * @returns 单一空格分隔、首尾修剪后的文本；非字符串输入回空串
 */
export function cleanText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 归一化薪资文本（spec 2.3-03）。
 *
 * 支持的写法来自 plan §10.2 的实测样本：`25-40K·14薪`、`30-45K`、`1.8-2.5万·15薪`、
 * `40-60K·16薪`、`面议`，以及单个数字（`20K`）和 `/年` 后缀。
 * `min` / `max` 的**数量级就是 `unit` 本身**（`25-40K` 是 25 与 40 + unit `k`；
 * `1.8-2.5万` 是 1.8 与 2.5 + unit `wan`），换算成月薪留给展示层，避免这里替用户选口径。
 * @param raw 薪资原文（如「25-40K·14薪」）
 * @returns 归一化薪资；面议与读不懂时为中性值且 `isNegotiable:true`
 */
export function parseSalary(raw: unknown): SalaryView {
  const neutral: SalaryView = {
    min: null,
    max: null,
    unit: 'unknown',
    period: 'unknown',
    salaryMonths: null,
    isNegotiable: true,
  };
  const text = cleanText(raw)
    .replace(FULL_WIDTH_ASCII, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .toLowerCase();
  if (!text || NEGOTIABLE.test(text)) return neutral;

  const salaryMonthsMatch = /·?(\d+(?:\.\d+)?)薪/.exec(text);
  const salaryMonths = salaryMonthsMatch ? Number(salaryMonthsMatch[1]) : null;
  const period: SalaryView['period'] = /年薪|\/年|每年/.test(text) ? 'year' : 'month';

  const unit: SalaryView['unit'] = text.includes('万')
    ? 'wan'
    : /k/.test(text)
      ? 'k'
      : text.includes('元')
        ? 'yuan'
        : 'unknown';
  if (unit === 'unknown') return neutral;

  const range = new RegExp(`(${NUMBER})${DASH.source}(${NUMBER})`).exec(text);
  const single = range ? null : new RegExp(`(${NUMBER})`).exec(text);
  const min = range ? Number(range[1]) : single ? Number(single[1]) : null;
  const max = range ? Number(range[2]) : single ? Number(single[1]) : null;
  if (min === null || max === null || !Number.isFinite(min) || !Number.isFinite(max)) return neutral;

  return {
    min: Math.min(min, max),
    max: Math.max(min, max),
    unit,
    period,
    salaryMonths,
    isNegotiable: false,
  };
}

/**
 * 把详情页的任职要求拆成条目。
 *
 * 站点把要求写成一段（`3 年 TypeScript 经验；熟悉 Electron；…`）或带序号的列表都有，
 * 这里只按分隔符拆、去掉行首序号，**不做语义归纳**——归纳是 2.7 简历定制的事。
 * @param raw 任职要求原文
 * @returns 条目数组；空文本回空数组，单条空行不会产生空字符串
 */
export function splitRequirements(raw: unknown): string[] {
  return cleanText(raw)
    .split(/[\n；;。]/)
    .map((item) => item.replace(/^\s*\d+[.、)）]\s*/, '').trim())
    .filter(Boolean);
}

/**
 * 把「相对时间」写法折算成时间戳（spec 2.3-03 的另一半）。
 *
 * 支持 `刚刚` / `X 分钟前` / `X 小时前` / `X 天前` / `今天` / `昨天` / `前天` /
 * `YYYY-MM-DD`（按当天 00:00 的本地时刻）。
 * @param raw 发布时间原文
 * @param nowMs 计算基准（毫秒，由调用方注入而不是内部取，否则单测要等时钟）
 * @returns 时间戳；写法认不出来时 `null`（原文照存，不猜）
 */
export function parsePostedAt(raw: unknown, nowMs: number): number | null {
  const text = cleanText(raw);
  if (!text) return null;
  const minute = /(\d+)\s*分钟前/.exec(text);
  if (minute) return nowMs - Number(minute[1]) * 60_000;
  const hour = /(\d+)\s*(?:小时|个小时)前/.exec(text);
  if (hour) return nowMs - Number(hour[1]) * 3_600_000;
  const day = /(\d+)\s*天前/.exec(text);
  if (day) return nowMs - Number(day[1]) * 86_400_000;
  if (/刚刚|新发布/.test(text)) return nowMs;
  const absolute = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (absolute) {
    const stamp = new Date(Number(absolute[1]), Number(absolute[2]) - 1, Number(absolute[3])).getTime();
    return Number.isFinite(stamp) ? stamp : null;
  }
  if (text === '今天') return nowMs;
  if (text === '昨天') return nowMs - 86_400_000;
  if (text === '前天') return nowMs - 2 * 86_400_000;
  return null;
}
