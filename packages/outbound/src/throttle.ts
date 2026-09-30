/**
 * `outbound.throttle` 服务（spec 2.5-04 / 2.5-05）：连续两次外发之间隔多久。
 *
 * 只回答「隔多久」这一个问题，既不持有计时器也不记账：
 * - 日上限属于额度域，已由 `entitlement.gate` 的 `mode:'daily'` 管（plan §12.3）——这里再造一份计数就是 §2.7 禁的第二套状态存储；
 * - 真正让出由调用方用 `@auto-cc/core` 的 `sleep` 做，本服务因此是纯函数，能在单测里被穷举而不拖慢测试。
 * 节奏必须不可预测：等间隔是机器行为，风控一眼就能挑出来（AGENTS.md §8.3），所以判据不是「够慢」而是「不像节拍器」。
 */
import { Service, type Context } from '@auto-cc/core';
import { z } from 'zod';

/**
 * 频控配置。区间而不是定值：定值本身就是可预测的节奏。
 *
 * `minGapMs <= maxGapMs` 是配置边界（`cordis.yml` 用户可改），交给 schema 在挂载前拒掉，
 * 而不是在取数时悄悄把区间翻转——那样界面会显示一个从没生效过的区间。
 */
export const throttleSchema = z
  .strictObject({
    minGapMs: z.number().int().min(0).default(45000),
    maxGapMs: z.number().int().min(0).default(150000),
  })
  .refine((gap) => gap.minGapMs <= gap.maxGapMs, {
    message: 'minGapMs 不能大于 maxGapMs',
    path: ['minGapMs'],
  });

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type OutboundThrottleConfig = z.infer<typeof throttleSchema>;

export class OutboundThrottleService extends Service {
  static provide = 'outbound.throttle';
  static Config = throttleSchema;

  private readonly options: OutboundThrottleConfig;

  constructor(ctx: Context, options: OutboundThrottleConfig) {
    // 必须接住第二个实参：cordis 递的是校验后的配置（AGENTS.md §9 实测 1.3）。
    super(ctx, 'outbound.throttle');
    this.options = options;
  }

  /**
   * 取下一次外发前应等待的时长。
   * @param rng 随机源，契约是返回 [0,1)（默认 `Math.random`）；单测传定值以断言精确落点
   * @returns 闭区间 [minGapMs, maxGapMs] 内的整数毫秒；区间退化成单点时恒等于该点，不抛异常
   */
  nextGapMs = (rng: () => number = Math.random): number => {
    const { minGapMs, maxGapMs } = this.options;
    // +1 让上界取得到：均匀整点抽样少了 1 毫秒就不是闭区间，判据会假绿。
    return minGapMs + Math.floor(rng() * (maxGapMs - minGapMs + 1));
  };

  [Service.init](): void {
    const { minGapMs, maxGapMs } = this.options;
    this.ctx.logger.info(
      `外发节流就绪：间隔在 ${(minGapMs / 1000).toFixed(1)}s – ${(maxGapMs / 1000).toFixed(1)}s 之间随机（非固定节奏）`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'outbound.throttle': OutboundThrottleService;
  }
}
