/**
 * 简历起止时间的归一化（spec 4.1-03）。
 *
 * 中文简历里的时间写法散得离谱（`2021.03-2023/11`、`2021年3月至今`、`2019 - 2022`、`至今`、全角数字），
 * 但下游三处都要求**可比较**：知识库的实体排序、JD 缺口比对里的年限计算、事实锁定字段的回填。
 * 因此这里把任意写法压成 `YYYY` 或 `YYYY-MM` 两种标准串，认不出的一律留 `null` 并报 `issues`——
 * **宁缺勿造**（spec 4.1-04）：猜出来的时间会伪装成事实，比空着危害更大。
 *
 * 抽取来源标注（spec 4.1-12）：思路参考 `ai-resume` 的 `server/src/utils/fileParser.ts`
 * （它同样把自由文本时间段归一化），但本文件**未复制其任何一行代码**——该仓库只在 README 里声明 MIT、
 * 仓库内没有 `LICENSE` 文件（书面授权状态见 `docs/specs/03-resume-pdf/spec.md` 的 3.3-13，仍为 `[!]`），
 * 所以按最严口径处理：只借概念，实现自写。
 */

/** 归一后的时间跨度粒度：`month` 两端都到月、`year` 至少有一端只到年、`none` 一整端都没认出来。 */
export type PeriodPrecision = 'month' | 'year' | 'none';

/**
 * 归一化过程中丢掉或存疑的信息（界面据此打「待确认」标，spec 4.1-04）。
 * `empty` 输入为空；`unparsable` 有字但没认出任何时间；`missing-start` / `missing-end` 只认出一端；
 * `reversed-range` 终点早于起点；`ambiguous-end` 既给了终点又写了「至今」；`stray-digits` 时间串里还剩没吃干净的数字。
 */
export type PeriodIssue =
  'empty' | 'unparsable' | 'missing-start' | 'missing-end' | 'reversed-range' | 'ambiguous-end' | 'stray-digits';

/** 一条归一化后的起止时间。`from` / `to` 是 `YYYY` 或 `YYYY-MM` 串，认不出即 `null`，不做任何填充。 */
export interface ParsedPeriod {
  from: string | null;
  to: string | null;
  /** 是否为「至今」语义；为 true 时 `to` 一律留 `null`，由展示方按当前时间渲染。 */
  isCurrent: boolean;
  precision: PeriodPrecision;
  issues: readonly PeriodIssue[];
}

/** 一个时间端点及其在原文中的位置（`extractPeriod` 要靠位置把时间段从标题行里摘掉）。 */
interface Endpoint {
  value: string;
  start: number;
  end: number;
}

/** 全角数字与全角点号 → 半角（中文简历里 `２０２１．０３` 是真实存在的写法）。 */
function toHalfWidth(text: string): string {
  return text.replace(/[\uFF10-\uFF19\uFF0E\uFF0F\uFF1A]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) - 0xfee0),
  );
}

/**
 * 一个时间端点：`2021.03` / `2021/3` / `2021年3月` / `2021-03` / `2021 03` / `2021`。
 * 年-月分支排在年份分支之前，靠正则的「最左 + 分支优先」保证 `2021.03` 不会被拆成 `2021` 加残串。
 * 三处 `(?!\d)` 是防误吃的关键：`2019 - 2022` 里若允许月份只吃 `2`，终点就被吞成了 `2019-02`；
 * 月份只接受 1–12，`2021.13` 这类畸形串退回年份分支，剩下的数字由 `stray-digits` 抓到。
 */
const DATE_TOKEN =
  /(?<!\d)(?<year>\d{4})(?!\d)(?:(?:\s*(?:[./\-–—~～]\s*|年\s*))(?<month>0?[1-9]|1[0-2])(?!\d)\s*月?)?/g;

/** 「至今」的等价写法；单独一个 `今` 只有在句末（后接空白或标点、前面是分隔符）时才算，避免把「今天入职」误判成至今。 */
const CURRENT_TOKEN = /至今|至现在|到现在|present|current|now|(?:^|[\s\-–—~～至到])今(?=[\s，,。;；]|$)/i;

/** 端点之前的分隔符——出现在某个时间**之前**就说明它是终点（`- 2024` 表示「起始年未知的 2024 年结束」）。 */
const LEADING_SEPARATOR = /(?:[-–—~～至到])\s*$/;

/**
 * 把 `2021.03` 形态的匹配转成标准串。
 * @param yearStr 四位年份字面量
 * @param monthStr 月份字面量，可能带前导零，也可能整体缺失
 * @returns `YYYY-MM`（月份存在）或 `YYYY`（只有年份）
 */
function canonical(yearStr: string, monthStr: string | undefined): string {
  if (monthStr === undefined || monthStr === '') return yearStr;
  return `${yearStr}-${monthStr.padStart(2, '0')}`;
}

/** 取标准串的可比较键：只有年份时补 `00` 月，让 `2021` 与 `2021-03` 能在同一刻度上比先后。 */
function compareKey(value: string): string {
  return value.length === 4 ? `${value}00` : value.replace('-', '');
}

/** 一个标准串是否到月（决定整段的 `precision`）。 */
function hasMonth(value: string): boolean {
  return value.length > 4;
}

