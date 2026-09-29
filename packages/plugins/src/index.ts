/**
 * `plugins` 服务（spec 1.5-01 … 1.5-08）：插件运行时的**策略层**。
 *
 * 分工是刻意的：`kernel` 只管 fiber 机制（挂载、卸载、分层配置、指标），本服务决定
 * 「谁能被停、错误怎么攒、界面能调什么」。把这两层分开有两个理由：
 *
 * 1. 「停掉一个插件」是危险操作，需要一个明确的闸门（`guarded`），而闸门是策略，
 *    不该长在负责装配的内核里。
 * 2. 界面要的能力是聚合视图（指标 + 错误历史 + 受保护清单），内核只该回答它自己知道的事。
 *
 * 依赖声明只写 `kernel`，**不依赖 `config`**：spec 1.5-04 要求演示「停掉提供方 → 依赖方
 * 降级为 PENDING」，而 `config` 正是被停的最佳对象。如果本服务依赖它，它自己也会变成
 * PENDING，`plugins.start('config')` 这条路就跟着消失了——调试器不能和被调试的进程同生共死。
 */
import { AppError, asApp, Service, type Context, type PluginErrorView } from '@auto-cc/core';
import type { EffectiveConfig, KernelMetrics, PluginNode } from '@auto-cc/plugin-kernel';
import { z } from 'zod';

/** 与内核指标合并后对外暴露的运行时指标（spec 1.5-08 的泄漏判据）。 */
export interface PluginMetrics extends KernelMetrics {
  /** Node 当前持有的活动资源（句柄/定时器/写流）条数，effect 泄漏会体现在这里。 */
  activeResources: number;
}

/** 面板一次性读到的视图：树之外还需要「能不能动手」与「出过什么错」。 */
export interface PluginStatus {
  metrics: PluginMetrics;
  /** 不允许从界面卸载的插件 id（本服务、内核、网关）。 */
  guarded: string[];
  errorCount: number;
  /** 最近错误，新的在前。 */
  errors: PluginErrorView[];
}

/** 反复启停后的对照结果（spec 1.5-08）：三个漂移都为 0 才算没泄漏。 */
export interface PluginCycleReport {
  id: string;
  rounds: number;
  before: PluginMetrics;
  after: PluginMetrics;
  sizeDrift: number;
  effectDrift: number;
  resourceDrift: number;
}

