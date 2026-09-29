/**
 * 插件运行时机制测试（spec 1.5-02 … 1.5-08 的内核侧）。
 *
 * 和 `kernel.test.ts` 一样跑真的 cordis 上下文：启停、依赖降级、effect 回收这些行为
 * 全部长在运行时里，mock 出来的「通过」没有意义。定时器与 effect 计数是刻意设计的
 * 可观察落点——「清理执行了」必须能被数出来，而不是靠注释宣称。
 */
import { Context, Service, type PluginState } from '@auto-cc/core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import { KernelService, type PluginNode, type Registry } from './index.js';

/** 记录 effect 回收器被调用时的实例配置，用来证明「旧实例的定时器真的被清掉了」。 */
const cleaned: string[] = [];

class TimerService extends Service {
  static provide = 'timer';
  static Config = z.strictObject({ interval: z.number().int().min(1).max(60000).default(5) });

  readonly interval: number;
  ticks = 0;

  constructor(ctx: Context, options: { interval: number }) {
    super(ctx, 'timer');
    this.interval = options.interval;
    const id = setInterval(() => {
      this.ticks += 1;
    }, this.interval);
    ctx.effect(
      () => () => {
        clearInterval(id);
        cleaned.push(`timer@${String(this.interval)}`);
      },
      'timer.tick',
    );
  }
}

/** 运行期依赖 `timer`：提供方被卸载时它应降级为 PENDING，而不是抛错（spec 1.5-04）。 */
class WatchService extends Service {
  static provide = 'watch';
  static Config = z.strictObject({});
  static inject = ['timer'];

  constructor(ctx: Context) {
    super(ctx, 'watch');
  }
}

class BoomService extends Service {
  static provide = 'boom';
  static Config = z.strictObject({});

  constructor(ctx: Context) {
    super(ctx, 'boom');
    throw new Error('构造器炸了');
  }
}

/** 只有 dir 合法才构造得起来：用来验收「把配置改对之后 FAILED 会自动回到 ACTIVE」。 */
class FragileService extends Service {
  static provide = 'fragile';
  static Config = z.strictObject({ dir: z.string().min(1) });

  readonly dir: string;

  constructor(ctx: Context, options: { dir: string }) {
    super(ctx, 'fragile');
    if (options.dir === 'bad') throw new Error('目录不可用：bad');
    this.dir = options.dir;
  }
}

const REGISTRY: Registry = {
  timer: TimerService,
  watch: WatchService,
  boom: BoomService,
  fragile: FragileService,
};

const rootDir = mkdtempSync(join(tmpdir(), 'auto-cc-lifecycle-'));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function mount(text: string): Promise<{ ctx: Context; kernel: KernelService }> {
  // 基线在这里清零，而不是 afterEach：vitest 的 onTestFinished 收尾钩子跑在 afterEach 之后，
  // 上一个测试的 `reload()` 会往 cleaned 里多推一条，让下一个测试的断言凭空多一项。
  cleaned.length = 0;
  writeFileSync(join(rootDir, 'cordis.yml'), text, 'utf8');
  const ctx = new Context();
  await ctx.plugin(KernelService, { manifest: 'cordis.yml', rootDir, runtime: {}, registry: REGISTRY });
  const kernel = ctx.get('kernel') as KernelService;
  // 收尾把全部 fiber 卸掉：定时器不留到下一个测试，vitest 也不会被挂住的句柄拖慢。
  onTestFinished(async () => {
    await kernel.reload();
  });
  return { ctx, kernel };
}

/** 轮询等状态落定：cordis 的重建是异步的，固定 sleep 要么慢要么 flaky。 */
async function waitFor(kernel: KernelService, id: string, state: PluginState): Promise<PluginNode> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const node = kernel.snapshot().find((item) => item.id === id);
    if (node && node.state === state) return node;
    if (Date.now() > deadline) throw new Error(`等待 ${id} → ${state} 超时（当前 ${node?.state ?? '无记录'}）`);
    await delay(20);
  }
}

const TREE = `
plugins:
  - id: timer
  - id: watch
    dependsOn: [timer]
`;

