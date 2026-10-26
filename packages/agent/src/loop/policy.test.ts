/**
 * `agent.policy` 的档位真值表、一次性全自动授权与免确认白名单（spec 5.3-01 / 06 / 07 / 8.10-01 的代码半边）。
 *
 * 为什么单独成文件（plan §5.3-a 的落点说明）：判定口的输入是三个自由度的组合
 * （档位 × 副作用级 × 这只手要不要批准），把它摊成 18 格表钉住，与「循环怎么跑」无关；
 * 塞进 `loop.test.ts` 会让「谁在测判定口、谁在测循环」重新糊在一起（§4.2 测试与被测文件同目录）。
 *
 * 期望值**逐格写死**，不写「按同一套规则算一遍」的函数——用被测逻辑的实现推期望，
 * 断言就只剩「代码等于自己」，改坏了判定顺序也不会红。
 *
 * 2026-10-26（片三，用户裁定「全自动，一次都不问」）起，这里的三组读数各测一件事，不再混进一张表：
 * ① `CONFIRMED_TABLE` 测「计划已确认 + 名单为空 + **已做一次性全自动授权**」时的档位语义；
 * ② `NO_CONSENT_TABLE` 测 `auto` 在**没做过那次明示**时一步都不执行（新增的硬闸）；
 * ③ `EXEMPT_CELLS` 测免确认名单只在 `semi` 生效（`auto` 那一行本来就放行，名单在它那里无事可做）。
 *
 * 5.5-a 起判定口前面还有一道**与这三个自由度无关**的闸：页面在人手里时 18 格一律改判
 * `TAKEOVER_HELD`（spec 5.5-02）。它同样另开一组用例，18 格表因此继续只表达档位语义本身。
 *
 * 全程打本地假工具，不碰真实招聘平台也不出网（AGENTS.md §7.2）。
 */
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { asApp, Context, fiberState, type AutonomyLevel, type Fiber, type ToolEffect, toolResult } from '@auto-cc/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentToolsService, type AgentTool } from '../tools.js';
import { FakeTakeoverService } from '../test-doubles.js';
import {
  AGENT_FULL_AUTO_MIGRATION_VERSION,
  AGENT_POLICY_MIGRATION_VERSION,
  AgentPolicyService,
  type PolicyCode,
} from './policy.js';

/** 拆卸清单与临时库目录（每个用例一套注册表 + 判定口 + 一份库，跑完即拆即删）。 */
const opened: { dispose(): Promise<unknown> }[] = [];
const dirs: string[] = [];

/** 用例里那份一次性授权的确定时刻（毫秒）：写死才断得了「首次时刻不被后续点击刷新」。 */
const GRANTED_AT = 1_700_000_000_000;

afterEach(async () => {
  while (opened.length) await opened.pop()?.dispose();
  while (dirs.length) rmSync(dirs.shift() ?? '', { recursive: true, force: true });
});

/**
 * 装一套 store + 注册表 + 判定口，并把六只合成手登记进去（三种副作用级 × 要不要批准）。
 *
 * store 是 5.3-b 加上的：免确认名单与它的审计两张表（号段 18）落在库里，判定口要读的就是这张表；
 * 号段 42 的全自动授权同样住在库里——两条读数都是「跨重启仍然算数的人的表态」，不能做成内存配置。
 * @param withTakeover 是否供上接管态替身（省略为 true；传 false 就是「摘掉 browser-takeover 那一行装配」）
 * @returns 上下文、注册表句柄、判定口、store 句柄、判定口的 fiber（老库重挂那条用例要拆了再装）
 */
async function bootPolicy(withTakeover = true) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-policy-'));
  dirs.push(dir);
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  const storeFiber = ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' });
  await storeFiber;
  const toolsFiber = ctx.plugin(AgentToolsService, {});
  await toolsFiber;
  // 5.5-a：判定口把接管态写成**硬依赖**——读不到还照动手，等于「接管期间一步都不发」这条护栏
  // 在少一行装配之后静默失效。台架因此必须先供上这份替身（它也用于「闸门缺席 → 服务不挂载」那条）。
  const fibers: Fiber[] = [storeFiber, toolsFiber];
  if (withTakeover) {
    const takeoverFiber = ctx.plugin(FakeTakeoverService, {});
    await takeoverFiber;
    fibers.push(takeoverFiber);
  }
  const policyFiber = ctx.plugin(AgentPolicyService, {});
  await policyFiber;
  opened.push(policyFiber, ...fibers);
  const app = asApp(ctx);
  for (const effect of EFFECTS) {
    for (const requiresConfirmation of [false, true]) {
      app['agent.tools'].register(makeSyntheticTool(effect, requiresConfirmation));
    }
  }
  // `takeover` 在 `withTakeover: false` 那条用例里是 undefined：那里只读 `policyFiber` 与 `ctx`，
  // 要看的是「判定口根本没挂上」，所以不需要一个能动的接管态。
  return {
    ctx,
    store: app.store,
    tools: app['agent.tools'],
    policy: app['agent.policy'],
    takeover: ctx.get('browser.takeover') as FakeTakeoverService,
    policyFiber,
  };
}

