/**
 * 择机投递的时机规则（spec 5.7-03）：四个输入进来，一个决定出去，全程不碰任何服务。
 *
 * 为什么是纯函数而不是又一处编排代码：判据要的是「规则可读、可配置」，而可读的唯一代价是
 * 把判定与取数分开——取数（问库、问闸门、问频控）留在投递服务里，这里只回答「此刻该不该递」。
 * 四个输入各自的单一事实来源见 plan §7.5.5 决策七：回复状态在 `conversation_messages`、
 * 额度在 `entitlement.gate`、节奏在 `outbound.throttle` + 账本，只有时间窗是这条规则自己带的配置。
 *
 * 时间一律按**运行机器本地时区**判定，与 5.7-a 的 cron 同一口径：求职者的「白天」就是他所在地的白天。
 * 因此本模块的用例全部冻结在具体的毫秒值上，不依赖跑测试的时刻（AGENTS.md §9 的"换时区机器不假红"）。
 */
import { z } from 'zod';

/** 星期名的下标就是 `Date.getDay()` 的返回值，拒因要写「今天是周六」而不是「今天是 6」。 */
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/**
 * 择机投递的配置（挂在 `outbound.deliver` 的 `timing` 键下）。
 *
 * `enabled` 默认关：2.6 验收过的投递主线是「审批档位决定何时递」，这条规则是给**无人值守**那一路加的，
 * 不该在没人设置的情况下改变已验收的行为（plan §7.5.5 决策七第 2 条）。
 * 时间窗含头不含尾：`[9, 21)` 就是 09:00:00.000 起算、21:00:00.000 整出局。
 */
export const deliverTimingSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    /** 未回复就不递：真 app 默认开（「对方没回就递简历」是打扰，不是择机） */
    requireReply: z.boolean().default(true),
    /** 只在工作日（周一到周五）递 */
    weekdaysOnly: z.boolean().default(true),
    windowStartHour: z.number().int().min(0).max(23).default(9),
    windowEndHour: z.number().int().min(1).max(24).default(21),
  })
  .refine((timing) => timing.windowStartHour < timing.windowEndHour, {
    message: 'windowStartHour 必须小于 windowEndHour',
    path: ['windowStartHour'],
  });

/** 校验后的配置形状。 */
export type DeliverTimingConfig = z.output<typeof deliverTimingSchema>;

/**
 * 规则的四项读数（由投递服务现场问出来，本模块自己谁也不问）。
 * @property nowMs 判定基准（毫秒，绝对时间点）
 * @property replied 对方是否回复过；`null` 是「问不到」（JD 库里没这条、或平台层没挂载），
 *           不等于「没回复」——把不知道写成假会静默挡掉本该递出去的简历
 * @property gapRemainingMs 频控还差多少毫秒（0 = 现在就能动）
 * @property quotaAllowed 闸门只读判定；`false` 时**不由本规则改判**，交给 `gate.enforce` 留被拒流水
 */
export type DeliverTimingFacts = {
  nowMs: number;
  replied: boolean | null;
  gapRemainingMs: number;
  quotaAllowed: boolean;
};

/** 一次时机判定的结果。 */
export type DeliverTimingDecision = {
  /** true = 此刻适合投递 */
  ready: boolean;
  /** 拒因原文，顺序与判定顺序一致（回复 → 工作日 → 时间窗 → 频控 → 额度） */
  blockers: string[];
  /**
   * 最早可能合格的时刻（毫秒）；只有时间类拒因（时间窗、频控）给得出，
   * 「等对方回复」与「额度用完」不猜时刻——前者取决于人，后者取决于账本过日界。
   */
  nextEligibleAtMs: number | null;
};

/**
 * 取本地时区的「日界之后的第 n 天 00:00」，用于往后推窗口开启日。
 * @param date 基准时刻的本地日
 * @param days 往后几天（0 = 今天）
 * @returns 那天本地 00:00 的毫秒值
 */
function localDayStart(date: Date, days: number): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

