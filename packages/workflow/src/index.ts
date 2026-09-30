/**
 * `@auto-cc/plugin-workflow`（spec 1.10 → 2.4）：按**计划**推进的工作流执行器。
 *
 * 1.10 交付的是六个占位步骤的空转流水线；2.4 把「步骤」换成「计划里的节点」：
 * 节点从 `plan.ts` 的计划声明来，执行函数从 `workflow.executors` 登记处来，
 * 每一次开始/结束/失败/重试都同时写进 `workflow.store` 的两张表（spec 2.4-01/02/05/10）。
 * 状态机仍然是 `machine.ts` 那一份，事件仍然只有 `workflow/progress` 一条频道，
 * 界面仍然只画 `run.steps`——换实现不动这三样（plan §11.3 第 1/2/3 条）。
 *
 * 失败只有三种下场：自动退避重试、转人工接管、判失败（plan §11.8）。没有节点级自动修复，
 * 也没有「猜一次也许就成了」的静默重放——外发动作重放一遍就是给同一个人发两条消息。
 */
import {
  AppError,
  asApp,
  maybeService,
  Service,
  sleep,
  type Context,
  type SessionExpiredEvent,
  type ToolEffect,
  type WorkflowNodeSpec,
  type WorkflowNodeExecutor,
  type WorkflowNodePhase,
  type WorkflowPlanView,
  type WorkflowRunStateView,
  type WorkflowRunView,
  type WorkflowStepId,
  type WorkflowStepView,
  type WorkflowTakeoverView,
} from '@auto-cc/core';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createRun, transition, type RunnerEvent } from './machine.js';
import type { WorkflowExecutorRegistryService } from './executors.js';
import { planById } from './plan.js';
import type { WorkflowRunStoreService } from './run-store.js';

// 登记处与落库服务从包出口露出去：装配清单要为它们各占一个 id（main/registry.ts）。
// 执行器的**契约**（`WorkflowNodeExecutor` 等）在 `@auto-cc/core`，能力包从那里取，不 import 本包。
export { WorkflowExecutorRegistryService } from './executors.js';
export { WorkflowRunStoreService } from './run-store.js';
export { BOSS_BASIC_PLAN, WORKFLOW_PLANS, planById, buildPlan, workflowPlanSchema } from './plan.js';

/** 一个失败节点留下的证据（spec 2.4-04）。 */
type NodeEvidence = {
  runId: string;
  nodeId: string;
  kind: string;
  effect: ToolEffect;
  target: string;
  /** 判失败时是第几次尝试（含首次）。 */
  attempt: number;
  /** 判定时间戳（毫秒）。 */
  at: number;
  error: { code: string; message: string; details?: unknown };
  /** 失败当时的页面读数；没有已挂载的内核会话时为 null（证据仍然要落盘）。 */
  page: { url: string; title: string; bodyText: string } | null;
};

/**
 * `browser.page` 里证据只需要的那一个方法（按结构取，不引包依赖：
 * workflow 不 import browser，否则 2.4-08「无浏览器纯 mock 跑通整条链」就破了）。
 */
type PageSnapshotReader = {
  snapshot: (maxChars?: number) => Promise<{ url: string; title: string; bodyText: string }>;
};

/** 执行器配置（在调试面板里可热改，走 1.5 的 `plugins.saveConfig`；§11.4 的键表）。 */
export const workflowConfigSchema = z.object({
  /** 从 `WORKFLOW_PLANS` 里选哪条计划；选不到就在挂载期结构化失败。 */
  planId: z.string().min(1).default('boss-basic'),
  /** 失败后的**额外**尝试次数；`maxAttempts = 1 + retryTimes`（节点声明可覆盖）。 */
  retryTimes: z.number().int().min(0).max(5).default(2),
  /** 指数退避的基数：第 k 次重试前等 `backoff × 2^(k-1)` 毫秒。 */
  retryBackoffMs: z.number().int().min(0).max(5000).default(500),
  /** 退避上限，防止长计划卡死在一条指数尾巴上。 */
  retryBackoffCapMs: z.number().int().min(0).max(60000).default(5000),
  /** 单次 run 的节点上限（防死循环，也是界面画得下的上限）。 */
  maxNodesPerRun: z.number().int().min(1).max(200).default(200),
  /** 向页面通道索取的 DOM 片段上限（字符）。 */
  evidenceDomChars: z.number().int().min(0).max(20000).default(800),
  /** 证据文件里单个文本字段的上限（字符），超出截断并标注。 */
  evidenceTextChars: z.number().int().min(0).max(20000).default(300),
  /** userData 下的证据子目录名；文件名是 `<runId>-<nodeId>.json`。 */
  evidenceDir: z.string().min(1).max(64).default('evidence'),
  /** 旧 run 的保留个数，超出清 `workflow_*` 行并连带删掉它们的证据文件。 */
  retentionRuns: z.number().int().min(1).max(500).default(20),
});

