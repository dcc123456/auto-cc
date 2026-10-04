/**
 * 5.10-d 的用例：保存前五条图校验（spec 5.10-05）与画布命令栈（spec 5.10-19），
 * 外加 5.10-14 的**反向验证**半边（连回边被拒且写明"不做循环"的理由）。
 *
 * 为什么写在 `packages/workflow`：被测的两个模块按裁定九放 `@auto-cc/core`（渲染层与这里要读同一份规则），
 * 而 core 包没有测试运行器；这一层同时是它们真实读者之一，用例打这一层等于"下层实现、上层调用形状"一起验。
 */
import {
  checkWorkflowGraph,
  createWorkflowGraphEditor,
  isWorkflowGraphValid,
  workflowEdgeIdOf,
  type WorkflowGraphDraft,
} from '@auto-cc/core';
import type { WorkflowNodeSpec } from '@auto-cc/core';
import { describe, expect, it } from 'vitest';

/**
 * 造一个节点声明（七字段齐全，只写测试关心的差异）。
 * @param id 节点 id
 * @param kind 算子名（默认 `jd.capture`，描述表里的第一只）
 * @param overrides 要改的那几项（`target` / `effect` / `outputs` 等）
 * @returns 可直接进校验与命令栈的节点
 */
function node(id: string, kind = 'jd.capture', overrides: Partial<WorkflowNodeSpec> = {}): WorkflowNodeSpec {
  return {
    id,
    kind,
    target: '',
    params: { query: '前端工程师' },
    effect: 'read',
    retryTimes: null,
    requiresHuman: false,
    ...overrides,
  };
}

/**
 * 造一条边。
 * @param source 起点节点 id
 * @param target 终点节点 id
 * @param sourceHandle 出口名（默认 `default`）
 * @returns 边的读数，id 由自然键派生（与命令栈同一套写法）
 */
function edge(source: string, target: string, sourceHandle = 'default') {
  return { id: workflowEdgeIdOf(source, sourceHandle, target), source, sourceHandle, target };
}

/**
 * 造一张图。
 * @param nodes 节点数组
 * @param edges 边数组
 * @returns 校验与命令栈通用的图读数
 */
function graph(nodes: WorkflowNodeSpec[], edges: ReturnType<typeof edge>[] = []): WorkflowGraphDraft {
  return { nodes, edges };
}

describe('spec 5.10-05 保存前五条图校验', () => {
  it('① 未知 kind：点名那只节点，并把它自己那一行报出来', () => {
    const issues = checkWorkflowGraph(graph([node('n1', 'jd.captor')]));
    expect(issues.map((issue) => issue.code)).toEqual(['unknownKind']);
    expect(issues[0]?.nodeIds).toEqual(['n1']);
    expect(issues[0]?.message).toContain('n1');
    expect(issues[0]?.message).toContain('jd.captor');
  });

  it('② 悬挂边：出口句柄不在该节点声明的出口里，两端节点 id 都给出来', () => {
    const issues = checkWorkflowGraph(graph([node('a'), node('b')], [edge('a', 'b', 'onError')]));
    const dangling = issues.filter((issue) => issue.code === 'danglingEdge');
    expect(dangling).toHaveLength(1);
    expect(dangling[0]?.nodeIds).toEqual(['a', 'b']);
    expect(dangling[0]?.message).toContain('onError');
  });

  it('② 悬挂边另一半：边连着图上根本不存在的节点', () => {
    const issues = checkWorkflowGraph(graph([node('a')], [edge('a', 'ghost')]));
    expect(issues.some((issue) => issue.code === 'danglingEdge' && issue.nodeIds.includes('ghost'))).toBe(true);
  });

  it('③ 多源点：两只没有入边的节点一起报，并写明只有一个是起点', () => {
    const issues = checkWorkflowGraph(graph([node('a'), node('b')]));
    expect(issues.map((issue) => issue.code)).toEqual(['multipleSources']);
    expect(issues[0]?.nodeIds).toEqual(['a', 'b']);
    expect(issues[0]?.message).toContain('a');
  });

  it('③ 并行扇出不算多源点：同一只起点分出两条出边仍然只有一个起点（5.10-09 的图形状）', () => {
    const shape = graph(
      [node('root'), node('left'), node('right', 'jd.list')],
      [edge('root', 'left'), edge('root', 'right')],
    );
    expect(checkWorkflowGraph(shape).map((issue) => issue.code)).not.toContain('multipleSources');
  });

  it('⑤ 外发缺 target：外发节点没有动作对象即拒，读侧节点空串合法', () => {
    const issues = checkWorkflowGraph(graph([node('send', 'greeting.send', { effect: 'outbound' })]));
    expect(issues.map((issue) => issue.code)).toEqual(['outboundMissingTarget']);
    expect(issues[0]?.nodeIds).toEqual(['send']);
    expect(
      isWorkflowGraphValid(graph([node('send', 'greeting.send', { effect: 'outbound', target: 'greet://1001' })])),
    ).toBe(true);
  });

  it('一条合格的图（读侧链）零问题：五条都不该误报', () => {
    const shape = graph([node('a'), node('b', 'jd.list')], [edge('a', 'b')]);
    expect(checkWorkflowGraph(shape)).toEqual([]);
  });

  it('一次报全部而不是撞到第一条就返回（判据的"逐条可定位"）', () => {
    const shape = graph(
      [node('x', 'nope.unknown'), node('y', 'resume.deliver', { effect: 'outbound' })],
      [edge('y', 'x'), edge('x', 'y')],
    );
    const codes = checkWorkflowGraph(shape).map((issue) => issue.code);
    expect(codes).toContain('unknownKind');
    expect(codes).toContain('cycle');
    expect(codes).toContain('outboundMissingTarget');
    expect(codes.length).toBeGreaterThanOrEqual(3);
  });
});

