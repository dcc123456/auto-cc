/**
 * 外发样例的骨架测试（spec 1.9-05 的核心一条）。
 *
 * 这里刻意**不**去测闸门本身（那是 `entitlement.test.ts` 的事），只测消费者这一侧的四件事：
 * 没有闸门就发不出去、额度用尽就发不出去、对端不通要以结构化错误失败、参数不合法不碰网络；
 * 四种失败都不许静默成功也不许落账。网络用存根，目标只有本地 fixture 的地址（AGENTS.md §7.2）。
 */
import { asApp, Context, fiberState } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import {
  DEFAULT_DAILY_LIMITS,
  EntitlementGateService,
  UsageLedgerService,
  type GateConfig,
} from '@auto-cc/plugin-entitlement';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { OutboundSampleAction } from '@auto-cc/shared';
import { OutboundSampleService } from './index.js';

const FIXTURE_ENDPOINT = 'http://127.0.0.1:10233/api/outbound';
const sandboxes: string[] = [];

afterAll(() => {
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 同 entitlement.test.ts：Windows 句柄延迟释放时允许残渣留在系统 temp。
    }
  }
});

/**
 * 把 `globalThis.fetch` 换成记账存根，按脚本决定回什么状态码。
 * @param status 存根回给调用方的 HTTP 状态码（默认 200；传 503 用来验「对端挂了」这一路）
 * @returns `calls` 每次被调的请求体，`restore` 还原真实 fetch（留给其他用例）
 */
