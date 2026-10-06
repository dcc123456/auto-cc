import { useCallback, useEffect, useState } from 'react';

/**
 * 内嵌内核视图当下在不在界面上（裁定⑱：默认不展示，只有装着真实站点时才展示）。
 *
 * 分工与 `useTakeover` 一致：**事件负责此刻提醒，读数负责错过了也还在**。
 * `shell/kernel-view-visible` 只当「该重读了」的铃来用，状态仍取自 `shell.getStatus`——
 * 于是渲染层握的是主进程那一份可见性，而不是自己推导出来的第二份事实（AGENTS.md §2.7）；
 * 漏掉一次推送（切视图、reload）也还能对得上。
 * @returns 当下可见性；主进程读数回来之前按 `false` 算，那正是它的默认值
 */
export function useKernelViewVisible(): boolean {
  const [isVisible, setIsVisible] = useState(false);
  const bridge = window.autoCC;

  /** 现读可见性：界面不许自己记住「上一次是展开的」再拿它摆布局。 */
  const read = useCallback(async () => {
    const reply = await bridge?.shell.getStatus();
    if (reply?.ok) setIsVisible(reply.value.kernelViewVisible);
  }, [bridge]);

  useEffect(() => {
    void read();
  }, [read]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.on('shell/kernel-view-visible', () => {
      void read();
    });
  }, [bridge, read]);

  return isVisible;
}
