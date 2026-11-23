import { describe, expect, it } from 'vitest';
import { RECOVERY_LIMIT, RECOVERY_WINDOW_MS, recoveryVerdict, withRecovery } from './recovery-budget.js';

/**
 * 恢复预算（2026-11-23 裁定：≤2 次 / 60s，超限只提示重试）。
 *
 * 这一条错了的后果不是「少恢复一次」，而是**无限重建**：站点一加载就再关一次，
 * 重建→再关→再重建，右栏持续闪断。所以时间窗口的边界要逐档钉死。
 */
describe('视图被站点关掉后的恢复预算', () => {
  it('空记录：允许恢复，已用 0 次', () => {
    expect(recoveryVerdict([], 1_000)).toEqual({ allowed: true, usedInWindow: 0, remainingMs: 0 });
  });

  it(`窗口内已用满 ${String(RECOVERY_LIMIT)} 次：拒绝，并给出还要等多久`, () => {
    const now = 100_000;
    const verdict = recoveryVerdict([now - 30_000, now - 10_000], now);
    expect(verdict.allowed).toBe(false);
    expect(verdict.usedInWindow).toBe(2);
    // 最早那一次在窗口起点附近滑出，剩 = 窗口 − 已过时间
    expect(verdict.remainingMs).toBe(RECOVERY_WINDOW_MS - 30_000);
  });

  it('窗口外的旧记录不占名额（滑窗，不是累计）', () => {
    const now = 500_000;
    const verdict = recoveryVerdict([now - RECOVERY_WINDOW_MS - 1, now - RECOVERY_WINDOW_MS - 2], now);
    expect(verdict.allowed).toBe(true);
    expect(verdict.usedInWindow).toBe(0);
  });

  it('记一次恢复之后旧记录被丢掉，数组不会无限增长', () => {
    const now = 900_000;
    const next = withRecovery([now - RECOVERY_WINDOW_MS - 5, now - 1_000], now);
    expect(next).toEqual([now - 1_000, now]);
  });

  it('连续两次允许、第三次拒绝：正是「≤2 次/60s」', () => {
    const now = 1_000_000;
    let attempts: number[] = [];
    expect(recoveryVerdict(attempts, now).allowed).toBe(true);
    attempts = withRecovery(attempts, now);
    expect(recoveryVerdict(attempts, now + 1_000).allowed).toBe(true);
    attempts = withRecovery(attempts, now + 1_000);
    expect(recoveryVerdict(attempts, now + 2_000).allowed).toBe(false);
    // 60 秒后再放开一次
    expect(recoveryVerdict(attempts, now + RECOVERY_WINDOW_MS + 2_000).allowed).toBe(true);
  });
});
