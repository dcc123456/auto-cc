import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { readVersion, runMigrations, type Migration } from './migrate.js';

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

  it('版本重复或非正整数在动手前就报错', () => {
    const db = new DatabaseSync(':memory:');
    const noop: Migration = { version: 1, up: () => {} };
    expect(() => runMigrations(db, [noop, { ...noop }])).toThrow(/版本重复/);
    expect(() => runMigrations(db, [{ version: 0, up: () => {} }])).toThrow(/正整数/);
    db.close();
  });
});
