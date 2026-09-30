/**
 * Single re-export surface for cordis.
 *
 * Every other package imports cordis primitives from here (enforced by the
 * `no-restricted-imports` rule) so that a cordis RC bump — its API is not stable —
 * is absorbed in one file instead of across the plugin tree.
 */
export { Context, CordisError, Fiber, Inject, Logger, Service } from 'cordis';
export type { Effect, EffectMeta, Exporter, LoggerType, Message as LoggerMessage, Plugin } from 'cordis';

import type { Context, Plugin } from 'cordis';
import type { WorkflowExecutorRegistry } from './events.js';

/**
 * cordis declares FiberState as an ambient const enum, which cannot be re-exported
 * under verbatimModuleSyntax — so the app maps the numeric state itself.
 */
export type PluginState = 'pending' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading';

export function fiberState(state: number): PluginState {
  return (['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'] as const)[state] ?? 'pending';
}

/** Typed authoring helper for the object form of a cordis plugin. */
export function definePlugin<T>(plugin: Plugin.Object<T>): Plugin.Object<T> {
  return plugin;
}

/**
 * 「确实没有可调项」的插件在直接挂载点的空配置实参。
 *
 * cordis 从构造器第二个参数反推 `ctx.plugin()` 调用点的配置类型，无键 schema 因此被推成
 * `undefined`（AGENTS.md §9 的 1.3 实测条），而运行期仍会拿 schema 解析一次实参：
 * 传 `undefined` 会被 strictObject 判成「期望对象却收到 undefined」，挂载当场就抛。
 * 放在这里而不是各包自己写一遍，是因为这是 cordis 的类型坑、不是某个包的私事。
 */
export const NO_CONFIG = Object.freeze({}) as unknown as undefined;

/** Augmentable map of app services; plugins add entries via module augmentation. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AppServices {}

/** Context plus every service a plugin has provided, so `ctx.<name>` is typed. */
export type AppContext = Context & AppServices;

/**
 * `Service.ctx` 的声明类型是 cordis 的 `Context`，看不到各包增补进来的服务名。
 * 需要访问兄弟服务时统一走这一次收窄（缺失时返回 undefined，由调用方判空）。
 */
export function asApp(ctx: Context): AppContext {
  // 断言看起来多余，是因为 core 自己的编译单元里 `AppServices` 还是空的；
  // 各插件包增补服务名之后，这一步收窄就不可省。
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return ctx as unknown as AppContext;
}

/**
 * 按服务名**可选**地取实例：未挂载（或上下文已销毁）一律收成 undefined，不抛。
 *
 * 与 `asApp` 的分工是「必需依赖 vs 可选增强」：必需依赖写进 `static inject`，由装配层
 * 保证存在，取不到就是 bug；可选依赖（如执行器登记、失败证据的页面通道）不能让整个服务
 * 因为对方没装而拒绝启动，只能就地降级。cordis 的 `ctx.get` 对未知名会抛，所以 try 是必要的，
 * 这不是「为假想场景加异常处理」（AGENTS.md §2.6）——它是这条口的既有行为（1.4 网关同款）。
 * @param ctx 当前服务的上下文
 * @param id 服务名（`域.能力` 约定）
 * @returns 已挂载的实例，未挂载为 undefined
 */
export function maybeService<T>(ctx: Context, id: string): T | undefined {
  try {
    return ctx.get(id) as T | undefined;
  } catch {
    return undefined;
  }
}

/**
 * 取工作流节点执行器的登记处（spec 2.4-01 的登记口）。
 *
 * 这只手放在 `core` 而不是 `plugin-workflow`：登记由各能力包（L2 领域）在自己的 init 里发起，
 * 而登记处属于 L3 流水线，让下层 import 上层会打破 AGENTS.md §4.1 的依赖方向。
 * @param ctx 调用方的上下文
 * @returns 登记处实例；工作流没装时为 undefined，此时能力包只是没有节点可登记，自身照常启动
 */
export function executorRegistryOf(ctx: Context): WorkflowExecutorRegistry | undefined {
  return maybeService<WorkflowExecutorRegistry>(ctx, 'workflow.executors');
}

/** Service name convention: `域.能力`, e.g. `store.db`, `jd.store`. */
export type ServiceName = string & {};

export * from './errors.js';
export * from './events.js';
export * from './paths.js';
export * from './sql.js';
export * from './concurrency.js';