/** 三种副作用级，顺序与 `TOOL_EFFECTS` 一致（这里不 import 那个常量，免得表格跟着它漂移）。 */
const EFFECTS: ToolEffect[] = ['read', 'local-write', 'outbound'];

/**
 * 合成手的 id：副作用级与「要不要批准」都写在名字里，读表的人不必回头查注册处。
 * @param effect 副作用级
 * @param requiresConfirmation 这只手自己是否声明要人批准
 * @returns 形如 `demo.outbound-ask` 的 id
 */
function toolIdFor(effect: ToolEffect, requiresConfirmation: boolean): string {
  return `demo.${effect}-${requiresConfirmation ? 'ask' : 'free'}`;
}

/**
 * 造一只登记用的合成手（`run` 什么都不做——判定口在调它之前就该给出结论，本文件不测执行）。
 * @param effect 副作用级
 * @param requiresConfirmation 是否声明要批准
 * @returns 一只可登记的工具声明
 */
function makeSyntheticTool(effect: ToolEffect, requiresConfirmation: boolean): AgentTool<Record<string, never>> {
  return {
    id: toolIdFor(effect, requiresConfirmation),
    titleKey: 'agent.tool.labels.demoTick',
    description: '真值表用的合成手，不产生任何副作用',
    input: z.strictObject({}),
    effect,
    requiresConfirmation,
    run: () => Promise.resolve(toolResult({}, { summary: '真值表用的空跑' })),
  };
}

/** 一格真值表：三个输入 + 逐格写死的期望。 */
type TruthCell = { tier: AutonomyLevel; effect: ToolEffect; requiresConfirmation: boolean; expected: PolicyCode };

/**
 * 计划已确认、**已做一次性全自动授权**、且免确认名单为空时的 18 格（spec 5.3-01 / 8.10-01）。
 *
 * 读法：`suggest` 一行三格全是 `TIER_SUGGEST_READ_ONLY`（只出计划不执行，与副作用级无关）；
 * `semi` 放行且仅放行「只读且不要求批准」，其余一律先要人点头；
 * `auto` 一行六格全放行——这一档的语义是「不再逐步确认」，`requiresConfirmation` 与副作用级都不再是问的理由。
 * 那一行里 `outbound-free` 仍是**产品上不许存在**的形状：真实登记的手里外发级都声明了
 * `requiresConfirmation: true`（plan §5.1-a 那句「`outbound` 必 `true`，逐条通过」），
 * 所以这一格今天只是「万一有」时的读数，不是一条可走的真实路径。
 */
