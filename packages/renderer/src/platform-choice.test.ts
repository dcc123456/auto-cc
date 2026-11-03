/**
 * 岗位屏平台选择判定（spec 2.3-12）。
 *
 * 这组用例钉的是界面的两条分叉：单个平台直接挂载、多个平台才出现选择；
 * 以及旧选择失效时必须落回仍然装着的平台，而不是拿一个被摘掉的平台去开视图。
 */
import { describe, expect, it } from 'vitest';
import { resolveCapturePlatform, shouldOfferPlatformChoice } from './platform-choice';

describe('平台选择是否上屏', () => {
  it('没有平台：不摆选择器（按钮由上层按无平台禁用）', () => {
    expect(shouldOfferPlatformChoice([])).toBe(false);
  });

  it('单个平台：不摆选择器，直接挂它', () => {
    expect(shouldOfferPlatformChoice(['boss'])).toBe(false);
  });

  it('多个平台：摆选择器让人挑', () => {
    expect(shouldOfferPlatformChoice(['boss', 'liepin'])).toBe(true);
  });
});

describe('本次实际挂载的平台', () => {
  it('清单为空时回空串，交给释放路径报结构化错误', () => {
    expect(resolveCapturePlatform([], 'boss', '')).toBe('');
  });

  it('单平台时不管默认值写的是谁都落到它', () => {
    expect(resolveCapturePlatform(['boss'], 'liepin', '')).toBe('boss');
  });

  it('多平台时默认用配置平台', () => {
    expect(resolveCapturePlatform(['boss', 'liepin'], 'liepin', '')).toBe('liepin');
  });

  it('人选的平台优先于默认平台', () => {
    expect(resolveCapturePlatform(['boss', 'liepin'], 'boss', 'liepin')).toBe('liepin');
  });

  it('旧选择已不在清单里时落回默认平台，不拿被摘掉的平台去开视图', () => {
    expect(resolveCapturePlatform(['boss', 'liepin'], 'boss', 'lagou')).toBe('boss');
  });
});
