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

/** Service name convention: `域.能力`, e.g. `store.db`, `jd.store`. */
export type ServiceName = string & {};

export * from './errors.js';
export * from './events.js';
export * from './paths.js';
export * from './concurrency.js';
