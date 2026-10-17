/**
 * `workflow.store` 的落库用例（spec 2.4-01 / 2.4-05 / 2.4-06 / 2.4-10）。
 *
 * 一律打**真的 `node:sqlite`**（系统临时目录，不进仓库，AGENTS.md §7.5）：
 * 「已完成节点不重放」「幂等键唯一」「迁移可回滚」「中断后读回进度」这四件事都是数据库语义，
 * mock 掉就等于没测。崩溃留下的脏行也照真实形状手写进库里，而不是靠我们的写接口造一个干净态。
 */
import { asApp, Context, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BOSS_BASIC_PLAN, buildPlan } from './plan.js';
import { WORKFLOW_GRAPH_MIGRATION_VERSION, WORKFLOW_PLAN_MIGRATION_VERSION } from './plan-store.js';
import {
  WORKFLOW_CHECKPOINT_MIGRATION_VERSION,
  WORKFLOW_MIGRATION_VERSION,
  WORKFLOW_NODE_OUTPUT_MIGRATION_VERSION,
  WorkflowRunStoreService,
  type NodeOutcome,
} from './run-store.js';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 开一个系统临时目录并记账（用例结束后统一删除）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-run-store-'));
  sandboxes.push(dir);
  return dir;
}

/**
 * 挂起一套 config + store + workflow.store。
 * @param dir 库文件目录（省略则新开一个临时目录）
 * @returns 上下文、`store`、`workflow.store`、裸连接，以及本服务的 fiber（重启用例要先停它）
 */
async function boot(dir = tempDir()) {
  const ctx = new Context();
  const configFiber = await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  const storeFiber = await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' });
  const runFiber = await ctx.plugin(WorkflowRunStoreService, {});
  fibers.push(configFiber, storeFiber, runFiber);
  const app = asApp(ctx);
  return {
    ctx,
    runFiber,
    store: app.store,
    runs: app['workflow.store'],
    db: app.store.db,
    /** 关掉这一套的全部 fiber：同一目录重挂第二遍之前必须先关，连接不释放就锁住那个库文件。 */
    close: async () => {
      for (const fiber of [runFiber, storeFiber, configFiber]) await fiber.dispose();
    },
  };
}

/** 一次节点结束读数（除状态外全部给足，视图里看不到「有耗时没结束时间」这种半截行）。 */
function outcome(overrides: Partial<NodeOutcome> = {}): NodeOutcome {
  return {
    status: 'done',
    attempts: 1,
    startedAt: 1_000,
    finishedAt: 1_500,
    durationMs: 500,
    error: null,
    evidenceRef: null,
    sideEffect: null,
    ...overrides,
  };
}

afterAll(async () => {
  // 先释放 fiber（关连接）再删目录：Windows 上句柄延迟释放会挡住删除。
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不该把一次通过的验收判成失败。
    }
  }
});