const CONFIRMED_TABLE: TruthCell[] = [
  // suggest：整行拒绝，且拒的原因是档位不是别的。
  { tier: 'suggest', effect: 'read', requiresConfirmation: false, expected: 'TIER_SUGGEST_READ_ONLY' },
  { tier: 'suggest', effect: 'read', requiresConfirmation: true, expected: 'TIER_SUGGEST_READ_ONLY' },
  { tier: 'suggest', effect: 'local-write', requiresConfirmation: false, expected: 'TIER_SUGGEST_READ_ONLY' },
  { tier: 'suggest', effect: 'local-write', requiresConfirmation: true, expected: 'TIER_SUGGEST_READ_ONLY' },
  { tier: 'suggest', effect: 'outbound', requiresConfirmation: false, expected: 'TIER_SUGGEST_READ_ONLY' },
  { tier: 'suggest', effect: 'outbound', requiresConfirmation: true, expected: 'TIER_SUGGEST_READ_ONLY' },
  // semi：只读且自由的手放行，其余一律先要人点头。
  { tier: 'semi', effect: 'read', requiresConfirmation: false, expected: 'ALLOWED' },
  { tier: 'semi', effect: 'read', requiresConfirmation: true, expected: 'CONFIRMATION_REQUIRED' },
  { tier: 'semi', effect: 'local-write', requiresConfirmation: false, expected: 'CONFIRMATION_REQUIRED' },
  { tier: 'semi', effect: 'local-write', requiresConfirmation: true, expected: 'CONFIRMATION_REQUIRED' },
  { tier: 'semi', effect: 'outbound', requiresConfirmation: false, expected: 'CONFIRMATION_REQUIRED' },
  { tier: 'semi', effect: 'outbound', requiresConfirmation: true, expected: 'CONFIRMATION_REQUIRED' },
  // auto（已授权）：六格全放行，读完这句就知道「不再逐步确认」到底免掉了什么。
  { tier: 'auto', effect: 'read', requiresConfirmation: false, expected: 'ALLOWED' },
  { tier: 'auto', effect: 'read', requiresConfirmation: true, expected: 'ALLOWED' },
  { tier: 'auto', effect: 'local-write', requiresConfirmation: false, expected: 'ALLOWED' },
  { tier: 'auto', effect: 'local-write', requiresConfirmation: true, expected: 'ALLOWED' },
  { tier: 'auto', effect: 'outbound', requiresConfirmation: false, expected: 'ALLOWED' },
  { tier: 'auto', effect: 'outbound', requiresConfirmation: true, expected: 'ALLOWED' },
];

describe('agent.policy 的档位真值表（5.3-01）', () => {
  it('计划确认且已授权：18 格逐格对上，放行的恰好是「semi 只读自由」那 1 格 + auto 那 6 格', async () => {
    const { policy } = await bootPolicy();
    policy.grantFullAutoConsent(GRANTED_AT);
    for (const cell of CONFIRMED_TABLE) {
      const decision = policy.decide({
        tier: cell.tier,
        planConfirmed: true,
        toolId: toolIdFor(cell.effect, cell.requiresConfirmation),
      });
      // 报错信息带上坐标，否则 18 格里断错一格只能看到一句 `ALLOWED !== CONFIRMATION_REQUIRED`。
      expect(`${cell.tier}/${cell.effect}/${String(cell.requiresConfirmation)} → ${decision.code}`).toBe(
        `${cell.tier}/${cell.effect}/${String(cell.requiresConfirmation)} → ${cell.expected}`,
      );
      expect(decision.canRun).toBe(cell.expected === 'ALLOWED');
    }
    const allowed = CONFIRMED_TABLE.filter((cell) => cell.expected === 'ALLOWED');
    expect(allowed).toHaveLength(7);
  });

  it('没确认计划时，18 格退化成一格：一律 PLAN_UNCONFIRMED，且排在档位判定之前', async () => {
    const { policy } = await bootPolicy();
    policy.grantFullAutoConsent(GRANTED_AT);
    for (const tier of ['suggest', 'semi', 'auto'] satisfies AutonomyLevel[]) {
      for (const effect of EFFECTS) {
        for (const requiresConfirmation of [false, true]) {
          const decision = policy.decide({
            tier,
            planConfirmed: false,
            toolId: toolIdFor(effect, requiresConfirmation),
          });
          expect(decision.canRun).toBe(false);
          // 这一格要说清的是顺序：suggest 档下未确认的计划报的是「没确认」，不是「档位只读」——
          // 顺序换了，用户看到的下一步操作提示就换了。
          expect(decision.code).toBe('PLAN_UNCONFIRMED');
        }
      }
    }
  });

  it('不在开放面上的手：三种档位一律 TOOL_UNAVAILABLE，且不给出「看起来能跑」的读数', async () => {
    const { policy } = await bootPolicy();
    policy.grantFullAutoConsent(GRANTED_AT);
    for (const tier of ['suggest', 'semi', 'auto'] satisfies AutonomyLevel[]) {
      const decision = policy.decide({ tier, planConfirmed: true, toolId: 'demo.not-registered' });
      expect(decision).toMatchObject({ canRun: false, code: 'TOOL_UNAVAILABLE' });
    }
  });

  it('拒绝是读数不是异常：判定口对任何输入都不抛', async () => {
    const { policy } = await bootPolicy();
    expect(() => policy.decide({ tier: 'suggest', planConfirmed: false, toolId: 'demo.read-free' })).not.toThrow();
    expect(() => policy.decide({ tier: 'auto', planConfirmed: true, toolId: '' })).not.toThrow();
  });
});

