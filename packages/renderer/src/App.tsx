import { Languages } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KERNEL_VIEW_WIDTH_RATIO } from '@auto-cc/shared';
import { switchLanguage, type SupportedLanguage } from './i18n';
import { AssemblyPanel } from './AssemblyPanel';
import { SessionPanel } from './SessionPanel';
import { ShellPanel } from './ShellPanel';
import { UsagePanel } from './UsagePanel';
import { WorkflowPanel } from './WorkflowPanel';

const otherLanguage = (current: string): SupportedLanguage => (current === 'zh-CN' ? 'en' : 'zh-CN');

/**
 * 顶层视图。1.10 先立「工作流是独立视图」这条结构，1.11 的对话式主界面再来争第一入口
 * （AGENTS.md §5.9）——所以现在只有两档，且诊断面板不会跟工作流挤在同一条滚动里。
 */
type TopView = 'workflow' | 'diagnostics';

/** 首页第一入口：1.2 阶段是壳自检面板，1.10 起工作流独立成视图。 */
export function App() {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<TopView>('workflow');

  /**
   * 视图按钮的样式，按层级分两档。
   * @param target 该按钮代表的视图
   * @returns 完整字面量的 class（Tailwind 扫得到），诊断档刻意比主视图低一档
   */
  const tabClass = (target: TopView) => {
    const isSelected = target === view;
    // 调试面板与插件树是次级入口：字号、对比度都低于主视图（spec 1.10-07）。
    if (target === 'diagnostics') {
      return `border-l border-slate-800 px-3 py-1 text-[11px] ${
        isSelected ? 'text-slate-200' : 'text-slate-500 hover:bg-slate-800/60'
      }`;
    }
    return isSelected
      ? 'rounded-md border border-slate-700 bg-slate-800 px-3 py-1 text-xs text-slate-100'
      : 'rounded-md border border-transparent px-3 py-1 text-xs text-slate-400 hover:bg-slate-800/60';
  };

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-6 py-3">
        <div>
          <h1 className="text-base font-semibold">{t('title')}</h1>
          <p className="text-xs text-slate-400">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <nav className="flex items-center gap-1" data-testid="view-tabs">
            <button
              type="button"
              data-view="workflow"
              className={tabClass('workflow')}
              onClick={() => setView('workflow')}
            >
              {t('nav.workflow')}
            </button>
            <button
              type="button"
              data-view="diagnostics"
              className={tabClass('diagnostics')}
              onClick={() => setView('diagnostics')}
            >
              {t('nav.diagnostics')}
            </button>
          </nav>
          <button
            type="button"
            onClick={() => switchLanguage(otherLanguage(i18n.resolvedLanguage ?? 'zh-CN'))}
            className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            <Languages size={14} />
            {t('language.switchTo')}
          </button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1">
        {/* 两个视图各自是一个滚动容器，切换只改 display 不卸载，所以回来时滚动位置还在（1.10-01）。 */}
        <section
          data-view-scroll="workflow"
          className={`${view === 'workflow' ? 'block' : 'hidden'} min-w-0 flex-1 overflow-y-auto p-6`}
        >
          <WorkflowPanel />
        </section>
        <section
          data-view-scroll="diagnostics"
          className={`${view === 'diagnostics' ? 'block' : 'hidden'} min-w-0 flex-1 overflow-y-auto p-6`}
        >
          <div className="flex flex-col gap-4">
            <ShellPanel />
            <SessionPanel />
            <UsagePanel />
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
