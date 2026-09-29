/**
 * `@auto-cc/plugin-workflow`（spec 1.10）：工作流执行器骨架。
 *
 * P1 只交付**空转的流水线**：六个主线步骤按 `machine.ts` 的迁移表依次推进，
 * 每推进一次推一条 `workflow/progress` 事件。步骤里什么都没有——真实的抓 JD、
 * 生成话术、打招呼、投递在 P2 换进来，换实现时不动状态机、不动界面、不动事件契约。
 *
 * 为什么状态驻内存而不建表：1.10-01…09 没有任何一条要求「重启后还能看到那次 run」，
 * 提前落库会让「内存态 vs 表行谁是真相」变成悬案，而且会占掉迁移号段 2
 * （号段规则见 plan §8.4 决策 6）。P2 的第一张真表再取 2。
 */
import {
  AppError,
  Service,
  WORKFLOW_STEP_IDS,
  sleep,
  type Context,
  type SessionExpiredEvent,
  type WorkflowRunView,
  type WorkflowStepId,
  type WorkflowTakeoverView,
} from '@auto-cc/core';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createRun, transition, type RunnerEvent } from './machine.js';

/** 执行器配置（在调试面板里可热改，走 1.5 的 `plugins.saveConfig`）。 */
export const workflowConfigSchema = z.object({
  /** 每个占位步骤的模拟耗时（毫秒）。上限卡在 5 秒：验收要连拍进度，太慢就拍不完。 */
  stepDelayMs: z.number().int().min(0).max(5000).default(600),
  /**
   * 让某一步**首次执行**必然失败，用来演示「失败步可单独重试并跑完」（spec 1.10-06）。
   * 只注入一次：改配置会重建实例并丢掉当前 run，若重试仍必然失败就永远看不到「重试→成功」这条路。
   */
  failStep: z.union([z.literal('none'), z.enum(WORKFLOW_STEP_IDS)]).default('none'),
});

export type WorkflowConfig = z.output<typeof workflowConfigSchema>;

/** 工作流执行器：全应用唯一一份 run 状态，界面只是它的镜像（spec 1.10-08）。 */
export class WorkflowRunnerService extends Service {
  static provide = 'workflow.runner';
  static Config = workflowConfigSchema;

  constructor(
    ctx: Context,
    private readonly config: WorkflowConfig,
  ) {
    super(ctx, 'workflow.runner');
  }

  /** 当前 run：挂载即是一个 `idle` 的六步快照，所以界面任何时候都有槽位可画（spec 1.10-02/03）。 */
  private run: WorkflowRunView = createRun(randomUUID(), Date.now());

  /** 本次 run 的取消句柄；暂停/续跑/重试都会换一个新的，避免复用已 abort 的信号。 */
  private controller: AbortController | undefined;

  /** 本次 run 已经注入过失败的步骤；`failStep` 只作用第一次，重试就让它过去（见配置注释）。 */
  private failInjectedFor: WorkflowStepId | null = null;

  /**
   * 当前 run 的快照，含还没跑过的 `idle` 那一版。
   * @returns 永不为 null；界面按状态画六个槽位，不需要为空态另写一套
   */
  current(): WorkflowRunView {
    return this.run;
  }

  /**
   * 起一个新的占位 run 并开始推进。
   * @returns 刚进入 `running` 的状态
   * @throws 上一个 run 还没走完时以 `WORKFLOW_INVALID_STATE` 失败（先暂停/重试，别并行两个 run）
   */
  start(): WorkflowRunView {
    if (this.run.status !== 'idle' && this.run.status !== 'done') {
      throw new AppError(
        'WORKFLOW_INVALID_STATE',
        `已有 run 处于 ${this.run.status} 态，先处理完它`,
        'workflow.runner',
        {
          status: this.run.status,
        },
      );
    }
    this.controller = new AbortController();
    this.failInjectedFor = null;
    this.run = createRun(randomUUID(), Date.now());
    const started = this.apply({ type: 'start' });
    void this.pump();
    return started;
  }

  /**
   * 请求暂停：把当前步退回 `pending` 并发出取消信号，**等它自己让出**。
   * @param message 暂停原因（spec 1.8-07 的会话失效走这里带原因）；null = 用户点了暂停按钮，无需播报
   * @returns 进入 `paused` 的状态
   * @throws 不在运行中时结构化失败
   */
  pause(message: string | null = null): WorkflowRunView {
    return this.stop(message, null);
  }

  /**
   * 从当前步续跑（不重置已完成步，spec 1.10-05）。
   * @returns 重新进入 `running` 的状态
   * @throws 不在暂停中时结构化失败
   */
  resume(): WorkflowRunView {
    const resumed = this.apply({ type: 'resume' });
    // 旧句柄已经 abort 过，复用它会让新的一步刚起步就被判成「已让出」。
    this.controller = new AbortController();
    void this.pump();
    return resumed;
  }

  /**
   * 单独重试某一个失败步（spec 1.10-06）。
   * @param stepIdRaw 步骤 id，来自渲染层——按不可信输入校验，不认就结构化失败
   * @returns 重新进入 `running`、`stepIndex` 指回该步的状态
   * @throws 步 id 不合法或该步不在失败态时 `WORKFLOW_INVALID_STATE`
   */
  retryStep(stepIdRaw: string): WorkflowRunView {
    if (!(WORKFLOW_STEP_IDS as readonly string[]).includes(stepIdRaw)) {
      throw new AppError('WORKFLOW_INVALID_STATE', `未知步骤 ${stepIdRaw}`, 'workflow.runner', { stepId: stepIdRaw });
    }
    const retried = this.apply({ type: 'retry-step', stepId: stepIdRaw as WorkflowStepId });
    this.controller = new AbortController();
    void this.pump();
    return retried;
  }

