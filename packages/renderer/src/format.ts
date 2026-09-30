/**
 * 渲染层各面板共用的读数格式化。
 *
 * 抽出来是因为「时间戳 → 本地时间」在会话、定位、抓取三个面板里已经是第三次出现（AGENTS.md §2.2）；
 * 占位文案由调用方从 i18n 取，本模块不碰翻译，所以它仍是一个纯格式化函数。
 */

/**
 * 时间戳 → 本地可读时间。
 * @param ms 毫秒时间戳；null 表示「这个时刻不存在」（如无期限 cookie、只抓到摘要的岗位）
 * @param noneLabel ms 为 null 时替换显示的文案
 * @returns 本地化日期时间串，或 noneLabel
 */
export const formatClock = (ms: number | null, noneLabel: string): string =>
  ms === null ? noneLabel : new Date(ms).toLocaleString();
