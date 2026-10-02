/**
 * `agent.loop`：一次任务的「规划 → 执行 → 观察 → 续推」循环（spec 5.2-01 / 02 / 05 / 08 / 11）。
 *
 * 四条硬规矩长在结构里，不是长在注释里：
 * 1. **每一步都问 `agent.policy`**（5.2-02）：循环里只有「判闸门 → 调工具」这一条顺序，
 *    没有旁路——`registry.call` 只在 `decide()` 放行之后出现，读这段代码时一眼能对上。
 * 2. **模型没有裁量口**（5.2-07，判定在 5.2-b 演）：`LoopModel` 只有起草与摘要两条口，
 *    步骤的副作用分级是循环现读注册表贴上去的，模型自述一概不进判定。
 * 3. **一次 run 一份作用域**（5.2-08）：游标、token 账、取消句柄都长在 `RunScope` 上并按 runId 存，
 *    服务字段里不放「上一次的进度」；改配置重建插件后作用域表会空，`ensureScope` 因此能从库里把它重建回来
 *    （AGENTS.md §9 的 2.5 实测：热改配置会重建下游插件，本地存第二份事实必然静默变空）。
 * 4. **步数与 token 双上限**（5.2-11）：两条都在动下一步之前判，撞到就把 run 落成 `failed`
 *    并写明 `stopReason`，不无限自转。上限是**这条 run 的**（起草时从配置定下并落进
 *    `agent_run` 的两列），不是服务的当前配置——否则改一次配置就会回改正在跑的旧任务的额度，
 *    而那两列也就成了摆设。
 *
 * 叫停（5.2-10）取「安全点」语义：正在跑的那一步**不硬切**——所以不把 abort 信号递给注册表，
 * 半途掐断一次打招呼比让它跑完更糟；信号只在下一步开始之前生效。
 */
import {
  AGENT_RUN_STATUSES,
  AppError,
  Service,
  asApp,
  type AgentPlanStepView,
  type AgentRunStatus,
  type AgentRunView,
  type AgentStepView,
  type AutonomyLevel,
  type Context,
} from '@auto-cc/core';
import type { StoreService } from '@auto-cc/plugin-store';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { MAX_USER_INPUT_CHARS } from '../session.js';
import type { ChatSessionService } from '../session.js';
import type { AgentToolsService } from '../tools.js';
import { StubLoopModel, type LoopModel, type ModelContext } from './model.js';
import type { AgentPolicyService } from './policy.js';

/** 迁移号段 16（plan §7.2 的 5.2-a 落点）：`agent_run` + `agent_step` 同一次迁移建出。 */
export const AGENT_RUN_MIGRATION_VERSION = 16;

/** 一条观察摘要里最多留多少个字（5.2-06 的「只带摘要」：整段工具正文不进 prompt）。 */
const OBSERVATION_TEXT_CAP = 80;

/** 单条输入文本的边界校验：与 `chat.session` 共用同一个上限常量（§2.2 同一逻辑只留一份）。 */
const MAX_GOAL_CHARS = MAX_USER_INPUT_CHARS;

/** 循环配置：两条上限是 5.2-11 的判据对象，上下文长度上限是 5.2-06 的判据对象。 */
export const agentLoopSchema = z.strictObject({
  /** 单次 run 最多执行多少步（无解任务靠它兜底，默认 12）。 */
  stepLimit: z.number().int().min(1).max(50).default(12),
  /** 单次 run 的 token 预算（桩按 2 字≈1 token 粗估，见 `estimateTokens`）。 */
  tokenBudget: z.number().int().min(50).max(200000).default(4000),
  /** 递给模型的上下文字数上限（5.2-06：有界摘要，不含整页 HTML）。 */
  contextCharsCap: z.number().int().min(100).max(8000).default(1200),
});

/** 校验后的循环配置。 */
export type AgentLoopConfig = z.output<typeof agentLoopSchema>;

/**
 * 一次 run 的作用域：进度只活在这一份对象里，按 runId 存放。
 *
 * `planConfirmed` 与 `controller` 都在这里而不是服务字段上：跨 run 的隐式延续正是
 * plan §1.1 取证结论里 Cordis「state is preserved across calls」那条坑的形态（5.2-08 判的就是它）。
 */
