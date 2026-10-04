/**
 * 工作流的**图语义层**（spec 5.10-02 / 5.10-06，plan §7.8.3 的 b 片）。
 *
 * 一句话定位：`plan.ts` 是"执行用的线性读数"，这里加的是"编辑与画布用的图读数"，
 * 而两者不是两份真相——线性计划经 `projectPlanToGraph` 原样投影成一条链，
 * 指纹走 `canonical.ts` 里那唯一一把（所以投影前后的指纹必须相同）。
 *
 * 刻意**不重写** `BOSS_BASIC_PLAN` 那三条内置计划的声明（F27）：加概念而不是改数据，
 * 才让 5.10-02 的判据（不重写即可作为图加载）有意义。
 */
import {
  AppError,
  WORKFLOW_DEFAULT_OUTPUT,
  type WorkflowEdgeView,
  type WorkflowGraphView,
  type WorkflowNodeSpec,
  type WorkflowPlanView,
} from '@auto-cc/core';
import { z } from 'zod';
import { graphFingerprint, isLinearProjection } from './canonical.js';
import { topologicalOrder } from './graph-advance.js';
import { buildPlan, workflowNodeSpecSchema } from './plan.js';

/** 一张图里边的数量上限：节点上限 64 时全连接是 4096 条，那不是"一条计划"而是另一件事。 */
const EDGE_CEILING = 128;

/** 一条执行边的声明形状（出口 `sourceHandle` 省略即 `default`）。 */
export const workflowEdgeSchema = z.strictObject({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceHandle: z.string().min(1).default(WORKFLOW_DEFAULT_OUTPUT),
  target: z.string().min(1),
});

/**
 * 一个节点的**视图层**读数：画布上的落点（逻辑像素，可为负）。
 *
 * 它与边分开存、分开序列化，而且**没有**任何路径能把它喂进指纹（`graphFingerprint` 的形参里
 * 就没有它）——这是 5.10-06「拖位置不许改变执行身份」的结构保证，而不是一句注释。
 */
export const workflowNodeViewSchema = z.strictObject({
  nodeId: z.string().min(1),
  x: z.number().finite(),
  y: z.number().finite(),
});

/** 整张图的声明形状；`fingerprint` 同 `workflowPlanSchema`，出现在输入里只为让「存进去→读回来」不报错。 */
export const workflowGraphSchema = z.strictObject({
  id: z.string().min(1),
  nodes: z.array(workflowNodeSpecSchema).min(1).max(64),
  edges: z.array(workflowEdgeSchema).max(EDGE_CEILING).default([]),
  fingerprint: z.string().length(8).optional(),
});

/** 视图层的独立通道（5.10-e 落 `workflow_plans.views_json` 的就是这段文本）。 */
export const workflowViewsSchema = z.array(workflowNodeViewSchema).max(64);

/** zod 输入侧形状：带默认值的键可省略。 */
export type GraphInput = z.input<typeof workflowGraphSchema>;

/**
 * 按节点顺序连成一条链：`nodes[0] → nodes[1] → …`，出口全是 `default`。
 * @param nodes 顺序即执行顺序的节点数组
 * @returns n-1 条边；边 id 由下标定死（`linear-1`、`linear-2`…），所以同一份计划两次投影得到同一组 id
 */
export function linearEdges(nodes: readonly WorkflowNodeSpec[]): WorkflowEdgeView[] {
  return nodes.slice(1).map((node, index) => ({
    id: `linear-${index + 1}`,
    source: (nodes[index] as WorkflowNodeSpec).id,
    sourceHandle: WORKFLOW_DEFAULT_OUTPUT,
    target: node.id,
  }));
}

/**
 * 把一条**线性**计划原样投影成图（spec 5.10-02 的判据本体）。
 * @param plan 已经过 `buildPlan` 校验、算好指纹的计划读数
 * @returns 同一份语义的图读数，`fingerprint` 与计划一致（一把哈希，见 `canonical.ts`）
 * @throws 任一节点声明了非 `default` 出口时以 `INVALID_ARGUMENT` 失败并点出节点 id——
 *         有分支出口的线性计划本身就不成立，投影方**不猜**该从哪个出口连下去（图校验是 5.10-d 的活）
 */
