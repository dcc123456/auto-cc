/**
 * `usage.ledger` 服务（spec 1.9-04 / 1.9-07 / 1.9-08）：外发用量的唯一落账处。
 *
 * 表由本服务把迁移 push 进 `store.migrations` 再 `upgrade()`（`store/src/index.ts:37` 为此留的口子），
 * 因此连接池仍然只有一处（AGENTS.md §2.7），而「哪张表属于哪个域」由建表的一方自己说清楚。
 *
 * `source` / `remoteRef` 两列现在恒为 null：它们是 P5 接 SaaS 时「不改表就能对上账」的预留，
 * 空列比空接口便宜得多，也改不动已有数据（spec 1.9-08）。
 */
import { asApp, Service, type Context } from '@auto-cc/core';
import type { StoreService } from '@auto-cc/plugin-store';
import type { DatabaseSync } from 'node:sqlite';
import type { LedgerRowView, UsageSummaryView } from '@auto-cc/shared';
import { z } from 'zod';
import type { ActionContext } from './types.js';

/**
 * 迁移号段（plan §8.4 决策 6）：`usage_ledger` 取 1，后续包依次取 2、3…
 * 撞号会发生在运行期（`runMigrations` 抛「迁移版本重复」），所以号段只能写在这里，不能靠记忆。
 */
export const LEDGER_MIGRATION_VERSION = 1;

