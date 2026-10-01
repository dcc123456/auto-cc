/**
 * `resume.print` 端口的实现（spec 3.3-02 / 04 / 05 / 12 的执行半边）：隐藏视图渲染 HTML → `printToPDF` → 交回字节。
 *
 * 全仓**唯一**碰 `webContents.printToPDF` 的地方（AGENTS.md §4.1：视图/窗口属 L1 壳，生成轨 L2 不反向依赖）。
 * 它只做「HTML 进、PDF 字节出」这一件事——不落盘、不改文档、不认识简历模型（那些都在 `resume.export`）。
 *
 * 无闪窗（3.3-04）：每次导出建一个 `show:false` 的离屏窗口，用完即关，全程不 `show()`。
 * 并发安全（3.3-12）：每次调用各自建窗口、各写各自的临时 HTML，互不共享可变态。
 * 字体就绪（3.3-05）：打印前 `await document.fonts.ready`，确保内嵌 `@font-face` 的字形已加载再定格版面。
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { Service, type Context } from '@auto-cc/core';
import type { ResumePrintPort, ResumePrintRequest } from '@auto-cc/shared';
import { z } from 'zod';

/** 仓库根目录（开发态字体随源码树；打包态随 extraResources）。 */
const repoRoot = join(__dirname, '..', '..', '..');

/** 无配置服务：端口只认「打印」这一件事，字体目录与临时目录都由运行期算出。 */
export const resumePrintSchema = z.strictObject({});

/**
 * 生成轨打印执行器：实现 {@link ResumePrintPort}。
 */
export class ResumePrintService extends Service implements ResumePrintPort {
  static provide = 'resume.print';
  static Config = resumePrintSchema;

  constructor(ctx: Context, _options: z.infer<typeof resumePrintSchema>) {
    super(ctx, 'resume.print');
  }

  /**
   * 随包内嵌字体目录的 `file://` base（不带结尾斜杠）。
   * @returns 开发态指向仓库 `resources/fonts`，打包态指向 `process.resourcesPath/fonts`
   */
  fontBaseUrl(): string {
    const dir = app.isPackaged ? join(process.resourcesPath, 'fonts') : join(repoRoot, 'resources', 'fonts');
    return pathToFileURL(dir).href;
  }

  /**
   * 在离屏窗口里把打印 HTML 渲染成 PDF 字节。
   *
   * HTML 落到临时目录再经 `file://` 装载：`@font-face` 的 `src` 是绝对 `file://` 字体，
   * 只有同源（file）文档才允许加载本地字体，`data:` 的 opaque origin 会被 Chromium 拦下（plan §3.3 字体随包内嵌）。
   * @param request 完整打印 HTML + 打印选项
   * @returns PDF 产物字节；打印失败由调用方（`resume.export`）收敛成结构化错误
   */
  async render(request: ResumePrintRequest): Promise<Uint8Array> {
    const dir = await mkdtemp(join(tmpdir(), 'auto-cc-print-'));
    const htmlPath = join(dir, `${randomUUID()}.html`);
    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await writeFile(htmlPath, request.html, 'utf8');
      await win.webContents.loadURL(pathToFileURL(htmlPath).href);
      // 字体子集随用随载：等 `document.fonts.ready` 落定再打印，字形才进得了产物（3.3-05）。
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      const pdf = await win.webContents.printToPDF(request.options);
      return new Uint8Array(pdf);
    } finally {
      if (!win.isDestroyed()) win.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  }
}
