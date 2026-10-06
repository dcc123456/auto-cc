import { useEffect, useState } from 'react';

/** 两套材质：墨案（深色桌面）与毡案（浅色桌面）。切主题只换 token，不换布局（06 计划 plan §3.1）。 */
export type DeskTheme = 'dark' | 'light';

const THEME_STORAGE_KEY = 'auto-cc.theme';

/**
 * 读本机已存的主题偏好；没表过态就用墨案（设计稿的主案）。
 * @returns 当前应生效的主题
 */
export function currentTheme(): DeskTheme {
  return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
}

/**
 * 把主题写到 `<html data-theme>` 上——`globals.css` 的毡案覆盖块就挂在这个选择器上。
 * @param theme 目标主题
 */
export function applyTheme(theme: DeskTheme): void {
  document.documentElement.dataset.theme = theme;
}

// 模块被 import 时立刻落一次：等 React 首帧再改属性，浅色下会先闪一下墨案。
applyTheme(currentTheme());

/**
 * 主题开关：返回当前主题与"翻面并记住"的动作（与 `i18n.ts` 的 `switchLanguage` 同一条存法）。
 * @returns `[当前主题, 切换到另一套材质]`
 */
export function useDeskTheme(): [DeskTheme, () => void] {
  const [theme, setTheme] = useState<DeskTheme>(currentTheme);

  const toggle = () => {
    const next: DeskTheme = theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
    setTheme(next);
  };

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return [theme, toggle];
}
