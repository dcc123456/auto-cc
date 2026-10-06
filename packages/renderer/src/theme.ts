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
 * 翻面时要现报的订阅者。
 * 为什么需要这一条：`App.tsx` 的 `PANELS` 是**模块常量**，那些 `<ResumePanel />` 元素在模块求值那一刻就造好了，
 * App 因主题 state 变化而重渲染时拿到的是同一个元素引用，React 因此整棵子树空转（不重渲染）。
 * 所以画布这类"必须跟着材质重画一次"的组件不能靠 prop 或依赖数组里的 `currentTheme()` 收到翻面。
 */
const themeListeners = new Set<() => void>();

/**
 * 把主题写到 `<html data-theme>` 上——`globals.css` 的毡案覆盖块就挂在这个选择器上。
 * 改主题只有这一处入口，所以报订阅也只写在这里（写在别处就会出现两套通知）。
 * @param theme 目标主题
 */
export function applyTheme(theme: DeskTheme): void {
  document.documentElement.dataset.theme = theme;
  for (const notify of themeListeners) notify();
}

// 模块被 import 时立刻落一次：等 React 首帧再改属性，浅色下会先闪一下墨案。
applyTheme(currentTheme());

/**
 * 订阅当前材质：给"不在 App 重渲染路径上、但画面必须跟着翻面"的组件用（画布类，见 `themeListeners` 那条注释）。
 * 只要材质就够了——翻面这个动作仍归标题栏那颗开关，这里不发出第二个入口（§2.5）。
 * @returns 当前生效的主题，随 `applyTheme` 更新
 */
export function useDeskThemeValue(): DeskTheme {
  const [theme, setTheme] = useState<DeskTheme>(currentTheme);

  useEffect(() => {
    const notify = () => setTheme(currentTheme());
    themeListeners.add(notify);
    // 挂载与订阅之间可能已经翻过一次，所以挂上之后要现读一次补上这一格。
    notify();
    return () => {
      themeListeners.delete(notify);
    };
  }, []);

  return theme;
}

/**
 * 主题开关：返回当前主题与"翻面并记住"的动作（与 `i18n.ts` 的 `switchLanguage` 同一条存法）。
 * 读数取 `useDeskThemeValue`：写 localStorage 之后真正生效的那一步是 `applyTheme`，
 * 由它统一报订阅，这里不另存一份 state（两处各存一份迟早漂，§2.5）。
 * @returns `[当前主题, 切换到另一套材质]`
 */
export function useDeskTheme(): [DeskTheme, () => void] {
  const theme = useDeskThemeValue();

  const toggle = () => {
    const next: DeskTheme = theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
  };

  return [theme, toggle];
}