describe('建表与迁移（spec 2.4-01，复用 2.3-05 的 down 路径判据）', () => {
  it('挂载即把工作流三张表建出来，schema 版本停在最高号段', async () => {
    const { store, db } = await boot();
    const tables = (
      db
        .prepare("select name from sqlite_master where type = 'table' and name like 'workflow_%' order by name")
        .all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    // `workflow_plans` 是 5.4-01 加的那张表，与 run 两张表同一个服务、另一个号段。
    // `workflow_node_checkpoints` 是 5.11-a 加的相位表。
    expect(tables).toEqual(['workflow_node_checkpoints', 'workflow_nodes', 'workflow_plans', 'workflow_runs']);
    // 5.11-a 起最高号段是 41（节点相位表）；本服务自己的号段仍以 29 为顶。
    expect(store.version).toBe(WORKFLOW_CHECKPOINT_MIGRATION_VERSION);
    // 号段是全局的（1=usage_ledger、2=chat、3=jobs、…、19=usage_denials），撞号只在运行期炸，所以钉在断言里。
    expect(WORKFLOW_MIGRATION_VERSION).toBe(4);
    expect(WORKFLOW_PLAN_MIGRATION_VERSION).toBe(20);
    expect(WORKFLOW_GRAPH_MIGRATION_VERSION).toBe(28);
  });

  it('幂等键上有唯一索引，孤儿行扫描与聚合各有一条支撑索引', async () => {
    const { db } = await boot();
    const indexes = (
      db.prepare("select name from sqlite_master where type = 'index' and tbl_name = 'workflow_nodes'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(indexes).toContain('workflow_nodes_idempotency');
    expect(indexes).toContain('workflow_nodes_kind');
    const runIndexes = (
      db.prepare("select name from sqlite_master where type = 'index' and tbl_name = 'workflow_runs'").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(runIndexes).toContain('workflow_runs_status');
  });

  it('重复挂载不会往共享迁移清单里塞第二个 v4 / v20，且重启后照样写得进去', async () => {
    const { ctx, store, runFiber } = await boot();
    // 两个号段各一条：push 的判据是「清单里有没有这个版本」，不是「有没有我这一支」，
    // 所以第二次挂载既不能把 v4 变成两条，也不能把 v20 变成两条（老库重跑迁移就是建表语句报错）。
    expect(store.migrations.filter((item) => item.version === WORKFLOW_MIGRATION_VERSION)).toHaveLength(1);
    expect(store.migrations.filter((item) => item.version === WORKFLOW_PLAN_MIGRATION_VERSION)).toHaveLength(1);
    expect(store.migrations.filter((item) => item.version === WORKFLOW_GRAPH_MIGRATION_VERSION)).toHaveLength(1);
    expect(store.migrations.filter((item) => item.version === WORKFLOW_NODE_OUTPUT_MIGRATION_VERSION)).toHaveLength(1);
    expect(store.migrations.filter((item) => item.version === WORKFLOW_CHECKPOINT_MIGRATION_VERSION)).toHaveLength(1);
    await runFiber.dispose();
    fibers.push(await ctx.plugin(WorkflowRunStoreService, {}));
    expect(store.migrations.filter((item) => item.version === WORKFLOW_MIGRATION_VERSION)).toHaveLength(1);
    expect(store.migrations.filter((item) => item.version === WORKFLOW_PLAN_MIGRATION_VERSION)).toHaveLength(1);
    expect(store.migrations.filter((item) => item.version === WORKFLOW_GRAPH_MIGRATION_VERSION)).toHaveLength(1);
    expect(store.migrations.filter((item) => item.version === WORKFLOW_NODE_OUTPUT_MIGRATION_VERSION)).toHaveLength(1);
    expect(store.migrations.filter((item) => item.version === WORKFLOW_CHECKPOINT_MIGRATION_VERSION)).toHaveLength(1);
    expect(store.version).toBe(WORKFLOW_CHECKPOINT_MIGRATION_VERSION);
    // 必须拿**新**实例读写：旧句柄的 ctx 已经 inactive，用它调用会在 cordis 层就失败（实测过一次），
    // 而「重启后照样能用」要证的正是新实例，不是旧壳子。
    const again = asApp(ctx)['workflow.store'];
    again.openRun('r-again', buildPlan(BOSS_BASIC_PLAN), 2_000);
    expect(again.state('r-again')?.status).toBe('running');
  });

  it('回滚把工作流三张表一起丢掉，再升级又建得回来（down 路径实测）', async () => {
    const { store, db, runs } = await boot();
    runs.openRun('r-rollback', buildPlan(BOSS_BASIC_PLAN), 1_000);
    expect(runs.state('r-rollback')).not.toBeNull();

    const back = store.rollback(WORKFLOW_MIGRATION_VERSION - 1);
    // 倒序回滚：41（节点相位表）→ 29（节点出口句柄）→ 28（画布那四列）→ 20（计划表）→ 4（run 两张表），
    // 各支的 down 只管自己那一份。
    expect(back.reverted).toEqual([
      WORKFLOW_CHECKPOINT_MIGRATION_VERSION,
      WORKFLOW_NODE_OUTPUT_MIGRATION_VERSION,
      WORKFLOW_GRAPH_MIGRATION_VERSION,
      WORKFLOW_PLAN_MIGRATION_VERSION,
      WORKFLOW_MIGRATION_VERSION,
    ]);
    expect(store.version).toBe(WORKFLOW_MIGRATION_VERSION - 1);
    const leftovers = db
      .prepare("select name from sqlite_master where type in ('table','index') and name like 'workflow_%'")
      .all() as { name: string }[];
    expect(leftovers).toEqual([]);
    // 查询直接失败在 sqlite 层：这是「表真的不在了」的证据，不是我们的判断。
    expect(() => runs.state('r-rollback')).toThrowError(/no such table/);

    expect(store.upgrade().applied).toEqual([
      WORKFLOW_MIGRATION_VERSION,
      WORKFLOW_PLAN_MIGRATION_VERSION,
      WORKFLOW_GRAPH_MIGRATION_VERSION,
      WORKFLOW_NODE_OUTPUT_MIGRATION_VERSION,
      WORKFLOW_CHECKPOINT_MIGRATION_VERSION,
    ]);
    expect(runs.state('r-rollback')).toBeNull();
    // 升级回来的不只是 run 表：计划表也必须建得回来，否则老库回滚再升级会得出「能跑、存不了」。
    runs.savePlan({
      id: 'plan-rollback',
      name: '回滚后仍可写',
      plan: buildPlan(BOSS_BASIC_PLAN),
      sourceRunId: null,
      at: 2_000,
    });
    expect(runs.listPlans().map((plan) => plan.id)).toEqual(['plan-rollback']);
  });

  it('节点行写下出口句柄后能原样读回，重跑不记时把它清空（号段 29 的读写闭环）', async () => {
    const { runs } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    runs.openRun('r-output', plan, 1_000);
    runs.claimNode('r-output', 0, plan.nodes[0]!, 1_000);
    runs.recordNode('r-output', 0, outcome({ output: 'yes' }));
    // 续跑重建推进态读的就是这一格（spec 5.10-13）：读不回来就等于把当年走的出口丢了。
    expect(runs.state('r-output')?.nodes[0]?.outputHandle).toBe('yes');
    // 第二次尝试没给句柄 → 列必须是 NULL，留着上一轮的 'yes' 会把「换了出口」读成「没变」。
    runs.recordNode('r-output', 0, outcome({ status: 'failed', error: 'boom' }));
    expect(runs.state('r-output')?.nodes[0]?.outputHandle).toBeNull();
  });
});

describe('节点相位（spec 5.11-01，号段 41）', () => {
  it('号段 41 与 §9 已登记的那几支不撞，空库与老库两种情形都建出表', async () => {
    const dir = tempDir();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    const first = await boot(dir);
    // 39/38 属 4.11 的 JD 变体轨、40 属简历事实那支（AGENTS.md §9 的 5.3-a 清单）。
    // 判据要求的「两种声明形状都 grep 过」是仓面读数，记在
    // docs/acceptance/5.11/5.11-01-migration-slot.txt；这里是常量本身的钉死。
    expect(WORKFLOW_CHECKPOINT_MIGRATION_VERSION).toBe(41);
    expect(
      first.db.prepare("select name from sqlite_master where type='table' and name='workflow_node_checkpoints'").get(),
    ).toMatchObject({ name: 'workflow_node_checkpoints' });

    // 老库形状：把 41 退掉，库里就只剩「已跑过老迁移」的现场（台账最高 40、相位表没了）。
    expect(first.store.rollback(WORKFLOW_CHECKPOINT_MIGRATION_VERSION - 1).reverted).toEqual([
      WORKFLOW_CHECKPOINT_MIGRATION_VERSION,
    ]);
    expect(
      first.db.prepare("select name from sqlite_master where type='table' and name='workflow_node_checkpoints'").get(),
    ).toBeUndefined();
    await first.close();

    // 再挂一次：这一支必须真的执行，而不是因为「看着像跑过了」被跳过。
    const second = await boot(dir);
    expect(second.store.version).toBe(WORKFLOW_CHECKPOINT_MIGRATION_VERSION);
    expect(
      second.db.prepare("select name from sqlite_master where type='table' and name='workflow_node_checkpoints'").get(),
    ).toMatchObject({ name: 'workflow_node_checkpoints' });
    second.runs.openRun('r-oldlib', plan, 1_000);
    expect(second.runs.claimNode('r-oldlib', 2, plan.nodes[2]!, 1_000)).toBe('granted');
    expect(second.runs.readPhases('r-oldlib', 2)).toEqual(['nodeStarted']);
  });

  it('claimNode 与副作用位同事务：崩在两句之间时两处都不变', async () => {
    const { runs, db } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    runs.openRun('r-tx', plan, 1_000);

    // 新节点那一支：节点行先 INSERT、相位行后写。把相位表抽掉就是「崩在两句之间」的真实形状
    // （迁移没跑成 / 库是从别处拷来的半份），node:sqlite 直接在写相位那一句上报错。
    db.exec('DROP TABLE workflow_node_checkpoints');
    expect(() => runs.claimNode('r-tx', 2, plan.nodes[2]!, 1_000)).toThrowError(/no such table/);
    // 两张表都要是「没变」：只断言相位表空着不够——那正是不做事务时的样子。
    expect(runs.state('r-tx')?.nodes.map((node) => node.status)).toEqual(['pending', 'pending', 'pending']);
    expect(
      db
        .prepare("select count(*) as total from sqlite_master where type='table' and name='workflow_node_checkpoints'")
        .get(),
    ).toMatchObject({ total: 0 });

    // 重试那一支：UPDATE 已自增过 attempts，回滚后必须连自增一起退回去。
    db.exec(
      `CREATE TABLE workflow_node_checkpoints (
         run_id TEXT NOT NULL, node_index INTEGER NOT NULL, phase TEXT NOT NULL, at INTEGER NOT NULL,
         PRIMARY KEY (run_id, node_index, phase))`,
    );
    runs.claimNode('r-tx', 2, plan.nodes[2]!, 1_000);
    runs.recordNode('r-tx', 2, outcome({ status: 'failed', error: '第 1 次失败', sideEffect: null }));
    db.exec('DROP TABLE workflow_node_checkpoints');
    expect(() => runs.claimNode('r-tx', 2, plan.nodes[2]!, 2_000)).toThrowError(/no such table/);
    expect(runs.state('r-tx')?.nodes[2]).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: '第 1 次失败',
    });
  });

  it('只有会动外面世界的节点记相位，只读节点记了只会让续跑误判', async () => {
    const { runs, db } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    runs.openRun('r-phase', plan, 1_000);
    runs.claimNode('r-phase', 0, plan.nodes[0]!, 1_000);
    runs.claimNode('r-phase', 1, plan.nodes[1]!, 1_000);
    runs.claimNode('r-phase', 2, plan.nodes[2]!, 1_000);

    // 同一个判据落在两张表上：只读节点不占副作用位，也不占相位。
    expect(runs.state('r-phase')?.nodes.map((node) => node.sideEffect)).toEqual([null, null, 'started']);
    expect(runs.readPhases('r-phase', 0)).toEqual([]);
    expect(runs.readPhases('r-phase', 1)).toEqual([]);
    expect(runs.readPhases('r-phase', 2)).toEqual(['nodeStarted']);
    expect(db.prepare('select count(*) as total from workflow_node_checkpoints').get()).toMatchObject({ total: 1 });

    // 重试是新的尝试：同相位覆盖时间戳而不是追加，否则「派发过几次」会被误读成相位前进。
    // 走 force=true 那一条（用户在接管点上确认过重试，2.4-05 的路径）：相位要跟着新尝试一起刷新。
    // 这里不断言「自动重试给什么判决」——那个判决从 5.11-b 起由相位参与，逐个方向由下一组用例证。
    runs.recordNode('r-phase', 2, outcome({ status: 'failed', error: 'boom' }));
    expect(runs.claimNode('r-phase', 2, plan.nodes[2]!, 9_000, true)).toBe('granted');
    expect(runs.readPhases('r-phase', 2)).toEqual(['nodeStarted']);
    expect(db.prepare('select at from workflow_node_checkpoints where node_index = 2').get()).toMatchObject({
      at: 9_000,
    });
  });

  it('落地被观察到时补 sideEffectObserved，结局落定才补 nodeCommitted', async () => {
    const { runs } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    runs.openRun('r-obs', plan, 1_000);
    runs.claimNode('r-obs', 2, plan.nodes[2]!, 1_000);
    // 第一次尝试挂在后置步骤上，但外发确实已经发生——这正是 `sideEffectObserved` 的那一刻。
    runs.recordNode('r-obs', 2, outcome({ status: 'failed', sideEffect: 'done', error: '后置步骤出错' }));
    expect(runs.readPhases('r-obs', 2)).toEqual(['nodeStarted', 'sideEffectObserved']);
    // 结局是 failed 就不算提交：节点还没落定。
    expect(runs.readPhases('r-obs', 2)).not.toContain('nodeCommitted');

    // 换一次干净的 run 看成功那一侧：三相位齐了。
    runs.openRun('r-obs-done', plan, 1_000);
    runs.claimNode('r-obs-done', 2, plan.nodes[2]!, 1_000);
    runs.recordNode('r-obs-done', 2, outcome({ sideEffect: 'done' }));
    expect(runs.readPhases('r-obs-done', 2)).toEqual(['nodeStarted', 'sideEffectObserved', 'nodeCommitted']);
    // 只读节点没有副作用位，但结局落定照样提交——`nodeCommitted` 说的是节点，不是外发。
    runs.openRun('r-obs-read', plan, 1_000);
    runs.claimNode('r-obs-read', 0, plan.nodes[0]!, 1_000);
    runs.recordNode('r-obs-read', 0, outcome());
    expect(runs.readPhases('r-obs-read', 0)).toEqual(['nodeCommitted']);
  });
});

describe('续跑判决读相位（spec 5.11-02，行为零变化）', () => {
  it('三个来源方向各一条：相位与列都指向动过手 → 拒绝；只有老库的列 → 也拒绝；两处都没有 → 放行', async () => {
    const { runs, db } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    const flaky = plan.nodes[2]!;

    // 一、新写入的行：相位与列一致，仍然是 needs-human（这一条与改前逐字同判）。
    runs.openRun('r-new', plan, 1_000);
    runs.claimNode('r-new', 2, flaky, 1_000);
    runs.recordNode('r-new', 2, outcome({ status: 'failed', sideEffect: 'done', error: '后置步骤出错' }));
    expect(runs.readPhases('r-new', 2)).toEqual(['nodeStarted', 'sideEffectObserved']);
    expect(runs.claimNode('r-new', 2, flaky, 2_000)).toBe('needs-human');

    // 二、号段 41 之前的老库行：相位表里一条都没有，只有 `side_effect='started'`。
    // 把相位行删掉就是那种库的真实形状——只看相位会把它误判成「能证明未派发」而放行，
    // 那正是把闸门放松。取并集之后判决与改前完全一致。
    runs.openRun('r-legacy', plan, 1_000);
    runs.claimNode('r-legacy', 2, flaky, 1_000);
    runs.recordNode('r-legacy', 2, outcome({ status: 'failed', error: '崩了', sideEffect: null }));
    db.prepare("UPDATE workflow_nodes SET side_effect = 'started' WHERE run_id = 'r-legacy' AND node_index = 2").run();
    db.prepare("DELETE FROM workflow_node_checkpoints WHERE run_id = 'r-legacy' AND node_index = 2").run();
    expect(runs.readPhases('r-legacy', 2)).toEqual([]);
    expect(runs.claimNode('r-legacy', 2, flaky, 2_000)).toBe('needs-human');

    // 三、既没有相位、`side_effect` 又是 NULL：这就是「能证明未派发」的形状，照常放行。
    runs.openRun('r-fresh', plan, 1_000);
    runs.claimNode('r-fresh', 2, flaky, 1_000);
    runs.recordNode('r-fresh', 2, outcome({ status: 'failed', error: '只读失败', sideEffect: null }));
    db.prepare("DELETE FROM workflow_node_checkpoints WHERE run_id = 'r-fresh' AND node_index = 2").run();
    expect(runs.claimNode('r-fresh', 2, flaky, 2_000)).toBe('granted');
    // 放行之后这次尝试重新落相位：从此它就是「可能动过手」的了。
    expect(runs.readPhases('r-fresh', 2)).toEqual(['nodeStarted']);
  });

  it('人工确认放行的那一次重放照常写闸门日志与新相位（force 分支不被相位挡住）', async () => {
    const { runs } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    const flaky = plan.nodes[2]!;
    runs.openRun('r-force', plan, 1_000);
    runs.claimNode('r-force', 2, flaky, 1_000);
    runs.recordNode('r-force', 2, outcome({ status: 'failed', sideEffect: 'done', error: '后置步骤出错' }));
    expect(runs.claimNode('r-force', 2, flaky, 2_000)).toBe('needs-human');
    // force=true 是用户在接管点上按过重试的路径（2.4-05）：相位不许把它也拦下。
    expect(runs.claimNode('r-force', 2, flaky, 3_000, true)).toBe('granted');
    expect(runs.state('r-force')?.nodes[2]).toMatchObject({ status: 'running', attempts: 2 });
  });

  it('已提交的节点重放仍是 already-done，不因有相位而改判（2.4-05 的基线）', async () => {
    const { runs } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    runs.openRun('r-committed', plan, 1_000);
    runs.claimNode('r-committed', 2, plan.nodes[2]!, 1_000);
    runs.recordNode('r-committed', 2, outcome({ sideEffect: 'done' }));
    expect(runs.readPhases('r-committed', 2)).toContain('nodeCommitted');
    expect(runs.claimNode('r-committed', 2, plan.nodes[2]!, 2_000)).toBe('already-done');
    expect(runs.state('r-committed')?.nodes[2]).toMatchObject({ status: 'done', attempts: 1 });
  });
});

describe('run 与节点的序列化（spec 2.4-01）', () => {
  it('开一次 run 就能读回整份计划，没跑过的节点补成 pending 槽位', async () => {
    const { runs } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    runs.openRun('r-1', plan, 1_000);
    const state = runs.state('r-1');
    expect(state).not.toBeNull();
    expect(state).toMatchObject({
      runId: 'r-1',
      planId: 'boss-basic',
      planFingerprint: plan.fingerprint,
      status: 'running',
      nodeIndex: 0,
      totalNodes: 3,
      startedAt: 1_000,
      finishedAt: null,
      lastError: null,
    });
    // 界面画槽位要的是「计划里有几个节点」，所以一个都没跑时视图里也得有三行 pending。
    expect(state?.nodes.map((node) => node.status)).toEqual(['pending', 'pending', 'pending']);
    expect(state?.nodes.map((node) => node.nodeId)).toEqual(['jd-capture', 'jd-list', 'flaky']);
    expect(state?.nodes[2]).toMatchObject({ attempts: 0, effect: 'local-write', sideEffect: null });
  });

  it('同一 runId 重复 openRun 是幂等的，不会把开始时间与进度冲掉', async () => {
    const { runs } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    runs.openRun('r-keep', plan, 1_000);
    runs.claimNode('r-keep', 0, plan.nodes[0]!, 2_000);
    runs.recordNode('r-keep', 0, outcome());
    runs.updateRun('r-keep', { status: 'running', nodeIndex: 1, finishedAt: null, lastError: null });
    runs.openRun('r-keep', plan, 9_999);
    expect(runs.state('r-keep')).toMatchObject({ startedAt: 1_000, nodeIndex: 1 });
  });

  it('库里的计划文本被写坏时拒绝读数，不返回半条计划', async () => {
    const { runs, db } = await boot();
    runs.openRun('r-corrupt', buildPlan(BOSS_BASIC_PLAN), 1_000);
    db.prepare('UPDATE workflow_runs SET plan_json = ? WHERE run_id = ?').run('{"id":"x","nodes":[]}', 'r-corrupt');
    expect(() => runs.state('r-corrupt')).toThrowError(/计划读数已损坏/);
  });

  it('计划文本被改过而指纹列没跟上时拒绝读数（2.4-05 的串档判据落在库层）', async () => {
    const { runs, db } = await boot();
    runs.openRun('r-tamper', buildPlan(BOSS_BASIC_PLAN), 1_000);
    // 只改节点参数、不改 `plan_fingerprint` 列：真实串档就是这个形状——文本动了，登记还是旧的。
    db.prepare(
      "UPDATE workflow_runs SET plan_json = json_set(plan_json, '$.nodes[0].params.query', '后端工程师') WHERE run_id = ?",
    ).run('r-tamper');
    expect(() => runs.state('r-tamper')).toThrowError(/指纹不一致/);
  });

  it('状态推进把节点读数原样存回，bigint 出口收成 number', async () => {
    const { runs, db } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    runs.openRun('r-2', plan, 1_000);
    runs.claimNode('r-2', 0, plan.nodes[0]!, 1_000);
    runs.recordNode('r-2', 0, outcome({ evidenceRef: 'evidence/r-2-jd-capture/dom.txt' }));
    // 手写一个 bigint 形状的读数：真实库里 `attempts` 可能以 bigint 回来，视图必须过结构化克隆。
    db.prepare("UPDATE workflow_nodes SET duration_ms = 900 WHERE run_id = 'r-2' AND node_index = 0").run();
    const node = runs.state('r-2')?.nodes[0];
    expect(node).toMatchObject({
      status: 'done',
      attempts: 1,
      durationMs: 900,
      evidenceRef: 'evidence/r-2-jd-capture/dom.txt',
      // 只读节点不占副作用位：它的 `started` 毫无意义，还会挡住重试（spec 2.4-06 只管内动外面世界的）。
      sideEffect: null,
    });
    expect(() => structuredClone(node)).not.toThrow();
  });
});

describe('已完成不重放与拒绝盲重放（spec 2.4-05 / 2.4-06）', () => {
  it('跑完的节点再 claim 一律 already-done，且不新增尝试次数', async () => {
    const { runs } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    runs.openRun('r-3', plan, 1_000);
    expect(runs.claimNode('r-3', 0, plan.nodes[0]!, 1_000)).toBe('granted');
    runs.recordNode('r-3', 0, outcome());
    expect(runs.claimNode('r-3', 0, plan.nodes[0]!, 2_000)).toBe('already-done');
    expect(runs.state('r-3')?.nodes[0]).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('失败的节点重试沿用同一行并把 attempts 加一（spec 2.4-03 的落库侧）', async () => {
    const { runs, db } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    runs.openRun('r-4', plan, 1_000);
    const flaky = plan.nodes[2]!;
    runs.claimNode('r-4', 2, flaky, 1_000);
    runs.recordNode('r-4', 2, outcome({ status: 'failed', error: '第 1 次失败', sideEffect: null }));
    // 崩溃在「已经动手、还没观察到完成」的窗口里：库里因此留着 side_effect='started'。
    db.prepare("UPDATE workflow_nodes SET side_effect = 'started' WHERE run_id = 'r-4' AND node_index = 2").run();
    expect(runs.claimNode('r-4', 2, flaky, 2_000)).toBe('needs-human');
    // 被拒绝的这次不消耗尝试次数，也不把错误清空——它一次都没跑。
    expect(runs.state('r-4')?.nodes[2]).toMatchObject({ status: 'failed', attempts: 1, error: '第 1 次失败' });
  });

  it('副作用位从 started 落到 done：一旦落过就永远拒绝自动重放', async () => {
    const { runs } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    runs.openRun('r-5', plan, 1_000);
    const flaky = plan.nodes[2]!;
    runs.claimNode('r-5', 2, flaky, 1_000);
    expect(runs.state('r-5')?.nodes[2]?.sideEffect).toBe('started');
    // 节点因别的原因失败（例如后置步骤出错），但外发确实已经发生：这行永远不能再自动重放。
    runs.recordNode('r-5', 2, outcome({ status: 'failed', sideEffect: 'done', error: '后置步骤出错' }));
    expect(runs.claimNode('r-5', 2, flaky, 2_000)).toBe('needs-human');
  });

  it('同一目标在两个位置出现时，幂等键挡住第二次外发（库层不信任调用方）', async () => {
    const { runs } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    const flaky = plan.nodes[2]!;
    runs.openRun('r-6', plan, 1_000);
    runs.claimNode('r-6', 2, flaky, 1_000);
    runs.recordNode('r-6', 2, outcome({ sideEffect: 'done' }));
    // 「同 nodeId + 同 target 却排在另一个下标」只能由「计划被改过却仍在同一个 run 上续跑」产生。
    // 那种串档在 runner 层由指纹拒绝（2.4-05），这里验的是数据库不依赖上游的自觉。
    expect(runs.claimNode('r-6', 1, flaky, 2_000)).toBe('already-done');
    expect(runs.state('r-6')?.nodes.map((node) => node.status)).toEqual(['pending', 'pending', 'done']);
  });
});

describe('中断扫描与续跑起点（spec 2.4-05）', () => {
  it('进程重启后把在途的 run 判成 interrupted，并把进度原样读回来', async () => {
    const { runs } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    runs.openRun('r-7', plan, 1_000);
    runs.claimNode('r-7', 0, plan.nodes[0]!, 1_000);
    runs.recordNode('r-7', 0, outcome());
    runs.updateRun('r-7', { status: 'running', nodeIndex: 1, finishedAt: null, lastError: null });
    // 第 2 个节点**只声明不落账**：这就是被 kill 的瞬间留下的形状——开始动作已经登记，结局永远没写回来。
    runs.claimNode('r-7', 1, plan.nodes[1]!, 2_000);
    // 这里不调用任何「模拟崩溃」的写接口：库里留着 status='running' 就是被 kill 之后的真实形状。
    expect(runs.markInterrupted(5_000)).toEqual(['r-7']);
    const state = runs.state('r-7');
    expect(state).toMatchObject({
      status: 'interrupted',
      nodeIndex: 1,
      finishedAt: 5_000,
      lastError: 'RUN_INTERRUPTED',
    });
    expect(state?.nodes.map((node) => node.status)).toEqual(['done', 'running', 'pending']);
    // 第二次扫描不能再报同一个 run：它已经不是 running 了。
    expect(runs.markInterrupted(6_000)).toEqual([]);
  });

  it('续跑起点按指纹挑选，计划改过就不给续', async () => {
    const { runs } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    runs.openRun('r-8', plan, 1_000);
    runs.markInterrupted(2_000);
    expect(runs.resumeCandidate(plan.fingerprint)).toEqual({
      runId: 'r-8',
      planFingerprint: plan.fingerprint,
      nodeIndex: 0,
    });
    // 换一条计划（节点参数变了）之后，那次中断就不该再被续——从错误的第 i 个节点瞎续比重新跑更糟。
    const edited = buildPlan({ ...BOSS_BASIC_PLAN, nodes: [{ id: 'a', kind: 'jd.capture', effect: 'read' }] });
    expect(runs.resumeCandidate(edited.fingerprint)).toBeNull();
    // 指定 runId 的续跑路径不做指纹筛选（由 runner 拿着 `state()` 比对后拒绝），这里只证明它找得到行。
    expect(runs.resumeCandidate('whatever', 'r-8')?.runId).toBe('r-8');
  });

  it('跑完的 run 不再出现在续跑候选里', async () => {
    const { runs } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    runs.openRun('r-9', plan, 1_000);
    runs.markInterrupted(2_000);
    expect(runs.resumeCandidate(plan.fingerprint)?.runId).toBe('r-9');
    runs.updateRun('r-9', { status: 'done', nodeIndex: 3, finishedAt: 3_000, lastError: null });
    expect(runs.resumeCandidate(plan.fingerprint)).toBeNull();
  });
});

describe('聚合与保留（spec 2.4-10）', () => {
  it('耗时与成功率按执行器聚合，没有结局的节点不拉低成功率', async () => {
    const { runs } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    runs.openRun('r-a', plan, 1_000);
    runs.claimNode('r-a', 0, plan.nodes[0]!, 1_000);
    runs.recordNode('r-a', 0, outcome({ durationMs: 400 }));
    runs.claimNode('r-a', 1, plan.nodes[1]!, 1_500);
    runs.recordNode('r-a', 1, outcome({ status: 'failed', attempts: 3, durationMs: 200, error: '读列表超时' }));
    runs.claimNode('r-a', 2, plan.nodes[2]!, 2_000);
    // 第 3 个节点还停在 running（没结局），它不该进分母。
    const byKind = new Map(runs.stats().map((row) => [row.kind, row]));
    expect(byKind.get('jd.capture')).toMatchObject({
      nodes: 1,
      done: 1,
      failed: 0,
      successRate: 1,
      avgDurationMs: 400,
    });
    expect(byKind.get('jd.list')).toMatchObject({ nodes: 1, done: 0, failed: 1, successRate: 0, avgAttempts: 3 });
    expect(byKind.get('demo.flaky')).toMatchObject({ nodes: 1, done: 0, failed: 0, successRate: null });
  });

  it('空表聚合回空列表，不编出一个全零的执行器', async () => {
    const { runs } = await boot();
    expect(runs.stats()).toEqual([]);
  });

  it('保留上限之外的 run 连同节点行一起清掉，并回报被清的 id', async () => {
    const { runs, db } = await boot();
    const plan = buildPlan(BOSS_BASIC_PLAN);
    // 开始时间按序拉开：`started_at DESC` 在同一毫秒里的排序不稳定，用它判新旧就是在赌。
    for (const [offset, runId] of ['r-old', 'r-mid', 'r-new'].entries()) {
      runs.openRun(runId, plan, 1_000 + offset);
      runs.claimNode(runId, 0, plan.nodes[0]!, 1_000 + offset);
    }
    expect(runs.prune(2)).toEqual(['r-old']);
    expect(runs.state('r-old')).toBeNull();
    expect(runs.state('r-new')?.status).toBe('running');
    // 子表不能留孤儿行：`state()` 读不到 run 行时压根不会去查节点，所以用裸 SQL 证明它真的空了。
    const orphan = db.prepare('SELECT COUNT(*) AS n FROM workflow_nodes WHERE run_id = ?').get('r-old') as {
      n: number;
    };
    expect(orphan.n).toBe(0);
    // 全都在保留窗口内时一次都不删，也不报账。
    expect(runs.prune(10)).toEqual([]);
  });
});
