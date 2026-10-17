/**
 * 编辑器纯操作的用例（spec 3.6-01 的落点数学半边 + 3.6-02 的 U 半边 + 3.11-01 的打字判据，plan §8.4 / §16）。
 */
import { describe, expect, it } from 'vitest';
import {
  EDITOR_METRIC_BOUNDS,
  entryBodyLineCount,
  planCustomSectionCreate,
  planCustomSectionRename,
  planDesign,
  planEntryCreate,
  planEntryMerge,
  planEntryMove,
  planEntryRemove,
  planEntrySplit,
  planFieldText,
  planMetric,
  planSectionMove,
  planSectionRemove,
  type MetricKey,
} from './editor-ops.js';
import { DEFAULT_LAYOUT, makeField, type Entry, type Layout, type Section, type SectionKind } from './model.js';

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
    // 运行时它就是个字符串，会话外面递进来的键都必须过 `unknown-metric` 这一条。
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

/** 造一条给定字段的条目：键的顺序就是装配顺序，哪一格被事实锁定由 `makeField` 判（不在此处抄名单）。 */
function entryOf(kind: SectionKind, entryId: string, fields: ReadonlyArray<readonly [string, string]>): Entry {
  return { id: entryId, fields: fields.map(([key, value]) => makeField(kind, key, value)) };
}

/** 造一个区块（拆/合的作用域就是一个区块内部，所以条目一律喂进来而不是按 id 生成）。 */
function sectionOf(kind: SectionKind, id: string, entries: Entry[]): Section {
  return { id, kind, title: id, entries };
}

/** 取一条条目里某个键的值（断言里反复用，缺键就给 `undefined` 而不是抛）。 */
function valueOf(entry: Entry, key: string): string | undefined {
  return entry.fields.find((field) => field.key === key)?.value;
}

/** 一条条目的全部字段值按存值顺序成行——"这行的内容还在不在"就按这一份找。 */
function linesOf(entry: Entry): string[] {
  return entry.fields.flatMap((field) => field.value.split('\n'));
}

/** 三条正文各两行的经历区块（第一、二条同一条正文里混着一条完整的抬头行，就是导入漏拆的那种形状）。 */
function splitFixture(): Section[] {
  return [
    sectionOf('experience', 'exp', [
      entryOf('experience', 'e1', [
        ['company', '星桥'],
        ['role', '前端'],
        ['achievement', '带教三名实习生\n蓝鲸科技 - 支付中台开发 2021.03 - 2024.06\n把结算对账从三小时压到八分钟'],
      ]),
      entryOf('experience', 'e2', [
        ['company', '只有一行'],
        ['role', '岗位'],
        ['achievement', '孤行一条'],
      ]),
    ]),
    sectionOf('skills', 'skills', [entryOf('skills', 's1', [['text', 'TypeScript\nReact\nNode']])]),
  ];
}

