import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { readVersion, rollback, runMigrations, type Migration } from './migrate.js';

/** 某张表在不在这库里（迁移的两类判据都只看这个）。 */
function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(name) !== undefined;
}

/** 台账里记了哪几版。 */
function ledgerVersions(db: DatabaseSync): number[] {
  return (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map(
    (row) => Number(row.version),
  );
}

describe('migration 机制（spec 1.3-07）', () => {
  it('按版本递增应用并把版本号写进 user_version', () => {
    const db = new DatabaseSync(':memory:');
    const migrations: Migration[] = [
      {
        version: 2,
        up: (handle) => handle.exec("CREATE TABLE jd (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '')"),
      },
      { version: 1, up: (handle) => handle.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)') },
    ];
    expect(readVersion(db)).toBe(0);
    expect(runMigrations(db, migrations)).toEqual({ from: 0, to: 2, applied: [1, 2] });
    expect(readVersion(db)).toBe(2);
    db.prepare('INSERT INTO jd (id, title) VALUES (?, ?)').run('1', '前端');
    expect((db.prepare('SELECT title FROM jd WHERE id = ?').get('1') as { title: string }).title).toBe('前端');
    db.close();
  });

  it('重复执行不再应用已完成的迁移', () => {
    const db = new DatabaseSync(':memory:');
    const migrations: Migration[] = [{ version: 1, up: (handle) => handle.exec('CREATE TABLE a (x INTEGER)') }];
    runMigrations(db, migrations);
    expect(runMigrations(db, migrations)).toEqual({ from: 1, to: 1, applied: [] });
    db.close();
  });

  it('迁移中途失败则整体回滚且版本号不动', () => {
    const db = new DatabaseSync(':memory:');
    const migrations: Migration[] = [
      {
        version: 1,
        up: (handle) => {
          handle.exec('CREATE TABLE ok (x INTEGER)');
          handle.exec('CREATE TABLE ok (x INTEGER)');
        },
      },
    ];
    expect(() => runMigrations(db, migrations)).toThrow(/迁移 1 失败/);
    expect(readVersion(db)).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").get()).toBeUndefined();
    db.close();
  });

  it('低号迁移晚于高号 push 时仍然要跑（新装机不再漏表）', () => {
    const db = new DatabaseSync(':memory:');
    // 装配顺序 = push 顺序：`workflow-store`(4) 排在 `jd-store`(3) 之前，水位因此先到了 4。
    // 旧设计按 `version <= 水位` 跳过，于是 `jobs` 在一份全新用户目录里永远建不出来。
    const high: Migration = {
      version: 4,
      up: (handle) => handle.exec('CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY)'),
    };
    const low: Migration = {
      version: 3,
      up: (handle) => handle.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY)'),
    };
    expect(runMigrations(db, [high])).toEqual({ from: 0, to: 4, applied: [4] });
    expect(runMigrations(db, [high, low])).toEqual({ from: 4, to: 4, applied: [3] });
    expect(tableExists(db, 'jobs')).toBe(true);
    expect(ledgerVersions(db)).toEqual([3, 4]);
    db.close();
  });

  it('只有水位没有台账的老库：幂等 DDL 重跑一次并把账补齐', () => {
    const db = new DatabaseSync(':memory:');
    const migrations: Migration[] = [
      { version: 1, up: (handle) => handle.exec('CREATE TABLE IF NOT EXISTS usage_ledger (id INTEGER PRIMARY KEY)') },
      { version: 2, up: (handle) => handle.exec('CREATE TABLE IF NOT EXISTS chat_session (id TEXT PRIMARY KEY)') },
    ];
    runMigrations(db, migrations);
    // 老库的真实形态：`schema_migrations` 还不存在，但 `user_version` 已经被旧设计推到 2。
    db.exec('DROP TABLE schema_migrations');
    expect(runMigrations(db, migrations)).toEqual({ from: 2, to: 2, applied: [1, 2] });
    expect(readVersion(db)).toBe(2);
    expect(ledgerVersions(db)).toEqual([1, 2]);
    db.close();
  });

  it('迁移失败时不记账，下次启动会重试而不是永久跳过', () => {
    const db = new DatabaseSync(':memory:');
    const broken: Migration = {
      version: 1,
      up: (handle) => {
        handle.exec('CREATE TABLE probe (a INTEGER)');
        handle.exec('INSERT INTO ghost VALUES (1)');
      },
    };
    expect(() => runMigrations(db, [broken])).toThrow(/迁移 1 失败/);
    expect(ledgerVersions(db)).toEqual([]);
    expect(readVersion(db)).toBe(0);
    // 同一版修好后再来一次：这一次真的要建出来，而不是因为「水位到过」被跳过。
    const fixed: Migration = { version: 1, up: (handle) => handle.exec('CREATE TABLE probe (a INTEGER)') };
    expect(runMigrations(db, [fixed])).toEqual({ from: 0, to: 1, applied: [1] });
    expect(ledgerVersions(db)).toEqual([1]);
    db.close();
  });

  it('版本重复或非正整数在动手前就报错', () => {
    const db = new DatabaseSync(':memory:');
    const noop: Migration = { version: 1, up: () => {} };
    expect(() => runMigrations(db, [noop, { ...noop }])).toThrow(/版本重复/);
    expect(() => runMigrations(db, [{ version: 0, up: () => {} }])).toThrow(/正整数/);
    db.close();
  });
});

