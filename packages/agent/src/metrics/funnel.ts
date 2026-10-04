/**
 * `funnel.query`：投递漏斗与额度消耗的**只读聚合口**（spec 5.8-01 / 02 / 03 / 04 / 05，plan §7.6.2 决策十六）。
 *
 * 它存在的唯一理由：看板的五级数与额度三量必须从**一张主进程读数**里来。若让界面分别去调
 * `jd.store.count` / `usage.ledger.summary` / `outbound.deliver.pending`，界面就得自己知道
 * "哪一级归谁、按哪一列的时刻数、缺谁该显示什么"——那是把主进程的归属表抄第二份（AGENTS.md §2.5），
 * 而且现有那几只手全不带时间范围（plan §7.6.1 F12），拼出来的"近 7 天"会是混着口径的假数。
 *
 * 三条刻意的取舍，与同包那只 `agent.run` 一字不差地同形：
 * ① **本包不 import 任何能力包**（spec 5.1-08 / §5.9，eslint `AGENT_CAPABILITY` 机检），
 *    归属服务按**结构接口** + `maybeService` 现问：只声明本口会按的那一只手，
 *    不在本地存第二份事实（§9 的 2.5 实测：热改配置会重建下游，存副本会静默变空）。
 * ② **自己不写一行 SQL**：数还是由每张表的主人来数（新增的四只带界计数分属四个包，见决策十六），
 *    否则这里就长出第二条读取通道（§2.7）。
 * ③ **读不到不降级成 0**：那一级给 `unavailableReason` 原话。0 在看板上读起来是"一条都没发生"，
 *    而"没有这个数据源"与"那个服务此刻没挂载"是三种完全不同的事实（spec 5.8-07 反向验证要拦的正是这个）。
 *
 * 挂载与生命周期：不建表、不占迁移号段、没有 `inject`——所以摘掉任何一条能力腿都不会把它一起带进
 * PENDING，只会在查那一级时给出一句确定的"没挂载"。反过来摘掉本插件（清单里注掉 `funnel`），
 * 看板得到的是「服务未挂载」的结构化失败，而不是对着空数画一条漏斗。
 */
import { AppError, maybeService, Service, type Context } from '@auto-cc/core';
import {
  QUOTA_ACTIONS,
  type FunnelLevel,
  type FunnelLevelView,
  type FunnelQuotaView,
  type FunnelRange,
  type FunnelView,
  type GateDecisionView,
  type GateQuotaView,
  type QuotaAction,
} from '@auto-cc/shared';
import { z } from 'zod';

/** 无可调项：五级归属、缺服务文案、面试级无源口径都是代码性质，不是配置（4.x 起代码内无魔法数同一条纪律）。 */
export const funnelQuerySchema = z.strictObject({});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type FunnelQueryConfig = z.output<typeof funnelQuerySchema>;

/** `jd.store.countCaptured()` 里本口要用的那一只手。 */
type JdCountReader = { countCaptured(range: FunnelRange): number };

/** `conversation.store.repliedJobCount()` 里本口要用的那一只手。 */
type RepliedCountReader = { repliedJobCount(range: FunnelRange): number };

/** `usage.ledger` 里本口要用的那两只手（区间数与今日数走的是同一张表的同一个主人）。 */
type LedgerCountReader = {
  countAction(action: string, range: FunnelRange): number;
  countToday(action: string, nowMs: number): number;
};

/** `outbound.deliveries.count()` 里本口要用的那一只手。 */
type DeliveryCountReader = { count(range: FunnelRange): number };

/** `entitlement.gate` 里本口要用的那两只手（模式/上限从配置侧读，剩余从判定侧读）。 */
type GateQuotaReader = {
  quota(): GateQuotaView;
  check(action: QuotaAction, context?: { nowMs?: number }): GateDecisionView;
};

