import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { pdfjsAssets, resumeFonts } from './vite-static-assets.js';

// 端口缺省仍是 5173；同机另一个项目的 dev 占着它时，用 AUTO_CC_RENDERER_PORT 让出，
// 由 scripts/dev.ts 读同一个变量拼 ELECTRON_RENDERER_URL。
const rendererPort = Number(process.env.AUTO_CC_RENDERER_PORT ?? 5173);

export default defineConfig({
  // pdf.js 的 worker 与三类资源、简历的随包内嵌字体，都必须与 `index.html` 同处一棵相对路径树下，
  // 装机版才能在 `file://` + `script-src 'self'` / `font-src 'self'` 里拿到同源资源（spec 3.5-12 / 6.6-04）。
  plugins: [react(), tailwindcss(), pdfjsAssets(), resumeFonts()],
  // 打包后由主进程以 file:// 加载 dist/index.html，资源必须相对定位
  base: './',
  resolve: {
    alias: { '@auto-cc/shared': path.resolve(import.meta.dirname, '../shared/src/index.ts') },
  },
  server: { host: '127.0.0.1', port: rendererPort, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