/** 从文本里摘出至多两个时间端点，并定位「至今」写法（无则 `null`）。 */
function locate(text: string): { endpoints: Endpoint[]; current: [number, number] | null } {
  const endpoints: Endpoint[] = [];
  for (const match of text.matchAll(DATE_TOKEN)) {
    const year = match.groups?.year;
    if (year === undefined || match.index === undefined) continue;
    endpoints.push({
      value: canonical(year, match.groups?.month),
      start: match.index,
      end: match.index + match[0].length,
    });
    if (endpoints.length === 2) break;
  }
  const found = text.match(CURRENT_TOKEN);
  const index = found?.index;
  const current: [number, number] | null = index === undefined ? null : [index, index + found![0].length];
  return { endpoints, current };
}

/** 摘掉端点跨度（两个端点时连同中间的分隔符一起摘）与「至今」跨度，剩下的就是没吃干净的文本。 */
function cutSpans(text: string, spans: readonly (readonly [number, number])[]): string {
  const keep = Array.from({ length: text.length }, () => true);
  for (const [start, end] of spans) {
    for (let index = Math.max(start, 0); index < Math.min(end, text.length); index += 1) keep[index] = false;
  }
  return text
    .split('')
    .filter((_, index) => keep[index])
    .join('');
}

/** 待挖掉的跨度：有端点就取「首端点起点 → 末端点终点」整段（中间只可能是分隔符），再加上「至今」跨度。 */
function spanOf(endpoints: readonly Endpoint[], current: readonly [number, number] | null): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const [first] = endpoints;
  const last = endpoints[endpoints.length - 1];
  if (first !== undefined && last !== undefined) spans.push([first.start, last.end]);
  if (current !== null) spans.push([current[0], current[1]]);
  return spans;
}

/**
 * 判残留用的跨度：只挖每个端点**自己**的字面，保留中间的分隔符。
 * 与 `spanOf` 的区别只为抓畸形写法——`2021.13 - 2022` 若按整段挖掉，那个不该存在的 `13`
 * 就被静默吞了；只挖端点才会把它留在残渣里，进而报 `stray-digits`。
 */
function tokenSpanOf(
  endpoints: readonly Endpoint[],
  current: readonly [number, number] | null,
): Array<[number, number]> {
  const spans = endpoints.map((endpoint) => [endpoint.start, endpoint.end] as [number, number]);
  if (current !== null) spans.push([current[0], current[1]]);
  return spans;
}

/**
 * 归一化一段自由文本，同时给出**摘掉时间段之后**的剩余文本。
 *
 * 只取前两个时间端点：`2019-2023 参与 2020 项目` 里第三个数字属于正文，
 * 多认一个就会把不相干的年份当成终点，所以剩下没吃干净的数字统一记 `stray-digits`。
 * @param input 原始文本（简历标题行里的一段，允许全角、任意分隔符、「至今」写法）
 * @returns `period` 为归一结果；`rest` 为去掉时间跨度后的文本，供上层继续拆「公司 · 职位」
 */
export function extractPeriod(input: string): { period: ParsedPeriod; rest: string } {
  const text = toHalfWidth(input).trim();
  if (text === '') {
    return { period: { from: null, to: null, isCurrent: false, precision: 'none', issues: ['empty'] }, rest: '' };
  }

  const { endpoints, current } = locate(text);
  const isCurrentWritten = current !== null;
  const rest = cutSpans(text, spanOf(endpoints, current));
  const issues: PeriodIssue[] = /\d{2,}/.test(cutSpans(text, tokenSpanOf(endpoints, current))) ? ['stray-digits'] : [];

  const first = endpoints[0];
  const second = endpoints[1];

  if (first === undefined || second === undefined) {
    if (first === undefined) {
      return {
        period: {
          from: null,
          to: null,
          isCurrent: isCurrentWritten,
          precision: 'none',
          issues: isCurrentWritten ? [...issues, 'missing-start'] : [...issues, 'unparsable'],
        },
        rest,
      };
    }
    const only = first.value;
    const precision: PeriodPrecision = hasMonth(only) ? 'month' : 'year';
    if (isCurrentWritten) {
      return { period: { from: only, to: null, isCurrent: true, precision, issues }, rest };
    }
    if (LEADING_SEPARATOR.test(text.slice(0, first.start))) {
      return {
        period: { from: null, to: only, isCurrent: false, precision, issues: [...issues, 'missing-start'] },
        rest,
      };
    }
    return { period: { from: only, to: null, isCurrent: false, precision, issues: [...issues, 'missing-end'] }, rest };
  }

  if (isCurrentWritten) issues.push('ambiguous-end');
  if (compareKey(second.value) < compareKey(first.value)) issues.push('reversed-range');
  return {
    period: {
      from: first.value,
      to: second.value,
      isCurrent: false,
      precision: hasMonth(first.value) && hasMonth(second.value) ? 'month' : 'year',
      issues,
    },
    rest,
  };
}

/**
 * 把一段自由文本里的起止时间归一化。
 * @param input 原始时间文本（允许全角、任意分隔符、「至今」写法、以及根本不含时间的正文）
 * @returns 归一结果；输入为空返回 `issues: ['empty']`，完全认不出返回 `issues: ['unparsable']`，两者都不抛异常
 */
export function parsePeriod(input: string): ParsedPeriod {
  return extractPeriod(input).period;
}
