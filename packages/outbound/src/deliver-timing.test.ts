/**
 * 择机投递时机规则的真值表（spec 5.7-03）。
 *
 * 判据是「四个输入进来、一个决定出去」，所以这里只喂读数、不看任何服务：真身那一路的接线
 * 由 `deliver.test.ts` 断（渠道调用次数 / 账本行数 / 被拒流水），两边合起来才是 5.7-03 的「规则可读、可配置」。
 *
 * 时刻一律用**本地时区构造器**生成（`new Date(y, m, d, h, min)`），规则本身也按本地时区判定，
 * 于是这份真值表在换时区、换机器、换日期的任何一次运行里读数都一样；
 * 对「下一次该来看」的时刻只断它落到本地的哪个星期几点，不比原始毫秒——跨夏令时的那一小时会比不出名堂。
 */
import { describe, expect, it } from 'vitest';
import {
  deliverTimingSchema,
  evaluateDeliverTiming,
  gapRemainingMs,
  type DeliverTimingConfig,
  type DeliverTimingFacts,
} from './deliver-timing.js';

/** 规则全开的配置：只关掉「默认关」那一位，其余走 schema 的默认（09:00–21:00、工作日、要求回复）。 */
const ON: DeliverTimingConfig = deliverTimingSchema.parse({ enabled: true });

/** 周一到周日在 `Date.getDay()` 里的下标，用例靠名字读，不靠数字猜。 */
const SUNDAY = 0;
const MONDAY = 1;
const TUESDAY = 2;
const FRIDAY = 5;
const SATURDAY = 6;

/**
 * 取锚点日之后第一个指定星期几的那天，按**本地**时刻返回毫秒。
 * @param weekday `Date.getDay()` 的下标（0 = 周日）
 * @param hour 本地小时（0–23）
 * @param minute 本地分钟
 * @returns 那一刻的毫秒值；七天内必然命中
 */
function dayAt(weekday: number, hour: number, minute = 0): number {
  // 锚点固定成 2026-01-01：它是哪天不重要，重要的是每次运行都从同一天往后数，读数因此可复现。
  const anchor = new Date(2026, 0, 1);
  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + offset, hour, minute, 0, 0);
    if (day.getDay() === weekday) return day.getTime();
  }
  throw new Error('锚点起七天内必然有目标星期');
}

/**
 * 造一份读数，默认的四个输入都是「此刻可以递」。
 * @param over 覆盖项
 * @returns 交给 `evaluateDeliverTiming` 的事实
 */
function facts(over: Partial<DeliverTimingFacts> = {}): DeliverTimingFacts {
  return {
    nowMs: dayAt(MONDAY, 10),
    replied: true,
    gapRemainingMs: 0,
    quotaAllowed: true,
    ...over,
  };
}

/**
 * 把「最早合格时刻」读成本地时刻的读数，好让断言落在「哪天几点」而不是裸毫秒。
 * @param ms 毫秒值
 * @returns 星期下标、小时、分钟
 */
function localClock(ms: number): { weekday: number; hour: number; minute: number } {
  const date = new Date(ms);
  return { weekday: date.getDay(), hour: date.getHours(), minute: date.getMinutes() };
}

