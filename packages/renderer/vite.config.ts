import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { pdfjsAssets } from './vite-pdfjs-assets.js';

export default defineConfig({
  // pdf.js 的 worker 与三类资源必须与 `index.html` 同处一棵相对路径树下，装机版才能在
  // `file://` + `script-src 'self'` 里拿到同源 worker（spec 3.5-12 / plan §10.8）。
  plugins: [react(), tailwindcss(), pdfjsAssets()],
  // 打包后由主进程以 file:// 加载 dist/index.html，资源必须相对定位
  base: './',
  resolve: {
    alias: { '@auto-cc/shared': path.resolve(import.meta.dirname, '../shared/src/index.ts') },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
