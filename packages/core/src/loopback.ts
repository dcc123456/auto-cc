/**
 * 回环主机判定（2026-11-24 红线事故后的公共判据）。
 *
 * 为什么放进 core：这条判据现在有两处消费者——`browser.page` 的自动化导航与 `sessions.open` 的会话挂载，
 * 两处都是「自动化能不能碰这个主机」的同一句话。留在任一包里再抄一份，就是 §2.2 禁止的第二处复制。
 */

/** 视为本机的三个写法（`URL.hostname` 已把大小写归一，IPv6 回环带方括号）。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * 是不是本机回环主机。
 * @param hostname `URL.hostname`（大小写不敏感）
 * @returns 回环（含 `localhost` 与 IPv6 回环）时为 true
 */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}
