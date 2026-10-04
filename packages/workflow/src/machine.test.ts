/**
 * 迁移表的穷举测试（spec 1.10-03 / 1.10-09 → 2.4-02）。
 *
 * 这块要证明的不是「代码能跑」，而是两件事：计划节点排成的线性序列**每一次合法迁移**都落在预期状态上，
 * 以及**每一次非法迁移**都被拒成一句可读的 reason 而不是异常——1.10-09 的反向验证就压在这上面：
 * 不引状态机库也没漏掉「非法调用被拒而不崩」这条能力。
 *
 * 2.4 之后槽位不再来自常量清单，而是调用方把计划的节点 id 交给 `createRun`（plan §11.3 第 2 条），
 * 所以这里用 `boss-basic` 那三个 id 造 run：换一批 id 就是换一条计划，迁移表本身一行不改。
 */
import type { WorkflowRunView, WorkflowStepView } from '@auto-cc/core';
import { describe, expect, it } from 'vitest';
import { createRun, transition, type RunnerEvent } from './machine.js';

/** `boss-basic` 计划的节点 id，顺序即执行顺序（与 `plan.ts` 那条计划一致）。 */
const NODE_IDS = ['jd-capture', 'jd-list', 'flaky'] as const;

/** 取一个确定性初始 run（时间戳固定，不参与断言，只为避免 randomUUID 噪声）。 */
function idleRun(): WorkflowRunView {
  return createRun('run-test', 1000, NODE_IDS);
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

/** 把三个节点全部跑到 done（用于「已完成 run 上再做动作」这类非法用例的前置）。 */
function finishedRun(): WorkflowRunView {
  const events: RunnerEvent[] = [];
  NODE_IDS.forEach((stepId, index) => {
    events.push({ type: 'step-started', stepId, at: 1000 + index * 100 });
    events.push({ type: 'step-finished', stepId, at: 1000 + index * 100 + 50 });
  });
  return applyAll({ ...idleRun(), status: 'running' }, events);
}

describe('createRun 的初始形状（1.10-01 / 2.4-01）', () => {
  it('槽位数等于传入的节点数，全部 pending 且没有耗时', () => {
    const run = idleRun();
    expect(run.runId).toBe('run-test');
    expect(run.status).toBe('idle');
    expect(run.stepIndex).toBe(0);
    expect(run.steps.map((step) => step.id)).toEqual(['jd-capture', 'jd-list', 'flaky']);
    expect(
      run.steps.every((step) => step.status === 'pending' && step.durationMs === null && step.error === null),
    ).toBe(true);
  });

  it('换一条计划就是换一批格子：迁移表不含任何写死的步骤数', () => {
    const twoNodes = createRun('run-two', 1000, ['a', 'b']);
    expect(twoNodes.steps.map((step) => step.id)).toEqual(['a', 'b']);
    const done = applyAll(twoNodes, [
      { type: 'start' },
      { type: 'step-started', stepId: 'a', at: 1100 },
      { type: 'step-finished', stepId: 'a', at: 1200 },
      { type: 'step-started', stepId: 'b', at: 1300 },
      { type: 'step-finished', stepId: 'b', at: 1400 },
    ]);
    expect(done.status).toBe('done');
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
      { type: 'step-started', stepId: 'jd-capture', at: 2000 },
      { type: 'step-finished', stepId: 'jd-capture', at: 2600 },
      { type: 'step-started', stepId: 'jd-list', at: 3000 },
    ]);
    expect(run.stepIndex).toBe(1);
    expect(stepAt(run, 0)).toMatchObject({ status: 'done', durationMs: 600, error: null });
    expect(stepAt(run, 1)).toMatchObject({ status: 'running', startedAt: 3000, durationMs: null });
    expect(stepAt(run, 2).status).toBe('pending');
  });

  it('最后一步结束把整个 run 置为 done，stepIndex 停在越界位', () => {
    const run = finishedRun();
    expect(run.status).toBe('done');
    expect(run.stepIndex).toBe(NODE_IDS.length);
    expect(run.steps.every((step) => step.status === 'done')).toBe(true);
  });

  it('库里已有结局的位置直接跳过：推进下标、标成 done，但不编造耗时（2.4-05 的不重放）', () => {
    const run = applyAll(idleRun(), [{ type: 'start' }, { type: 'step-skipped', stepId: 'jd-capture', at: 2000 }]);
    expect(run.stepIndex).toBe(1);
    // 耗时留空：把库里的真实耗时编成 0ms 是撒谎，界面宁可不显示这一格。
    expect(stepAt(run, 0)).toMatchObject({ status: 'done', finishedAt: 2000, durationMs: null });
    expect(stepAt(run, 1).status).toBe('pending');

    const allSkipped = applyAll(run, [
      { type: 'step-skipped', stepId: 'jd-list', at: 2100 },
      { type: 'step-skipped', stepId: 'flaky', at: 2200 },
    ]);
    expect(allSkipped.status).toBe('done');
    expect(allSkipped.stepIndex).toBe(NODE_IDS.length);
  });

  it('编排层的意外把整条 run 判失败：已完成的位置不被改写，且仍能从这一步重试', () => {
    const failed = applyAll(idleRun(), [
      { type: 'start' },
      { type: 'step-started', stepId: 'jd-capture', at: 2000 },
      { type: 'step-finished', stepId: 'jd-capture', at: 2100 },
      { type: 'step-started', stepId: 'jd-list', at: 2200 },
      { type: 'run-failed', error: '库里读回的计划与登记的指纹不一致', at: 2300 },
    ]);
    expect(failed.status).toBe('failed');
    expect(stepAt(failed, 0).status).toBe('done');
    expect(stepAt(failed, 1)).toMatchObject({
      status: 'failed',
      error: '库里读回的计划与登记的指纹不一致',
      // 没跑完的一步不编耗时（同 `step-skipped` 那条口径）。
      durationMs: null,
    });
    expect(stepAt(failed, 2).status).toBe('pending');
    expect(applyAll(failed, [{ type: 'retry-step', stepId: 'jd-list' }]).status).toBe('running');
  });

  it('暂停把当前步退回 pending 但不动 stepIndex，续跑接着这一步（1.10-05）', () => {
    const paused = applyAll(idleRun(), [
      { type: 'start' },
      { type: 'step-started', stepId: 'jd-capture', at: 2000 },
      { type: 'step-finished', stepId: 'jd-capture', at: 2600 },
      { type: 'step-started', stepId: 'jd-list', at: 3000 },
      { type: 'pause' },
    ]);
    expect(paused.status).toBe('paused');
    expect(paused.stepIndex).toBe(1);
    expect(stepAt(paused, 1)).toMatchObject({ status: 'pending', startedAt: null, durationMs: null });
    expect(stepAt(paused, 0).status).toBe('done');

    const resumed = applyAll(paused, [{ type: 'resume' }, { type: 'step-started', stepId: 'jd-list', at: 4000 }]);
    expect(resumed.status).toBe('running');
    // 从头再来这一步：startedAt 是续跑后的时间，不是暂停前那个。
    expect(resumed.steps[1]).toMatchObject({ status: 'running', startedAt: 4000 });
  });

  it('失败步单独重试时把 stepIndex 指回去并清掉错误（1.10-06）', () => {
    const failed = applyAll(idleRun(), [
      { type: 'start' },
      { type: 'step-started', stepId: 'jd-capture', at: 2000 },
      { type: 'step-finished', stepId: 'jd-capture', at: 2600 },
      { type: 'step-started', stepId: 'jd-list', at: 3000 },
      { type: 'step-failed', stepId: 'jd-list', at: 3200, error: '对端不可达' },
    ]);
    expect(failed.status).toBe('failed');
    expect(failed.steps[1]).toMatchObject({ status: 'failed', error: '对端不可达', durationMs: 200 });
    // 失败之后的后续步仍是 pending——不能因为它们没跑就把整个 run 判成 partial done。
    expect(stepAt(failed, 2).status).toBe('pending');

    const retried = applyAll(failed, [{ type: 'retry-step', stepId: 'jd-list' }]);
    expect(retried.status).toBe('running');
    expect(retried.stepIndex).toBe(1);
    expect(retried.steps[1]).toMatchObject({ status: 'pending', error: null, finishedAt: null, durationMs: null });
  });
});

