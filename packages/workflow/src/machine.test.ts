/**
 * 迁移表的穷举测试（spec 1.10-03 / 1.10-09）。
 *
 * 这块要证明的不是「代码能跑」，而是两件事：六步线性流水线的**每一次合法迁移**都落在预期状态上，
 * 以及**每一次非法迁移**都被拒成一句可读的 reason 而不是异常——1.10-09 的反向验证就压在这上面：
 * 不引状态机库也没漏掉「非法调用被拒而不崩」这条能力。
 */
import { WORKFLOW_STEP_IDS, type WorkflowRunView, type WorkflowStepView } from '@auto-cc/core';
import { describe, expect, it } from 'vitest';
import { createRun, transition, type RunnerEvent } from './machine.js';

/** 取一个确定性初始 run（时间戳固定，不参与断言，只为避免 randomUUID 噪声）。 */
function idleRun(): WorkflowRunView {
  return createRun('run-test', 1000);
}

/**
 * 依次投喂事件，任何一步被拒就直接把 reason 抛给测试框架。
 * @param run 起始状态
 * @param events 事件序列（`at` 由调用方给，测试里全是固定数，所以耗时可精确断言）
 * @returns 走完序列后的状态
 */
function applyAll(run: WorkflowRunView, events: RunnerEvent[]): WorkflowRunView {
  let current = run;
  for (const event of events) {
    const result = transition(current, event);
    if (!result.ok) throw new Error(`事件 ${event.type} 被拒：${result.reason}`);
    current = result.run;
  }
  return current;
}

/**
 * 取某一步的读数。
 * @param run 要读的状态
 * @param index 下标（`noUncheckedIndexedAccess` 下直接下标访问是可选的，断言会因此糊掉）
 * @returns 该步读数；下标越界直接抛错，让测试红而不是静默通过
 */
function stepAt(run: WorkflowRunView, index: number): WorkflowStepView {
  const step = run.steps[index];
  if (!step) throw new Error(`第 ${String(index)} 步不存在`);
  return step;
}

/** 把六步全部跑到 done（用于「已完成 run 上再做动作」这类非法用例的前置）。 */
function finishedRun(): WorkflowRunView {
  const events: RunnerEvent[] = [];
  WORKFLOW_STEP_IDS.forEach((stepId, index) => {
    events.push({ type: 'step-started', stepId, at: 1000 + index * 100 });
    events.push({ type: 'step-finished', stepId, at: 1000 + index * 100 + 50 });
  });
  return applyAll({ ...idleRun(), status: 'running' }, events);
}

describe('createRun 的初始形状（1.10-01）', () => {
  it('六个槽位按主线顺序排好，全部 pending 且没有耗时', () => {
    const run = idleRun();
    expect(run.runId).toBe('run-test');
    expect(run.status).toBe('idle');
    expect(run.stepIndex).toBe(0);
    expect(run.steps.map((step) => step.id)).toEqual(['search', 'profile', 'pitch', 'greet', 'tune', 'deliver']);
    expect(
      run.steps.every((step) => step.status === 'pending' && step.durationMs === null && step.error === null),
    ).toBe(true);
  });
});

