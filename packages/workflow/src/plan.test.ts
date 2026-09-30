/**
 * 计划声明层的用例（spec 2.4-01 的「可序列化存库、可回放」）。
 *
 * 重点是**指纹**：它是 2.4-05 续跑前唯一的判据，所以「同一份计划必然同一指纹」与
 * 「改过一个字节就必须换指纹」两条都要钉住，而后者要连着「键序不算改动」一起测——
 * 指纹若受键序影响，从库里读回来的计划会永远对不上，续跑就永远被拒绝。
 */
import { describe, expect, it } from 'vitest';
import { BOSS_BASIC_PLAN, buildPlan, workflowPlanSchema } from './plan.js';

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
