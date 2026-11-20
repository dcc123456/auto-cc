/**
 * 内核视图的布局模式开关与分栏几何判据（11 片 plan §4.1 / §4.2，spec 11-03 / 11-04）。
 *
 * 两种模式互斥，**在启动时读一次**——切换靠 reload 整体生效，不允许两态同屏各握一份几何事实。
 * 默认 `canvas`（常驻分栏）；`sidebar` 是运行时回滚通道，旧 8.8 三档宽度代码整段留在那个分支里。
 *
 * 分栏态的宽度常量与缩放算术也收在这一支：`KernelCanvasSlot` 只消费、不另写一份数字。
 */
export type KernelViewMode = 'canvas' | 'sidebar';

/** 模式偏好键；与 `auto-cc.lang` 等同一份 localStorage。 */
export const KERNEL_VIEW_MODE_STORAGE_KEY = 'auto-cc.kernel-view-mode';

/**
 * 分栏态右栏可拖到的宽度区间（百分点）。
 *
 * 与 sidebar 分支的 `WIDTH_MIN=38 / WIDTH_MAX=72` **互不相犯**（spec 11-08）：两套模式各有自己的
 * 落盘键与常量，回滚态复测时不会因为同一个变量名被两组数字夹来夹去。
 */
export const CANVAS_RIGHT_MIN = 30;
export const CANVAS_RIGHT_MAX = 70;

/** 默认右栏占主区 65%（spec 11-03）；也是把手双击的回落档。 */
export const CANVAS_RIGHT_DEFAULT = 65;

/** 键盘微调步长（百分点）：与 sidebar 把手同档。 */
export const CANVAS_RIGHT_STEP = 2;

/** 分栏态右栏宽度的落盘键；`auto-cc.kernel-slot-width` 在分栏态不读不写（spec 11-08）。 */
export const CANVAS_RIGHT_STORAGE_KEY = 'auto-cc.kernel-canvas-right-width';

/** 命令式写在右栏本体上的 CSS 变量名，值就是上面那个百分比。 */
export const CANVAS_RIGHT_VAR = '--kernel-canvas-right-width';

/** 右栏宽度的宽度 class：唯一的字面量，值由 CSS 变量给（Tailwind 只扫得见字面量）。 */
export const CANVAS_RIGHT_WIDTH_CLASS = 'w-(--kernel-canvas-right-width)';

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

/**
 * 按右栏容器宽算缩放比例（spec 11-04）：`zoom = min(1, 容器宽 / minLayoutWidth)`。
 *
 * 全精度传递、**不取整**：取三位小数会让「容器宽 / zoom ≥ minLayoutWidth」不再成立
 * （614 / 0.502 = 1223.1 < 1224，判据自己否定自己，门下省第 2 轮点名）。界面上要显示三位小数
 * 是读数层的事，判定一律用这里返回的原值。
 * @param viewWidth 右栏容器实测宽（CSS px，>0 才有意义）
 * @param minLayoutWidth 平台桌面布局的最小宽（BOSS 1224，单一事实来自平台知识包）；未声明/非法时视为未适配
 * @returns 有限且 `0 < zoom ≤ 1` 的比例；适配器缺值时恒 1（原生排布）并结合 `unadapted` 读数如实标注
 */
export function canvasZoom(viewWidth: number, minLayoutWidth: number | undefined): number {
  if (!Number.isFinite(viewWidth) || viewWidth <= 0) return 1;
  if (minLayoutWidth === undefined || !Number.isFinite(minLayoutWidth) || minLayoutWidth <= 0) return 1;
  return Math.min(1, viewWidth / minLayoutWidth);
}

/**
 * 分栏态两栏的宽度算术（U 类几何判据用，与 `SplitHandle` 的拖拽模型同一套分母）。
 *
 * 把手**不占行内宽度**：它用负外边距叠在左栏右缘 6px 上（否则窗口 1555 时左栏只剩 474px，
 * 与 spec 11-06 的「左栏 480」差出一个把手），因此右栏 = 主区 × ratio，左栏 = 主区 − 右栏。
 * @param stageWidth 主区（分栏行）宽（CSS px）
 * @param ratioPercent 右栏占比（百分点，调用方给合法区间内的值）
 * @returns `{ right, left }` 两栏宽（CSS px，未取整）；非法输入按 0 处理
 */
export function canvasColumnWidths(stageWidth: number, ratioPercent: number): { right: number; left: number } {
  if (!Number.isFinite(stageWidth) || stageWidth <= 0) return { right: 0, left: 0 };
  if (!Number.isFinite(ratioPercent)) return { right: 0, left: stageWidth };
  const right = (stageWidth * ratioPercent) / 100;
  return { right, left: stageWidth - right };
}
