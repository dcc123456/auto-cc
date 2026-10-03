/**
 * 自定义计划存储层用例（spec 5.4-01 的落库半边 / 05 / 06 / 08 的存储半边）。
 *
 * 与 `run-store.test.ts` 同一口径：打**真的 `node:sqlite`**（系统临时目录，产物不进仓库，§7.5）。
 * 「改名不动指纹」「删计划不影响历史 run」「坏掉的一行读不回来」这三件事全是数据库语义，
 * mock 掉存储等于没测。5.4-08 的界面半边（列表、二次确认）由 5.4-b 的 harness 验收判，这里不越界。
 *
 * 一律用内置 `boss-basic` 的节点表当素材，不碰任何平台包（AGENTS.md §7.2）。
 */
import { asApp, Context, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { BOSS_BASIC_PLAN, buildPlan } from './plan.js';
import { assertPlanName, newPlanId } from './plan-store.js';
import { WorkflowRunStoreService, type NodeOutcome } from './run-store.js';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 开一个系统临时目录并记账（用例结束后统一删除）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-plan-store-'));
  sandboxes.push(dir);
  return dir;
}

/**
 * 挂起一套 config + store + workflow.store（计划表就长在这一个服务上）。
 * @returns 上下文、`workflow.store` 句柄与裸连接（要演「库被改坏」必须绕过写入口）
 */
async function boot() {
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir: tempDir(), file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(WorkflowRunStoreService, {}));
  const app = asApp(ctx);
  return { ctx, runs: app['workflow.store'], db: app.store.db };
}

/** 一次节点结束读数（除状态外全部给足，与 `run-store.test.ts` 同一口径）。 */
function outcome(overrides: Partial<NodeOutcome> = {}): NodeOutcome {
  return {
    status: 'done',
    attempts: 1,
    startedAt: 1_100,
    finishedAt: 1_600,
    durationMs: 500,
    error: null,
    evidenceRef: null,
    sideEffect: null,
    ...overrides,
  };
}

/**
 * 存一条计划的最短写法（计划本体取内置那条的节点表）。
 * @param runs `workflow.store` 句柄
 * @param id 计划 id
 * @param name 名字
 * @param at 落库时刻（毫秒）
 * @returns 刚落库的读数
 */
function save(runs: WorkflowRunStoreService, id: string, name: string, at: number) {
  return runs.savePlan({ id, name, plan: buildPlan({ id, nodes: BOSS_BASIC_PLAN.nodes }), sourceRunId: 'run-src', at });
}

/**
 * 把库里那行的计划原文换成任意文本（绕过写入口，演的是「库被改过」而不是「我们写坏了」）。
 * @param db 裸连接
 * @param id 计划 id
 * @param text 新的 `plan_json` 值
 */
