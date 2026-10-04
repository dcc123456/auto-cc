/**
 * `workflow.graph` 服务（spec 5.10-10 / 5.10-17，plan §7.8.3 的 e 片）：画布读写图的唯一入口。
 *
 * 存储机器不在这里——表、列、读写函数都在 `plan-store.ts`（同一个连接、同一份迁移清单），
 * 本服务只做两件不属于存储层的事：
 * ① **保存前**把五条图校验跑一遍（判据本体在 `@auto-cc/core/graph-check`，界面上那圈红环读的是
 *    同一份机器，§2.5），不合法就结构化拒绝并把逐条原因带回去，库里那一版原样不动；
 * ② 内置那三条计划不在表里，`load` 时从目录线性投影，于是「能选出来的计划就能画」是一句话，
 *    而不是界面前两份清单、服务里再判一次。
 *
 * 为什么不并进 `workflow.runner`：runner 的方法全在「跑」这件事上，图读写是编辑面，
 * 混在一起会让 5.10-f 的 DAG 改造与本片互相踩（plan §7.8.3 的 e/f 分界）。
 * 为什么不新起一个存储服务：那是 §2.7 禁止的「第二条拿着同一个连接的通路」。
 *
 * **5.10-f 起的边界**：保存连带把 `plan_json` 与 `fingerprint` 按拓扑序回写（裁定六，实现在存储层的
 * `savePlanGraph`），于是"画布上存过的图"与"runner 拿去跑的本体"必然是同一份节点集合；
 * 边只存在于 `graph_json`，runner 按图推进（spec 5.10-07/08/09/13）。
 */
import {
  AppError,
  asApp,
  checkWorkflowGraph,
  Service,
  WORKFLOW_OPERATORS,
  type Context,
  type WorkflowGraphLoadView,
  type WorkflowGraphSaveInput,
  type WorkflowGraphSaveView,
} from '@auto-cc/core';
import { z } from 'zod';
import { buildGraph, projectPlanToGraph, workflowGraphSchema, workflowViewsSchema } from './graph.js';
import { planById } from './plan.js';
import type { WorkflowRunStoreService } from './run-store.js';

/** 本服务无配置项，但 cordis 仍要求构造器接住校验后的配置对象（AGENTS.md §9 实测 1.3）。 */
const workflowGraphServiceConfig = z.strictObject({});

/** 保存入参的形状：渲染层递来的值是系统边界，只在这里校验一次（§2.6）。 */
const saveGraphInputSchema = z.strictObject({
  planId: z.string().min(1),
  graph: workflowGraphSchema,
  placements: workflowViewsSchema.default([]),
  /** 画布基于哪一版编辑的；与库里不等就拒绝写入（`WorkflowGraphLoadView.revision` 的对面）。 */
  expectedRevision: z.number().int().min(1),
});

/** `save()` 的入参形状（跨进程签名与契约同侧，定义在 `@auto-cc/core`；上面这份 schema 是它的运行期校验）。 */

/**
 * 画布的图读写口（spec 5.10-10）。
 *
 * 挂载即就绪：它不建表也不跑迁移（那是 `workflow.store` 在 init 里做的），
 * 所以调试面板单独摘掉 `workflow-graph` 只会让画布读不到图，不会牵动 run 状态那一套。
 */
export class WorkflowGraphService extends Service {
  static provide = 'workflow.graph';
  static Config = workflowGraphServiceConfig;
  static inject = ['workflow.store'];

  constructor(ctx: Context, _options: z.output<typeof workflowGraphServiceConfig>) {
    super(ctx, 'workflow.graph');
  }

  /** `workflow.store` 句柄；用的时候现问，不在本地存第二份事实（AGENTS.md §9 的 2.5 实测条）。 */
  private get store(): WorkflowRunStoreService {
    return asApp(this.ctx)['workflow.store'];
  }

  /**
   * 读一条计划的画布图。
   * @param planId 计划 id（自定义计划读库里那份；内置那三条由 `plan_json` 线性投影现算，
   *               `isCustom` 为 false、落点为空数组，画布按默认摆位打开）
   * @returns 图 + 落点 + 覆盖保存用的版本号
   * @throws `INVALID_ARGUMENT` 既不在库里也不在内置目录里——不返回空图，否则画布会显示成「一条都没有」
   */
  load(planId: string): WorkflowGraphLoadView {
    const stored = this.store.getPlanGraph(planId);
    if (stored) return stored;
    // 内置那三条不在表里：读不出来就从目录线性投影（5.10-02 的判据在 IPC 这一侧同样成立）。
    // 两条都不是时 `planById` 自己抛「未知的工作流计划 …，可选：…」，这里不再抄一遍文案。
    return {
      planId,
      graph: projectPlanToGraph(planById(planId)),
      placements: [],
      // 内置计划没有可比的版本：给 1 表示「第一版就是它自己」。想改它得先复制成自定义计划，
      // 否则 `save` 会因为表里没有这一行而拒写（`savePlanGraph` 的那条 INVALID_ARGUMENT）。
      revision: 1,
      isCustom: false,
    };
  }

  /**
   * 保存画布图（覆盖保存）。
   *
   * 顺序是「结构 → 语义 → 并发」三道，缺一不可：`buildGraph` 管结构与指纹，
   * `checkWorkflowGraph` 管那五条保存前判据（未知 kind / 悬挂边 / 多源点 / 有环 / 外发缺 target），
   * 存储层管版本号。三道都在服务端跑，是因为界面那条只是**预览**——真正的闸门必须在写入口。
   * @param input 计划 id、图本体、落点、期望版本（形状见 `WorkflowGraphSaveInput`）
   * @returns 保存后的版本号与指纹（界面用它把 `expectedRevision` 跟上）
   * @throws `INVALID_ARGUMENT` 形状不合、图 id 与计划 id 不符、或五条校验任一不过（逐条原因在 message 与
   *         `details.issues` 里）；`WORKFLOW_INVALID_STATE` 计划不存在或版本冲突
   */
  save(input: WorkflowGraphSaveInput): WorkflowGraphSaveView {
    const parsed = saveGraphInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `保存画布的参数不合法：${parsed.error.issues.map((item) => `${item.path.join('.')} ${item.message}`).join('；')}`,
        'workflow.graph',
        {},
      );
    }
    const { planId, placements, expectedRevision } = parsed.data;
    if (parsed.data.graph.id !== planId) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `图的 id ${parsed.data.graph.id} 与要保存的计划 ${planId} 不符，拒绝写入`,
        'workflow.graph',
        { planId, graphId: parsed.data.graph.id },
      );
    }
    // 结构层：重名节点 / 边端点不存在 / 线性边按顺序重算，顺带把指纹重算一遍（不信传进来的那串）。
    const graph = buildGraph({ ...parsed.data.graph, id: planId });
    const issues = checkWorkflowGraph(graph, WORKFLOW_OPERATORS);
    if (issues.length > 0) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `这张图有 ${String(issues.length)} 处问题，未保存：${issues.map((issue) => issue.message).join('；')}`,
        'workflow.graph',
        { planId, issues: issues.map((issue) => ({ code: issue.code, nodeIds: issue.nodeIds })) },
      );
    }
    const saved = this.store.savePlanGraph({
      id: planId,
      graph,
      placements,
      expectedRevision,
      at: Date.now(),
    });
    // 与 `savePlan` 同一份事件：计划列表那一列显示节点数，画布存过图之后它可能变了（5.10-10）。
    this.ctx.emit('workflow/plans-changed', { action: 'save', planId, at: saved.updatedAt });
    return saved;
  }
}
