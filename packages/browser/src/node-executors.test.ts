/**
 * `browser.*` 节点族用例（spec 5.12-04 / 05 / 06）。
 *
 * 重点在**动作到底有没有被派发出去**：每一条拒执行都必须断言动作通道的调用次数为 0，
 * 抛个错就收工不算数——工作流是最容易把闸门绕开的一条新通道（plan §7.10.1 第四节），
 * 所以「拒」在本文件里的定义是「页面一个字节都没动」。
 *
 * 「判分不在本文件」这条不靠注释保证：定位替身一律按声明原样回读，任何一条用例都断言
 * 派给它的 `LocateSpec` 与节点声明逐位相等（通道那一档除外，它是派生的）。
 */
import { AppError, Context, Service, type Context as Ctx, type Fiber, type WorkflowNodeSpec } from '@auto-cc/core';
import type { LocateSpec, QuotaAction } from '@auto-cc/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BrowserNodeService, BROWSER_CLICK_KIND, BROWSER_NAVIGATE_KIND, BROWSER_TYPE_KIND } from './node-executors.js';

const fibers: Fiber[] = [];
afterEach(async () => {
  while (fibers.length) await fibers.pop()?.dispose();
});

const fakeConfig = z.strictObject({});
type FakeConfig = z.infer<typeof fakeConfig>;

/** 动作通道替身：只记「被叫了几次、拿到的是什么」，不给它真的派发能力。 */
class FakeActService extends Service {
  static provide = 'browser.act';
  static Config = fakeConfig;
  constructor(ctx: Ctx, _options: FakeConfig) {
    super(ctx, 'browser.act');
  }
  clicks: LocateSpec[] = [];
  typed: { spec: LocateSpec; text: string }[] = [];
  /** 定位替身要抛的错（模拟 `decideLocate` 判不过线）：null = 不抛。 */
  locateFailure: Error | null = null;

  private account(): void {
    if (this.locateFailure) throw this.locateFailure;
  }

  click = (spec: LocateSpec): Promise<{ status: string }> => {
    this.account();
    this.clicks.push(spec);
    return Promise.resolve({ status: 'done' });
  };

  type = (spec: LocateSpec, text: string): Promise<{ status: string }> => {
    this.account();
    this.typed.push({ spec, text });
    return Promise.resolve({ status: 'done' });
  };
}

/** 页面替身：只记导航地址。 */
class FakePageService extends Service {
  static provide = 'browser.page';
  static Config = fakeConfig;
  constructor(ctx: Ctx, _options: FakeConfig) {
    super(ctx, 'browser.page');
  }
  visited: string[] = [];
  navigate = (url: string): Promise<void> => {
    this.visited.push(url);
    return Promise.resolve();
  };
}

/** 登记处替身：只回答「登记进来没有 / 摘掉没有」。 */
class FakeExecutorRegistryService extends Service {
  static provide = 'workflow.executors';
  static Config = fakeConfig;
  constructor(ctx: Ctx, _options: FakeConfig) {
    super(ctx, 'workflow.executors');
  }
  private readonly table = new Map<string, (invocation: unknown) => Promise<unknown>>();
  register = (kind: string, executor: (invocation: unknown) => Promise<unknown>): void => {
    this.table.set(kind, executor);
  };
  unregister = (kind: string): boolean => this.table.delete(kind);
  resolve = (kind: string) => this.table.get(kind) ?? null;
  list = (): string[] => [...this.table.keys()];
}

/**
 * 闸门替身：`perform` 判定不过就**不调 task**——这一条正是真闸门的性质
 * （`packages/entitlement/src/gate.ts:141-143`），替身必须照抄，否则用例测的是替身的宽松。
 */
class FakeGateService extends Service {
  static provide = 'entitlement.gate';
  static Config = z.strictObject({ remaining: z.number().default(3) });
  constructor(
    ctx: Ctx,
    private readonly config: { remaining: number },
  ) {
    super(ctx, 'entitlement.gate');
  }
  performed: { action: string; targetId?: string; workflowRunId?: string }[] = [];
  /** 额度到量后 `perform` 拒绝，形状与真闸门一致。 */
  perform = async <T>(
    action: QuotaAction,
    context: { targetId?: string; workflowRunId?: string },
    task: () => Promise<T>,
  ): Promise<{ value: T; ledgerId: number }> => {
    if (this.config.remaining <= 0) {
      throw new AppError('QUOTA_EXCEEDED', `额度已用完`, 'entitlement.gate', { action });
    }
    this.performed.push({ action, ...context });
    return { value: await task(), ledgerId: this.performed.length };
  };
}

