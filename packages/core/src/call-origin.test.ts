import { describe, expect, it } from 'vitest';
import { assertUserCall, currentCallOrigin, runAsUserCall } from './call-origin.js';

/**
 * 调用来源（2026-11-24 红线事故后的第二处收紧）。
 *
 * 判据只有一条：**没有网关标就是自动化**——参数、调用方自报都不算数。
 */
describe('调用来源的打标与判据', () => {
  it('没有标时按自动化算（主进程内部调用都是这一档）', () => {
    expect(currentCallOrigin()).toBe('automation');
    expect(() => assertUserCall('browser.page.navigateFromUser')).toThrow(/只接受人在界面上的调用/);
  });

  it('网关打标之后才是 user，标只活在这一次异步链里', async () => {
    const inside = await runAsUserCall(async () => {
      await Promise.resolve();
      return currentCallOrigin();
    });
    expect(inside).toBe('user');
    expect(currentCallOrigin()).toBe('automation');
  });

  it('人那一路的口在标的上下文里放行', async () => {
    await runAsUserCall(async () => {
      await Promise.resolve();
      expect(() => assertUserCall('sessions.openFromUser')).not.toThrow();
    });
  });

  it('拒绝时把当前来源带进 details（好让日志说得清是谁想走这条路）', () => {
    try {
      assertUserCall('sessions.openFromUser');
      throw new Error('应当抛');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('INVALID_ARGUMENT');
      expect((error as { details?: { origin?: string } }).details?.origin).toBe('automation');
    }
  });
});
