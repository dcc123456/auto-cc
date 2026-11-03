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