export type WorkflowConfig = z.output<typeof workflowConfigSchema>;

/**
 * 工作流执行器：全应用唯一一份 run 状态，界面只是它的镜像（spec 1.10-08）。
 *
 * 与 1.10 的区别只有一句话：**槽位来自计划，进度同时落库**。
 * `current()` 给的是界面镜像（内存态，随事件推送），`state()` 给的是库里的真相（含尝试次数与证据路径）。
 */
export class WorkflowRunnerService extends Service {
  static provide = 'workflow.runner';
  static Config = workflowConfigSchema;
  static inject = ['workflow.store', 'workflow.executors', 'config'];

  /** 本次要跑的计划（挂载时按 `planId` 解析，之后不可变——指纹就是它的身份）。 */
  private readonly plan: WorkflowPlanView;

  /**
   * 当前 run 的镜像：挂载即是一个 `idle` 的节点数快照，所以界面任何时候都有槽位可画（spec 1.10-02/03）。
   * 这个初始 run 在库里**没有行**——它只是给界面的空格子，第一次 `start()` 才产生 runId 并落库。
   */
  private run: WorkflowRunView;

  constructor(
    ctx: Context,
    private readonly config: WorkflowConfig,
  ) {
    super(ctx, 'workflow.runner');
    // 这两样在构造器体里赋值而不是写在字段初始化器上：参数属性 `config` 是在字段初始化**之后**才写入的，
    // 初始化器里读它会拿到 undefined（TS2729）。计划不合法时在这里就抛，挂载因此结构化失败。
    this.plan = planById(config.planId);
    this.run = createRun(
      'pending',
      Date.now(),
      this.plan.nodes.map((node) => node.id),
    );
  }

  /** 本次 run 的取消句柄；暂停/续跑/重试都会换一个新的，避免复用已 abort 的信号。 */
  private controller: AbortController | undefined;

  /**
   * 本进程内已经「声明开始过」的节点位置（`runId#下标`）。
   *
   * 为什么需要它：幂等闸门（`claimNode`）的意义是**跨进程**不重放，而同一个进程内的退避重试
   * 是同一次尝试序列的延续。若不区分，暂停/续跑就会把一个正在自动重试的读节点判成「外发未观察完成」
   * 而转接管，把 1.10-05 的暂停-续跑打断。跨进程的那一侧（kill 后重启）这张表是空的，闸门照旧生效。
   */
  private readonly claimedPositions = new Set<string>();

  /**
   * 用户已经在接管点上确认过「就重放这一个位置」的那些位置（同样是 `runId#下标`）。
   *
   * 它和上一张表的区别是判决来源：上一张是「本进程亲眼开始过」，闸门可以直接放行；
   * 这张是「本进程没开始过，但人说了继续」，于是仍然走 `claimNode(force)`——闸门照常工作，
   * 只是把「拒绝」换成「一次带日志的重放」（plan §11.3 第 5 条）。用完即弃：一次确认只放行一次。
   */
  private readonly confirmedPositions = new Set<string>();

  /**
   * 当前 run 的镜像读数，含还没跑过的那些槽位。
   * @returns 永不为 null；界面按状态画槽位，不需要为空态另写一套
   */
  current(): WorkflowRunView {
    return this.run;
  }

  /**
   * 当前计划的节点声明（spec 2.4-01）。面板与 2.8 的工具卡片用它列节点。
   * @returns 按执行顺序排列的节点声明；返回的是计划本体的引用，调用方不该改
   */
  nodes(): WorkflowNodeSpec[] {
    return this.plan.nodes;
  }

  /**
   * 库里这次 run 的真相读数（spec 2.4-01/05/10 的界面出口）。
   * @returns 含逐节点尝试次数与证据路径；还没起过 run（只有初始镜像）时为 null
   */
  state(): WorkflowRunStateView | null {
    return this.store.state(this.run.runId);
  }

  /**
   * 起一个新的 run 并开始推进。
   * @returns 刚进入 `running` 的状态
   * @throws 上一个 run 还没走完时以 `WORKFLOW_INVALID_STATE` 失败（先暂停/重试，别并行两个 run）；
   *         计划里有登记处不认识的 `kind` 时以 `INVALID_ARGUMENT` 失败（装配期就拒，不跑到一半才发现）
   */
  start(): WorkflowRunView {
    if (this.run.status !== 'idle' && this.run.status !== 'done') {
      throw new AppError(
        'WORKFLOW_INVALID_STATE',
        `已有 run 处于 ${this.run.status} 态，先处理完它`,
        'workflow.runner',
        { status: this.run.status },
      );
    }
    this.requireExecutable(this.plan);
    this.applyRetention();
    this.claimedPositions.clear();
    this.confirmedPositions.clear();
    this.controller = new AbortController();
    this.run = createRun(
      randomUUID(),
      Date.now(),
      this.plan.nodes.map((node) => node.id),
    );
    this.store.openRun(this.run.runId, this.plan, this.run.startedAt);
    const started = this.apply({ type: 'start' }, null, `计划 ${this.plan.id} 开跑`);
    void this.pump();
    return started;
  }

