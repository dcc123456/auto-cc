/**
 * 导航许可判定（spec 2.1-03 / 2.1-04 的安全边界，P8 8.1-05 改口径）。
 *
 * 渲染层传来的 URL 是**不可信输入**：视图跑的是外部站点，让它跳去任意地址等于把内嵌内核
 * 变成自由浏览器（AGENTS.md §8.1 的默认拒绝精神）。许可口径是「只能去已登记平台声明的源」——
 * 同源之内翻页、进详情、开聊天都是正常工作流，跨源一律拒绝。
 *
 * 名单来源从「`sessions` 里那条 startUrl 的 origin」换成「适配器知识包里的 `origins`」，
 * 因为 startUrl 只是**首屏地址**（一个源），而真实平台常有登录域与主域两个源，
 * 那两个源都该由站点知识说话，不该由装配清单的一行地址决定。
 *
 * 第二道闸门：源不是本地回环时，还要求该平台存在 `automation:<platform>` 签字（spec 2.7-06 的
 * 同一份真相，走 `sessions.hasConsent`，不新建签字表）。回环豁免是刻意的——本地仿站是自动化验收面
 * （AGENTS.md §7.2），它没有「风险确认」这回事，豁免它才不至于把测试面逼成造假签字。
 */
import { AppError } from '@auto-cc/core';

/** 可导航的协议：`javascript:` 与 `data:` 在页面上下文里就是脚本执行，不能当导航目标。 */
const NAVIGABLE_PROTOCOLS = new Set(['http:', 'https:']);

/** 回环主机名：这一类的源不需要签字即可导航（本地仿站是验收面，见文件头）。 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** 许可判定眼里的一个平台：名字用来查签字，`origins` 用来划范围。 */
export type NavigablePlatform = { id: string; origins: string[] };

/**
 * 判定一个源是否属于「不需要签字」的本地回环。
 * @param hostname 已解析 URL 的主机名（不含端口，IPv6 带方括号）
 * @returns 回环为 true
 */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * 校验并解析一次导航目标。
 * @param rawUrl 渲染层/调用方给出的地址（不可信）
 * @param platforms 已登记平台及其声明的可导航源（`platform.registry.list()` 的投影，知识包是唯一来源）
 * @param consentedPlatformIds 其中已签过 `automation:<platform>` 风险确认的平台名；真源不在其内就拒
 * @returns 解析后的 URL 对象
 * @throws 协议不允许 / 地址解析失败 / 源不在登记平台里时 `NAVIGATE_URL_REJECTED`；
 *         源已登记但该平台没签字时 `CONSENT_REQUIRED`（带平台名，界面按名字插进文案）。
 *         details 里带回被拒的地址与允许的源，便于界面直接显示
 */
export function resolveNavigableUrl(
  rawUrl: string,
  platforms: NavigablePlatform[],
  consentedPlatformIds: string[] = [],
): URL {
  const allowedOrigins = platforms.flatMap((platform) => platform.origins);
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AppError('NAVIGATE_URL_REJECTED', `地址无法解析：${rawUrl}`, 'browser', { allowedOrigins });
  }
  if (!NAVIGABLE_PROTOCOLS.has(parsed.protocol)) {
    throw new AppError('NAVIGATE_URL_REJECTED', `不允许的协议 ${parsed.protocol}（只允许 http/https）`, 'browser', {
      url: rawUrl,
      allowedOrigins,
    });
  }
  const owner = platforms.find((platform) => platform.origins.includes(parsed.origin));
  if (!owner) {
    throw new AppError('NAVIGATE_URL_REJECTED', `目标源 ${parsed.origin} 不属于任何已登记平台`, 'browser', {
      url: rawUrl,
      allowedOrigins,
    });
  }
  if (!isLoopbackHost(parsed.hostname) && !consentedPlatformIds.includes(owner.id)) {
    throw new AppError('CONSENT_REQUIRED', `平台 ${owner.id} 还没有一份自动化风险确认记录，不予导航`, 'browser', {
      platform: owner.id,
      url: rawUrl,
    });
  }
  return parsed;
}
