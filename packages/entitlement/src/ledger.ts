/**
 * `usage.ledger` 服务（spec 1.9-04 / 1.9-07 / 1.9-08 / 5.3-12）：外发用量的唯一落账处，兼被拒流水的唯一去处。
 *
 * 表由本服务把迁移 push 进 `store.migrations` 再 `upgrade()`（`store/src/index.ts:37` 为此留的口子），
 * 因此连接池仍然只有一处（AGENTS.md §2.7），而「哪张表属于哪个域」由建表的一方自己说清楚。
 *
 * 两张表分工是硬的：`usage_ledger` 的一行 = **一次真的外发**（三处计数都读它，所以被拒永远不进这张表），
 * `usage_denials` 的一行 = **一次被闸门拦下的尝试**（只追加、只回看，不参与任何判定）。
 *
 * `source` 列从 2.5-e 起有真实消费方，4.6-e 起那条链是「[manual:]模板版本:话术类型:JD id[#证据 id 列表]」
 * （拼装只在 `outbound/greet.ts` 的 `ledgerSource` 一处，spec 2.5-09 / 4.6-02），
 * `remoteRef` 仍是 null：那是 P5 接 SaaS 时「不改表就能对上账」的第二条预留，
 * 空列比空接口便宜得多，也改不动已有数据（spec 1.9-08）。
 */
import { asApp, Service, type Context } from '@auto-cc/core';
import type { StoreService } from '@auto-cc/plugin-store';
import type { DatabaseSync } from 'node:sqlite';
import {
  dayKey,
  startOfDay,
  type FunnelRange,
  type LedgerDenialView,
  type LedgerRowView,
  type UsageSummaryView,
} from '@auto-cc/shared';
import { z } from 'zod';
import type { ActionContext } from './types.js';

/**
 * 迁移号段（plan §8.4 决策 6）：`usage_ledger` 取 1，后续包依次取 2、3…
 * 撞号会发生在运行期（`runMigrations` 抛「迁移版本重复」），所以号段只能写在这里，不能靠记忆。
 */
export const LEDGER_MIGRATION_VERSION = 1;

/**
 * 被拒流水的号段（spec 5.3-12）：取当前台账之后的 19，而不是把建表语句塞进号段 1。
 * 依据是 5.3-a 实测过的那条（§9）：已记「1 已应用」的老库永远不会重跑那支迁移。
 */
export const DENIAL_MIGRATION_VERSION = 19;

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

/**
 * 被闸门拦下的动作记这一张（spec 5.3-12）：只追加、只回看，不参与任何判定。
 *
 * 不做成 `usage_ledger` 的一列 `status`，是因为那张表正被三处计数读着（日上限、同目标重复发送防护、
 * 频控的钟），掺进被拒行后每条查询漏一个过滤，就会让被拒反过来惩罚用户——plan §7 的 5.3-d 落点。
 */