describe('3.6-10 手动拆分：拆点只能是行号，四种拒绝各给一条确定的码', () => {
  it('查无区块 / 查无条目 / 没有正文 / 行号越界，四种都不抛异常且 detail 说得出界在哪', () => {
    const sections = splitFixture();
    expect(planEntrySplit(sections, 'zz', 'e1', 1)).toMatchObject({ ok: false, code: 'unknown-section' });
    expect(planEntrySplit(sections, 'exp', 'e9', 1)).toMatchObject({ ok: false, code: 'unknown-entry' });
    // 没有正文字段的条目（只带了 company/role）：拆它无意义，界面上的原因码 `no-body` 由此而来。
    const noBody = [sectionOf('experience', 'exp', [entryOf('experience', 'e1', [['company', '星桥']])])];
    expect(planEntrySplit(noBody, 'exp', 'e1', 1)).toMatchObject({ ok: false, code: 'no-body' });
    // 三行正文的可拆点是 1…2：0（拆在前一条之前）、3（拆完之后没有第二条）、非整数都不放行。
    for (const bad of [0, 3, 2.5, Number.NaN]) {
      const rejected = planEntrySplit(sections, 'exp', 'e1', bad);
      expect(rejected.ok, `拆点 ${String(bad)} 不该放行`).toBe(false);
      if (rejected.ok) continue;
      expect(rejected.code).toBe('index-out-of-range');
      expect(rejected.detail).toContain('1…2');
    }
    // 只有一行正文（e2）压根没有可拆点。
    expect(planEntrySplit(sections, 'exp', 'e2', 1)).toMatchObject({ ok: false, code: 'index-out-of-range' });
  });

  it('拆出的后半截按**导入时同一条规则**装抬头：`（二）` 这种装饰不会冒充公司名', () => {
    const sections = [
      sectionOf('experience', 'exp', [
        entryOf('experience', 'e1', [
          ['company', '星桥'],
          ['role', '前端'],
          // 导入漏拆的形状：三条经历挤在一条正文里，第二条的抬头行落在中间。拆点 1 让那一行进后半截。
          ['achievement', '负责官网首页\n（二）某公司 - 前端开发 2021.03 - 2024.06\n主导组件库迁移'],
        ]),
      ]),
    ];
    const result = planEntrySplit(sections, 'exp', 'e1', 1);
    if (!result.ok) throw new Error(`应当放行，实际 ${result.code}`);
    const tail = result.value[0]?.entries[1] as Entry;
    // 抬头三格都认出来了，且汉字序号装饰被摘掉——这一条就是 63-a 把 `stripLineMarkup` 一起搬过来的原因。
    expect(valueOf(tail, 'company')).toBe('某公司');
    expect(valueOf(tail, 'role')).toBe('前端开发');
    expect(valueOf(tail, 'period')).toBe('2021-03 - 2024-06');
    expect(valueOf(tail, 'achievement')).toBe('主导组件库迁移');
    expect(tail.fields.some((field) => field.value.includes('（二）'))).toBe(false);
  });

  it('拆后两条的正文拼起来与原条目逐字相同（不吞字），新条目 id 取本区块最大序号 +1 且不重排既有 id', () => {
    const sections = splitFixture();
    const original = sections[0]?.entries[0] as Entry;
    const before = valueOf(original, 'achievement');
    const result = planEntrySplit(sections, 'exp', 'e1', 2);
    if (!result.ok) throw new Error(`应当放行，实际 ${result.code}`);
    const [head, tail] = result.value[0]?.entries as [Entry, Entry];
    // 前半截只剩两行正文，其余字段（company/role）原样带着；引用换了新对象但 id 不动。
    expect(valueOf(head, 'achievement')).toBe('带教三名实习生\n蓝鲸科技 - 支付中台开发 2021.03 - 2024.06');
    expect(valueOf(head, 'company')).toBe('星桥');
    expect(head.id).toBe('e1');
    // 后半截首行被装成抬头（上一条），所以"逐字相同"要按**行**对齐：原文的每一行都能在两条里找到。
    expect((before ?? '').split('\n').every((line) => [...linesOf(head), ...linesOf(tail)].includes(line))).toBe(true);
    // 新 id：本区块现有 `<kind>-<n>` 里没有，故从 1 起；既有的 e1/e2 一字不动。
    expect(tail.id).toBe('experience-1');
    expect(result.value[0]?.entries.map((entry) => entry.id)).toEqual(['e1', 'experience-1', 'e2']);
    // 别的区块原样带着（引用相等），拆是局部动作。
    expect(result.value[1]).toBe(sections[1]);
  });

  it('技能与简介没有抬头这一说：拆出来两条都只有正文键', () => {
    const sections = splitFixture();
    const result = planEntrySplit(sections, 'skills', 's1', 1);
    if (!result.ok) throw new Error(`应当放行，实际 ${result.code}`);
    const [head, tail] = result.value[1]?.entries as [Entry, Entry];
    expect(head.fields.map((field) => field.key)).toEqual(['text']);
    expect(valueOf(head, 'text')).toBe('TypeScript');
    // 新条目 id 在技能区块里跟着 kind 走，与经历区块那条互不影响。
    expect(tail.id).toBe('skills-1');
    expect(valueOf(tail, 'text')).toBe('React\nNode');
  });

  it('投影里的行数与拆操作的界同源：按 `entryBodyLineCount` 拨到最大可拆点必然放行', () => {
    const sections = splitFixture();
    const target = sections[0]?.entries[0] as Entry;
    const count = entryBodyLineCount(target);
    expect(count).toBe(3);
    // 上界是"行数 − 1"（拆完两条都得有内容）：拨到它放行，拨到行数本身被拒。
    expect(planEntrySplit(sections, 'exp', 'e1', count - 1).ok).toBe(true);
    expect(planEntrySplit(sections, 'exp', 'e1', count)).toMatchObject({ ok: false, code: 'index-out-of-range' });
    // 没有正文字段的条目给 0（界面据此把「拆」那颗按不动，而不是让它拆出个空条目）。
    expect(entryBodyLineCount(entryOf('experience', 'e9', [['company', '星桥']]))).toBe(0);
  });
});

