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
 * - **算子从调色板拖进来时，落点也走这一条视图层通道**（6.5-04）：松手才建格，落点写进 `dragOffsets`，
 *   命令栈拿到的仍是那七字段、没有 position——所以"拖到哪儿"这件事在结构上够不到执行身份。
 * - **边是执行顺序**：库里的边照画，镜像里多出的那几格（图上没有）按镜像顺序补一条链。
 * - **合法性规则不在这里长第二份**：五条保存前校验读 `@auto-cc/core/graph-check`（渲染层与 L3 的保存口
 *   同一份规则，plan 裁定九），界面只按 `code` 取文案、按 `nodeIds` 落红环。
 * - **配色与步骤行同源**：`STEP_STATUS_STYLE` 与工作流面板共用一份，同一状态在两处必须同色。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
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
  type XYPosition,
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
import { Banner, DeskButton, DeskDisclosure, EffectChip } from './ui/controls';
import { Drawer } from './ui/overlays';
import { useDeskThemeValue } from './theme';
import { OperatorPalette } from './OperatorPalette';
import { OperatorParamForm } from './OperatorParamForm';
import { WorkflowNodeDetail } from './WorkflowNodeDetail';
import { operatorIconOf } from './operator-icons';
import { useBridgeAction } from './useBridgeAction';

/** 格子的初始摆放间距（像素）；库里存过落点时以落点为准（裁定三）。 */
const NODE_GAP_X = 260;

/** 多出口算子的源句柄纵向落点——用 Tailwind 任意值而不是手写 CSS（AGENTS.md §5.1）。 */
const SOURCE_HANDLE_CLASS = ['!top-1/2', '!top-[70%]', '!top-[88%]'] as const;

/** 校验点名的格子加一圈朱砂环（seal=风险档）；状态色仍完全由 `STEP_STATUS_STYLE` 决定，这里不碰它。 */
const ISSUE_RING_CLASS = 'ring-2 ring-seal/70';

/**
 * 此刻指向的那一格：外圈青瓷实线（03 稿的「此刻指向」，与 `ScriptPanel` 候选行、`JobLabPanel` 列表行同档色）。
 * 画在 **outline** 而不是 border——那一圈是状态色（`stepStatusStyle.ts`），选中不能把「这一格在跑」改掉；
 * running 与选中因此可以同框：内圈读状态，外圈读指针。
 */
const SELECTED_CELL_CLASS = 'outline-solid outline-2 outline-offset-2 outline-celadon/70';

/** 连接点：描边用分隔线色、底用桌面色，深浅两主题都跟着 token 走（06 稿 10 的格子形状）。 */
const HANDLE_CLASS = '!h-2 !w-2 !border-2 !border-line-strong !bg-ink-900';

/** 连线的默认笔色：静止的边只是「先后顺序」，不该抢格子的颜色（06 稿 10 的③）。 */
const EDGE_STYLE = { stroke: 'var(--color-line-strong)', strokeWidth: 1.5 } as const;

/** 在跑的边描青瓷（进行中档），与格子的 running 同色。 */
const RUNNING_EDGE_STYLE = { stroke: 'var(--color-celadon)', strokeWidth: 1.5 } as const;

/** 按下之后要挪动这么多像素才算"拖"；没越过就仍按 5.10-03 的点击建格走（那条通路一字未改）。 */
const PALETTE_DRAG_THRESHOLD_PX = 4;

/** 落点预览框那一只节点的 id：固定值，harness 按它断言"此刻有没有落点框"。 */
const DROP_FRAME_NODE_ID = 'palette-drop-frame';

/**
 * 落点框的画法（10 稿⑧）：青瓷虚线一圈，**不用整块高亮**——铺满的半透明遮罩会让用户以为
 * 整个画布都是一个投放区，而这里要说的是"松手之后这一格落在这儿"。
 */
const DROP_FRAME_CLASS = 'flex h-[68px] w-[210px] -translate-x-1/2 -translate-y-1/2 items-center justify-center';

/**
 * 一次"从调色板拖进画布"的读数（spec 6.5-04）。
 *
 * 为什么整份存进 state 而不是拆成 ref：松手那一刻要拿**最新**的落点建格，而监听器挂在 window 上、
 * 闭包里的值必须是最新的——放进 state 又每次改动都重挂监听，这条 effect 因此按"每次移动重挂"写，
 * 一次手势几十次重挂的成本远低于养一份会过期的第二事实（§2.5）。
 */
