/**
 * `agent.policy` 的档位真值表（spec 5.3-01 的代码半边）。
 *
 * 为什么单独成文件（plan §5.3-a 的落点说明）：判定口的输入是三个自由度的组合
 * （档位 × 副作用级 × 这只手要不要批准），把它摊成 18 格表钉住，与「循环怎么跑」无关；
 * 塞进 `loop.test.ts` 会让「谁在测判定口、谁在测循环」重新糊在一起（§4.2 测试与被测文件同目录）。
 *
 * 期望值**逐格写死**，不写「按同一套规则算一遍」的函数——用被测逻辑的实现推期望，
 * 断言就只剩「代码等于自己」，改坏了判定顺序也不会红。
 *
 * 全程打本地假工具，不碰真实招聘平台也不出网（AGENTS.md §7.2）。
 */
import { ConfigService } from '@auto-cc/plugin-config';
import { asApp, Context, toolResult, type AutonomyLevel, type ToolEffect } from '@auto-cc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentToolsService, type AgentTool } from '../tools.js';
import { AgentPolicyService, type PolicyCode } from './policy.js';

/** 拆卸清单（每个用例一套注册表 + 判定口，跑完即拆）。 */
const opened: { dispose(): Promise<unknown> }[] = [];

afterEach(async () => {
  while (opened.length) await opened.pop()?.dispose();
});

/**
 * 装一套「注册表 + 判定口」，并把六只合成手登记进去（三种副作用级 × 要不要批准）。
 * @returns 上下文、注册表句柄、判定口
 */
async function bootPolicy() {
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  const toolsFiber = ctx.plugin(AgentToolsService, {});
  await toolsFiber;
  const policyFiber = ctx.plugin(AgentPolicyService, {});
  await policyFiber;
  opened.push(policyFiber, toolsFiber);
  const app = asApp(ctx);
  for (const effect of EFFECTS) {
    for (const requiresConfirmation of [false, true]) {
      app['agent.tools'].register(makeSyntheticTool(effect, requiresConfirmation));
    }
  }
  return { tools: app['agent.tools'], policy: app['agent.policy'] };
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
 * 计划已确认时的 18 格。
 *
 * 读法：`suggest` 一行三格全是 `TIER_SUGGEST_READ_ONLY`（只出计划不执行，与副作用级无关）；
 * `semi` 放行且仅放行「只读且不要求批准」；`auto` 放行「不要求批准」的一切——
 * 这一格里 `outbound-free` 是**产品上不许存在**的形状：真实登记的 16 只手外，外发级都声明了
 * `requiresConfirmation: true`（plan §5.1-a 那句「`outbound` 必 `true`，逐条通过」），所以它今天不可达；
 * 但「不可达」目前是人工核对出来的、不是机检钉住的，而 5.3-06 要的恰恰是**即使用户升到 `auto`、
 * 外发仍默认要点头**——那要靠 5.3-b 的免确认白名单把这一格也管起来。因此 5.3-01 在本片**不勾**，
 * 这里如实记为 ALLOWED，不为它改期望值、也不给判定口塞一条「outbound 一律拒」的临时规则（§2.6）。
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
  // auto：手自己声明要批准的，任何档位都不替用户点头；其余放行（白名单收窄在 5.3-b）。
  { tier: 'auto', effect: 'read', requiresConfirmation: false, expected: 'ALLOWED' },
  { tier: 'auto', effect: 'read', requiresConfirmation: true, expected: 'CONFIRMATION_REQUIRED' },
  { tier: 'auto', effect: 'local-write', requiresConfirmation: false, expected: 'ALLOWED' },
  { tier: 'auto', effect: 'local-write', requiresConfirmation: true, expected: 'CONFIRMATION_REQUIRED' },
  { tier: 'auto', effect: 'outbound', requiresConfirmation: false, expected: 'ALLOWED' },
  { tier: 'auto', effect: 'outbound', requiresConfirmation: true, expected: 'CONFIRMATION_REQUIRED' },
];

describe('agent.policy 的档位真值表（5.3-01）', () => {
  it('计划确认后：18 格逐格对上，允许的那格恰好是「放行」那 4 格', async () => {
    const { policy } = await bootPolicy();
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
    expect(allowed).toHaveLength(4);
  });

  it('没确认计划时，18 格退化成一格：一律 PLAN_UNCONFIRMED，且排在档位判定之前', async () => {
    const { policy } = await bootPolicy();
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
