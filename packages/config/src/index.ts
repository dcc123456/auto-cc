/**
 * `config` 服务（spec 1.3-02 / 1.3-03）。
 *
 * 分层合并是纯函数（`merge.ts`），校验也是纯函数（`validate.ts`）；本文件只负责把
 * cordis.yml 的文件层、进程环境变量、以及主进程注入的运行时覆盖拼在一起，并在
 * **挂载期**把非法字段挡下来。
 */
import { resolveLogDir, resolveUserDataDir, Service, type Context } from '@auto-cc/core';
import { homedir } from 'node:os';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { envLayer, mergeDeep, mergeLayers, type ConfigLayer } from './merge.js';
import { validateConfig } from './validate.js';

/** 单个插件的配置诉求：schema 是唯一真相，其余三层是来源。 */
export interface ConfigRequest<T> {
  schema: StandardSchemaV1<unknown, T>;
  /** cordis.yml 里该插件的 `config` 段（文件层） */
  file?: unknown;
  /** 环境变量白名单：配置路径 → 变量名；不在表里的变量一律忽略 */
  envMap?: Record<string, string>;
  /** 运行时覆盖层（主进程/界面写入，优先级最高） */
  runtime?: unknown;
  /** 环境变量快照，单测注入用 */
  env?: Record<string, string | undefined>;
}

export interface ConfigTrace {
  layers: ConfigLayer[];
  value: Record<string, unknown>;
}

export interface DataPaths {
  userDataDir: string;
  logDir: string;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** 四层合并（默认 < 文件 < 环境变量 < 运行时），并保留每层原值以便界面展示来源。 */
export function traceConfig(input: ConfigRequest<unknown>): ConfigTrace {
  const layers: ConfigLayer[] = [
    { scope: 'default', values: {} },
    { scope: 'file', values: asObject(input.file) },
    { scope: 'env', values: envLayer(input.env ?? process.env, input.envMap ?? {}) },
    { scope: 'runtime', values: asObject(input.runtime) },
  ];
  return { layers, value: mergeLayers(layers) };
}

/** 合并 + 同步校验；失败抛 `ConfigValidationError`，错误里带服务名与字段路径。 */
export function resolveConfig<T>(serviceName: string, input: ConfigRequest<T>): T {
  return validateConfig(serviceName, input.schema, traceConfig(input).value);
}

/** `config` 插件只关心应用名——它决定平台规范目录的落点（spec 1.1-11）。 */
export const configSchema = z.strictObject({
  appName: z.string().min(1).default('auto-cc'),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type ConfigOutput = z.infer<typeof configSchema>;

/**
 * 配置服务：持有文件层与运行时层，供内核按插件逐个解析，也供界面回看来源。
 */
export class ConfigService extends Service {
  static provide = 'config';
  static Config = configSchema;

  /** 环境变量快照；测试可整体替换，避免依赖真实 env。 */
  env: Record<string, string | undefined> = process.env;

  private readonly fileLayers = new Map<string, unknown>();
  private readonly runtimeLayers = new Map<string, unknown>();
  private pathsOverride: Partial<DataPaths> = {};

  /** cordis 把 `static Config` 校验后的配置作为构造器第二个实参传入，类型也从这里推导出调用点。 */
  private readonly options: ConfigOutput;

  constructor(ctx: Context, options: ConfigOutput) {
    super(ctx, 'config');
    this.options = options;
  }

  /** 主进程用 `app.getPath()` 结果覆盖平台目录；缺失时 `paths()` 退回纯解析函数。 */
  setPathsOverride(paths: Partial<DataPaths>): void {
    this.pathsOverride = { ...this.pathsOverride, ...paths };
  }

  /** 装载 cordis.yml 里某插件的 `config` 段。 */
  setFile(id: string, values: unknown): void {
    this.fileLayers.set(id, values);
  }

  /** 运行时覆盖（spec 1.3-02 第 4 层）：同路径后写赢，不影响已写入的其它键。 */
  setRuntime(id: string, patch: unknown): void {
    this.runtimeLayers.set(id, mergeDeep(asObject(this.runtimeLayers.get(id)), asObject(patch)));
  }

  /** 某插件当前四层合并结果与来源（界面「配置来源」面板与断言用）。 */
  trace<T>(id: string, request: Pick<ConfigRequest<T>, 'schema' | 'envMap'>): ConfigTrace {
    return traceConfig({
      schema: request.schema,
      env: this.env,
      envMap: request.envMap,
      file: this.fileLayers.get(id),
      runtime: this.runtimeLayers.get(id),
    });
  }

  /** 解析某插件的最终配置；非法字段在这里失败，而不是让插件运行期撞空值。 */
  resolve<T>(id: string, request: Pick<ConfigRequest<T>, 'schema' | 'envMap'>): T {
    return validateConfig(id, request.schema, this.trace(id, request).value);
  }

  /** 平台规范目录。Electron 主进程应通过 `setPathsOverride` 给出权威值。 */
  paths(): DataPaths {
    const input = { platform: process.platform, env: this.env, homedir: homedir() };
    const appName = this.options.appName;
    return {
      userDataDir: this.pathsOverride.userDataDir ?? resolveUserDataDir(appName, input),
      logDir: this.pathsOverride.logDir ?? resolveLogDir(appName, input),
    };
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    config: ConfigService;
  }
}
