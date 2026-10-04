/**
 * 自定义工作流计划的**存储层**（spec 5.4-01 / 06 / 08）。
 *
 * 这里只有「一行计划文本 + 它的名字与版本」，不含任何执行语义：能不能跑由 `workflow.executors`
 * 登记处与 runner 说了算（同一件事不允许在这里再判一遍，§2.5）。
 *
 * 为什么不另做一个 `workflow.plans` 服务：本包已经有 `workflow.store` 这一份工作流持久化
 * （`workflow_runs` / `workflow_nodes`），再挂一张同域表进去是**扩展**；再起一个服务就是
 * 第二条拿着同一个连接的通路，还要为它单独过一遍 IPC 白名单而收益为零（AGENTS.md §2.3/§2.7）。
 * 所以这里是导出给 `WorkflowRunStoreService` 调的纯函数，迁移由那一个服务统一幂等 push。
 */
import {
  AppError,
  type SavedWorkflowPlanView,
  type WorkflowGraphLoadView,
  type WorkflowGraphSaveView,
  type WorkflowGraphView,
  type WorkflowNodePlacement,
  type WorkflowPlanView,
} from '@auto-cc/core';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { buildGraph, canonicalViewsText, projectPlanToGraph, workflowViewsSchema } from './graph.js';
import { planFromStoredText } from './plan.js';

/**
 * 计划表的迁移号段：**20**（19 是额度拒绝账，18 是免确认白名单，17 是档位审计，16 是对话 run）。
 *
 * 必须新开而不是挂到 19 那一支上：`runMigrations` 认的是台账里「这一版记过账没有」，
 * 已记「19 已应用」的老库永远不会重跑那支迁移，`CREATE TABLE IF NOT EXISTS` 在这里帮不上忙
 * （AGENTS.md §9 的 5.3-a 实测条）。
 */
export const WORKFLOW_PLAN_MIGRATION_VERSION = 20;

/**
 * 建 `workflow_plans` 一张表（列表与读回都按 id 主键取，行数就是用户自己存的工作流数，不建索引）。
 *
 * 这里**没有** `revision` / `graph_json` / `views_json` / `is_custom` 四列：5.4 的写入口只有新增 /
 * 改名 / 复制 / 删除，没有一处会改节点内容，恒等于 1 的版本号没有消费者（AGENTS.md §2.6）。
 * 画布出现覆盖保存之后它们才有消费者，而那是**号段 28 加列**（见下面的 `workflowGraphMigration`）：
 * 已记「20 已应用」的老库永远不会重跑这一支，改这里的 `up` 等于对老库静默失效。
 */
export const workflowPlanMigration = {
  version: WORKFLOW_PLAN_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS workflow_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      source_run_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS workflow_plans');
  },
};

/**
 * 画布图的落库号段：**28**（27 是投递时间索引，26 是调度任务）。
 *
 * 四条加列各有一个明确的消费者，缺一条这一片就不成立：
 * `graph_json` 是 5.10-10 的"重启后画布重开同一张图"；`views_json` 是 5.10-06 的"落点与执行身份分开"
 * （它绝不进指纹，所以绝不能混进 `graph_json`）；`revision` 是覆盖保存的乐观并发凭据；
 * `is_custom` 区分"画布存下来的图"与"`plan_json` 线性投影现算的图"，读路靠它决定哪一份是真相。
 */
export const WORKFLOW_GRAPH_MIGRATION_VERSION = 28;

