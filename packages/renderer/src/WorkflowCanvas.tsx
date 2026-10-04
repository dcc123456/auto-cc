/**
 * 算子图画布（spec 5.10-01 的骨架 + 5.10-03/04 的编辑态第一层 + 5.10-d 的连线、命令栈与保存前校验）。
 *
 * 两种画法共用**同一张图**（§5.10.5 的口径）：
 * - **运行态**格子来自 `workflow/progress` 推来的 `steps`，画布自己不发起请求、不起定时器
 *   （spec 5.10-11 要求"离开画布无残留句柄"，所以它由面板按开合挂载/卸载，而不是常驻）。
 * - **编辑态**草稿来自算子库：一只草稿节点的全部外观与参数形状都由 `WORKFLOW_OPERATORS` 里那一行
 *   决定（图标、危险度徽标、出口句柄数、表单字段），这里没有 per-算子 的分支。
 *
 * - **位置是视图层**：拖完之后位置由画布自己持有，不进命令栈、不参与指纹（5.10-06 已把这条钉成测试）。
 * - **边是执行顺序**：运行链的边由步骤顺序派生，草稿之间的边由用户连（5.10-d），两者都只画不解释。
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
  type WorkflowNodeSpec,
  type WorkflowStepView,
} from '@auto-cc/shared';
import { STEP_STATUS_STYLE } from './stepStatusStyle';
import { OperatorPalette } from './OperatorPalette';
import { OperatorParamForm } from './OperatorParamForm';
import { operatorIconOf } from './operator-icons';

/** 运行链的初始摆放间距（像素）；真正的分层落点在后续片里按拓扑算（裁定三）。 */
const NODE_GAP_X = 260;

/** 草稿节点从运行链下方开始摆，避免与正在跑的格子叠在一起看不清。 */
const DRAFT_ORIGIN_Y = 250;

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
  /** 草稿节点的算子 kind；运行态格子拿不到 kind（步骤镜像里没有这一项）所以是 null */
  kind: string | null;
  /** 这只格子被保存前校验点名了吗（红环依据是它，不是那句文案） */
  hasIssue: boolean;
}

type OperatorNode = Node<OperatorData, 'operator'>;

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
}

/**
 * 画布主体：运行链 + 算子库加入的草稿节点。
 * @param steps 当前 run 的步骤读数
 * @returns 可平移缩放、格子可拖拽、能加算子并填参数的画布
 */
