/**
 * `entitlement.gate` 服务（spec 1.9-01 / 1.9-02 / 1.9-03 / 2.7-03）：所有外发与抓取动作的唯一必经口。
 *
 * 三个方法分工是刻意的：
 * - `check()` **只用于展示**（剩余额度、界面提示），它不产生任何副作用，也不代表许可；
 * - `enforce()` 是「现在就问一句，到量就把这一次记成被拒再抛」——外发编排在等频控间隔**之前**用它，
 *   免得用户白等一个周期（spec 2.5-02 / 2.6 的「到量即停」）；
 * - `perform()` 才是放行口 —— 判定、执行、落账三步在一个方法里完成，
 *   所以「调了 check 再自己发」这种绕过在结构上就写不出正确的代码（spec 1.9-05 的立足点）。
 *
 * 额度是**按动作**的（`search` / `greet` / `deliver` 各一条上限，2.7-03）：抓 40 轮不该吃掉打招呼的额度，
 * 反过来也不能因为「抓取只是读」就 entirely 游离在闸门之外——那是 2.3-11 的原判据，plan §14.4 第 1 条已更正。
 *
 * 当前实现是纯本地的：没有网络校验、没有登录、没有付费分支（`docs/00-master-plan.md` §1.5）。
 * P5 接 SaaS 时替换的是本文件里的判定，调用点一个都不用改。
 */