interface PaletteDragState {
  /** 被拖走的那只算子的整份描述（建格时按它派生 id/参数/危险度） */
  descriptor: OperatorDescriptor;
  /** 起手时的屏幕坐标，用来算"挪了多少像素" */
  origin: XYPosition;
  /** 光标此刻的屏幕坐标 */
  cursor: XYPosition;
  /** 是否已越过拖拽阈值（没越过就什么都不做，交给 click） */
  isDragging: boolean;
  /** 光标是否落在画布那块矩形里（在里头才谈得上落点） */
  isOverCanvas: boolean;
  /** 落点在 flow 坐标系里的位置；不在画布内时为 null */
  flowPosition: XYPosition | null;
}

/** 落点预览那一只节点要显示的东西——它不属于图，只是"松手会落在这儿"的一圈线。 */
interface DropFrameData extends Record<string, unknown> {
  /** 将被建出来的那一格的展示标签（来自描述表的标题键） */
  label: string;
}

type DropFrameNode = Node<DropFrameData, 'dropFrame'>;

/**
 * 落点框：一只不可拖、不可选、不带连接点的虚线框，位置由库自己摆（所以这里没有任何坐标样式）。
 * @param data 该节点的读数
 * @returns 虚线框
 */
function DropFrameNodeCard({ data }: NodeProps<DropFrameNode>) {
  const { t } = useTranslation();
  return (
    <div
      className={`${DROP_FRAME_CLASS} rounded-lg border-2 border-dashed border-celadon/70`}
      data-testid="canvas-drop-frame"
    >
      <span className="break-all px-2 text-center text-[11px] leading-tight text-celadon">
        {data.label}
        <span className="mt-0.5 block text-[10px] text-slate-400">{t('workflow.operator.dropFrameHint')}</span>
      </span>
    </div>
  );
}

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
  /**
   * 这一格是不是检视器正在读的那一格（6.5-06）。
   * 由视图层的 `selectedNodeId` 现算，不进命令栈——选中是镜头，不是图的一部分，撤销一条边不该把它清掉。
   */
  isSelected: boolean;
}

type OperatorNode = Node<OperatorData, 'operator'>;

/** 画布上会出现的两类节点：图上那一格，与拖拽期间的落点框（6.5-04）。 */
type CanvasNode = OperatorNode | DropFrameNode;

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
      data-node-selected={data.isSelected ? 'true' : 'false'}
      className={`rounded-lg border px-3 py-2 text-[11px] shadow-sm ${STEP_STATUS_STYLE[data.status]} ${
        data.hasIssue ? ISSUE_RING_CLASS : ''
      } ${data.isSelected ? SELECTED_CELL_CLASS : ''}`}
    >
      <Handle type="target" position={Position.Left} id="default" className={HANDLE_CLASS} />
      <span className="flex items-center gap-1">
        {Icon ? <Icon size={11} /> : <span className="font-mono text-xs opacity-60">{String(data.order)}</span>}
        <span className="break-all">{data.label}</span>
      </span>
      {/* 危险度徽标只说描述表里那一档，界面不给用户挑危险度的机会（闸门读的就是这一项）。 */}
      {descriptor ? (
        <span className="mt-1 block">
          <EffectChip effect={descriptor.effect}>{t(`workflow.operator.effect.${descriptor.effect}`)}</EffectChip>
        </span>
      ) : null}
      {outputs.map((output, handleIndex) => (
        <Handle
          key={output}
          type="source"
          position={Position.Right}
          id={output}
          className={`${HANDLE_CLASS} ${SOURCE_HANDLE_CLASS[Math.min(handleIndex, SOURCE_HANDLE_CLASS.length - 1)]}`}
        />
      ))}
    </div>
  );
}