/**
 * 第五级（约面）的确定读数原话（plan §7.6.2 决策十五，由用户裁定）。
 *
 * 全仓没有任何面试字段、状态枚举或时间列（§7.6.1 F11），所以这一级**没有可数的东西**；
 * 按 `LIKE '%面试%'` 粗筛招聘方消息会把"聊到面试"当"约了面试"，那是 §8.4 事实锁定禁的猜测，
 * 而新建一张人工标记表是新功能、不该塞进一个只读看板。三条路都不通向数字，于是这里只给一句话。
 */
const INTERVIEW_NO_SOURCE = 'app 目前不记录约面这件事：库里没有面试字段或状态源，所以这一级没有可数的东西（不是 0）';

/**
 * 校验区间入参（唯一的校验处）。
 *
 * 这是系统边界：`fromMs` / `toMs` 从渲染层经 IPC 进来，形状没有任何保证。
 * 不校验就往下走的后果分两种且都不可接受——非整数/NaN 会让 SQL 比较静默无行（看板显示一排 0），
 * `from >= to` 会让"这一级是 0"读起来像"这段时间没干活"。
 * @param range 待校验的半开区间
 * @returns 原样返回的区间（校验通过才有下一步）
 * @throws 不合法时以 `FUNNEL_RANGE_INVALID` 结构化失败，界面上屏原话
 */
function requireRange(range: FunnelRange): FunnelRange {
  const fromMs = range?.fromMs;
  const toMs = range?.toMs;
  const invalid =
    typeof fromMs !== 'number' ||
    typeof toMs !== 'number' ||
    !Number.isSafeInteger(fromMs) ||
    !Number.isSafeInteger(toMs) ||
    fromMs >= toMs;
  if (invalid) {
    throw new AppError(
      'FUNNEL_RANGE_INVALID',
      `看板的时间区间要是一对整数毫秒且含头不含尾，收到的是 [${String(fromMs)}, ${String(toMs)})`,
      'funnel.query',
      { fromMs, toMs },
    );
  }
  return { fromMs, toMs };
}

export class FunnelQueryService extends Service {
  /**
   * 服务名取 `funnel`、方法名取 `query`，于是白名单路径正好是 plan §3 表里那条 `funnel.query`。
   * （决策十六原文写的 "provide `funnel.query`" 与那条路径不能同时成立：`resolve.ts` 按最长前缀拆
   * `service.method`，provide 叫 `funnel.query` 时路径只能是 `funnel.query.<方法>`；此处按**路径表**为准。）
   */
  static provide = 'funnel';
  static Config = funnelQuerySchema;

  constructor(ctx: Context, _options: FunnelQueryConfig) {
    // 无配置项也要接住第二个实参：cordis 递的是校验后的配置（AGENTS.md §9 实测 1.3）。
    super(ctx, 'funnel');
  }

  /**
   * 一次取回漏斗五级 + 额度三量（看板的唯一数据源）。
   *
   * 只读：本方法不写任何一张表、不改任何一份配置、不启动任何计时器（spec 5.8-02 的只读性判据）。
   * `tookMs` 是这次聚合在主进程里的真实耗时，随读数一起出去——5.8-05 要计时证据时读的就是这一位，
   * 界面原样显示、不自测（自测会把 IPC 往返也算成聚合代价）。
   * @param range 半开区间毫秒时间戳，**含头不含尾**；日界由发起方按本地时区算（决策十七）
   * @param context 读数基准；`nowMs` 只用于「今日已用/剩余」那一块，省略则取当前时间
   * @returns 五级读数（缺源的那级带原话）+ 额度块 + 真实耗时
   * @throws 区间不合法时 `FUNNEL_RANGE_INVALID`
   */
  query = (range: FunnelRange, context: { nowMs?: number } = {}): FunnelView => {
    const checked = requireRange(range);
    const nowMs = context.nowMs ?? Date.now();
    const startedAt = performance.now();
    const levels = this.levels(checked);
    const quota = this.quota(nowMs);
    return { range: checked, levels, quota, tookMs: Math.max(0, Math.round(performance.now() - startedAt)) };
  };

