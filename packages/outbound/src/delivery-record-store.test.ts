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
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DELIVERY_CONVERSATION_TARGET_MIGRATION_VERSION,
  DELIVERY_RECORD_MIGRATION_VERSION,
  DELIVERY_TIME_INDEX_MIGRATION_VERSION,
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
 * @returns 记录服务、裸连接、账本侧的同名读数入口（用来看两表是否真的一一对齐），
 *          以及上下文与本次挂载的目录与本服务的 `Fiber`（「老库升到 35」那条要摘掉重挂，必须能指名 dispose 哪一支）
 */
async function boot(dir = tempDir()) {
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  const recordsFiber = await ctx.plugin(DeliveryRecordService, {});
  fibers.push(recordsFiber);
  return {
    ctx,
    dir,
    records: asApp(ctx)['outbound.deliveries'],
    db: asApp(ctx).store.db,
    recordsFiber,
  };
}

/**
 * 列出 `delivery_records` 现有的列名（「老库」那一形状的直接读数：列在不在，不靠报错猜）。
 * @param db 裸连接
 * @returns 列名数组，按建表顺序
 */
function columnNames(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(delivery_records)').all() as { name?: string }[]).map((column) =>
    String(column.name),
  );
}

/**
 * 一条合法的投递记录读数。
 * @param overrides 覆盖项（账本行 id、目标坐标、快照引用、时间）
 * @returns 交给 `record` 的入参
 */
function record(overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    ledgerId: 1,
    platform: 'boss',
    jobId: 'job-1001',
    // 默认这一条走的是岗位坐标：会话坐标那一路在用例里显式覆盖（裁定⑲ 搬到投递）。
    conversationTarget: null,
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

  it('号段 27 是「时间索引」这一条的新号，不与前二十六撞（spec 5.8-05）', () => {
    // 已分配：1…8 见上一条，9 是本表，10…25 是后续各包，26 是会话库的时间索引（号段全局，撞号的后果同上）。
    const allocated = new Set(Array.from({ length: 26 }, (_entry, position) => position + 1));
    expect(DELIVERY_TIME_INDEX_MIGRATION_VERSION).toBe(27);
    expect(allocated.has(DELIVERY_TIME_INDEX_MIGRATION_VERSION)).toBe(false);
  });

  it('号段 27 建的索引在，区间计数走它而不是全表扫（万级记录下的计时证据）', async () => {
    const { db } = await boot();
    const index = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_delivery_records_ts'")
      .get() as { name?: string } | undefined;
    expect(index?.name).toBe('idx_delivery_records_ts');
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM delivery_records WHERE ts >= ? AND ts < ?')
      .all(1, 2) as unknown as { detail?: string }[];
    expect(plan.some((row) => /idx_delivery_records_ts/i.test(row.detail ?? ''))).toBe(true);
  });

  it('号段 35 是「会话坐标列」这一条的新号，不与前面三十四撞（8.5-D，裁定⑲ 搬到投递）', () => {
    // 已分配：1…8 见上面两条，9 是本表，10…25 是后续各包，26/27 是两张时间索引，28/29 是工作流图与节点输出，
    // 30 按 plan §8.3 预留给 3.6 的草稿表（当前未启用），31/32 是提供商池与模型清单，33 是会话表的同名列。
    const allocated = new Set(Array.from({ length: 34 }, (_entry, position) => position + 1));
    expect(DELIVERY_CONVERSATION_TARGET_MIGRATION_VERSION).toBe(35);
    expect(allocated.has(DELIVERY_CONVERSATION_TARGET_MIGRATION_VERSION)).toBe(false);
  });
});

describe('按区间数投递成功条数（spec 5.8-01 的投递记录半边）', () => {
  it('含头不含尾：下界那一刻算进来，上界那一刻不算', async () => {
    const { records } = await boot();
    records.record(record({ ledgerId: 1, ts: 1_000 }));
    records.record(record({ ledgerId: 2, jobId: 'job-2', ts: 2_000 }));
    records.record(record({ ledgerId: 3, jobId: 'job-3', ts: 3_000 }));
    expect(records.count({ fromMs: 1_000, toMs: 3_000 })).toBe(2);
    expect(records.count({ fromMs: 3_000, toMs: 4_000 })).toBe(1);
    expect(records.count({ fromMs: 0, toMs: 1_000 })).toBe(0);
    expect(records.count({ fromMs: 0, toMs: 4_000 })).toBe(3);
  });

  it('库里没有记录时给 0 而不是报错：看板刚装好、还没递过任何东西就是这一档', async () => {
    const { records } = await boot();
    expect(records.count({ fromMs: 0, toMs: Number.MAX_SAFE_INTEGER })).toBe(0);
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

  it('会话那一行只落会话坐标：job_id 那一格读回 null，按岗位查它不出现（裁定⑲ 搬到投递）', async () => {
    const { records } = await boot();
    records.record(record({ ledgerId: 21, jobId: null, conversationTarget: '示例科技' }));
    expect(records.get(21)).toMatchObject({ jobId: null, conversationTarget: '示例科技' });
    // 库里那一格是空串（列是 NOT NULL），读回视图时归 null：不给"这一列装两种实体"留第三种读数。
    expect(records.listFor('job-1001').map((item) => item.ledgerId)).toEqual([]);
    // 反查那一版递给了谁：这一行照常出现，带着它的会话坐标。
    expect(records.listBySnapshot('snap-1')).toMatchObject([
      { ledgerId: 21, jobId: null, conversationTarget: '示例科技' },
    ]);
  });

  it('老库（已记 9 / 27、没有会话坐标那一列）重挂后列补得上，旧行读回 null 而不是空串', async () => {
    // 这一条守的是 §9 实测 5.3-a 那一类缺陷：`runMigrations` 认的是 `schema_migrations` 台账，
    // 把 `ALTER TABLE` 补进已经记过账的号段 9 里，老用户机上永远执行不到那一支，
    // 列因此静默缺失、第一次按会话投递就以 `no such column` 失败。每个用例都从空库起，单测照不出这条腿。
    const dir = tempDir();
    const first = await boot(dir);
    first.records.record(record({ ledgerId: 31, snapshotId: 'snap-old' }));
    // 造出"老库"的真实形状：列还没有，台账里也没有 35 这一行。
    first.db.exec('ALTER TABLE delivery_records DROP COLUMN conversation_target');
    first.db
      .prepare('DELETE FROM schema_migrations WHERE version = ?')
      .run(DELIVERY_CONVERSATION_TARGET_MIGRATION_VERSION);
    expect(columnNames(first.db)).not.toContain('conversation_target');

    for (const fiber of fibers.splice(0)) await fiber.dispose();
    const second = await boot(dir);
    expect(columnNames(second.db)).toContain('conversation_target');
    // 老行拿到的是列的默认空串，读回来是 null——「那一次记的是岗位，没有会话坐标」是实话，不是缺数据。
    expect(second.records.get(31)).toMatchObject({ jobId: 'job-1001', conversationTarget: null });
    // 新写入在升好列的库上落得下去（这就是运行期第一次按会话投递要走的那一步）。
    second.records.record(record({ ledgerId: 32, jobId: null, conversationTarget: '示例科技' }));
    expect(second.records.get(32)?.conversationTarget).toBe('示例科技');
  });
});
