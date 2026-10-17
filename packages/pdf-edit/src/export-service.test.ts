/**
 * `pdf.export` 另存通道的端到端单测（spec 3.5-02 的「不改写原内容流」+ 3.5-09 的「源文件 hash 前后一致」
 * + 从 3.4-04/05/07 转移来的确定态：失败即报错、**磁盘上没有半成品**）。
 *
 * 产物断言走的是**内容流原文**而不是渲染像素：这片没有位图渲染（plan §7.1 的读侧选型），
 * 而「只追加、不改写」这件事在内容流里是可直接观测的——旧的那行 `(Jane Doe) Tj` 必须还在，
 * 新画的那笔必须是**闭合路径 + 填充**（`h` 后跟 `f`）而不是描边（跟 `S`/`B` 就说明 `borderWidth: 0` 写漏了）。
 * 读内容流统一经 `@auto-cc/testing` 的 `pdfContentText`：实测 `pdf-lib` 把新落笔写进**新建的 Flate 流**，
 * 直接在字节里找子串会得到假阴性。三条实测口径决定了下面断言的写法（都记在 plan §7.12）：
 * 落笔不写 `re` 操作符，而是 `cm` 平移 + `m/l/h` 折线；文字写十六进制串而不是字面串；操作符逐条换行。
 * 按 plan §7.6 的反伪装口径，本文件的断言与文案里都不出现"删除/涂黑/不可恢复"这类说法。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, asApp, Context, Service, type Context as CoreContext, type Fiber } from '@auto-cc/core';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { sha256Hex } from '@auto-cc/core/file-read';
import { afterAll, describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { encodePng, minimalMultiPagePdf, minimalPdf, pdfContentText } from '@auto-cc/testing';

import { PdfEditDocument } from './pdf-document.js';
import { PdfExportService, type PdfExportConfig } from './export-service.js';
import type { PdfEditorObjectInput, PdfEditorPageInput } from './object-model.js';
import type { PdfOverlayInput } from './overlay-writer.js';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 建一个系统临时目录（`afterAll` 清理；AGENTS.md §7.5：测试产物不进仓库）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-pdf-export-'));
  sandboxes.push(dir);
  return dir;
}

/**
 * 把字节写成临时目录里的一份文件。
 * @param dir 哪个沙箱
 * @param name 文件名
 * @param bytes 文件字节
 * @returns 绝对路径
 */
function putFile(dir: string, name: string, bytes: Uint8Array): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, bytes);
  return filePath;
}

/** 另存通道的五条尺度：测试里显式写全（`.default()` 出现在输出类型里，调用点必须给，见 AGENTS.md §9）。 */
const config: PdfExportConfig = {
  maxBytes: 5_242_880,
  maxOverlays: 3,
  maxPages: 64,
  defaultTextSizePt: 11,
  minAreaRatio: 0.0001,
  maxObjects: 100,
  maxImageBytes: 10_485_760,
};

/**
 * "不重排"的写法：页序是必填入参，所以原样另存也要显式给出 `1…n`（空数组在边界上算非法，见 `page-ops.ts`）。
 * @param pageCount 源文件的页数
 * @returns 逐页指向自身那一页的页序
 */
function keepPages(pageCount: number): number[] {
  return Array.from({ length: pageCount }, (_, index) => index + 1);
}

/**
 * 挂起一份 `pdf.export`。
 * @param overrides 想改的尺度（演「条数超上限」那条通道时改 `maxOverlays`）
 * @returns 服务实例
 */
async function boot(overrides: Partial<PdfExportConfig> = {}): Promise<PdfExportService> {
  const ctx = new Context();
  fibers.push(await ctx.plugin(PdfExportService, { ...config, ...overrides }));
  return asApp(ctx)['pdf.export'];
}

