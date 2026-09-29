/**
 * 闸门与账本的装配测试（spec 1.9-01 / 02 / 03 / 04 / 07 / 08 / 09）。
 *
 * 一律用真的 `node:sqlite` 落临时库：额度这件事的语义就是「跨调用、跨重启的计数」，
 * mock 掉数据库等于把被验证的东西换成一个假计数。临时目录在 `os.tmpdir`，不进仓库（AGENTS.md §7.5）。
 */
import { asApp, Context, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LEDGER_MIGRATION_VERSION,
  EntitlementGateService,
  UsageLedgerService,
  dayKey,
  startOfDay,
  type GateConfig,
} from './index.js';

const sandboxes: string[] = [];
const opened: Fiber[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-entitlement-'));
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
      // Windows 上 sqlite 句柄可能尚未释放；残渣留在系统 temp，不进仓库。
    }
  }
});

/** 起一套 config + store + ledger + gate，返回两个服务实例与账本的 fiber（重启用例要它）。 */
async function boot(gateConfig: GateConfig = { mode: 'unlimited', dailyLimit: 5 }) {
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  await ctx.plugin(StoreService, { dir: tempDir(), file: 'store.db', journal: 'delete' });
  const ledgerFiber = ctx.plugin(UsageLedgerService, {});
  await ledgerFiber;
  const gateFiber = ctx.plugin(EntitlementGateService, gateConfig);
  await gateFiber;
  opened.push(ledgerFiber, gateFiber);
  const app = asApp(ctx);
  return { ctx, gate: app['entitlement.gate'], ledger: app['usage.ledger'], ledgerFiber };
}

/**
 * 把 `globalThis.fetch` 换成计数存根，用来证明闸门路径上一个网络调用都没发生。
 * @returns `calls` 累计次数（还原后仍可读）与 `restore` 还原函数
 */
function stubFetchWithoutNetwork(): { calls: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return Promise.reject(new Error('闸门不该发起网络请求'));
  };
  return { calls: () => calls, restore: () => (globalThis.fetch = original) };
}