/**
 * `auto` 档在**没做过**那次一次性明示时的 6 格（spec 8.10-01 的硬闸半边）。
 *
 * 六格全写死成同一个码：这不是「按副作用级再分一分」的规则，而是「一句话都没答应过就一步都不跑」。
 * 循环那一层也据此停在 `FULL_AUTO_CONSENT_REQUIRED`，界面预先摆出那张明示卡——两处读的是同一份库记录。
 */
const NO_CONSENT_TABLE: TruthCell[] = EFFECTS.flatMap((effect) =>
  [false, true].map((requiresConfirmation) => ({
    tier: 'auto',
    effect,
    requiresConfirmation,
    expected: 'FULL_AUTO_CONSENT_REQUIRED',
  })),
);

describe('agent.policy 的一次性全自动授权（spec 8.10-01）', () => {
  it('缺省未授权：读数为 null，auto 六格全停在 FULL_AUTO_CONSENT_REQUIRED', async () => {
    const { policy } = await bootPolicy();
    expect(policy.fullAutoConsent()).toEqual({ acknowledgedAt: null });
    for (const cell of NO_CONSENT_TABLE) {
      const decision = policy.decide({
        tier: cell.tier,
        planConfirmed: true,
        toolId: toolIdFor(cell.effect, cell.requiresConfirmation),
      });
      expect(`${cell.effect}/${String(cell.requiresConfirmation)} → ${decision.code}`).toBe(
        `${cell.effect}/${String(cell.requiresConfirmation)} → ${cell.expected}`,
      );
      expect(decision.canRun).toBe(false);
      // 这一句是人唯一会读到的下一步指引：要它说清「一次」与「跨重启」，否则会被当成又一句逐次确认。
      expect(decision.message).toContain('一次性');
      expect(decision.message).toContain('跨重启');
    }
  });

  it('授权之后 auto 六格放行，读数记下首次时刻；重复授权不刷新那一刻', async () => {
    const { policy } = await bootPolicy();
    expect(policy.grantFullAutoConsent(GRANTED_AT)).toEqual({ acknowledgedAt: GRANTED_AT });
    for (const cell of NO_CONSENT_TABLE) {
      const decision = policy.decide({
        tier: cell.tier,
        planConfirmed: true,
        toolId: toolIdFor(cell.effect, cell.requiresConfirmation),
      });
      expect(decision).toMatchObject({ canRun: true, code: 'ALLOWED' });
      // 免确认≠免闸门：这句话里必须还留着那四道门，界面据此才不会把它读成「以后什么都不管了」。
      expect(decision.message).toContain('额度闸门');
      expect(decision.message).toContain('接管');
    }
    // 再点一次（换一个时刻）不改写「第一次答应是什么时候」这句事实。
    expect(policy.grantFullAutoConsent(GRANTED_AT + 60_000)).toEqual({ acknowledgedAt: GRANTED_AT });
  });

  it('重启（重新挂载本服务）之后授权仍然算数：它是库里的行，不是内存里的标志位', async () => {
    const { ctx, policy, policyFiber } = await bootPolicy();
    policy.grantFullAutoConsent(GRANTED_AT);
    await policyFiber.dispose();
    await ctx.plugin(AgentPolicyService, {});
    const remounted = asApp(ctx)['agent.policy'];
    expect(remounted.fullAutoConsent()).toEqual({ acknowledgedAt: GRANTED_AT });
    expect(remounted.decide({ tier: 'auto', planConfirmed: true, toolId: 'demo.outbound-ask' })).toMatchObject({
      canRun: true,
      code: 'ALLOWED',
    });
  });

  it('老库（号段 42 未记账、表不存在）重新挂载后能建表：只建表、不替人签字', async () => {
    // 与 5.3-a 那条同一教训的回归位：把新表挂到已记账的号段上，老用户机上第一次打开全自动
    // 就以 `no such table` 失败（单测从空库起照不出来）。
    const { ctx, store, policyFiber } = await bootPolicy();
    store.db.exec('DROP TABLE agent_full_auto_consent');
    store.db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(AGENT_FULL_AUTO_MIGRATION_VERSION);
    expect(
      store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_full_auto_consent'").get(),
    ).toBeUndefined();

    await policyFiber.dispose();
    await ctx.plugin(AgentPolicyService, {});
    const remounted = asApp(ctx)['agent.policy'];
    // 建表不等于授权：老用户升级之后仍然要先看到那句话并亲手点一次。
    expect(remounted.fullAutoConsent()).toEqual({ acknowledgedAt: null });
    expect(remounted.decide({ tier: 'auto', planConfirmed: true, toolId: 'demo.read-free' }).code).toBe(
      'FULL_AUTO_CONSENT_REQUIRED',
    );
    expect(remounted.grantFullAutoConsent(GRANTED_AT)).toEqual({ acknowledgedAt: GRANTED_AT });
  });
});

