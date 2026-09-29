/**
 * `kernel` 服务（spec 1.3-01 / 1.3-09 / 1.3-10 / 1.5-01…1.5-08）。
 *
 * 它是「清单 → 真实插件树」的唯一通道：读 `cordis.yml`、拓扑排序、按插件解析分层配置、
 * 逐个挂载，并把每个插件的挂载结果记录成界面可见的状态。两个关键行为直接来自 cordis：
 *
 * 1. 依赖缺失时 cordis 把该 fiber 留在 PENDING 而**不是**抛错，且 `await` 会立刻返回，
 *    所以这里必须读 `fiber.state`，不能只靠 try/catch（spec 1.3-09）。
 * 2. 单个插件构造器/回调抛错只会让它自己 FAILED，兄弟插件不受影响（spec 1.3-10）。
 *
 * 1.5 起它还是 fiber 的**机制层**：卸载（`stop`）、重新挂载（`start`）、配置热更新
 * （`applyConfig`）、以及泄漏指标（`metrics`）。策略不在这里——「谁能被停、错误怎么攒」
 * 归 `plugins` 服务，本文件只保证 cordis 的语义被正确使用：
 *
 * 3. DISPOSED 的 fiber 不能复活：`restart()` / `update()` 都会在上面创建 effect 时抛
 *    `INACTIVE_EFFECT`。所以「重新启动」一律是新建一次 `ctx.plugin`，得到的是**新 fiber**，
 *    cordis 随后自动把依赖它的插件重建为 ACTIVE（spec 1.5-03 / 1.5-04）。
 */
import { resolveConfig, type ConfigService } from '@auto-cc/plugin-config';
import { fiberState, Service, type Context, type EffectMeta, type Fiber, type PluginState } from '@auto-cc/core';
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
  /**
   * 失败时的完整调用栈（spec 1.5-07）。
   * 只跟着快照走，不进日志文本——日志里的 message 给人读，栈给面板展开给人看。
   */
  stack?: string;
}

/** 单个在跑插件的 effect 数量（spec 1.5-02 的「清理是否执行」就数这个）。 */
export interface PluginEffectCount {
  id: string;
  effects: number;
}

/**
 * 运行时指标（spec 1.5-01 / 1.5-08）。
 *
 * `registrySize` 是泄漏判据：实测一个插件 dispose 后它会回到基线；
 * `registryCounter` 是单调递增的挂载序号，**不能**用来判泄漏，只用于展示「挂过多少次」。
 */
export interface KernelMetrics {
  registrySize: number;
  registryCounter: number;
  effectTotal: number;
  effects: PluginEffectCount[];
}

