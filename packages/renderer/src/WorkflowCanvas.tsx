/**
 * 算子图画布（spec 5.10-01 的骨架 + 5.10-03/04 的编辑态第一层 + 5.10-d 的连线、命令栈与保存前校验
 * + 5.10-g 的"运行态叠在编辑态同一张图上" + 5.10-10 的写入口「保存到库」）。
 *
 * 两种画法共用**同一张图**（§5.10.5 的口径）：
 * - **图的节点与边**来自库：下拉里选中那条计划时经 `workflow.graph.load` 读进来（5.10-02 要的
 *   「内置线性计划不重写就能画成一条链」就是这一条），没选计划时退化成照运行镜像摆格子。
 * - **状态**来自 `workflow/progress` 推来的 `steps`，只叠在 id 对得上的格子上；画布自己不发起请求、
 *   不起定时器（spec 5.10-11 要求"离开画布无残留句柄"，所以它由面板按开合挂载/卸载，而不是常驻）。
 *   点开一格看它的参数 / attempts / 耗时 / 证据是另一件事：那一份读数由 `WorkflowNodeDetail`
 *   **在点开那一刻**去库里问一次（spec 5.10-12），不参与格子的状态，画布因此仍没有第二个状态源。
 * - **运行时只读**（5.10-11）：`isReadOnly` 由父层按 run 状态给出，调色板、连线、参数表单、撤销重做
 *   在那期间一律禁用——改图会换指纹，而「计划已修改 → 旧 run 不可续跑」正是 5.10-07 要的结果，
 *   所以这条路根本不该在运行期间存在，而不是留给用户去踩。
 * - **算子形状来自描述表**：一只节点的全部外观与参数形状都由 `WORKFLOW_OPERATORS` 里那一行
 *   决定（图标、危险度徽标、出口句柄数、表单字段），这里没有 per-算子 的分支。
 *
 * - **位置是视图层**：拖完之后位置由画布自己持有，不进命令栈、不参与指纹（5.10-06 已把这条钉成测试）。
 * - **边是执行顺序**：库里的边照画，镜像里多出的那几格（图上没有）按镜像顺序补一条链。
 * - **合法性规则不在这里长第二份**：五条保存前校验读 `@auto-cc/core/graph-check`（渲染层与 L3 的保存口
 *   同一份规则，plan 裁定九），界面只按 `code` 取文案、按 `nodeIds` 落红环。
 * - **配色与步骤行同源**：`STEP_STATUS_STYLE` 与工作流面板共用一份，同一状态在两处必须同色。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import {
  WORKFLOW_OPERATORS,
  checkWorkflowGraph,
  createWorkflowGraphEditor,
  operatorByKind,
  operatorParamDefaults,
  type OperatorDescriptor,
  type WorkflowGraphDraft,
  type WorkflowGraphEditor,
  type WorkflowGraphIssue,
  type WorkflowGraphLoadView,
  type WorkflowNodeSpec,
  type WorkflowStepView,
} from '@auto-cc/shared';
import { STEP_STATUS_STYLE } from './stepStatusStyle';
import { OperatorPalette } from './OperatorPalette';
import { OperatorParamForm } from './OperatorParamForm';
import { WorkflowNodeDetail } from './WorkflowNodeDetail';
import { operatorIconOf } from './operator-icons';
import { useBridgeAction } from './useBridgeAction';

/** 格子的初始摆放间距（像素）；库里存过落点时以落点为准（裁定三）。 */
const NODE_GAP_X = 260;

/** 多出口算子的源句柄纵向落点——用 Tailwind 任意值而不是手写 CSS（AGENTS.md §5.1）。 */
const SOURCE_HANDLE_CLASS = ['!top-1/2', '!top-[70%]', '!top-[88%]'] as const;

/** 校验点名的格子加一圈红环；状态色仍完全由 `STEP_STATUS_STYLE` 决定，这里不碰它。 */
const ISSUE_RING_CLASS = 'ring-2 ring-rose-500';

