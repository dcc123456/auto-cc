/**
 * 上报给原生视图的那一份整数矩形（spec 10.11-27；PMO 2026-11-22 定论）。
 *
 * 为什么取整要在**上报侧**做：`getBoundingClientRect()` 是小数（地址栏底 94.15、视图顶 94），
 * 而原生视图按整数像素落位；直接把小数传下去就会出现一条 0.15px 的亚像素带被判成「重叠 98px²」。
 * 这里的口径是「视图从上面那一块的底边**上取整**开始」：`x/y` 上取整、`right/bottom` 下取整，
 * 保证 `y >= 上一块 bottom` 且宽度/高度不为负。
 */

/** 上报矩形（DIP，客户区坐标）。 */
export interface KernelViewRectInt {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 把小数矩形折成上报用的整数矩形。
 * @param rect 渲染层量到的 `getBoundingClientRect()`
 * @returns 上取整的左上角 + 下取整的右/下边；宽高至少为 1（0 尺寸交给调用方跳过）
 */
export const quantizeKernelViewRect = (rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): KernelViewRectInt => {
  const x = Math.ceil(rect.x);
  const y = Math.ceil(rect.y);
  const right = Math.floor(rect.x + rect.width);
  const bottom = Math.floor(rect.y + rect.height);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
};
