/**
 * 挂在人身上的表态单（spec 5.3-08 / 09 / 10 + 5.7-14）：在等的单子、一句表态、以及「这张单是怎么收掉的」。
 *
 * 分工与 `useAgentRun` 一字不差：**事件负责此刻提醒，读数负责错过了也还在**（2.6-01 定下的口径）。
 * 所以 `agent/pause-*` 与 `outbound/approval-requested` 这几条事件的处理器都不把载荷存成卡片内容，
 * 而是现读主进程的 `pending()`——事件里那份与 `pending()` 是同一类型，真存了就是同一件事握两份（AGENTS.md §2.5）。
 *
 * 这里刻意汇两路读数：`agent.pause` 的暂停单（哪一步要不要动手、缺哪些入参）与 `outbound.deliver`
 * 自己的投递确认单。两路各有各的通道与应答口，但**挂在人身上时是同一件事**——「这只手现在能不能动」。
 * 5.7-d 的实测缺口就是后一张只在 `JobLabPanel` 画：档位为 semi 时对话那一路要过两道表态，
 * 第一道在对话里、第二道在另一个视图，链路必然挂到超时（#110）。汇成一份清单、由同一张卡形状画出来，
 * 应答时按来源送回各自的口，界面上不存在第二套"怎么批准"。
 *
 * 唯一留在本地的一份是「刚收掉的那张单长什么样」：`agent/pause-resolved` 只带单号与结局，
 * 而 5.3-10 要界面说清**是哪一类单**没人应答、第几轮、哪一步。它在收掉之前本来就在 `pending()` 里，
 * 这里只是把主进程给过的那份读数按单号留下一份，不编任何新事实；界面上也只用于那一行回报。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentPauseAnswer, AgentPauseView, BridgeReply, DeliverApprovalView } from '@auto-cc/shared';
import { useBridgeAction } from './useBridgeAction';

/** 一张已经收掉的单与它的结局（`answered` 是人的表态落了地，后两者都**不是一种表态**）。 */
export type ResolvedPause = { card: AgentPauseView; outcome: 'answered' | 'timed-out' | 'cancelled' };

/**
 * 一份汇了来源的表态清单条目。
 *
 * `origin` 只做**应答路由**，不做第二份事实：卡片上显示的每个字段都来自各自那份主进程读数，
 * 界面上不拼、不猜、不改写（§2.5）。投递单没有"已定局"事件，所以它只靠 `pending()` 现读——
 * 到点被主进程按拒绝收掉之后，下一次读数里它就不在了。
 */
export type PendingDecision =
  { origin: 'agent'; card: AgentPauseView } | { origin: 'deliver'; card: DeliverApprovalView };

/**
 * 挂上两条表态通道：在等的单子（两路汇成一份）、表态口、以及超时/让出的回报。
 * @returns `pending`（现读的在等清单，还没读到过时为 undefined）、`resolved`（最近收掉的一张 agent 单）、
 *   `busy` / `notice`（沿用 `useBridgeAction` 的忙碌态与提示行）、`respond`（把人的一句表态按来源送回各自的口）
 */
export function useAgentPause() {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingDecision[]>();
  const [resolved, setResolved] = useState<ResolvedPause>();
  const bridge = window.autoCC;
  // 收单事件只带单号，回报那一行要知道「收掉的是哪一类单、第几轮、哪一步」，所以要按单号查回刚才那份读数。
  // 存的是**主进程读数的引用**，永远由 `read` 整体覆盖：界面拿它查一次显示，不拿它拼下一份状态。
  const lastReadRef = useRef<AgentPauseView[]>([]);

  /**
   * 现读两路在等的单子并汇成一份清单。
   *
   * 两路都读到才写 state：只读到一路就写，等于把另一路正在等的单从界面上抹掉——
   * 那比"界面还没刷出来"更糟，人会以为没人欠他一次表态。
   */
  const read = useCallback(async () => {
    const [pauseReply, deliverReply] = await Promise.all([
      bridge?.agent['pause.pending'](),
      bridge?.outbound['deliver.pending'](),
    ]);
    if (!pauseReply?.ok || !deliverReply?.ok) return;
    lastReadRef.current = pauseReply.value;
    setPending([
      ...pauseReply.value.map((card): PendingDecision => ({ origin: 'agent', card })),
      ...deliverReply.value.map((card): PendingDecision => ({ origin: 'deliver', card })),
    ]);
  }, [bridge]);

  const action = useBridgeAction(read);

  useEffect(() => {
    if (!bridge) return;
    const offPauseRequested = bridge.on('agent/pause-requested', () => {
      void read();
    });
    const offPauseResolved = bridge.on('agent/pause-resolved', (event) => {
      const card = lastReadRef.current.find((row) => row.requestId === event.requestId);
      // 查不到的单不回报：那意味着这张卡不是本界面见过的（例如另一条 run 的），此时编一句「没人应答」就是假话。
      if (card) setResolved({ card, outcome: event.outcome });
      void read();
    });
    // 投递单开出来时同样只负责提醒去读：载荷那份 `DeliverApprovalView` 与 `deliver.pending()` 是同一件事。
    const offDeliverRequested = bridge.on('outbound/approval-requested', () => {
      void read();
    });
    return () => {
      offPauseRequested();
      offPauseResolved();
      offDeliverRequested();
    };
  }, [bridge, read]);

  useEffect(() => {
    void read();
  }, [read]);

  /**
   * 把人的一句表态送回那张单所属的口（spec 5.3-09 的应答口：只有界面这一条路，模型没有这只手——机检 ⑦）。
   *
   * 投递这一路只有是 / 否：`supply` 对一张「要不要把这份简历发出去」的单没有意义，界面上也不画文本域，
   * 所以这里把 `approve` 之外的一切表态都按拒绝送出去——与主进程「没人点等于不投」同一条口径。
   *
   * 表态之后界面上那行「已按你的表态放行 / 这一步不执行」不在这里写：`agent.pause` 在单定局时
   * 一定广播 `agent/pause-resolved`，回报由那个事件出。本地再猜一次就是第二处措辞现场。
   * @param decision 界面上正在画的那张单（来源与单号都取自主进程的读数）
   * @param answer `approve` / `deny` / 带文本的 `supply`；种类与单不相配时结构化失败、单照旧在等
   */
  const respond = useCallback(
    async (decision: PendingDecision, answer: AgentPauseAnswer): Promise<void> => {
      // 两个口的返回类型不同（暂停单回整份清单、投递单回那一张），所以这里按 `unknown` 交给外壳：
      // 本钩子不 `apply` 返回值，清单一律由 `read()` 现读（§2.5 不在界面上留第二份真相）。
      const call = (): Promise<BridgeReply<unknown>> | undefined =>
        decision.origin === 'agent'
          ? bridge?.agent['pause.respond'](decision.card.requestId, answer)
          : bridge?.outbound['deliver.resolveApproval'](decision.card.approvalId, answer.decision === 'approve');
      await action.run(t(`agent.pause.action.${answer.decision}`), call);
    },
    [action, bridge, t],
  );

  return { pending, resolved, busy: action.busy, notice: action.notice, respond };
}
