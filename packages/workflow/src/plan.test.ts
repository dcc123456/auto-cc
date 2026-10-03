/**
 * 计划声明层的用例（spec 2.4-01 的「可序列化存库、可回放」）。
 *
 * 重点是**指纹**：它是 2.4-05 续跑前唯一的判据，所以「同一份计划必然同一指纹」与
 * 「改过一个字节就必须换指纹」两条都要钉住，而后者要连着「键序不算改动」一起测——
 * 指纹若受键序影响，从库里读回来的计划会永远对不上，续跑就永远被拒绝。
 */
import { describe, expect, it } from 'vitest';
import {
  BOSS_BASIC_PLAN,
  BOSS_DELIVER_PLAN,
  BOSS_E2E_PLAN,
  buildPlan,
  planById,
  WORKFLOW_PLANS,
  workflowPlanSchema,
} from './plan.js';

describe('计划声明的解析与补全（spec 2.4-01）', () => {
  it('把省略的键补成确定形状，节点顺序即执行顺序', () => {
    const plan = buildPlan(BOSS_BASIC_PLAN);
    expect(plan.id).toBe('boss-basic');
    expect(plan.nodes).toHaveLength(3);
    expect(plan.nodes.map((node) => node.id)).toEqual(['jd-capture', 'jd-list', 'flaky']);
    // 只读节点没有目标可去重：空串是「不按目标去重」的唯一合法表示，不能留 undefined。
    expect(plan.nodes[0]?.target).toBe('');
    expect(plan.nodes[0]?.retryTimes).toBeNull();
    expect(plan.nodes[0]?.requiresHuman).toBe(false);
    expect(plan.nodes[2]).toMatchObject({ effect: 'local-write', retryTimes: 2, target: 'demo://flaky' });
  });

  it('序列化再反序列化回来是同一份计划，指纹不变（存库读回的往返）', () => {
    const plan = buildPlan(BOSS_BASIC_PLAN);
    const restored = buildPlan(JSON.parse(JSON.stringify(plan)) as unknown);
    expect(restored).toEqual(plan);
    expect(restored.fingerprint).toBe(plan.fingerprint);
  });

  it('指纹只与节点内容有关：改参数就换，键序不同与改 id 都不算换', () => {
    const plan = buildPlan(BOSS_BASIC_PLAN);
    expect(plan.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    const changed = buildPlan({
      ...BOSS_BASIC_PLAN,
      nodes: BOSS_BASIC_PLAN.nodes.map((node, index) =>
        index === 0 ? { ...node, params: { query: '后端工程师' } } : node,
      ),
    });
    expect(changed.fingerprint).not.toBe(plan.fingerprint);
    // 计划名不在指纹里：它是 `workflow_runs.plan_id` 那一列，改名字不改要做的事。
    expect(buildPlan({ ...BOSS_BASIC_PLAN, id: 'other-name' }).fingerprint).toBe(plan.fingerprint);
    // 参数键交换顺序后 JSON 文本不同，但计划是同一份：指纹必须仍然相等，否则库里读回的就续不上。
    const reordered = buildPlan({
      ...BOSS_BASIC_PLAN,
      nodes: [
        {
          id: 'jd-capture',
          kind: 'jd.capture',
          effect: 'read',
          params: { city: '上海', query: '前端工程师', target: 3 },
        },
        BOSS_BASIC_PLAN.nodes[1]!,
        BOSS_BASIC_PLAN.nodes[2]!,
      ],
    });
    expect(reordered.fingerprint).toBe(plan.fingerprint);
  });

  it('不合法的计划一律拒绝，不返回半条', () => {
    expect(() => buildPlan({ id: 'empty', nodes: [] })).toThrowError(/计划不合法/);
    expect(() => buildPlan({ id: 'no-effect', nodes: [{ id: 'a', kind: 'jd.capture' }] })).toThrowError(/计划不合法/);
    expect(() =>
      buildPlan({
        id: 'dup',
        nodes: [
          { id: 'a', kind: 'jd.capture', effect: 'read' },
          { id: 'a', kind: 'jd.list', effect: 'read' },
        ],
      }),
    ).toThrowError(/重名节点/);
    // 参数只允许标量：嵌套对象意味着计划里偷偷长了模板引擎（plan §11.8 明确不做）。
    expect(() =>
      buildPlan({ id: 'nested', nodes: [{ id: 'a', kind: 'jd.capture', effect: 'read', params: { deep: { x: 1 } } }] }),
    ).toThrowError(/计划不合法/);
    expect(() =>
      buildPlan({ id: 'danger', nodes: [{ id: 'a', kind: 'jd.capture', effect: 'very-dangerous' }] }),
    ).toThrowError(/计划不合法/);
  });

  it('schema 与视图类型对齐：`retryTimes` 越界、节点数超上限都在解析期挡下', () => {
    expect(
      workflowPlanSchema.safeParse({ id: 'x', nodes: [{ id: 'a', kind: 'k', effect: 'read', retryTimes: 9 }] }).success,
    ).toBe(false);
    const many = Array.from({ length: 65 }, (_, index) => ({ id: `n${String(index)}`, kind: 'k', effect: 'read' }));
    expect(workflowPlanSchema.safeParse({ id: 'x', nodes: many }).success).toBe(false);
  });
});

describe('投递主线计划（spec 2.6-01 / 03 / 07 的节点半边）', () => {
  it('两个投递节点都是外发副作用且零重试，路径不写进计划（取自 `outbound.deliver` 配置）', () => {
    const plan = buildPlan(BOSS_DELIVER_PLAN);
    expect(plan.nodes.map((node) => node.kind)).toEqual(['resume.deliver', 'resume.deliver']);
    // `retryTimes: 0` 是「已下架就不再试」的落库口径：默认值是 null（= 跟全局 2 次），必须显式写死才叫不重试。
    expect(plan.nodes.map((node) => node.retryTimes)).toEqual([0, 0]);
    expect(plan.nodes.every((node) => node.effect === 'outbound')).toBe(true);
    // target 各按目标分开：幂等键是 `runId+nodeId+target`，两个节点若共用空 target 就退化成「按节点去重」。
    expect(plan.nodes.map((node) => node.target)).toEqual(['deliver://1001', 'deliver://1002']);
    expect(plan.nodes.every((node) => !('file' in node.params))).toBe(true);
  });

  it('内置清单按 id 取得到三条计划，取不到时点名可用项', () => {
    expect(planById('boss-deliver').nodes).toHaveLength(2);
    expect(Object.keys(WORKFLOW_PLANS)).toEqual(['boss-basic', 'boss-deliver', 'boss-e2e']);
    expect(() => planById('boss-none')).toThrowError(/可选/);
  });
});

describe('全链路计划 boss-e2e（spec 2.8-07 / M6）', () => {
  it('五格顺序是搜索→读库→打招呼→定制（占位）→投递，且每格都是真能力不是演示节点', () => {
    const plan = buildPlan(BOSS_E2E_PLAN);
    expect(plan.id).toBe('boss-e2e');
    expect(plan.nodes.map((node) => node.kind)).toEqual([
      'jd.capture',
      'jd.list',
      'greeting.send',
      'resume.customize',
      'resume.deliver',
    ]);
    // 挂名的 kinds 必须都有执行器登记（`demo.flaky` 那种测试专用节点出现在这里就是链子造假）。
    expect(plan.nodes.some((node) => node.kind.startsWith('demo.'))).toBe(false);
  });

  it('外发两格是 outbound、只读三格是 read，两格外发都显式写零重试', () => {
    const plan = buildPlan(BOSS_E2E_PLAN);
    expect(plan.nodes.map((node) => node.effect)).toEqual(['read', 'read', 'outbound', 'read', 'outbound']);
    // 纯读节点没有目标可对，target 留空串；三条外发/占位格各按岗位分开，幂等键才分得开。
    expect(plan.nodes.map((node) => node.target)).toEqual(['', '', 'greet://1001', 'resume://1001', 'deliver://1001']);
    // 这两行的 `0` 从 5.7-04 起只是写给人看的：漏写了也不会重发，`retryBudgetFor` 按 `effect` 压成一次。
    expect(plan.nodes.map((node) => node.retryTimes)).toEqual([null, null, 0, null, 0]);
  });

  it('话术不在计划里预置：打招呼那格只给 title/company，生成走 `greeting.send` 内部（plan §15.9 决策 1）', () => {
    const plan = buildPlan(BOSS_E2E_PLAN);
    const greet = plan.nodes[2]!;
    expect(greet.params).not.toHaveProperty('text');
    expect(greet.params).toMatchObject({
      platform: 'boss',
      job: '1001',
      title: '桌面端前端工程师（Electron）',
      company: '星桥科技',
    });
    // 简历路径同理不钉进仓库：取 `outbound.deliver` 配置的 `resumeFile`。
    expect(plan.nodes.every((node) => !('file' in node.params))).toBe(true);
  });
});
