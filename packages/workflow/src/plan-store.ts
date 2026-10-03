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
import { AppError, type SavedWorkflowPlanView, type WorkflowPlanView } from '@auto-cc/core';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
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
 * 没有 `revision` 列：本片的写入口只有新增 / 改名 / 复制 / 删除，没有一处会改节点内容，
 * 恒等于 1 的版本号没有消费者（AGENTS.md §2.6）。真出现覆盖保存时它才有意义，那时再加。
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

/** `workflow_plans` 一行的原始读数（列名与视图字段不同，转换收在 `toSavedPlanView` 一侧）。 */
type PlanRow = {
  id: string;
  name: string;
  plan_json: string;
  fingerprint: string;
  source_run_id: string | null;
  created_at: number | bigint;
  updated_at: number | bigint;
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
  if (!/^[\p{Script=Han}A-Za-z0-9 .,()\-_、：:·]+$/u.test(name)) {
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
    nodeCount: plan.nodes.length,
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