/**
 * 一个盖在页面上半部的覆盖区（比例坐标），带拉丁文字。
 * 四个比例都挑成**二进制精确**的分数（0.25 / 0.5 / 0.125）：0.1 + 0.05 这类十进制分数在浮点里
 * 是 0.15000000000000002，换算出的 pt 带一串尾数，产物里的数字断言就成了在测浮点而不是测换算。
 */
const box: PdfOverlayInput = {
  id: 'box-1',
  pageNumber: 1,
  rect: { xRatio: 0.25, yRatio: 0.25, widthRatio: 0.5, heightRatio: 0.125 },
  text: 'REDACTED',
};

/**
 * 文字在产物内容流里的写法（实测：`pdf-lib` 给嵌入字体写**十六进制串**，不是 `(文字) Tj` 字面串）。
 * @param text 叠加文字
 * @returns 大写十六进制串，与 `<…> Tj` 里那段逐字相同
 */
function hexOf(text: string): string {
  return Buffer.from(text, 'latin1').toString('hex').toUpperCase();
}

describe('3.5-02 的叠加半边：垫底矩形 + 拉丁文字都进了内容流（颜色口径见 3.5-14）', () => {
  it('产物里同时有旧文字与新文字，且新矩形是填充（re f）而不是描边', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'resume.pdf', minimalPdf(['Jane Doe']));
    const receipt = await (await boot()).saveAs(sourcePath, [box], keepPages(1), join(dir, 'out.pdf'));

    const content = pdfContentText(new Uint8Array(readFileSync(receipt.outPath)));
    expect(content.startsWith('%PDF-')).toBe(true);
    // 原内容流没被改写：旧文字仍以字面串在原位（实测口径见 plan §7.2 第一轮，这就是 §7.6 的「只追加」）。
    expect(content).toContain('(Jane Doe) Tj');
    expect(content).toContain(`<${hexOf('REDACTED')}> Tj`);
    // 3.5-14：这一区没带量到的底色（界面还没走到那一步），于是**如实按墨黑垫底**，
    // 而过去那一版是猜白——产物里今天再出现 `1 1 1 rg` 就说明有人在绘制侧写回了纯白。
    expect(content).toMatch(/0\.06666666666666667 0\.06666666666666667 0\.06666666666666667 rg/);
    expect(content).not.toMatch(/1 1 1 rg/);
    expect(content).toMatch(/h\s+f/); // 闭合路径 + 填充
    expect(content).not.toMatch(/h\s+[SB]/); // 出现 S 或 B 就是描边没被 `borderWidth: 0` 关掉
    // 3.5-03 的精确度：落点与尺寸就是比例换算出来的那四个数（0.25×595=148.75、0.5×595=297.5、
    // 翻轴 1−(0.25+0.125) 得底边 526.25、0.125×842=105.25），基线再按 (高−字号)/2 抬到 573.375。
    expect(content).toContain('1 0 0 1 148.75 526.25 cm');
    expect(content).toContain('0 105.25 l');
    expect(content).toContain('297.5 0 l');
    expect(content).toContain('1 0 0 1 148.75 573.375 Tm');
  });

  it('界面量到了纸色：那一个色号一路走到产物内容流，屏幕上看到什么产物里就是什么', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'resume.pdf', minimalPdf(['Jane Doe']));
    const outPath = join(dir, 'out.pdf');
    await (await boot()).saveAs(sourcePath, [{ ...box, backdropHex: '#F0D2B4' }], keepPages(1), outPath);

    const content = pdfContentText(new Uint8Array(readFileSync(outPath)));
    // 小写归一在 `planOverlays` 那一步做完，这里判的是"量到的那个数真的落到了纸上"；
    // 而新字的墨色是另一笔 `rg`（#0f172a），两者都在，说明两条通道读的是同一份判据。
    expect(content).toContain('0.9411764705882353 0.8235294117647058 0.7058823529411765 rg');
    expect(content).toContain('0.058823529411764705 0.09019607843137255 0.16470588235294117 rg');
    expect(content).not.toContain('1 1 1 rg');
  });

  it('产物是一份能被重新装载的合法 PDF，页数与源一致', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'three.pdf', minimalMultiPagePdf(3));
    const outPath = join(dir, 'out.pdf');
    const receipt = await (await boot()).saveAs(sourcePath, [{ ...box, pageNumber: 2 }], keepPages(3), outPath);

    expect(receipt.pageCount).toBe(3);
    const reloaded = await PdfEditDocument.load(new Uint8Array(readFileSync(outPath)));
    if (reloaded.status !== 'loaded') throw new Error(reloaded.detail);
    expect(reloaded.document.pageCount).toBe(3);
    expect(reloaded.document.sourcePageMetrics()[1]).toEqual({ number: 2, widthPt: 595, heightPt: 842 });
  });

  it('回执里的 sha256 就是产物字节的摘要，且与源文件哈希不同（产物是新文件）', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'resume.pdf', minimalPdf(['Jane Doe']));
    const outPath = join(dir, 'out.pdf');
    const receipt = await (await boot()).saveAs(sourcePath, [box], keepPages(1), outPath);

    expect(receipt.sha256).toBe(sha256Hex(new Uint8Array(readFileSync(outPath))));
    expect(receipt.sha256).not.toBe(sha256Hex(readFileSync(sourcePath)));
  });

  it('没有文字的覆盖区也能存：只涂白底，内容流里不该冒出 Tj', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'resume.pdf', minimalPdf(['Fudan University']));
    const outPath = join(dir, 'out.pdf');
    await (await boot()).saveAs(sourcePath, [{ ...box, text: undefined }], keepPages(1), outPath);

    const content = pdfContentText(new Uint8Array(readFileSync(outPath)));
    expect(content).toMatch(/h\s+f/);
    // 只涂白底时整份文件里只有源文件那一笔 `Tj`：新区不该长出隐形文字。
    expect((content.match(/Tj/g) ?? []).length).toBe(1);
  });
});

