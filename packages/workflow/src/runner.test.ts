/**
 * `workflow.runner` 服务侧的行为测试（spec 1.10-02 / 04 / 05 / 06 / 07）。
 *
 * 迁移表由 `machine.test.ts` 穷举，这里只测**跑起来之后**的四件事：
 * 推进顺序与事件流对得上、暂停是协作让出而不是强杀、失败步能被重新执行、
 * 卸载插件后定时器链真的停了（否则 `plugins.stop('workflow')` 之后还有一个人在推进状态）。
 * 非法调用一律要求结构化错误，不要求抛裸异常（1.10-09 的服务侧那一半）。
 */
import { asApp, AppError, Context, type WorkflowProgressEvent } from '@auto-cc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowRunnerService, type WorkflowConfig } from './index.js';

const fibers: { dispose(): Promise<unknown> }[] = [];

afterEach(async () => {
  // 倒序回收：先卸掉的可能已被后卸的依赖，正序 dispose 会撞 PENDING 警告。
  while (fibers.length) await fibers.pop()?.dispose();
});

/** 装一个执行器并挂上进度事件采集；fiber 交给 afterEach 回收，避免定时器链活过用例。 */
async function boot(config: Partial<WorkflowConfig> = {}) {
  const ctx = new Context();
  const events: WorkflowProgressEvent[] = [];
  // 先订阅再挂载：`[Service.init]` 会推一次 idle 快照，晚一行就漏掉它。
  ctx.on('workflow/progress', (event) => events.push(event));
  const fiber = ctx.plugin(WorkflowRunnerService, { stepDelayMs: 20, failStep: 'none', ...config });
  await fiber;
  fibers.push(fiber);
  return { ctx, runner: asApp(ctx)['workflow.runner'], events };
}