/**
 * 加白之后的格子（spec 5.3-06）。
 *
 * 每格都是「先问一次，再把这一只手加进名单，再问一次」。三档 × 三种副作用级的 `*-ask` 手共 9 格，
 * 逐格写死前后两个期望：
 * `suggest` 前后都只因档位被拒（白名单不改档位语义）；`semi` 那三格由「要确认」改判放行
 * （**名单自 2026-10-26 起只在 `semi` 生效**）；`auto` 前后都放行——它在白名单之外已经有了
 * 那次一次性授权，名单在它那里无事可做。
 */
const EXEMPT_CELLS: { tier: AutonomyLevel; effect: ToolEffect; before: PolicyCode; after: PolicyCode }[] = [
  { tier: 'suggest', effect: 'read', before: 'TIER_SUGGEST_READ_ONLY', after: 'TIER_SUGGEST_READ_ONLY' },
  { tier: 'suggest', effect: 'local-write', before: 'TIER_SUGGEST_READ_ONLY', after: 'TIER_SUGGEST_READ_ONLY' },
  { tier: 'suggest', effect: 'outbound', before: 'TIER_SUGGEST_READ_ONLY', after: 'TIER_SUGGEST_READ_ONLY' },
  { tier: 'semi', effect: 'read', before: 'CONFIRMATION_REQUIRED', after: 'ALLOWED' },
  { tier: 'semi', effect: 'local-write', before: 'CONFIRMATION_REQUIRED', after: 'ALLOWED' },
  { tier: 'semi', effect: 'outbound', before: 'CONFIRMATION_REQUIRED', after: 'ALLOWED' },
  { tier: 'auto', effect: 'read', before: 'ALLOWED', after: 'ALLOWED' },
  { tier: 'auto', effect: 'local-write', before: 'ALLOWED', after: 'ALLOWED' },
  { tier: 'auto', effect: 'outbound', before: 'ALLOWED', after: 'ALLOWED' },
];