describe('接管点（spec 2.1-08 / 2.4-06）', () => {
  /** 一个「运行中、停在第一个节点」的状态，接管相关断言都从它出发。 */
  const running = () =>
    applyAll(idleRun(), [{ type: 'start' }, { type: 'step-started', stepId: 'jd-capture', at: 2000 }]);

  it('未开始的 run 没有接管点，界面不会凭空挂出「等待你接管」', () => {
    expect(idleRun().requiresHuman).toBeNull();
    // 归档位同理：新 run 上没有任何一格该挂「已人工接管」（spec 2.8-11 的反向验证）。
    expect(idleRun().takeoverHandled).toBeNull();
  });

  it('普通暂停只是用户按了停止，不写接管点', () => {
    expect(applyAll(running(), [{ type: 'pause' }]).requiresHuman).toBeNull();
    expect(applyAll(running(), [{ type: 'pause', takeover: null }]).requiresHuman).toBeNull();
  });

  it('带接管原因的暂停把「主体 + 原因 + 卡在哪一步」原样留在 run 上', () => {
    const takeover = { subject: 'boss', reason: 'expired', stepId: 'jd-capture', at: 2500 } as const;
    const paused = applyAll(running(), [{ type: 'pause', takeover }]);
    expect(paused.status).toBe('paused');
    // 断言的是**数据**而不是句子：文案由渲染层按语言组织（AGENTS.md §5.5），主进程不参与组句。
    expect(paused.requiresHuman).toEqual(takeover);
  });

  it('拒绝盲重放时挂的是**执行器名**而不是平台名，界面据此换一句文案', () => {
    const takeover = {
      subject: 'jd.capture',
      reason: 'unobserved-side-effect',
      stepId: 'jd-capture',
      at: 2500,
    } as const;
    expect(applyAll(running(), [{ type: 'pause', takeover }]).requiresHuman).toEqual(takeover);
  });

  it('续跑即宣告接管完成，横幅跟着消失', () => {
    const paused = applyAll(running(), [
      { type: 'pause', takeover: { subject: 'boss', reason: 'missing', stepId: 'jd-capture', at: 2500 } },
    ]);
    expect(applyAll(paused, [{ type: 'resume' }]).requiresHuman).toBeNull();
  });

  it('续跑把那次接管归档到 `takeoverHandled`：横幅消失，但「已人工接管」的格子留痕（spec 2.8-11）', () => {
    const takeover = { subject: 'boss', reason: 'risk-control', stepId: 'jd-capture', at: 2500 } as const;
    const resumed = applyAll(applyAll(running(), [{ type: 'pause', takeover }]), [{ type: 'resume' }]);
    expect(resumed.requiresHuman).toBeNull();
    // 留的是**同一份数据**：界面按 `stepId` 找格子、按 `reason` 组织文案，主进程不组句。
    expect(resumed.takeoverHandled).toEqual(takeover);
  });

  it('普通暂停（用户按停止）恢复后不留「已人工接管」：没接管过就不该有痕', () => {
    const resumed = applyAll(applyAll(running(), [{ type: 'pause' }]), [{ type: 'resume' }]);
    expect(resumed.status).toBe('running');
    expect(resumed.takeoverHandled).toBeNull();
  });

  it('再次接管时归档换成最近一次：一个 run 只有一格挂「已人工接管」', () => {
    const first = { subject: 'boss', reason: 'missing', stepId: 'jd-capture', at: 2500 } as const;
    const second = { subject: 'boss', reason: 'expired', stepId: 'jd-list', at: 9000 } as const;
    // 第一段：jd-capture 上接管并恢复（恢复后这一步从头再跑，所以要先 started 再 finished），然后停在 jd-list。
    const afterFirst = applyAll(running(), [
      { type: 'pause', takeover: first },
      { type: 'resume' },
      { type: 'step-started', stepId: 'jd-capture', at: 2900 },
      { type: 'step-finished', stepId: 'jd-capture', at: 3000 },
      { type: 'step-started', stepId: 'jd-list', at: 3100 },
    ]);
    expect(afterFirst.takeoverHandled).toEqual(first);
    const afterSecond = applyAll(afterFirst, [{ type: 'pause', takeover: second }, { type: 'resume' }]);
    expect(afterSecond.takeoverHandled).toEqual(second);
  });

  it('重新起一个 run 不会把上一个的接管点带过来', () => {
    const paused = applyAll(running(), [
      { type: 'pause', takeover: { subject: 'boss', reason: 'missing', stepId: 'jd-capture', at: 2500 } },
    ]);
    const restarted = applyAll({ ...paused, status: 'idle' }, [{ type: 'start' }]);
    expect(restarted.requiresHuman).toBeNull();
  });
});

