/**
 * 真计划器的两条口（plan 2026-10-26 §3.1）：回复收窄与「模型没配 / 请求失败」的确定结局。
 *
 * 全部打假通道，不出网（AGENTS.md §7.2）。判据分两半：
 * ① `parsePlanJson` 是**不可信输入**的第一道收窄——注册表核对与结构核对各一组，错就整份不成立；
 * ② `LlmLoopModel` 不许静默回落成桩——没通道、通道不可用、请求抛错三项各给一个 `AGENT_PLANNER_*` 码，
 *    由循环落成 `failed` 的 run 让界面读得到（环回那一半在 `loop.test.ts`）。
 */
import { AppError } from '@auto-cc/core';
import { describe, expect, it } from 'vitest';
import { LlmLoopModel, parsePlanJson, type PlannerChatChannel } from './llm-model.js';
import type { ObservationRequest, PlanDraftRequest } from './model.js';

/** 用例里的工具面：一只出网的与一只只读的，足够判「清单外的手」与「清单内照收」。 */
const KNOWN_TOOLS = ['jd.capture.run', 'jd.store.list'] as const;

/** 一次补全的入参形状（从通道那一侧取，测试不另写一份）。 */
type CompleteRequest = Parameters<PlannerChatChannel['complete']>[0];

/**
 * 造一份可断言的假通道。
 * @param reply 补全的结局：给文本，或抛错
 * @param status 可用性读数；缺省为「可用」
 * @returns 通道本体、收到的请求清单与 `complete` 的调用次数
 */
function fakeChannelOf(
  reply: { text: string; promptTokens?: number | null; completionTokens?: number | null } | { throws: Error },
  status: { available: boolean; missing: readonly string[]; model: string | null } = {
    available: true,
    missing: [],
    model: 'fake-chat',
  },
): { channel: PlannerChatChannel; requests: CompleteRequest[]; calls: () => number } {
  const requests: CompleteRequest[] = [];
  const channel: PlannerChatChannel = {
    status: () => status,
    complete: (request) => {
      requests.push(request);
      if ('throws' in reply) return Promise.reject(reply.throws);
      return Promise.resolve({
        text: reply.text,
        promptTokens: reply.promptTokens ?? null,
        completionTokens: reply.completionTokens ?? null,
      });
    },
  };
  return { channel, requests, calls: () => requests.length };
}

/**
 * 一份最小的起草请求。
 * @param overrides 只改本用例关心的那几位
 * @returns 可直接递给 `draftPlan` 的请求
 */
function planRequestOf(overrides: Partial<PlanDraftRequest> = {}): PlanDraftRequest {
  return {
    goal: '帮我找一份前端开发工作',
    tier: 'auto',
    knownToolIds: [...KNOWN_TOOLS],
    tools: [
      { id: 'jd.capture.run', description: '按条件搜岗位并抓取', effect: 'outbound' },
      { id: 'jd.store.list', description: '只读列出库里的岗位', effect: 'read' },
    ],
    context: { refs: ['entity:skill-1'], text: '在线简历：技能 - TypeScript / React' },
    ...overrides,
  };
}

/** 一份最小的观察请求（摘要在这一步只判截断与参数，不判措辞）。 */
function observationRequestOf(reading: string): ObservationRequest {
  return {
    step: {
      planStepIndex: 0,
      toolId: 'jd.capture.run',
      intent: '搜岗位',
      effect: 'outbound',
      requiresConfirmation: true,
      input: {},
    },
    reading,
    outcome: 'ok',
    context: { refs: [], text: '' },
  };
}

/** 一份够长的观察正文：用来验「摘要最多留 200 字」。 */
const LONG_READING = '抓到 3 条岗位：'.padEnd(300, '岗');

