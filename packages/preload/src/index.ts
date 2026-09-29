import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, RENDERER_ALLOWLIST } from '@auto-cc/shared';

/**
 * 由白名单生成 `window.autoCC` 代理：命名空间 → 方法 → invoke。
 *
 * 不在白名单里的能力在渲染层**根本不存在**（不是"存在但被拒"），因此界面可调用方法数
 * 恒等于 `RENDERER_ALLOWLIST.length`；主进程侧再独立校验一次作为纵深防御。
 *
 * @returns 供 contextBridge 暴露的扁平命名空间对象
 */
const buildBridge = () => {
  const namespaces = new Map<string, Record<string, unknown>>();
  for (const id of RENDERER_ALLOWLIST) {
    const [namespace, method] = id.split('.');
    if (!namespace || !method) continue;
    const group = namespaces.get(namespace) ?? {};
    group[method] = (...args: unknown[]) => ipcRenderer.invoke(IPC_CHANNELS.call, { id, args });
    namespaces.set(namespace, group);
  }
  return Object.fromEntries(namespaces);
};

contextBridge.exposeInMainWorld('autoCC', buildBridge());
