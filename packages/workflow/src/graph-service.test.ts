/**
 * `workflow.graph` 服务用例（spec 5.10-10 的读图 / 存图半边 + 5.10-15 的保存口硬拦）。
 *
 * 打**真的 cordis 上下文与真的 `node:sqlite`**（系统临时目录，产物不进仓库，§7.5）：
 * 「存进去 → 重启 → 读回来逐字段一致」是数据库语义 + 挂载语义两件事，
 * mock 掉存储或把服务类当纯函数调，等于两条都跳过。界面上那圈红环是**预览**（5.10-d 已活体验收），
 * 这里钉的是写入口那道闸——预览可以骗人，闸门不能。
 *
 * 节点素材只用登记过的算子 kind（`jd.capture` / `greeting.send`），不碰任何平台包（§7.2）。
 */
import { asApp, Context, type Fiber, type WorkflowGraphSaveInput } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildGraph } from './graph.js';
import { WorkflowGraphService } from './graph-service.js';
import { BOSS_BASIC_PLAN, buildPlan } from './plan.js';
import { WorkflowRunStoreService } from './run-store.js';

const sandboxes: string[] = [];
const mounted: Fiber[] = [];

/** 开一个系统临时目录并记账；同一个目录第二次挂载就是「重启」。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-graph-'));
  sandboxes.push(dir);
  return dir;
}

/** 一次挂载的读数（含 `dispose`，重启那条用例要真的把这一份连接放掉）。 */
type Mount = {
  graph: WorkflowGraphService;
  runs: WorkflowRunStoreService;
  dispose: () => Promise<void>;
};

/**
 * 挂起 config + store + workflow.store + **workflow.graph**（图的读写口就长在这一个连接上）。
 * @param dir 库所在目录；同一个目录第二次调用 = 用新连接打开同一份库，即用户理解的「重启 app」
 * @returns 两个服务句柄与一份只释放本次挂载的 `dispose`
 */
async function boot(dir: string): Promise<Mount> {
  const ctx = new Context();
  const created: Fiber[] = [];
  created.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  created.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  created.push(await ctx.plugin(WorkflowRunStoreService, {}));
  created.push(await ctx.plugin(WorkflowGraphService, {}));
  mounted.push(...created);
  const app = asApp(ctx) as unknown as Record<'workflow.graph' | 'workflow.store', unknown>;
  return {
    graph: app['workflow.graph'] as WorkflowGraphService,
    runs: app['workflow.store'] as WorkflowRunStoreService,
    dispose: async () => {
      for (const fiber of created.reverse()) await fiber.dispose();
      // 从全局台账里摘掉，免得 afterAll 二次释放同一份 fiber。
      for (const fiber of created) mounted.splice(mounted.indexOf(fiber), 1);
    },
  };
}

/** 一条**合法**的两节点线性图（读 → 外发，外带动作对象齐，五条校验都不该响）。 */
const VALID_NODES = [
  { id: 'jd-1', kind: 'jd.capture', effect: 'read' as const, target: 'https://fixture.example/jd/1' },
  { id: 'greet-1', kind: 'greeting.send', effect: 'outbound' as const, target: 'candidate-9' },
];

/** 那条链的那条边（`buildGraph` 对**已经成链**的边按顺序重算 id，所以这里写什么都会被归一成 `e-1` 形状的线性边）。 */
const VALID_EDGES = [{ id: 'chain-1', source: 'jd-1', target: 'greet-1' }];

/**
 * 存一条可改的自定义计划并给出它的图读数（保存口的每一次成功都要求表里有这一行）。
 * @param runs `workflow.store` 句柄
 * @param planId 计划 id（图 id 与它相同；不一致是另一条用例）
 * @returns 补全过默认值、算好指纹的图本体
 */
function seed(runs: WorkflowRunStoreService, planId: string) {
  runs.savePlan({
    id: planId,
    name: '画布用例',
    plan: buildPlan({ id: planId, nodes: BOSS_BASIC_PLAN.nodes }),
    sourceRunId: null,
    at: 1_700_000_000_000,
  });
  return buildGraph({ id: planId, nodes: VALID_NODES, edges: VALID_EDGES });
}

/**
 * 抓下被拒绝那一次的错误码与原文（判据是「结构化拒绝且给得出原因」，不是「抛了个什么东西」）。
 * @param fn 期望失败的那次调用
 * @returns 错误的 `code` 与 `message`
 * @throws fn 居然成功时抛「本该拒绝」，让用例失败而不是静默通过
 */
function reject(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    const thrown = error as { code?: string; message: string };
    return { code: thrown.code ?? '', message: thrown.message };
  }
  throw new Error('本该结构化拒绝，结果却成功了');
}

afterAll(async () => {
  // 先释放 fiber（关连接）再删目录：Windows 上句柄延迟释放会挡住删除。
  for (const fiber of mounted) await fiber.dispose();
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不该把一次通过的验收判成失败。
    }
  }
});

