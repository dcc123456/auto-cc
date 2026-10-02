/**
 * `resume-kb` 的测试替身清单。
 *
 * 为什么单独一个文件而不是各测一份：`agent.tools` 这个替身在 4.2-f（`kb.profile.list`）、
 * 4.3-c（`kb.profile.search`）与 4.4-d（`kb.gap.report`）三处都要挂，同包内抄第二份就是
 * AGENTS.md §2.2 禁止的那种重复。为什么不跨包复用 `packages/browser/src/test-doubles.ts` 那份：
 * 注册表属 L3 对话插件，本包（L2）连测试都不该 import 它，而跨包共享要新建一个包（§4.3 得先记理由）——
 * 与 browser 那份文件开头记的是同一条取舍。
 */
import { Service, type AgentToolDeclaration, type Context } from '@auto-cc/core';
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
