import { describe, expect, it } from 'vitest';
import {
  CANVAS_RIGHT_DEFAULT,
  CANVAS_RIGHT_MAX,
  CANVAS_RIGHT_MIN,
  canvasColumnWidths,
  canvasZoom,
} from './useKernelViewMode';

/**
 * 分栏几何与缩放的 U 类判据（spec 11-03 / 11-04）。
 *
 * 数字与 spec、plan §4.3 **逐字一致**：窄档窗口 1000 → 主区 944 → 右栏 614 → zoom 0.501634；
 * 宽档窗口 1409 → 主区 1225 → 右栏 796 → zoom 0.650327；≥1555 → 右栏 891 → zoom 0.7279（≈0.728）；
 * 全屏态主区 1225 → zoom = min(1, 1225/1224) = 1.0。左栏 = 主区 − 右栏（把手不占行内宽度）。
 */
describe('分栏态缩放（spec 11-04）', () => {
  it('右栏宽低于最小布局宽时等比缩小，全精度不取整', () => {
    expect(canvasZoom(614, 1224)).toBe(614 / 1224);
    expect(canvasZoom(614, 1224)).toBeCloseTo(0.501634, 6);
    expect(canvasZoom(796, 1224)).toBeCloseTo(0.650327, 6);
    expect(canvasZoom(891, 1224)).toBeCloseTo(0.7279, 4);
  });

  it('右栏宽足够时封顶为 1（原生排布）', () => {
    expect(canvasZoom(1225, 1224)).toBe(1);
    expect(canvasZoom(1400, 1224)).toBe(1);
  });

  it('全精度保证「视图宽 / zoom ≥ minLayoutWidth」成立', () => {
    for (const width of [614, 796, 891]) {
      expect(width / canvasZoom(width, 1224)).toBeGreaterThanOrEqual(1224);
    }
  });

  it('适配器未声明最小布局宽时按 1 原生排布（未适配）', () => {
    expect(canvasZoom(614, undefined)).toBe(1);
    expect(canvasZoom(614, 0)).toBe(1);
    expect(canvasZoom(614, Number.NaN)).toBe(1);
  });

  it('非法右栏宽不产出非法 zoom', () => {
    expect(canvasZoom(0, 1224)).toBe(1);
    expect(canvasZoom(Number.NaN, 1224)).toBe(1);
    expect(canvasZoom(-10, 1224)).toBe(1);
  });
});

describe('分栏两栏宽度（spec 11-03 / 11-06）', () => {
  it('默认 65% 与各窗口档的左栏读数与 spec 一致', () => {
    expect(CANVAS_RIGHT_DEFAULT).toBe(65);
    const narrow = canvasColumnWidths(944, CANVAS_RIGHT_DEFAULT);
    expect(narrow.right).toBeCloseTo(613.6, 1);
    expect(narrow.left).toBeCloseTo(330.4, 1);
    const wide = canvasColumnWidths(1225, CANVAS_RIGHT_DEFAULT);
    expect(wide.right).toBeCloseTo(796.25, 2);
    expect(wide.left).toBeCloseTo(428.75, 2);
    const tall = canvasColumnWidths(1371, CANVAS_RIGHT_DEFAULT);
    expect(tall.right).toBeCloseTo(891.15, 2);
    expect(tall.left).toBeCloseTo(479.85, 2);
  });

  it('可拖区间 30~70 与 sidebar 的 38~72 互不相犯', () => {
    expect(CANVAS_RIGHT_MIN).toBe(30);
    expect(CANVAS_RIGHT_MAX).toBe(70);
    expect(CANVAS_RIGHT_MIN).toBeLessThan(38);
    expect(CANVAS_RIGHT_MAX).toBeLessThan(72);
  });

  it('拖到两端点时两栏之和仍等于主区宽（把手不占行内宽度）', () => {
    for (const ratio of [CANVAS_RIGHT_MIN, CANVAS_RIGHT_MAX]) {
      const columns = canvasColumnWidths(1225, ratio);
      expect(columns.right + columns.left).toBeCloseTo(1225, 6);
    }
    expect(canvasColumnWidths(1225, CANVAS_RIGHT_MIN).right).toBeCloseTo(367.5, 3);
    expect(canvasColumnWidths(1225, CANVAS_RIGHT_MAX).right).toBeCloseTo(857.5, 3);
  });

  it('主区宽非法时两栏都为 0，不产生负宽或 NaN', () => {
    expect(canvasColumnWidths(0, 65)).toEqual({ right: 0, left: 0 });
    expect(canvasColumnWidths(Number.NaN, 65)).toEqual({ right: 0, left: 0 });
    expect(canvasColumnWidths(1225, Number.NaN)).toEqual({ right: 0, left: 1225 });
  });
});
