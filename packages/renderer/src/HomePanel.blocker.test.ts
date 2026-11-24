/**
 * 首页阻断条的挑选逻辑（spec 10.11-08：一条阻断条、同时最多 1 条）。
 *
 * 为什么单测压在这里：三类的优先级只有活体上「真登录了 BOSS」才走得到，
 * 自动化只打本地仿站（§7.2），所以用纯函数把「先报哪条、绝不报两条」钉住，活体只证外观与入口。
 */
import { describe, expect, it } from 'vitest';
import { isRealPlatform, loginFirstApplies, pickHomeBlocker } from './HomePanel';

describe('pickHomeBlocker', () => {
  it('三样都没满足：先报未登录（不在首页堆三条红字）', () => {
    expect(pickHomeBlocker({ isLoggedIn: false, hasDocs: false, modelMissing: true })).toBe('login');
  });

  it('登录了但没有简历：报简历，不再顺带报模型', () => {
    expect(pickHomeBlocker({ isLoggedIn: true, hasDocs: false, modelMissing: true })).toBe('resume');
  });

  it('登录与简历都齐、模型缺：报模型', () => {
    expect(pickHomeBlocker({ isLoggedIn: true, hasDocs: true, modelMissing: true })).toBe('model');
  });

  it('三样都齐：一条都不报', () => {
    expect(pickHomeBlocker({ isLoggedIn: true, hasDocs: true, modelMissing: false })).toBeNull();
  });
});

describe('isRealPlatform / loginFirstApplies', () => {
  const isLocal = (url: string): boolean => url.includes('127.0.0.1') || url.includes('localhost');

  it('登记处来源全在回环时不算真实平台（仿站 pack 的首屏不出登录步）', () => {
    expect(isRealPlatform({ origins: ['http://127.0.0.1:10233'], startUrl: 'http://127.0.0.1:10233/' }, isLocal)).toBe(
      false,
    );
    // 没有 origins 时退回 startUrl 判：与 pack=real 一致。
    expect(isRealPlatform({ startUrl: 'https://www.zhipin.com/' }, isLocal)).toBe(true);
  });

  it('真实平台在场且未登录才要求登录；纯仿站装配登录不适用', () => {
    const fixtureRow = { id: 'boss', auth: 'expired' };
    expect(loginFirstApplies([fixtureRow], new Set<string>())).toBe(false);
    expect(loginFirstApplies([fixtureRow], new Set(['boss']))).toBe(true);
    expect(loginFirstApplies([{ id: 'boss', auth: 'active' }], new Set(['boss']))).toBe(false);
  });
});
