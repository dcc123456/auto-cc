/**
 * `@auto-cc/plugin-workflow`（spec 1.10 → 2.4）：按**计划**推进的工作流执行器。
 *
 * 1.10 交付的是六个占位步骤的空转流水线；2.4 把「步骤」换成「计划里的节点」：
 * 节点从 `plan.ts` 的计划声明来，执行函数从 `workflow.executors` 登记处来，
 * 每一次开始/结束/失败/重试都同时写进 `workflow.store` 的两张表（spec 2.4-01/02/05/10）。
 * 状态机仍然是 `machine.ts` 那一份，事件仍然只有 `workflow/progress` 一条频道，
 * 界面仍然只画 `run.steps`——换实现不动这三样（plan §11.3 第 1/2/3 条）。
 *
 * 失败只有三种下场：自动退避重试、转人工接管、判失败（plan §11.8）。没有节点级自动修复，
 * 也没有「猜一次也许就成了」的静默重放——外发动作重放一遍就是给同一个人发两条消息。
 */
import {
  AppError,
  asApp,
  maybeService,
  redactText,
  redactValue,
  agentTool,
  registerAgentTools,
  Service,
  sleep,
  toolResult,
  WORKFLOW_DEFAULT_OUTPUT,
  type Context,
  type RiskSignalEvent,
  type SavedWorkflowPlanView,
  type SessionExpiredEvent,
  type ToolEffect,
  type WorkflowGraphView,
  type WorkflowNodeSpec,
  type WorkflowNodeExecutor,
  type WorkflowNodePhase,
  type WorkflowEvidenceView,
  type WorkflowPlanOptionView,
  type WorkflowPlanView,
  type WorkflowRunStateView,
  type WorkflowRunView,
  type WorkflowStepId,
  type WorkflowStepView,
  type WorkflowTakeoverView,
} from '@auto-cc/core';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createRun, transition, type RunnerEvent } from './machine.js';
import type { WorkflowExecutorRegistryService } from './executors.js';
import { advanceGraph, initialAdvanceState, type GraphAdvanceView } from './graph-advance.js';
import { projectPlanToGraph } from './graph.js';
import { BOSS_BASIC_PLAN, buildPlan, planById, WORKFLOW_PLANS, workflowPlanSchema } from './plan.js';
import { assertPlanName, newPlanId } from './plan-store.js';
import type { WorkflowRunStoreService } from './run-store.js';
import { retryBudgetFor } from './retry-policy.js';

// 登记处与落库服务从包出口露出去：装配清单要为它们各占一个 id（main/registry.ts）。
// 执行器的**契约**（`WorkflowNodeExecutor` 等）在 `@auto-cc/core`，能力包从那里取，不 import 本包。
export { WorkflowExecutorRegistryService } from './executors.js';
export { WorkflowRunStoreService } from './run-store.js';
// 画布图的读写口（spec 5.10-10）：装配清单为它单独占一个 id，摘掉它画布读不到图但不影响 run。
export { WorkflowGraphService } from './graph-service.js';
export {
  advanceGraph,
  initialAdvanceState,
  topologicalOrder,
  type GraphAdvanceInput,
  type GraphAdvanceView,
  type GraphNodeOutcome,
  type GraphNodeStatus,
} from './graph-advance.js';
export { BOSS_BASIC_PLAN, WORKFLOW_PLANS, planById, buildPlan, workflowPlanSchema };
// 重试预算单独露出去（spec 5.7-04）：判据是"外发不重试、只读 ≤2"，用例直接打这条纯函数比造一个假执行器更省。
export { READ_RETRY_CEILING, retryBudgetFor, type RetryBudget } from './retry-policy.js';

/**
 * `workflow.run` 的入参（spec 5.10-18，plan §7.8.2 裁定五）。
 *
 * 只有计划 id：节点内容一律由 `start()` 从配置或库里那份现取，工具面不接收节点数组——
 * 那会让 agent 侧长出一条"绕过保存前五条校验直接拼图"的第二通路（§2.5）。
 */
const workflowRunInputSchema = z.strictObject({ planId: z.string().min(1) });

/** 一个失败节点留下的证据（spec 2.4-04）。 */
type NodeEvidence = {
  runId: string;
  nodeId: string;
  kind: string;
  effect: ToolEffect;
  target: string;
  /** 判失败时是第几次尝试（含首次）。 */
  attempt: number;
  /** 判定时间戳（毫秒）。 */
  at: number;
  error: { code: string; message: string; details?: unknown };
  /** 失败当时的页面读数；没有已挂载的内核会话时为 null（证据仍然要落盘）。 */
  page: { url: string; title: string; bodyText: string } | null;
  /**
   * 失败当时的现场截图（spec 2.4-04）；`ref` 是相对 userData 的证据目录路径。
   * 取不到画面（页面服务没装 / 视图隐藏 / 写盘失败）时为 null——**错误 payload 比一张图重要**，
   * 所以截图失败不会把整份证据丢掉。
   */
  screenshot: { ref: string; width: number; height: number } | null;
};

/**
 * `browser.page` 里证据只需要的那两个方法（按结构取，不引包依赖：
 * workflow 不 import browser，否则 2.4-08「无浏览器纯 mock 跑通整条链」就破了）。
 *
 * `screenshot` 是**可选**的：装的页面服务可以只给快照不给截图（1.6 那套 harness 通道就是这样），
 * 这时证据记 null，工作流的行为与没有 browser 时一致。
 */
type PageSnapshotReader = {
  snapshot: (maxChars?: number) => Promise<{ url: string; title: string; bodyText: string }>;
  screenshot?: () => Promise<{ width: number; height: number; png: Uint8Array }>;
};

/** 执行器配置（在调试面板里可热改，走 1.5 的 `plugins.saveConfig`；§11.4 的键表）。 */
export const workflowConfigSchema = z.object({
  /** 从 `WORKFLOW_PLANS` 里选哪条计划；选不到就在挂载期结构化失败。 */
  planId: z.string().min(1).default('boss-basic'),
  /** 失败后的**额外**尝试次数；`maxAttempts = 1 + retryTimes`（节点声明可覆盖）。 */
  retryTimes: z.number().int().min(0).max(5).default(2),
  /** 指数退避的基数：第 k 次重试前等 `backoff × 2^(k-1)` 毫秒。 */
  retryBackoffMs: z.number().int().min(0).max(5000).default(500),
  /** 退避上限，防止长计划卡死在一条指数尾巴上。 */
  retryBackoffCapMs: z.number().int().min(0).max(60000).default(5000),
  /** 单次 run 的节点上限（防死循环，也是界面画得下的上限）。 */
  maxNodesPerRun: z.number().int().min(1).max(200).default(200),
  /** 向页面通道索取的 DOM 片段上限（字符）。 */
  evidenceDomChars: z.number().int().min(0).max(20000).default(800),
  /** 证据文件里单个文本字段的上限（字符），超出截断并标注。 */
  evidenceTextChars: z.number().int().min(0).max(20000).default(300),
  /** userData 下的证据子目录名；文件名是 `<runId>-<nodeId>.json`，现场截图同名换成 `.png`。 */
  evidenceDir: z.string().min(1).max(64).default('evidence'),
  /**
   * 读侧上限：一张现场截图经 IPC 交给渲染层最多个头（字节）。
   *
   * 它和上面两个写侧上限不是一回事（那两条管的是「正文里留多少字」，这条管的是「一次 IPC 能塞多大」），
   * 所以必须存在：整窗 PNG 在真实站点上可以到几 MB，超限就不给图而不是截半张。
   */
  evidenceShotBytes: z.number().int().min(0).max(20_000_000).default(2_000_000),
  /** 旧 run 的保留个数，超出清 `workflow_*` 行并连带删掉它们的证据文件。 */
  retentionRuns: z.number().int().min(1).max(500).default(20),
});

export type WorkflowConfig = z.output<typeof workflowConfigSchema>;

/**
 * 工作流执行器：全应用唯一一份 run 状态，界面只是它的镜像（spec 1.10-08）。
 *
 * 与 1.10 的区别只有一句话：**槽位来自计划，进度同时落库**。
 * `current()` 给的是界面镜像（内存态，随事件推送），`state()` 给的是库里的真相（含尝试次数与证据路径）。
 */
export class WorkflowRunnerService extends Service {
  static provide = 'workflow.runner';
  static Config = workflowConfigSchema;
  static inject = ['workflow.store', 'workflow.executors', 'config'];

  /**
   * 当前要跑的计划。挂载时取配置里那条（`config.planId`），`start(planId)` 可以把它换成挑中的那条。
   *
   * 5.4 起它不再是挂载期常量：判据 5.4-03 要求"沉淀出的计划面板可直接运行"，而界面不能为了换一条
   * 计划去改配置（改配置会重建下游，见 AGENTS.md §9 的 2.5 实测）。**不做持久化**——重启回到配置值，
   * 九条判据里没有一条要求"重启后仍停在某条自定义计划"。写点只有 `selectPlan` 一处。
   */
  private plan: WorkflowPlanView;

  /**
   * 当前 run 的镜像：挂载即是一个 `idle` 的节点数快照，所以界面任何时候都有槽位可画（spec 1.10-02/03）。
   * 这个初始 run 在库里**没有行**——它只是给界面的空格子，第一次 `start()` 才产生 runId 并落库。
   */
  private run: WorkflowRunView;

