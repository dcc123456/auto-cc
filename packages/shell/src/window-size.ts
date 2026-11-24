/**
 * 启动窗口尺寸的取证通道（2026-11-23 裁定）。
 *
 * 为什么需要：31「窗口缩放后视图自适应」要 1024/1280/1600 三档读数，而 Electron 的 CDP **没有 `Browser` 域**
 * （`Browser.getWindowForTarget` 不存在），`osascript` 要辅助访问权限，`Emulation.setDeviceMetricsOverride`
 * 改的是页面视口、不是真实窗口——用它取三档会得到「视图右沿被夹在 1200、页面 innerWidth 与 bounds 不成比例」
 * 的自相矛盾读数，等于用不同步的通道判同步。所以给一个**只影响初始尺寸**的环境变量：
 * 起三次实例各取一档，完全走真实窗口路径；用户在场时再做一次真实拖拽对照。
 *
 * 边界：只读环境变量、只影响 `BrowserWindow` 的初始 width/height，不加 UI、不加菜单、不影响后续任何行为。
 */

/** 默认窗口尺寸（与本服务原先写死的 1200×800 一致）。 */
export const DEFAULT_WINDOW_SIZE = { width: 1200, height: 800 } as const;

/**
 * 主窗口的最小尺寸（2026-11-24 裁定，采纳设计师 §12 的建议）。
 *
 * 为什么：更窄的窗口不是「另一种布局」，是整窗退化——299 宽时标题竖排成一字一行、卡片正文一列一字；
 * 为它继续调壳层是拿产品去迁就不可用态。所以把最小尺寸钉在 720×560（720 宽时筛选区仍有 1 列可用、
 * 详情卡 footer 不折行），比它更窄的窗口从此不进产品。这个下限只管**主窗口**：打印用的隐藏窗口不受影响。
 */
export const MIN_WINDOW_SIZE = { width: 720, height: 560 } as const;

/** 允许的最大边长（挡住离谱值；下界由 {@link clampWindowSize} 抬到最小窗口，不在解析里判非法）。 */
const MAX_SIDE = 7680;

/**
 * 把请求尺寸抬到最小窗口尺寸之上。
 *
 * 为什么不在解析器里直接判非法：`AUTO_CC_WINDOW_SIZE` 是取证通道，写了 `299x900` 的人要的是
 * 「最小的可用窗口」而不是「静默回到 1200」。所以解析只管语法与离谱边界，这里按最小尺寸抬升，
 * 调用方看到被抬升就记一行日志——读数与请求不一致时，日志里有原因。
 * @param size 已通过语法校验的请求尺寸（可以小于最小窗口）
 * @returns 宽高都不低于 {@link MIN_WINDOW_SIZE} 的尺寸
 */
export function clampWindowSize(size: { width: number; height: number }): { width: number; height: number } {
  return {
    width: Math.max(size.width, MIN_WINDOW_SIZE.width),
    height: Math.max(size.height, MIN_WINDOW_SIZE.height),
  };
}

/**
 * 解析 `AUTO_CC_WINDOW_SIZE`（形如 `1024x768`）。
 * @param raw 环境变量原文；未设置或非法时返回 null
 * @returns 语法合法且在最大边界内的尺寸（**不判「过小」**：过小由调用方按最小窗口抬升）；非法一律 null
 */
export function parseWindowSize(raw: string | undefined): { width: number; height: number } | null {
  if (raw === undefined) return null;
  const match = /^\s*(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$/i.exec(raw);
  if (match === null) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width > MAX_SIDE || height > MAX_SIDE) return null;
  return { width, height };
}
