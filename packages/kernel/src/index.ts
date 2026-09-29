/**
 * `kernel` 服务（spec 1.3-01 / 1.3-09 / 1.3-10）。
 *
 * 它是「清单 → 真实插件树」的唯一通道：读 `cordis.yml`、拓扑排序、按插件解析分层配置、
 * 逐个挂载，并把每个插件的挂载结果记录成界面可见的状态。两个关键行为直接来自 cordis：
 *
 * 1. 依赖缺失时 cordis 把该 fiber 留在 PENDING 而**不是**抛错，且 `await` 会立刻返回，
 *    所以这里必须读 `fiber.state`，不能只靠 try/catch（spec 1.3-09）。
 * 2. 单个插件构造器/回调抛错只会让它自己 FAILED，兄弟插件不受影响（spec 1.3-10）。
 */
import { resolveConfig, type ConfigService } from '@auto-cc/plugin-config';
import { fiberState, Service, type Context, type Fiber, type PluginState } from '@auto-cc/core';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { parseManifest, selectEnabled, type ManifestEntry } from './manifest.js';

/**
 * 内核对插件实现类的要求：实现 + 配置 schema + 可选 env 白名单。
 *
 * 第二个参数只能是 `any`：内核递给插件的是四层合并并经 `Config` 校验后的
 * `Record<string, unknown>`（编译期不知道具体形状），而各插件构造器声明的是自己的
 * schema 输出类型；写成具体类型会因参数逆变让整个 `Registry` 都不再兼容。
 * 运行期的形状由 `Config` 校验兜底，非法字段在挂载期就变 FAILED。
 */
export interface PluginConstructor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new (ctx: Context, config: any): unknown;
  Config: StandardSchemaV1<unknown, unknown>;
  envMap?: Record<string, string>;
}

/** id → 实现。清单只写 id，实现由这里给（主进程是 esbuild 单文件，无法按路径动态 import）。 */
export type Registry = Record<string, PluginConstructor>;

export interface PluginNode {
  id: string;
  state: PluginState;
  dependsOn: string[];
  /** 生效配置的键名（只列键，不列值，避免把目录之类的实际内容推到界面） */
  keys: string[];
  error?: string;
}

export const kernelSchema = z.strictObject({
  manifest: z.string().min(1).default('cordis.yml'),
  /** 清单所在目录：开发态是仓库根，打包态是 resources 目录。 */
  rootDir: z.string().min(1).optional(),
  /** 各插件的运行时覆盖层（spec 1.3-02 第 4 层），主进程用 `app.getPath()` 结果填目录。 */
  runtime: z.record(z.string(), z.unknown()).default({}),
  registry: z.unknown().default({}),
});

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 校验后的内核配置形状；主进程与单测按它给 `ctx.plugin(KernelService, ...)`。 */
export type KernelConfig = z.infer<typeof kernelSchema>;

export class KernelService extends Service {
  static provide = 'kernel';
  static Config = kernelSchema;

  /** cordis 把 `static Config` 校验后的配置作为构造器第二个实参传入，类型也从这里推导出调用点。 */
  private readonly options: KernelConfig;
  private readonly nodes = new Map<string, PluginNode>();
  private readonly fibers = new Map<string, Fiber>();
  private readonly idByUid = new Map<number, string>();
  private entries: ManifestEntry[] = [];

  /** 清单本身解析失败时挂在这里，界面用横幅显示（此时插件树可能是空的）。 */
  manifestError: string | undefined;

  constructor(ctx: Context, options: KernelConfig) {
    super(ctx, 'kernel');
    this.options = options;
  }

  /** 界面插件树与 1.6 自测通道读这份快照。 */
  snapshot(): PluginNode[] {
    return [...this.nodes.values()];
  }

  /**
   * IPC 网关入口（spec 1.4-07）：装配树直接由内核给出。
   * 1.3 时它挂在 `shell.getPluginTree` 上，那是网关尚未存在的过渡形态。
   */
  tree = (): { nodes: PluginNode[]; manifestError?: string } => ({
    nodes: this.snapshot(),
    manifestError: this.manifestError,
  });

  get manifestPath(): string {
    const name = this.options.manifest;
    if (isAbsolute(name)) return name;
    return resolve(this.options.rootDir ?? process.cwd(), name);
  }

  /** 重新读清单并装配；改完 cordis.yml 不必重启进程也能生效。 */
  async reload(): Promise<void> {
    const current = [...this.fibers.values()];
    this.fibers.clear();
    this.nodes.clear();
    this.idByUid.clear();
    await Promise.allSettled(current.map((fiber) => fiber.dispose()));
    await this.assemble();
  }

