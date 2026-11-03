import type { TFunction } from 'i18next';

/**
 * 平台码 → 页面上的人话专名。
 *
 * 话术面板与岗位屏的抓取平台选择画的是同一批码，所以这条映射只留一处（AGENTS.md §2.2）。
 * 语言包没备专名的码原样返回：不给未知平台编一个名字，也不让漏翻译变成一句空白。
 * @param translate 调用方的翻译函数（`useTranslation` 的那个 `t`）
 * @param code 平台标识（如 `boss`）
 * @returns 语言包里的专名；没有对应键时就是 `code` 本身
 */
export const platformLabel = (translate: TFunction, code: string): string =>
  translate(`platformName.${code}`, { defaultValue: code });
