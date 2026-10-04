/**
 * 画布的编辑命令栈（spec 5.10-19，plan §5.10.6 末尾那句"撤销重做是画布级命令栈，自建"）。
 *
 * `@xyflow/react` 不提供历史栈，而这三个动作（加节点、连线、改参数）正是判据点名的三类编辑，
 * 所以这里做**唯一**的一份实现：放在 `@auto-cc/core` 让渲染层（L4）与 workflow 的保存口（L3）
 * 读同一份语义（同一条理由见 `graph-check.ts` 头注）。渲染层取它走 `@auto-cc/core/graph-edit` 窄出口。
 *
 * 两条设计取舍写清楚，免得后人以为还能更"聪明"：
 * - **存快照而不是存逆操作**。一张图的体量上限是 64 节点 / 128 边（`graph.ts` 的 schema 定死），
 *   一份深拷贝成本可忽略；而逆操作要为三类编辑各写一份反向逻辑（改参数还得记住旧值），
 *   那是同一件事的第二套实现，漂了就变成"撤销一次得到一张哪都没见过的图"（AGENTS.md §2.6/§2.7）。
 * - **落点不进栈**。拖动位置属视图层、不参与指纹（5.10-06 已钉成用例），把它算作一步撤销单元
 *   会让"回退到底"这件事无法逐字段比对——用户按撤销时也不会期待位置跟着跳回去。
 */
import { WORKFLOW_DEFAULT_OUTPUT, type WorkflowEdgeView, type WorkflowNodeSpec } from './events.js';

/** 一张可编辑的图：只有执行语义，落点与状态色都在别处。 */
export type WorkflowGraphDraft = {
  nodes: WorkflowNodeSpec[];
  edges: WorkflowEdgeView[];
};

/** 边的自然键：同一对（起点, 出口, 终点）只可能存在一条，重复连线不当成一次编辑。 */
export function workflowEdgeIdOf(source: string, sourceHandle: string, target: string): string {
  return `${source}:${sourceHandle}->${target}`;
}

/** 命令栈的读数（界面用它置灰撤销/重做按钮）。 */
export type WorkflowGraphEditor = {
  /** 当前图（**副本**：调用方改不动栈里的状态）。 */
  draft(): WorkflowGraphDraft;
  /** 还能往回退几步。 */
  canUndo(): boolean;
  /** 还能往前重做几步。 */
  canRedo(): boolean;
  /**
   * 加一只节点。
   * @param node 补全过默认值的节点声明
   * @returns 生效返回 true；id 与已有节点重复时不生效（不产生一条空撤销单元）
   */
  addNode(node: WorkflowNodeSpec): boolean;
  /**
   * 连一条执行边。
   * @param source 起点节点 id
   * @param sourceHandle 起点出口名（省略即 `default`）
   * @param target 终点节点 id
   * @returns 生效返回 true；端点不在图上或这条边已存在时不生效。
   *          注意**回边不在这里拦**（自环、A→B→A 都会进图），因为它属图语义合法性，
   *          由 `checkWorkflowGraph` 逐条报出并给"不做循环"的理由——判据要的是拒绝并说明原因，
   *          而不是让连线静默失效（5.10-14）。
   */
  connect(source: string, sourceHandle?: string, target?: string): boolean;
  /**
   * 写回一只节点的参数（表单校验通过之后才会走到这里，见 c 片的 `OperatorParamForm`）。
   * @param nodeId 目标节点 id
   * @param params 已按 zod 补全的参数
   * @returns 生效返回 true；节点不存在或参数与现值逐字段相同（空编辑）时返回 false
   */
  setParams(nodeId: string, params: WorkflowNodeSpec['params']): boolean;
  /**
   * 回退一步。
   * @returns 退成功返回 true；栈空时 false 且当前图不变
   */
  undo(): boolean;
  /**
   * 重做一步（只在退回去之后又没做新编辑时可用）。
   * @returns 成功返回 true；没有可重做的步骤时 false
   */
  redo(): boolean;
};

/**
 * 深拷一张图：参数对象逐节点拷，边逐条拷。
 * @param draft 栈里存着的那份
 * @returns 内容相同、引用无关的新图
 */
function cloneDraft(draft: WorkflowGraphDraft): WorkflowGraphDraft {
  return {
    nodes: draft.nodes.map((node) => ({
      ...node,
      params: { ...node.params },
      ...(node.outputs ? { outputs: [...node.outputs] } : {}),
    })),
    edges: draft.edges.map((edge) => ({ ...edge })),
  };
}

/** 历史栈的默认深度：一屏一屏地撤销几十次是人的极限，再深只是内存占用（§2.6 不做未来抽象）。 */
const DEFAULT_HISTORY_CEILING = 50;

/**
 * 建一只编辑命令栈。
 * @param initial 初始图（拷一份进去，调用方之后改原数组不影响栈）
 * @param historyCeiling 最多留几步历史，超出丢最老的（默认 50）
 * @returns 命令栈读数；四个编辑动作都只在**真的改变了图**时产生一条撤销单元
 */
export function createWorkflowGraphEditor(
  initial: WorkflowGraphDraft,
  historyCeiling: number = DEFAULT_HISTORY_CEILING,
): WorkflowGraphEditor {
  let present = cloneDraft(initial);
  const past: WorkflowGraphDraft[] = [];
  let future: WorkflowGraphDraft[] = [];

  /**
   * 把当前图压进历史并换上下一份状态。
   * @param next 编辑后的图（会被拷一份）
   */
  function commit(next: WorkflowGraphDraft): void {
    past.push(present);
    if (past.length > historyCeiling) past.shift();
    present = next;
    // 新编辑一律作废"重做"分支：这不是协同编辑，没有"两条历史线"要留（§5.10.8 明确不做多人协同）。
    future = [];
  }

  return {
    draft() {
      return cloneDraft(present);
    },
    canUndo() {
      return past.length > 0;
    },
    canRedo() {
      return future.length > 0;
    },
    addNode(node) {
      if (present.nodes.some((candidate) => candidate.id === node.id)) return false;
      commit({ nodes: [...present.nodes, node], edges: present.edges });
      return true;
    },
    connect(source, sourceHandle = WORKFLOW_DEFAULT_OUTPUT, target = '') {
      const edgeId = workflowEdgeIdOf(source, sourceHandle, target);
      const known = new Set(present.nodes.map((node) => node.id));
      if (!known.has(source) || !known.has(target)) return false;
      if (present.edges.some((edge) => edge.id === edgeId)) return false;
      commit({ nodes: present.nodes, edges: [...present.edges, { id: edgeId, source, sourceHandle, target }] });
      return true;
    },
    setParams(nodeId, params) {
      const index = present.nodes.findIndex((node) => node.id === nodeId);
      if (index < 0) return false;
      const previous = (present.nodes[index] as WorkflowNodeSpec).params;
      const keys = new Set([...Object.keys(previous), ...Object.keys(params)]);
      const unchanged = [...keys].every((key) => previous[key] === params[key]);
      if (unchanged) return false;
      const nextNodes = present.nodes.map((node, candidate) =>
        candidate === index ? { ...node, params: { ...params } } : node,
      );
      commit({ nodes: nextNodes, edges: present.edges });
      return true;
    },
    undo() {
      const previous = past.pop();
      if (!previous) return false;
      future.push(present);
      present = previous;
      return true;
    },
    redo() {
      const next = future.pop();
      if (!next) return false;
      past.push(present);
      present = next;
      return true;
    },
  };
}
