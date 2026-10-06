/**
 * `text-layout.ts` 的用例（spec 3.5-01 的坐标半边，plan §7.15）：
 * 钉住「pdf.js 的基线坐标 → 视觉比例矩形」这一次翻轴，以及哪些项不该画线框。
 *
 * 页面一律用 595×842（A4，与 `@auto-cc/testing` 那份 fixture 同一个 MediaBox），
 * 这样纯函数侧的数字与真实抽取侧（`layout-service.test.ts`）能直接对得上。
 */
import { describe, expect, it } from 'vitest';

import type { PdfPageMetric } from './pdf-document.js';
import { textItemRect, type PdfTextItemSlice } from './text-layout.js';

/** A4 首页度量，与 `minimalPdf` 的 MediaBox 一致。 */
const a4: PdfPageMetric = { number: 1, widthPt: 595, heightPt: 842 };

/**
 * 造一条文本项。
 * @param overrides 要改的成员（默认是一条 12pt、基线在 (50, 800)、宽 54.7 的正常项）
 * @returns 给 `textItemRect` 的切片
 */
function item(overrides: Partial<PdfTextItemSlice> = {}): PdfTextItemSlice {
  return { str: 'Jane Doe', transform: [12, 0, 0, 12, 50, 800], width: 54.7, height: 12, ...overrides };
}

describe('3.5-01 的翻轴：基线在 PDF 里朝上、在线框里朝下', () => {
  it('四个比例分别是左边距、顶边距、项宽与项高对页面的比', () => {
    const rect = textItemRect(item(), a4);
    expect(rect).not.toBeNull();
    expect(rect?.xRatio).toBeCloseTo(50 / 595, 10);
    // 顶边 = 页高 −（基线 + 项高）：842 − 812 = 30，而不是 800/842 那个「基线当顶边」的错读法。
    expect(rect?.yRatio).toBeCloseTo(30 / 842, 10);
    expect(rect?.widthRatio).toBeCloseTo(54.7 / 595, 10);
    expect(rect?.heightRatio).toBeCloseTo(12 / 842, 10);
  });

  it('同一页上更低的一行，yRatio 更大（轴没翻反）', () => {
    const upper = textItemRect(item({ transform: [12, 0, 0, 12, 50, 800] }), a4);
    const lower = textItemRect(item({ transform: [12, 0, 0, 12, 50, 780] }), a4);
    expect(upper?.yRatio).toBeLessThan(lower?.yRatio ?? 0);
    expect((lower?.yRatio ?? 0) - (upper?.yRatio ?? 0)).toBeCloseTo(20 / 842, 10);
  });

  it('线框与覆盖区共用同一份比例矩形，所以线框框住的地方可以直接当覆盖区用', () => {
    const rect = textItemRect(item(), a4);
    // 这条断言看着像类型检查，实际钉的是返回形状：`PdfOverlayRect` 的四个键一个不多一个不少，
    // 否则渲染层拿到的线框与它自己框出来的区不会是同一个类型（§2.5 的「一个入口」）。
    expect(Object.keys(rect ?? {}).sort()).toEqual(['heightRatio', 'widthRatio', 'xRatio', 'yRatio']);
  });
});

describe('不该画线框的项：返回 null 而不是画出一个坏框', () => {
  const cases: readonly { readonly name: string; readonly input: PdfTextItemSlice }[] = [
    { name: '空串', input: item({ str: '' }) },
    { name: '只有空白', input: item({ str: '   ' }) },
    { name: '没有 str', input: item({ str: undefined }) },
    { name: 'transform 不是数组', input: item({ transform: '50 800' }) },
    { name: 'transform 长度不足', input: item({ transform: [12, 0, 0] }) },
    { name: '坐标是 NaN', input: item({ transform: [12, 0, 0, 12, Number.NaN, 800] }) },
    { name: '坐标是 Infinity', input: item({ transform: [12, 0, 0, 12, 50, Number.POSITIVE_INFINITY] }) },
    { name: '宽度为 0', input: item({ width: 0 }) },
    { name: '高度为负', input: item({ height: -1 }) },
    { name: '宽度不是数', input: item({ width: '54.7' }) },
  ];

  for (const caseItem of cases) {
    it(caseItem.name, () => {
      expect(textItemRect(caseItem.input, a4)).toBeNull();
    });
  }

  it('页面度量为 0 时不除零（返回 null 而不是 Infinity）', () => {
    expect(textItemRect(item(), { number: 1, widthPt: 0, heightPt: 842 })).toBeNull();
    expect(textItemRect(item(), { number: 1, widthPt: 595, heightPt: 0 })).toBeNull();
  });
});

describe('超出页面的项照原样回比例，不在这里偷偷裁（越界是界面绘制侧的事）', () => {
  it('基线在页面之下的项得到大于 1 的 yRatio', () => {
    const rect = textItemRect(item({ transform: [12, 0, 0, 12, 50, -20] }), a4);
    expect(rect?.yRatio).toBeCloseTo((842 - -8) / 842, 10);
    expect(rect?.yRatio).toBeGreaterThan(1);
  });

  it('基线在页面之上的项得到负的 yRatio', () => {
    const rect = textItemRect(item({ transform: [12, 0, 0, 12, 50, 900] }), a4);
    expect(rect?.yRatio).toBeLessThan(0);
  });
});