describe('插件卸载 / 重新挂载 / 配置热更新', () => {
  it('Stop → DISPOSED，effect 回收器被调用且定时器停走（spec 1.5-02）', async () => {
    const { ctx, kernel } = await mount(TREE);
    const timer = ctx.get('timer') as TimerService;
    const size = kernel.metrics().registrySize;
    expect(kernel.metrics().effects.find((item) => item.id === 'timer')?.effects).toBeGreaterThanOrEqual(1);
    await delay(40);
    const before = timer.ticks;
    expect(before).toBeGreaterThan(0);

    await kernel.stop('timer');

    expect(kernel.snapshot().find((item) => item.id === 'timer')?.state).toBe('disposed');
    expect(cleaned).toEqual(['timer@5']);
    expect(kernel.metrics().registrySize).toBe(size - 1);
    expect(kernel.metrics().effects.map((item) => item.id)).not.toContain('timer');
    await delay(40);
    expect(timer.ticks).toBe(before);
  });

  it('Stop 后 Start 回来，服务重新可调用（spec 1.5-03）', async () => {
    const { ctx, kernel } = await mount(TREE);
    const first = ctx.get('timer') as TimerService;
    await kernel.stop('timer');
    await kernel.start('timer');

    const second = ctx.get('timer') as TimerService;
    expect(second).toBeInstanceOf(TimerService);
    expect(second).not.toBe(first);
    expect((await waitFor(kernel, 'timer', 'active')).state).toBe('active');
    await delay(30);
    expect(second.ticks).toBeGreaterThan(0);
  });

  it('停掉提供方 → 依赖方 PENDING；恢复后 cordis 自动把它建回 ACTIVE（spec 1.5-04）', async () => {
    const { kernel } = await mount(TREE);
    await waitFor(kernel, 'watch', 'active');
    const size = kernel.metrics().registrySize;

    await kernel.stop('timer');
    await waitFor(kernel, 'watch', 'pending');

    await kernel.start('timer');
    await waitFor(kernel, 'watch', 'active');
    await waitFor(kernel, 'timer', 'active');
    expect(kernel.metrics().registrySize).toBe(size);
  });

  it('失败的插件被 Start 也只是再次 FAILED，其它插件不受牵连（spec 1.5-05）', async () => {
    const { ctx, kernel } = await mount(`
plugins:
  - id: boom
  - id: timer
`);
    const failed = await waitFor(kernel, 'boom', 'failed');
    expect(failed.error).toContain('构造器炸了');
    // 完整栈只进快照与 `plugin/error` 事件，不进日志文本（spec 1.5-07 的证据来源）。
    expect(failed.stack).toContain('BoomService');
    await waitFor(kernel, 'timer', 'active');

    await kernel.start('boom');
    expect(kernel.snapshot().find((item) => item.id === 'boom')?.state).toBe('failed');
    expect((ctx.get('timer') as TimerService).interval).toBe(5);
  });

  it('把配置改对之后 FAILED 自动回到 ACTIVE，快照不再挂着上一次的错误（spec 1.5-05 的恢复分支）', async () => {
    const { ctx, kernel } = await mount(`
plugins:
  - id: fragile
    config:
      dir: bad
`);
    const failed = await waitFor(kernel, 'fragile', 'failed');
    expect(failed.error).toContain('目录不可用');

    await kernel.applyConfig('fragile', { dir: 'ok' });

    const active = await waitFor(kernel, 'fragile', 'active');
    // 绿色态却又显示一段红色错误，是界面最容易骗人的组合：当前状态必须干净。
    expect(active.error).toBeUndefined();
    expect(active.stack).toBeUndefined();
    expect((ctx.get('fragile') as FragileService).dir).toBe('ok');
  });

  it('保存配置即时生效：update 会重新构造实例并送去新值（spec 1.5-06）', async () => {
    const { ctx, kernel } = await mount(TREE);
    const first = ctx.get('timer') as TimerService;
    expect(kernel.effectiveConfig('timer')).toEqual({ id: 'timer', values: { interval: 5 }, mounted: true });

    await kernel.applyConfig('timer', { interval: 50 });

    const second = ctx.get('timer') as TimerService;
    expect(second.interval).toBe(50);
    // 拿到的是新实例：配置生效靠的是重建插件，而不是在旧实例上偷偷改字段。
    expect(second).not.toBe(first);
    // 旧实例的 effect 回收器确实跑过，否则两个定时器会同时在走。
    expect(cleaned).toEqual(['timer@5']);
    await delay(60);
    expect(second.ticks).toBeGreaterThan(0);
  });

  it('非法配置在写入运行时层之前就被拦下（spec 1.5-06 的失败分支）', async () => {
    const { kernel } = await mount(TREE);
    await expect(kernel.applyConfig('timer', { interval: 'fast' })).rejects.toThrow(/interval/);
    // 关键点：坏值没被存进运行时层，否则之后每次解析都会失败，界面再也修不回来。
    expect(kernel.effectiveConfig('timer').values).toEqual({ interval: 5 });
    await expect(kernel.applyConfig('timer', { unknownKey: 1 })).rejects.toThrow(/unknownKey/);
    await kernel.applyConfig('timer', { interval: 20 });
    expect(kernel.effectiveConfig('timer').values).toEqual({ interval: 20 });
  });

  it('未挂载的插件保存配置只暂存，Start 时才生效（spec 1.5-06 与 1.5-02 的交界）', async () => {
    const { ctx, kernel } = await mount(TREE);
    await kernel.stop('timer');
    await kernel.applyConfig('timer', { interval: 30 });
    expect(kernel.effectiveConfig('timer').mounted).toBe(false);

    await kernel.start('timer');
    expect((ctx.get('timer') as TimerService).interval).toBe(30);
  });

  it('反复启停 20 次后 registry 与 effect 计数回到基线（spec 1.5-08 的内核侧）', async () => {
    const { kernel } = await mount(TREE);
    await waitFor(kernel, 'watch', 'active');
    const baseline = kernel.metrics();

    for (let index = 0; index < 20; index += 1) {
      await kernel.stop('timer');
      await kernel.start('timer');
    }

    const after = kernel.metrics();
    expect(after.registrySize).toBe(baseline.registrySize);
    expect(after.effectTotal).toBe(baseline.effectTotal);
    expect(cleaned).toHaveLength(20);
    await waitFor(kernel, 'watch', 'active');
  });
});