function rewritePlanText(db: DatabaseSync, id: string, text: string): void {
  db.prepare('UPDATE workflow_plans SET plan_json = ? WHERE id = ?').run(text, id);
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

describe('名字校验（spec 5.4-05）', () => {
  it('首尾空格被去掉，中间空格留着', () => {
    expect(assertPlanName('  早班会打招呼  ')).toBe('早班会打招呼');
    expect(assertPlanName('Boss 直聘 基础流')).toBe('Boss 直聘 基础流');
  });

  it('空 / 只有空格 → 拒，并说清是「不能为空」', () => {
    expect(() => assertPlanName('')).toThrowError(/不能为空/);
    expect(() => assertPlanName('   ')).toThrowError(/不能为空/);
  });

  it('40 字正好通过、41 字拒（上限就是列表那一列放得下的长度）', () => {
    const atLimit = '字'.repeat(40);
    expect(assertPlanName(atLimit)).toBe(atLimit);
    expect(() => assertPlanName('字'.repeat(41))).toThrowError(/不能超过 40 个字符（当前 41）/);
  });

  it('汉字 / 字母 / 数字 / 空格与常见标点都收', () => {
    const allowed = 'Boss3 直聘：前端、JD(基础)_流-v1.2·投递';
    expect(assertPlanName(allowed)).toBe(allowed);
  });

  it('全角括号 （） 与半角 () 同等收（中文输入法打出来的就是全角，5.4-b 实测撞过）', () => {
    expect(assertPlanName('搜上海前端打招呼（改名后）')).toBe('搜上海前端打招呼（改名后）');
  });

  it('引号、尖括号、路径分隔符、控制字符一律拒（它们目前没有消费者）', () => {
    for (const illegal of ['a"b', "a'b", '<script>', 'a/b', 'a\\b', 'a\nb', 'a;b', '|cat', 'a$b', '`x`', '岗位*']) {
      expect(() => assertPlanName(illegal)).toThrowError(/不被允许的字符/);
    }
  });
});

describe('计划 id（不与内置目录撞形）', () => {
  it('前缀 `plan-` + 12 位十六进制，连发 200 个不重号', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const id = newPlanId();
      expect(id).toMatch(/^plan-[0-9a-f]{12}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(200);
  });
});

describe('存与读（spec 5.4-01 的落库半边）', () => {
  it('写一条就能读回：节点数从正文现算、指纹取计划本体重算的那份', async () => {
    const { runs } = await boot();
    const saved = save(runs, 'plan-a', '基础流', 1_000);
    const plan = buildPlan({ id: 'plan-a', nodes: BOSS_BASIC_PLAN.nodes });
    expect(saved).toEqual({
      id: 'plan-a',
      name: '基础流',
      fingerprint: plan.fingerprint,
      nodeCount: plan.nodes.length,
      sourceRunId: 'run-src',
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    // 本体读得回来，而且节点顺序与声明一致（runner 按下标起格子，顺序漂了就错位在别的节点上）。
    expect(runs.getPlan('plan-a')?.plan.nodes.map((node) => node.id)).toEqual(plan.nodes.map((node) => node.id));
    // 每次现读：两次 `getPlan` 交出的不是同一个对象，服务里没有那份内存镜像（§9 的 2.5 实测条）。
    expect(runs.getPlan('plan-a')?.plan).not.toBe(runs.getPlan('plan-a')?.plan);
  });

  it('库里没有这条时读回 null，而不是抛（「不存在」是一个读数）', async () => {
    const { runs } = await boot();
    expect(runs.getPlan('plan-none')).toBeNull();
  });

  it('表里只有那七列，没有 revision（覆盖保存在 5.4 没有消费者，§2.6）', async () => {
    const { db } = await boot();
    const columns = (db.prepare('PRAGMA table_info(workflow_plans)').all() as { name: string }[]).map(
      (col) => col.name,
    );
    expect(columns).toEqual(['id', 'name', 'plan_json', 'fingerprint', 'source_run_id', 'created_at', 'updated_at']);
  });

  it('列表按最后改动时间倒序，同一时刻按 id 升序（界面顶部就是刚刚动过的那条）', async () => {
    const { runs } = await boot();
    save(runs, 'plan-b', '乙', 2_000);
    save(runs, 'plan-a', '甲', 3_000);
    save(runs, 'plan-c', '丙', 2_000);
    // 同一时刻的两条按 id 升序兜底，界面顺序因此永远稳定。
    expect(runs.listPlans().map((plan) => plan.id)).toEqual(['plan-a', 'plan-b', 'plan-c']);
    expect(runs.listPlans().map((plan) => plan.name)).toEqual(['甲', '乙', '丙']);
  });

  it('空表读成空数组：一条都没有是一个读数，不是 null', async () => {
    const { runs } = await boot();
    expect(runs.listPlans()).toEqual([]);
  });

  it('同一 id 重复插入以主键冲突失败，且原来那行原样还在（不静默覆盖）', async () => {
    const { runs, db } = await boot();
    save(runs, 'plan-dup', '第一条', 1_000);
    expect(() => save(runs, 'plan-dup', '第二条', 2_000)).toThrowError(/UNIQUE constraint failed/);
    expect(runs.getPlan('plan-dup')?.saved).toMatchObject({ name: '第一条', updatedAt: 1_000 });
    const rows = db.prepare('SELECT COUNT(*) AS n FROM workflow_plans').get() as { n: number | bigint };
    expect(Number(rows.n)).toBe(1);
  });
});

describe('改名与删除（spec 5.4-08 的存储半边 + 5.4-06 的快照语义）', () => {
  it('改名只动名字：指纹不变、created_at 不变、updated_at 走到新时刻', async () => {
    const { runs } = await boot();
    const before = save(runs, 'plan-r', '旧名', 1_000);
    const after = runs.renamePlan('plan-r', '新名', 5_000);
    expect(after).toMatchObject({ id: 'plan-r', name: '新名', createdAt: 1_000, updatedAt: 5_000 });
    // 指纹是"哪份计划文本"的身份：改名不改文本，所以它必须原地不动（否则历史 run 会突然续不上）。
    expect(after?.fingerprint).toBe(before.fingerprint);
  });

  it('库里没有这条 → 改名为 null；名字不合法 → 拒并且库里那行原样不动', async () => {
    const { runs } = await boot();
    expect(runs.renamePlan('plan-none', '随便', 1_000)).toBeNull();
    save(runs, 'plan-r2', '原名', 1_000);
    expect(() => runs.renamePlan('plan-r2', '  ', 2_000)).toThrowError(/不能为空/);
    expect(runs.getPlan('plan-r2')?.saved).toMatchObject({ name: '原名', updatedAt: 1_000 });
  });

  it('删掉计划不影响那次已跑完的 run —— 它读的是自己那行 `plan_json`（5.4-06）', async () => {
    const { runs } = await boot();
    const plan = buildPlan({ id: 'plan-d', nodes: BOSS_BASIC_PLAN.nodes });
    runs.openRun('run-d', plan, 1_000);
    // 先 claim 再 record：`recordNode` 是 UPDATE，行由幂等闸门那一步建（与 runner 的真实顺序一致）。
    runs.claimNode('run-d', 0, plan.nodes[0]!, 1_100);
    runs.recordNode('run-d', 0, outcome());
    save(runs, 'plan-d', '要删掉的那条', 2_000);

    expect(runs.deletePlan('plan-d')).toBe(true);
    expect(runs.getPlan('plan-d')).toBeNull();
    expect(runs.listPlans()).toEqual([]);
    // 进度与计划快照都还在：删列表条目不等于删历史。
    expect(runs.state('run-d')?.nodes[0]).toMatchObject({ status: 'done', attempts: 1 });
    expect(runs.planSnapshot('run-d')?.fingerprint).toBe(plan.fingerprint);
    // 再删一次是 false（界面按「列表已经刷新过」处理，不额外报错）。
    expect(runs.deletePlan('plan-d')).toBe(false);
  });
});

describe('坏掉的一行读不回来（5.4-03「能选的就是能跑的」在存储层的强制）', () => {
  it('原文不是合法计划 → 列表与单读都结构化失败，说清读数已损坏', async () => {
    const { runs, db } = await boot();
    save(runs, 'plan-x', '坏文本', 1_000);
    rewritePlanText(db, 'plan-x', '{"nodes":');
    expect(() => runs.getPlan('plan-x')).toThrowError(/计划读数已损坏/);
    // 列表这一侧同样不放过：坏一行就整条口失败，下拉里不会出现"看得见、点不动"的选项。
    expect(() => runs.listPlans()).toThrowError(/计划读数已损坏/);
  });

  it('节点内容被换掉而指纹列没跟着改 → 拒读，并把登记的那个指纹交出来', async () => {
    const { runs, db } = await boot();
    const original = buildPlan({ id: 'plan-y', nodes: BOSS_BASIC_PLAN.nodes });
    save(runs, 'plan-y', '被偷改的那条', 1_000);
    // 偷改一个节点的 target：内容变了、`fingerprint` 列还是旧值——这正是"按一份没人核对过的节点表开跑"的形状。
    const tampered = {
      ...original,
      nodes: original.nodes.map((node, index) => (index === 0 ? { ...node, target: '偷改' } : node)),
    };
    rewritePlanText(db, 'plan-y', JSON.stringify(tampered));
    const failure = (() => {
      try {
        runs.getPlan('plan-y');
        return null;
      } catch (caught) {
        return caught instanceof Error ? caught : new Error(String(caught));
      }
    })();
    expect(failure?.message).toContain('指纹不一致');
    // 详情里登记的指纹都在：调的人能看出「登记的是哪份」，不用猜。
    expect((failure as { details?: Record<string, unknown> }).details).toMatchObject({
      planId: 'plan-y',
      stored: original.fingerprint,
    });
    expect(() => runs.listPlans()).toThrowError(/指纹不一致/);
  });

  it('run 那一侧的同一条判据仍然说话（两条读路共用一台机器，不会漂成两个口径）', async () => {
    const { runs, db } = await boot();
    const plan = buildPlan({ id: 'plan-z', nodes: BOSS_BASIC_PLAN.nodes });
    runs.openRun('run-z', plan, 1_000);
    // 改 run 行的计划原文：`state()` 走的是 `planFromStoredText`，与计划表同一处校验。
    db.prepare('UPDATE workflow_runs SET plan_json = ? WHERE run_id = ?').run('{"nodes":[]}', 'run-z');
    expect(() => runs.state('run-z')).toThrowError(/计划读数已损坏/);
    expect(() => runs.planSnapshot('run-z')).toThrowError(/计划读数已损坏/);
  });
});
