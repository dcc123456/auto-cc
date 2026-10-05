/**
 * 编辑轨打开腿的**装配与 IPC 面**对账（spec 3.4-03 的接线半边 / plan §7.4）。
 *
 * 为什么放在 `packages/main`：这里要同时读到注册表、`cordis.yml`、渲染层白名单与网关的 `resolveCall`
 * ——四样东西分属四个包，只有装配层认识它们全部（`graph-link.test.ts` 同一口径）。
 * 装载语义本体（页数、宽高、三种确定态）在 `packages/pdf-edit/src/*.test.ts` 判，
 * 这里只钉「界面调得到的那条路径确实切成服务 `pdf.io` + 方法 `open`，且未登记的名字进不来」。
 */
import { AppError, asApp, Context, type Fiber } from '@auto-cc/core';
import { PdfIoService } from '@auto-cc/plugin-pdf-edit';
import { resolveCall } from '@auto-cc/plugin-ipc';
import { RENDERER_ALLOWLIST, isAllowedCall } from '@auto-cc/shared';
import { afterAll, describe, expect, it } from 'vitest';

const fibers: Fiber[] = [];

/**
 * 只挂 `pdf.io` 一只服务（它不 inject 任何别的名字，所以这里不需要 store）。
 * @returns 上下文与按名取实例的查找口（网关用的就是同一种查找）
 */
async function bootPdfIo(): Promise<{ ctx: Context; lookup: (name: string) => object | undefined }> {
  const ctx = new Context();
  fibers.push(await ctx.plugin(PdfIoService, { maxBytes: 5242880 }));
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

describe('pdf.io 走的是真装配那道口（plan §7.3 的挂载 + §7.4 的白名单）', () => {
  it('服务在真实上下文里挂起来了，名字就是 `pdf.io`', async () => {
    const { ctx } = await bootPdfIo();
    expect(asApp(ctx)['pdf.io']).toBeInstanceOf(PdfIoService);
  });

  it('网关把 `pdf.io.open` 切成服务 `pdf.io` + 方法 `open` 并调得通', async () => {
    const { lookup } = await bootPdfIo();
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
});

describe('白名单只放行登记过的那一条（§8.2 的边界）', () => {
  it('`pdf.*` 恰有 io.open 一项，抄错的名字与还没落地的方法都进不来', () => {
    // 3.5-b 的 `pdf.edit.*` / `pdf.export.saveAs` 与 3.5-a 的 `pdf.layout.textItems` 此刻都不在名单里：
    // 白名单每多一行就多一条没人审的通路，所以它们各自等到有实现的那一片再登记（plan §7.4 的表是路线图，不是许可证）。
    expect(RENDERER_ALLOWLIST.filter((id) => id.startsWith('pdf.'))).toEqual(['pdf.io.open']);
    expect(isAllowedCall('pdf.io.open')).toBe(true);
    expect(isAllowedCall('pdf.export.saveAs')).toBe(false);
    expect(isAllowedCall('pdf.layout.textItems')).toBe(false);
    expect(isAllowedCall('pdf.io')).toBe(false);
    expect(isAllowedCall('Pdf.io.open')).toBe(false);
  });

  it('`pdf.*` 不进 agent 工具面：改的是用户手里的文件，模型没有这只手（plan §7.4 末行）', () => {
    const pdfIds = RENDERER_ALLOWLIST.filter((id) => id.startsWith('pdf.'));
    expect(pdfIds.every((id) => !id.startsWith('agent.'))).toBe(true);
    expect(pdfIds).toHaveLength(1);
  });
});
