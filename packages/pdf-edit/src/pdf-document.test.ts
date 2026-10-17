/**
 * `pdf-document.ts` 单元测试（spec 3.4-03 的引擎判据：`pdf-lib` 装载并生成合法 PDF；
 * 外加 plan §7.10 要求三种「打不开」都有确定态，以及 3.5-09 的「装载与另存都不碰源字节」半边）。
 *
 * 夹具来自 `@auto-cc/testing` 的手写 PDF 生成器：**不用 pdf-lib 造再让 pdf-lib 读**，
 * 否则「装载」这条通道等于自证（spec 3.4-03 要的是引擎对外部输入负责）。
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { encodePng, minimalEncryptedPdf, minimalMultiPagePdf, minimalPdf, pdfContentText } from '@auto-cc/testing';

import { latinStandardFontOf, PdfEditDocument, type EditorImageAsset } from './pdf-document.js';
import {
  planEditorObjects,
  planEditorPages,
  type PdfEditorObjectInput,
  type PdfEditorPageInput,
} from './object-model.js';
import type { PlannedOverlay } from './overlay-writer.js';

describe('3.4-03 装载通道：把最小 PDF 读成一份可编辑文档', () => {
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

describe('3.4-03 生成通道：save 出去的字节要能被重新装载', () => {
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

  it('只铺底不写字：这一条通道只有那一个颜色操作符，不该长出反白墨色', async () => {
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

  it('量到 monospace：嵌 Courier；没量到（拖框那一条）按无衬线走且绝不长出衬线名', async () => {
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

/**
 * WPS 形态编辑器（assembleEditor）这一族的共用夹具：把「比例输入」先过一遍校验规整，
 * 引擎测试只演引擎该负责的事（拷页/空白页/旋转/绘制），判据重复写在这里就是两份事实。
 */
const editorLimits = {
  pages: { sourcePageCount: 3, maxPages: 10, defaultBlankWidthPt: 595.28, defaultBlankHeightPt: 841.89 },
  objects: { maxObjects: 100, defaultTextSizePt: 11, minAreaRatio: 0.0001 },
} as const;

/** 过校验取出规整页计划；夹具写得不对应当场炸，而不是让引擎替它兜。 */
function plannedPagesOf(inputs: readonly PdfEditorPageInput[]) {
  const outcome = planEditorPages(inputs, 3, editorLimits.pages);
  if (!outcome.ok) throw new Error(`夹具页计划不合法：${outcome.detail}`);
  return outcome.pages;
}

/** 过校验取出规整对象。 */
function plannedObjectsOf(pages: readonly PdfEditorPageInput[], inputs: readonly PdfEditorObjectInput[]) {
  const outcome = planEditorObjects(inputs, plannedPagesOf(pages), editorLimits.objects);
  if (!outcome.ok) throw new Error(`夹具对象不合法：${outcome.detail}`);
  return outcome.objects;
}

/** 1×1 不透明红 PNG（用测试夹具的规范编码器现造，embedPng 真的嵌得进去）。 */
const ONE_PIXEL_PNG = new Uint8Array(encodePng(Buffer.from([0xff, 0x00, 0x00, 0xff]), 1, 1, 0, true));

describe('WPS 编辑器 assembleEditor：页计划装页（副本/空白页/旋转）', () => {
  it('源页副本 + 空白页：页数、空白页尺寸、源页内容都按计划落位，产物可重新装载', async () => {
    const loaded = await PdfEditDocument.load(minimalMultiPagePdf(2));
    if (loaded.status !== 'loaded') throw new Error('夹具应当装得上');
    const pages: readonly PdfEditorPageInput[] = [
      { id: 'dup-a', kind: 'source', sourcePageNumber: 1 },
      { id: 'blank', kind: 'blank' },
      { id: 'dup-b', kind: 'source', sourcePageNumber: 1 },
    ];
    const assembled = await loaded.document.assembleEditor(plannedPagesOf(pages), []);

    expect(assembled.pageCount).toBe(3);
    expect(assembled.outputPageSources()).toEqual([1, 0, 1]); // 0 是空白页的来源记号
    const saved = await assembled.save();
    const pdfDoc = await PDFDocument.load(saved);
    expect(pdfDoc.getPageCount()).toBe(3);
    // 空白页取默认 A4（pdf-lib 存回时 595.28 原样保留）。
    const blank = pdfDoc.getPage(1);
    expect(blank.getWidth()).toBeCloseTo(595.28, 1);
    expect(blank.getHeight()).toBeCloseTo(841.89, 1);
    // 两张源页副本：pdf-lib 对重复指标共享同一份拷来的内容流对象（字节里原文只出现一次，
    // 但页树两个页节点都引用它，阅读器两页都看得到），这里只断言原文在、第 2 页原文不在。
    const content = pdfContentText(saved);
    expect(content).toContain('(page 1) Tj');
    expect(content).not.toContain('(page 2) Tj');
  });

  it('显式旋转写进产物页；省略旋转时源档原本没有 /Rotate 就是 0', async () => {
    const loaded = await PdfEditDocument.load(minimalMultiPagePdf(1));
    if (loaded.status !== 'loaded') throw new Error('夹具应当装得上');
    const pages: readonly PdfEditorPageInput[] = [
      { id: 'p1', kind: 'source', sourcePageNumber: 1, rotation: 90 },
      { id: 'p2', kind: 'source', sourcePageNumber: 1 },
    ];
    const saved = await (await loaded.document.assembleEditor(plannedPagesOf(pages), [])).save();
    const pdfDoc = await PDFDocument.load(saved);
    expect(pdfDoc.getPage(0).getRotation().angle).toBe(90);
    expect(pdfDoc.getPage(1).getRotation().angle).toBe(0);
  });
});

