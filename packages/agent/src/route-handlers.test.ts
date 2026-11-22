/**
 * 六个处理器各自调了哪个口（spec 10.11-16 / 2026-11-22 裁定）。
 * 判据：每类一条 + `act` 不在处理器里执行 + 处理器拒绝时**原样抛出**（由调用方包成 route_refused）。
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '@auto-cc/core';
import { runRoute, type RoutePorts } from './route-handlers.js';
import type { RouteReading } from './router.js';

/** 一座记录调用的假端口：每个口都可以单独替换成抛错版。 */
function fakePorts(overrides: Partial<RoutePorts> = {}): { ports: RoutePorts; calls: string[] } {
  const calls: string[] = [];
  const ports: RoutePorts = {
    funnelQuery: () => {
      calls.push('funnel');
      return Promise.resolve({ quota: { used: 2, limit: 10 }, delivered: 1 });
    },
    ledgerSummary: () => {
      calls.push('ledger');
      return Promise.resolve({ total: 3, lastSendAt: 1_700_000_000_000 });
    },
    kbSearch: () => {
      calls.push('kb');
      return Promise.resolve({ hits: 2 });
    },
    trackingCurrent: () => {
      calls.push('tracking');
      return Promise.resolve({ jobId: '1001', state: 'greeted' });
    },
    pausePending: () => {
      calls.push('pause');
      return Promise.resolve(1);
    },
    unattendedView: () => {
      calls.push('unattended');
      return Promise.resolve({ status: 'stopped', pending: 2 });
    },
    authorizationCurrent: () => {
      calls.push('authorization');
      return Promise.resolve({ status: 'active' });
    },
    propose: (goal) => {
      calls.push(`propose:${goal}`);
      return Promise.resolve({ runId: 'run-1', steps: 2 });
    },
    ...overrides,
  };
  return { ports, calls };
}

const reading = (intent: RouteReading['intent']): RouteReading => ({ intent, confidence: 0.9 });

describe('runRoute：六类各自调哪个口', () => {
  it('summary：只读 funnel + ledger，回执带两个数字', async () => {
    const { ports, calls } = fakePorts();
    const parts = await runRoute(reading('summary'), '今天投了几份', ports);
    expect(calls.sort()).toEqual(['funnel', 'ledger']);
    expect(parts?.[0]).toMatchObject({ kind: 'notice', code: 'summary' });
  });

  it('explain：只读 kb + 追踪', async () => {
    const { ports, calls } = fakePorts();
    const parts = await runRoute(reading('explain'), '为什么匹配', ports);
    expect(calls.sort()).toEqual(['kb', 'tracking']);
    expect(parts?.[0]).toMatchObject({ kind: 'notice', code: 'explain' });
  });

  it('draft_plan：只起草（propose），不确认', async () => {
    const { ports, calls } = fakePorts();
    const parts = await runRoute(reading('draft_plan'), '准备一轮投递', ports);
    expect(calls).toEqual(['propose:准备一轮投递']);
    expect(parts?.[0]).toMatchObject({ kind: 'notice', code: 'plan_drafted' });
  });

  it('reminder：待表态 + 执行器 + 授权单三样都读', async () => {
    const { ports, calls } = fakePorts();
    const parts = await runRoute(reading('reminder'), '有什么要处理的', ports);
    expect(calls.sort()).toEqual(['authorization', 'pause', 'unattended']);
    expect(parts?.[0]).toMatchObject({ kind: 'notice', code: 'reminder' });
  });

  it('navigate：不调任何业务口，只给跳转片段', async () => {
    const { ports, calls } = fakePorts();
    const parts = await runRoute({ intent: 'navigate', confidence: 0.9, target: { view: 'trust' } }, '带我去看', ports);
    expect(calls).toEqual([]);
    expect(parts?.[0]).toEqual({ kind: 'navigate', view: 'trust' });
  });

  it('act：处理器里不执行，返回 null（交给既有 /tool 那条带审批的路）', async () => {
    const { ports, calls } = fakePorts();
    expect(await runRoute(reading('act'), '帮我打招呼', ports)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('处理器拒绝时原样抛出错误码（调用方包成 route_refused，不二次包装）', async () => {
    const { ports } = fakePorts({
      propose: () => Promise.reject(new AppError('AGENT_PLANNER_UNAVAILABLE', '模型通道未配置', 'chat.session')),
    });
    await expect(runRoute(reading('draft_plan'), '准备一轮', ports)).rejects.toMatchObject({
      code: 'AGENT_PLANNER_UNAVAILABLE',
    });
  });
});
