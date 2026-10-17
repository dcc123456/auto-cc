/**
 * 终态跳过的守卫与合成（spec 5.11-04 的 U + C 半边）。
 *
 * 全部是纯函数用例：一个 JSON 值进、一个布尔出，不碰 sqlite、不碰页面、不碰时钟。
 * 这一层之所以能这么测，是因为它被刻意写成没有 I/O 的一层（`terminal-state.ts` 的模块注释）；
 * 一旦哪条用例需要起库或造页面，就说明判断被搬进 I/O 里去了，该把纯的那部分搬回来。
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowCondition } from '@auto-cc/core';
import { provesLandedEffect, terminalStateHolds, type TerminalStateReading } from './terminal-state.js';

/** 一份「什么都没观测到」的快照：多数用例只改它的一两个字段。 */
const NOTHING_OBSERVED: TerminalStateReading = { effectObserved: false, committedNodeIds: [] };

describe('落地守卫 provesLandedEffect（spec 5.11-04 的反例本体）', () => {
  it('「URL 在地址栏上」不构成落地证据——F41 的反例必须失败', () => {
    // 这三行是 browser-copilot 现场的原话：模型给「发布页上的那个按钮」写 urlContains /publish/，
    // 而发布页在标题存没存下来之前都带着 /publish/，拿它当「已生效」就是把整条梯子一次关掉。
    expect(provesLandedEffect({ kind: 'urlContains', value: '/publish/' })).toBe(false);
    // 换成通配写法也一样：读数仍然是「run 在哪」，不是「它做了什么」。
    expect(provesLandedEffect({ kind: 'urlContains', value: '.*/publish/.*' })).toBe(false);
    // 空串更糟：它在任何地址上都成立。
    expect(provesLandedEffect({ kind: 'urlContains', value: '' })).toBe(false);
  });

  it('机器写下的那两族是落地证据', () => {
    expect(provesLandedEffect({ kind: 'effectObserved' })).toBe(true);
    expect(provesLandedEffect({ kind: 'nodeCommitted', nodeId: 'jd-list' })).toBe(true);
  });

  it('判据按形状拒，不看取值：换成任何 kind 之外的读法都还是拒', () => {
    // 守卫是「这一族证明不了」而不是「这一条值不对」，所以它对取值免疫——
    // 现场那批坏判据正是模型随手换写法写出来的，逐个值去堵堵不完。
    const denials: WorkflowCondition[] = [
      { kind: 'urlContains', value: 'https://example.invalid/publish' },
      { kind: 'urlContains' },
    ];
    expect(denials.every((row) => !provesLandedEffect(row))).toBe(true);
  });
});

describe('终态合成 terminalStateHolds（spec 5.11-03 / 04）', () => {
  it('没有终态判据就不是「终态已成立」——省略不得被读成放行', () => {
    expect(terminalStateHolds(undefined, { effectObserved: true, committedNodeIds: ['x'] })).toBe(false);
    expect(terminalStateHolds([], { effectObserved: true, committedNodeIds: ['x'] })).toBe(false);
  });

  it('落地被观察到才成立：effectObserved 是唯一能凭本行读数成立的判据', () => {
    const conditions: WorkflowCondition[] = [{ kind: 'effectObserved' }];
    expect(terminalStateHolds(conditions, { ...NOTHING_OBSERVED, effectObserved: true })).toBe(true);
    expect(terminalStateHolds(conditions, NOTHING_OBSERVED)).toBe(false);
  });

  it('nodeCommitted 只认计划里真的落定的那个格子', () => {
    const conditions: WorkflowCondition[] = [{ kind: 'nodeCommitted', nodeId: 'jd-list' }];
    expect(terminalStateHolds(conditions, { ...NOTHING_OBSERVED, committedNodeIds: ['jd-capture', 'jd-list'] })).toBe(
      true,
    );
    expect(terminalStateHolds(conditions, { ...NOTHING_OBSERVED, committedNodeIds: ['jd-capture'] })).toBe(false);
    // 没指名格子的那一行读不成任何格子：宁可判不成立，不许「缺省即真」。
    expect(terminalStateHolds([{ kind: 'nodeCommitted' }], { ...NOTHING_OBSERVED, committedNodeIds: [''] })).toBe(
      false,
    );
  });

  it('多条判据取交集：一条观测不到就整体不成立', () => {
    const conditions: WorkflowCondition[] = [{ kind: 'effectObserved' }, { kind: 'nodeCommitted', nodeId: 'jd-list' }];
    expect(terminalStateHolds(conditions, { effectObserved: true, committedNodeIds: ['jd-list'] })).toBe(true);
    expect(terminalStateHolds(conditions, { effectObserved: true, committedNodeIds: [] })).toBe(false);
    expect(terminalStateHolds(conditions, { effectObserved: false, committedNodeIds: ['jd-list'] })).toBe(false);
  });

  it('URL 那一行即使"看起来满足"也不成立——反例的端到端形状', () => {
    // 这里刻意把 value 换成一个真实站点会出现的地址段：守卫不读它，所以换不换结果都一样。
    const conditions: WorkflowCondition[] = [{ kind: 'urlContains', value: '/publish/' }];
    expect(terminalStateHolds(conditions, { effectObserved: true, committedNodeIds: ['jd-list'] })).toBe(false);
    // 快照「什么都有」也不行：没观测到的判据就是没观测到，读不出来的通道不许由别的判据顶替。
    expect(terminalStateHolds(conditions, { effectObserved: true, committedNodeIds: ['jd-list', 'flaky'] })).toBe(
      false,
    );
  });

  it('守卫先于观测：被拒的那一行不因为快照里恰好有对应读数而翻案', () => {
    const conditions: WorkflowCondition[] = [{ kind: 'urlContains', value: '/publish/' }, { kind: 'effectObserved' }];
    // 交集里那一行仍然成立不了，所以整体不成立——不允许「别的行替它兜底」。
    expect(terminalStateHolds(conditions, { effectObserved: true, committedNodeIds: [] })).toBe(false);
  });
});