  /**
   * 重试一个 FAILED 插件。cordis 的 `restart()` 不会清 `_error`，只有 `update(config)` 会，
   * 所以修好配置之后必须走 update 这条路。
   */
  retry(id: string): PluginNode | undefined {
    const fiber = this.fibers.get(id);
    const entry = this.entries.find((item) => item.id === id);
    if (!fiber || !entry) return;
    const impl = (this.options.registry as Registry)[id];
    if (!impl) return;
    // `update()` 返回 `Awaitable<void>`：重启失败要落进快照，而不是变成未处理的拒绝。
    void Promise.resolve(fiber.update(this.configuration(entry, impl))).catch((error: unknown) => {
      this.record(entry, 'failed', messageOf(error));
    });
    return this.nodes.get(id);
  }

  async [Service.init](): Promise<void> {
    // cordis 在每次状态迁移上发 `internal/status`，快照因此能跟着依赖出现/消失实时变化。
    const off = this.ctx.on('internal/status', (fiber) => {
      const id = fiber.uid === null ? undefined : this.idByUid.get(fiber.uid);
      const node = id ? this.nodes.get(id) : undefined;
      if (node) node.state = fiberState(fiber.state);
    });
    this.ctx.effect(() => off, 'kernel.status');
    await this.assemble();
  }

  /** 读清单 → 逐插件解析配置 → 逐个挂载；任何一步的失败都只影响该插件。 */
  private async assemble(): Promise<void> {
    const registry = this.options.registry as Registry;
    try {
      this.entries = selectEnabled(parseManifest(readFileSync(this.manifestPath, 'utf8')));
      this.manifestError = undefined;
    } catch (error) {
      this.entries = [];
      this.manifestError = messageOf(error);
      this.ctx.logger.error(this.manifestError);
      return;
    }

    // `config` 服务可能尚未挂上（清单里注掉了它），此时退回纯函数分层解析。
    const config = this.ctx.get('config') as ConfigService | undefined;
    for (const entry of this.entries) config?.setFile(entry.id, entry.config);
    for (const [id, patch] of Object.entries(this.options.runtime)) config?.setRuntime(id, patch);

    for (const entry of this.entries) {
      const impl = registry[entry.id];
      if (!impl) {
        // 清单里有、注册表里没有：装配层面的错误，不阻塞其它插件。
        this.record(entry, 'failed', `注册表中没有插件实现：${entry.id}`);
        continue;
      }
      let value: Record<string, unknown>;
      try {
        value = this.configuration(entry, impl, config);
      } catch (error) {
        this.record(entry, 'failed', messageOf(error));
        continue;
      }
      await this.attach(entry, impl, value);
    }
  }

  /** 挂载一个插件并把它落定的状态写进快照。 */
  private async attach(entry: ManifestEntry, impl: PluginConstructor, value: Record<string, unknown>): Promise<void> {
    const fiber = this.ctx.plugin(impl, value);
    this.fibers.set(entry.id, fiber);
    // 只有根 fiber 的 uid 是 null，挂载出来的插件一定有数字 uid；映射不上就跳过状态回调。
    if (fiber.uid !== null) this.idByUid.set(fiber.uid, entry.id);
    let error: string | undefined;
    try {
      await fiber;
    } catch (reason) {
      error = messageOf(reason);
    }
    // await 对 PENDING 是立刻返回的（依赖没齐），所以状态一律以 fiber.state 为准。
    this.record(entry, fiberState(fiber.state), error, Object.keys(value));
  }

  /** 分层配置：有 `config` 服务就用它（四层齐全），否则用纯函数解析文件层 + 运行时层。 */
  private configuration(
    entry: ManifestEntry,
    impl: PluginConstructor,
    config?: ConfigService,
  ): Record<string, unknown> {
    // `impl.Config` 的输出类型是擦除的（每个插件形状不同），内核只按「普通对象」解析，
    // 具体形状由各插件构造器的第二个参数负责收窄。
    const schema = impl.Config as unknown as StandardSchemaV1<unknown, Record<string, unknown>>;
    const request = { schema, envMap: impl.envMap };
    if (config) return config.resolve(entry.id, request);
    return resolveConfig(entry.id, { ...request, file: entry.config, runtime: this.options.runtime[entry.id] });
  }

  private record(
    entry: ManifestEntry,
    state: PluginState,
    error?: string,
    keys: string[] = Object.keys(entry.config),
  ): void {
    this.nodes.set(entry.id, { id: entry.id, state, dependsOn: entry.dependsOn, keys, error });
    const line = `插件 ${entry.id} → ${state}${error ? `（${error}）` : ''}`;
    if (error) this.ctx.logger.warn(line);
    else this.ctx.logger.info(line);
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    kernel: KernelService;
  }
}