/** 给 `workflow_plans` 加画布那四列（默认值让 5.4 的老行读出来就是"未编辑过、版本 1"）。 */
export const workflowGraphMigration = {
  version: WORKFLOW_GRAPH_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec('ALTER TABLE workflow_plans ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
    db.exec('ALTER TABLE workflow_plans ADD COLUMN graph_json TEXT');
    db.exec('ALTER TABLE workflow_plans ADD COLUMN views_json TEXT');
    db.exec('ALTER TABLE workflow_plans ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0');
  },
  down: (db: DatabaseSync) => {
    db.exec('ALTER TABLE workflow_plans DROP COLUMN is_custom');
    db.exec('ALTER TABLE workflow_plans DROP COLUMN views_json');
    db.exec('ALTER TABLE workflow_plans DROP COLUMN graph_json');
    db.exec('ALTER TABLE workflow_plans DROP COLUMN revision');
  },
};

/** `workflow_plans` 一行的原始读数（列名与视图字段不同，转换收在 `toSavedPlanView` 一侧）。 */
type PlanRow = {
  id: string;
  name: string;
  plan_json: string;
  fingerprint: string;
  source_run_id: string | null;
  created_at: number | bigint;
  updated_at: number | bigint;
  revision: number | bigint;
  graph_json: string | null;
  views_json: string | null;
  is_custom: number | bigint;
};

/** 落库一条计划时要带上的全部信息。 */
export type SavedPlanInput = {
  id: string;
  name: string;
  plan: WorkflowPlanView;
  sourceRunId: string | null;
  /** 落库时刻（毫秒）；由调用方给，存储层不自己读钟（同 `workflow.store` 的其余写口）。 */
  at: number;
};

/**
 * 计划名字的校验（spec 5.4-05 的唯一判点）。
 *
 * 校验只放在写入口这一处：界面拦一道、服务再拦一道就是两套规则，两边一改就漂移
 * （AGENTS.md §2.6——用户输入是系统边界，边界才校验）。
 * @param rawName 用户填的原值（可以带首尾空格）
 * @returns 去掉首尾空格之后的名字
 * @throws `INVALID_ARGUMENT` 并说清是哪一条（空 / 超长 / 非法字符）
 */
export function assertPlanName(rawName: string): string {
  const name = rawName.trim();
  if (name === '') {
    throw new AppError('INVALID_ARGUMENT', '工作流名称不能为空', 'workflow.store', {});
  }
  // 上限 40：列表那一列在常见窗口宽度下刚好放得下，超出的名字会被省略号吃掉，等于没起作用。
  if (name.length > 40) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `工作流名称不能超过 40 个字符（当前 ${String(name.length)}）`,
      'workflow.store',
      {
        length: name.length,
      },
    );
  }
  // 允许 汉字 / 字母 / 数字 / 空格 / 常见连接符；其余（引号、尖括号、路径分隔符、控制字符）一律拒。
  // 这些字符目前没有任何消费者会解释它们，但会出现在文件名式的日志与将来的导出里，
  // 与其等那一天再补转义，不如在入口就不让进（同 §8 的"边界处一次做对"口径）。
  // 全角括号 （） 与半角 () 同列：中文输入法打出来的就是全角，5.4-b 实测里
  // 「搜上海前端打招呼（改名后）」被这道校验拒掉，等于告诉用户"中文名字不许有括号"。
  if (!/^[\p{Script=Han}A-Za-z0-9 .,()（）\-_、：:·]+$/u.test(name)) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `工作流名称「${name}」含不被允许的字符（只能用中英文、数字、空格与常见标点）`,
      'workflow.store',
      {},
    );
  }
  return name;
}

/**
 * 生成一条自定义计划的 id（`plan-` + 12 位十六进制）。
 *
 * 与内置那三条（`boss-basic` 等）不会撞：后者的形状是「短横线小写词」，而这里带 `plan-` 前缀，
 * runner 解析计划时按「先内置目录、再表」的顺序查，撞名就会让一条自定义计划永远读不到。
 * @returns 新的计划 id
 */
