/**
 * `entitlement.gate` 服务（spec 1.9-01 / 1.9-02 / 1.9-03 / 2.7-03）：所有外发与抓取动作的唯一必经口。
 *
 * 两个方法分工是刻意的：
 * - `check()` **只用于展示**（剩余额度、界面提示），它不产生任何副作用，也不代表许可；
 * - `perform()` 才是放行口 —— 判定、执行、落账三步在一个方法里完成，
 *   所以「调了 check 再自己发」这种绕过在结构上就写不出正确的代码（spec 1.9-05 的立足点）。
 *
 * 额度是**按动作**的（`search` / `greet` / `deliver` 各一条上限，2.7-03）：抓 40 轮不该吃掉打招呼的额度，
 * 反过来也不能因为「抓取只是读」就 entirely 游离在闸门之外——那是 2.3-11 的原判据，plan §14.4 第 1 条已更正。
 *
 * 当前实现是纯本地的：没有网络校验、没有登录、没有付费分支（`docs/00-master-plan.md` §1.5）。
 * P5 接 SaaS 时替换的是本文件里的判定，调用点一个都不用改。
 */
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import { QUOTA_ACTIONS, type GateDecisionView, type QuotaAction } from '@auto-cc/shared';
import { z } from 'zod';
import type { ActionContext } from './types.js';

/** 一次放行的结果：业务返回值 + 本次落账的账本行 id（spec 1.9-04 要能在回执里看到行）。 */
export type Performed<T> = { value: T; ledgerId: number };

/** 按动作的日额度表本体（三个键都必填：缺一条就等于那条动作没人管过）。 */
const dailyLimitsSchema = z.strictObject({
  /** 每个动作每天允许的条数（按本地自然日计）。`search` 的一条 = 一轮抓取 run，不是一条 JD。 */
  search: z.number().int().min(1).max(1000).default(40),
  greet: z.number().int().min(1).max(1000).default(20),
  deliver: z.number().int().min(1).max(1000).default(10),
});

/** 按动作的日额度表（配置面、装配清单、测试用例共用这一个形状）。 */
export type GateDailyLimits = z.infer<typeof dailyLimitsSchema>;

/**
 * 三条日额度的 shipped 默认（spec 2.7-03）。
 *
 * 抽成导出的常量是为了让**配置面与测试面读同一个数**：装配面板与用例要「只收紧一条」时
 * 必须从它展开，抄一份数字进用例就成了第二套真相。
 */
export const DEFAULT_DAILY_LIMITS: GateDailyLimits = { search: 40, greet: 20, deliver: 10 };

/**
 * 闸门配置（spec 1.9-02 / 2.7-03）：日上限从「每动作同一个数」变成**按动作各给一个数**。
 *
 * `search` 与另两键并列的理由：抓取纳进同一个闸门是唯一合规的落点（plan §14.4 第 1 条）——
 * 另建一套抓取计数会同时违反 AGENTS.md §2.7 与 2.6-08 已验收的「无第二套计数」。
 * 三者互不占用由 `countToday(action)` 天然保证，所以抓 20 轮不会吃掉打招呼的额度。
 */
