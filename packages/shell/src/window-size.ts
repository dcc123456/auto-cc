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

/** 允许的最小/最大边长（挡住 0 与离谱值，避免把窗口建成一个点）。 */
const MIN_SIDE = 320;
const MAX_SIDE = 7680;

/**
 * 解析 `AUTO_CC_WINDOW_SIZE`（形如 `1024x768`）。
 * @param raw 环境变量原文；未设置或非法时返回 null
 * @returns 合法尺寸；非法（缺一边、非数字、越界）一律 null —— 调用方退回默认值并记一行日志
 */
export function parseWindowSize(raw: string | undefined): { width: number; height: number } | null {
  if (raw === undefined) return null;
  const match = /^\s*(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$/i.exec(raw);
  if (match === null) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < MIN_SIDE || height < MIN_SIDE || width > MAX_SIDE || height > MAX_SIDE) return null;
  return { width, height };
}
