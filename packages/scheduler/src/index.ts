/**
 * `@auto-cc/plugin-scheduler` 的唯一对外出口（AGENTS.md §4.2）。
 *
 * `internal/cron.ts` 不在这里复导出：cron 表达式求值只有本包用得到，
 * 把它摆到包口就等于给别的包开一条"顺手解析 cron"的路，而 §2.7 禁止第二套同类基础设施时
 * 首先需要看得见"第一套在哪"——它现在只在一个文件里。
 */
export {
  SCHEDULE_MIGRATION_VERSION,
  SCHEDULE_MISSED_REASON,
  SCHEDULE_OUTBOUND_ACTIONS,
  ScheduleRegistryService,
  scheduleSchema,
  type CreateScheduleJobInput,
  type ScheduleConfig,
} from './registry.js';
export type {
  ScheduleJobView,
  ScheduleLaunchPort,
  ScheduleQuotaPort,
  ScheduleTriggerResult,
  ScheduleTriggerView,
} from './types.js';
