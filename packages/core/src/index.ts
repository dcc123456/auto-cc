/**
 * Single re-export surface for cordis.
 *
 * Every other package imports cordis primitives from here (enforced by the
 * `no-restricted-imports` rule) so that a cordis RC bump — its API is not stable —
 * is absorbed in one file instead of across the plugin tree.
 */
export { Context, CordisError, Fiber, Inject, Service } from 'cordis';
export type { Effect, Plugin } from 'cordis';

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

/** Augmentable map of app services; plugins add entries via module augmentation. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AppServices {}

/** Context plus every service a plugin has provided, so `ctx.<name>` is typed. */
export type AppContext = Context & AppServices;

/** Service name convention: `域.能力`, e.g. `store.db`, `jd.store`. */
export type ServiceName = string & {};

export * from './errors.js';
export * from './paths.js';