describe('3.5-09：另存不污染源文件', () => {
  it('源文件的字节哈希在另存前后完全一致', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'resume.pdf', minimalPdf(['Jane Doe']));
    const before = sha256Hex(readFileSync(sourcePath));

    await (await boot()).saveAs(sourcePath, [box], keepPages(1), join(dir, 'out.pdf'));
    expect(sha256Hex(readFileSync(sourcePath))).toBe(before);
  });

  it('产物路径等于源路径：直接拒，一个字都不写（就地改是 3.5-09 的反例）', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'resume.pdf', minimalPdf(['Jane Doe']));
    const before = sha256Hex(readFileSync(sourcePath));
    const error = (await (
      await boot()
    )
      .saveAs(sourcePath, [box], keepPages(1), sourcePath)
      .catch((caught: unknown) => caught)) as AppError;

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('PDF_EDIT_SAVE_FAILED');
    expect(error.details).toMatchObject({ code: 'out-is-source' });
    expect(sha256Hex(readFileSync(sourcePath))).toBe(before);
    expect(readdirSync(dir)).toEqual(['resume.pdf']);
  });
});

describe('3.5-07 的另存半边：页数与顺序符合操作，覆盖区跟着来源页走', () => {
  /**
   * 逐页写着自己页号的三页源档（"顺序对不对"就只有可直接观测的答案：内容流里那行 `page N`）。
   * @param dir 哪个沙箱
   * @returns 源文件的绝对路径
   */
  function threePageSource(dir: string): string {
    return putFile(dir, 'three.pdf', minimalMultiPagePdf(3));
  }

  it('删页：页序里缺的那一项不出现，产物页数随之变少', async () => {
    const dir = tempDir();
    const sourcePath = threePageSource(dir);
    const outPath = join(dir, 'out.pdf');
    const receipt = await (await boot()).saveAs(sourcePath, [box], [3, 1], outPath);

    expect(receipt.pageCount).toBe(2);
    const content = pdfContentText(new Uint8Array(readFileSync(outPath)));
    expect(content).toContain('(page 3) Tj');
    expect(content).toContain('(page 1) Tj');
    expect(content).not.toContain('(page 2) Tj');
    // 顺序也是判据的一部分：只数页数会放过一份"删对了但顺序乱了"的产物。
    expect(content.indexOf('(page 3) Tj')).toBeLessThan(content.indexOf('(page 1) Tj'));
  });

  it('增页（同一源的副本）：页数变多，且覆盖区画在**每一份**副本上', async () => {
    const dir = tempDir();
    const sourcePath = threePageSource(dir);
    const outPath = join(dir, 'out.pdf');
    // 覆盖区按来源页绑：[1,1,2] 里第 1 页有两张副本，那一句"改过了"必须两张都有，
    // 否则产物里就还留着一张带旧话的页面（plan §7.6 的反伪装精神）。
    const receipt = await (await boot()).saveAs(sourcePath, [box], [1, 1, 2], outPath);
    expect(receipt.pageCount).toBe(3);

    const content = pdfContentText(new Uint8Array(readFileSync(outPath)));
    expect((content.match(new RegExp(`<${hexOf('REDACTED')}> Tj`, 'g')) ?? []).length).toBe(2);
    // 没被指派覆盖区的那一页（来源第 2 页）不该跟着吃一笔。
    expect((content.match(/\(page 2\) Tj/g) ?? []).length).toBe(1);
  });

  it('重排后重新装载：产物逐页宽高仍是源档那三页的量得（拷贝保留 MediaBox）', async () => {
    const dir = tempDir();
    const sourcePath = threePageSource(dir);
    const outPath = join(dir, 'out.pdf');
    await (await boot()).saveAs(sourcePath, [], [3, 2, 1], outPath);

    const reloaded = await PdfEditDocument.load(new Uint8Array(readFileSync(outPath)));
    if (reloaded.status !== 'loaded') throw new Error(reloaded.detail);
    expect(reloaded.document.pageCount).toBe(3);
    expect(reloaded.document.sourcePageMetrics()).toEqual([
      { number: 1, widthPt: 595, heightPt: 842 },
      { number: 2, widthPt: 595, heightPt: 842 },
      { number: 3, widthPt: 595, heightPt: 842 },
    ]);
  });
});