describe('3.6-10 手动合并：并回上一条，锁定字段按原样进正文', () => {
  it('区块第一条没有上一条可并，给 `nothing-to-merge` 且不动任何东西', () => {
    const sections = splitFixture();
    const rejected = planEntryMerge(sections, 'exp', 'e1');
    expect(rejected).toMatchObject({ ok: false, code: 'nothing-to-merge' });
    if (rejected.ok) throw new Error('区块第一条不该放行合并');
    expect(rejected.detail).toContain('第一条');
    expect(planEntryMerge(sections, 'zz', 'e2')).toMatchObject({ ok: false, code: 'unknown-section' });
    expect(planEntryMerge(sections, 'exp', 'e9')).toMatchObject({ ok: false, code: 'unknown-entry' });
  });

  it('被并走那条除正文以外的每一格按原样成行：事实锁定的 company/role/period 一个字都不丢', () => {
    const sections = [
      sectionOf('experience', 'exp', [
        entryOf('experience', 'e1', [
          ['company', '星桥'],
          ['role', '前端'],
          ['achievement', '带教三名实习生'],
        ]),
        entryOf('experience', 'e2', [
          ['company', '蓝鲸'],
          ['role', '支付中台'],
          ['period', '2021-03 - 2024-06'],
          ['achievement', '把对账从三小时压到八分钟'],
        ]),
        entryOf('experience', 'e3', [
          ['company', '另一家'],
          ['role', '岗位'],
        ]),
      ]),
    ];
    const result = planEntryMerge(sections, 'exp', 'e2');
    if (!result.ok) throw new Error(`应当放行，实际 ${result.code}`);
    const merged = result.value[0]?.entries[0] as Entry;
    // 顺序：前一条正文 → 被并走那条的其余格（存值顺序）→ 被并走那条的正文。
    expect(valueOf(merged, 'achievement')).toBe(
      '带教三名实习生\n蓝鲸\n支付中台\n2021-03 - 2024-06\n把对账从三小时压到八分钟',
    );
    // 前一条自己的抬头不受影响，被并走那条消失，第三条 id 与位置一字不动。
    expect(valueOf(merged, 'company')).toBe('星桥');
    expect(result.value[0]?.entries.map((entry) => entry.id)).toEqual(['e1', 'e3']);
    expect(linesOf(sections[0]?.entries[1] as Entry).every((line) => linesOf(merged).includes(line))).toBe(true);
  });

  it('前一条没有正文字段时，合并给它新建那一格而不是丢下内容（键沿用被并走那条的正文键）', () => {
    const sections = [
      sectionOf('education', 'edu', [
        entryOf('education', 'e1', [['school', '某大学']]),
        entryOf('education', 'e2', [
          ['school', '另一大学'],
          ['description', '计算机科学与技术 学士'],
        ]),
      ]),
    ];
    const result = planEntryMerge(sections, 'edu', 'e2');
    if (!result.ok) throw new Error(`应当放行，实际 ${result.code}`);
    const merged = result.value[0]?.entries[0] as Entry;
    // 教育区块的正文键是 `description`（`bodyKeyOf` 给的那一档），不是凭空造一个 `achievement`；
    // 前一条自己的 school 仍留在它那格（'某大学' 没被搬进正文，也没被丢），正文收到被并走那条的全部内容。
    expect(valueOf(merged, 'description')).toBe('另一大学\n计算机科学与技术 学士');
    expect(valueOf(merged, 'school')).toBe('某大学');
    expect(merged.fields.map((field) => field.key)).toEqual(['school', 'description']);
  });
});