function stubFixture(status = 200): { calls: Record<string, unknown>[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Record<string, unknown>[] = [];
  // 签名直接取 `typeof fetch`：自己写窄一点的参数类型会被 tsc 判成不兼容赋值。
  const stub: typeof fetch = (_input, init) => {
    // `BodyInit` 允许流/表单，只有字符串这一支是被测代码实际用的形状。
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
    calls.push(body);
    return Promise.resolve(
      new Response(JSON.stringify({ ok: status === 200, received: calls.length }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  globalThis.fetch = stub;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** 装到 `outbound` 为止；`withGate` 为 false 时不挂闸门（1.9-05 要的就是这一路）。 */
async function boot(options: { withGate: boolean; gate?: GateConfig }) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-outbound-'));
  sandboxes.push(dir);
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' });
  const ledgerFiber = ctx.plugin(UsageLedgerService, {});
  await ledgerFiber;
  if (options.withGate)
    await ctx.plugin(EntitlementGateService, options.gate ?? { mode: 'unlimited', dailyLimits: DEFAULT_DAILY_LIMITS });
  const outboundFiber = ctx.plugin(OutboundSampleService, { endpoint: FIXTURE_ENDPOINT });
  await outboundFiber;
  return { ctx, outboundFiber, ledger: asApp(ctx)['usage.ledger'] };
}

describe('outbound.sample 只认闸门（spec 1.9-03 / 04 / 05）', () => {
  it('闸门在场：外发成功、回执带账本行，对端确实收到一条（1.9-04）', async () => {
    const fixture = stubFixture();
    try {
      const { ctx, ledger } = await boot({ withGate: true });
      const receipt = await asApp(ctx)['outbound.sample'].send({
        action: 'greet',
        targetId: 'job-1',
        message: '你好，我对这个岗位很感兴趣',
      });
      expect(receipt).toMatchObject({ action: 'greet', targetId: 'job-1', delivered: 1 });
      expect(fixture.calls[0]).toMatchObject({ action: 'greet', targetId: 'job-1' });
      expect(ledger.summary().total).toBe(1);
      expect(ledger.summary().recent[0]?.id).toBe(receipt.ledgerId);
    } finally {
      fixture.restore();
    }
  });

  it('闸门缺席：外发服务根本不挂载，一次网络请求都没发出（1.9-05）', async () => {
    const fixture = stubFixture();
    try {
      const { ctx, outboundFiber } = await boot({ withGate: false });
      // cordis 对依赖缺席的插件停在 PENDING 而不是抛错，所以「没挂上」要看状态而不是等异常。
      expect(fiberState(outboundFiber.state)).toBe('pending');
      expect(asApp(ctx).get('outbound.sample')).toBeUndefined();
      expect(fixture.calls).toHaveLength(0);
    } finally {
      fixture.restore();
    }
  });

  it('额度用尽：外发以 QUOTA_EXCEEDED 失败、不落账、不打到对端（1.9-03 + 决策 1）', async () => {
    const fixture = stubFixture();
    try {
      const { ctx, ledger } = await boot({
        withGate: true,
        gate: { mode: 'daily', dailyLimits: { ...DEFAULT_DAILY_LIMITS, greet: 1 } },
      });
      const sample = asApp(ctx)['outbound.sample'];
      await sample.send({ action: 'greet', targetId: 'job-1', message: '第一条' });
      await expect(sample.send({ action: 'greet', targetId: 'job-2', message: '第二条' })).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      });
      expect(fixture.calls).toHaveLength(1);
      expect(ledger.summary().total).toBe(1);
    } finally {
      fixture.restore();
    }
  });

  it('动作名收窄到样例子集：`search` 与任意字符串都在入口被拒，不碰闸门也不碰网络（2.7-03）', async () => {
    const fixture = stubFixture();
    try {
      const { ctx, ledger } = await boot({ withGate: true });
      const sample = asApp(ctx)['outbound.sample'];
      // `search` 是合法的**额度**动作，但不是样例外发的动作：抓取那一条账只能由 `jd.capture` 记，
      // 界面或调用方能拿 `sample.send` 发一个 'search' 就等于凭空造出一条假的外发用量。
      for (const action of ['search', 'download-resume']) {
        await expect(
          sample.send({ action: action as OutboundSampleAction, targetId: 'job-1', message: '伪造的动作' }),
        ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      }
      expect(fixture.calls).toHaveLength(0);
      expect(ledger.summary().total).toBe(0);
    } finally {
      fixture.restore();
    }
  });

  it('对端返回 5xx：以 OUTBOUND_FAILED 失败且不落账（决策 1 的另一半）', async () => {
    const fixture = stubFixture(503);
    try {
      const { ctx, ledger } = await boot({ withGate: true });
      await expect(
        asApp(ctx)['outbound.sample'].send({ action: 'greet', targetId: 'job-1', message: '会失败的一条' }),
      ).rejects.toMatchObject({ code: 'OUTBOUND_FAILED' });
      expect(ledger.summary().total).toBe(0);
      expect(fixture.calls).toHaveLength(1);
    } finally {
      fixture.restore();
    }
  });

  it('对端连不上：以 OUTBOUND_FAILED 结构化失败且不落账（spec 1.9-09）', async () => {
    const original = globalThis.fetch;
    // 端口没人监听时 fetch 是 reject，不是返回非 2xx —— 这一支必须也变成结构化错误。
    globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'));
    try {
      const { ctx, ledger } = await boot({ withGate: true });
      await expect(
        asApp(ctx)['outbound.sample'].send({ action: 'greet', targetId: 'job-1', message: '对端已停' }),
      ).rejects.toMatchObject({ code: 'OUTBOUND_FAILED', details: { endpoint: FIXTURE_ENDPOINT } });
      expect(ledger.summary().total).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('入站参数不合法时结构化失败，不发网络（渲染层是不可信来源）', async () => {
    const fixture = stubFixture();
    try {
      const { ctx } = await boot({ withGate: true });
      const sample = asApp(ctx)['outbound.sample'];
      // 动作名那一维交给上一条用例，这里只查另外两个必填字段：空串在类型上合法，只有 schema 拦得住。
      const base = { action: 'greet' as const, targetId: 'job-1', message: '正文' };
      await expect(sample.send({ ...base, targetId: '' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(sample.send({ ...base, message: '' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(fixture.calls).toHaveLength(0);
    } finally {
      fixture.restore();
    }
  });
});