/** 节点卡片要显示的读数——运行态取步骤镜像，编辑态取算子描述。 */
interface OperatorData extends Record<string, unknown> {
  /** 节点 id：harness 按它定位格子，必须是稳定值而不是译文 */
  stepId: string;
  /** 展示标签，语言包没有条目时退回 id 本身 */
  label: string;
  /** 步骤状态，取 shared 的四种（`skipped` 的写点在 f 片才有） */
  status: WorkflowStepView['status'];
  /** 第几步（从 1 开始，与步骤行的序号同口径） */
  order: number;
  /** 算子 kind：图上每一格都有；只有"镜像里有、图上没有"那几格拿不到（步骤镜像里没有这一项） */
  kind: string | null;
  /** 这只格子被保存前校验点名了吗（红环依据是它，不是那句文案） */
  hasIssue: boolean;
}

type OperatorNode = Node<OperatorData, 'operator'>;

/**
 * 画布上一格格子的读数——图上的格子与运行镜像补的格子统一成这一个形状，
 * 下面摆节点、连边、选中都只认它，不再分两套路径（5.10-g 的「同一张图」）。
 */
interface CanvasCell {
  /** 格子 id：图上格子和镜像格子都稳定，harness 按它定位 */
  id: string;
  /** 展示标签（图上格子来自描述表，镜像格子来自 `workflow.step.<id>`） */
  label: string;
  /** 叠加后的状态：图上格子取镜像同 id 那一格，取不到是 pending */
  status: WorkflowStepView['status'];
  /** 算子 kind；只有镜像补的那几格是 null（步骤镜像里没有这一项） */
  kind: string | null;
  /** 这一格来自库里的图，还是来自运行镜像（决定它有没有参数可填、边从哪来） */
  isFromGraph: boolean;
}

/**
 * 由描述表造一只草稿节点的声明（命令栈里存的就是这个形状，与运行侧的节点声明同构）。
 *
 * `target` 留空串是**如实**而不是省事：画布上新加的格子还没有动作对象，而"外发节点缺 target"正是
 * 五条校验里的一条（5.10-05），所以这里不替用户编一个目标，让校验把它点出来。
 * @param descriptor 被点中的算子描述
 * @param nodeId 新格子的 id
 * @returns 七字段齐全的节点声明（参数只带 schema 里声明过的默认值）
 */
function draftNodeSpec(descriptor: OperatorDescriptor, nodeId: string): WorkflowNodeSpec {
  return {
    id: nodeId,
    kind: descriptor.kind,
    target: '',
    params: operatorParamDefaults(descriptor),
    effect: descriptor.effect,
    retryTimes: null,
    requiresHuman: false,
    // 只有多出口算子才写 outputs：省略即"只有 default 出口"，与 2.4 时代留下的计划文本同一条读法
    ...(descriptor.outputs.length > 1 ? { outputs: [...descriptor.outputs] } : {}),
  };
}

/**
 * 单个算子格子：一张带连接点的卡片，外观按描述表派生。
 * @param data 该节点的读数
 * @returns 节点卡片
 */
