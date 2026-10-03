/**
 * cron 表达式 → 下一个计划时刻（毫秒）的唯一封装点。
 *
 * 本文件是 `packages/scheduler` 里**唯一**允许 `import 'cron-parser'` 的地方（§4.2 的 internal 分区），
 * 原因是本机 spike 实测到的三处非直观行为（plan §7.5.2）：
 * ① 默认按**运行机器本地时区**算，`0 9 * * 1-5` 在 UTC+8 机器上得到的是本地周一 09:00，不是 UTC 09:00；
 * ② `.next()` 返回的是库自己的 `CronDate`，**不是 `Date` 实例**（`toUTCString()` 不存在），只有 `.toDate()` 可靠；
 * ③ `.next()` 会推进表达式对象自身的游标，所以每次求值都重新 `parse`，不把实例存下来复用。
 * 把这三条收在一个文件里，将来换库只动这里，服务侧只见 `number`。
 */
import { AppError } from '@auto-cc/core';
import { CronExpressionParser } from 'cron-parser';

/**
 * 求 `expression` 在 `fromMs` 之后的第一个计划时刻。
 *
 * 时区口径：按运行机器本地时区（求职者的"每天早上 9 点"就是他手表上的 9 点），不传 `tz` 选项。
 * 这一个调用同时承担**校验**职责：cron-parser 在 `parse` 阶段就会拒掉语法错的表达式与永不成立的日期
 * （实测 `0 0 31 2 *` 即 2 月 31 日抛 `Invalid explicit day of month definition`），
 * 所以建任务那一刻就能结构化失败，而不是等到夜里触发时才发现任务从来没跑过。
 * @param expression 五段或六段 cron 表达式（`0 9 * * 1-5` / `@daily` / `0 0 9 * * *`），来自界面或配置文件，按不可信输入处理
 * @param fromMs 计算基准时间戳（毫秒），语义是"严格晚于这一刻的第一个计划点"
 * @returns 下一个计划时刻的毫秒时间戳（绝对时间点，与时区无关）
 * @throws 表达式语法不合法、或该表达式永不成立时以 `INVALID_ARGUMENT` 失败，`details` 带回库原话
 */
export function nextRunAtMs(expression: string, fromMs: number): number {
  try {
    // 传 ISO 串而不是 Date：spike 实测 `currentDate` 认 ISO 串，且它被当作**绝对瞬间**解释
    // （给 '2026-10-03T15:00:00Z' 得到的是本地周一 09:00），这正是"从此刻往后算"要的语义。
    const expression0 = CronExpressionParser.parse(expression, { currentDate: new Date(fromMs).toISOString() });
    return expression0.next().toDate().getTime();
  } catch (error) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `定时表达式不可用（${expression}）：${error instanceof Error ? error.message : String(error)}`,
      'schedule.registry',
      { expression, reason: error instanceof Error ? error.message : String(error) },
    );
  }
}
