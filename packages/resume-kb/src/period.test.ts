/**
 * `parsePeriod` 的参数化单测（spec 4.1-03，要求 ≥8 例）。
 *
 * 用例全部来自真实简历里出现过的写法：分隔符混用（`.` `/` `-` `~` `–` `—` `至`）、中文年月、
 * 全角数字、只有起点、只有终点、整段只写「至今」、以及**该拒绝**的畸形串。
 * 最后这一类是重点：认不出必须留 `null` 并报 issue，绝不返回一个看起来合法的时间（spec 4.1-04）。
 */
import { describe, expect, it } from 'vitest';
import { parsePeriod, type PeriodIssue, type PeriodPrecision } from './period.js';

interface PeriodCase {
  readonly label: string;
  readonly input: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly isCurrent: boolean;
  readonly precision: PeriodPrecision;
  readonly issues: readonly PeriodIssue[];
}

const CASES: readonly PeriodCase[] = [
  {
    label: '点分起点 + 斜杠终点',
    input: '2021.03-2023/11',
    from: '2021-03',
    to: '2023-11',
    isCurrent: false,
    precision: 'month',
    issues: [],
  },
  {
    label: '中文年月 + 至今',
    input: '2021年3月至今',
    from: '2021-03',
    to: null,
    isCurrent: true,
    precision: 'month',
    issues: [],
  },
  {
    label: '整段只有至今',
    input: '至今',
    from: null,
    to: null,
    isCurrent: true,
    precision: 'none',
    issues: ['missing-start'],
  },
  {
    label: '两端只到年',
    input: '2019 - 2022',
    from: '2019',
    to: '2022',
    isCurrent: false,
    precision: 'year',
    issues: [],
  },
  {
    label: '波浪号分隔',
    input: '2015.09~2019.06',
    from: '2015-09',
    to: '2019-06',
    isCurrent: false,
    precision: 'month',
    issues: [],
  },
  {
    label: '单位数月补零',
    input: '2020/1 - 2020/12',
    from: '2020-01',
    to: '2020-12',
    isCurrent: false,
    precision: 'month',
    issues: [],
  },
  {
    label: '长破折号 + 汉字「至」',
    input: '2018.07 — 2020 至 2021.06',
    from: '2018-07',
    to: '2020',
    isCurrent: false,
    precision: 'year',
    issues: ['stray-digits'],
  },
  {
    label: '全角数字',
    input: '２０２１．０３-２０２３．１１',
    from: '2021-03',
    to: '2023-11',
    isCurrent: false,
    precision: 'month',
    issues: [],
  },
  {
    label: '起点到月、终点只到年',
    input: '2021.03 - 2024',
    from: '2021-03',
    to: '2024',
    isCurrent: false,
    precision: 'year',
    issues: [],
  },
  {
    label: '只有终点（前置分隔符）',
    input: '- 2024',
    from: null,
    to: '2024',
    isCurrent: false,
    precision: 'year',
    issues: ['missing-start'],
  },
  {
    label: '只有起点',
    input: '2024.02',
    from: '2024-02',
    to: null,
    isCurrent: false,
    precision: 'month',
    issues: ['missing-end'],
  },
  {
    label: '终点早于起点',
    input: '2023.05-2021.08',
    from: '2023-05',
    to: '2021-08',
    isCurrent: false,
    precision: 'month',
    issues: ['reversed-range'],
  },
  {
    label: '既给终点又写至今',
    input: '2019-2023 至今',
    from: '2019',
    to: '2023',
    isCurrent: false,
    precision: 'year',
    issues: ['ambiguous-end'],
  },
  {
    label: '畸形月份不被编造成时间',
    input: '2021.13 - 2022',
    from: '2021',
    to: '2022',
    isCurrent: false,
    precision: 'year',
    issues: ['stray-digits'],
  },
  {
    label: '纯中文相对时间一概不猜',
    input: '最近三年',
    from: null,
    to: null,
    isCurrent: false,
    precision: 'none',
    issues: ['unparsable'],
  },
  {
    label: '空输入',
    input: '   ',
    from: null,
    to: null,
    isCurrent: false,
    precision: 'none',
    issues: ['empty'],
  },
];

describe('4.1-03 时间归一化', () => {
  it.each(CASES)('$label：$input', ({ input, from, to, isCurrent, precision, issues }) => {
    expect(parsePeriod(input)).toEqual({ from, to, isCurrent, precision, issues });
  });

  it('用例数量满足 spec 的 ≥8 例下限', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(8);
  });

  it('认不出时四个槽全空，不给界面留可被误信的值', () => {
    const parsed = parsePeriod('工作期间');
    expect(parsed.from).toBeNull();
    expect(parsed.to).toBeNull();
    expect(parsed.isCurrent).toBe(false);
    expect(parsed.precision).toBe('none');
  });

  it('描述性文字里的数字不会被当成时间端点', () => {
    // 「P99 延迟下降 40%」这种职责行在标题拆分时会被扫到，必须保持 unparsable 才不会被误认成时间段。
    expect(parsePeriod('主导订单服务重构，P99 延迟下降 40%').precision).toBe('none');
  });
});
