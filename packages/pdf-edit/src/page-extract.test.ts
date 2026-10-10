/**
 * spec 3.8-01 的判据：抽取**完整性**这道量化门（族二的第一道门，达标才允许开族三）。
 *
 * 输入是 `@auto-cc/testing` 手写的带样式 PDF（`styledResumePdf`），期望值与夹具共用同一份清单
 * （`STYLED_PDF_RUNS` / `STYLED_PDF_BAND` / `STYLED_PDF_RULE`）——不在测试里另抄一份数字，
 * 否则夹具一改就同时改断言，那条腿等于没测（AGENTS.md §2.5）。
 *
 * 三条阈值是 plan `03-resume-pdf` §11 写死的：run ≥98%、色 ≥95%、矩形 ≥90%；
 * 旋转文字**单列成已知丢失项**，不进任何一条分母。
 */
import { describe, expect, it } from 'vitest';
import { STYLED_PDF_BAND, STYLED_PDF_RUNS, styledResumePdf, STYLED_PDF_RULE } from '@auto-cc/testing';

import { extractPdfDocument, type ExtractedRun } from './page-extract.js';

/** 声明了颜色的那些格（判据的分母只数这些——没写颜色算子的格如实回 null，不算丢）。 */
const COLOURED_RUNS = STYLED_PDF_RUNS.filter((run) => run.rgb !== null && run.rotationDeg === 0);

/** 横排（非旋转）的那些格——旋转那一格按 plan 的口径单列，不进总数。 */
const UPRIGHT_RUNS = STYLED_PDF_RUNS.filter((run) => run.rotationDeg === 0);

/**
 * 按文本找到抽出来的那一格。
 * @param runs 抽取结果
 * @param text 期望文本（夹具里逐字唯一）
 * @returns 那一格；找不到即断言失败
 */
function runOf(runs: readonly ExtractedRun[], text: string): ExtractedRun {
  const found = runs.find((run) => run.text === text);
  if (!found) throw new Error(`抽不到这一格：${text}（实际抽到 ${runs.map((run) => run.text).join(' | ')}）`);
  return found;
}

describe('3.8-01 抽取完整性：三道阈值（plan 03 §11）', () => {
  it('run 恢复率 ≥ 98%：横排的每一格都从算子流里抽回来了', async () => {
    const result = await extractPdfDocument(styledResumePdf());
    if (result.status !== 'extracted') throw new Error(`抽取应当成功，实际 ${result.code}: ${result.reason}`);
    const { stats, pages } = result.document;

    expect(pages).toHaveLength(1);
    expect(pages[0]?.widthPt).toBe(595);
    expect(pages[0]?.heightPt).toBe(842);
    // 分母按"横排"取，旋转那一格单列（plan 明写不许混进总数）。
    const uprightRecovered = (pages[0]?.runs ?? []).filter((run) => Math.abs(run.rotationDeg) <= 0.01);
    expect(stats.rotatedRuns).toBe(STYLED_PDF_RUNS.length - UPRIGHT_RUNS.length);
    expect(uprightRecovered.length / UPRIGHT_RUNS.length).toBeGreaterThanOrEqual(0.98);
    expect(stats.textContentItems).toBe(STYLED_PDF_RUNS.length);
    expect(stats.runsRecovered).toBe(STYLED_PDF_RUNS.length);
  });

  it('色恢复率 ≥ 95%：声明了颜色的格逐格对得上（每通道误差 ≤ 1/255）', async () => {
    const result = await extractPdfDocument(styledResumePdf());
    if (result.status !== 'extracted') throw new Error(`抽取应当成功，实际 ${result.code}: ${result.reason}`);
    const runs = result.document.pages[0]?.runs ?? [];

    const matched = COLOURED_RUNS.filter((expected) => {
      const got = runs.find((run) => run.text === expected.text)?.colorRgb;
      if (!got) return false;
      return expected.rgb?.every((channel, axis) => Math.abs(channel - (got[axis] as number)) <= 1 / 255) ?? false;
    });
    expect(matched.length / COLOURED_RUNS.length).toBeGreaterThanOrEqual(0.95);

    // 一条如实的负腿：没写颜色算子的那些格**回 null 而不是猜黑**。
    const uncoloured = UPRIGHT_RUNS.find((run) => run.rgb === null);
    expect(runOf(runs, uncoloured?.text ?? '').colorRgb).toBeNull();
  });

  it('矩形恢复率 ≥ 90%：色带与分隔线都抽到，且几何与颜色对得上', async () => {
    const result = await extractPdfDocument(styledResumePdf());
    if (result.status !== 'extracted') throw new Error(`抽取应当成功，实际 ${result.code}: ${result.reason}`);
    const page = result.document.pages[0];
    if (!page) throw new Error('一页都抽不到，判据无从谈起');

    expect(result.document.stats.paintOps).toBe(2);
    expect(page.shapes.length / result.document.stats.paintOps).toBeGreaterThanOrEqual(0.9);

    const band = page.shapes.find((shape) => shape.kind === 'fill');
    expect(band).toMatchObject({
      xPt: STYLED_PDF_BAND.xPt,
      yPt: STYLED_PDF_BAND.yPt,
      widthPt: STYLED_PDF_BAND.widthPt,
      heightPt: STYLED_PDF_BAND.heightPt,
    });
    expect(band?.colorRgb?.[0]).toBeCloseTo(STYLED_PDF_BAND.rgb[0], 2);

    const rule = page.shapes.find((shape) => shape.kind === 'stroke');
    expect(rule).toMatchObject({ xPt: STYLED_PDF_RULE.x1Pt, yPt: STYLED_PDF_RULE.yPt, heightPt: 0 });
    expect(rule?.widthPt).toBeCloseTo(STYLED_PDF_RULE.x2Pt - STYLED_PDF_RULE.x1Pt, 3);
  });
});

