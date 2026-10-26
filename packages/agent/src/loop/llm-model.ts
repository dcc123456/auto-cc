/**
 * 真计划器：把 `llm.chat` 的**对话通道**接成 `LoopModel` 的第二份实现（plan 2026-10-26 §3.1）。
 *
 * 两条口与桩逐字同形（`LoopModel` 机检仍只认 `draftPlan` / `summarizeObservation`）：
 * 模型在这里只负责「起草」，判定权在 `agent.policy`，这一步一条都不给它。
 *
 * 模型产出是**不可信输入**，收窄分两层且都在本文件之外已有的判据上：
 * ① `toolId` 现查 `PlanDraftRequest.knownToolIds`（注册表那一份），不在清单里就整份计划不成立——
 *    不静默丢步、也不猜一个近似名，那会让「模型编了一只不存在的手」看起来像跑完了；
 * ② `input` 原样交给循环，由各工具自己的 zod schema 在 `agent.tools.validateInput` 里收窄（既有形状）。
 *
 * 失败一律抛 `AppError`（码见各分支），由循环落成 `failed` 的 run——**不静默回落到桩**：
 * 桩只留给单测做确定性复现，生产里「模型没配 / 超时 / JSON 非法」必须能被界面说出来。
 */
import { AppError } from '@auto-cc/core';
import { buildObservationMessages, buildPlanMessages } from '../prompts.js';
import {
  estimateTokens,
  type LoopModel,
  type ObservationRequest,
  type ObservationResult,
  type PlanDraftRequest,
  type PlanDraftResult,
  type PlanStepDraft,
} from './model.js';

/**
 * 计划器要的对话通道（窄口：只要 `status` 与 `complete`）。
 *
 * 不直接收 `LlmChatService` 是因为循环只需要这两件事，而单测要能塞一份假通道；
 * 形状与 `llm.chat` 的两个导出方法逐位一致（§2.3 扩展既有实现，不新建第二套客户端）。
 */
export type PlannerChatChannel = {
  /** 纯本地可用性读数；`available: false` 时一次网络都不发 */
  status(): { available: boolean; missing: readonly string[]; model: string | null };
  /** 一次补全；`timeoutMs` 是这一趟自己的覆盖值（§3.1：不抬通道缺省） */
  complete(request: {
    messages: Array<{ role: 'system' | 'user'; content: string }>;
    maxTokens?: number | null;
    temperature?: number | null;
    timeoutMs?: number | null;
  }): Promise<{ text: string; promptTokens: number | null; completionTokens: number | null }>;
};

/** 计划器这一趟的参数：超时按「这一趟」给，温度压低求稳定。 */
export type LlmPlannerConfig = {
  /** 单次请求超时（毫秒），随请求递给 `llm.chat` 的 `timeoutMs` */
  timeoutMs: number;
  /** 回复上限；一份计划就是几段 JSON，不需要生成通道那种档位 */
  maxTokens: number;
  /** 采样温度：计划要可复现，压到接近贪心 */
  temperature: number;
};

/** 计划器回复里最多认多少步：与 `agentLoopSchema.stepLimit` 的上限同量级，多出来的整份不成立。 */
const MAX_PLAN_STEPS = 50;

/** 一句观察摘要最多留多少字（与循环侧的 `OBSERVATION_TEXT_CAP` 同口径，避免摘要比观察还长）。 */
const MAX_SUMMARY_CHARS = 200;

/**
 * 去掉模型常见的代码围栏（```json … ```）。
 * @param text 模型回复原文
 * @returns 去围栏并去首尾空白后的文本
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[A-Za-z]*\s*\n([\s\S]*?)\n?```$/u.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

/**
 * 把模型回复收成步序列（严格 JSON + 注册表核对）。
 * @param text 模型回复原文（可能带代码围栏）
 * @param knownToolIds 注册表现读的工具 id
 * @returns 步序列；空数组是合法结局（循环会落 `PLAN_EMPTY`）
 * @throws `AGENT_PLANNER_INVALID_JSON`（不是 JSON / 结构不对）、`AGENT_PLANNER_UNKNOWN_TOOL`（点了清单外的手）
 */
export function parsePlanJson(text: string, knownToolIds: readonly string[]): PlanStepDraft[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stripCodeFence(text));
  } catch {
    throw new AppError('AGENT_PLANNER_INVALID_JSON', '计划器回复不是合法 JSON', 'agent.loop', {
      head: text.slice(0, 200),
    });
  }
  const rawSteps = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as { steps?: unknown }).steps)
      ? (payload as { steps: unknown[] }).steps
      : null;
  if (rawSteps === null || rawSteps.length > MAX_PLAN_STEPS) {
    throw new AppError(
      'AGENT_PLANNER_INVALID_JSON',
      `计划器回复的形状不对：要 {"steps":[...]}（步数不超过 ${String(MAX_PLAN_STEPS)}）`,
      'agent.loop',
    );
  }
  const known = new Set(knownToolIds);
  return rawSteps.map((entry, index) => {
    const step = entry as { toolId?: unknown; intent?: unknown; input?: unknown };
    if (typeof step.toolId !== 'string' || step.toolId.length === 0 || typeof step.intent !== 'string') {
      throw new AppError(
        'AGENT_PLANNER_INVALID_JSON',
        `计划第 ${String(index + 1)} 步缺 toolId 或 intent（两者都必须是字符串）`,
        'agent.loop',
        { index },
      );
    }
    if (!known.has(step.toolId)) {
      throw new AppError(
        'AGENT_PLANNER_UNKNOWN_TOOL',
        `计划第 ${String(index + 1)} 步点了不在工具面上的一只手：${step.toolId}`,
        'agent.loop',
        { index, toolId: step.toolId },
      );
    }
    return { toolId: step.toolId, intent: step.intent, input: step.input ?? {} };
  });
}

