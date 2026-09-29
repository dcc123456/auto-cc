import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

export type SupportedLanguage = 'zh-CN' | 'en';

const LANGUAGE_STORAGE_KEY = 'auto-cc.lang';

const isSupported = (value: string | null): value is SupportedLanguage => value === 'zh-CN' || value === 'en';

function detectLanguage(): SupportedLanguage {
  const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (isSupported(stored)) return stored;
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/**
 * 语言资源全部随包本地化（不依赖网络），命名空间即 locale 文件的顶层 key。
 * @returns 已完成初始化的 i18next 实例
 */
export function setupI18n() {
  void i18n.use(initReactI18next).init({
    resources: {
      'zh-CN': { shell: zhCN.shell },
      en: { shell: en.shell },
    },
    ns: ['shell'],
    defaultNS: 'shell',
    lng: detectLanguage(),
    fallbackLng: 'zh-CN',
    interpolation: { escapeValue: false },
  });
  // `index.html` 里的 `lang` 是写死的 zh-CN，而实际语种由 detectLanguage() 决定，
  // 切语言也不动它——读屏软件与翻译插件都以这个属性判断页面语种，所以必须跟着 i18n 走。
  document.documentElement.lang = i18n.language;
  i18n.on('languageChanged', (lng) => {
    document.documentElement.lang = lng;
  });
  return i18n;
}

/**
 * 切换语言并记住选择。
 * @param next 目标语言
 */
export function switchLanguage(next: SupportedLanguage) {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
  void i18n.changeLanguage(next);
}