describe('plan §7.10 的确定态：失败一律 PDF_EDIT_SAVE_FAILED，且沙箱里不留半成品', () => {
  /** 十一条失败那一条：四条"覆盖区非法"、四条"页序非法"、一条"源文件读不出"、两条"产物写不了"。 */
  const cases: readonly {
    name: string;
    source?: Uint8Array;
    config?: Partial<PdfExportConfig>;
    overlays?: readonly PdfOverlayInput[];
    pageOrder?: readonly number[];
    outPath: (dir: string) => string;
    code: string;
  }[] = [
    {
      name: '非拉丁文字',
      overlays: [{ ...box, text: '覆盖 \ud83c\udf89' }],
      outPath: (dir) => join(dir, 'out.pdf'),
      code: 'text-not-supported',
    },
    {
      name: '覆盖区指向不存在的页',
      overlays: [{ ...box, pageNumber: 9 }],
      outPath: (dir) => join(dir, 'out.pdf'),
      code: 'out-of-page',
    },
    {
      name: '条数超上限',
      overlays: [box, { ...box, id: 'b' }, { ...box, id: 'c' }, { ...box, id: 'd' }],
      outPath: (dir) => join(dir, 'out.pdf'),
      code: 'too-many',
    },
    {
      name: '矩形越界',
      overlays: [{ ...box, rect: { xRatio: 0.8, yRatio: 0.1, widthRatio: 0.6, heightRatio: 0.05 } }],
      outPath: (dir) => join(dir, 'out.pdf'),
      code: 'out-of-bounds',
    },
    {
      name: '结构损坏的源文件',
      source: Buffer.from('%PDF-1.4\n这不是合法的 PDF 结构\n', 'latin1'),
      outPath: (dir) => join(dir, 'out.pdf'),
      code: 'invalid-pdf',
    },
    { name: '产物路径不是绝对路径', outPath: () => 'out.pdf', code: 'out-path-not-absolute' },
    { name: '产物目录不存在', outPath: (dir) => join(dir, 'missing-dir', 'out.pdf'), code: 'write-failed' },
    { name: '页序为空', pageOrder: [], outPath: (dir) => join(dir, 'out.pdf'), code: 'empty-order' },
    {
      name: '页序指向不存在的页',
      pageOrder: [1, 7],
      outPath: (dir) => join(dir, 'out.pdf'),
      code: 'page-out-of-range',
    },
    {
      name: '页序里有非整数',
      pageOrder: [1.5],
      outPath: (dir) => join(dir, 'out.pdf'),
      code: 'page-out-of-range',
    },
    {
      name: '产物页数超上限',
      config: { maxPages: 2 },
      pageOrder: [1, 1, 1],
      outPath: (dir) => join(dir, 'out.pdf'),
      code: 'too-many-pages',
    },
  ];

  for (const item of cases) {
    it(`${item.name} → ${item.code}：有码、有中文、没有 <outPath> 也没有 <outPath>.part`, async () => {
      const dir = tempDir();
      const sourcePath = putFile(dir, 'resume.pdf', item.source ?? minimalPdf(['Jane Doe']));
      const error = (await (
        await boot(item.config)
      )
        .saveAs(sourcePath, item.overlays ?? [box], item.pageOrder ?? keepPages(1), item.outPath(dir))
        .catch((caught: unknown) => caught)) as AppError;

      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe('PDF_EDIT_SAVE_FAILED');
      expect(error.message).toMatch(/[\u4e00-\u9fa5]/);
      // 4.1-06 立过的口径：错误能被网关转成结构化载荷，界面拿到的是码而不是裸异常。
      expect(AppError.from(error)).toMatchObject({ code: 'PDF_EDIT_SAVE_FAILED' });
      expect(error.details).toMatchObject({ code: item.code });
      // 半成品判据：除了源文件，沙箱里没有别的条目（`.part` 已被清掉，`out.pdf` 从没出现过）。
      expect(readdirSync(dir)).toEqual(['resume.pdf']);
    });
  }
});

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/**
 * 随包字体目录的替身（3.5-06 的中文半边要它）。
 *
 * 另存通道按名字**现问** `resume.print` 的 `fontBaseUrl()`（`export-service.ts` 的 `cjkFontBytes`），
 * 所以这里只装一只提供那一个读数的假服务，指向仓库里真正随包的那份 woff2——
 * 判据要的是「中文真的嵌得进去、抽得出来」，用假字节就把它测成了空气。
 */
