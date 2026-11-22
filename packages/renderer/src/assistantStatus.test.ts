/**
 * 「需要你」角标的计数口径（spec 10.11-11）：三样相加、读不到按 0、不制造负角标。
 */
import { describe, expect, it } from 'vitest';
import { executorNeedsYou, mixNeedsYou } from './assistantStatus';

describe('mixNeedsYou', () => {
  it('三样都空：不亮', () => {
    expect(mixNeedsYou({ pauseCards: 0, proposedPlan: 0, executorPending: 0 })).toBe(0);
  });

  it('三样相加（待确认计划 + 逐条批准 + 执行器待办）', () => {
    expect(mixNeedsYou({ pauseCards: 2, proposedPlan: 1, executorPending: 3 })).toBe(6);
  });

  it('只有执行器待办也算「需要你」——这一类以前压根没计', () => {
    expect(mixNeedsYou({ pauseCards: 0, proposedPlan: 0, executorPending: 4 })).toBe(4);
  });

  it('脏读数（负数 / 非数）按 0 收口，不制造负角标', () => {
    expect(mixNeedsYou({ pauseCards: -1, proposedPlan: 0, executorPending: 0 })).toBe(0);
    expect(mixNeedsYou({ pauseCards: 1, proposedPlan: Number.NaN, executorPending: 1 })).toBe(0);
  });
});

describe('executorNeedsYou（2026-11-22 裁定 A）', () => {
  it('idle 时有授权单不算、running 时也不算（那是「未完成岗位数」）', () => {
    expect(executorNeedsYou({ status: 'idle', authorizationStatus: 'active' })).toBe(false);
    expect(executorNeedsYou({ status: 'running', authorizationStatus: 'active' })).toBe(false);
  });

  it('真的在等人的三态都算', () => {
    expect(executorNeedsYou({ status: 'paused' })).toBe(true);
    expect(executorNeedsYou({ status: 'stopped' })).toBe(true);
    expect(executorNeedsYou({ status: 'blocked' })).toBe(true);
  });

  it('授权单 restart-required：不管执行器什么状态都算（那是等人重新确认）', () => {
    expect(executorNeedsYou({ status: 'idle', authorizationStatus: 'restart-required' })).toBe(true);
  });
});