describe('合法迁移（1.10-02 / 03 / 05 / 06）', () => {
  it('start 把 idle 变 running，且只此一次', () => {
    const result = transition(idleRun(), { type: 'start' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.run.status).toBe('running');
  });

  it('逐步推进：stepIndex 单调递增，耗时由起止时间戳算出', () => {
    const run = applyAll(idleRun(), [
      { type: 'start' },
      { type: 'step-started', stepId: 'search', at: 2000 },
      { type: 'step-finished', stepId: 'search', at: 2600 },
      { type: 'step-started', stepId: 'profile', at: 3000 },
    ]);
    expect(run.stepIndex).toBe(1);
    expect(stepAt(run, 0)).toMatchObject({ status: 'done', durationMs: 600, error: null });
    expect(stepAt(run, 1)).toMatchObject({ status: 'running', startedAt: 3000, durationMs: null });
    expect(stepAt(run, 2).status).toBe('pending');
  });

  it('最后一步结束把整个 run 置为 done，stepIndex 停在越界位', () => {
    const run = finishedRun();
    expect(run.status).toBe('done');
    expect(run.stepIndex).toBe(WORKFLOW_STEP_IDS.length);
    expect(run.steps.every((step) => step.status === 'done')).toBe(true);
  });

  it('暂停把当前步退回 pending 但不动 stepIndex，续跑接着这一步（1.10-05）', () => {
    const paused = applyAll(idleRun(), [
      { type: 'start' },
      { type: 'step-started', stepId: 'search', at: 2000 },
      { type: 'step-finished', stepId: 'search', at: 2600 },
      { type: 'step-started', stepId: 'profile', at: 3000 },
      { type: 'pause' },
    ]);
    expect(paused.status).toBe('paused');
    expect(paused.stepIndex).toBe(1);
    expect(stepAt(paused, 1)).toMatchObject({ status: 'pending', startedAt: null, durationMs: null });
    expect(stepAt(paused, 0).status).toBe('done');

    const resumed = applyAll(paused, [{ type: 'resume' }, { type: 'step-started', stepId: 'profile', at: 4000 }]);
    expect(resumed.status).toBe('running');
    // 从头再来这一步：startedAt 是续跑后的时间，不是暂停前那个。
    expect(resumed.steps[1]).toMatchObject({ status: 'running', startedAt: 4000 });
  });

  it('失败步单独重试时把 stepIndex 指回去并清掉错误（1.10-06）', () => {
    const failed = applyAll(idleRun(), [
      { type: 'start' },
      { type: 'step-started', stepId: 'search', at: 2000 },
      { type: 'step-finished', stepId: 'search', at: 2600 },
      { type: 'step-started', stepId: 'profile', at: 3000 },
      { type: 'step-failed', stepId: 'profile', at: 3200, error: '对端不可达' },
    ]);
    expect(failed.status).toBe('failed');
    expect(failed.steps[1]).toMatchObject({ status: 'failed', error: '对端不可达', durationMs: 200 });
    // 失败之后的后续步仍是 pending——不能因为它们没跑就把整个 run 判成 partial done。
    expect(stepAt(failed, 2).status).toBe('pending');

    const retried = applyAll(failed, [{ type: 'retry-step', stepId: 'profile' }]);
    expect(retried.status).toBe('running');
    expect(retried.stepIndex).toBe(1);
    expect(retried.steps[1]).toMatchObject({ status: 'pending', error: null, finishedAt: null, durationMs: null });
  });
});

describe('非法迁移一律拒绝且不抛异常（1.10-09）', () => {
  const search = WORKFLOW_STEP_IDS[0];
  const cases: { label: string; run: WorkflowRunView; event: RunnerEvent }[] = [
    { label: '未开始就暂停', run: idleRun(), event: { type: 'pause' } },
    { label: '未开始就续跑', run: idleRun(), event: { type: 'resume' } },
    { label: '未开始就重试', run: idleRun(), event: { type: 'retry-step', stepId: search } },
    { label: '运行中再 start', run: applyAll(idleRun(), [{ type: 'start' }]), event: { type: 'start' } },
    {
      label: '启动非当前步',
      run: applyAll(idleRun(), [{ type: 'start' }]),
      event: { type: 'step-started', stepId: 'profile', at: 2000 },
    },
    {
      label: '没启动就结束',
      run: applyAll(idleRun(), [{ type: 'start' }]),
      event: { type: 'step-finished', stepId: search, at: 2000 },
    },
    {
      label: '暂停中推进',
      run: applyAll(idleRun(), [
        { type: 'start' },
        { type: 'step-started', stepId: search, at: 2000 },
        { type: 'pause' },
      ]),
      event: { type: 'step-finished', stepId: search, at: 2500 },
    },
    {
      label: '已完成的 run 再重试',
      run: finishedRun(),
      event: { type: 'retry-step', stepId: search },
    },
    {
      label: '重试一个不存在的步 id',
      run: applyAll(idleRun(), [
        { type: 'start' },
        { type: 'step-started', stepId: search, at: 2000 },
        { type: 'step-failed', stepId: search, at: 2500, error: 'boom' },
      ]),
      event: { type: 'retry-step', stepId: 'nope' as (typeof WORKFLOW_STEP_IDS)[number] },
    },
    {
      label: '全部结束后没有可启动的步骤',
      run: { ...finishedRun(), status: 'running', stepIndex: WORKFLOW_STEP_IDS.length },
      event: { type: 'step-started', stepId: search, at: 9000 },
    },
  ];

  it.each(cases)('$label → 拒绝并给出原因', ({ run, event }) => {
    const frozen = structuredClone(run);
    const result = transition(run, event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    // 非法迁移不许改动入参：状态是普通对象，被就地改会同时污染界面正在读的快照。
    expect(run).toEqual(frozen);
  });
});
