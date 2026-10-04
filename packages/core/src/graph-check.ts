/**
 * 保存前的图校验（spec 5.10-05 / 5.10-14，plan §5.10.6 的那五条）。
 *
 * 为什么放 `@auto-cc/core`：读它的是**两处**——渲染层（L4，画完一条边就要立刻知道行不行）与
 * workflow 的保存口（L3，落库前同一套规则再拦一遍）。依赖方向只许上层依赖下层（AGENTS.md §4.1），
 * 而渲染层只经 `@auto-cc/shared` 取值，所以唯一能被两处同读的位置还是 core（与算子描述表同一条理由）。
 * 渲染层取值走 `@auto-cc/core/graph-check` 窄子路径出口，不许 import barrel（裁定八）。
 *
 * 三条口径：
 * - **一次报全部**，不是撞到第一条就返回。判据原文是"逐条可定位"，只回"图不合法"没有意义。
 * - 每条都带 `code`（界面按它取 i18n 文案，§5.5）与 `nodeIds`（点名是哪几只格子），`message` 是给
 *   日志与测试读的中文诊断，不是页面上的那句原话。
 * - 参数级校验（必填缺失、类型不合）不在这里——那是 `validateOperatorParams` 一处的活（c 片已做，
 *   §2.5 不在第二处再实现一遍）。这里只管**图**的形状与语义。
 */
import { WORKFLOW_DEFAULT_OUTPUT, type WorkflowEdgeView, type WorkflowNodeSpec } from './events.js';
import { WORKFLOW_OPERATORS, operatorByKind, type OperatorDescriptor } from './operators.js';

/** 五条校验的稳定编码；新增一条要同时补界面文案与用例，不能只在界面加一类。 */
export const WORKFLOW_GRAPH_CHECK_CODES = [
  'unknownKind',
  'danglingEdge',
  'multipleSources',
  'cycle',
  'outboundMissingTarget',
] as const;

export type WorkflowGraphCheckCode = (typeof WORKFLOW_GRAPH_CHECK_CODES)[number];

/** 一条被指出来的问题：编码 + 涉及的节点 id + 中文诊断。 */
export type WorkflowGraphIssue = {
  code: WorkflowGraphCheckCode;
  /** 点名的节点 id（界面把红框落到这些格子上）。悬挂边的两端都会在这里。 */
  nodeIds: string[];
  /** 诊断文本，含节点 id；给日志、给测试断言、给 e 片 IPC 的 `reason`，不当界面文案用。 */
  message: string;
};

/** 校验输入：一张图的执行语义部分（落点属视图层，与合法性无关，5.10-06）。 */
export type WorkflowGraphShape = {
  nodes: readonly WorkflowNodeSpec[];
  edges: readonly WorkflowEdgeView[];
};

/**
 * 取一只节点声明的出口名。
 * @param node 节点声明
 * @param descriptor 该 kind 的算子描述（未登记时为 undefined）
 * @returns 出口名数组：节点自己声明的最优先，其次描述表，都没有就是单出口 `default`
 */
function outputsOf(node: WorkflowNodeSpec, descriptor: OperatorDescriptor | undefined): readonly string[] {
  if (node.outputs !== undefined && node.outputs.length > 0) return node.outputs;
  if (descriptor) return descriptor.outputs;
  return [WORKFLOW_DEFAULT_OUTPUT];
}

/**
 * 按 plan §5.10.6 的五条逐一检查一张图，报出**所有**问题。
 * @param graph 待校验的图读数（节点/边，不必已过 zod 形状校验；这里只按字段读）
 * @param descriptors 算子描述表（默认可见，测试与后续 mock 链可注入扩展表——§2.5 一个入口）
 * @returns 问题数组；空数组即这张图可保存。不抛异常，因为界面要把五条同时列出来
 */
