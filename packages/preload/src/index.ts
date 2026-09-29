import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, RENDERER_ALLOWLIST, isAllowedEvent, type RendererEvent } from '@auto-cc/shared';

/**
 * 由 `RENDERER_ALLOWLIST` 生成 `window.autoCC`：命名空间 → 方法 → invoke。
 *
 * 名单与主进程网关读的是同一个常量，因此「渲染层能调什么」与「主进程允许什么」不会漂移；
 * 不在名单里的能力在界面上**根本不存在**（不是存在但被拒），网关再独立校验一次作为纵深防御。
 */
const buildNamespaces = (): Record<string, Record<string, unknown>> => {
  const namespaces = new Map<string, Record<string, unknown>>();
  for (const path of RENDERER_ALLOWLIST) {
    // 只按第一个点切：`log.tail` → ('log','tail')。
    // 用 `const [ns, method] = id.split('.')` 会把第三段之后的内容静默丢掉，`a.b.c` 就指到了别的键上。
    const dot = path.indexOf('.');
    const namespace = path.slice(0, dot);
    const method = path.slice(dot + 1);
    const group = namespaces.get(namespace) ?? {};
    group[method] = (...args: unknown[]) => ipcRenderer.invoke(IPC_CHANNELS.call, { path, args });
    namespaces.set(namespace, group);
  }
  return Object.fromEntries(namespaces);
};

/**
 * 订阅主进程推送的事件。
 *
 * 事件名是渲染层传进来的运行时字符串，TS 类型在这里不做任何保证，
 * 所以未登记的名字一律不接（spec 1.4-03）。
 */
const on = (name: string, handler: (payload: unknown) => void): (() => void) => {
  if (!isAllowedEvent(name)) return () => {};
  const listener = (_event: unknown, envelope: RendererEvent) => {
    if (envelope.event === name) handler(envelope.payload);
  };
  ipcRenderer.on(IPC_CHANNELS.event, listener);
  return () => {
    ipcRenderer.removeListener(IPC_CHANNELS.event, listener);
  };
};

contextBridge.exposeInMainWorld('autoCC', { ...buildNamespaces(), on });
