/**
 * `journey.tracking` 服务（spec 10.4 / 10.8，plan §12.4）：岗位八态状态机与约面唯一来源。
 *
 * **不另建数据体系**：两张表挂进同一条 `store` 连接（迁移 45），漏斗的约面级与看板趋势仍从
 * `funnel.query` 一张读数出去——本服务只负责「状态怎么推进」和「约面由谁登记」，不自己算漏斗。
 *
 * 三条硬规则（plan §12.4.1）：
 * 1. **按事件推进**：没有事件不推进；同一事件重复到达不落第二行（幂等返回当前读数）；
 * 2. **只进不退**：回退请求一律以 `JOB_STATUS_BACKWARD` 拒绝；唯一例外是 `closed` 重开一次，
 *    且重开要留痕（原结束态、原因、时刻）；
 * 3. **跳跃须有回执**：允许 `tailored → delivered` 这类跳级，但每一次迁移都必须带 `sourceRef`
 *    （构建/消息/账本/投递记录 id），空引用直接拒绝——「跳跃无回执」与「无事件」不是一回事。
 *
 * 约面（plan §12.4.3）：唯一来源是用户登记的一条记录（岗位 + 时间 + 方式 + 来源引用）。
 * 一岗多条按岗位计 1，未登记不计入也不补 0；漏斗该级读不到本服务时给不可用原因。
 *
 * 迁移号段取 **45**（本工作树已核到 44 的唯一归属是 `outbound_authorizations`）。
 */
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import {
  JOB_CLOSE_REASONS,
  INTERVIEW_MODES,
  dayKey,
  type FunnelRange,
  type InterviewMode,
  type InterviewRecordView,
  type JobCloseReason,
  type JobStage,
  type JobStatusEventView,
  type JobTrackingView,
} from '@auto-cc/shared';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

/** 迁移号段：45（45 的两条声明形状动手前核过零命中）。 */
export const JOB_TRACKING_MIGRATION_VERSION = 45;

/**
 * 允许的迁移表（`closed` 不在键里：进入 closed 只能走 `close()`，离开只能走 `reopen()`）。
 *
 * 顺序与判据逐字对应 plan §12.4.1 的「允许后继」列；`tailored → delivered` 是刻意允许的跳级
 * （站点上可以不经打招呼直接投递），但两边都必须带 `sourceRef`。
 */
const ALLOWED_TRANSITIONS: Record<Exclude<JobStage, 'closed'>, readonly JobStage[]> = {
  captured: ['matched', 'closed'],
  matched: ['tailored', 'closed'],
  tailored: ['greeted', 'delivered', 'closed'],
  greeted: ['replied', 'closed'],
  replied: ['delivered', 'interviewed', 'closed'],
  delivered: ['replied', 'interviewed', 'closed'],
  interviewed: ['closed'],
};

/** 无配置项：八态与结束原因都是判据，不是可调项。 */
export const jobTrackingSchema = z.strictObject({});

/** 校验后的配置形状。 */
export type JobTrackingConfig = z.infer<typeof jobTrackingSchema>;

/** `job_status_events` 的裸行。 */
interface StatusEventRow {
  id: number | bigint;
  platform: string;
  job_id: string;
  from_state: JobStage | null;
  to_state: JobStage;
  source_ref: string;
  reason: string | null;
  at: number | bigint;
}

/** `interview_records` 的裸行。 */
interface InterviewRow {
  id: number | bigint;
  platform: string;
  job_id: string;
  scheduled_at: number | bigint;
  mode: InterviewMode;
  source_ref: string;
  created_at: number | bigint;
}

