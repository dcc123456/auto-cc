/**
 * 缺口报告 ↔ 额度闸门的接线判定（spec 4.4-09 的验收原文：LLM 调用若计入额度必经 `entitlement.gate`，
 * 本地调用不误扣额度；验证操作「断言 ledger 行为符合配置」）。
 *
 * 为什么这条住在 `packages/main`（与 3.7-02 那份跨包用例同一个理由）：
 * 判定要的是**真的闸门与真的账本**同时在场。`resume-kb` 不依赖 `entitlement`（§4.1 的依赖方向，
 * 领域包之间也不许横向 import），在它自己包里只能用替身演一遍"没扣额度"，
 * 而替身不会拒绝、也不会落账，那条断言是空的。装配层是唯一能把两侧真服务放进同一个 `Context` 的入口。
 *
 * 三条判定各守一种失效模式：
 * 1. **额度见底挡不住报告**（`mode:'daily'` + 三键上限都取 1 + 当天先落一条 `search` 账）。
 *    这条是正向证明：报告路径如果在任何一处问了闸门，就会在这里收到 `QUOTA_EXCEEDED` 而炸掉，
 *    比"断言源码里没写 perform"强——它跟着接线变化自动失效，不需要有人记得改注释。
 * 2. **跑完不落账**（跑前跑后 `usage_ledger` 行数相等）。这一条必须配第 3 条一起看，否则的话
 *    "行数不变"也可能只是账本坏了。
 * 3. **落账口是活的**（正向对照：同一份装配里 `gate.perform('greet')` 确实多出第二行，
 *    之后 `check('greet')` 转为拒绝）。它证明第 2 条的"不变"是**没被调用**，不是**调用不生效**。
 * 4. **配置语义对照**（`mode:'unlimited'` 下 `check` 恒放行且 `remaining` 为 null，报告同样不落账）——
 *    "符合配置"得有第二个配置值才成立。
 *
 * 库是**空的**（挂了 `kb.profile` 但没同步任何简历）：4.4-09 判的是闸门与账本，
 * 比对的读数质量在 4.4-c 的真库用例里已经断过，这里再造一份语料等于把两件事混在一处测。
 * 空库下 `report()` 仍然产出行（全部判缺失），所以"额度见底还能出报告"这一条照样判得准。
 * 语料是写在文件里的虚构 JD（§7.2 不碰真实招聘平台），公司名与手机号都是假。
 */
import { asApp, Context, type Fiber } from '@auto-cc/core';
import { AgentToolsService } from '@auto-cc/plugin-agent';
import { ConfigService } from '@auto-cc/plugin-config';
import { EntitlementGateService, UsageLedgerService, type GateConfig } from '@auto-cc/plugin-entitlement';
import { LogService } from '@auto-cc/plugin-logger';
import { ResumeDocService } from '@auto-cc/plugin-resume-doc';
import { KbGapService, KbProfileService, kbGapSchema, kbProfileSchema } from '@auto-cc/plugin-resume-kb';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

/** 虚构 JD 正文（够 `minJdChars`，四类里至少出硬技能与年限）。 */
const JD_TEXT = '后端工程师（虚构：南汇云图）：负责交易链路的 Java 服务，熟悉 Kafka；要求 5 年以上经验，本科及以上。';

/** 判定基准时刻（固定值，不让"今天"从时钟里漏进来——账本按本地自然日计数）。 */
const AS_OF_MS = new Date(2026, 9, 15, 12).getTime();

/** 三键上限都取 1 的日额度配置（"用掉一条就见底"，这样"见底"是可证的而不是猜的）。 */
const ONE_EACH: GateConfig = { mode: 'daily', dailyLimits: { search: 1, greet: 1, deliver: 1 } };

/**
 * 喂给 `gate.perform` 的假外发动作。
 *
 * `perform` 的 `task` 签名是 `() => Promise<T>`（它要 `await` 真动作再落账），而这里没有真动作：
 * 写成 `async () => 'x'` 会被 eslint 的 `require-await` 判成"async 里没有 await"，
 * 所以显式返回一个已完成的 Promise——四处置换都用它，不在每条用例里各抄一遍（§2.2）。
 * @returns 永远成功的假动作结果
 */
const fakeDispatch = (): Promise<string> => Promise.resolve('fixture 侧的一次动作');

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 建一个系统临时目录（`afterAll` 负责清理，产物不进仓库，§7.5）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-gap-quota-'));
  sandboxes.push(dir);
  return dir;
}

/**
 * 撑起「闸门 + 账本 + 空知识库 + 缺口报告 + 真工具注册表」的装配。
 * @param gate 闸门的配置（`daily` 见底那组与 `unlimited` 那组共用本函数，不各抄一份装配）
 * @returns 四个服务、真 `node:sqlite` 连接与临时目录
 */
