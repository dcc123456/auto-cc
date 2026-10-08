import { describe, expect, it } from 'vitest';
import { clampSlotRect, fallbackSlotRect } from './slot-bounds.js';

/**
 * 组一条槽位读数。
 * @param patch 与默认值不同的那几位（默认是一条 100×600 的合法右栏）
 * @returns 交给 `clampSlotRect` 的矩形
 */
const rect = (patch: Partial<{ x: number; y: number; width: number; height: number }>) => ({
  x: 700,
  y: 100,
  width: 100,
  height: 600,
  ...patch,
});

describe('内核视图槽位收口（spec 8.8-01）', () => {
  it('合法读数原样取整通过', () => {
    expect(clampSlotRect(rect({ x: 700.4, y: 99.6 }), { width: 1200, height: 800 })).toEqual({
      x: 700,
      y: 100,
      width: 100,
      height: 600,
    });
  });

  it('非有限值（NaN / Infinity）一律拒收，绝不铺一块点不动的视图', () => {
    expect(clampSlotRect(rect({ width: Number.NaN }), { width: 1200, height: 800 })).toBeNull();
    expect(clampSlotRect(rect({ y: Number.POSITIVE_INFINITY }), { width: 1200, height: 800 })).toBeNull();
  });

  it('零或负尺寸拒收（槽位此刻不存在，不该把视图铺成 0×0 藏起来）', () => {
    expect(clampSlotRect(rect({ width: 0 }), { width: 1200, height: 800 })).toBeNull();
    expect(clampSlotRect(rect({ height: -24 }), { width: 1200, height: 800 })).toBeNull();
  });

  it('客户区为 0×0（窗口还没就绪）时拒收，不等 resize 来救', () => {
    expect(clampSlotRect(rect({}), { width: 0, height: 0 })).toBeNull();
  });

  it('越界读数被夹进客户区，而不是铺到窗口外面', () => {
    expect(clampSlotRect(rect({ x: -40, y: -20, width: 300, height: 300 }), { width: 1200, height: 800 })).toEqual({
      x: 0,
      y: 0,
      width: 260,
      height: 280,
    });
    expect(clampSlotRect(rect({ x: 1150, y: 780, width: 400, height: 400 }), { width: 1200, height: 800 })).toEqual({
      x: 1150,
      y: 780,
      width: 50,
      height: 20,
    });
  });

  it('完全落在客户区外（夹完没有面积）时拒收', () => {
    expect(clampSlotRect(rect({ x: 2000, y: 100 }), { width: 1200, height: 800 })).toBeNull();
  });

  it('兜底摆位按右侧一条取宽，铺满全高（渲染层没报过槽位时用它）', () => {
    expect(fallbackSlotRect({ width: 1000, height: 800 }, 0.38)).toEqual({ x: 620, y: 0, width: 380, height: 800 });
  });
});
