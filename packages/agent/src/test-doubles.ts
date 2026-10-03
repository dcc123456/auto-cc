/**
 * agent 台架用的人工接管替身（spec 5.5-02 的测试面）。
 *
 * 为什么要有这一份替身而不是把 `@auto-cc/plugin-browser` 拖进来：agent 是 L3，它按 AGENTS.md §4.1
 * 与 5.1-08 的机检**不许 import 浏览器包**——判定口与循环只认 `@auto-cc/core` 里那张窄询问面
 * （`TakeoverStateSource`，只有 `held()`）。所以测试要换一个「结构上满足那张面」的假提供者，
 * 而不是去真装一块内核视图。
 *
 * 它同时是「摘掉 `browser-takeover` 那一行装配」的对照物：`agent.policy` 与 `agent.loop` 把它写成硬依赖，
 * 不装它这两个服务根本不挂载（下面的「闸门缺席」用例把这条钉住），于是「接管态读不到还照动手」
 * 那种静默失效在结构上不成立。
 */
import { Service, type Context, type TakeoverReason, type TakeoverStateView } from '@auto-cc/core';
import { z } from 'zod';

/** 替身无可调项（与 `browser.takeover` 同形：状态由测试的手改，不由配置改）。 */
export const fakeTakeoverSchema = z.strictObject({});

export class FakeTakeoverService extends Service {
  static provide = 'browser.takeover';
  static Config = fakeTakeoverSchema;

  /** 当前那双手（null = 页面在自动化手里）。真实服务同一口径：只活在内存里，重启回落成「没在接管」。 */
  private hold: { reason: TakeoverReason; startedAt: number } | null = null;

  /** begin / end 次数：视图里那两位是界面算「有没有在途接管」的依据，替身也要跟着动。 */
  private beginCount = 0;

  private endCount = 0;

  /**
   * @param ctx 挂载上下文（`setHold` 要往事件线上发 `browser/takeover-changed`）
   * @param _options 校验后的配置，恒为空对象——真实服务同一口径（状态由手改不由配置改），
   *   这个参数只为满足 AGENTS.md §9 的 1.3 实测条：cordis 从构造器第二个实参**反推** `ctx.plugin()`
   *   的配置类型，写成单参数构造器会让两个台架的 `{}` 实参报 TS2345。
   */
  constructor(ctx: Context, _options: z.output<typeof fakeTakeoverSchema>) {
    super(ctx, 'browser.takeover');
  }

  /**
   * 现读接管态（`TakeoverStateSource` 要求的那一口，判定口与循环都走它）。
   * @returns 当前读数，每次新造对象（调用方改不坏替身内部）
   */
  held(): TakeoverStateView {
    return {
      isHeld: this.hold !== null,
      reason: this.hold?.reason ?? null,
      startedAt: this.hold?.startedAt ?? null,
      beginCount: this.beginCount,
      endCount: this.endCount,
    };
  }

  /**
   * 把页面交给人手或交还给自动化（测试的那只「手」）。
   *
   * 顺手发一条 `browser/takeover-changed`：5.5-a 里正挂在暂停单上的 run 就是靠这条事件被叫醒的，
   * 不发就只能测到「步与步之间现问」那一半。
   * @param reason 交给人手时写的原因；传 null 表示交还给自动化
   * @returns 变更后的读数，供用例直接断言
   */
  setHold(reason: TakeoverReason | null): TakeoverStateView {
    if (reason === null) {
      if (this.hold) {
        this.hold = null;
        this.endCount += 1;
      }
    } else if (!this.hold) {
      this.hold = { reason, startedAt: Date.now() };
      this.beginCount += 1;
    }
    const view = this.held();
    this.ctx.emit('browser/takeover-changed', view);
    return view;
  }
}