export function projectPlanToGraph(plan: WorkflowPlanView): WorkflowGraphView {
  for (const node of plan.nodes) {
    const declared = node.outputs;
    if (declared !== undefined && !(declared.length === 1 && declared[0] === WORKFLOW_DEFAULT_OUTPUT)) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `节点 ${node.id} 声明了多个出口，无法按线性顺序投影成图`,
        'workflow.graph',
        { planId: plan.id, nodeId: node.id, outputs: declared },
      );
    }
  }
  return {
    id: plan.id,
    nodes: plan.nodes.map((node) => ({ ...node })),
    edges: linearEdges(plan.nodes),
    fingerprint: graphFingerprint(plan.nodes, linearEdges(plan.nodes)),
  };
}

/**
 * 把一张图投影回**可执行本体**（plan §7.8.3-bis 裁定六：`plan_json` 是 `graph_json` 的投影）。
 *
 * 为什么必须有这一条：5.10-e 的保存口只写 `graph_json`，于是画布上加一个节点再保存，库里就是
 * 「图里 4 个节点、可执行本体 3 个节点」两份事实，而 runner 的 `requireExecutable`、节点参数、
 * 面板槽位读的全是后者。方向与内置那侧相反（内置是 `plan` 为真相、图由 `projectPlanToGraph` 现算），
 * 但**同源**：两条都只有一份节点集合，写点仍只有保存口一处。
 * @param graph 已过 `buildGraph` 与保存前五条校验的图读数
 * @returns 节点按 `topologicalOrder` 排好、指纹由 `buildPlan` 现算的计划本体；
 *          边只留在 `graph_json`，所以分支图的本体指纹是"节点集合 + 拓扑顺序"这一层
 * @throws 无（无环由保存前校验保证，拓扑序必然覆盖全部节点——不会发生的事不写守卫，AGENTS.md §2.6）
 */
export function projectGraphToPlan(graph: WorkflowGraphView): WorkflowPlanView {
  const position = new Map(topologicalOrder(graph).map((id, index) => [id, index]));
  const nodes = [...graph.nodes].sort((left, right) => (position.get(left.id) ?? 0) - (position.get(right.id) ?? 0));
  return buildPlan({ id: graph.id, nodes });
}

/**
 * 把一份图（外部数据也行：界面编辑结果、库里读回的 `graph_json`）解析成可信读数。
 *
 * 这一层只做**结构**判据（重名节点、边端点不存在、边 id 重复、线性计划读回时边与顺序不符），
 * 有环 / 悬挂出口 / 外发缺 target 那几条属保存前校验，在 5.10-d。
 * @param raw 来自界面或数据库 JSON 列的原始值
 * @returns 补全默认值并**重算过指纹**的图读数
 * @throws 结构不合时以 `TypeError` 抛出并列出问题——不返回半张图，否则会落库一张永远跑不动的图
 */
export function buildGraph(raw: unknown): WorkflowGraphView {
  const parsed = workflowGraphSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TypeError(`工作流图不合法：${parsed.error.issues.map((item) => item.message).join('；')}`);
  }
  const nodeIds = new Set<string>();
  for (const node of parsed.data.nodes) {
    if (nodeIds.has(node.id)) throw new TypeError(`工作流图有重名节点 ${node.id}`);
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of parsed.data.edges) {
    if (edgeIds.has(edge.id)) throw new TypeError(`工作流图有重名边 ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source)) throw new TypeError(`工作流图的边 ${edge.id} 指向不存在的起点 ${edge.source}`);
    if (!nodeIds.has(edge.target)) throw new TypeError(`工作流图的边 ${edge.id} 指向不存在的终点 ${edge.target}`);
  }
  // 线性投影的边必须由顺序**重算**：外部传进来的线性边若是 `custom-1` 这类 id，同一份语义就会
  // 因为 id 写法不同而拿到不同指纹，续跑判据就成了一句空话（与 buildPlan 不信传入指纹同一条理由）。
  const edges = isLinearProjection(parsed.data.nodes, parsed.data.edges)
    ? linearEdges(parsed.data.nodes)
    : parsed.data.edges.map((edge) => ({ ...edge }));
  return {
    id: parsed.data.id,
    nodes: parsed.data.nodes.map((node) => ({ ...node })),
    edges,
    fingerprint: graphFingerprint(parsed.data.nodes, edges),
  };
}

/**
 * 把视图层读数收成**规范文本**（按节点 id 排序，落库存这一份，画布重开时按它摆位）。
 * @param views 界面拖出来的落点，顺序不可信
 * @returns 键有序的 JSON 文本；同一组落点无论以什么顺序传入都得到同一串字节
 */
export function canonicalViewsText(views: readonly z.input<typeof workflowNodeViewSchema>[]): string {
  const parsed = workflowViewsSchema.parse(views);
  const sorted = [...parsed].sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
  return JSON.stringify(sorted);
}
