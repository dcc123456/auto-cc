import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { pdfjsAssets, resumeFonts } from './vite-static-assets.js';

export default defineConfig({
  // pdf.js 的 worker 与三类资源、简历的随包内嵌字体，都必须与 `index.html` 同处一棵相对路径树下，
  // 装机版才能在 `file://` + `script-src 'self'` / `font-src 'self'` 里拿到同源资源（spec 3.5-12 / 6.6-04）。
  plugins: [react(), tailwindcss(), pdfjsAssets(), resumeFonts()],
  // 打包后由主进程以 file:// 加载 dist/index.html，资源必须相对定位
  base: './',
  resolve: {
    alias: { '@auto-cc/shared': path.resolve(import.meta.dirname, '../shared/src/index.ts') },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
