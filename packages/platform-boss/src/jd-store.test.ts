/**
 * `jd.store` 的落库用例（spec 2.3-02 / 2.3-04 / 2.3-05）。
 *
 * 一律打**真的 `node:sqlite`**（临时目录，不进仓库）：幂等、合并方向、`RETURNING` 拿回的 id、
 * 迁移回滚这四件事 mock 掉就等于没测。库内一行的坏值也要能读出来（库里可能躺着别的程序写进来的
 * 东西），所以最后一组用例直接手写列值。
 */
import { asApp, Context, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { UsageLedgerService } from '@auto-cc/plugin-entitlement';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { JD_MIGRATION_VERSION, JdStoreService, type JobDraft } from './jd-store.js';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 开一个系统临时目录并记账（用例结束后统一删除，AGENTS.md §7.5）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-jd-store-'));
  sandboxes.push(dir);
  return dir;
}

/**
 * 挂起一套 config + store + jd.store。
 * @param dir 库文件目录（省略则新开一个临时目录）
 * @returns 上下文、`store` 与 `jd.store` 服务、裸连接，以及 `jd.store` 的 fiber（重启用例要先停掉它）
 */
async function boot(dir = tempDir()) {
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  const jdFiber = await ctx.plugin(JdStoreService, {});
  fibers.push(jdFiber);
  const app = asApp(ctx);
  return { ctx, jdFiber, store: app.store, jd: app['jd.store'], db: app.store.db };
}

/** 一条最小可用的入库草稿（幂等键齐全）。 */
function draft(overrides: Partial<JobDraft> = {}): JobDraft {
  return {
    platform: 'boss',
    jobId: '1001',
    title: '资深前端工程师',
    company: '示例科技',
    salaryText: '25-40K·15薪',
    city: '上海',
    sourceUrl: 'http://127.0.0.1:10233/boss/detail?jobId=1001',
    capturedAt: 1_700_000_000_000,
    ...overrides,
  };
}

afterAll(async () => {
  // 先释放 fiber（关连接）再删目录：Windows 上句柄延迟释放会挡住删除。
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不该把一次通过的验收判成失败。
    }
  }
});

