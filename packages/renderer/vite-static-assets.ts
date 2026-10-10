/**
 * `packages/renderer/vite.config.ts` 的静态资源腿：把「必须与 `index.html` 同在一棵相对路径树下」的两类
 * 随包资源接进渲染层的 URL 空间——pdf.js 的 worker 与四类运行期资源（spec 3.5-12，plan §10.8 的那条未决项）、
 * 简历随包内嵌字体（spec 6.6-04）。
 *
 * 为什么不能走 vite 的 `?url` 或 `?worker&inline`：装机版的渲染层是 `file://` 页 +
 * `script-src 'self'`（`scripts/build.ts` 注入的 `RENDERER_CSP`），实测 `blob:` worker 被挡、
 * 而同源 `.mjs` worker 可用（plan §10.2）。所以 worker 必须是一份**真文件**，且 pdf.js 运行期要按
 * URL 去取的 `cmaps/`（CJK 字符映射）、`standard_fonts/`、`wasm/` 三类资源必须与它同在一棵相对路径树下
 * ——`document.baseURI` 在 dev 是 `http://127.0.0.1:5173/`、在装机版是 `file://…/renderer/index.html`，
 * 两边都指向「渲染层根目录」，于是同一条相对路径在两种运行态里各自落到正确的位置（§2.5 一份事实）。
 *
 * 字体腿用的是**同一条性质**：预览 HTML 里的 `@font-face` src 是相对路径（`PREVIEW_FONT_BASE`，
 * 见 `packages/shared/src/print.ts` 那条注释里记的 `NetworkError` 实测），而 `resources/fonts/**` 既不在
 * 渲染层包里、也不会被 vite 自己看见——不接这一条腿，屏上纸面永远掉回系统字体，只有导出的 PDF 才是内嵌字体。
 */
import { cpSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';
import { PDFJS_ASSET_DIRS, PDFJS_PATH_PREFIX, PDFJS_WORKER_FILE } from './src/pdfjs-asset-tree';

/** 仓库根目录（开发态字体随源码树；打包态由 `electron-builder.yml` 的 extraResources 另走一份进包）。 */
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/** 一棵静态资源树：URL 前缀 + 「前缀下的相对路径 → 磁盘绝对路径」的允许清单。 */
interface AssetTree {
  /** 渲染层根目录下的目录名，也是运行期 URL 的第一段。 */
  readonly prefix: string;
  /**
   * 允许被 URL 取到的文件。清单靠**列目录**得到、不接受任意路径拼接，
   * 于是中间件不可能被 `..` 带出声明好的那几个目录。
   */
  readonly files: ReadonlyMap<string, string>;
}

/**
 * 解析 `pdfjs-dist` 在 node_modules 里的真实根目录。
 * @returns 该包的绝对路径（含 `build/`、`cmaps/` 等）
 */
function resolvePdfjsRoot(): string {
  const require = createRequire(path.join(import.meta.dirname, 'package.json'));
  return path.dirname(require.resolve('pdfjs-dist/package.json'));
}

/**
 * 拼出 pdf.js 那一棵树：worker 本体 + 三个整目录搬的运行期资源目录。
 * @returns {@link AssetTree}
 */
function pdfjsTree(): AssetTree {
  const root = resolvePdfjsRoot();
  const files = new Map<string, string>();
  files.set(PDFJS_WORKER_FILE, path.join(root, PDFJS_WORKER_FILE));
  for (const dir of PDFJS_ASSET_DIRS) {
    for (const name of readdirSync(path.join(root, dir))) {
      files.set(`${dir}/${name}`, path.join(root, dir, name));
    }
  }
  return { prefix: PDFJS_PATH_PREFIX, files };
}

/**
 * 拼出简历字体那一棵树：`resources/fonts/**` 里的每只 woff2（许可证全文 `OFL.txt` 不进 URL 空间，
 * 它只随包给法务读，界面与打印面都不取它）。
 * @returns {@link AssetTree}
 */
function resumeFontTree(): AssetTree {
  const dir = path.join(repoRoot, 'resources', 'fonts');
  const files = new Map<string, string>();
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.woff2')) files.set(name, path.join(dir, name));
  }
  // 前缀必须与 `@auto-cc/shared` 的 `PREVIEW_FONT_BASE` 逐字相同：预览 HTML 拼的是那条相对路径。
  // 这里引不到那个常量——vite 只把**相对** import 内联进配置文件，包名 `@auto-cc/shared` 走 node 解析，
  // 而包入口里的 `./print.js` 说明符在 node 下解析不了（实测 ERR_MODULE_NOT_FOUND）。改一边必须改两边。
  return { prefix: 'fonts', files };
}

/**
 * 把一棵资源树接进渲染层的 URL 空间：开发态用中间件直接从源目录读，构建态搬进 `dist/`。
 * @param tree 待接的资源树（{@link AssetTree}）
 * @returns vite 插件
 */
function serveAssetTree(tree: AssetTree): Plugin {
  let outDir = '';
  return {
    name: `auto-cc:static-assets:${tree.prefix}`,
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use(`/${tree.prefix}/`, (req, res, next) => {
        const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname).replace(/^\//, '');
        const filePath = tree.files.get(rel);
        if (filePath === undefined) {
          next();
          return;
        }
        // 模块 worker 必须是 JS MIME，woff2 交给 font-face 按字形表解析；
        // 其余（.bcmap/.pfb/.wasm）pdf.js 都按 arrayBuffer 取，类型不参与判定。
        const type = /\.m?js$/.test(filePath)
          ? 'text/javascript'
          : /\.woff2$/.test(filePath)
            ? 'font/woff2'
            : 'application/octet-stream';
        res.setHeader('Content-Type', type);
        // 纸面帧是 `sandbox=""` 的 srcdoc（`ResumePaperStage.tsx:212`）：它没有来源，于是那条相对字体的
        // 请求是**跨源**取（`Origin: null`），浏览器按 CORS 校验——没有这一行就稳定报 `NetworkError`，
        // 屏上纸面永远掉回系统字体（实测 2026-10-10）。这几棵树都是随包的公开静态资源，`*` 不泄什么。
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(readFileSync(filePath));
      });
    },
    closeBundle() {
      const target = path.join(outDir, tree.prefix);
      for (const [rel, src] of tree.files) {
        const dest = path.join(target, ...rel.split('/'));
        mkdirSync(path.dirname(dest), { recursive: true });
        cpSync(src, dest);
      }
    },
  };
}

/**
 * pdf.js 资源腿（worker + cmaps/standard_fonts/wasm）。
 * @returns vite 插件
 */
export function pdfjsAssets(): Plugin {
  return serveAssetTree(pdfjsTree());
}

/**
 * 简历随包内嵌字体腿（`resources/fonts/*.woff2` → 渲染层根下的 `fonts/`）。
 * @returns vite 插件
 */
export function resumeFonts(): Plugin {
  return serveAssetTree(resumeFontTree());
}
