/**
 * `agent.loop` 与 `agent.policy` 的行为测试（spec 5.2-01 / 02 / 05 / 08 / 11，另带 09 / 10 的代码半边）。
 *
 * 与 `agent.test.ts` 同一口径：**这里不测界面**。5.2 的可视判据（计划卡、逐步卡片流、中途叫停、
 * 执行中输入不冻结）由 CDP harness 驱动真实窗口验收（AGENTS.md §7.1，落在 5.2-c）。
 * 单测负责的是结构事实：草案确定性、每一步必经判定口、run 与步两行表里记了什么、
 * 作用域是否真按 run 隔离、以及两条上限是否真会停。
 *
 * 全程打本地假工具（`demo.*`），不碰真实招聘平台也不出网（AGENTS.md §7.2）。
 */
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { asApp, Context, toolResult, type AgentRunView, type AutonomyLevel } from '@auto-cc/core';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChatSessionService } from '../session.js';
import { AgentToolsService, type AgentTool } from '../tools.js';
import { AGENT_RUN_MIGRATION_VERSION, AgentLoopService, type AgentLoopConfig } from './loop.js';
import { StubLoopModel } from './model.js';
import { AgentPolicyService, type PolicyDecision, type StepPermissionRequest } from './policy.js';

/** 拆卸清单与临时库目录（每个用例一套，跑完即删）。 */
const opened: { dispose(): Promise<unknown> }[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (opened.length) await opened.pop()?.dispose();
  while (dirs.length) rmSync(dirs.shift() ?? '', { recursive: true, force: true });
});

/** 循环配置的起手值（上限类用例只改自己关心的那一位，其余照默认走）。 */
const BASE_CONFIG: AgentLoopConfig = { stepLimit: 12, tokenBudget: 4000, contextCharsCap: 1200 };

/** `agent_step` 的原始行读数——断言时直接对表说话，不经视图转换。 */
type StepRecord = {
  run_id: string;
  plan_step_index: number;
  tool_id: string;
  status: string;
  snapshot_refs_json: string;
  observation: string;
  evidence_refs_json: string;
  code: string | null;
};

/**
 * 装一套 store + 注册表 + 会话 + 判定口 + 循环，并登记一只留下副作用的假工具。
 * @param overrides 循环配置覆盖
 * @param tier 起手档位；默认 `auto`（多数用例要的是「允许动手」），判定拒绝的用例显式传 `suggest`
 * @returns 上下文、四个服务句柄、副作用清单、临时库目录与循环的 fiber（重建服务时用）
 */
async function bootLoop(overrides: Partial<AgentLoopConfig> = {}, tier: AutonomyLevel = 'auto') {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-loop-'));
  dirs.push(dir);
  const config: AgentLoopConfig = { ...BASE_CONFIG, ...overrides };
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  const storeFiber = ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' });
  await storeFiber;
  const toolsFiber = ctx.plugin(AgentToolsService, {});
  await toolsFiber;
  const chatFiber = ctx.plugin(ChatSessionService, { chunkChars: 40, chunkIntervalMs: 0 });
  await chatFiber;
  const policyFiber = ctx.plugin(AgentPolicyService, {});
  await policyFiber;
  const loopFiber = ctx.plugin(AgentLoopService, config);
  await loopFiber;
  opened.push(loopFiber, policyFiber, chatFiber, toolsFiber, storeFiber);
  const app = asApp(ctx);
  /** 副作用清单：每进一次工具实现追加一条；判「被拒 = 什么都没发生」就看它空不空。 */
  const calls: string[] = [];
  app['agent.tools'].register(makeTickTool(calls));
  app['chat.session'].setAutonomy(tier);
  return {
    ctx,
    store: app.store,
    tools: app['agent.tools'],
    chat: app['chat.session'],
    policy: app['agent.policy'],
    loop: app['agent.loop'],
    calls,
    loopFiber,
    config,
  };
}

/**
 * 重挂一次循环服务，复现「热改配置会重建下游插件」（AGENTS.md §9 的 2.5 实测）。
 * @param ctx 本次台架的上下文
 * @param overrides 新配置覆盖
 * @returns 重建后的循环实例
 */
