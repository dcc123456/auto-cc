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
  type OutboundAttemptKey,
  type OutboundAttemptView,
  type OutboundControlView,
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

/**
 * 外发停用与尝试台账的迁移号段：**43**（本工作树已核到 42；43 的常量与字面声明均零命中）。
 * 独立新表而不是改旧迁移：老库只按台账判断是否应用，修改 1 号建表语句不会重跑。
 */
export const OUTBOUND_STATE_MIGRATION_VERSION = 43;

/**
 * 尝试台账的「站点默认问候」扩宽迁移：**46**（本工作树已核到 45：44 授权、45 追踪；46 的常量与字面声明均零命中）。
 *
 * 为什么必须重建表而不是改 43 号的建表语句：43 已记进 `schema_migrations`，老库不会重跑；
 * 而 `status` 上有 CHECK，SQLite 改不了，只能新表 + 搬数据。
 * 同时把 `confirmed_at`（只由人在界面按一次才写）与 `evidence_summary`（站点默认问候的脱敏摘要）
 * 一并加上，不紧跟着再来第二个迁移。摘要**不塞进 `receipt_id`**：那一列在四方对账里代表应用自己发出的回执 id。
 * 搬数据时**原样保留**已有的 unknown 行（它们正是历史解锁的对象），四元组唯一约束在重建后仍然生效。
 */
export const OUTBOUND_ATTEMPTS_SITE_DEFAULT_MIGRATION_VERSION = 46;

/** 重建 `outbound_attempts`：CHECK 扩到 `site-default`，新增 `confirmed_at`。 */
export const outboundAttemptsSiteDefaultMigration = {
  version: OUTBOUND_ATTEMPTS_SITE_DEFAULT_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    // 事务由 `runMigrations` 统一开（它已把每支迁移包在 BEGIN/COMMIT 里）；
    // 这里再开一层会报「cannot start a transaction within a transaction」（本片实测踩到）。
    db.exec(`CREATE TABLE outbound_attempts_next (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      target_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('greet', 'deliver')),
      resume_version TEXT NOT NULL,
      workflow_run_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('in-flight', 'succeeded', 'unknown', 'failed', 'site-default')),
      ledger_id INTEGER,
      receipt_id TEXT,
      reason TEXT,
      updated_at INTEGER NOT NULL,
      confirmed_at INTEGER,
      evidence_summary TEXT,
      UNIQUE (platform, target_id, action, resume_version)
    )`);
    db.exec(`INSERT INTO outbound_attempts_next
      (id, platform, target_id, action, resume_version, workflow_run_id, status, ledger_id, receipt_id, reason, updated_at, confirmed_at, evidence_summary)
      SELECT id, platform, target_id, action, resume_version, workflow_run_id, status, ledger_id, receipt_id, reason, updated_at, NULL, NULL
      FROM outbound_attempts`);
    db.exec('DROP TABLE outbound_attempts');
    db.exec('ALTER TABLE outbound_attempts_next RENAME TO outbound_attempts');
    db.exec('CREATE INDEX IF NOT EXISTS idx_outbound_attempts_status ON outbound_attempts (status, updated_at)');
  },
  down: (db: DatabaseSync) => {
    // 不回退：状态语义扩宽后回退会丢 site-default 行与确认时间，代价大于收益。
    void db;
  },
};

/** 外发控制与尝试台账：去重不含工作流 id，跨入口、跨运行、跨重启都不得重放。 */
const outboundStateMigration = {
  version: OUTBOUND_STATE_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS outbound_control (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      stopped INTEGER NOT NULL CHECK (stopped IN (0, 1)),
      updated_at INTEGER NOT NULL
    )`);
    db.exec('INSERT OR IGNORE INTO outbound_control (id, stopped, updated_at) VALUES (1, 0, 0)');
    db.exec(`CREATE TABLE IF NOT EXISTS outbound_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      target_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('greet', 'deliver')),
      resume_version TEXT NOT NULL,
      workflow_run_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('in-flight', 'succeeded', 'unknown', 'failed')),
      ledger_id INTEGER,
      receipt_id TEXT,
      reason TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE (platform, target_id, action, resume_version)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_outbound_attempts_status ON outbound_attempts (status, updated_at)');
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS outbound_attempts');
    db.exec('DROP TABLE IF EXISTS outbound_control');
  },
};

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

