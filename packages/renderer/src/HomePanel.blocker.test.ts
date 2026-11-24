/**
 * 首页阻断条的挑选逻辑（spec 10.11-08：一条阻断条、同时最多 1 条）。
 *
 * 为什么单测压在这里：三类的优先级只有活体上「真登录了 BOSS」才走得到，
 * 自动化只打本地仿站（§7.2），所以用纯函数把「先报哪条、绝不报两条」钉住，活体只证外观与入口。
 */
import { describe, expect, it } from 'vitest';
import { loginFirstApplies, pickHomeBlocker } from './HomePanel';

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

describe('loginFirstApplies', () => {
  it('只有本机仿站时不要求登录（验收环境第一步落到简历准备）', () => {
    expect(
      loginFirstApplies([{ startUrl: 'http://127.0.0.1:10233/', auth: 'expired' }], (url) => url.includes('127.0.0.1')),
    ).toBe(false);
    expect(loginFirstApplies([], () => false)).toBe(false);
  });

  it('有真实平台且未登录时要求先登录', () => {
    expect(
      loginFirstApplies([{ startUrl: 'https://www.zhipin.com/', auth: 'expired' }], (url) => url.includes('127.0.0.1')),
    ).toBe(true);
    expect(
      loginFirstApplies([{ startUrl: 'https://www.zhipin.com/', auth: 'active' }], (url) => url.includes('127.0.0.1')),
    ).toBe(false);
  });
});
