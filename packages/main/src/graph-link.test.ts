/**
 * 画布图读写的**装配与 IPC 面**对账（spec 5.10-10 的接线半边 / 5.10-17）。
 *
 * 为什么放在 `packages/main`：这里要同时读到注册表、`cordis.yml`、白名单与网关的 `resolveCall`
 * ——四样东西分属三个包，只有装配层认识它们全部。判据也正是装配层的判据：
 * 服务挂起来了但清单没写它，app 启动时同样不会有这一道口（`metrics-link.test.ts` 同一口径）。
 *
 * 图语义本体（存图→重启→读回、五条校验硬拦）在 `packages/workflow/src/graph-service.test.ts` 判，
 * 这里不重复审一遍，只钉「界面调得到的那条路径确实切得对、且未登记的名字进不来」。
 */
import { asApp, Context, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { resolveCall } from '@auto-cc/plugin-ipc';
import { StoreService } from '@auto-cc/plugin-store';
import { WorkflowGraphService, WorkflowRunStoreService } from '@auto-cc/plugin-workflow';
import { RENDERER_ALLOWLIST, isAllowedCall } from '@auto-cc/shared';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/**
 * 挂起 config + store + workflow.store + **workflow.graph**（画布那道口在真实装配里就长这样）。
 * @returns 上下文、`workflow.graph` 句柄与 `asApp` 读数（走 `app['workflow.graph']` 那条真调用路）
 */
async function bootGraph() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-graph-link-'));
  sandboxes.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(WorkflowRunStoreService, {}));
  fibers.push(await ctx.plugin(WorkflowGraphService, {}));
  // `workflow.graph` 这个名字还没进 cordis 的 AppServices 声明（只有 `workflow.store` 在里面），
  // 所以这里按名取时要先落到 unknown，再由句柄类型收口——不影响网关那侧的动态 lookup 走同一条路。
  const app = asApp(ctx) as unknown as Record<'workflow.graph', unknown>;
  return { ctx, graph: app['workflow.graph'] as WorkflowGraphService };
}

afterAll(async () => {
  // 先释放 fiber（关连接）再删目录：Windows 上句柄延迟释放会挡住删除（§9 的环境事实）。
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不该把一次通过的验收判成失败。
    }
  }
});

describe('装配对账（spec 5.10-10）', () => {
  it('注册表与 cordis.yml 都有 workflow-graph 这一行，缺一条就不装', () => {
    // 只写注册表不进清单，启动时那条口根本不存在；只进清单不写注册表，插件树里显示 failed。
    const registrySource = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'registry.ts'), 'utf8');
    expect(registrySource).toMatch(/^ {2}'workflow-graph': WorkflowGraphService,$/m);
    const cordisYml = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '../../../cordis.yml'), 'utf8');
    expect(cordisYml).toMatch(/\n {2}- id: workflow-graph\n/);
  });
});

describe('网关切得动这两条路径（spec 5.10-10 的界面半边）', () => {
  it('`workflow.graph.load` 切成服务 `workflow.graph` + 方法 `load` 并调得通', async () => {
    const { ctx, graph } = await bootGraph();
    const resolution = resolveCall('workflow.graph.load', (name) => {
      try {
        return ctx.get(name) as object;
      } catch {
        return undefined;
      }
    });
    expect(resolution).toMatchObject({ ok: true, service: 'workflow.graph', method: 'load' });
    if (!resolution.ok) throw new Error('分派失败');
    // 网关那一路调出来的读数与服务直接调的一致，且内置 `boss-basic` 走的是线性投影（3 节点 2 条边）。
    const viaGateway = resolution.invoke('boss-basic') as ReturnType<WorkflowGraphService['load']>;
    expect(viaGateway.isCustom).toBe(false);
    expect(viaGateway.graph).toEqual(graph.load('boss-basic').graph);
  });
});

describe('白名单只放行登记过的那两个名字（spec 5.10-17）', () => {
  it('`workflow.graph.*` 恰有 load 与 save，抄错的名字结构化拒在门口', () => {
    // 渲染层拿到的 `window.autoCC` 由同一条名单生成，所以「服务挂着」与「界面调得到」之间
    // 缺的就是登记这一步；而多登记一个名字就等于多开一条没人审的通路（§8.2）。
    expect(RENDERER_ALLOWLIST.filter((id) => id.startsWith('workflow.graph.'))).toEqual([
      'workflow.graph.load',
      'workflow.graph.save',
    ]);
    expect(isAllowedCall('workflow.graph.load')).toBe(true);
    expect(isAllowedCall('workflow.graph.save')).toBe(true);
    // 未登记的方法名（图没有删除口：删计划连带删图）、带点的方法名、整名小写都进不来。
    expect(isAllowedCall('workflow.graph.deleteGraph')).toBe(false);
    expect(isAllowedCall('workflow.graph.save.all')).toBe(false);
    expect(isAllowedCall('Workflow.graph.load')).toBe(false);
    expect(isAllowedCall('workflow.graph')).toBe(false);
  });

  it('图读写不进 agent 工具面：沉淀那四条只由人按的口径同样管住画布（§8.4）', () => {
    // 白名单里有 ≠ 模型能调。画布保存改的是「以后每次都这么跑」的那份计划，
    // 这条断言钉的是「它只出现在渲染层名单里」，工具面登记是另一处（`agent.tools.*`）的事。
    const graphIds = RENDERER_ALLOWLIST.filter((id) => id.startsWith('workflow.graph.'));
    expect(graphIds.every((id) => !id.startsWith('agent.'))).toBe(true);
    expect(graphIds).toHaveLength(2);
  });
});