  /**
   * 本次 run 的**图推进态**（spec 5.10-07/08/09 的调度侧依据）。
   *
   * 谁写它：`start()` 起一张图时取 `initialAdvanceState`，每个节点结算后由 `advanceGraph` 推进，
   * `resumeRun()` 从库里那些 `output_handle` 重建。谁读它：推进循环问「这一格是不是被级联判成没走」，
   * `succeedNode` 问「整张图结算完了没有」。
   * 线性计划下它退化成「一步一格」，与 2.4 的 `+1` 给出同一个顺序，所以这条路径不是分支开关，
   * 而是把原来那条线性推进换成图推进（同一件事只留一份实现，AGENTS.md §2.5）。
   */
  private advanceState: GraphAdvanceView = { outcomes: {}, ready: [], finished: false };

  constructor(
    ctx: Context,
    private readonly config: WorkflowConfig,
  ) {
    super(ctx, 'workflow.runner');
    // 这两样在构造器体里赋值而不是写在字段初始化器上：参数属性 `config` 是在字段初始化**之后**才写入的，
    // 初始化器里读它会拿到 undefined（TS2729）。计划不合法时在这里就抛，挂载因此结构化失败。
    // 挂载期只查内置目录：那时 `workflow.store` 的迁移不一定已经跑完，读表会把装配打崩。
    this.plan = this.selectPlan(planById(config.planId));
    this.run = createRun(
      'pending',
      Date.now(),
      this.plan.nodes.map((node) => node.id),
    );
  }

  /** 本次 run 的取消句柄；暂停/续跑/重试都会换一个新的，避免复用已 abort 的信号。 */
  private controller: AbortController | undefined;

  /**
   * 本进程内已经「声明开始过」的节点位置（`runId#下标`）。
   *
   * 为什么需要它：幂等闸门（`claimNode`）的意义是**跨进程**不重放，而同一个进程内的退避重试
   * 是同一次尝试序列的延续。若不区分，暂停/续跑就会把一个正在自动重试的读节点判成「外发未观察完成」
   * 而转接管，把 1.10-05 的暂停-续跑打断。跨进程的那一侧（kill 后重启）这张表是空的，闸门照旧生效。
   */
  private readonly claimedPositions = new Set<string>();

  /**
   * 用户已经在接管点上确认过「就重放这一个位置」的那些位置（同样是 `runId#下标`）。
   *
   * 它和上一张表的区别是判决来源：上一张是「本进程亲眼开始过」，闸门可以直接放行；
   * 这张是「本进程没开始过，但人说了继续」，于是仍然走 `claimNode(force)`——闸门照常工作，
   * 只是把「拒绝」换成「一次带日志的重放」（plan §11.3 第 5 条）。用完即弃：一次确认只放行一次。
   */
  private readonly confirmedPositions = new Set<string>();

  /**
   * 当前 run 的镜像读数，含还没跑过的那些槽位。
   * @returns 永不为 null；界面按状态画槽位，不需要为空态另写一套
   */
  current(): WorkflowRunView {
    return this.run;
  }

  /**
   * 界面画格子要用的节点声明（spec 2.4-01，5.4-07 把它从"当前计划"改成"这次 run 自己的快照"）。
   *
   * 有 run 就读那条 run 的 `plan_json`，没有 run（只有初始镜像）才读当前计划。差别在切换计划之后才显现：
   * 面板这时配的是 B，而屏幕上那条 run 是 A 跑的——格子必须还是 A 的那些格，否则进度会错位到
   * 别的节点上，而对话侧读的是同一个 `workflow/progress`，两处就会显示两件事（5.4-07 的判据）。
   * @returns 按执行顺序排列的节点声明；返回的是计划本体的引用，调用方不该改
   */
  nodes(): WorkflowNodeSpec[] {
    return this.store.planSnapshot(this.run.runId)?.nodes ?? this.plan.nodes;
  }

  /**
   * 可跑的计划清单：内置目录 + 用户沉淀出来的自定义计划（spec 5.4-01/08 的列表数据源）。
   *
   * 每次现读表、不在服务里存第二份计划事实（AGENTS.md §9 的 2.5 实测条：改配置重建下游时本地镜像会静默变空）。
   * 自定义计划排在前面（按最后改动时间倒序），面板顶部就是"我刚刚存下来的那条"。
   * @returns 每条计划的选项读数（id / 名字 / 指纹 / 节点数 / 来源）
   */
  plans(): WorkflowPlanOptionView[] {
    const custom = this.store.listPlans().map((saved) => ({
      id: saved.id,
      name: saved.name,
      source: 'custom' as const,
      fingerprint: saved.fingerprint,
      nodeCount: saved.nodeCount,
    }));
    const builtin = Object.keys(WORKFLOW_PLANS).map((id) => {
      const plan = planById(id);
      return {
        // 内置计划没有"名字"这一维：id 就是它对外的称呼（`boss-basic` 一类是稳定标识，不进 i18n）。
        id,
        name: id,
        source: 'builtin' as const,
        fingerprint: plan.fingerprint,
        nodeCount: plan.nodes.length,
      };
    });
    return [...custom, ...builtin];
  }

  /**
   * 存一条自定义计划（spec 5.4-01 的落库半边，也是 `agent.sediment.save` 的落点）。
   *
   * 这是计划的**唯一写入口**，所以三道拒绝里的命名校验（5.4-05）与形状校验都只做在这里：
   * 界面再拦一道是提示，服务拦不住才是缺陷（AGENTS.md §2.6——用户输入是系统边界）。
   * 落库前先过 `buildPlan`：它总是按节点内容**重算**指纹（`plan.ts` 的注释写着"传进来的值一律不信"），
   * 于是 5.4-03 的"与 2.4 节点模型完全同构"是结构上成立的，不是靠约定。
   * @param nodes 沉淀出来的节点声明（`agent.sediment` 的投影产物）
   * @param nameRaw 用户填的名字（首尾空格会被去掉）
   * @param sourceRunId 这条计划来自哪次 run；手工新建时传 null
   * @returns 刚落库的读数（含新 id，界面据此把下拉指过去）
   * @throws `INVALID_ARGUMENT`：名字不合法（空 / 超 40 字 / 非法字符）或节点形状不合、`kind` 未知由 runner 管
   */
  savePlan(nodes: readonly WorkflowNodeSpec[], nameRaw: string, sourceRunId: string | null): SavedWorkflowPlanView {
    const name = assertPlanName(nameRaw);
    const id = newPlanId();
    const plan = buildPlan({ id, nodes });
    const saved = this.store.savePlan({ id, name, plan, sourceRunId, at: Date.now() });
    // 写完就广播（5.4-01 的「存成后计划库出现新条目」）：这一条**必须**由写的一方发，
    // 因为沉淀卡在对话侧，它存计划时计划库界面并不经手，等界面自己刷新就会漏掉这一类写入。
    // 载荷只带 id 不带内容，界面收到就现查 `plans()`（AGENTS.md §2.7：不存第二份事实）。
    this.ctx.emit('workflow/plans-changed', { action: 'save', planId: id, at: Date.now() });
    return saved;
  }

  /**
   * 重命名一条自定义计划（spec 5.4-08）。只改名字，所以指纹不动——改名不该让
   * 已有的 run 变成"续不上"，那个判据管的是计划文本变没变。
   * @param id 计划 id（内置那三条不在表里，直接返回 null）
   * @param nameRaw 新名字，校验同 `savePlan`
   * @returns 改后的读数；库里没有这条时为 null
   */
  renamePlan(id: string, nameRaw: string): SavedWorkflowPlanView | null {
    const renamed = this.store.renamePlan(id, nameRaw, Date.now());
    // 改名成功才广播（5.4-08）：列表那一列显示的就是名字，不刷新就还是旧名。
    if (renamed) this.ctx.emit('workflow/plans-changed', { action: 'rename', planId: id, at: Date.now() });
    return renamed;
  }

  /**
   * 复制一条计划（spec 5.4-08 的"复制"）：拿到一份同内容、新 id、新名字的副本。
   *
   * 副本的指纹与源头相同（内容一样，指纹就是内容算出来的），这是**对的**：指纹的身份是"哪份计划文本"，
   * 不是"哪个列表条目"。5.4-06 的快照语义靠的是每行各存一份 `plan_json`，两条以后各改各的就会分岔。
   * @param id 源头计划 id
   * @param nameRaw 副本名字
   * @returns 副本的读数；源头不存在时为 null
   */
  duplicatePlan(id: string, nameRaw: string): SavedWorkflowPlanView | null {
    const source = this.store.getPlan(id);
    if (!source) return null;
    return this.savePlan(source.plan.nodes, nameRaw, source.saved.sourceRunId);
  }

  /**
   * 删一条自定义计划（spec 5.4-08 的删除；二次确认发生在界面，这里只管删）。
   *
   * 历史 run 不受影响：每一行各带自己的 `plan_json` 快照，删掉计划不会让它们变成"有计划、无进度"。
   * @param id 计划 id
   * @returns 真的删掉一行为 true；本来就没有为 false（界面按"列表已经刷新过"处理，不额外报错）
   */
  removePlan(id: string): boolean {
    const removed = this.store.deletePlan(id);
    // 没删掉东西就不广播：界面会为一次空操作白读一遍表（同 `renamePlan` 的 null 分支）。
    if (removed) this.ctx.emit('workflow/plans-changed', { action: 'remove', planId: id, at: Date.now() });
    return removed;
  }

