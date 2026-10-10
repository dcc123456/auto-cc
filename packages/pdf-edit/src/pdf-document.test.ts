/**
 * `pdf-document.ts` 单元测试（spec 3.4-03 的引擎判据：`pdf-lib` 装载并生成合法 PDF；
 * 外加 plan §7.10 要求三种「打不开」都有确定态，以及 3.5-09 的「装载与另存都不碰源字节」半边）。
 *
 * 夹具来自 `@auto-cc/testing` 的手写 PDF 生成器：**不用 pdf-lib 造再让 pdf-lib 读**，
 * 否则「装载」这条腿等于自证（spec 3.4-03 要的是引擎对外部输入负责）。
 */
import { describe, expect, it } from 'vitest';
import { minimalEncryptedPdf, minimalMultiPagePdf, minimalPdf, pdfContentText } from '@auto-cc/testing';

import { latinStandardFontOf, PdfEditDocument } from './pdf-document.js';
import type { PlannedOverlay } from './overlay-writer.js';

describe('3.4-03 装载腿：把最小 PDF 读成一份可编辑文档', () => {
  it('单页：页数与 A4 宽高（pt）都读得出来，来源哈希是 sha256', async () => {
    const loaded = await PdfEditDocument.load(minimalPdf(['Jane Doe', 'Work Experience']));
    if (loaded.status !== 'loaded') throw new Error(`应当装载成功，实际是 ${loaded.reason}`);

    expect(loaded.document.pageCount).toBe(1);
    expect(loaded.document.sourcePageMetrics()).toEqual([{ number: 1, widthPt: 595, heightPt: 842 }]);
    expect(loaded.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('三页：页号从 1 连续排到 3，每页各量各的宽高', async () => {
    const loaded = await PdfEditDocument.load(minimalMultiPagePdf(3));
    if (loaded.status !== 'loaded') throw new Error(`应当装载成功，实际是 ${loaded.reason}`);

    expect(loaded.document.pageCount).toBe(3);
    expect(loaded.document.sourcePageMetrics().map((page) => page.number)).toEqual([1, 2, 3]);
  });
});

describe('3.4-03 生成腿：save 出去的字节要能被重新装载', () => {
  it('往返一次：页数与宽高不变，产物以 %PDF- 开头', async () => {
    const loaded = await PdfEditDocument.load(minimalMultiPagePdf(2));
    if (loaded.status !== 'loaded') throw new Error(`应当装载成功，实际是 ${loaded.reason}`);

    const saved = await loaded.document.save();
    expect(saved.slice(0, 5)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));

    const reloaded = await PdfEditDocument.load(saved);
    if (reloaded.status !== 'loaded') throw new Error(`产物应当是合法 PDF，实际是 ${reloaded.reason}`);
    expect(reloaded.document.pageCount).toBe(2);
    expect(reloaded.document.sourcePageMetrics()).toEqual(loaded.document.sourcePageMetrics());
  });

  it('同一份文档连存两次各自独立，且源字节始终是同一份（3.5-09 的半边）', async () => {
    const source = minimalPdf(['Fudan University']);
    const loaded = await PdfEditDocument.load(source);
    if (loaded.status !== 'loaded') throw new Error(`应当装载成功，实际是 ${loaded.reason}`);

    const first = await loaded.document.save();
    const second = await loaded.document.save();
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(first).not.toEqual(source);
    // 源字节被读了第三遍仍是同一份：装载没有把它移交出去，来源哈希因此可以当幂等键用。
    await expect(PdfEditDocument.load(source)).resolves.toMatchObject({
      status: 'loaded',
      sourceHash: loaded.sourceHash,
    });
  });
});

describe('plan §7.10 的确定态：打不开就给原因，不抛裸异常也不产出半成品', () => {
  const cases: readonly { name: string; bytes: Uint8Array; reason: 'empty' | 'encrypted' | 'invalid' }[] = [
    { name: '零字节', bytes: new Uint8Array(0), reason: 'empty' },
    {
      name: '有文件头但结构是垃圾',
      bytes: new Uint8Array(Buffer.from('%PDF-1.4\n这不是合法的 PDF 结构\n')),
      reason: 'invalid',
    },
    { name: '带加密字典', bytes: minimalEncryptedPdf(['Jane Doe']), reason: 'encrypted' },
  ];

  for (const item of cases) {
    it(`${item.name}：status 为 failed 且带技术原因`, async () => {
      const outcome = await PdfEditDocument.load(item.bytes);
      expect(outcome).toMatchObject({ status: 'failed', reason: item.reason });
      if (outcome.status === 'failed') expect(outcome.detail.length).toBeGreaterThan(0);
    });
  }
});

describe('3.5-02 的绘制半边：applyOverlays 只追加，页号越界当场抛而不静默跳过', () => {
  it('拿着别的文档的计划过来：抛错并说清是哪一区（跳过就等于产出少画几区的半成品）', async () => {
    const loaded = await PdfEditDocument.load(minimalMultiPagePdf(2));
    if (loaded.status !== 'loaded') throw new Error('夹具应当装得上');

    await expect(
      loaded.document.applyOverlays([
        { id: 'box-9', pageNumber: 3, xPt: 0, yBottomPt: 0, widthPt: 10, heightPt: 10, sizePt: 11 },
      ]),
    ).rejects.toThrow(/box-9.*源档第 3 页.*没有来自它的页/);
  });

  it('画过覆盖区的文档页数与每页宽高都不变——页面树没被动过（结构上必然的「非文本元素原样保留」）', async () => {
    const loaded = await PdfEditDocument.load(minimalMultiPagePdf(2));
    if (loaded.status !== 'loaded') throw new Error('夹具应当装得上');
    const before = loaded.document.sourcePageMetrics();

    await loaded.document.applyOverlays([
      {
        id: 'box-1',
        pageNumber: 2,
        xPt: 10,
        yBottomPt: 20,
        widthPt: 100,
        heightPt: 30,
        sizePt: 11,
        text: 'OK',
        textBaselinePt: 25,
      },
    ]);
    expect(loaded.document.sourcePageMetrics()).toEqual(before);
    // 实测：新落的文字在产物里是十六进制串（`<4F4B> Tj`），不是字面串，所以按同样的口径算出期望值。
    expect(pdfContentText(await loaded.document.save())).toContain('<4F4B> Tj');
  });
});

/**
 * 一条覆盖区在测试里的缺省几何（夹具是单页 A4，页号固定 1；字号 11pt 与 `textBaselinePt: 25` 一起
 * 构成"基线在矩形内"的形状，绘制侧照抄这两个数，不再自己算符号）。
 */
const overlayBase: PlannedOverlay = {
  id: 'box-1',
  pageNumber: 1,
  xPt: 10,
  yBottomPt: 20,
  widthPt: 100,
  heightPt: 30,
  sizePt: 11,
};

/**
 * 画完给定覆盖区后的**整份产物字节**。
 * @param plans 要画的区，每条只写想改的字段（给两条就能演「同一页两种字族」）
 * @returns 保存后的 PDF 字节
 */
async function drawn(...plans: readonly Partial<PlannedOverlay>[]): Promise<Uint8Array> {
  const loaded = await PdfEditDocument.load(minimalPdf(['Jane Doe']));
  if (loaded.status !== 'loaded') throw new Error('夹具应当装得上');
  await loaded.document.applyOverlays(
    plans.map((plan, index): PlannedOverlay => {
      const withGeometry = { ...overlayBase, id: `box-${String(index + 1)}`, ...plan };
      return withGeometry.text === undefined || withGeometry.textBaselinePt !== undefined
        ? withGeometry
        : { ...withGeometry, textBaselinePt: 25 };
    }),
  );
  return loaded.document.save();
}

/**
 * 画完给定覆盖区后的内容流文本（3.5-14 那一族颜色断言看的就是它）。
 * @param plans 同 `drawn`
 */
async function contentOf(...plans: readonly Partial<PlannedOverlay>[]): Promise<string> {
  return pdfContentText(await drawn(...plans));
}

describe('3.5-14 的绘制半边：垫底矩形取量到的纸色，量不到才按墨色，纯白一个字都不许出现', () => {
  /** 三条实测形状（本机 `pdf-lib` 1.17.1 的 `rg` 写法是**全精度小数**，写断言前用 `tmp/35-14-color-probe.mjs` 现读过一遍）。 */
  const SAMPLED_FILL = '0.9411764705882353 0.8235294117647058 0.7058823529411765 rg'; // #f0d2b4
  const FALLBACK_FILL = '0.06666666666666667 0.06666666666666667 0.06666666666666667 rg'; // #111111
  const FALLBACK_INK = '0.9725490196078431 0.9803921568627451 0.9882352941176471 rg'; // #f8fafc
  const SAMPLED_INK = '0.058823529411764705 0.09019607843137255 0.16470588235294117 rg'; // #0f172a

  it('量到了底色：矩形填那一个色号，新字取默认墨色，产物里没有 `1 1 1 rg`', async () => {
    const content = await contentOf({ backdropHex: '#f0d2b4', text: 'OK' });
    expect(content).toContain(SAMPLED_FILL);
    expect(content).toContain(SAMPLED_INK);
    expect(content).not.toContain('1 1 1 rg');
  });

  it('没量到底色：如实按墨黑垫底并把新字反白（宁可难看也不猜白），仍然没有 `1 1 1 rg`', async () => {
    const content = await contentOf({ text: 'OK' });
    expect(content).toContain(FALLBACK_FILL);
    expect(content).toContain(FALLBACK_INK);
    expect(content).not.toContain('1 1 1 rg');
  });

  it('只铺底不写字：这一条腿只有那一个颜色操作符，不该长出反白墨色', async () => {
    const content = await contentOf({});
    expect(content).toContain(FALLBACK_FILL);
    expect(content).not.toContain(FALLBACK_INK);
  });
});

describe('3.5-15 的绘制半边：量到的字族决定嵌哪只标准字体', () => {
  /**
   * 画完给定区后的**整份产物文本**（解开压缩的那一份）。
   * 为什么不是内容流单独看：`pdf-lib` 默认把字体字典写进**压缩的对象流**，而标准字体在资源表里的
   * 键是 `<字族名>-<对象号>`（本机 `tmp/35-15-font-probe.log` 实测：`/Times-Roman-7098480789 11 Tf`），
   * 所以判"嵌了哪只、被哪一笔用到"要解开之后整份看。
   * @param plans 同 `drawn`
   */
  async function productTextOf(...plans: readonly Partial<PlannedOverlay>[]): Promise<string> {
    return pdfContentText(await drawn(...plans));
  }

  /**
   * 数出产物里每一处 `/BaseFont`（**不去重**：同一只字体出现两次就是嵌了两次）。
   * @param text 解开压缩的产物文本
   */
  function baseFontsOf(text: string): string[] {
    return [...text.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+-]+)/g)].map((match) => match[1] as string);
  }

  /**
   * 列出内容流里每一次 `Tf` 用到的资源键。
   * @param text 解开压缩的产物文本
   */
  function textFontKeysOf(text: string): string[] {
    return [...text.matchAll(/\/([A-Za-z0-9+-]+) [0-9.]+ Tf/g)].map((match) => match[1] as string);
  }

  it('三档各映射到一只标准字体（枚举值以 `pdf-lib` 的 `.d.ts` 为准，§6.2）', () => {
    expect(latinStandardFontOf('serif')).toBe('Times-Roman');
    expect(latinStandardFontOf('monospace')).toBe('Courier');
    expect(latinStandardFontOf('sans-serif')).toBe('Helvetica');
  });

  it('量到 serif：嵌 Times 且**这一笔就用它**（嵌了却没用等于白嵌，字族还是对不上）', async () => {
    const text = await productTextOf({ text: 'AAA', fontFamilyHint: 'serif' });
    expect(baseFontsOf(text)).toContain('Times-Roman');
    expect(textFontKeysOf(text).filter((key) => key.startsWith('Times-Roman')).length).toBe(1);
  });

  it('量到 monospace：嵌 Courier；没量到（拖框那一腿）按无衬线走且绝不长出衬线名', async () => {
    const mono = await productTextOf({ text: 'AAA', fontFamilyHint: 'monospace' });
    expect(baseFontsOf(mono)).toContain('Courier');
    expect(textFontKeysOf(mono).filter((key) => key.startsWith('Courier')).length).toBe(1);

    const plain = await productTextOf({ text: 'AAA' });
    expect(plain).not.toContain('Times-Roman');
    expect(plain).not.toContain('/Courier');
  });

  it('两区两种字族 → 两只字体各用一次；两区同一字族 → 只嵌一次但用两笔（多嵌就是产物虚胖）', async () => {
    const mixed = await productTextOf(
      { text: 'AAA', fontFamilyHint: 'serif' },
      { text: 'BBB', fontFamilyHint: 'monospace', yBottomPt: 60 },
    );
    expect(baseFontsOf(mixed).filter((name) => name === 'Times-Roman').length).toBe(1);
    expect(baseFontsOf(mixed).filter((name) => name === 'Courier').length).toBe(1);
    expect(textFontKeysOf(mixed).length).toBe(3); // 夹具自己那一笔 + 新落的两笔

    const twoSerif = await productTextOf(
      { text: 'AAA', fontFamilyHint: 'serif' },
      { text: 'BBB', fontFamilyHint: 'serif', yBottomPt: 60 },
    );
    expect(baseFontsOf(twoSerif).filter((name) => name === 'Times-Roman').length).toBe(1);
    expect(textFontKeysOf(twoSerif).filter((key) => key.startsWith('Times-Roman')).length).toBe(2);
  });
});

