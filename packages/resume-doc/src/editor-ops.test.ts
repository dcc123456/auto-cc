/**
 * 编辑器纯操作的用例（spec 3.6-01 的落点数学半边 + 3.6-02 的 U 半边，plan §8.4 的 3.6-a 那一格）。
 */
import { describe, expect, it } from 'vitest';
import {
  EDITOR_METRIC_BOUNDS,
  planDesign,
  planEntryMove,
  planMetric,
  planSectionMove,
  type MetricKey,
} from './editor-ops.js';
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

describe('6.6-05 样式补丁的判定半边（颜色形状、档位、数值界与"取消那一格"）', () => {
  /** 一份带主题的版面：主题两色 + 正文两轴 + experience 的两条段落轴，用来验证补丁是"改而不是换"。 */
  const styled = (): Layout => {
    const first = planDesign(DEFAULT_LAYOUT, {
      inkHex: '#0b5c50',
      accentHex: '#a31621',
      body: { fontFamily: 'serif', sizePt: 11 },
      paragraph: { kind: 'experience', align: 'justify', inkHex: '#101820' },
    });
    if (!first.ok) throw new Error('前置补丁应当放行');
    return first.value;
  };

  it('合法补丁只动 design，度量与纸张一字不改', () => {
    const result = planDesign(DEFAULT_LAYOUT, {
      paperHex: '#f7f5f2',
      body: { weight: 'medium' },
      paragraph: { kind: 'skills', sizePt: 9 },
    });
    if (!result.ok) throw new Error('应当放行');
    expect(result.value.design).toMatchObject({
      paperHex: '#f7f5f2',
      body: { weight: 'medium' },
      paragraphs: { skills: { sizePt: 9 } },
    });
    expect(result.value.baseFontPt).toBe(DEFAULT_LAYOUT.baseFontPt);
    expect(result.value.margin).toEqual(DEFAULT_LAYOUT.margin);
    expect(result.value.pageSize).toBe(DEFAULT_LAYOUT.pageSize);
    expect(result.value.columns).toBe(DEFAULT_LAYOUT.columns);
  });

  it('补丁是"改"：已有的每一格都沿用，只覆盖给到的那几格', () => {
    const result = planDesign(styled(), { inkHex: '#aa0000' });
    if (!result.ok) throw new Error('应当放行');
    expect(result.value.design).toMatchObject({
      inkHex: '#aa0000',
      accentHex: '#a31621',
      body: { fontFamily: 'serif', sizePt: 11 },
      paragraphs: { experience: { align: 'justify', inkHex: '#101820' } },
    });
  });

  it('空补丁不落空壳：`design` 这一格要么不存在、要么原样', () => {
    const bare = planDesign(DEFAULT_LAYOUT, {});
    if (!bare.ok) throw new Error('应当放行');
    // `'design' in layout` 必须是 false：留一个 `{}` 会让"从没设过主题"与"设过又清空"在产物里分不开。
    expect('design' in bare.value).toBe(false);
    const kept = planDesign(styled(), {});
    if (!kept.ok) throw new Error('应当放行');
    expect(kept.value.design).toEqual(styled().design);
  });

  it('取消到只剩一格时只留那一格，取消到一无所有时整格消失', () => {
    const cleared = planDesign(styled(), {
      inkHex: null,
      paperHex: null,
      accentHex: null,
      body: null,
      paragraph: {
        kind: 'experience',
        sizePt: null,
        weight: null,
        align: null,
        lineHeight: null,
        inkHex: null,
        backdropHex: null,
      },
    });
    if (!cleared.ok) throw new Error('应当放行');
    expect('design' in cleared.value).toBe(false);

    // 只留 accentHex 那一格：`body` 整组取消、`paragraph` 那一类整格消失，都不该留下 `{}` 空壳。
    const oneLeft = planDesign(styled(), {
      inkHex: null,
      paperHex: null,
      body: null,
      paragraph: { kind: 'experience', align: null, inkHex: null },
    });
    if (!oneLeft.ok) throw new Error('应当放行');
    expect(oneLeft.value.design).toEqual({ accentHex: '#a31621' });
  });

  it('坏颜色、坏档位、坏种类与界外数值各给一条确定的拒绝码，都不抛异常', () => {
    for (const bad of ['#12345', 'red', '#GGHHII', '#0f172a ', '']) {
      const rejected = planDesign(DEFAULT_LAYOUT, { inkHex: bad });
      expect(rejected.ok, `颜色 ${JSON.stringify(bad)} 不该放行`).toBe(false);
      if (rejected.ok) continue;
      expect(rejected.code).toBe('bad-color');
      // 轴名要在理由里：界面得把话说到哪一格，而不是笼统报"颜色不对"。
      expect(rejected.detail).toContain('inkHex');
    }
    expect(planDesign(DEFAULT_LAYOUT, { body: { weight: 'heavy' as never } })).toMatchObject({
      ok: false,
      code: 'bad-token',
    });
    expect(
      planDesign(DEFAULT_LAYOUT, { paragraph: { kind: 'awards' as never, align: 'middle' as never } }),
    ).toMatchObject({ ok: false, code: 'unknown-kind' });
    expect(planDesign(DEFAULT_LAYOUT, { paragraph: { kind: 'skills', align: 'middle' as never } })).toMatchObject({
      ok: false,
      code: 'bad-token',
    });
    // 段落字号沿用度量那一档界（6…24），行距沿用 1…3——同一张界表，不另立第二个数（§2.5）。
    expect(planDesign(DEFAULT_LAYOUT, { body: { sizePt: 30 } })).toMatchObject({ ok: false, code: 'out-of-bounds' });
    expect(planDesign(DEFAULT_LAYOUT, { paragraph: { kind: 'skills', lineHeight: 4 } })).toMatchObject({
      ok: false,
      code: 'out-of-bounds',
    });
    expect(planDesign(DEFAULT_LAYOUT, { paragraph: { kind: 'skills', sizePt: Number.NaN } })).toMatchObject({
      ok: false,
      code: 'not-a-number',
    });
  });

  it('一类区块的六条轴全被取消时那一格整格消失，别的种类原样带着', () => {
    const two = planDesign(styled(), { paragraph: { kind: 'project', backdropHex: '#f7f5f2' } });
    if (!two.ok) throw new Error('应当放行');
    expect(Object.keys(two.value.design?.paragraphs ?? {})).toEqual(['experience', 'project']);
    const dropped = planDesign(two.value, { paragraph: { kind: 'project', backdropHex: null } });
    if (!dropped.ok) throw new Error('应当放行');
    expect(Object.keys(dropped.value.design?.paragraphs ?? {})).toEqual(['experience']);
  });
});
