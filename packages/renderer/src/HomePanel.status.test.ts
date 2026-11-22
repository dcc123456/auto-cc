/**
 * Home「无人值守」那一行的取值与**渲染结果**（2026-11-22 裁定，QA 的 04）：
 * 暂停必须带原因原文，不许回落成「只建议」；没写原因时给「未写原因」而不是裸 key。
 * 判据刻意压在**渲染出来的字符串**上：只断言 `params.reason` 等于某个 key，正是上一版漏掉裸 key 的原因。
 */
import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import zh from './locales/zh-CN.json';
import { unattendedStatusKey, unattendedValue } from './HomePanel';

/** 从语言包里按 key 取文案并插值的迷你 t（与运行时同一份语言包，才能测出裸 key）。 */
const miniT = ((key: string, params?: Record<string, string | number>) => {
  // 语言包的根是 `shell`（i18next 的 ns 也是它），key 里不带 ns 前缀。
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      (zh as unknown as { shell: unknown }).shell,
    );
  if (typeof value !== 'string') return key;
  return value.replace(/\{\{(\w+)\}\}/g, (_match: string, name: string) => String(params?.[name] ?? `{{${name}}}`));
}) as unknown as TFunction;

/** 一份「接下来」块的读数壳（只填这一行用得到的两位）。 */
const ready = (authorization: unknown) => ({ state: 'ready' as const, value: { authorization } as never });

describe('unattendedValue：渲染结果不含裸 key', () => {
  it('暂停且写了原因：出现原因原文，且整个字符串里没有 `home.` 这类 key', () => {
    const text = unattendedValue(miniT, ready({ status: 'paused', targets: ['1001'], pauseReason: '页面出现验证码' }));
    expect(text).toBe('已暂停：页面出现验证码');
    expect(text).not.toMatch(/home\.[a-zA-Z]/);
  });

  it('暂停但没写原因：给「未写原因」，**不是**裸 key', () => {
    const text = unattendedValue(miniT, ready({ status: 'paused', targets: [], pauseReason: null }));
    expect(text).toBe('已暂停：未写原因');
    expect(text).not.toMatch(/home\.[a-zA-Z]/);
  });

  it('已授权 / 没有授权单 / 失效：都不含裸 key', () => {
    expect(unattendedValue(miniT, ready({ status: 'active', targets: ['1', '2'], pauseReason: null }))).toBe(
      '已授权 2 岗',
    );
    expect(unattendedValue(miniT, ready(null))).toBe('只建议');
    expect(unattendedValue(miniT, ready({ status: 'revoked', targets: [] }))).toBe('已收回');
  });

  it('纯函数本身：暂停无原因返回的是 `pausedNoReason` 那条 key，参数里没有 key 字符串', () => {
    expect(unattendedStatusKey({ authorization: { status: 'paused', targets: [], pauseReason: null } })).toEqual({
      key: 'home.unattendedValue.pausedNoReason',
    });
  });
});