/** 面板保存配置时的回显：生效值 + 该 id 是否有在跑的 fiber（决定要不要立刻 update）。 */
export interface EffectiveConfig {
  id: string;
  values: Record<string, unknown>;
  mounted: boolean;
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

function stackOf(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

/** 配置层可能来自清单、运行时入参、或面板写入的 JSON——非对象一律当空层看待。 */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * 数一个 fiber 上登记的 effect 条数。
 *
 * cordis 的 `getEffects()` 返回的是树（effect 可以嵌套），泄漏判据要数全部节点，所以递归。
 * 卸载后实测为空数组——这就是 spec 1.5-02「清理被执行」的可量化证据。
 */
function countEffects(meta: readonly EffectMeta[]): number {
  return meta.reduce((total, item) => total + 1 + countEffects(item.children), 0);
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
  /**
   * 运行时覆盖层（spec 1.3-02 第 4 层）的内核副本。
   *
   * 为什么要自己留一份：`config` 服务也是可卸载的插件，一旦被 stop/start（或被依赖它的
   * 插件重启），它内部那张表就没了；面板保存的配置不能因为重启而悄悄失效。所以真相存在
   * 内核里，每次解析配置前重放一遍（`seedConfig`）。
   */
  private readonly runtimePatches = new Map<string, Record<string, unknown>>();
  private entries: ManifestEntry[] = [];

  /** 清单本身解析失败时挂在这里，界面用横幅显示（此时插件树可能是空的）。 */
  manifestError: string | undefined;

  constructor(ctx: Context, options: KernelConfig) {
    super(ctx, 'kernel');
    this.options = options;
    for (const [id, patch] of Object.entries(options.runtime)) {
      this.runtimePatches.set(id, asRecord(patch));
    }
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
   * 卸载一个插件（spec 1.5-02）。
   *
   * `dispose()` 会回收该 fiber 的全部 effect，并让依赖它的插件自动降级为 PENDING（spec 1.5-04）。
   * 清单条目与快照都保留，所以之后还能 `start` 回来；被摘掉的 fiber 记录也一并留着，
   * 因为「卸载后重新挂载」拿到的是新 fiber，旧的那条已经不可复活，留着只会误导。
   */
  async stop(id: string): Promise<PluginNode> {
    const fiber = this.fibers.get(id);
    const node = this.nodes.get(id);
    if (!fiber || !node) throw new Error(`该插件没有已挂载的实例：${id}`);
    const before = countEffects(fiber.getEffects());
    await fiber.dispose();
    this.fibers.delete(id);
    // cordis 的状态回调不是同步必定先到的，界面不能赌；这里直接落 DISPOSED，回调到了也只是重复赋值。
    node.state = 'disposed';
    node.error = undefined;
    node.stack = undefined;
    this.ctx.logger.info(
      `插件 ${id} 已卸载：回收 ${String(before)} 项 effect，剩余 ${String(countEffects(fiber.getEffects()))} 项`,
    );
    return node;
  }

  /**
   * 确保一个插件处于挂载状态（spec 1.5-03 / 1.5-05）。
   *
   * DISPOSED 的 fiber 是死的：在它上面 `restart()` / `update()` 都会在创建 effect 时抛
   * `INACTIVE_EFFECT`（读 cordis 源码 + 实测一致）。所以「重新启动」一律是再挂一次
   * `ctx.plugin`，得到的是**新 fiber**；依赖它的插件会由 cordis 自动重建（spec 1.5-04）。
   * PENDING 的插件不在这里强推——它缺的是依赖，不是挂载。
   */
  async start(id: string): Promise<PluginNode> {
    const entry = this.entryOf(id);
    const current = this.fibers.get(id);
    if (current) {
      const state = fiberState(current.state);
      if (state === 'active' || state === 'loading' || state === 'pending') {
        return this.requireNode(entry, state);
      }
      try {
        await current.dispose();
      } catch (error) {
        // 失败的 fiber 可能连回收都不干净；目标是让它从 registry 里退出，错误只记日志。
        this.ctx.logger.warn(`卸载旧实例 ${id} 时出错：${messageOf(error)}`);
      }
      this.fibers.delete(id);
    }
    return this.attach(entry, this.implOf(id), this.configuration(entry, this.implOf(id)));
  }

  /**
   * 保存面板改过的配置并立刻生效（spec 1.5-06，不重启 app）。
   *
   * 写运行时层 → 重放给 `config` → 重新解析 → 对在跑的 fiber 走 `update()`。选 `update`
   * 而不是 `restart` 有两个理由：它是 cordis 里唯一会清 `_error` 的重启方式（改完配置顺手
   * 重试失败插件就靠这个），并且它会把新配置**存进 fiber**，之后依赖变化引发的自动重建
   * 用的也是新值而不是挂载时的旧值。
   * 未挂载的插件只存配置，等 `start` 时生效——`update()` 在 DISPOSED fiber 上会抛。
   */
  async applyConfig(id: string, patch: Record<string, unknown>): Promise<PluginNode> {
    const entry = this.entryOf(id);
    const impl = this.implOf(id);
    // 先按「现有运行时层 + 本次补丁」预校验一次：面板送来的是任意 JSON，写坏的键不该被
    // 存进运行时层，否则之后每一次解析都会跟着失败，界面再也修不回来。
    this.validateCandidate(entry, impl, patch);
    this.patchRuntime(id, patch);
    const value = this.configuration(entry, impl);
    const fiber = this.fibers.get(id);
    if (!fiber) return this.requireNode(entry, 'pending', Object.keys(value));
    try {
      await Promise.resolve(fiber.update(value));
    } catch (error) {
      this.record(entry, 'failed', error, Object.keys(value));
    }
    return this.requireNode(entry, undefined, Object.keys(value));
  }

  /** 面板读取当前生效配置（spec 1.5-06）；未挂载的插件也能读，反映的是「下次挂载会拿到什么」。 */
  effectiveConfig(id: string): EffectiveConfig {
    const entry = this.entryOf(id);
    return { id, values: this.configuration(entry, this.implOf(id)), mounted: this.fibers.has(id) };
  }

  /** 运行时指标（spec 1.5-01 / 1.5-08）：`registrySize` 是泄漏判据，`registryCounter` 只是挂载序号。 */
  metrics(): KernelMetrics {
    const effects = [...this.fibers.entries()].map(([id, fiber]) => ({
      id,
      effects: countEffects(fiber.getEffects()),
    }));
    return {
      registrySize: this.ctx.registry.size,
      registryCounter: this.ctx.registry.counter,
      effectTotal: effects.reduce((total, item) => total + item.effects, 0),
      effects,
    };
  }

  async [Service.init](): Promise<void> {
    // cordis 在每次状态迁移上发 `internal/status`，快照因此能跟着依赖出现/消失实时变化。
    const off = this.ctx.on('internal/status', (fiber) => {
      const id = fiber.uid === null ? undefined : this.idByUid.get(fiber.uid);
      const node = id ? this.nodes.get(id) : undefined;
      if (!node) return;
      const state = fiberState(fiber.state);
      node.state = state;
      if (state === 'active') {
        // 修好配置后 fiber 会自己重跑，此时快照里还挂着上一次的 message，界面就会显示
        // 一个「已就绪但在报错」的插件。历史留在 `plugin/error` 事件里，当前状态不再背它。
        node.error = undefined;
        node.stack = undefined;
      }
    });
    this.ctx.effect(() => off, 'kernel.status');
    await this.assemble();
  }

  /** 读清单 → 逐插件解析配置 → 逐个挂载；任何一步的失败都只影响该插件。 */
  private async assemble(): Promise<void> {
    try {
      this.entries = selectEnabled(parseManifest(readFileSync(this.manifestPath, 'utf8')));
      this.manifestError = undefined;
    } catch (error) {
      this.entries = [];
      this.manifestError = messageOf(error);
      this.ctx.logger.error(this.manifestError);
      return;
    }

    // 不在这里灌配置层：`config` 自己也是清单里的插件，装配开始时它还不存在（见 `configuration`）。
    for (const entry of this.entries) {
      const impl = this.registry()[entry.id];
      if (!impl) {
        // 清单里有、注册表里没有：装配层面的错误，不阻塞其它插件。
        this.record(entry, 'failed', new Error(`注册表中没有插件实现：${entry.id}`));
        continue;
      }
      let value: Record<string, unknown>;
      try {
        value = this.configuration(entry, impl);
      } catch (error) {
        this.record(entry, 'failed', error);
        continue;
      }
      await this.attach(entry, impl, value);
    }
  }

  /** 挂载一个插件并把它落定的状态写进快照。 */
  private async attach(
    entry: ManifestEntry,
    impl: PluginConstructor,
    value: Record<string, unknown>,
  ): Promise<PluginNode> {
    const fiber = this.ctx.plugin(impl, value);
    this.fibers.set(entry.id, fiber);
    // 只有根 fiber 的 uid 是 null，挂载出来的插件一定有数字 uid；映射不上就跳过状态回调。
    if (fiber.uid !== null) this.idByUid.set(fiber.uid, entry.id);
    let cause: unknown;
    try {
      await fiber;
    } catch (reason) {
      cause = reason;
    }
    // await 对 PENDING 是立刻返回的（依赖没齐），所以状态一律以 fiber.state 为准。
    return this.record(entry, fiberState(fiber.state), cause, Object.keys(value));
  }

  /** 分层配置：有 `config` 服务就用它（四层齐全），否则用纯函数解析文件层 + 运行时层。 */
  private configuration(entry: ManifestEntry, impl: PluginConstructor): Record<string, unknown> {
    // `impl.Config` 的输出类型是擦除的（每个插件形状不同），内核只按「普通对象」解析，
    // 具体形状由各插件构造器的第二个参数负责收窄。
    const request = { schema: this.schemaOf(impl), envMap: impl.envMap };
    // `config` 服务可能尚未挂上（清单里注掉了它，或它正被调试面板停着），此时退回纯函数分层解析。
    const config = this.ctx.get('config') as ConfigService | undefined;
    if (!config)
      return resolveConfig(entry.id, { ...request, file: entry.config, runtime: this.runtimePatches.get(entry.id) });
    // 解析前重放镜像：`config` 是在装配循环里逐个挂上的，早于它的重放点都会落空，
    // 而它自己也可被 stop/start（表就空了）。内核这两张表才是真相，缺了就永远只拿到 schema 默认值。
    this.seedConfig(config);
    return config.resolve(entry.id, request);
  }

  /**
   * 预校验一次「补丁之后会变成什么」，不写任何层。
   *
   * 面板送来的补丁是任意 JSON：非法字段必须先挡在写入之前。否则坏键进了运行时层，
   * 之后每次 `configuration()` 都会失败，而失败又是写层之后发生的——界面就再也修不回来了。
   */
  private validateCandidate(entry: ManifestEntry, impl: PluginConstructor, patch: Record<string, unknown>): void {
    resolveConfig(entry.id, {
      schema: this.schemaOf(impl),
      envMap: impl.envMap,
      file: entry.config,
      runtime: { ...this.runtimePatches.get(entry.id), ...patch },
    });
  }

  private schemaOf(impl: PluginConstructor): StandardSchemaV1<unknown, Record<string, unknown>> {
    return impl.Config as unknown as StandardSchemaV1<unknown, Record<string, unknown>>;
  }

  private record(
    entry: ManifestEntry,
    state: PluginState,
    cause?: unknown,
    keys: string[] = Object.keys(entry.config),
  ): PluginNode {
    const error = cause === undefined ? undefined : messageOf(cause);
    const node: PluginNode = {
      id: entry.id,
      state,
      dependsOn: entry.dependsOn,
      keys,
      error,
      stack: stackOf(cause),
    };
    this.nodes.set(entry.id, node);
    const line = `插件 ${entry.id} → ${state}${error ? `（${error}）` : ''}`;
    if (error) {
      // 日志只带 message（栈信息进日志会把可读性毁掉），完整栈走 `plugin/error` 事件给面板（spec 1.5-07）。
      this.ctx.logger.warn(line);
      this.ctx.emit('plugin/error', { id: entry.id, message: error, stack: node.stack, at: Date.now() });
    } else {
      this.ctx.logger.info(line);
    }
    return node;
  }

  /** id → 实现；注册表漏项在这里点名，而不是让 `ctx.plugin` 拿到 undefined 再炸。 */
  private implOf(id: string): PluginConstructor {
    const impl = this.registry()[id];
    if (!impl) throw new Error(`注册表中没有插件实现：${id}`);
    return impl;
  }

  private registry(): Registry {
    return this.options.registry as Registry;
  }

  private entryOf(id: string): ManifestEntry {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) throw new Error(`清单里没有该插件：${id}`);
    return entry;
  }

  /** 快照里必须已有该插件的记录（挂载/卸载路径都会先 `record`），缺记录说明内核状态被写坏了。 */
  private requireNode(entry: ManifestEntry, state?: PluginState, keys?: string[]): PluginNode {
    const existing = this.nodes.get(entry.id);
    if (existing) {
      if (state) existing.state = state;
      if (keys) existing.keys = keys;
      return existing;
    }
    return this.record(entry, state ?? 'pending', undefined, keys);
  }

  private patchRuntime(id: string, patch: Record<string, unknown>): void {
    // 面板按字段保存，顶层键后写赢就够；深合并由 `config` 服务那层负责。
    this.runtimePatches.set(id, { ...this.runtimePatches.get(id), ...patch });
  }

  /** 把内核这两张表（清单文件层 + 运行时层）重放进 `config` 服务，幂等，所以每次解析前都灌。 */
  private seedConfig(config: ConfigService): void {
    for (const entry of this.entries) config.setFile(entry.id, entry.config);
    for (const [id, patch] of this.runtimePatches) config.setRuntime(id, patch);
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    kernel: KernelService;
  }
}
