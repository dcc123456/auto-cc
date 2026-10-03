import { AppError, asApp, Context } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { UsageLedgerService } from '@auto-cc/plugin-entitlement';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { throttleSchema, OutboundThrottleService, type OutboundThrottleConfig } from './throttle.js';

/** 与 schema 的 default 一致（带 `.default()` 的键在直接调用点必须显式给出，AGENTS.md §9）。 */
const BASE: OutboundThrottleConfig = { minGapMs: 45000, maxGapMs: 150000, scrollMinGapMs: 300, scrollMaxGapMs: 900 };

const fibers: { dispose(): Promise<unknown> }[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (fibers.length) await fibers.pop()?.dispose();
  while (dirs.length) rmSync(dirs.shift() ?? '', { recursive: true, force: true });
});

/** 装到 `outbound.throttle` 为止；`overrides` 覆盖区间。 */
async function ready(overrides: Partial<OutboundThrottleConfig> = {}) {
  const ctx = new Context();
  await ctx.plugin(OutboundThrottleService, { ...BASE, ...overrides });
  return asApp(ctx)['outbound.throttle'];
}

/**
 * 装上「真账本 + 频控服务」的那一轮装配（`checkGap` 的钟在账本里，替身就测不到它）。
 * @param overrides 频控区间覆盖
 * @returns 频控服务与真账本（用例用它把「上一次外发」落到库里）
 */
async function readyWithLedger(overrides: Partial<OutboundThrottleConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-throttle-'));
  dirs.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(UsageLedgerService, {}));
  fibers.push(await ctx.plugin(OutboundThrottleService, { ...BASE, ...overrides }));
  return { throttle: asApp(ctx)['outbound.throttle'], ledger: asApp(ctx)['usage.ledger'] };
}

/**
 * 取一次抛错的错误码（预检对陌生动作名要的是结构化失败，不是兜底放行）。
 * @param fn 会抛的那一步
 * @returns `AppError` 的错误码；没抛或未结构化时返回可读标记，让断言失败信息自己说话
 */
function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'not-thrown';
  } catch (error) {
    return error instanceof AppError ? error.code : `not-AppError:${String(error)}`;
  }
}

/** 固定的落账时刻（毫秒）：频控判的是两个时刻之差，用例不需要真时钟。 */
const LAST_AT = 1_791_000_000_000;

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

describe('outbound.throttle 的频控预检（spec 5.7-08：调度侧起跑前问的那一句）', () => {
  it('账本一条没有 → 放行且剩余 0（从来没发过就不用手等）', async () => {
    const { throttle } = await readyWithLedger();
    expect(throttle.checkGap('greet', { nowMs: LAST_AT })).toEqual({ allowed: true, remainingMs: 0, reason: null });
  });

  it('离上一次打招呼还差 25 秒 → 拒绝，拒因是给人读的原话并带上秒数', async () => {
    const { throttle, ledger } = await readyWithLedger();
    ledger.record({ action: 'greet', targetId: 'job-1', nowMs: LAST_AT });
    const decision = throttle.checkGap('greet', { nowMs: LAST_AT + 20_000 });
    // 区间下界 45s（BASE），已等 20s → 还差 25s。上界 150s 不参与判定：那是「可能还要等」，不是「必然」。
    expect(decision.allowed).toBe(false);
    expect(decision.remainingMs).toBe(25_000);
    expect(decision.reason).toContain('离上一次打招呼还差 25 秒');
    expect(decision.reason).toContain('45.0s – 150.0s');
  });

  it('刚过下界即放行：判据是「必然还要等」而不是「可能还要等」', async () => {
    const { throttle, ledger } = await readyWithLedger();
    ledger.record({ action: 'greet', targetId: 'job-1', nowMs: LAST_AT });
    // 差 1 毫秒仍在下界之内 → 拒；到点即放行 → 这一对边界把「不误跳」钉住：
    // 按下界放行的那一次即便节点侧还要干等到上界，也是 2.5-04 早已验收的 `sleep` 行为，不是频控失守。
    expect(throttle.checkGap('greet', { nowMs: LAST_AT + 44_999 }).allowed).toBe(false);
    expect(throttle.checkGap('greet', { nowMs: LAST_AT + 45_000 })).toEqual({
      allowed: true,
      remainingMs: 0,
      reason: null,
    });
  });

  it('打招呼的钟不算到投递头上：两条动作各自判（与 2.5-04 各数各的同一条口径）', async () => {
    const { throttle, ledger } = await readyWithLedger();
    ledger.record({ action: 'greet', targetId: 'job-1', nowMs: LAST_AT });
    expect(throttle.checkGap('deliver', { nowMs: LAST_AT + 1_000 }).allowed).toBe(true);
    ledger.record({ action: 'deliver', targetId: 'job-1', nowMs: LAST_AT + 500 });
    // 投递自己的钟落在 +500ms，于是在 +20_000ms 这一刻还差 45_000 - 19_500 = 25_500ms。
    expect(throttle.checkGap('deliver', { nowMs: LAST_AT + 20_000 }).remainingMs).toBe(25_500);
  });

  it('陌生动作名以 INVALID_ARGUMENT 失败：往调度名单里加第三条不会悄悄免检', async () => {
    const { throttle } = await readyWithLedger();
    expect(codeOf(() => throttle.checkGap('search', { nowMs: LAST_AT }))).toBe('INVALID_ARGUMENT');
  });

  it('账本没挂载时放行而不抛：预检不是执行口，真间隔仍在节点侧的 `sleep` 里', async () => {
    // `ready()` 只挂频控服务（2.5-04 那批用例的形状），调度器若装配在没有账本的子集里也不该整条停摆。
    const throttle = await ready();
    expect(throttle.checkGap('greet', { nowMs: LAST_AT }).allowed).toBe(true);
  });

  it('区间收成 0 时恒放行（测试装配与"不要频控"的配置取值都落到这一支）', async () => {
    const { throttle, ledger } = await readyWithLedger({ minGapMs: 0, maxGapMs: 0 });
    ledger.record({ action: 'greet', targetId: 'job-1', nowMs: LAST_AT });
    expect(throttle.checkGap('greet', { nowMs: LAST_AT })).toEqual({ allowed: true, remainingMs: 0, reason: null });
  });
});