import { AppError, asApp, Service, type Context, type OutboundInspection } from '@auto-cc/core';
import {
  QUOTA_ACTIONS,
  type GateDecisionView,
  type GateQuotaView,
  type OutboundAttemptKey,
  type OutboundAttemptView,
  type OutboundControlView,
  type OutboundReconcileView,
  type QuotaAction,
} from '@auto-cc/shared';
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

  /** 账本句柄：所有停用与去重事实都只读这一处，不另存内存副本。 */
  private get ledger() {
    return asApp(this.ctx)['usage.ledger'];
  }

  /**
   * 生成并校验完整外发键；缺任何一维都必须停在页面动作之前。
   * @param action greet/deliver
   * @param context 编排层提供的平台、目标与简历版本
   * @returns 可直接落尝试台账的键
   * @throws `INVALID_ARGUMENT`：键缺维或动作为 search
   */
  private keyOf(action: OutboundAttemptKey['action'], context: ActionContext): OutboundAttemptKey {
    const platform = context.platform?.trim() ?? '';
    const targetId = context.targetId?.trim() ?? '';
    const resumeVersion = context.resumeVersion?.trim() ?? '';
    if (!platform || !targetId || !resumeVersion) {
      throw new AppError(
        'INVALID_ARGUMENT',
        '持久化外发必须给全 platform + targetId + action + resumeVersion，缺一维就不能判定重放',
        'entitlement.gate',
        { action, platform, targetId, hasResumeVersion: resumeVersion.length > 0 },
      );
    }
    return { platform, targetId, action, resumeVersion };
  }

  /**
   * 已成功或结局未知的键一律不许再次进入页面；该方法只读，不产生额度或被拒流水。
   * @param key 完整去重键
   * @throws `OUTBOUND_ALREADY_SENT` / `OUTBOUND_RECONCILIATION_REQUIRED`
   */
  private assertFresh(key: OutboundAttemptKey): void {
    const attempt = this.ledger.attemptFor(key);
    if (!attempt) return;
    if (attempt.status === 'succeeded') {
      throw new AppError(
        'OUTBOUND_ALREADY_SENT',
        '同一平台、目标、动作与简历版本已经成功外发，本次重放不再扣额或发送',
        'entitlement.gate',
        {
          ...key,
          ledgerId: attempt.ledgerId,
          receiptId: attempt.receiptId,
        },
      );
    }
    if (attempt.status === 'site-default' && attempt.confirmedAt !== null) return;
    if (attempt.status !== 'failed') {
      throw new AppError(
        'OUTBOUND_RECONCILIATION_REQUIRED',
        '上一次外发结局尚未对账，禁止盲目重发；先只读核对页面回执与账本',
        'entitlement.gate',
        {
          ...key,
          attemptStatus: attempt.status,
          ledgerId: attempt.ledgerId,
        },
      );
    }
  }

  /**
   * 停用状态只读展示；恢复不代表自动续跑，仍须重新经审批、额度、频控与去重。
   * @returns 持久化控制读数
   */
  outboundStatus = (): OutboundControlView => this.ledger.outboundStatus();

  /**
   * 人的一键停用/恢复入口，刻意不登记成 agent 工具，模型不能自行恢复外发。
   * @param stopped 是否停用
   * @param nowMs 表态时刻（毫秒）
   * @returns 设置后的状态
   */
  setOutboundStopped = (stopped: boolean, nowMs = Date.now()): OutboundControlView =>
    this.ledger.setOutboundStopped(stopped, nowMs);

  /**
   * 只读外发尝试，供编排层提前避免重复生成内容与界面展示对账读数。
   * @param action greet/deliver
   * @param context 完整外发上下文
   * @returns 已持久化的尝试或 null
   */
  outboundAttempt = (action: OutboundAttemptKey['action'], context: ActionContext): OutboundAttemptView | null =>
    this.ledger.attemptFor(this.keyOf(action, context));

  /**
   * 编排层在生成内容前先做无副作用的重放检查；真正发送前 `performOutbound` 会再查一次防竞态。
   * @param action greet/deliver
   * @param context 完整外发上下文
   * @throws 同 `performOutbound` 的重复/未知两类错误
   */
  assertOutboundFresh = (action: OutboundAttemptKey['action'], context: ActionContext): void => {
    this.assertFresh(this.keyOf(action, context));
  };

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
   * 额度的**静态那一面**（spec 5.8-03）：当前模式与按动作的日上限表。
   *
   * 为什么单开一只手而不是让看板去推算：`check()` 的 `remaining` 在超限时被夹到 0（`Math.max`），
   * 于是「已用 + 剩余」在超限那档就不再等于上限——上限只能从配置这一侧读，
   * 而配置的唯一主人是本服务（AGENTS.md §2.7：不在界面存第二份额度事实）。
   * 模式与上限都是**只读**读数：看板的判据（5.8-02）正是它不该触发任何一次改写。
   * @returns 模式（`unlimited` 时界面该说「不设上限」而不是给一个大数）与三条动作的日上限（条/本地自然日）
   */
  quota = (): GateQuotaView => ({
    mode: this.options.mode,
    dailyLimits: { ...this.options.dailyLimits },
  });

  /**
   * 一键停用优先于去重与额度：停用期间每一次新调用都明确拒绝，不拿旧成功回执冒充本次放行。
   * @param action 动作名；search 是只读抓取，不受外发总开关影响
   * @param context 被拒流水的上下文
   * @throws `OUTBOUND_DISABLED` 并留一条不计额度的被拒审计
   */
  private ensureOutboundEnabled(action: QuotaAction, context: ActionContext): void {
    if (action === 'search' || !this.ledger.outboundStatus().stopped) return;
    const reason = `动作 ${action} 未执行：外发已一键停用；恢复后仍需重新审批与对账`;
    this.ledger.recordDenial({ action, ...context, code: 'OUTBOUND_DISABLED', reason });
    throw new AppError('OUTBOUND_DISABLED', reason, 'entitlement.gate', { action, stopped: true });
  }

  /**
   * 问一句「现在能不能做」，不能做就**先把这一次记成被拒流水再抛**。
   *
   * 它是 `usage_denials` 的唯一写入口（spec 5.3-12）：判定、留痕、抛错三件事长在一起，
   * 所以调用方拿不到「被拒但没留痕」这个选项。`perform` 内部也走这里，两处判定因此是同一处实现。
   * @param action 额度动作名
   * @param context 判定与留痕的上下文（`targetId` / `workflowRunId` / `nowMs`，进被拒表的那三列）
   * @returns 放行时的判定读数（界面可顺带取剩余额度）
   * @throws 到量时以 `QUOTA_EXCEEDED` 失败（`details` 带动作名与剩余额度），不静默跳过
   */
  enforce = (action: QuotaAction, context: ActionContext = {}): GateDecisionView => {
    this.ensureOutboundEnabled(action, context);
    const decision = this.check(action, context);
    if (decision.allowed) return decision;
    const reason = decision.reason ?? `动作 ${action} 的额度已用完`;
    this.ledger.recordDenial({ action, ...context, code: 'QUOTA_EXCEEDED', reason });
    throw new AppError('QUOTA_EXCEEDED', reason, 'entitlement.gate', { action, remaining: decision.remaining });
  };

  /**
   * 放行一次外发：判定 → 执行 → 落账；判定不过则由 `enforce` 先记一条被拒流水再抛。
   *
   * 落账在 `task` **成功之后**（plan §8.4 决策 1）：被拒与发送失败都没有消耗平台侧的任何东西，
   * 记进用量表就是假用量；反过来只要用量表上有行，就说明那条动作真的走完了。
   * 被拒的那一次另有去处（`usage_denials`，spec 5.3-12）：它是"有人试过、被拦下了"的审计事实，
   * 不是用量，所以既不占日上限、也不启动频控的钟（那是 1.9-03 那句「既不花钱也不落账」的原意）。
   * @param action 动作名
   * @param context 落账上下文（`targetId` / `workflowRunId` / `nowMs`）
   * @param task 真正的外发动作；只能是进程内的闭包 —— 它不出 IPC，因此无法被渲染层绕过
   * @returns 业务返回值与本次的账本行 id
   */
  perform = async <T>(action: QuotaAction, context: ActionContext, task: () => Promise<T>): Promise<Performed<T>> => {
    this.enforce(action, context);
    const value = await task();
    const ledgerId = asApp(this.ctx)['usage.ledger'].record({ action, ...context });
    this.ctx.logger.info(`闸门放行并落账：动作 ${action} · 账本行 ${String(ledgerId)}`);
    return { value, ledgerId };
  };

  /**
   * 带持久化去重与未知结局保护的外发放行口；页面闭包全应用仍只在主进程内。
   * @param action greet/deliver
   * @param context 必须含平台、目标、简历版本；账本沿用原字段
   * @param task 真正的页面动作；只允许执行一次
   * @param writeDelivery 成功时与同事务写 `delivery_records` 的可选回调
   * @returns 页面返回值与一对一账本行
   * @throws 重放 `OUTBOUND_ALREADY_SENT`；未知 `OUTBOUND_RECONCILIATION_REQUIRED`；其余同 `perform`
   */
  performOutbound = async <T>(
    action: OutboundAttemptKey['action'],
    context: ActionContext,
    task: () => Promise<{ value: T; receiptId?: string | null }>,
    writeDelivery?: (ledgerId: number) => void,
  ): Promise<Performed<T>> => {
    const key = this.keyOf(action, context);
    this.ensureOutboundEnabled(action, context);
    this.assertFresh(key);
    this.enforce(action, context);
    const begun = this.ledger.beginAttempt(key, context.workflowRunId ?? null, context.nowMs);
    if (begun.kind !== 'send') {
      // 并发入口在唯一索引前只能有一个赢家；输家按同一份持久化事实停下，不碰页面。
      this.assertFresh(key);
      throw new AppError(
        'OUTBOUND_RECONCILIATION_REQUIRED',
        '外发发送权状态发生变化，先重新对账',
        'entitlement.gate',
        key,
      );
    }
    try {
      const outcome = await task();
      // 页面动作在停用前开始、停用后才回执时，仍不得在停用后新增成功账；未知结局留给人工对账。
      this.ensureOutboundEnabled(action, context);
      const completed = this.ledger.completeAttempt(
        key,
        context,
        outcome.receiptId ?? null,
        writeDelivery,
        context.nowMs,
      );
      this.ctx.logger.info(`外发已放行并原子落账：动作 ${action} · 账本行 ${String(completed.ledgerId)}`);
      return { value: outcome.value, ledgerId: completed.ledgerId };
    } catch (error) {
      const reason = error instanceof AppError ? error.code : 'OUTBOUND_UNKNOWN_ERROR';
      if (reason === 'OUTBOUND_UNTRACKED_SITE_GREETING') {
        // 站点代发了默认问候（应用没发正文）：这一发有可核的页面证据，标 site-default 而不是 unknown，
        // 人确认后才允许继续；仍然从这里抛出「停」，绝不在写完后自动重发（spec 10.11-26）。
        const details = error instanceof AppError ? (error.details as Record<string, unknown> | undefined) : undefined;
        const summary = typeof details?.['evidenceSummary'] === 'string' ? details['evidenceSummary'] : null;
        this.ledger.markAttemptSiteDefault(key, summary, context.nowMs);
      } else {
        this.ledger.markAttemptUnknown(key, reason, context.nowMs);
      }
      throw error;
    }
  };

  /**
   * 失败后只读对账：页面确认成功就只补账不重发；明确未发生才允许显式重试；未知/冲突继续停手。
   * @param action greet/deliver
   * @param context 与原发送完全相同的四元组、来源和运行上下文
   * @param inspection 平台适配器只读回执，三态不得用 sent:false 冒充“确定没发”
   * @param writeDelivery 页面确认成功时补投递经过的回调，仍与账本同事务
   * @returns 对账结局与是否允许之后显式重试
   */
  reconcile = (
    action: OutboundAttemptKey['action'],
    context: ActionContext,
    inspection: OutboundInspection,
    writeDelivery?: (ledgerId: number) => void,
  ): OutboundReconcileView => {
    const key = this.keyOf(action, context);
    const before = this.ledger.attemptFor(key);
    if (!before) {
      return { status: inspection.status === 'confirmed' ? 'conflict' : 'not-found', canResume: false, attempt: null };
    }
    if (before.status === 'succeeded') {
      const differs =
        inspection.status === 'absent' ||
        (before.receiptId !== null && inspection.receiptId !== undefined && inspection.receiptId !== before.receiptId);
      return { status: differs ? 'conflict' : 'already-succeeded', canResume: false, attempt: before };
    }
    if (before.status === 'site-default') {
      // 站点默认问候：只有人确认过才允许续发；确认后仍不落账、不扣额（spec 10.11-26）。
      return {
        status: before.confirmedAt === null ? 'unknown' : 'not-sent',
        canResume: before.confirmedAt !== null,
        attempt: before,
      };
    }
    if (inspection.status === 'unknown') return { status: 'unknown', canResume: false, attempt: before };
    if (inspection.status === 'absent') {
      const attempt = this.ledger.markAttemptFailed(key, context.nowMs);
      return { status: 'not-sent', canResume: !this.ledger.outboundStatus().stopped, attempt };
    }
    if (this.ledger.outboundStatus().stopped) {
      // 停用期间允许只读核对，但不得借对账补一条成功账；恢复后可由人再确认同一回执。
      return { status: 'conflict', canResume: false, attempt: before };
    }
    try {
      const completed = this.ledger.completeAttempt(
        key,
        context,
        inspection.receiptId ?? null,
        writeDelivery,
        context.nowMs,
      );
      return { status: 'recovered', canResume: false, attempt: completed.attempt };
    } catch (error) {
      const reason = error instanceof AppError ? error.code : 'RECONCILE_WRITE_FAILED';
      const attempt = this.ledger.markAttemptUnknown(key, reason, context.nowMs);
      return { status: 'conflict', canResume: false, attempt };
    }
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
