/**
 * 内核装配集成测试（spec 1.3-01 / 1.3-02 / 1.3-03 / 1.3-09 / 1.3-10）。
 *
 * 这里跑的是真的 cordis 上下文：清单写在临时目录里，插件是真的 Service 子类。
 * 只有真实运行时才能验证「依赖缺席 → PENDING 而不是抛错」这类从 cordis 语义里
 * 长出来的行为，用 mock 就只剩自说自话。
 */
import { Context, Service } from '@auto-cc/core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { KernelService, type PluginNode, type Registry } from './index.js';

const seen: string[] = [];

const demoSchema = z.strictObject({
  greeting: z.string().default('hi'),
  level: z.enum(['debug', 'info']).default('info'),
});

/** 记录构造期看到的配置，用来证明分层解析真的把值送进了插件。 */
class DemoService extends Service {
  static provide = 'demo';
  static Config = demoSchema;

  constructor(ctx: Context) {
    super(ctx, 'demo');
    seen.push(`${String(ctx.fiber.config['greeting'])}/${String(ctx.fiber.config['level'])}`);
  }
}

class OtherService extends Service {
  static provide = 'other';
  static Config = z.strictObject({});

  constructor(ctx: Context) {
    super(ctx, 'other');
  }
}

/** 依赖一个清单里被注掉的插件：cordis 把它留在 PENDING，`await` 立刻返回。 */
class DependentService extends Service {
  static provide = 'dependent';
  static Config = z.strictObject({});
  static inject = ['demo'];

  constructor(ctx: Context) {
    super(ctx, 'dependent');
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

const REGISTRY: Registry = {
  demo: DemoService,
  other: OtherService,
  dependent: DependentService,
  boom: BoomService,
};

const rootDir = mkdtempSync(join(tmpdir(), 'auto-cc-kernel-'));

function manifest(text: string): void {
  writeFileSync(join(rootDir, 'cordis.yml'), text, 'utf8');
}

async function mount(): Promise<KernelService> {
  const ctx = new Context();
  await ctx.plugin(KernelService, { manifest: 'cordis.yml', rootDir, runtime: {}, registry: REGISTRY });
  return ctx.get('kernel') as KernelService;
}

function node(nodes: PluginNode[], id: string): PluginNode | undefined {
  return nodes.find((item) => item.id === id);
}

describe('内核装配（cordis.yml → 插件树）', () => {
  beforeEach(() => {
    seen.length = 0;
  });

  it('按清单挂载并把分层配置送进插件', async () => {
    manifest(`
plugins:
  - id: demo
    config:
      greeting: hello
  - id: other
`);
    const kernel = await mount();
    const nodes = kernel.snapshot();
    expect(nodes.map((item) => item.id)).toEqual(['demo', 'other']);
    expect(node(nodes, 'demo')?.state).toBe('active');
    expect(node(nodes, 'demo')?.keys).toEqual(['greeting', 'level']);
    // 文件层给 greeting、schema 默认值补 level：插件构造期就该拿到合并后的结果。
    expect(seen).toEqual(['hello/info']);
  });

  it('运行时层覆盖文件层（spec 1.3-02）', async () => {
    manifest(`
plugins:
  - id: demo
    config:
      greeting: hello
`);
    const ctx = new Context();
    await ctx.plugin(KernelService, {
      manifest: 'cordis.yml',
      rootDir,
      runtime: { demo: { greeting: 'runtime' } },
      registry: REGISTRY,
    });
    expect(seen).toEqual(['runtime/info']);
  });

  it('依赖缺席时是 PENDING 而不是装配失败，兄弟插件照常 ACTIVE（spec 1.3-09）', async () => {
    manifest(`
plugins:
  - id: demo
    enabled: false
  - id: dependent
    dependsOn: [demo]
  - id: other
`);
    const nodes = (await mount()).snapshot();
    expect(node(nodes, 'demo')).toBeUndefined();
    expect(node(nodes, 'dependent')?.state).toBe('pending');
    expect(node(nodes, 'other')?.state).toBe('active');
  });

  it('单个插件抛错只让它自己 FAILED（spec 1.3-10）', async () => {
    manifest(`
plugins:
  - id: boom
  - id: other
`);
    const nodes = (await mount()).snapshot();
    expect(node(nodes, 'boom')?.state).toBe('failed');
    expect(node(nodes, 'boom')?.error).toContain('构造器炸了');
    expect(node(nodes, 'other')?.state).toBe('active');
  });

  it('配置非法时点名具体字段而不是笼统失败（spec 1.3-03）', async () => {
    manifest(`
plugins:
  - id: demo
    config:
      level: verbose
  - id: other
`);
    const nodes = (await mount()).snapshot();
    expect(node(nodes, 'demo')?.state).toBe('failed');
    expect(node(nodes, 'demo')?.error).toContain('level');
    expect(node(nodes, 'other')?.state).toBe('active');
  });

  it('清单里的 id 在注册表中没有实现时点名，而不是静默跳过', async () => {
    manifest(`
plugins:
  - id: ghost
  - id: other
`);
    const nodes = (await mount()).snapshot();
    expect(node(nodes, 'ghost')?.state).toBe('failed');
    expect(node(nodes, 'ghost')?.error).toContain('注册表中没有插件实现：ghost');
    expect(node(nodes, 'other')?.state).toBe('active');
  });

  it('清单写坏时挂横幅而不是伪装成插件失败', async () => {
    manifest('notPlugins:\n  - id: demo\n');
    const kernel = await mount();
    expect(kernel.snapshot()).toEqual([]);
    expect(kernel.manifestError).toContain('plugins');
  });

  it('改完清单 reload 即重新装配，注掉的行真的少装一个', async () => {
    manifest(`
plugins:
  - id: demo
  - id: other
`);
    const kernel = await mount();
    expect(kernel.snapshot().map((item) => item.id)).toEqual(['demo', 'other']);

    manifest(`
plugins:
  - id: demo
`);
    await kernel.reload();
    expect(kernel.snapshot().map((item) => item.id)).toEqual(['demo']);
  });
});
