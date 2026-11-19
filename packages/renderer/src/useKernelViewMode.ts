/**
 * 内核视图的布局模式开关（11 片 plan §4.1）。
 *
 * 两种模式互斥，**在启动时读一次**——切换靠 reload 整体生效，不允许两态同屏各握一份几何事实。
 * 默认 `canvas`（主画布）；`sidebar` 是运行时回滚通道，旧 8.8 三档宽度代码整段留在那个分支里。
 */
export type KernelViewMode = 'canvas' | 'sidebar';

/** 模式偏好键；与 `auto-cc.lang` 等同一份 localStorage。 */
export const KERNEL_VIEW_MODE_STORAGE_KEY = 'auto-cc.kernel-view-mode';

/**
 * 读当前布局模式。
 * @returns `sidebar` 仅当键显式写成它；其余（缺失、非法值、读盘失败）一律 `canvas`
 */
export function readKernelViewMode(): KernelViewMode {
  try {
    return window.localStorage.getItem(KERNEL_VIEW_MODE_STORAGE_KEY) === 'sidebar' ? 'sidebar' : 'canvas';
  } catch {
    return 'canvas';
  }
}
