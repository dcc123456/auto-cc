import { AppError, asApp, Context, NO_CONFIG } from '@auto-cc/core';
import type { PlatformAdapter } from '@auto-cc/plugin-browser';
import { PlatformRegistryService } from '@auto-cc/plugin-browser';
import { describe, expect, it } from 'vitest';
import type { BossAdapterMethod } from './adapter.js';
import { BossPlatformService, createBossAdapter, loadBossKnowledgePack } from './index.js';

/** 把被拒的原因收成 `AppError` 载荷，好逐条断言码与 `details`（失败原因本身就是这条契约的一半）。 */
const asErr = (error: unknown): AppError => error as AppError;

/** 每个动作由哪个子计划补齐 —— 与 `adapter.ts` 同表，界面显示「等什么」就读它（spec 2.2-06）。 */
const ACTIONS: readonly (readonly [BossAdapterMethod, string])[] = [
  ['search', '2.3'],
  ['detail', '2.3'],
  ['chat', '2.5'],
  ['sendResume', '2.6'],
  ['readReplies', '2.5'],
] as const;

describe('BOSS 空壳适配器（spec 2.2-06）', () => {
  const pack = loadBossKnowledgePack();
  // 这一行的**类型标注**就是 2.2-06 的「C」：空壳能实现契约，编译期就成立了。
  const adapter: PlatformAdapter = createBossAdapter(pack);

  it('meta 完全来自知识包：标识、显示名、起始地址与能力集', () => {
    expect(adapter.meta).toEqual({
      id: 'boss',
      displayName: 'BOSS 直聘',
      startUrl: 'http://127.0.0.1:10233/boss',
      capabilities: ['search', 'detail', 'chat', 'sendResume', 'readReplies'],
    });
  });

  it('meta.capabilities 是拷贝，知识包对象后续被改也不影响已登记的读数', () => {
    pack.capabilities.push('search');
    expect(adapter.meta.capabilities).toHaveLength(5);
    pack.capabilities.pop();
  });

  it.each(ACTIONS)('%s 尚未实现时以 METHOD_NOT_FOUND 结构化失败，并说明归哪个子计划', async (method, plan) => {
    const call = (): Promise<unknown> => {
      switch (method) {
        case 'search':
          return adapter.search({ keyword: '前端工程师', city: '上海' });
        case 'detail':
          return adapter.detail('1001');
        case 'chat':
          return adapter.chat('1001', '您好，我对这个岗位很感兴趣');
        case 'sendResume':
          return adapter.sendResume('1001');
        case 'readReplies':
          return adapter.readReplies('1001');
      }
    };
    const error = asErr(
      await call().then(
        () => null,
        (reason: unknown) => reason,
      ),
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('METHOD_NOT_FOUND');
    expect(error.path).toBe('platform.boss');
    expect(error.message).toContain(plan);
    expect(error.details).toEqual({ method, deliveredBy: plan });
  });
});

describe('platform.boss 挂载即登记（spec 2.2-07）', () => {
  it('服务 init 把自己登记进 platform.registry，登记表按名取回的就是它', async () => {
    const ctx = new Context();
    // 不挂 logger/config：这两位在 2.2-07 这条断言里不是被检对象，cordis 自带控制台 logger。
    await ctx.plugin(PlatformRegistryService, NO_CONFIG);
    await ctx.plugin(BossPlatformService, {});
    const registry = asApp(ctx)['platform.registry'];
    expect(registry.list().platforms.map((platform) => platform.id)).toEqual(['boss']);
    expect(registry.get('boss').meta).toEqual(createBossAdapter(loadBossKnowledgePack()).meta);
    // 未登记的平台仍是可读错误（同 2.2-07 的后半条），本包没有把它变成第二套判定。
    expect(() => registry.get('liepin')).toThrowError(/未登记的平台适配器/);
  });
});
