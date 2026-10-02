/**
 * 循环向模型问的**两件事**（plan §5.2：LLM 只用于生成计划草案、把观察摘要成回报文案）。
 *
 * 端口长这样而不是一个 `complete(prompt)` 大口袋，是为了让 5.2-07 判得准：
 * 「这一步能不能执行」在这两条口上根本没有出现——模型没有一条可以表态的通道，
 * 于是它写多少句「已授权继续」都改变不了判定（判定长在 `agent.policy`）。
 *
 * 本文件只带确定性桩（spec 5.2-01）。真模型不在 5.2 接：出网打外部模型服务要花钱，
 * 且必须用户单独授权（AGENTS.md §8 与本计划 plan §7.2 的「5.2 不做的事」）。
 */
import type { AgentPlanStepView, AutonomyLevel } from '@auto-cc/core';
import { findNamedTools } from '../tool-request.js';

/** 一次模型调用的用量（桩按字数粗估，真模型接进来时换成它返回的 usage）。 */
export type ModelUsage = { inputTokens: number; outputTokens: number };

/** 模型草案里的一步——`toolId` 与 `input` 都是**不可信输入**，注册表与策略各收一次窄。 */
export type PlanStepDraft = { toolId: string; input: unknown; intent: string };

/**
 * 递给模型的上下文：引用 + 摘要文本。
 *
 * `refs` 是「模型看到的每一条信息来自哪一步」的凭据（spec 5.2-06 判的就是这一位与 `text` 的对应），
 * `text` 是循环自己拼出来的有界摘要——页面正文只以引用与摘要出现，整页 HTML 从不进 prompt。
 */
export type ModelContext = { refs: string[]; text: string };

/** 起草计划的请求（首次起草与撞墙后的续推共用这一条口）。 */
export type PlanDraftRequest = {
  /** 用户原文 */
  goal: string;
  /** 起草时的档位快照，只进 prompt 供模型措辞，不参与判定 */
  tier: AutonomyLevel;
  /** 注册表现读的工具 id 清单：桩只从这里取材，绝不凭措辞造一只没登记的手 */
  knownToolIds: readonly string[];
  context: ModelContext;
};

/** 起草结果：步序列 + 用量（用量进 5.2-11 的 token 上限账）。 */
export type PlanDraftResult = { steps: PlanStepDraft[]; usage: ModelUsage };

/** 把一步的观察收成回报文案的请求。 */
export type ObservationRequest = {
  step: AgentPlanStepView;
  /** 注册表/工具交回的原文（成功是 `ToolResult.summary`，失败是 code + message） */
  reading: string;
  /** 这一步的状态文本（`ok` / `failed` / `refused`） */
  outcome: string;
  context: ModelContext;
};

/** 观察摘要结果。 */
export type ObservationResult = { text: string; usage: ModelUsage };

/**
 * 循环消费模型的唯一端口。
 *
 * 只有两个方法：`draftPlan` 与 `summarizeObservation`。循环不许再要第三条（例如「问模型这步可否执行」），
 * 那是 5.2-07 的结构性保证——权限判定与模型之间没有接口，就不是「模型说了不算」这句口头承诺。
 */
export interface LoopModel {
  /**
   * 起草一份计划。
   * @param request 目标原文、档位、可用工具清单与已有上下文
   * @returns 步序列与用量；实现抛错时循环把 run 记为 `failed`（不许当成「没有下一步」而谎报收尾）
   */
  draftPlan(request: PlanDraftRequest): Promise<PlanDraftResult>;
  /**
   * 把一步的观察收成一句回报文案。
   * @param request 该步的读数与状态
   * @returns 文案与用量
   */
  summarizeObservation(request: ObservationRequest): Promise<ObservationResult>;
}

/**
 * 粗估 token 数：中文按 2 字≈1 token。
 *
 * 这条口径写在桩这一侧而不是循环里，是为了 5.2-11 的断言不会被误读成「精确计数」——
 * 上限判据要的是「有两条都会停的闸」，不是tokenizer 与某家模型对齐。
 * @param text 要估的文本
 * @returns 至少 1 的估算值（空串也记 1，免得「一次调用零成本」把上限算穿）
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 2));
}

/**
 * 确定性桩模型（spec 5.2-01 的主角）。
 *
 * 无随机、无时钟、无网络，取材只有一条规则：从目标原文里找出被**逐字点名**的已注册工具
 * （`findNamedTools`），一步一只，顺序即文本里的出现顺序。这就是「可脚本化」的落点——
 * **输入即脚本**，同一段文本永远得到同一份计划，测试与截图都靠这一点复现。
 * 刻意不给测试留「往模型里塞队列」的口子：那等于在生产 surface 上开一条后门，
 * 而且没人调用它就是死口（AGENTS.md §2.4）。
 *
 * 这条规则也刻意不做任何意图猜测——「帮我找前端岗位」到桩这里不会变成 `jd.capture.run`，
 * 因为那要在 agent 层写业务映射（plan §8 第一条禁止）。
 */
export class StubLoopModel implements LoopModel {
  /**
   * 起草计划：按文本里点名的手出步序列。
   * @param request 见 `LoopModel.draftPlan`
   * @returns 步序列与按字数粗估的用量
   */
  draftPlan(request: PlanDraftRequest): Promise<PlanDraftResult> {
    const steps = this.stepsFromNaming(request);
    const rendered = JSON.stringify(steps.map((step) => ({ toolId: step.toolId, intent: step.intent })));
    return Promise.resolve({
      steps,
      usage: {
        inputTokens: estimateTokens(request.goal + request.context.text),
        outputTokens: estimateTokens(rendered),
      },
    });
  }

  /**
   * 把观察收成一句文案（桩的措辞是模板，不含工具正文）。
   * @param request 见 `LoopModel.summarizeObservation`
   * @returns 形如「第 2 步 kb.profile.search → failed：…」的读数
   */
  summarizeObservation(request: ObservationRequest): Promise<ObservationResult> {
    const text = `第 ${String(request.step.planStepIndex + 1)} 步 ${request.step.toolId} → ${request.outcome}：${request.reading}`;
    return Promise.resolve({
      text,
      usage: {
        inputTokens: estimateTokens(request.reading + request.context.text),
        outputTokens: estimateTokens(text),
      },
    });
  }

  /**
   * 点名取材：文本里逐字出现的已注册工具即一步。
   * @param request 起草请求
   * @returns 步序列；一个都没点名时为空序列（循环因此如实收尾并说明「桩没被指定做什么」，不硬凑一步）
   */
  private stepsFromNaming(request: PlanDraftRequest): PlanStepDraft[] {
    return findNamedTools(request.goal, request.knownToolIds).map((named, index) => ({
      toolId: named.toolId,
      input: named.input,
      intent: `按消息里点名的第 ${String(index + 1)} 只手执行`,
    }));
  }
}
