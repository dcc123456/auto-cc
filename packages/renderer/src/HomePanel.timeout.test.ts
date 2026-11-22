/**
 * 「慢」与「挂」必须可区分（2026-11-22 裁定 / QA 的 F2）：超时带 timedOut，读不到不带。
 * 为什么用纯函数钉：本机没有可控的「慢返回」口子（停服务一律快失败、contextBridge 冻结不能注入延迟），
 * 所以慢那一路的落态由这条单测守住，活体只证「读不到」那一支。
 */
import { describe, expect, it } from 'vitest';
import { blockFailureState } from './HomePanel';

describe('blockFailureState', () => {
  it('超时（计时器打的标记）：timedOut=true，原因就是超时那句话', () => {
    const timeout = Object.assign(new Error('读取超时（8 秒）'), { timedOut: true });
    expect(blockFailureState(timeout)).toEqual({ reason: '读取超时（8 秒）', timedOut: true });
  });

  it('读不到（服务未挂载 / 桥接抛错）：timedOut=false', () => {
    expect(blockFailureState(new Error('服务未挂载：resume'))).toEqual({
      reason: '服务未挂载：resume',
      timedOut: false,
    });
  });

  it('非 Error 的抛出也收口成字符串，并且不算超时', () => {
    expect(blockFailureState('boom')).toEqual({ reason: 'boom', timedOut: false });
  });
});
