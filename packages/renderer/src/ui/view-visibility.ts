import { useEffect } from 'react';
import type { TopView } from '../viewTrail';

/**
 * 「这一屏真的露出来了」就重读一次——七个视图只改 `display`、不卸载（`App.tsx` 的 `workspace`），
 * 所以只在挂载那一刻读一次的面板，会在别的屏里发生的事之后一直显示旧读数。
 *
 * 为什么需要这一条（2026-11-24 萌新两个 P1 的同一个根因）：
 * - 投递之后切到「运行记录」，账本仍写「一条记录都没有」，要手动点「重新读取」才对；
 * - 投递之后岗位卡仍写「未投递」、追踪页「0 个岗位在追」——因为它们读的都是挂载那一刻的快照。
 *
 * 为什么用 `IntersectionObserver` 而不是事件/轮询：视图容器是 `hidden` 显隐，观察者在它被 `display:none`
 * 时不会把 `isIntersecting` 判成 true，露出来那一刻才触发一次；既不新增定时器，也不要求各面板自己订阅业务事件
 * （同一套业务事件在别的包里叫不出名字就是第二套耦合）。
 *
 * 这条逻辑原先在 `HomePanel` 与 `ResumeDesk` 各有一份，出现第三、第四次就收进这里（AGENTS.md §2.2）。
 * @param view 视图标识（与 `App.tsx` 里 `data-view-scroll` 的取值同源）
 * @param reload 露出来时要做的重读；调用方应当用 `useCallback` 稳定它，否则每次渲染都会重挂观察者
 */
export function useReloadWhenVisible(view: TopView, reload: () => void): void {
  useEffect(() => {
    const host = document.querySelector<HTMLElement>(`[data-view-scroll="${view}"]`);
    if (!host || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        // 只在「这一屏露出来」时重读；被别的视图盖住时不做无谓重读。
        if (entries.some((entry) => entry.isIntersecting)) reload();
      },
      { threshold: 0 },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [view, reload]);
}
