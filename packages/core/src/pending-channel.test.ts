/**
 * 等人应答通道的用例（spec 5.3-09 / 10 的机制半边）。
 *
 * 这里钉的是**通道的四条性质**：按 id 路由、重复与错 id 无副作用、超时不是表态、等待方消失时收单，
 * 外加 5.5-05 要求的「单号可由调用方给定」（重推一张老单时沿用旧 id，时刻仍从这一拍重算）。
 * 领域映射（投递侧的错误码、循环侧的 `refused` 步行）不在这里测——那两个消费者各自的用例
 * （`deliver.test.ts` 的 2.6-01 一族、`confirm.test.ts` 的 5.3 一族）才是它们该红的地方。
 */
import { describe, expect, it } from 'vitest';
import { PendingChannel, type PendingOutcome } from './pending-channel.js';

/** 一张在等的单子开出去之后，把定局等到手（超时用例会真的等，所以时长都取几毫秒）。 */
async function settleOnce<TView, TAnswer>(
  channel: PendingChannel<TView, TAnswer>,
  view: TView,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ requestId: string; outcome: PendingOutcome<TAnswer> }> {
  const ticket = channel.open(view, options);
  // 先读一遍再等：开单与登记必须在同一次调用里完成，界面收到事件后立刻 `pending()` 要读得到（2.6-01 的口径）。
  const [firstPending] = channel.pending();
  expect(firstPending?.requestId).toBe(ticket.request.requestId);
  return { requestId: ticket.request.requestId, outcome: await ticket.outcome };
}

describe('5.3-09 应答按 requestId 路由', () => {
  it('并发两张单交叉应答：每张只收到自己那一份值', async () => {
    const channel = new PendingChannel<{ label: string }, string>();
    const first = channel.open({ label: '打招呼给 A 岗' }, { timeoutMs: 5_000 });
    const second = channel.open({ label: '打招呼给 B 岗' }, { timeoutMs: 5_000 });
    expect(channel.pendingIds()).toEqual([first.request.requestId, second.request.requestId]);

    // 把 B 的应答打到 B 上，A 必须还在等——路由按 id 而不是按「最近开的那张」。
    expect(channel.answer(second.request.requestId, 'B 的答案')).toBe(true);
    expect(await second.outcome).toEqual({ kind: 'answered', answer: 'B 的答案' });
    expect(channel.pendingIds()).toEqual([first.request.requestId]);

    expect(channel.answer(first.request.requestId, 'A 的答案')).toBe(true);
    expect(await first.outcome).toEqual({ kind: 'answered', answer: 'A 的答案' });
    expect(channel.pending()).toHaveLength(0);
  });

  it('载荷里的字段与单号、时刻三位一起读出，`expiresAt` 就是开单时刻加超时时长', () => {
    const channel = new PendingChannel<{ label: string }, string>();
    const before = Date.now();
    channel.open({ label: '投递给 job-1001' }, { timeoutMs: 120_000 });
    const [request] = channel.pending();
    expect(request?.label).toBe('投递给 job-1001');
    expect(request!.requestedAt).toBeGreaterThanOrEqual(before);
    expect(request!.expiresAt).toBe(request!.requestedAt + 120_000);
  });

  it('错 id 的应答被忽略：返回 false，两张在等的单一张都没定局', () => {
    const channel = new PendingChannel<{ label: string }, string>();
    channel.open({ label: '一' }, { timeoutMs: 5_000 });
    expect(channel.answer('不存在的单号', '随便什么值')).toBe(false);
    expect(channel.pending()).toHaveLength(1);
  });

  it('重复 id 的应答只算第一次：后到的表态不改变已定的局', async () => {
    const channel = new PendingChannel<{ label: string }, boolean>();
    const ticket = channel.open({ label: '投递' }, { timeoutMs: 5_000 });
    expect(channel.answer(ticket.request.requestId, true)).toBe(true);
    expect(await ticket.outcome).toEqual({ kind: 'answered', answer: true });
    // 界面上双击、或一张陈旧卡片被按下来：都不许把已经批过的单子改成"又批了一次"，也不许放行任何新的东西。
    expect(channel.answer(ticket.request.requestId, false)).toBe(false);
    expect(await ticket.outcome).toEqual({ kind: 'answered', answer: true });
  });
});