/** `nodeTypes` 必须在组件外定义：每次渲染新建对象会让 react-flow 重建所有节点。 */
const NODE_TYPES = { operator: OperatorNodeCard, dropFrame: DropFrameNodeCard } as const;

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
  const deskTheme = useDeskThemeValue();
  const flow = useReactFlow<OperatorNode>();

  /**
   * 画布 chrome 的文案出口：库里那三只按钮的 `title`（悬停可见）与 `aria-label` 同源，
   * 只认 `ariaLabelConfig` 这一条（`Controls` 没有 `labels` 参数，读 12.12.0 的编译产物确认）。
   * 不传就是硬编码英文（实测：Zoom In / Zoom Out / Fit View），违反 §5.5；
   * 记忆一份是因为库对每个变化的 prop 都重放一次 `store.setState`。
   */
  const chromeLabels = useMemo(
    () => ({
      'controls.ariaLabel': t('workflow.canvas.controls.panel'),
      'controls.zoomIn.ariaLabel': t('workflow.canvas.controls.zoomIn'),
      'controls.zoomOut.ariaLabel': t('workflow.canvas.controls.zoomOut'),
      'controls.fitView.ariaLabel': t('workflow.canvas.controls.fitView'),
    }),
    [t],
  );

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
   * 点开的格子（spec 5.10-12）：参数卡（描述表派生）搬进右侧抽屉（09 稿形态④），
   * 运行读数卡仍摆在画布下方——读数卡说的是"这一格跑成什么样"，稿上没有它的抽屉档。
   * 只有一格能选中，因为这两处说的都是"这一格"，同时选中两格会让用户分不清读数在讲谁。
   */
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  /** 抽屉里「校验」那一行的问题清单展没展开（点开是镜头，不是图的一部分，不进命令栈）。 */
  const [isIssueListOpen, setIsIssueListOpen] = useState(false);
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
  /** 此刻正从调色板拖出来的一格（spec 6.5-04）；null = 没有在拖。 */
  const [paletteDrag, setPaletteDrag] = useState<PaletteDragState | null>(null);
  /** 画布那块矩形的引用：拖拽时要按它判"光标进来了没有"，落点框也挂在它里面的 flow 坐标系里。 */
  const canvasHolderRef = useRef<HTMLDivElement | null>(null);
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

  const nodes = useMemo<CanvasNode[]>(() => {
    const cells: CanvasNode[] = canvasCells.map<OperatorNode>((cell, index) => ({
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
        isSelected: cell.id === selectedNodeId,
      },
    }));
    // 拖拽中且光标已在画布内，才长出落点框（10 稿⑧）：它不是图上的一格，不进命令栈、不参与校验。
    if (paletteDrag?.isDragging && paletteDrag.flowPosition) {
      cells.push({
        id: DROP_FRAME_NODE_ID,
        type: 'dropFrame',
        position: paletteDrag.flowPosition,
        draggable: false,
        selectable: false,
        data: { label: t(paletteDrag.descriptor.titleKey) },
      });
    }
    return cells;
  }, [canvasCells, dragOffsets, issueNodeIds, paletteDrag, selectedNodeId, t]);

  /**
   * 只接住位置变更：`nodes` 是受控的，落点回到 state 才拖得住；
   * 其余变更（select/dragging/remove）要么由 UI 自己走 `onNodeClick`，要么本片不开放删除。
   * @param changes react-flow 本轮报出的变更
   */
  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
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
   * @param dropPosition 拖进来时的落点（flow 坐标系）；省略 = 点击建格，按下标摆
   */
  function addOperatorNode(descriptor: OperatorDescriptor, dropPosition?: XYPosition) {
    const sameKindCount = snapshot.nodes.filter((draft) => draft.kind === descriptor.kind).length;
    const draftId = `${descriptor.kind.replaceAll('.', '-')}-draft-${String(sameKindCount + 1)}`;
    if (!editorRef.current?.addNode(draftNodeSpec(descriptor, draftId))) return;
    // 落点写的是视图层那一份（`dragOffsets`），命令栈里仍是无 position 的七字段——位置不进指纹因此破不了。
    if (dropPosition) setDragOffsets((previous) => ({ ...previous, [draftId]: dropPosition }));
    sync();
    setSelectedNodeId(draftId);
    // 拖进来的那一格就在松手的地方，重新贴合视口反而会把它挪走；只有点击建格才需要镜头跟上。
    if (!dropPosition) setFitRequestId((previous) => previous + 1);
  }

  /**
   * 把一次屏幕坐标折算成这一手势的读数（阈值、是否进画布、flow 坐标系落点）。
   * @param state 起手时那一份（descriptor 与 origin 从这里带）
   * @param client 光标此刻的屏幕坐标（`clientX` / `clientY`，像素）
   * @returns 新的拖拽读数；不在画布内时 `flowPosition` 为 null
   */
  function readPaletteDrag(state: PaletteDragState, client: XYPosition): PaletteDragState {
    const rect = canvasHolderRef.current?.getBoundingClientRect();
    const isOverCanvas =
      rect !== undefined &&
      client.x >= rect.left &&
      client.x <= rect.right &&
      client.y >= rect.top &&
      client.y <= rect.bottom;
    return {
      ...state,
      cursor: client,
      isDragging: Math.hypot(client.x - state.origin.x, client.y - state.origin.y) > PALETTE_DRAG_THRESHOLD_PX,
      isOverCanvas,
      // 只有进了画布才换算落点：库在拿不到 domNode 时会原样退回屏幕坐标（`dist/esm/index.mjs:559-563`），
      // 那种读数当落点用会把格子甩到画面外。
      flowPosition: isOverCanvas ? flow.screenToFlowPosition(client) : null,
    };
  }

  /**
   * 起手：记下从哪一格、在哪按下，之后的移动与松手由下面那条 effect 挂在 window 上跟。
   * @param descriptor 被按下的算子描述
   * @param event 起手的鼠标按下事件（只取左键与屏幕坐标）
   */
  function beginPaletteDrag(descriptor: OperatorDescriptor, event: ReactMouseEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    const origin = { x: event.clientX, y: event.clientY };
    setPaletteDrag(
      readPaletteDrag(
        { descriptor, origin, cursor: origin, isDragging: false, isOverCanvas: false, flowPosition: null },
        origin,
      ),
    );
  }

  /**
   * 拖拽期间的三条 window 监听（`mousemove` / `mouseup` / `keydown`）。
   *
   * 挂在 window 而不是挂在画布上：指针会离开那一格、也会掠过画布外的地方，只有 window 能一直跟到松手。
   * 依赖里有 `paletteDrag`，所以每次移动都重挂一次——一次手势几十次，代价远低于让闭包读到过期的落点。
   * 卸载时三条一起摘，运行期不留句柄（与 5.10-11 的"离开画布无残留"同一口径）。
   */
  useEffect(() => {
    if (paletteDrag === null) return;
    const onMove = (event: MouseEvent) =>
      setPaletteDrag(readPaletteDrag(paletteDrag, { x: event.clientX, y: event.clientY }));
    const onUp = (event: MouseEvent) => {
      const final = readPaletteDrag(paletteDrag, { x: event.clientX, y: event.clientY });
      setPaletteDrag(null);
      // 松手才建（08 稿）：没越过阈值就什么都不做，让浏览器的 click 去走原来的点击建格；
      // 落在画布外则整次取消——半途而废的手势不该凭空多出一格。
      if (!final.isDragging || final.flowPosition === null) return;
      addOperatorNode(final.descriptor, final.flowPosition);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPaletteDrag(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKeyDown);
    };
  });

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
        style: cell.status === 'running' ? RUNNING_EDGE_STYLE : EDGE_STYLE,
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
        style: statusById.get(edge.source) === 'running' ? RUNNING_EDGE_STYLE : EDGE_STYLE,
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
   * 四只工具按钮各自的"为什么按不动"（6.2-06：禁用必须说得出原因，且原因取现成的判据，不另数一遍）。
   * 排列按"离手最近"：先说这一条路根本不存在（运行期只读），再说这一步没内容。
   */
  const undoReason = isReadOnly ? 'READ_ONLY' : !canUndo ? 'NOTHING_TO_UNDO' : undefined;
  const redoReason = isReadOnly ? 'READ_ONLY' : !canRedo ? 'NOTHING_TO_REDO' : undefined;
  const saveReason = isReadOnly
    ? 'READ_ONLY'
    : loaded === null
      ? 'MIRROR_ONLY'
      : snapshot.nodes.length === 0
        ? 'EMPTY_GRAPH'
        : undefined;
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
  /**
   * 上一次「保存前校验」里点到这一格的那几条（`issues` 是全图结果，抽屉只报本格的）。
   * 只在人按过校验之后才有内容：`issues === null` 时抽屉里那行整个不出现（不给"通过"这种凭空读数）。
   */
  const selectedNodeIssues =
    issues === null || selectedSpec === null ? [] : issues.filter((issue) => issue.nodeIds.includes(selectedSpec.id));

  return (
    <div className="mt-3" data-testid="workflow-canvas" data-palette-drag={paletteDrag?.descriptor.kind ?? ''}>
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
        <p className="mt-1 text-[11px] text-amber" data-testid="canvas-graph-notice">
          {graphNotice}
        </p>
      ) : null}
      <OperatorPalette
        onAdd={addOperatorNode}
        onDragStart={beginPaletteDrag}
        draggingKind={paletteDrag?.isDragging ? paletteDrag.descriptor.kind : undefined}
        isReadOnly={isReadOnly}
      />
      {/* 命令栈与校验的读数条：图上格子数、撤销/重做是否可用、校验按钮。
          按钮的禁用态直接读 canUndo/canRedo，不让界面自己数历史（那会是第二份事实，§2.5）；
          运行时只读再叠一层（5.10-11）——改图会换指纹，续跑的老 run 就此作废，这条路不该在运行期间存在。 */}
      <div className="mt-2 flex items-center gap-2 text-[11px]">
        <span data-testid="canvas-draft-count" className="text-slate-500">
          {t('workflow.canvas.draftCount', { nodeCount: snapshot.nodes.length })}
        </span>
        <DeskButton
          action="canvas-undo"
          markers={{ testid: 'canvas-undo' }}
          variant="ghost"
          onClick={undoEdit}
          disabled={!canUndo || isReadOnly}
          disabledReason={undoReason}
          disabledReasonLabel={undoReason ? t(`workflow.canvas.reason.${undoReason}`) : undefined}
        >
          {t('workflow.canvas.undo')}
        </DeskButton>
        <DeskButton
          action="canvas-redo"
          markers={{ testid: 'canvas-redo' }}
          variant="ghost"
          onClick={redoEdit}
          disabled={!canRedo || isReadOnly}
          disabledReason={redoReason}
          disabledReasonLabel={redoReason ? t(`workflow.canvas.reason.${redoReason}`) : undefined}
        >
          {t('workflow.canvas.redo')}
        </DeskButton>
        <DeskButton
          action="canvas-validate"
          markers={{ testid: 'canvas-validate' }}
          variant="line"
          onClick={validateDraft}
          disabled={isReadOnly}
          disabledReason={isReadOnly ? 'READ_ONLY' : undefined}
          disabledReasonLabel={isReadOnly ? t('workflow.canvas.reason.READ_ONLY') : undefined}
        >
          {t('workflow.canvas.validate')}
        </DeskButton>
        {/* 写入口（5.10-10）：一次点击一次覆盖保存，画布不自动存草稿——"改了就进库"会让 5.10-07 的
            指纹续跑判据在用户不知情时生效，那比丢掉未入库的编辑更糟。
            这一档涂琥珀而不是青瓷：它写的是本机的库，不碰外面（03 稿的三色效果归属）。 */}
        <DeskButton
          action="canvas-save"
          markers={{ testid: 'canvas-save' }}
          variant="amber"
          onClick={saveDraft}
          disabled={!canSave}
          disabledReason={saveReason}
          disabledReasonLabel={saveReason ? t(`workflow.canvas.reason.${saveReason}`) : undefined}
        >
          {t('workflow.canvas.save')}
        </DeskButton>
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
      {/* react-flow 需要一个有高度的容器，否则视口量到 0 宽高（隐藏视图宽高为 0 会让点击落空，同一类坑）。
          这一只 div 同时是拖拽的命中区：光标进了它的矩形才算"要落在这张图上"（6.5-04）。 */}
      <div
        className="mt-2 h-[420px] w-full overflow-hidden rounded-xl border border-line bg-ink-850/60"
        data-testid="canvas-holder"
        ref={canvasHolderRef}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onNodeClick={(_event, node) => {
            setSelectedNodeId(node.id);
          }}
          nodeTypes={NODE_TYPES}
          // 库自带明暗两套主题（`dist/style.css` 里的 `.react-flow.dark` 变量组），所以跟着 06 子计划的
          // 材质走：订阅 `useDeskThemeValue()`（localStorage 是主题的唯一事实，见 theme.ts），这里不再自己存一份
          // state——自己翻面就会长出第二个真相（§2.5）。默认 light 时代画布控件是一排白底按钮，
          // 与墨案打架（5.10-a 实测截图）；用库的主题开关而不是自己写样式覆盖（§5.1）。
          // 为什么不是 `currentTheme()`：本组件挂在 App.tsx 的模块常量 PANELS 下，主题开关改的是 App 自己的
          // state，子树拿到的还是同一个元素引用、不会重渲染，现读到的色就停在翻面之前那一档。
          colorMode={deskTheme}
          ariaLabelConfig={chromeLabels}
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
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-line-strong)" />
          {/* 裁定 2：画布 chrome 保留库的 `<Controls>`，只用 Tailwind 把它按回令牌层——不自绘一套缩放按钮。
              走的是库自己的变量出口（`dist/style.css` 里 `--xy-controls-*` 那一组，读编译产物确认），
              而不是后代选择器硬盖：变量定在容器上、按钮继承，主题翻转由令牌自己完成，一份覆盖两套主题。 */}
          <Controls
            showInteractive={false}
            className="[--xy-controls-button-background-color:var(--color-ink-800)] [--xy-controls-button-background-color-hover:var(--color-ink-750)] [--xy-controls-button-color:var(--color-slate-200)] [--xy-controls-button-color-hover:var(--color-slate-200)] [--xy-controls-button-border-color:var(--color-line-strong)] [--xy-controls-box-shadow:var(--shadow-lift)] overflow-hidden rounded-md"
          />
        </ReactFlow>
      </div>
      {selectedSpec && selectedDescriptor ? (
        // 09 稿形态④ 的第二只真身（4-C 清单里的「算子参数」）：参数卡搬进抽屉，
        // 关闭规则按稿上那一档走「Esc / ✕ / 点遮罩」——它不做不可逆动作，所以不给遮罩弹窗。
        <Drawer
          action="node-params"
          open
          title={t('workflow.operator.paramHeading')}
          headExtra={
            // 稿上抽屉头部那一枚「外发」徽标读的还是描述表（不是用户挑的危险度），
            // 与格子上的同一只 `EffectChip`，一份映射两处用（§2.5）。
            <EffectChip effect={selectedDescriptor.effect}>
              {t(`workflow.operator.effect.${selectedDescriptor.effect}`)}
            </EffectChip>
          }
          subtitle={selectedCell?.label ?? selectedSpec.id}
          onClose={() => setSelectedNodeId(null)}
        >
          {selectedDescriptor.effect === 'outbound' ? (
            <Banner tone="seal" markers={{ testid: 'drawer-outbound-notice' }}>
              {t('workflow.operator.outboundNotice')}
            </Banner>
          ) : null}
          <OperatorParamForm
            // 换一格就重挂载：未提交的草稿文本属于那一格，不该跟着跳过去。
            // 键带 `params:` 前缀是原样留下的：读数卡 `detail:` 仍是这张画布的兄弟，
            // 去掉前缀会让两次翻主题时 React 在同一个 children 数组里撞出同键孤儿 DOM。
            key={`params:${selectedSpec.id}`}
            descriptor={selectedDescriptor}
            params={selectedSpec.params}
            isReadOnly={isReadOnly}
            onCommit={(params) => commitNodeParams(selectedSpec.id, params)}
          />
          {/* 校验读数只在人按过「保存前校验」之后才存在（`issues` 是那次点出来的结果）。
              没按过时这一行整个不出现：稿上画的是「通过 · 2 项警告」，
              但界面上凭空写一句"通过"就是假读数（与第四十三片"不装假按钮"同一条尺）。 */}
          {issues === null ? null : (
            <div
              className="mt-3 rounded-md border border-line px-2.5 py-2"
              data-testid="drawer-validate-row"
              data-node-issue-count={selectedNodeIssues.length}
            >
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-slate-400">{t('workflow.canvas.validate')}</span>
                {selectedNodeIssues.length === 0 ? (
                  <span className="text-jade-ink" data-testid="drawer-validate-ok">
                    {t('workflow.operator.validateOk')}
                  </span>
                ) : (
                  <>
                    <span className="text-seal-ink" data-testid="drawer-validate-issues">
                      {t('workflow.operator.validateIssues', { num: selectedNodeIssues.length })}
                    </span>
                    <DeskDisclosure
                      action="drawer-issues"
                      open={isIssueListOpen}
                      onClick={() => setIsIssueListOpen((isOpen) => !isOpen)}
                      className="ml-auto"
                    >
                      {t('workflow.operator.validateView')}
                    </DeskDisclosure>
                  </>
                )}
              </div>
              {isIssueListOpen && selectedNodeIssues.length > 0 ? (
                <ul className="mt-1.5 space-y-1" data-testid="drawer-issue-list">
                  {selectedNodeIssues.map((issue) => (
                    <li key={`${issue.code}:${issue.nodeIds.join(',')}`} className="text-[10px] text-seal-ink">
                      {t(`workflow.canvas.issue.${issue.code}`, {
                        nodeIds: issue.nodeIds.join(', '),
                        // 兜底文案来自 core 的 message：语言包漏键时界面不至于显示一个空条目
                        defaultValue: issue.message,
                      })}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
        </Drawer>
      ) : null}
      {selectedCell ? (
        <WorkflowNodeDetail
          // 同理：读数属于那一格，换格子必须重新去库里问一次（前缀同上，两张卡不能同键）
          key={`detail:${selectedCell.id}`}
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
