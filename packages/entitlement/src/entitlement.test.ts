/**
 * 闸门与账本的装配测试（spec 1.9-01 / 02 / 03 / 04 / 07 / 08 / 09 / 2.7-03 / 5.3-12）。
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
import type { QuotaAction } from '@auto-cc/shared';
import {
  DENIAL_MIGRATION_VERSION,
  LEDGER_MIGRATION_VERSION,
  DEFAULT_DAILY_LIMITS,
  EntitlementGateService,
  UsageLedgerService,
  dayKey,
  startOfDay,
  type GateConfig,
  type GateDailyLimits,
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

/**
 * 把 shipped 默认额度按动作收紧，用于「切成每日模式」的用例。
 * @param tighten 只覆盖在意的那一条（其余留默认，这样「抓 40 轮不吃打招呼额度」在同一个用例里就是现成的证据）
 * @returns 一条 `daily` 模式的闸门配置
 */
const daily = (tighten: Partial<GateDailyLimits> = {}): GateConfig => ({
  mode: 'daily',
  dailyLimits: { ...DEFAULT_DAILY_LIMITS, ...tighten },
});

/** 起一套 config + store + ledger + gate，返回两个服务实例与账本的 fiber（重启用例要它）。 */
async function boot(gateConfig: GateConfig = { mode: 'unlimited', dailyLimits: DEFAULT_DAILY_LIMITS }) {
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

  it('配置切成「打招呼每天 1 次」后，第二次判定被拒且 reason 说清原因（1.9-03）', async () => {
    const { gate } = await boot(daily({ greet: 1 }));
    expect(gate.check('greet')).toMatchObject({ allowed: true, remaining: 1 });
    await gate.perform('greet', { targetId: 'job-1' }, () => Promise.resolve('sent'));
    const after = gate.check('greet');
    expect(after).toMatchObject({ allowed: false, remaining: 0 });
    expect(after.reason).toContain('greet');
    expect(after.reason).toContain('1');
  });

  it('三条动作各自计数、互不占用：抓满一轮不吃打招呼与投递的额度（2.7-03）', async () => {
    const { gate, ledger } = await boot(daily({ greet: 1 }));
    await gate.perform('greet', { targetId: 'job-1' }, () => Promise.resolve('sent'));
    await gate.perform('search', { targetId: '前端工程师' }, () => Promise.resolve('run'));

    expect(gate.check('greet')).toMatchObject({ allowed: false, remaining: 0 });
    // 默认值取自 `DEFAULT_DAILY_LIMITS` 而不是抄数字：配置面与用例读同一个数。
    expect(gate.check('search')).toMatchObject({ allowed: true, remaining: DEFAULT_DAILY_LIMITS.search - 1 });
    expect(gate.check('deliver')).toMatchObject({ allowed: true, remaining: DEFAULT_DAILY_LIMITS.deliver });
    expect(ledger.summary().byAction).toEqual(
      expect.arrayContaining([
        { action: 'greet', count: 1 },
        { action: 'search', count: 1 },
      ]),
    );
  });

  it('闸门不认的动作名一律结构化失败，且在 unlimited 模式下也一样（2.7-03 的收窄）', async () => {
    // 跨 IPC 边界的字符串没有运行期保证：认不出的名字若当 0 就是静默拒绝，当无限就是日上限形同虚设。
    const configs: GateConfig[] = [{ mode: 'unlimited', dailyLimits: DEFAULT_DAILY_LIMITS }, daily({ greet: 1 })];
    const unknown = 'download-resume' as QuotaAction;
    for (const config of configs) {
      const { gate, ledger } = await boot(config);
      let taskRan = false;
      await expect(
        gate.perform(unknown, { targetId: 'job-1' }, () => {
          taskRan = true;
          return Promise.resolve('不该被执行');
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        // reason 里点名三个合法动作：只说「不合法」的报错让调用方永远猜不到该传什么。
        message: expect.stringContaining('search / greet / deliver'),
      });
      expect(taskRan).toBe(false);
      expect(ledger.summary().total).toBe(0);
    }
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
    const { gate, ledger } = await boot(daily({ greet: 1 }));
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
      const { gate } = await boot(daily({ greet: 2 }));
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

/**
 * 被拦下的动作进被拒流水（spec 5.3-12）。
 *
 * 这一族用例存在的意义是**同时**成立两件事：拦下必留痕（5.3-12），留痕绝不进用量（1.9 已验收的
 * 「被拒既不花钱也不落账」与 plan §8.4 决策 1）。只断言前者，后来者把两件事搅回一张表也照样绿。
 */
describe('被闸门拦下的动作（spec 5.3-12）', () => {
  it('拦下几次就记几行，用量表一行也不许多', async () => {
    const { gate, ledger } = await boot(daily({ greet: 1 }));
    await gate.perform('greet', { targetId: 'job-1' }, () => Promise.resolve('first'));
    for (const targetId of ['job-2', 'job-3']) {
      await expect(gate.perform('greet', { targetId }, () => Promise.resolve('不该被执行'))).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      });
    }

    const summary = ledger.summary(50);
    expect(summary.total).toBe(1);
    expect(summary.recentDenials).toHaveLength(2);
    // 倒序（最近一条在前）且带可读原话：人要回头看出「刚才那两次是被谁以什么理由拦下的」。
    expect(summary.recentDenials[0]).toMatchObject({
      action: 'greet',
      targetId: 'job-3',
      code: 'QUOTA_EXCEEDED',
    });
    expect(summary.recentDenials[0]?.reason).toContain('额度已用完');
    expect(summary.recentDenials[1]?.targetId).toBe('job-2');
  });

  it('只用于展示的 check 不落任何流水，无限模式也不会被记成被拒', async () => {
    const { gate, ledger } = await boot(daily({ greet: 1 }));
    await gate.perform('greet', { targetId: 'job-1' }, () => Promise.resolve('first'));
    for (let attempt = 0; attempt < 3; attempt += 1) expect(gate.check('greet').allowed).toBe(false);
    expect(ledger.recentDenials(50)).toHaveLength(0);

    const unlimited = await boot();
    expect(unlimited.gate.check('greet').allowed).toBe(true);
    expect(unlimited.ledger.recentDenials(50)).toHaveLength(0);
  });

  it('enforce（外发编排等间隔之前那次询问）是留痕的口：放行不记，拦下必记', async () => {
    const { gate, ledger } = await boot(daily({ greet: 1 }));
    // 放行那一支返回读数本身（界面靠它显示还剩几条），并且一行都不记。
    expect(gate.enforce('greet', { targetId: 'job-1' })).toMatchObject({ allowed: true, remaining: 1 });
    expect(ledger.recentDenials(50)).toHaveLength(0);

    await gate.perform('greet', { targetId: 'job-1' }, () => Promise.resolve('first'));
    let refused: { code?: string; details?: unknown } | null = null;
    try {
      gate.enforce('greet', { targetId: 'job-2', workflowRunId: 'run-9' });
    } catch (error) {
      refused = error as { code?: string; details?: unknown };
    }
    expect(refused).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { action: 'greet', remaining: 0 } });
    // 上下文三件都在：回看时要能认出「哪一次运行、对哪个目标试过」，否则审计只剩一句"被拒了"。
    expect(ledger.recentDenials(50)).toMatchObject([{ action: 'greet', targetId: 'job-2', workflowRunId: 'run-9' }]);
  });

  it('被拒不占日上限、不启动频控的钟、也不挡住同目标的重复发送防护', async () => {
    const { gate, ledger } = await boot(daily({ greet: 1 }));
    await gate.perform('greet', { targetId: 'job-1', workflowRunId: 'run-1' }, () => Promise.resolve('first'));
    const usedBefore = ledger.countToday('greet', Date.now());
    const clockBefore = ledger.latestActionTs('greet');
    const forJob2Before = ledger.countFor('greet', 'job-2', 'run-1');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        gate.perform('greet', { targetId: 'job-2', workflowRunId: 'run-1' }, () => Promise.resolve('不该被执行')),
      ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    }

    // 三条计数都只读 usage_ledger，所以被拒行进了另一张表就等于它们结构性地看不见这件事。
    expect(ledger.countToday('greet', Date.now())).toBe(usedBefore);
    expect(ledger.latestActionTs('greet')).toBe(clockBefore);
    expect(ledger.countFor('greet', 'job-2', 'run-1')).toBe(forJob2Before);
  });

  it('老库重新挂载后照样建得出被拒表并写得进去（5.3-a 号段那条实测的复跑）', async () => {
    const { ctx, ledgerFiber, ledger } = await boot();
    expect(ledger.recentDenials(10)).toHaveLength(0);

    await ledgerFiber.dispose();
    const remounted = ctx.plugin(UsageLedgerService, {});
    await remounted;
    const again = asApp(ctx)['usage.ledger'];
    const store = asApp(ctx).store;
    expect(store.migrations.filter((item) => item.version === DENIAL_MIGRATION_VERSION)).toHaveLength(1);
    expect(again.recordDenial({ action: 'greet', code: 'QUOTA_EXCEEDED', reason: '今日 1 次已用完' })).toBeGreaterThan(
      0,
    );
    expect(again.summary().recentDenials[0]?.code).toBe('QUOTA_EXCEEDED');
    // 用量侧仍是空的：被拒行不可能被任何一条计数查询读到（本用例的后半段就是那条断言）。
    expect(again.summary().total).toBe(0);
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

  it('带界计数按含头不含尾数落账条数，`countToday` 就是它在「今天」这一档的取值（spec 5.8-01 的账本半边）', async () => {
    const { ledger } = await boot();
    const now = Date.now();
    const dayStart = startOfDay(now);
    ledger.record({ action: 'greet', targetId: 'job-yesterday', nowMs: dayStart - 1 });
    ledger.record({ action: 'greet', targetId: 'job-boundary', nowMs: dayStart });
    ledger.record({ action: 'greet', targetId: 'job-today', nowMs: now });
    ledger.record({ action: 'deliver', targetId: 'job-deliver', nowMs: now });
    // 含头不含尾是可数的：`now` 那一刻落的那条，上界取 `now` 时不在内、取 `now + 1` 时在内；
    // 下界那条（正好在日界上）则一进一出都算，看板把「今天」与「明天」两段拼起来时不会重一条。
    expect(ledger.countAction('greet', { fromMs: dayStart, toMs: now })).toBe(1);
    expect(ledger.countAction('greet', { fromMs: dayStart, toMs: now + 1 })).toBe(2);
    expect(ledger.countAction('greet', { fromMs: dayStart, toMs: dayStart + 1 })).toBe(1);
    expect(ledger.countAction('deliver', { fromMs: dayStart, toMs: Number.MAX_SAFE_INTEGER })).toBe(1);
    expect(ledger.countAction('search', { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER })).toBe(0);
    // 昨日那条落在日界之外，今日这两条都在内——与 `countToday` 走的是同一个日界、同一条 SQL 形状。
    expect(ledger.countToday('greet', now)).toBe(2);
    expect(ledger.countToday('greet', now)).toBe(
      ledger.countAction('greet', { fromMs: dayStart, toMs: Number.MAX_SAFE_INTEGER }),
    );
    expect(ledger.countAction('greet', { fromMs: 0, toMs: dayStart })).toBe(1);
  });

  it('日界与日键都按本机时区，而不是 SQLite 的 UTC date()（决策 3）', () => {
    const midnight = startOfDay(Date.now());
    expect(midnight).toBeLessThanOrEqual(Date.now());
    expect(new Date(midnight).getHours()).toBe(0);
    expect(dayKey(midnight)).toBe(dayKey(midnight + 60 * 60 * 1000));
  });
});
