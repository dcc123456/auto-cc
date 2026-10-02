/**
 * `agent.policy`：一次任务里「这一步现在到底能不能执行」的唯一判定口（spec 5.2-02 / 07）。
 *
 * 循环的每一步都必须经过它，且它**只看三样东西**：当前档位、计划确认了没有、这只手在注册表里的真相。
 * 请求里没有 `effect` 也没有「模型说它安全」那一位——不是漏了，是刻意不给：
 * 副作用分级由判定者现读注册表（`list()` 里那份），模型的自述在这条口上根本没有入口，
 * 于是 5.2-07 要的不是「我们忽略了模型的话」，而是「模型没有一条可以表态的通道」。
 *
 * 5.2 这一片它只回答「可执行 / 不可执行 + 原因」。两类暂停（审批、补充信息）与档位提升的审计在 5.3，
 * 额度还剩多少也不在这里判——外发工具自己经 `entitlement.gate`（AGENTS.md §7.3），
 * 这里再问一次就是同一件事两套口径（§2.5）。
 */
import { Service, asApp, type AutonomyLevel, type Context, type ToolDescriptorView } from '@auto-cc/core';
import { z } from 'zod';
import type { AgentToolsService } from '../tools.js';

/**
 * 判定结果码。
 *
 * `ALLOWED` 之外全是「这一步不动」，区别只在为什么不动、由谁解除：
 * `PLAN_UNCONFIRMED` 等用户确认计划；`TIER_SUGGEST_READ_ONLY` 等档位被用户显式改；
 * `CONFIRMATION_REQUIRED` 等 5.3 的审批口；`TOOL_UNAVAILABLE` 是注册表里没有或已声明 disabled。
 */
export type PolicyCode =
  'ALLOWED' | 'PLAN_UNCONFIRMED' | 'TIER_SUGGEST_READ_ONLY' | 'CONFIRMATION_REQUIRED' | 'TOOL_UNAVAILABLE';

/** 一条判定读数：可否执行 + 码 + 要显示给人看的原话。 */
export type PolicyDecision = { canRun: boolean; code: PolicyCode; message: string };

/** 判定的输入（见文件头：刻意不含副作用与模型措辞）。 */
export type StepPermissionRequest = {
  /** 当前会话档位 */
  tier: AutonomyLevel;
  /** 这份计划是否已被用户确认（5.2-03 的前置） */
  planConfirmed: boolean;
  /** 这一步要点的那只手 */
  toolId: string;
};

/** 策略配置：5.2 无可调项，空 strictObject 与注册表/账本同一形状（装配面板里因此能单独摘掉本服务）。 */
export const agentPolicySchema = z.strictObject({});

/** 校验后的配置形状。 */
export type AgentPolicyConfig = z.output<typeof agentPolicySchema>;

export class AgentPolicyService extends Service {
  static provide = 'agent.policy';
  static Config = agentPolicySchema;
  static inject = ['agent.tools'];

  constructor(
    ctx: Context,
    private readonly config: AgentPolicyConfig,
  ) {
    super(ctx, 'agent.policy');
  }

  /** 注册表现读：不在本地存第二份工具表（AGENTS.md §9 的 2.5 实测：改配置会重建下游插件）。 */
  private get registry(): AgentToolsService {
    return asApp(this.ctx)['agent.tools'];
  }

  /**
   * 判这一步可否执行。
   * @param request 档位 + 计划是否已确认 + 工具 id
   * @returns 判定读数；**永不抛异常**——拒绝是一种正常结果，不是要把循环炸掉的错误
   */
  decide(request: StepPermissionRequest): PolicyDecision {
    if (!request.planConfirmed) {
      return {
        canRun: false,
        code: 'PLAN_UNCONFIRMED',
        message: `工具 ${request.toolId} 这一步不执行：计划尚未确认，确认前零动作是硬规定`,
      };
    }
    const descriptor = this.findDescriptor(request.toolId);
    if (!descriptor) {
      return {
        canRun: false,
        code: 'TOOL_UNAVAILABLE',
        message: `工具 ${request.toolId} 不在开放的工具面上（未登记，或已声明 disabled）`,
      };
    }
    if (request.tier === 'suggest') {
      return {
        canRun: false,
        code: 'TIER_SUGGEST_READ_ONLY',
        message: '当前档位「建议模式」只出计划不执行任何动作（要执行请由你把档位显式改掉）',
      };
    }
    // 一只自己声明要批准的手，任何档位都不替用户点头：`semi` 逐条问、`auto` 也只覆盖
    // 「不要求批准」的动作，外发在两侧都落在这里（plan §5.3：外发永远问）。
    if (descriptor.requiresConfirmation || (request.tier === 'semi' && descriptor.effect !== 'read')) {
      return {
        canRun: false,
        code: 'CONFIRMATION_REQUIRED',
        message: `这一步是「${descriptor.effect}」级动作，要先由你批准（审批通道在 5.3 接）`,
      };
    }
    return {
      canRun: true,
      code: 'ALLOWED',
      message: `档位 ${request.tier} 允许执行 ${descriptor.effect} 级的 ${descriptor.id}`,
    };
  }

  [Service.init](): void {
    this.ctx.logger.info(`自治策略判定口就绪（无可调项，配置 ${JSON.stringify(this.config)}）`);
  }

  /**
   * 按 id 现读注册表里的那份真相。
   * @param toolId 工具 id
   * @returns 描述符；不在开放面上时返回 null（`list()` 已经把 disabled 的那批滤掉，判定因此与清单同口径）
   */
  private findDescriptor(toolId: string): ToolDescriptorView | undefined {
    return this.registry.list().find((entry) => entry.id === toolId);
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'agent.policy': AgentPolicyService;
  }
}
