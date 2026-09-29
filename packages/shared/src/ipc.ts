/**
 * IPC 通道常量（spec 1.4-02）。
 *
 * 全应用只有这两个通道：`cordis:call` 走请求/响应，`cordis:event` 走主进程→渲染层的事件流。
 * 新增通道要改这份常量与 spec；插件不允许自己注册入站处理器，一律经 `plugin-ipc` 网关。
 */
export const IPC_CHANNELS = { call: 'cordis:call', event: 'cordis:event' } as const;
