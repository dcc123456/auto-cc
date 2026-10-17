/**
 * 统一对象模型的单测：页计划/对象的边界校验 + 旋转几何换算。
 *
 * 几何那几条是 E2 活体验收之外的数学底线：阅读器把页面顺时针转正 R，我们的绘制先逆时针 R，
 * 角点必须严丝合缝——这个只有纯数单测判得准，截图只能看个大概。
 */
import { describe, expect, it } from 'vitest';
import {
  displayedSize,
  placeVisualPointRatio,
  placeVisualRect,
  planEditorObjects,
  planEditorPages,
  sniffImageMagic,
  type PageGeometry,
  type PdfEditorObjectInput,
  type PdfEditorPageInput,
} from './object-model.js';

/** 三页源档、产物上限十页、对象上限一百，测试只改需要演的那几条。 */
const pageLimits = { sourcePageCount: 3, maxPages: 10, defaultBlankWidthPt: 595.28, defaultBlankHeightPt: 841.89 };
const objectLimits = { maxObjects: 100, defaultTextSizePt: 11, minAreaRatio: 0.0001 };

/** 一页源计划的构造口（省得每条用例都写一遍 union）。 */
function sourcePage(id: string, sourcePageNumber: number, rotation?: 0 | 90 | 180 | 270): PdfEditorPageInput {
  return rotation === undefined
    ? { id, kind: 'source', sourcePageNumber }
    : { id, kind: 'source', sourcePageNumber, rotation };
}

/** 一个矩形对象的最小构造。 */
function object(partial: Partial<PdfEditorObjectInput> & Pick<PdfEditorObjectInput, 'id' | 'kind' | 'pageId'>): PdfEditorObjectInput {
  return {
    rect: { xRatio: 0.1, yRatio: 0.1, widthRatio: 0.2, heightRatio: 0.05 },
    ...partial,
  };
}

describe('planEditorPages：源页副本 / 空白页 / 旋转的校验与规整', () => {
  it('源页条目原样规整；旋转缺省时规整结果里根本没有 rotation 键（=保留源档 /Rotate）', () => {
    const outcome = planEditorPages([sourcePage('p1', 1), sourcePage('p2', 2, 0)], 3, pageLimits);
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) throw new Error('应当通过');
    expect(outcome.pages[0]).toEqual({ id: 'p1', kind: 'source', sourcePageNumber: 1, widthPt: 0, heightPt: 0 });
    expect(outcome.pages[1]).toMatchObject({ id: 'p2', rotation: 0 });
  });

  it('空白页缺省尺寸取 A4 竖版', () => {
    const outcome = planEditorPages([{ id: 'b1', kind: 'blank' }], 3, pageLimits);
    if (!outcome.ok) throw new Error('应当通过');
    expect(outcome.pages[0]).toMatchObject({ kind: 'blank', widthPt: 595.28, heightPt: 841.89, rotation: 0 });
  });

  it('重复页号是副本：同一源出现两次不拒', () => {
    const outcome = planEditorPages([sourcePage('a', 2), sourcePage('b', 2), sourcePage('c', 1)], 3, pageLimits);
    expect(outcome.ok).toBe(true);
  });

  it('空计划、条目 id 重复、源页越界、旋转角非法、空白页尺寸离谱各拒各的码', () => {
    expect(planEditorPages([], 3, pageLimits)).toMatchObject({ ok: false, code: 'empty-pages' });
    expect(planEditorPages([sourcePage('a', 1), sourcePage('a', 2)], 3, pageLimits)).toMatchObject({
      ok: false,
      code: 'duplicate-page-id',
    });
    expect(planEditorPages([sourcePage('a', 4)], 3, pageLimits)).toMatchObject({ ok: false, code: 'page-out-of-range' });
    expect(planEditorPages([sourcePage('a', 1, 45 as 90)], 3, pageLimits)).toMatchObject({
      ok: false,
      code: 'bad-rotation',
    });
    expect(planEditorPages([{ id: 'b', kind: 'blank', widthPt: 10, heightPt: 10 }], 3, pageLimits)).toMatchObject({
      ok: false,
      code: 'bad-blank-size',
    });
    expect(planEditorPages([{ id: 'b', kind: 'blank' }], 0, pageLimits)).toMatchObject({ ok: true });
  });

  it('超页数上限拒（外部输入不设界就能把主进程内存顶满）', () => {
    const pages = Array.from({ length: 11 }, (_, index) => sourcePage(`p${String(index)}`, 1));
    expect(planEditorPages(pages, 3, pageLimits)).toMatchObject({ ok: false, code: 'too-many-pages' });
  });
});