  [Service.init](): void {
    // 卸载时必须让出在跑的循环，否则 `plugins.stop('workflow')` 之后定时器链还在推进一个没人看的 run。
    this.ctx.effect(() => () => this.controller?.abort());
    // 会话失效是 `sessions` 探测出来的，runner 只在运行中接它：不在运行中就没有可停的地方。
    const offSessionExpired = this.ctx.on('session/expired', (event) => this.handleSessionExpired(event));
    this.ctx.effect(() => offSessionExpired, 'workflow.session-expired');
    // 改配置会重建实例：不推这一句的话界面上会继续挂着上一个已被销毁的 run（实测过）。
    this.pushProgress(null, null);
    this.ctx.logger.info(`工作流执行器就绪：六步占位流水线，单步 ${String(this.config.stepDelayMs)}ms`);
  }

  /**
   * 停在可恢复点并写出接管点（`pause` 与人工接管共用的那条路）。
   * @param message 日志用的一句话说明（不进界面文案：界面按 `takeover` 自己组织 i18n 句子）
   * @param takeover 接管点数据；null = 普通暂停（用户自己按了暂停）
   * @returns 进入 `paused` 的状态
   */
  private stop(message: string | null, takeover: WorkflowTakeoverView | null): WorkflowRunView {
    const paused = this.apply({ type: 'pause', takeover }, message);
    this.controller?.abort();
    return paused;
  }

  /**
   * 登录态失效时停在可恢复点并**留下结构化接管点**（spec 1.8-07 / 2.1-08）：
   * 不能让它继续往外发一个必然失败的请求，也不能静默停在半路——用户必须看见「卡在哪一步、为什么」。
   *
   * 2.1 之前这里直接拼了一句中文给界面显示，界面因此拿到的是主进程的字符串而不是语言包；
   * 现在只把 `平台 / 原因 / 停在第几步` 作为数据推过去，句子由渲染层按当前语言组（AGENTS.md §5.5 / §5.7）。
   * @param event `sessions` 推的失效事件（只有平台名与判定原因，无 cookie）
   */
  private handleSessionExpired(event: SessionExpiredEvent): void {
    if (this.run.status !== 'running') return;
    const currentStep = this.run.steps[this.run.stepIndex];
    if (!currentStep) return;
    this.ctx.logger.warn(`${event.platform} 登录态失效（${event.reason}），已停在 ${currentStep.id}，等待用户接管`);
    this.stop(null, { platform: event.platform, reason: event.reason, stepId: currentStep.id, at: event.at });
  }

  /**
   * 把当前 run 推给渲染层。
   * @param stepId 本条播报涉及的步骤（纯状态迁移时为 null）
   * @param message 要显示给用户的一句话（无播报时为 null）
   */
  private pushProgress(stepId: WorkflowStepId | null, message: string | null): void {
    this.ctx.emit('workflow/progress', { run: this.run, stepId, message });
  }

  /**
   * 跑一次迁移并推送进度。
   * @param event 迁移事件
   * @param message 要显示给用户的一句话（null 表示纯状态迁移）
   * @returns 迁移后的状态
   * @throws 非法迁移以 `WORKFLOW_INVALID_STATE` 失败，不抛裸异常
   */
  private apply(event: RunnerEvent, message: string | null = null): WorkflowRunView {
    const run = this.run;
    const result = transition(run, event);
    if (!result.ok) {
      throw new AppError('WORKFLOW_INVALID_STATE', result.reason, 'workflow.runner', {
        status: run.status,
        event: event.type,
      });
    }
    this.run = result.run;
    this.pushProgress('stepId' in event ? event.stepId : null, message);
    return this.run;
  }

  /**
   * 推进循环：依次跑完每一步，直到 run 不再是 `running`。
   *
   * 每一步都重新读 `this.run`，因为暂停/重试可能在两次推进之间改走状态；
   * `await` 之后必须先确认「这次让出是谁引起的」，否则会把 paused 覆盖成 done。
   */
  private async pump(): Promise<void> {
    for (;;) {
      const run = this.run;
      if (run.status !== 'running') return;
      const step = run.steps[run.stepIndex];
      if (!step) return;
      this.apply({ type: 'step-started', stepId: step.id, at: Date.now() }, `开始 ${step.id}`);
      const controller = this.controller;
      try {
        await this.executeStep(step.id);
      } catch (error) {
        this.apply(
          {
            type: 'step-failed',
            stepId: step.id,
            at: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          },
          `${step.id} 失败`,
        );
        return;
      }
      if (controller?.signal.aborted || this.run?.status !== 'running') return;
      this.apply({ type: 'step-finished', stepId: step.id, at: Date.now() }, `${step.id} 完成`);
    }
  }

  /**
   * 执行一个占位步骤。
   * @param stepId 要跑的步骤 id
   * @throws 命中 `failStep` 且本次 run 尚未注入过时以 `WORKFLOW_STEP_FAILED` 抛出（1.10-06 的失败注入）
   */
  private async executeStep(stepId: WorkflowStepId): Promise<void> {
    await sleep(this.config.stepDelayMs, this.controller?.signal);
    if (this.config.failStep === stepId && this.failInjectedFor !== stepId) {
      this.failInjectedFor = stepId;
      throw new AppError(
        'WORKFLOW_STEP_FAILED',
        `步骤 ${stepId} 首次执行被注入为失败（failStep），重试即通过`,
        'workflow.runner',
        {
          stepId,
        },
      );
    }
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'workflow.runner': WorkflowRunnerService;
  }
}
