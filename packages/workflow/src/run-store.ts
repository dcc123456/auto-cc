/**
 * `workflow.store` 服务（spec 2.4-01 / 2.4-05 / 2.4-06 / 2.4-10）：一次 run 的唯一落点。
 *
 * 为什么必须有表：2.4-05 要「中途 kill 进程，重启后从失败节点继续，已完成节点不重放」，
 * 而 1.10 的 run 状态只在内存里——进程一没就什么都没了。落库之后「上次卡在第几个节点」
 * 成了一个可以被读出来的事实，而不是靠日志猜（plan §11.3 第 4/6 条）。
 *
 * 本服务**只管数据**：不认识执行器、不做重试、不发事件。所有编排在 `workflow.runner`，
 * 于是 2.4-08 的 mock 链和 2.4-01 的序列化 round-trip 都能直接对着这张表测。
 *
 * 5.4 起它还是**自定义工作流计划**的落点（`workflow_plans`，号段 20，读写机器在 `plan-store.ts`）。
 * 挂在这一个服务上而不是新起 `workflow.plans` 服务，理由写在 `plan-store.ts` 的文件头：
 * 同属工作流持久化、同一个连接、同一份迁移清单，再起一个服务就是第二条通路（AGENTS.md §2.3/§2.7）。
 */
import {
  AppError,
  asApp,
  asSqlCount,
  asSqlInt,
  Service,
  type Context,
  type SavedWorkflowPlanView,
  type WorkflowNodeRunView,
  type WorkflowNodeSpec,
  type WorkflowNodeStatsView,
  type WorkflowNodeStatus,
  type WorkflowPlanView,
  type WorkflowRunStateStatus,
  type WorkflowRunStateView,
} from '@auto-cc/core';
import type { StoreService } from '@auto-cc/plugin-store';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { planFromStoredText } from './plan.js';
import {
  deletePlan,
  getPlan,
  insertPlan,
  listPlans,
  renamePlan,
  workflowPlanMigration,
  WORKFLOW_PLAN_MIGRATION_VERSION,
  type SavedPlanInput,
} from './plan-store.js';

/**
 * run 表的迁移号段：**4**（`usage_ledger` 占 1、`chat` 的两张表占 2、`jobs` 占 3）。
 * 撞号不是编译期错误而是运行期抛「迁移版本重复」，所以前几级谁占的必须写在这里。
 */
export const WORKFLOW_MIGRATION_VERSION = 4;

/**
 * 建 `workflow_runs` + `workflow_nodes` 两张表，以及把 run 判成中断所需的那条索引。
 *
 * 计划本体以 `plan_json` 存在 run 行上（而不是每个节点行存一份）：一条计划的节点在一次 run 里
 * 是不可变的，重复存 N 份就给了「节点行与计划不一致」留了口子；而续跑恰恰需要连参数一起读回来。
 */
