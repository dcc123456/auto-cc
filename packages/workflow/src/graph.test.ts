/**
 * 图语义层的用例（spec 5.10-02 的 C 半边 + 5.10-06 全部）。
 *
 * 两组判据各盯一个风险：
 * ① 「不重写即可作为图加载」——三条内置计划一个字节都不改，投影出来的必须是
 *    「节点顺序 = 执行顺序、边 = 相邻两点、出口全是 default」，且**指纹与计划相同**
 *    （两条指纹就是两条真相，5.10-07 的续跑判据会空转）；
 * ② 「位置属视图层」——落点怎么挪指纹都不许动，而改参数、改边必须动。
 *    这一半还连着一条 2.4 时代的回归：新口径算出来的值要和老算法逐字节相同，
 *    否则本机库里留下的 run 一续跑就被误判成「计划已修改」。
 */
import { describe, expect, it } from 'vitest';
import { canonicalJson, fnv1a32, graphFingerprint } from './canonical.js';
import { buildGraph, canonicalViewsText, linearEdges, projectPlanToGraph } from './graph.js';
import { BOSS_BASIC_PLAN, buildPlan, planById, WORKFLOW_PLANS } from './plan.js';

/** 三条内置计划都有的形状：把节点补全后的数组取出来，供"改一个字节"的用例复制用。 */
function nodesOf(id: string) {
  return planById(id).nodes.map((node) => ({ ...node }));
}

describe('线性计划原样投影成图（spec 5.10-02）', () => {
  it('三条内置计划一个都不改写，投影出来是一条链、边全走 default 出口', () => {
    for (const planId of Object.keys(WORKFLOW_PLANS)) {
      const plan = planById(planId);
      const graph = projectPlanToGraph(plan);
      expect(graph.nodes.map((node) => node.id)).toEqual(plan.nodes.map((node) => node.id));
      expect(graph.edges).toHaveLength(Math.max(plan.nodes.length - 1, 0));
      // 出口全是 default：线性计划没有任何分支出口可走（分支是 f 片才有的东西）。
      expect(graph.edges.map((edge) => edge.sourceHandle)).toEqual(graph.edges.map(() => 'default'));
      expect(graph.edges.map((edge) => [edge.source, edge.target])).toEqual(
        plan.nodes.slice(1).map((node, index) => [(plan.nodes[index] as (typeof plan.nodes)[number]).id, node.id]),
      );
      // 一把哈希：图读数与它的源计划算出同一个指纹，"两条真相"在这条断言面前立不住。
      expect(graph.fingerprint).toBe(plan.fingerprint);
    }
  });

  it('boss-basic 画出来就是三个节点两条边，边 id 由顺序定死', () => {
    const graph = projectPlanToGraph(planById('boss-basic'));
    expect(graph.nodes.map((node) => node.id)).toEqual(['jd-capture', 'jd-list', 'flaky']);
    expect(graph.edges).toEqual([
      { id: 'linear-1', source: 'jd-capture', sourceHandle: 'default', target: 'jd-list' },
      { id: 'linear-2', source: 'jd-list', sourceHandle: 'default', target: 'flaky' },
    ]);
    // 单个节点的计划没有边，也不是错误读数（一条计划可以只有一步）。
    expect(linearEdges(nodesOf('boss-basic').slice(0, 1))).toEqual([]);
  });

  it('投影是确定的：同一份计划投两次、以及把图读回再算，指纹都不变', () => {
    const plan = planById('boss-basic');
    const graph = projectPlanToGraph(plan);
    expect(projectPlanToGraph(plan)).toEqual(graph);
    // 存进库再读回（序列化→反序列化）必须得到同一张图，这是 5.10-e 落库的前提。
    expect(buildGraph(JSON.parse(JSON.stringify(graph)))).toEqual(graph);
  });

  it('声明了多出口的节点不许按线性投影，且点出是哪一只', () => {
    const branching = buildPlan({
      ...BOSS_BASIC_PLAN,
      nodes: [{ id: 'gate', kind: 'demo.branch', effect: 'read', outputs: ['yes', 'no'] }],
    });
    expect(() => projectPlanToGraph(branching)).toThrow(/gate/);
  });

  it('结构不成立的图读数一律拒绝，不返回半张图', () => {
    const base = projectPlanToGraph(planById('boss-basic'));
    expect(() => buildGraph({ ...base, nodes: [...base.nodes, { ...base.nodes[0]! }] })).toThrow(/重名节点/);
    expect(() => buildGraph({ ...base, edges: [{ id: 'linear-1', source: 'ghost', target: 'jd-list' }] })).toThrow(
      /不存在的起点 ghost/,
    );
    expect(() => buildGraph({ ...base, edges: [...base.edges, { ...base.edges[0]!, id: base.edges[0]!.id }] })).toThrow(
      /重名边/,
    );
  });
});

