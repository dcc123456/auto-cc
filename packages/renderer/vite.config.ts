import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 打包后由主进程以 file:// 加载 dist/index.html，资源必须相对定位
  base: './',
  resolve: {
    alias: { '@auto-cc/shared': path.resolve(import.meta.dirname, '../shared/src/index.ts') },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
