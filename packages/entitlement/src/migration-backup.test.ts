/**
 * 10.2-04：43 号迁移前的真实 SQLite 备份、隔离恢复、逐表摘要对比与失败负对照。
 * 源库是系统临时目录里的虚构数据，不读取也不修改任何用户库。
 */
import { asApp, Context, fiberState, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { OUTBOUND_STATE_MIGRATION_VERSION, UsageLedgerService } from './index.js';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 一张表的脱敏结构摘要：行数、主键、全行哈希；虚构数据因此可以逐行参与哈希。 */
type TableDigest = { rows: number; primaryKey: string[]; sha256: string };
type DatabaseDigest = { version: number; tables: Record<string, TableDigest> };

/** 计算整库逐表摘要；表名只来自 SQLite 自身元数据，比较时按键排序保证稳定。 */
function digestOf(db: DatabaseSync): DatabaseDigest {
  const versionRow = db.prepare('PRAGMA user_version').get() as { user_version: number | bigint };
  const tableRows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  const tables: Record<string, TableDigest> = {};
  for (const { name } of tableRows) {
    const quoted = `'${name.replaceAll("'", "''")}'`;
    const columns = db.prepare(`PRAGMA table_info(${quoted})`).all() as { name: string; pk: number }[];
    const primaryKey = columns.filter((column) => column.pk > 0).map((column) => column.name);
    const orderBy = primaryKey.length > 0 ? primaryKey.map((key) => `"${key}"`).join(', ') : 'rowid';
    const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY ${orderBy}`).all();
    tables[name] = {
      rows: rows.length,
      primaryKey,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  return { version: Number(versionRow.user_version), tables };
}

/** 建一份停在 42 的虚构旧库，并实际调用 node:sqlite 的在线备份 API。 */
async function seedAndBackup(
  dir: string,
): Promise<{ sourcePath: string; backupPath: string; baseline: DatabaseDigest }> {
  const sourcePath = join(dir, 'source.db');
  const backupPath = join(dir, 'backup.db');
  const source = new DatabaseSync(sourcePath);
  source.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE usage_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target_id TEXT,
      workflow_run_id TEXT, ts INTEGER NOT NULL, source TEXT, remote_ref TEXT);
    CREATE TABLE usage_denials (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target_id TEXT,
      workflow_run_id TEXT, ts INTEGER NOT NULL, code TEXT NOT NULL, reason TEXT NOT NULL);
    CREATE TABLE delivery_records (ledger_id INTEGER PRIMARY KEY, platform TEXT NOT NULL, job_id TEXT NOT NULL,
      conversation_target TEXT NOT NULL DEFAULT '', snapshot_id TEXT, ts INTEGER NOT NULL);
    PRAGMA user_version = 42;`);
  for (const version of [1, 9, 19, 27, 35, 42]) {
    source.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, 1_760_000_000_000);
  }
  source
    .prepare(
      "INSERT INTO usage_ledger (action, target_id, workflow_run_id, ts, source) VALUES ('deliver', 'job-fixture', 'run-old', 1760000000000, 'resume:old')",
    )
    .run();
  source
    .prepare(
      "INSERT INTO delivery_records (ledger_id, platform, job_id, snapshot_id, ts) VALUES (1, 'fixture', 'job-fixture', 'snap-old', 1760000000000)",
    )
    .run();
  const pages = await backup(source, backupPath, { rate: 1 });
  expect(pages).toBeGreaterThan(0);
  const baseline = digestOf(source);
  source.close();
  return { sourcePath, backupPath, baseline };
}

/** 在隔离库上挂真实 store/ledger；可选注入同号失败迁移，验证失败不会改恢复副本。 */
async function mountLedger(dir: string, shouldFail: boolean) {
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  const storeFiber = await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' });
  fibers.push(storeFiber);
  const store = asApp(ctx).store;
  if (shouldFail) {
    store.migrations.push({
      version: OUTBOUND_STATE_MIGRATION_VERSION,
      up: () => {
        throw new Error('隔离副本的故意迁移失败');
      },
    });
  }
  try {
    const ledgerFiber = await ctx.plugin(UsageLedgerService, {});
    fibers.push(ledgerFiber);
    return { store, ledgerFiber, failure: null };
  } catch (error) {
    return { store, ledgerFiber: null, failure: error };
  }
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

describe('43 号迁移的备份与隔离恢复（10.2-04）', () => {
  it('备份恢复逐表一致；失败不碰源库；成功后旧表逐行不变且只新增控制/尝试表', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-cc-migration-backup-'));
    sandboxes.push(dir);
    const { sourcePath, backupPath, baseline } = await seedAndBackup(dir);
    const sourceHashBefore = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');

    // 失败副本：恢复前与源库逐表一致；故意让 43 失败后，连 schema 水位和行哈希都不能变。
    const failedDir = join(dir, 'failed');
    mkdirSync(failedDir, { recursive: true });
    const failedPath = join(failedDir, 'store.db');
    copyFileSync(backupPath, failedPath);
    const failedConnection = new DatabaseSync(failedPath);
    const failedBefore = digestOf(failedConnection);
    failedConnection.close();
    expect(failedBefore).toEqual(baseline);
    const failedMount = await mountLedger(failedDir, true);
    expect(failedMount.failure).toBeInstanceOf(Error);
    expect(String(failedMount.failure)).toContain('迁移 43 失败');
    expect(digestOf(failedMount.store.db)).toEqual(failedBefore);
    expect(createHash('sha256').update(readFileSync(sourcePath)).digest('hex')).toBe(sourceHashBefore);

    // 成功副本：从同一份备份重新恢复，不沿用失败副本的任何句柄或文件。
    const successDir = join(dir, 'success');
    mkdirSync(successDir, { recursive: true });
    const successPath = join(successDir, 'store.db');
    copyFileSync(backupPath, successPath);
    const successMount = await mountLedger(successDir, false);
    expect(successMount.ledgerFiber).not.toBeNull();
    expect(fiberState(successMount.ledgerFiber!.state)).toBe('active');
    const migrated = digestOf(successMount.store.db);
    expect(migrated.version).toBe(OUTBOUND_STATE_MIGRATION_VERSION);
    for (const [table, before] of Object.entries(baseline.tables)) {
      if (table === 'schema_migrations') continue;
      expect(migrated.tables[table], `旧表 ${table} 的行数/主键/全行哈希必须不变`).toEqual(before);
    }
    const versions = successMount.store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(versions.map((row) => row.version)).toEqual([1, 9, 19, 27, 35, 42, 43]);
    expect(migrated.tables.outbound_control).toMatchObject({ rows: 1, primaryKey: ['id'] });
    expect(migrated.tables.outbound_attempts).toMatchObject({ rows: 0, primaryKey: ['id'] });
    expect(createHash('sha256').update(readFileSync(sourcePath)).digest('hex')).toBe(sourceHashBefore);

    const printable = Object.fromEntries(
      Object.entries(migrated.tables).map(([table, digest]) => [
        table,
        { rows: digest.rows, primaryKey: digest.primaryKey, sha256: digest.sha256.slice(0, 12) },
      ]),
    );
    console.log(
      `MIGRATION_BACKUP_OK ${JSON.stringify({ backup: 'node:sqlite backup(rate=1)', sourceSha256: sourceHashBefore.slice(0, 12), failedCopyUnchanged: true, oldTablesPreserved: true, versions: versions.map((row) => row.version), tables: printable })}`,
    );
  });
});