export const gateSchema = z.strictObject({
  /** `unlimited` 是当前产品阶段的默认；`daily` 用来演示「每动作各自 N 次」超限即拒。 */
  mode: z.enum(['unlimited', 'daily']).default('unlimited'),
  dailyLimits: dailyLimitsSchema.default(DEFAULT_DAILY_LIMITS),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type GateConfig = z.infer<typeof gateSchema>;

export class EntitlementGateService extends Service {
  static provide = 'entitlement.gate';
  static Config = gateSchema;
  // 依赖写服务名而不是清单 id：cordis 的依赖是「这个名字的出现/消失」，
  // 摘掉 `usage` 之后本服务会连同 `outbound` 一起降级为 PENDING，外发入口随之消失（spec 1.9-05）。
  static inject = ['usage.ledger'];

  private readonly options: GateConfig;

  constructor(ctx: Context, options: GateConfig) {
    // 必须接住第二个实参：cordis 递的是校验后的配置，只声明一个参数会让调用点报 TS2345。
    super(ctx, 'entitlement.gate');
    this.options = options;
  }

  /**
   * 判定某动作现在能不能做、还剩几条。
   * @param action 额度动作名（`search` / `greet` / `deliver`）；渲染层递来的字符串在网关侧不做形状校验，
   *        所以这里在**任何模式分支之前**先认名，不认识的名称结构化失败——
   *        当作 0 会让一个拼错的动作名变成静默拒绝，当作无限更是直接把日上限绕成摆设（spec 2.7-03）
   * @param context 判定上下文；只用 `nowMs` 作为「今天」的基准，省略则取当前时间
   * @returns `{allowed, remaining, reason}`；`unlimited` 模式下 `remaining` 恒为 null（spec 1.9-02）
   */
  check = (action: QuotaAction, context: ActionContext = {}): GateDecisionView => {
    const limit = this.requireLimit(action);
    const nowMs = context.nowMs ?? Date.now();
    if (this.options.mode === 'unlimited') return { allowed: true, remaining: null, reason: null };
    const used = asApp(this.ctx)['usage.ledger'].countToday(action, nowMs);
    const remaining = Math.max(0, limit - used);
    if (remaining > 0) return { allowed: true, remaining, reason: null };
    return {
      allowed: false,
      remaining: 0,
      reason: `动作 ${action} 今日 ${String(limit)} 次额度已用完`,
    };
  };

  /**
   * 放行一次外发：判定 → 执行 → 落账。
   *
   * 落账在 `task` **成功之后**（plan §8.4 决策 1）：被拒与发送失败都没有消耗平台侧的任何东西，
   * 记进账本就是假用量；反过来只要账上有行，就说明那条动作真的走完了。
   * @param action 动作名
   * @param context 落账上下文（`targetId` / `workflowRunId` / `nowMs`）
   * @param task 真正的外发动作；只能是进程内的闭包 —— 它不出 IPC，因此无法被渲染层绕过
   * @returns 业务返回值与本次的账本行 id
   */
  perform = async <T>(action: QuotaAction, context: ActionContext, task: () => Promise<T>): Promise<Performed<T>> => {
    const decision = this.check(action, context);
    if (!decision.allowed) {
      throw new AppError('QUOTA_EXCEEDED', decision.reason ?? '额度已用完', 'entitlement.gate', {
        action,
        remaining: decision.remaining,
      });
    }
    const value = await task();
    const ledgerId = asApp(this.ctx)['usage.ledger'].record({ action, ...context });
    this.ctx.logger.info(`闸门放行并落账：动作 ${action} · 账本行 ${String(ledgerId)}`);
    return { value, ledgerId };
  };

  /**
   * 取该动作的日额度，顺带完成动作名校验。
   * @param action 动作名（类型上是枚举，运行期可能是渲染层递来的任意字符串）
   * @returns 配置里那一条上限
   * @throws 配置被改坏（少一键）或动作名不在枚举内时 `INVALID_ARGUMENT`，不静默兜底
   */
  private requireLimit = (action: QuotaAction): number => {
    // 标注成 Partial 是为了让「取不到」成为一个可判定的运行期事实：类型上的枚举保证不了
    // 跨 IPC 边界那一下（渲染层的字符串是任意 JSON），配置被改坏同样会落到这条分支。
    const limits: Partial<Record<QuotaAction, number>> = this.options.dailyLimits;
    const limit = limits[action];
    if (limit === undefined) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `闸门不认识的动作「${String(action)}」，可判定的动作只有 ${QUOTA_ACTIONS.join(' / ')}`,
        'entitlement.gate',
        { action },
      );
    }
    return limit;
  };

  [Service.init](): void {
    const { mode, dailyLimits } = this.options;
    this.ctx.logger.info(
      `外发闸门就绪：模式 ${mode}` +
        (mode === 'daily'
          ? ` · 每日上限 搜索 ${String(dailyLimits.search)} · 打招呼 ${String(dailyLimits.greet)}` +
            ` · 投递 ${String(dailyLimits.deliver)}（三者各自计数，互不占用）`
          : ''),
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'entitlement.gate': EntitlementGateService;
  }
}