async function bootWithGate(gate: GateConfig) {
  const dir = tempDir();
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(LogService, { level: 'info', buffer: 200, file: 'auto-cc.log', dir, redact: false }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  // 空配置服务传字面量 `{}` 而不是 `NO_CONFIG`：后者的类型是 `undefined`，只适配"构造器不接配置"的插件，
  // 而账本与工具注册表的 `Config` 是 `z.strictObject({})`（推断成 `Record<string, never>`）。
  fibers.push(await ctx.plugin(UsageLedgerService, {}));
  fibers.push(await ctx.plugin(EntitlementGateService, gate));
  fibers.push(await ctx.plugin(ResumeDocService, {}));
  // 配置一律取 schema 默认值（与 `cordis.yml` 同源）：这里判的是接线，不在测试里另抄一份阈值。
  fibers.push(await ctx.plugin(KbProfileService, kbProfileSchema.parse({})));
  // 注册表先于 `kb.gap` 上岗：`registerAgentTools` 是软取，晚挂载就登记出 0 个工具。
  fibers.push(await ctx.plugin(AgentToolsService, {}));
  fibers.push(await ctx.plugin(KbGapService, kbGapSchema.parse({})));
  const app = asApp(ctx);
  return {
    gate: app['entitlement.gate'],
    ledger: app['usage.ledger'],
    gap: app['kb.gap'],
    tools: app['agent.tools'],
    db: app.store.db,
  };
}

/**
 * 数一眼账本总行数。
 * @param db 共享的 `node:sqlite` 连接
 * @returns `usage_ledger` 的行数（表由账本服务在建表迁移里创建）
 */
function ledgerRows(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM usage_ledger').get() as { n?: number | bigint };
  return Number(row.n ?? 0);
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  // 日志写流是异步开文件的（与 `resume-kb` 那几份用例同一处实测）：不等一下就先删目录，
  // 会在收尾之后冒出 ENOENT 的未处理异常，把一次通过的验收判成失败。
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放，清理失败不该把一次通过的验收判成失败。
    }
  }
});

describe('4.4-09 缺口报告不误扣额度（真闸门 + 真账本）', () => {
  it('三条日额度都只剩一次且 search 已用尽：报告照样产出，账本一行都不多', async () => {
    const { gate, gap, db } = await bootWithGate(ONE_EACH);
    // 先把 `search` 用到见底：`perform` 是唯一的放行口，所以这一步同时证明账本写得进去。
    await gate.perform('search', { nowMs: AS_OF_MS }, fakeDispatch);
    const exhausted = gate.check('search', { nowMs: AS_OF_MS });
    expect(exhausted).toMatchObject({ allowed: false, remaining: 0 });
    const rowsBefore = ledgerRows(db);

    const view = await gap.report(JD_TEXT, {}, AS_OF_MS);
    // 报告出来了：空库下每类要求都判缺失，但行数与三态计数齐全（"没扣额度"不等于"没干活"）。
    expect(view.rows.length).toBeGreaterThan(0);
    expect(view.counts.missing).toBe(view.rows.length);
    // 装配里根本没有 `llm.chat`，所以模型腿报 unavailable 且不问任何人要额度。
    expect(view.modelStatus).toBe('unavailable');
    expect(ledgerRows(db)).toBe(rowsBefore);
  });

  it('agent 工具面入口（经真注册表的 safeParse）同样不落账', async () => {
    const { gate, tools, db } = await bootWithGate(ONE_EACH);
    await gate.perform('search', { nowMs: AS_OF_MS }, fakeDispatch);
    expect(gate.check('search', { nowMs: AS_OF_MS }).allowed).toBe(false);
    const rowsBefore = ledgerRows(db);

    const reply = await tools.call('kb.gap.report', { jdText: JD_TEXT });
    expect(reply.ok).toBe(true);
    if (!reply.ok) throw new Error(`工具调用失败：${reply.code} · ${reply.message}`);
    expect((reply.value as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
    expect(ledgerRows(db)).toBe(rowsBefore);
  });

  it('正向对照：同一份装配里外发动作确实会落第二行，之后该动作转为拒绝', async () => {
    const { gate, db } = await bootWithGate(ONE_EACH);
    await gate.perform('search', { nowMs: AS_OF_MS }, fakeDispatch);
    expect(ledgerRows(db)).toBe(1);
    // 上面两条用例的"行数不变"只有在落账口是活的时才有意义，所以这里当面向它要一次。
    const performed = await gate.perform('greet', { nowMs: AS_OF_MS, targetId: 'job-1' }, fakeDispatch);
    expect(performed.ledgerId).toBeGreaterThan(0);
    expect(ledgerRows(db)).toBe(2);
    expect(gate.check('greet', { nowMs: AS_OF_MS }).allowed).toBe(false);
  });

  it('配置语义对照：`unlimited` 模式下恒放行、remaining 为 null，报告依然不落账', async () => {
    const { gate, gap, db } = await bootWithGate({
      mode: 'unlimited',
      dailyLimits: { search: 1, greet: 1, deliver: 1 },
    });
    expect(gate.check('deliver', { nowMs: AS_OF_MS })).toEqual({ allowed: true, remaining: null, reason: null });
    const rowsBefore = ledgerRows(db);
    await gap.report(JD_TEXT, {}, AS_OF_MS);
    expect(ledgerRows(db)).toBe(rowsBefore);
  });
});
