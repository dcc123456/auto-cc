import { describe, expect, it } from 'vitest';
import { SEARCH_FILTER_DIMENSIONS } from '@auto-cc/shared';
import en from './locales/en.json';
import zh from './locales/zh-CN.json';

/**
 * 筛选维度标签的「不裸 key」判据（2026-11-23 的 P1：界面把 `jd.filterLabel.experience` 画给用户）。
 *
 * 根因是动态拼 key，机检（只看写死的 `t(…)` 的字符串实参）扫不到。现在映射表是
 * `Record<SearchFilterDimension, string>`（缺维度编译红），这里补另一半：
 * **每个维度的 key 在两种语言包里都必须真的有文案**，而且不许是 key 自己。
 */
const labelOf = (locale: unknown): Record<string, string> =>
  (locale as { shell?: { jd?: { filterLabel?: Record<string, string> } } }).shell?.jd?.filterLabel ?? {};

describe('筛选维度标签：九个维度 × 两种语言都不许裸 key', () => {
  it('语言包里有全部维度 + 兜底键', () => {
    for (const language of [zh, en]) {
      const label = labelOf(language);
      for (const dimension of [...SEARCH_FILTER_DIMENSIONS, 'fallback']) {
        expect(label[dimension], `缺 ${dimension}`).toBeTruthy();
      }
    }
  });

  it('文案不是 key 自己（渲染出来像 `jd.filterLabel.x` 的就是裸 key）', () => {
    const keyShaped = /^[a-z][\w]*(\.[a-zA-Z][\w]*)+$/;
    for (const language of [zh, en]) {
      for (const [dimension, text] of Object.entries(labelOf(language))) {
        expect(keyShaped.test(text), `${dimension} 的文案像 key：${text}`).toBe(false);
      }
    }
  });
});
