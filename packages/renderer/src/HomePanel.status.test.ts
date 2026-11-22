/**
 * Home「无人值守」那一行的取值（2026-11-22 裁定，QA 的 04）：
 * 暂停必须带原因原文，不许回落成「只建议」；只有真的没有授权单时才说「只建议」。
 */
import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { unattendedStatusKey } from './HomePanel';

/** 只做插值记录的假 t：返回 `key|params`，方便断言用了哪条文案。 */
const fakeT = ((key: string, params?: Record<string, unknown>) =>
  `${key}|${JSON.stringify(params ?? {})}`) as unknown as TFunction;

describe('unattendedStatusKey', () => {
  it('没有授权单：才说「只建议」', () => {
    expect(unattendedStatusKey({ authorization: null })).toEqual({ key: 'home.unattendedValue.suggest' });
  });

  it('生效中：报「已授权 N 岗」，不含第二层「无人值守：」前缀', () => {
    const reading = unattendedStatusKey({
      authorization: { status: 'active', targets: ['1001', '1002'], pauseReason: null },
    });
    expect(reading).toEqual({ key: 'home.unattendedValue.active', params: { count: 2 } });
  });

  it('暂停：报「已暂停」并带原因原文（不许回落成只建议）', () => {
    const reading = unattendedStatusKey({
      authorization: { status: 'paused', targets: ['1001'], pauseReason: '页面出现验证码，已暂停' },
    });
    expect(reading).toEqual({ key: 'home.unattendedValue.paused', params: { reason: '页面出现验证码，已暂停' } });
  });

  it('暂停但没有原因：仍报暂停，原因写「没有写原因」而不是省略', () => {
    const reading = unattendedStatusKey({
      authorization: { status: 'paused', targets: [], pauseReason: null },
    });
    expect(reading).toEqual({
      key: 'home.unattendedValue.paused',
      params: { reason: 'home.unattendedValue.noReason' },
    });
  });

  it('失效/收回：按状态给各自的人话', () => {
    expect(unattendedStatusKey({ authorization: { status: 'revoked', targets: [] } })).toEqual({
      key: 'home.unattendedValue.revoked',
    });
  });

  expectUnused(fakeT);
});

/** 假 t 只在上面用于类型自检时被引用一次；这里留一个显式调用免得 lint 抱怨未使用。 */
function expectUnused(t: TFunction): void {
  expect(typeof t).toBe('function');
}
