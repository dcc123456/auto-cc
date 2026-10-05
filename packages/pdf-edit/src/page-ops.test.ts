/**
 * 页序模型的单测（spec 3.5-07 的判定半边：页数与顺序符合操作，非法页序一律拒）。
 *
 * 这一层不碰 `pdf-lib`（真拷页在 `pdf-document.ts` 的 `arrange()`，端到端断言在
 * `export-service.test.ts` 与 `pdf-document.test.ts`），所以这里只钉三件事：
 * 一只数组怎么表达增删重排、哪三种页序算非法、"就是不动"该怎么判。
 */
import { describe, expect, it } from 'vitest';
import { isIdentityOrder, planPageOrder } from './page-ops.js';

/** 源档三页、产物上限十页，测试里只改这两个数就够覆盖三条拒绝腿。 */
const limits = { sourcePageCount: 3, maxPages: 10 };

describe('planPageOrder：一只数组同时表达增页/删页/重排', () => {
  it('重复项就是增页，缺项就是删页，都算合法且原样规整', () => {
    expect(planPageOrder([2, 2, 1], limits.sourcePageCount, limits.maxPages)).toEqual({ ok: true, order: [2, 2, 1] });
    expect(planPageOrder([3], limits.sourcePageCount, limits.maxPages)).toEqual({ ok: true, order: [3] });
  });

  it('返回的是副本：调用方之后再改自己那只数组，动不到已通过的页序', () => {
    const order = [1, 2];
    const outcome = planPageOrder(order, limits.sourcePageCount, limits.maxPages);
    if (!outcome.ok) throw new Error(`应当通过，实际被拒：${outcome.detail}`);
    order.push(3);
    expect(outcome.order).toEqual([1, 2]);
  });

  it('空页序直接拒：产物不许是一份没有页的 PDF', () => {
    expect(planPageOrder([], limits.sourcePageCount, limits.maxPages)).toMatchObject({
      ok: false,
      code: 'empty-order',
    });
  });

  it('页号越界与非整数都算 out-of-range（0、负数、源档之外、小数）', () => {
    for (const pageNumber of [0, -1, 4, 1.5, Number.NaN]) {
      expect(planPageOrder([1, pageNumber], limits.sourcePageCount, limits.maxPages)).toMatchObject({
        ok: false,
        code: 'page-out-of-range',
      });
    }
  });

  it('产物页数超上限即拒，不做「排到第 N 页为止」这种半成品', () => {
    const tooMany = Array.from({ length: 11 }, () => 1);
    expect(planPageOrder(tooMany, limits.sourcePageCount, limits.maxPages)).toMatchObject({
      ok: false,
      code: 'too-many-pages',
    });
    // 正好等于上限是合法的：判据写的是"不超"，不是"小于"。
    expect(
      planPageOrder(
        Array.from({ length: 10 }, () => 1),
        limits.sourcePageCount,
        limits.maxPages,
      ).ok,
    ).toBe(true);
  });
});

describe('isIdentityOrder：直通与重拷的分界', () => {
  it('逐页指向自身且长度相同才算直通', () => {
    expect(isIdentityOrder([1, 2, 3], limits.sourcePageCount)).toBe(true);
    expect(isIdentityOrder([1, 2], limits.sourcePageCount)).toBe(false);
    expect(isIdentityOrder([1, 2, 3, 3], limits.sourcePageCount)).toBe(false);
    expect(isIdentityOrder([3, 2, 1], limits.sourcePageCount)).toBe(false);
  });
});