class FakePrintFontPort extends Service {
  static provide = 'resume.print';
  static Config = z.strictObject({});

  constructor(ctx: CoreContext, _options: z.infer<typeof FakePrintFontPort.Config>) {
    super(ctx, 'resume.print');
  }

  /** @returns 仓库 `resources/fonts` 的 `file://` base（与打包态由 shell 给的那一句同一形状） */
  fontBaseUrl(): string {
    return pathToFileURL(new URL('../../../resources/fonts/', import.meta.url).pathname).href;
  }
}

/**
 * 挂起一份带字体目录的 `pdf.export`。
 * @returns 服务实例
 */
async function bootWithFont(): Promise<PdfExportService> {
  const ctx = new Context();
  // 顺序按 §9 的 5.1-c：字体端口先装，另存这一侧是按名字现问，装配清单里 `pdf-export` 也排在 `resume-print` 之后。
  fibers.push(await ctx.plugin(FakePrintFontPort, {}));
  fibers.push(await ctx.plugin(PdfExportService, config));
  return asApp(ctx)['pdf.export'];
}

/**
 * 在产物上跑 pdf.js 抽文本项（判据原文的"文本层"就是这里，不能用 `pdf.layout.textItems`——它脱敏，只回矩形）。
 * @param filePath 产物路径
 * @returns 第一页的文本项（`str` / `width` / `height` / `transform`）
 */
