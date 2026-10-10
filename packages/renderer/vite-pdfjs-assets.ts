/**
 * `packages/renderer/vite.config.ts` 的 pdf.js 资源腿（spec 3.5-12，plan §10.8 的那条未决项）。
 *
 * 为什么不能走 vite 的 `?url` 或 `?worker&inline`：装机版的渲染层是 `file://` 页 +
 * `script-src 'self'`（`scripts/build.ts` 注入的 `RENDERER_CSP`），实测 `blob:` worker 被挡、
 * 而同源 `.mjs` worker 可用（plan §10.2）。所以 worker 必须是一份**真文件**，且 pdf.js 运行期要按
 * URL 去取的 `cmaps/`（CJK 字符映射）、`standard_fonts/`、`wasm/` 三类资源必须与它同在一棵相对路径树下
 * ——`document.baseURI` 在 dev 是 `http://127.0.0.1:5173/`、在装机版是 `file://…/renderer/index.html`，
 * 两边都指向「渲染层根目录」，于是同一条 `pdfjs/...` 相对路径在两种运行态里各自落到正确的位置（§2.5 一份事实）。
 */
import { cpSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';
import { PDFJS_ASSET_DIRS, PDFJS_PATH_PREFIX, PDFJS_WORKER_FILE } from './src/pdfjs-asset-tree';

/**
 * 解析 `pdfjs-dist` 在 node_modules 里的真实根目录。
 * @returns 该包的绝对路径（含 `build/`、`cmaps/` 等）
 */
function resolvePdfjsRoot(): string {
  const require = createRequire(path.join(import.meta.dirname, 'package.json'));
  return path.dirname(require.resolve('pdfjs-dist/package.json'));
}

/**
 * 把 pdf.js 的四类资源接进渲染层的 URL 空间：开发态用中间件直接从包目录读，构建态搬进 `dist/`。
 * @returns vite 插件
 */
export function pdfjsAssets(): Plugin {
  const root = resolvePdfjsRoot();
  // 开发态的允许清单靠"列目录"得到，不接受任意路径拼接——中间件因此不可能被 `..` 带出包目录。
  const files = new Map<string, string>();
  files.set(PDFJS_WORKER_FILE, path.join(root, PDFJS_WORKER_FILE));
  for (const dir of PDFJS_ASSET_DIRS) {
    for (const name of readdirSync(path.join(root, dir))) {
      files.set(`${dir}/${name}`, path.join(root, dir, name));
    }
  }

  let outDir = '';
  return {
    name: 'auto-cc:pdfjs-assets',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use(`/${PDFJS_PATH_PREFIX}/`, (req, res, next) => {
        const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname).replace(/^\//, '');
        const filePath = files.get(rel);
        if (filePath === undefined) {
          next();
          return;
        }
        // 模块 worker 必须是 JS  MIME，其余（.bcmap/.pfb/.wasm）pdf.js 都按 arrayBuffer 取，类型不参与判定。
        res.setHeader('Content-Type', /\.m?js$/.test(filePath) ? 'text/javascript' : 'application/octet-stream');
        res.end(readFileSync(filePath));
      });
    },
    closeBundle() {
      const target = path.join(outDir, PDFJS_PATH_PREFIX);
      for (const [rel, src] of files) {
        const dest = path.join(target, ...rel.split('/'));
        mkdirSync(path.dirname(dest), { recursive: true });
        cpSync(src, dest);
      }
    },
  };
}
