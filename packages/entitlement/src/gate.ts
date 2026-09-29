/**
 * `entitlement.gate` 服务（spec 1.9-01 / 1.9-02 / 1.9-03）：所有外发动作的唯一必经口。
 *
 * 两个方法分工是刻意的：
 * - `check()` **只用于展示**（剩余额度、界面提示），它不产生任何副作用，也不代表许可；
 * - `perform()` 才是放行口 —— 判定、执行、落账三步在一个方法里完成，
 *   所以「调了 check 再自己发」这种绕过在结构上就写不出正确的代码（spec 1.9-05 的立足点）。
 *
 * 当前实现是纯本地的：没有网络校验、没有登录、没有付费分支（`docs/00-master-plan.md` §1.5）。
 * P5 接 SaaS 时替换的是本文件里的判定，调用点一个都不用改。
 */
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import type { GateDecisionView } from '@auto-cc/shared';
import { z } from 'zod';
import type { ActionContext } from './types.js';

/** 一次放行的结果：业务返回值 + 本次落账的账本行 id（spec 1.9-04 要能在回执里看到行）。 */
export type Performed<T> = { value: T; ledgerId: number };

export const gateSchema = z.strictObject({
  /** `unlimited` 是当前产品阶段的默认；`daily` 用来演示「每动作每天 N 次」超限即拒。 */
  mode: z.enum(['unlimited', 'daily']).default('unlimited'),
  /** `daily` 模式下每个动作每天允许的条数（按本地自然日计）。 */
  dailyLimit: z.number().int().min(1).max(1000).default(5),
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
   * @param action 动作名（如 `greet` / `deliver`）
   * @param context 判定上下文；只用 `nowMs` 作为「今天」的基准，省略则取当前时间
   * @returns `{allowed, remaining, reason}`；`unlimited` 模式下 `remaining` 恒为 null（spec 1.9-02）
   */
  check = (action: string, context: ActionContext = {}): GateDecisionView => {
    const nowMs = context.nowMs ?? Date.now();
    if (this.options.mode === 'unlimited') return { allowed: true, remaining: null, reason: null };
    const used = asApp(this.ctx)['usage.ledger'].countToday(action, nowMs);
    const remaining = Math.max(0, this.options.dailyLimit - used);
    if (remaining > 0) return { allowed: true, remaining, reason: null };
    return {
      allowed: false,
      remaining: 0,
      reason: `动作 ${action} 今日 ${String(this.options.dailyLimit)} 次额度已用完`,
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
  perform = async <T>(action: string, context: ActionContext, task: () => Promise<T>): Promise<Performed<T>> => {
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

  [Service.init](): void {
    this.ctx.logger.info(
      `外发闸门就绪：模式 ${this.options.mode}${this.options.mode === 'daily' ? ` · 每动作每日 ${String(this.options.dailyLimit)} 次` : ''}`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'entitlement.gate': EntitlementGateService;
  }
}
