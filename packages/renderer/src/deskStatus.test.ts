import { describe, expect, it } from 'vitest';
import { deskTierReading } from './deskStatus';

/**
 * 状态条「档位」那一格的状态转移（spec 10.10-04 / plan §13.2 的 2026-11-21 裁定）。
 *
 * 真实授权单要连平台才开得出来，所以这一条**状态转移**在这里钉住：干净实例报最保守档、
 * 授权生效报「已授权 N 岗」、撤权或停用后退回档位名。界面只按读数取译文。
 */
describe('状态条档位读数（spec 10.10-04）', () => {
  it('干净实例没有授权单：报最保守的「只建议」档', () => {
    expect(deskTierReading('suggest', null)).toEqual({ kind: 'tier', tier: 'suggest' });
    expect(deskTierReading('suggest', undefined)).toEqual({ kind: 'tier', tier: 'suggest' });
  });

  it('授权单生效：报无人值守与已授权岗位数', () => {
    expect(deskTierReading('suggest', { active: true, targetCount: 1 })).toEqual({
      kind: 'unattended',
      count: 1,
    });
  });

  it('撤权/停用（授权单不再是 active）：退回档位名', () => {
    expect(deskTierReading('suggest', { active: false, targetCount: 1 })).toEqual({
      kind: 'tier',
      tier: 'suggest',
    });
  });

  it('一键停用（授权单仍 active、停用位为真）：也退回档位名', () => {
    expect(deskTierReading('suggest', { active: true, targetCount: 1, stopped: true })).toEqual({
      kind: 'tier',
      tier: 'suggest',
    });
  });
});