describe('3.8-01 抽到的样式：字号 / 字族 / 基线 / 单 run 宽度', () => {
  it('三种字族、三种字号都读得出来，基线逐位对得上', async () => {
    const result = await extractPdfDocument(styledResumePdf());
    if (result.status !== 'extracted') throw new Error(`抽取应当成功，实际 ${result.code}: ${result.reason}`);
    const runs = result.document.pages[0]?.runs ?? [];

    for (const expected of STYLED_PDF_RUNS) {
      const got = runOf(runs, expected.text);
      expect(got.fontSizePt).toBe(expected.sizePt);
      expect(got.baselineXPt).toBeCloseTo(expected.xPt, 3);
      expect(got.baselineYPt).toBeCloseTo(expected.yPt, 3);
      expect(got.rotationDeg).toBeCloseTo(expected.rotationDeg, 1);
    }
    // 字族提示只有 `styles` 里有（算子流里没有），这一条钉住"Times-Roman 被认成 serif"。
    expect(runOf(runs, 'Jane Doe').fontFamilyHint).toBe('serif');
    expect(runOf(runs, 'Work Experience').fontFamilyHint).toBe('sans-serif');
    expect(new Set(runs.map((run) => run.fontName)).size).toBe(3);
  });

  it('单 run 宽度误差 ≤ 2%（拿 pdf.js 自己的 `getTextContent` 宽度做参照）', async () => {
    const result = await extractPdfDocument(styledResumePdf());
    if (result.status !== 'extracted') throw new Error(`抽取应当成功，实际 ${result.code}: ${result.reason}`);
    const pdfModule = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
      getDocument(source: unknown): {
        promise: Promise<{ getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }> }>;
        destroy(): Promise<void>;
      };
    };
    // 字节**另取一份**：`getDocument` 会把传进去的 `ArrayBuffer` 移交（transfer）走，
    // 同一份 `Uint8Array` 喂第二次会以 `DataCloneError` 收场——这不是夹具缺陷，是它的移交语义。
    const task = pdfModule.getDocument({
      data: styledResumePdf(),
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0,
    });
    const document = await task.promise;
    const page = await document.getPage(1);
    const items = (await page.getTextContent()).items as readonly { str?: string; width?: number }[];
    await task.destroy();

    for (const item of items) {
      if (!item.str) continue;
      const got = runOf(result.document.pages[0]?.runs ?? [], item.str);
      // 旋转那一格两边都按同一套 advance 走，误差同样受 2% 约束（不是豁免项）。
      expect(Math.abs(got.widthPt - (item.width ?? 0)) / (item.width ?? 1)).toBeLessThanOrEqual(0.02);
    }
  });
});

describe('3.8-01 的确定态：打不开的东西不抛异常', () => {
  it('喂一段非 PDF 字节 → failed + invalid-pdf（界面据此走既有的扫描件回落）', async () => {
    const result = await extractPdfDocument(new Uint8Array([0x00, 0x01, 0x02, 0x03]));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.code).toBe('invalid-pdf');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});