function OperatorNodeCard({ data }: NodeProps<OperatorNode>) {
  const { t } = useTranslation();
  const descriptor = data.kind ? operatorByKind(data.kind) : undefined;
  const Icon = descriptor ? operatorIconOf(descriptor.icon) : null;
  const outputs = descriptor?.outputs ?? ['default'];
  return (
    <div
      data-testid="canvas-node"
      data-node-id={data.stepId}
      data-node-status={data.status}
      data-kind={data.kind ?? ''}
      data-node-issue={data.hasIssue ? 'true' : 'false'}
      className={`rounded-lg border px-3 py-2 text-[11px] shadow-sm ${STEP_STATUS_STYLE[data.status]} ${
        data.hasIssue ? ISSUE_RING_CLASS : ''
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="default"
        className="!h-2 !w-2 !border-2 !border-slate-700 !bg-slate-950"
      />
      <span className="flex items-center gap-1">
        {Icon ? <Icon size={11} /> : <span className="font-mono text-xs opacity-60">{String(data.order)}</span>}
        <span className="break-all">{data.label}</span>
      </span>
      {/* 危险度徽标只说描述表里那一档，界面不给用户挑危险度的机会（闸门读的就是这一项）。 */}
      {descriptor ? (
        <span className="mt-1 block text-[10px] text-slate-400">
          {t(`workflow.operator.effect.${descriptor.effect}`)}
        </span>
      ) : null}
      {outputs.map((output, handleIndex) => (
        <Handle
          key={output}
          type="source"
          position={Position.Right}
          id={output}
          className={`!h-2 !w-2 !border-2 !border-slate-700 !bg-slate-950 ${
            SOURCE_HANDLE_CLASS[Math.min(handleIndex, SOURCE_HANDLE_CLASS.length - 1)]
          }`}
        />
      ))}
    </div>
  );
}

/** `nodeTypes` 必须在组件外定义：每次渲染新建对象会让 react-flow 重建所有节点。 */
const NODE_TYPES = { operator: OperatorNodeCard } as const;

export interface WorkflowCanvasProps {
  /** 当前 run 的步骤镜像（`workflow/progress` 推来的那份，不是画布自己读的）；没有 run 时是空表 */
  steps: WorkflowStepView[];
  /**
   * 下拉里选中的那条计划的 id——画布照它的图库版本摆格子（5.10-02）。
   * undefined = 用户没选（`start()` 的默认路径是「沿用 runner 当下装载的那份」，而那份的 id 界面读不到，
   * 也不该由界面猜），此时画布只照 `steps` 摆，不冒充「这就是库里的图」。
   */
  planId: string | undefined;
  /** 有正在进行的 run（running / paused）：画布只读（5.10-11），判据由父层给，画布不自己问 runner */
  isReadOnly: boolean;
}

/**
 * 画布主体：库里那条计划的图 + 叠在上面的运行状态 + 算子库新加进来的格子。
 * @param props 见 `WorkflowCanvasProps`
 * @returns 可平移缩放、格子可拖拽、能加算子并填参数的画布
 */
function WorkflowCanvasBoard({ steps, planId, isReadOnly }: WorkflowCanvasProps) {
  const { t } = useTranslation();
  const flow = useReactFlow<OperatorNode>();

  /**
   * 命令栈只在 ref 里活着一份：它是可变对象（`undo` 会改内部指针），放进 state 会让每次编辑
   * 都新建一个实例、历史在两次渲染之间被丢掉。真正驱动渲染的是下面那份快照。
   */
  const editorRef = useRef<WorkflowGraphEditor | null>(null);
  if (editorRef.current === null) {
    editorRef.current = createWorkflowGraphEditor({ nodes: [], edges: [] });
  }

  /** 图上那一份只读快照（命令栈的内容在编辑器对象里，React 读不到，所以每次编辑后复制一份出来） */
  const [snapshot, setSnapshot] = useState<WorkflowGraphDraft>({ nodes: [], edges: [] });
  /** 上一次"保存前校验"的结果；null = 还没校验过（不是"校验过且没问题"） */
  const [issues, setIssues] = useState<WorkflowGraphIssue[] | null>(null);
  /**
   * 点开的格子（spec 5.10-12）：画布下方摆两张卡——参数卡（描述表派生）与运行读数卡（库里那一行）。
   * 只有一格能选中，因为这两张卡说的都是"这一格"，同时选中两格会让用户分不清读数在讲谁。
   */
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  /**
   * 画布现在照的是库里哪条计划（5.10-02 的判据要在界面上认得出来源），以及覆盖保存要的版本号。
   * null = 没照库画（没选计划，或那次读数没成功），此时格子来自运行镜像，没有可写的对象。
   *
   * `revision` 是覆盖保存的乐观并发凭据：每存成功一次跟上一次，同一张图在两个窗口各改一版时，
   * 后写那一次由保存口拒掉并报错，而不是静默抹掉前一版（`WorkflowGraphLoadView.revision` 的对面）。
   * 这里**不记「这条计划是不是自定义的」**："库里有这一行才存得下"由保存口判（它读同一张表），
   * 界面再判一次就是第二份事实，而且读回来的 `isCustom` 说的是"图存过没有"，不是同一件事。
   */
  const [loaded, setLoaded] = useState<{ planId: string; revision: number } | null>(null);
  /** 拖拽后的落点（视图层）：图上格子与镜像补的格子都按这一份覆盖初始摆放。 */
  const [dragOffsets, setDragOffsets] = useState<Record<string, { x: number; y: number }>>({});
  /** 图变过一次就自增一次，让下面的 effect 重新贴合视口（0 = 还没变过，不该动用户的视野）。 */
  const [fitRequestId, setFitRequestId] = useState(0);
  const bridge = window.autoCC;

  /**
   * 把命令栈的当前图复制成一份 React 状态，并清掉上一轮的校验读数。
   *
   * 校验结果必须跟着编辑作废：图已经变了还挂着旧的红环与旧的原因，比不报更误导（用户会以为
   * 那只格子仍然有问题）。写盘前的硬拦在保存口（5.10-e 的 IPC），界面这里只负责"改了就不骗人"。
   */
  const sync = useCallback(() => {
    setSnapshot(editorRef.current?.draft() ?? { nodes: [], edges: [] });
    setIssues(null);
  }, []);

  /**
   * 用库里读来的那张图重铺命令栈：节点、边、落点都照库里那一版，撤销到底也回到这一版。
   *
   * 换一条计划就等于丢掉尚未入库的编辑——这是**如实**而不是省事：写入口是「保存到库」那一次明确的
   * 按钮（5.10-10），画布不做自动存草稿，所以没按过就还没进库，切走了也就没了。
   * @param view `workflow.graph.load` 的读数
   */
  const seedFromGraph = useCallback((view: WorkflowGraphLoadView) => {
    editorRef.current = createWorkflowGraphEditor({ nodes: view.graph.nodes, edges: view.graph.edges });
    setSnapshot({ nodes: view.graph.nodes, edges: view.graph.edges });
    setIssues(null);
    setDragOffsets(
      Object.fromEntries(view.placements.map((placement) => [placement.nodeId, { x: placement.x, y: placement.y }])),
    );
    setSelectedNodeId(null);
    setLoaded({ planId: view.planId, revision: view.revision });
    setFitRequestId((previous) => previous + 1);
  }, []);

  /** 一次读数没有「动作跑完重读快照」这回事，复用外壳只为忙碌态与失败提示的同一套呈现（§2.1，同 `NodeEvidenceSection`）。 */
  const nothingToReread = useCallback(() => Promise.resolve(), []);
  const { notice: graphNotice, run: runGraphAction } = useBridgeAction(nothingToReread);

  /**
   * 选中的计划变了就去库里读它的那张图（spec 5.10-02：内置线性计划不重写就能画成一条链）。
   * 只在这一条变化时读——运行进度仍由父层从 `workflow/progress` 推（5.10-11），画布不轮询 runner。
   */
  useEffect(() => {
    if (!planId) {
      setLoaded(null);
      return;
    }
    void runGraphAction(t('workflow.canvas.actionLoad'), () => bridge?.workflow['graph.load'](planId), {
      apply: seedFromGraph,
    });
  }, [planId, bridge, runGraphAction, seedFromGraph, t]);

  /** 被校验点名的节点 id——红环按这一份落，与文案无关（同一份事实的两个读数）。 */
  const issueNodeIds = useMemo(() => new Set((issues ?? []).flatMap((issue) => issue.nodeIds)), [issues]);

  /** 镜像里的状态按 id 索引：它是叠在图上那一层，不是第二批格子（5.10-g 的「同一张图」）。 */
  const statusById = useMemo(() => new Map(steps.map((step) => [step.id, step.status])), [steps]);

  /**
   * 画布上的格子：图上每一格（算子、参数、出口都由描述表说话），再加上「镜像里有、图上没有」那几格。
   * 后一种只出现在没选计划的时候——那时画布没有库里的图可照，只能照运行镜像摆，且如实标明不是图上的。
   */
  const canvasCells = useMemo<CanvasCell[]>(() => {
    const graphCells = snapshot.nodes.map<CanvasCell>((node) => {
      // 标题键也从描述表取：这里再拼一次 `workflow.operator.${kind}.title` 就是第二份规则（§2.2）。
      const descriptor = operatorByKind(node.kind);
      return {
        id: node.id,
        label: descriptor ? t(descriptor.titleKey, { defaultValue: node.kind }) : node.kind,
        status: statusById.get(node.id) ?? 'pending',
        kind: node.kind,
        isFromGraph: true,
      };
    });
    const inGraph = new Set(snapshot.nodes.map((node) => node.id));
    const mirrorCells = steps
      .filter((step) => !inGraph.has(step.id))
      .map<CanvasCell>((step) => ({
        id: step.id,
        label: t(`workflow.step.${step.id}`, { defaultValue: step.id }),
        status: step.status,
        kind: null,
        isFromGraph: false,
      }));
    return [...graphCells, ...mirrorCells];
  }, [snapshot, steps, statusById, t]);

  const nodes = useMemo<OperatorNode[]>(
    () =>
      canvasCells.map((cell, index) => ({
        id: cell.id,
        type: 'operator' as const,
        // 位置不进命令栈（5.10-06）：栈里那份没有 position 字段，初始落点由下标现算，
        // 拖过的落点存在视图层的 `dragOffsets` 里（库里存过的落点也在这一份里）——撤销一条边不会把格子弹回原位。
        position: dragOffsets[cell.id] ?? { x: index * NODE_GAP_X, y: 0 },
        data: {
          stepId: cell.id,
          label: cell.label,
          status: cell.status,
          order: index + 1,
          kind: cell.kind,
          hasIssue: issueNodeIds.has(cell.id),
        },
      })),
    [canvasCells, dragOffsets, issueNodeIds],
  );

  /**
   * 只接住位置变更：`nodes` 是受控的，落点回到 state 才拖得住；
   * 其余变更（select/dragging/remove）要么由 UI 自己走 `onNodeClick`，要么本片不开放删除。
   * @param changes react-flow 本轮报出的变更
   */
  const onNodesChange = useCallback((changes: NodeChange<OperatorNode>[]) => {
    setDragOffsets((previous) => {
      const next = { ...previous };
      let moved = false;
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          next[change.id] = change.position;
          moved = true;
        }
      }
      return moved ? next : previous;
    });
  }, []);

  /**
   * 从算子库加一格：id 由 kind 派生保证可读，参数初值只带 schema 里声明过的默认值。
   * @param descriptor 被点中的算子描述（整份从描述表来，画布不认识任何一只算子）
   */
  function addOperatorNode(descriptor: OperatorDescriptor) {
    const sameKindCount = snapshot.nodes.filter((draft) => draft.kind === descriptor.kind).length;
    const draftId = `${descriptor.kind.replaceAll('.', '-')}-draft-${String(sameKindCount + 1)}`;
    if (!editorRef.current?.addNode(draftNodeSpec(descriptor, draftId))) return;
    sync();
    setSelectedNodeId(draftId);
    setFitRequestId((previous) => previous + 1);
  }

  /**
   * 加完草稿重新贴合一次视口。
   *
   * 为什么必须自己做：`fitView` 这个 prop 只在挂载时生效一次（实测：草稿摆在运行链下方 y=250，
   * 点算子库加了格子之后节点在视口外，界面看起来像"点了没反应"）。延一帧是等 react-flow
   * 量到新节点的宽高，否则 fitView 会按 0 尺寸算边界。
   */
  useEffect(() => {
    if (fitRequestId === 0) return;
    const timer = setTimeout(() => {
      void flow.fitView({ duration: 200, padding: 0.25 });
    }, 50);
    return () => clearTimeout(timer);
  }, [fitRequestId, flow]);

  /**
   * 表单校验通过后写回节点参数（红标期间走不到这里，见 `OperatorParamForm`）。
   * @param nodeId 目标节点 id
   * @param params 已按 zod 补全的参数
   */
  function commitNodeParams(nodeId: string, params: Record<string, string | number | boolean>) {
    if (!editorRef.current?.setParams(nodeId, params)) return;
    sync();
  }

  /**
   * 连一条草稿之间的边（react-flow 报来的连接，句柄取用户实际拖到的那一个）。
   * @param connection 源节点/源句柄 → 目标节点/目标句柄
   */
  function onConnect(connection: Connection) {
    if (connection.source === null || connection.target === null) return;
    if (!editorRef.current?.connect(connection.source, connection.sourceHandle ?? undefined, connection.target)) {
      return;
    }
    sync();
  }

  /** 退回到上一条编辑之前的图；命令栈空时无事发生，按钮也按 canUndo 禁用。 */
  function undoEdit() {
    if (!editorRef.current?.undo()) return;
    sync();
  }

  /** 重做一条被撤销的编辑。 */
  function redoEdit() {
    if (!editorRef.current?.redo()) return;
    sync();
  }

  /**
   * 跑一遍五条保存前校验并把结果摆出来。
   *
   * 这里是**提示**而不是闸门：真正的硬拦在 5.10-e 的保存口（IPC 侧再跑同一个函数），
   * 因为"点按钮才校验"拦不住绕过界面的 agent。
   */
  function validateDraft() {
    setIssues(checkWorkflowGraph(snapshot, WORKFLOW_OPERATORS));
  }

  /**
   * 把画布上这一版写回库（spec 5.10-10 的写入口，plan §7.8.3-septies 的 B 片）。
   *
   * 界面这条只是**发起**：服务端那三道（结构 → 五条语义 → 版本号）在 `workflow.graph` 里跑，
   * 不合法就以结构化错误回来、库里那一版原样不动，所以这里不预先拦、也不猜"能不能存"——
   * 内置那三条不在 `workflow_plans` 表里，保存口会直接回「画布图无处可存，请先复制成自定义计划」，
   * 那句判据在存储层（它读那张表），界面再判一次就是第二份事实（§2.5）。
   * 落点从 `nodes` 现取而不重算初始摆放：那条规则只有一份（§2.2），抄第二份就会漂。
   */
  function saveDraft() {
    if (loaded === null) return;
    const graphCellIds = new Set(snapshot.nodes.map((node) => node.id));
    void runGraphAction(
      t('workflow.canvas.actionSave'),
      () =>
        bridge?.workflow['graph.save']({
          planId: loaded.planId,
          graph: { id: loaded.planId, nodes: snapshot.nodes, edges: snapshot.edges },
          placements: nodes
            .filter((node) => graphCellIds.has(node.id))
            .map((node) => ({ nodeId: node.id, x: node.position.x, y: node.position.y })),
          expectedRevision: loaded.revision,
        }),
      {
        // 存成功就把版本号跟上：库里那一版已经前进了，下一次保存的凭据必须是新的那一个。
        apply: (saved) => setLoaded((previous) => (previous ? { ...previous, revision: saved.revision } : previous)),
      },
    );
  }

  /**
   * 画布上的边。
   *
   * - 图上的边只从 `snapshot.edges` 来（库里存的那一份，或用户在算子库之间连出来的那一份）。
   * - **只有**「镜像里有、图上没有」那几格之间才按镜像顺序补一条链——那是没选计划、画布没有图可照时的
   *   退化态。图上已有这一格时绝不按步骤顺序再连一条，否则会凭空多出图里没有的边，与 5.10-07 的指纹不是同一件事。
   * - `animated` 只看源格子是否在跑：流线的动画是"这一步正在往下走"的读数，不引入新的状态源。
   */
  const edges = useMemo<Edge[]>(() => {
    const mirrorOnlyCells = canvasCells.filter((cell) => !cell.isFromGraph);
    return [
      ...mirrorOnlyCells.slice(1).map((cell, index) => ({
        id: `${mirrorOnlyCells[index]?.id}->${cell.id}`,
        source: mirrorOnlyCells[index]?.id ?? '',
        sourceHandle: 'default',
        target: cell.id,
        targetHandle: 'default',
        type: 'smoothstep',
        animated: cell.status === 'running',
      })),
      ...snapshot.edges.map((edge) => ({
        // 边的 id 与命令栈里那一份同源（`workflowEdgeIdOf` 的读法），撤销才认得回同一条线
        id: `${edge.source}:${edge.sourceHandle}->${edge.target}`,
        source: edge.source,
        sourceHandle: edge.sourceHandle,
        target: edge.target,
        targetHandle: 'default',
        type: 'smoothstep',
        animated: statusById.get(edge.source) === 'running',
      })),
    ];
  }, [canvasCells, snapshot, statusById]);

  const canUndo = editorRef.current.canUndo();
  const canRedo = editorRef.current.canRedo();
  /**
   * 能不能发起这一次保存：照的是库里那张图（不是运行镜像）、不在运行期、图上至少有一格。
   * 「这条计划存不存得下」不在这里判（见 `saveDraft` 那条注释）；空格那条也不是防御——
   * `workflowGraphSchema` 的 `nodes.min(1)` 真会拒，而"图上一格都没有"此刻在界面上看得见。
   */
  const canSave = loaded !== null && !isReadOnly && snapshot.nodes.length > 0;
  /**
   * 点开的那一格。从 `canvasCells` 找而不是再算一次标签：标签规则只在那一份里（§2.2），
   * 且这一格被撤销 / 换一条计划之后可能已经不在了，找不到就是"它不在这张图上"。
   */
  const selectedCell = canvasCells.find((cell) => cell.id === selectedNodeId) ?? null;
  /**
   * 选中格子在命令栈里的那份声明（kind 与参数的来源）。只在**图上有这一格**时才有——
   * 镜像补的那几格没有声明可改，参数卡因此不出现，运行读数卡照常出现（5.10-12 的两张卡本来就是两回事）。
   */
  const selectedSpec = snapshot.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedDescriptor = selectedSpec ? operatorByKind(selectedSpec.kind) : undefined;

  return (
    <div className="mt-3" data-testid="workflow-canvas">
      <h3 className="text-xs font-semibold text-slate-300">{t('workflow.canvas.heading')}</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{t('workflow.canvas.hint')}</p>
      {/* 画布照的是哪一份要说出来（2.4-05 的口径：内存里那次 run 与库里那条计划是两件事，界面不替用户混着说）。 */}
      <p
        className="mt-1 text-[11px] text-slate-500"
        data-testid="canvas-graph-source"
        data-loaded-plan={loaded?.planId ?? ''}
      >
        {loaded
          ? t('workflow.canvas.graphSourceGraph', { planId: loaded.planId })
          : t('workflow.canvas.graphSourceMirror')}
      </p>
      {graphNotice ? (
        <p className="mt-1 text-[11px] text-amber-300" data-testid="canvas-graph-notice">
          {graphNotice}
        </p>
      ) : null}
      <OperatorPalette onAdd={addOperatorNode} isReadOnly={isReadOnly} />
      {/* 命令栈与校验的读数条：图上格子数、撤销/重做是否可用、校验按钮。
          按钮的禁用态直接读 canUndo/canRedo，不让界面自己数历史（那会是第二份事实，§2.5）；
          运行时只读再叠一层（5.10-11）——改图会换指纹，续跑的老 run 就此作废，这条路不该在运行期间存在。 */}
      <div className="mt-2 flex items-center gap-2 text-[11px]">
        <span data-testid="canvas-draft-count" className="text-slate-500">
          {t('workflow.canvas.draftCount', { nodeCount: snapshot.nodes.length })}
        </span>
        <button
          type="button"
          data-testid="canvas-undo"
          onClick={undoEdit}
          disabled={!canUndo || isReadOnly}
          className="rounded-md border border-slate-700 px-2 py-1 text-slate-300 enabled:hover:border-slate-500 disabled:opacity-40"
        >
          {t('workflow.canvas.undo')}
        </button>
        <button
          type="button"
          data-testid="canvas-redo"
          onClick={redoEdit}
          disabled={!canRedo || isReadOnly}
          className="rounded-md border border-slate-700 px-2 py-1 text-slate-300 enabled:hover:border-slate-500 disabled:opacity-40"
        >
          {t('workflow.canvas.redo')}
        </button>
        <button
          type="button"
          data-testid="canvas-validate"
          onClick={validateDraft}
          disabled={isReadOnly}
          className="rounded-md border border-slate-700 px-2 py-1 text-slate-300 enabled:hover:border-slate-500 disabled:opacity-40"
        >
          {t('workflow.canvas.validate')}
        </button>
        {/* 写入口（5.10-10）：一次点击一次覆盖保存，画布不自动存草稿——"改了就进库"会让 5.10-07 的
            指纹续跑判据在用户不知情时生效，那比丢掉未入库的编辑更糟。 */}
        <button
          type="button"
          data-testid="canvas-save"
          onClick={saveDraft}
          disabled={!canSave}
          className="rounded-md border border-slate-700 px-2 py-1 text-slate-300 enabled:hover:border-slate-500 disabled:opacity-40"
        >
          {t('workflow.canvas.save')}
        </button>
      </div>
      {issues !== null ? (
        <ul
          className="mt-2 space-y-1 text-[11px]"
          data-testid={issues.length === 0 ? 'canvas-validate-ok' : 'canvas-validate-issues'}
        >
          {issues.length === 0 ? (
            <li className="text-emerald-300">{t('workflow.canvas.validatePassed')}</li>
          ) : (
            issues.map((issue) => (
              <li key={`${issue.code}:${issue.nodeIds.join(',')}`} className="text-rose-300">
                {t(`workflow.canvas.issue.${issue.code}`, {
                  nodeIds: issue.nodeIds.join(', '),
                  // 兜底文案来自 core 的 message：语言包漏键时界面不至于显示一个空条目
                  defaultValue: issue.message,
                })}
              </li>
            ))
          )}
        </ul>
      ) : null}
      {/* react-flow 需要一个有高度的容器，否则视口量到 0 宽高（隐藏视图宽高为 0 会让点击落空，同一类坑） */}
      <div className="mt-2 h-[420px] w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-950/40">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onNodeClick={(_event, node) => {
            setSelectedNodeId(node.id);
          }}
          nodeTypes={NODE_TYPES}
          // 库自带明暗两套主题（`dist/style.css` 里的 `.react-flow.dark` 变量组）。本 app 只有深色一套
          // 界面，所以显式走 dark：默认 light 下画布控件是一排白底按钮，与界面打架（5.10-a 实测截图）。
          // 用库的主题开关而不是自己写样式覆盖——AGENTS.md §5.1 禁止渲染层手写 CSS。
          colorMode="dark"
          fitView
          // 滚轮交给页面而不是交给画布：库默认截获画布上的 wheel 做缩放，于是 420px 高的画布成了
          // 工作流视图里的一段"滚动墙"。读 `@xyflow/system` 编译产物确认这条出口（§6.2）：
          // `preventScrolling=false` 时 `createZoomOnScrollHandler` 对不带 Ctrl 的 wheel 直接 return。
          preventScrolling={false}
          // 开放连线（5.10-d）：拖出来的边进命令栈，撤销一条就没了。运行时关掉（5.10-11 的只读）。
          // 删除仍然关着——删节点/删边属 5.10-e 入库时的编辑面，且没有回边以外的删除语义要先定。
          nodesConnectable={!isReadOnly}
          deleteKeyCode={null}
          // 库的署名浮标是一个外链，AGENTS.md §8.1 要求外链默认拒绝，所以关掉
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1e293b" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {selectedSpec && selectedDescriptor ? (
        <OperatorParamForm
          // 换一格就重挂载：未提交的草稿文本属于那一格，不该跟着跳过去
          key={selectedSpec.id}
          descriptor={selectedDescriptor}
          params={selectedSpec.params}
          isReadOnly={isReadOnly}
          onCommit={(params) => commitNodeParams(selectedSpec.id, params)}
        />
      ) : null}
      {selectedCell ? (
        <WorkflowNodeDetail
          // 同理：读数属于那一格，换格子必须重新去库里问一次
          key={selectedCell.id}
          nodeId={selectedCell.id}
          label={selectedCell.label}
        />
      ) : null}
    </div>
  );
}

/**
 * 对外出口：给画布套一层 `ReactFlowProvider`。
 *
 * 为什么要这一层：加草稿后要把视口重新贴合（见 `WorkflowCanvasBoard` 里的 fitView 效应），
 * 而 `useReactFlow()` 只有在 provider 之下才拿得到实例——库的 `fitView` prop 只在挂载时算一次，
 * 覆盖不了"挂载之后又加了格子"这一种情况。
 * @param steps 当前 run 的步骤读数
 * @param planId 下拉里选中的计划 id（决定画布照库里哪张图）
 * @param isReadOnly 有正在进行的 run 时为真：编辑面全部禁用
 * @returns 挂好 provider 的画布
 */
export function WorkflowCanvas({ steps, planId, isReadOnly }: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvasBoard steps={steps} planId={planId} isReadOnly={isReadOnly} />
    </ReactFlowProvider>
  );
}
