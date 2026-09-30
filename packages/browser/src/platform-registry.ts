/**
 * `platform.registry` 服务（spec 2.2-06 / 2.2-07）：平台适配器的**唯一**登记处。
 *
 * 它存在的意义是把「内核 ↔ 站点」这条依赖方向钉死：`browser` 永远不 import 任何平台包，
 * 平台包在自己的 `[Service.init]` 里把自己 `register` 进来（装配层决定装谁，见 `cordis.yml`）。
 * 于是新增一个平台 = 新增一个包 + 装配清单加一行，`browser` 与 `workflow` 一行代码都不改。
 *
 * 只读面 `list()` 进渲染层白名单；`get()` 返回的是**活的适配器实例**，因此不对白名单开放——
 * 界面拿到对象就等于拿到主进程能力（AGENTS.md §8.2）。
 */
import { AppError, Service, type Context } from '@auto-cc/core';
import type { PlatformMetaView, PlatformRegistryView } from '@auto-cc/shared';
import { z } from 'zod';
import type { PlatformAdapter } from './platform-contract.js';

/**
 * 登记处的配置：**没有可调项**，所以是空严格对象。
 *
 * 为什么还要声明一个 schema：内核的 `PluginConstructor` 要求 `Config`（清单里每一条都要能被
 * 「解析配置 → 挂载 → 启停」这条统一路径处理，spec 1.5 的装配面板就靠它）。写成空对象而不是
 * 省掉，等于在类型上承认「这里确实没参数」，装配面板上该项显示零键而不是报错。
 */
export const platformRegistrySchema = z.strictObject({});

export class PlatformRegistryService extends Service {
  static provide = 'platform.registry';
  static Config = platformRegistrySchema;

  private readonly adapters = new Map<string, PlatformAdapter>();

  constructor(ctx: Context) {
    super(ctx, 'platform.registry');
  }

  /**
   * 登记一个平台适配器（由平台包在挂载时调用，主进程内能力，不进渲染层白名单）。
   * @param adapter 实现完契约的适配器；`meta.id` 重复时后者替换前者
   * @returns 替换后的平台清单，调用方据此确认「我确实登记上了」
   */
  register = (adapter: PlatformAdapter): PlatformRegistryView => {
    if (this.adapters.has(adapter.meta.id)) {
      // 热重载平台包会走到这里：静默覆盖的话，界面上看不出跑的是哪一份实现。
      this.ctx.logger.warn(`平台适配器重复登记，已替换：${adapter.meta.id}`);
    }
    this.adapters.set(adapter.meta.id, adapter);
    this.ctx.logger.info(`平台适配器已登记：${adapter.meta.id}（能力 ${adapter.meta.capabilities.join(' / ')}）`);
    return this.list();
  };

  /**
   * 已登记平台的只读清单。
   * @returns 元信息数组，按登记顺序；不含任何选择器或页面数据
   */
  list = (): PlatformRegistryView => ({
    platforms: [...this.adapters.values()].map((adapter): PlatformMetaView => adapter.meta),
  });

  /**
   * 按平台名取回适配器实例。
   * @param platform 平台标识（`meta.id`）
   * @returns 活的适配器，供 `workflow` 在主进程内直接调用
   * @throws 未登记时 `PLATFORM_NOT_REGISTERED`，`details.known` 列出当前装着的平台，界面能直接说「只支持这些」
   */
  get = (platform: string): PlatformAdapter => {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new AppError('PLATFORM_NOT_REGISTERED', `未登记的平台适配器：${platform}`, 'platform.registry', {
        known: [...this.adapters.keys()],
      });
    }
    return adapter;
  };

  [Service.init](): void {
    this.ctx.logger.info('平台登记表就绪：当前为空，等待平台包登记');
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'platform.registry': PlatformRegistryService;
  }
}
