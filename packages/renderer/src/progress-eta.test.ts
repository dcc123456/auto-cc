import { describe, expect, it } from 'vitest';
import { captureEtaSeconds } from './progress-eta';

/**
 * 「还要多久」的估算判据（2026-11-24 萌新 P1）。
 *
 * 这一格只允许两种输出：一个按已观测速率算出来的秒数，或 null（算不出就不显示）。
 * 不允许出现「0 秒」这种假装精确的读数，也不许拿固定节流常数当倍率。
 */
describe('抓取剩余时间估算', () => {
  it('按已观测速率外推：4 秒入库 4 条，目标 11 条 → 约剩 7 秒', () => {
    const samples = [
      { stored: 0, at: 1_000 },
      { stored: 2, at: 3_000 },
      { stored: 4, at: 5_000 },
    ];
    expect(captureEtaSeconds(samples, 11)).toBe(7);
  });

  it('顺序反了也按时间算（推送是新的在前）', () => {
    const samples = [
      { stored: 4, at: 5_000 },
      { stored: 0, at: 1_000 },
    ];
    expect(captureEtaSeconds(samples, 11)).toBe(7);
  });

  it('已达目标 / 样本不够 / 跨度过短 / 没长过：一律 null，不编 0 秒', () => {
    expect(
      captureEtaSeconds(
        [
          { stored: 11, at: 5_000 },
          { stored: 0, at: 1_000 },
        ],
        11,
      ),
    ).toBeNull();
    expect(captureEtaSeconds([{ stored: 3, at: 5_000 }], 11)).toBeNull();
    expect(captureEtaSeconds([], 11)).toBeNull();
    expect(
      captureEtaSeconds(
        [
          { stored: 0, at: 1_000 },
          { stored: 3, at: 1_200 },
        ],
        11,
      ),
    ).toBeNull();
    expect(
      captureEtaSeconds(
        [
          { stored: 3, at: 1_000 },
          { stored: 3, at: 9_000 },
        ],
        11,
      ),
    ).toBeNull();
    expect(
      captureEtaSeconds(
        [
          { stored: 0, at: 1_000 },
          { stored: 3, at: 9_000 },
        ],
        0,
      ),
    ).toBeNull();
  });
});
