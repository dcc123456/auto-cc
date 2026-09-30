/**
 * `outbound.throttle` 服务（spec 2.5-04 / 2.5-05 / 2.7-04）：站点看到的操作节奏由这一处给。
 *
 * 只回答「隔多久」这一个问题，既不持有计时器也不记账：
 * - 日上限属于额度域，已由 `entitlement.gate` 的 `mode:'daily'` 管（plan §12.3）——这里再造一份计数就是 §2.7 禁的第二套状态存储；
 * - 真正让出由调用方用 `@auto-cc/core` 的 `sleep` 做，本服务因此是纯函数，能在单测里被穷举而不拖慢测试。
 * 节奏必须不可预测：等间隔是机器行为，风控一眼就能挑出来（AGENTS.md §8.3），所以判据不是「够慢」而是「不像节拍器」。
 *
 * 抓取（滚一轮、读一条详情）也算节奏：站在站点侧，「这个客户端多久动一次」不区分它是来发消息还是来看列表，
 * 所以 2.7-04 之后这里从一档区间变成两档区间，`jd.capture` 不再自己拿一个固定毫秒数睡觉（plan §14.3 第 4 条）。
 */
import { Service, type Context } from '@auto-cc/core';
import { z } from 'zod';

/**
 * 频控配置。区间而不是定值：定值本身就是可预测的节奏。
 *
 * 两组区间分别管「外发之间」和「页面动作之间（滚动 / 逐条读详情）」：量级差两个数量级，
 * 合成一组就会要么把抓取拖成分钟级、要么让打招呼像机器。
 * `min <= max` 是配置边界（`cordis.yml` 用户可改），交给 schema 在挂载前拒掉，
 * 而不是在取数时悄悄把区间翻转——那样界面会显示一个从没生效过的区间。
 */
export const throttleSchema = z
  .strictObject({
    minGapMs: z.number().int().min(0).default(45000),
    maxGapMs: z.number().int().min(0).default(150000),
    /** 抓取滚一轮之后的停顿下界（毫秒）；原来是 `jd.capture` 自己的定值 300，2.7-04 归位到这里。 */
    scrollMinGapMs: z.number().int().min(0).default(300),
    scrollMaxGapMs: z.number().int().min(0).default(900),
  })
  .refine((gap) => gap.minGapMs <= gap.maxGapMs, {
    message: 'minGapMs 不能大于 maxGapMs',
    path: ['minGapMs'],
  })
  .refine((gap) => gap.scrollMinGapMs <= gap.scrollMaxGapMs, {
    message: 'scrollMinGapMs 不能大于 scrollMaxGapMs',
    path: ['scrollMinGapMs'],
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
  nextGapMs = (rng: () => number = Math.random): number =>
    drawInclusive(this.options.minGapMs, this.options.maxGapMs, rng);

  /**
   * 取一次页面动作（滚动一轮、读完一条详情）后的停顿时长（spec 2.7-04）。
   * @param rng 随机源，同上
   * @returns 闭区间 [scrollMinGapMs, scrollMaxGapMs] 内的整数毫秒
   */
  nextScrollGapMs = (rng: () => number = Math.random): number =>
    drawInclusive(this.options.scrollMinGapMs, this.options.scrollMaxGapMs, rng);

  [Service.init](): void {
    const { minGapMs, maxGapMs, scrollMinGapMs, scrollMaxGapMs } = this.options;
    this.ctx.logger.info(
      `节奏节流就绪：外发间隔 ${(minGapMs / 1000).toFixed(1)}s – ${(maxGapMs / 1000).toFixed(1)}s · ` +
        `页面动作间隔 ${(scrollMinGapMs / 1000).toFixed(2)}s – ${(scrollMaxGapMs / 1000).toFixed(2)}s（均为区间随机，非固定节奏）`,
    );
  }
}

/**
 * 在闭区间里抽一个整数毫秒——两组区间共用这一条抽样，不各写一遍。
 * @param min 下界（毫秒）
 * @param max 上界（毫秒），schema 已保证 `min <= max`
 * @param rng 随机源，契约是返回 [0,1)
 * @returns [min, max] 内的整数；+1 让上界取得到，少了它「闭区间」的判据会假绿
 */
function drawInclusive(min: number, max: number, rng: () => number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

declare module '@auto-cc/core' {
  interface AppServices {
    'outbound.throttle': OutboundThrottleService;
  }
}
