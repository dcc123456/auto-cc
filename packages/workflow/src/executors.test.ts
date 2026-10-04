/**
 * `workflow.executors` 登记处用例（spec 2.4-01 的登记表 + 5.10-k 的句柄宣告半边）。
 *
 * 打**真的 cordis 上下文**而不是直接调那两个私有函数：`[Service.init]` 里那两次 `register` 才是
 * "内置演示节点就位"这件事本体，把执行器当纯函数捞出来测会让「登记了没有」这一条无人认领
 * （5.1-c 记过同类账：清单顺序错了，四道门禁全绿而活体少一只工具）。
 *
 * 素材只有两只内置演示节点，不调任何平台包、不出网（§7.2）。
 */
import { Context, asApp, type WorkflowNodeExecutor, type WorkflowNodeSpec } from '@auto-cc/core';
import { describe, expect, it } from 'vitest';
import { DEMO_BRANCH_KIND, DEMO_FLAKY_KIND, WorkflowExecutorRegistryService } from './executors.js';

/**
 * 挂起登记处服务，取回契约本体。
 * @returns 登记表服务（`resolve` / `list` 都已就位）
 */
async function boot() {
  const ctx = new Context();
  await ctx.plugin(WorkflowExecutorRegistryService, {});
  return asApp(ctx)['workflow.executors'];
}

/**
 * 造一条 `demo.branch` 的节点声明。
 * @param params 要交给执行器的参数（原样放进 `spec.params`，故意缺键就是"缺参"那条用例）
 * @returns 补全默认值形状之后的节点声明
 */
function branchSpec(params: Record<string, string | number | boolean>): WorkflowNodeSpec {
  return {
    id: 'branch-1',
    kind: DEMO_BRANCH_KIND,
    target: '',
    params,
    effect: 'read',
    retryTimes: null,
    requiresHuman: false,
    outputs: ['yes', 'no'],
  };
}

/**
 * 调用一只已登记的执行器。
 * @param executor 目标执行器
 * @param spec 节点声明
 * @returns 执行器的返回值（`{ output }` 或 void）
 */
async function call(executor: WorkflowNodeExecutor, spec: WorkflowNodeSpec) {
  return executor({ runId: 'run-1', spec, attempt: 1, signal: new AbortController().signal });
}

describe('2.4-01 登记处与内置演示节点', () => {
  it('init 之后两只内置演示节点都在登记表里，其余 kind 如实为 null', async () => {
    const registry = await boot();
    expect(registry.list().sort()).toEqual([DEMO_BRANCH_KIND, DEMO_FLAKY_KIND].sort());
    expect(registry.resolve('jd.capture')).toBeNull();
  });

  it('demo.branch 宣告走过的出口句柄：数值不低于阈值走 yes，低于走 no', async () => {
    const executor = (await boot()).resolve(DEMO_BRANCH_KIND);
    expect(executor).not.toBeNull();
    await expect(call(executor!, branchSpec({ value: 2, threshold: 1 }))).resolves.toEqual({ output: 'yes' });
    // 相等那一格必须是 yes：`>=` 与 `>` 的边界只有在这里钉住，画布上才会出现"同一张图换支"的取法
    await expect(call(executor!, branchSpec({ value: 1, threshold: 1 }))).resolves.toEqual({ output: 'yes' });
    await expect(call(executor!, branchSpec({ value: 0, threshold: 1 }))).resolves.toEqual({ output: 'no' });
  });

  it('demo.branch 缺参数或参数不是数字时结构化拒绝，不猜走哪一支', async () => {
    const executor = (await boot()).resolve(DEMO_BRANCH_KIND);
    await expect(call(executor!, branchSpec({}))).rejects.toThrow(/value \/ threshold/);
    await expect(call(executor!, branchSpec({ value: '2', threshold: 1 }))).rejects.toThrow(/缺少数值参数/);
  });
});
