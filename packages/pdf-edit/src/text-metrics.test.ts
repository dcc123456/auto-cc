/**
 * 字形度量的单测（spec 3.5-15 的 U 半边）。
 *
 * 三条判据都是**纯数**，不需要画布也不需要 Electron：字高度量的是矩阵的哪两列、
 * 升部占比的四档回落顺序对不对、pdf.js 报的字族名归到哪三种。
 * 「替换字在纸上与原文一般高」那一半是 V 判据，按 plan §7.1 走活体读数，本文件不假装收掉它。
 */
import { describe, expect, it } from 'vitest';

import { ascentRatioOf, fontFamilyHintOf, fontHeightPt } from './text-metrics.js';

describe('fontHeightPt：字高度取矩阵的第三、四列（照抄 pdf.js TextLayer 的那一句）', () => {
  it('水平文字：c=0、d=字号 ⇒ 字高度就是字号，与矩阵里的 a（水平缩放）无关', () => {
    // [a, b, c, d, e, f] = [12, 0, 0, 12, 72, 700]：一行 12pt 的水平文字。
    expect(fontHeightPt([12, 0, 0, 12, 72, 700])).toBe(12);
  });

  it('斜切（c 非零）时按长度算，不取 d：这是 pdf.js 的口径，不是"字号的另一种写法"', () => {
    expect(fontHeightPt([10, 0, 6, 8, 0, 0])).toBe(10);
  });

  it('旋转 90°（c/d 互换那一支）也量得出字高度', () => {
    expect(fontHeightPt([0, 11, -11, 0, 0, 0])).toBe(11);
  });

  it('矩阵形状不合（缺项、非数、Infinity）一律回 0，由调用方当"量不出这一行"', () => {
    expect(fontHeightPt([])).toBe(0);
    expect(fontHeightPt([1, 2, '3', 4, 5, 6])).toBe(0);
    expect(fontHeightPt([1, 2, Number.NaN, 4, 5, 6])).toBe(0);
    expect(fontHeightPt([1, 2, Number.POSITIVE_INFINITY, 4, 5, 6])).toBe(0);
  });
});

describe('ascentRatioOf：基线落在哪，由四档回落决定', () => {
  it('第一档：画布量得出 fontBoundingBox 就用它（这是 pdf.js 实际走的那一支）', () => {
    expect(ascentRatioOf({ measuredAscentPt: 24, measuredDescentPt: 6 })).toBeCloseTo(0.8, 10);
    // 降部读数是负的也没关系：调用方按 pdf.js 那句 `Math.abs(...)` 先取正，这里再验一次比例本身。
    expect(ascentRatioOf({ measuredAscentPt: 20, measuredDescentPt: 20 })).toBeCloseTo(0.5, 10);
  });

  it('画布量不到（0 / 负 / 非有限）时退到字体自带的 ascent', () => {
    expect(ascentRatioOf({ measuredAscentPt: 0, styleAscent: 0.75 })).toBe(0.75);
    expect(ascentRatioOf({ measuredAscentPt: Number.NaN, styleAscent: 0.75 })).toBe(0.75);
  });

  it('连 ascent 也没有时按 `1 + descent` 反推（pdf.js 的 descent 是负数）', () => {
    expect(ascentRatioOf({ styleDescent: -0.22 })).toBeCloseTo(0.78, 10);
  });

  it('四档全空即兜 0.8：行盒总要有个基线，这一档在 pdf.js 里也是同一个数', () => {
    expect(ascentRatioOf({})).toBe(0.8);
    // 比例掉出 (0,1) 之外（基线跑到行盒外）也当"这一档不合用"，继续往下退。
    expect(ascentRatioOf({ measuredAscentPt: 30, measuredDescentPt: 0, styleAscent: 0.9 })).toBeCloseTo(0.9, 10);
    expect(ascentRatioOf({ styleAscent: 1.4, styleDescent: -0.3 })).toBeCloseTo(0.7, 10);
  });
});

describe('fontFamilyHintOf：pdf.js 报的字族名归到导出侧真能兑现的三种', () => {
  it('子集前缀必须先摘，否则 `ABCDEF+FooSerif` 谁都匹配不上', () => {
    expect(fontFamilyHintOf('ABCDEF+FooSerif')).toBe('serif');
    expect(fontFamilyHintOf('GHIJKL+CourierNewPSMT')).toBe('monospace');
  });

  it('`sans-serif` 里也含 `serif`，所以衬线判定排在它后面', () => {
    expect(fontFamilyHintOf('sans-serif')).toBe('sans-serif');
    expect(fontFamilyHintOf('Helvetica Neue, sans-serif')).toBe('sans-serif');
    expect(fontFamilyHintOf('serif')).toBe('serif');
    expect(fontFamilyHintOf('TimesNewRoman')).toBe('serif');
    expect(fontFamilyHintOf('monospace')).toBe('monospace');
  });

  it('中文字体按声明名归类：宋体（SimSun）与 Songti / Ming 是衬线，认不出的一律无衬线', () => {
    expect(fontFamilyHintOf('ABCDEF+SimSun')).toBe('serif');
    expect(fontFamilyHintOf('STSongti-SC-Regular')).toBe('serif');
    expect(fontFamilyHintOf('NotoSerifCJKsc')).toBe('serif');
    // `NotoSansCJKjp` 里没有 `serif` 之外的分隔符，靠"先判 sans"这一条落回无衬线。
    expect(fontFamilyHintOf('NotoSansCJKjp')).toBe('sans-serif');
    expect(fontFamilyHintOf(undefined)).toBe('sans-serif');
    expect(fontFamilyHintOf('   ')).toBe('sans-serif');
  });
});