describe('存图 → 重启 → 读回（spec 5.10-10）', () => {
  it('换一份连接打开同一份库，图、落点、版本号逐字段读得回来', async () => {
    const dir = tempDir();
    const first = await boot(dir);
    const graph = seed(first.runs, 'plan-graph-1');
    const placements = [
      { nodeId: 'jd-1', x: 40, y: 120 },
      { nodeId: 'greet-1', x: 320, y: 120 },
    ];
    const saved = first.graph.save({ planId: 'plan-graph-1', graph, placements, expectedRevision: 1 });
    expect(saved).toMatchObject({ planId: 'plan-graph-1', revision: 2, fingerprint: graph.fingerprint });
    await first.dispose();

    // 真重启：新的 Context、新的连接，指向同一份库文件。
    const second = await boot(dir);
    const loaded = second.graph.load('plan-graph-1');
    expect(loaded.isCustom).toBe(true);
    expect(loaded.revision).toBe(2);
    expect(loaded.graph).toEqual(graph);
    // 落点按节点 id 排序回读（`canonicalViewsText` 存的就是那一串字节），所以这里等的是排过序的那一份。
    expect(loaded.placements).toEqual([placements[1], placements[0]]);
    // 列表里的节点数从库存下来的图现算（§2.5：同一件事不留第二个口径）。
    expect(second.runs.listPlans().find((item) => item.id === 'plan-graph-1')?.nodeCount).toBe(2);
  });
});

describe('内置计划的读图 = 线性投影（spec 5.10-02 的 IPC 半边）', () => {
  it('表里没有这一行时投影现算，指纹与那条计划相同，且不许直接覆盖保存', async () => {
    const { graph: service } = await boot(tempDir());
    const loaded = service.load('boss-basic');
    expect(loaded.isCustom).toBe(false);
    expect(loaded.placements).toEqual([]);
    expect(loaded.graph.edges).toHaveLength(BOSS_BASIC_PLAN.nodes.length - 1);
    // 一把哈希：投影出来的图与计划本体算出同一个指纹（`canonical.ts` 那一把，不是第二把）。
    expect(loaded.graph.fingerprint).toBe(buildPlan({ id: 'boss-basic', nodes: BOSS_BASIC_PLAN.nodes }).fingerprint);
    // 想改内置那条得先复制成自定义计划：这道口拒写，而不是往表里凭空插一行同名记录。
    const attempt: WorkflowGraphSaveInput = {
      planId: 'boss-basic',
      graph: loaded.graph,
      placements: [],
      expectedRevision: 1,
    };
    expect(reject(() => service.save(attempt)).code).toBe('INVALID_ARGUMENT');
  });
});

describe('保存口硬拦（spec 5.10-15 / 5.10-10 的写半边）', () => {
  /** 起一套服务并存好一条可写的计划。 */
  async function ready(planId: string) {
    const handle = await boot(tempDir());
    return { service: handle.graph, graph: seed(handle.runs, planId) };
  }

  it('有回边就拒写，原因里带得出循环那条，且库里那一版原样不动', async () => {
    const { service, graph } = await ready('plan-graph-cycle');
    const withBackEdge = buildGraph({
      id: graph.id,
      nodes: VALID_NODES,
      edges: [
        { id: 'e-1', source: 'jd-1', target: 'greet-1' },
        { id: 'e-2', source: 'greet-1', target: 'jd-1' },
      ],
    });
    const refused = reject(() =>
      service.save({ planId: 'plan-graph-cycle', graph: withBackEdge, placements: [], expectedRevision: 1 }),
    );
    expect(refused.code).toBe('INVALID_ARGUMENT');
    expect(refused.message).toMatch(/环/);
    // 没写进去：读回来还是投影那一条，`is_custom` 不会因为一次失败的保存被翻成 true。
    expect(service.load('plan-graph-cycle').isCustom).toBe(false);
  });

  it('外发节点缺动作对象就拒写（幂等与额度判不了就不许存）', async () => {
    const { service, graph } = await ready('plan-graph-outbound');
    const outboundNoTarget = buildGraph({
      id: graph.id,
      nodes: [
        { id: 'jd-1', kind: 'jd.capture', effect: 'read', target: 'https://fixture.example/jd/1' },
        { id: 'greet-1', kind: 'greeting.send', effect: 'outbound', target: '' },
      ],
      edges: VALID_EDGES,
    });
    expect(
      reject(() =>
        service.save({ planId: 'plan-graph-outbound', graph: outboundNoTarget, placements: [], expectedRevision: 1 }),
      ).message,
    ).toMatch(/外发节点 .* 没有动作对象|外发节点.*没有动作对象/);
  });

  it('版本与库里不符时拒写，而不是静默覆盖另一窗口那一版', async () => {
    const { service, graph } = await ready('plan-graph-revision');
    service.save({ planId: 'plan-graph-revision', graph, placements: [], expectedRevision: 1 });
    const stale = reject(() =>
      service.save({ planId: 'plan-graph-revision', graph, placements: [], expectedRevision: 1 }),
    );
    expect(stale.code).toBe('WORKFLOW_INVALID_STATE');
    // 冲突那一次没有把版本推走：带着 2 去存还能成功。
    expect(service.load('plan-graph-revision').revision).toBe(2);
    expect(service.save({ planId: 'plan-graph-revision', graph, placements: [], expectedRevision: 2 }).revision).toBe(
      3,
    );
  });

  it('图的 id 与要保存的计划 id 不符时拒写', async () => {
    const { service, graph } = await ready('plan-graph-mismatch');
    const other = buildGraph({ id: 'plan-other', nodes: VALID_NODES });
    expect(
      reject(() => service.save({ planId: graph.id, graph: other, placements: [], expectedRevision: 1 })).message,
    ).toMatch(/不符/);
  });
});
