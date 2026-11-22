/**
 * 「任意网页」模式的只读闸（spec 10.11-30，2026-11-22 裁定）。
 * 判据的重心是**负对照**：进了 web 模式，定位/点击/抓取/导航全都拿不到句柄；
 * 平台模式下一切照旧（这道闸不能顺手把平台动作也拦了）。
 */
import { describe, expect, it } from 'vitest';
import type { WebContents } from 'electron';
import { requireKernelContents, type KernelHost } from './frame-channel.js';

/** 一座够用的壳：只回答本闸会问到的两个问题。 */
function fakeHost(mode: 'platform' | 'web', hasContents: boolean): KernelHost {
  return {
    kernelContents: () => (hasContents ? ({} as WebContents) : null),
    getStatus: () => ({
      kernelViewMode: mode,
      kernelViewPartition: 'persist:x',
      kernelViewUrl: 'https://example.test/',
    }),
  } as unknown as KernelHost;
}

/** 取一次调用的错误码（不抛时为空串）。 */
function codeOf(run: () => unknown): string {
  try {
    run();
    return '';
  } catch (error) {
    return (error as { code?: string }).code ?? '';
  }
}

describe('requireKernelContents 的 web 模式只读闸', () => {
  it('web 模式：拒绝并给 WEB_MODE_READ_ONLY（点击/定位/抓取/导航共用这一处）', () => {
    expect(codeOf(() => requireKernelContents(fakeHost('web', true), 'browser.act'))).toBe('WEB_MODE_READ_ONLY');
  });

  it('platform 模式：照旧交出句柄（这道闸不许误伤平台动作）', () => {
    expect(() => requireKernelContents(fakeHost('platform', true), 'browser.act')).not.toThrow();
  });

  it('platform 模式且没挂载：仍是 NO_KERNEL_SESSION，不是新码', () => {
    expect(codeOf(() => requireKernelContents(fakeHost('platform', false), 'browser.page'))).toBe('NO_KERNEL_SESSION');
  });
});