describe('migration 回滚（spec 2.3-05）', () => {
  /** 两版可回滚迁移：v1 建 meta，v2 建 jobs，`down` 各自删掉自己建的表。 */
  const migrations: Migration[] = [
    {
      version: 1,
      up: (handle) => handle.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)'),
      down: (handle) => handle.exec('DROP TABLE meta'),
    },
    {
      version: 2,
      up: (handle) => handle.exec("CREATE TABLE jobs (id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT '')"),
      down: (handle) => handle.exec('DROP TABLE jobs'),
    },
  ];

  it('逐版倒序执行 down 并把版本号一起退回去', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, migrations);
    expect(readVersion(db)).toBe(2);

    expect(rollback(db, migrations, 1)).toEqual({ from: 2, to: 1, reverted: [2] });
    expect(readVersion(db)).toBe(1);
    expect(tableExists(db, 'jobs')).toBe(false);
    expect(tableExists(db, 'meta')).toBe(true);

    expect(rollback(db, migrations, 0)).toEqual({ from: 1, to: 0, reverted: [1] });
    expect(readVersion(db)).toBe(0);
    expect(tableExists(db, 'meta')).toBe(false);
    db.close();
  });

  it('回滚后可以再次 upgrade，结构回到同一版本', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, migrations);
    rollback(db, migrations, 0);
    expect(runMigrations(db, migrations)).toEqual({ from: 0, to: 2, applied: [1, 2] });
    expect(tableExists(db, 'jobs')).toBe(true);
    db.close();
  });

  it('缺 down 的迁移显式失败，且版本号与已倒回的版本保持真实', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, migrations);
    const withoutDown: Migration[] = [{ ...migrations[0]!, down: undefined }, migrations[1]!];
    // v2 有 down 会先倒成功，v1 没有 down 才停：版本停在 1 而不是被写成 0。
    expect(() => rollback(db, withoutDown, 0)).toThrow(/迁移 1 缺少 down/);
    expect(readVersion(db)).toBe(1);
    expect(tableExists(db, 'jobs')).toBe(false);
    expect(tableExists(db, 'meta')).toBe(true);
    db.close();
  });

  it('目标版本高于当前版本或为负数时不动任何表', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, migrations);
    expect(() => rollback(db, migrations, 3)).toThrow(/高于当前版本/);
    expect(() => rollback(db, migrations, -1)).toThrow(/≥0 的整数/);
    expect(readVersion(db)).toBe(2);
    expect(rollback(db, migrations, 2)).toEqual({ from: 2, to: 2, reverted: [] });
    db.close();
  });

  it('down 中途失败则那一版整体不生效且版本不动', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, migrations);
    const brokenDown: Migration[] = [
      migrations[0]!,
      {
        version: 2,
        up: () => {},
        down: () => {
          throw new Error('模拟 down 失败');
        },
      },
    ];
    expect(() => rollback(db, brokenDown, 1)).toThrow(/回滚 2 失败：模拟 down 失败/);
    expect(readVersion(db)).toBe(2);
    expect(tableExists(db, 'jobs')).toBe(true);
    db.close();
  });
});