export class LlmLoopModel implements LoopModel {
  /**
   * @param channel 每次调用**现取**通道的解析器：改配置会重建上游服务，存一份实例会静默变空
   *   （AGENTS.md §9 的 2.5 实测）；读不到返回 `null`
   * @param config 这一条通道的超时、回复上限与温度
   */
  constructor(
    private readonly channel: () => PlannerChatChannel | null,
    private readonly config: LlmPlannerConfig,
  ) {}

  /**
   * 取一次可用的通道；未配置时抛 `AGENT_PLANNER_UNAVAILABLE`（且一次网络都不发）。
   * @returns 已确认可用的通道
   */
  private requireChannel(): PlannerChatChannel {
    const channel = this.channel();
    if (!channel) {
      throw new AppError(
        'AGENT_PLANNER_UNAVAILABLE',
        '计划器通道未挂载（装配里没有 llm 服务）：这一条任务不能起草计划',
        'agent.loop',
      );
    }
    const status = channel.status();
    if (!status.available) {
      throw new AppError(
        'AGENT_PLANNER_UNAVAILABLE',
        `模型通道未配置，缺 ${status.missing.join(' / ')}：先在「信任」工作台里配齐对话通道`,
        'agent.loop',
        { missing: status.missing },
      );
    }
    return channel;
  }

  /**
   * 起草计划：一次对话补全 + 严格 JSON 收窄。
   * @param request 目标、档位、工具面与上下文（上下文里的「在线简历」由循环取材后递进来）
   * @returns 步序列与用量（对端没回报 token 时按字数粗估）
   * @throws `AGENT_PLANNER_UNAVAILABLE` / `AGENT_PLANNER_REQUEST_FAILED` / `AGENT_PLANNER_INVALID_JSON` /
   *   `AGENT_PLANNER_UNKNOWN_TOOL`
   */
  async draftPlan(request: PlanDraftRequest): Promise<PlanDraftResult> {
    const channel = this.requireChannel();
    const messages = buildPlanMessages(request);
    let text: string;
    let promptTokens: number | null;
    let completionTokens: number | null;
    try {
      const reply = await channel.complete({
        messages,
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
        timeoutMs: this.config.timeoutMs,
      });
      text = reply.text;
      promptTokens = reply.promptTokens;
      completionTokens = reply.completionTokens;
    } catch (error) {
      throw new AppError(
        'AGENT_PLANNER_REQUEST_FAILED',
        `计划器请求失败：${error instanceof Error ? error.message : String(error)}`,
        'agent.loop',
        error instanceof AppError ? { cause: error.code } : {},
      );
    }
    const steps = parsePlanJson(text, request.knownToolIds);
    return {
      steps,
      usage: {
        inputTokens: promptTokens ?? estimateTokens(messages.map((message) => message.content).join('\n')),
        outputTokens: completionTokens ?? estimateTokens(text),
      },
    };
  }

  /**
   * 把一步的观察收成一句回报（模型不可用时抛给循环，由循环记一句如实的话，不谎报成功）。
   * @param request 该步读数与状态
   * @returns 文案与用量
   * @throws `AGENT_PLANNER_UNAVAILABLE` / `AGENT_PLANNER_REQUEST_FAILED`
   */
  async summarizeObservation(request: ObservationRequest): Promise<ObservationResult> {
    const channel = this.requireChannel();
    const messages = buildObservationMessages(request);
    try {
      const reply = await channel.complete({
        messages,
        maxTokens: 200,
        temperature: 0.2,
        timeoutMs: this.config.timeoutMs,
      });
      const text = reply.text.trim().slice(0, MAX_SUMMARY_CHARS);
      return {
        text,
        usage: {
          inputTokens: reply.promptTokens ?? estimateTokens(messages.map((message) => message.content).join('\n')),
          outputTokens: reply.completionTokens ?? estimateTokens(text),
        },
      };
    } catch (error) {
      throw new AppError(
        'AGENT_PLANNER_REQUEST_FAILED',
        `观察摘要请求失败：${error instanceof Error ? error.message : String(error)}`,
        'agent.loop',
        error instanceof AppError ? { cause: error.code } : {},
      );
    }
  }
}
