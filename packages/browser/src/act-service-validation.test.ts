/**
 * `browser.act` 的**声明校验**用例（plan §16.3：非法的定位声明不许伪装成闸门超时）。
 *
 * 要钉住的是失败**顺序**：一份缺字段的声明如果在碰会话之前没被拒，页内脚本会按
 * `candidate.strategy` 取匹配器、读到零条候选，五秒后回 `WAIT_TIMEOUT`——
 * 调用方拿到的是一条指向「页面不可点」的假线索，而毛病其实在自己传的参数里。
 */
import { AppError, Context, NO_CONFIG, type Fiber } from '@auto-cc/core';
import type { LocateSpec } from '@auto-cc/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserActService, type BrowserActConfig } from './act-service.js';
import { FakeLocateService, FakePageService, FakeShellService } from './test-doubles.js';

/** 动作服务配置：全部取默认节奏，本文件只关心校验，不关心等待时长。 */
const ACT_CONFIG: BrowserActConfig = {
  waitForTimeoutMs: 5000,
  stableCheckSamples: 2,
  waitCheckMs: 100,
  cdpInputEnabled: true,
  uploadReadbackMs: 1500,
  uploadReadbackStepMs: 50,
  clickReadbackMs: 600,
  clickReadbackStepMs: 50,
};

const fibers: Fiber[] = [];

/**
 * 起一套「替身 shell/page/locate + 真动作服务」，且**故意不挂内核会话视图**。
 * @returns 动作服务实例（校验若在碰会话之前，非法声明就不会先撞上 NO_KERNEL_SESSION）
 */
async function bootActWithoutSession(): Promise<BrowserActService> {
  const ctx = new Context();
  fibers.push(
    await ctx.plugin(FakeShellService, NO_CONFIG),
    await ctx.plugin(FakePageService, NO_CONFIG),
    await ctx.plugin(FakeLocateService, NO_CONFIG),
  );
  fibers.push(await ctx.plugin(BrowserActService, ACT_CONFIG));
  return ctx.get('browser.act') as BrowserActService;
}

/** `testId` 候选缺属性名：类型上完全合法，只有 `validateSpec` 那一条规则认得它。 */
const testIdWithoutAttribute: LocateSpec = {
  description: '打招呼按钮（缺属性名）',
  cardinality: 'single',
  candidates: [{ strategy: 'testId', value: 'greet-button' }],
};

/** `role` 候选缺可读名：与上一条同族，都是"闸门外看不出问题、闸门里读到零条"的形状。 */
const roleWithoutName: LocateSpec = {
  description: '打招呼按钮（缺可读名）',
  cardinality: 'single',
  candidates: [{ strategy: 'role', role: 'button' }],
};

/**
 * 取一次动作调用抛出的错误码。
 * @param run 待await 的动作调用
 * @returns 抛出 `AppError` 时给它的 `code`，正常返回时给 `null`
 */
async function codeOf(run: Promise<unknown>): Promise<string | null> {
  return run.then(
    () => null,
    (error: unknown) => (error instanceof AppError ? error.code : 'NOT_APP_ERROR'),
  );
}

describe('browser.act 的声明校验', () => {
  afterAll(async () => {
    for (const fiber of fibers.splice(0)) await fiber.dispose();
  });

  it('click 对缺属性名的声明报 LOCATE_SPEC_INVALID，而不是闸门超时', async () => {
    const act = await bootActWithoutSession();
    expect(await codeOf(act.click(testIdWithoutAttribute))).toBe('LOCATE_SPEC_INVALID');
  });

  it('type 与 select 走同一道校验，缺可读名的 role 候选当场被拒', async () => {
    const act = await bootActWithoutSession();
    expect(await codeOf(act.type(roleWithoutName, '打招呼'))).toBe('LOCATE_SPEC_INVALID');
    expect(await codeOf(act.select(roleWithoutName, 'boss'))).toBe('LOCATE_SPEC_INVALID');
  });

  it('waitFor 也不许把非法声明报告成「未满足」', async () => {
    const act = await bootActWithoutSession();
    expect(await codeOf(act.waitFor({ kind: 'clickable', spec: testIdWithoutAttribute }))).toBe('LOCATE_SPEC_INVALID');
  });
});
