/**
 * 内核视图槽位矩形的收口（spec 8.8-01）。
 *
 * 单独成文件是因为渲染层报来的数字是**不可信输入**（用户手改脚本、布局算出 NaN 都算），
 * 而它唯一的用途就是把一块原生视图铺到屏幕上——铺歪了不是界面瑕疵，是那块区域从此点不动。
 * 校验与夹取写成纯函数，才能在不带 electron 的 vitest 里逐条测到（同 `reveal-target.ts` 的手法）。
 */
import type { KernelViewRect } from '@auto-cc/shared';

/** 客户区尺寸：夹取的边界就是它，视图永远不许铺到窗口外面去。 */
export type ContentSize = { width: number; height: number };

/**
 * 把渲染层报来的槽位矩形收成一次可用的摆位。
 * @param rect 渲染层 `getBoundingClientRect()` 的读数（DIP，原点是客户区左上角，可为负或超界）
 * @param content 当前窗口的客户区尺寸（宽或高为 0 视为窗口还没就绪）
 * @returns 夹取并取整后的矩形；输入非有限 / 尺寸非正 / 与客户区无交集时为 null（调用方保留上一份，不铺 0x0）
 */
export function clampSlotRect(rect: KernelViewRect, content: ContentSize): KernelViewRect | null {
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (values.some((value) => !Number.isFinite(value))) return null;
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (content.width <= 0 || content.height <= 0) return null;

  // 左/上先夹进客户区，右下角同理；夹完没有面积就算「无交集」。
  // 用「先夹坐标再算尺寸」而不是 max/min 四件套：后者会把一块越界的大矩形悄悄缩成贴边视图，
  // 那正是渲染层想要 x=0 时的行为，而它报出负坐标本来就该被修成 0，不是被当成有效布局。
  const x = Math.max(0, Math.min(Math.round(rect.x), content.width));
  const y = Math.max(0, Math.min(Math.round(rect.y), content.height));
  const width = Math.max(0, Math.min(Math.round(rect.x + rect.width), content.width) - x);
  const height = Math.max(0, Math.min(Math.round(rect.y + rect.height), content.height) - y);
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * 渲染层还没报过槽位时的兜底摆位：右侧一条、按 `KERNEL_VIEW_WIDTH_RATIO` 取宽、铺满全高。
 * @param content 客户区尺寸
 * @param ratio 兜底宽度比例（与渲染层 `--kernel-view-width` 同源，由 `check-renderer-conventions.ts` 机检）
 * @returns 槽位矩形
 */
export function fallbackSlotRect(content: ContentSize, ratio: number): KernelViewRect {
  const width = Math.round(content.width * ratio);
  return { x: content.width - width, y: 0, width, height: content.height };
}