describe('建表与迁移（spec 2.3-05）', () => {
  it('挂载即把 jobs 表建出来，schema 版本停在号段 3', async () => {
    const { jd, store, db } = await boot();
    const table = db.prepare("select name from sqlite_master where type = 'table' and name = 'jobs'").get() as {
      name?: string;
    };
    expect(table?.name).toBe('jobs');
    expect(store.version).toBe(JD_MIGRATION_VERSION);
    expect(jd.status().schemaVersion).toBe(JD_MIGRATION_VERSION);
    // 号段是全局的（`usage_ledger` 占 1、`chat` 占 2），撞号在运行期才炸，所以把它钉在断言里。
    expect(JD_MIGRATION_VERSION).toBe(3);
  });

  it('幂等键 (source_url, title) 上有唯一索引，抓取列表上有倒序索引', async () => {
    const { db } = await boot();
    const indexes = (
      db.prepare("select name from sqlite_master where type = 'index' and tbl_name = 'jobs'").all() as {
        name: string;
      }[]
    ).map((row) => row['name']);
    expect(indexes).toContain('jobs_source_title');
    expect(indexes).toContain('jobs_captured_at');
  });

  it('重复挂载不会往共享迁移清单里塞第二个 v3（插件重启就是重写一遍号段的话）', async () => {
    const { ctx, store, jdFiber } = await boot();
    expect(store.migrations.filter((item) => item.version === JD_MIGRATION_VERSION)).toHaveLength(1);
    // 同一个 Context 里挂着两份 `jd.store` 会直接报「服务已注册」，所以重启的真实形状是「先停再装」。
    await jdFiber.dispose();
    fibers.push(await ctx.plugin(JdStoreService, {}));
    expect(store.migrations.filter((item) => item.version === JD_MIGRATION_VERSION)).toHaveLength(1);
    expect(store.version).toBe(JD_MIGRATION_VERSION);
    // 版本没重复只是一半，另一半是「重启之后照样写得进去」：表还在，`upgrade()` 在已到版本上是空转。
    expect(asApp(ctx)['jd.store'].upsert(draft()).created).toBe(true);
    expect(asApp(ctx)['jd.store'].count()).toBe(1);
  });

  it('回滚把表整张丢掉，再升级又建得回来（down 路径实测）', async () => {
    const { store, db, jd } = await boot();
    jd.upsert(draft());
    expect(jd.count()).toBe(1);

    const back = store.rollback(2);
    expect(back.reverted).toEqual([3]);
    expect(store.version).toBe(2);
    const leftovers = db
      .prepare("select name from sqlite_master where type in ('table','index') and tbl_name = 'jobs'")
      .all() as { name: string }[];
    expect(leftovers).toEqual([]);
    // 查询接口直接失败在 sqlite 层：这是「表真的不在了」的证据，不是我们的判断。
    expect(() => jd.count()).toThrowError(/no such table/);

    store.upgrade();
    expect(store.version).toBe(3);
    expect(jd.count()).toBe(0);
    expect(jd.upsert(draft()).created).toBe(true);
  });

  it('与 usage_ledger 同库共存时迁移按版本各就各位，互不越界', async () => {
    const dir = tempDir();
    const ctx = new Context();
    fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
    fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
    fibers.push(await ctx.plugin(UsageLedgerService, {}));
    fibers.push(await ctx.plugin(JdStoreService, {}));
    const app = asApp(ctx);
    const versions = app.store.migrations.map((item) => item.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toContain(1);
    expect(app.store.version).toBe(JD_MIGRATION_VERSION);
    expect(app.store.db.prepare('SELECT COUNT(*) AS n FROM usage_ledger').get()).toBeTruthy();
    expect(app['jd.store'].count()).toBe(0);
  });
});

describe('UPSERT 幂等与合并方向（spec 2.3-04）', () => {
  it('同一来源地址 + 同一标题写两次只有一行，第二次是更新而不是新行', async () => {
    const { jd } = await boot();
    const first = jd.upsert(draft());
    const second = jd.upsert(draft({ capturedAt: 1_700_000_009_000 }));
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ id: first.id, created: false });
    expect(jd.count()).toBe(1);
  });

  it('id 来自 RETURNING 的合并后行：走更新分支时 lastInsertRowid 是不变的', async () => {
    const { jd } = await boot();
    const original = jd.upsert(draft({ jobId: 'A' }));
    const other = jd.upsert(
      draft({ jobId: 'B', title: '另一个岗位', sourceUrl: 'http://127.0.0.1:10233/boss/detail?jobId=B' }),
    );
    const updated = jd.upsert(draft({ jobId: 'A-改过 jobId' }));
    expect(updated.id).toBe(original.id);
    expect(other.id).toBeGreaterThan(original.id);
    // 更新分支改的是原来那一行：别的行没被顺手动过。
    const rows = jd.list(500).rows;
    expect(rows.find((row) => row.id === original.id)?.jobId).toBe('A-改过 jobId');
    expect(rows.find((row) => row.id === other.id)?.jobId).toBe('B');
    expect(jd.count()).toBe(2);
  });

  it('空值不覆盖已有正文，captured_at 反过来永远取新', async () => {
    const { jd, db } = await boot();
    jd.upsert(
      draft({
        description: '上一轮读到的职责正文',
        requirements: ['五年经验'],
        postedText: '3 天前',
        detailCapturedAt: 1_600_000_000_000,
      }),
    );
    const merged = jd.upsert(
      draft({
        company: '',
        description: '',
        requirements: [],
        salaryText: '',
        postedText: '',
        capturedAt: 1_800_000_000_000,
      }),
    );
    expect(merged.hasDetail).toBe(true);
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(merged.id) as Record<string, unknown>;
    expect(row['description']).toBe('上一轮读到的职责正文');
    expect(row['company']).toBe('示例科技');
    expect(row['salary_text']).toBe('25-40K·15薪');
    expect(row['requirements_json']).toBe('["五年经验"]');
    expect(row['posted_text']).toBe('3 天前');
    expect(Number(row['captured_at'])).toBe(1_800_000_000_000);
    expect(Number(row['detail_captured_at'])).toBe(1_600_000_000_000);
  });

  it('hasDetail 读的是合并后的行，不是「这次带没带」', async () => {
    const { jd } = await boot();
    expect(jd.upsert(draft()).hasDetail).toBe(false);
    expect(jd.upsert(draft({ detailCapturedAt: 1_600_000_000_000 })).hasDetail).toBe(true);
    // 再抓一次列表（不带详情字段）仍然知道这行有详情：阶段 B 因此能跳过它。
    expect(jd.upsert(draft()).hasDetail).toBe(true);
  });

  it('缺标题或来源地址直接拒绝——它们俩就是幂等键', async () => {
    const { jd } = await boot();
    expect(() => jd.upsert(draft({ title: '   ' }))).toThrowError(/需要同时有标题与来源地址/);
    expect(() => jd.upsert(draft({ sourceUrl: '' }))).toThrowError(/需要同时有标题与来源地址/);
    expect(jd.count()).toBe(0);
  });

  it('标题与地址两端空白折叠成同一个键（页面正文常带空格与换行）', async () => {
    const { jd } = await boot();
    const first = jd.upsert(draft({ title: '  资深前端工程师  ' }));
    const second = jd.upsert(draft({ sourceUrl: ' http://127.0.0.1:10233/boss/detail?jobId=1001 ' }));
    expect(second.id).toBe(first.id);
    expect(jd.count()).toBe(1);
  });
});

