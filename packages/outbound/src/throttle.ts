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
 *
 * 5.7-08 起本服务多了一个**只读**问法（`checkGap`）：调度器要在起跑前问一句「这个计划点起跑会不会被频控按住」。
 * 「不记账」这条性质没变——它只是把账本里已有的最近一次外发时刻读出来做一次减法（减法本身仍只在
 * `gapRemainingMs` 里写一遍，§2.2），既不新建表也不在内存里存「上次什么时候发的」（§2.7）。
 */
import { AppError, maybeService, Service, type Context } from '@auto-cc/core';
import { z } from 'zod';
import { gapRemainingMs } from './deliver-timing.js';

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

/**
 * 受外发间隔约束的动作 → 给人看的动作名。
 *
 * 名单就是这一处，而不是从契约包 import `QuotaAction`：本包的 `search` 走的是页面动作那一档间隔
 * （`nextScrollGapMs`），把三条额度动作混进同一张表会让「搜索也要隔 45s」变成假话。
 * 拒因里要说的是「打招呼」而不是 `greet`——这行字最终出现在定时任务的触发记录里，给人读。
 */
const GAP_ACTION_LABELS: Record<string, string> = { greet: '打招呼', deliver: '投递' };

/**
 * 一次频控预检的读数（spec 5.7-08）。
 * @property allowed 此刻起跑会不会立刻被频控按住；`true` 只说明**不会必然等待**，不承诺节点侧零等待
 * @property remainingMs 按区间下界算还要等多久（毫秒），放行时为 0
 * @property reason 拒因原文（给人读，界面与触发记录直接显示它，不做二次翻译）
 */
export type OutboundGapDecision = { allowed: boolean; remainingMs: number; reason: string | null };

/**
 * 频控预检向账本要的那一只手（本包不 import 账本类，用的时候按名字现问，§2.7 与 §9 的 2.5 实测条）。
 * @property latestActionTs 某动作最近一次落账的时刻（毫秒），从未落账时为 null
 */
interface GapClockSource {
  latestActionTs(action: string): number | null;
}

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

  /**
   * 只读预检：这个动作此刻动手会不会被频控按住（spec 5.7-08 给调度器的那一句问话）。
   *
   * 判据取**区间下界**而不是上界，这是有意的：上一次抽到的间隔是几毫秒没人记得（本服务不存状态），
   * 所以只有「连下界都还没过」才是**必然还要等**的确证。用下界可能放过一次仍需在节点里干等一会的起跑
   * （那是 `outbound.greet` / `outbound.deliver` 自己的 `sleep`，行为早已验收），
   * 用上界则会把本可以起跑的任务跳掉——**宁可少跳，不可误跳**。
   * @param action 外发动作名，只认 `greet` / `deliver`（见 `GAP_ACTION_LABELS`）
   * @param context 判定上下文；`nowMs` 为基准毫秒（省略取当前时间），调度侧一律带注入的时钟进来
   * @returns 读数见 `OutboundGapDecision`；账本未挂载时视为「从来没发过」而放行——真正的间隔仍在节点侧执行，
   *          预检放行不等于免频控，预检失败也不能让调度器自己编一个间隔
   * @throws 动作名不在名单内时以 `INVALID_ARGUMENT` 失败，不静默放行：那会让将来往调度名单里加一条动作时，
   *         频控预检在没人注意的情况下变成摆设（同 `entitlement.gate` 拒绝陌生动作名的口径）
   */
  checkGap = (action: string, context: { nowMs?: number } = {}): OutboundGapDecision => {
    const label = GAP_ACTION_LABELS[action];
    if (!label) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `频控预检不认识的动作「${String(action)}」，受外发间隔约束的动作只有 ${Object.keys(GAP_ACTION_LABELS).join(' / ')}`,
        'outbound.throttle',
        { action },
      );
    }
    const nowMs = context.nowMs ?? Date.now();
    const ledger = maybeService<GapClockSource>(this.ctx, 'usage.ledger');
    const remainingMs = gapRemainingMs(ledger?.latestActionTs(action) ?? null, this.options.minGapMs, nowMs);
    if (remainingMs <= 0) return { allowed: true, remainingMs: 0, reason: null };
    return {
      allowed: false,
      remainingMs,
      reason:
        `离上一次${label}还差 ${String(Math.ceil(remainingMs / 1000))} 秒` +
        `（外发间隔 ${(this.options.minGapMs / 1000).toFixed(1)}s – ${(this.options.maxGapMs / 1000).toFixed(1)}s 的下界还没过），` +
        '按频控此刻不动手',
    };
  };

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