describe('3.5-07 的引擎半边：按页序拷出新的页树', () => {
  it('页序就是 `1…n` 时直通返回自身，不重拷一遍文档', async () => {
    const loaded = await PdfEditDocument.load(minimalMultiPagePdf(3));
    if (loaded.status !== 'loaded') throw new Error('夹具应当装得上');
    expect(await loaded.document.arrange([1, 2, 3])).toBe(loaded.document);
  });

  it('排过页的文档带得出逐页来源：重复项在产物的两份位置上都算数', async () => {
    const loaded = await PdfEditDocument.load(minimalMultiPagePdf(3));
    if (loaded.status !== 'loaded') throw new Error('夹具应当装得上');
    const arranged = await loaded.document.arrange([2, 2, 1]);

    expect(arranged.pageCount).toBe(3);
    // 源档页数不因排页而变——覆盖区的页号上界一直是它。
    expect(arranged.sourcePageCount).toBe(3);
    expect(arranged.outputPageSources()).toEqual([2, 2, 1]);
    // 没进页序的那一页**根本不进产物**：新文档是逐页拷出来的，不是删出来的，
    // 所以这里断言的是"少了那一页的内容流"，而不是"某个对象被标记为删除"。
    const content = pdfContentText(await arranged.save());
    expect(content).toContain('(page 1) Tj');
    expect(content).not.toContain('(page 3) Tj');
  });

  it('覆盖区指向的源页在这一份页序里根本不存在：抛错而不是只画得到的那几页', async () => {
    const loaded = await PdfEditDocument.load(minimalMultiPagePdf(3));
    if (loaded.status !== 'loaded') throw new Error('夹具应当装得上');
    const arranged = await loaded.document.arrange([1, 1]);

    await expect(
      arranged.applyOverlays([
        { id: 'box-2', pageNumber: 3, xPt: 0, yBottomPt: 0, widthPt: 10, heightPt: 10, sizePt: 11 },
      ]),
    ).rejects.toThrow(/box-2.*源档第 3 页.*没有来自它的页/);
  });
});