describe('只读接口（spec 2.3-09 的界面读数）', () => {
  it('list 按最近抓到倒序，limit 钳到 1～500 而不是照收乱值', async () => {
    const { jd } = await boot();
    jd.upsert(draft({ jobId: 'old', title: '旧岗位', capturedAt: 1 }));
    jd.upsert(
      draft({
        jobId: 'new',
        title: '新岗位',
        sourceUrl: 'http://127.0.0.1:10233/boss/detail?jobId=new',
        capturedAt: 999,
      }),
    );
    expect(jd.list().rows.map((row) => row.title)).toEqual(['新岗位', '旧岗位']);
    expect(jd.list(1).rows).toHaveLength(1);
    // 0 与乱值都收到合法区间：界面传坏值不该把整库倒出来，也不该报错。
    expect(jd.list(0).rows).toHaveLength(1);
    expect(jd.list(9999).rows).toHaveLength(2);
    expect(jd.list(Number.NaN).rows).toHaveLength(2);
    // total 不受 limit 影响：界面要能说明「库里还有」。
    expect(jd.list(1).total).toBe(2);
  });

  it('status 给出总数、有详情数与最近一次的来源地址', async () => {
    const { jd } = await boot();
    jd.upsert(draft({ detailCapturedAt: 5 }));
    jd.upsert(draft({ jobId: 'B', title: '只抓到摘要', sourceUrl: 'http://127.0.0.1:10233/boss/detail?jobId=B' }));
    expect(jd.status()).toEqual({
      total: 2,
      withDetail: 1,
      schemaVersion: JD_MIGRATION_VERSION,
      newestSourceUrl: 'http://127.0.0.1:10233/boss/detail?jobId=B',
    });
  });

  it('库里存的坏 JSON 读成中性值，不让一行脏数据炸掉整页', async () => {
    const { jd, db } = await boot();
    jd.upsert(
      draft({ salary: { min: 25, max: 40, unit: 'k', period: 'month', salaryMonths: 15, isNegotiable: false } }),
    );
    db.prepare("UPDATE jobs SET requirements_json = '{不是数组}', salary_json = '{坏值}' WHERE id = 1").run();
    const [row] = jd.list().rows;
    expect(row?.requirements).toEqual([]);
    expect(row?.salary).toBeNull();
    // 原文照存：界面仍然看得到「我们读到了什么」。
    expect(row?.salaryText).toBe('25-40K·15薪');
  });
});
