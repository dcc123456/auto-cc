/**
 * store 服务装配测试（spec 1.3-06 / 1.3-07 / 1.3-08）。
 *
 * 用真的 `node:sqlite` 落临时文件：WAL、版本号、迁移这三件事一旦 mock 掉就等于没测。
 * 主进程内可用性由 `docs/acceptance/1.3/1.3-06-node-sqlite-in-electron.txt` 记录，
 * 这里覆盖的是服务语义。临时库都落在 os.tmpdir，不进仓库（AGENTS.md §7.5）。
 */
import { asApp, Context, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { StoreService, storeSchema, type StoreConfig } from './index.js';

const sandboxes: string[] = [];
const opened: Fiber[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-store-'));
  sandboxes.push(dir);
  return dir;
}

afterAll(async () => {
  // 先关连接（WAL 句柄在 Windows 上会挡住删除），再清临时目录，不给仓库和系统留残渣。
  for (const fiber of opened) await fiber.dispose();
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

async function open(dir: string, options: { file?: string; journal?: 'wal' | 'delete' } = {}) {
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  const fiber = ctx.plugin(StoreService, {
    dir,
    file: options.file ?? 'store.db',
    journal: options.journal ?? 'wal',
  });
  await fiber;
  opened.push(fiber);
  return { ctx, fiber, store: asApp(ctx).store };
}

/** 被测结构清单：`schema_migrations` 是迁移器自己的台账，不属于任何一条断言里的「业务表」。 */
function tables(db: DatabaseSync): string[] {
  return db
    .prepare("select name from sqlite_master where type = 'table' and name != 'schema_migrations' order by name")
    .all()
    .map((row) => String(row['name']));
}

describe('store 服务（node:sqlite + 迁移）', () => {
  it('驱动与版本如实上报，不引入原生编译依赖（spec 1.3-06）', async () => {
    const { store } = await open(tempDir());
    expect(store.driverInfo()).toMatch(/^node:sqlite \/ sqlite 3\.\d+\.\d+/);
  });

  it('WAL 生效并产生 -wal 文件（spec 1.3-07）', async () => {
    const dir = tempDir();
    const { store } = await open(dir);
    expect(store.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    store.db.exec('create table probe (a integer)');
    store.db.exec('insert into probe values (1)');
    expect(readdirSync(dir)).toContain('store.db-wal');
  });

  it('卸载后连接句柄被 effect 释放，WAL 侧文件收回主库（spec 1.3-08）', async () => {
    const dir = tempDir();
    const { fiber, store } = await open(dir);
    store.db.exec('create table probe (a integer)');
    store.db.exec('insert into probe values (1)');
    expect(readdirSync(dir)).toContain('store.db-wal');

    await fiber.dispose();
    expect(store.isOpen).toBe(false);
    // 最后一个连接干净关闭时 sqlite 会把 -wal/-shm 合并回主库并删除；
    // 若挂载只开了一次连接、卸载真的回收了它，这里就不会有残留，Windows 上也不会删不干净。
    expect(readdirSync(dir).filter((name) => name.endsWith('-wal') || name.endsWith('-shm'))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('journal=delete 时按配置切换，不是写死 WAL（spec 1.3-08）', async () => {
    const { store } = await open(tempDir(), { journal: 'delete' });
    expect(store.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
  });

  it('迁移把 user_version 推上去，重复 upgrade 不再执行（spec 1.3-07）', async () => {
    const { store } = await open(tempDir());
    expect(store.version).toBe(0);

    store.migrations.push(
      { version: 1, up: (db) => db.exec('create table usage (id integer primary key)') },
      { version: 2, up: (db) => db.exec('create table ledger (id integer primary key)') },
    );
    expect(store.upgrade()).toEqual({ from: 0, to: 2, applied: [1, 2] });
    expect(store.version).toBe(2);
    expect(store.upgrade()).toEqual({ from: 2, to: 2, applied: [] });
    expect(tables(store.db)).toEqual(['ledger', 'usage']);
  });

  it('关库重开：schema 版本与数据都在，迁移不会重复跑（spec 1.3-07）', async () => {
    const dir = tempDir();
    const first = await open(dir);
    first.store.migrations.push({
      version: 1,
      up: (db) => db.exec('create table profile (id integer primary key, name text)'),
    });
    first.store.upgrade();
    first.store.db.prepare('insert into profile (id, name) values (1, ?)').run('张三');
    await first.fiber.dispose();
    expect(first.store.isOpen).toBe(false);

    const second = await open(dir);
    expect(second.store.version).toBe(1);
    expect(second.store.migrationResult.applied).toEqual([]);
    expect(second.store.db.prepare('select name from profile where id = 1').get()).toEqual({ name: '张三' });
  });

  it('迁移失败时版本不动、半成品表不存在（spec 1.3-07 回滚）', async () => {
    const { store } = await open(tempDir());
    store.migrations.push({
      version: 1,
      up: (db) => {
        db.exec('create table half_built (a integer)');
        db.exec('insert into ghost_table values (1)');
      },
    });
    expect(() => store.upgrade()).toThrow(/迁移 1 失败/);
    expect(store.version).toBe(0);
    expect(tables(store.db)).toEqual([]);
  });

  it('未跑完 init 时读 db 给出可读原因，而不是 undefined 崩在别处', () => {
    const ctx = new Context();
    // 直接构造：`[Service.init]` 只在作为插件挂载时才执行，因此这是「已构造未就绪」的真实状态。
    const store = new StoreService(ctx, { dir: tempDir(), file: 'store.db', journal: 'wal' });
    expect(store.isOpen).toBe(false);
    expect(() => store.db).toThrow(/尚未完成挂载/);
  });

  it('配置严格校验：未知键在挂载期就点名（spec 1.3-08）', async () => {
    const ctx = new Context();
    await ctx.plugin(ConfigService, { appName: 'auto-cc' });
    // 未知键只会来自清单/env 这类编译期看不见的来源，所以这里绕开字面量的多余属性检查。
    const illegal: unknown = { dir: tempDir(), file: 'store.db', journal: 'wal', dir2: 'oops' };
    await expect(ctx.plugin(StoreService, illegal as StoreConfig)).rejects.toThrow(/dir2/);
    expect(storeSchema.safeParse({ dir: 'x', file: 'store.db', journal: 'wal' }).success).toBe(true);
  });
});
