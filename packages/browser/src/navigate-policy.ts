/**
 * 导航许可判定（spec 2.1-03 / 2.1-04 的安全边界）。
 *
 * 渲染层传来的 URL 是**不可信输入**：视图跑的是外部站点，让它跳去任意地址等于把内嵌内核
 * 变成自由浏览器（AGENTS.md §8.1 的默认拒绝精神）。这里的许可口径是「只能去已登记平台的
 * 同源页面」——同源之内翻页、进详情、开聊天都是正常工作流，跨源一律拒绝。
 */
import { AppError } from '@auto-cc/core';

/** 可导航的协议：`javascript:` 与 `data:` 在页面上下文里就是脚本执行，不能当导航目标。 */
const NAVIGABLE_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * 校验并解析一次导航目标。
 * @param rawUrl 渲染层/调用方给出的地址（不可信）
 * @param startUrls 已在 `sessions` 登记的平台起始地址集合，取其 origin 作为许可名单
 * @returns 解析后的 URL 对象
 * @throws 协议不允许 / 地址解析失败 / 源不在登记平台里时，以 `NAVIGATE_URL_REJECTED` 结构化失败，
 *         details 里带回被拒的地址与允许的源，便于界面直接显示
 */
export function resolveNavigableUrl(rawUrl: string, startUrls: string[]): URL {
  const allowedOrigins = startUrls.map((startUrl) => new URL(startUrl).origin);
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
  if (!allowedOrigins.includes(parsed.origin)) {
    throw new AppError('NAVIGATE_URL_REJECTED', `目标源 ${parsed.origin} 不属于任何已登记平台`, 'browser', {
      url: rawUrl,
      allowedOrigins,
    });
  }
  return parsed;
}
