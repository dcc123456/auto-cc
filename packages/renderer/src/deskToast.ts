/**
 * 左下角浮层 toast 的界面侧汇流（09 稿形态① 的 1-B，spec 6.2-04 里那条"打扰度最低"的通道）。
 *
 * 稿子把这条通道限死在两句话上：结果一句话说得清，**且结果不在当前视野里**（产物是磁盘上的一份
 * 文件，界面上翻不到）才配一只 toast；同一时刻只允许一只，后来的直接顶掉先来的。
 * 所以这里只存"当前那一只"，不做队列——存成队列等于自己发明了第七种形态。
 *
 * 画法照 `deskStatus.ts` / `theme.ts`：模块级状态 + 一组订阅者 + 一只 hook，
 * 通知入口只有 `pushDeskToast` 与 `clearDeskToast` 两只，别处再写一套就长出第二个真相（§2.5）。
 */
import { useEffect, useState } from 'react';

/** 当前挂在左下角的那一句话。 */
export interface DeskToastReading {
  /** harness 断言用的凭据（渲染成 `data-action`）：判据是"回执真长出来了"，不是"调用没报错"。 */
  action: string;
  /** jade=办完了（8 秒自动收）；seal=办砸了（不自动收，与 spec 6.2-02 的结果态同一条理由）。 */
  tone: 'jade' | 'seal';
  /** 已翻译好的一句话（调用方把 i18n 结果递进来，界面不自己拼句子，§5.7）。 */
  message: string;
}

let current: DeskToastReading | undefined;

/** 订阅者集合（与 `deskStatus.ts` 的 `statusListeners` 同一条画法）。 */
const toastListeners = new Set<() => void>();

/** 通知全部订阅者；状态已经落在 `current` 里，这里只负责推。 */
function emit(): void {
  for (const notify of toastListeners) notify();
}

/**
 * 顶上一只 toast。
 * @param toast 内容；已有 toast 时新的直接换掉旧的（09 稿浮层纪律：toast 同时只 1 只）
 */
export function pushDeskToast(toast: DeskToastReading): void {
  current = toast;
  emit();
}

/** 收起当前 toast（jade 那一只到点与 Esc 走这一只；通道本来就空时什么都不做）。 */
export function clearDeskToast(): void {
  if (!current) return;
  current = undefined;
  emit();
}

/**
 * 订阅当前 toast：只给 `Toast` 原件用，面板一律靠 `pushDeskToast` 说话。
 * @returns 当前那一只；没有 toast 时 undefined
 */
export function useDeskToast(): DeskToastReading | undefined {
  const [toast, setToast] = useState<DeskToastReading | undefined>(current);

  useEffect(() => {
    const sync = () => setToast(current);
    toastListeners.add(sync);
    // 挂载与订阅之间可能已经有人顶上一只，挂上之后现读一次补上这一格（同 `useDeskStatus`）。
    sync();
    return () => {
      toastListeners.delete(sync);
    };
  }, []);

  return toast;
}
