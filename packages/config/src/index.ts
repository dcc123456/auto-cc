/**
 * `config` 服务（spec 1.3-02 / 1.3-03）。
 *
 * 分层合并是纯函数（`merge.ts`），校验也是纯函数（`validate.ts`）；本文件只负责把
 * cordis.yml 的文件层、userData 里的持久层、进程环境变量、以及主进程注入的运行时覆盖拼在一起，并在
 * **挂载期**把非法字段挡下来。
 *
 * 另有两格**不参与合并**的存储：`secret.ts` 的密钥库（凭证只以密文落盘、对外只回掩码）与
 * `persist.ts` 的设置持久层（让界面里的表态熬过重启）。它们放在同一个包里是刻意的——
 * AGENTS.md §2.7 禁「第二套配置读取 / 第二套状态存储」，跨模块要落盘的键只有这一个入口。
 */
import { AppError, resolveLogDir, resolveUserDataDir, Service, type Context } from '@auto-cc/core';
import { homedir } from 'node:os';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { SettingsStore } from './persist.js';
import { SecretStore, resolveCipher, type SecretRecord } from './secret.js';
import { envLayer, mergeDeep, mergeLayers, type ConfigLayer } from './merge.js';
import { validateConfig } from './validate.js';

/** 单个插件的配置诉求：schema 是唯一真相，其余几层是来源。 */
export interface ConfigRequest<T> {
  schema: StandardSchemaV1<unknown, T>;
  /** cordis.yml 里该插件的 `config` 段（文件层） */
  file?: unknown;
  /** userData/settings.json 里该插件的覆盖值（持久层，spec 7.1-05）；排在文件层之上、env 之下 */
  persisted?: unknown;
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

/** 五层合并（默认 < 文件 < 持久 < 环境变量 < 运行时），并保留每层原值以便界面展示来源。 */
export function traceConfig(input: ConfigRequest<unknown>): ConfigTrace {
  const layers: ConfigLayer[] = [
    { scope: 'default', values: {} },
    { scope: 'file', values: asObject(input.file) },
    { scope: 'persisted', values: asObject(input.persisted) },
    { scope: 'env', values: envLayer(input.env ?? process.env, input.envMap ?? {}) },
    { scope: 'runtime', values: asObject(input.runtime) },
  ];
  return { layers, value: mergeLayers(layers) };
}

/** 合并 + 同步校验；失败抛 `ConfigValidationError`，错误里带服务名与字段路径。 */
export function resolveConfig<T>(serviceName: string, input: ConfigRequest<T>): T {
  return validateConfig(serviceName, input.schema, traceConfig(input).value);
}

/** `config` 插件关心两件事：应用名（决定平台规范目录的落点，spec 1.1-11）与主进程给出的权威目录。 */
export const configSchema = z.strictObject({
  appName: z.string().min(1).default('auto-cc'),
  /**
   * 主进程用 Electron `app.getPath()` 结果给出的覆盖；缺失时 `paths()` 退回纯解析函数。
   * 走配置层而不是一个 setter：这样它和其它运行时覆盖同层、能在来源追溯里看见，且只有装配那一次有机会写它。
   */
  paths: z.strictObject({ userDataDir: z.string().min(1).optional(), logDir: z.string().min(1).optional() }).optional(),
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

  /** userData/settings.json 的内存镜像；`[Service.init]` 之前是 null（此时持久层视为空）。 */
  private settings: SettingsStore | null = null;

  /** 密钥库；同样在 init 之后才存在，读不到就当没存（`getSecret` 回空串）。 */
  private secrets: SecretStore | null = null;

  /** cordis 把 `static Config` 校验后的配置作为构造器第二个实参传入，类型也从这里推导出调用点。 */
  private readonly options: ConfigOutput;

  constructor(ctx: Context, options: ConfigOutput) {
    super(ctx, 'config');
    this.options = options;
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
      persisted: this.settings?.get(id),
      runtime: this.runtimeLayers.get(id),
    });
  }

  /** 解析某插件的最终配置；非法字段在这里失败，而不是让插件运行期撞空值。 */
  resolve<T>(id: string, request: Pick<ConfigRequest<T>, 'schema' | 'envMap'>): T {
    return validateConfig(id, request.schema, this.trace(id, request).value);
  }

  /** 平台规范目录：主进程给过 `paths` 就以它为准，否则按 appName 纯解析（Electron 缺席的单测走这条）。 */
  paths(): DataPaths {
    const input = { platform: process.platform, env: this.env, homedir: homedir() };
    const appName = this.options.appName;
    const override = this.options.paths;
    return {
      userDataDir: override?.userDataDir ?? resolveUserDataDir(appName, input),
      logDir: override?.logDir ?? resolveLogDir(appName, input),
    };
  }