export function newPlanId(): string {
  return `plan-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * 把库里的计划原文收成可信本体：判据与 run 快照**同一条**（`plan.ts` 的 `planFromStoredText`）。
 *
 * 坏一行就说清坏在哪，而不是按一份来历不明的节点表开跑；重算机器全仓一份，两条读路不会漂成两个口径。
 * @param row 库里的一行
 * @returns 补全默认值并重算过指纹的计划本体
 * @throws `INVALID_ARGUMENT` 原文坏了、或节点内容与登记的指纹不符
 */
function planBody(row: PlanRow): WorkflowPlanView {
  return planFromStoredText(row.plan_json, row.fingerprint, `计划 ${row.id}`, { planId: row.id });
}

/**
 * 把一行计划读数转成跨进程视图。
 * @param row 库里的一行
 * @param plan 由 `planBody` 收出来的本体（节点数从它现算）
 * @returns 列表与详情共用的读数（不含节点本体，那是 `getPlan` 的第二段返回）
 */
function toSavedPlanView(row: PlanRow, plan: WorkflowPlanView): SavedWorkflowPlanView {
  return {
    id: row.id,
    name: row.name,
    // 节点数不另存一列：从本体现算，存了就允许它与正文不一致（§2.5）。
    // 画布存过图之后**图**才是节点集合的真相（5.10-10），此时列表数的是图里的节点，
    // 否则会出现「列表说 3 格、画布打开是 5 格」这种第二状态源。
    nodeCount: storedGraph(row)?.nodes.length ?? plan.nodes.length,
    fingerprint: row.fingerprint,
    sourceRunId: row.source_run_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * 插入一条新计划。
 * @param db 主进程那一份唯一连接（由 `workflow.store` 递进来）
 * @param input 计划本体与归属
 * @returns 刚落库的读数
 * @throws id 已存在时 `SQLITE_CONSTRAINT_PRIMARYKEY` 由 SQLite 抛（调用方不吞：撞号是程序缺陷）
 */
export function insertPlan(db: DatabaseSync, input: SavedPlanInput): SavedWorkflowPlanView {
  db.prepare(
    `INSERT INTO workflow_plans (id, name, plan_json, fingerprint, source_run_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.name,
    JSON.stringify(input.plan),
    input.plan.fingerprint,
    input.sourceRunId,
    input.at,
    input.at,
  );
  const saved = getPlanRow(db, input.id);
  // 刚写完就读不出来只可能是表没建（迁移没跑），那时报得比 `undefined` 有用（5.1-d：禁止吞错返 undefined）。
  if (!saved)
    throw new AppError(
      'WORKFLOW_INVALID_STATE',
      `计划 ${input.id} 写入后读不回来（workflow_plans 表没建起来，迁移未挂载？）`,
      'workflow.store',
      { planId: input.id },
    );
  // 写后立刻按读路的那条判据过一遍：存进去的东西自己读不回来，比不存更糟——它会让人以为沉淀成功了。
  return toSavedPlanView(saved, planBody(saved));
}

/**
 * 列出全部自定义计划（按最后改动时间倒序，界面列表就是这个顺序）。
 *
 * 每一行都过 `planBody`：坏掉的一行会让这条口结构化失败，而不是继续出现在下拉里。
 * 这不是过度防御——「能选的就是能跑的」是 5.4-03 的判据，把一条跑不通的计划列进下拉，
 * 界面上那个选项按下去就是「有计划、开不了跑」的第二状态。
 * @param db 唯一连接
 * @returns 每条计划的列表读数；库里没有时为空数组（不是 null——「一条都没有」是一个读数）
 */
export function listPlans(db: DatabaseSync): SavedWorkflowPlanView[] {
  const rows = db
    .prepare('SELECT * FROM workflow_plans ORDER BY updated_at DESC, id ASC')
    .all() as unknown as PlanRow[];
  return rows.map((row) => toSavedPlanView(row, planBody(row)));
}

/** 库里的一行（内部用：既要视图也要原文）。 */
function getPlanRow(db: DatabaseSync, id: string): PlanRow | undefined {
  return db.prepare('SELECT * FROM workflow_plans WHERE id = ?').get(id) as PlanRow | undefined;
}

