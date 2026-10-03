/**
 * `agent.sediment` 服务（spec 5.4-01 / 02 / 03 / 05 / 06 / 09）：把一次跑通的对话任务**投影**成工作流计划。
 *
 * 这里只做一件事：读 `agent.loop` 的 run 读数 + 工具声明上的 `workflow` 条款，产出「这段对话能不能
 * 变成一条工作流、每个格子长什么样、哪个格为什么不行」。计划的**存储与校验不在本包**——
 * 落库经 `workflow.runner.savePlan` 这一个写入口（名字校验、`buildPlan` 重算指纹都在那边），
 * 因为「一条计划跑不跑得起来」由 workflow 域的登记处说了算，在这里再判一遍就是两套口径（AGENTS.md §2.5）。
 *
 * 为什么投影放在 agent 侧而不是 workflow 侧：投影要的是 agent 域内的真相（run 行 + 步行 + 工具声明），
 * 而 workflow 域不认识 `agent_step` 这个形状；方向沿用既有先例——L2 的 outbound 软问 L3 的登记处
 * （`executorRegistryOf`），反过来让 workflow 读对话记录就是把流水线依赖到对话的形状上（plan 5.4-a 落点）。
 *
 * 与 5.10 的画布无关：沉淀出来的仍是线性 `nodes` 数组，`edges` 一类不在本片（plan「5.4 不做的事」）。
 */
import {
  AppError,
  agentToolTable,
  asApp,
  executorRegistryOf,
  maybeService,
  Service,
  WORKFLOW_VARIABLE_PARAM_KEYS,
  type AgentRunView,
  type AgentToolDeclaration,
  type Context,
  type PlanParamReadoutView,
  type SavedWorkflowPlanView,
  type SedimentPreviewView,
  type SedimentStepView,
  type WorkflowNodeSpec,
  type WorkflowParamValue,
} from '@auto-cc/core';
import { z } from 'zod';
import type { AgentLoopService } from './loop.js';

/** 沉淀服务暂无可配置项；strict 让 `cordis.yml` 里写错的键在挂载期就报错（同包其余服务的口径）。 */
export const agentSedimentSchema = z.strictObject({});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type AgentSedimentConfig = z.output<typeof agentSedimentSchema>;

/**
 * 从 workflow 侧只需要的那一口（按结构取，不 import 本包的兄弟包：AGENTS.md §4.1 的依赖方向）。
 *
 * `savePlan` 是**唯一**的计划写入口，id 生成、名字校验、`buildPlan` 都在它里面，所以这里不声明返回值细节，
 * 只把形状钉到「能存下一条计划」为止（与 workflow 包里 `PageSnapshotReader` 同一套路）。
 */
type WorkflowPlanSaver = {
  savePlan(nodes: readonly WorkflowNodeSpec[], nameRaw: string, sourceRunId: string | null): SavedWorkflowPlanView;
};

/**
 * 投影要问的两件事：这只工具怎么声明自己、这个执行器名登记了没有。
 *
 * 做成注入的查表函数而不是让投影直接摸注册表：单测要能拿一份手写声明表跑 5.4-02/09 的组合，
 * 而真运行时的声明表住在 `core` 的按上下文表里、登记处住在 workflow 里（两处都不该被投影认识）。
 */
export type SedimentLookups = {
  /** 按 id 取工具声明（含 `workflow` 条款）；没登记过的手返回 undefined。 */
  declarationOf(toolId: string): AgentToolDeclaration | undefined;
  /** 这个节点 `kind` 当前有没有执行器。 */
  kindRegistered(kind: string): boolean;
};

/**
 * 沿点路径读一个标量（`request.jobId` → 值）。
 * @param input 这一步实际递给工具的入参（来自 `agent_run.plan_json` 的那份草案，见 `projectRun` 的注释）
 * @param path 点路径文本
 * @returns 标量值；路径断了、或末端不是标量时 undefined（调用方按「这个参数不带」处理）
 */
function readScalarPath(input: unknown, path: string): WorkflowParamValue | undefined {
  let cursor: unknown = input;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  // 节点参数只接受标量（`plan.ts` 的 nodeParamSchema），数组/对象在这里就断掉：
  // 落一条跑不通的计划比少一个参数更糟——它会把「沉淀成功」说成一句谎。
  return typeof cursor === 'string' || typeof cursor === 'number' || typeof cursor === 'boolean' ? cursor : undefined;
}

