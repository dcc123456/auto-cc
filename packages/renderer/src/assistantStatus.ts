/**
 * 全局助手在顶栏那一颗胶囊上的三态读数（spec 10.11-11 / plan §14.2）。
 *
 * 为什么集中到这一支模块：胶囊住在 `App` 的顶栏，而「在跑 / 需要你 / 被拦」三类事实分别属于
 * `ChatPanel` 的 agent run、表态单与接管态。让顶栏自己去读一遍服务，就是同一份事实的第二份副本
 * （AGENTS.md §2.5）；这里的画法与 `deskStatus.ts` 一致：**拥有读数的那只面板报进来，胶囊只订阅**。
 *
 * 三类口径（照 plan §14.2 的角标定义）：
 * - `running`：有 run 正在跑 → 青瓷点；
 * - `needsYou`：待确认计划 + 逐条批准 + 投递待确认的条数 → 琥珀计数；
 * - `blocked`：页面被风控接管 → 朱砂点。
 * 普通未读**不亮**：助手不做消息中心（同节「不做」）。
 */
import { useEffect, useState } from 'react';

/** 胶囊要显示的三态读数。缺省全空 = 什么都不亮（还没读到也算不亮，与状态条「未读」口径一致）。 */
export interface AssistantStatusReading {
  /** 有 run 在跑 */
  running?: boolean;
  /** 「需要你」的条数（只计待确认计划 / 逐条批准 / 投递待确认） */
  needsYou?: number;
  /** 页面被风控接管 */
  blocked?: boolean;
}

/**
 * 「需要你」的计数口径（spec 10.11-11）：待确认计划 + 逐条批准 + **执行器待办**，三样相加。
 *
 * 为什么单独成函数：这三项来自三个不同的读数（`agent.loop` 的 proposed、`agent.pause.pending` 的条数、
 * `journey.unattended.view` 的 pending），相加的规则要是散在面板里，加第四类时没人知道该改哪。
 * @param input 三项各自的条数（读不到的按 0，别让缺读数长出一个假的「需要你」）
 * @returns 角标要显示的条数；负数按 0 收口（脏读数不制造负角标）
 */
export function mixNeedsYou(input: { pauseCards: number; proposedPlan: number; executorPending: number }): number {
  const total = input.pauseCards + input.proposedPlan + input.executorPending;
  return Number.isFinite(total) && total > 0 ? total : 0;
}

/**
 * 执行器那一类该不该算进「需要你」（2026-11-22 裁定 A）。
 *
 * 只算**真的在等你**的状态：`paused` / `stopped` / `blocked`，或授权单 `restart-required`。
 * `idle` 时有授权单不算、`running` 时也不算——那是「未完成岗位数」，把它当「需要你」会让人
 * 看到琥珀数字点进助手，却找不到对应的待办。
 * @param input 执行器状态与授权单状态（都为 null/缺省时按不算计）
 * @returns 该不该把待办数计入角标
 */
export function executorNeedsYou(input: { status?: string | null; authorizationStatus?: string | null }): boolean {
  if (input.authorizationStatus === 'restart-required') return true;
  return input.status === 'paused' || input.status === 'stopped' || input.status === 'blocked';
}

let current: AssistantStatusReading = {};

const statusListeners = new Set<() => void>();

/**
 * 落一份读数并通知订阅者。
 * @param patch 本次覆盖的字段（其余字段原样留着：三类事实各自独立到货）
 */
export function reportAssistantStatus(patch: AssistantStatusReading): void {
  current = { ...current, ...patch };
  for (const notify of statusListeners) notify();
}

/** 订阅胶囊读数（只在变化时重渲染）。 */
export function useAssistantStatus(): AssistantStatusReading {
  const [reading, setReading] = useState(current);
  useEffect(() => {
    const notify = () => setReading(current);
    statusListeners.add(notify);
    return () => {
      statusListeners.delete(notify);
    };
  }, []);
  return reading;
}
