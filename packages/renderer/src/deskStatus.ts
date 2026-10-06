/**
 * 底部状态条那几项读数的界面侧汇流（spec 6.3-05）。
 *
 * 状态条要报「登录态 / 进行中运行 / 额度剩余 / 档位指示」，而这四项**各自早就有人在读了**：
 * 运行是 `useWorkflowRun`，其余三项分别属于 `SessionPanel`、`UsagePanel`、`ChatPanel`。
 * 状态条自己去调一遍 service 就是同一份事实的第二份副本 + 第二次调用，两份什么时候漂谁都不知道
 * （AGENTS.md §2.5），所以这里只做汇流：**读数由原本就拥有它的那只面板在每次 `read()` 成功之后推进来**，
 * 状态条只订阅——一条定时器都不加（「不新增长轮询」指的就是这一条）。
 *
 * 画法照 `theme.ts` 的 `themeListeners`：模块级状态 + 一组订阅者 + 一只 hook，
 * 通知入口只有 `report*` 那几只，别处再写一套就长出第二个真相（§2.5）。
 */
import { useEffect, useState } from 'react';
import type { AutonomyLevel, GateDecisionView, SessionPlatformView } from '@auto-cc/shared';

/**
 * 状态条能报出来的读数。
 * 每一项都区分「还没人报过」（undefined）与「报了但值是空」——
 * 前者界面上必须写「尚未读取」，后者写真实的零，把前者画成后者就是谎报（06 计划 plan §3.1）。
 */
export interface DeskStatusReading {
  /** 各平台的会话读数（`sessions.status()` 那一份的 `platforms`） */
  platforms?: SessionPlatformView[];
  /** 掉线的那一只平台名（`session/expired` 且 reason 为 `expired`）；没掉过或已重新登录是 undefined */
  expiredPlatform?: string;
  /** 闸门对三个额度动作的判定（`entitlement.gate.check` 逐动作那几份） */
  quota?: Record<string, GateDecisionView>;
  /** 当前会话的自治档位（`chat.session.current()` 里的 `session.autonomy`） */
  tier?: AutonomyLevel;
}

let current: DeskStatusReading = {};

/** 订阅者集合（与 `theme.ts` 的 `themeListeners` 同一条画法）。 */
const statusListeners = new Set<() => void>();

/**
 * 落一份读数并通知订阅者。
 * @param patch 本次要覆盖的那几项（其余项原样留着：四项各自独立到货，不该互相清掉）
 */
function report(patch: DeskStatusReading): void {
  current = { ...current, ...patch };
  for (const notify of statusListeners) notify();
}

/**
 * 报各平台的会话读数，并顺带算出「刚掉线」那一格。
 *
 * 掉线只由**快照之间的变化**判定：上一份里 `active`、这一份里不再 `active` 才算。
 * 从没登录过的平台读回 `expired` 是常态（主进程那份判定的 `reason` 就是 `missing`），
 * 把它报成「刚失效」是谎；而这条判据也不必去读事件载荷，界面上因此只有这一处知道掉线。
 * @param platforms `sessions.status()` 里那一份（只带 cookie 名与过期时间，不含值）
 */
export function reportDeskPlatforms(platforms: SessionPlatformView[]): void {
  const wasActive = new Set((current.platforms ?? []).filter((item) => item.auth === 'active').map((item) => item.id));
  const justDropped = platforms.find((item) => item.auth !== 'active' && wasActive.has(item.id));
  // 已经挂着的那一格跟着最新快照走：这一平台仍不在 active 就继续挂着（本面板的失效横幅也是这个寿命），
  // 重新登录好了就撤——状态条不该比横幅更早改口，也不该在用户修好之后还挂着朱砂（spec 6.3-05）。
  const stillDown = platforms.some((item) => item.id === current.expiredPlatform && item.auth !== 'active');
  report({ platforms, expiredPlatform: justDropped?.id ?? (stillDown ? current.expiredPlatform : undefined) });
}

/**
 * 报闸门判定。
 * @param quota 动作名 → 判定；undefined = 这一组里有一只没读到，宁可不报也不报半屏数字
 */
export function reportDeskQuota(quota: Record<string, GateDecisionView> | undefined): void {
  report({ quota });
}

/**
 * 报当前自治档位。
 * @param tier 会话上那一份档位（改档之后由 `ChatPanel` 的重读推过来）
 */
export function reportDeskTier(tier: AutonomyLevel): void {
  report({ tier });
}

/** 状态条那一格要报的「最紧的一只额度」。 */
export interface TightestQuota {
  /** 动作名（`search` / `greet` / `deliver`，与闸门同源，界面不另存一份名单） */
  action: string;
  /** 剩余次数；null = 这一只不限 */
  remaining: number | null;
  /** 闸门已经拒绝了吗（拒绝优先于数字：剩多少都不许发，报数字是误导） */
  isDenied: boolean;
}

/**
 * 从闸门判定里挑出状态条要报的那一只。
 * @param decisions 动作名 → 判定；undefined = 还没读到
 * @returns 已被拒的那一只 → 否则剩余最少的那一只 → 全部不限时给第一只（remaining 为 null）；一份都没有时 undefined
 */
export function tightestQuota(decisions: Record<string, GateDecisionView> | undefined): TightestQuota | undefined {
  if (!decisions) return undefined;
  let firstAction: string | undefined;
  let tightest: { action: string; remaining: number } | undefined;
  for (const [action, decision] of Object.entries(decisions)) {
    firstAction ??= action;
    // 被拒优先于数字：闸门已经不许发了，报「还剩几次」是误导。
    if (!decision.allowed) return { action, remaining: decision.remaining, isDenied: true };
    if (decision.remaining !== null && (!tightest || decision.remaining < tightest.remaining)) {
      tightest = { action, remaining: decision.remaining };
    }
  }
  if (firstAction === undefined) return undefined;
  // 全部不限（本地阶段的常态）：报第一只 + null，让界面说「不限」而不是说「没读到」。
  return tightest ? { ...tightest, isDenied: false } : { action: firstAction, remaining: null, isDenied: false };
}

/**
 * 订阅状态条读数：给底部状态条用。
 * @returns 当前汇流读数，随任一 `report*` 更新
 */
export function useDeskStatus(): DeskStatusReading {
  const [reading, setReading] = useState<DeskStatusReading>(current);

  useEffect(() => {
    const notify = () => setReading(current);
    statusListeners.add(notify);
    // 挂载与订阅之间可能已经有人报过一次，挂上之后现读一次补上这一格（同 `useDeskThemeValue`）。
    notify();
    return () => {
      statusListeners.delete(notify);
    };
  }, []);

  return reading;
}
