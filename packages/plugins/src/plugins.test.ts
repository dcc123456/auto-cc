/**
 * `plugins` 策略层测试（spec 1.5-01 / 1.5-02 / 1.5-06 / 1.5-07 / 1.5-08 的策略侧）。
 *
 * 内核侧（`packages/kernel/src/lifecycle.test.ts`）验的是 fiber 机制：卸载会不会回收 effect、
 * 重新挂载能不能拿到新实例。这里验的是**闸门与视图**：哪些插件停不得、错误怎么攒、
 * 反复启停后指标还回不回得来。跑真上下文的原因和内核测试一样——闸门要和真的挂载状态对得上。
 */
import { Context, Service } from '@auto-cc/core';
import { KernelService, type Registry } from '@auto-cc/plugin-kernel';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import { PluginsService } from './index.js';

const seen: string[] = [];

class DemoService extends Service {
  static provide = 'demo';
  static Config = z.strictObject({
    greeting: z.string().default('hi'),
    level: z.enum(['debug', 'info']).default('info'),
  });

  constructor(ctx: Context) {
    super(ctx, 'demo');
    seen.push(String(ctx.fiber.config['greeting']));
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

const REGISTRY: Registry = { demo: DemoService, boom: BoomService, plugins: PluginsService };

const rootDir = mkdtempSync(join(tmpdir(), 'auto-cc-plugins-'));

/**
 * 清单把 `boom` 排在最前：它构造即失败，正好同时检查两件事——`plugins` 不会被兄弟插件连累
 * （它只 inject `kernel`），以及挂载时能不能从快照把已经错过的错误补进历史。
 */
async function mount(pluginsConfig: Record<string, unknown> = {}): Promise<{ ctx: Context; plugins: PluginsService }> {
  seen.length = 0;
  const config = Object.entries(pluginsConfig).map(([key, value]) => `      ${key}: ${String(JSON.stringify(value))}`);
  writeFileSync(
    join(rootDir, 'cordis.yml'),
    `plugins:
  - id: boom
  - id: demo
    config:
      greeting: hi
  - id: plugins
${config.length ? `    config:\n${config.join('\n')}\n` : ''}`,
    'utf8',
  );
  const ctx = new Context();
  await ctx.plugin(KernelService, { manifest: 'cordis.yml', rootDir, runtime: {}, registry: REGISTRY });
  const plugins = ctx.get('plugins') as PluginsService;
  onTestFinished(async () => {
    await (ctx.get('kernel') as KernelService).reload();
  });
  return { ctx, plugins };
}

describe('插件管理策略层', () => {
  it('闸门只拦卸载，不拦启动：受保护插件停不掉，其它插件照停（spec 1.5-02）', async () => {
    const { ctx, plugins } = await mount();
    expect(plugins.status().guarded).toEqual(['kernel', 'ipc', 'plugins']);

    await expect(plugins.stop('kernel')).rejects.toMatchObject({ code: 'PLUGIN_FAILED', path: 'plugins.stop' });
    await expect(plugins.stop('plugins')).rejects.toMatchObject({ code: 'PLUGIN_FAILED' });
    // 闸门在机制层之前：内核的 fiber 一个都不该被摘掉，否则「停掉网关」会连这次调用的答复都发不出去。
    expect(ctx.get('kernel')).toBeDefined();
    await expect(plugins.cycle('kernel')).rejects.toMatchObject({ code: 'PLUGIN_FAILED', path: 'plugins.cycle' });

    expect((await plugins.stop('demo')).state).toBe('disposed');
    // 启动不设闸：把一个受保护插件重新挂上永远是安全的，所以 start 不查 guarded。
    expect((await plugins.start('demo')).state).toBe('active');
    expect(ctx.get('demo')).toBeInstanceOf(DemoService);
  });

  it('状态视图给出指标、闸门与错误历史（spec 1.5-01 / 1.5-07）', async () => {
    const { plugins } = await mount();
    const status = plugins.status();

    expect(status.metrics.registrySize).toBeGreaterThan(0);
    expect(status.metrics.effects.map((item) => item.id)).toContain('demo');
    expect(status.metrics.activeResources).toBeGreaterThan(0);

    // 挂载之前就已经失败过的插件靠快照补历史——错过的那次一次性事件不能假装没发生。
    expect(status.errorCount).toBe(1);
    expect(status.errors[0]).toMatchObject({ id: 'boom', message: expect.stringContaining('构造器炸了') });
    expect(status.errors[0]?.stack).toContain('BoomService');
  });

  it('错误历史有界且新的在前（spec 1.5-07）', async () => {
    const { plugins } = await mount({ history: 2 });
    expect(plugins.status().errorCount).toBe(1);

    // 构造即失败的插件走「再挂一次、再炸一次」而不是抛异常：spec 1.5-05 要求单个插件炸
    // 只让它自己 FAILED，错误经快照与历史到达面板，不占用异常通道。
    expect((await plugins.saveConfig('boom', {})).state).toBe('failed');
    expect((await plugins.saveConfig('boom', {})).error).toContain('构造器炸了');

    const status = plugins.status();
    expect(status.errorCount).toBe(2);
    expect(status.errors.every((item) => item.id === 'boom')).toBe(true);
    expect(status.errors[0]!.at).toBeGreaterThanOrEqual(status.errors[1]!.at);
  });

  it('反复启停不泄漏：第二轮起指标一动不动（spec 1.5-08）', async () => {
    const { plugins } = await mount();
    // 第一批启停会让兄弟 fiber 补上一条内部 effect（实测与轮数无关：3 轮和 5 轮都只 +1），
    // 那是运行时的结构收敛而不是泄漏。判据因此看第二批——批内、批间都不许再动。
    const warm = await plugins.cycle('demo', 3);
    const report = await plugins.cycle('demo', 5);

    expect(warm.sizeDrift).toBe(0);
    // 句柄数只看「不许变多」：它是整个进程的 `getActiveResourcesInfo()`，测试运行时里
    // 别的用例的定时器也在进出，绝对值会负漂移（实测 -3），那同样不是泄漏。
    expect(warm.resourceDrift).toBeLessThanOrEqual(0);
    expect(report.rounds).toBe(5);
    expect(report.sizeDrift).toBe(0);
    expect(report.effectDrift).toBe(0);
    // 最后一轮的定时器还在事件循环里排队，所以 cycle 收尾前留了 settle 窗口。
    expect(report.resourceDrift).toBeLessThanOrEqual(0);
    expect(report.before.effectTotal).toBe(warm.after.effectTotal);
    expect(report.after.effectTotal).toBe(warm.after.effectTotal);
    expect(report.after.registrySize).toBe(warm.after.registrySize);
    // 轮次入参来自面板，越界值一律收敛到 [1, 200]，不给自测通道留一个能把自己打死的方向盘。
    expect((await plugins.cycle('demo', 0)).rounds).toBe(1);
    expect((await plugins.cycle('demo', 1000)).rounds).toBe(200);
  });

  it('配置读写透传到内核，保存后新实例拿到新值（spec 1.5-06）', async () => {
    const { ctx, plugins } = await mount();
    expect(plugins.readConfig('demo')).toEqual({
      id: 'demo',
      values: { greeting: 'hi', level: 'info' },
      mounted: true,
    });

    await plugins.saveConfig('demo', { greeting: 'yo' });
    expect(plugins.readConfig('demo').values).toEqual({ greeting: 'yo', level: 'info' });
    // 非法补丁挡在写层之前：坏键一旦落进运行时层，之后每一次解析都会失败，界面就再也修不回来。
    await expect(plugins.saveConfig('demo', { greeting: 42 })).rejects.toThrow(/greeting/);
    expect(plugins.readConfig('demo').values).toEqual({ greeting: 'yo', level: 'info' });
    await expect(plugins.saveConfig('demo', { nope: 1 })).rejects.toThrow(/nope/);

    expect(ctx.get('demo')).toBeInstanceOf(DemoService);
    // 校验通过的那一次真的换了实例：构造期记录里出现过新值，才说明配置送进去了而不是只存了层。
    expect(seen).toContain('yo');
  });
});
