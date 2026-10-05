/**
 * 覆盖区的坐标换算与校验单测（spec 3.5-03 的 U 半边：「白底覆盖精确：不盖住相邻文字」判在这里）。
 *
 * 这片不需要 Electron、也不需要真实 PDF：3.5-03 的判据是**算得对不对**，
 * 而算错的形状很固定——翻轴忘了、比例当 pt 用了、越界没拦住。三条都只能在这一层测得出。
 * 截图目视那半边按 plan §7.9 第 3 条等用户在场，本文件不假装收掉它。
 */
import { describe, expect, it } from 'vitest';
import type { PdfPageMetric } from './pdf-document.js';
import { isLatinOnly, planOverlays, toPageRect, type OverlayLimits, type PdfOverlayInput } from './overlay-writer.js';

/** A4 单页读数（595×842 pt），与 `@auto-cc/testing` 的 PDF 夹具同一尺寸。 */
const a4: PdfPageMetric = { number: 1, widthPt: 595, heightPt: 842 };

/** 三条尺度：测试里显式写全，改哪个断言就动哪个数。 */
const limits: OverlayLimits = { maxOverlays: 3, defaultTextSizePt: 11, minAreaRatio: 0.0001 };

/**
 * 造一条覆盖区输入。
 * @param overrides 想改的字段（页号、矩形、文字、字号）
 * @returns 一条合法输入的副本
 */
function overlay(overrides: Partial<PdfOverlayInput> = {}): PdfOverlayInput {
  return {
    id: 'box-1',
    pageNumber: 1,
    rect: { xRatio: 0.1, yRatio: 0.2, widthRatio: 0.3, heightRatio: 0.05 },
    ...overrides,
  };
}

describe('3.5-03 的坐标半边：比例（视觉，原点左上）↔ pt（PDF，原点左下）', () => {
  it('翻轴：视觉顶边 y=0.2、高 0.05 的框，底边落在 842 - 0.25×842', () => {
    expect(toPageRect({ xRatio: 0.1, yRatio: 0.2, widthRatio: 0.3, heightRatio: 0.05 }, a4)).toEqual({
      xPt: 59.5,
      yBottomPt: 842 - 0.25 * 842,
      widthPt: 178.5,
      heightPt: 42.1,
    });
  });

  it('整页框换算回整页：左上角归零、右下不出页（盖满不该留黑边）', () => {
    expect(toPageRect({ xRatio: 0, yRatio: 0, widthRatio: 1, heightRatio: 1 }, a4)).toEqual({
      xPt: 0,
      yBottomPt: 0,
      widthPt: 595,
      heightPt: 842,
    });
  });

  it('页面最底部的框（视觉 y=0.95）换算成贴着 PDF 底边的 42.1 pt', () => {
    expect(toPageRect({ xRatio: 0, yRatio: 0.95, widthRatio: 1, heightRatio: 0.05 }, a4).yBottomPt).toBeCloseTo(0, 10);
  });

  it('文字基线竖向居中：(高 - 字号)/2 加到底边上', () => {
    const planned = planOverlays([overlay({ text: 'REDACTED' })], [a4], limits);
    if (!planned.ok) throw new Error(planned.detail);
    expect(planned.overlays[0]).toMatchObject({
      text: 'REDACTED',
      sizePt: 11,
      textBaselinePt: 842 - 0.25 * 842 + (42.1 - 11) / 2,
    });
  });

  it('没写文字的覆盖区不给基线（只涂白底的区不该长出隐形文字）', () => {
    const planned = planOverlays([overlay()], [a4], limits);
    if (!planned.ok) throw new Error(planned.detail);
    expect(planned.overlays[0]?.text).toBeUndefined();
    expect(planned.overlays[0]?.textBaselinePt).toBeUndefined();
  });
});

describe('3.5-02 / 3.5-03 的边界校验：非法输入一条也不放过，且第一条说了就算', () => {
  /** 七条拒绝腿：每条给一个越界的字段，断言机器码而不是断言"抛了个错"。 */
  const cases: readonly { name: string; inputs: readonly PdfOverlayInput[]; code: string }[] = [
    { name: '条数超上限', inputs: [overlay(), overlay(), overlay(), overlay()], code: 'too-many' },
    { name: '页号不存在', inputs: [overlay({ pageNumber: 2 })], code: 'out-of-page' },
    {
      name: '比例非有限数',
      inputs: [overlay({ rect: { xRatio: Number.NaN, yRatio: 0.2, widthRatio: 0.3, heightRatio: 0.05 } })],
      code: 'out-of-bounds',
    },
    {
      name: '矩形出页（右边界 > 1）',
      inputs: [overlay({ rect: { xRatio: 0.8, yRatio: 0.1, widthRatio: 0.3, heightRatio: 0.1 } })],
      code: 'out-of-bounds',
    },
    {
      name: '细到看不见',
      inputs: [overlay({ rect: { xRatio: 0.1, yRatio: 0.1, widthRatio: 0.001, heightRatio: 0.001 } })],
      code: 'too-small',
    },
    { name: '字号越界', inputs: [overlay({ sizePt: 500 })], code: 'bad-size' },
    { name: '文字含中文', inputs: [overlay({ text: '覆盖中文哨兵' })], code: 'text-not-supported' },
  ];

  for (const item of cases) {
    it(`${item.name} → ${item.code}`, () => {
      const planned = planOverlays(item.inputs, [a4], limits);
      expect(planned.ok).toBe(false);
      if (!planned.ok) {
        expect(planned.code).toBe(item.code);
        expect(planned.detail).toMatch(/[\u4e00-\u9fa5]/);
      }
    });
  }

  it('合法清单全过：换算结果与页序无关，条数不少不增', () => {
    const planned = planOverlays([overlay({ id: 'a' }), overlay({ id: 'b', pageNumber: 1, text: 'OK' })], [a4], limits);
    if (!planned.ok) throw new Error(planned.detail);
    expect(planned.overlays.map((item) => item.id)).toEqual(['a', 'b']);
  });
});

describe('isLatinOnly：中文那条腿的闸门（裁定⑧ 未落，故必须先挡住）', () => {
  it('拉丁、数字、标点、Latin-1 补充都放过', () => {
    for (const text of ['Jane Doe', '2024.03 - present', 'Fudan Univ. (CS) ©±£', '']) {
      expect(isLatinOnly(text)).toBe(true);
    }
  });

  it('中日韩与全角标点一律挡住：标准 14 只字体没有 CJK 字形，硬画得到豆腐块', () => {
    for (const text of ['张三', 'ＦＵＤＡＮ', '经验·项目']) {
      expect(isLatinOnly(text)).toBe(false);
    }
  });
});