async function textItemsOf(filePath: string): Promise<{ str: string; width: number; height: number }[]> {
  const pdfModule = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    getDocument(source: unknown): {
      promise: Promise<{
        numPages: number;
        getPage(n: number): Promise<{
          getTextContent(): Promise<{ items: { str?: unknown; width?: unknown; height?: unknown }[] }>;
          cleanup(): void;
        }>;
      }>;
    };
  };
  const task = pdfModule.getDocument({
    data: new Uint8Array(readFileSync(filePath)),
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  try {
    return (await page.getTextContent()).items.map((item) => ({
      str: typeof item.str === 'string' ? item.str : '',
      width: typeof item.width === 'number' ? item.width : 0,
      height: typeof item.height === 'number' ? item.height : 0,
    }));
  } finally {
    page.cleanup();
  }
}

describe('3.5-06 的中文半边：CJK 子集内嵌后，文本层逐字符全等且按全角推进算得出字形数', () => {
  it('中文叠加抽回来与写进去逐字符全等，宽度是七个全角推进（不是豆腐块、也不是空白）', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'resume.pdf', minimalPdf(['Jane Doe']));
    const sentinel = '覆盖中文哨兵甲乙丙';
    const receipt = await (
      await bootWithFont()
    ).saveAs(sourcePath, [{ ...box, text: sentinel }], keepPages(1), join(dir, 'cn.pdf'));

    const items = await textItemsOf(receipt.outPath);
    const drawn = items.filter((item) => item.str.includes(sentinel));
    // 逐字符全等：判据原文要的是"可复制可搜索"，抽回来的字符串必须一字不差（spike 第三轮的读数就是这个形状）。
    expect(drawn.map((item) => item.str)).toEqual([sentinel]);
    // 字形数：拿装配清单里的默认字号去除整条推进量，得到七个字（宽度为 0 就是空白或豆腐块，这里要的是非零推进）。
    expect(Math.round(drawn[0]!.width / config.defaultTextSizePt)).toBe(sentinel.length);
    expect(drawn[0]!.height).toBeGreaterThan(0);
    // 反伪装（plan §7.6）：覆盖上去的中文之下，源文件那句话仍读得出来——我们只追加，不删除。
    expect(items.some((item) => item.str.includes('Jane Doe'))).toBe(true);
  });

  it('没装字体端口时中文另存以 font-unavailable 失败，磁盘上不留半成品', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'resume.pdf', minimalPdf(['Jane Doe']));
    const outPath = join(dir, 'cn.pdf');
    const service = await boot();
    await expect(
      service.saveAs(sourcePath, [{ ...box, text: '中文哨兵' }], keepPages(1), outPath),
    ).rejects.toMatchObject({ code: 'PDF_EDIT_SAVE_FAILED', details: { code: 'font-unavailable' } });
    expect(readdirSync(dir).filter((name) => name.endsWith('.pdf') || name.endsWith('.part'))).toEqual(['resume.pdf']);
  });
});

/**
 * WPS 形态编辑器 saveEditor 的端到端（2026-10-14 反转裁定）。
 * 页计划 + 五类对象一路走到落盘；中文走 bootWithFont 的真随包字体，图片写在沙箱里按路径重读。
 */