describe('entitlement.gate（spec 1.9-01…04）', () => {
  it('check 的返回契约正是 spec 写的三个键，不多不少（1.9-01）', async () => {
    const { gate } = await boot();
    const decision = gate.check('greet');
    expect(Object.keys(decision).sort()).toEqual(['allowed', 'reason', 'remaining']);
    expect(typeof decision.allowed).toBe('boolean');
  });

  it('默认是本地无限实现：allowed=true、remaining=null、且不花一分钱（1.9-02）', async () => {
    const { gate } = await boot();
    expect(gate.check('greet')).toEqual({ allowed: true, remaining: null, reason: null });
  });

  it('配置切成「每动作每天 1 次」后，第二次判定被拒且 reason 说清原因（1.9-03）', async () => {
    const { gate } = await boot({ mode: 'daily', dailyLimit: 1 });
    expect(gate.check('greet')).toMatchObject({ allowed: true, remaining: 1 });
    await gate.perform('greet', { targetId: 'job-1' }, () => Promise.resolve('sent'));
    const after = gate.check('greet');
    expect(after).toMatchObject({ allowed: false, remaining: 0 });
    expect(after.reason).toContain('greet');
    expect(after.reason).toContain('1');
  });

  it('perform 成功后落一行，四个字段都在（1.9-04）', async () => {
    const { gate, ledger } = await boot();
    const now = Date.now();
    const { value, ledgerId } = await gate.perform(
      'deliver',
      { targetId: 'job-42', workflowRunId: 'run-7', nowMs: now },
      () => Promise.resolve('ok'),
    );
    expect(value).toBe('ok');
    const row = ledger.summary(50).recent.find((item) => item.id === ledgerId);
    expect(row).toMatchObject({ action: 'deliver', targetId: 'job-42', workflowRunId: 'run-7', ts: now });
    expect(row?.source).toBeNull();
    expect(row?.remoteRef).toBeNull();
  });

  it('被拒不落账、task 也不执行；task 抛错同样不落账（plan §8.4 决策 1）', async () => {
    const { gate, ledger } = await boot({ mode: 'daily', dailyLimit: 1 });
    await gate.perform('greet', { targetId: 'job-1' }, () => Promise.resolve('first'));

    let taskRan = false;
    const refusedTask = () => {
      taskRan = true;
      return Promise.resolve('不该被执行');
    };
    await expect(gate.perform('greet', { targetId: 'job-2' }, refusedTask)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    expect(taskRan).toBe(false);

    await expect(
      gate.perform('deliver', { targetId: 'job-3' }, () => Promise.reject(new Error('对端挂了'))),
    ).rejects.toThrow('对端挂了');

    expect(ledger.summary().total).toBe(1);
  });

  it('判定与落账全程不碰网络，所以断网不会阻塞外发（1.9-09）', async () => {
    const spy = stubFetchWithoutNetwork();
    try {
      const { gate } = await boot({ mode: 'daily', dailyLimit: 2 });
      expect(gate.check('greet').allowed).toBe(true);
      expect((await gate.perform('greet', { targetId: 'job-1' }, () => Promise.resolve('value'))).value).toBe('value');
    } finally {
      spy.restore();
    }
    expect(spy.calls()).toBe(0);
  });

  it('账本被停掉再重新挂载，不会把同一份迁移 push 两遍（plan §8.4 决策 5）', async () => {
    const { ctx, ledgerFiber } = await boot();
    const store = asApp(ctx).store;
    const ledgerVersions = () => store.migrations.filter((item) => item.version === LEDGER_MIGRATION_VERSION).length;
    expect(ledgerVersions()).toBe(1);

    await ledgerFiber.dispose();
    const remounted = ctx.plugin(UsageLedgerService, {});
    await remounted;
    expect(ledgerVersions()).toBe(1);
    // 版本没重复只是一半，另一半是「重新挂载之后照样落账」——upgrade() 在已到版本的库上是空转。
    expect(asApp(ctx)['usage.ledger'].record({ action: 'greet', targetId: 'job-x' })).toBeGreaterThan(0);
    expect(asApp(ctx)['usage.ledger'].summary().total).toBe(1);
  });
});

describe('usage.ledger 的读数（spec 1.9-07 / 1.9-08）', () => {
  it('按本地自然日分组：昨天一条、今天一条（1.9-07，日界见决策 3）', async () => {
    const { ledger } = await boot();
    const now = Date.now();
    ledger.record({ action: 'greet', targetId: 'job-old', nowMs: now - 26 * 60 * 60 * 1000 });
    ledger.record({ action: 'deliver', targetId: 'job-today', nowMs: now });
    const summary = ledger.summary();
    expect(summary.total).toBe(2);
    expect(summary.today).toBe(1);
    expect(summary.byDay).toHaveLength(2);
    expect(summary.byDay[0]).toEqual({ day: dayKey(now), count: 1, actions: [{ action: 'deliver', count: 1 }] });
    expect(summary.byAction).toEqual(
      expect.arrayContaining([
        { action: 'greet', count: 1 },
        { action: 'deliver', count: 1 },
      ]),
    );
  });

  it('source / remoteRef 存在且可空，不写也能插入（1.9-08 的「接 SaaS 不改表」）', async () => {
    const { ctx, ledger } = await boot();
    const columns = asApp(ctx).store.db.prepare('PRAGMA table_info(usage_ledger)').all() as unknown as {
      name: string;
      notnull: number;
    }[];
    for (const name of ['target_id', 'workflow_run_id', 'source', 'remote_ref']) {
      expect(columns.find((item) => item.name === name)?.notnull).toBe(0);
    }
    const withRemote = ledger.record({ action: 'greet', targetId: 'job-1', source: 'remote', remoteRef: 'bill-9' });
    expect(ledger.summary(50).recent.find((item) => item.id === withRemote)).toMatchObject({
      source: 'remote',
      remoteRef: 'bill-9',
    });
  });

  it('日界与日键都按本机时区，而不是 SQLite 的 UTC date()（决策 3）', () => {
    const midnight = startOfDay(Date.now());
    expect(midnight).toBeLessThanOrEqual(Date.now());
    expect(new Date(midnight).getHours()).toBe(0);
    expect(dayKey(midnight)).toBe(dayKey(midnight + 60 * 60 * 1000));
  });
});
