/**
 * 跨进程的 cordis 事件契约（spec 1.4-03）。
 *
 * `Events` 的字符串键必须由模块增补声明，而全应用只有 `core` 允许接触 cordis
 * （见 eslint 的 CORDIS 限制），所以「哪些事件可以出进程」的声明集中在这里；
 * 网关侧另有 `RENDERER_EVENTS` 白名单，两者一起构成事件出口的双层收口。
 */

/**
 * 一条已脱敏日志的线格式；渲染层视图与主进程事件载荷共用同一形状。
 */
export interface LogLineView {
  ts: number;
  level: string;
  name: string;
  text: string;
}

/**
 * 插件失败事件（spec 1.5-07）。
 *
 * `stack` 是完整调用栈：界面上折叠显示，展开才看得见，所以它必须越过 IPC 边界，
 * 但不能进日志文本（日志只留 message，见 `kernel` 的 `record`）。
 */
export interface PluginErrorView {
  id: string;
  message: string;
  stack?: string;
  at: number;
}

/**
 * 会话登录态失效事件（spec 1.8-06）。
 *
 * 只带平台名与判定原因：这条载荷会被推到渲染层、也可能被 harness 原样写进证据文件，
 * 一旦带上 cookie 值就等于把登录凭证抄进截图（AGENTS.md §8.5）。
 */
export interface SessionExpiredEvent {
  platform: string;
  /** `missing` = 分区里根本没有会话 cookie；`expired` = 有但已过期。 */
  reason: 'missing' | 'expired';
  /** 判定基准时间戳（毫秒）。 */
  at: number;
}

/** 内嵌内核视图的一次加载失败（`did-fail-load`），1.8-09 要求它必须能被界面读到。 */
export interface KernelViewLoadError {
  code: number;
  description: string;
  url: string;
}

declare module 'cordis' {
  interface Events {
    /** `log` 服务每写出一条已脱敏日志时发出，IPC 网关节据此推给渲染层。 */
    'log/line'(line: LogLineView): void;
    /**
     * 某个插件进入 FAILED 状态时由 `kernel` 发出，`plugins` 服务据此累积错误历史。
     * 这里声明的是**进程内**事件：它没进 `RENDERER_EVENTS`，因此不会出进程。
     */
    'plugin/error'(error: PluginErrorView): void;
    /**
     * 某平台的登录态被探测为失效时由 `sessions` 发出（spec 1.8-06）。
     * 载荷刻意只有平台名与原因，没有任何 cookie 值（AGENTS.md §8.5）。
     */
    'session/expired'(event: SessionExpiredEvent): void;
    /**
     * 内嵌内核视图的主文档加载失败时由 `shell` 发出（spec 1.8-09）。
     * 界面不能靠轮询 `shell.getStatus` 看到它：`sessions.open` 先返回、失败事件后到，
     * 那次读数里错误位还是空的，所以错误态必须由事件推进来。
     */
    'shell/view-error'(error: KernelViewLoadError): void;
  }
}