async function remountLoop(ctx: Context, overrides: Partial<AgentLoopConfig>): Promise<AgentLoopService> {
  const fiber = ctx.plugin(AgentLoopService, { ...BASE_CONFIG, ...overrides });
  await fiber;
  opened.push(fiber);
  return asApp(ctx)['agent.loop'];
}

/**
 * 一只「执行就留痕」的假工具（5.2-02 / 05 的判据都要能证明「拒了就是没发生」）。
 * @param calls 副作用清单，每进一次 `run` 追加一条
 * @returns 合规声明：`strictObject` 入参、`read` 级、不要求批准
 */
function makeTickTool(calls: string[]): AgentTool<{ n: number }> {
  return {
    id: 'demo.tick',
    titleKey: 'agent.tool.labels.demoTick',
    description: '把第几次调用记进副作用清单',
    input: z.strictObject({ n: z.number().int().min(0) }),
    effect: 'read',
    requiresConfirmation: false,
    run: (params) => {
      calls.push(`tick:${String(params.n)}`);
      return Promise.resolve(
        toolResult(
          { n: params.n },
          { summary: `已执行第 ${String(params.n)} 次`, evidenceRefs: [`tick:${String(params.n)}`] },
        ),
      );
    },
  };
}

/**
 * 拼一段点名 N 只手的目标文本（5.2-01 的「输入即脚本」：同一段文本永远起草出同一份计划）。
 * @param steps 要点名几次
 * @returns 形如 `demo.tick {"n":1} 然后 demo.tick {"n":2}` 的文本
 */
function goalNaming(steps: number): string {
  const mentions: string[] = [];
  for (let index = 0; index < steps; index += 1) mentions.push(`demo.tick {"n":${String(index + 1)}}`);
  return mentions.join(' 然后 ');
}

/**
 * 读一个 run 的全部步行（按步序号）。
 * @param store 存储句柄
 * @param runId 运行 id
 * @returns 原始行，用来断言表里到底记了什么
 */
function stepRecords(store: StoreService, runId: string): StepRecord[] {
  return store.db
    .prepare(
      'SELECT run_id, plan_step_index, tool_id, status, snapshot_refs_json, observation, evidence_refs_json, code FROM agent_step WHERE run_id = ? ORDER BY plan_step_index ASC',
    )
    .all(runId) as unknown as StepRecord[];
}

/** 数一遍号段 16 被登记了几次（重挂服务不许把同一个迁移版本 push 两遍）。 */
function migrationCopies(store: StoreService): number {
  return store.migrations.filter((migration) => migration.version === AGENT_RUN_MIGRATION_VERSION).length;
}

