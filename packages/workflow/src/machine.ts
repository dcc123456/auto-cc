/**
 * `workflow.runner` 的迁移表（spec 1.10-03 / 1.10-09）。
 *
 * 纯函数：给定当前 run 与一个事件，要么返回下一个 run，要么返回「这是非法迁移」的结论。
 * 状态是普通可序列化对象而不是某个解释器的内部态，所以「从当前步续跑」就是把 `stepIndex`
 * 指回去，「非法迁移被拒而不崩」就是返回一句 reason 由调用方转成结构化错误（plan §8.5 选型）。
 */
import { WORKFLOW_STEP_IDS, type WorkflowRunView, type WorkflowStepId, type WorkflowStepView } from '@auto-cc/core';

/** runner 认得的迁移事件；`at` 一律是毫秒时间戳，由调用方给（测试据此造出确定耗时）。 */
export type RunnerEvent =
  | { type: 'start' }
  | { type: 'step-started'; stepId: WorkflowStepId; at: number }
  | { type: 'step-finished'; stepId: WorkflowStepId; at: number }
  | { type: 'step-failed'; stepId: WorkflowStepId; at: number; error: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'retry-step'; stepId: WorkflowStepId };

/** 一次迁移的结果：合法就给新状态，非法就给一句能显示给用户的原因。 */
export type TransitionResult = { ok: true; run: WorkflowRunView } | { ok: false; reason: string };

/**
 * 造一个还没开始的 run：六个槽位全部 `pending`，耗时与时间戳都是 null。
 * @param runId 本次 run 的 id（由服务侧生成，界面只回显）
 * @param at 创建时间戳（毫秒）
 * @returns 状态为 `idle`、`stepIndex` 为 0 的 run
 */
export function createRun(runId: string, at: number): WorkflowRunView {
  const steps: WorkflowStepView[] = WORKFLOW_STEP_IDS.map((id) => ({
    id,
    status: 'pending',
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    error: null,
  }));
  return { runId, status: 'idle', stepIndex: 0, steps, startedAt: at };
}

/** 替换某个下标处的步骤读数（其余字段原样带着走，避免逐字段手抄漏一个）。 */
function withStep(run: WorkflowRunView, index: number, patch: Partial<WorkflowStepView>): WorkflowRunView {
  const steps = run.steps.map((step, position) => (position === index ? { ...step, ...patch } : step));
  return { ...run, steps };
}

/**
 * 跑一次迁移。
 * @param run 当前状态（不会被改动）
 * @param event 迁移事件
 * @returns `{ ok: true, run }` 或 `{ ok: false, reason }`——非法迁移不抛异常，
 *          因为「界面多点了一次按钮」不该变成主进程崩溃（spec 1.10-09）
 */
export function transition(run: WorkflowRunView, event: RunnerEvent): TransitionResult {
  switch (event.type) {
    case 'start':
      if (run.status !== 'idle') return { ok: false, reason: `只有未开始的 run 可以启动，当前是 ${run.status}` };
      return { ok: true, run: { ...run, status: 'running' } };

    case 'step-started': {
      if (run.status !== 'running') return { ok: false, reason: `run 不在运行中，当前是 ${run.status}` };
      const current = run.steps[run.stepIndex];
      if (!current) return { ok: false, reason: '所有步骤都已结束，没有可启动的步骤' };
      if (current.id !== event.stepId) {
        return { ok: false, reason: `只能启动当前步 ${current.id}，收到的是 ${event.stepId}` };
      }
      return { ok: true, run: withStep(run, run.stepIndex, { status: 'running', startedAt: event.at }) };
    }

    case 'step-finished': {
      if (run.status !== 'running') return { ok: false, reason: `run 不在运行中，当前是 ${run.status}` };
      const current = run.steps[run.stepIndex];
      if (!current || current.id !== event.stepId || current.status !== 'running') {
        return { ok: false, reason: `只能结束正在运行的当前步 ${current?.id ?? '（无）'}` };
      }
      const stepIndex = run.stepIndex + 1;
      const finished = withStep(run, run.stepIndex, {
        status: 'done',
        finishedAt: event.at,
        durationMs: event.at - (current.startedAt ?? event.at),
      });
      // 最后一步结束就是整个 run 结束：stepIndex 停在越界的一位，界面据此显示「全部完成」。
      const status = stepIndex >= run.steps.length ? 'done' : finished.status;
      return { ok: true, run: { ...finished, stepIndex, status } };
    }

    case 'step-failed': {
      if (run.status !== 'running') return { ok: false, reason: `run 不在运行中，当前是 ${run.status}` };
      const current = run.steps[run.stepIndex];
      if (!current || current.id !== event.stepId || current.status !== 'running') {
        return { ok: false, reason: `只能让正在运行的当前步 ${current?.id ?? '（无）'} 失败` };
      }
      const failed = withStep(run, run.stepIndex, {
        status: 'failed',
        finishedAt: event.at,
        durationMs: event.at - (current.startedAt ?? event.at),
        error: event.error,
      });
      return { ok: true, run: { ...failed, status: 'failed' } };
    }

    case 'pause': {
      if (run.status !== 'running') return { ok: false, reason: `只有运行中的 run 可以暂停，当前是 ${run.status}` };
      const current = run.steps[run.stepIndex];
      if (!current) return { ok: false, reason: '已经没有进行中的步骤可暂停' };
      // 当前步回到 pending：它没有跑完，续跑时要从头再来这一步（spec 1.10-05）。
      const paused = withStep(run, run.stepIndex, { status: 'pending', startedAt: null, durationMs: null });
      return { ok: true, run: { ...paused, status: 'paused' } };
    }

    case 'resume':
      if (run.status !== 'paused') return { ok: false, reason: `只有暂停中的 run 可以续跑，当前是 ${run.status}` };
      return { ok: true, run: { ...run, status: 'running' } };

    case 'retry-step': {
      if (run.status !== 'failed') return { ok: false, reason: `只有失败的 run 可以重试单步，当前是 ${run.status}` };
      const index = run.steps.findIndex((step) => step.id === event.stepId);
      const target = run.steps[index];
      if (!target || target.status !== 'failed') {
        return { ok: false, reason: `步骤 ${event.stepId} 不处于失败态，无需重试` };
      }
      const retried = withStep(run, index, {
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        error: null,
      });
      return { ok: true, run: { ...retried, stepIndex: index, status: 'running' } };
    }
  }
}