describe('3.11-01 打字改一格：只换 value，四种拒绝各给一条确定的码', () => {
  it('改成果那一格：值换了、其余字段一字不动，别的区块引用相等，原序列不被就地改', () => {
    const sections = splitFixture();
    const before = sections[0]?.entries[0] as Entry;
    const result = planFieldText(sections, 'exp', 'e1', 'achievement', '改成的一行\n又加一行');
    if (!result.ok) throw new Error(`应当放行，实际 ${result.code}`);
    const patched = result.value[0]?.entries[0] as Entry;
    expect(valueOf(patched, 'achievement')).toBe('改成的一行\n又加一行');
    // 换行原样留着：打字框里的回车就是文档里的 `\n`，拆/并（3.6-10）与块级渲染（3.9-01）都读同一条算式。
    expect(valueOf(patched, 'role')).toBe('前端');
    // 同区块里没被点的那一条、以及别的区块都必须是**同一个引用**——打字是局部动作，不许重建任何人。
    expect(result.value[0]?.entries[1]).toBe(sections[0]?.entries[1]);
    expect(result.value[1]).toBe(sections[1]);
    expect(valueOf(before, 'achievement')).toContain('带教三名实习生');
  });

  it('事实锁定那一格（公司名）照样允许人打字改，但 `locked` / `factKey` 必须留着——「待确认」靠它们（裁定㉛）', () => {
    const sections = splitFixture();
    const field = (sections[0]?.entries[0] as Entry).fields.find((item) => item.key === 'company')!;
    const result = planFieldText(sections, 'exp', 'e1', 'company', '新的公司名');
    if (!result.ok) throw new Error(`应当放行，实际 ${result.code}`);
    const patched = (result.value[0]?.entries[0] as Entry).fields.find((item) => item.key === 'company');
    expect(patched).toMatchObject({ value: '新的公司名', locked: true, factKey: field.factKey });
  });

  it('空串与超长串都放行：这一格能装什么由 `fieldSchema.value` 那一份判据管，编辑器不自造界（§2.5）', () => {
    const sections = splitFixture();
    expect(planFieldText(sections, 'exp', 'e2', 'achievement', '').ok).toBe(true);
    expect(planFieldText(sections, 'exp', 'e2', 'achievement', '经'.repeat(5000)).ok).toBe(true);
  });

  it('查无区块 / 查无条目 / 查无此键 / 值不是字符串，四种都不抛异常', () => {
    const sections = splitFixture();
    expect(planFieldText(sections, 'zz', 'e1', 'achievement', 'x')).toMatchObject({
      ok: false,
      code: 'unknown-section',
    });
    expect(planFieldText(sections, 'exp', 'e9', 'achievement', 'x')).toMatchObject({
      ok: false,
      code: 'unknown-entry',
    });
    // 这一条没有 `description` 键：不许"当作新建"——界面递出的键只可能来自纸上的锚点，对不上就是定位错了。
    expect(planFieldText(sections, 'exp', 'e1', 'description', 'x')).toMatchObject({
      ok: false,
      code: 'unknown-field',
    });
    expect(planFieldText(sections, 'exp', 'e1', 'achievement', 3 as unknown as string)).toMatchObject({
      ok: false,
      code: 'not-a-text',
    });
  });
});

/** 造一个指定 kind 的区块（要素核对结构操作用）。 */
function kindSection(kind: SectionKind, id: string = kind, entryIds: readonly string[] = []): Section {
  return {
    id,
    kind,
    title: id,
    entries: entryIds.map((entryId) => ({ id: entryId, fields: [makeField(kind, 'text', entryId)] })),
  };
}

