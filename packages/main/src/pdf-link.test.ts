/**
 * 编辑轨的**装配与 IPC 面**对账（spec 3.4-03 的接线半边 + 3.5-02 / 3.5-09 / 3.5-01 的接线半边，plan §7.4）。
 *
 * 为什么放在 `packages/main`：这里要同时读到注册表、`cordis.yml`、渲染层白名单与网关的 `resolveCall`
 * ——四样东西分属四个包，只有装配层认识它们全部（`graph-link.test.ts` 同一口径）。
 * 装载与叠加的语义本体（页数、宽高、坐标换算、内容流）在 `packages/pdf-edit/src/*.test.ts` 判，
 * 这里只钉「界面调得到的那三条路径确实切成服务 `pdf.io` / `pdf.export` / `pdf.layout`，且未登记的名字进不来」。
 */
import { AppError, asApp, Context, type Fiber } from '@auto-cc/core';
import { PdfExportService, PdfIoService, PdfLayoutService } from '@auto-cc/plugin-pdf-edit';
import { resolveCall } from '@auto-cc/plugin-ipc';
import { RENDERER_ALLOWLIST, isAllowedCall } from '@auto-cc/shared';
import { afterAll, describe, expect, it } from 'vitest';

const fibers: Fiber[] = [];

/**
 * 只挂编辑轨这三只服务（它们都不 inject 任何别的名字，所以这里不需要 store）。
 * @returns 上下文与按名取实例的查找口（网关用的就是同一种查找）
 */
async function bootEditTrack(): Promise<{ ctx: Context; lookup: (name: string) => object | undefined }> {
  const ctx = new Context();
  fibers.push(await ctx.plugin(PdfIoService, { maxBytes: 5242880 }));
  fibers.push(
    await ctx.plugin(PdfExportService, {
      maxBytes: 5242880,
      maxOverlays: 50,
      maxPages: 64,
      defaultTextSizePt: 11,
      minAreaRatio: 0.0001,
    }),
  );
  fibers.push(await ctx.plugin(PdfLayoutService, { maxBytes: 5242880 }));
  return {
    ctx,
    lookup: (name) => {
      try {
        return ctx.get(name) as object;
      } catch {
        return undefined;
      }
    },
  };
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
});

describe('编辑轨三条口都走真装配（plan §7.3 的挂载 + §7.4 的白名单）', () => {
  it('服务在真实上下文里挂起来了，名字就是 `pdf.io`、`pdf.export` 与 `pdf.layout`', async () => {
    const { ctx } = await bootEditTrack();
    expect(asApp(ctx)['pdf.io']).toBeInstanceOf(PdfIoService);
    expect(asApp(ctx)['pdf.export']).toBeInstanceOf(PdfExportService);
    expect(asApp(ctx)['pdf.layout']).toBeInstanceOf(PdfLayoutService);
  });

  it('网关把 `pdf.io.open` 切成服务 `pdf.io` + 方法 `open` 并调得通', async () => {
    const { lookup } = await bootEditTrack();
    const resolution = resolveCall('pdf.io.open', lookup);
    expect(resolution).toMatchObject({ ok: true, service: 'pdf.io', method: 'open' });
    if (!resolution.ok) throw new Error('should not reach');
    // 经网关这一次调用真的落到了服务上：路径不存在时上浮的是编辑轨的错误码，不是「服务未挂载」。
    const failure = await Promise.resolve(resolution.invoke('/tmp/auto-cc-不存在的那份.pdf')).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AppError);
    expect(AppError.from(failure).code).toBe('PDF_EDIT_READ_FAILED');
  });

  it('网关把 `pdf.export.saveAs` 切成服务 `pdf.export` + 方法 `saveAs`（三段路径切在正确的点上）', async () => {
    const { lookup } = await bootEditTrack();
    const resolution = resolveCall('pdf.export.saveAs', lookup);
    expect(resolution).toMatchObject({ ok: true, service: 'pdf.export', method: 'saveAs' });
    if (!resolution.ok) throw new Error('should not reach');
    // 源文件读不出即结构化失败，且用的另存腿那一个码（`PDF_EDIT_READ_FAILED` 是打开腿的话术，两者不混）。
    // 四个实参按 `saveAs(filePath, overlays, pageOrder, outPath)` 给全：页序给空数组就够，因为这一条只测
    // "失败落到了编辑轨的码上"，而源文件不存在那一条腿在读文件时就先撞上了。
    const failure = await Promise.resolve(
      resolution.invoke('/tmp/auto-cc-不存在的那份.pdf', [], [], '/tmp/auto-cc-产物.pdf'),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect(AppError.from(failure).code).toBe('PDF_EDIT_SAVE_FAILED');
  });

  it('网关把 `pdf.layout.textItems` 切成服务 `pdf.layout` + 方法 `textItems`（路径与页号两个实参都过界）', async () => {
    const { lookup } = await bootEditTrack();
    const resolution = resolveCall('pdf.layout.textItems', lookup);
    expect(resolution).toMatchObject({ ok: true, service: 'pdf.layout', method: 'textItems' });
    if (!resolution.ok) throw new Error('should not reach');
    // 路径不存在时落在打开腿那一个码上（`PDF_EDIT_READ_FAILED`）：读不出文件这件事在界面上的处置与 `pdf.io.open` 相同，
    // 按已验收的口径（界面处置相同就共用一支码）不再另开支新码。
    const failure = await Promise.resolve(resolution.invoke('/tmp/auto-cc-不存在的那份.pdf', 1)).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AppError);
    expect(AppError.from(failure).code).toBe('PDF_EDIT_READ_FAILED');
  });
});

describe('白名单只放行登记过的那三条（§8.2 的边界）', () => {
  it('`pdf.*` 恰有 io.open、export.saveAs 与 layout.textItems，抄错的名字与还没落地的方法都进不来', () => {
    // 3.5-c₂ 会话腿把 `pdf.edit.*` 判成了渲染层的纯模型（plan §7.14），所以那六行至今不在名单里；
    // 这一片补上的是 §7.4 那张表里从 3.5-a 顺延下来的 `pdf.layout.textItems`。
    // 口径照旧：白名单每多一行就多一条没人审的通路，只在实现真落在一口服务上时才登记（表是路线图，不是许可证）。
    expect(RENDERER_ALLOWLIST.filter((id) => id.startsWith('pdf.'))).toEqual([
      'pdf.io.open',
      'pdf.export.saveAs',
      'pdf.layout.textItems',
    ]);
    expect(isAllowedCall('pdf.io.open')).toBe(true);
    expect(isAllowedCall('pdf.export.saveAs')).toBe(true);
    expect(isAllowedCall('pdf.layout.textItems')).toBe(true);
    expect(isAllowedCall('pdf.edit.addOverlay')).toBe(false);
    expect(isAllowedCall('pdf.layout.items')).toBe(false);
    expect(isAllowedCall('pdf.layout')).toBe(false);
    expect(isAllowedCall('pdf.export')).toBe(false);
    expect(isAllowedCall('pdf.export.save')).toBe(false);
    expect(isAllowedCall('pdf.io')).toBe(false);
    expect(isAllowedCall('Pdf.io.open')).toBe(false);
  });

  it('`pdf.*` 不进 agent 工具面：改的是用户手里的文件，模型没有这只手（plan §7.4 末行）', () => {
    const pdfIds = RENDERER_ALLOWLIST.filter((id) => id.startsWith('pdf.'));
    expect(pdfIds.every((id) => !id.startsWith('agent.'))).toBe(true);
    expect(pdfIds).toHaveLength(3);
  });
});
