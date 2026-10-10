/**
 * pdf.js 资源树的**路径口径**（spec 3.5-12）：worker 本体与三类运行期资源在渲染层根目录下的位置。
 *
 * 这一份常量同时被两侧消费：构建侧的 `vite-pdfjs-assets.ts` 按它决定搬哪些文件、开发态中间件挂哪个前缀，
 * 运行侧的 `pdf-page-view.ts` 按它拼出 URL。之所以单独成模块且**不含任何 Node 引用**：装机页与开发页
 * 拿到的是同一条相对路径（`document.baseURI` 两边都指向渲染层根目录），一旦这个前缀在两处各写一遍，
 * 就会出现「dev 跑得通、装机找不到 worker」那种只能靠人撞的漂移（AGENTS.md §2.5）。
 */

/** 渲染层根目录下的资源目录名，也是运行期 URL 的第一段。 */
export const PDFJS_PATH_PREFIX = 'pdfjs';

/** worker 本体（取 min 那份：装机版少解析 1MB 源码）。 */
export const PDFJS_WORKER_FILE = 'build/pdf.worker.min.mjs';

/**
 * 运行期按 URL 现取的资源目录，整目录搬。
 * 除这三类以外 pdf.js 不从磁盘取任何东西（已在 `build/pdf.worker.min.mjs` 里 grep 过取数点：
 * cmaps 的 `.bcmap`、标准字体的 `.pdb/.pfb`、解码用的 `.wasm`）。
 */
export const PDFJS_ASSET_DIRS = ['cmaps', 'standard_fonts', 'wasm'] as const;
