/**
 * 算子图画布（spec 5.10-01 的骨架 + 5.10-03/04 的编辑态第一层）。
 *
 * 两种画法共用**同一张图**（§5.10.5 的口径）：
 * - **运行态**格子来自 `workflow/progress` 推来的 `steps`，画布自己不发起请求、不起定时器
 *   （spec 5.10-11 要求"离开画布无残留句柄"，所以它由面板按开合挂载/卸载，而不是常驻）。
 * - **编辑态**草稿来自算子库：一只草稿节点的全部外观与参数形状都由 `WORKFLOW_OPERATORS` 里那一行
 *   决定（图标、危险度徽标、出口句柄数、表单字段），这里没有 per-算子 的分支。
 *
 * 三条口径不变：
 * - **位置是视图层**：拖完之后位置由画布自己持有，不进计划语义、不参与指纹（5.10-06 已把这条钉成测试）。
 * - **边是执行顺序**：现在只有运行链一条；草稿节点之间的连线属 5.10-d，入库属 5.10-e。
 * - **配色与步骤行同源**：`STEP_STATUS_STYLE` 与工作流面板共用一份，同一状态在两处必须同色。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
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
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import { operatorByKind, operatorParamDefaults, type OperatorDescriptor, type WorkflowStepView } from '@auto-cc/shared';
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
}

type OperatorNode = Node<OperatorData, 'operator'>;

/** 画布上的草稿节点：参数是**已提交**的形状（红标期间不会写进来），落点只是摆放。 */
type DraftNode = {
  id: string;
  kind: string;
  params: Record<string, string | number | boolean>;
  position: { x: number; y: number };
};

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
      className={`rounded-lg border px-3 py-2 text-[11px] shadow-sm ${STEP_STATUS_STYLE[data.status]}`}
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
function WorkflowCanvasEditor({ steps }: WorkflowCanvasProps) {
  const { t } = useTranslation();
  const flow = useReactFlow<OperatorNode>();
  const [drafts, setDrafts] = useState<DraftNode[]>([]);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  /** 拖拽后的落点（视图层）：运行态格子与草稿都按这一份覆盖初始摆放。 */
  const [dragOffsets, setDragOffsets] = useState<Record<string, { x: number; y: number }>>({});
  /** 加过草稿就自增一次，让下面的 effect 重新贴合视口（0 = 还没加过，不该动用户的视野）。 */
  const [fitRequestId, setFitRequestId] = useState(0);

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
      },
    }));
    const draftNodes = drafts.map((draft, index) => {
      // 标题键也从描述表取：这里再拼一次 `workflow.operator.${kind}.title` 就是第二份规则（§2.2）。
      const descriptor = operatorByKind(draft.kind);
      return {
        id: draft.id,
        type: 'operator' as const,
        position: dragOffsets[draft.id] ?? draft.position,
        data: {
          stepId: draft.id,
          label: descriptor ? t(descriptor.titleKey, { defaultValue: draft.kind }) : draft.kind,
          status: 'pending' as const,
          order: runningNodes.length + index + 1,
          kind: draft.kind,
        },
      };
    });
    return [...runningNodes, ...draftNodes];
  }, [steps, drafts, dragOffsets, t]);

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
    const sameKindCount = drafts.filter((draft) => draft.kind === descriptor.kind).length;
    const draftId = `${descriptor.kind.replaceAll('.', '-')}-draft-${String(sameKindCount + 1)}`;
    setDrafts((previous) => [
      ...previous,
      {
        id: draftId,
        kind: descriptor.kind,
        params: operatorParamDefaults(descriptor),
        position: { x: 0, y: DRAFT_ORIGIN_Y + previous.length * 78 },
      },
    ]);
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
    setDrafts((previous) => previous.map((draft) => (draft.id === draftId ? { ...draft, params } : draft)));
  }

  /** 线性链的边：相邻步骤连一条（草稿之间的连线属 5.10-d）。 */
  const edges = useMemo<Edge[]>(
    () =>
      steps.slice(1).map((step, index) => ({
        id: `${steps[index]?.id}->${step.id}`,
        source: steps[index]?.id ?? '',
        sourceHandle: 'default',
        target: step.id,
        targetHandle: 'default',
        type: 'smoothstep',
        animated: step.status === 'running',
      })),
    [steps],
  );

  const selectedDraft = drafts.find((draft) => draft.id === selectedDraftId) ?? null;
  const selectedDescriptor = selectedDraft ? operatorByKind(selectedDraft.kind) : undefined;

  return (
    <div className="mt-3" data-testid="workflow-canvas">
      <h3 className="text-xs font-semibold text-slate-300">{t('workflow.canvas.heading')}</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{t('workflow.canvas.hint')}</p>
      <OperatorPalette onAdd={addDraftNode} />
      {/* react-flow 需要一个有高度的容器，否则视口量到 0 宽高（隐藏视图宽高为 0 会让点击落空，同一类坑） */}
      <div className="mt-2 h-[420px] w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-950/40">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
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
          // 连线与删除属 5.10-d 的命令栈，这一版只开放加节点与填参数（spec 5.10-03/04）
          nodesConnectable={false}
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
 * 对外出口：给编辑器套一层 `ReactFlowProvider`。
 *
 * 为什么要这一层：加草稿后要把视口重新贴合（见 `WorkflowCanvasEditor` 里的 fitView 效应），
 * 而 `useReactFlow()` 只有在 provider 之下才拿得到实例——库的 `fitView` prop 只在挂载时算一次，
 * 覆盖不了"挂载之后又加了格子"这一种情况。
 * @param steps 当前 run 的步骤读数
 * @returns 挂好 provider 的画布
 */
export function WorkflowCanvas({ steps }: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvasEditor steps={steps} />
    </ReactFlowProvider>
  );
}
