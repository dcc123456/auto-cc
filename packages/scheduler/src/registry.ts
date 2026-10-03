/**
 * `schedule.registry` 服务（spec 5.7-05 / 06 / 07 / 08 / 09 / 10）：
 * 定时任务的唯一登记处 + **进程内**触发器。
 *
 * 三条形状约束决定了这个类的大部分写法：
 * ① 它只会一件事——"拿一个已保存工作流的 id 起跑"（经 `ScheduleLaunchPort`），
 *    所以 5.7-07「无人值守下不临场规划外发」是结构事实：端口上没有 goal，也没有 agent 循环（plan §7.5.3 决策三）。
 * ② 每一次触发都追加一行读数（5.7-06），所以"失败/跳过有没有影响下一次"答得出、也标得出（5.7-09）。
 * ③ 定时器只有这里的一个 `setInterval`，不注册任何操作系统的计划任务（5.7-10，
 *    由 `scripts/check-scheduler-no-external-cron.ts` 机检；那个脚本扫本包源码里的外部任务写入通道）。
 *
 * 它**不 import** `workflow` / `entitlement` / `outbound` 三个同级包（§4.1），一律经 `maybeService` 按名字现问——
 * §9 的 2.5 实测教训：在本地存第二份事实（哪怕是配置）会静默变空。
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError, Service, asApp, maybeService, type Context } from '@auto-cc/core';
import type { StoreService } from '@auto-cc/plugin-store';
import { z } from 'zod';
import { nextRunAtMs } from './internal/cron.js';
import type {
  ScheduleJobView,
  ScheduleLaunchPort,
  ScheduleQuotaPort,
  ScheduleThrottlePort,
  ScheduleTriggerResult,
  ScheduleTriggerView,
} from './types.js';

/**
 * 迁移号段 **25**（5.7-a 起）：`schedule_jobs` + `schedule_triggers`。
 *
 * 为什么两张而不是一张（plan §7.5.3 决策二）：`workflow_plans` 答"怎么跑"，
 * 任务答"什么时候跑"，触发记录答"每一次实际怎么样了"——三种生命周期。
 * 把结果写在 job 行上就只剩"最后一次"的读数，而 5.7-06 的"失败不影响下次"与 5.7-09 的"已跳过（原因）"
 * 都只有**追加记录**才能证明。
 */
export const SCHEDULE_MIGRATION_VERSION = 25;

/** 两张表一支号段；`down` 与本仓其余号段同一口径不写（回滚会显式失败而不是静默跳过）。 */
const scheduleMigration = {
  version: SCHEDULE_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS schedule_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      expression TEXT NOT NULL,
      is_enabled INTEGER NOT NULL,
      next_run_at INTEGER,
      last_planned_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    // tick 每次都是"取所有启用任务里到点的那几条"，没这条索引就是全表扫（任务条数小，但 tick 每分钟都跑）。
    db.exec('CREATE INDEX IF NOT EXISTS schedule_jobs_enabled_next ON schedule_jobs (is_enabled, next_run_at)');
    db.exec(`CREATE TABLE IF NOT EXISTS schedule_triggers (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      planned_at INTEGER NOT NULL,
      fired_at INTEGER,
      result TEXT NOT NULL,
      reason TEXT,
      workflow_run_id TEXT,
      created_at INTEGER NOT NULL
    )`);
    // 界面与 5.7-06 的断言都要"看某条任务最近的触发史"，按 (job_id, created_at) 取最近若干条。
    db.exec('CREATE INDEX IF NOT EXISTS schedule_triggers_job_ts ON schedule_triggers (job_id, created_at)');
  },
};

/**
 * 起跑前预检（额度 + 频控）用的动作名单。
 *
 * 只列外发两条（不打 `search`）：抓取失败顶多白跑一趟，外发被拒却会留下一条**半截的 run**——
 * 后者才是 5.7-08 要的"额度用尽即跳过并记账"。`search` 不进名单还有个具体理由：它的节奏是页面动作那一档
 * （`nextScrollGapMs`，秒级），而 `outbound.throttle.checkGap` 只认外发两条、陌生动作名直接结构化失败，
 * 所以将来往这里加第三条时不会悄悄拿到一个错误区间的预检。
 * 名单是本包私有的常量而不是从契约包 import，因为本包不依赖那个包（§4.1）；两处预检用同一份名单，不靠复制。
 */
