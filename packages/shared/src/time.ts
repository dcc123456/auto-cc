/**
 * 跨层共用的本地日界工具（spec 1.9-08 / 5.8-04）。
 *
 * 放在 `@auto-cc/shared` 而不是留在 `entitlement` 里：同一套「按本机时区切一天」的口径
 * 有两个确定的消费方——L2 的账本按天分组，L4 的指标看板自己算「近 7 天」的区间
 * （决策十七：区间由发起方算，主进程不猜）。渲染层引不到 L2 的产物（那份要拖进浏览器包），
 * 而这一层是两边都已依赖的纯类型/纯函数面，所以两个口径只能在这里长成一份。
 */

/**
 * 本地日的 `YYYY-MM-DD` 键。
 * @param ts 毫秒时间戳
 * @returns 按**运行机器时区**算的日键 —— 故意不用 SQLite 的 `date('now')`，那是 UTC，
 *   中国用户会在早 8 点前被算进「昨天」（plan §8.4 决策 3）
 */
export function dayKey(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

/**
 * 本地「今天」零点的毫秒时间戳。
 * @param ts 毫秒时间戳（判定基准，通常是 `Date.now()`）
 * @returns 该时刻所在自然日的起点
 */
export function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