/**
 * 轮询等待条件成立。
 * @param predicate 每 5ms 调一次，返回 true 即结束
 * @param timeoutMs 上限（毫秒），默认 2000；到点抛错而不是静默返回，避免测试假通过
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 等一小段时间，用来确认「没有再发生任何事」。 */
async function settle(ms = 120): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('workflow.runner 推进与事件流（1.10-02 / 07）', () => {
  it('六步按顺序跑完，每一步都先 started 后 finished', async () => {
    const { runner, events } = await boot();
    const initial = runner.start();
    expect(initial.status).toBe('running');
    expect(initial.steps.every((step) => step.status === 'pending')).toBe(true);

    await waitFor(() => runner.current().status === 'done');
    const run = runner.current();
    expect(run.steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    expect(run.steps.every((step) => (step.durationMs ?? -1) >= 0)).toBe(true);

    const messages = events.map((event) => event.message);
    // 前两条是纯状态迁移：挂载时推的 idle 快照，和 `start` 本身，都不面向用户播报。
    expect(messages.slice(0, 2)).toEqual([null, null]);
    expect(messages.slice(2)).toEqual([
      '开始 search',
      'search 完成',
      '开始 profile',
      'profile 完成',
      '开始 pitch',
      'pitch 完成',
      '开始 greet',
      'greet 完成',
      '开始 tune',
      'tune 完成',
      '开始 deliver',
      'deliver 完成',
    ]);
    // 事件里的 run 是迁移后的快照，界面直接镜像即可，不需要自己再拼状态。
    expect(events.at(-1)?.run.steps.every((step) => step.status === 'done')).toBe(true);
  });

  it('挂载即有一个 idle run：六个槽位全部待执行，界面任何时候都有东西可画', async () => {
    const { runner, events } = await boot();
    const idle = runner.current();
    expect(idle.status).toBe('idle');
    expect(idle.stepIndex).toBe(0);
    expect(idle.steps.map((step) => step.status)).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    // 挂载时就推一次快照：改配置重建实例后，界面不会继续挂着上一个已被销毁的 run。
    expect(events[0]).toMatchObject({ run: { status: 'idle' }, stepId: null, message: null });
  });
});

describe('暂停与续跑（1.10-05）', () => {
  it('暂停等到当前步让出，stepIndex 不动；续跑从这一步重来并跑完', async () => {
    const { runner, events } = await boot({ stepDelayMs: 400 });
    runner.start();
    await waitFor(() => runner.current().steps[0]?.status === 'running');

    const paused = runner.pause();
    expect(paused.status).toBe('paused');
    expect(paused.stepIndex).toBe(0);
    expect(paused.steps[0]).toMatchObject({ status: 'pending', startedAt: null });

    // 协作式取消：abort 之后那一步不许被记成 done，也不许再推任何事件。
    const countAtPause = events.length;
    await settle(300);
    expect(events.length).toBe(countAtPause);
    expect(runner.current().status).toBe('paused');

    runner.resume();
    await waitFor(() => runner.current().status === 'done', 4000);
    const run = runner.current();
    expect(run.steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    // 第一步被重跑了一遍：出现了两次「开始 search」，且第二次之后的续跑没有跳过任何步。
    expect(events.filter((event) => event.message === '开始 search').length).toBe(2);
    expect(events.filter((event) => event.message === 'search 完成').length).toBe(1);
  });

  it('没在运行时暂停 / 暂停中另起 run / 没暂停时续跑，都是结构化失败', async () => {
    const { runner } = await boot();
    expect(() => runner.pause()).toThrow(AppError);
    try {
      runner.pause();
    } catch (error) {
      expect((error as AppError).code).toBe('WORKFLOW_INVALID_STATE');
    }
    runner.start();
    runner.pause();
    // 暂停态既不能另起一个 run（会变成两条流水线抢一份状态），也不能重复续跑。
    expect(() => runner.start()).toThrow(/已有 run 处于 paused 态/);
    expect(runner.resume().status).toBe('running');
    expect(() => runner.resume()).toThrow(/只有暂停中的 run 可以续跑/);
  });
});

describe('失败步与单独重试（1.10-06）', () => {
  it('注入失败后停在失败步；重试这一步会跑完整个 run', async () => {
    const { runner } = await boot({ failStep: 'profile' });
    runner.start();
    await waitFor(() => runner.current().status === 'failed');

    const failed = runner.current();
    expect(failed.stepIndex).toBe(1);
    expect(failed.steps[0]?.status).toBe('done');
    expect(failed.steps[1]).toMatchObject({ status: 'failed' });
    expect(failed.steps[1]?.error).toContain('failStep');
    expect(failed.steps.slice(2).every((step) => step.status === 'pending')).toBe(true);

    // 注入只作用一次：重试之后这一步必须真的重跑并放行，后面的步接着走完。
    expect(runner.retryStep('profile').status).toBe('running');
    await waitFor(() => runner.current().status === 'done');
    const done = runner.current();
    expect(done.stepIndex).toBe(6);
    expect(done.steps[1]).toMatchObject({ status: 'done', error: null });
    expect(done.steps.every((step) => step.status === 'done')).toBe(true);
  });

  it('重试不认识的步 id、或重试没失败的步，都结构化失败', async () => {
    const { runner } = await boot({ failStep: 'greet' });
    expect(() => runner.retryStep('nope')).toThrow(/未知步骤 nope/);
    runner.start();
    await waitFor(() => runner.current().status === 'failed');
    // search 已经 done，对它重试没有意义，必须被拒而不是把 run 拽回 running。
    expect(() => runner.retryStep('search')).toThrow(/不处于失败态/);
    expect(runner.current().status).toBe('failed');
  });
});

describe('会话失效停在可恢复点（1.8-07）', () => {
  /** 向全局事件总线推一次登录态失效，等同于 `sessions.probe` 判出失效。 */
  function expire(ctx: Context, platform = 'boss', reason: 'missing' | 'expired' = 'expired'): void {
    ctx.emit('session/expired', { platform, reason, at: Date.now() });
  }

  it('运行中收到失效：停在当前步、带原因播报，且不再推进；续跑从这一步接着跑完', async () => {
    const { ctx, runner, events } = await boot({ stepDelayMs: 400 });
    runner.start();
    await waitFor(() => runner.current().steps[1]?.status === 'running');

    expire(ctx);

    const paused = runner.current();
    expect(paused.status).toBe('paused');
    // 停在的是当时正在跑的那一步：stepIndex 不动，该步退回 pending 等着被重跑。
    expect(paused.stepIndex).toBe(1);
    expect(paused.steps[0]?.status).toBe('done');
    expect(paused.steps[1]).toMatchObject({ status: 'pending', durationMs: null });
    expect(events.at(-1)).toMatchObject({
      message: 'boss 登录态失效（expired），已停在 profile，重新登录后从当前步续跑',
    });

    // 协作式取消：让出之后这一步不许被记成 done，也不许再推事件。
    const countAtPause = events.length;
    await settle(300);
    expect(events.length).toBe(countAtPause);

    runner.resume();
    await waitFor(() => runner.current().status === 'done', 4000);
    const done = runner.current();
    expect(done.steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    expect(events.filter((event) => event.message === '开始 profile').length).toBe(2);
  });

  it('没在运行时收到失效：什么都不做，不报错也不把 idle 拽成 paused', async () => {
    const { ctx, runner, events } = await boot();
    expire(ctx);
    expect(runner.current().status).toBe('idle');
    expect(events.length).toBe(1);

    runner.start();
    runner.pause();
    const countAtPause = events.length;
    expire(ctx, 'liepin', 'missing');
    // 已经是 paused 的 run 不能被二次暂停（迁移表会拒），所以这里必须被忽略而不是抛错。
    expect(runner.current().status).toBe('paused');
    expect(events.length).toBe(countAtPause);
  });
});

describe('卸载即让出（1.10-04 的回收侧）', () => {
  it('dispose 之后不再有进度事件', async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(WorkflowRunnerService, { stepDelayMs: 400, failStep: 'none' });
    await fiber;
    const events: WorkflowProgressEvent[] = [];
    ctx.on('workflow/progress', (event) => events.push(event));
    asApp(ctx)['workflow.runner'].start();
    await waitFor(() => events.length > 1);

    const countAtDispose = events.length;
    await fiber.dispose();
    await settle(300);
    expect(events.length).toBe(countAtDispose);
  });
});