/** `outbound_attempts` 的裸行；跨层出口统一收成 number 与 camelCase。 */
type OutboundAttemptRow = {
  platform: string;
  target_id: string;
  action: 'greet' | 'deliver';
  resume_version: string;
  workflow_run_id: string | null;
  status: OutboundAttemptView['status'];
  ledger_id: number | bigint | null;
  receipt_id: string | null;
  reason: string | null;
  updated_at: number | bigint;
  confirmed_at: number | bigint | null;
  evidence_summary: string | null;
};

/**
 * 把尝试台账裸行转成共享视图，避免 bigint 漏出 IPC。
 * @param row SQLite 裸行
 * @returns 字段类型稳定的跨进程视图
 */
function toAttemptView(row: OutboundAttemptRow): OutboundAttemptView {
  return {
    platform: row.platform,
    targetId: row.target_id,
    action: row.action,
    resumeVersion: row.resume_version,
    workflowRunId: row.workflow_run_id,
    status: row.status,
    ledgerId: row.ledger_id === null ? null : Number(row.ledger_id),
    receiptId: row.receipt_id,
    reason: row.reason,
    updatedAt: Number(row.updated_at),
    // `== null` 同时兜住 null 与「这一列还没读到」（undefined）：后者曾被 Number(undefined) 变成 NaN。
    confirmedAt: row.confirmed_at == null ? null : Number(row.confirmed_at),
    evidenceSummary: row.evidence_summary ?? null,
  };
}

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
    for (const migration of [
      ledgerMigration,
      denialMigration,
      outboundStateMigration,
      outboundAttemptsSiteDefaultMigration,
    ]) {
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
   * 读取一键停用状态；停用只影响后续外发，不改写任何历史账行。
   * @returns 当前停用位与最后修改时刻；新库默认 `stopped:false / updatedAt:0`
   */
  outboundStatus = (): OutboundControlView => {
    const row = this.store.db.prepare('SELECT stopped, updated_at FROM outbound_control WHERE id = 1').get() as
      { stopped: number; updated_at: number | bigint } | undefined;
    return { stopped: row?.stopped === 1, updatedAt: Number(row?.updated_at ?? 0) };
  };

  /**
   * 持久化一键停用/恢复；重复设置同一状态不刷新表态时刻。
   * @param stopped true 停用 greet/deliver，false 允许重新经完整闸门发起
   * @param nowMs 表态时刻（毫秒），省略取当前时间
   * @returns 设置后的控制读数
   */
  setOutboundStopped = (stopped: boolean, nowMs = Date.now()): OutboundControlView => {
    this.store.db
      .prepare('UPDATE outbound_control SET stopped = ?, updated_at = ? WHERE id = 1 AND stopped <> ?')
      .run(stopped ? 1 : 0, nowMs, stopped ? 1 : 0);
    this.ctx.logger.info(`外发总开关已${stopped ? '停用' : '恢复'}：历史账本与投递记录保持不变`);
    return this.outboundStatus();
  };

  /**
   * 按完整四元组读取一次外发尝试；不在这里猜平台或简历版本。
   * @param key 平台 + 目标 + 动作 + 简历版本
   * @returns 已持久化的尝试；从未发起时为 null
   */
  attemptFor = (key: OutboundAttemptKey): OutboundAttemptView | null => {
    const row = this.store.db
      .prepare(
        `SELECT platform, target_id, action, resume_version, workflow_run_id, status, ledger_id, receipt_id, reason, updated_at
         FROM outbound_attempts
         WHERE platform = ? AND target_id = ? AND action = ? AND resume_version = ?`,
      )
      .get(key.platform, key.targetId, key.action, key.resumeVersion) as OutboundAttemptRow | undefined;
    return row ? toAttemptView(row) : null;
  };

  /**
   * 占据一次发送权。唯一索引是并发入口的最后防线：同四元组只允许一只闭包进入页面。
   * @param key 完整去重键
   * @param workflowRunId 来源运行（只作审计，不放宽去重范围）
   * @param nowMs 写入时刻（毫秒）
   * @returns `send` 可执行；`duplicate` 已成功；`reconcile` 必须先只读对账
   */
  beginAttempt = (
    key: OutboundAttemptKey,
    workflowRunId: string | null,
    nowMs = Date.now(),
  ): { kind: 'send' | 'duplicate' | 'reconcile'; attempt: OutboundAttemptView } => {
    const existing = this.attemptFor(key);
    if (existing?.status === 'succeeded') return { kind: 'duplicate', attempt: existing };
    if (existing && existing.status !== 'failed') return { kind: 'reconcile', attempt: existing };
    if (existing) {
      this.store.db
        .prepare(
          `UPDATE outbound_attempts
           SET status = 'in-flight', workflow_run_id = ?, ledger_id = NULL, receipt_id = NULL,
               reason = NULL, updated_at = ?
           WHERE platform = ? AND target_id = ? AND action = ? AND resume_version = ? AND status = 'failed'`,
        )
        .run(workflowRunId, nowMs, key.platform, key.targetId, key.action, key.resumeVersion);
    } else {
      this.store.db
        .prepare(
          `INSERT INTO outbound_attempts
             (platform, target_id, action, resume_version, workflow_run_id, status, updated_at)
           VALUES (?, ?, ?, ?, ?, 'in-flight', ?)`,
        )
        .run(key.platform, key.targetId, key.action, key.resumeVersion, workflowRunId, nowMs);
    }
    const attempt = this.attemptFor(key);
    if (!attempt) throw new Error('外发尝试写入后读不到，停止发送');
    return { kind: 'send', attempt };
  };

  /**
   * 页面动作或落账半途失败：保守记成未知，下一次只能先对账，不能自动重发。
   * @param key 完整去重键
   * @param reason 结构化错误码或不敏感摘要；禁止写正文、cookie 与本机路径
   * @param nowMs 失败时刻（毫秒）
   * @returns 更新后的尝试；原记录不存在时为 null
   */
  markAttemptUnknown = (key: OutboundAttemptKey, reason: string, nowMs = Date.now()): OutboundAttemptView | null => {
    this.store.db
      .prepare(
        `UPDATE outbound_attempts SET status = 'unknown', reason = ?, updated_at = ?
         WHERE platform = ? AND target_id = ? AND action = ? AND resume_version = ? AND status = 'in-flight'`,
      )
      .run(reason.slice(0, 120), nowMs, key.platform, key.targetId, key.action, key.resumeVersion);
    return this.attemptFor(key);
  };

  /**
   * 站点代发了一条默认问候（应用没发正文）：把这笔尝试标成 `site-default`，**不落账、不扣额度**。
   *
   * 与 `unknown` 的区别是它有明确的「已经发生的站点行为 + 可核摘要」，所以允许人确认后继续；
   * 与 `succeeded` 的区别是应用没发正文，账本里不该有这一发。`receipt_id` 保持 NULL——
   * 那一列在四方对账里代表应用自己发出的回执 id，页面摘要进 `evidence_summary`。
   * @param key 完整去重键
   * @param evidenceSummary 页面默认问候的脱敏摘要（原文片段 + 页面上读到的时间等；禁止写 cookie/路径）
   * @param nowMs 记录时刻（毫秒）
   * @returns 更新后的尝试；原记录不存在时为 null
   */
  markAttemptSiteDefault = (
    key: OutboundAttemptKey,
    evidenceSummary: string | null,
    nowMs = Date.now(),
  ): OutboundAttemptView | null => {
    this.store.db
      .prepare(
        `UPDATE outbound_attempts
           SET status = 'site-default', reason = 'SITE_DEFAULT_GREETING', receipt_id = NULL,
               evidence_summary = ?, updated_at = ?
         WHERE platform = ? AND target_id = ? AND action = ? AND resume_version = ? AND status = 'in-flight'`,
      )
      .run(evidenceSummary?.slice(0, 500) ?? null, nowMs, key.platform, key.targetId, key.action, key.resumeVersion);
    return this.attemptFor(key);
  };

  /**
   * 人确认「站点默认问候」这件事：写 `confirmed_at`，同目标同一天只允许一次。
   *
   * 幂等口径：已经确认过的行原样返回、`confirmed_at` 不变（第二次确认不再写入）。
   * 历史遗留的 `unknown` 与 `site-default` 都走这一口：确认后统一改判为 `site-default`，
   * 闸门据此放行；`unknown` 本身不会被自动当成 `site-default` 放行（只有人确认过的才会变）。
   * @param key 完整去重键
   * @param nowMs 确认时刻（毫秒，只有人按钮那一刻传）
   * @returns 更新后的尝试；原记录不存在或状态不可确认时为 null/原值
   */
  confirmAttemptSiteDefault = (key: OutboundAttemptKey, nowMs = Date.now()): OutboundAttemptView | null => {
    const before = this.attemptFor(key);
    if (!before) return null;
    if (before.status !== 'site-default' && before.status !== 'unknown') return before;
    if (before.confirmedAt !== null) return before;
    this.store.db
      .prepare(
        `UPDATE outbound_attempts
           SET status = 'site-default', confirmed_at = ?, updated_at = ?
         WHERE platform = ? AND target_id = ? AND action = ? AND resume_version = ?
           AND status IN ('site-default', 'unknown') AND confirmed_at IS NULL`,
      )
      .run(nowMs, nowMs, key.platform, key.targetId, key.action, key.resumeVersion);
    return this.attemptFor(key);
  };

  /**
   * 只读对账明确证明页面没有这次外发后，允许显式重试；这不是自动失败重放。
   * @param key 完整去重键
   * @param nowMs 对账时刻（毫秒）
   * @returns 更新后的尝试；原记录不存在时为 null
   */
  markAttemptFailed = (key: OutboundAttemptKey, nowMs = Date.now()): OutboundAttemptView | null => {
    this.store.db
      .prepare(
        `UPDATE outbound_attempts SET status = 'failed', reason = 'PAGE_CONFIRMED_ABSENT', updated_at = ?
         WHERE platform = ? AND target_id = ? AND action = ? AND resume_version = ? AND status <> 'succeeded'`,
      )
      .run(nowMs, key.platform, key.targetId, key.action, key.resumeVersion);
    return this.attemptFor(key);
  };

  /**
   * 账本、去重成功位与领域经过在同一 SQLite 事务里落库，任一步失败都整体回滚。
   * @param key 完整去重键
   * @param context 账本来源、运行与时刻
   * @param receiptId 页面独立回执 id；没有则保留 null，不伪造
   * @param writeDelivery 投递经过写入器；与账本共用同一 store 连接，打招呼省略
   * @param nowMs 成功时刻（毫秒）
   * @returns 新账本行 id 与成功尝试
   */
  completeAttempt = (
    key: OutboundAttemptKey,
    context: ActionContext,
    receiptId: string | null,
    writeDelivery?: (ledgerId: number) => void,
    nowMs = Date.now(),
  ): { ledgerId: number; attempt: OutboundAttemptView } => {
    this.store.db.exec('BEGIN');
    try {
      const ledgerId = this.record({ ...context, action: key.action, targetId: key.targetId });
      writeDelivery?.(ledgerId);
      this.store.db
        .prepare(
          `UPDATE outbound_attempts
           SET status = 'succeeded', ledger_id = ?, receipt_id = ?, reason = NULL, updated_at = ?
           WHERE platform = ? AND target_id = ? AND action = ? AND resume_version = ? AND status IN ('in-flight', 'unknown')`,
        )
        .run(ledgerId, receiptId, nowMs, key.platform, key.targetId, key.action, key.resumeVersion);
      const attempt = this.attemptFor(key);
      if (!attempt || attempt.status !== 'succeeded' || attempt.ledgerId !== ledgerId) {
        throw new Error('外发成功位没有与账本行一对一落定');
      }
      this.store.db.exec('COMMIT');
      return { ledgerId, attempt };
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  };

  /**
   * 最近外发尝试（脱敏对账用）：只含键、状态与引用 id，不含消息正文或附件路径。
   * @param limit 最多返回几条；0 表示不取
   * @returns 按最后更新倒序的尝试清单
   */
  recentAttempts = (limit = 20): OutboundAttemptView[] => {
    const rows = this.store.db
      .prepare(
        `SELECT platform, target_id, action, resume_version, workflow_run_id, status, ledger_id, receipt_id, reason, updated_at
         FROM outbound_attempts ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(Math.max(0, limit)) as OutboundAttemptRow[];
    return rows.map(toAttemptView);
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
   * 区间内被拒原因 Top N（spec 10.8-04 的趋势失败榜，按次数降序；同次数按 code 升序保证稳定）。
   * @param range 半开区间毫秒（含头不含尾）
   * @param limit 取前几条（0 表示不取）
   * @returns `{code,count}` 数组；区间内没有拒绝记录为空数组
   */
  denialTop = (range: FunnelRange, limit: number): { code: string; count: number }[] => {
    if (limit <= 0) return [];
    const rows = this.store.db
      .prepare(
        `SELECT code, COUNT(*) AS n FROM usage_denials WHERE ts >= ? AND ts < ?
         GROUP BY code ORDER BY n DESC, code ASC LIMIT ?`,
      )
      .all(range.fromMs, range.toMs, limit) as unknown as { code: string; n: number | bigint }[];
    return rows.map((row) => ({ code: row.code, count: Number(row.n) }));
  };

  /**
   * 某平台在 `sinceMs` 之后已经推进过哪些岗位（spec 10.6-01/02 的「日限额按岗位计」唯一读数口）。
   *
   * 读 43 号 `outbound_attempts` 的 `succeeded` 行而不是 `usage_ledger`：平台维只在那张表上
   * （账本行不带平台），而「推进」= 该岗位至少一笔打招呼或投递成功——同一岗位两种动作只占一个名额。
   * @param platform 平台标识
   * @param sinceMs 起算时刻（毫秒，通常取本地日界）
   * @returns 去重后的岗位 id 列表；顺序不保证，调用方只用来判集合与数量
   */
  advancedTargetsSince = (platform: string, sinceMs: number): string[] => {
    const rows = this.store.db
      .prepare(
        `SELECT DISTINCT target_id FROM outbound_attempts
         WHERE platform = ? AND status = 'succeeded' AND updated_at >= ?`,
      )
      .all(platform, sinceMs) as unknown as { target_id: string }[];
    return rows.map((row) => row.target_id);
  };

  /**
   * 同一平台同一岗位的招呼与投递是否都成功过（无人值守执行器的「这岗推完了」口径，spec 10.6 第 5 片）。
   *
   * 不看简历版本：执行器逐岗定制出的变体版本各不相同，完成口径按**岗位**算；版本维仍由四元组去重各自把关。
   * @param platform 平台标识
   * @param targetId 岗位/会话目标
   * @returns 两种动作各有至少一条 succeeded 尝试时为 true
   */
  hasCompletedJob = (platform: string, targetId: string): boolean => {
    const row = this.store.db
      .prepare(
        `SELECT COUNT(DISTINCT action) AS n FROM outbound_attempts
         WHERE platform = ? AND target_id = ? AND status = 'succeeded' AND action IN ('greet', 'deliver')`,
      )
      .get(platform, targetId) as { n?: number | bigint };
    return Number(row?.n ?? 0) >= 2;
  };

  /**
   * 同平台、同岗位、同动作在 `sinceMs` 之后是否有过「可能已经发生过」的尝试（spec 10.6-08 的同岗 24 小时上限）。
   *
   * 只排除 `failed`：那是页面只读对账确认「没发出去」的唯一状态；`in-flight` / `unknown` / `succeeded`
   * 都必须按「可能已发生」计，否则一次崩溃就能把 24 小时上限绕过去。
   * @param platform 平台标识
   * @param targetId 岗位/会话目标
   * @param action greet/deliver
   * @param sinceMs 窗口起点（毫秒）
   * @returns 窗口内有过就 true
   */
  hasAttemptSince = (
    platform: string,
    targetId: string,
    action: OutboundAttemptKey['action'],
    sinceMs: number,
  ): boolean => {
    const row = this.store.db
      .prepare(
        `SELECT 1 AS hit FROM outbound_attempts
         WHERE platform = ? AND target_id = ? AND action = ? AND status <> 'failed' AND updated_at >= ?
         LIMIT 1`,
      )
      .get(platform, targetId, action, sinceMs) as { hit?: number } | undefined;
    return row?.hit === 1;
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