describe('pdf.export.saveEditor：页计划 + 五类对象的另存端到端', () => {
  it('源页(旋转90) + 空白页：改字/高亮/图片/便签全画上，中文抽得回，产物页旋转为 90', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'resume.pdf', minimalPdf(['Jane Doe']));
    const imagePath = putFile(dir, 'seal.png', new Uint8Array(encodePng(Buffer.from([0xff, 0x00, 0x00, 0xff]), 2, 2)));
    const outPath = join(dir, 'editor.pdf');

    const pages: readonly PdfEditorPageInput[] = [
      { id: 'p1', kind: 'source', sourcePageNumber: 1, rotation: 90 },
      { id: 'b1', kind: 'blank' },
    ];
    const objects: readonly PdfEditorObjectInput[] = [
      // 就地改字（中文 + 垫底，量到白纸）。
      {
        id: 't1',
        pageId: 'p1',
        kind: 'text',
        rect: { xRatio: 0.1, yRatio: 0.1, widthRatio: 0.5, heightRatio: 0.06 },
        text: '姓名：张三',
        backdropHex: '#ffffff',
        baselineYRatio: 0.14,
      },
      // 高亮（半透明）。
      { id: 'h1', pageId: 'p1', kind: 'highlight', rect: { xRatio: 0.1, yRatio: 0.2, widthRatio: 0.3, heightRatio: 0.03 } },
      // 图片（字节按路径在主进程重读，不随对象过界）。
      { id: 'i1', pageId: 'p1', kind: 'image', rect: { xRatio: 0.1, yRatio: 0.3, widthRatio: 0.1, heightRatio: 0.1 }, imagePath },
      // 空白页上的中文便签。
      { id: 'n1', pageId: 'b1', kind: 'note', rect: { xRatio: 0.1, yRatio: 0.1, widthRatio: 0.5, heightRatio: 0.1 }, text: '这是一页空白纸的便签' },
    ];

    const receipt = await (await bootWithFont()).saveEditor(sourcePath, pages, objects, outPath);
    expect(receipt.pageCount).toBe(2);
    expect(receipt.sha256).toBe(sha256Hex(new Uint8Array(readFileSync(outPath))));

    // 源文件没被碰过。
    expect(sha256Hex(readFileSync(sourcePath))).toBe(sha256Hex(minimalPdf(['Jane Doe'])));

    // 产物第一页 /Rotate=90，第二页是默认 A4 竖版。
    const pdfDoc = await PDFDocument.load(new Uint8Array(readFileSync(outPath)));
    expect(pdfDoc.getPage(0).getRotation().angle).toBe(90);
    expect(pdfDoc.getPage(1).getWidth()).toBeCloseTo(595.28, 1);

    // 中文经随包字体子集内嵌：文本层抽得回（可复制可搜索）；旧文字仍在（只追加）。
    const items = await textItemsOf(outPath);
    expect(items.some((item) => item.str.includes('姓名：张三'))).toBe(true);
    expect(items.some((item) => item.str.includes('Jane Doe'))).toBe(true);
  });

  it('产物路径等于源路径：out-is-source 拒，磁盘上没有产物', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'resume.pdf', minimalPdf(['Jane Doe']));
    const pages: readonly PdfEditorPageInput[] = [{ id: 'p1', kind: 'source', sourcePageNumber: 1 }];
    const error = (await (
      await boot()
    )
      .saveEditor(sourcePath, pages, [], sourcePath)
      .catch((caught: unknown) => caught)) as AppError;
    expect(error.details).toMatchObject({ code: 'out-is-source' });
    expect(readdirSync(dir)).toEqual(['resume.pdf']);
  });

  it('对象绑了页计划里没有的 id：object-page-unknown，失败不落半成品', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'resume.pdf', minimalPdf(['Jane Doe']));
    const outPath = join(dir, 'out.pdf');
    const pages: readonly PdfEditorPageInput[] = [{ id: 'p1', kind: 'source', sourcePageNumber: 1 }];
    const objects: readonly PdfEditorObjectInput[] = [
      { id: 'h1', pageId: 'ghost', kind: 'highlight', rect: { xRatio: 0.1, yRatio: 0.1, widthRatio: 0.2, heightRatio: 0.03 } },
    ];
    const error = (await (
      await boot()
    )
      .saveEditor(sourcePath, pages, objects, outPath)
      .catch((caught: unknown) => caught)) as AppError;
    expect(error.details).toMatchObject({ code: 'object-page-unknown' });
    expect(readdirSync(dir)).toEqual(['resume.pdf']);
  });

  it('图片文件头不是 PNG/JPEG（扩展名是 .png 也没用）：image-format 拒', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'resume.pdf', minimalPdf(['Jane Doe']));
    const fakeImage = putFile(dir, 'seal.png', new Uint8Array(Buffer.from('%PDF-1.4\n假装是图片\n')));
    const outPath = join(dir, 'out.pdf');
    const pages: readonly PdfEditorPageInput[] = [{ id: 'p1', kind: 'source', sourcePageNumber: 1 }];
    const objects: readonly PdfEditorObjectInput[] = [
      { id: 'i1', pageId: 'p1', kind: 'image', rect: { xRatio: 0.1, yRatio: 0.3, widthRatio: 0.1, heightRatio: 0.1 }, imagePath: fakeImage },
    ];
    const error = (await (
      await boot()
    )
      .saveEditor(sourcePath, pages, objects, outPath)
      .catch((caught: unknown) => caught)) as AppError;
    expect(error.details).toMatchObject({ code: 'image-format' });
    expect(readdirSync(dir)).toEqual(['resume.pdf', 'seal.png']);
  });

  it('同一图片被两个对象引用：主进程按路径只读一次（产物里两个 Do 引用同一个图像 XObject）', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'resume.pdf', minimalPdf(['Jane Doe']));
    const imagePath = putFile(dir, 'seal.png', new Uint8Array(encodePng(Buffer.from([0x00, 0xff, 0x00, 0xff]), 2, 2)));
    const outPath = join(dir, 'out.pdf');
    const pages: readonly PdfEditorPageInput[] = [{ id: 'p1', kind: 'source', sourcePageNumber: 1 }];
    const objects: readonly PdfEditorObjectInput[] = [
      { id: 'i1', pageId: 'p1', kind: 'image', rect: { xRatio: 0.1, yRatio: 0.3, widthRatio: 0.1, heightRatio: 0.1 }, imagePath },
      { id: 'i2', pageId: 'p1', kind: 'image', rect: { xRatio: 0.3, yRatio: 0.3, widthRatio: 0.1, heightRatio: 0.1 }, imagePath },
    ];
    const receipt = await (await boot()).saveEditor(sourcePath, pages, objects, outPath);
    expect(receipt.pageCount).toBe(1);
    const content = pdfContentText(new Uint8Array(readFileSync(outPath)));
    // 两笔绘制（Do）各引一个资源名。
    expect((content.match(/\/\S+\s+Do/g) ?? []).length).toBe(2);

    // 去重的真正落点：页资源里两个图像名字指向**同一个间接对象号**（主进程按路径只嵌了一份）。
    // 不能数 `/Subtype /Image`：pdfContentText 解包对象流时同一字典会被资源表与对象表各带出一次。
    const reloaded = await PDFDocument.load(new Uint8Array(readFileSync(outPath)));
    const resources = reloaded.getPage(0).node.Resources();
    if (resources === undefined) throw new Error('产物页应当有资源字典');
    const xObjects = reloaded.context.lookup(resources.get(PDFName.of('XObject')), PDFDict);
    const targets = xObjects.entries().map(([, value]) => (value instanceof PDFRef ? value.objectNumber : -1));
    expect(targets).toHaveLength(2);
    expect(targets[0]).toBe(targets[1]);
    expect(targets[0]).toBeGreaterThan(0);
  });
});