  /**
   * 请求暂停：把当前步退回 `pending` 并发出取消信号，**等它自己让出**（spec 2.4-07）。
   * @param message 暂停原因（spec 1.8-07 的会话失效走这里带原因）；null = 用户点了暂停按钮，无需播报
   * @returns 进入 `paused` 的状态
   * @throws 不在运行中时结构化失败
   */
  pause(message: string | null = null): WorkflowRunView {
    return this.stop(null, message);
  }

  /**
   * 从当前步续跑**本次内存里的这次 run**（不重置已完成步，spec 1.10-05）。
   *
   * 与 `resumeRun(runId)` 不是一回事：这里续的是「刚刚按了暂停的那一次」，库里根本没有中断需要读回；
   * 后者续的是「上一次进程死亡留下的 run」，要先读库再校验指纹。混淆这两者是 plan §11.3 第 3 条点名的坑。
   * @returns 重新进入 `running` 的状态
   * @throws 不在暂停中时结构化失败
   */
  resume(): WorkflowRunView {
    const resumed = this.apply({ type: 'resume' }, null, '从当前步续跑');
    // 旧句柄已经 abort 过，复用它会让新的一步刚起步就被判成「已让出」。
    this.controller = new AbortController();
    void this.pump();
    return resumed;
  }

  /**
   * 单独重试某一个节点（spec 1.10-06 / 2.4-03）。
   *
   * 两种「停住」都要能从这里出去，否则用户在界面上只剩重新开跑一条路：
   * 失败态走 `retry-step`；挂着接管标记的暂停态走 `resume`，并且当接管原因是「外发未观察完成」时
   * 顺便登记一次确认，让幂等闸门放行这一回（见 `confirmedPositions`）。
   * @param stepIdRaw 步骤 id，来自渲染层——按当前计划的节点 id 校验，不认就结构化失败
   * @returns 重新进入 `running`、`stepIndex` 指回该步的状态
   * @throws 步 id 不属于当前计划，或这一步既没失败也没挂接管点时 `WORKFLOW_INVALID_STATE`
   */
  retryStep(stepIdRaw: string): WorkflowRunView {
    const spec = this.plan.nodes.find((node) => node.id === stepIdRaw);
    if (!spec) {
      throw new AppError('WORKFLOW_INVALID_STATE', `当前计划里没有步骤 ${stepIdRaw}`, 'workflow.runner', {
        stepId: stepIdRaw,
        planId: this.plan.id,
      });
    }
    const refusal = this.run.requiresHuman;
    if (this.run.status === 'paused' && refusal?.stepId === spec.id) {
      // 接管点上的这一次点击就是「我知道了，继续」：登录态一类的暂停直接续跑即可，
      // 而「外发未观察完成」必须留下一次确认，闸门据此把「拒绝」换成「一次带日志的重放」
      // （plan §11.3 第 5 条）。
      if (refusal.reason === 'unobserved-side-effect') {
        this.confirmedPositions.add(this.positionKey(this.run.runId, this.run.stepIndex));
      }
      const confirmed = this.apply({ type: 'resume' }, null, `从接管点继续 ${spec.id}`);
      this.controller = new AbortController();
      void this.pump();
      return confirmed;
    }
    const retried = this.apply({ type: 'retry-step', stepId: spec.id }, null, `重试 ${spec.id}`);
    this.controller = new AbortController();
    void this.pump();
    return retried;
  }