describe('计划器回复的收窄（不可信输入）', () => {
  it('合法 JSON 照收：代码围栏、裸数组与 {"steps":[…]} 三种形状都认', () => {
    const step = { toolId: 'jd.capture.run', intent: '搜前端岗位', input: { criteria: { keyword: '前端' } } };
    expect(parsePlanJson(JSON.stringify({ steps: [step] }), KNOWN_TOOLS)).toEqual([step]);
    expect(parsePlanJson(JSON.stringify([step]), KNOWN_TOOLS)).toEqual([step]);
    expect(parsePlanJson(`\`\`\`json\n${JSON.stringify({ steps: [step] })}\n\`\`\``, KNOWN_TOOLS)).toEqual([step]);
  });

  it('不是 JSON / 形状不对 / 步数超上限：一律 AGENT_PLANNER_INVALID_JSON，不做「猜一下」', () => {
    expect(() => parsePlanJson('帮我搜一下前端', KNOWN_TOOLS)).toThrowError(AppError);
    expect(() => parsePlanJson('{}', KNOWN_TOOLS)).toThrowError(AppError);
    const tooMany = Array.from({ length: 51 }, () => ({ toolId: 'jd.store.list', intent: '回看', input: {} }));
    expect(() => parsePlanJson(JSON.stringify({ steps: tooMany }), KNOWN_TOOLS)).toThrowError(AppError);
    for (const text of ['帮我搜一下前端', '{}']) {
      try {
        parsePlanJson(text, KNOWN_TOOLS);
      } catch (error) {
        expect((error as AppError).code).toBe('AGENT_PLANNER_INVALID_JSON');
      }
    }
  });

  it('缺 toolId / intent 或类型不对：整份不成立，并指出是第几步', () => {
    try {
      parsePlanJson(JSON.stringify({ steps: [{ toolId: 'jd.store.list', intent: 7 }] }), KNOWN_TOOLS);
    } catch (error) {
      expect((error as AppError).code).toBe('AGENT_PLANNER_INVALID_JSON');
      expect((error as AppError).message).toContain('第 1 步');
    }
    try {
      parsePlanJson(JSON.stringify({ steps: [{ intent: '回看' }] }), KNOWN_TOOLS);
    } catch (error) {
      expect((error as AppError).code).toBe('AGENT_PLANNER_INVALID_JSON');
    }
  });

  it('清单外的手：AGENT_PLANNER_UNKNOWN_TOOL，错误里带着编出来的那只 id', () => {
    try {
      parsePlanJson(JSON.stringify({ steps: [{ toolId: 'jd.delete.everything', intent: '清库' }] }), KNOWN_TOOLS);
    } catch (error) {
      expect((error as AppError).code).toBe('AGENT_PLANNER_UNKNOWN_TOOL');
      expect((error as AppError).details).toMatchObject({ toolId: 'jd.delete.everything', index: 0 });
    }
  });
});

describe('LlmLoopModel 的通道与失败结局', () => {
  it('通道未挂载：AGENT_PLANNER_UNAVAILABLE，一次网络都不发', async () => {
    const model = new LlmLoopModel(() => null, { timeoutMs: 120000, maxTokens: 1024, temperature: 0.1 });
    await expect(model.draftPlan(planRequestOf())).rejects.toMatchObject({ code: 'AGENT_PLANNER_UNAVAILABLE' });
  });

  it('通道不可用：报出缺哪几项，仍然一次网络都不发', async () => {
    const { channel, calls } = fakeChannelOf(
      { text: '{"steps":[]}' },
      { available: false, missing: ['apiKey', 'model'], model: null },
    );
    const model = new LlmLoopModel(() => channel, { timeoutMs: 120000, maxTokens: 1024, temperature: 0.1 });
    await expect(model.draftPlan(planRequestOf())).rejects.toMatchObject({
      code: 'AGENT_PLANNER_UNAVAILABLE',
      details: { missing: ['apiKey', 'model'] },
    });
    expect(calls()).toBe(0);
  });

  it('请求抛错：包成 AGENT_PLANNER_REQUEST_FAILED，原码留在 details 里（可复盘）', async () => {
    const { channel } = fakeChannelOf({ throws: new AppError('LLM_REQUEST_FAILED', '端点回 502') });
    const model = new LlmLoopModel(() => channel, { timeoutMs: 120000, maxTokens: 1024, temperature: 0.1 });
    await expect(model.draftPlan(planRequestOf())).rejects.toMatchObject({
      code: 'AGENT_PLANNER_REQUEST_FAILED',
      details: { cause: 'LLM_REQUEST_FAILED' },
    });
  });

  it('成功一趟：这一趟的超时/上限/温度逐位递到传输层，没回报 token 时按消息字数粗估', async () => {
    const { channel, requests } = fakeChannelOf({ text: JSON.stringify({ steps: [] }) });
    const model = new LlmLoopModel(() => channel, { timeoutMs: 420000, maxTokens: 2048, temperature: 0.1 });
    const result = await model.draftPlan(planRequestOf());
    expect(result.steps).toEqual([]);
    const request = requests[0];
    if (request === undefined) throw new Error('通道没收到补全请求');
    expect(request).toMatchObject({ maxTokens: 2048, temperature: 0.1, timeoutMs: 420000 });
    // 消息里既有目标也有工具面，且在线简历那段上下文原样带进去（§3.4 的取材落点）。
    expect(request.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(request.messages[0]?.content).toContain('计划器');
    expect(request.messages[1]?.content).toContain('帮我找一份前端开发工作');
    expect(request.messages[1]?.content).toContain('jd.store.list');
    expect(request.messages[1]?.content).toContain('TypeScript / React');
    // 对端没给用量：按送出去的整份文本粗估，至少不是 0（0 会让 token 预算那道闸永不触发）。
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it('观察摘要：最多 200 字，温度与上限与规划那一趟分开给', async () => {
    const { channel, requests } = fakeChannelOf({ text: LONG_READING });
    const model = new LlmLoopModel(() => channel, { timeoutMs: 420000, maxTokens: 2048, temperature: 0.1 });
    const result = await model.summarizeObservation(observationRequestOf(LONG_READING));
    expect(result.text).toHaveLength(200);
    expect(requests[0]).toMatchObject({ maxTokens: 200, temperature: 0.2, timeoutMs: 420000 });
    expect(requests[0]?.messages[1]?.content).toContain('jd.capture.run');
  });
});
