import { asApp, Context } from '@auto-cc/core';
import { describe, expect, it } from 'vitest';
import { throttleSchema, OutboundThrottleService, type OutboundThrottleConfig } from './throttle.js';

/** 与 schema 的 default 一致（带 `.default()` 的键在直接调用点必须显式给出，AGENTS.md §9）。 */
const BASE: OutboundThrottleConfig = { minGapMs: 45000, maxGapMs: 150000, scrollMinGapMs: 300, scrollMaxGapMs: 900 };

/** 装到 `outbound.throttle` 为止；`overrides` 覆盖区间。 */
async function ready(overrides: Partial<OutboundThrottleConfig> = {}) {
  const ctx = new Context();
  await ctx.plugin(OutboundThrottleService, { ...BASE, ...overrides });
  return asApp(ctx)['outbound.throttle'];
}

describe('outbound.throttle 的间隔抽样（spec 2.5-04 / 2.5-05）', () => {
  it('随机源的两端都落得进去：闭区间而不是左闭右开（2.5-04）', async () => {
    const throttle = await ready();
    expect(throttle.nextGapMs(() => 0)).toBe(45000);
    expect(throttle.nextGapMs(() => 0.5)).toBe(97500);
    expect(throttle.nextGapMs(() => 0.9999999999)).toBe(150000);
  });

  it('默认区间连取 10 次：全在区间内，且极差远大于固定节奏（2.5-05 的方差判据）', async () => {
    const throttle = await ready();
    const gaps = Array.from({ length: 10 }, () => throttle.nextGapMs());
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(45000);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(150000);
    // 均匀抽样 10 次的极差期望约是区间长度的 82%，落到 30% 以下的概率约万分之一：
    // 阈值定在这里既能咬死「等间隔」，又不会因随机波动偶发假红。
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan((150000 - 45000) * 0.3);
    expect(new Set(gaps).size).toBeGreaterThanOrEqual(8);
  });

  it('区间退化成单点时恒等于该点，不抛异常（配置被压到最小时仍可运行）', async () => {
    const throttle = await ready({ minGapMs: 60000, maxGapMs: 60000 });
    expect(throttle.nextGapMs()).toBe(60000);
    expect(throttle.nextGapMs(() => 0.7)).toBe(60000);
  });

  it('页面动作间隔（滚动）走自己的区间，不借用外发区间（2.7-04 归位）', async () => {
    const throttle = await ready();
    expect(throttle.nextScrollGapMs(() => 0)).toBe(300);
    expect(throttle.nextScrollGapMs(() => 0.5)).toBe(600);
    expect(throttle.nextScrollGapMs(() => 0.9999999999)).toBe(900);
    // 两根区间各自独立：把外发区间拉到 1 秒级也不该动到页面动作的间隔。
    const tight = await ready({ minGapMs: 1000, maxGapMs: 1000 });
    expect(tight.nextScrollGapMs(() => 0)).toBe(300);
  });

  it('scrollMinGapMs > scrollMaxGapMs 同样在配置边界被拒（区间翻转就是假读数）', () => {
    const parsed = throttleSchema.safeParse({ scrollMinGapMs: 900, scrollMaxGapMs: 300 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain('不能大于');
  });

  it('自定义区间生效：毫秒数不写死在代码里（plan §12.4）', async () => {
    const throttle = await ready({ minGapMs: 1000, maxGapMs: 1002 });
    expect([1000, 1001, 1002]).toContain(throttle.nextGapMs(() => 0.9999999999));
    expect(throttle.nextGapMs(() => 0)).toBe(1000);
  });

  it('minGapMs > maxGapMs 在配置边界就被拒（否则界面显示的是一个从没生效过的区间）', () => {
    const parsed = throttleSchema.safeParse({ minGapMs: 60000, maxGapMs: 30000 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toContain('不能大于');
  });
});