/**
 * 把一次 run 的读数投影成沉淀预览（纯函数，`preview` 与 `save` 共用同一条判据）。
 *
 * 预览与落库必须走这一个函数：分开写就会出现「界面说可以、服务拒了」或反之，而 5.4-02 判的正是拒绝口径
 * （plan 5.4-a：三条「拒」的口径必须由同一次投影给出）。
 * @param run `agent.loop.read()` 的整份读数（计划草案 + 已跑到的步）
 * @param lookups 声明表与执行器登记处的查表口
 * @returns 逐格读数 + 整段能不能沉淀 + 第一条拒因
 */
export function projectRun(run: AgentRunView, lookups: SedimentLookups): SedimentPreviewView {
  // 「跑到的步」以 `agent_step` 有行为准：没跑到的步不落行（5.2 的口径），所以不能按 plan 的长度铺格子，
  // 否则一条中途叫停的 run 会把没做的那几步也沉淀进计划——那是 5.4-09 反向验证要抓的第一种假。
  const rowByStep = new Map(run.steps.map((step) => [step.planStepIndex, step]));
  const executed = run.plan.filter((step) => rowByStep.has(step.planStepIndex));
  const views: SedimentStepView[] = executed.map((step) => {
    const row = rowByStep.get(step.planStepIndex)!;
    const base = { planStepIndex: step.planStepIndex, toolId: step.toolId, stepStatus: row.status };
    if (row.status !== 'ok') {
      return {
        ...base,
        sedimentable: false,
        reason: `第 ${String(step.planStepIndex + 1)} 步的状态是 ${row.status}，不是成功（含失败步的段落不能沉淀，spec 5.4-02）`,
        node: null,
        params: [],
      };
    }
    const declaration = lookups.declarationOf(step.toolId);
    if (!declaration) {
      return {
        ...base,
        sedimentable: false,
        reason: `工具 ${step.toolId} 当前没有声明（能力包被摘掉了），这一步没有可复现的手`,
        node: null,
        params: [],
      };
    }
    // 不声明 = 这只工具不可沉淀，**没有**「按 id 猜一个 kind」的回落：猜中的那次能跑，
    // 猜不中的那次会把一条跑不通的工作流说成沉淀成功（spec 5.4-09）。
    const clause = declaration.workflow;
    if (!clause) {
      return {
        ...base,
        sedimentable: false,
        reason: `工具 ${step.toolId} 没有声明对应的可跑节点（它的产物是给用户读的，不是工作流的一步）`,
        node: null,
        params: [],
      };
    }
    if (!lookups.kindRegistered(clause.kind)) {
      return {
        ...base,
        sedimentable: false,
        reason: `节点执行器 ${clause.kind} 当前没登记（工作流侧没有这只手），这一步跑不起来`,
        node: null,
        params: [],
      };
    }
    const nodeId = `node-${String(step.planStepIndex + 1)}`;
    const params: Record<string, WorkflowParamValue> = {};
    for (const [paramKey, path] of Object.entries(clause.params)) {
      const value = readScalarPath(step.input, path);
      if (value === undefined) continue;
      params[paramKey] = value;
    }
    const readout: PlanParamReadoutView[] = Object.entries(params).map(([paramKey, value]) => ({
      nodeId,
      paramKey,
      value,
      // 变量与否**不存库**，按白名单键名现算（`WORKFLOW_VARIABLE_PARAM_KEYS`）：
      // 存一份标记就有第二份事实，改了键名或改了值时两边会各说各话（§2.5）。
      isVariable: (WORKFLOW_VARIABLE_PARAM_KEYS as readonly string[]).includes(paramKey),
    }));
    return {
      ...base,
      sedimentable: true,
      reason: null,
      // `effect` 取工具声明而不是自己分级：危险度属于这只手的固有属性，两处各写一份迟早会漂移。
      // 于是 `jd.capture.run` 沉淀出来是 `outbound`（它占一条 search 额度，声明就这么写的），
      // 与内置计划里那格 `read` 不同——那是两条不同的声明，不是一份事实的两种写法。
      node: {
        id: nodeId,
        kind: clause.kind,
        target: clause.target === undefined ? '' : String(readScalarPath(step.input, clause.target) ?? ''),
        params,
        effect: declaration.effect,
        // `retryTimes: null` = 跟全局配置；`requiresHuman: false` = 不是接管点。
        // 两者都不从对话记录里猜：退避策略与接管点属于计划作者的决定，5.4 没有让用户在卡片上改它们。
        retryTimes: null,
        requiresHuman: false,
      },
      params: readout,
    };
  });
  const blocking = views.find((view) => !view.sedimentable);
  return {
    runId: run.runId,
    goal: run.goal,
    steps: views,
    canSediment: views.length > 0 && !blocking,
    blockingReason: views.length === 0 ? '这次任务一步都没跑过，没有可沉淀的内容' : (blocking?.reason ?? null),
  };
}

