/**
 * 岗位屏抓取的平台选择判定（spec 2.3-12）。
 *
 * 抽成纯函数是因为这一条规则要能被单测钉住：只有一个可抓取平台时**不摆选择器**、直接挂它；
 * 多个平台时才让人挑。判定与派生都只依赖入参，不碰 React，也不读主进程。
 */

/**
 * 界面该不该出现平台选择。
 * @param platforms 可抓取平台标识清单（`jd.capture.status().platforms`）
 * @returns 平台多于一个时为 true；零个或一个时为 false
 */
export const shouldOfferPlatformChoice = (platforms: string[]): boolean => platforms.length > 1;

/**
 * 解析本次实际要挂载并搜索的平台。
 *
 * 优先级：人选的（且仍在清单里）→ 配置默认平台（且仍在清单里）→ 清单第一条。
 * 旧选择失效时静默落回默认，避免拿一个已被摘掉的平台去开视图。
 * @param platforms 可抓取平台标识清单
 * @param preferred 服务配置的默认平台（`jd.capture.status().platform`）
 * @param draft 人在下拉里选过的平台；空串表示还没选过
 * @returns 目标平台标识；清单为空时是空串（交给释放路径给出结构化错误）
 */
export const resolveCapturePlatform = (platforms: string[], preferred: string, draft: string): string => {
  if (draft !== '' && platforms.includes(draft)) return draft;
  if (preferred !== '' && platforms.includes(preferred)) return preferred;
  return platforms[0] ?? '';
};

/**
 * 这一条会话是不是本机仿站（演示平台）。
 *
 * 新手界面上只该出现真实平台（spec 10.10-10）：干净实例里同时列出 `fixture` / `fixture-alt` / `boss`
 * 三行，走查人以为"我有三个账号"。判据用会话自己的 `startUrl` 主机名，而不是把平台 id 写死成名单——
 * 换一台机器的仿站端口或再加一只演示平台都不用改这里。
 * @param startUrl 会话的起始地址（`sessions.status()` 里那一份）
 * @returns 主机是本机回环地址时为 true；空串/形状不可解析时按"不是演示"处理（宁可多显示一行，也不藏掉真平台）
 */
export const isLocalSessionUrl = (startUrl: string | undefined): boolean => {
  if (!startUrl) return false;
  try {
    const host = new URL(startUrl).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
};