export const pluginsSchema = z.strictObject({
  /**
   * 卸载闸（spec 1.5-02）。
   *
   * 三个默认值各有各的原因：停 `ipc` 会把正在服务这次调用的网关摘掉，停 `kernel` 没人重新
   * 装配，停 `plugins` 自己则连「再点一次启动」的按钮都失效了。
   */
  guarded: z.array(z.string().min(1)).default(['kernel', 'ipc', 'plugins']),
  /** 错误历史保留条数（spec 1.5-07），超出的最旧记录被丢弃。 */
  history: z.number().int().positive().max(200).default(20),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type PluginsConfig = z.infer<typeof pluginsSchema>;

/** 巡检收尾前的 settle 窗口，留给事件循环里正在落地的句柄。 */
const SETTLE_MS = 300;

export class PluginsService extends Service {
  static provide = 'plugins';
  static Config = pluginsSchema;
  static inject = ['kernel'];

  /** cordis 把 `static Config` 校验后的配置作为构造器第二个实参传入，类型也从这里推导出调用点。 */
  private readonly options: PluginsConfig;
  private readonly errors: PluginErrorView[] = [];

  constructor(ctx: Context, options: PluginsConfig) {
    super(ctx, 'plugins');
    this.options = options;
  }

  private get kernel() {
    return asApp(this.ctx).kernel;
  }

  /**
   * 面板的一次性快照（spec 1.5-01 / 1.5-07）：指标 + 闸门 + 错误历史。
   * 树本身仍由 `kernel.tree` 提供，这里不复制第二份真相。
   */
  status = (): PluginStatus => ({
    metrics: this.metrics(),
    guarded: this.options.guarded,
    errorCount: this.errors.length,
    errors: [...this.errors].reverse(),
  });

  /** 卸载一个插件（spec 1.5-02）。 */
  stop = async (id: string): Promise<PluginNode> => {
    this.assertStoppable(id, 'plugins.stop');
    return await this.kernel.stop(id);
  };

  /** 重新挂载（spec 1.5-03）。启动不设闸门：把一个受保护插件重新挂上永远是安全的。 */
  start = async (id: string): Promise<PluginNode> => await this.kernel.start(id);

  /** 读取某插件当前生效的配置（spec 1.5-06）。 */
  readConfig = (id: string): EffectiveConfig => this.kernel.effectiveConfig(id);

  /**
   * 保存配置并立刻生效（spec 1.5-06）。
   *
   * `patch` 来自渲染层的任意 JSON，但本服务不自己判形状——内核会先用插件自己的 schema
   * 预校验，非法就抛字段级的 `CONFIG_INVALID`。界面因此能知道到底是哪个键写坏了。
   */
  saveConfig = async (id: string, patch: Record<string, unknown>): Promise<PluginNode> =>
    await this.kernel.applyConfig(id, patch);

  /**
   * 反复启停同一个插件（spec 1.5-08）。
   *
   * 泄漏检测做成面板上一个能点的动作，而不只活在单测里：基线与收尾各取一次指标，
   * 判据是 `registrySize` 与 `effectTotal` 都回到基线。
   * 收尾前留一个短暂 settle 窗口：最后一轮的 dispose/create 会在事件循环里留下一个还在
   * 落地的句柄（SQLite / 文件），立刻取样会把它读成「泄漏 +1」，而这个数其实几百毫秒后自己就归零。
   */
  cycle = async (id: string, rounds = 20): Promise<PluginCycleReport> => {
    this.assertStoppable(id, 'plugins.cycle');
    const count = Math.max(1, Math.min(200, Math.floor(rounds)));
    const before = this.metrics();
    for (let index = 0; index < count; index += 1) {
      await this.kernel.stop(id);
      await this.kernel.start(id);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));
    const after = this.metrics();
    return {
      id,
      rounds: count,
      before,
      after,
      sizeDrift: after.registrySize - before.registrySize,
      effectDrift: after.effectTotal - before.effectTotal,
      resourceDrift: after.activeResources - before.activeResources,
    };
  };

  [Service.init](): void {
    // 内核可能在本服务挂载之前就把某个插件标成 FAILED（清单里配置写错就是这种），
    // 那些记录错过了一次性事件，所以先从快照补一遍，再接后续事件。
    for (const node of this.kernel.snapshot()) {
      if (node.error) this.remember({ id: node.id, message: node.error, stack: node.stack, at: Date.now() });
    }
    const off = this.ctx.on('plugin/error', (error) => this.remember(error));
    this.ctx.effect(() => off, 'plugins.errors');
    this.ctx.logger.info(
      `插件管理就绪：受保护 ${this.options.guarded.join(' / ')}｜错误历史上限 ${String(this.options.history)} 条`,
    );
  }

  /** 累积错误历史；超出上限丢最旧的，保证面板列表长度有界（spec 1.5-07）。 */
  private remember(error: PluginErrorView): void {
    this.errors.push(error);
    if (this.errors.length > this.options.history) this.errors.splice(0, this.errors.length - this.options.history);
  }

  private metrics(): PluginMetrics {
    return { ...this.kernel.metrics(), activeResources: process.getActiveResourcesInfo().length };
  }

  /** 卸载闸（spec 1.5-02）：受保护的插件即使被界面直接调用也停不掉，错误里点名是哪个能力动的。 */
  private assertStoppable(id: string, path: string): void {
    if (this.options.guarded.includes(id)) {
      throw new AppError('PLUGIN_FAILED', `该插件受保护，不能从界面卸载：${id}`, path);
    }
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    plugins: PluginsService;
  }
}