export function checkWorkflowGraph(
  graph: WorkflowGraphShape,
  descriptors: readonly OperatorDescriptor[] = WORKFLOW_OPERATORS,
): WorkflowGraphIssue[] {
  const issues: WorkflowGraphIssue[] = [];
  const nodesById = new Map<string, WorkflowNodeSpec>();
  for (const node of graph.nodes) nodesById.set(node.id, node);

  // ① 未知 kind：描述表里没有的执行器名。跑起来只会表现为"节点一直 pending"，所以必须保存前就点出来。
  for (const node of graph.nodes) {
    if (!operatorByKind(node.kind, descriptors)) {
      issues.push({
        code: 'unknownKind',
        nodeIds: [node.id],
        message: `节点 ${node.id} 的算子 ${node.kind} 未在描述表登记`,
      });
    }
  }

  // ② 悬挂边：端点不存在，或出口句柄不在那只节点声明的出口里（后者是"接了个不存在的口"）。
  for (const edge of graph.edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) {
      issues.push({
        code: 'danglingEdge',
        nodeIds: [edge.source, edge.target].filter((id) => !nodesById.has(id)),
        message: `边 ${edge.id} 连着不存在的节点（${edge.source} → ${edge.target}）`,
      });
      continue;
    }
    const declared = outputsOf(source, operatorByKind(source.kind, descriptors));
    if (!declared.includes(edge.sourceHandle)) {
      issues.push({
        code: 'danglingEdge',
        nodeIds: [edge.source, edge.target],
        message: `边 ${edge.id} 从节点 ${edge.source} 的出口 ${edge.sourceHandle} 出发，而该节点只有 ${declared.join('、')} 出口`,
      });
    }
  }

  // ③ 多源点：入度为 0 的节点超过一只，就没有"这条计划从哪开始"这一件事。
  // 并行扇出不在此列——它是**同一只**源点分出多条出边，仍然只有一个起点（5.10-09）。
  const incoming = new Map<string, number>();
  for (const edge of graph.edges) incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  const roots = graph.nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id);
  if (roots.length > 1) {
    issues.push({
      code: 'multipleSources',
      nodeIds: roots,
      message: `这张图有 ${String(roots.length)} 个起点（${roots.join('、')}），一次运行只能有一条起点`,
    });
  }

  // ④ 有环：深度优先找一条回边。这一条同时是 5.10-14 的反向验证——本项目**不做循环**，
  // 理由写在下面那句 message 里（attempts 既当重试计数又当 2.4-10 的统计原料，循环会让"第几次执行"二义）。
  const outgoing = new Map<string, WorkflowEdgeView[]>();
  for (const edge of graph.edges) {
    const bucket = outgoing.get(edge.source);
    if (bucket) bucket.push(edge);
    else outgoing.set(edge.source, [edge]);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const reportedCycles = new Set<string>();
  const walk = (nodeId: string, path: string[]): void => {
    if (state.get(nodeId) === 'done') return;
    if (state.get(nodeId) === 'visiting') {
      const cycle = path.slice(path.indexOf(nodeId));
      const key = [...cycle].sort().join('|');
      if (!reportedCycles.has(key)) {
        reportedCycles.add(key);
        issues.push({
          code: 'cycle',
          nodeIds: cycle,
          message:
            `节点 ${cycle.join(' → ')} 连成了环：本项目的图不做循环与回边，重试由节点的 retryTimes 表达，` +
            '循环会让 attempts 既是重试计数又是统计原料而失去含义',
        });
      }
      return;
    }
    state.set(nodeId, 'visiting');
    for (const edge of outgoing.get(nodeId) ?? []) walk(edge.target, [...path, nodeId]);
    state.set(nodeId, 'done');
  };
  for (const node of graph.nodes) walk(node.id, []);

  // ⑤ 外发缺 target：`target` 参与幂等键 `runId+nodeId+target`（2.4-06），空串意味着
  // "往哪儿发都不知道"，重放去重也就无从判定——所以外发节点必须有目标才许保存。
  for (const node of graph.nodes) {
    if (node.effect === 'outbound' && node.target.trim().length === 0) {
      issues.push({
        code: 'outboundMissingTarget',
        nodeIds: [node.id],
        message: `外发节点 ${node.id} 没有动作对象（target 为空），幂等键与闸门都判不了这一件事`,
      });
    }
  }

  return issues;
}

/**
 * 这张图能不能保存。
 * @param graph 待校验的图读数
 * @param descriptors 算子描述表（默认可见）
 * @returns 无问题时 true；界面要展示逐条原因请直接用 `checkWorkflowGraph`
 */
export function isWorkflowGraphValid(
  graph: WorkflowGraphShape,
  descriptors: readonly OperatorDescriptor[] = WORKFLOW_OPERATORS,
): boolean {
  return checkWorkflowGraph(graph, descriptors).length === 0;
}