describe('planEditorObjects：五类对象的边界校验', () => {
  const pages = [sourcePage('p1', 1)];
  const plannedPages = planEditorPages(pages, 3, pageLimits);
  if (!plannedPages.ok) throw new Error('夹具页计划应通过');

  it('text：文字、字号、颜色、字族、基线、粗斜下划线都规整', () => {
    const outcome = planEditorObjects(
      [
        object({
          id: 't1',
          pageId: 'p1',
          kind: 'text',
          text: 'Jane Doe',
          sizePt: 14,
          colorHex: '#123456',
          backdropHex: '#FFFFFF',
          fontFamilyHint: 'serif',
          baselineYRatio: 0.21,
          bold: true,
          underline: true,
        }),
      ],
      plannedPages.pages,
      objectLimits,
    );
    if (!outcome.ok) throw new Error(`应当通过：${outcome.detail}`);
    expect(outcome.objects[0]).toMatchObject({
      id: 't1',
      sizePt: 14,
      colorHex: '#123456',
      backdropHex: '#ffffff',
      fontFamilyHint: 'serif',
      baselineYRatio: 0.21,
      bold: true,
      italic: false,
      underline: true,
    });
  });

  it('text 省略字号取默认；note 固定 9pt；highlight 只认颜色', () => {
    const outcome = planEditorObjects(
      [
        object({ id: 't', pageId: 'p1', kind: 'text', text: 'x' }),
        object({ id: 'n', pageId: 'p1', kind: 'note', text: '一条便签' }),
        object({ id: 'h', pageId: 'p1', kind: 'highlight', rect: { xRatio: 0, yRatio: 0, widthRatio: 0.3, heightRatio: 0.02 } }),
      ],
      plannedPages.pages,
      objectLimits,
    );
    if (!outcome.ok) throw new Error(`应当通过：${outcome.detail}`);
    const byId = new Map(outcome.objects.map((item) => [item.id, item]));
    expect(byId.get('t')?.sizePt).toBe(11);
    expect(byId.get('n')?.sizePt).toBe(9);
    expect(byId.get('h')?.colorHex).toBeUndefined();
  });

  it('image：必须带图片路径；shape：描边宽越界拒；非 hex 颜色静默丢弃（不当失败）', () => {
    const rejected = planEditorObjects([object({ id: 'i', pageId: 'p1', kind: 'image' })], plannedPages.pages, objectLimits);
    expect(rejected).toMatchObject({ ok: false, code: 'image-path-required' });
    const badWidth = planEditorObjects(
      [object({ id: 's', pageId: 'p1', kind: 'shape', borderWidthPt: 99 })],
      plannedPages.pages,
      objectLimits,
    );
    expect(badWidth).toMatchObject({ ok: false, code: 'bad-border-width' });
    const weirdColor = planEditorObjects(
      [object({ id: 's2', pageId: 'p1', kind: 'shape', colorHex: 'red' })],
      plannedPages.pages,
      objectLimits,
    );
    if (!weirdColor.ok) throw new Error('应当通过');
    expect(weirdColor.objects[0]?.colorHex).toBeUndefined();
  });

  it('页 id 不认、矩形越界、面积太小、空文字、emoji、字号越界各拒各的码', () => {
    const cases: readonly { code: string; input: PdfEditorObjectInput }[] = [
      { code: 'object-page-unknown', input: object({ id: 'a', pageId: 'nope', kind: 'highlight' }) },
      {
        code: 'object-out-of-bounds',
        input: object({ id: 'b', pageId: 'p1', kind: 'highlight', rect: { xRatio: 0.9, yRatio: 0, widthRatio: 0.2, heightRatio: 0.1 } }),
      },
      {
        code: 'object-too-small',
        input: object({ id: 'c', pageId: 'p1', kind: 'highlight', rect: { xRatio: 0, yRatio: 0, widthRatio: 0.001, heightRatio: 0.001 } }),
      },
      { code: 'text-required', input: object({ id: 'd', pageId: 'p1', kind: 'text', text: '' }) },
      { code: 'text-not-supported', input: object({ id: 'e', pageId: 'p1', kind: 'text', text: '你好😀' }) },
      { code: 'bad-size', input: object({ id: 'f', pageId: 'p1', kind: 'text', text: 'x', sizePt: 200 }) },
    ];
    for (const item of cases) {
      expect(planEditorObjects([item.input], plannedPages.pages, objectLimits)).toMatchObject({
        ok: false,
        code: item.code,
      });
    }
  });

  it('中文可画（白名单内），超条数拒，id 重复拒，未知类型拒', () => {
    const ok = planEditorObjects(
      [object({ id: 'z', pageId: 'p1', kind: 'text', text: '三年经验，本科' })],
      plannedPages.pages,
      objectLimits,
    );
    expect(ok.ok).toBe(true);
    expect(
      planEditorObjects(
        [object({ id: 'x', pageId: 'p1', kind: 'text', text: 'a' }), object({ id: 'x', pageId: 'p1', kind: 'note' })],
        plannedPages.pages,
        objectLimits,
      ),
    ).toMatchObject({ ok: false, code: 'duplicate-object-id' });
    expect(
      planEditorObjects([object({ id: 'u', pageId: 'p1', kind: 'stamp' as 'note' })], plannedPages.pages, objectLimits),
    ).toMatchObject({ ok: false, code: 'unknown-kind' });
    const many = Array.from({ length: 101 }, (_, index) =>
      object({ id: `o${String(index)}`, pageId: 'p1', kind: 'highlight', rect: { xRatio: 0, yRatio: 0, widthRatio: 0.01, heightRatio: 0.01 } }),
    );
    expect(planEditorObjects(many, plannedPages.pages, objectLimits)).toMatchObject({ ok: false, code: 'too-many-objects' });
  });
});