  /**
   * 五级读数（顺序即主计划里的漏斗顺序，界面按数组画、不自己排）。
   * @param range 已校验的半开区间
   * @returns 五级各一条；归属服务缺席的那一级带 `unavailableReason` 而不是 0
   */
  private levels(range: FunnelRange): FunnelLevelView[] {
    return [
      this.countLevel('search', '岗位库', 'jd.store', range, (owner: JdCountReader) => owner.countCaptured(range)),
      this.countLevel('greet', '用量账本', 'usage.ledger', range, (owner: LedgerCountReader) =>
        owner.countAction('greet', range),
      ),
      this.countLevel('reply', '会话库', 'conversation.store', range, (owner: RepliedCountReader) =>
        owner.repliedJobCount(range),
      ),
      this.countLevel('deliver', '投递记录', 'outbound.deliveries', range, (owner: DeliveryCountReader) =>
        owner.count(range),
      ),
      // 第五级没有主人可问：给它编一个数就是把"没做这件事"显示成"这件事零转化"。
      { level: 'interview', count: null, unavailableReason: INTERVIEW_NO_SOURCE },
    ];
  }

  /**
   * 组装「问得到归属服务就数、问不到就说原因」那一条唯一路径（§2.2：五级共用它）。
   * @param level 级别名（稳定的机器键，界面上的中文走语言包，§5.5）
   * @param label 拒因里说人话的功能名，不是内部 id
   * @param serviceId 归属服务的 provide 名（用的时候现问，不在本服务存第二份事实）
   * @param range 已校验的半开区间（只为让 `read` 的闭包写得短，读数与它同源）
   * @param read 归属服务上的那一只手
   * @returns 一条级别读数；两分支互斥（有数字必无原因，无数字必有原因）
   */
  private countLevel<T extends object>(
    level: FunnelLevel,
    label: string,
    serviceId: string,
    range: FunnelRange,
    read: (owner: T) => number,
  ): FunnelLevelView {
    const owner = maybeService<T>(this.ctx, serviceId);
    if (owner === undefined) {
      return { level, count: null, unavailableReason: `${label}（${serviceId}）此刻没有挂载，这一级无数可数` };
    }
    return { level, count: read(owner), unavailableReason: null };
  }

  /**
   * 额度那一块（spec 5.8-03）：三条动作各一行「今日已用 / 上限 / 剩余」，外加模式。
   *
   * 三只手各归各家，本口一件都不自己算（决策二十）：模式与上限从 `gate.quota()` 来（超限时
   * `check()` 的 `remaining` 夹在 0，用「已用 + 剩余」反推上限会在用光那一档算出比配置小的数），
   * 今日已用从 `usage.ledger.countToday` 来，剩余从 `gate.check` 来。
   * 闸门缺席时整块给 null 而不是给三个 0——「没装闸门」与「额度用光了」在屏幕上必须长得不一样。
   * @param nowMs 「今日」的判定基准毫秒（与 `check`/`countToday` 共用同一个数，避免跨零点的两读）
   * @returns 额度块；`mode` 为 null 表示闸门此刻没挂载
   */
  private quota(nowMs: number): FunnelQuotaView {
    const gate = maybeService<GateQuotaReader>(this.ctx, 'entitlement.gate');
    const ledger = maybeService<LedgerCountReader>(this.ctx, 'usage.ledger');
    if (gate === undefined) {
      return {
        mode: null,
        actions: QUOTA_ACTIONS.map((action) => ({
          action,
          usedToday: ledger === undefined ? null : ledger.countToday(action, nowMs),
          dailyLimit: null,
          remaining: null,
        })),
      };
    }
    const gateQuota = gate.quota();
    return {
      mode: gateQuota.mode,
      actions: QUOTA_ACTIONS.map((action) => ({
        action,
        usedToday: ledger === undefined ? null : ledger.countToday(action, nowMs),
        dailyLimit: gateQuota.dailyLimits[action],
        remaining: gate.check(action, { nowMs }).remaining,
      })),
    };
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    funnel: FunnelQueryService;
  }
}