  /**
   * 从库里续上**上一次进程留下的** run（spec 2.4-05）。
   *
   * 校验顺序是刻意的：先读库（读库自身会比对指纹，计划被改过就直接拒绝），再把落库读数重建成镜像，
   * 最后才走 `resume()` 推进。中间任何一步失败都不动内存态，于是「续不上」的表现是原样停住而不是跑一半。
   * @param runIdRaw 要续的那次 run；省略时按当前计划的指纹取**最近一次**未完成的（界面不需要记住 id）。
   *                   给了 id 就按不可信输入处理，库里没有就拒绝
   * @returns 重新进入 `running`（或停在接管点上的 `paused`）的状态
   * @throws 库里没有可续的 run、或计划指纹与当前配置不是同一条时 `INVALID_ARGUMENT`（2.4-05 的串档判据）
   */
  resumeRun(runIdRaw?: string): WorkflowRunView {
    const candidate = runIdRaw === undefined ? this.store.resumeCandidate(this.plan.fingerprint) : null;
    const runId = runIdRaw ?? candidate?.runId;
    if (!runId) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `库里没有按当前计划（${this.plan.fingerprint}）可续的 run`,
        'workflow.runner',
        { planId: this.plan.id },
      );
    }
    const stored = this.store.state(runId);
    if (!stored) {
      throw new AppError('INVALID_ARGUMENT', `库里没有这次 run：${runId}`, 'workflow.runner', { runId });
    }
    if (stored.planFingerprint !== this.plan.fingerprint) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `这次 run 的计划与当前配置的不是同一条（库里 ${stored.planFingerprint}，当前 ${this.plan.fingerprint}），拒绝按原进度续跑`,
        'workflow.runner',
        { runId, stored: stored.planFingerprint, current: this.plan.fingerprint },
      );
    }
    if (stored.status === 'done') {
      this.run = toMirror(stored);
      this.pushProgress(null, null, '这次 run 已经跑完，无需续跑');
      return this.run;
    }
    this.claimedPositions.clear();
    this.confirmedPositions.clear();
    this.run = toMirror(stored);
    // 中断/失败/暂停的 run 都从 `paused` 起步走同一条续跑口：接管标记在这里清掉，
    // 因为用户点「从失败节点续跑」本身就是「我知道发生了什么，继续」。
    this.run = { ...this.run, status: 'paused', requiresHuman: null };
    return this.resume();
  }

  [Service.init](): void {
    // 卸载时必须让出在跑的循环，否则 `plugins.stop('workflow')` 之后定时器链还在推进一个没人看的 run。
    this.ctx.effect(() => () => this.controller?.abort());
    // 会话失效是 `sessions` 探测出来的，runner 只在运行中接它：不在运行中就没有可停的地方。
    const offSessionExpired = this.ctx.on('session/expired', (event) => this.handleSessionExpired(event));
    this.ctx.effect(() => offSessionExpired, 'workflow.session-expired');

    // 开机第一件事是把上次进程死亡留下的孤儿 run 判成中断（plan §11.3 第 6 条）：
    // 晚一步，界面上第一次读数就会显示「仍在运行」，而那个「运行中」属于一个已经不存在的进程。
    const interrupted = this.store.markInterrupted(Date.now());
    // 改配置会重建实例：不推这一句的话界面上会继续挂着上一个已被销毁的 run（实测过）。
    this.pushProgress(null, null, null);
    this.ctx.logger.info(
      `工作流执行器就绪：计划 ${this.plan.id}（${String(this.plan.nodes.length)} 个节点，指纹 ${this.plan.fingerprint}）` +
        (interrupted.length > 0 ? `，本次启动把 ${String(interrupted.length)} 次旧 run 判为中断` : ''),
    );
  }

  /** `workflow.store` 句柄。 */
  private get store(): WorkflowRunStoreService {
    return asApp(this.ctx)['workflow.store'];
  }

  /** `workflow.executors` 登记处。 */
  private get registry(): WorkflowExecutorRegistryService {
    return asApp(this.ctx)['workflow.executors'];
  }

  /** userData 目录（与库文件同根，证据因此和 run 行在一起）。 */
  private get userDataDir(): string {
    return asApp(this.ctx).config.paths().userDataDir;
  }

  /**
   * 停在可恢复点并写出接管点（`pause` 与人工接管共用的那条路）。
   * @param takeover 接管点数据；null = 普通暂停（用户自己按了暂停）
   * @param message 日志与进度行用的一句话说明
   * @returns 进入 `paused` 的状态
   */
  private stop(takeover: WorkflowTakeoverView | null, message: string | null): WorkflowRunView {
    const paused = this.apply({ type: 'pause', takeover }, null, message);
    this.controller?.abort();
    return paused;
  }

  /**
   * 登录态失效时停在可恢复点并**留下结构化接管点**（spec 1.8-07 / 2.1-08）：
   * 不能让它继续往外发一个必然失败的请求，也不能静默停在半路——用户必须看见「卡在哪一步、为什么」。
   *
   * 只把「平台 / 原因 / 停在第几步」作为数据推过去，句子由渲染层按当前语言组（AGENTS.md §5.5 / §5.7）。
   * @param event `sessions` 推的失效事件（只有平台名与判定原因，无 cookie）
   */
  private handleSessionExpired(event: SessionExpiredEvent): void {
    if (this.run.status !== 'running') return;
    const currentStep = this.run.steps[this.run.stepIndex];
    if (!currentStep) return;
    this.ctx.logger.warn(`${event.platform} 登录态失效（${event.reason}），已停在 ${currentStep.id}，等待用户接管`);
    // 播报位留 null：这一句由渲染层按 `requiresHuman` 组织（2.1-08 定下的口径），主进程不参与组句。
    this.stop({ subject: event.platform, reason: event.reason, stepId: currentStep.id, at: event.at }, null);
  }

  /**
   * 把当前 run 推给渲染层（spec 2.4-02 的 `node.started/finished/failed` 就落在这条频道上）。
   * @param stepId 本条播报涉及的节点；run 级迁移时为 null
   * @param phase 节点迁移相位；run 级迁移时为 null
   * @param message 一句话说明（界面自己按 `phase` 组织文案，这条只用于日志与旧面板）
   */
  private pushProgress(stepId: WorkflowStepId | null, phase: WorkflowNodePhase | null, message: string | null): void {
    this.ctx.emit('workflow/progress', { run: this.run, stepId, phase, message });
  }

  /**
   * 跑一次迁移并推送进度。
   * @param event 迁移事件
   * @param phase 本条播报的相位（纯状态迁移为 null）
   * @param message 一句话说明（null 表示不播报）
   * @returns 迁移后的状态
   * @throws 非法迁移以 `WORKFLOW_INVALID_STATE` 失败，不抛裸异常（spec 1.10-09）
   */
  private apply(event: RunnerEvent, phase: WorkflowNodePhase | null, message: string | null): WorkflowRunView {
    const run = this.run;
    const result = transition(run, event);
    if (!result.ok) {
      throw new AppError('WORKFLOW_INVALID_STATE', result.reason, 'workflow.runner', {
        status: run.status,
        event: event.type,
      });
    }
    this.run = result.run;
    const stepId = 'stepId' in event ? event.stepId : null;
    this.pushProgress(stepId, phase, message);
    return this.run;
  }

  /**
   * 推进循环的守护壳：把任何意外收成一次**可见的**失败。
   *
   * 调用点是 `void this.pump()`（界面不该等工作流跑完才返回），所以异常裸抛只会变成一个无人认领的
   * rejection——那时库里的 run 还写着 `running`、界面还挂着进度条，而推进早就停了。
   * 这正是本项目点名要修的「骗人的读数」，因此宁可多这一步收口。
   */
  private async pump(): Promise<void> {
    try {
      await this.advance();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ctx.logger.error(`工作流推进中断：${message}`);
      if (this.run.status !== 'running') return;
      this.store.updateRun(this.run.runId, {
        status: 'failed',
        nodeIndex: this.run.stepIndex,
        finishedAt: null,
        lastError: message,
      });
      this.apply({ type: 'run-failed', error: message, at: Date.now() }, 'failed', `推进中断：${message}`);
    }
  }

  /**
   * 推进循环：按计划的节点顺序依次跑完，直到 run 不再是 `running`。
   *
   * 每一步都重新读 `this.run`，因为暂停/重试可能在两次推进之间改走状态；
   * `await` 之后必须先确认「这次让出是谁引起的」，否则会把 paused 覆盖成 done。
   */
  private async advance(): Promise<void> {
    for (;;) {
      const run = this.run;
      if (run.status !== 'running') return;
      const index = run.stepIndex;
      const step = run.steps[index];
      const spec = this.plan.nodes[index];
      if (!step || !spec) return;

      const claim = this.enterNode(run.runId, index, spec);
      if (claim === 'already-done') {
        // 这个位置在库里已经有了结局：一次都不许调执行器（spec 2.4-05/06 的「不重放」）。
        this.apply({ type: 'step-skipped', stepId: spec.id, at: Date.now() }, null, `${spec.id} 已完成，跳过`);
        continue;
      }
      if (claim === 'needs-human') {
        this.stop(
          { subject: spec.kind, reason: 'unobserved-side-effect', stepId: spec.id, at: Date.now() },
          `${spec.id} 上次外发未观察到完成，拒绝自动重放`,
        );
        return;
      }

      const executor = this.registry.resolve(spec.kind);
      if (!executor) {
        // `start()` 已经整条计划校验过一次，走到这里只能是登记处在跑动中被卸载了。
        await this.failNode(
          run.runId,
          index,
          spec,
          1,
          new AppError('INVALID_ARGUMENT', `执行器 ${spec.kind} 已不在登记处`, 'workflow.runner', {
            kind: spec.kind,
          }),
          null,
        );
        return;
      }
      const settled = await this.runNode(run.runId, index, spec, executor);
      if (!settled) return;
    }
  }

  /**
   * 声明「这个节点现在开始」，并按需把库里的行推进一次。
   * @param runId 本次 run
   * @param index 节点下标
   * @param spec 节点声明
   * @returns `granted` / `already-done` / `needs-human`
   */
  private enterNode(runId: string, index: number, spec: WorkflowNodeSpec): 'granted' | 'already-done' | 'needs-human' {
    const key = this.positionKey(runId, index);
    if (this.confirmedPositions.delete(key)) {
      // 一次确认只放行一次：闸门仍然要写这笔重放（并留下日志），否则「拒绝盲重放」就成了空话。
      return this.store.claimNode(runId, index, spec, Date.now(), true);
    }
    if (this.claimedPositions.has(key)) {
      // 同进程内的重试：幂等闸门已经在第一次声明时开过了，这里只把尝试次数推进一格。
      const state = this.store.state(runId);
      const attempts = (state?.nodes[index]?.attempts ?? 1) + 1;
      this.store.recordNode(runId, index, {
        status: 'running',
        attempts,
        startedAt: state?.nodes[index]?.startedAt ?? Date.now(),
        finishedAt: null,
        durationMs: null,
        error: null,
        evidenceRef: null,
        sideEffect: state?.nodes[index]?.sideEffect ?? (spec.effect === 'read' ? null : 'started'),
      });
      return 'granted';
    }
    const claim = this.store.claimNode(runId, index, spec, Date.now());
    if (claim === 'granted') this.claimedPositions.add(key);
    return claim;
  }

  /**
   * 跑一个节点的全部尝试（含退避重试）。
   * @param runId 本次 run
   * @param index 节点下标
   * @param spec 节点声明
   * @param executor 登记处取到的执行函数
   * @returns true 表示这个位置已经有了结局（成功或被判失败），循环该往下走；
   *          false 表示被暂停/接管打断，循环必须就地停下
   */
  private async runNode(
    runId: string,
    index: number,
    spec: WorkflowNodeSpec,
    executor: WorkflowNodeExecutor,
  ): Promise<boolean> {
    const maxAttempts = 1 + (spec.retryTimes ?? this.config.retryTimes);
    // 库里那一列记的是**跨进程**的总尝试次数（2.4-03/10 的读数），循环计数是本进程这一次尝试序列：
    // 被 kill 过一次之后库里已经有 1 次，本进程的第 1 次其实是这个位置的第 2 次。
    const alreadyAttempted = this.store.state(runId)?.nodes[index]?.attempts ?? 1;
    const startedAt = Date.now();
    for (let attempt = 1; ; attempt += 1) {
      const totalAttempts = alreadyAttempted - 1 + attempt;
      const controller = this.controller;
      this.apply(
        { type: 'step-started', stepId: spec.id, at: attempt === 1 ? startedAt : Date.now() },
        'started',
        attempt === 1 ? `开始 ${spec.id}` : `第 ${String(totalAttempts)} 次尝试 ${spec.id}`,
      );
      try {
        await executor({
          runId,
          spec,
          attempt: totalAttempts,
          signal: controller?.signal ?? new AbortController().signal,
        });
      } catch (error) {
        // 让出是暂停/卸载引起的：不是节点的失败，状态已经由引起它的那一方写好了，原样停下。
        if (controller?.signal.aborted || this.run.status !== 'running') return false;
        if (spec.requiresHuman) {
          this.stop(
            { subject: spec.kind, reason: 'manual-takeover', stepId: spec.id, at: Date.now() },
            `${spec.id} 是人工接管点，停下等用户`,
          );
          return false;
        }
        if (attempt < maxAttempts) {
          const wait = this.backoffMs(attempt);
          this.pushProgress(
            spec.id,
            'retrying',
            `${spec.id} 第 ${String(totalAttempts)} 次失败，${String(wait)}ms 后重试`,
          );
          // 退避睡在同一个取消信号上：暂停因此能立刻打断等待，而不是等满退避再让出（spec 2.4-09）。
          await sleep(wait, this.controller?.signal);
          if (this.controller?.signal.aborted || this.run.status !== 'running') return false;
          continue;
        }
        await this.failNode(runId, index, spec, totalAttempts, error, startedAt);
        return true;
      }
      // 正常返回也要先确认这次让出是谁引起的：协作式取消里「收到 abort 就 resolve 收手」是合法写法
      // （`sleep(ms, signal)` 就是这么设计的），此时这一步并没有做完。
      // 把它记成成功会连着两个坏结果——库里留下一行假 `done`（续跑因此永远不重放它），
      // 而 `apply(step-finished)` 在 paused 态是非法迁移，会把异常抛进这条无人 await 的循环。
      if (controller?.signal.aborted || this.run.status !== 'running') return false;
      this.succeedNode(runId, index, spec, totalAttempts, startedAt);
      return true;
    }
  }

  /**
   * 写成功结局：落库 + 状态机推进一格。
   * @param runId 本次 run
   * @param index 节点下标
   * @param spec 节点声明
   * @param attempts 这个位置总共用掉的尝试次数（含首次、含其它进程用掉的）
   * @param startedAt 本节点首次开始的时间戳（毫秒）
   */
  private succeedNode(runId: string, index: number, spec: WorkflowNodeSpec, attempts: number, startedAt: number): void {
    const at = Date.now();
    this.store.recordNode(runId, index, {
      status: 'done',
      attempts,
      startedAt,
      finishedAt: at,
      durationMs: at - startedAt,
      error: null,
      evidenceRef: null,
      // 只有真的会动外面世界的节点才需要把副作用位收成 done（spec 2.4-06 的判据）。
      sideEffect: spec.effect === 'read' ? null : 'done',
    });
    this.store.updateRun(runId, {
      status: this.plan.nodes.length === index + 1 ? 'done' : 'running',
      nodeIndex: index + 1,
      finishedAt: this.plan.nodes.length === index + 1 ? at : null,
      lastError: null,
    });
    this.apply({ type: 'step-finished', stepId: spec.id, at }, 'finished', `${spec.id} 完成`);
  }

  /**
   * 写失败结局：证据落盘 → 落库 → 状态机判失败。
   * @param runId 本次 run
   * @param index 节点下标
   * @param spec 节点声明
   * @param attempt 判失败时这个位置总共用掉的次数（含其它进程用掉的）
   * @param error 最后一次抛出的错误
   * @param startedAt 本节点首次开始的时间戳（毫秒）；单点失败注入时可为 null
   */
  private async failNode(
    runId: string,
    index: number,
    spec: WorkflowNodeSpec,
    attempt: number,
    error: unknown,
    startedAt: number | null,
  ): Promise<void> {
    const at = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    const evidenceRef = await this.writeEvidence(runId, index, spec, attempt, at, error);
    this.store.recordNode(runId, index, {
      status: 'failed',
      attempts: attempt,
      startedAt: startedAt ?? at,
      finishedAt: at,
      durationMs: startedAt === null ? null : at - startedAt,
      error: message,
      evidenceRef,
      // 失败的外发**保持 started**：这正是「重启后不许自动重放」要读到的那个位（spec 2.4-06）。
      sideEffect: spec.effect === 'read' ? null : 'started',
    });
    this.store.updateRun(runId, { status: 'failed', nodeIndex: index, finishedAt: null, lastError: message });
    this.apply({ type: 'step-failed', stepId: spec.id, at, error: message }, 'failed', `${spec.id} 失败`);
  }

  /**
   * 第 `attempt` 次失败之后的退避时长。
   * @param attempt 刚刚失败的那一次（从 1 起）
   * @returns 毫秒数：`retryBackoffMs × 2^(attempt-1)`，封顶 `retryBackoffCapMs`（spec 2.4-03，plan §11.4）
   */
  private backoffMs(attempt: number): number {
    return Math.min(this.config.retryBackoffMs * 2 ** (attempt - 1), this.config.retryBackoffCapMs);
  }

  /**
   * 失败证据落盘（spec 2.4-04）。
   *
   * 写在 run 行旁边（userData 下的 `evidenceDir`）而不是写进库里一个 BLOB：截图是给人翻文件看的，
   * 而库里只留**相对路径**（`workflow_nodes.evidence_ref`），于是「库能被拷走看」这件事没坏。
   * @param runId 本次 run
   * @param index 节点下标（只用于日志）
   * @param spec 节点声明
   * @param attempt 判失败时的尝试次数
   * @param at 判定时间戳（毫秒）
   * @param error 最后一次错误
   * @returns userData 下的**相对路径**（如 `evidence/<runId>-<nodeId>.json`）；磁盘写不下时 null 并记一笔 warn
   */
  private async writeEvidence(
    runId: string,
    index: number,
    spec: WorkflowNodeSpec,
    attempt: number,
    at: number,
    error: unknown,
  ): Promise<string | null> {
    const code = error instanceof AppError ? error.code : error instanceof Error ? error.name : 'UNKNOWN';
    const details = error instanceof AppError ? error.details : undefined;
    const evidence: NodeEvidence = {
      runId,
      nodeId: spec.id,
      kind: spec.kind,
      effect: spec.effect,
      target: spec.target,
      attempt,
      at,
      error: { code, message: this.cap(error instanceof Error ? error.message : String(error)), details },
      page: await this.readPage(),
    };
    const relative = join(this.config.evidenceDir, `${runId}-${spec.id}.json`);
    try {
      const dir = join(this.userDataDir, this.config.evidenceDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(this.userDataDir, relative), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
      return relative.split(/[\\/]/).join('/');
    } catch (error_) {
      // 证据丢了不能把整条 run 判成别的结局：落库的失败读数比一份附件重要。
      this.ctx.logger.warn(
        `第 ${String(index)} 个节点的证据写盘失败：${error_ instanceof Error ? error_.message : String(error_)}`,
      );
      return null;
    }
  }

  /**
   * 取一帧失败现场的页面读数。
   *
   * 页面通道是**可选**依赖（`browser.page` 没装时节点照样要判失败），所以走 `maybeService` 而不是 inject；
   * 取不到就记 null，绝不因为「没页面」而把证据整体丢掉（spec 2.4-04 要求的是错误 payload + 现场读数）。
   * @returns URL / 标题 / 正文节选；无内核会话或求值失败时为 null
   */
  private async readPage(): Promise<NodeEvidence['page']> {
    const page = maybeService<PageSnapshotReader>(this.ctx, 'browser.page');
    if (!page) return null;
    try {
      const snapshot = await page.snapshot(this.config.evidenceDomChars);
      return {
        url: snapshot.url,
        title: this.cap(snapshot.title),
        bodyText: this.cap(snapshot.bodyText),
      };
    } catch (error) {
      // 没登录态就没有页面，这不是缺陷：证据仍然要有错误 payload，页面位记 null。
      this.ctx.logger.debug(`证据未取得页面读数：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * 按配置的字段上限截断文本。
   * @param text 原始文本
   * @returns 不超过 `evidenceTextChars` 的文本；被截断时尾部带标记（不谎称是全文）
   */
  private cap(text: string): string {
    const limit = this.config.evidenceTextChars;
    return text.length <= limit ? text : `${text.slice(0, limit)}…（已截断）`;
  }

  /**
   * 清掉超出保留数的旧 run，并连带删掉它们的证据文件（spec 2.4-10 的保留侧）。
   *
   * 「谁产生谁管生命周期」：证据路径是 runner 写进库的，所以只有 runner 知道该删哪些文件；
   * `workflow.store.prune()` 只报账被删的 run id。
   */
  private applyRetention(): void {
    const dropped = this.store.prune(this.config.retentionRuns);
    if (dropped.length === 0) return;
    const dir = join(this.userDataDir, this.config.evidenceDir);
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const runId of dropped) {
      for (const name of entries.filter((item) => item.startsWith(`${runId}-`))) {
        rmSync(join(dir, name), { force: true });
      }
    }
    this.ctx.logger.info(
      `按保留上限 ${String(this.config.retentionRuns)} 次清掉了 ${String(dropped.length)} 次旧 run 与其证据`,
    );
  }

  /**
   * 装配期校验：计划里的每个 `kind` 都必须在登记处有实现，节点数不得超过上限。
   * @param plan 待校验的计划
   * @throws 超上限或 `kind` 无人登记时 `INVALID_ARGUMENT`，且一次报全所有问题
   */
  private requireExecutable(plan: WorkflowPlanView): void {
    const problems: string[] = [];
    if (plan.nodes.length > this.config.maxNodesPerRun) {
      problems.push(
        `计划有 ${String(plan.nodes.length)} 个节点，超过单次 run 上限 ${String(this.config.maxNodesPerRun)}`,
      );
    }
    const known = new Set(this.registry.list());
    for (const spec of plan.nodes) {
      if (!known.has(spec.kind)) problems.push(`节点 ${spec.id} 的执行器 ${spec.kind} 没有登记`);
    }
    if (problems.length > 0) {
      throw new AppError('INVALID_ARGUMENT', `这条计划现在跑不了：${problems.join('；')}`, 'workflow.runner', {
        planId: plan.id,
        problems,
        registered: [...known],
      });
    }
  }

  /** 节点位置的键（同进程重试判定用）。 */
  private positionKey(runId: string, index: number): string {
    return `${runId}#${String(index)}`;
  }
}

/**
 * 把库里的 run 读数重建成界面镜像（spec 2.4-05）。
 *
 * 只有 `steps` 需要重建：镜像的职责是「画槽位 + 显示状态」，而库里那份才是真相。
 * @param stored 库里的完整读数
 * @returns 与同一次 run 被跑过时一模一样的镜像（`interrupted` 映射成 `paused`，界面不需要新增态）
 */
function toMirror(stored: WorkflowRunStateView): WorkflowRunView {
  const steps: WorkflowStepView[] = stored.nodes.map((node) => ({
    id: node.nodeId,
    // 库里的 `skipped` 在界面上与 `done` 同形（都是「这个位置不用再跑」）；
    // 崩溃时正在跑的那个节点没有结局，退回 `pending` 等重放（spec 1.10-05 的暂停同口径）。
    status:
      node.status === 'done' || node.status === 'skipped' ? 'done' : node.status === 'failed' ? 'failed' : 'pending',
    startedAt: node.startedAt,
    finishedAt: node.finishedAt,
    durationMs: node.durationMs,
    error: node.error,
  }));
  return {
    runId: stored.runId,
    status: stored.status === 'interrupted' ? 'paused' : stored.status,
    stepIndex: Math.min(stored.nodeIndex, steps.length),
    steps,
    startedAt: stored.startedAt,
    requiresHuman: null,
  };
}

declare module '@auto-cc/core' {
  interface AppServices {
    'workflow.runner': WorkflowRunnerService;
  }
}
