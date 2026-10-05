/**
 * `pdf.export` 另存腿的端到端单测（spec 3.5-02 的「不改写原内容流」+ 3.5-09 的「源文件 hash 前后一致」
 * + 从 3.4-04/05/07 转移来的确定态：失败即报错、**磁盘上没有半成品**）。
 *
 * 产物断言走的是**内容流原文**而不是渲染像素：这片没有位图渲染（plan §7.1 的读侧选型），
 * 而「只追加、不改写」这件事在内容流里是可直接观测的——旧的那行 `(Jane Doe) Tj` 必须还在，
 * 新画的那笔必须是 `re`+`f`（填充）而不是 `re`+`S`（描边，那说明 `borderWidth: 0` 写漏了）。
 * 读内容流统一经 `@auto-cc/testing` 的 `pdfContentText`：实测 `pdf-lib` 把新落笔写进**新建的 Flate 流**，
 * 直接在字节里找子串会得到假阴性。三条实测口径决定了下面断言的写法（都记在 plan §7.11）：
 * 落笔不写 `re` 操作符，而是 `cm` 平移 + `m/l/h` 折线；文字写十六进制串而不是字面串；操作符逐条换行。
 * 按 plan §7.6 的反伪装口径，本文件的断言与文案里都不出现"删除/涂黑/不可恢复"这类说法。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, asApp, Context, type Fiber } from '@auto-cc/core';
import { sha256Hex } from '@auto-cc/core/file-read';
import { afterAll, describe, expect, it } from 'vitest';
import { minimalMultiPagePdf, minimalPdf, pdfContentText } from '@auto-cc/testing';

import { PdfEditDocument } from './pdf-document.js';
import { PdfExportService, type PdfExportConfig } from './export-service.js';
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

/** 另存腿的四条尺度：测试里显式写全（`.default()` 出现在输出类型里，调用点必须给，见 AGENTS.md §9）。 */
const config: PdfExportConfig = { maxBytes: 5_242_880, maxOverlays: 3, defaultTextSizePt: 11, minAreaRatio: 0.0001 };

/**
 * 挂起一份 `pdf.export`。
 * @param overrides 想改的尺度（演「条数超上限」那条腿时改 `maxOverlays`）
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

describe('3.5-02 的叠加半边：白底矩形 + 拉丁文字都进了内容流', () => {
  it('产物里同时有旧文字与新文字，且新矩形是填充（re f）而不是描边', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'resume.pdf', minimalPdf(['Jane Doe']));
    const receipt = await (await boot()).saveAs(sourcePath, [box], join(dir, 'out.pdf'));

    const content = pdfContentText(new Uint8Array(readFileSync(receipt.outPath)));
    expect(content.startsWith('%PDF-')).toBe(true);
    // 原内容流没被改写：旧文字仍以字面串在原位（实测口径见 plan §7.2 第一轮，这就是 §7.6 的「只追加」）。
    expect(content).toContain('(Jane Doe) Tj');
    expect(content).toContain(`<${hexOf('REDACTED')}> Tj`);
    expect(content).toMatch(/1 1 1 rg/); // 白底
    expect(content).toMatch(/h\s+f/); // 闭合路径 + 填充
    expect(content).not.toMatch(/h\s+[SB]/); // 出现 S 或 B 就是描边没被 `borderWidth: 0` 关掉
    // 3.5-03 的精确度：落点与尺寸就是比例换算出来的那四个数（0.25×595=148.75、0.5×595=297.5、
    // 翻轴 1−(0.25+0.125) 得底边 526.25、0.125×842=105.25），基线再按 (高−字号)/2 抬到 573.375。
    expect(content).toContain('1 0 0 1 148.75 526.25 cm');
    expect(content).toContain('0 105.25 l');
    expect(content).toContain('297.5 0 l');
    expect(content).toContain('1 0 0 1 148.75 573.375 Tm');
  });

  it('产物是一份能被重新装载的合法 PDF，页数与源一致', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'three.pdf', minimalMultiPagePdf(3));
    const outPath = join(dir, 'out.pdf');
    const receipt = await (await boot()).saveAs(sourcePath, [{ ...box, pageNumber: 2 }], outPath);

    expect(receipt.pageCount).toBe(3);
    const reloaded = await PdfEditDocument.load(new Uint8Array(readFileSync(outPath)));
    if (reloaded.status !== 'loaded') throw new Error(reloaded.detail);
    expect(reloaded.document.pageCount).toBe(3);
    expect(reloaded.document.pageMetrics()[1]).toEqual({ number: 2, widthPt: 595, heightPt: 842 });
  });

  it('回执里的 sha256 就是产物字节的摘要，且与源文件哈希不同（产物是新文件）', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'resume.pdf', minimalPdf(['Jane Doe']));
    const outPath = join(dir, 'out.pdf');
    const receipt = await (await boot()).saveAs(sourcePath, [box], outPath);

    expect(receipt.sha256).toBe(sha256Hex(new Uint8Array(readFileSync(outPath))));
    expect(receipt.sha256).not.toBe(sha256Hex(readFileSync(sourcePath)));
  });

  it('没有文字的覆盖区也能存：只涂白底，内容流里不该冒出 Tj', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'resume.pdf', minimalPdf(['Fudan University']));
    const outPath = join(dir, 'out.pdf');
    await (await boot()).saveAs(sourcePath, [{ ...box, text: undefined }], outPath);

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

    await (await boot()).saveAs(sourcePath, [box], join(dir, 'out.pdf'));
    expect(sha256Hex(readFileSync(sourcePath))).toBe(before);
  });

  it('产物路径等于源路径：直接拒，一个字都不写（就地改是 3.5-09 的反例）', async () => {
    const dir = tempDir();
    const sourcePath = putFile(dir, 'resume.pdf', minimalPdf(['Jane Doe']));
    const before = sha256Hex(readFileSync(sourcePath));
    const error = (await (
      await boot()
    )
      .saveAs(sourcePath, [box], sourcePath)
      .catch((caught: unknown) => caught)) as AppError;

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('PDF_EDIT_SAVE_FAILED');
    expect(error.details).toMatchObject({ code: 'out-is-source' });
    expect(sha256Hex(readFileSync(sourcePath))).toBe(before);
    expect(readdirSync(dir)).toEqual(['resume.pdf']);
  });
});

describe('plan §7.10 的确定态：失败一律 PDF_EDIT_SAVE_FAILED，且沙箱里不留半成品', () => {
  /** 七条失败腿：三条"文件没法用"、三条"覆盖区非法"、一条"写不进去"。 */
  const cases: readonly {
    name: string;
    source?: Uint8Array;
    config?: Partial<PdfExportConfig>;
    overlays?: readonly PdfOverlayInput[];
    outPath: (dir: string) => string;
    code: string;
  }[] = [
    {
      name: '非拉丁文字',
      overlays: [{ ...box, text: '覆盖中文哨兵' }],
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
  ];

  for (const item of cases) {
    it(`${item.name} → ${item.code}：有码、有中文、没有 <outPath> 也没有 <outPath>.part`, async () => {
      const dir = tempDir();
      const sourcePath = putFile(dir, 'resume.pdf', item.source ?? minimalPdf(['Jane Doe']));
      const error = (await (
        await boot(item.config)
      )
        .saveAs(sourcePath, item.overlays ?? [box], item.outPath(dir))
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