const denialMigration = {
  version: DENIAL_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS usage_denials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      target_id TEXT,
      workflow_run_id TEXT,
      ts INTEGER NOT NULL,
      code TEXT NOT NULL,
      reason TEXT NOT NULL
    )`);
    // 回看口按时间倒序取最近几条（spec 1.9-07 同一个读法），没有这条索引就是全表扫。
    db.exec('CREATE INDEX IF NOT EXISTS usage_denials_ts ON usage_denials (ts)');
  },
};

/** 落账一条记录的行内形状（`perform` 内部与单测用它，跨进程只走 `LedgerRowView`）。 */
export type LedgerDraft = ActionContext & {
  action: string;
  source?: string | null;
  remoteRef?: string | null;
};

/**
 * 记一条被拒的行内形状（只由 `entitlement.gate` 在判定拒绝时写，见 `gate.perform`）。
 * `code` 是给用例断言的拒因码，`reason` 是要显示给人看的原话（与 `GateDecisionView.reason` 同一句）。
 */
export type DenialDraft = ActionContext & {
  action: string;
  code: string;
  reason: string;
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

/** 被拒流水的一行原始读数（转换收在 `toDenialView`）。 */
type DenialRow = {
  id: number | bigint;
  action: string;
  target_id: string | null;
  workflow_run_id: string | null;
  ts: number | bigint;
  code: string;
  reason: string;
};

/**
 * 本地日的 `YYYY-MM-DD` 键与本地日界零点已从本文件**上移**到 `@auto-cc/shared` 的 `time.ts`
 * （spec 5.8-b 的复用收口 AGENTS.md §2.2）：指标看板必须按同一口径自己算区间（决策十七），
 * 而渲染层引不到本包（会把 Node/SQLite 依赖拖进浏览器包），所以两处共用的只能是 L0 侧那一份。
 * 本文件只做消费方，不再持有第二份事实。
 */

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

/** 把被拒流水的一行转成跨进程视图，`bigint` 同样在出口处收成 number。 */
function toDenialView(row: DenialRow): LedgerDenialView {
  return {
    id: Number(row.id),
    action: row.action,
    targetId: row.target_id,
    workflowRunId: row.workflow_run_id,
    ts: Number(row.ts),
    code: row.code,
    reason: row.reason,
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
   * 登记迁移并把两张表都建出来。
   *
   * 幂等是硬要求：`plugins.start('usage')` 会重新构造本服务，若无条件 push 就会在同一份
   * 共享清单里留下两个同版本号，之后任何一次 `upgrade()` 都直接抛错（plan §8.4 决策 5）。
   * 两支迁移同属账本域、同走这一次 `upgrade()`，不构成第二套存储（§2.7）。
   */
  private ensureSchema(): void {
    const { migrations } = this.store;
    for (const migration of [ledgerMigration, denialMigration]) {
      if (!migrations.some((item) => item.version === migration.version)) {
        migrations.push(migration);
      }
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
   * 记一条「被闸门拦下」的流水（spec 5.3-12）。
   *
   * 唯一调用点是 `entitlement.gate.perform` 在判定拒绝、抛错之前那一行；本方法**不参与任何判定**，
   * 也不写 `usage_ledger`（那张表的每一行仍然等于一次真的外发，spec 1.9-04 与 5.3-12 因此同时成立）。
   * @param draft 被拒内容：动作名 + 拒因码 + 给人读的原话 + `ActionContext`
   * @returns 新行的自增 id
   */
  recordDenial = (draft: DenialDraft): number => {
    const ts = draft.nowMs ?? Date.now();
    const result = this.store.db
      .prepare(
        'INSERT INTO usage_denials (action, target_id, workflow_run_id, ts, code, reason) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(draft.action, draft.targetId ?? null, draft.workflowRunId ?? null, ts, draft.code, draft.reason);
    return Number(result.lastInsertRowid);
  };

  /**
   * 最近几条被拒流水（spec 5.3-12 的回看口，按时间倒序）。
   * @param limit 取几条；0 表示不取
   * @returns 视图数组，没有被拒记录时为空数组而不是 null
   */
  recentDenials = (limit: number): LedgerDenialView[] => {
    const rows = this.store.db
      .prepare('SELECT * FROM usage_denials ORDER BY ts DESC, id DESC LIMIT ?')
      .all(Math.max(0, limit)) as unknown as DenialRow[];
    return rows.map(toDenialView);
  };

  /**
   * 某动作在**半开区间** `[fromMs, toMs)` 内落了几条账（spec 5.8-01 的打招呼数、5.8-04 的区间筛选）。
   *
   * 新增的是**查询形状**而不是新事实（plan §7.6.2 决策十六）：数还是由这张表的主人来数，
   * 看板的聚合口不写 SQL 打别人的表。走 `usage_ledger_action_ts (action, ts)` 那条既有索引（决策十七）。
   * 区间含头不含尾：调用方按本地时区算日界（`startOfDay`），SQLite 不参与日期换算，
   * 否则跨时区的机器上"近 7 天"会比用户认知的那一天晚一天（见 `dayKey` 的注释）。
   * @param action 动作名（`search` / `greet` / `deliver`，账本里存什么名就按什么名数，不认的名为 0 而不是抛）
   * @param range 半开区间毫秒时间戳，`fromMs` 含、`toMs` 不含
   * @returns 区间内的行数；空区间或库里没有该动作为 0
   */
  countAction = (action: string, range: FunnelRange): number => {
    const row = this.store.db
      .prepare('SELECT COUNT(*) AS n FROM usage_ledger WHERE action = ? AND ts >= ? AND ts < ?')
      .get(action, range.fromMs, range.toMs) as { n?: number | bigint };
    return Number(row?.n ?? 0);
  };

  /**
   * 某动作在 `nowMs` 所在自然日已经用了几次（闸门判定的唯一数据源）。
   * @param action 动作名
   * @param nowMs 判定基准毫秒时间戳
   * @returns 今日已落账的行数
   */
  countToday = (action: string, nowMs: number): number => {
    // 上界给到 `MAX_SAFE_INTEGER` 而不是"明天零点"：判定要的是「此刻之前用了几次」，
    // 让 `countAction` 只留一条 SQL 形状（§2.2），同时不必在此处再算一次日界。
    return this.countAction(action, { fromMs: startOfDay(nowMs), toMs: Number.MAX_SAFE_INTEGER });
  };

  /**
   * 某动作在指定目标（可选指定运行）上已经落过几条账（spec 2.5-13 的重复发送防护）。
   *
   * 用 `IS` 而不是 `=`：`workflowRunId` 为 null 时 `= NULL` 恒不成立，
   * 「界面直接点的那几次」（runId 为空）就永远查不到历史行，重复发送防护会假绿。
   * @param action 动作名
   * @param targetId 目标标识
   * @param workflowRunId 运行标识；省略或 null 表示「非工作流发起的那一批」
   * @returns 已落账的行数，0 表示这个目标还没发过
   */
  countFor = (action: string, targetId: string, workflowRunId?: string | null): number => {
    const row = this.store.db
      .prepare('SELECT COUNT(*) AS n FROM usage_ledger WHERE action = ? AND target_id IS ? AND workflow_run_id IS ?')
      .get(action, targetId, workflowRunId ?? null) as { n?: number | bigint };
    return Number(row?.n ?? 0);
  };

  /**
   * 某动作最近一次落账的时刻（频控用的钟，spec 2.5-04）。
   *
   * 频控不自建「上次发送时间」这份内存态：账本里的行就是「确实发出去过」的唯一真相，
   * 读它既不用第二套状态存储（AGENTS.md §2.7），也天然跨重启生效。
   * @param action 动作名
   * @returns 最近一行的 `ts`（毫秒）；从未落过账时为 null（第一次发送不需要等）
   */
  latestActionTs = (action: string): number | null => {
    const row = this.store.db.prepare('SELECT MAX(ts) AS ts FROM usage_ledger WHERE action = ?').get(action) as {
      ts?: number | bigint | null;
    };
    return row?.ts === null || row?.ts === undefined ? null : Number(row.ts);
  };

  /**
   * 账本总行数（spec 2.3-11 的对照读数：抓取在闸门任务内部前后各读一次，两值必须相等，
   * 因为本轮那条 `search` 是在任务返回之后才落的账，见 2.7-03 对 2.3-11 的更正）。
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
   * 用量回看（spec 1.9-07 / 5.3-12）：总数、今日、按天分组、按动作分组，外加最近几行与最近几条被拒。
   *
   * 分组在 JS 里做而不是在 SQL 里 `GROUP BY`：日界必须按本地时区（见 `dayKey`），
   * 交给 SQLite 就会静默变成 UTC 分组，界面显示的日子比用户认知晚一天。
   * @param recentLimit 最近行条数，默认 10（被拒流水取同一个数，回看时两件事按同一把尺子摆在一起）
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
      recentDenials: this.recentDenials(recentLimit),
    };
  };

  /**
   * 按账本行 id 定点读一行（spec 5.7-02 的 `ledger:<id>` 引用回看）。
   *
   * 为什么单开一只手而不是让调用方去翻 `summary().recent`：那只手是给用量面板做汇总的，
   * 最近 N 行之外的行读不到——而一次打招呼落的那行账，跑完第二条就已经不在前十行了。
   * 直接 `WHERE id = ?` 而不是把整张表读进 JS 再找：与 `count()` 同一个理由（汇总要分组才全表读，
   * 定点读不需要）。
   * @param id 账本行 id（外发回执的 `ledgerId`，即引用里 `ledger:` 后面那一段）
   * @returns 该行的跨进程视图；库里没有这一行返回 `null`（「查无」是正常态，界面据此显示原因而不是崩）
   */
  row = (id: number): LedgerRowView | null => {
    const row = this.store.db.prepare('SELECT * FROM usage_ledger WHERE id = ?').get(id) as unknown as
      LedgerRow | undefined;
    return row === undefined ? null : toRowView(row);
  };

  [Service.init](): void {
    this.ensureSchema();
    this.ctx.logger.info(
      `用量账本就绪：表 usage_ledger 与 usage_denials（schema v${String(LEDGER_MIGRATION_VERSION)} / v${String(DENIAL_MIGRATION_VERSION)}）`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'usage.ledger': UsageLedgerService;
  }
}
