/**
 * 算子图画布（spec 5.10-01 的第一版落点：节点=算子、边=执行顺序、可平移缩放与拖拽）。
 *
 * 这一片只做**渲染与交互骨架**，不判定任何东西：状态整份取自 `workflow.runner` 推来的 `run.steps`
 * （经由 `WorkflowPanel` 传下来），画布自己不发请求、不起定时器（spec 5.10-11 的判据要求"离开画布
 * 无残留句柄"，所以它由面板按开合挂载/卸载，而不是常驻）。
 *
 * 三条口径先写清楚，免得后面几片改不动：
 * - **位置是视图层**：这里的落点只是"按执行顺序横向排开"的初始摆放，用户拖完之后位置由画布自己
 *   持有；它不进计划语义，也不参与指纹（5.10-06 会把这个约束钉成测试）。
 * - **边是执行顺序**：现在只有线性一条链（`steps` 的相邻关系），`default` 出口之外还有分支时
 *   边要从图的 edges 里来 —— 那是 b 片扩语义层之后的事，这里刻意不把"相邻即边"写成永久规则。
 * - **配色与步骤行同源**：`STEP_STATUS_STYLE` 与工作流面板共用一份，同一状态在两处必须同色。
 */
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import type { WorkflowStepView } from '@auto-cc/shared';
import { STEP_STATUS_STYLE } from './stepStatusStyle';

/** 初始摆放的节点间距（像素）。真正的落点规则（按拓扑分层）在 b/后续片里定。 */
const NODE_GAP_X = 260;

/** 节点卡片要显示的读数——全部来自 run 的步骤镜像，画布不自己算。 */
interface OperatorData extends Record<string, unknown> {
  /** 步骤 id（同时是节点 id）：harness 按它定位格子，必须是稳定值而不是译文 */
  stepId: string;
  /** 展示标签，语言包没有条目时退回步骤 id 本身 */
  label: string;
  /** 步骤状态，取 shared 的四种（`skipped` 的写点在 f 片才有，这里先不扩） */
  status: WorkflowStepView['status'];
  /** 第几步（从 1 开始，与步骤行的序号同口径） */
  order: number;
}

type OperatorNode = Node<OperatorData, 'operator'>;

/**
 * 单个算子节点：一张带左右连接点的卡片。
 *
 * 样式一律 Tailwind utility（AGENTS.md §5.1）；库自己的 `dist/style.css` 只在入口引一次，
 * 负责的是画布视口的定位与连线，不碰这块卡片的外观。
 * @param data 该节点的读数
 * @returns 节点卡片
 */
function OperatorNodeCard({ data }: NodeProps<OperatorNode>) {
  return (
    <div
      data-testid="canvas-node"
      data-node-id={data.stepId}
      data-node-status={data.status}
      className={`rounded-lg border px-3 py-2 text-[11px] shadow-sm ${STEP_STATUS_STYLE[data.status]}`}
    >
      {/* 连接点在 b 片做多出口时才有多枚；现在一进一出，句柄名固定 default */}
      <Handle
        type="target"
        position={Position.Left}
        id="default"
        className="!h-2 !w-2 !border-2 !border-slate-700 !bg-slate-950"
      />
      <span className="font-mono text-xs opacity-60">{String(data.order)}</span>
      <span className="ml-2 break-all">{data.label}</span>
      <Handle
        type="source"
        position={Position.Right}
        id="default"
        className="!h-2 !w-2 !border-2 !border-slate-700 !bg-slate-950"
      />
    </div>
  );
}

/** `nodeTypes` 必须在组件外定义：每次渲染新建对象会让 react-flow 重建所有节点。 */
const NODE_TYPES = { operator: OperatorNodeCard } as const;

export interface WorkflowCanvasProps {
  /** 当前 run 的步骤镜像（`workflow/progress` 推来的那份，不是画布自己读的） */
  steps: WorkflowStepView[];
}

/**
 * 画布主体：把步骤镜像画成一条链，节点随事件变色。
 * @param steps 当前 run 的步骤读数
 * @returns 可平移缩放、节点可拖拽的画布
 */
export function WorkflowCanvas({ steps }: WorkflowCanvasProps) {
  const { t } = useTranslation();
  const [nodes, setNodes, onNodesChange] = useNodesState<OperatorNode>([]);

  /**
   * 步骤读数变了就整表重建，但**保留已有节点的位置**：
   * 否则每来一条进度事件，用户刚拖好的摆放就被弹回初始行，画布等于不能用。
   */
  useEffect(() => {
    setNodes((previous) =>
      steps.map((step, index) => {
        const existing = previous.find((node) => node.id === step.id);
        const label = t(`workflow.step.${step.id}`, step.id);
        return {
          id: step.id,
          type: 'operator',
          position: existing?.position ?? { x: index * NODE_GAP_X, y: 0 },
          data: { stepId: step.id, label, status: step.status, order: index + 1 },
        };
      }),
    );
  }, [steps, setNodes, t]);

  /** 线性链的边：相邻步骤连一条，出口句柄一律 `default`（分支边属 b 片之后的 edges 语义）。 */
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

  return (
    <div className="mt-3" data-testid="workflow-canvas">
      <h3 className="text-xs font-semibold text-slate-300">{t('workflow.canvas.heading')}</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{t('workflow.canvas.hint')}</p>
      {/* react-flow 需要一个有高度的容器，否则视口量到 0 宽高（harness 的隐藏视图宽高为 0 会让点击落空，同一类坑） */}
      <div className="mt-2 h-[420px] w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-950/40">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          nodeTypes={NODE_TYPES}
          // 库自带明暗两套主题（`dist/style.css` 里的 `.react-flow.dark` 变量组）。本 app 只有深色一套
          // 界面，所以显式走 dark：默认 light 下画布控件是一排白底按钮，与界面打架（实测截图）。
          // 用库的主题开关而不是自己写样式覆盖——AGENTS.md §5.1 禁止渲染层手写 CSS。
          colorMode="dark"
          fitView
          // 滚轮交给页面而不是交给画布：库默认截获画布上的 wheel 做缩放，于是 420px 高的画布成了
          // 工作流视图里的一段"滚动墙"——鼠标停在上面就滚不过去（实测：harness 滚到边界仍拍不到画布）。
          // 读 `@xyflow/system` 编译产物确认这条出口（AGENTS.md §6.2）：`preventScrolling=false` 时
          // `createZoomOnScrollHandler` 对不带 Ctrl 的 wheel 直接 return，连 `event.preventDefault()` 都不做，
          // 滚动因此交回浏览器；带 Ctrl 的 wheel 才继续走 d3 缩放。活体实测只证了前者（画布内滚轮 →
          // 容器 scrollTop 变化、视口 transform 不变），缩放走画布控件按钮那条路已实测生效。
          preventScrolling={false}
          // 连线编辑与多选属 5.10-c/d 的编辑态，这一版只让拖节点与平移缩放（spec 5.10-01）
          nodesConnectable={false}
          deleteKeyCode={null}
          // 库的署名浮标是一个外链，AGENTS.md §8.1 要求外链默认拒绝，所以关掉
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1e293b" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
