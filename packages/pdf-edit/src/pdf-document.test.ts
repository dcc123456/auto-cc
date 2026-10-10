/**
 * `pdf-document.ts` 单元测试（spec 3.4-03 的引擎判据：`pdf-lib` 装载并生成合法 PDF；
 * 外加 plan §7.10 要求三种「打不开」都有确定态，以及 3.5-09 的「装载与另存都不碰源字节」半边）。
 *
 * 夹具来自 `@auto-cc/testing` 的手写 PDF 生成器：**不用 pdf-lib 造再让 pdf-lib 读**，
 * 否则「装载」这条腿等于自证（spec 3.4-03 要的是引擎对外部输入负责）。
 */
import { describe, expect, it } from 'vitest';
import { minimalEncryptedPdf, minimalMultiPagePdf, minimalPdf, pdfContentText } from '@auto-cc/testing';

import { PdfEditDocument } from './pdf-document.js';

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

describe('3.5-14 的绘制半边：垫底矩形取量到的纸色，量不到才按墨色，纯白一个字都不许出现', () => {
  /** 三条实测形状（本机 `pdf-lib` 1.17.1 的 `rg` 写法是**全精度小数**，写断言前用 `tmp/35-14-color-probe.mjs` 现读过一遍）。 */
  const SAMPLED_FILL = '0.9411764705882353 0.8235294117647058 0.7058823529411765 rg'; // #f0d2b4
  const FALLBACK_FILL = '0.06666666666666667 0.06666666666666667 0.06666666666666667 rg'; // #111111
  const FALLBACK_INK = '0.9725490196078431 0.9803921568627451 0.9882352941176471 rg'; // #f8fafc
  const SAMPLED_INK = '0.058823529411764705 0.09019607843137255 0.16470588235294117 rg'; // #0f172a

  /**
   * 造一份只画一区覆盖区后的内容流文本。
   * @param plan 这一区的几何与颜色（页号固定 1，夹具就是单页）
   */
  async function contentOf(plan: { backdropHex?: string; text?: string }): Promise<string> {
    const loaded = await PdfEditDocument.load(minimalPdf(['Jane Doe']));
    if (loaded.status !== 'loaded') throw new Error('夹具应当装得上');
    await loaded.document.applyOverlays([
      {
        id: 'box-1',
        pageNumber: 1,
        xPt: 10,
        yBottomPt: 20,
        widthPt: 100,
        heightPt: 30,
        sizePt: 11,
        ...plan,
        ...(plan.text === undefined ? {} : { textBaselinePt: 25 }),
      },
    ]);
    return pdfContentText(await loaded.document.save());
  }

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