  /**
   * 库里这次 run 的真相读数（spec 2.4-01/05/10 的界面出口）。
   * @returns 含逐节点尝试次数与证据路径；还没起过 run（只有初始镜像）时为 null
   */
  state(): WorkflowRunStateView | null {
    return this.store.state(this.run.runId);
  }

  /**
   * 库里最近一次可续的 run 的完整读数（spec 2.4-05 的界面入口）。
   *
   * 与 `state()` 不是一回事：那份读的是**内存里这次** run，进程刚重启时它在库里还没有行，
   * 于是 plan §11.3 第 6 条要求的「上次中断在第 i 个节点」永远显示不出来。这里读的是
   * `resumeRun()` 不带参数时将要挑中的同一条（同一个 `resumeCandidate` 判据），
   * 所以界面先显示的进度与点下去真正续上的进度必然一致——不会出现「显示第 2 个、续到第 1 个」。
   * @returns 可续 run 的落库状态；库里没有同指纹的中断/暂停/失败 run 时为 null（不是抛错）
   */
  resumable(): WorkflowRunStateView | null {
    const candidate = this.store.resumeCandidate(this.storedPlan().fingerprint);
    return candidate ? this.store.state(candidate.runId) : null;
  }

  /**
   * 「此刻生效的计划」以**库里那份**为准（内置那三条不在表里，取不到才沿用自己那份）。
   *
   * 为什么不能直接读 `this.plan`：5.10-f 裁定六之后，画布保存会在任何时刻重算 `plan_json` 与指纹，
   * 内存里那条因此只是可能陈旧的副本（AGENTS.md §9 的 2.5 实测条：本地镜像会静默变空/变旧）。
   * @returns 与 `this.plan.id` 对应、此刻库里读得到的计划本体
   */
  private storedPlan(): WorkflowPlanView {
    return this.store.getPlan(this.plan.id)?.plan ?? this.plan;
  }