function WorkflowCanvasBoard({ steps }: WorkflowCanvasProps) {
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

  /** 草稿图的一份只读快照（命令栈的内容在编辑器对象里，React 读不到，所以每次编辑后复制一份出来） */
  const [snapshot, setSnapshot] = useState<WorkflowGraphDraft>({ nodes: [], edges: [] });
  /** 上一次"保存前校验"的结果；null = 还没校验过（不是"校验过且没问题"） */
  const [issues, setIssues] = useState<WorkflowGraphIssue[] | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  /** 拖拽后的落点（视图层）：运行态格子与草稿都按这一份覆盖初始摆放。 */
  const [dragOffsets, setDragOffsets] = useState<Record<string, { x: number; y: number }>>({});
  /** 加过草稿就自增一次，让下面的 effect 重新贴合视口（0 = 还没加过，不该动用户的视野）。 */
  const [fitRequestId, setFitRequestId] = useState(0);

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

  /** 被校验点名的节点 id——红环按这一份落，与文案无关（同一份事实的两个读数）。 */
  const issueNodeIds = useMemo(() => new Set((issues ?? []).flatMap((issue) => issue.nodeIds)), [issues]);

  const nodes = useMemo<OperatorNode[]>(() => {
    const runningNodes = steps.map((step, index) => ({
      id: step.id,
      type: 'operator' as const,
      position: dragOffsets[step.id] ?? { x: index * NODE_GAP_X, y: 0 },
      data: {
        stepId: step.id,
        label: t(`workflow.step.${step.id}`, { defaultValue: step.id }),
        status: step.status,
        order: index + 1,
        kind: null,
        hasIssue: issueNodeIds.has(step.id),
      },
    }));
    const draftNodes = snapshot.nodes.map((draft, index) => {
      // 标题键也从描述表取：这里再拼一次 `workflow.operator.${kind}.title` 就是第二份规则（§2.2）。
      const descriptor = operatorByKind(draft.kind);
      return {
        id: draft.id,
        type: 'operator' as const,
        // 位置不进命令栈（5.10-06）：栈里那份没有 position 字段，初始落点由下标现算，
        // 拖过的落点存在视图层的 `dragOffsets` 里——撤销一条边不会把格子弹回原位。
        position: dragOffsets[draft.id] ?? { x: 0, y: DRAFT_ORIGIN_Y + index * 78 },
        data: {
          stepId: draft.id,
          label: descriptor ? t(descriptor.titleKey, { defaultValue: draft.kind }) : draft.kind,
          status: 'pending' as const,
          order: runningNodes.length + index + 1,
          kind: draft.kind,
          hasIssue: issueNodeIds.has(draft.id),
        },
      };
    });
    return [...runningNodes, ...draftNodes];
  }, [steps, snapshot, dragOffsets, issueNodeIds, t]);

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
   * 从算子库加一格草稿：id 由 kind 派生保证可读，参数初值只带 schema 里声明过的默认值。
   * @param descriptor 被点中的算子描述（整份从描述表来，画布不认识任何一只算子）
   */
  function addDraftNode(descriptor: OperatorDescriptor) {
    const sameKindCount = snapshot.nodes.filter((draft) => draft.kind === descriptor.kind).length;
    const draftId = `${descriptor.kind.replaceAll('.', '-')}-draft-${String(sameKindCount + 1)}`;
    if (!editorRef.current?.addNode(draftNodeSpec(descriptor, draftId))) return;
    sync();
    setSelectedDraftId(draftId);
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
   * 表单校验通过后写回草稿参数（红标期间走不到这里，见 `OperatorParamForm`）。
   * @param draftId 目标草稿节点 id
   * @param params 已按 zod 补全的参数
   */
  function commitDraftParams(draftId: string, params: Record<string, string | number | boolean>) {
    if (!editorRef.current?.setParams(draftId, params)) return;
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

  /** 运行链的相邻边 + 草稿之间用户连的边（两者都只画不解释）。 */
  const edges = useMemo<Edge[]>(
    () => [
      ...steps.slice(1).map((step, index) => ({
        id: `${steps[index]?.id}->${step.id}`,
        source: steps[index]?.id ?? '',
        sourceHandle: 'default',
        target: step.id,
        targetHandle: 'default',
        type: 'smoothstep',
        animated: step.status === 'running',
      })),
      ...snapshot.edges.map((edge) => ({
        // 边的 id 与命令栈里那一份同源（`workflowEdgeIdOf` 的读法），撤销才认得回同一条线
        id: `${edge.source}:${edge.sourceHandle}->${edge.target}`,
        source: edge.source,
        sourceHandle: edge.sourceHandle,
        target: edge.target,
        targetHandle: 'default',
        type: 'smoothstep',
      })),
    ],
    [steps, snapshot],
  );

  const canUndo = editorRef.current.canUndo();
  const canRedo = editorRef.current.canRedo();
  const selectedDraft = snapshot.nodes.find((draft) => draft.id === selectedDraftId) ?? null;
  const selectedDescriptor = selectedDraft ? operatorByKind(selectedDraft.kind) : undefined;

  return (
    <div className="mt-3" data-testid="workflow-canvas">
      <h3 className="text-xs font-semibold text-slate-300">{t('workflow.canvas.heading')}</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{t('workflow.canvas.hint')}</p>
      <OperatorPalette onAdd={addDraftNode} />
      {/* 命令栈与校验的读数条：草稿数、撤销/重做是否可用、校验按钮。
          按钮的禁用态直接读 canUndo/canRedo，不让界面自己数历史（那会是第二份事实，§2.5）。 */}
      <div className="mt-2 flex items-center gap-2 text-[11px]">
        <span data-testid="canvas-draft-count" className="text-slate-500">
          {t('workflow.canvas.draftCount', { nodeCount: snapshot.nodes.length })}
        </span>
        <button
          type="button"
          data-testid="canvas-undo"
          onClick={undoEdit}
          disabled={!canUndo}
          className="rounded-md border border-slate-700 px-2 py-1 text-slate-300 enabled:hover:border-slate-500 disabled:opacity-40"
        >
          {t('workflow.canvas.undo')}
        </button>
        <button
          type="button"
          data-testid="canvas-redo"
          onClick={redoEdit}
          disabled={!canRedo}
          className="rounded-md border border-slate-700 px-2 py-1 text-slate-300 enabled:hover:border-slate-500 disabled:opacity-40"
        >
          {t('workflow.canvas.redo')}
        </button>
        <button
          type="button"
          data-testid="canvas-validate"
          onClick={validateDraft}
          className="rounded-md border border-slate-700 px-2 py-1 text-slate-300 hover:border-slate-500"
        >
          {t('workflow.canvas.validate')}
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
            if (node.data.kind) setSelectedDraftId(node.id);
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
          // 开放连线（5.10-d）：拖出来的边进命令栈，撤销一条就没了。
          // 删除仍然关着——删节点/删边属 5.10-e 入库时的编辑面，且没有回边以外的删除语义要先定。
          nodesConnectable
          deleteKeyCode={null}
          // 库的署名浮标是一个外链，AGENTS.md §8.1 要求外链默认拒绝，所以关掉
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1e293b" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {selectedDraft && selectedDescriptor ? (
        <OperatorParamForm
          // 换一只草稿节点就重挂载：草稿文本属于那一格，不该跟着跳过去
          key={selectedDraft.id}
          descriptor={selectedDescriptor}
          params={selectedDraft.params}
          onCommit={(params) => commitDraftParams(selectedDraft.id, params)}
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
 * @returns 挂好 provider 的画布
 */
export function WorkflowCanvas({ steps }: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvasBoard steps={steps} />
    </ReactFlowProvider>
  );
}
