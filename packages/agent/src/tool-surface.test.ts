/**
 * 注册表作为「跨层登记口」的那一半（spec 2.8-08）。
 *
 * `agent.test.ts` 验的是注册表自己的行为（清单形状、schema 校验、错误码），这里验的是
 * **能力包侧的路径**：`core` 的 `agentToolsOf` / `registerAgentTools` 能不能在真注册表上跑通，
 * 以及能力包 fiber 销毁后工具是否跟着摘掉。之所以放在本包：真 `AgentToolsService` 只有这里能 import
 * （L2 不许依赖 L3），而这两条性质一旦不成立，界面上就会出现「工具清单里有、调用却未注册」的假象。
 */
import { Context, NO_CONFIG, Service, asApp, agentToolsOf, registerAgentTools, type Fiber } from '@auto-cc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentToolsService } from './tools.js';

const fibers: Fiber[] = [];

afterEach(async () => {
  while (fibers.length) await fibers.pop()?.dispose();
});

/** 一个只登记一只工具的假能力包（本包不许 import 真实能力包，1.11-14）。 */
class FakeCapabilityService extends Service {
  static provide = 'fake.capability';
  static Config = z.strictObject({});

  /** 本次 init 实际登记的条数。 */
  registeredCount = -1;

  constructor(ctx: Context) {
    super(ctx, 'fake.capability');
  }

  [Service.init](): void {
    this.registeredCount = registerAgentTools(this.ctx, [
      {
        id: 'fake.capability.run',
        description: '假能力包登记的一只工具',
        input: z.strictObject({ text: z.string().min(1) }),
        effect: 'read',
        requiresConfirmation: false,
        run: ({ text }) => Promise.resolve({ echoed: text }),
      },
    ]);
  }
}

/** 先挂真注册表、再挂假能力包，返回两侧句柄与那条 fiber（销毁用例要用）。 */
async function boot() {
  const ctx = new Context();
  fibers.push(await ctx.plugin(AgentToolsService, {}));
  const capabilityFiber = await ctx.plugin(FakeCapabilityService, NO_CONFIG);
  const capability = ctx.get('fake.capability') as unknown as FakeCapabilityService;
  return { tools: asApp(ctx)['agent.tools'], narrow: agentToolsOf(ctx), capability, capabilityFiber };
}

describe('agent.tools 的跨层登记面（spec 2.8-08）', () => {
  it('真注册表被 core 的窄面取到，登记与调用是同一条路径', async () => {
    const { tools, narrow, capability } = await boot();
    // 登记口与读面是不是同一个实例，由「登记之后 list 立刻可见」这件事自己说话（cordis 交出的是代理对象，
    // 在这里比 `===` 只会撞到代理的取值守卫上）。
    expect(typeof narrow?.register).toBe('function');
    expect(capability.registeredCount).toBe(1);
    expect(tools.list()).toEqual([
      {
        id: 'fake.capability.run',
        description: '假能力包登记的一只工具',
        effect: 'read',
        requiresConfirmation: false,
      },
    ]);
    await expect(tools.call('fake.capability.run', { text: 'hi' })).resolves.toEqual({
      ok: true,
      value: { echoed: 'hi' },
    });
  });

  it('入参不过声明里的 schema 时不进实现：登记方不需要自己再校验一遍', async () => {
    const { tools } = await boot();
    await expect(tools.call('fake.capability.run', { text: '' })).resolves.toMatchObject({
      ok: false,
      code: 'TOOL_INPUT_INVALID',
    });
  });

  it('能力包销毁后工具立刻从清单消失：不留指向已销毁实例的入口', async () => {
    const { tools, capabilityFiber } = await boot();
    expect(tools.list()).toHaveLength(1);
    await capabilityFiber.dispose();
    expect(tools.list()).toEqual([]);
    await expect(tools.call('fake.capability.run', { text: 'hi' })).resolves.toMatchObject({
      ok: false,
      code: 'TOOL_NOT_REGISTERED',
    });
  });

  it('注册表自己被重建时清单不清空：登记属于这个 app，不属于某一次挂载（spec 2.8-08）', async () => {
    // 活体实测（2.8-b 收口）抓到过一次：面板里存一次 `agent` 的配置，cordis 重建整组 fiber，
    // 表若挂在服务实例上，清单就从 9 条变成 0 条，而九只工具的主人一个都没重启。
    const ctx = new Context();
    const firstRegistry = await ctx.plugin(AgentToolsService, {});
    fibers.push(firstRegistry);
    fibers.push(await ctx.plugin(FakeCapabilityService, NO_CONFIG));
    expect(asApp(ctx)['agent.tools'].list()).toHaveLength(1);

    await firstRegistry.dispose();
    fibers.push(await ctx.plugin(AgentToolsService, {}));

    const tools = asApp(ctx)['agent.tools'];
    expect(tools.list()).toEqual([
      {
        id: 'fake.capability.run',
        description: '假能力包登记的一只工具',
        effect: 'read',
        requiresConfirmation: false,
      },
    ]);
    await expect(tools.call('fake.capability.run', { text: 'hi' })).resolves.toEqual({
      ok: true,
      value: { echoed: 'hi' },
    });
  });
});
