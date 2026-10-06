/**
 * `pdf.layout` 的用例（spec 3.5-01 的「文本块识别结果可视」中不靠眼睛的那半边，plan §7.4 / §7.15）。
 *
 * 这一份是**真抽取**：fixture 由 `@auto-cc/testing` 现造（Helvetica Type1 + A4 595×842，基线从 y=800 起、
 * 每行 −20），字节交给真的 pdf.js 读。之所以要跑真的库而不是把项编成字面量：
 * `AGENTS.md` §6.2 说框架 API 的形态以实测为准——`transform` 里哪一位是基线、`height` 是不是 pt，
 * 文档转述错了这里就会红，而纯函数那份用例（`text-layout.test.ts`）钉的是换算式本身。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, asApp, Context, type Fiber } from '@auto-cc/core';
import { afterAll, describe, expect, it } from 'vitest';
import { minimalMultiPagePdf, minimalPdf } from '@auto-cc/testing';

import { PdfLayoutService, type PdfLayoutConfig } from './layout-service.js';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 建一个系统临时目录（`afterAll` 清理；AGENTS.md §7.5：测试产物不进仓库）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-pdf-layout-'));
  sandboxes.push(dir);
  return dir;
}

/**
 * 把字节写成临时目录里的一份文件。
 * @param name 文件名
 * @param bytes 文件字节
 * @returns 绝对路径
 */
function putFile(name: string, bytes: Uint8Array): string {
  const dir = tempDir();
  const filePath = join(dir, name);
  writeFileSync(filePath, bytes);
  return filePath;
}

/** 线框腿的唯一尺度：字节上限，显式写全（带 `.default()` 的键在调用点必须给，见 AGENTS.md §9）。 */
const config: PdfLayoutConfig = { maxBytes: 5_242_880 };

/**
 * 挂起一份 `pdf.layout`。
 * @returns 服务实例
 */
async function boot(): Promise<PdfLayoutService> {
  const ctx = new Context();
  fibers.push(await ctx.plugin(PdfLayoutService, config));
  return asApp(ctx)['pdf.layout'];
}

/** A4 的宽高（与 fixture 的 MediaBox 一致），把比例还原成 pt 用。 */
const PAGE_WIDTH_PT = 595;
const PAGE_HEIGHT_PT = 842;

describe('3.5-01 的线框半边：真 pdf.js 抽出来的项落在该在的位置', () => {
  it('两行文字得到两块框，左边距就是内容流里写的 50pt', async () => {
    const filePath = putFile('resume.pdf', minimalPdf(['Jane Doe', 'Zurich']));
    const reading = await (await boot()).textItems(filePath, 1);
    expect(reading.pageNumber).toBe(1);
    expect(reading.pageCount).toBe(1);
    expect(reading.boxes).toHaveLength(2);
    for (const box of reading.boxes) {
      expect(box.rect.xRatio).toBeCloseTo(50 / PAGE_WIDTH_PT, 6);
    }
  });

  it('第一行的 yRatio 比第二行小，且两行相差正好是内容流里那个 20pt 步进（轴没翻反）', async () => {
    const filePath = putFile('resume.pdf', minimalPdf(['Jane Doe', 'Zurich']));
    const { boxes } = await (await boot()).textItems(filePath, 1);
    const first = boxes[0]?.rect;
    const second = boxes[1]?.rect;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // 基线 800 在 A4 上是页面上部：没翻轴会报成 0.95 附近，翻了应该在 0.05 附近。
    expect(first?.yRatio).toBeLessThan(0.5);
    expect(second!.yRatio).toBeGreaterThan(first!.yRatio);
    expect((second!.yRatio - first!.yRatio) * PAGE_HEIGHT_PT).toBeCloseTo(20, 1);
  });

  it('项高落在 12pt 字号的合理区间、短行比长行窄（读数确实是逐项的 pt 而不是常量）', async () => {
    const filePath = putFile('resume.pdf', minimalPdf(['Jane Doe', 'Zurich']));
    const { boxes } = await (await boot()).textItems(filePath, 1);
    const wideLine = boxes[0]!.rect;
    const narrowLine = boxes[1]!.rect;
    expect(isPlausibleGlyphBoxHeight(wideLine.heightRatio * PAGE_HEIGHT_PT)).toBe(true);
    expect(narrowLine.widthRatio).toBeLessThan(wideLine.widthRatio);
    expect(wideLine.widthRatio * PAGE_WIDTH_PT).toBeGreaterThan(10);
  });

  it('多页文档只回要问的那一页，页号原样带回', async () => {
    const filePath = putFile('three.pdf', minimalMultiPagePdf(3));
    const reading = await (await boot()).textItems(filePath, 2);
    expect(reading.pageCount).toBe(3);
    expect(reading.pageNumber).toBe(2);
    expect(reading.boxes).toHaveLength(1);
    expect(reading.boxes[0]?.rect.xRatio).toBeCloseTo(50 / PAGE_WIDTH_PT, 6);
  });

  it('没有文字的文档（扫描件那一类）回空数组，而不是报「读不出」', async () => {
    const filePath = putFile('blank.pdf', minimalPdf([]));
    const reading = await (await boot()).textItems(filePath, 1);
    expect(reading.pageCount).toBe(1);
    expect(reading.boxes).toEqual([]);
  });

  /**
   * 高度是否在合理区间。
   * @param heightPt 由比例还原出的项高（pt）
   * @returns 6…40pt 之间（12pt 字号的字形框含升部降部，实测落在这个带里）
   */
  function isPlausibleGlyphBoxHeight(heightPt: number): boolean {
    return heightPt > 6 && heightPt < 40;
  }
});