describe('WPS 编辑器 assembleEditor：五类对象的绘制（拉丁侧，不需要随包字体）', () => {
  const pages: readonly PdfEditorPageInput[] = [{ id: 'p1', kind: 'source', sourcePageNumber: 1 }];

  /** 装一页带对象的产物，回内容流原文。 */
  async function contentWith(...inputs: readonly PdfEditorObjectInput[]): Promise<string> {
    const loaded = await PdfEditDocument.load(minimalPdf(['Jane Doe']));
    if (loaded.status !== 'loaded') throw new Error('夹具应当装得上');
    const images = new Map<string, EditorImageAsset>();
    for (const input of inputs.filter((item) => item.kind === 'image')) {
      images.set(input.id, { format: 'png', bytes: ONE_PIXEL_PNG });
    }
    const saved = await loaded.document.assembleEditor(
      plannedPagesOf(pages),
      plannedObjectsOf(pages, inputs),
      images,
    ).then((document) => document.save());
    return pdfContentText(saved);
  }

  it('就地改字：垫底 + 新字都在，旧文字仍在内容流里（只追加，不许说"已删除"）', async () => {
    const content = await contentWith({
      id: 't1',
      pageId: 'p1',
      kind: 'text',
      rect: { xRatio: 0.1, yRatio: 0.1, widthRatio: 0.3, heightRatio: 0.05 },
      text: 'FIXED',
      backdropHex: '#ffffff',
    });
    expect(content).toContain('(Jane Doe) Tj');
    // 拉丁走标准字体时文字是十六进制串（与旧覆盖区同一口径）。
    expect(content).toContain(`<${Buffer.from('FIXED', 'latin1').toString('hex').toUpperCase()}> Tj`);
  });

  it('文本框（无 backdrop）不画垫底；粗体走 Helvetica-Bold；underline 多一笔矩形', async () => {
    const noStyle = await contentWith({
      id: 'a',
      pageId: 'p1',
      kind: 'text',
      rect: { xRatio: 0.1, yRatio: 0.2, widthRatio: 0.3, heightRatio: 0.05 },
      text: 'BOX',
    });
    const styled = await contentWith({
      id: 'a',
      pageId: 'p1',
      kind: 'text',
      rect: { xRatio: 0.1, yRatio: 0.2, widthRatio: 0.3, heightRatio: 0.05 },
      text: 'BOX',
      bold: true,
      underline: true,
    });
    // 文本框没有垫底：整份内容流里只有源文件与默认墨色，#ffffff 归一后的白一个都不许出现。
    expect(styled).not.toContain('1 1 1 rg');
    expect(styled).toContain('Helvetica-Bold');
    // 下划线比纯文本多一次闭合填充矩形（文本框自己不画垫底，所以基线就是 0 对 1）。
    expect((noStyle.match(/h\s+f/g) ?? []).length).toBe(0);
    expect((styled.match(/h\s+f/g) ?? []).length).toBe(1);
  });

  it('高亮是半透明矩形（ExtGState + /ca 0.35），形状是描边矩形，图片嵌得进去不抛', async () => {
    const content = await contentWith(
      { id: 'h1', pageId: 'p1', kind: 'highlight', rect: { xRatio: 0.1, yRatio: 0.3, widthRatio: 0.2, heightRatio: 0.03 } },
      {
        id: 's1',
        pageId: 'p1',
        kind: 'shape',
        rect: { xRatio: 0.1, yRatio: 0.4, widthRatio: 0.2, heightRatio: 0.05 },
        colorHex: '#dc2626',
      },
      { id: 'i1', pageId: 'p1', kind: 'image', rect: { xRatio: 0.1, yRatio: 0.5, widthRatio: 0.1, heightRatio: 0.1 }, imagePath: 'a.png' },
    );
    // 半透明：pdf-lib 给 opacity 生成 ExtGState，内容流里出现 /GSn 与 /ca。
    expect(content).toMatch(/\/ca 0\.35/);
    // 红色描边的三个通道（#dc2626 → 0.862/0.149/0.149）。
    expect(content).toContain('0.8627450980392157 0.14901960784313725 0.14901960784313725 RG');
    // 图片：整份字节里有 /Subtype /Image（图像 XObject）。
    expect(content).toContain('/Subtype');
    expect(content).toMatch(/\/Image/);
  });

  it('便签：贴纸色块 + 换行小字，内容超出按行数裁掉并加省略号', async () => {
    const content = await contentWith({
      id: 'n1',
      pageId: 'p1',
      kind: 'note',
      // 又窄又矮的贴纸（~119pt 宽、~34pt 高：只能放两行），长文必然被裁。
      rect: { xRatio: 0.1, yRatio: 0.6, widthRatio: 0.2, heightRatio: 0.04 },
      // 拉丁文字：这一族不测随包字体（中文换行在 export-service 的端到端里演）。
      text: 'This is a very long sticky note that should overflow the tiny box and be clipped with an ellipsis at the end',
    });
    expect(content).toContain('1 0.9490196078431372 0.6588235294117647 rg'); // 便签填充 #fff2a8
    // 省略号在 WinAnsi 里是单字节 0x85，随每条 Tj 以十六进制串出现；长文被裁必有一笔带着它收尾。
    expect(content).toMatch(/<[0-9A-F]*85> Tj/);
  });
});
