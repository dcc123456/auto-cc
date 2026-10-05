/**
 * 编辑器纯操作的用例（spec 3.6-01 的落点数学半边 + 3.6-02 的 U 半边，plan §8.4 的 3.6-a 那一格）。
 */
import { describe, expect, it } from 'vitest';
import { EDITOR_METRIC_BOUNDS, planEntryMove, planMetric, planSectionMove, type MetricKey } from './editor-ops.js';
import { DEFAULT_LAYOUT, makeField, type Layout, type Section } from './model.js';

/** 造一个区块（三个区块的用例里只有 id 与标题不同）。 */
function section(id: string, entryIds: readonly string[] = []): Section {
  return {
    id,
    kind: 'experience',
    title: id,
    entries: entryIds.map((entryId) => ({ id: entryId, fields: [makeField('experience', 'role', entryId)] })),
  };
}

describe('3.6-02 度量界内界外', () => {
  it('每条键的上下两端都放行，其余键一字不动', () => {
    for (const key of Object.keys(EDITOR_METRIC_BOUNDS) as MetricKey[]) {
      const bound = EDITOR_METRIC_BOUNDS[key];
      for (const value of [bound.min, bound.max]) {
        const result = planMetric(DEFAULT_LAYOUT, key, value);
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        if (key === 'baseFontPt' || key === 'lineHeight') expect(result.value[key]).toBe(value);
        else expect(result.value.margin[key]).toBe(value);
        // 只动那一条：其它三条边、字号、行距、分栏、纸张都得原样带着。
        expect(Object.keys(result.value.margin)).toEqual(Object.keys(DEFAULT_LAYOUT.margin));
        expect(result.value.pageSize).toBe(DEFAULT_LAYOUT.pageSize);
        expect(result.value.columns).toBe(DEFAULT_LAYOUT.columns);
      }
    }
  });

  it('界外、非有限数、未知键各给一条确定的拒绝码，且不抛异常', () => {
    expect(planMetric(DEFAULT_LAYOUT, 'baseFontPt', 5.5)).toMatchObject({
      ok: false,
      code: 'out-of-bounds',
    });
    expect(planMetric(DEFAULT_LAYOUT, 'lineHeight', 3.01)).toMatchObject({ ok: false, code: 'out-of-bounds' });
    expect(planMetric(DEFAULT_LAYOUT, 'leftMm', 41)).toMatchObject({ ok: false, code: 'out-of-bounds' });
    // NaN 与 Infinity 两侧的漏网都比"报得太晚"危险：它们能过 `<`/`>` 的两头，一路写进 @page 才炸。
    expect(planMetric(DEFAULT_LAYOUT, 'baseFontPt', Number.NaN)).toMatchObject({ ok: false, code: 'not-a-number' });
    expect(planMetric(DEFAULT_LAYOUT, 'baseFontPt', Number.POSITIVE_INFINITY)).toMatchObject({
      ok: false,
      code: 'not-a-number',
    });
    // `columns` 是真实存在的版面键，但**不在**编辑器给人推的那四条里（它只有 1/2 两档，模型级 schema 管着）：
    // 运行时它就是个字符串，会话外面递进来的键都必须过 `unknown-metric` 这一腿。
    expect(planMetric(DEFAULT_LAYOUT, 'columns' as unknown as MetricKey, 1)).toMatchObject({
      ok: false,
      code: 'unknown-metric',
    });
  });

  it('拒绝时原版面纹丝不动（纯操作不许就地改）', () => {
    const layout: Layout = { ...DEFAULT_LAYOUT, margin: { ...DEFAULT_LAYOUT.margin } };
    const snapshot = structuredClone(layout);
    expect(planMetric(layout, 'baseFontPt', 99).ok).toBe(false);
    expect(layout).toEqual(snapshot);
  });

  it('今天立的这张界表不许把已验收的默认版面判成非法（界必须包住 DEFAULT_LAYOUT 的每一条）', () => {
    const inside = (key: MetricKey, value: number): boolean => {
      const bound = EDITOR_METRIC_BOUNDS[key];
      return value >= bound.min && value <= bound.max;
    };
    expect(inside('baseFontPt', DEFAULT_LAYOUT.baseFontPt)).toBe(true);
    expect(inside('lineHeight', DEFAULT_LAYOUT.lineHeight)).toBe(true);
    for (const key of ['topMm', 'bottomMm', 'leftMm', 'rightMm'] as const) {
      expect(inside(key, DEFAULT_LAYOUT.margin[key])).toBe(true);
    }
  });
});

describe('3.6-01 区块落点数学', () => {
  it('把第 0 块拖到第 2 位：toIndex 是结果里的下标，不是"跨过几个"', () => {
    const sections = [section('a'), section('b'), section('c')];
    const result = planSectionMove(sections, 'a', 2);
    expect(result.ok && result.value.map((item) => item.id)).toEqual(['b', 'c', 'a']);
    // 原序列不被改动（会话靠这条保证"拒绝的动作不留半成品"）。
    expect(sections.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('往前拖与往后拖都只改顺序，区块对象本身引用不变', () => {
    const sections = [section('a'), section('b'), section('c')];
    const result = planSectionMove(sections, 'c', 0);
    if (!result.ok) throw new Error('应当放行');
    expect(result.value.map((item) => item.id)).toEqual(['c', 'a', 'b']);
    expect(result.value[0]).toBe(sections[2]);
  });

  it('查无此区块、下标越界与非整数各给确定的拒绝码，越界界值是 length 本身', () => {
    const sections = [section('a'), section('b')];
    expect(planSectionMove(sections, 'zz', 1)).toMatchObject({ ok: false, code: 'unknown-section' });
    expect(planSectionMove(sections, 'a', 2)).toMatchObject({ ok: false, code: 'index-out-of-range' });
    expect(planSectionMove(sections, 'a', -1)).toMatchObject({ ok: false, code: 'index-out-of-range' });
    expect(planSectionMove(sections, 'a', 0.5)).toMatchObject({ ok: false, code: 'index-out-of-range' });
    expect(planSectionMove([], 'a', 0)).toMatchObject({ ok: false, code: 'unknown-section' });
  });
});

describe('3.6-01 条目落点数学（作用域限在所属区块内）', () => {
  it('条目只在自己那个区块里换序，别的区块原样带着', () => {
    const sections = [section('exp', ['e1', 'e2', 'e3']), section('edu', ['e4'])];
    const result = planEntryMove(sections, 'exp', 'e1', 2);
    if (!result.ok) throw new Error('应当放行');
    expect(result.value[0]?.entries.map((entry) => entry.id)).toEqual(['e2', 'e3', 'e1']);
    expect(result.value[1]).toBe(sections[1]);
  });

  it('跨区块拖条目被拒：条目 id 不在指定区块里就是 unknown-entry', () => {
    const sections = [section('exp', ['e1', 'e2']), section('edu', ['e4'])];
    expect(planEntryMove(sections, 'exp', 'e4', 0)).toMatchObject({ ok: false, code: 'unknown-entry' });
    expect(planEntryMove(sections, 'zz', 'e1', 0)).toMatchObject({ ok: false, code: 'unknown-section' });
    // 单条目区块里唯一的落点就是原地，越界的那一侧仍然是 index-out-of-range。
    expect(planEntryMove(sections, 'edu', 'e4', 1)).toMatchObject({ ok: false, code: 'index-out-of-range' });
  });
});
