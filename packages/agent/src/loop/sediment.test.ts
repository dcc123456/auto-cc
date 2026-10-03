/**
 * 对话 → 工作流的**投影**用例（spec 5.4-02 / 03 的形状半边 / 04 / 09 的代码半边）。
 *
 * 这里只测 `projectRun` 这一只纯函数：它的判据是「这段对话会变成哪几个格子、哪个格子为什么不行」，
 * 输入是 `agent.loop.read()` 的读数与两张查表口，没有数据库、没有 IPC、也没有界面（那三样各自有归属：
 * 落库见 `packages/main/src/sediment-link.test.ts`，界面见 5.4-b 的 harness 验收）。
 * 之所以能这么切：投影被刻意做成不吃注册表本体（`SedimentLookups` 是注入的查表函数），
 * 于是 5.4-02 的四种「拒」每一种都能单独摆出来，不必为了造一个失败步去挂一整套服务。
 *
 * 全程用假工具与假执行器名，不碰真实招聘平台（AGENTS.md §7.2）。
 */
import {
  toolResult,
  type AgentPlanStepView,
  type AgentRunView,
  type AgentStepView,
  type AgentToolDeclaration,
  type ToolEffect,
} from '@auto-cc/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { projectRun, type SedimentLookups } from './sediment.js';

/** 这只工具的入参形状：投影按点路径读它，所以路径写错在这里就会露出来（少一个参数是看得见的）。 */
const INPUT = {
  platform: 'boss',
  jobId: 'job-77',
  text: '您好，看到贵司这个岗位很感兴趣',
  limit: 20,
  nested: { deep: 'x' },
};

/**
 * 造一条计划草案步。
 * @param index 步序（同时决定格子 id 是 `node-<index+1>`）
 * @param toolId 这只步要点名的工具
 * @returns `AgentPlanStepView`（`intent`/`effect` 等投影不读的字段给足占位值）
 */
function planStep(index: number, toolId: string): AgentPlanStepView {
  return {
    planStepIndex: index,
    toolId,
    input: INPUT,
    intent: `第 ${String(index + 1)} 步`,
    effect: 'read',
    requiresConfirmation: false,
  };
}

/**
 * 造一条已跑到的步行（`agent_step` 的视图）。
 * @param index 对应的草案步序
 * @param toolId 工具 id
 * @param status 落库状态；缺省 `ok`（只有成功步才可能沉淀）
 * @returns `AgentStepView`
 */
function stepRow(index: number, toolId: string, status: AgentStepView['status'] = 'ok'): AgentStepView {
  return {
    runId: 'run-1',
    planStepIndex: index,
    toolId,
    status,
    snapshotRefs: [],
    observation: `第 ${String(index + 1)} 步的观察摘要`,
    evidenceRefs: [`fixture:${String(index)}`],
    durationMs: 10,
    code: status === 'ok' ? null : 'TOOL_FAILED',
  };
}

/**
 * 造一次 run 的整份读数。
 * @param plan 计划草案
 * @param steps 已跑到的步（**可以少于** plan：中途叫停的 run 就是这一形状）
 * @returns `AgentRunView`
 */