describe('脱敏半边：原文一个字都不过进程边界', () => {
  it('回传的结构里搜不到任何一行正文', async () => {
    const filePath = putFile('resume.pdf', minimalPdf(['Jane Doe', '+86 138-0000-0000']));
    const reading = await (await boot()).textItems(filePath, 1);
    // 与 3.6-b 那条同一口径：把拿到的读数整个序列化再搜原文关键词，搜不到才算过。
    const serialized = JSON.stringify(reading);
    expect(serialized).not.toContain('Jane');
    expect(serialized).not.toContain('Doe');
    expect(serialized).not.toContain('138');
    expect(serialized).toContain('xRatio');
  });
});

describe('失败腿：每种都是结构化失败，details.code 分得开', () => {
  const failures: readonly { readonly name: string; readonly bytes: Uint8Array; readonly code: string }[] = [
    { name: '空文件', bytes: new Uint8Array(0), code: 'empty' },
    { name: '不是 PDF', bytes: new TextEncoder().encode('hello, not a pdf at all'), code: 'invalid-pdf' },
  ];

  for (const caseItem of failures) {
    it(caseItem.name, async () => {
      const filePath = putFile('bad.pdf', caseItem.bytes);
      const error = await captureTextItems(filePath, 1);
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe('PDF_EDIT_READ_FAILED');
      expect(error.message).toMatch(/[\u4e00-\u9fa5]/);
      expect(AppError.from(error)).toMatchObject({ code: 'PDF_EDIT_READ_FAILED' });
      expect(error.details).toMatchObject({ code: caseItem.code });
    });
  }

  for (const pageNumber of [0, 2, 99, 1.5]) {
    it(`页号 ${String(pageNumber)} 越界（这份 fixture 只有一页，且页号从 1 起、必须是整数）`, async () => {
      const filePath = putFile('resume.pdf', minimalPdf(['Jane Doe']));
      const error = await captureTextItems(filePath, pageNumber);
      expect(error.code).toBe('PDF_EDIT_READ_FAILED');
      expect(error.details).toMatchObject({ code: 'page-out-of-range', pageNumber });
    });
  }
});

/**
 * 跑一次 `textItems` 并把异常取回来。
 * @param filePath 待量的文件
 * @param pageNumber 页号
 * @returns 抛出的 `AppError`（正常返回时用例先失败，所以这里断言不到成功分支）
 */
async function captureTextItems(filePath: string, pageNumber: number): Promise<AppError> {
  const service = await boot();
  try {
    await service.textItems(filePath, pageNumber);
  } catch (error) {
    return error as AppError;
  }
  throw new Error('本该拒绝的一次量页成功了');
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});