  /**
   * 把某插件的覆盖值**写进磁盘**（spec 7.1-05），使其熬过重启。
   *
   * 白名单由调用方给出：本方法只接受 `allow` 列出的顶层键，其余一律 `SETTING_NOT_ALLOWED`。
   * 没有这道闸，设置页就会变成"任意插件的任意配置都能从渲染层写盘"的口子。
   * @param id 插件 id（与 cordis.yml 里的名字一致）
   * @param patch 要覆盖的键值（只允许扁平标量；嵌套对象被拒绝）
   * @param allow 允许落盘的键清单（由声明它的那个服务提供，不在这里的键不写）
   * @throws 持久层尚未装载（init 之前）或键不在白名单时 `SETTING_NOT_ALLOWED`
   */
  setPersisted = (id: string, patch: Record<string, unknown>, allow: readonly string[]): void => {
    if (!this.settings) {
      throw new AppError('SETTING_NOT_ALLOWED', '设置持久层尚未装载（config 未初始化）', 'config', { id });
    }
    for (const [key, value] of Object.entries(patch)) {
      const allowed = allow.includes(key);
      const flat = value === null || ['string', 'number', 'boolean'].includes(typeof value);
      if (!allowed || !flat) {
        throw new AppError('SETTING_NOT_ALLOWED', `键 ${id}.${key} 不允许从界面写入`, 'config', { id, key });
      }
    }
    this.settings.write(id, patch);
  };

  /** 某插件当前已持久化的覆盖值（未装载或未写过时为空对象）。 */
  persisted = (id: string): Record<string, unknown> => this.settings?.get(id) ?? {};

  /**
   * 取一条密钥的明文。
   * @param path 密钥路径（服务名级别，如 `llm.chat`）
   * @returns 明文；没存过、装载失败或未初始化都回空串，**不抛**（可用性判定归 `llm.chat.status()`）
   */
  getSecret = (path: string): string => this.secrets?.get(path) ?? '';

  /**
   * 写入一条密钥（密文落盘，0600）。
   * @param path 密钥路径
   * @param plain 明文；空串按「清除」处置，避免界面上"清空输入框再保存"变成写入空密钥
   */
  setSecret = (path: string, plain: string): void => {
    if (!this.secrets) {
      throw new AppError('SECRET_UNREADABLE', '密钥库尚未装载（config 未初始化）', 'config', { path });
    }
    if (plain === '') this.secrets.clear(path);
    else this.secrets.set(path, plain);
  };

  /** 删除一条密钥；不存在时静默成功。 */
  clearSecret = (path: string): void => this.secrets?.clear(path);

  /** 密钥清单（只有掩码：路径 + 末 4 位 + 写入时间），供界面与诊断展示。 */
  listSecrets = (): SecretRecord[] => this.secrets?.list() ?? [];

  /**
   * 密钥存储的事实陈述（spec 7.1-03 / 7.1-04）：有没有加密、是不是解不开、文件落在哪。
   * @returns `encrypted` 来自 `safeStorage` 探测；`unreadable` 为 true 时界面要请人重填一次
   */
  secretStorage = (): { encrypted: boolean; unreadable: boolean; file: string | null } => ({
    encrypted: this.secrets?.isEncrypted ?? false,
    unreadable: this.secrets?.unreadable ?? false,
    file: this.secrets?.filePath() ?? null,
  });

  /**
   * 装载持久层与密钥库（spec 7.1-01 / 7.1-05）。
   *
   * 顺序要紧：它必须早于任何插件解析配置，所以 `config` 在 cordis.yml 里排在最前（AGENTS.md §9 实测 5.1-c）。
   * `resolveCipher()` 是异步的（Electron 的 `safeStorage` 只在主进程里可解析），因此这里是 `async` init。
   */
  async [Service.init](): Promise<void> {
    const { userDataDir } = this.paths();
    this.settings = new SettingsStore(userDataDir);
    this.settings.load();
    this.secrets = new SecretStore(userDataDir, await resolveCipher());
    const loaded = this.secrets.load();
    this.ctx.logger.info(
      `设置持久层已装载：${String(userDataDir)}/settings.json · ` +
        `密钥库${this.secrets.isEncrypted ? '已加密' : '未加密（系统安全存储不可用）'}存储 ${String(loaded.records.length)} 条` +
        `${loaded.unreadable ? '（原有文件解不开，需重填）' : ''}`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    config: ConfigService;
  }
}
