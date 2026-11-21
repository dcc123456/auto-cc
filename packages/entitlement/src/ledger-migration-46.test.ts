/**
 * 迁移 46 的断言（spec 10.11-26）：旧库升级后数据原样、`confirmed_at` 为空、
 * `site-default` 可写、重复四元组仍被拒。
 *
 * 为什么用真的 `node:sqlite` 并从旧 schema 起：迁移的判据是「老库上的数据搬得对不对」，
 * 在空库上跑等于只验了建表语句。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { outboundAttemptsSiteDefaultMigration } from './ledger.js';

const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上句柄可能未释放，残渣留在系统 temp。
    }
  }
});

/** 建一份「迁移 46 之前」的库：43 号的表结构 + 4 条 unknown + 1 条 succeeded。 */
function legacyDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-m46-'));
  sandboxes.push(dir);
  const db = new DatabaseSync(join(dir, 'store.db'));
  db.exec(`CREATE TABLE outbound_attempts (
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
  const insert = db.prepare(
    `INSERT INTO outbound_attempts
      (platform, target_id, action, resume_version, workflow_run_id, status, ledger_id, receipt_id, reason, updated_at)
     VALUES (?, ?, 'greet', 'doc:r1:h1', NULL, ?, ?, ?, ?, 1000)`,
  );
  insert.run('boss', 'job-a', 'unknown', null, null, 'OUTBOUND_UNTRACKED_SITE_GREETING');
  insert.run('boss', 'job-b', 'unknown', null, null, 'OUTBOUND_UNTRACKED_SITE_GREETING');
  insert.run('boss', 'job-c', 'unknown', null, null, 'WAIT_TIMEOUT');
  insert.run('boss', 'job-d', 'unknown', null, null, 'OUTBOUND_UNTRACKED_SITE_GREETING');
  insert.run('boss', 'job-e', 'succeeded', 7, 'rcpt-1', null);
  return db;
}

describe('迁移 46：尝试台账扩宽（site-default + confirmed_at）', () => {
  it('旧库升级：5 行原样搬过来、confirmed_at 全为 NULL、site-default 可写、重复四元组被拒', () => {
    const db = legacyDb();
    try {
      outboundAttemptsSiteDefaultMigration.up(db);
      const rows = db.prepare('SELECT * FROM outbound_attempts ORDER BY id').all() as Record<string, unknown>[];
      expect(rows).toHaveLength(5);
      expect(rows.map((row) => row['target_id'])).toEqual(['job-a', 'job-b', 'job-c', 'job-d', 'job-e']);
      expect(rows.filter((row) => row['status'] === 'unknown')).toHaveLength(4);
      expect(rows.every((row) => row['confirmed_at'] === null)).toBe(true);
      expect(rows.find((row) => row['target_id'] === 'job-e')?.['ledger_id']).toBe(7);
      // 新状态可写
      db.prepare(
        `INSERT INTO outbound_attempts (platform, target_id, action, resume_version, status, reason, updated_at)
         VALUES ('boss', 'job-f', 'greet', 'doc:r1:h1', 'site-default', 'SITE_DEFAULT_GREETING', 2000)`,
      ).run();
      // 四元组唯一约束仍在：重复插入必须抛
      expect(() =>
        db
          .prepare(
            `INSERT INTO outbound_attempts (platform, target_id, action, resume_version, status, reason, updated_at)
           VALUES ('boss', 'job-a', 'greet', 'doc:r1:h1', 'site-default', 'SITE_DEFAULT_GREETING', 3000)`,
          )
          .run(),
      ).toThrow();
      // 旧状态值仍然拒绝
      expect(() =>
        db
          .prepare(
            `INSERT INTO outbound_attempts (platform, target_id, action, resume_version, status, updated_at)
           VALUES ('boss', 'job-g', 'greet', 'doc:r1:h1', 'bogus', 3000)`,
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