export const SCHEDULE_OUTBOUND_ACTIONS = ['greet', 'deliver'] as const;

/** 重启补记跳过时的拒因原文（界面上"已跳过"那一行显示的就是它）。 */
export const SCHEDULE_MISSED_REASON = 'app 关闭期间越过了这个计划点，按不补跑的约定跳过';

/** 配置：只有 tick 间隔一项可调（时钟是方法入参，见 `tick` / `accountForMissedRuns` 的注释）。 */
export const scheduleSchema = z.strictObject({
  /** 进程内 tick 的间隔（毫秒）。下限 1 秒是防止把主进程打成忙轮询。 */
  tickIntervalMs: z.number().int().min(1000).default(60_000),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type ScheduleConfig = z.infer<typeof scheduleSchema>;

/** 建任务入参的边界校验（渲染层是不可信来源，AGENTS.md §2.6）。 */
const createJobSchema = z.strictObject({
  name: z.string().trim().min(1).max(60),
  /** 已保存工作流的 id——这里**没有**给自由对话任务留任何形状，5.7-07 的守口就在这里 */
  planId: z.string().min(1),
  expression: z.string().trim().min(1),
  /** 缺省即启用：建完就等着跑是这类任务的常识语义 */
  isEnabled: z.boolean().default(true),
});

/** 建任务入参（`isEnabled` 可省）。 */
export type CreateScheduleJobInput = z.input<typeof createJobSchema>;

/** `schedule_jobs` 的一行原始读数（snake_case 列名，转视图的工作收在 `toJobView`）。 */
type JobRow = {
  id: string;
  name: string;
  plan_id: string;
  expression: string;
  is_enabled: number | bigint;
  next_run_at: number | bigint | null;
  last_planned_at: number | bigint | null;
  created_at: number | bigint;
  updated_at: number | bigint;
};

/** `schedule_triggers` 的一行原始读数。 */
type TriggerRow = {
  id: string;
  job_id: string;
  planned_at: number | bigint;
  fired_at: number | bigint | null;
  result: string;
  reason: string | null;
  workflow_run_id: string | null;
  created_at: number | bigint;
};

/** 数值列的统一收口：node:sqlite 在 INTEGER 上会给 `bigint`，视图一律交 `number`。 */
function toMs(value: number | bigint | null): number | null {
  if (value === null) return null;
  return Number(value);
}

/** 结局列的收窄：库里只允许这三个值，读到别的就是数据被外部改过——按 `failed` 报而不是当没发生。 */
function toResult(value: string): ScheduleTriggerResult {
  return value === 'started' || value === 'skipped' ? value : 'failed';
}

export class ScheduleRegistryService extends Service {
  static provide = 'schedule.registry';
  static Config = scheduleSchema;
  // 只依赖 store：起跑口与闸门都用时现问（§9 的 2.5 实测：inject 同级服务会让热改配置把本服务一起重建）。
  static inject = ['store'];

  private readonly options: ScheduleConfig;

  constructor(ctx: Context, options: ScheduleConfig) {
    // 必须接住第二个实参：cordis 递的是校验后的配置，只声明一个参数会让调用点报 TS2345（AGENTS.md §9 的 1.3 实测）。
    super(ctx, 'schedule.registry');
    this.options = options;
  }

  private get store(): StoreService {
    return asApp(this.ctx).store;
  }

  /**
   * 建一条定时任务：先验表达式、再验计划 id，两步都过了才落库。
   *
   * 校验放在落库之前是刻意的——一条"表达式永远不成立"（如 2 月 31 日）或"计划 id 不存在"的任务
   * 如果进了表，它只会安静地从不触发，用户要到很多天以后才发现。cron-parser 在 `parse` 阶段就抛，
   * 起跑口那边 `plans()` 也当场答得出 id 在不在，所以这里能做到"建的时候就知道"。
   * @param input 任务名、已保存工作流的 id、cron 表达式、可选的启用位（缺省启用）
   * @returns 落库后的任务视图，`nextRunAt` 已按当时算好
   * @throws 表达式不合法或永不成立、`planId` 不在可起跑清单里、起跑口未挂载时，均以 `INVALID_ARGUMENT` 失败且不落库
   */
  createJob = (input: CreateScheduleJobInput): ScheduleJobView => {
    const parsed = createJobSchema.safeParse(input);
    if (!parsed.success) {
      // 形状错也收在同一个码上：`strictObject` 会把界面上多塞的键（比如想让它"顺手跑一段对话"的 `goal`）
      // 报成 unrecognized key，这条原话正是 5.7-07 想留下的证据，不要把它压成一句"参数不合法"。
      throw new AppError(
        'INVALID_ARGUMENT',
        `定时任务入参不合法：${parsed.error.issues[0]?.message ?? ''}`,
        'schedule.registry',
      );
    }
    const nowMs = Date.now();
    const firstRunAt = nextRunAtMs(parsed.data.expression, nowMs);
    this.requireKnownPlan(parsed.data.planId);
    const id = randomUUID();
    this.store.db
      .prepare(
        `INSERT INTO schedule_jobs (id, name, plan_id, expression, is_enabled, next_run_at, last_planned_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        parsed.data.name,
        parsed.data.planId,
        parsed.data.expression,
        parsed.data.isEnabled ? 1 : 0,
        firstRunAt,
        nowMs,
        nowMs,
      );
    return this.job(id);
  };

  /**
   * 全部任务，按"下一次什么时候跑"升序；停用任务排最后（它没有下一次）。
   * @returns 任务视图数组，空表就是空数组而不是 null
   */
  jobs = (): ScheduleJobView[] => {
    const rows = this.store.db
      .prepare('SELECT * FROM schedule_jobs ORDER BY next_run_at IS NULL, next_run_at, created_at')
      .all() as unknown as JobRow[];
    return rows.map((row) => this.toJobView(row));
  };

  /**
   * 启用/停用一条任务。
   *
   * 重新启用时**按当时重算下一次**而不是沿用旧值：停用期间越过的那些点不该记成"错过"——
   * 用户把它停了就是不打算让它跑，把它变成一排红色"已跳过"是骗人。
   * @param jobId 任务 id
   * @param enabled 目标状态
   * @param nowMs 重算基准（毫秒），注入是为了让测试不真等；缺省取当前时间
   * @returns 变更后的任务视图
   * @throws id 不存在时以 `INVALID_ARGUMENT` 失败
   */
  setEnabled = (jobId: string, enabled: boolean, nowMs: number = Date.now()): ScheduleJobView => {
    const row = this.rowOf(jobId);
    const nextRunAt = enabled ? nextRunAtMs(row.expression, nowMs) : null;
    this.store.db
      .prepare('UPDATE schedule_jobs SET is_enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, nextRunAt, nowMs, jobId);
    return this.job(jobId);
  };

  /**
   * 删掉一条任务。触发历史**保留**（那是账，不跟着任务一起消失），只是此后不再有新增行。
   * @param jobId 任务 id
   * @returns 无；id 不存在时以 `INVALID_ARGUMENT` 失败
   */
  removeJob = (jobId: string): void => {
    const changes = this.store.db.prepare('DELETE FROM schedule_jobs WHERE id = ?').run(jobId).changes;
    if (Number(changes) === 0) {
      throw new AppError('INVALID_ARGUMENT', `没有这条定时任务：${jobId}`, 'schedule.registry', { jobId });
    }
  };

  /**
   * 某条任务最近的触发记录，按时间倒序。
   * @param jobId 任务 id；省略则返回全局最近（界面的"调度日志"用）
   * @param limit 最多几条，默认 20
   * @returns 触发记录视图；从没触发过就是空数组
   */
  triggers = (jobId?: string, limit = 20): ScheduleTriggerView[] => {
    const sql = jobId
      ? 'SELECT * FROM schedule_triggers WHERE job_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
      : 'SELECT * FROM schedule_triggers ORDER BY created_at DESC, id DESC LIMIT ?';
    const rows = (jobId
      ? this.store.db.prepare(sql).all(jobId, limit)
      : this.store.db.prepare(sql).all(limit)) as unknown as TriggerRow[];
    return rows.map((row) => this.toTriggerView(row));
  };

  /**
   * 一次 tick：把所有**到点**的启用任务各触发一次。
   * @param nowMs 判定基准（毫秒）。写成入参而不是内部调 `Date.now()`，是为了让 5.7-06 / 08 / 09 的时序
   *   能冻结时间断言（plan §7.5.3 决策六），而不是让测试真等一分钟。
   * @returns 本次触发的条数（0 表示无事发生）
   */
  tick = (nowMs: number = Date.now()): number => this.advanceDue(nowMs, 'due');

  /**
   * 重启后的追账：把关机期间越过的计划点**记成已跳过**，再把下一次推到当下之后。
   *
   * 这就是 5.7-09「不补跑」的全部实现：错过的点不补起跑（那会在没人看着的时候打出一排招呼），
   * 但也不假装没发生（那会让界面上"今天什么都没跑"和"今天跳过了三次"长成一个样）。
   * @param nowMs 判定基准（毫秒），同 `tick`
   * @returns 补记的条数
   */
  accountForMissedRuns = (nowMs: number = Date.now()): number => this.advanceDue(nowMs, 'missed');

  /**
   * 手工立刻触发一条任务（界面的"跑一次"、也是 spec 5.7-06 的验证方式）。
   *
   * 走的是与 tick **完全相同**的一条腿：额度预检查、起跑、落账、推进计划点都在，
   * 所以手工这条路不会成为一个绕过闸门的后门；它只是把"计划点"当成此刻。
   * @param jobId 任务 id
   * @param nowMs 时间基准（毫秒）
   * @returns 这一次的记录
   * @throws id 不存在时以 `INVALID_ARGUMENT` 失败
   */
  triggerNow = (jobId: string, nowMs: number = Date.now()): ScheduleTriggerView => {
    const row = this.rowOf(jobId);
    const trigger = this.launch(row, nowMs, nowMs, 'due');
    this.advance(row, nowMs, nowMs);
    return trigger;
  };

  [Service.init](): void {
    this.ensureSchema();
    // 挂载即追账：这一句同时是 5.7-09 的实现点与它的可演示性——重启后第一件事是把错过的点标出来，
    // 然后才开始正常 tick。放在定时器之前，是为了让第一次 tick 面对的是"已经对齐"的表。
    const missed = this.accountForMissedRuns();
    const timer = setInterval(() => {
      this.tick();
    }, this.options.tickIntervalMs);
    this.ctx.effect(() => () => clearInterval(timer));
    this.ctx.logger.info(
      `调度登记处就绪：tick ${String(this.options.tickIntervalMs)}ms（进程内，不写系统计划任务），补记跳过 ${String(missed)} 条`,
    );
  }

  /**
   * 把调度域的迁移登记进 `store.migrations` 并建表。
   * 幂等是硬要求：`plugins.start('schedule')` 会重新构造本服务，无条件 push 同一 version 会让
   * `runMigrations` 抛「迁移版本重复」（口径同 `packages/agent/src/session.ts` 的号段 24）。
   */
  private ensureSchema(): void {
    const migrations = this.store.migrations;
    if (!migrations.some((registered) => registered.version === scheduleMigration.version)) {
      migrations.push(scheduleMigration);
    }
    this.store.upgrade();
  }

  /**
   * 到点的任务统一处理，`reason` 决定"到点"是当触发还是当错过。
   * @param nowMs 判定基准（毫秒）
   * @param mode `'due'` = 正在运行中到点（起跑）；`'missed'` = 关机期间越过的点（补记跳过）
   * @returns 处理条数
   */
  private advanceDue(nowMs: number, mode: 'due' | 'missed'): number {
    const rows = this.store.db
      .prepare(
        'SELECT * FROM schedule_jobs WHERE is_enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at',
      )
      .all(nowMs) as unknown as JobRow[];
    for (const row of rows) {
      // plannedAt 取**当时存的计划点**而不是 nowMs：记录要说的是"哪个点被处理了"，
      // 5.7-09 的判据（越过的点标出来）全靠这一列，写成 now 就变成"跳过的时刻"，语义反了。
      const plannedAt = toMs(row.next_run_at) ?? nowMs;
      this.launch(row, plannedAt, nowMs, mode);
      this.advance(row, plannedAt, nowMs);
    }
    return rows.length;
  }

  /**
   * 单次触发的全部判定与落账。
   * @param job 任务原始行
   * @param plannedAt 本次对应的计划点（毫秒）
   * @param nowMs 动手时刻（毫秒）
   * @param mode `'due'` / `'missed'`，见 `advanceDue`
   * @returns 本次的触发记录（`started` / `skipped` / `failed` 三态之一，必落一行）
   */
  private launch(job: JobRow, plannedAt: number, nowMs: number, mode: 'due' | 'missed'): ScheduleTriggerView {
    if (mode === 'missed') return this.record(job.id, plannedAt, null, 'skipped', SCHEDULE_MISSED_REASON, null, nowMs);

    // 预检查只读闸门，不在这里记账也不在这里抛：真正的额度执行仍在节点里（§7.3）。
    // 明知第一步必死就别先起一个半途而废的 run——那会在无人值守时留下一条"跑到打招呼就停"的 run。
    const quota = maybeService<ScheduleQuotaPort>(this.ctx, 'entitlement.gate');
    if (quota) {
      for (const action of SCHEDULE_OUTBOUND_ACTIONS) {
        const decision = quota.check(action, { nowMs });
        if (!decision.allowed) {
          return this.record(
            job.id,
            plannedAt,
            nowMs,
            'skipped',
            decision.reason ?? `动作 ${action} 的额度已用完`,
            null,
            nowMs,
          );
        }
      }
    }

    // 频控预检（spec 5.7-08 的另一半边）：判据来自 `outbound.throttle` 自己——本包不复制间隔区间、
    // 也不自己算「还要等多久」，那两处都会成为第二套节奏事实（§2.7）。
    // 判序放在额度之后是有意的：额度是「今天彻底没了」，频控只是「再等一会儿」，
    // 界面读到前者要建议人改配置，读到后者只需知道下一跳照跑，两句拒因不许混成一句。
    const throttle = maybeService<ScheduleThrottlePort>(this.ctx, 'outbound.throttle');
    if (throttle) {
      for (const action of SCHEDULE_OUTBOUND_ACTIONS) {
        const gap = throttle.checkGap(action, { nowMs });
        if (!gap.allowed) {
          return this.record(
            job.id,
            plannedAt,
            nowMs,
            'skipped',
            gap.reason ?? `动作 ${action} 的频控间隔未到`,
            null,
            nowMs,
          );
        }
      }
    }

    const runner = maybeService<ScheduleLaunchPort>(this.ctx, 'workflow.runner');
    if (!runner) {
      return this.record(job.id, plannedAt, nowMs, 'failed', '工作流运行口未挂载（workflow），无法起跑', null, nowMs);
    }
    try {
      const run = runner.start(job.plan_id);
      return this.record(job.id, plannedAt, nowMs, 'started', null, run.runId, nowMs);
    } catch (error) {
      // 拒因原样上浮（含 `WORKFLOW_INVALID_STATE` 那句"已有 run 处于 X 态"）：调度器不翻译别人的失败，
      // 否则 5.7-02 的证据链就要对着这里的转述猜原始错误。
      const message = error instanceof Error ? error.message : String(error);
      return this.record(job.id, plannedAt, nowMs, 'failed', message, null, nowMs);
    }
  }

  /**
   * 把任务的下一次推到"此刻之后"，并记下本次处理的计划点。
   * @param job 任务原始行（表达式来自这里，不重新查表）
   * @param plannedAt 本次处理掉的计划点（毫秒），进 `last_planned_at`
   * @param nowMs 推进基准（毫秒）
   */
  private advance(job: JobRow, plannedAt: number, nowMs: number): void {
    const nextRunAt = nextRunAtMs(job.expression, nowMs);
    this.store.db
      .prepare('UPDATE schedule_jobs SET next_run_at = ?, last_planned_at = ?, updated_at = ? WHERE id = ?')
      .run(nextRunAt, plannedAt, nowMs, job.id);
  }

  /**
   * 落一行触发记录。
   * @param jobId 任务 id
   * @param plannedAt 对应计划点（毫秒）
   * @param firedAt 动手时刻（毫秒）；补记跳过传 null，因为那一刻 app 没在跑
   * @param result 三态结局
   * @param reason 跳过/失败的原话，`started` 传 null
   * @param workflowRunId 起跑成功时 `workflow.runner` 给的 run id
   * @param nowMs 记录写入时刻（毫秒）
   * @returns 刚落成的记录视图
   */
  private record(
    jobId: string,
    plannedAt: number,
    firedAt: number | null,
    result: ScheduleTriggerResult,
    reason: string | null,
    workflowRunId: string | null,
    nowMs: number,
  ): ScheduleTriggerView {
    const id = randomUUID();
    this.store.db
      .prepare(
        `INSERT INTO schedule_triggers (id, job_id, planned_at, fired_at, result, reason, workflow_run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, jobId, plannedAt, firedAt, result, reason, workflowRunId, nowMs);
    return { id, jobId, plannedAt, firedAt, result, reason, workflowRunId, createdAt: nowMs };
  }

  /**
   * 断言 `planId` 在可起跑清单里。
   * @param planId 待验的计划 id（来自界面，按不可信输入处理）
   * @throws 起跑口未挂载、或 id 不在 `plans()` 里时以 `INVALID_ARGUMENT` 失败并列出可用值
   */
  private requireKnownPlan(planId: string): void {
    const runner = maybeService<ScheduleLaunchPort>(this.ctx, 'workflow.runner');
    if (!runner) {
      throw new AppError(
        'INVALID_ARGUMENT',
        '工作流运行口未挂载（workflow），定时任务只能触发已保存的工作流，现在没有可校验的清单',
        'schedule.registry',
        { planId },
      );
    }
    const available = runner.plans().map((option) => option.id);
    if (!available.includes(planId)) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `未知的工作流计划 ${planId}，定时任务只能触发已保存的工作流。可选：${available.join('、')}`,
        'schedule.registry',
        { planId, available },
      );
    }
  }

  /**
   * 读一条任务的原始行。
   * @param jobId 任务 id
   * @returns 原始行
   * @throws id 不存在时以 `INVALID_ARGUMENT` 失败
   */
  private rowOf(jobId: string): JobRow {
    const row = this.store.db.prepare('SELECT * FROM schedule_jobs WHERE id = ?').get(jobId) as unknown as
      JobRow | undefined;
    if (!row) throw new AppError('INVALID_ARGUMENT', `没有这条定时任务：${jobId}`, 'schedule.registry', { jobId });
    return row;
  }

  /**
   * 按 id 取任务视图。
   * @param jobId 任务 id
   * @returns 任务视图；id 不存在时由 `rowOf` 结构化失败
   */
  private job(jobId: string): ScheduleJobView {
    return this.toJobView(this.rowOf(jobId));
  }

  /**
   * 原始行 → 视图（列名口径只在本文件出现一次，§4.2）。
   * @param row `schedule_jobs` 的一行
   * @returns 界面上的那一行读数
   */
  private toJobView(row: JobRow): ScheduleJobView {
    return {
      id: row.id,
      name: row.name,
      planId: row.plan_id,
      expression: row.expression,
      isEnabled: Number(row.is_enabled) === 1,
      nextRunAt: toMs(row.next_run_at),
      lastPlannedAt: toMs(row.last_planned_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  /**
   * 原始行 → 触发记录视图。
   * @param row `schedule_triggers` 的一行
   * @returns 触发记录读数
   */
  private toTriggerView(row: TriggerRow): ScheduleTriggerView {
    return {
      id: row.id,
      jobId: row.job_id,
      plannedAt: Number(row.planned_at),
      firedAt: toMs(row.fired_at),
      result: toResult(row.result),
      reason: row.reason,
      workflowRunId: row.workflow_run_id,
      createdAt: Number(row.created_at),
    };
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'schedule.registry': ScheduleRegistryService;
  }
}