describe('spec 5.10-14 反向验证：连回边被拒且写明理由', () => {
  it('A→B→A 报 cycle，文案含环上的两个节点 id 与"不做循环"的理由', () => {
    const shape = graph([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')]);
    const issues = checkWorkflowGraph(shape);
    const cycle = issues.find((issue) => issue.code === 'cycle');
    expect(cycle?.nodeIds.sort()).toEqual(['a', 'b']);
    expect(cycle?.message).toContain('不做循环');
    expect(cycle?.message).toContain('retryTimes');
  });

  it('自环也算环，并且只报一次同一段环', () => {
    const shape = graph([node('a'), node('b')], [edge('a', 'a'), edge('a', 'b')]);
    const cycles = checkWorkflowGraph(shape).filter((issue) => issue.code === 'cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.nodeIds).toEqual(['a']);
  });

  it('没有环的链不报 cycle（反向验证不能被误报抵销）', () => {
    const shape = graph([node('a'), node('b')], [edge('a', 'b')]);
    expect(checkWorkflowGraph(shape).map((issue) => issue.code)).not.toContain('cycle');
  });
});

describe('spec 5.10-19 编辑命令栈：三类编辑可逐步回退与重做', () => {
  /** 初始图：一格读侧节点，作为"回退到底"的比对基准。 */
  const initial = (): WorkflowGraphDraft => graph([node('a')]);

  it('加节点、连线、改参数各产生一条撤销单元，逐条退到底与初始图逐字段一致', () => {
    const start = initial();
    const editor = createWorkflowGraphEditor(start);
    expect(editor.addNode(node('b', 'jd.list'))).toBe(true);
    expect(editor.connect('a', 'default', 'b')).toBe(true);
    expect(editor.setParams('b', { limit: 5 })).toBe(true);
    expect(editor.canRedo()).toBe(false);

    expect(editor.undo()).toBe(true);
    expect(editor.undo()).toBe(true);
    expect(editor.undo()).toBe(true);
    expect(editor.draft()).toEqual(start);
    expect(editor.canUndo()).toBe(false);

    expect(editor.redo()).toBe(true);
    expect(editor.redo()).toBe(true);
    expect(editor.redo()).toBe(true);
    expect(editor.draft()).toEqual({
      nodes: [node('a'), { ...node('b', 'jd.list'), params: { limit: 5 } }],
      edges: [edge('a', 'b')],
    });
  });

  it('空编辑不产生撤销单元：重名节点、重复连线、参数没变都不算一步', () => {
    const editor = createWorkflowGraphEditor(graph([node('a'), node('b')], [edge('a', 'b')]));
    expect(editor.addNode(node('a'))).toBe(false);
    expect(editor.connect('a', 'default', 'b')).toBe(false);
    expect(editor.setParams('a', { query: '前端工程师' })).toBe(false);
    expect(editor.canUndo()).toBe(false);
  });

  it('连线的端点不在图上时不生效（回边则是生效并由校验拒，见上面 5.10-14）', () => {
    const editor = createWorkflowGraphEditor(initial());
    expect(editor.connect('a', 'default', 'ghost')).toBe(false);
    expect(editor.draft().edges).toEqual([]);
    expect(editor.connect('a', 'default', 'a')).toBe(true);
  });

  it('撤销后再做新编辑即作废重做分支（不是协同编辑，不留两条历史线）', () => {
    const editor = createWorkflowGraphEditor(initial());
    editor.addNode(node('b', 'jd.list'));
    editor.addNode(node('c', 'jd.list'));
    editor.undo();
    expect(editor.canRedo()).toBe(true);
    editor.addNode(node('d', 'jd.list'));
    expect(editor.canRedo()).toBe(false);
    expect(editor.draft().nodes.map((candidate) => candidate.id)).toEqual(['a', 'b', 'd']);
  });

  it('历史深度有上限，超出丢最老的一步而不是无限涨', () => {
    const editor = createWorkflowGraphEditor(initial(), 3);
    for (const id of ['b', 'c', 'd', 'e']) editor.addNode(node(id, 'jd.list'));
    let steps = 0;
    while (editor.undo()) steps += 1;
    expect(steps).toBe(3);
    expect(editor.draft().nodes.map((candidate) => candidate.id)).toEqual(['a', 'b']);
  });

  it('图里没有位置这一项：落点属视图层，命令栈管不到它（5.10-06 的口径）', () => {
    const editor = createWorkflowGraphEditor(initial());
    editor.addNode(node('b', 'jd.list'));
    const [first] = editor.draft().nodes;
    expect(Object.keys(first ?? {})).not.toContain('position');
  });

  it('返回的是副本：调用方改拿到的数组不会写穿栈里的状态', () => {
    const editor = createWorkflowGraphEditor(initial());
    const leaked = editor.draft();
    leaked.nodes.push(node('sneaky', 'jd.list'));
    leaked.nodes[0]!.params.query = '改成别的';
    expect(editor.draft().nodes.map((candidate) => candidate.id)).toEqual(['a']);
    expect(editor.draft().nodes[0]?.params.query).toBe('前端工程师');
  });
});