/** 节点声明的默认形状：只读 + 一条定位声明。 */
function readonlyClick(overrides: Record<string, unknown> = {}): WorkflowNodeSpec {
  return {
    id: 'greet-button',
    kind: BROWSER_CLICK_KIND,
    target: 'boss-greet',
    params: {},
    effect: 'read' as const,
    retryTimes: null,
    requiresHuman: false,
    locate: {
      description: '打招呼按钮',
      cardinality: 'single' as const,
      candidates: [{ strategy: 'testId' as const, attribute: 'data-testid', value: 'greet' }],
    },
    ...overrides,
  };
}

/** 起一套「动作替身 + 页面替身 + 登记处替身（+ 可选闸门）」。 */
async function boot(withGate = true) {
  const ctx = new Context();
  fibers.push(
    await ctx.plugin(FakeActService, {}),
    await ctx.plugin(FakePageService, {}),
    await ctx.plugin(FakeExecutorRegistryService, {}),
  );
  if (withGate) fibers.push(await ctx.plugin(FakeGateService, { remaining: 3 }));
  fibers.push(await ctx.plugin(BrowserNodeService, {}));
  return {
    act: ctx.get('browser.act') as unknown as FakeActService,
    page: ctx.get('browser.page') as unknown as FakePageService,
    registry: ctx.get('workflow.executors') as unknown as FakeExecutorRegistryService,
    gate: withGate ? (ctx.get('entitlement.gate') as unknown as FakeGateService) : null,
  };
}

/** 按登记表派一次执行器。 */
async function run(
  registry: FakeExecutorRegistryService,
  kind: string,
  spec: ReturnType<typeof readonlyClick>,
  signal = new AbortController().signal,
): Promise<unknown> {
  const executor = registry.resolve(kind);
  if (!executor) throw new Error(`执行器 ${kind} 没登记`);
  return executor({ runId: 'run-1', spec, attempt: 1, signal });
}

