/**
 * `platform.registry` 服务（spec 2.2-06 / 2.2-07）：平台适配器的**唯一**登记处。
 *
 * 它存在的意义是把「内核 ↔ 站点」这条依赖方向钉死：`browser` 永远不 import 任何平台包，
 * 平台包在自己的 `[Service.init]` 里把自己 `register` 进来（装配层决定装谁，见 `cordis.yml`）。
 * 于是新增一个平台 = 新增一个包 + 装配清单加一行，`browser` 与 `workflow` 一行代码都不改。
 *
 * 只读面 `list()` 进渲染层白名单；`get()` 返回的是**活的适配器**，因此不对白名单开放——
 * 界面拿到对象就等于拿到主进程能力（AGENTS.md §8.2）。
 *
 * 另面对外发域露两件事：`GreetChannelSource`（spec 2.5-02）与 `ResumeChannelSource`（spec 2.6-01 / 02）。
 * 渠道的真相就是适配器，所以这里按名字现问现取，不再另存一张渠道表——那张表在适配器被重建时就成了过期读数。
 * 第三个口子是给风控观测层的 `riskPatternOf`（spec 2.7-01）：判据同样只存在适配器声明里，理由与上两句相同。
 */
import {
  AppError,
  Service,
  type Context,
  type GreetChannel,
  type GreetChannelSource,
  type ResumeChannelSource,
  type ResumeDeliveryChannel,
} from '@auto-cc/core';
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

export class PlatformRegistryService extends Service implements GreetChannelSource, ResumeChannelSource {
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

  /**
   * 按平台名要一个打招呼渠道（`GreetChannelSource` 的实现，spec 2.5-02）。
   *
   * 这里是**现问现取**而不是另存一张表：适配器是唯一真相，外发侧缓存一份就会在它被重建时读到空表。
   * @param platform 平台标识
   * @returns `adapter.chat` 的窄投影；没这个平台或它没声明 `chat` 能力时为 null（不抛——渠道缺失是外发侧的可处置失败）
   */
  greetChannel = (platform: string): GreetChannel | null => {
    const adapter = this.adapters.get(platform);
    if (!adapter?.meta.capabilities.includes('chat')) return null;
    return {
      send: async (target, text) => {
        // `ledgerKey` 在这里被有意丢掉：计量凭证由 `entitlement.gate` 落账时生成，适配器不算数。
        const outcome = await adapter.chat(target, text);
        return { sent: outcome.sent, reason: outcome.reason };
      },
    };
  };

  /**
   * 当前能打招呼的平台清单（供外发侧把「发不出去」说清楚）。
   * @returns 登记了适配器且声明 `chat` 能力的平台标识，按登记顺序；一个都没有时是空数组
   */
  greetablePlatforms = (): string[] =>
    [...this.adapters.values()]
      .filter((adapter) => adapter.meta.capabilities.includes('chat'))
      .map((adapter) => adapter.meta.id);

  /**
   * 按平台名要一个简历投递渠道（`ResumeChannelSource` 的实现，spec 2.6-01 / 02）。
   *
   * 与 `greetChannel` 同一手法：现问现取、只投影 `sendResume` 这一个方法，
   * 判据换成 `sendResume` 能力——装了会话页不等于装了上传页，两者可以一个有一个没有。
   * @param platform 平台标识
   * @returns 渠道的窄投影；没这个平台或它没声明 `sendResume` 能力时为 null（不抛——缺渠道是外发侧的可处置失败）
   */
  deliverChannel = (platform: string): ResumeDeliveryChannel | null => {
    const adapter = this.adapters.get(platform);
    if (!adapter?.meta.capabilities.includes('sendResume')) return null;
    return {
      send: async (target, attachment) => {
        // `ledgerKey` 同样被有意丢掉：计量凭证由 `entitlement.gate` 落账时生成，适配器不算数。
        // 两只坐标原样透传，编排层与这里都不做"会话对象算哪个岗位"的映射（裁定⑲ 的同一形状，plan §7 第 14 条）。
        const outcome = await adapter.sendResume(target, attachment);
        return { sent: outcome.sent, reason: outcome.reason };
      },
    };
  };

  /**
   * 当前能递简历的平台清单（供投递编排把「递不出去」说清楚）。
   * @returns 登记了适配器且声明 `sendResume` 能力的平台标识，按登记顺序；一个都没有时是空数组
   */
  deliverablePlatforms = (): string[] =>
    [...this.adapters.values()]
      .filter((adapter) => adapter.meta.capabilities.includes('sendResume'))
      .map((adapter) => adapter.meta.id);

  /**
   * 按平台名要它的风控页文字判据（`browser.risk` 用，spec 2.7-01）。
   *
   * 不抛而是回 null：知识包没有 `risk` 段是合法状态（那个平台只按 HTTP 状态判风控），
   * 观测层不该因为「这个站点的文案判据还没摸清」就整条链路失败。
   * @param platform 平台标识（来自会话分区归属，不是页面地址猜的）
   * @returns 正则源码；未登记或该平台未声明时为 null
   */
  riskPatternOf = (platform: string): string | null => this.adapters.get(platform)?.risk?.pattern ?? null;

  [Service.init](): void {
    this.ctx.logger.info('平台登记表就绪：当前为空，等待平台包登记');
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'platform.registry': PlatformRegistryService;
  }
}
