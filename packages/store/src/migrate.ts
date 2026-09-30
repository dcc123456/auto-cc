import type { DatabaseSync } from 'node:sqlite';

/**
 * 迁移执行器（spec 1.3-07）：版本号存在 SQLite 自带的 `PRAGMA user_version` 里，
 * 不额外建 `_migrations` 表——少一张表就少一处会和真实结构不一致的地方。
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
  from: number;
  to: number;
  applied: number[];
}

/** `rollback` 的结局：`reverted` 是实际倒回去的版本号，按倒序排列。 */
export interface RollbackResult {
  from: number;
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

export function runMigrations(db: DatabaseSync, migrations: readonly Migration[]): MigrationResult {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of sorted) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new Error(`迁移版本必须是正整数，收到 ${migration.version}`);
    }
  }
  const duplicate = sorted.findIndex((item, index) => index > 0 && item.version === sorted[index - 1]?.version);
  if (duplicate > 0) throw new Error(`迁移版本重复：${String(sorted[duplicate]?.version)}`);

  const from = readVersion(db);
  const applied: number[] = [];
  for (const migration of sorted) {
    if (migration.version <= from) continue;
    db.exec('BEGIN');
    try {
      migration.up(db);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      // 失败原因与版本号一起抛出，避免留下「表建了一半但版本没动」的不可解释状态。
      throw new Error(
        `迁移 ${String(migration.version)} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // 版本号在事务提交之后才写：不依赖 `PRAGMA user_version` 是否参与事务，语义都是「提交成功才算升上去」。
    writeVersion(db, migration.version);
    applied.push(migration.version);
  }
  return { from, to: applied.length > 0 ? (applied[applied.length - 1] as number) : from, applied };
}

/**
 * 把 schema 倒回 `toVersion`（spec 2.3-05 的 down 路径）。
 *
 * 逐版倒序执行，每版一个事务，成功后才写 `PRAGMA user_version`——与 `runMigrations` 同一套口径，
 * 于是「回滚到一半失败」留下的是上一个完整版本，而不是一个既不是 A 也不是 B 的中间态。
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
  const from = readVersion(db);
  if (toVersion > from) throw new Error(`回滚目标 ${String(toVersion)} 高于当前版本 ${String(from)}`);

  const byVersion = new Map(migrations.map((item) => [item.version, item]));
  const reverted: number[] = [];
  for (let version = from; version > toVersion; version -= 1) {
    const migration = byVersion.get(version);
    // 缺 `down` 就停在这里：跳过它继续倒，会把 user_version 写成与真实结构不一致的数（比报错更糟）。
    if (!migration?.down) throw new Error(`迁移 ${String(version)} 缺少 down，无法回滚`);
    db.exec('BEGIN');
    try {
      migration.down(db);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`回滚 ${String(version)} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    writeVersion(db, version - 1);
    reverted.push(version);
  }
  return { from, to: toVersion, reverted };
}