describe('browser.* 节点族：登记与派发（spec 5.12-04）', () => {
  it('三种 kind 登记进来，卸载时摘掉', async () => {
    const { registry } = await boot();
    expect(registry.list().sort()).toEqual([BROWSER_CLICK_KIND, BROWSER_NAVIGATE_KIND, BROWSER_TYPE_KIND].sort());
    const fiber = fibers.pop();
    await fiber?.dispose();
    expect(registry.list()).toEqual([]);
  });

  it('只读格子按声明原样派发定位——节点不改一个字节', async () => {
    const { registry, act } = await boot();
    await run(registry, BROWSER_CLICK_KIND, readonlyClick());
    expect(act.clicks).toEqual([
      {
        description: '打招呼按钮',
        cardinality: 'single',
        candidates: [{ strategy: 'testId', attribute: 'data-testid', value: 'greet' }],
        effect: 'read',
      },
    ]);
  });

  it('输入格子把 params.text 一并递下去', async () => {
    const { registry, act } = await boot();
    await run(registry, BROWSER_TYPE_KIND, readonlyClick({ kind: BROWSER_TYPE_KIND, params: { text: '你好' } }));
    expect(act.typed).toHaveLength(1);
    expect(act.typed[0]?.text).toBe('你好');
    expect(act.typed[0]?.spec.candidates).toEqual([{ strategy: 'testId', attribute: 'data-testid', value: 'greet' }]);
  });

  it('导航格子走 browser.page，不是动作通道', async () => {
    const { registry, page, act } = await boot();
    await run(registry, BROWSER_NAVIGATE_KIND, {
      ...readonlyClick({ kind: BROWSER_NAVIGATE_KIND }),
      params: { url: 'https://example.test/jobs' },
    });
    expect(page.visited).toEqual(['https://example.test/jobs']);
    expect(act.clicks).toEqual([]);
  });

  it('没声明定位的格子在动手之前就拒', async () => {
    const { registry, act } = await boot();
    await expect(run(registry, BROWSER_CLICK_KIND, readonlyClick({ locate: undefined }))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(act.clicks).toEqual([]);
  });

  it('只读格子带着 quota 参数：拒——它不过闸门也不落账，误认比多查一道更贵', async () => {
    const { registry, act, gate } = await boot();
    await expect(
      run(registry, BROWSER_CLICK_KIND, readonlyClick({ params: { quota: 'greet' } })),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(act.clicks).toEqual([]);
    expect(gate?.performed).toEqual([]);
  });
});

describe('browser.* 节点族：外发型必过闸门（spec 5.12-05）', () => {
  const OUTBOUND = {
    effect: 'outbound' as const,
    params: { quota: 'greet' },
    successConditions: [{ kind: 'effectObserved' as const }],
  };

  it('放行时动作在闸门的 task 里派发，且账记到这一格', async () => {
    const { registry, act, gate } = await boot();
    await run(registry, BROWSER_CLICK_KIND, readonlyClick(OUTBOUND));
    expect(act.clicks).toHaveLength(1);
    expect(gate?.performed).toEqual([{ action: 'greet', targetId: 'boss-greet', workflowRunId: 'run-1' }]);
  });

  it('定位通道档位由节点的 effect 派生，不许节点自称', async () => {
    const { registry, act } = await boot();
    await run(registry, BROWSER_CLICK_KIND, readonlyClick(OUTBOUND));
    // `LocateSpec.effect` 在 `WorkflowNodeLocate` 里根本不存在（Pick 掉了），所以这一档只能是派生的。
    expect(act.clicks[0]?.effect).toBe('outbound');
  });

  it('缺 quota 声明：拒，动作一个字节都没动', async () => {
    const { registry, act, gate } = await boot();
    await expect(run(registry, BROWSER_CLICK_KIND, readonlyClick({ ...OUTBOUND, params: {} }))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(act.clicks).toEqual([]);
    expect(gate?.performed).toEqual([]);
  });

  it('quota 不在闸门认得的那三个名字里：拒，且连闸门都没走到', async () => {
    const { registry, act, gate } = await boot();
    await expect(
      run(registry, BROWSER_CLICK_KIND, readonlyClick({ ...OUTBOUND, params: { quota: 'say-hi' } })),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(act.clicks).toEqual([]);
    expect(gate?.performed).toEqual([]);
  });

  it('闸门没挂载：拒，动作一个字节都没动', async () => {
    const { registry, act } = await boot(false);
    await expect(run(registry, BROWSER_CLICK_KIND, readonlyClick(OUTBOUND))).rejects.toMatchObject({
      code: 'SERVICE_NOT_FOUND',
    });
    expect(act.clicks).toEqual([]);
  });

  it('额度到量：闸门不调 task，于是动作一个字节都没动', async () => {
    const ctx = new Context();
    fibers.push(
      await ctx.plugin(FakeActService, {}),
      await ctx.plugin(FakePageService, {}),
      await ctx.plugin(FakeExecutorRegistryService, {}),
      await ctx.plugin(FakeGateService, { remaining: 0 }),
      await ctx.plugin(BrowserNodeService, {}),
    );
    const act = ctx.get('browser.act') as unknown as FakeActService;
    const registry = ctx.get('workflow.executors') as unknown as FakeExecutorRegistryService;
    await expect(run(registry, BROWSER_CLICK_KIND, readonlyClick(OUTBOUND))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    expect(act.clicks).toEqual([]);
  });
});

describe('browser.* 节点族：成功判据与定位判定（spec 5.12-06 / 04）', () => {
  it('外发型格子没有成功判据：拒——动作回成功不等于落地（spec 8.4-05）', async () => {
    const { registry, act } = await boot();
    await expect(
      run(registry, BROWSER_CLICK_KIND, {
        ...readonlyClick({ effect: 'outbound', params: { quota: 'greet' } }),
        successConditions: undefined,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(act.clicks).toEqual([]);
  });

  it('定位判定不在本族里做：判不过线就如实失败，且不自行放行', async () => {
    const { registry, act } = await boot();
    act.locateFailure = new AppError('LOCATE_FAILED', '定位未过线，动作没有执行：与次优候选只差 3 分', 'browser.act', {
      status: 'ambiguous',
    });
    await expect(run(registry, BROWSER_CLICK_KIND, readonlyClick())).rejects.toMatchObject({ code: 'LOCATE_FAILED' });
    expect(act.clicks).toEqual([]);
  });

  it('判据原文原样透出：这一族不重写定位给的结论（not-found 与 ambiguous 同理）', async () => {
    const { registry, act } = await boot();
    act.locateFailure = new AppError('LOCATE_FAILED', '定位未过线，动作没有执行：页面上没有这种东西', 'browser.act', {
      status: 'not-found',
    });
    // 报错正文逐字来自判定那一侧：本族若自己判分或自己兜底，失败原因就会换成另一句话。
    await expect(run(registry, BROWSER_CLICK_KIND, readonlyClick())).rejects.toThrowError(
      '定位未过线，动作没有执行：页面上没有这种东西',
    );
    expect(act.clicks).toEqual([]);
  });

  it('动手之前已被暂停：拒，不把动作派出去', async () => {
    const { registry, act } = await boot();
    const aborted = new AbortController();
    aborted.abort();
    await expect(run(registry, BROWSER_CLICK_KIND, readonlyClick(), aborted.signal)).rejects.toMatchObject({
      code: 'WORKFLOW_STEP_FAILED',
    });
    expect(act.clicks).toEqual([]);
  });
});