  /**
   * 读回一个失败节点的证据（spec 2.8-04）：错误码与正文 + 现场截图，全部取自主进程自己写下的那份文件。
   *
   * 入参来自渲染层，按不可信输入处理（AGENTS.md §2.6）：**不拿这两个字符串拼路径**，
   * 而是先查库——只有 `workflow_nodes` 里确实登记过这条 (runId, nodeId) 且它的 `evidence_ref`
   * 与按配置算出来的文件名完全一致时才去读盘。于是「报一个别人的 runId」和
   * 「用 `../` 够到证据目录外面」两条路都在库里撞墙，而不是靠字符白名单侥幸。
   *
   * 正文不在这里二次脱敏：`writeEvidence` 落盘前整份过了 `redactValue`（spec 2.7-07 的唯一写盘点）。
   * @param runIdRaw 界面给的 run id（来自 `state()` / `resumable()` 的读数，不是用户输入）
   * @param nodeIdRaw 界面给的节点 id
   * @returns 证据读数；库里没有这条 run / 这个节点、或这一位根本没有证据时结构化失败而不是返回半份
   * @throws `INVALID_ARGUMENT`（id 不属于任何落库节点，或那次节点没有证据文件）
   */
  readEvidence(runIdRaw: string, nodeIdRaw: string): WorkflowEvidenceView {
    const stored = this.store.state(runIdRaw);
    const node = stored?.nodes.find((item) => item.nodeId === nodeIdRaw);
    if (!stored || !node) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `库里查不到这次 run 的这个节点（${runIdRaw} / ${nodeIdRaw}），拒绝读证据`,
        'workflow.runner',
        { runId: runIdRaw, nodeId: nodeIdRaw },
      );
    }
    const json = this.evidenceFile(stored.runId, node.nodeId, 'json');
    if (node.evidenceRef === null || node.evidenceRef !== json.relative) {
      throw new AppError(
        'INVALID_ARGUMENT',
        node.evidenceRef === null
          ? `节点 ${node.nodeId} 没有登记证据文件（这一步不是失败结算的），无证据可读`
          : `这个节点登记的证据不是这条路径（库里 ${node.evidenceRef}），拒绝读`,
        'workflow.runner',
        { runId: stored.runId, nodeId: node.nodeId, ref: node.evidenceRef },
      );
    }
    const evidence = this.readEvidenceFile(json.absolute);
    const screenshot = this.readEvidenceScreenshot(stored.runId, node.nodeId, evidence?.screenshot ?? null);
    return {
      runId: stored.runId,
      nodeId: node.nodeId,
      attempt: evidence?.attempt ?? node.attempts,
      at: evidence?.at ?? node.finishedAt ?? stored.startedAt,
      error: {
        code: evidence?.error.code ?? 'UNKNOWN',
        message: evidence?.error.message ?? node.error ?? '这次失败没有留下证据正文',
      },
      page: evidence?.page ?? null,
      screenshot,
      ref: json.relative,
    };
  }

  /**
   * 读并解析证据 JSON。
   * @param absolute 由 `evidenceFile` 算出的磁盘路径（不接受外部拼好的路径）
   * @returns 解析出来的证据本体；文件不存在或读不出/解析不了时 null（读数面自己决定怎么报错）
   */
  private readEvidenceFile(absolute: string): NodeEvidence | null {
    try {
      return JSON.parse(readFileSync(absolute, 'utf8')) as NodeEvidence;
    } catch {
      // 保留期清理之后再来点展开、或磁盘问题：这一格空着比编一份出来诚实。
      return null;
    }
  }

  /**
   * 读现场截图并转成 data URL（渲染层拿到的就是这个，`file:` 路径一律不给）。
   * @param runId 已核对过的 run id
   * @param nodeId 已核对过的节点 id
   * @param shot 证据本体里的截图位（写盘时没取到画面就是 null）
   * @returns 取到了给 `dataUrl` 那份，取不到给 `{ omitted }` 说明为什么没给
   */
  private readEvidenceScreenshot(
    runId: string,
    nodeId: string,
    shot: NodeEvidence['screenshot'],
  ): WorkflowEvidenceView['screenshot'] {
    if (!shot) return { omitted: 'missing' };
    const png = this.evidenceFile(runId, nodeId, 'png');
    try {
      const bytes = statSync(png.absolute).size;
      if (bytes > this.config.evidenceShotBytes) return { omitted: 'too-large' };
      const buffer = readFileSync(png.absolute);
      return {
        dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
        width: shot.width,
        height: shot.height,
        bytes,
      };
    } catch {
      return { omitted: 'unreadable' };
    }
  }

  /**
   * 起一个新的 run 并开始推进。
   * @param planIdRaw 挑中的计划 id（spec 5.4-03 的"面板可直接运行"）。省略时沿用**当前**计划，
   *                  所以 2.4 那条"点了开始就跑配置里那条"的路径一字不变；给了 id 就按不可信输入处理，
   *                  先换计划再起 run，换不了（未知 id）时内存态原样不动。
   * @returns 刚进入 `running` 的状态
   * @throws 上一个 run 还没走完时以 `WORKFLOW_INVALID_STATE` 失败（先暂停/重试，别并行两个 run）；
   *         计划 id 不在内置目录也不在 `workflow_plans` 时以 `INVALID_ARGUMENT` 失败并列出可用值；
   *         计划里有登记处不认识的 `kind` 时以 `INVALID_ARGUMENT` 失败（装配期就拒，不跑到一半才发现）
   */
  start(planIdRaw?: string): WorkflowRunView {
    if (this.run.status !== 'idle' && this.run.status !== 'done') {
      throw new AppError(
        'WORKFLOW_INVALID_STATE',
        `已有 run 处于 ${this.run.status} 态，先处理完它`,
        'workflow.runner',
        { status: this.run.status },
      );
    }
    // 切换计划放在状态闸门之后、起 run 之前：`resolvePlan` 失败时这里一行内存态都没动。
    if (planIdRaw !== undefined) this.selectPlan(this.resolvePlan(planIdRaw));
    this.requireExecutable(this.plan);
    this.applyRetention();
    this.claimedPositions.clear();
    this.confirmedPositions.clear();
    this.controller = new AbortController();
    this.run = createRun(
      randomUUID(),
      Date.now(),
      this.plan.nodes.map((node) => node.id),
    );
    this.store.openRun(this.run.runId, this.plan, this.run.startedAt);
    this.advanceState = initialAdvanceState(this.executionGraph());
    const started = this.apply({ type: 'start' }, null, `计划 ${this.plan.id} 开跑`);
    void this.pump();
    return started;
  }

  /**
   * 当前计划的**执行图**（plan §7.8.3 裁定 4）：画布存过图就用库里那份，否则由 `plan_json` 线性投影现算。
   *
   * 每次现问 `workflow.store`、不在 runner 里存第二份图（AGENTS.md §9 的 2.5 实测条：改配置重建下游时
   * 本地镜像会静默变空）。内置那三条不在表里，`getPlanGraph` 返回 null，走投影那一支。
   * 刻意**不**依赖 `workflow.graph` 服务：摘掉画布读写口不该让执行器跑不起来（裁定 4 的原话）。
   * @returns 与当前计划同一份节点集合的图读数
   */
  private executionGraph(): WorkflowGraphView {
    const stored = this.store.getPlanGraph(this.plan.id);
    return stored?.isCustom ? stored.graph : projectPlanToGraph(this.plan);
  }

  /**
   * 从库里那些行**重建**推进态（plan §7.8.3 裁定 3：续跑靠存下来的出口句柄，不靠猜）。
   *
   * 触发的场景是 5.10-13：分支节点 `done` 之后、两支都还没结算时被 kill，重启时库里只有「cond 完成了」，
   * 只有 `workflow_nodes.output_handle` 能回答"走的哪一支"。从下游行的状态反推在这条路径上恰好失效
   * （被选那支的目标当然不可能是 `skipped`，但它也可能只是"还没轮到"）。
   * @param stored 库里这次 run 的完整读数（含逐节点的 status 与 outputHandle）
   * @param graph 这次续跑要用的图（与 `stored` 同一条计划，由 `resumeRun` 的指纹闸门保证）
   * @returns 与中断之前同一份推进状态：已结算的格子带着当初的出口，未走的支已被级联判成 `skipped`
   * @throws `INVALID_ARGUMENT` 分支节点完成了却没登记走过的出口——猜一个出口会把半张图跑成另一张图，
   *         项目立的规矩是不猜，所以结构化拒绝而不是继续；节点不在这张图里由 `advanceGraph` 自己报
   */
  private rebuildAdvanceState(stored: WorkflowRunStateView, graph: WorkflowGraphView): GraphAdvanceView {
    const declaredOutputs = new Map(graph.nodes.map((node) => [node.id, node.outputs ?? [WORKFLOW_DEFAULT_OUTPUT]]));
    let state = initialAdvanceState(graph);
    for (const node of stored.nodes) {
      if (node.status === 'done') {
        const outputs = declaredOutputs.get(node.nodeId) ?? [WORKFLOW_DEFAULT_OUTPUT];
        const isBranch = outputs.length > 1 || outputs[0] !== WORKFLOW_DEFAULT_OUTPUT;
        if (isBranch && node.outputHandle === null) {
          throw new AppError(
            'INVALID_ARGUMENT',
            `节点 ${node.nodeId} 已完成，但库里没有它走过的出口，无法判断该续哪一支，已拒绝按旧进度续跑`,
            'workflow.runner',
            { runId: stored.runId, nodeId: node.nodeId, declared: outputs },
          );
        }
        state = advanceGraph(state, graph, {
          nodeId: node.nodeId,
          status: 'done',
          ...(node.outputHandle === null ? {} : { output: node.outputHandle }),
        });
      } else if (node.status === 'skipped') {
        state = advanceGraph(state, graph, { nodeId: node.nodeId, status: 'skipped' });
      }
    }
    return state;
  }

  /**
   * 当前计划的**唯一**写点：挂载期取配置值，`start(planId)` 时换成挑中的那条（5.4 起它可变，但不持久化）。
   * @param plan 收窄过、指纹已重算的计划本体
   * @returns 同一个计划——写成表达式是为了让构造器里那一次是 TS 认得的直接赋值
   * （`strictPropertyInitialization` 不追方法调用，只写 `this.selectPlan(...)` 会报「未初始化」）
   */
  private selectPlan(plan: WorkflowPlanView): WorkflowPlanView {
    this.plan = plan;
    return plan;
  }

  /**
   * 按 id 解析一条计划：先内置目录，再 `workflow_plans`。
   *
   * 顺序是刻意的——内置 id 是稳定标识（`boss-basic`），自定义 id 带 `plan-` 前缀（见 `newPlanId`），
   * 两者形状上不撞；先查表的话，用户存的一条坏计划就能盖掉一条演示主线。
   * @param id 界面或配置给的值，按不可信输入处理
   * @returns 补全默认值并算好指纹的计划视图
   * @throws 两处都查不到时 `INVALID_ARGUMENT`，并列出当前所有可用 id（含自定义那几条）
   */
  private resolvePlan(id: string): WorkflowPlanView {
    if (id in WORKFLOW_PLANS) return planById(id);
    const saved = this.store.getPlan(id);
    if (saved) return saved.plan;
    throw new AppError(
      'INVALID_ARGUMENT',
      `未知的工作流计划 ${id}，可选：${this.plans()
        .map((option) => option.id)
        .join('、')}`,
      'workflow.runner',
      { planId: id, available: this.plans().map((option) => option.id) },
    );
  }

  /**
   * 请求暂停：把当前步退回 `pending` 并发出取消信号，**等它自己让出**（spec 2.4-07）。
   * @param message 暂停原因（spec 1.8-07 的会话失效走这里带原因）；null = 用户点了暂停按钮，无需播报
   * @returns 进入 `paused` 的状态
   * @throws 不在运行中时结构化失败
   */
  pause(message: string | null = null): WorkflowRunView {
    return this.stop(null, message);
  }

  /**
   * 从当前步续跑**本次内存里的这次 run**（不重置已完成步，spec 1.10-05）。
   *
   * 与 `resumeRun(runId)` 不是一回事：这里续的是「刚刚按了暂停的那一次」，库里根本没有中断需要读回；
   * 后者续的是「上一次进程死亡留下的 run」，要先读库再校验指纹。混淆这两者是 plan §11.3 第 3 条点名的坑。
   * @returns 重新进入 `running` 的状态
   * @throws 不在暂停中时结构化失败
   */
  resume(): WorkflowRunView {
    const resumed = this.apply({ type: 'resume' }, null, '从当前步续跑');
    // 旧句柄已经 abort 过，复用它会让新的一步刚起步就被判成「已让出」。
    this.controller = new AbortController();
    void this.pump();
    return resumed;
  }

  /**
   * 中止本次 run（spec 2.8-03）：停下来，并把库里这一行判成 `interrupted` + `USER_ABORT`。
   *
   * 刻意**不给状态机加新终态、也不给界面加第六个状态**（plan §15.1 决策 2）：中止与「进程被 kill」
   * 要的是同一条语义——都停在可恢复点上、都能被 `resumeRun()` 按原下标续上。既有不变量
   * （`interrupted` 读回成 `paused` + 接管位，见 `toMirror`）因此直接复用，中止只是「用户自己按的 interrupted」。
   *
   * 也不写接管标记：`manual-takeover` 那个原因按定义是「节点自己声明的接管点」（验证码一类），
   * 中止不是被拦下来的，挂上它就会让界面说一句不对的话。中止的原因走库里的 `lastError`（机器码，界面按码组句）。
   * @returns 停在可恢复点上的 `paused` 镜像
   * @throws 没有在跑也没有停着的 run（`idle` / `done`）时 `WORKFLOW_INVALID_STATE`
   */
  abort(): WorkflowRunView {
    if (this.run.status === 'running') {
      // 走与暂停同一条路：当前步退回 pending、发出取消信号，等它自己让出（spec 2.4-07）。
      this.stop(null, '已中止');
    } else if (this.run.status !== 'paused') {
      throw new AppError('WORKFLOW_INVALID_STATE', `没有可中止的 run，当前是 ${this.run.status}`, 'workflow.runner', {
        status: this.run.status,
      });
    }
    this.store.updateRun(this.run.runId, {
      status: 'interrupted',
      nodeIndex: this.run.stepIndex,
      finishedAt: Date.now(),
      lastError: 'USER_ABORT',
    });
    return this.run;
  }

  /**
   * 单独重试某一个节点（spec 1.10-06 / 2.4-03）。
   *
   * 两种「停住」都要能从这里出去，否则用户在界面上只剩重新开跑一条路：
   * 失败态走 `retry-step`；挂着接管标记的暂停态走 `resume`，并且当接管原因是「外发未观察完成」时
   * 顺便登记一次确认，让幂等闸门放行这一回（见 `confirmedPositions`）。
   * @param stepIdRaw 步骤 id，来自渲染层——按当前计划的节点 id 校验，不认就结构化失败
   * @returns 重新进入 `running`、`stepIndex` 指回该步的状态
   * @throws 步 id 不属于当前计划，或这一步既没失败也没挂接管点时 `WORKFLOW_INVALID_STATE`
   */
  retryStep(stepIdRaw: string): WorkflowRunView {
    const spec = this.plan.nodes.find((node) => node.id === stepIdRaw);
    if (!spec) {
      throw new AppError('WORKFLOW_INVALID_STATE', `当前计划里没有步骤 ${stepIdRaw}`, 'workflow.runner', {
        stepId: stepIdRaw,
        planId: this.plan.id,
      });
    }
    const refusal = this.run.requiresHuman;
    if (this.run.status === 'paused' && refusal?.stepId === spec.id) {
      // 接管点上的这一次点击就是「我知道了，继续」：登录态一类的暂停直接续跑即可，
      // 而「外发未观察完成」必须留下一次确认，闸门据此把「拒绝」换成「一次带日志的重放」
      // （plan §11.3 第 5 条）。
      if (refusal.reason === 'unobserved-side-effect') {
        this.confirmedPositions.add(this.positionKey(this.run.runId, this.run.stepIndex));
      }
      const confirmed = this.apply({ type: 'resume' }, null, `从接管点继续 ${spec.id}`);
      this.controller = new AbortController();
      void this.pump();
      return confirmed;
    }
    const retried = this.apply({ type: 'retry-step', stepId: spec.id }, null, `重试 ${spec.id}`);
    this.controller = new AbortController();
    void this.pump();
    return retried;
  }

  /**
   * 从库里续上**上一次进程留下的** run（spec 2.4-05）。
   *
   * 校验顺序是刻意的：先读库（读库自身会比对指纹，计划被改过就直接拒绝），再把落库读数重建成镜像，
   * 最后才走 `resume()` 推进。中间任何一步失败都不动内存态，于是「续不上」的表现是原样停住而不是跑一半。
   * @param runIdRaw 要续的那次 run；省略时按当前计划的指纹取**最近一次**未完成的（界面不需要记住 id）。
   *                   给了 id 就按不可信输入处理，库里没有就拒绝
   * @returns 重新进入 `running`（或停在接管点上的 `paused`）的状态
   * @throws 库里没有可续的 run、或计划指纹与当前配置不是同一条时 `INVALID_ARGUMENT`（2.4-05 的串档判据）
   *
   * 5.4 之后要多留意一句：**续自定义计划的 run，得先把当前计划换成那条**（面板的下拉，5.4-b 的入口）。
   * 这里没有改成"按 run 自己的快照续"，因为 2.4-05 已验收的判据字面就是"配置的计划与 run 不一致时拒绝续"，
   * 放开它就是把一条已验收的安全网悄悄拆掉。
   *
   * 5.10-f 裁定六之后「当前计划」这一维必须以**库里现在那份**为准（见下面 `current` 那一步）：
   * 画布保存会在任何时刻重算 `plan_json` 与指纹，内存里的那条从此只是可能陈旧的副本，
   * 而 5.10-07 要的「改过图之后旧 run 不可续跑」在同进程里就必须判得出来。
   */
  resumeRun(runIdRaw?: string): WorkflowRunView {
    // 现查库、不拿内存镜像比（§2.7：同一件事只留一份事实）。
    const current = this.storedPlan();
    const candidate = runIdRaw === undefined ? this.store.resumeCandidate(current.fingerprint) : null;
    const runId = runIdRaw ?? candidate?.runId;
    if (!runId) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `库里没有按当前计划（${current.fingerprint}）可续的 run`,
        'workflow.runner',
        { planId: current.id },
      );
    }
    const stored = this.store.state(runId);
    if (!stored) {
      throw new AppError('INVALID_ARGUMENT', `库里没有这次 run：${runId}`, 'workflow.runner', { runId });
    }
    if (stored.planFingerprint !== current.fingerprint) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `这次 run 的计划与当前配置的不是同一条（库里 ${stored.planFingerprint}，当前 ${current.fingerprint}），拒绝按原进度续跑`,
        'workflow.runner',
        { runId, stored: stored.planFingerprint, current: this.plan.fingerprint },
      );
    }
    if (stored.status === 'done') {
      this.run = toMirror(stored);
      this.pushProgress(null, null, '这次 run 已经跑完，无需续跑');
      return this.run;
    }
    this.claimedPositions.clear();
    this.confirmedPositions.clear();
    this.run = toMirror(stored);
    // 中断/失败/暂停的 run 都从 `paused` 起步走同一条续跑口：接管标记在这里清掉，
    // 因为用户点「从失败节点续跑」本身就是「我知道发生了什么，继续」。
    this.run = { ...this.run, status: 'paused', requiresHuman: null };
    // 推进态必须在起循环之前重建：没有它，runner 不知道哪些格子属于「没走的那一支」。
    this.advanceState = this.rebuildAdvanceState(stored, this.executionGraph());
    return this.resume();
  }

  [Service.init](): void {
    // 卸载时必须让出在跑的循环，否则 `plugins.stop('workflow')` 之后定时器链还在推进一个没人看的 run。
    this.ctx.effect(() => () => this.controller?.abort());
    // 会话失效是 `sessions` 探测出来的，runner 只在运行中接它：不在运行中就没有可停的地方。
    const offSessionExpired = this.ctx.on('session/expired', (event) => this.handleSessionExpired(event));
    this.ctx.effect(() => offSessionExpired, 'workflow.session-expired');
    // 风控信号与登录态失效同一条处置：运行中才停，停的方式是同一个 `stop()`（spec 2.7-01）。
    const offRiskSignal = this.ctx.on('browser/risk-signal', (event) => this.handleRiskSignal(event));
    this.ctx.effect(() => offRiskSignal, 'workflow.risk-signal');

    // 开机第一件事是把上次进程死亡留下的孤儿 run 判成中断（plan §11.3 第 6 条）：
    // 晚一步，界面上第一次读数就会显示「仍在运行」，而那个「运行中」属于一个已经不存在的进程。
    const interrupted = this.store.markInterrupted(Date.now());
    // 改配置会重建实例：不推这一句的话界面上会继续挂着上一个已被销毁的 run（实测过）。
    this.pushProgress(null, null, null);
    this.ctx.logger.info(
      `工作流执行器就绪：计划 ${this.plan.id}（${String(this.plan.nodes.length)} 个节点，指纹 ${this.plan.fingerprint}）` +
        (interrupted.length > 0 ? `，本次启动把 ${String(interrupted.length)} 次旧 run 判为中断` : ''),
    );

    // `workflow.run`（spec 5.10-18 / plan 裁定五）：agent 与面板跑的是**同一个** `workflow.runner`，
    // 这只工具只是它的第三个入口——里面不含任何推进逻辑，只把「按那条计划起一次 run 并等到停下」包成一次调用。
    // 定级取 `outbound` 是因为一只通用运行器的副作用取决于图里有什么，而声明期必须定级（F33），
    // 取最保守的那一侧；确认由 `requiresConfirmation` 兜住，节点级的三闸门仍在 runner 里逐个判。
    // 登记方排在 `agent` 之后才拿得到注册表（AGENTS.md §9 的 5.1-c 那条），`workflow` 在清单里正排在后面。
    const tools = registerAgentTools(this.ctx, [
      agentTool({
        id: 'workflow.run',
        titleKey: 'agent.tool.labels.workflowRun',
        description: '按库里那条计划起一次工作流运行并等到它停下，外发节点仍逐个过闸门与人工接管',
        input: workflowRunInputSchema,
        effect: 'outbound',
        requiresConfirmation: true,
        run: async ({ planId }, signal) => {
          const started = this.start(planId);
          const settled = await this.waitForSettled(started.runId, signal);
          const unsettled = settled.steps.filter(
            (step) => step.status === 'pending' || step.status === 'running',
          ).length;
          return toolResult(
            {
              runId: settled.runId,
              status: settled.status,
              steps: settled.steps.map((step) => ({ id: step.id, status: step.status })),
            },
            {
              summary:
                `计划 ${planId} 的这次 run 停在 ${settled.status}（${String(settled.steps.length)} 格` +
                (settled.status === 'done' ? '）' : `，还有 ${String(unsettled)} 格未结算）`),
              evidenceRefs: [`run:${settled.runId}`, `plan:${planId}`],
            },
          );
        },
      }),
    ]);
    if (tools === 0) {
      this.ctx.logger.info('agent 工具注册表未挂载：workflow.run 本轮不登记（面板入口照常）');
    }
  }

  /**
   * 等到这次 run 停下（`done` / `failed` / `paused`）——`workflow.run` 的等待腿（spec 5.10-18）。
   * @param runId 由 `start()` 当场返回的 run id，不接受外部输入
   * @param signal 取消信号；让出的方式是**停在可恢复点**（`abort()`），与用户在界面按暂停同一条路，
   *        于是"取消一次工具调用"不会变成"这一件事从没发生过"，续跑与幂等闸门照旧成立
   * @returns 停下那一刻的运行镜像（读的是 `current()`，与界面/事件同一份内存事实，不另取一份）
   */
  private waitForSettled(runId: string, signal?: AbortSignal): Promise<WorkflowRunView> {
    const isSettled = (view: WorkflowRunView): boolean =>
      view.runId === runId && (view.status === 'done' || view.status === 'failed' || view.status === 'paused');
    const already = this.current();
    if (isSettled(already)) return Promise.resolve(already);
    return new Promise<WorkflowRunView>((resolve) => {
      const finish = (view: WorkflowRunView): void => {
        off();
        signal?.removeEventListener('abort', onAbort);
        resolve(view);
      };
      const off = this.ctx.on('workflow/progress', (event) => {
        if (isSettled(event.run)) finish(event.run);
      });
      const onAbort = (): void => {
        finish(this.abort());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** `workflow.store` 句柄。 */
  private get store(): WorkflowRunStoreService {
    return asApp(this.ctx)['workflow.store'];
  }

  /** `workflow.executors` 登记处。 */
  private get registry(): WorkflowExecutorRegistryService {
    return asApp(this.ctx)['workflow.executors'];
  }

  /** userData 目录（与库文件同根，证据因此和 run 行在一起）。 */
  private get userDataDir(): string {
    return asApp(this.ctx).config.paths().userDataDir;
  }

  /**
   * 停在可恢复点并写出接管点（`pause` 与人工接管共用的那条路）。
   * @param takeover 接管点数据；null = 普通暂停（用户自己按了暂停）
   * @param message 日志与进度行用的一句话说明
   * @returns 进入 `paused` 的状态
   */
  private stop(takeover: WorkflowTakeoverView | null, message: string | null): WorkflowRunView {
    const paused = this.apply({ type: 'pause', takeover }, null, message);
    this.controller?.abort();
    return paused;
  }

  /**
   * 登录态失效时停在可恢复点并**留下结构化接管点**（spec 1.8-07 / 2.1-08）：
   * 不能让它继续往外发一个必然失败的请求，也不能静默停在半路——用户必须看见「卡在哪一步、为什么」。
   *
   * 只把「平台 / 原因 / 停在第几步」作为数据推过去，句子由渲染层按当前语言组（AGENTS.md §5.5 / §5.7）。
   * @param event `sessions` 推的失效事件（只有平台名与判定原因，无 cookie）
   */
  private handleSessionExpired(event: SessionExpiredEvent): void {
    if (this.run.status !== 'running') return;
    const currentStep = this.run.steps[this.run.stepIndex];
    if (!currentStep) return;
    this.ctx.logger.warn(`${event.platform} 登录态失效（${event.reason}），已停在 ${currentStep.id}，等待用户接管`);
    // 播报位留 null：这一句由渲染层按 `requiresHuman` 组织（2.1-08 定下的口径），主进程不参与组句。
    this.stop({ subject: event.platform, reason: event.reason, stepId: currentStep.id, at: event.at }, null);
  }

  /**
   * 撞上网页自己的风控拦截时停在可恢复点并**留下结构化接管点**（spec 2.7-01）。
   *
   * 与 `handleSessionExpired` 走的是同一条 `stop()`：停下来的方式只有一种，区别只在界面按 `reason`
   * 说的这句话——登录失效要重新扫码，风控拦停下来是「等一等、人来点」，两者不能混成一个文案。
   * @param event `browser.risk` 推的信号（平台 / 判据类别 / 命中的那句原文 / 地址）
   */
  private handleRiskSignal(event: RiskSignalEvent): void {
    if (this.run.status !== 'running') return;
    const currentStep = this.run.steps[this.run.stepIndex];
    if (!currentStep) return;
    this.ctx.logger.warn(
      `${event.platform} 触发风控信号（${event.kind}：${event.detail}），已停在 ${currentStep.id}，等待用户接管`,
    );
    this.stop({ subject: event.platform, reason: 'risk-control', stepId: currentStep.id, at: event.at }, null);
  }

  /**
   * 把当前 run 推给渲染层（spec 2.4-02 的 `node.started/finished/failed` 就落在这条频道上）。
   * @param stepId 本条播报涉及的节点；run 级迁移时为 null
   * @param phase 节点迁移相位；run 级迁移时为 null
   * @param message 一句话说明（界面自己按 `phase` 组织文案，这条只用于日志与旧面板）
   */
  private pushProgress(stepId: WorkflowStepId | null, phase: WorkflowNodePhase | null, message: string | null): void {
    this.ctx.emit('workflow/progress', { run: this.run, stepId, phase, message });
  }

  /**
   * 跑一次迁移并推送进度。
   * @param event 迁移事件
   * @param phase 本条播报的相位（纯状态迁移为 null）
   * @param message 一句话说明（null 表示不播报）
   * @returns 迁移后的状态
   * @throws 非法迁移以 `WORKFLOW_INVALID_STATE` 失败，不抛裸异常（spec 1.10-09）
   */
  private apply(event: RunnerEvent, phase: WorkflowNodePhase | null, message: string | null): WorkflowRunView {
    const run = this.run;
    const result = transition(run, event);
    if (!result.ok) {
      throw new AppError('WORKFLOW_INVALID_STATE', result.reason, 'workflow.runner', {
        status: run.status,
        event: event.type,
      });
    }
    this.run = result.run;
    const stepId = 'stepId' in event ? event.stepId : null;
    this.pushProgress(stepId, phase, message);
    return this.run;
  }

  /**
   * 推进循环的守护壳：把任何意外收成一次**可见的**失败。
   *
   * 调用点是 `void this.pump()`（界面不该等工作流跑完才返回），所以异常裸抛只会变成一个无人认领的
   * rejection——那时库里的 run 还写着 `running`、界面还挂着进度条，而推进早就停了。
   * 这正是本项目点名要修的「骗人的读数」，因此宁可多这一步收口。
   */
  private async pump(): Promise<void> {
    try {
      await this.advance();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ctx.logger.error(`工作流推进中断：${message}`);
      if (this.run.status !== 'running') return;
      this.store.updateRun(this.run.runId, {
        status: 'failed',
        nodeIndex: this.run.stepIndex,
        finishedAt: null,
        lastError: message,
      });
      this.apply({ type: 'run-failed', error: message, at: Date.now() }, 'failed', `推进中断：${message}`);
    }
  }

  /**
   * 推进循环：按**拓扑序**（= `plan_json` 的节点顺序，5.10-f 裁定六把它投影成拓扑序）依次跑，直到 run 不再是 `running`。
   *
   * 5.10-f 起的形状是「游标照旧 +1，但每一格先问图」：拓扑序保证游标走到任何一格时它的全部上游都已结算，
   * 于是 `machine.ts` 那条只会 +1 的游标仍然合法（裁定 1，`machine.ts` 一字未动）；
   * 而「这一支没走」不靠顺序排除，靠 `advanceGraph` 把它级联结算成 `skipped`（spec 5.10-08）。
   * 每一步都重新读 `this.run`，因为暂停/重试可能在两次推进之间改走状态；
   * `await` 之后必须先确认「这次让出是谁引起的」，否则会把 paused 覆盖成 done。
   */
  private async advance(): Promise<void> {
    const graph = this.executionGraph();
    for (;;) {
      const run = this.run;
      if (run.status !== 'running') return;
      const index = run.stepIndex;
      const step = run.steps[index];
      const spec = this.plan.nodes[index];
      if (!step || !spec) return;

      if (this.advanceState.outcomes[spec.id]?.status === 'skipped') {
        // 上游那一次分支没选这一支：执行器一次都不许调，落一行 `skipped` 并把「没走」推给界面。
        this.store.markNodeSkipped(run.runId, index, spec, Date.now());
        this.apply({ type: 'step-skipped', stepId: spec.id, at: Date.now(), reason: 'branch-not-taken' }, null, null);
        continue;
      }

      const claim = this.enterNode(run.runId, index, spec);
      if (claim === 'already-done') {
        // 这个位置在库里已经有了结局：一次都不许调执行器（spec 2.4-05/06 的「不重放」）。
        this.apply({ type: 'step-skipped', stepId: spec.id, at: Date.now() }, null, `${spec.id} 已完成，跳过`);
        continue;
      }
      if (claim === 'needs-human') {
        this.stop(
          { subject: spec.kind, reason: 'unobserved-side-effect', stepId: spec.id, at: Date.now() },
          `${spec.id} 上次外发未观察到完成，拒绝自动重放`,
        );
        return;
      }

      const executor = this.registry.resolve(spec.kind);
      if (!executor) {
        // `start()` 已经整条计划校验过一次，走到这里只能是登记处在跑动中被卸载了。
        await this.failNode(
          run.runId,
          index,
          spec,
          1,
          new AppError('INVALID_ARGUMENT', `执行器 ${spec.kind} 已不在登记处`, 'workflow.runner', {
            kind: spec.kind,
          }),
          null,
        );
        return;
      }
      const settled = await this.runNode(run.runId, index, spec, executor, graph);
      if (!settled) return;
    }
  }

  /**
   * 声明「这个节点现在开始」，并按需把库里的行推进一次。
   * @param runId 本次 run
   * @param index 节点下标
   * @param spec 节点声明
   * @returns `granted` / `already-done` / `needs-human`
   */
  private enterNode(runId: string, index: number, spec: WorkflowNodeSpec): 'granted' | 'already-done' | 'needs-human' {
    const key = this.positionKey(runId, index);
    if (this.confirmedPositions.delete(key)) {
      // 一次确认只放行一次：闸门仍然要写这笔重放（并留下日志），否则「拒绝盲重放」就成了空话。
      return this.store.claimNode(runId, index, spec, Date.now(), true);
    }
    if (this.claimedPositions.has(key)) {
      // 同进程内的重试：幂等闸门已经在第一次声明时开过了，这里只把尝试次数推进一格。
      const state = this.store.state(runId);
      const attempts = (state?.nodes[index]?.attempts ?? 1) + 1;
      this.store.recordNode(runId, index, {
        status: 'running',
        attempts,
        startedAt: state?.nodes[index]?.startedAt ?? Date.now(),
        finishedAt: null,
        durationMs: null,
        error: null,
        evidenceRef: null,
        sideEffect: state?.nodes[index]?.sideEffect ?? (spec.effect === 'read' ? null : 'started'),
      });
      return 'granted';
    }
    const claim = this.store.claimNode(runId, index, spec, Date.now());
    if (claim === 'granted') this.claimedPositions.add(key);
    return claim;
  }

  /**
   * 跑一个节点的全部尝试（含退避重试）。
   * @param runId 本次 run
   * @param index 节点下标
   * @param spec 节点声明
   * @param executor 登记处取到的执行函数
   * @param graph 本次 run 的执行图（成功结算要按它查边）
   * @returns true 表示这个位置已经有了结局（成功或被判失败），循环该往下走；
   *          false 表示被暂停/接管打断，循环必须就地停下
   */
  private async runNode(
    runId: string,
    index: number,
    spec: WorkflowNodeSpec,
    executor: WorkflowNodeExecutor,
    graph: WorkflowGraphView,
  ): Promise<boolean> {
    const budget = retryBudgetFor(spec, this.config.retryTimes);
    const maxAttempts = budget.attempts;
    if (budget.clampedAway > 0) {
      // 外发步写了 retryTimes 也要压到一次，并且**说出来**：静默压掉会让人以为计划里那行生效了。
      this.ctx.logger.warn(
        `节点 ${spec.id} 是外发步，声明的 ${String(budget.clampedAway)} 次额外重试不生效（spec 5.7-04）`,
      );
    }
    // 库里那一列记的是**跨进程**的总尝试次数（2.4-03/10 的读数），循环计数是本进程这一次尝试序列：
    // 被 kill 过一次之后库里已经有 1 次，本进程的第 1 次其实是这个位置的第 2 次。
    const alreadyAttempted = this.store.state(runId)?.nodes[index]?.attempts ?? 1;
    const startedAt = Date.now();
    for (let attempt = 1; ; attempt += 1) {
      const totalAttempts = alreadyAttempted - 1 + attempt;
      const controller = this.controller;
      this.apply(
        { type: 'step-started', stepId: spec.id, at: attempt === 1 ? startedAt : Date.now() },
        'started',
        attempt === 1 ? `开始 ${spec.id}` : `第 ${String(totalAttempts)} 次尝试 ${spec.id}`,
      );
      // 执行器可以宣告它走掉的出口句柄（分支算子），省略即 `default`（裁定 3）。
      let takenOutput: string | undefined;
      try {
        const outcome = await executor({
          runId,
          spec,
          attempt: totalAttempts,
          signal: controller?.signal ?? new AbortController().signal,
        });
        takenOutput = typeof outcome === 'object' && outcome !== null ? outcome.output : undefined;
      } catch (error) {
        // 让出是暂停/卸载引起的：不是节点的失败，状态已经由引起它的那一方写好了，原样停下。
        if (controller?.signal.aborted || this.run.status !== 'running') return false;
        if (spec.requiresHuman) {
          this.stop(
            { subject: spec.kind, reason: 'manual-takeover', stepId: spec.id, at: Date.now() },
            `${spec.id} 是人工接管点，停下等用户`,
          );
          return false;
        }
        if (attempt < maxAttempts) {
          const wait = this.backoffMs(attempt);
          this.pushProgress(
            spec.id,
            'retrying',
            `${spec.id} 第 ${String(totalAttempts)} 次失败，${String(wait)}ms 后重试`,
          );
          // 退避睡在同一个取消信号上：暂停因此能立刻打断等待，而不是等满退避再让出（spec 2.4-09）。
          await sleep(wait, this.controller?.signal);
          if (this.controller?.signal.aborted || this.run.status !== 'running') return false;
          continue;
        }
        await this.failNode(runId, index, spec, totalAttempts, error, startedAt);
        return true;
      }
      // 正常返回也要先确认这次让出是谁引起的：协作式取消里「收到 abort 就 resolve 收手」是合法写法
      // （`sleep(ms, signal)` 就是这么设计的），此时这一步并没有做完。
      // 把它记成成功会连着两个坏结果——库里留下一行假 `done`（续跑因此永远不重放它），
      // 而 `apply(step-finished)` 在 paused 态是非法迁移，会把异常抛进这条无人 await 的循环。
      if (controller?.signal.aborted || this.run.status !== 'running') return false;
      this.succeedNode(runId, index, spec, totalAttempts, startedAt, takenOutput, graph);
      return true;
    }
  }

  /**
   * 写成功结局：落库（含走过的出口句柄）→ 按图推进 → 状态机推进一格。
   * @param runId 本次 run
   * @param index 节点下标
   * @param spec 节点声明
   * @param attempts 这个位置总共用掉的尝试次数（含首次、含其它进程用掉的）
   * @param startedAt 本节点首次开始的时间戳（毫秒）
   * @param output 执行器宣告走过的出口句柄；省略即 `default`（裁定 3）
   * @param graph 本次 run 的执行图
   */
  private succeedNode(
    runId: string,
    index: number,
    spec: WorkflowNodeSpec,
    attempts: number,
    startedAt: number,
    output: string | undefined,
    graph: WorkflowGraphView,
  ): void {
    const at = Date.now();
    // 先推图再落库：`advanceGraph` 会校验「这个出口真是该节点声明过的」，声明里没有就结构化失败，
    // 库里因此不会留下一行「done 但没人知道走的哪一支」的读数（5.10-13 续跑读的就是这一行）。
    const next = advanceGraph(this.advanceState, graph, {
      nodeId: spec.id,
      status: 'done',
      ...(output ? { output } : {}),
    });
    this.advanceState = next;
    this.store.recordNode(runId, index, {
      status: 'done',
      attempts,
      startedAt,
      finishedAt: at,
      durationMs: at - startedAt,
      error: null,
      evidenceRef: null,
      // 只有真的会动外面世界的节点才需要把副作用位收成 done（spec 2.4-06 的判据）。
      sideEffect: spec.effect === 'read' ? null : 'done',
      output: output ?? null,
    });
    // done 的判据从「下标+1 到底了」换成「图上全部格子都结算了」（裁定 2 里那一步的替代物）：
    // 分支图里游标走到最后一格时，未走那一支早已级联成 skipped，两者此刻是同一个结论。
    this.store.updateRun(runId, {
      status: next.finished ? 'done' : 'running',
      nodeIndex: index + 1,
      finishedAt: next.finished ? at : null,
      lastError: null,
    });
    this.apply({ type: 'step-finished', stepId: spec.id, at }, 'finished', `${spec.id} 完成`);
  }

  /**
   * 写失败结局：证据落盘 → 落库 → 状态机判失败。
   * @param runId 本次 run
   * @param index 节点下标
   * @param spec 节点声明
   * @param attempt 判失败时这个位置总共用掉的次数（含其它进程用掉的）
   * @param error 最后一次抛出的错误
   * @param startedAt 本节点首次开始的时间戳（毫秒）；单点失败注入时可为 null
   */
  private async failNode(
    runId: string,
    index: number,
    spec: WorkflowNodeSpec,
    attempt: number,
    error: unknown,
    startedAt: number | null,
  ): Promise<void> {
    const at = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    const evidenceRef = await this.writeEvidence(runId, index, spec, attempt, at, error);
    this.store.recordNode(runId, index, {
      status: 'failed',
      attempts: attempt,
      startedAt: startedAt ?? at,
      finishedAt: at,
      durationMs: startedAt === null ? null : at - startedAt,
      error: message,
      evidenceRef,
      // 失败的外发**保持 started**：这正是「重启后不许自动重放」要读到的那个位（spec 2.4-06）。
      sideEffect: spec.effect === 'read' ? null : 'started',
    });
    this.store.updateRun(runId, { status: 'failed', nodeIndex: index, finishedAt: null, lastError: message });
    this.apply({ type: 'step-failed', stepId: spec.id, at, error: message }, 'failed', `${spec.id} 失败`);
  }

  /**
   * 第 `attempt` 次失败之后的退避时长。
   * @param attempt 刚刚失败的那一次（从 1 起）
   * @returns 毫秒数：`retryBackoffMs × 2^(attempt-1)`，封顶 `retryBackoffCapMs`（spec 2.4-03，plan §11.4）
   */
  private backoffMs(attempt: number): number {
    return Math.min(this.config.retryBackoffMs * 2 ** (attempt - 1), this.config.retryBackoffCapMs);
  }

  /**
   * 失败证据落盘（spec 2.4-04）。
   *
   * 写在 run 行旁边（userData 下的 `evidenceDir`）而不是写进库里一个 BLOB：截图是给人翻文件看的，
   * 而库里只留**相对路径**（`workflow_nodes.evidence_ref`），于是「库能被拷走看」这件事没坏。
   *
   * 落盘前整份过一遍 `redactValue`（spec 2.7-07）：证据里除了截断过的正文，还有 `error.details`
   * 这一位——它是执行器原样塞进来的对象（可能含页面 URL、选择器、甚至抓取到的字段值），
   * 逐字段包不如在唯一的写盘点上统一掩码。文本字段另外在 `cap` 里先脱敏后截断，两处共用同一份判据。
   * @param runId 本次 run
   * @param index 节点下标（只用于日志）
   * @param spec 节点声明
   * @param attempt 判失败时的尝试次数
   * @param at 判定时间戳（毫秒）
   * @param error 最后一次错误
   * @returns userData 下的**相对路径**（如 `evidence/<runId>-<nodeId>.json`）；磁盘写不下时 null 并记一笔 warn
   */
  private async writeEvidence(
    runId: string,
    index: number,
    spec: WorkflowNodeSpec,
    attempt: number,
    at: number,
    error: unknown,
  ): Promise<string | null> {
    const code = error instanceof AppError ? error.code : error instanceof Error ? error.name : 'UNKNOWN';
    const details = error instanceof AppError ? error.details : undefined;
    const json = this.evidenceFile(runId, spec.id, 'json');
    try {
      mkdirSync(join(this.userDataDir, this.config.evidenceDir), { recursive: true });
      const evidence: NodeEvidence = {
        runId,
        nodeId: spec.id,
        kind: spec.kind,
        effect: spec.effect,
        target: spec.target,
        attempt,
        at,
        error: { code, message: this.cap(error instanceof Error ? error.message : String(error)), details },
        page: await this.readPage(),
        screenshot: await this.writeScreenshot(runId, spec.id),
      };
      writeFileSync(json.absolute, `${JSON.stringify(redactValue(evidence), null, 2)}\n`, 'utf8');
      return json.relative;
    } catch (error_) {
      // 证据丢了不能把整条 run 判成别的结局：落库的失败读数比一份附件重要。
      this.ctx.logger.warn(
        `第 ${String(index)} 个节点的证据写盘失败：${error_ instanceof Error ? error_.message : String(error_)}`,
      );
      return null;
    }
  }

  /**
   * 拼一份证据文件的落点（两种证据共用，AGENTS.md §2.2）。
   * @param runId 本次 run
   * @param nodeId 节点 id
   * @param ext 扩展名，不含点：`json` 是证据本体，`png` 是现场截图
   * @returns `relative` 写进库与证据正文（userData 相对、正斜杠），`absolute` 是要真写的磁盘路径
   */
  private evidenceFile(runId: string, nodeId: string, ext: 'json' | 'png'): { relative: string; absolute: string } {
    const name = `${runId}-${nodeId}.${ext}`;
    return {
      relative: join(this.config.evidenceDir, name).split(/[\\/]/).join('/'),
      absolute: join(this.userDataDir, this.config.evidenceDir, name),
    };
  }

  /**
   * 抓一帧失败现场并写成 PNG（spec 2.4-04）。
   *
   * 字节由 `browser.page` 交出、由这里落盘：页面服务不知道自己会被谁调用，所以它不碰路径；
   * 而保留期是 run 的事，故截图与证据 JSON 同名同目录，`applyRetention` 按 `<runId>-` 前缀一起清掉。
   * @param runId 本次 run
   * @param nodeId 节点 id
   * @returns 证据里的截图位；页面服务没装、不给截图、取不到画面或写盘失败时为 null
   */
  private async writeScreenshot(runId: string, nodeId: string): Promise<NodeEvidence['screenshot']> {
    const page = this.pageChannel();
    if (!page?.screenshot) return null;
    try {
      const shot = await page.screenshot();
      const png = this.evidenceFile(runId, nodeId, 'png');
      writeFileSync(png.absolute, shot.png);
      return { ref: png.relative, width: shot.width, height: shot.height };
    } catch (error) {
      // 视图隐藏 / 还没绘制 / 磁盘问题：三种都只让截图这一位空掉，正文证据照旧落盘。
      this.ctx.logger.debug(`证据未取得现场截图：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * 取证据要用的页面通道。
   *
   * 页面通道是**可选**依赖（`browser.page` 没装时节点照样要判失败），所以走 `maybeService` 而不是 inject
   * ——这也是 2.4-08「纯 mock 跑通整条链」在类型上成立的前提。
   * @returns 装了的页面服务（只取证据用得上的两个方法）；没装时 undefined（`maybeService` 的读数形状）
   */
  private pageChannel(): PageSnapshotReader | undefined {
    return maybeService<PageSnapshotReader>(this.ctx, 'browser.page');
  }

  /**
   * 取一帧失败现场的页面读数。
   *
   * 取不到就记 null，绝不因为「没页面」而把证据整体丢掉（spec 2.4-04 要求的是错误 payload + 现场读数）。
   * @returns URL / 标题 / 正文节选；无内核会话或求值失败时为 null
   */
  private async readPage(): Promise<NodeEvidence['page']> {
    const page = this.pageChannel();
    if (!page) return null;
    try {
      const snapshot = await page.snapshot(this.config.evidenceDomChars);
      return {
        url: snapshot.url,
        title: this.cap(snapshot.title),
        bodyText: this.cap(snapshot.bodyText),
      };
    } catch (error) {
      // 没登录态就没有页面，这不是缺陷：证据仍然要有错误 payload，页面位记 null。
      this.ctx.logger.debug(`证据未取得页面读数：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * 按配置的字段上限截断文本。
   *
   * 先脱敏再截断，顺序反了会漏：`13800138000` 若在第 300 个字被切剩 `1380013`，
   * 落盘时的整串判据就认不出来了，等于把半个手机号留在证据里（spec 2.7-07）。
   * @param text 原始文本
   * @returns 掩码后不超过 `evidenceTextChars` 的文本；被截断时尾部带标记（不谎称是全文）
   */
  private cap(text: string): string {
    const limit = this.config.evidenceTextChars;
    const safe = redactText(text);
    return safe.length <= limit ? safe : `${safe.slice(0, limit)}…（已截断）`;
  }

  /**
   * 清掉超出保留数的旧 run，并连带删掉它们的证据文件（spec 2.4-10 的保留侧）。
   *
   * 「谁产生谁管生命周期」：证据路径是 runner 写进库的，所以只有 runner 知道该删哪些文件；
   * `workflow.store.prune()` 只报账被删的 run id。
   */
  private applyRetention(): void {
    const dropped = this.store.prune(this.config.retentionRuns);
    if (dropped.length === 0) return;
    const dir = join(this.userDataDir, this.config.evidenceDir);
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const runId of dropped) {
      for (const name of entries.filter((item) => item.startsWith(`${runId}-`))) {
        rmSync(join(dir, name), { force: true });
      }
    }
    this.ctx.logger.info(
      `按保留上限 ${String(this.config.retentionRuns)} 次清掉了 ${String(dropped.length)} 次旧 run 与其证据`,
    );
  }

  /**
   * 装配期校验：计划里的每个 `kind` 都必须在登记处有实现，节点数不得超过上限。
   * @param plan 待校验的计划
   * @throws 超上限或 `kind` 无人登记时 `INVALID_ARGUMENT`，且一次报全所有问题
   */
  private requireExecutable(plan: WorkflowPlanView): void {
    const problems: string[] = [];
    if (plan.nodes.length > this.config.maxNodesPerRun) {
      problems.push(
        `计划有 ${String(plan.nodes.length)} 个节点，超过单次 run 上限 ${String(this.config.maxNodesPerRun)}`,
      );
    }
    const known = new Set(this.registry.list());
    for (const spec of plan.nodes) {
      if (!known.has(spec.kind)) problems.push(`节点 ${spec.id} 的执行器 ${spec.kind} 没有登记`);
    }
    if (problems.length > 0) {
      throw new AppError('INVALID_ARGUMENT', `这条计划现在跑不了：${problems.join('；')}`, 'workflow.runner', {
        planId: plan.id,
        problems,
        registered: [...known],
      });
    }
  }

  /** 节点位置的键（同进程重试判定用）。 */
  private positionKey(runId: string, index: number): string {
    return `${runId}#${String(index)}`;
  }
}

/**
 * 把库里的 run 读数重建成界面镜像（spec 2.4-05）。
 *
 * 只有 `steps` 需要重建：镜像的职责是「画槽位 + 显示状态」，而库里那份才是真相。
 * @param stored 库里的完整读数
 * @returns 与同一次 run 被跑过时一模一样的镜像（`interrupted` 映射成 `paused`，界面不需要新增态）
 */
function toMirror(stored: WorkflowRunStateView): WorkflowRunView {
  const steps: WorkflowStepView[] = stored.nodes.map((node) => ({
    id: node.nodeId,
    // 5.10-08 之后 `skipped` 有自己的读数（琥珀色的「这一支没走」），不许再与 `done` 同形：
    // 只走了半张图的 run 与跑完全图的 run 必须是两个样子。崩溃时正在跑的那个节点没有结局，
    // 退回 `pending` 等重放（spec 1.10-05 的暂停同口径）。
    status:
      node.status === 'done'
        ? 'done'
        : node.status === 'failed'
          ? 'failed'
          : node.status === 'skipped'
            ? 'skipped'
            : 'pending',
    startedAt: node.startedAt,
    finishedAt: node.finishedAt,
    durationMs: node.durationMs,
    error: node.error,
  }));
  return {
    runId: stored.runId,
    status: stored.status === 'interrupted' ? 'paused' : stored.status,
    stepIndex: Math.min(stored.nodeIndex, steps.length),
    steps,
    startedAt: stored.startedAt,
    requiresHuman: null,
    // 接管点从来不入库（`workflow_nodes` 没有对应列，plan §15.9 事实 7），所以从库里重建的镜像
    // 两个接管位都是空的：跨进程续跑后界面上不该出现「等待接管 / 已人工接管」——那事已经随进程死了。
    takeoverHandled: null,
  };
}

declare module '@auto-cc/core' {
  interface AppServices {
    'workflow.runner': WorkflowRunnerService;
  }
}