/** 账本表不存在时按此建表；`up` 只写 DDL，数据迁移由后续版本负责。 */
const ledgerMigration = {
  version: LEDGER_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS usage_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      target_id TEXT,
      workflow_run_id TEXT,
      ts INTEGER NOT NULL,
      source TEXT,
      remote_ref TEXT
    )`);
    // 闸门每次都按「某动作 + 今天」数行数（spec 1.9-03），没有这条索引就得每次全表扫。
    db.exec('CREATE INDEX IF NOT EXISTS usage_ledger_action_ts ON usage_ledger (action, ts)');
  },
};

/** 落账一条记录的行内形状（`perform` 内部与单测用它，跨进程只走 `LedgerRowView`）。 */
export type LedgerDraft = ActionContext & {
  action: string;
  source?: string | null;
  remoteRef?: string | null;
};

/** 账本表的一行原始读数（列名与 `LedgerRowView` 的驼峰字段不同，转换收在 `toRowView`）。 */
type LedgerRow = {
  id: number | bigint;
  action: string;
  target_id: string | null;
  workflow_run_id: string | null;
  ts: number | bigint;
  source: string | null;
  remote_ref: string | null;
};

/**
 * 本地日的 `YYYY-MM-DD` 键。
 * @param ts 毫秒时间戳
 * @returns 按**运行机器时区**算的日键 —— 故意不用 SQLite 的 `date('now')`，那是 UTC，
 *   中国用户会在早 8 点前被算进「昨天」（plan §8.4 决策 3）
 */
export function dayKey(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

/**
 * 本地「今天」零点的毫秒时间戳。
 * @param ts 毫秒时间戳（判定基准，通常是 `Date.now()`）
 * @returns 该时刻所在自然日的起点
 */
export function startOfDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 把数据库行转成跨进程视图：`bigint` 在 node:sqlite 里是常态，必须在出口处收成 number。 */
function toRowView(row: LedgerRow): LedgerRowView {
  return {
    id: Number(row.id),
    action: row.action,
    targetId: row.target_id,
    workflowRunId: row.workflow_run_id,
    ts: Number(row.ts),
    source: row.source,
    remoteRef: row.remote_ref,
  };
}

/** 账本暂无可选项；strict 让 `cordis.yml` 里写错的键在挂载期就报错（与 `ipc` 同形）。 */
export const ledgerSchema = z.strictObject({});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type LedgerConfig = z.infer<typeof ledgerSchema>;

export class UsageLedgerService extends Service {
  static provide = 'usage.ledger';
  static Config = ledgerSchema;
  static inject = ['store'];

  constructor(ctx: Context, _options: LedgerConfig) {
    // 无配置项也要接住第二个实参：cordis 递的是校验后的配置对象（AGENTS.md §9 实测 1.3）。
    super(ctx, 'usage.ledger');
  }

  /** store 服务句柄；连接尚未打开时由 `store.db` 的 getter 抛出「尚未完成挂载」。 */
  private get store(): StoreService {
    return asApp(this.ctx).store;
  }

  /**
   * 登记迁移并把表建出来。
   *
   * 幂等是硬要求：`plugins.start('usage')` 会重新构造本服务，若无条件 push 就会在同一份
   * 共享清单里留下两个 `version: 1`，之后任何一次 `upgrade()` 都直接抛错（plan §8.4 决策 5）。
   */
  private ensureSchema(): void {
    const { migrations } = this.store;
    if (!migrations.some((item) => item.version === LEDGER_MIGRATION_VERSION)) {
      migrations.push(ledgerMigration);
    }
    this.store.upgrade();
  }

  /**
   * 写一行用量记录。
   * @param draft 落账内容：动作名 + `ActionContext`（`targetId` / `workflowRunId` 可为空）+ 可选 `source` / `remoteRef`
   * @returns 新行的自增 id，供回执显示「确实落账了」（spec 1.9-04）
   */
  record = (draft: LedgerDraft): number => {
    const ts = draft.nowMs ?? Date.now();
    const result = this.store.db
      .prepare(
        'INSERT INTO usage_ledger (action, target_id, workflow_run_id, ts, source, remote_ref) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        draft.action,
        draft.targetId ?? null,
        draft.workflowRunId ?? null,
        ts,
        draft.source ?? null,
        draft.remoteRef ?? null,
      );
    return Number(result.lastInsertRowid);
  };

  /**
   * 某动作在 `nowMs` 所在自然日已经用了几次（闸门判定的唯一数据源）。
   * @param action 动作名
   * @param nowMs 判定基准毫秒时间戳
   * @returns 今日已落账的行数
   */
  countToday = (action: string, nowMs: number): number => {
    const row = this.store.db
      .prepare('SELECT COUNT(*) AS n FROM usage_ledger WHERE action = ? AND ts >= ?')
      .get(action, startOfDay(nowMs)) as { n?: number | bigint };
    return Number(row?.n ?? 0);
  };

  /**
   * 账本总行数（spec 2.3-11 的对照读数：抓取是只读动作，一轮前后两值必须相等）。
   *
   * 单独一个 `COUNT` 而不是复用 `summary().total`：后者为了分组把整张表读进 JS，
   * 每次抓取跑两遍纯属浪费，而这里要的就是一个整数。
   * @returns 已落账的行数；空账本为 0
   */
  count = (): number => {
    const row = this.store.db.prepare('SELECT COUNT(*) AS n FROM usage_ledger').get() as { n?: number | bigint };
    return Number(row?.n ?? 0);
  };

  /**
   * 用量回看（spec 1.9-07）：总数、今日、按天分组、按动作分组，外加最近几行。
   *
   * 分组在 JS 里做而不是在 SQL 里 `GROUP BY`：日界必须按本地时区（见 `dayKey`），
   * 交给 SQLite 就会静默变成 UTC 分组，界面显示的日子比用户认知晚一天。
   * @param recentLimit 最近行条数，默认 10
   * @returns 跨进程视图；账本为空时各数组为空而不是 null
   */
  summary = (recentLimit = 10): UsageSummaryView => {
    const rows = this.store.db
      .prepare('SELECT * FROM usage_ledger ORDER BY ts ASC, id ASC')
      .all() as unknown as LedgerRow[];
    const todayStart = startOfDay(Date.now());
    const byDay = new Map<string, Map<string, number>>();
    const byAction = new Map<string, number>();
    for (const row of rows) {
      const day = dayKey(Number(row.ts));
      const actions = byDay.get(day) ?? new Map<string, number>();
      actions.set(row.action, (actions.get(row.action) ?? 0) + 1);
      byDay.set(day, actions);
      byAction.set(row.action, (byAction.get(row.action) ?? 0) + 1);
    }
    return {
      total: rows.length,
      today: rows.filter((row) => Number(row.ts) >= todayStart).length,
      byDay: [...byDay.entries()]
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([day, actions]) => ({
          day,
          count: [...actions.values()].reduce((total, item) => total + item, 0),
          actions: [...actions.entries()].map(([action, count]) => ({ action, count })),
        })),
      byAction: [...byAction.entries()].map(([action, count]) => ({ action, count })),
      recent: rows.slice(-Math.max(0, recentLimit)).reverse().map(toRowView),
    };
  };

  [Service.init](): void {
    this.ensureSchema();
    this.ctx.logger.info(`用量账本就绪：表 usage_ledger（schema v${String(LEDGER_MIGRATION_VERSION)}）`);
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'usage.ledger': UsageLedgerService;
  }
}
