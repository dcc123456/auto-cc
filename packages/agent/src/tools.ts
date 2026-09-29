/**
 * `agent.tools` 服务（spec 1.11-04 / 1.11-05 / 1.11-09）：工具注册表与调用协议。
 *
 * P1 交付的是**空表 + 定型的协议**：注册表里一个工具都没有，任何调用都以 `TOOL_NOT_REGISTERED`
 * 失败。这不是偷懒——master plan §1.7 第 1 条要求「工具面 = service 白名单」，
 * 没有声明的能力对 agent 既不可见也不可调用，所以先把「声明长什么样」钉死，
 * P2~P4 的能力（抓 JD、生成话术、打招呼、投递）只能作为工具注册进来，不能另起一条通路。
 *
 * 与主流协议的关系见 plan §8.6：`input` 用 zod（与全仓一致），`effect` / `requiresConfirmation`
 * 是本项目补的两个字段——MCP 的 annotation 规范自己声明不可信，AI SDK 的 tool() 里也没有副作用分级。
 */
import {
  AppError,
  Service,
  type Context,
  type ToolCallReply,
  type ToolDescriptorView,
  type ToolEffect,
} from '@auto-cc/core';
import { z, type ZodType } from 'zod';

/**
 * 一个工具的声明式契约。
 *
 * P5 只往注册表里 register 这样的对象，不改本接口——这正是 1.11-05 要的「协议定型」。
 * 副作用分级（`ToolEffect`）、元数据视图（`ToolDescriptorView`）与结果联合（`ToolCallReply`）
 * 定义在 `@auto-cc/core`，因为它们要跨进程出现在工具卡片里。
 * @template I schema 解析后的入参类型（默认 `unknown`，注册处收窄）
 */
export interface AgentTool<I = unknown> {
  /** 全限定 id，约定 `域.动作`（如 `greet.send`），与 service 命名同源。 */
  readonly id: string;
  /** 给模型与界面看的一句话说明；界面卡片标题读它。 */
  readonly description: string;
  /** 入参 schema：调用前 `safeParse`，不过就 `TOOL_INPUT_INVALID`，绝不把脏值递给 `run`。 */
  readonly input: ZodType<I>;
  readonly effect: ToolEffect;
  /**
   * 是否需要用户先批准再执行。外发类工具默认 true；
   * P1 只把值存进协议，真正的批准流属 P5（plan §8.6「边界与不做」）。
   */
  readonly requiresConfirmation: boolean;
  /**
   * 实际执行。
   * @param params 已过 schema 的入参
   * @param signal 取消信号，实现必须协作式让出（与 runner 同一语义）
   * @returns 结果值，必须可 JSON 序列化（要落进消息 parts 并过 IPC）
   */
  run(params: I, signal?: AbortSignal): Promise<unknown>;
}

/**
 * 注册表内部存放的形态：把泛型 `AgentTool<I>` 收成非泛型，避免 `Map` 里塞一堆不同 `I` 的工具时
 * 出现「`ZodType<I>` 之间互不兼容」的假难题。转换只发生在 `register` 一处（见下方注释）。
 */
type StoredTool = {
  id: string;
  description: string;
  effect: ToolEffect;
  requiresConfirmation: boolean;
  input: ZodType;
  run(input: unknown, signal?: AbortSignal): Promise<unknown>;
};

/** 注册表暂无可配置项；strict 让 `cordis.yml` 里写错的键在挂载期就报错。 */
export const agentToolsConfigSchema = z.strictObject({});

/** 校验后的配置形状（调用点引用它，而不是手写一遍 zod 推断）。 */
export type AgentToolsConfig = z.output<typeof agentToolsConfigSchema>;

/** 工具注册表：全应用唯一的 agent 能力入口。 */
export class AgentToolsService extends Service {
  static provide = 'agent.tools';
  static Config = agentToolsConfigSchema;

  /**
   * @param ctx 挂载上下文
   * @param _options 校验后的配置；无配置项也要接住第二个实参（AGENTS.md §9 实测 1.3）
   */
  constructor(ctx: Context, _options: AgentToolsConfig) {
    super(ctx, 'agent.tools');
  }

  /** 已注册工具；P1 恒空。 */
  private readonly tools = new Map<string, StoredTool>();

  /**
   * 登记一个工具。
   * @param tool 符合协议的声明式契约
   * @throws 同 id 重复登记时以 `TOOL_DUPLICATE` 失败——两个同 id 的工具会让「白名单」失去意义
   */
  register<I>(tool: AgentTool<I>): void {
    if (this.tools.has(tool.id)) {
      throw new AppError('TOOL_DUPLICATE', `工具 ${tool.id} 已注册，禁止重复登记`, 'agent.tools', {
        toolId: tool.id,
      });
    }
    // 泛型 `I` 只活在注册处：schema 先解析一次，`run` 才拿得到收窄后的入参，注册表对外一律 `unknown`。
    this.tools.set(tool.id, {
      id: tool.id,
      description: tool.description,
      effect: tool.effect,
      requiresConfirmation: tool.requiresConfirmation,
      input: tool.input,
      run: (input, signal) => tool.run(input as I, signal),
    });
  }

  /**
   * 摘掉一个工具（P5 的按档位/额度收窄能力入口用，也是单测构造非空表的手段）。
   * @param id 工具 id
   * @returns 是否真的摘掉了一个
   */
  unregister(id: string): boolean {
    return this.tools.delete(id);
  }

  /**
   * 列举当前可见的工具元数据。
   * @returns 数组顺序即登记顺序；P1 恒为空数组（spec 1.11-04 的判据）
   */
  list(): ToolDescriptorView[] {
    return [...this.tools.values()].map((tool) => ({
      id: tool.id,
      description: tool.description,
      effect: tool.effect,
      requiresConfirmation: tool.requiresConfirmation,
    }));
  }

  /**
   * 调用一个工具：查表 → 校验入参 → 执行 → 原样回报。
   * @param toolId 来自渲染层的字符串，按不可信输入处理，不做任何「猜它想调什么」
   * @param rawInput 未收窄的入参值，必须过 `tool.input` 的 schema
   * @param signal 取消信号；中止后结果不再写回消息
   * @returns 成功带 `value`，失败带结构化 code 与**要显示给用户看**的一句话
   */
  async call(toolId: string, rawInput: unknown, signal?: AbortSignal): Promise<ToolCallReply> {
    const tool = this.tools.get(toolId);
    if (!tool) {
      return {
        ok: false,
        code: 'TOOL_NOT_REGISTERED',
        message: `工具 ${toolId} 未注册（P1 的 agent 工具面是空表）`,
      };
    }
    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) {
      return {
        ok: false,
        code: 'TOOL_INPUT_INVALID',
        message: `工具 ${toolId} 入参不合法：${parsed.error.issues.map((issue) => `${issue.path.join('.') || '-'} ${issue.message}`).join('；')}`,
      };
    }
    try {
      return { ok: true, value: await tool.run(parsed.data, signal) };
    } catch (error) {
      // §1.7 第 8 条：失败原样回报，禁止用「已完成」的措辞掩盖。
      return {
        ok: false,
        code: 'TOOL_FAILED',
        message: `工具 ${toolId} 执行失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  [Service.init](): void {
    this.ctx.logger.info(`工具注册表就绪：已登记 ${String(this.tools.size)} 个工具（P1 为空表）`);
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'agent.tools': AgentToolsService;
  }
}
