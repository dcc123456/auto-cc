import { describe, expect, it } from 'vitest';
import { quantizeKernelViewRect } from './kernel-bounds';

/**
 * 上报矩形取整（spec 10.11-27）：地址栏底是小数时，视图必须从它的上取整开始，交集严格为 0。
 */
describe('内核视图上报矩形取整', () => {
  it('小数底边：视图 top 取整后不小于地址栏 bottom', () => {
    const barBottom = 94.15;
    const rect = quantizeKernelViewRect({ x: 540.6, y: barBottom, width: 659.4, height: 648 });
    expect(rect.y).toBe(95);
    expect(rect.y).toBeGreaterThanOrEqual(barBottom);
    expect(rect.x).toBe(541);
    expect(rect.width).toBe(Math.floor(540.6 + 659.4) - 541);
    expect(rect.height).toBe(Math.floor(barBottom + 648) - 95);
  });

  it('整数入参不变形，且宽高至少为 1', () => {
    expect(quantizeKernelViewRect({ x: 10, y: 20, width: 300, height: 200 })).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });
    expect(quantizeKernelViewRect({ x: 1.2, y: 1.2, width: 0.2, height: 0.2 })).toEqual({
      x: 2,
      y: 2,
      width: 1,
      height: 1,
    });
  });
});