/**
 * 读一条计划：列表读数 + **可直接交给 runner 的本体**。
 *
 * 返回的是每次现 parse 出来的新对象，服务里不存 Map——存了就等于在进程里镜像一份库内事实，
 * 改配置重建下游时它会静默变空（AGENTS.md §9 的 2.5 实测条），而 5.4-06 的快照语义正是
 * 「界面上改掉的节点不许回头影响历史会话」，那件事的唯一强制手段就是没有人缓存它。
 * @param db 唯一连接
 * @param id 计划 id
 * @returns 读数与本体；库里没有时为 null（调用方按「不存在」回答，不抛）
 */
export function getPlan(db: DatabaseSync, id: string): { saved: SavedWorkflowPlanView; plan: WorkflowPlanView } | null {
  const row = getPlanRow(db, id);
  if (!row) return null;
  const plan = planBody(row);
  return { saved: toSavedPlanView(row, plan), plan };
}

/**
 * 改名（只动名字，不动 `plan_json`，所以**指纹不变**——改名不该让一条跑过的 run 失去它的计划读数）。
 * @param db 唯一连接
 * @param id 计划 id
 * @param rawName 新名字（内部过 `assertPlanName`）
 * @param at 改动时刻（毫秒）
 * @returns 改后的读数；库里没有这条时为 null
 */
export function renamePlan(db: DatabaseSync, id: string, rawName: string, at: number): SavedWorkflowPlanView | null {
  if (!getPlanRow(db, id)) return null;
  db.prepare('UPDATE workflow_plans SET name = ?, updated_at = ? WHERE id = ?').run(assertPlanName(rawName), at, id);
  const row = getPlanRow(db, id);
  return row ? toSavedPlanView(row, planBody(row)) : null;
}

/**
 * 删掉一条计划（spec 5.4-08 的删除——确认发生在界面，这里不管）。
 *
 * 只删这一行：`workflow_runs` 里那些跑过的 run 各带自己的 `plan_json` 快照，
 * 删掉计划不会让它们变成"有计划、无进度"的假象，也不会让历史进度凭空消失。
 * @param db 唯一连接
 * @param id 计划 id
 * @returns 真的删掉了一行为 true；本来就没有为 false（调用方按「不存在」回答）
 */
export function deletePlan(db: DatabaseSync, id: string): boolean {
  return db.prepare('DELETE FROM workflow_plans WHERE id = ?').run(id).changes > 0;
}

/** 覆盖保存一条计划的画布图时要带上的全部信息（spec 5.10-10）。 */
export type SavedGraphInput = {
  id: string;
  /** 已过保存前校验的图读数（`buildGraph` 的产物，边与节点都在同一份里）。 */
  graph: WorkflowGraphView;
  /** 画布落点，顺序不可信——`canonicalViewsText` 会按节点 id 排完再存。 */
  placements: readonly WorkflowNodePlacement[];
  /** 乐观并发凭据：与库里的 `revision` 不等就不写（见 `readPlanGraph` 的返回）。 */
  expectedRevision: number;
  /** 落库时刻（毫秒）；由调用方给，存储层不自己读钟（同其余写口）。 */
  at: number;
};

/**
 * 把库里的 `graph_json` 读成图读数。
 *
 * 只在 `is_custom=1` 且列非空时成立，否则返回 null 表示「这条计划没在画布上编辑过」——
 * 那时图由 `plan_json` 线性投影现算（5.10-02 的判据），而不是存一份重复的投影结果在库里。
 * @param row 库里的一行
 * @returns 重算过指纹的图；未编辑过时为 null
 * @throws 原文坏了、或图 id 与行 id 不符（那是写错了行，比读不出来更该炸）
 */
