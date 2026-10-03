/**
 * 重试预算的读数表（spec 5.7-04）：外发步恒为一次，非外发步最多两次额外尝试。
 *
 * 判据要的是「按节点效果区分」，而区分这件事唯一的入口就是这条纯函数——
 * 用假执行器在 runner 里演要造一整条计划，那部分留给 `runner.test.ts` 的一条合起来看；
 * 这里把「声明值怎么被压」逐档钉住，包括 `retryTimes: null`（跟随全局配置）那一档。
 */
import { type WorkflowNodeSpec } from '@auto-cc/core';
import { describe, expect, it } from 'vitest';
import { READ_RETRY_CEILING, retryBudgetFor } from './retry-policy.js';

/**
 * 造一个节点声明，只关心 `effect` 与 `retryTimes` 两位。
 * @param over 覆盖项
 * @returns 完整的 `WorkflowNodeSpec`（缺的字段给计划序列化后的默认值，不省略类型）
 */
function node(over: Partial<Pick<WorkflowNodeSpec, 'effect' | 'retryTimes'>> = {}): WorkflowNodeSpec {
  return {
    id: 'n-1',
    kind: 'mock.one',
    target: '',
    params: {},
    effect: 'read',
    retryTimes: null,
    requiresHuman: false,
    ...over,
  };
}

describe('外发步不自动重试（spec 5.7-04）', () => {
  it('外发步声明了 3 次额外重试 → 只许尝试 1 次，压掉的 3 次要能被读出来（日志用它说话）', () => {
    expect(retryBudgetFor(node({ effect: 'outbound', retryTimes: 3 }), 2)).toEqual({ attempts: 1, clampedAway: 3 });
  });

  it('外发步没声明时按全局配置算压掉的次数：配置 2 → 压掉 2', () => {
    expect(retryBudgetFor(node({ effect: 'outbound' }), 2)).toEqual({ attempts: 1, clampedAway: 2 });
  });

  it('外发步显式写了 0 次 → 没压掉任何东西（不报错也不啰嗦一句）', () => {
    expect(retryBudgetFor(node({ effect: 'outbound', retryTimes: 0 }), 2)).toEqual({ attempts: 1, clampedAway: 0 });
  });

  it('三种外发档位的结果都是「一次尝试」：把打招呼重发两次的那条路被封在结构里，不靠计划记得写', () => {
    for (const declared of [0, 2, 5, null]) {
      expect(retryBudgetFor(node({ effect: 'outbound', retryTimes: declared }), 2).attempts).toBe(1);
    }
  });
});

describe('只读与本地写步的重试上限（spec 5.7-04 的「≤2 次」）', () => {
  it('上限就是 2 次额外尝试（3 次总尝试），声明 5 也压到 3', () => {
    expect(READ_RETRY_CEILING).toBe(2);
    expect(retryBudgetFor(node({ effect: 'read', retryTimes: 5 }), 2)).toEqual({ attempts: 3, clampedAway: 0 });
  });

  it('读节点跟随全局配置：配置 2 → 3 次；配置 0 → 1 次', () => {
    expect(retryBudgetFor(node({ effect: 'read' }), 2).attempts).toBe(3);
    expect(retryBudgetFor(node({ effect: 'read' }), 0).attempts).toBe(1);
  });

  it('声明值小于配置时按声明值走（节点自己说「我只试一次」，全局不许把它抬高）', () => {
    expect(retryBudgetFor(node({ effect: 'read', retryTimes: 1 }), 2).attempts).toBe(2);
    expect(retryBudgetFor(node({ effect: 'local-write', retryTimes: 0 }), 2).attempts).toBe(1);
  });

  it('本地写节点与读节点同档：能被重放的动作才谈次数，外发那条另说', () => {
    expect(retryBudgetFor(node({ effect: 'local-write', retryTimes: 2 }), 2)).toEqual({
      attempts: 3,
      clampedAway: 0,
    });
  });
});
