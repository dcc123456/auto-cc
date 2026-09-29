/**
 * 登录态判定的纯逻辑（spec 1.8-01 / 1.8-05 / 1.8-06）。
 *
 * 单独成文件是因为它必须能在不带 electron 的 vitest 里被测到：真实 cookie 读取留在
 * `SessionsService`，这里只吃已经取出来的 cookie 摘要。判定**只看 cookie 的存在与过期时间，
 * 绝不发站点请求**——真实平台上一发请求就是风控流量（§8.3 决策 4）。
 */

/** 一条 cookie 的摘要：只有名字与过期时间戳（毫秒），没有值。 */
export type CookieSummary = { name: string; expiresAt: number | null };

/** 判定结果：`missing` 与 `expired` 分开，是因为界面要给用户的下一步动作不同（重登 vs 等待）。 */
export type AuthVerdict = {
  auth: 'active' | 'expired';
  reason: 'missing' | 'expired' | null;
  expiresAt: number | null;
};

/**
 * 按会话 cookie 判定某平台的登录态。
 * @param cookies 该分区里的 cookie 摘要（顺序无关）
 * @param sessionCookieName 判定所依据的 cookie 名（由 `cordis.yml` 的平台配置给出）
 * @param nowMs 判定基准时间戳（毫秒），调用方传 `Date.now()`，测试传固定值
 * @returns 登录态、失效原因与 cookie 过期时间；会话型 cookie（无过期时间）视为 active
 */
export function judgeAuth(cookies: readonly CookieSummary[], sessionCookieName: string, nowMs: number): AuthVerdict {
  const sessionCookie = cookies.find((cookie) => cookie.name === sessionCookieName);
  if (!sessionCookie) return { auth: 'expired', reason: 'missing', expiresAt: null };
  if (sessionCookie.expiresAt !== null && sessionCookie.expiresAt <= nowMs) {
    return { auth: 'expired', reason: 'expired', expiresAt: sessionCookie.expiresAt };
  }
  return { auth: 'active', reason: null, expiresAt: sessionCookie.expiresAt };
}

/**
 * 把 cookie 列表收成可安全落日志 / 过 IPC 的摘要。
 *
 * 值在这里就被丢掉（spec 1.8-05、AGENTS.md §8.5）：调用方拿不到带值的形状，也就没法把凭证
 * 顺手写进日志或截图；Electron 的 `expirationDate` 是「秒」且会话 cookie 为 -1，一并折算成毫秒或 null。
 * @param cookies electron `session.cookies.get()` 的原始返回（只取 name 与 expirationDate）
 * @returns 按名字排序的摘要列表
 */
export function summarizeCookies(cookies: readonly { name: string; expirationDate?: number }[]): CookieSummary[] {
  return cookies
    .map((cookie) => {
      // Electron 的类型里 `expirationDate` 是可选的，实测会话 cookie 给 -1：两者都收成 null。
      const expiresInSeconds = cookie.expirationDate ?? 0;
      return {
        name: cookie.name,
        expiresAt: expiresInSeconds > 0 ? Math.round(expiresInSeconds * 1000) : null,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}
