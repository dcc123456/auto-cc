/**
 * 导航许可判定（spec 2.1-03 / 2.1-04 的安全边界；2026-11-22 用户裁定后只剩协议一道）。
 *
 * 裁定原文：「内嵌的就是一个真实 chrome 浏览器，会记录登录态，不需要切换」——所以这里**不再有**
 * 已登记平台名单，也不再有非回环源的风险签字：任意 http(s) 地址都可达，翻页、开详情、进第三方
 * 文档页都是同一个浏览器的正常工作，不该要求用户先「切成任意网页」。
 *
 * 留下的这一条是确定性的红线，与「信任谁」无关：`javascript:` 在页面上下文里就是脚本执行，
 * `data:` / `file:` 是本地文档与本地文件读取，它们都不是「一个网页」。地址是渲染层传来的不可信
 * 输入，所以仍要过一遍协议判定，而不是直接把字符串交给内核。
 *
 * 安全边界因此移到**按来源判动作**：未登记来源上的点击/输入/提交要用户确认一次（走既有
 * `agent.pause` 审批）；外发仍只走平台适配器 + 授权单 + 额度闸门。两者都不再靠「能不能打开
 * 这个地址」来挡，所以名单不在这里复活。
 */
import { AppError, isLoopbackHost } from '@auto-cc/core';

/** 可导航的协议：`javascript:` 与 `data:` 在页面上下文里就是脚本执行，不能当导航目标。 */
const NAVIGABLE_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * 回环主机名（2026-11-24 红线事故后的默认许可面）。
 *
 * 事故经过：一份副本实例的 `platform-boss.pack` 仍是 `real`，取证脚本一次 `jd.capture.run`
 * 就把自动化导航带到了真实招聘站点并抓了一屏。规则一直写着「自动化永不访问真实平台」，但它只靠人记住。
 * 所以默认许可面收成回环地址：**自动化**只能在本机靶站上跑，真实站点由人自己在视图里点。
 */
/**
 * 自动化导航的目标判定：非回环地址一律拒绝，除非装配侧显式放行。
 *
 * 为什么闸在导航这一处：抓取、打招呼、投递、工作流节点全部要先把内核视图导到目标页，
 * 这里是自动化唯一绕不过去的咽喉；放在每个能力包里就要各写一遍，早晚漏一处。
 * @param rawUrl 自动化给出的地址（不可信输入）
 * @param allowRealHosts 装配侧的显式放行（人工在场时才该为 true）
 * @returns 允许导航的目标 URL
 * @throws `NAVIGATE_URL_REJECTED` 协议/解析不合；`REAL_PLATFORM_AUTOMATION_BLOCKED` 非回环且未放行
 */
export { isLoopbackHost };

export function resolveAutomationUrl(rawUrl: string, allowRealHosts: boolean): URL {
  const parsed = resolveNavigableUrl(rawUrl);
  if (allowRealHosts || isLoopbackHost(parsed.hostname)) return parsed;
  throw new AppError(
    'REAL_PLATFORM_AUTOMATION_BLOCKED',
    `自动化不导航到非本机地址：${parsed.href}（host ${parsed.hostname}）。真实平台只由人自己在视图里操作；` +
      '确需人工在场跑自动化，先由装配侧显式打开 allowRealAutomation',
    'browser',
    { url: parsed.href, host: parsed.hostname },
  );
}

/**
 * 校验并解析一次导航目标。
 * @param rawUrl 渲染层/调用方给出的地址（不可信输入）
 * @returns 解析后的 URL 对象（协议与主机名已规整，交给内核实参用 `href`）
 * @throws 地址解析失败或协议不在 http/https 内时 `NAVIGATE_URL_REJECTED`；
 *         details 里带回被拒的地址，便于界面直接显示
 */
export function resolveNavigableUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AppError('NAVIGATE_URL_REJECTED', `地址无法解析：${rawUrl}`, 'browser', { url: rawUrl });
  }
  if (!NAVIGABLE_PROTOCOLS.has(parsed.protocol)) {
    throw new AppError('NAVIGATE_URL_REJECTED', `不允许的协议 ${parsed.protocol}（只允许 http/https）`, 'browser', {
      url: rawUrl,
    });
  }
  return parsed;
}
