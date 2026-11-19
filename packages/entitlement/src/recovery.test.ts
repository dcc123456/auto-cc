/**
 * 10.2-02/03 的闸门负对照：停用、四元组去重、未知结局与原子落账。
 * 全部使用系统临时目录里的真 SQLite；不访问网络，也不读取用户库。
 */
import { asApp, Context, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { OutboundAttemptKey } from '@auto-cc/shared';
import { DEFAULT_DAILY_LIMITS, EntitlementGateService, UsageLedgerService } from './index.js';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];
const NOW = 1_760_000_000_000;
const KEY: OutboundAttemptKey = {
  platform: 'fixture',
  targetId: 'job-1001',
  action: 'deliver',
  resumeVersion: 'snapshot-v1',
};

/** 起一套只含临时库的真闸门；返回服务与用于核对裸表的连接。 */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-outbound-recovery-'));
  sandboxes.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(UsageLedgerService, {}));
  fibers.push(await ctx.plugin(EntitlementGateService, { mode: 'unlimited', dailyLimits: DEFAULT_DAILY_LIMITS }));
  const app = asApp(ctx);
  return { gate: app['entitlement.gate'], ledger: app['usage.ledger'], db: app.store.db };
}

/** 把键摊成 `performOutbound` 的上下文；所有用例共用同一个基准时刻。 */
function contextOf(key: OutboundAttemptKey = KEY, workflowRunId: string | null = null) {
  return {
    platform: key.platform,
    targetId: key.targetId,
    resumeVersion: key.resumeVersion,
    workflowRunId,
    nowMs: NOW,
    source: 'fixture-source',
  };
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

describe('外发停用与四元组去重（10.2-02/03）', () => {
  it('停用后 greet/deliver 闭包与成功账行均为 0，历史保留，恢复不自动重放', async () => {
    const { gate, ledger } = await boot();
    await gate.performOutbound('deliver', contextOf(), () =>
      Promise.resolve({ value: 'sent', receiptId: 'receipt-1' }),
    );
    expect(ledger.count()).toBe(1);

    gate.setOutboundStopped(true, NOW + 1);
    let calls = 0;
    for (const action of ['greet', 'deliver'] as const) {
      await expect(
        gate.performOutbound(action, { ...contextOf({ ...KEY, action }), nowMs: NOW + 2 }, () => {
          calls += 1;
          return Promise.resolve({ value: 'sent', receiptId: 'must-not-send' });
        }),
      ).rejects.toMatchObject({ code: 'OUTBOUND_DISABLED' });
    }
    expect(calls).toBe(0);
    expect(ledger.count()).toBe(1);
    expect(ledger.row(1)).toMatchObject({ action: 'deliver', targetId: KEY.targetId });

    gate.setOutboundStopped(false, NOW + 3);
    await expect(
      gate.performOutbound('deliver', contextOf(), () => Promise.resolve({ value: 'sent', receiptId: 'replay' })),
    ).rejects.toMatchObject({
      code: 'OUTBOUND_ALREADY_SENT',
    });
    expect(calls).toBe(0);
    expect(ledger.count()).toBe(1);
  });

  it('页面动作在停用后才回执：停用后成功账仍为 0，对账也不能绕过停用补账', async () => {
    const { gate, ledger } = await boot();
    await expect(
      gate.performOutbound('deliver', contextOf(), () => {
        gate.setOutboundStopped(true, NOW + 1);
        return Promise.resolve({ value: 'late-page-success', receiptId: 'late-receipt' });
      }),
    ).rejects.toMatchObject({ code: 'OUTBOUND_DISABLED' });
    expect(ledger.count()).toBe(0);
    expect(gate.outboundAttempt('deliver', contextOf())).toMatchObject({ status: 'unknown' });
    expect(
      gate.reconcile('deliver', contextOf(), { status: 'confirmed', reason: '迟到回执', receiptId: 'late-receipt' }),
    ).toMatchObject({ status: 'conflict', canResume: false });
    expect(ledger.count()).toBe(0);

    gate.setOutboundStopped(false, NOW + 2);
    expect(
      gate.reconcile('deliver', contextOf(), { status: 'confirmed', reason: '迟到回执', receiptId: 'late-receipt' }),
    ).toMatchObject({ status: 'recovered' });
    expect(ledger.count()).toBe(1);
  });

  it('同四元组跨运行重放不二次外发/扣额；换平台或简历版本才是新动作', async () => {
    const { gate, ledger } = await boot();
    let calls = 0;
    const send = () => {
      calls += 1;
      return Promise.resolve({ value: 'sent', receiptId: `receipt-${String(calls)}` });
    };
    await gate.performOutbound('deliver', contextOf(KEY, 'run-a'), send);
    await expect(gate.performOutbound('deliver', contextOf(KEY, 'run-b'), send)).rejects.toMatchObject({
      code: 'OUTBOUND_ALREADY_SENT',
    });
    expect(calls).toBe(1);
    expect(ledger.count()).toBe(1);

    await gate.performOutbound('deliver', contextOf({ ...KEY, platform: 'fixture-alt' }), send);
    await gate.performOutbound('deliver', contextOf({ ...KEY, resumeVersion: 'snapshot-v2' }), send);
    expect(calls).toBe(3);
    expect(ledger.count()).toBe(3);
  });
});

describe('未知结局与对账恢复（10.2-03）', () => {
  it('页面成功、经过写入失败时账本与成功位整体回滚；对账只补账不重发', async () => {
    const { gate, ledger } = await boot();
    const deliveries: number[] = [];
    let pageCalls = 0;
    await expect(
      gate.performOutbound(
        'deliver',
        contextOf(),
        () => {
          pageCalls += 1;
          return Promise.resolve({ value: 'sent', receiptId: 'page-receipt-7' });
        },
        () => {
          throw new Error('模拟 delivery_records 写失败');
        },
      ),
    ).rejects.toThrow('模拟 delivery_records 写失败');
    expect(ledger.count()).toBe(0);
    expect(gate.outboundAttempt('deliver', contextOf())).toMatchObject({ status: 'unknown', ledgerId: null });

    await expect(
      gate.performOutbound('deliver', contextOf(), () => {
        pageCalls += 1;
        return Promise.resolve({ value: 'sent', receiptId: 'blind-replay' });
      }),
    ).rejects.toMatchObject({ code: 'OUTBOUND_RECONCILIATION_REQUIRED' });
    expect(pageCalls).toBe(1);

    const reconciled = gate.reconcile(
      'deliver',
      contextOf(),
      { status: 'confirmed', reason: '仿站回执仍在', receiptId: 'page-receipt-7' },
      (ledgerId) => deliveries.push(ledgerId),
    );
    expect(reconciled).toMatchObject({ status: 'recovered', canResume: false });
    expect(pageCalls).toBe(1);
    expect(deliveries).toEqual([1]);
    expect(ledger.count()).toBe(1);
    expect(gate.outboundAttempt('deliver', contextOf())).toMatchObject({
      status: 'succeeded',
      ledgerId: 1,
      receiptId: 'page-receipt-7',
    });
  });

  it('证据不足继续停手；明确未发生才允许之后显式重试，成功动作不重放', async () => {
    const { gate, ledger } = await boot();
    await expect(
      gate.performOutbound('deliver', contextOf(), () => Promise.reject(new Error('回执读取失败'))),
    ).rejects.toThrow('回执读取失败');
    expect(gate.reconcile('deliver', contextOf(), { status: 'unknown', reason: '页面读不出' })).toMatchObject({
      status: 'unknown',
      canResume: false,
    });
    expect(ledger.count()).toBe(0);

    expect(gate.reconcile('deliver', contextOf(), { status: 'absent', reason: '完整消息清单无此附件' })).toMatchObject({
      status: 'not-sent',
      canResume: true,
    });
    let pageCalls = 0;
    await gate.performOutbound('deliver', contextOf(), () => {
      pageCalls += 1;
      return Promise.resolve({ value: 'sent', receiptId: 'after-manual-reconcile' });
    });
    expect(pageCalls).toBe(1);
    expect(
      gate.reconcile('deliver', contextOf(), {
        status: 'confirmed',
        reason: '仍在',
        receiptId: 'after-manual-reconcile',
      }),
    ).toMatchObject({
      status: 'already-succeeded',
      canResume: false,
    });
    expect(ledger.count()).toBe(1);
  });
});