/** 建两张表：状态事件（只追加）与约面登记（用户唯一来源）。 */
const trackingMigration = {
  version: JOB_TRACKING_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS job_status_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      job_id TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      reason TEXT,
      at INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_job_status_events_job ON job_status_events (platform, job_id, id)');
    db.exec(`CREATE TABLE IF NOT EXISTS interview_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      job_id TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('phone', 'video', 'onsite')),
      source_ref TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_interview_records_created ON interview_records (created_at)');
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS interview_records');
    db.exec('DROP TABLE IF EXISTS job_status_events');
  },
};

/** 把事件裸行转成跨进程视图。 */
function toEventView(row: StatusEventRow): JobStatusEventView {
  return {
    id: Number(row.id),
    when: Number(row.at),
    from: row.from_state,
    to: row.to_state,
    sourceRef: row.source_ref,
    reason: row.reason,
  };
}

/** 把约面裸行转成跨进程视图。 */
function toInterviewView(row: InterviewRow): InterviewRecordView {
  return {
    id: Number(row.id),
    platform: row.platform,
    jobId: row.job_id,
    scheduledAt: Number(row.scheduled_at),
    mode: row.mode,
    sourceRef: row.source_ref,
    createdAt: Number(row.created_at),
  };
}

export class JobTrackingService extends Service {
  static provide = 'journey.tracking';
  static Config = jobTrackingSchema;
  static inject = ['store'];

  constructor(ctx: Context, _options: JobTrackingConfig) {
    // 无配置项也要接住第二个实参：cordis 递的是校验后的配置（AGENTS.md §9 实测 1.3）。
    super(ctx, 'journey.tracking');
  }

  /** 共享连接；两张表都挂在这一条上（§2.7 禁第二个连接池）。 */
  private get store() {
    return asApp(this.ctx).store;
  }

  /**
   * 记一次状态推进（八态机唯一写入口）。
   * @param input 平台、岗位、目标态、回执来源（必填）与可选原因
   * @returns 推进后的当前读数；同一事件重复到达时原样返回且不落第二行
   * @throws `JOB_STATUS_TRANSITION_INVALID` / `JOB_STATUS_BACKWARD` / `JOB_STATUS_SOURCE_REQUIRED`
   */
  record = (input: {
    platform: string;
    jobId: string;
    to: JobStage;
    sourceRef: string;
    reason?: string;
    at?: number;
  }): JobTrackingView => {
    const platform = input.platform.trim();
    const jobId = input.jobId.trim();
    const sourceRef = input.sourceRef.trim();
    if (platform === '' || jobId === '') {
      throw new AppError('INVALID_ARGUMENT', '状态推进必须给平台与岗位', 'journey.tracking');
    }
    if (sourceRef === '') {
      throw new AppError(
        'JOB_STATUS_SOURCE_REQUIRED',
        `推进到 ${input.to} 必须带来源引用（账本/投递记录/消息/回执 id）：没有回执的跳跃不成立`,
        'journey.tracking',
        { jobId, to: input.to },
      );
    }
    const at = input.at ?? Date.now();
    const current = this.latest(platform, jobId);
    if (current === null) {
      if (input.to !== 'captured') {
        throw new AppError(
          'JOB_STATUS_TRANSITION_INVALID',
          `岗位 ${jobId} 还没有任何状态记录：第一次推进只能是 captured`,
          'journey.tracking',
          { jobId, to: input.to },
        );
      }
      this.insert(platform, jobId, null, 'captured', sourceRef, input.reason ?? null, at);
      return this.current(platform, jobId);
    }
    if (current.to_state === input.to) return this.toView(platform, jobId, current);
    if (current.to_state === 'closed') {
      throw new AppError(
        'JOB_STATUS_BACKWARD',
        `岗位 ${jobId} 已结束：只能通过「重开」回到结束前的态，不能直接推进到 ${input.to}`,
        'journey.tracking',
        { jobId, to: input.to },
      );
    }
    const allowed = ALLOWED_TRANSITIONS[current.to_state];
    if (!allowed.includes(input.to)) {
      const backward = this.isBackward(current.to_state, input.to);
      throw new AppError(
        backward ? 'JOB_STATUS_BACKWARD' : 'JOB_STATUS_TRANSITION_INVALID',
        backward
          ? `岗位 ${jobId} 不能从 ${current.to_state} 退回 ${input.to}（只进不退）`
          : `岗位 ${jobId} 不能从 ${current.to_state} 直接到 ${input.to}`,
        'journey.tracking',
        { jobId, from: current.to_state, to: input.to },
      );
    }
    this.insert(platform, jobId, current.to_state, input.to, sourceRef, input.reason ?? null, at);
    return this.current(platform, jobId);
  };

  /**
   * 结束一个岗位（必须给原因，plan §12.4.2）。
   * @param input 平台、岗位、原因、来源引用与时刻
   * @returns 结束后的读数
   * @throws 已结束 / 无状态记录 / 原因不在四种内
   */
  close = (input: {
    platform: string;
    jobId: string;
    reason: JobCloseReason;
    sourceRef: string;
    at?: number;
  }): JobTrackingView => {
    if (!JOB_CLOSE_REASONS.includes(input.reason)) {
      throw new AppError('INVALID_ARGUMENT', `结束原因只能是 ${JOB_CLOSE_REASONS.join(' / ')}`, 'journey.tracking');
    }
    return this.record({ ...input, to: 'closed', reason: input.reason });
  };

  /**
   * 重开一个已结束的岗位（只允许一次，并留痕）。
   * @param input 平台、岗位、重开原因、来源引用与时刻
   * @returns 重开后的读数（回到结束前的态）
   * @throws 未结束 / 已重开过一次 / 无来源
   */
  reopen = (input: {
    platform: string;
    jobId: string;
    reason: string;
    sourceRef: string;
    at?: number;
  }): JobTrackingView => {
    const platform = input.platform.trim();
    const jobId = input.jobId.trim();
    const sourceRef = input.sourceRef.trim();
    if (sourceRef === '') {
      throw new AppError('JOB_STATUS_SOURCE_REQUIRED', '重开必须写清依据（谁、什么时候决定重开）', 'journey.tracking');
    }
    const current = this.latest(platform, jobId);
    if (current === null || current.to_state !== 'closed') {
      throw new AppError('JOB_STATUS_TRANSITION_INVALID', `岗位 ${jobId} 没有处于结束态，不能重开`, 'journey.tracking');
    }
    const reopened = this.store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM job_status_events WHERE platform = ? AND job_id = ? AND from_state = 'closed'`,
      )
      .get(platform, jobId) as { n?: number | bigint };
    if (Number(reopened.n ?? 0) >= 1) {
      throw new AppError('JOB_STATUS_REOPEN_LIMIT', `岗位 ${jobId} 已经重开过一次，不能再次重开`, 'journey.tracking');
    }
    const beforeClose = this.store.db
      .prepare(
        `SELECT * FROM job_status_events WHERE platform = ? AND job_id = ? AND to_state <> 'closed'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(platform, jobId) as StatusEventRow | undefined;
    const target: JobStage = beforeClose?.to_state ?? 'captured';
    this.insert(platform, jobId, 'closed', target, sourceRef, input.reason, input.at ?? Date.now());
    return this.current(platform, jobId);
  };

  /**
   * 读一个岗位的当前态。
   * @param platform 平台
   * @param jobId 岗位
   * @returns 当前读数；从没记录过时为 `state:null`（不替它猜 captured）
   */
  current = (platform: string, jobId: string): JobTrackingView => {
    const row = this.latest(platform.trim(), jobId.trim());
    return this.toView(platform.trim(), jobId.trim(), row);
  };

  /**
   * 列当前在追的岗位（每岗一行，最近更新的在前）。
   * @param platform 只看某平台；省略看全部
   * @returns 当前读数数组
   */
  list = (platform?: string): JobTrackingView[] => {
    const rows =
      platform === undefined || platform.trim() === ''
        ? (this.store.db
            .prepare(
              `SELECT * FROM job_status_events e WHERE e.id = (
                 SELECT MAX(id) FROM job_status_events WHERE platform = e.platform AND job_id = e.job_id
               ) ORDER BY e.at DESC, e.id DESC`,
            )
            .all() as unknown as StatusEventRow[])
        : (this.store.db
            .prepare(
              `SELECT * FROM job_status_events e WHERE e.platform = ? AND e.id = (
                 SELECT MAX(id) FROM job_status_events WHERE platform = e.platform AND job_id = e.job_id
               ) ORDER BY e.at DESC, e.id DESC`,
            )
            .all(platform.trim()) as unknown as StatusEventRow[]);
    return rows.map((row) => this.toView(row.platform, row.job_id, row));
  };

  /**
   * 读一个岗位的全部迁移（正序；重开也在里面）。
   * @param platform 平台
   * @param jobId 岗位
   * @returns 事件数组；没有记录时为空数组
   */
  events = (platform: string, jobId: string): JobStatusEventView[] => {
    const rows = this.store.db
      .prepare('SELECT * FROM job_status_events WHERE platform = ? AND job_id = ? ORDER BY id ASC')
      .all(platform.trim(), jobId.trim()) as unknown as StatusEventRow[];
    return rows.map(toEventView);
  };

  /**
   * 登记一条约面记录（约面唯一来源）。
   * @param input 平台、岗位、约面时间、方式与来源引用
   * @returns 新记录的视图
   * @throws `INVALID_ARGUMENT`：时间非整数/方式不认识/来源为空（不引用就不计入）
   */
  registerInterview = (input: {
    platform: string;
    jobId: string;
    scheduledAt: number;
    mode: InterviewMode;
    sourceRef: string;
    at?: number;
  }): InterviewRecordView => {
    const platform = input.platform.trim();
    const jobId = input.jobId.trim();
    const sourceRef = input.sourceRef.trim();
    if (platform === '' || jobId === '') {
      throw new AppError('INVALID_ARGUMENT', '约面登记必须给平台与岗位', 'journey.tracking');
    }
    if (!Number.isSafeInteger(input.scheduledAt) || input.scheduledAt <= 0) {
      throw new AppError('INVALID_ARGUMENT', '约面时间必须是正整数毫秒时间戳', 'journey.tracking');
    }
    if (!INTERVIEW_MODES.includes(input.mode)) {
      throw new AppError('INVALID_ARGUMENT', `约面方式只能是 ${INTERVIEW_MODES.join(' / ')}`, 'journey.tracking');
    }
    if (sourceRef === '') {
      throw new AppError(
        'INVALID_ARGUMENT',
        '约面登记必须带来源引用（平台消息 id 或用户口述依据）：没有来源的约面不计入漏斗',
        'journey.tracking',
      );
    }
    const createdAt = input.at ?? Date.now();
    const result = this.store.db
      .prepare(
        `INSERT INTO interview_records (platform, job_id, scheduled_at, mode, source_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(platform, jobId, input.scheduledAt, input.mode, sourceRef, createdAt);
    const row = this.store.db
      .prepare('SELECT * FROM interview_records WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as unknown as InterviewRow;
    return toInterviewView(row);
  };

  /**
   * 区间内登记过的约面记录（含头不含尾，按登记时刻）。
   * @param range 半开区间毫秒
   * @returns 记录数组
   */
  interviews = (range: FunnelRange): InterviewRecordView[] => {
    const rows = this.store.db
      .prepare(
        'SELECT * FROM interview_records WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC, id ASC',
      )
      .all(range.fromMs, range.toMs) as unknown as InterviewRow[];
    return rows.map(toInterviewView);
  };

  /**
   * 区间内已登记约面的**岗位数**（按岗位去重；一岗多条只算 1）。
   * @param range 半开区间毫秒
   * @returns 去重后的岗位数
   */
  interviewedJobCount = (range: FunnelRange): number => {
    const row = this.store.db
      .prepare('SELECT COUNT(DISTINCT job_id) AS n FROM interview_records WHERE created_at >= ? AND created_at < ?')
      .get(range.fromMs, range.toMs) as { n?: number | bigint };
    return Number(row?.n ?? 0);
  };

  /** 读某岗位最新一行事件；没有为 null。 */
  private latest(platform: string, jobId: string): StatusEventRow | null {
    const row = this.store.db
      .prepare('SELECT * FROM job_status_events WHERE platform = ? AND job_id = ? ORDER BY id DESC LIMIT 1')
      .get(platform, jobId) as StatusEventRow | undefined;
    return row ?? null;
  }

  /** 追加一行迁移（唯一 INSERT 口）。 */
  private insert(
    platform: string,
    jobId: string,
    from: JobStage | null,
    to: JobStage,
    sourceRef: string,
    reason: string | null,
    at: number,
  ): void {
    this.store.db
      .prepare(
        `INSERT INTO job_status_events (platform, job_id, from_state, to_state, source_ref, reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(platform, jobId, from, to, sourceRef, reason, at);
  }

  /** 目标态在状态机顺序里位于当前态之前即判「回退」（`closed` 已在调用方排除）。 */
  private isBackward(from: JobStage, to: JobStage): boolean {
    if (from === 'closed' || to === 'closed') return false;
    const order: JobStage[] = ['captured', 'matched', 'tailored', 'greeted', 'replied', 'delivered', 'interviewed'];
    return order.indexOf(to) < order.indexOf(from);
  }

  /** 由最新一行拼当前读数（没有事件时给 `state:null`）。 */
  private toView(platform: string, jobId: string, row: StatusEventRow | null): JobTrackingView {
    if (row === null) {
      return { platform, jobId, state: null, updatedAt: null, closedReason: null, closedAt: null, reopenCount: 0 };
    }
    const reopenCount = this.store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM job_status_events WHERE platform = ? AND job_id = ? AND from_state = 'closed'`,
      )
      .get(platform, jobId) as { n?: number | bigint };
    return {
      platform,
      jobId,
      state: row.to_state,
      updatedAt: Number(row.at),
      closedReason: row.to_state === 'closed' ? row.reason : null,
      closedAt: row.to_state === 'closed' ? Number(row.at) : null,
      reopenCount: Number(reopenCount.n ?? 0),
    };
  }

  [Service.init](): void {
    const migrations = this.store.migrations;
    if (!migrations.some((migration) => migration.version === JOB_TRACKING_MIGRATION_VERSION)) {
      migrations.push(trackingMigration);
    }
    this.store.upgrade();
    this.ctx.logger.info(
      `岗位追踪就绪：八态事件表 + 约面登记表（schema v${String(JOB_TRACKING_MIGRATION_VERSION)}），` +
        `今日 ${dayKey(Date.now())} · 约面只认用户登记`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'journey.tracking': JobTrackingService;
  }
}