function storedGraph(row: PlanRow): WorkflowGraphView | null {
  if (Number(row.is_custom) !== 1 || row.graph_json === null) return null;
  const graph = buildGraph(JSON.parse(row.graph_json) as unknown);
  if (graph.id !== row.id) {
    throw new TypeError(`计划 ${row.id} 的 graph_json 里写的是 ${graph.id}，两条 id 不一致（写串行了）`);
  }
  return graph;
}

/**
 * 读一条计划的画布图：图 + 落点 + 版本号（spec 5.10-10 的"重启后画布重开同一张图"）。
 *
 * 每次现 parse、不在服务里存 Map：存了就等于在进程里镜像一份库内事实，改配置重建下游时它会静默变空
 * （AGENTS.md §9 的 2.5 实测条），而"重启读回逐字段一致"这条判据要的正是**库里**那份。
 * @param db 唯一连接
 * @param id 计划 id
 * @returns 画布读数；库里没有这条时为 null（调用方按「不存在」回答，不抛）
 */
export function readPlanGraph(db: DatabaseSync, id: string): WorkflowGraphLoadView | null {
  const row = getPlanRow(db, id);
  if (!row) return null;
  const stored = storedGraph(row);
  const graph = stored ?? projectPlanToGraph(planBody(row));
  const placements = stored
    ? (workflowViewsSchema.parse(JSON.parse(row.views_json ?? '[]')) as WorkflowNodePlacement[])
    : [];
  return { planId: id, graph, placements, revision: Number(row.revision), isCustom: stored !== null };
}

/**
 * 覆盖保存画布图（spec 5.10-10 的写入口，也是 5.10-05 五条校验的**服务端**那道闸）。
 *
 * 校验发生在调用方（`workflow.graph` 服务），这里只管"存进去的必须读得回来"：
 * `WHERE id = ? AND revision = ?` 让并发写变成 0 行改动而不是后写覆盖前写，随后按读路现查一遍，
 * 存进去自己读不回来比不存更糟——它会让人以为画布已经保存成功了。
 * @param db 唯一连接
 * @param input 图本体、落点、期望版本与时刻
 * @returns 保存后的版本号与指纹（界面拿它把 `expectedRevision` 跟上）
 * @throws `INVALID_ARGUMENT` 库里没有这条计划（内置那三条不在表里，要先复制）；
 *         `WORKFLOW_INVALID_STATE` 版本不符（别处已经改过）或写完读不回来
 */
export function savePlanGraph(db: DatabaseSync, input: SavedGraphInput): WorkflowGraphSaveView {
  const row = getPlanRow(db, input.id);
  if (!row) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `计划 ${input.id} 不存在，画布图无处可存（内置计划请先复制成自定义计划）`,
      'workflow.store',
      { planId: input.id },
    );
  }
  const current = Number(row.revision);
  if (current !== input.expectedRevision) {
    throw new AppError(
      'WORKFLOW_INVALID_STATE',
      `计划 ${input.id} 已被别处改过（库里是第 ${String(current)} 版，画布基于第 ${String(input.expectedRevision)} 版），本次保存未写入`,
      'workflow.store',
      { planId: input.id, revision: current, expectedRevision: input.expectedRevision },
    );
  }
  db.prepare(
    `UPDATE workflow_plans SET graph_json = ?, views_json = ?, is_custom = 1, revision = revision + 1, updated_at = ?
     WHERE id = ? AND revision = ?`,
  ).run(JSON.stringify(input.graph), canonicalViewsText(input.placements), input.at, input.id, input.expectedRevision);
  const saved = readPlanGraph(db, input.id);
  if (!saved) {
    throw new AppError(
      'WORKFLOW_INVALID_STATE',
      `计划 ${input.id} 的图写入后读不回来（workflow_plans 的画布列没建起来，号段 28 未挂载？）`,
      'workflow.store',
      { planId: input.id },
    );
  }
  return { planId: input.id, revision: saved.revision, fingerprint: saved.graph.fingerprint, updatedAt: input.at };
}
