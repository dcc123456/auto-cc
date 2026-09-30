/**
 * `normalize.ts` 的纯函数用例（spec 2.3-02 / 2.3-03）。
 *
 * 样本全部取自 plan §10.2 里实测到的真实写法分布：区间 K、区间万、无区间、带「·N薪」后缀、
 * 面议，以及中文相对时间。这里不需要开窗口，也不需要数据库。
 */
import { describe, expect, it } from 'vitest';
import { cleanText, parsePostedAt, parseSalary, splitRequirements } from './normalize.js';

/** 一天与一小时的毫秒数，测试里用常量而不是再乘一遍，免得算错了看不出来。 */
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('cleanText（spec 2.3-02 的落库前置）', () => {
  it('折叠换行与多空格为一个空格，并去掉零宽字符', () => {
    expect(cleanText(' 桌面端\u200B前端\n  工程师（Electron） ')).toBe('桌面端前端 工程师（Electron）');
  });

  it('非字符串输入回空串而不是抛出', () => {
    expect(cleanText(undefined)).toBe('');
    expect(cleanText(null)).toBe('');
    expect(cleanText(42)).toBe('');
  });
});

describe('parseSalary（spec 2.3-03）', () => {
  it('区间 K 与「·N薪」后缀分别落到 min/max 与 salaryMonths', () => {
    expect(parseSalary('25-40K·14薪')).toEqual({
      min: 25,
      max: 40,
      unit: 'k',
      period: 'month',
      salaryMonths: 14,
      isNegotiable: false,
    });
    expect(parseSalary('40-60K·16薪')).toMatchObject({ min: 40, max: 60, salaryMonths: 16 });
  });

  it('无后缀的区间与小数区间都能读', () => {
    expect(parseSalary('30-45K')).toMatchObject({ min: 30, max: 45, unit: 'k', salaryMonths: null });
    expect(parseSalary('1.8-2.5万·15薪')).toMatchObject({ min: 1.8, max: 2.5, unit: 'wan', salaryMonths: 15 });
  });

  it('单个数字时 min 与 max 相同', () => {
    expect(parseSalary('20K')).toMatchObject({ min: 20, max: 20, unit: 'k' });
  });

  it('面议与读不懂都回中性值，且 isNegotiable 为 true', () => {
    for (const text of ['面议', '薪资待定', '', '  ', '待遇从优', undefined]) {
      expect(parseSalary(text)).toEqual({
        min: null,
        max: null,
        unit: 'unknown',
        period: 'unknown',
        salaryMonths: null,
        isNegotiable: true,
      });
    }
  });

  it('全角数字、破折号与空格先折叠再解析', () => {
    expect(parseSalary('２５　— ４０ｋ')).toMatchObject({ min: 25, max: 40, unit: 'k' });
    expect(parseSalary('25 ~ 40K')).toMatchObject({ min: 25, max: 40 });
  });

  it('区间写反时按大小归位，元与年薪各自落到 unit / period', () => {
    expect(parseSalary('40-25K')).toMatchObject({ min: 25, max: 40 });
    expect(parseSalary('6000-9000元/月')).toMatchObject({ min: 6000, max: 9000, unit: 'yuan', period: 'month' });
    expect(parseSalary('20-30万/年')).toMatchObject({ min: 20, max: 30, unit: 'wan', period: 'year' });
  });
});

describe('splitRequirements（spec 2.3-02 的要求条目）', () => {
  it('按分号与句号拆条，并剥掉行首序号', () => {
    expect(splitRequirements('1. 三年 TypeScript 经验；2. 熟悉 Electron。3、能独立打包')).toEqual([
      '三年 TypeScript 经验',
      '熟悉 Electron',
      '能独立打包',
    ]);
  });

  it('空文本与只有分隔符时回空数组', () => {
    expect(splitRequirements('')).toEqual([]);
    expect(splitRequirements('；；;')).toEqual([]);
  });
});

describe('parsePostedAt（spec 2.3-03 的相对时间）', () => {
  const now = 1_700_000_000_000;

  it('分钟前 / 小时前 / 天前按注入的基准折算', () => {
    expect(parsePostedAt('12 分钟前', now)).toBe(now - 12 * 60_000);
    expect(parsePostedAt('3小时前', now)).toBe(now - 3 * HOUR);
    expect(parsePostedAt('5 天前', now)).toBe(now - 5 * DAY);
  });

  it('刚刚 / 今天 / 昨天 / 前天有明确落点', () => {
    expect(parsePostedAt('刚刚发布', now)).toBe(now);
    expect(parsePostedAt('今天', now)).toBe(now);
    expect(parsePostedAt('昨天', now)).toBe(now - DAY);
    expect(parsePostedAt('前天', now)).toBe(now - 2 * DAY);
  });

  it('绝对日期取当天零点', () => {
    expect(parsePostedAt('发布于 2026-09-25', now)).toBe(new Date(2026, 8, 25).getTime());
  });

  it('认不出来回 null，不猜一个时间', () => {
    expect(parsePostedAt('随时可用', now)).toBeNull();
    expect(parsePostedAt('', now)).toBeNull();
    expect(parsePostedAt(undefined, now)).toBeNull();
  });
});
