/**
 * `outbound.deliveries` 的落库用例（spec 3.7-02）。
 *
 * 一律打**真的 `node:sqlite`**（系统临时目录，不进仓库，AGENTS.md §7.5）：这张表存在的全部理由就是「事后查得到」，
 * 所以判据只能是——写进库、拔掉服务、重开、再按 JD 与按快照两个方向读回来。
 * 「成功才写、失败一行都不写」那条性质属于编排，在 `deliver.test.ts` 里测；这里只管这张表本身。
 */
import { asApp, Context, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DELIVERY_RECORD_MIGRATION_VERSION,
  DeliveryRecordService,
  type DeliveryRecord,
} from './delivery-record-store.js';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 建一个系统临时目录（用完由 `afterAll` 清理，不进仓库，AGENTS.md §7.5）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-delivery-records-'));
  sandboxes.push(dir);
  return dir;
}

/**
 * 挂起 config + store + outbound.deliveries。
 * @param dir 复用哪个目录（演「换个进程重挂同一份库」时传同一个）
 * @returns 记录服务、裸连接与账本侧的同名读数入口（用来看两表是否真的一一对齐）
 */
async function boot(dir = tempDir()) {
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(DeliveryRecordService, {}));
  return { records: asApp(ctx)['outbound.deliveries'], db: asApp(ctx).store.db };
}

/**
 * 一条合法的投递记录读数。
 * @param overrides 覆盖项（账本行 id、目标、快照引用、时间）
 * @returns 交给 `record` 的入参
 */
function record(overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    ledgerId: 1,
    platform: 'boss',
    jobId: 'job-1001',
    snapshotId: 'snap-1',
    ts: 1_760_000_000_000,
    ...overrides,
  };
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不该把一次通过的验收判成失败（Windows 句柄延迟释放）。
    }
  }
});

describe('建表与迁移', () => {
  it('挂载即建 delivery_records 表，迁移号段为 9', async () => {
    const { db } = await boot();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='delivery_records'").get() as
      { name?: string } | undefined;
    expect(row?.name).toBe('delivery_records');
    expect(DELIVERY_RECORD_MIGRATION_VERSION).toBe(9);
  });

  it('迁移号段不复用任何已分配号段（撞号的后果是「见号已存在就跳过建表」，表根本不存在）', () => {
    // 已分配：账本 1 / agent 会话 2 / jobs 3 / workflow run 4 / conversation 5 / consent 6 / resume_docs 7 / resume_snapshots 8。
    const taken = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(taken.has(DELIVERY_RECORD_MIGRATION_VERSION)).toBe(false);
  });
});

describe('3.7-02 记录的写入与读取', () => {
  it('record 之后按账本行 id 读回，逐字段与写入一致（回执里的 ledgerId 就是这里的钥匙）', async () => {
    const { records } = await boot();
    records.record(record());
    expect(records.get(1)).toEqual(record());
  });

  it('没有对应投递的账本行 id → null，不抛异常', async () => {
    const { records } = await boot();
    expect(records.get(99)).toBeNull();
  });

  it('请求没带快照引用时 snapshot_id 留空而不是编一个：null 是「只递了个文件」的实话', async () => {
    const { records } = await boot();
    records.record(record({ snapshotId: null }));
    expect(records.get(1)?.snapshotId).toBeNull();
  });

  it('同一个账本行 id 写第二次被主键拒掉：一次投递只有一条经过，写两遍就是编排层出了 bug', async () => {
    const { records } = await boot();
    records.record(record());
    expect(() => records.record(record({ jobId: 'job-other' }))).toThrowError();
    expect(records.listFor('job-other')).toEqual([]);
  });

  it('按 JD 查是时间倒序（最近递了哪几版在前），按快照反查是正序（这一版先后递给了谁）', async () => {
    const { records } = await boot();
    records.record(record({ ledgerId: 10, jobId: 'job-A', snapshotId: 'snap-shared', ts: 100 }));
    records.record(record({ ledgerId: 11, jobId: 'job-A', snapshotId: 'snap-2', ts: 300 }));
    records.record(record({ ledgerId: 12, jobId: 'job-B', snapshotId: 'snap-shared', ts: 200 }));
    expect(records.listFor('job-A').map((item) => item.ledgerId)).toEqual([11, 10]);
    expect(records.listBySnapshot('snap-shared').map((item) => item.ledgerId)).toEqual([10, 12]);
    expect(records.listBySnapshot('snap-never-used')).toEqual([]);
  });

  it('拔掉服务重开同一目录后仍能读回（证明落的是库不是内存）', async () => {
    const dir = tempDir();
    const first = await boot(dir);
    first.records.record(record({ ledgerId: 7, jobId: 'job-persist' }));
    for (const fiber of fibers.splice(0)) await fiber.dispose();
    const second = await boot(dir);
    expect(second.records.get(7)?.jobId).toBe('job-persist');
  });
});
