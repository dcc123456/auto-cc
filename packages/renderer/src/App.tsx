import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { KERNEL_VIEW_WIDTH_RATIO } from '@auto-cc/shared';
import { switchLanguage, type SupportedLanguage } from './i18n';
import { AssemblyPanel } from './AssemblyPanel';
import { SessionPanel } from './SessionPanel';
import { ShellPanel } from './ShellPanel';

const otherLanguage = (current: string): SupportedLanguage => (current === 'zh-CN' ? 'en' : 'zh-CN');

/** 首页第一入口：1.2 阶段是壳自检面板，1.11 起在此挂载对话式界面。 */
export function App() {
  const { t, i18n } = useTranslation();

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-6 py-3">
        <div>
          <h1 className="text-base font-semibold">{t('title')}</h1>
          <p className="text-xs text-slate-400">{t('subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={() => switchLanguage(otherLanguage(i18n.resolvedLanguage ?? 'zh-CN'))}
          className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
        >
          <Languages size={14} />
          {t('language.switchTo')}
        </button>
      </header>

      <main className="flex min-h-0 flex-1">
        <section className="min-w-0 flex-1 overflow-y-auto p-6">
          <div className="flex flex-col gap-4">
            <ShellPanel />
            <SessionPanel />
            <AssemblyPanel />
          </div>
        </section>
        {/* 槽位宽度与主进程摆位同源：`--kernel-view-width` 必须等于 KERNEL_VIEW_WIDTH_RATIO（1.2-12） */}
        <aside className="w-(--kernel-view-width) border-l border-slate-800 bg-slate-900/40 p-6">
          <h2 className="text-sm font-semibold text-slate-300">{t('kernel.heading')}</h2>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">{t('kernel.hint')}</p>
          <p className="mt-6 text-xs text-slate-600">{KERNEL_VIEW_WIDTH_RATIO * 100}%</p>
        </aside>
      </main>
    </div>
  );
}