describe('要素核对：planEntryCreate / planEntryRemove', () => {
  it('custom 区块末尾加条目：id 挂区块 id 前缀（custom-1-2），字段是单个空 text', () => {
    const sections = [kindSection('custom', 'custom-1', ['custom-1-1'])];
    const result = planEntryCreate(sections, 'custom-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const created = result.value[0]!.entries[1]!;
    expect(created.id).toBe('custom-1-2');
    expect(created.fields).toEqual([makeField('custom', 'text', '')]);
    expect(sections[0]!.entries).toHaveLength(1); // 入参不被修改
  });

  it('经历区块加条目：给 company/role/achievement 三个空槽，不造 period', () => {
    const result = planEntryCreate([kindSection('experience')], 'experience');
    if (!result.ok) return expect(result.ok).toBe(true);
    expect(result.value[0]!.entries[0]!.fields.map((field) => field.key)).toEqual(['company', 'role', 'achievement']);
  });

  it('删条目：指定条目消失、其余保留；删到零条也合法（空区块渲染跳过）', () => {
    const sections = [kindSection('custom', 'custom-1', ['custom-1-1', 'custom-1-2'])];
    const removed = planEntryRemove(sections, 'custom-1', 'custom-1-1');
    if (!removed.ok) return expect(removed.ok).toBe(true);
    expect(removed.value[0]!.entries.map((entry) => entry.id)).toEqual(['custom-1-2']);
    const again = planEntryRemove(removed.value, 'custom-1', 'custom-1-2');
    if (!again.ok) return expect(again.ok).toBe(true);
    expect(again.value[0]!.entries).toEqual([]);
  });

  it('查无区块 / 查无条目各给确定拒绝码', () => {
    expect(planEntryCreate([], 'nope')).toMatchObject({ ok: false, code: 'unknown-section' });
    expect(planEntryRemove([kindSection('custom', 'custom-1', ['custom-1-1'])], 'custom-1', 'x')).toMatchObject({
      ok: false,
      code: 'unknown-entry',
    });
  });
});

describe('要素核对：custom 区块的增 / 删 / 改名', () => {
  it('新建 custom：id 接现有最大编号，标题 trim，初始无条目', () => {
    const sections = [
      kindSection('summary'),
      kindSection('custom', 'custom-1', ['custom-1-1']),
      kindSection('custom', 'custom-3'),
    ];
    const result = planCustomSectionCreate(sections, '  证书 ');
    if (!result.ok) return expect(result.ok).toBe(true);
    expect(result.value[3]).toMatchObject({ id: 'custom-4', kind: 'custom', title: '证书', entries: [] });
  });

  it('空白标题拒绝（empty-title），超过 16 字拒绝（title-too-long）', () => {
    expect(planCustomSectionCreate([], '   ')).toMatchObject({ ok: false, code: 'empty-title' });
    expect(planCustomSectionCreate([], '证'.repeat(17))).toMatchObject({ ok: false, code: 'title-too-long' });
  });

  it('只有 custom 区块可整块删除：固定六类给 section-not-removable，查无给 unknown-section', () => {
    const sections = [kindSection('experience', 'experience'), kindSection('custom', 'custom-1')];
    expect(planSectionRemove(sections, 'experience')).toMatchObject({ ok: false, code: 'section-not-removable' });
    expect(planSectionRemove(sections, 'nope')).toMatchObject({ ok: false, code: 'unknown-section' });
    const removed = planSectionRemove(sections, 'custom-1');
    if (!removed.ok) return expect(removed.ok).toBe(true);
    expect(removed.value.map((section) => section.id)).toEqual(['experience']);
  });

  it('改名：custom 可改（trim 生效），固定六类拒绝，空白 / 超长拒绝', () => {
    const sections = [kindSection('experience', 'experience'), kindSection('custom', 'custom-1')];
    const renamed = planCustomSectionRename(sections, 'custom-1', ' 荣誉奖项 ');
    if (!renamed.ok) return expect(renamed.ok).toBe(true);
    expect(renamed.value[1]!.title).toBe('荣誉奖项');
    expect(planCustomSectionRename(sections, 'experience', 'x')).toMatchObject({
      ok: false,
      code: 'section-not-removable',
    });
    expect(planCustomSectionRename(sections, 'custom-1', '')).toMatchObject({ ok: false, code: 'empty-title' });
  });
});