describe('旋转几何：四档显示旋转下视觉矩形/点的落位', () => {
  // 源档是竖版 A4（595×842）；90/270 时显示面横过来（842×595）。
  const portrait: PageGeometry = { widthPt: 595, heightPt: 842, rotation: 0 };
  const r90: PageGeometry = { widthPt: 595, heightPt: 842, rotation: 90 };
  const r180: PageGeometry = { widthPt: 595, heightPt: 842, rotation: 180 };
  const r270: PageGeometry = { widthPt: 595, heightPt: 842, rotation: 270 };

  it('displayedSize：90/270 宽高互换', () => {
    expect(displayedSize(portrait)).toEqual({ widthPt: 595, heightPt: 842 });
    expect(displayedSize(r90)).toEqual({ widthPt: 842, heightPt: 595 });
    expect(displayedSize(r270)).toEqual({ widthPt: 842, heightPt: 595 });
  });

  it('整页矩形四档旋转都盖满整页（绘制原点随角走，宽高 90/270 互换）', () => {
    const full = { xRatio: 0, yRatio: 0, widthRatio: 1, heightRatio: 1 };
    expect(placeVisualRect(full, portrait)).toMatchObject({ xPt: 0, yPt: 0, widthPt: 595, heightPt: 842, drawRotationDegrees: 0 });
    expect(placeVisualRect(full, r90)).toMatchObject({ xPt: 595, yPt: 0, widthPt: 842, heightPt: 595, drawRotationDegrees: 90 });
    expect(placeVisualRect(full, r180)).toMatchObject({ xPt: 595, yPt: 0, widthPt: 595, heightPt: 842, drawRotationDegrees: 180 });
    expect(placeVisualRect(full, r270)).toMatchObject({ xPt: 0, yPt: 842, widthPt: 842, heightPt: 595, drawRotationDegrees: 270 });
  });

  it('视觉四角在 90 档映射到原生四个角（阅读器转正后归位）', () => {
    const corners: readonly [number, number, number, number][] = [
      // 视觉左上 → 原生左下；右上 → 原生左上；右下 → 原生右上；左下 → 原生右下
      [0, 0, 0, 0],
      [1, 0, 0, 842],
      [1, 1, 595, 842],
      [0, 1, 595, 0],
    ];
    for (const [xr, yr, nx, ny] of corners) {
      expect(placeVisualPointRatio(xr, yr, r90)).toMatchObject({ xPt: nx, yPt: ny });
    }
  });

  it('180 / 270 的视觉左上各自对上原生的右上角，中心点四档都在页心', () => {
    expect(placeVisualPointRatio(0, 0, r180)).toMatchObject({ xPt: 595, yPt: 842 });
    expect(placeVisualPointRatio(0, 0, r270)).toMatchObject({ xPt: 595, yPt: 842 });
    for (const geometry of [portrait, r90, r180, r270]) {
      const center = placeVisualPointRatio(0.5, 0.5, geometry);
      expect(center.xPt).toBeCloseTo(595 / 2);
      expect(center.yPt).toBeCloseTo(842 / 2);
    }
  });
});

describe('sniffImageMagic：只认文件头不认扩展名', () => {
  it('PNG / JPEG 魔数各认各的，别的字节给 undefined', () => {
    expect(sniffImageMagic(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('png');
    expect(sniffImageMagic(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImageMagic(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeUndefined();
    expect(sniffImageMagic(new Uint8Array([0x01, 0x02]))).toBeUndefined();
  });
});