const workflowMigration = {
  version: WORKFLOW_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      plan_fingerprint TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      status TEXT NOT NULL,
      node_index INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      last_error TEXT
    )`);
    // 开机扫描孤儿行（`status='running'`）与「取最近一次中断的 run」都走这条，没它就是全表扫。
    db.exec('CREATE INDEX IF NOT EXISTS workflow_runs_status ON workflow_runs (status, started_at DESC)');
    db.exec(`CREATE TABLE IF NOT EXISTS workflow_nodes (
      run_id TEXT NOT NULL,
      node_index INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      effect TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      finished_at INTEGER,
      duration_ms INTEGER,
      idempotency_key TEXT,
      side_effect TEXT,
      evidence_ref TEXT,
      error TEXT,
      PRIMARY KEY (run_id, node_index)
    )`);
    // 幂等键的唯一约束（spec 2.4-06）。只读节点的键是 NULL，而 SQLite 的唯一索引**视 NULL 互不相等**，
    // 于是「没有键」天然表示「不按目标去重」，不需要再加 WHERE 子句做成偏索引。
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS workflow_nodes_idempotency ON workflow_nodes (idempotency_key)');
    // 2.4-10 的聚合按执行器名分组；顺带让「某个节点在某 run 里排第几」可查。
    db.exec('CREATE INDEX IF NOT EXISTS workflow_nodes_kind ON workflow_nodes (kind, status)');
  },
  down: (db: DatabaseSync) => {
    // 两张表一起丢：run 行留着而节点行没了，下次读状态就会拿到「有计划、无进度」的假象。
    db.exec('DROP TABLE IF EXISTS workflow_nodes');
    db.exec('DROP TABLE IF EXISTS workflow_runs');
  },
};

/** `workflow_runs` 一行的原始读数（列名与视图字段不同，转换收在 `toRunRow` 一侧）。 */
type RunRow = {
  run_id: string;
  plan_id: string;
  plan_fingerprint: string;
  plan_json: string;
  status: string;
  node_index: number | bigint;
  started_at: number | bigint;
  finished_at: number | bigint | null;
  last_error: string | null;
};

/** `workflow_nodes` 一行的原始读数。 */
type NodeRow = {
  run_id: string;
  node_index: number | bigint;
  node_id: string;
  kind: string;
  effect: string;
  status: string;
  attempts: number | bigint;
  started_at: number | bigint | null;
  finished_at: number | bigint | null;
  duration_ms: number | bigint | null;
  idempotency_key: string | null;
  side_effect: string | null;
  evidence_ref: string | null;
  error: string | null;
};

/** 节点状态的合法集合；库里躺着别的值时一律按 `pending` 读出来（宁可重跑也不当作已完成）。 */
const NODE_STATUSES: readonly WorkflowNodeStatus[] = ['pending', 'running', 'done', 'failed', 'skipped'];

/** run 状态的合法集合（含只有落库侧才有的 `interrupted`）。 */
const RUN_STATUSES: readonly WorkflowRunStateStatus[] = ['idle', 'running', 'paused', 'failed', 'done', 'interrupted'];

/**
 * 收窄库里读出的状态字符串。
 * @param raw 列里的文本
 * @param allowed 该列的合法集合
 * @returns 合法成员，否则集合第一项（读侧的「不认识就退回初值」，不让一个坏值把整个面板打空）
 */
function oneOf<T extends string>(raw: string, allowed: readonly T[]): T {
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : allowed[0]!;
}

/** 一次节点的结束读数——`recordNode` 要的是**完整**对象，不是部分字段。 */
export type NodeOutcome = {
  status: WorkflowNodeStatus;
  /** 含首次在内的尝试次数；上限是 `1 + retryTimes`（spec 2.4-03）。 */
  attempts: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** 最后一次尝试的耗时（毫秒）；未结束为 null。 */
  durationMs: number | null;
  error: string | null;
  /** 证据文件的相对路径（userData 下）；无证据为 null（spec 2.4-04）。 */
  evidenceRef: string | null;
  /** 外部副作用位：null = 无副作用，`started` = 已开始未观察到完成，`done` = 已完成。 */
  sideEffect: null | 'started' | 'done';
};

/** 一次 run 的结束/推进读数（同样是完整对象，`updateRun` 每次写全）。 */
export type RunOutcome = {
  status: WorkflowRunStateStatus;
  /** 下一个要跑的节点下标；越界一位表示全部结束。 */
  nodeIndex: number;
  finishedAt: number | null;
  /** 稳定的机器可读码（如 `RUN_INTERRUPTED`），句子由渲染层按语言组（AGENTS.md §5.5）。 */
  lastError: string | null;
};

/** `claimNode` 的三种判决。 */
export type NodeClaim =
  /** 可以执行：节点行已就位（首次插入或失败后重来），`attempts` 已反映本次尝试。 */
  | 'granted'
  /** 这个位置已经完成过（或被跳过），**不许重放**（spec 2.4-05 的「已完成节点不重放」）。 */
  | 'already-done'
  /** 上一次外部副作用开始了却没观察到完成，自动重放可能发两遍 → 转人工接管（plan §11.3 第 5 条）。 */
  | 'needs-human';

/** 可以被续跑的一次中断的读数（2.4-05 的续跑入口只看这三项）。 */
export type ResumeCandidateView = {
  runId: string;
  planFingerprint: string;
  nodeIndex: number;
};

export const workflowStoreSchema = z.strictObject({});

/** 校验后的配置形状（本服务无配置项，号段与表结构都是代码内的事实）。 */
export type WorkflowStoreConfig = z.infer<typeof workflowStoreSchema>;

export class WorkflowRunStoreService extends Service {
  static provide = 'workflow.store';
  static Config = workflowStoreSchema;
  static inject = ['store'];

  constructor(ctx: Context, _options: WorkflowStoreConfig) {
    // 无配置项也要接住第二个实参：cordis 递的是校验后的配置对象（AGENTS.md §9 实测 1.3）。
    super(ctx, 'workflow.store');
  }

  /** store 服务句柄；连接尚未打开时由 `store.db` 的 getter 抛出「尚未完成挂载」。 */
  private get store(): StoreService {
    return asApp(this.ctx).store;
  }

  private get db(): DatabaseSync {
    return this.store.db;
  }

  /**
   * 登记迁移并把表建出来。
   *
   * 幂等 push 是硬要求：插件重启会重新构造本服务，无条件 push 会在共享清单里留下两个 `version: 4`。
   */
  private ensureSchema(): void {
    const { migrations } = this.store;
    if (!migrations.some((item) => item.version === WORKFLOW_MIGRATION_VERSION)) {
      migrations.push(workflowMigration);
    }
    // 计划表那一支单独判一次：两支都属于本服务，但版本号互不相干，缺任何一支都要各自补齐。
    if (!migrations.some((item) => item.version === WORKFLOW_PLAN_MIGRATION_VERSION)) {
      migrations.push(workflowPlanMigration);
    }
    this.store.upgrade();
  }

  /**
   * 开一次 run：把计划连同指纹一起落库，之后进程没了也读得回来。
   * @param runId 本次 run 的 id（由 runner 生成）
   * @param plan 已补全默认值的计划（`buildPlan` 的产物）
   * @param at 开始时间戳（毫秒）
   * @returns 无；重复用同一 `runId` 调用是**幂等**的（`INSERT OR IGNORE`），因为续跑不该重写开始时间
   */
  openRun = (runId: string, plan: WorkflowPlanView, at: number): void => {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO workflow_runs
          (run_id, plan_id, plan_fingerprint, plan_json, status, node_index, started_at, finished_at, last_error)
         VALUES (?, ?, ?, ?, 'running', 0, ?, NULL, NULL)`,
      )
      .run(runId, plan.id, plan.fingerprint, JSON.stringify(plan), at);
  };

  /**
   * 声明「第 `index` 个节点现在开始执行」——这是幂等的**唯一**保证点。
   *
   * 判决顺序刻意是「先看位置上的旧行，再看有没有别的行占了同一个幂等键」：
   * 前者管「重试沿用同一行、已完成的不重放」，后者管「同一 run 里换个节点做同一件外发也不重复」。
   * @param runId 本次 run
   * @param index 节点下标（计划数组的顺序）
   * @param spec 节点声明
   * @param at 本次尝试的开始时间戳（毫秒）
   * @param force 人工确认后的重放：`needs-human` 的那道拒绝只为「没人看过」而设，
   *   用户在接管点上按下重试之后继续重放才是 2.4-05 要的路径；默认 false，绝不能由执行器自己传 true
   * @returns `granted`（可以跑）/ `already-done`（跳过）/ `needs-human`（拒绝盲重放，转接管）
   * @throws run 行不存在时 `INVALID_ARGUMENT`——没有 run 就没有 `node_index` 的归属，静默插一行会变成孤儿
   */
  claimNode = (runId: string, index: number, spec: WorkflowNodeSpec, at: number, force = false): NodeClaim => {
    const existing = this.nodeRow(runId, index);
    if (existing) {
      if (existing.status === 'done' || existing.status === 'skipped') return 'already-done';
      if ((existing.side_effect === 'started' || existing.side_effect === 'done') && !force) return 'needs-human';
      if (force && existing.side_effect) {
        this.ctx.logger.warn(
          `第 ${String(index)} 个节点的外发未被观察到完成，人工确认后重放（幂等键 ${existing.idempotency_key ?? '（无）'}）`,
        );
      }
      // 失败留的行沿用到底：`attempts` 自增、上一轮的耗时/错误/证据清空（重试是一次新的尝试，但仍是同一个节点）。
      this.db
        .prepare(
          `UPDATE workflow_nodes SET status = 'running', attempts = attempts + 1,
            finished_at = NULL, duration_ms = NULL, error = NULL
           WHERE run_id = ? AND node_index = ?`,
        )
        .run(runId, index);
      return 'granted';
    }
    const key = idempotencyKey(runId, spec);
    if (key) {
      const clash = this.db.prepare('SELECT node_index FROM workflow_nodes WHERE idempotency_key = ?').get(key) as
        { node_index?: number | bigint } | undefined;
      if (clash) {
        // 同一个 run 里另一个位置已经对这个目标动过手：外发只做一次（spec 2.4-06）。
        // 这里刻意**不**升级成接管点：那是要在同一位置「开始了却没观察到完成」时才用的判决
        // （见上面的 `needs-human`）；串到别的下标是数据异常，静默跳过比把整条 run 停住更合适，
        // 而真正的「计划换过」由 run 行的指纹比对在 runner 层拒绝（2.4-05）。
        this.ctx.logger.warn(
          `幂等键 ${key} 已被第 ${String(Number(clash.node_index))} 个节点占用，本次跳过以免重复外发`,
        );
        return 'already-done';
      }
    }
    const run = this.runRow(runId);
    if (!run) {
      throw new AppError('INVALID_ARGUMENT', `续跑前必须先有 run 行：${runId}`, 'workflow.store', { runId });
    }
    this.db
      .prepare(
        `INSERT INTO workflow_nodes
          (run_id, node_index, node_id, kind, effect, status, attempts, started_at,
           finished_at, duration_ms, idempotency_key, side_effect, evidence_ref, error)
         VALUES (?, ?, ?, ?, ?, 'running', 1, ?, NULL, NULL, ?, ?, NULL, NULL)`,
      )
      .run(
        runId,
        index,
        spec.id,
        spec.kind,
        spec.effect,
        at,
        key,
        // 只有真的会动外面世界的节点才占副作用位：read 节点的 `started` 毫无意义，还会挡住重试。
        spec.effect === 'read' ? null : 'started',
      );
    return 'granted';
  };

  /**
   * 写回一个节点这次的完整读数。
   * @param runId 本次 run
   * @param index 节点下标
   * @param outcome 结束读数（完整对象，见 `NodeOutcome`）
   * @returns 无；命中 0 行不报错——`claimNode` 已经保证行存在，这里只负责落地
   */
  recordNode = (runId: string, index: number, outcome: NodeOutcome): void => {
    this.db
      .prepare(
        `UPDATE workflow_nodes SET status = ?, attempts = ?, started_at = ?, finished_at = ?, duration_ms = ?,
           error = ?, evidence_ref = ?, side_effect = ?
         WHERE run_id = ? AND node_index = ?`,
      )
      .run(
        outcome.status,
        outcome.attempts,
        outcome.startedAt,
        outcome.finishedAt,
        outcome.durationMs,
        outcome.error,
        outcome.evidenceRef,
        outcome.sideEffect,
        runId,
        index,
      );
  };

  /**
   * 推进或收尾一次 run。
   * @param runId 本次 run
   * @param outcome run 读数（下一个节点下标 + 状态 + 结束时间 + 错误码）
   */
  updateRun = (runId: string, outcome: RunOutcome): void => {
    this.db
      .prepare('UPDATE workflow_runs SET status = ?, node_index = ?, finished_at = ?, last_error = ? WHERE run_id = ?')
      .run(outcome.status, outcome.nodeIndex, outcome.finishedAt, outcome.lastError, runId);
  };

  /**
   * 读回一次 run 的完整状态（2.4-01 的「可回放」）。
   *
   * 没跑过的节点也会被补成 `pending` 行：界面画槽位要的是「计划里有几个节点」，
   * 而不是「库里现在有几行」，否则刚起步的 run 在面板上只有 1 个格子。
   * @param runId 本次 run
   * @returns 状态视图；库里没有这次 run 时为 null（不是抛错——「还没跑过」是正常状态）
   * @throws `plan_json` 被外部写坏、或计划文本与登记的指纹不一致时以 `INVALID_ARGUMENT` 失败，绝不返回半条计划
   */
  state = (runId: string): WorkflowRunStateView | null => {
    const run = this.runRow(runId);
    if (!run) return null;
    const plan = this.runPlan(run);
    const rows = this.db
      .prepare('SELECT * FROM workflow_nodes WHERE run_id = ? ORDER BY node_index')
      .all(runId) as NodeRow[];
    const byIndex = new Map<number, NodeRow>();
    for (const row of rows) byIndex.set(Number(row.node_index), row);
    const nodes = plan.nodes.map((spec, index) => toNodeView(byIndex.get(index), spec, index));
    return {
      runId: run.run_id,
      planId: run.plan_id,
      planFingerprint: run.plan_fingerprint,
      status: oneOf(run.status, RUN_STATUSES),
      nodeIndex: Number(run.node_index),
      totalNodes: plan.nodes.length,
      startedAt: Number(run.started_at),
      finishedAt: asSqlInt(run.finished_at),
      lastError: run.last_error,
      nodes,
    };
  };

  /**
   * 读回某次 run **自己带上**的那份计划（spec 5.4-07 的地基）。
   *
   * 为什么不复用 `state()`：那里给的是「节点进度」，界面要的是「这一格当初声明的是什么」
   * （kind、参数、是否接管点）。两者读的是同一列，所以校验只写在一处（`runPlan`），
   * 而 `nodes()` 因此能按 run 自己的快照回答——面板此刻配了哪条计划与它无关。
   * @param runId 本次 run
   * @returns 计划视图；库里没有这次 run 时为 null（初始镜像还没有行）
   * @throws 计划文本损坏或与登记指纹不一致，同 `state()`——绝不返回半条计划
   */
  planSnapshot = (runId: string): WorkflowPlanView | null => {
    const run = this.runRow(runId);
    return run ? this.runPlan(run) : null;
  };

  /**
   * 把上次进程死亡留下的孤儿 run 判成 `interrupted`（plan §11.3 第 6 条）。
   *
   * 必须在 runner 挂载之前跑：晚一步的话，界面上第一次读数就会显示「仍在运行」，
   * 而那个「运行中」其实属于一个已经不存在的进程——2.4-05 的续跑也就没有起点。
   * @param at 判定基准时间戳（毫秒），写进 `finished_at`
   * @returns 被判成中断的 run id 列表（正常启动时为空）
   */
  markInterrupted = (at: number): string[] => {
    const rows = this.db.prepare("SELECT run_id FROM workflow_runs WHERE status = 'running'").all() as {
      run_id: string;
    }[];
    if (rows.length === 0) return [];
    this.db
      .prepare(
        "UPDATE workflow_runs SET status = 'interrupted', finished_at = ?, last_error = 'RUN_INTERRUPTED' WHERE status = 'running'",
      )
      .run(at);
    this.ctx.logger.info(
      `上次进程退出留下了 ${String(rows.length)} 次未完成的 run，已判为中断：${rows.map((row) => row.run_id).join('、')}`,
    );
    return rows.map((row) => row.run_id);
  };

  /**
   * 找最近一次可以被续跑的中断 run（spec 2.4-05 的入口）。
   * @param fingerprint 当前计划的指纹；不符就不返回——**计划改过之后从第 i 个节点瞎续比重新跑更糟**
   * @param runIdRaw 指定要续的那次；省略就取最近一次中断
   * @returns 续跑起点（含要接着跑的节点下标）；无可续的 run 时为 null
   */
  resumeCandidate = (fingerprint: string, runIdRaw?: string): ResumeCandidateView | null => {
    const row = runIdRaw
      ? (this.db
          .prepare(
            "SELECT run_id, plan_fingerprint, node_index FROM workflow_runs WHERE run_id = ? AND status IN ('interrupted', 'paused', 'failed')",
          )
          .get(runIdRaw) as ResumeRow | undefined)
      : (this.db
          .prepare(
            `SELECT run_id, plan_fingerprint, node_index FROM workflow_runs
             WHERE status IN ('interrupted', 'paused', 'failed') AND plan_fingerprint = ?
             ORDER BY started_at DESC LIMIT 1`,
          )
          .get(fingerprint) as ResumeRow | undefined);
    if (!row) return null;
    return { runId: row.run_id, planFingerprint: row.plan_fingerprint, nodeIndex: Number(row.node_index) };
  };

  /**
   * 按执行器聚合历史耗时与成功率（spec 2.4-10，P5 看板的唯一数据源）。
   *
   * 直接聚合 `workflow_nodes`，不另建统计表：那张表既是续跑的真相又是看板的原料，
   * 于是「看板说的」和「续跑用的」必然是同一份读数（plan §11.3 第 4 条）。
   * @returns 每个 `kind` 一行的聚合，按节点数从多到少
   */
  stats = (): WorkflowNodeStatsView[] => {
    const rows = this.db
      .prepare(
        `SELECT kind,
                COUNT(*) AS nodes,
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
                SUM(COALESCE(duration_ms, 0)) AS duration_sum,
                SUM(attempts) AS attempt_sum
         FROM workflow_nodes GROUP BY kind ORDER BY nodes DESC`,
      )
      .all() as StatsRow[];
    return rows.map((row) => {
      const nodes = asSqlCount(row.nodes);
      const done = asSqlCount(row.done);
      const failed = asSqlCount(row.failed);
      // 分母只算「有结局」的节点：正在跑和没跑过的都不该拉低成功率，但也不该被算成成功。
      const settled = done + failed;
      return {
        kind: row.kind,
        nodes,
        done,
        failed,
        skipped: asSqlCount(row.skipped),
        successRate: settled === 0 ? null : done / settled,
        avgDurationMs: settled === 0 ? null : asSqlCount(row.duration_sum) / settled,
        avgAttempts: nodes === 0 ? 0 : asSqlCount(row.attempt_sum) / nodes,
      };
    });
  };

  /**
   * 只保留最近 `keepRuns` 次 run（源仓库 checkpoint 保留上限的等价物）。
   * @param keepRuns 保留次数下限，来自 `workflow.runner` 的 `retentionRuns` 配置
   * @returns 被清掉的 run id 列表——**证据文件由调用方删**（谁产生谁管生命周期），这里只报账
   */
  prune = (keepRuns: number): string[] => {
    const keep = Math.max(1, Math.floor(keepRuns));
    const dropped = this.db
      .prepare('SELECT run_id FROM workflow_runs ORDER BY started_at DESC LIMIT -1 OFFSET ?')
      .all(keep) as { run_id: string }[];
    if (dropped.length === 0) return [];
    const ids = dropped.map((row) => row.run_id);
    // 先删子表再删主表：反过来的话中途崩溃会留下没有 run 的节点行，而那张表上没有级联可依赖。
    for (const runId of ids) {
      this.db.prepare('DELETE FROM workflow_nodes WHERE run_id = ?').run(runId);
      this.db.prepare('DELETE FROM workflow_runs WHERE run_id = ?').run(runId);
    }
    return ids;
  };

  /**
   * 存一条自定义计划（spec 5.4-01 的落库那一半）。
   * @param input 计划本体、名字、来源 run；`at` 由调用方给（本服务不自己读钟）
   * @returns 刚落库的列表读数
   */
  savePlan = (input: SavedPlanInput): SavedWorkflowPlanView => insertPlan(this.db, input);

  /**
   * 列出全部自定义计划（不含内置那三条，内置的在 runner 的目录里）。
   * @returns 按最后改动时间倒序的列表读数；一条都没有时为空数组
   */
  listPlans = (): SavedWorkflowPlanView[] => listPlans(this.db);

  /**
   * 读一条自定义计划。
   * @param id 计划 id
   * @returns 列表读数 + 交给 runner 的本体；库里没有这条时为 null
   */
  getPlan = (id: string): { saved: SavedWorkflowPlanView; plan: WorkflowPlanView } | null => getPlan(this.db, id);

  /**
   * 给自定义计划改名（spec 5.4-08 的重命名）。
   * @param id 计划 id
   * @param rawName 新名字，校验在 `plan-store` 那一处，不在界面重复
   * @param at 改动时刻（毫秒）
   * @returns 改后的读数；这条不存在时为 null
   */
  renamePlan = (id: string, rawName: string, at: number): SavedWorkflowPlanView | null =>
    renamePlan(this.db, id, rawName, at);

  /**
   * 删一条自定义计划（spec 5.4-08 的删除——确认发生在界面，这里只负责删）。
   * @param id 计划 id
   * @returns 真的删掉一行为 true；本来就没有为 false
   */
  deletePlan = (id: string): boolean => deletePlan(this.db, id);

  /**
   * 把 run 行里的 `plan_json` 解析回计划，并核对指纹（`state()` 与 `planSnapshot()` 共用的一处校验）。
   *
   * 判据本体在 `plan.ts` 的 `planFromStoredText`——`workflow_plans` 那条读路走的是同一份机器（§2.2），
   * 这里只负责递上「这条 run 的原文 + 它登记的指纹」和一句指认谁的话。
   * @param run 已经读到手的 run 行
   * @returns 补全默认值并重算过指纹的计划视图
   * @throws `INVALID_ARGUMENT`（文本读不回、形状不合、或与登记的指纹不一致），绝不返回半条计划
   */
  private runPlan(run: RunRow): WorkflowPlanView {
    return planFromStoredText(run.plan_json, run.plan_fingerprint, '库里这次 run', { runId: run.run_id });
  }

  /** 读 run 行；没有就 null（内部用，所以不抛）。 */
  private runRow(runId: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM workflow_runs WHERE run_id = ?').get(runId) as RunRow | undefined;
  }

  /** 读某个位置上的节点行；没有就 null。 */
  private nodeRow(runId: string, index: number): NodeRow | undefined {
    return this.db.prepare('SELECT * FROM workflow_nodes WHERE run_id = ? AND node_index = ?').get(runId, index) as
      NodeRow | undefined;
  }

  [Service.init](): void {
    this.ensureSchema();
    this.ctx.logger.info(
      `run 存储就绪：workflow_runs / workflow_nodes（schema v${String(WORKFLOW_MIGRATION_VERSION)}）` +
        ` · 自定义计划 workflow_plans（schema v${String(WORKFLOW_PLAN_MIGRATION_VERSION)}）`,
    );
  }
}