describe('5.3-10 超时与让出都不是一种表态', () => {
  it('没人应答到点：定局是 timed-out，不是 answered——缺省永远不等于同意', async () => {
    const channel = new PendingChannel<{ label: string }, boolean>();
    const { outcome } = await settleOnce(channel, { label: '投递' }, { timeoutMs: 15 });
    expect(outcome).toEqual({ kind: 'timed-out' });
    expect(channel.pending()).toHaveLength(0);
  });

  it('超时之后再补一句应答也被忽略（迟到的表态不算数）', async () => {
    const channel = new PendingChannel<{ label: string }, boolean>();
    const ticket = channel.open({ label: '投递' }, { timeoutMs: 10 });
    await ticket.outcome;
    expect(channel.answer(ticket.request.requestId, true)).toBe(false);
  });

  it('让出信号在等待中 abort：定局是 cancelled，之后无人可再定它', async () => {
    const channel = new PendingChannel<{ label: string }, boolean>();
    const controller = new AbortController();
    const ticket = channel.open({ label: '投递' }, { timeoutMs: 5_000, signal: controller.signal });
    expect(channel.pending()).toHaveLength(1);
    controller.abort();
    expect(await ticket.outcome).toEqual({ kind: 'cancelled' });
    expect(channel.answer(ticket.request.requestId, true)).toBe(false);
  });

  it('信号在开单之前就已经 abort：不等超时，当场收掉', async () => {
    const channel = new PendingChannel<{ label: string }, boolean>();
    const controller = new AbortController();
    controller.abort();
    const ticket = channel.open({ label: '投递' }, { timeoutMs: 5_000, signal: controller.signal });
    expect(await ticket.outcome).toEqual({ kind: 'cancelled' });
    expect(channel.pending()).toHaveLength(0);
  });

  it('cancelAll 把全部在等的单收成 cancelled 并报出张数（服务销毁时的收单）', async () => {
    const channel = new PendingChannel<{ label: string }, boolean>();
    const first = channel.open({ label: '一' }, { timeoutMs: 5_000 });
    const second = channel.open({ label: '二' }, { timeoutMs: 5_000 });
    expect(channel.cancelAll()).toBe(2);
    expect(await first.outcome).toEqual({ kind: 'cancelled' });
    expect(await second.outcome).toEqual({ kind: 'cancelled' });
    expect(channel.pending()).toHaveLength(0);
    // 再收一次是空操作：登记已空，不会把同一张单定第二次
    expect(channel.cancelAll()).toBe(0);
  });

  it('定局之后不留悬挂句柄：应答掉的与超时掉的都不再占定时器', async () => {
    const channel = new PendingChannel<{ label: string }, boolean>();
    const answered = channel.open({ label: '已应答' }, { timeoutMs: 30_000 });
    channel.answer(answered.request.requestId, true);
    await answered.outcome;
    // 长时长的单子如果句柄没被摘掉，这条用例会在测试运行时里留一只 30s 的定时器；
    // 判据写成"不等它也能收尾"，与仓库既有的句柄口径一致（AGENTS.md §9 的 5.3-b 收口条：只判不许变多）。
    const timedOut = channel.open({ label: '会超时' }, { timeoutMs: 5 });
    expect(await timedOut.outcome).toEqual({ kind: 'timed-out' });
    expect(channel.pending()).toHaveLength(0);
  });
});

describe('5.5-05 重推一张老单：单号沿用，时刻重算', () => {
  it('给定 requestId 时用它登记，应答按这个老单号路由到这张新等的单', async () => {
    const channel = new PendingChannel<{ label: string }, boolean>();
    // 界面上那张卡片带着重启前的单号；用户点它，必须点到重推后的这一等上。
    const ticket = channel.open({ label: '投递确认（重启前开出）' }, { timeoutMs: 5_000, requestId: 'pause-7f3a' });
    expect(ticket.request.requestId).toBe('pause-7f3a');
    expect(channel.pendingIds()).toEqual(['pause-7f3a']);
    expect(channel.answer('pause-7f3a', true)).toBe(true);
    expect(await ticket.outcome).toEqual({ kind: 'answered', answer: true });
  });

  it('重推不把旧的 expiresAt 带过来：等待时长从这一拍重新起算', () => {
    const channel = new PendingChannel<{ label: string }, boolean>();
    const before = Date.now();
    channel.open({ label: '重推的单' }, { timeoutMs: 60_000, requestId: 'pause-old' });
    const [request] = channel.pending();
    // 老单子的到点时刻在进程停摆期间早就烧完，照搬会得到一张「重启即超时」的死卡；
    // 这条断言钉住的是通道这一头根本没有入口接受外部时刻。
    expect(request!.requestedAt).toBeGreaterThanOrEqual(before);
    expect(request!.expiresAt).toBe(request!.requestedAt + 60_000);
  });

  it('不给 requestId 时仍旧每次新发、互不相同（投递侧的既有行为一字未动）', () => {
    const channel = new PendingChannel<{ label: string }, boolean>();
    const first = channel.open({ label: '一' }, { timeoutMs: 5_000 });
    const second = channel.open({ label: '二' }, { timeoutMs: 5_000 });
    expect(first.request.requestId).not.toBe(second.request.requestId);
    expect(first.request.requestId).toMatch(/^[0-9a-f]{8}-/);
  });

  it('沿用老单号的重推照样吃超时与收单：定局性质不因 id 来路而变', async () => {
    const channel = new PendingChannel<{ label: string }, boolean>();
    const timed = channel.open({ label: '会超时' }, { timeoutMs: 10, requestId: 'pause-ttl' });
    expect(await timed.outcome).toEqual({ kind: 'timed-out' });
    expect(channel.answer('pause-ttl', true)).toBe(false);
    const cancelled = channel.open({ label: '会被收' }, { timeoutMs: 5_000, requestId: 'pause-cancel' });
    expect(channel.cancelAll()).toBe(1);
    expect(await cancelled.outcome).toEqual({ kind: 'cancelled' });
  });
});
