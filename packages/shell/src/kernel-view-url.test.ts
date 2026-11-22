/**
 * `shell/kernel-view-url` 负对照（spec 10.11-29⑤ 的事件面）：地址没变就不许发。
 * 判据的重心是后两条——「同值不发」是防事件风暴的那条，不是顺手写的。
 */
import { describe, expect, it } from 'vitest';
import { markKernelViewUrl } from './kernel-view-url';

describe('markKernelViewUrl', () => {
  it('首推：上一次为空串，真要发', () => {
    expect(markKernelViewUrl('', 'https://example.test/')).toEqual({ previous: 'https://example.test/', emit: true });
  });

  it('地址变了：发，并记下新值', () => {
    expect(markKernelViewUrl('https://example.test/', 'https://example.test/alt')).toEqual({
      previous: 'https://example.test/alt',
      emit: true,
    });
  });

  it('地址没变（同页刷新、重复上报）：不发，值不变', () => {
    expect(markKernelViewUrl('https://example.test/', 'https://example.test/')).toEqual({
      previous: 'https://example.test/',
      emit: false,
    });
  });
});
