/**
 * 图的**推进语义**（spec 5.10-07 / 08 / 09 的判据本体，plan §7.8.3 的 f 片）。
 *
 * 一句话定位：`machine.ts` 是「下标 +1」的线性状态机，这里给的是「按当前节点的出口查边」的图读数。
 * 刻意做成**纯函数**——不碰数据库、不碰执行器、不起定时器：DAG 的「谁现在可以跑」这件事必须能被
 * 单测穷举（分支、汇聚、级联跳过），而一旦被塞进 runner 的 `void` 循环里，5.10-09 的 join 计数就只剩
 * 活体截图能证，而截图证不了「只执行一次」这一条（plan §7.8.3 f 行把它标成 U+V 就是这个原因）。
 *
 * 与校验层的分工：`@auto-cc/core/graph-check` 保证**存进库的图**无环、单源点集合自洽、边端点存在；
 * 因此这里的推进循环必然在 ≤节点数 轮内收敛（每一轮至少结算一个节点），不再另加一道"防死循环"的
 * 异常处理（AGENTS.md §2.6：不会发生的事不写守卫）。
 */
import { AppError, WORKFLOW_DEFAULT_OUTPUT, type WorkflowGraphView } from '@auto-cc/core';

/** 一个节点的结算方式：跑完了，还是因为上游那支没被选中而跳过。 */
export type GraphNodeStatus = 'done' | 'skipped';

/**
 * 一个节点的结算读数。
 *
 * `output` 是**实际走过的出口句柄**（线性节点就是 `default`），它必须留档：
 * 分支节点声明了 `yes` / `no` 两个出口，只有它决定哪条入边算「到齐」，
 * 而汇聚节点要等的是「上游全部结算」，判据里就得能查到上游当年走的是哪个出口。
 */
export type GraphNodeOutcome = { status: GraphNodeStatus; output: string | null };

/** 推进状态的可序列化读数：界面/库里都能原样拿它当状态（同 `machine.ts` 的口径）。 */
export type GraphAdvanceView = {
  /** 已结算的节点：键是节点 id，顺序不参与任何判定（判定只看边）。 */
  outcomes: Record<string, GraphNodeOutcome>;
  /**
   * 此刻可并行起跑的节点（入边全部到齐、且至少一条是"活着"的）。
   * 顺序是 `graph.nodes` 里的声明顺序，所以同一份状态两次读得到同一个数组。
   */
  ready: string[];
  /** 整张图是否已无待执行节点——runner 据此把 run 判成 done。 */
  finished: boolean;
};

/** 一次推进的输入：刚结算的那个节点、它的结局、走过的出口（省略即 `default`）。 */
export type GraphAdvanceInput = { nodeId: string; status: GraphNodeStatus; output?: string };

/**
 * 图的起跑状态：起点集合 = **没有任何入边**的节点。
 *
 * 保存前校验已保证「只能有一个起点」之外的形状不入库，所以这里直接把它当起跑前沿用，
 * 不再按 `nodes[0]` 猜（那条线性投影里两者相同，但图形态下顺序不可信——5.10-06）。
 * @param graph 已经过 `buildGraph` 的图读数
 * @returns `outcomes` 为空、`ready` 为起点集合、`finished` 为 false 的推进状态
 */
export function initialAdvanceState(graph: WorkflowGraphView): GraphAdvanceView {
  const hasIncoming = new Set(graph.edges.map((edge) => edge.target));
  const ready = graph.nodes.filter((node) => !hasIncoming.has(node.id)).map((node) => node.id);
  return { outcomes: {}, ready, finished: ready.length === 0 };
}

/**
 * 把一次「节点结束」推进成新的图状态。
 *
 * 步骤固定三段：记这笔结算 → 级联判跳过（谁的上游全结算了却一条活边都没等到，它就是 skipped）→
 * 重算可起跑的节点。级联要跑到不动点，因为跳转会继续让下游失去入边（分支图里一次跳过常常连着三格）。
 * @param state 推进前的状态（不改动它，返回新的）
 * @param graph 同一张图（推进过程中不许换图——换图意味着指纹变了，那是 5.10-07 的续跑判据）
 * @param input 刚结算的节点与它走过的出口
 * @returns 新的推进状态；`ready` 空且 `finished` 为 false 时说明还有节点在等上游（并行未汇聚完）
 * @throws `INVALID_ARGUMENT` 节点 id 不在这张图里——续跑时图被改过就会出现这种读数，宁可停下也不猜
 */
export function advanceGraph(
  state: GraphAdvanceView,
  graph: WorkflowGraphView,
  input: GraphAdvanceInput,
): GraphAdvanceView {
  const node = graph.nodes.find((item) => item.id === input.nodeId);
  if (!node) {
    throw new AppError('INVALID_ARGUMENT', `节点 ${input.nodeId} 不在这张图里，无法推进`, 'workflow.advance', {
      graphId: graph.id,
      nodeId: input.nodeId,
    });
  }
  const declared = node.outputs ?? [WORKFLOW_DEFAULT_OUTPUT];
  const output = input.output ?? WORKFLOW_DEFAULT_OUTPUT;
  if (input.status === 'done' && !declared.includes(output)) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `节点 ${node.id} 没有声明出口 ${output}，能走的是 ${declared.join(' / ')}`,
      'workflow.advance',
      { graphId: graph.id, nodeId: node.id, declared },
    );
  }
  const outcomes: Record<string, GraphNodeOutcome> = {
    ...state.outcomes,
    [node.id]: { status: input.status, output: input.status === 'done' ? output : null },
  };
  // 级联到不动点：每轮至少多结算一个节点（无环保证），所以不需要"最多几轮"这种兜底。
  let previous = -1;
  while (previous !== Object.keys(outcomes).length) {
    previous = Object.keys(outcomes).length;
    for (const item of graph.nodes) {
      if (outcomes[item.id]) continue;
      const incoming = graph.edges.filter((edge) => edge.target === item.id);
      // 入边还没全部结算：它既不该跑，也不该被判跳过，只能继续等（并行汇聚的一半状态就是这个）。
      if (!incoming.every((edge) => outcomes[edge.source])) continue;
      const arrived = incoming.some((edge) => isArrived(edge, outcomes));
      if (!arrived) outcomes[item.id] = { status: 'skipped', output: null };
    }
  }
  const ready = graph.nodes
    .filter((item) => !outcomes[item.id])
    .filter((item) => {
      const incoming = graph.edges.filter((edge) => edge.target === item.id);
      // 无入边 = 起点（一次运行里它只会被 dispatch 一次，因为起点唯一）。
      return incoming.length > 0 && incoming.every((edge) => outcomes[edge.source])
        ? incoming.some((edge) => isArrived(edge, outcomes))
        : incoming.length === 0;
    })
    .map((item) => item.id);
  return { outcomes, ready, finished: Object.keys(outcomes).length === graph.nodes.length };
}

/**
 * 一条入边是否「活着」：上游跑完了，且它当年走的就是这条边写着的那个出口句柄。
 * @param edge 待判的边
 * @param outcomes 上游的结算读数
 * @returns 这条边是否把执行权送到了它的终点
 */
function isArrived(edge: WorkflowGraphView['edges'][number], outcomes: Record<string, GraphNodeOutcome>): boolean {
  const outcome = outcomes[edge.source];
  return outcome?.status === 'done' && outcome.output === edge.sourceHandle;
}
