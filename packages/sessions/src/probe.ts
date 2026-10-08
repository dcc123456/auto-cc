/**
 * 登录态判定的纯逻辑（spec 1.8-01 / 1.8-06 / 8.2-01）。
 *
 * 单独成文件是因为它必须能在不带 electron 的 vitest 里被测到：真实 cookie 读取留在
 * `SessionsService`，这里只吃已经取出来的 cookie 摘要。判定**只看 cookie 的存在与过期时间，
 * 绝不发站点请求**——真实平台上一发请求就是风控流量（§8.3 决策 4）。
 *
 * 8.2 换掉的是"单枚 cookie 名"这一条判据：仿站只发一枚 `autocc_session`，真实站点的登录态
 * 是一族 cookie（`docs/acceptance/08-real-platform-driving/8.0-02-cookie-name-diff.txt` 的实测差集），
 * 只认一枚在真站上恒判失效。因此这里收的是**信号族**，并且第三种状态 `unknown` 是必需的：
 * 未标定的平台、或看到的 cookie 两族都不沾时，程序不许挑一头说谎（要么谎报已登录、要么把人
 * 推进重新登录的接管循环）。`unknown` 不发 `session/expired`——它的处置是"停下来问人"，不是"重登"。
 */
import type { SessionAuthStatus, SessionExpiredEvent } from '@auto-cc/core';

/** 一条 cookie 的摘要：只有名字与过期时间戳（毫秒），没有值。 */
export type CookieSummary = { name: string; expiresAt: number | null };

/**
 * 一个平台的登录信号标定（取值凭据：8.0-02 的登录前后 cookie 名差集）。
 *
 * 族名单由配置给出而不是代码里写死，是因为这份知识属于站点、会随着站点改版失效；
 * 写死就等于把"某天起真站恒判 unknown"藏进一次发版里（改配置行即可，且未标定只会得到 `unknown`）。
 */
export type AuthSignals = {
  /** 登录票据族：命中任一枚（且未过期）就是登录过的证据。空数组 = 该平台未标定。 */
  authCookieNames: readonly string[];
  /** 游客族：只有这些在场 ⇒ 明确的未登录（真站上的登录前基线正是这一族）。 */
  guestCookieNames: readonly string[];
  /** 判活所需的登录族在场枚数；`>1` 时单枚在场只算"候选"，判 `unknown` 而不算数。 */
  authMinPresence: number;
};

/**
 * 判定依据（机器码，进日志与事件，不进句子）：
 * - `auth_present`：登录族在场枚数达标；
 * - `expired`：登录族有 cookie 但全部已过期；
 * - `missing`：分区里没有任何 cookie；
 * - `guest_only`：只见游客族 ⇒ 游客态；
 * - `not_calibrated`：该平台没有登记登录族 ⇒ 无法判定；
 * - `below_presence`：在场枚数不足 ⇒ 只算候选，不敢判活；
 * - `unmapped`：有 cookie 但两族都不沾 ⇒ 无法判定（可能是站点改版）。
 *
 * 顺序有含义：`reasons` 里第一条就是决定性那条，事件取的是它（`sessionExpiredReason`）。
 */
export type AuthReason =
  'auth_present' | 'expired' | 'missing' | 'guest_only' | 'not_calibrated' | 'below_presence' | 'unmapped';

/**
 * 判定结果。
 *
 * `auth` 三态而不是两态：`unknown` 是"我没有足够证据说话"，它既不授权动作（一切判据都写
 * `=== 'active'`），也不触发重新登录的接管循环。`expiresAt` 是**绑定约束**那条时间线：
 * 达标在场里有任一会话型 cookie（无过期时间）就报 null（界面显示"无期限"），否则取最早过期的那一枚。
 */
export type AuthVerdict = {
  auth: SessionAuthStatus;
  reasons: AuthReason[];
  expiresAt: number | null;
};

/** 会话型 cookie（没有过期时间）在场即为真；比较基准由调用方给，测试传固定值。 */
function isLive(cookie: CookieSummary, nowMs: number): boolean {
  return cookie.expiresAt === null || cookie.expiresAt > nowMs;
}

/**
 * 按信号族判定某平台的登录态。
 * @param cookies 该分区里的 cookie 摘要（顺序无关，只含名字与过期时间）
 * @param signals 该平台的信号标定（登录族 / 游客族 / 判活枚数下限）
 * @param nowMs 判定基准时间戳（毫秒），调用方传 `Date.now()`
 * @returns 三态判定 + 决定性依据在首位的 `reasons` + 绑定约束的过期时间
 */
export function judgeAuth(cookies: readonly CookieSummary[], signals: AuthSignals, nowMs: number): AuthVerdict {
  if (signals.authCookieNames.length === 0) {
    return { auth: 'unknown', reasons: ['not_calibrated'], expiresAt: null };
  }
  const authFamily = cookies.filter((cookie) => signals.authCookieNames.includes(cookie.name));
  const present = authFamily.filter((cookie) => isLive(cookie, nowMs));
  // **按名字去重再计数**：同一枚票据可以同时挂在站点主域与主机上（`.zhipin.com` 与 `www.zhipin.com`），
  // 直接数行数会让 `authMinPresence: 2` 被一个名字凑满，于是"至少两枚独立信号"这条保守判据形同虚设。
  const presentNames = new Set(present.map((cookie) => cookie.name));
  if (presentNames.size >= signals.authMinPresence) {
    // 会话型 cookie 没有期限可报；有期限的那些里，最早过期的那枚决定登录态还能用多久。
    const expiries = present.map((cookie) => cookie.expiresAt).filter((value): value is number => value !== null);
    return {
      auth: 'active',
      reasons: ['auth_present'],
      expiresAt: expiries.length === present.length ? Math.min(...expiries) : null,
    };
  }
  if (present.length > 0) {
    // 见过登录票据、但在场名字数不足：单枚（且语义未核实的那族）不足以判活，也不能反过来说人没登录。
    return { auth: 'unknown', reasons: ['below_presence'], expiresAt: null };
  }
  if (authFamily.length > 0) {
    const stale = authFamily.map((cookie) => cookie.expiresAt).filter((value): value is number => value !== null);
    return { auth: 'expired', reasons: ['expired'], expiresAt: stale.length > 0 ? Math.max(...stale) : null };
  }
  if (cookies.length === 0) return { auth: 'expired', reasons: ['missing'], expiresAt: null };
  const onlyGuest = cookies.every((cookie) => signals.guestCookieNames.includes(cookie.name));
  if (onlyGuest) return { auth: 'expired', reasons: ['guest_only'], expiresAt: null };
  return { auth: 'unknown', reasons: ['unmapped'], expiresAt: null };
}

/**
 * 把一条失效判定收成 `session/expired` 的原因码。
 *
 * 事件侧只有两个码是既有界面与接管文案认得的（`missing` = 没有会话 cookie、`expired` = 有但过期了），
 * 而判定侧的细分码（`guest_only` 等）只进日志：游客态在事件语义上就是"没有会话 cookie"，
 * 为它加第三个码会让接管文案、工作流停止原因跟着长一份没人写的翻译（§2.6 不为假想的未来做抽象）。
 * @param verdict 判定为 `expired` 的那一份读数
 * @returns 界面与接管用的原因码
 */
export function sessionExpiredReason(verdict: AuthVerdict): SessionExpiredEvent['reason'] {
  return verdict.reasons[0] === 'expired' ? 'expired' : 'missing';
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