describe('择机投递的判定（spec 5.7-03 的真值表）', () => {
  it('四项全绿：可递、无拒因、不报下一次时刻', () => {
    const decision = evaluateDeliverTiming(facts(), ON);
    expect(decision).toEqual({ ready: true, blockers: [], nextEligibleAtMs: null });
  });

  it('没回复 → 挡；拒因说清是「对方没回」，且不给下一次时刻（那取决于人，不取决于钟）', () => {
    const decision = evaluateDeliverTiming(facts({ replied: false }), ON);
    expect(decision.ready).toBe(false);
    expect(decision.blockers).toEqual(['对方还没有回复这条岗位，按择机投递的约定先不递简历']);
    expect(decision.nextEligibleAtMs).toBeNull();
  });

  it('问不到回复状态 → 挡，而且是一条**独立**的拒因（「不知道」不能折进「没回复」，否则库空了会静默永不递）', () => {
    const decision = evaluateDeliverTiming(facts({ replied: null }), ON);
    expect(decision.blockers).toEqual(['问不到这条岗位的回复状态（库里没有它或平台层没挂载），先不递简历']);
  });

  it('关掉「要求回复」后，没回复也照递：这条规则是可配置的约定，不是硬性合规', () => {
    const decision = evaluateDeliverTiming(facts({ replied: false }), { ...ON, requireReply: false });
    expect(decision.ready).toBe(true);
  });

  it('周六 10:00 → 挡在「只在工作日」，下一次落在周一 09:00', () => {
    const nowMs = dayAt(SATURDAY, 10);
    const decision = evaluateDeliverTiming(facts({ nowMs }), ON);
    expect(decision.blockers).toEqual(['今天是周六，按只在工作日投递的约定今天不递']);
    expect(decision.nextEligibleAtMs).not.toBeNull();
    expect(localClock(decision.nextEligibleAtMs!)).toEqual({ weekday: MONDAY, hour: 9, minute: 0 });
    expect(decision.nextEligibleAtMs!).toBeGreaterThan(nowMs);
  });

  it('周日 → 同一条约定，拒因里的星期名跟着变（读数要能对上用户看的那个星期几）', () => {
    const decision = evaluateDeliverTiming(facts({ nowMs: dayAt(SUNDAY, 14) }), ON);
    expect(decision.blockers).toEqual(['今天是周日，按只在工作日投递的约定今天不递']);
    expect(localClock(decision.nextEligibleAtMs!)).toEqual({ weekday: MONDAY, hour: 9, minute: 0 });
  });

  it('关掉「只在工作日」后，周六窗口内照递', () => {
    const decision = evaluateDeliverTiming(facts({ nowMs: dayAt(SATURDAY, 10) }), {
      ...ON,
      weekdaysOnly: false,
    });
    expect(decision.ready).toBe(true);
  });

  it('窗口边界：08:59 挡、09:00 放行、20:59 放行、21:00 挡（含头不含尾）', () => {
    const before = evaluateDeliverTiming(facts({ nowMs: dayAt(MONDAY, 8, 59) }), ON);
    expect(before.blockers).toEqual(['现在 08:59 不在投递时间窗 09:00–21:00 内']);
    expect(localClock(before.nextEligibleAtMs!)).toEqual({ weekday: MONDAY, hour: 9, minute: 0 });

    expect(evaluateDeliverTiming(facts({ nowMs: dayAt(MONDAY, 9) }), ON).ready).toBe(true);
    expect(evaluateDeliverTiming(facts({ nowMs: dayAt(MONDAY, 20, 59) }), ON).ready).toBe(true);

    const after = evaluateDeliverTiming(facts({ nowMs: dayAt(MONDAY, 21) }), ON);
    expect(after.blockers).toEqual(['现在 21:00 不在投递时间窗 09:00–21:00 内']);
    expect(localClock(after.nextEligibleAtMs!)).toEqual({ weekday: TUESDAY, hour: 9, minute: 0 });
  });

  it('周五夜里收盘 → 下一次是下周一，不是周六也不是「明天 09:00」（周末整天被排除）', () => {
    const decision = evaluateDeliverTiming(facts({ nowMs: dayAt(FRIDAY, 23) }), ON);
    expect(decision.blockers).toEqual(['现在 23:00 不在投递时间窗 09:00–21:00 内']);
    expect(localClock(decision.nextEligibleAtMs!)).toEqual({ weekday: MONDAY, hour: 9, minute: 0 });
  });

  it('频控还差 30 秒 → 挡，下一次就是这 30 秒之后', () => {
    const nowMs = dayAt(MONDAY, 10);
    const decision = evaluateDeliverTiming(facts({ nowMs, gapRemainingMs: 30_000 }), ON);
    expect(decision.blockers).toEqual(['离上一次投递还差 30 秒，按频控此刻不动手']);
    expect(decision.nextEligibleAtMs).toBe(nowMs + 30_000);
  });

  it('额度用完 → 挡，但拒因明写是闸门那本账，下一次时刻留空（日界归账本管）', () => {
    const decision = evaluateDeliverTiming(facts({ quotaAllowed: false }), ON);
    expect(decision.blockers).toEqual(['今日投递额度已用完（这条由额度闸门记账，时机规则不替它改判）']);
    expect(decision.nextEligibleAtMs).toBeNull();
  });

  it('多条同时不满足 → 拒因按固定顺序全列出来，下一次取最早那个（不是最后一个）', () => {
    const nowMs = dayAt(SATURDAY, 10);
    const decision = evaluateDeliverTiming(facts({ nowMs, replied: false, gapRemainingMs: 30_000 }), ON);
    expect(decision.blockers).toEqual([
      '对方还没有回复这条岗位，按择机投递的约定先不递简历',
      '今天是周六，按只在工作日投递的约定今天不递',
      '离上一次投递还差 30 秒，按频控此刻不动手',
    ]);
    // 频控那 30 秒比「等到周一」近得多，屏幕上因此显示的是 30 秒后，而不是骗人的周一。
    expect(decision.nextEligibleAtMs).toBe(nowMs + 30_000);
  });

  it('窗口外 + 频控同时卡 → 下一次是两者里更早的那个', () => {
    const nowMs = dayAt(MONDAY, 22);
    const decision = evaluateDeliverTiming(facts({ nowMs, gapRemainingMs: 90_000 }), ON);
    expect(decision.blockers).toHaveLength(2);
    // 周一 22:00 + 90 秒 = 22:01:30，仍早于次日 09:00 开窗。
    expect(decision.nextEligibleAtMs).toBe(nowMs + 90_000);
  });
});