describe('视图层位置与执行身份分离（spec 5.10-06）', () => {
  it('挪动落点不改变指纹，落点顺序也不改变规范文本之外的任何东西', () => {
    const nodes = nodesOf('boss-e2e');
    const edges = linearEdges(nodes);
    const before = graphFingerprint(nodes, edges);
    const dragged = [
      { nodeId: 'e2e-capture', x: 480, y: -120 },
      { nodeId: 'e2e-deliver', x: 12.5, y: 999 },
      { nodeId: 'e2e-list', x: 0, y: 0 },
    ];
    // 视图走独立通道：它不进指纹函数的形参，所以"挪位置"这件事在结构上就够不到执行身份。
    expect(graphFingerprint(nodes, edges)).toBe(before);
    expect(canonicalViewsText(dragged)).toBe(canonicalViewsText([...dragged].reverse()));
    expect(JSON.parse(canonicalViewsText(dragged)).map((view: { nodeId: string }) => view.nodeId)).toEqual([
      'e2e-capture',
      'e2e-deliver',
      'e2e-list',
    ]);
  });

  it('改参数换指纹；只补一个 default 出口声明不换（声明面不是执行身份）', () => {
    const nodes = nodesOf('boss-basic');
    const edges = linearEdges(nodes);
    const baseline = graphFingerprint(nodes, edges);
    const retuned = nodes.map((node, index) =>
      index === 0 ? { ...node, params: { ...node.params, limit: 99 } } : node,
    );
    expect(graphFingerprint(retuned, edges)).not.toBe(baseline);

    const declaredDefault = nodes.map((node) => ({ ...node, outputs: ['default' as const] }));
    expect(graphFingerprint(declaredDefault, edges)).toBe(baseline);
  });

  it('改边换指纹：跳过中间一步、把出口换成分支名，都不是同一张图', () => {
    const nodes = nodesOf('boss-e2e');
    const linear = linearEdges(nodes);
    const baseline = graphFingerprint(nodes, linear);
    const skipOne = [
      { id: 'linear-1', source: 'e2e-capture', sourceHandle: 'default', target: 'e2e-list' },
      { id: 'linear-2', source: 'e2e-list', sourceHandle: 'default', target: 'e2e-greet' },
      { id: 'shortcut', source: 'e2e-capture', sourceHandle: 'default', target: 'e2e-greet' },
      { id: 'linear-4', source: 'e2e-customize', sourceHandle: 'default', target: 'e2e-deliver' },
    ];
    expect(graphFingerprint(nodes, skipOne)).not.toBe(baseline);
    const renamedHandle = linear.map((edge, index) => (index === 0 ? { ...edge, sourceHandle: 'yes' } : edge));
    expect(graphFingerprint(nodes, renamedHandle)).not.toBe(baseline);
  });

  it('键序与线性边的 id 写法都不算改动（续跑判据不能被"重存一次"打断）', () => {
    const plan = planById('boss-basic');
    const graph = projectPlanToGraph(plan);
    // 打乱键序再走一遍读回路径：库里存的是文本，`JSON.parse` 之后的键序按写入时走。
    const reshuffled = JSON.parse(
      JSON.stringify({
        edges: graph.edges.map((edge) => ({
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          id: edge.id,
          source: edge.source,
        })),
        nodes: graph.nodes.map((node) => ({
          requiresHuman: node.requiresHuman,
          effect: node.effect,
          retryTimes: node.retryTimes,
          params: node.params,
          target: node.target,
          kind: node.kind,
          id: node.id,
        })),
        id: graph.id,
      }),
    ) as unknown;
    expect(buildGraph(reshuffled).fingerprint).toBe(plan.fingerprint);
    // 同一张链换个边 id 写法：线性投影的边由顺序重算，所以不会被 id 拖出第二个指纹。
    expect(buildGraph({ ...graph, edges: graph.edges.map((edge) => ({ ...edge, id: `custom-${edge.id}` })) })).toEqual(
      graph,
    );
  });

  it('新口径与 2.4 时代留下的哈希逐字节相同（本机库里的历史 run 不受本片影响）', () => {
    for (const planId of Object.keys(WORKFLOW_PLANS)) {
      const plan = planById(planId);
      // 老算法就是"把补全后的节点数组整个规范化再 FNV"；七个执行字段之外的东西当时不存在。
      const legacy = fnv1a32(
        canonicalJson(
          plan.nodes.map((node) => ({
            id: node.id,
            kind: node.kind,
            target: node.target,
            params: node.params,
            effect: node.effect,
            retryTimes: node.retryTimes,
            requiresHuman: node.requiresHuman,
          })),
        ),
      );
      expect(plan.fingerprint).toBe(legacy);
      expect(projectPlanToGraph(plan).fingerprint).toBe(legacy);
    }
  });
});
