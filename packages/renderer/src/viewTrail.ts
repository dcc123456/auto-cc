/**
 * 跨视图推进（09 稿形态⑥，spec 6.2-24）的界面侧汇流：一次"从 A 视图跳到 B 视图并带上上下文"的意图。
 *
 * 稿子上这条通道的判据是**跳转一定要长面包屑**（同视图内的锚点不需要），所以这里存的不是"当前视图"
 * ——当前视图归 `App.tsx` 的 `view`——而是**这一跳是从哪儿来的、带了什么过去**。视图本身仍然由
 * `App.tsx` 的 `hidden` 类名切换，六个容器都不卸载（1.10-01 既有口径），正好兑现稿上「返回时滚动位置不变」
 * 那一条：返回只是清掉这一跳并切回来源视图，没有重建任何子树。
 *
 * 画法照 `deskToast.ts` / `deskStatus.ts` / `theme.ts`：模块级状态 + 一组订阅者 + 一只 hook，
 * 通知入口只有 `advanceViewTrail` 与 `clearViewTrail` 两只，别处再存一份就长出第二个真相（§2.5）。
 */
import { useEffect, useState } from 'react';

/** 六个视图的名字。归这里 own 是因为跨视图推进是全 app 唯一一处"要同时认识两个视图"的契约。 */
export type TopView = 'chat' | 'jobs' | 'resume' | 'workflow' | 'trust' | 'diagnostics';

/** 一次推进的内容。所有文案都是调用方已经翻好的字符串（§5.7：组件不拼句子）。 */
export interface ViewTrailReading {
  /** 来源视图，决定「返回」切回哪一格。 */
  sourceView: TopView;
  /** 来源那一格的已翻译标题（面包屑第一只 chip）。 */
  sourceTitle: string;
  /** 来源视图里被带走的那一个对象（岗位标题、会话标题…），可缺。 */
  sourceDetail?: string;
  /** 目标视图，`App.tsx` 认它切格。 */
  targetView: TopView;
  /** 目标那一格的已翻译标题（面包屑第二只 chip）。 */
  targetTitle: string;
  /** 目标视图里落到的那一段（「按 JD 定制这份简历」），可缺。 */
  targetDetail?: string;
  /**
   * 带过去的岗位正文原文（08 稿那行的"并带上该岗位"）。
   * 只走渲染层已有的自由文本入口：岗位行的 `description` 落进「按 JD 定制」那只输入框，
   * 由人自己按「生成定制版」——本模块不写任何简历内容，也不碰「正文不过界」那面墙。
   */
  seedJdText?: string;
  /**
   * 第几跳（模块级自增）。同一行双击两次、或带同样内容的两跳，靠它区分：
   * 订阅方拿它当 effect 依赖，否则"内容没变"的那一跳既不会重设输入框也不会重新滚进画面。
   */
  requestId: number;
}

let current: ViewTrailReading | undefined;

/** 订阅者集合（与 `deskToast.ts` 的 `toastListeners` 同一条画法）。 */
const trailListeners = new Set<() => void>();

/** 通知全部订阅者；状态已经落在 `current` 里，这里只负责推。 */
function emit(): void {
  for (const notify of trailListeners) notify();
}

/** 自增的第几跳。从 1 起，0 留作"没有这一跳"。 */
let trailSeq = 0;

/**
 * 发起一次跨视图推进。
 * @param trail 这一跳的来源与携带内容；`requestId` 由本模块盖，调用方不需要给
 */
export function advanceViewTrail(trail: Omit<ViewTrailReading, 'requestId'>): void {
  trailSeq += 1;
  current = { ...trail, requestId: trailSeq };
  emit();
}

/** 收起面包屑（人手动切视图、「返回」按下都走这一只；本来就没有这一跳时什么都不做）。 */
export function clearViewTrail(): void {
  if (!current) return;
  current = undefined;
  emit();
}

/**
 * 订阅当前那一跳：`App.tsx` 靠它切视图并挂面包屑，面板靠它取携带内容。
 * @returns 当前那一跳；没有推进在途时 undefined
 */
export function useViewTrail(): ViewTrailReading | undefined {
  const [trail, setTrail] = useState<ViewTrailReading | undefined>(current);

  useEffect(() => {
    const sync = () => setTrail(current);
    trailListeners.add(sync);
    // 挂载与订阅之间可能已经有人发起了一跳，挂上之后现读一次补上这一格（同 `useDeskToast`）。
    sync();
    return () => {
      trailListeners.delete(sync);
    };
  }, []);

  return trail;
}