type RunScope = {
  runId: string;
  cursor: number;
  plan: AgentPlanStepView[];
  tokensUsed: number;
  /** 这条 run 的步上限（起草时从配置定下并落进 `agent_run.step_limit`，之后改配置不回改旧 run）。 */
  stepLimit: number;
  /** 这条 run 的 token 预算（同上，落在 `agent_run.token_budget`）。 */
  tokenBudget: number;
  planConfirmed: boolean;
  controller: AbortController;
};

/** `agent_run` 的一行原始读数。 */
type RunRow = {
  id: string;
  session_id: string;
  goal: string;
  status: string;
  autonomy: string;
  plan_step_index: number | bigint;
  plan_json: string;
  step_limit: number | bigint;
  token_budget: number | bigint;
  tokens_used: number | bigint;
  stop_reason: string | null;
  created_at: number | bigint;
  updated_at: number | bigint;
};

/** `agent_step` 的一行原始读数。 */
type StepRow = {
  run_id: string;
  plan_step_index: number | bigint;
  tool_id: string;
  status: string;
  snapshot_refs_json: string;
  observation: string;
  evidence_refs_json: string;
  duration_ms: number | bigint | null;
  code: string | null;
};

/** 两张表的建表迁移；`up` 只写 DDL（与 `chat_message` 同一口径）。 */
const agentRunMigration = {
  version: AGENT_RUN_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_run (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      autonomy TEXT NOT NULL,
      plan_step_index INTEGER NOT NULL,
      plan_json TEXT NOT NULL,
      step_limit INTEGER NOT NULL,
      token_budget INTEGER NOT NULL,
      tokens_used INTEGER NOT NULL,
      stop_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    // 主键取 (run_id, plan_step_index)：同一步重跑是覆盖而不是补一行，读进度因此不需要「取最新那条」。
    db.exec(`CREATE TABLE IF NOT EXISTS agent_step (
      run_id TEXT NOT NULL,
      plan_step_index INTEGER NOT NULL,
      tool_id TEXT NOT NULL,
      status TEXT NOT NULL,
      snapshot_refs_json TEXT NOT NULL,
      observation TEXT NOT NULL,
      evidence_refs_json TEXT NOT NULL,
      duration_ms INTEGER,
      code TEXT,
      PRIMARY KEY (run_id, plan_step_index)
    )`);
  },
};

/**
 * 把观察文本收到定长（超了就截，不留整段工具正文）。
 * @param reading 工具读数或失败原话
 * @returns 不超过 `OBSERVATION_TEXT_CAP` 字的文本
 */
function clipReading(reading: string): string {
  return reading.length > OBSERVATION_TEXT_CAP ? `${reading.slice(0, OBSERVATION_TEXT_CAP)}…` : reading;
}

/**
 * 把一行 run 与它的步行拼成界面读数。
 * @param run 运行行
 * @param steps 步行（按 plan_step_index 升序）
 * @returns 跨进程可用的 `AgentRunView`
 */
function toRunView(run: RunRow, steps: StepRow[]): AgentRunView {
  return {
    runId: run.id,
    sessionId: run.session_id,
    goal: run.goal,
    status: run.status as AgentRunStatus,
    autonomy: run.autonomy as AutonomyLevel,
    planStepIndex: Number(run.plan_step_index),
    plan: JSON.parse(run.plan_json) as AgentPlanStepView[],
    steps: steps.map((step) => ({
      runId: step.run_id,
      planStepIndex: Number(step.plan_step_index),
      toolId: step.tool_id,
      status: step.status as AgentStepView['status'],
      snapshotRefs: JSON.parse(step.snapshot_refs_json) as string[],
      observation: step.observation,
      evidenceRefs: JSON.parse(step.evidence_refs_json) as string[],
      durationMs: step.duration_ms === null ? null : Number(step.duration_ms),
      code: step.code,
    })),
    stepLimit: Number(run.step_limit),
    tokenBudget: Number(run.token_budget),
    tokensUsed: Number(run.tokens_used),
    stopReason: run.stop_reason,
    createdAt: Number(run.created_at),
    updatedAt: Number(run.updated_at),
  };
}

export class AgentLoopService extends Service {
  static provide = 'agent.loop';
  static Config = agentLoopSchema;
  static inject = ['store', 'agent.tools', 'agent.policy', 'chat.session'];

  constructor(
    ctx: Context,
    private readonly config: AgentLoopConfig,
  ) {
    super(ctx, 'agent.loop');
  }

  /** 按 runId 存的作用域表；终态即摘行，跨 run 看不见彼此（5.2-08）。 */
  private readonly scopes = new Map<string, RunScope>();

