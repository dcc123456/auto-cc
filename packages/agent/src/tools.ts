/**
 * `agent.tools` 服务（spec 1.11-04 / 1.11-05 / 1.11-09 + 2.8-08）：工具注册表与调用协议。
 *
 * 1.11 交付的是**空表 + 定型的协议**：先把「声明长什么样」钉死，因为 master plan §1.7 第 1 条要求
 * 「工具面 = service 白名单」——没有声明的能力对 agent 既不可见也不可调用。2.8-b 起各能力包在**自己的
 * init 里**经 `core` 的 `registerAgentTools` 登记（plan §15.7 落点 1/2），本包不认识任何具体能力：
 * 表里有什么完全由装配清单决定，摘掉某个包它的工具就一起消失。
 * P2~P4 的能力（抓 JD、生成话术、打招呼、投递）只能作为工具注册进来，不能另起一条通路。
 *
 * 与主流协议的关系见 plan §8.6：`input` 用 zod（与全仓一致），`effect` / `requiresConfirmation`
 * 是本项目补的两个字段——MCP 的 annotation 规范自己声明不可信，AI SDK 的 tool() 里也没有副作用分级。
 */
import {
  AppError,
  Service,
  agentToolTable,
  type AgentToolDeclaration,
  type Context,
  type ToolCallReply,
  type ToolDescriptorView,
} from '@auto-cc/core';
import { z } from 'zod';

/**
 * 一个工具的声明式契约。
 *
 * 形状从 2.8-08 起住在 `@auto-cc/core`（`AgentToolDeclaration`）：登记方是 L2 的能力包
 * （浏览器 / 会话 / 外发 / 平台），它们不允许 import 本包（AGENTS.md §4.1 的依赖方向），
 * 而注册表与登记方必须共认同一个形状，留两份定义就是 §2.5 禁止的「两个都能用」。
 * 这里保留 `AgentTool` 这个名字，是因为本包与它的测试都在用；它是一个别名，不是第二份契约。
 * @template I schema 解析后的入参类型（默认 `unknown`，注册处收窄）
 */
export type AgentTool<I = unknown> = AgentToolDeclaration<I>;

/** 注册表暂无可配置项；strict 让 `cordis.yml` 里写错的键在挂载期就报错。 */
export const agentToolsConfigSchema = z.strictObject({});

/** 校验后的配置形状（调用点引用它，而不是手写一遍 zod 推断）。 */
export type AgentToolsConfig = z.output<typeof agentToolsConfigSchema>;

/**
 * 工具注册表：全应用唯一的 agent 能力入口。
 *
 * 它是**读面**，不是持有者：声明表按 `Context` 存在 `core`（`agentToolTable`），
 * 因为本服务会随 `agent` 的配置热改被整个重建，而九个工具的主人（L2 能力包）不会跟着重建。
 * 2.8-b 的活体实测就是这条：存在实例字段上时，面板里存一次配置就把清单从 9 条清成 0 条。
 */
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

  /** 本上下文的声明表；空表只出现在「装配清单把能力包都摘掉」时。 */
  private get table(): Map<string, AgentToolDeclaration> {
    return agentToolTable(this.ctx);
  }

  /**
   * 登记一个工具。
   * @param tool 符合协议的声明式契约
   * @throws 同 id 重复登记时以 `TOOL_DUPLICATE` 失败——两个同 id 的工具会让「白名单」失去意义
   */
  register<I>(tool: AgentTool<I>): void {
    if (this.table.has(tool.id)) {
      throw new AppError('TOOL_DUPLICATE', `工具 ${tool.id} 已注册，禁止重复登记`, 'agent.tools', {
        toolId: tool.id,
      });
    }
    // 泛型 `I` 只活在调用点：`run` 是方法式声明，因此带具体入参的声明可以直接进 `unknown` 的表，
    // 收窄由 `call` 里的 `safeParse` 在递给实现之前完成。
    this.table.set(tool.id, tool);
  }

  /**
   * 摘掉一个工具（P5 的按档位/额度收窄能力入口用，也是能力包销毁时的清理与单测构造非空表的手段）。
   * @param id 工具 id
   * @returns 是否真的摘掉了一个
   */
  unregister(id: string): boolean {
    return this.table.delete(id);
  }

  /**
   * 列举当前可见的工具元数据。
   * @returns 数组顺序即登记顺序；表里没有能力包登记的工具时为空数组（spec 1.11-04 的判据）
   */
  list(): ToolDescriptorView[] {
    return [...this.table.values()].map((tool) => ({
      id: tool.id,
      titleKey: tool.titleKey,
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
    const tool = this.table.get(toolId);
    if (!tool) {
      return {
        ok: false,
        code: 'TOOL_NOT_REGISTERED',
        message: `工具 ${toolId} 未注册（该能力包当前未挂载，或它没有把这只手登记进工具面）`,
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
    // 读数必须在挂载时现算：登记由各能力包在自己的 init 里推（spec 2.8-08），本服务先于它们就绪时
    // 这里就是 0，把「注册表就绪」写成「已登记 N 个」才不会出现 §12.13 那种骗人的空数。
    // 表是按 Context 存的，所以「被重建的那一次」读到的是既有内容，日志仍然说实话。
    this.ctx.logger.info(`工具注册表就绪：当前已登记 ${String(this.table.size)} 个工具（清单见 agent.tools.list）`);
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'agent.tools': AgentToolsService;
  }
}
