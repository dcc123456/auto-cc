/**
 * `registerAgentTools` 的登记与摘回（spec 2.8-08）。
 *
 * 这个 helper 住在 `core` 是因为登记方（L2 能力包）与注册表（L3 的 `agent.tools`）之间只能经它通信，
 * 所以它的两条性质必须在最底层被单独断言，而不是等六个包各测一遍：
 * 1. **注册表没装时不报错也不静默**——返回 0 由调用方打进日志（1.5-03/04 的「agent 可单独摘掉」靠它）；
 * 2. **登记方销毁时摘得干净**——热改配置重建服务后，旧实例的 `run` 闭包若还悬在表里，
 *    下一次调用打到的就是一个已经销毁的实例（plan §12.13 记过的那类现场）。
 * 这里不测真注册表的行为（`list` / `call` / schema 校验由 `agent` 包的用例负责），只测这条跨层通道，
 * 外加文件末尾那一组**契约取值面**断言：副作用枚举是闸门与界面分级的唯一词表，多一个值就等于多一类工具。
 */
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Context,
  NO_CONFIG,
  Service,
  TOOL_EFFECTS,
  agentToolsOf,
  registerAgentTools,
  toolResult,
  type AgentToolDeclaration,
  type AgentToolRegistry,
  type Fiber,
} from './index.js';

const fibers: Fiber[] = [];

afterEach(async () => {
  while (fibers.length) await fibers.pop()?.dispose();
});

/**
 * 注册表的测试替身：只做「往里放、往外摘」这两件事。
 *
 * 刻意不复用真 `AgentToolsService`——那是 L3 的实现，core 不许 import 它；
 * 而本 helper 对注册表的全部诉求就是 `AgentToolRegistry` 这两只手，替身正好把契约面钉在这里。
 */
class FakeRegistryService extends Service implements AgentToolRegistry {
  static provide = 'agent.tools';
  static Config = z.strictObject({});

  /** 收到的声明，按登记顺序排列（`Map` 的迭代序即插入序）。 */
  readonly received: AgentToolDeclaration[] = [];
  /** 被摘回的 id，用来断言销毁时真的摘干净了。 */
  readonly removed: string[] = [];

  constructor(ctx: Context) {
    super(ctx, 'agent.tools');
  }

  register<I>(tool: AgentToolDeclaration<I>): void {
    this.received.push(tool);
  }

  unregister(id: string): boolean {
    this.removed.push(id);
    const index = this.received.findIndex((tool) => tool.id === id);
    if (index < 0) return false;
    this.received.splice(index, 1);
    return true;
  }
}

/** 一个只用于走通通道的假工具。
 * @param id 工具 id
 * @returns 合规声明，`run` 回自己的 id
 */
function makeTool(id: string): AgentToolDeclaration {
  return {
    id,
    titleKey: `agent.tool.labels.fake${id}`,
    description: `假工具 ${id}`,
    input: z.strictObject({}),
    effect: 'read',
    requiresConfirmation: false,
    run: () => Promise.resolve(toolResult({ id }, { summary: `假工具 ${id} 已执行`, evidenceRefs: [`fake:${id}`] })),
  };
}

/** 一个「在自己的 init 里登记两只工具」的假能力包（模拟浏览器 / 外发那六个包的形状）。 */
class FakeCapabilityService extends Service {
  static provide = 'fake.capability';
  static Config = z.strictObject({});

  /** 本次 init 实际登记的条数（helper 的返回值，用例断言它）。 */
  registeredCount = -1;

  constructor(ctx: Context) {
    super(ctx, 'fake.capability');
  }

  [Service.init](): void {
    this.registeredCount = registerAgentTools(this.ctx, [makeTool('fake.alpha'), makeTool('fake.beta')]);
  }
}

/**
 * 起一套上下文并按需挂载注册表。
 * @param withRegistry 是否先挂注册表（对应装配面板里 `agent` 在不在）
 * @returns 上下文、注册表替身（未挂时为 null），以及假能力包的 fiber
 */
async function boot(withRegistry: boolean) {
  const ctx = new Context();
  if (withRegistry) fibers.push(await ctx.plugin(FakeRegistryService, NO_CONFIG));
  const fiber = await ctx.plugin(FakeCapabilityService, NO_CONFIG);
  const capability = ctx.get('fake.capability') as unknown as FakeCapabilityService;
  return {
    ctx,
    fiber,
    capability,
    registry: withRegistry ? (ctx.get('agent.tools') as unknown as FakeRegistryService) : null,
  };
}

describe('agent 工具登记通道（spec 2.8-08）', () => {
  it('注册表没装时返回 0 且不抛：能力包照常挂载（agent 可单独摘掉的前提）', async () => {
    const { ctx, fiber, capability } = await boot(false);
    fibers.push(fiber);
    expect(capability.registeredCount).toBe(0);
    expect(agentToolsOf(ctx)).toBeUndefined();
  });

  it('注册表先挂载时按登记顺序收到声明，返回条数与清单一致', async () => {
    const { fiber, capability, registry } = await boot(true);
    fibers.push(fiber);
    expect(capability.registeredCount).toBe(2);
    expect(registry?.received.map((tool) => tool.id)).toEqual(['fake.alpha', 'fake.beta']);
    // 声明是原物递过去的（不是被复制后失去字段）：`run` 与 `effect` 都在注册表这一侧可用，
    // 而 5.1-11 之后 `run` 交回的是统一读数，摘要与证据引用也得整段原样到得了调用方。
    const first = registry?.received[0];
    expect(first?.effect).toBe('read');
    await expect(first?.run({})).resolves.toEqual({
      summary: '假工具 fake.alpha 已执行',
      value: { id: 'fake.alpha' },
      evidenceRefs: ['fake:fake.alpha'],
    });
  });

  it('登记方销毁时两只工具都摘回去：不留指向已销毁实例的闭包', async () => {
    const { fiber, registry } = await boot(true);
    expect(registry?.received).toHaveLength(2);
    await fiber.dispose();
    expect(registry?.removed).toEqual(['fake.alpha', 'fake.beta']);
    expect(registry?.received).toEqual([]);
  });

  it('注册表先被销毁时，能力包随后销毁也不报错：摘回是尽力而为，不反向拖垮卸载', async () => {
    const { fiber, registry } = await boot(true);
    const registryFiber = fibers.pop();
    await registryFiber?.dispose();
    await expect(fiber.dispose()).resolves.toBeUndefined();
    expect(registry?.removed).toEqual(['fake.alpha', 'fake.beta']);
  });
});

describe('工具契约的取值面（spec 5.1-03）', () => {
  it('副作用枚举恰好三值，顺序稳定且没有 unknown 这类兜底位', () => {
    // 这一位决定闸门与界面分级，多一个值就等于多一类工具；顺序进断言是因为界面按下标上色。
    expect(TOOL_EFFECTS).toEqual(['read', 'local-write', 'outbound']);
    expect(new Set(TOOL_EFFECTS).size).toBe(3);
    expect(TOOL_EFFECTS).not.toContain('unknown');
  });
});