/**
 * 对话 → 工作流的沉淀入口（spec 5.4-01 的两只手：先看一眼，再存下来）。
 *
 * 不开第三条口：预览与保存之外没有别的动作，改名字、删除这些列表管理走 `workflow.runner` 的既有计划口。
 */
export class AgentSedimentService extends Service {
  static provide = 'agent.sediment';
  static Config = agentSedimentSchema;
  // 同包内的硬依赖（与 `agent.loop` inject `agent.tools` 同形）：投影读的就是那份 run 记录。
  static inject = ['agent.loop'];

  constructor(ctx: Context, _options: AgentSedimentConfig) {
    // 无配置项也要接住第二个实参：cordis 递的是校验后的配置对象（AGENTS.md §9 实测 1.3）。
    super(ctx, 'agent.sediment');
  }

  private get loop(): AgentLoopService {
    return asApp(this.ctx)['agent.loop'];
  }

  /**
   * 看一眼这次任务能不能沉淀、每个格子会变成什么（spec 5.4-01 的预览卡素材）。
   * @param runId `agent.loop` 的 run id（来自对话卡片，不是用户手打的）
   * @returns 逐格读数 + 整段判决 + 第一条拒因
   * @throws 库里没有这条 run 时按 `agent.loop.read` 的口径失败（`AGENT_LOOP_RUN_NOT_FOUND`）
   */
  preview(runId: string): SedimentPreviewView {
    return projectRun(this.loop.read(runId), this.lookups());
  }

  /**
   * 把这次任务存成一条自定义计划（spec 5.4-01 的落库半边）。
   *
   * 先跑一遍 `preview` 再决定存不存：拒绝口径只有一处（`projectRun`），界面上的绿勾与这里的放行
   * 因此永远不会各说各话。名字校验**不在这里**，在 `workflow.runner.savePlan` 那个唯一写入口（5.4-05）。
   * @param runId 要沉淀的 run
   * @param nameRaw 用户填的工作流名字（原样转过去，本服务不提前 trim 也不提前判长度——那是第二套规则）
   * @returns 刚落库的计划读数（含新 id，界面据此把下拉指过去）
   * @throws `INVALID_ARGUMENT` 段落不可沉淀（含失败步 / 有格子没有可跑节点 / 一步都没跑）；
   *         `SERVICE_NOT_FOUND` 工作流没挂载（没有存储口，此时对话侧照常能用）
   */
  save(runId: string, nameRaw: string): SavedWorkflowPlanView {
    const preview = this.preview(runId);
    if (!preview.canSediment) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `这条对话记录还不能沉淀成工作流：${preview.blockingReason ?? '未知原因'}`,
        'agent.sediment',
        { runId, steps: preview.steps },
      );
    }
    const nodes = preview.steps.map((step) => step.node).filter((node): node is WorkflowNodeSpec => node !== null);
    const saver = maybeService<WorkflowPlanSaver>(this.ctx, 'workflow.runner');
    if (!saver) {
      throw new AppError(
        'SERVICE_NOT_FOUND',
        '工作流没挂载（workflow.runner 不在），没有可写入的计划存储口',
        'agent.sediment',
        { runId },
      );
    }
    return saver.savePlan(nodes, nameRaw, runId);
  }

  /**
   * 组装投影要问的两张表：工具声明表（按上下文存在 core）+ 执行器登记处（软问）。
   *
   * 每次现问现组：声明表会随能力包热改重建，登记处会随 workflow 摘装消失，
   * 在本地存一份就是 §9 的 2.5 实测里那个「静默变空」的注册表。
   * @returns 给 `projectRun` 的查表口
   */
  private lookups(): SedimentLookups {
    const table = agentToolTable(this.ctx);
    const registry = executorRegistryOf(this.ctx);
    return {
      declarationOf: (toolId) => table.get(toolId),
      kindRegistered: (kind) => registry?.list().includes(kind) ?? false,
    };
  }

  [Service.init](): void {
    // 报的是「条款数」而不是「工具数」：能沉淀的手只有那几只，界面上的空态要说得出为什么是空的。
    const withClause = [...agentToolTable(this.ctx).values()].filter((tool) => tool.workflow !== undefined);
    this.ctx.logger.info(
      `对话沉淀就绪：已声明可沉淀节点的工具 ${String(withClause.length)} 只（${
        withClause.map((tool) => `${tool.id}→${tool.workflow?.kind}`).join('、') || '没有——能力包都没带 workflow 条款'
      }）`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'agent.sediment': AgentSedimentService;
  }
}
