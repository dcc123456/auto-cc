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
