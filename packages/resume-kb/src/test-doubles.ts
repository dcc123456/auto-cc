/**
 * `resume-kb` 的测试替身清单。
 *
 * 为什么单独一个文件而不是各测一份：`agent.tools` 这个替身在 4.2-f（`kb.profile.list`）、
 * 4.3-c（`kb.profile.search`）与 4.4-d（`kb.gap.report`）三处都要挂，同包内抄第二份就是
 * AGENTS.md §2.2 禁止的那种重复。为什么不跨包复用 `packages/browser/src/test-doubles.ts` 那份：
 * 注册表属 L3 对话插件，本包（L2）连测试都不该 import 它，而跨包共享要新建一个包（§4.3 得先记理由）——
 * 与 browser 那份文件开头记的是同一条取舍。
 *
 * `llm.chat` 的替身同理，从 4.5-b 起有了第二个消费者：4.4-b 要判「五种结局各能观测到」，
 * 4.5-b 还要判「第一轮被校验拦下 → 带违规行重试一次」，后者需要**按次给不同回复**，
 * 所以这里的回复是一张序列而不是一句常量。
 */
import {
  AppError,
  Service,
  type AgentToolDeclaration,
  type ChatCompletionView,
  type ChatRequestView,
  type Context,
} from '@auto-cc/core';
import { z } from 'zod';

/**
 * 假的 `agent.tools` 注册表：只把收到的声明存进 `Map`，不做校验也不执行。
 *
 * 用例要判的是「能力包登记了几只、契约字段对不对、`run` 打进去的是不是同一个服务」，
 * 真的注册表还带 `safeParse` 与批准流程（属 `packages/agent` 自己的判据），挂进来只会把两件事混在一起测。
 */
export class FakeAgentToolsService extends Service {
  static provide = 'agent.tools';
  static Config = z.strictObject({});

  /** 收到的声明，迭代序即登记顺序。 */
  readonly declarations = new Map<string, AgentToolDeclaration>();

  constructor(ctx: Context) {
    super(ctx, 'agent.tools');
  }

  /** 契约见 `AgentToolRegistry.register`。 */
  register<I>(tool: AgentToolDeclaration<I>): void {
    this.declarations.set(tool.id, tool);
  }

  /** 契约见 `AgentToolRegistry.unregister`。 */
  unregister(id: string): boolean {
    return this.declarations.delete(id);
  }
}

/** 假 `llm.chat` 的可调项（走 `static Config`，与真网关同一条 cordis 传参路径，见 §9 实测 1.3）。 */
const fakeChatSchema = z.strictObject({
  available: z.boolean(),
  model: z.string().nullable(),
  /**
   * 按次取用的回复序列：第一次 `complete()` 取第 0 条，之后依次往后；用尽后重复最后一条。
   * 4.4-b 只给一条（五态用例各要一句固定答案），4.5-b 给两条以走到「重试一轮」那一路。
   */
  replies: z.array(z.string()).min(1),
  fail: z.boolean(),
});

/**
 * 假的 `llm.chat`（spec 4.4-02 / 4.5-05 的单测替身，与 4.3-d 的 `FakeEmbedService` 同一种替身）。
 *
 * 只回写死的文本（可按次切换），可选地抛 `LLM_REQUEST_FAILED`；`calls` 记下每次收到的消息序列，
 * 用来断言「不可用时一次都不发」与「第二轮的提示词里确实带了违规行」。
 * 替身只在用例显式要求时才挂进装配——不挂就是真实装配里注掉 `llm` 那一行的形态（spec 4.4-02 的
 * 「装配缺包时功能照常」半边），这条判据只有分开挂才有意义。
 */
export class FakeChatService extends Service {
  static provide = 'llm.chat';
  static Config = fakeChatSchema;

  /** 每次 `complete()` 收到的消息序列（断言提示词确实带着原文与补强）。 */
  readonly calls: Array<Array<{ role: 'system' | 'user'; content: string }>> = [];

  constructor(
    ctx: Context,
    private readonly options: z.infer<typeof fakeChatSchema>,
  ) {
    super(ctx, 'llm.chat');
  }

  /** 契约见 `ChatGateway.status`。 */
  status(): { available: boolean; missing: Array<'baseUrl' | 'model' | 'apiKey'>; model: string | null } {
    if (!this.options.available) return { available: false, missing: ['baseUrl', 'model', 'apiKey'], model: null };
    return { available: true, missing: [], model: this.options.model };
  }

  /**
   * 契约见 `ChatGateway.complete`。
   * 不写成 `async`：存根里没有任何 `await` 表达式，加 `async` 只是白造一层微任务；
   * 契约要的是「返回 Promise」，失败半边用 `Promise.reject` 给的就是同一个被调用方 `catch` 住的错误。
   * 用普通方法而不是箭头属性：唯一的调用点是 `gateway.complete({...})`，`this` 由调用点绑定。
   * @param request 本次请求（只记下消息序列，不参与回复的选取）
   * @returns 下一次该给的文本；配置里要求失败时给 rejected
   */
  complete(request: ChatRequestView): Promise<ChatCompletionView> {
    this.calls.push(request.messages);
    if (this.options.fail) {
      return Promise.reject(
        new AppError('LLM_REQUEST_FAILED', '模型请求超时（测试存根）', 'llm.chat', { reason: 'timeout' }),
      );
    }
    const reply = this.options.replies[Math.min(this.calls.length - 1, this.options.replies.length - 1)] as string;
    return Promise.resolve({ text: reply, model: this.options.model ?? 'fake-model' });
  }
}