  /**
   * 模型端口。
   *
   * 5.2 只有确定性桩一种实现（真模型要花钱且须用户单独授权，本片不接），所以直接 new 在这里；
   * 等接真模型时改的是这一行与 `model.ts` 的实现，循环与判定一行都不动。
   */
  private readonly model: LoopModel = new StubLoopModel();

  private get store(): StoreService {
    return asApp(this.ctx).store;
  }

  private get registry(): AgentToolsService {
    return asApp(this.ctx)['agent.tools'];
  }

  private get policy(): AgentPolicyService {
    return asApp(this.ctx)['agent.policy'];
  }

  private get session(): ChatSessionService {
    return asApp(this.ctx)['chat.session'];
  }

  /**
   * 起草一份计划并落一条 `proposed` 的 run（spec 5.2-03 的代码半边）。
   * @param goalRaw 用户原文（按系统边界校验：去空、限长）
   * @returns 尚未执行任何动作的 run 读数，`status` 为 `proposed`
   * @throws 空输入 `AGENT_LOOP_EMPTY_GOAL`；超长 `AGENT_LOOP_GOAL_TOO_LONG`
   */
  async propose(goalRaw: string): Promise<AgentRunView> {
    const goal = goalRaw.trim();
    if (!goal) throw new AppError('AGENT_LOOP_EMPTY_GOAL', '任务目标为空，不起草计划', 'agent.loop', {});
    if (goal.length > MAX_GOAL_CHARS) {
      throw new AppError('AGENT_LOOP_GOAL_TOO_LONG', `任务目标最长 ${String(MAX_GOAL_CHARS)} 字`, 'agent.loop', {
        length: goal.length,
      });
    }
    // `autonomy` 列存**起草时**的档位（计划卡要说「当时按哪档起的草」）；能不能动手按执行当下的档位现判，
    // 所以这一位是记录，不是授权凭据——判定只读 `agent.policy`，见 `execute` 里的 `decide`。
    const tier = this.session.current().session.autonomy;
    const draft = await this.model.draftPlan({
      goal,
      tier,
      knownToolIds: this.registry.list().map((descriptor) => descriptor.id),
      context: { refs: [], text: '' },
    });
    const runId = randomUUID();
    const at = Date.now();
    const plan: AgentPlanStepView[] = draft.steps.map((step, index) =>
      this.enrich(index, step.toolId, step.input, step.intent),
    );
    this.store.db
      .prepare(
        `INSERT INTO agent_run (id, session_id, goal, status, autonomy, plan_step_index, plan_json,
         step_limit, token_budget, tokens_used, stop_reason, created_at, updated_at)
         VALUES (?, ?, ?, 'proposed', ?, 0, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        runId,
        this.session.current().session.id,
        goal,
        tier,
        JSON.stringify(plan),
        this.config.stepLimit,
        this.config.tokenBudget,
        draft.usage.inputTokens + draft.usage.outputTokens,
        at,
        at,
      );
    this.scopes.set(runId, {
      runId,
      cursor: 0,
      plan,
      tokensUsed: draft.usage.inputTokens + draft.usage.outputTokens,
      stepLimit: this.config.stepLimit,
      tokenBudget: this.config.tokenBudget,
      planConfirmed: false,
      controller: new AbortController(),
    });
    return this.read(runId);
  }

  /**
   * 确认计划并跑完整条循环（5.2-03 的「确认之后才动」）。
   * @param runId 一次 `proposed` 的 run
   * @returns 跑完（或停在安全点）之后的读数
   * @throws 不在待确认态（已确认过、正在跑、或已终态）`AGENT_LOOP_NOT_PROPOSED`
   */
  async confirm(runId: string): Promise<AgentRunView> {
    const scope = this.ensureScope(runId);
    const view = this.read(runId);
    // 并发确认只有一道闸，就是这一位落库的状态：`updateRun('running')` 在下一个 `await` 之前发生，
    // 所以同一 tick 里按第二次必然读到 `running` 而被拒。再存一个「正在跑」的 promise 就是第二份事实（§2.5）。
    if (view.status !== 'proposed') {
      throw new AppError('AGENT_LOOP_NOT_PROPOSED', `run ${runId} 不是待确认态（现在：${view.status}）`, 'agent.loop', {
        status: view.status,
      });
    }
    scope.planConfirmed = true;
    this.updateRun(runId, { status: 'running', planStepIndex: scope.cursor, tokensUsed: scope.tokensUsed });
    await this.execute(scope);
    return this.read(runId);
  }

  /**
   * 叫停一次 run（5.2-10 的入口半边）。
   *
   * 正在跑的那一步不硬切：这里只置信号，循环在**下一个安全点**（取步之前）看见信号就停，
   * 已经发出去的动作照常收尾并落它的观察记录。
   * @param runId 要停的 run
   * @returns 停下之后的读数；已经终态的 run 原样返回读数，不报错
   */
  stop(runId: string): AgentRunView {
    const view = this.read(runId);
    if (view.status === 'running') {
      // 只置信号：正在跑的那一步照常收尾，循环在取下一步之前看见它。
      this.ensureScope(runId).controller.abort();
      return view;
    }
    if (view.status === 'proposed') {
      const scope = this.ensureScope(runId);
      scope.controller.abort();
      this.finish(scope, 'paused', 'USER_STOPPED');
      return this.read(runId);
    }
    return view;
  }

  /**
   * 读一次 run 的整份落库读数（界面与日志的唯一去处）。
   * @param runId 运行 id
   * @returns run + 计划 + 已跑到的步
   * @throws 库里没有这条 run 时 `AGENT_LOOP_RUN_NOT_FOUND`
   */
  read(runId: string): AgentRunView {
    const run = this.store.db.prepare('SELECT * FROM agent_run WHERE id = ?').get(runId) as RunRow | undefined;
    if (!run) throw new AppError('AGENT_LOOP_RUN_NOT_FOUND', `找不到 run ${runId}`, 'agent.loop', { runId });
    const steps = this.store.db
      .prepare('SELECT * FROM agent_step WHERE run_id = ? ORDER BY plan_step_index ASC')
      .all(runId) as unknown as StepRow[];
    return toRunView(run, steps);
  }

  [Service.init](): void {
    // 卸载时把在跑的循环都停在安全点，别留下「服务已经没了、循环还在调注册表」的形态。
    // 必须是「返回一个函数」：cordis 会立刻执行这里的第一层来取回收器（AGENTS.md §9 实测 1.3），
    // 写成单层箭头就成了「刚挂载就 abort 一遍」，而那时一个 scope 都还没有。
    this.ctx.effect(() => () => {
      for (const scope of this.scopes.values()) scope.controller.abort();
      this.scopes.clear();
    });
    this.ensureSchema();
    this.ctx.logger.info(
      `对话循环就绪：步上限 ${String(this.config.stepLimit)} · token 预算 ${String(this.config.tokenBudget)} · 上下文 ${String(this.config.contextCharsCap)} 字 · 模型腿 确定性桩`,
    );
  }

  /** 幂等登记号段 16 并建表（`plugins.start('agent-loop')` 会重跑 init）。 */
  private ensureSchema(): void {
    const migrations = this.store.migrations;
    if (!migrations.some((migration) => migration.version === AGENT_RUN_MIGRATION_VERSION)) {
      migrations.push(agentRunMigration);
    }
    this.store.upgrade();
  }

  /**
   * 循环主体：每轮只做「取当前步 → 判闸门 → 调工具 → 写观察」四件事。
   * @param scope 本次 run 的作用域（游标、token 账、两条上限、取消句柄都在里面）
   */
  private async execute(scope: RunScope): Promise<void> {
    // 空计划不是「做完了」：桩没被点名任何手，一步都没跑却报 `completed` 就是 5.2-13 要防的谎报形态。
    if (scope.plan.length === 0) {
      this.finish(scope, 'failed', 'PLAN_EMPTY');
      return;
    }
    while (scope.cursor < scope.plan.length) {
      if (scope.controller.signal.aborted) {
        this.finish(scope, 'paused', 'USER_STOPPED');
        return;
      }
      if (scope.cursor >= scope.stepLimit) {
        this.finish(scope, 'failed', 'STEP_LIMIT');
        return;
      }
      if (scope.tokensUsed >= scope.tokenBudget) {
        this.finish(scope, 'failed', 'TOKEN_LIMIT');
        return;
      }
      const step = scope.plan[scope.cursor]!;
      // 档位**用的时候现问**而不是存进作用域：档位是人在此刻的授权表态，不是起草时的存档。
      // 存下来会留一个洞——起草之后把档位从 `auto` 降回 `suggest`，确认这条旧计划照样动手。
      // 现问的效果是人随时降档都能在最下一个安全点生效（AGENTS.md §9 的 2.5 实测同一口径）。
      const decision = this.policy.decide({
        tier: this.session.current().session.autonomy,
        planConfirmed: scope.planConfirmed,
        toolId: step.toolId,
      });
      if (!decision.canRun) {
        this.writeStep(scope, step, 'refused', decision.message, [], null, decision.code);
        this.finish(scope, 'failed', 'POLICY_REFUSED');
        return;
      }
      this.writeStep(scope, step, 'pending', '', [], null, null);
      const at = Date.now();
      const reply = await this.registry.call(step.toolId, step.input);
      const durationMs = Date.now() - at;
      const outcome = reply.ok ? 'ok' : 'failed';
      const reading = reply.ok ? reply.result.summary : `${reply.code}：${reply.message}`;
      const evidenceRefs = reply.ok ? [...reply.result.evidenceRefs] : [];
      const context = this.buildContext(scope);
      const summary = await this.model.summarizeObservation({ step, reading: clipReading(reading), outcome, context });
      scope.tokensUsed += summary.usage.inputTokens + summary.usage.outputTokens;
      this.writeStep(scope, step, outcome, summary.text, evidenceRefs, durationMs, reply.ok ? null : reply.code);
      scope.cursor += 1;
    }
    const finished = this.store.db
      .prepare('SELECT status FROM agent_step WHERE run_id = ?')
      .all(scope.runId) as unknown as { status: string }[];
    // 「跑到了」不等于「做成了」：任何一步不是 ok，这条 run 就不能自称 completed（5.2-09 的凭据）。
    const allSucceeded = scope.cursor > 0 && finished.every((row) => row.status === 'ok');
    this.finish(scope, allSucceeded ? 'completed' : 'failed', allSucceeded ? 'COMPLETED' : 'STEP_UNSUCCESSFUL');
  }

  /**
   * 拼递给模型的上下文：只有已落步的**引用 + 摘要**（5.2-06）。
   * @param scope 本次 run 的作用域
   * @returns 引用清单与有界文本；整页 HTML 与工具正文都不在这里出现
   */
  private buildContext(scope: RunScope): ModelContext {
    // 上下文从**落库的步行**取而不是从内存里的计划取：改配置重建服务之后，内存里什么都没有了，
    // 而模型该看到的观察仍然是那几行已写回的观察（§9 的 2.5 实测换来的口径）。
    const rows = this.store.db
      .prepare(
        'SELECT plan_step_index, tool_id, status, observation FROM agent_step WHERE run_id = ? AND plan_step_index < ? ORDER BY plan_step_index ASC',
      )
      .all(scope.runId, scope.cursor) as unknown as {
      plan_step_index: number | bigint;
      tool_id: string;
      status: string;
      observation: string;
    }[];
    const entries = rows.map((row) => ({
      ref: `run:${scope.runId}/step:${String(Number(row.plan_step_index))}`,
      line: `#${String(Number(row.plan_step_index) + 1)} ${row.tool_id} ${row.status} → ${clipReading(row.observation)}`,
    }));
    // 装不下的从**最早**的几条开始丢：离当前越近的越界越要留给模型看。
    const kept: typeof entries = [];
    let total = 0;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (total + entry.line.length > this.config.contextCharsCap) break;
      kept.unshift(entry);
      total += entry.line.length;
    }
    const omitted = entries.length - kept.length;
    return {
      refs: kept.map((entry) => entry.ref),
      text:
        omitted > 0
          ? `（前 ${String(omitted)} 步已略）\n${kept.map((entry) => entry.line).join('\n')}`
          : kept.map((entry) => entry.line).join('\n'),
    };
  }

  /**
   * 把模型草案里的一步补上注册表的真相。
   * @param index 步序号
   * @param toolId 模型点名的手
   * @param input 模型给的入参（不可信，注册表那侧还要过 schema）
   * @param intent 模型给的说明
   * @returns 计划步读数；工具不在开放面上时 `effect` 为 null，由策略直接拒
   */
  private enrich(index: number, toolId: string, input: unknown, intent: string): AgentPlanStepView {
    const descriptor = this.registry.list().find((entry) => entry.id === toolId);
    return {
      planStepIndex: index,
      toolId,
      input,
      intent,
      effect: descriptor?.effect ?? null,
      requiresConfirmation: descriptor?.requiresConfirmation ?? false,
    };
  }

  /**
   * 覆盖一条步行（同一 `(runId, planStepIndex)` 只有一行，见 DDL 主键）。
   * @param scope 本次 run 的作用域
   * @param step 计划里的那一步
   * @param status 落库状态
   * @param observation 观察文本（`pending` 时是空串）
   * @param evidenceRefs 工具交回的证据引用
   * @param durationMs 耗时；未跑完为 null
   * @param code 拒因或失败码；成功为 null
   */
  private writeStep(
    scope: RunScope,
    step: AgentPlanStepView,
    status: AgentStepView['status'],
    observation: string,
    evidenceRefs: readonly string[],
    durationMs: number | null,
    code: string | null,
  ): void {
    const context = this.buildContext(scope);
    this.store.db
      .prepare(
        `INSERT INTO agent_step (run_id, plan_step_index, tool_id, status, snapshot_refs_json, observation,
         evidence_refs_json, duration_ms, code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, plan_step_index) DO UPDATE SET
           status = excluded.status,
           snapshot_refs_json = excluded.snapshot_refs_json,
           observation = excluded.observation,
           evidence_refs_json = excluded.evidence_refs_json,
           duration_ms = excluded.duration_ms,
           code = excluded.code`,
      )
      .run(
        scope.runId,
        step.planStepIndex,
        step.toolId,
        status,
        JSON.stringify(context.refs),
        observation,
        JSON.stringify(evidenceRefs),
        durationMs,
        code,
      );
  }

  /**
   * 收尾：写终态、摘掉作用域、留一条可 grep 的日志。
   * @param scope 本次 run 的作用域
   * @param status 终态（`AGENT_RUN_STATUSES` 里的终态三选一）
   * @param stopReason 为什么停（界面与 5.2-09 的失败陈述都读这一位）
   */
  private finish(
    scope: RunScope,
    status: Extract<AgentRunStatus, 'paused' | 'completed' | 'failed'>,
    stopReason: string,
  ): void {
    this.updateRun(scope.runId, { status, planStepIndex: scope.cursor, tokensUsed: scope.tokensUsed, stopReason });
    this.scopes.delete(scope.runId);
    this.ctx.logger.info(`run ${scope.runId} 收尾：${status}（${stopReason}）· 跑到第 ${String(scope.cursor)} 步`);
  }

  /**
   * 更新 run 行的可变列。
   * @param runId 运行 id
   * @param patch 要写的列（至少含 status）
   */
  private updateRun(
    runId: string,
    patch: { status: AgentRunStatus; planStepIndex: number; tokensUsed: number; stopReason?: string | null },
  ): void {
    if (!AGENT_RUN_STATUSES.includes(patch.status))
      throw new AppError('AGENT_LOOP_STATUS_INVALID', `未知 run 状态 ${patch.status}`, 'agent.loop', {
        status: patch.status,
      });
    if (patch.stopReason === undefined) {
      this.store.db
        .prepare('UPDATE agent_run SET status = ?, plan_step_index = ?, tokens_used = ?, updated_at = ? WHERE id = ?')
        .run(patch.status, patch.planStepIndex, patch.tokensUsed, Date.now(), runId);
      return;
    }
    this.store.db
      .prepare(
        'UPDATE agent_run SET status = ?, plan_step_index = ?, tokens_used = ?, stop_reason = ?, updated_at = ? WHERE id = ?',
      )
      .run(patch.status, patch.planStepIndex, patch.tokensUsed, patch.stopReason, Date.now(), runId);
  }

  /**
   * 取一次 run 的作用域，内存里没有就从库里重建。
   *
   * 必须能重建：改配置会重建本服务并把 `scopes` 清空（AGENTS.md §9 的 2.5 实测），
   * 那时若只能读内存，界面就得到「有 run 却没有进度」。
   * @param runId 运行 id
   * @returns 与落库进度一致的作用域
   */
  private ensureScope(runId: string): RunScope {
    const existing = this.scopes.get(runId);
    if (existing) return existing;
    const view = this.read(runId);
    const scope: RunScope = {
      runId,
      cursor: view.steps.length > 0 ? Math.max(...view.steps.map((step) => step.planStepIndex)) + 1 : 0,
      plan: view.plan,
      tokensUsed: view.tokensUsed,
      // 两条上限从 run 行取，不取服务的当前配置：那两列记的就是「这条任务自己的额度」。
      stepLimit: view.stepLimit,
      tokenBudget: view.tokenBudget,
      planConfirmed: view.status !== 'proposed',
      controller: new AbortController(),
    };
    this.scopes.set(runId, scope);
    return scope;
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'agent.loop': AgentLoopService;
  }
}
