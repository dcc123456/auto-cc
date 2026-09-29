import type { RendererBridge } from '@auto-cc/shared';

declare global {
  interface Window {
    /** preload 依白名单注入；纯浏览器调试态下不存在。 */
    autoCC?: RendererBridge;
  }
}

export {};