function agentRun(plan: AgentPlanStepView[], steps: AgentStepView[]): AgentRunView {
  return {
    runId: 'run-1',
    sessionId: 'sess-1',
    goal: '给 job-77 打招呼',
    status: 'completed',
    autonomy: 'auto',
    planStepIndex: plan.length,
    plan,
    steps,
    stepLimit: 12,
    tokenBudget: 4000,
    tokensUsed: 120,
    stopReason: 'COMPLETED',
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

/**
 * 造一只带 `workflow` 条款的工具声明。
 * @param id 工具 id
 * @param overrides 覆盖条款或危险度（`workflow: null` 表示「这只手压根没声明条款」）
 * @returns 声明读数，够投影读的那几位
 */
function declaration(
  id: string,
  overrides: Partial<Pick<AgentToolDeclaration, 'effect'>> & {
    workflow?: AgentToolDeclaration['workflow'] | null;
  } = {},
): AgentToolDeclaration {
  const { workflow, ...rest } = overrides;
  return {
    id,
    titleKey: 'agent.tool.labels.demoGreet',
    description: '假的外发手',
    input: z.strictObject({ platform: z.string(), jobId: z.string(), text: z.string() }),
    effect: 'read',
    requiresConfirmation: false,
    run: () => Promise.resolve(toolResult({ ok: true }, { summary: '假执行', evidenceRefs: [] })),
    ...rest,
    ...(workflow === null ? {} : workflow === undefined ? { workflow: GREET_CLAUSE } : { workflow }),
  };
}

/** 打招呼那格的条款（与 `outbound/src/greet.ts` 里那条同形状，参数名按执行器侧的口径）。 */
const GREET_CLAUSE = {
  kind: 'greeting.send',
  target: 'request.jobId',
  params: { platform: 'request.platform', job: 'request.jobId', text: 'request.text' },
} as const;

/**
 * 组装查表口：声明表 + 已登记的执行器名。
 * @param tools 这批工具声明（按 id 建表）
 * @param kinds 登记处当前有的节点 kind
 * @returns 给 `projectRun` 的 `SedimentLookups`
 */
function lookups(tools: AgentToolDeclaration[], kinds: string[]): SedimentLookups {
  const table = new Map(tools.map((tool) => [tool.id, tool]));
  return { declarationOf: (toolId) => table.get(toolId), kindRegistered: (kind) => kinds.includes(kind) };
}

/** 一处共用：`request.*` 前缀的入参形状（条款按它写，与工具真实的入参壳子一致）。 */
const REQUEST_INPUT = { request: { platform: 'boss', jobId: 'job-77', text: '您好，方便聊聊吗' } };

/**
 * 造一条**入参带壳**的草案步（真工具的 `input` 就是 `{request: {...}}` 这一形状）。
 * @param index 步序
 * @param toolId 工具 id
 * @returns 草案步，`input` 为 `REQUEST_INPUT`
 */
function requestStep(index: number, toolId: string): AgentPlanStepView {
  return { ...planStep(index, toolId), input: REQUEST_INPUT };
}

describe('沉淀投影：全段可沉淀的形状（spec 5.4-01 / 03 的形状半边）', () => {
  it('三步都成功且都有条款与执行器 → 三个格子，逐字段按条款取到值', () => {
    const preview = projectRun(
      agentRun(
        [
          requestStep(0, 'outbound.greet.perform'),
          requestStep(1, 'outbound.greet.perform'),
          requestStep(2, 'outbound.greet.perform'),
        ],
        [
          stepRow(0, 'outbound.greet.perform'),
          stepRow(1, 'outbound.greet.perform'),
          stepRow(2, 'outbound.greet.perform'),
        ],
      ),
      lookups([declaration('outbound.greet.perform')], ['greeting.send']),
    );
    expect(preview.canSediment).toBe(true);
    expect(preview.blockingReason).toBeNull();
    expect(preview.steps.map((step) => [step.planStepIndex, step.toolId, step.sedimentable])).toEqual([
      [0, 'outbound.greet.perform', true],
      [1, 'outbound.greet.perform', true],
      [2, 'outbound.greet.perform', true],
    ]);
    // 格子 id 由步序现算，不由模型给：模型给的 id 会撞车，撞了就撞在幂等键上（2.4-01 的口径）。
    expect(preview.steps.map((step) => step.node?.id)).toEqual(['node-1', 'node-2', 'node-3']);
    expect(preview.steps[0]?.node).toEqual({
      id: 'node-1',
      kind: 'greeting.send',
      target: 'job-77',
      params: { platform: 'boss', job: 'job-77', text: '您好，方便聊聊吗' },
      effect: 'read',
      retryTimes: null,
      requiresHuman: false,
    });
  });

  it('节点声明与 2.4 的模型同形状：每个格子都带齐 effect / retryTimes / requiresHuman（5.4-03）', () => {
    const preview = projectRun(
      agentRun([requestStep(0, 't.a')], [stepRow(0, 't.a')]),
      lookups([declaration('t.a', { effect: 'outbound' })], ['greeting.send']),
    );
    const node = preview.steps[0]?.node;
    expect(node).not.toBeNull();
    // `effect` 取的是**工具声明**那一位（outbound 工具沉淀出来就是 outbound），不是投影自己分级。
    expect(node?.effect).toBe('outbound');
    expect(node?.retryTimes).toBeNull();
    expect(node?.requiresHuman).toBe(false);
    expect(Object.keys(node ?? {})).toEqual([
      'id',
      'kind',
      'target',
      'params',
      'effect',
      'retryTimes',
      'requiresHuman',
    ]);
  });

  it('条款里没有的键、以及点路径读不到标量的键都不写进 params（宁缺勿假）', () => {
    const preview = projectRun(
      agentRun(
        // `nested` 是对象：节点参数只接受标量（`plan.ts` 的 nodeParamSchema），带进去就是一条跑不通的计划。
        [{ ...requestStep(0, 't.a'), input: { ...REQUEST_INPUT, nested: { deep: 'x' } } }],
        [stepRow(0, 't.a')],
      ),
      lookups(
        [
          declaration('t.a', {
            workflow: {
              kind: 'greeting.send',
              params: { platform: 'request.platform', missing: 'request.none', obj: 'nested' },
            },
          }),
        ],
        ['greeting.send'],
      ),
    );
    // 只留下真正读得到的那一个；读不到的既不进 params 也不进变量读数。
    expect(preview.steps[0]?.node?.params).toEqual({ platform: 'boss' });
    expect(preview.steps[0]?.params.map((param) => param.paramKey)).toEqual(['platform']);
    expect(preview.canSediment).toBe(true);
  });
});

describe('沉淀投影：四种拒绝各说清一件事（spec 5.4-02）', () => {
  it('含失败步 → 整段不可沉淀，并且拒因点到那一步的序号与原状态', () => {
    const preview = projectRun(
      agentRun(
        [requestStep(0, 't.a'), requestStep(1, 't.a'), requestStep(2, 't.a')],
        [stepRow(0, 't.a'), stepRow(1, 't.a', 'failed'), stepRow(2, 't.a')],
      ),
      lookups([declaration('t.a')], ['greeting.send']),
    );
    // 「整段」而不是「跳过那一格」：一条少了中间一步的工作流跑起来是另一件事，界面上不能给它一个绿勾。
    expect(preview.canSediment).toBe(false);
    expect(preview.blockingReason).toContain('第 2 步');
    expect(preview.blockingReason).toContain('failed');
    expect(preview.steps[1]).toMatchObject({ sedimentable: false, node: null, params: [] });
    // 其余格子仍然算得出来（界面要把「坏在哪一格」指给用户看，不只是报一句不行）。
    expect(preview.steps[0]?.sedimentable).toBe(true);
    expect(preview.steps[2]?.sedimentable).toBe(true);
  });

  it('被拒的确认步（refused）与失败步同口径：一样整段不放行', () => {
    const preview = projectRun(
      agentRun([requestStep(0, 't.a'), requestStep(1, 't.a')], [stepRow(0, 't.a'), stepRow(1, 't.a', 'refused')]),
      lookups([declaration('t.a')], ['greeting.send']),
    );
    expect(preview.canSediment).toBe(false);
    expect(preview.steps[1]?.stepStatus).toBe('refused');
  });

  it('工具声明不见了（能力包被摘）→ 那一格拒，并说清是没有声明', () => {
    const preview = projectRun(
      agentRun([requestStep(0, 't.gone')], [stepRow(0, 't.gone')]),
      lookups([], ['greeting.send']),
    );
    expect(preview.canSediment).toBe(false);
    expect(preview.blockingReason).toContain('t.gone');
    expect(preview.blockingReason).toContain('没有声明');
  });

  it('工具没带 workflow 条款 → 拒，且不按 id 猜一个 kind（5.4-09 的反向半边）', () => {
    const preview = projectRun(
      agentRun([requestStep(0, 'kb.search.run')], [stepRow(0, 'kb.search.run')]),
      lookups([declaration('kb.search.run', { workflow: null })], ['greeting.send']),
    );
    expect(preview.canSediment).toBe(false);
    expect(preview.blockingReason).toContain('没有声明对应的可跑节点');
    // 猜出来的那一格既没有 kind 也没有 params：拒得干净，比"看起来能跑"重要。
    expect(preview.steps[0]?.node).toBeNull();
  });

  it('条款指的那个 kind 没登记 → 拒，并点名执行器', () => {
    const preview = projectRun(
      agentRun([requestStep(0, 't.a')], [stepRow(0, 't.a')]),
      lookups([declaration('t.a')], []),
    );
    expect(preview.canSediment).toBe(false);
    expect(preview.blockingReason).toContain('greeting.send');
    expect(preview.blockingReason).toContain('没登记');
  });

  it('一步都没跑 → 拒因是「没有可沉淀的内容」，不是空计划', () => {
    const preview = projectRun(agentRun([requestStep(0, 't.a')], []), lookups([declaration('t.a')], ['greeting.send']));
    expect(preview).toMatchObject({ runId: 'run-1', goal: '给 job-77 打招呼', steps: [], canSediment: false });
    expect(preview.blockingReason).toContain('一步都没跑过');
  });
});

describe('沉淀投影：格子只跟着跑过的步长（spec 5.4-09 的「一步对一格」）', () => {
  it('草案五步、只跑到三步 → 三格，且第 4/5 步不会被编成格子', () => {
    const preview = projectRun(
      agentRun(
        [
          requestStep(0, 't.a'),
          requestStep(1, 't.a'),
          requestStep(2, 't.a'),
          requestStep(3, 't.a'),
          requestStep(4, 't.a'),
        ],
        [stepRow(0, 't.a'), stepRow(1, 't.a'), stepRow(2, 't.a')],
      ),
      lookups([declaration('t.a')], ['greeting.send']),
    );
    // 「导出的每一步都在对话里找得到对应卡片」在这里是结构事实：格子来自 steps，不是来自 plan 的长度。
    expect(preview.steps).toHaveLength(3);
    expect(preview.steps.map((step) => step.planStepIndex)).toEqual([0, 1, 2]);
    expect(preview.canSediment).toBe(true);
  });

  it('乱序的步行读数按草案顺序出格子（幂等键与界面格子顺序都靠它）', () => {
    const preview = projectRun(
      agentRun([requestStep(0, 't.a'), requestStep(1, 't.b')], [stepRow(1, 't.b'), stepRow(0, 't.a')]),
      lookups([declaration('t.a'), declaration('t.b')], ['greeting.send']),
    );
    expect(preview.steps.map((step) => [step.planStepIndex, step.node?.id])).toEqual([
      [0, 'node-1'],
      [1, 'node-2'],
    ]);
  });
});

describe('变量与残留值的读数（spec 5.4-04）', () => {
  /** 一次带齐"变量键"与"残留键"的投影：`query`/`city`/`limit`/`target` 在名单里，其余不在。 */
  function projectParamReadout() {
    return projectRun(
      agentRun(
        [
          {
            planStepIndex: 0,
            toolId: 't.a',
            input: INPUT,
            intent: '搜岗位',
            effect: 'read',
            requiresConfirmation: false,
          },
        ],
        [stepRow(0, 't.a')],
      ),
      lookups(
        [
          declaration('t.a', {
            workflow: {
              kind: 'jd.capture',
              target: 'jobId',
              params: { query: 'text', city: 'platform', limit: 'limit', job: 'jobId', text: 'text' },
            },
          }),
        ],
        ['jd.capture'],
      ),
    ).steps[0]?.params;
  }

  it('按白名单键名判变量，不按值长得像不像，也不交给模型', () => {
    const readout = projectParamReadout() ?? [];
    expect(readout.map((param) => [param.paramKey, param.isVariable])).toEqual([
      ['query', true],
      ['city', true],
      ['limit', true],
      ['job', false],
      ['text', false],
    ]);
    // `city` 的值是 "boss"——完全不像城市名，但它仍然算变量位：判据是键名，不是长相。
    expect(readout.find((param) => param.paramKey === 'city')?.value).toBe('boss');
  });

  it('target 参与格子（幂等键的一段），但它不是 params 里的一项', () => {
    const preview = projectRun(
      agentRun(
        [{ planStepIndex: 0, toolId: 't.a', input: INPUT, intent: '', effect: 'read', requiresConfirmation: false }],
        [stepRow(0, 't.a')],
      ),
      lookups(
        [declaration('t.a', { workflow: { kind: 'jd.capture', target: 'jobId', params: { query: 'text' } } })],
        ['jd.capture'],
      ),
    );
    expect(preview.steps[0]?.node?.target).toBe('job-77');
    expect(preview.steps[0]?.params.map((param) => param.paramKey)).toEqual(['query']);
  });

  it('没有 target 的条款 → 空格子（纯读节点不按目标去重），而不是 undefined 落进库里', () => {
    const preview = projectRun(
      agentRun(
        [{ planStepIndex: 0, toolId: 't.a', input: INPUT, intent: '', effect: 'read', requiresConfirmation: false }],
        [stepRow(0, 't.a')],
      ),
      lookups([declaration('t.a', { workflow: { kind: 'jd.capture', params: { query: 'text' } } })], ['jd.capture']),
    );
    expect(preview.steps[0]?.node?.target).toBe('');
  });

  it('effect 四种取值都原样带过格子（危险度不由投影改判）', () => {
    const effects: ToolEffect[] = ['read', 'local-write', 'outbound'];
    for (const [index, effect] of effects.entries()) {
      const preview = projectRun(
        agentRun([requestStep(index, 't.a')], [stepRow(index, 't.a')]),
        lookups([declaration('t.a', { effect })], ['greeting.send']),
      );
      expect(preview.steps[0]?.node?.effect).toBe(effect);
    }
    expect(effects).toEqual(['read', 'local-write', 'outbound']);
  });
});
