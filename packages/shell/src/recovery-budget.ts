/**
 * 内核视图「被站点关掉」之后的恢复预算（2026-11-23 管理员裁定）。
 *
 * 背景：真站上点一次城市筛选，站点会自己把页面关掉（`destroyed` 已由调用点尾迹判定为「外部/站点侧」）。
 * 恢复动作是「按当时的地址栏 URL 重建一次」，但**没有限流就是无限循环**：
 * 站点可能一加载就再关一次，于是重建→再关→再重建，用户看到右栏持续闪断、日志被刷爆。
 * 所以预算写死：**60 秒内最多 2 次**；用完就停手，只留一句「请点重试」。
 *
 * 为什么做成纯函数：限流是这条兜底里唯一能单测的部分（时间窗口 + 计数），
 * 而它错了的后果是「无限重建」——最该被钉住的那一格。
 */

/** 恢复预算的窗口（毫秒）与窗口内允许的次数。 */
export const RECOVERY_WINDOW_MS = 60_000;
export const RECOVERY_LIMIT = 2;

/**
 * 判定此刻还能不能恢复一次。
 * @param attempts 已经发生过恢复的时刻（毫秒时间戳，旧的可以留着，本函数只数落在窗口内的）
 * @param nowMs 当前时刻（毫秒）
 * @returns `allowed` 为 false 时 `remainingMs` 是「还要等多久才腾出名额」
 */
export function recoveryVerdict(
  attempts: readonly number[],
  nowMs: number,
): { allowed: boolean; usedInWindow: number; remainingMs: number } {
  const recent = attempts.filter((at) => nowMs - at < RECOVERY_WINDOW_MS);
  if (recent.length < RECOVERY_LIMIT) return { allowed: true, usedInWindow: recent.length, remainingMs: 0 };
  // 最早那一次滑出窗口就腾出一个名额。
  const earliest = Math.min(...recent);
  const remainingMs = Math.max(0, RECOVERY_WINDOW_MS - (nowMs - earliest));
  return { allowed: false, usedInWindow: recent.length, remainingMs };
}

/**
 * 记一次恢复，并顺手丢掉窗口外的旧记录（防止数组无限增长）。
 * @param attempts 已有记录（不改原数组）
 * @param nowMs 这次恢复的时刻
 * @returns 新的记录数组（只保留窗口内的）
 */
export function withRecovery(attempts: readonly number[], nowMs: number): number[] {
  return [...attempts.filter((at) => nowMs - at < RECOVERY_WINDOW_MS), nowMs];
}
