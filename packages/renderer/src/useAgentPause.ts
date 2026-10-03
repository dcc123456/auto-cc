/**
 * 暂停单的界面侧状态（spec 5.3-08 / 09 / 10）：在等的单子、一句表态、以及「这张单是怎么收掉的」。
 *
 * 分工与 `useAgentRun` 一字不差：**事件负责此刻提醒，读数负责错过了也还在**（2.6-01 定下的口径）。
 * 所以两条 `agent/pause-*` 事件的处理器都不把载荷存成卡片内容，而是现读 `agent.pause.pending()`——
 * 事件里那份 `AgentPauseView` 与 `pending()` 是同一类型，真存了就是同一件事握两份（AGENTS.md §2.5）。
 *
 * 唯一留在本地的一份是「刚收掉的那张单长什么样」：`agent/pause-resolved` 只带单号与结局，
 * 而 5.3-10 要界面说清**是哪一类单**没人应答、第几轮、哪一步。它在收掉之前本来就在 `pending()` 里，
 * 这里只是把主进程给过的那份读数按单号留下一份，不编任何新事实；界面上也只用于那一行回报。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentPauseAnswer, AgentPauseView } from '@auto-cc/shared';
import { useBridgeAction } from './useBridgeAction';

/** 一张已经收掉的单与它的结局（`answered` 是人的表态落了地，后两者都**不是一种表态**）。 */
export type ResolvedPause = { card: AgentPauseView; outcome: 'answered' | 'timed-out' | 'cancelled' };

/**
 * 挂上暂停通道：在等的单子、表态口、以及超时/让出的回报。
 * @returns `pending`（现读的在等清单，还没读到过时为 undefined）、`resolved`（最近收掉的一张）、
 *   `busy` / `notice`（沿用 `useBridgeAction` 的忙碌态与提示行）、`respond`（把人的一句表态按单号送回去）
 */
export function useAgentPause() {
  const { t } = useTranslation();
  const [pending, setPending] = useState<AgentPauseView[]>();
  const [resolved, setResolved] = useState<ResolvedPause>();
  const bridge = window.autoCC;
  // 收单事件只带单号，回报那一行要知道「收掉的是哪一类单、第几轮、哪一步」，所以要按单号查回刚才那份读数。
  // 存的是**主进程读数的引用**，永远由 `read` 整体覆盖：界面拿它查一次显示，不拿它拼下一份状态。
  const lastReadRef = useRef<AgentPauseView[]>([]);

  /** 现读在等的单子（每个动作跑完由 `useBridgeAction` 调一次，界面不猜主进程当下在等谁）。 */
  const read = useCallback(async () => {
    const reply = await bridge?.agent['pause.pending']();
    if (reply?.ok) {
      lastReadRef.current = reply.value;
      setPending(reply.value);
    }
  }, [bridge]);

  const action = useBridgeAction(read);

  useEffect(() => {
    if (!bridge) return;
    const offRequested = bridge.on('agent/pause-requested', () => {
      void read();
    });
    const offResolved = bridge.on('agent/pause-resolved', (event) => {
      const card = lastReadRef.current.find((row) => row.requestId === event.requestId);
      // 查不到的单不回报：那意味着这张卡不是本界面见过的（例如另一条 run 的），此时编一句「没人应答」就是假话。
      if (card) setResolved({ card, outcome: event.outcome });
      void read();
    });
    return () => {
      offRequested();
      offResolved();
    };
  }, [bridge, read]);

  useEffect(() => {
    void read();
  }, [read]);

  /**
   * 把人的一句表态送回那张单（spec 5.3-09 的应答口：只有界面这一条路，模型没有这只手——机检 ⑦）。
   *
   * 表态之后界面上那行「已按你的表态放行 / 这一步不执行」不在这里写：`agent.pause` 在单定局时
   * 一定广播 `agent/pause-resolved`，回报由那个事件出。本地再猜一次就是第二处措辞现场。
   * @param card 界面上正在画的那张单（单号与类型都取自主进程的读数）
   * @param answer `approve` / `deny` / 带文本的 `supply`；种类与单不相配时结构化失败、单照旧在等
   */
  const respond = useCallback(
    async (card: AgentPauseView, answer: AgentPauseAnswer): Promise<void> => {
      await action.run(
        t(`agent.pause.action.${answer.decision}`),
        () => bridge?.agent['pause.respond'](card.requestId, answer),
        { apply: setPending },
      );
    },
    [action, bridge, t],
  );

  return { pending, resolved, busy: action.busy, notice: action.notice, respond };
}
