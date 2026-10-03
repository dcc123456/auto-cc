/**
 * 接管态的界面侧读数与那两只手（spec 5.5-01 的界面半边，兼 5.5-02 的「看得见的在拦」）。
 *
 * 分工与 `useAgentPause` 一字不差：**事件负责此刻提醒，读数负责错过了也还在**。
 * `browser/takeover-changed` 的载荷与 `browser.takeover.held()` 是同一个类型，
 * 所以事件处理器只拿它当「该重读了」的铃，不把载荷存成状态——存了就等于界面握第二份接管事实
 * （AGENTS.md §2.5，而这一条判据在 5.5-02 的全部意义就是「接管态只有一处」）。
 *
 * 时长也不另起一份账：`startedAt` 是主进程那一份读数给的毫秒时刻，本地只有一个每秒跳一次的
 * 重画扳机（`setTick`），它不调任何 IPC、不猜任何状态，改的只是「这一行字该重画了」。
 *
 * `begin` / `end` 的 `runId` 是把这次接管对上「哪条 run 被它按住」的那根线（spec 5.5-09）：
 * 人在哪张计划卡前面按的接管，审计里就写哪条 run，界面不把「我猜它是这条」写进任何一处判断。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TakeoverStateView } from '@auto-cc/shared';
import { useBridgeAction } from './useBridgeAction';

/** 接管时长那一行重画的间隔（毫秒）——只扳本地重画，不因此多问主进程一次。 */
const CLOCK_TICK_MS = 1000;

/**
 * 挂上接管态：当下在不在人手里、因何、多久，以及「我来接管 / 交还页面」两只手。
 * @param activeRunId 界面上当前这条 run 的 id（没有 run 时为 undefined，审计行的归属写 null）
 * @returns `state`（现读的接管读数，未读回来前为 undefined）、`elapsedMs`（在接管中才非零的时长）、
 *   `busy` / `notice`（沿用 `useBridgeAction`）、`hold` / `release`（两只按钮的手）
 */
export function useTakeover(activeRunId?: string) {
  const { t } = useTranslation();
  const [state, setState] = useState<TakeoverStateView>();
  const [, setTick] = useState(0);
  const bridge = window.autoCC;

  /** 现读接管态（每个动作跑完由 `useBridgeAction` 调一次，界面不猜页面此刻在谁手里）。 */
  const read = useCallback(async () => {
    const reply = await bridge?.browser['takeover.held']();
    if (reply?.ok) setState(reply.value);
  }, [bridge]);

  const action = useBridgeAction(read);

  useEffect(() => {
    void read();
  }, [read]);

  useEffect(() => {
    if (!bridge) return;
    // 自动那一路（风控 / 登录失效，spec 5.5-07）没有按钮，界面只能靠这条广播发现页面换了主人。
    return bridge.on('browser/takeover-changed', () => {
      void read();
    });
  }, [bridge, read]);

  useEffect(() => {
    if (!state?.isHeld) return;
    const timer = setInterval(() => setTick((n) => n + 1), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [state?.isHeld]);

  /**
   * 人按下「我来接管」：把页面的操作权要回自己手里（`actor` 恒为 `user`，这是人的表态不是系统的观测）。
   *
   * 它**不**叫停任何在跑的 run：循环是在下一个安全点自己停下并落 `paused` + `TAKEOVER_HELD` 的
   * （5.5-a 的账），这里再补一次 `stop` 就会把同一次接管记成「用户停止了任务」。
   */
  const hold = useCallback(async (): Promise<void> => {
    await action.run(
      t('chat.takeover.actionHold'),
      () => bridge?.browser['takeover.begin']({ reason: 'manual', actor: 'user', runId: activeRunId ?? null }),
      { apply: setState },
    );
  }, [action, activeRunId, bridge, t]);

  /**
   * 人按下「交还页面」：只把页面交回去，**不**顺带恢复任何 run。
   *
   * 恢复是第二只按钮（`useAgentRun.resume`），因为交还页面与「那就接着跑」是两件可以分开表态的事——
   * 人可能只想改一下登录态、看一眼，再决定要不要让它继续（spec 5.5-01 的两步口径）。
   */
  const release = useCallback(async (): Promise<void> => {
    await action.run(
      t('chat.takeover.actionRelease'),
      () => bridge?.browser['takeover.end']({ actor: 'user', runId: activeRunId ?? null }),
      { apply: setState },
    );
  }, [action, activeRunId, bridge, t]);

  // 未接管时给 0：横幅不画时长，也就永远不会显示一个停在那里的假秒数。
  const elapsedMs = state?.isHeld && state.startedAt !== null ? Math.max(0, Date.now() - state.startedAt) : 0;

  return { state, elapsedMs, busy: action.busy, notice: action.notice, hold, release };
}
