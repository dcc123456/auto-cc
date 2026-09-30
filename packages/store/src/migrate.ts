import type { DatabaseSync } from 'node:sqlite';

/**
 * 迁移执行器（spec 1.3-07）。
 *
 * 「哪些版本已经跑过」记在 `schema_migrations` 一行一版，而不是只靠 `PRAGMA user_version` 这一个水位。
 * 原因是实测踩到过的坑：每个服务在自己的 `[Service.init]` 里 push 迁移再 `upgrade()`，于是装配顺序决定了
 * push 顺序——`workflow-store`(4) 排在 `jd-store`(3) 之前，水位先到 4，之后 push 的 3 被 `<= from` 跳过，
 * 新装机的 `jobs` / `chat_*` 表一条都不会建（老用户目录里表早就存在，所以一直没暴露）。
 * `user_version` 仍然写，继续给日志与界面读数当水位用：升级时取「已应用版本的最大值」，回滚时取「调用方要求
 * 回到的版本」。台账里可能有空洞（某个服务的迁移没挂载过），所以水位与台账不互为换算关系，只有台账能回答
 * 「这一版跑过没有」。
 */

export interface Migration {
  /** 目标版本，必须为正整数且不重复。 */
  version: number;
  up: (db: DatabaseSync) => void;
  /**
   * 反向 DDL（spec 2.3-05 的「migration 可回滚」）。
   * 省略即「这张表回不去」：`rollback` 会显式失败，而不是静默跳过后宣称成功。
   */
  down?: (db: DatabaseSync) => void;
}

export interface MigrationResult {
  /** 本次调用开始时 `PRAGMA user_version` 的读数。 */
  from: number;
  /** 全部迁移跑完后的水位（= 已应用版本的最大值），没有新应用时与 `from` 相同。 */
  to: number;
  applied: number[];
}

/** `rollback` 的结局：`reverted` 是实际倒回去的版本号，按倒序排列。 */
export interface RollbackResult {
  /** 倒回前的水位。 */
  from: number;
  /** 倒回后的水位；途中失败时抛错而不是返回这个字段。 */
  to: number;
  reverted: number[];
}

export function readVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number | bigint } | undefined;
  return Number(row?.user_version ?? 0);
}

function writeVersion(db: DatabaseSync, version: number): void {
  // PRAGMA 不接受占位符，只能拼字符串；version 已由调用方保证是整数。
  db.exec(`PRAGMA user_version = ${version}`);
}

/** 迁移台账表名：整张库只此一处，rollback 与 upgrade 共用。 */
const LEDGER_TABLE = 'schema_migrations';

/**
 * 建出台账表（幂等）。
 * @param db 目标连接
 */
function ensureLedger(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
}

/**
 * 读出已应用的版本号集合。
 * @param db 目标连接（台账表必须已由 `ensureLedger` 建出）
 * @returns 已应用的版本号；老库里就是空集
 */
function appliedVersions(db: DatabaseSync): Set<number> {
  const rows = db.prepare(`SELECT version FROM ${LEDGER_TABLE}`).all() as { version: number | bigint }[];
  return new Set(rows.map((row) => Number(row.version)));
}

/**
 * 把水位写成「已应用版本的最大值」。
 * @param db 目标连接
 */
function refreshVersion(db: DatabaseSync): void {
  const versions = [...appliedVersions(db)];
  writeVersion(db, versions.length > 0 ? Math.max(...versions) : 0);
}

export function runMigrations(db: DatabaseSync, migrations: readonly Migration[]): MigrationResult {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of sorted) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new Error(`迁移版本必须是正整数，收到 ${migration.version}`);
    }
  }
  const duplicate = sorted.findIndex((item, index) => index > 0 && item.version === sorted[index - 1]?.version);
  if (duplicate > 0) throw new Error(`迁移版本重复：${String(sorted[duplicate]?.version)}`);

  ensureLedger(db);
  const from = readVersion(db);
  const done = appliedVersions(db);
  const applied: number[] = [];
  for (const migration of sorted) {
    // 判据是「这一版记过账没有」，不是「水位到没到」：晚 push 上来的低号迁移照样要跑。
    if (done.has(migration.version)) continue;
    db.exec('BEGIN');
    try {
      migration.up(db);
      // 台账行与 DDL 同一个事务：`up` 半途失败时既没有表也没有账，下次启动会重试而不是永久跳过。
      db.prepare(`INSERT INTO ${LEDGER_TABLE} (version, applied_at) VALUES (?, ?)`).run(migration.version, Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      // 失败原因与版本号一起抛出，避免留下「表建了一半但版本没动」的不可解释状态。
      throw new Error(
        `迁移 ${String(migration.version)} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    refreshVersion(db);
    applied.push(migration.version);
  }
  return { from, to: readVersion(db), applied };
}

/**
 * 把 schema 倒回 `toVersion`（spec 2.3-05 的 down 路径）。
 *
 * 倒序的判据是台账里记过的版本，而不是水位到几：没记过账的版本不去猜它建过什么（老库的台账是空的，
 * 首次 `upgrade()` 会靠幂等 DDL 把账补齐）。会失败的是「记过账但缺 `down`」那一类——结构回不去还把
 * 水位写成目标值就是撒谎。
 * 每倒成一版就把水位往下挪一格，全部倒完后落在 `toVersion`：与 2.3-05 已验收的口径一致。
 * @param db 目标连接
 * @param migrations 迁移清单（与 `upgrade` 共用同一份，不另建登记表）
 * @param toVersion 回到的版本号；0 表示回到「一张表都没有」；必须不大于当前版本
 * @returns 实际倒回去的版本列表（倒序）；已在目标版本时为空数组
 * @throws 目标版本非法、或途中遇到没有 `down` 的迁移时抛出，当前版本保持不动
 */
export function rollback(db: DatabaseSync, migrations: readonly Migration[], toVersion: number): RollbackResult {
  if (!Number.isInteger(toVersion) || toVersion < 0) {
    throw new Error(`回滚目标版本必须是 ≥0 的整数，收到 ${toVersion}`);
  }
  ensureLedger(db);
  const from = readVersion(db);
  if (toVersion > from) throw new Error(`回滚目标 ${String(toVersion)} 高于当前版本 ${String(from)}`);

  const byVersion = new Map(migrations.map((item) => [item.version, item]));
  const reverted: number[] = [];
  const pending = [...appliedVersions(db)].filter((version) => version > toVersion).sort((a, b) => b - a);
  for (const version of pending) {
    const migration = byVersion.get(version);
    // 缺 `down` 就停在这里：跳过它继续倒，会把水位写成与真实结构不一致的数（比报错更糟）。
    if (!migration?.down) throw new Error(`迁移 ${String(version)} 缺少 down，无法回滚`);
    db.exec('BEGIN');
    try {
      migration.down(db);
      db.prepare(`DELETE FROM ${LEDGER_TABLE} WHERE version = ?`).run(version);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`回滚 ${String(version)} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    // 台账行删掉与 DDL 同一个事务；水位在提交后挪一格，失败时停在上一版（与 `runMigrations` 同一套口径）。
    writeVersion(db, version - 1);
    reverted.push(version);
  }
  return { from, to: readVersion(db), reverted };
}