/**
 * 从某个时刻往后找第一个「可投递日的窗口开启点」。
 * @param fromMs 起点（毫秒）；返回值一定严格晚于它，所以窗口外时能当"下一次该来看"的时刻
 * @param timing 时间窗与是否只在工作日
 * @returns 那一刻的毫秒值
 */
function nextWindowOpenMs(fromMs: number, timing: DeliverTimingConfig): number {
  const cursor = new Date(fromMs);
  for (let offset = 0; offset < 8; offset += 1) {
    const dayStart = localDayStart(cursor, offset);
    const weekday = new Date(dayStart).getDay();
    if (timing.weekdaysOnly && (weekday === 0 || weekday === 6)) continue;
    const open = dayStart + timing.windowStartHour * 3_600_000;
    if (open > fromMs) return open;
    // 同一天但已经过了开启点（那就是已过收盘点才会走到这里），往后一天再看。
  }
  // 走到这里是配置把每一天都排除了；上面按 8 天滚动，正常配置不可能到这里。
  return fromMs;
}

/**
 * 判定「此刻该不该递这份简历」。
 * @param facts 四项读数，见 `DeliverTimingFacts`
 * @param timing 规则配置，见 `DeliverTimingConfig`
 * @returns 决策；`ready` 为 false 时 `blockers` 至少一条，全部拒因都是给人读的原文
 */
export function evaluateDeliverTiming(facts: DeliverTimingFacts, timing: DeliverTimingConfig): DeliverTimingDecision {
  const blockers: string[] = [];
  const candidates: number[] = [];

  if (timing.requireReply) {
    if (facts.replied === false) blockers.push('对方还没有回复这条岗位，按择机投递的约定先不递简历');
    if (facts.replied === null) blockers.push('问不到这条岗位的回复状态（库里没有它或平台层没挂载），先不递简历');
  }

  const now = new Date(facts.nowMs);
  const weekday = now.getDay();
  const isWeekend = weekday === 0 || weekday === 6;
  if (timing.weekdaysOnly && isWeekend) {
    blockers.push(`今天是${WEEKDAY_NAMES[weekday] ?? '周末'}，按只在工作日投递的约定今天不递`);
    candidates.push(nextWindowOpenMs(facts.nowMs, timing));
  } else {
    const hour = now.getHours();
    if (hour < timing.windowStartHour || hour >= timing.windowEndHour) {
      blockers.push(
        `现在 ${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} 不在投递时间窗 ` +
          `${String(timing.windowStartHour).padStart(2, '0')}:00–${String(timing.windowEndHour).padStart(2, '0')}:00 内`,
      );
      candidates.push(nextWindowOpenMs(facts.nowMs, timing));
    }
  }

  if (facts.gapRemainingMs > 0) {
    blockers.push(`离上一次投递还差 ${String(Math.ceil(facts.gapRemainingMs / 1000))} 秒，按频控此刻不动手`);
    candidates.push(facts.nowMs + facts.gapRemainingMs);
  }

  if (!facts.quotaAllowed) blockers.push('今日投递额度已用完（这条由额度闸门记账，时机规则不替它改判）');

  return {
    ready: blockers.length === 0,
    blockers,
    nextEligibleAtMs: candidates.length === 0 ? null : Math.min(...candidates),
  };
}

/**
 * 算「离下一次外发还差多少毫秒」——频控那一段减法只允许写在这里一次（AGENTS.md §2.2）。
 * @param lastSentAt 账本里最近一条同名动作的时刻（毫秒）；null 表示从来没做过，于是不用等
 * @param gapMs 本次要隔开的时长（毫秒），由 `outbound.throttle` 掷出
 * @param nowMs 判定基准（毫秒）
 * @returns 还要等的毫秒数；已经等够或没有历史时为 0
 */
export function gapRemainingMs(lastSentAt: number | null, gapMs: number, nowMs: number): number {
  if (lastSentAt === null) return 0;
  return Math.max(0, lastSentAt + gapMs - nowMs);
}