describe('非法迁移一律拒绝且不抛异常（1.10-09）', () => {
  const first = NODE_IDS[0];
  const cases: { label: string; run: WorkflowRunView; event: RunnerEvent }[] = [
    { label: '未开始就暂停', run: idleRun(), event: { type: 'pause' } },
    { label: '未开始就续跑', run: idleRun(), event: { type: 'resume' } },
    { label: '未开始就重试', run: idleRun(), event: { type: 'retry-step', stepId: first } },
    { label: '未开始就跳过', run: idleRun(), event: { type: 'step-skipped', stepId: first, at: 2000 } },
    {
      label: '未开始就整体判失败',
      run: idleRun(),
      event: { type: 'run-failed', error: 'boom', at: 2000 },
    },
    { label: '运行中再 start', run: applyAll(idleRun(), [{ type: 'start' }]), event: { type: 'start' } },
    {
      label: '启动非当前步',
      run: applyAll(idleRun(), [{ type: 'start' }]),
      event: { type: 'step-started', stepId: 'jd-list', at: 2000 },
    },
    {
      label: '没启动就结束',
      run: applyAll(idleRun(), [{ type: 'start' }]),
      event: { type: 'step-finished', stepId: first, at: 2000 },
    },
    {
      label: '没启动就判失败',
      run: applyAll(idleRun(), [{ type: 'start' }]),
      event: { type: 'step-failed', stepId: first, at: 2000, error: 'boom' },
    },
    {
      label: '暂停中推进',
      run: applyAll(idleRun(), [
        { type: 'start' },
        { type: 'step-started', stepId: first, at: 2000 },
        { type: 'pause' },
      ]),
      event: { type: 'step-finished', stepId: first, at: 2500 },
    },
    {
      label: '暂停中跳过',
      run: applyAll(idleRun(), [
        { type: 'start' },
        { type: 'step-started', stepId: first, at: 2000 },
        { type: 'pause' },
      ]),
      event: { type: 'step-skipped', stepId: first, at: 2500 },
    },
    {
      label: '已完成的 run 再重试',
      run: finishedRun(),
      event: { type: 'retry-step', stepId: first },
    },
    {
      label: '重试一个不存在的步 id',
      run: applyAll(idleRun(), [
        { type: 'start' },
        { type: 'step-started', stepId: first, at: 2000 },
        { type: 'step-failed', stepId: first, at: 2500, error: 'boom' },
      ]),
      event: { type: 'retry-step', stepId: 'nope' },
    },
    {
      label: '全部结束后没有可启动的步骤',
      run: { ...finishedRun(), status: 'running', stepIndex: NODE_IDS.length },
      event: { type: 'step-started', stepId: first, at: 9000 },
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

describe('step-skipped 的两种来由（spec 5.10-08：「跳过」与「已完成」必须分得开）', () => {
  const head = NODE_IDS[0] ?? 'jd-capture';

  /** 起手到第一步正在跑：`step-skipped` 只对运行中的当前步合法。 */
  function runningHead(): WorkflowRunView {
    return applyAll(idleRun(), [{ type: 'start' }, { type: 'step-started', stepId: head, at: 2000 }]);
  }

  it('不带 reason（库里这个位置已有结局）时镜像仍标 done，游标照下一格走', () => {
    const result = transition(runningHead(), { type: 'step-skipped', stepId: head, at: 3000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(stepAt(result.run, 0).status).toBe('done');
    expect(result.run.stepIndex).toBe(1);
  });

  it('branch-not-taken 时镜像标 skipped——只走了半张图的 run 不许和跑完的长一样', () => {
    const result = transition(runningHead(), {
      type: 'step-skipped',
      stepId: head,
      at: 3000,
      reason: 'branch-not-taken',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(stepAt(result.run, 0).status).toBe('skipped');
    // 耗时照旧留 null：这一步没跑过，编个 0ms 就是往统计里掺假数（spec 2.4-10 的读数必须可信）。
    expect(stepAt(result.run, 0).durationMs).toBeNull();
    expect(result.run.stepIndex).toBe(1);
  });

  it('同一张 run 里 done 与 skipped 各留各的读数，后者不覆盖前者', () => {
    const mixed = applyAll(idleRun(), [
      { type: 'start' },
      { type: 'step-started', stepId: head, at: 2000 },
      { type: 'step-finished', stepId: head, at: 2500 },
      { type: 'step-started', stepId: 'jd-list', at: 2600 },
      { type: 'step-skipped', stepId: 'jd-list', at: 3000, reason: 'branch-not-taken' },
    ]);
    expect(mixed.steps.map((step) => step.status)).toEqual(['done', 'skipped', 'pending']);
    expect(stepAt(mixed, 0).durationMs).toBe(500);
    expect(stepAt(mixed, 1).finishedAt).toBe(3000);
  });
});
