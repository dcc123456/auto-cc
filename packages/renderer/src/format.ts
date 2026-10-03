/**
 * 渲染层各面板共用的读数格式化。
 *
 * 抽出来是因为「时间戳 → 本地时间」在会话、定位、抓取三个面板里已经是第三次出现（AGENTS.md §2.2）；
 * 占位文案由调用方从 i18n 取，本模块不碰翻译，所以它仍是一个纯格式化函数。
 * 5.4-c 起这里还放「步下标 → 第几步」那一处夹法：它同样只是读数格式化，句子仍归语言包。
 */

/**
 * 时间戳 → 本地可读时间。
 * @param ms 毫秒时间戳；null 表示「这个时刻不存在」（如无期限 cookie、只抓到摘要的岗位）
 * @param noneLabel ms 为 null 时替换显示的文案
 * @returns 本地化日期时间串，或 noneLabel
 */
export const formatClock = (ms: number | null, noneLabel: string): string =>
  ms === null ? noneLabel : new Date(ms).toLocaleString();

/**
 * 主进程的步下标 → 界面上的「第几步」（1 起）。
 *
 * 抽出来是因为这个夹法在渲染层是第二次出现（AGENTS.md §2.2）：`done` 时游标等于步数（越界一位），
 * 直接 +1 会画出「第 3 / 2 步」；实验台（`WorkflowLabPanel`）先撞上过，对话侧的运行卡（5.4-07）是第二个用户。
 * @param stepIndex 主进程给的当前步下标；`idle` / `paused` 时指向要跑的那一步
 * @param total 这次 run 的总步数（格子数就是当前计划的节点数）
 * @returns 1 起的步号；`total` 为 0 时给 0——一格都没有时不该显示「第 1 / 0 步」
 */
export const displayStepNumber = (stepIndex: number, total: number): number =>
  total === 0 ? 0 : Math.min(stepIndex + 1, total);