/**
 * 算一个节点的幂等键。
 * @param runId 本次 run
 * @param spec 节点声明
 * @returns `runId|nodeId|target`；只读节点（`effect='read'`）为 null，表示「本节点不按目标去重」
 */
function idempotencyKey(runId: string, spec: WorkflowNodeSpec): string | null {
  if (spec.effect === 'read') return null;
  return `${runId}|${spec.id}|${spec.target}`;
}

/**
 * 把节点行（可能不存在）转成跨进程视图。
 * @param row 库里的行；没跑过的节点没有行
 * @param spec 该位置的节点声明，用于在缺行时补出 `pending` 槽位
 * @param index 节点下标
 */
function toNodeView(row: NodeRow | undefined, spec: WorkflowNodeSpec, index: number): WorkflowNodeRunView {
  if (!row) {
    return {
      index,
      nodeId: spec.id,
      kind: spec.kind,
      effect: spec.effect,
      status: 'pending',
      attempts: 0,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      error: null,
      evidenceRef: null,
      sideEffect: null,
    };
  }
  return {
    index: Number(row.node_index),
    nodeId: row.node_id,
    kind: row.kind,
    effect: spec.effect,
    status: oneOf(row.status, NODE_STATUSES),
    attempts: asSqlCount(row.attempts),
    startedAt: asSqlInt(row.started_at),
    finishedAt: asSqlInt(row.finished_at),
    durationMs: asSqlInt(row.duration_ms),
    error: row.error,
    evidenceRef: row.evidence_ref,
    // 库里可能是坏值：只认这三个，其余按 null 读，界面前不会出现「既没开始又开始过」的第三种说法。
    sideEffect: row.side_effect === 'started' || row.side_effect === 'done' ? row.side_effect : null,
  };
}

/** `resumeCandidate` 的查询行。 */
type ResumeRow = { run_id: string; plan_fingerprint: string; node_index: number | bigint };

/** `stats()` 的聚合行（`SUM` 在无值时回 NULL，所以全部按可空读）。 */
type StatsRow = {
  kind: string;
  nodes: number | bigint;
  done: number | bigint | null;
  failed: number | bigint | null;
  skipped: number | bigint | null;
  duration_sum: number | bigint | null;
  attempt_sum: number | bigint | null;
};

declare module '@auto-cc/core' {
  interface AppServices {
    'workflow.store': WorkflowRunStoreService;
  }
}
