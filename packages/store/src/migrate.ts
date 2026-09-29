import type { DatabaseSync } from 'node:sqlite';

/**
 * 迁移执行器（spec 1.3-07）：版本号存在 SQLite 自带的 `PRAGMA user_version` 里，
 * 不额外建 `_migrations` 表——少一张表就少一处会和真实结构不一致的地方。
 */

export interface Migration {
  /** 目标版本，必须为正整数且不重复。 */
  version: number;
  up: (db: DatabaseSync) => void;
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: number[];
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