describe('频控剩余时间的算法（AGENTS.md §2.2：这段减法只许写一次）', () => {
  it('从没递过 → 0，不用等', () => {
    expect(gapRemainingMs(null, 60_000, 1_000)).toBe(0);
  });

  it('上一次刚递过 → 还差多久就是多久', () => {
    expect(gapRemainingMs(1_000, 60_000, 31_000)).toBe(30_000);
  });

  it('早就等够了 → 0，不出现负数', () => {
    expect(gapRemainingMs(1_000, 60_000, 200_000)).toBe(0);
  });
});

describe('时机规则的配置（可配置的那一半）', () => {
  it('默认值是「规则关着」：enabled 为 false，其余按 09:00–21:00 只在工作日、要求回复', () => {
    expect(deliverTimingSchema.parse({})).toEqual({
      enabled: false,
      requireReply: true,
      weekdaysOnly: true,
      windowStartHour: 9,
      windowEndHour: 21,
    });
  });

  it('窗口起点不小于终点 → 直接拒绝装配（否则任何时刻都算窗口外，规则会静默挡死所有投递）', () => {
    expect(() => deliverTimingSchema.parse({ windowStartHour: 21, windowEndHour: 21 })).toThrow();
    expect(() => deliverTimingSchema.parse({ windowStartHour: 21, windowEndHour: 9 })).toThrow();
  });

  it('小时越界与非整数 → 拒绝（24 只能当终点，不能当起点）', () => {
    expect(() => deliverTimingSchema.parse({ windowStartHour: 24 })).toThrow();
    expect(() => deliverTimingSchema.parse({ windowEndHour: 0 })).toThrow();
    expect(() => deliverTimingSchema.parse({ windowStartHour: 9.5 })).toThrow();
  });

  it('未知键 → 拒绝（配置面多一个没人读的键，比少一个更难发现）', () => {
    expect(() => deliverTimingSchema.parse({ deferMinutes: 10 })).toThrow();
  });

  it('整点窗口可以按配置挪（例如夜班用户改成 14:00–23:00）', () => {
    const timing = deliverTimingSchema.parse({ enabled: true, windowStartHour: 14, windowEndHour: 23 });
    const decision = evaluateDeliverTiming(facts({ nowMs: dayAt(MONDAY, 15) }), timing);
    expect(decision.ready).toBe(true);
  });
});