describe('agent.policy 的免确认白名单（5.3-06 / 07）', () => {
  it('名单默认是空的：缺省即「每个要批准的动作仍逐次问」', async () => {
    const { policy } = await bootPolicy();
    expect(policy.exemptList()).toEqual([]);
    expect(policy.exemptAudit()).toEqual([]);
  });

  it('加白 9 格逐格对上：只有 semi 那三格改判放行，suggest 与 auto 一行都不动', async () => {
    const { policy } = await bootPolicy();
    policy.grantFullAutoConsent(GRANTED_AT);
    for (const cell of EXEMPT_CELLS) {
      const toolId = toolIdFor(cell.effect, true);
      const before = policy.decide({ tier: cell.tier, planConfirmed: true, toolId });
      // 加白之前先钉一次：`semi` 那三格确实是要确认的（否则下面「改判」就什么都没测到）。
      expect(`${cell.tier}/${cell.effect}/加白前 → ${before.code}`).toBe(
        `${cell.tier}/${cell.effect}/加白前 → ${cell.before}`,
      );
      policy.setExempt(toolId);
      const decision = policy.decide({ tier: cell.tier, planConfirmed: true, toolId });
      expect(`${cell.tier}/${cell.effect}/加白 → ${decision.code}`).toBe(
        `${cell.tier}/${cell.effect}/加白 → ${cell.after}`,
      );
      expect(decision.canRun).toBe(cell.after === 'ALLOWED');
      // 免确认≠免闸门：放行的那几格要在原话里说清额度与频控照旧，人读界面才知道省掉的是「问」不是「闸」。
      if (cell.after === 'ALLOWED') expect(decision.message).toContain('闸门');
      policy.clearExempt(toolId);
    }
  });

  it('加白只改这一只手：同档下没加白的那一只仍要确认', async () => {
    const { policy } = await bootPolicy();
    policy.setExempt('demo.outbound-ask');
    expect(policy.decide({ tier: 'semi', planConfirmed: true, toolId: 'demo.outbound-ask' }).canRun).toBe(true);
    const kept = policy.decide({ tier: 'semi', planConfirmed: true, toolId: 'demo.local-write-ask' });
    expect(kept).toMatchObject({ canRun: false, code: 'CONFIRMATION_REQUIRED' });
  });

  it('撤销之后立刻回到要确认（5.3-07 的逐条撤销是真生效，不是界面上划掉一行）', async () => {
    const { policy } = await bootPolicy();
    policy.setExempt('demo.outbound-ask');
    expect(policy.decide({ tier: 'semi', planConfirmed: true, toolId: 'demo.outbound-ask' }).canRun).toBe(true);
    const after = policy.clearExempt('demo.outbound-ask');
    expect(after).toEqual([]);
    const refusedAgain = policy.decide({ tier: 'semi', planConfirmed: true, toolId: 'demo.outbound-ask' });
    expect(refusedAgain).toMatchObject({ canRun: false, code: 'CONFIRMATION_REQUIRED' });
    // 拒绝原话是指针，必须指向**当下真有的**那条口：5.3-b 的免确认白名单，以及 5.3-c 已经接上的确认单。
    expect(refusedAgain.message).toContain('免确认白名单');
    expect(refusedAgain.message).toContain('确认单');
  });

  it('名单读数现读注册表：加白的一只带副作用级与标题键，手被摘掉后 descriptor 变 null 且判定给 TOOL_UNAVAILABLE', async () => {
    const { policy, tools } = await bootPolicy();
    policy.setExempt('demo.outbound-ask');
    expect(policy.exemptList()).toMatchObject([
      { toolId: 'demo.outbound-ask', descriptor: { effect: 'outbound', requiresConfirmation: true } },
    ]);
    tools.unregister('demo.outbound-ask');
    const [row] = policy.exemptList();
    // 陈旧的那一条还在名单里（记录不跟着注册表消失），但它放行不了任何东西：先查表就给 TOOL_UNAVAILABLE。
    expect(row).toMatchObject({ toolId: 'demo.outbound-ask', descriptor: null });
    expect(policy.decide({ tier: 'semi', planConfirmed: true, toolId: 'demo.outbound-ask' })).toMatchObject({
      canRun: false,
      code: 'TOOL_UNAVAILABLE',
    });
    // 手不在开放面上了，用户仍然要能把当初加的白撤掉——留一条撤不掉的免确认比留一条陈旧记录危险。
    expect(policy.clearExempt('demo.outbound-ask')).toEqual([]);
  });

  it('加白不在开放面上的动作：结构化失败、名单不动、也不留审计', async () => {
    const { policy } = await bootPolicy();
    const thrown = (() => {
      try {
        policy.setExempt('demo.not-registered');
        return null;
      } catch (error) {
        return error as { code?: string };
      }
    })();
    expect(thrown?.code).toBe('AGENT_POLICY_EXEMPT_UNKNOWN');
    expect(policy.exemptList()).toEqual([]);
    expect(policy.exemptAudit()).toEqual([]);
  });

  it('审计只记真实变更：重复加白不叠行，撤销不在名单里的不写行，一加一撤各留一条', async () => {
    const { policy } = await bootPolicy();
    policy.setExempt('demo.outbound-ask');
    policy.setExempt('demo.outbound-ask');
    policy.clearExempt('demo.read-ask');
    const first = policy.exemptAudit();
    expect(first).toMatchObject([{ toolId: 'demo.outbound-ask', action: 'add', source: 'user' }]);
    expect(first).toHaveLength(1);
    policy.clearExempt('demo.outbound-ask');
    const rows = policy.exemptAudit();
    expect(rows).toHaveLength(2);
    // 倒序：最新在前，排查时先看最近一次动过名单的是谁。
    expect(rows[0]).toMatchObject({ toolId: 'demo.outbound-ask', action: 'revoke', source: 'user' });
    expect(rows[1]!.action).toBe('add');
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  it('老库（号段 18 未记账、两张表都没有）重新挂载后能建表并写入读出', async () => {
    // 与 5.3-a 那条同一教训的回归位：`runMigrations` 认台账不认 `PRAGMA user_version`，
    // 把两张表挂到已记账的号段上，老用户机上第一次加白就以 `no such table` 失败（单测从空库起照不出来）。
    const { ctx, store, policyFiber } = await bootPolicy();
    store.db.exec('DROP TABLE agent_policy_exempt; DROP TABLE agent_policy_exempt_audit');
    store.db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(AGENT_POLICY_MIGRATION_VERSION);
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'agent_policy_exempt'").get()).toBeUndefined();

    await policyFiber.dispose();
    await ctx.plugin(AgentPolicyService, {});
    const remounted = asApp(ctx)['agent.policy'];
    expect(remounted.exemptList()).toEqual([]);
    remounted.setExempt('demo.outbound-ask');
    expect(remounted.decide({ tier: 'semi', planConfirmed: true, toolId: 'demo.outbound-ask' }).canRun).toBe(true);
    expect(remounted.exemptAudit()).toMatchObject([{ action: 'add', toolId: 'demo.outbound-ask' }]);
  });
});

describe('agent.policy 的接管闸门（spec 5.5-02）', () => {
  it('接管中：18 格一律改判 TAKEOVER_HELD，档位与计划确认都不放行', async () => {
    const { policy, takeover } = await bootPolicy();
    policy.grantFullAutoConsent(GRANTED_AT);
    takeover.setHold('manual');
    for (const cell of CONFIRMED_TABLE) {
      const decision = policy.decide({
        tier: cell.tier,
        planConfirmed: true,
        toolId: toolIdFor(cell.effect, cell.requiresConfirmation),
      });
      // 连 `auto` + 已授权那几格（真值表里最松的格子）都放行不了：人在动页面时读页面也算动手。
      expect(`${cell.tier}/${cell.effect}/${String(cell.requiresConfirmation)} → ${decision.code}`).toBe(
        `${cell.tier}/${cell.effect}/${String(cell.requiresConfirmation)} → TAKEOVER_HELD`,
      );
      expect(decision.canRun).toBe(false);
    }
  });

  it('接管判在一切之前：未确认计划与未登记的手都报接管，而不是各自的码', async () => {
    const { policy, takeover } = await bootPolicy();
    takeover.setHold('risk');
    expect(policy.decide({ tier: 'auto', planConfirmed: false, toolId: 'demo.read-free' }).code).toBe('TAKEOVER_HELD');
    expect(policy.decide({ tier: 'auto', planConfirmed: true, toolId: 'demo.not-registered' }).code).toBe(
      'TAKEOVER_HELD',
    );
  });

  it('加白绕不过接管：同一只手加白后仍是 TAKEOVER_HELD，交还页面才回到 ALLOWED', async () => {
    const { policy, takeover } = await bootPolicy();
    policy.setExempt('demo.outbound-ask');
    const before = policy.decide({ tier: 'semi', planConfirmed: true, toolId: 'demo.outbound-ask' });
    expect(before.canRun).toBe(true);

    takeover.setHold('manual');
    const held = policy.decide({ tier: 'semi', planConfirmed: true, toolId: 'demo.outbound-ask' });
    expect(held).toMatchObject({ canRun: false, code: 'TAKEOVER_HELD' });
    // 名单还在（接管不改用户的表态），但它此刻放行不了任何东西。
    expect(policy.exemptList()).toHaveLength(1);
    expect(held.message).toContain('加白');

    takeover.setHold(null);
    expect(policy.decide({ tier: 'semi', planConfirmed: true, toolId: 'demo.outbound-ask' }).canRun).toBe(true);
  });

  it('拒因说清「因为什么、已经多久、唯一那只口」：界面与日志都直接念这句', async () => {
    const { policy, takeover } = await bootPolicy();
    takeover.setHold('session-expired');
    const decision = policy.decide({ tier: 'semi', planConfirmed: true, toolId: 'demo.read-free' });
    expect(decision.message).toContain('session-expired');
    expect(decision.message).toContain('已持续');
    expect(decision.message).toContain('一步都不发');
  });

  it('接管态闸门缺席（少一行装配）：判定口停在 pending，根本不挂载', async () => {
    const { ctx, policyFiber } = await bootPolicy(false);
    // cordis 对依赖缺席的插件停在 PENDING 而不是抛错，所以「没挂上」要看状态而不是等异常（同 1.9-05）。
    expect(fiberState(policyFiber.state)).toBe('pending');
    expect(asApp(ctx).get('agent.policy')).toBeUndefined();
  });
});