describe('桩模型的确定性草案（5.2-01）', () => {
  it('同一段目标文本两次起草得到同一份计划，步序与入参按点名顺序', async () => {
    const { loop } = await bootLoop();
    const first = await loop.propose(goalNaming(3));
    const second = await loop.propose(goalNaming(3));
    expect(first.runId).not.toBe(second.runId);
    expect(second.plan).toEqual(first.plan);
    expect(first).toMatchObject({ status: 'proposed', planStepIndex: 0 });
    expect(first.plan.map((step) => [step.planStepIndex, step.toolId, step.input])).toEqual([
      [0, 'demo.tick', { n: 1 }],
      [1, 'demo.tick', { n: 2 }],
      [2, 'demo.tick', { n: 3 }],
    ]);
    // 副作用分级是循环现读注册表贴上去的（不是模型自述），计划因此自带「预计副作用」那一列。
    expect(first.plan.every((step) => step.effect === 'read' && step.requiresConfirmation === false)).toBe(true);
    expect(first.plan.every((step) => step.intent.length > 0)).toBe(true);
  });

  it('没点名任何手时计划为空：确认之后一步都不跑，也不许自称做完', async () => {
    const { loop, calls } = await bootLoop();
    const proposed = await loop.propose('帮我看看有没有合适的前端岗位');
    expect(proposed.plan).toEqual([]);
    const finished = await loop.confirm(proposed.runId);
    expect(finished).toMatchObject({ status: 'failed', stopReason: 'PLAN_EMPTY' });
    expect(finished.steps).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('空目标与超长目标在起草之前被边界校验拦下，库里连一行 run 都不留', async () => {
    const { loop, store } = await bootLoop();
    await expect(loop.propose('   ')).rejects.toThrowError(/任务目标为空/);
    await expect(loop.propose('x'.repeat(2001))).rejects.toThrowError(/任务目标最长/);
    const rows = store.db.prepare('SELECT COUNT(*) AS n FROM agent_run').get() as { n: number | bigint };
    expect(Number(rows.n)).toBe(0);
  });
});

describe('每一步都过判定口（5.2-02）', () => {
  it('确认之前零动作：只有 run 行与计划，没有任何步行、没有任何副作用', async () => {
    const { loop, store, calls } = await bootLoop();
    const proposed = await loop.propose(goalNaming(2));
    expect(proposed.status).toBe('proposed');
    expect(proposed.plan).toHaveLength(2);
    expect(calls).toEqual([]);
    expect(stepRecords(store, proposed.runId)).toEqual([]);
  });

  it('档位「建议模式」下确认计划：步记 refused 并写明原因，工具一次都没进', async () => {
    const { loop, calls } = await bootLoop({}, 'suggest');
    const proposed = await loop.propose(goalNaming(2));
    const finished = await loop.confirm(proposed.runId);
    expect(finished).toMatchObject({ status: 'failed', stopReason: 'POLICY_REFUSED' });
    expect(finished.steps).toHaveLength(1);
    expect(finished.steps[0]).toMatchObject({
      planStepIndex: 0,
      status: 'refused',
      code: 'TIER_SUGGEST_READ_ONLY',
      evidenceRefs: [],
    });
    expect(finished.steps[0]?.observation).toContain('建议模式');
    // 判据的实质不是「返回了错误」，而是实现根本没被叫起来。
    expect(calls).toEqual([]);
  });

  it('一只自己声明要批准的手，`auto` 档也不替用户点头：CONFIRMATION_REQUIRED 且零副作用', async () => {
    const { loop, tools, calls } = await bootLoop();
    tools.register({
      id: 'demo.needs-approval',
      titleKey: 'agent.tool.labels.demoNeedsApproval',
      description: '要求批准才可执行',
      input: z.strictObject({ n: z.number().int().min(0) }),
      effect: 'outbound',
      requiresConfirmation: true,
      run: (params) => {
        calls.push(`approved:${String(params.n)}`);
        return Promise.resolve(toolResult({ n: params.n }, { summary: '不该走到这里' }));
      },
    });
    const finished = await loop.confirm((await loop.propose('demo.needs-approval {"n":1}')).runId);
    expect(finished.steps[0]).toMatchObject({ status: 'refused', code: 'CONFIRMATION_REQUIRED' });
    expect(calls).toEqual([]);
  });

  it('起草之后手被摘掉：执行时按注册表现读的结果拒，认它是 TOOL_UNAVAILABLE', async () => {
    const { loop, tools, calls } = await bootLoop();
    const proposed = await loop.propose(goalNaming(1));
    expect(proposed.plan[0]).toMatchObject({ effect: 'read' });
    tools.unregister('demo.tick');
    tools.register({ ...makeTickTool(calls), disabled: true });
    const finished = await loop.confirm(proposed.runId);
    expect(finished.steps[0]).toMatchObject({ status: 'refused', code: 'TOOL_UNAVAILABLE' });
    expect(calls).toEqual([]);
  });

  it('循环里调注册表只有一处、且排在判定之后；每步的判定都带「计划已确认」', async () => {
    const { loop, policy, calls } = await bootLoop();
    /** 判定台账：套一层记录用的壳，判据是「每一步都经过这里」，不是判定本身的结果。 */
    const decisions: StepPermissionRequest[] = [];
    const decideOriginal = policy.decide.bind(policy);
    policy.decide = (request: StepPermissionRequest): PolicyDecision => {
      decisions.push(request);
      return decideOriginal(request);
    };
    const finished = await loop.confirm((await loop.propose(goalNaming(3))).runId);
    expect(decisions).toHaveLength(3);
    expect(decisions.every((request) => request.planConfirmed === true)).toBe(true);
    expect(decisions.map((request) => request.toolId)).toEqual(['demo.tick', 'demo.tick', 'demo.tick']);
    expect(finished.status).toBe('completed');
    expect(calls).toEqual(['tick:1', 'tick:2', 'tick:3']);
    // 代码走查的机检半边（5.2-02 是 C 类）：调工具的口只有一处，且它排在判定之后——没有第二条旁路。
    const source = readFileSync(fileURLToPath(new URL('./loop.ts', import.meta.url)), 'utf8');
    expect(source.match(/this\.registry\.call\(/g)).toHaveLength(1);
    expect(source.indexOf('this.policy.decide(')).toBeLessThan(source.indexOf('this.registry.call('));
  });
});

describe('run 与步记录落库（5.2-05）', () => {
  it('跑完三步：一条 run 行、三条步行，序号/状态/快照引用/证据/耗时齐全', async () => {
    const { loop, store } = await bootLoop();
    const proposed = await loop.propose(goalNaming(3));
    const finished = await loop.confirm(proposed.runId);
    expect(finished).toMatchObject({ status: 'completed', stopReason: 'COMPLETED', planStepIndex: 3 });
    const rows = stepRecords(store, proposed.runId);
    // 同一步只有一行：`pending` → `ok` 是覆盖（主键 (run_id, plan_step_index)），读进度不必「取最新那条」。
    expect(rows.map((row) => row.plan_step_index)).toEqual([0, 1, 2]);
    expect(rows.every((row) => row.status === 'ok' && row.code === null)).toBe(true);
    expect(JSON.parse(rows[0]?.snapshot_refs_json ?? '[]')).toEqual([]);
    expect(JSON.parse(rows[1]?.snapshot_refs_json ?? '[]')).toEqual([`run:${proposed.runId}/step:0`]);
    expect(JSON.parse(rows[2]?.snapshot_refs_json ?? '[]')).toEqual([
      `run:${proposed.runId}/step:0`,
      `run:${proposed.runId}/step:1`,
    ]);
    expect(JSON.parse(rows[2]?.evidence_refs_json ?? '[]')).toEqual(['tick:3']);
    expect(finished.steps.every((step) => step.durationMs !== null)).toBe(true);
    expect(migrationCopies(store)).toBe(1);
  });

  it('查无此 run 时结构化失败，而不是给一份空读数冒充「跑完了」', async () => {
    const { loop } = await bootLoop();
    expect(() => loop.read('no-such-run')).toThrowError(/找不到 run/);
  });

  it('对已经跑完的 run 再确认一次被拒：计划不是可以重复按下去的按钮', async () => {
    const { loop, calls } = await bootLoop();
    const runId = (await loop.propose(goalNaming(1))).runId;
    await loop.confirm(runId);
    expect(calls).toEqual(['tick:1']);
    await expect(loop.confirm(runId)).rejects.toThrowError(/不是待确认态/);
    expect(calls).toEqual(['tick:1']);
  });
});

describe('一次 run 一份作用域（5.2-08）', () => {
  it('连跑两个任务：游标、账、上下文互不相干，第二个看不到第一个的步', async () => {
    const { loop } = await bootLoop();
    const first = await loop.confirm((await loop.propose(goalNaming(3))).runId);
    const second = await loop.confirm((await loop.propose(goalNaming(1))).runId);
    expect(first).toMatchObject({ planStepIndex: 3, status: 'completed' });
    expect(second).toMatchObject({ planStepIndex: 1, status: 'completed', stopReason: 'COMPLETED' });
    expect(second.steps).toHaveLength(1);
    // 新 run 的上下文从空开始：跨 run 的隐式延续正是 plan §1.1 里 Cordis 那条坑的形态。
    expect(second.steps[0]?.snapshotRefs).toEqual([]);
    expect(second.tokensUsed).not.toBe(first.tokensUsed);
    expect(second.runId).not.toBe(first.runId);
  });

  it('服务被重建之后进度仍读得回：内存表可以空，落库的那两行才是事实', async () => {
    const { loop, store, ctx, loopFiber, calls } = await bootLoop();
    const proposed = await loop.propose(goalNaming(2));
    // 改配置会重建本服务并把作用域表清空（AGENTS.md §9 的 2.5 实测），这里手动重挂一次复现它。
    await loopFiber.dispose();
    const revived = await remountLoop(ctx, { stepLimit: 5 });
    expect(migrationCopies(store)).toBe(1);
    // 重建后的第一次读：计划、档位、token 账全部来自库里那一行，而不是内存里残留的旧作用域。
    expect(revived.read(proposed.runId)).toEqual(proposed);
    const finished = await revived.confirm(proposed.runId);
    expect(finished).toMatchObject({ status: 'completed', planStepIndex: 2 });
    expect(calls).toEqual(['tick:1', 'tick:2']);
  });
});

describe('步数与 token 双上限（5.2-11）', () => {
  it('计划比步上限长 → 跑到上限即停，并写明 STEP_LIMIT（不无限自转）', async () => {
    const { loop, calls } = await bootLoop({ stepLimit: 2 });
    const finished = await loop.confirm((await loop.propose(goalNaming(4))).runId);
    expect(finished).toMatchObject({ status: 'failed', stopReason: 'STEP_LIMIT', stepLimit: 2, planStepIndex: 2 });
    expect(finished.steps).toHaveLength(2);
    expect(calls).toEqual(['tick:1', 'tick:2']);
  });

  it('预算先撞 → 在下一步开始之前停下并写明 TOKEN_LIMIT', async () => {
    const goal = goalNaming(3);
    // 预算从「这份草案自己花多少」推出来，不硬写数字：桩模型是导出的公开实现，拿它当预言机不是后门。
    const draft = await new StubLoopModel().draftPlan({
      goal,
      tier: 'auto',
      knownToolIds: ['demo.tick'],
      context: { refs: [], text: '' },
    });
    const budget = draft.usage.inputTokens + draft.usage.outputTokens + 10;
    const { loop, calls } = await bootLoop({ tokenBudget: budget });
    const proposed = await loop.propose(goal);
    expect(proposed.tokensUsed).toBe(budget - 10);
    const finished = await loop.confirm(proposed.runId);
    expect(finished).toMatchObject({ status: 'failed', stopReason: 'TOKEN_LIMIT', tokenBudget: budget });
    expect(finished.tokensUsed).toBeGreaterThanOrEqual(budget);
    // 停在预算上而不是把整份计划跑光：跑到的步数必须少于计划步数，而且至少跑出了一步。
    expect(finished.steps.length).toBeLessThan(finished.plan.length);
    expect(finished.steps.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThan(3);
  });

  it('两条上限属于这条 run：起草之后改配置，不回改已经在等人确认的那个任务', async () => {
    const { loop, ctx, loopFiber } = await bootLoop();
    const proposed = await loop.propose(goalNaming(2));
    expect(proposed).toMatchObject({ stepLimit: 12, tokenBudget: 4000 });
    // 把服务配置收到「一步都不许跑」的程度：run 行上的那两列才是它的额度，界面读的也是那两列。
    await loopFiber.dispose();
    const stricter = await remountLoop(ctx, { stepLimit: 1, tokenBudget: 50 });
    const finished = await stricter.confirm(proposed.runId);
    expect(finished).toMatchObject({ status: 'completed', stopReason: 'COMPLETED', planStepIndex: 2 });
  });
});

describe('失败与叫停的如实记录（5.2-09 / 10 的代码半边）', () => {
  it('工具抛错时步记 failed 并带原因，整条 run 不自称 completed', async () => {
    const { loop, tools } = await bootLoop();
    tools.unregister('demo.tick');
    tools.register({ ...makeTickTool([]), run: () => Promise.reject(new Error('页面出现验证码，已停止')) });
    const finished = await loop.confirm((await loop.propose(goalNaming(2))).runId);
    expect(finished).toMatchObject({ status: 'failed', stopReason: 'STEP_UNSUCCESSFUL' });
    expect(finished.steps).toHaveLength(2);
    expect(finished.steps[0]).toMatchObject({ status: 'failed', code: 'TOOL_FAILED', evidenceRefs: [] });
    expect(finished.steps[0]?.observation).toContain('验证码');
    expect(finished.steps[1]?.status).toBe('failed');
  });

  it('叫停在下一个安全点生效：正在跑的那一步照常收尾，但不进下一步', async () => {
    const { loop, tools, calls } = await bootLoop();
    const gate = makeGate();
    tools.register({
      id: 'demo.gated',
      titleKey: 'agent.tool.labels.demoGated',
      description: '进实现即通知测试，等放行才回',
      input: z.strictObject({ n: z.number().int().min(0) }),
      effect: 'read',
      requiresConfirmation: false,
      run: (params) => {
        calls.push(`gated:${String(params.n)}`);
        gate.entered();
        return gate.releaseAfter(() => toolResult({ n: params.n }, { summary: `门后执行第 ${String(params.n)} 次` }));
      },
    });
    const proposed = await loop.propose(`demo.gated {"n":1} 然后 demo.gated {"n":2}`);
    const inFlight = loop.confirm(proposed.runId);
    await gate.enteredPromise;
    const during = loop.stop(proposed.runId);
    // 叫停不立刻改终态：它只置信号，正在跑的那一步还没收尾，界面此刻读到的仍是 running。
    expect(during.status).toBe('running');
    expect(calls).toEqual(['gated:1']);
    gate.open();
    const finished: AgentRunView = await inFlight;
    expect(finished).toMatchObject({ status: 'paused', stopReason: 'USER_STOPPED' });
    // 半途掐断一次已发出的动作比让它跑完更糟：这一步的观察记录必须完整存在，而下一步根本没跑。
    expect(finished.steps).toHaveLength(1);
    expect(finished.steps[0]).toMatchObject({ status: 'ok' });
    expect(finished.steps[0]?.observation).toContain('门后执行第 1 次');
    expect(calls).toEqual(['gated:1']);
  });

  it('对 `proposed` 的 run 叫停：直接落 paused 且零动作；已终态的再按一次不炸', async () => {
    const { loop, calls } = await bootLoop();
    const proposed = await loop.propose(goalNaming(2));
    const stopped = loop.stop(proposed.runId);
    expect(stopped).toMatchObject({ status: 'paused', stopReason: 'USER_STOPPED' });
    expect(stopped.steps).toEqual([]);
    expect(calls).toEqual([]);
    expect(loop.stop(proposed.runId).status).toBe('paused');
  });

  it('执行途中把档位降回建议模式：下一个安全点就不再动手（档位是人当下的表态）', async () => {
    const { loop, tools, chat, calls } = await bootLoop();
    const gate = makeGate();
    tools.unregister('demo.tick');
    tools.register({
      ...makeTickTool(calls),
      run: (params) => {
        calls.push(`tick:${String(params.n)}`);
        gate.entered();
        return gate.releaseAfter(() => toolResult({ n: params.n }, { summary: '慢动作执行完' }));
      },
    });
    const proposed = await loop.propose(goalNaming(2));
    const inFlight = loop.confirm(proposed.runId);
    await gate.enteredPromise;
    chat.setAutonomy('suggest');
    gate.open();
    const finished = await inFlight;
    expect(finished).toMatchObject({ status: 'failed', stopReason: 'POLICY_REFUSED' });
    expect(finished.steps[1]).toMatchObject({ status: 'refused', code: 'TIER_SUGGEST_READ_ONLY' });
    expect(calls).toEqual(['tick:1']);
  });
});

/**
 * 一只可控的「门」：让假工具能停在实现里，等测试放行才返回。
 * @returns `entered` 通知测试已进实现、`open` 放行、`releaseAfter` 把返回值排在放行之后
 */
function makeGate() {
  let open = (): void => {};
  let entered = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    enteredPromise,
    entered,
    open,
    /**
     * 等放行再算出工具返回值。
     * @param produce 产出工具读数的函数
     * @returns 放行后兑现的读数
     */
    releaseAfter<T>(produce: () => T): Promise<T> {
      return opened.then(produce);
    },
  };
}
