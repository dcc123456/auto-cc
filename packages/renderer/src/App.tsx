import { Languages, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KERNEL_VIEW_WIDTH_RATIO } from '@auto-cc/shared';
import { switchLanguage, type SupportedLanguage } from './i18n';
import { AssemblyPanel } from './AssemblyPanel';
import { ChatPanel } from './ChatPanel';
import { GapPanel } from './GapPanel';
import { GeneratePanel } from './GeneratePanel';
import { JobLabPanel } from './JobLabPanel';
import { KbPanel } from './KbPanel';
import { LocatorLabPanel } from './LocatorLabPanel';
import { MetricsPanel } from './MetricsPanel';
import { PrivacyNotice, usePrivacyNotice } from './PrivacyNotice';
import { ResumePanel } from './ResumePanel';
import { ScriptPanel } from './ScriptPanel';
import { SessionPanel } from './SessionPanel';
import { ShellPanel } from './ShellPanel';
import { UsagePanel } from './UsagePanel';
import { WorkflowLabPanel } from './WorkflowLabPanel';
import { WorkflowPanel } from './WorkflowPanel';

const otherLanguage = (current: string): SupportedLanguage => (current === 'zh-CN' ? 'en' : 'zh-CN');

/**
 * 顶层视图。AGENTS.md §5.9 定的顺序：对话是第一入口，工作流第二，诊断面板再低一档。
 * 三个视图都常驻挂载，切换只改 display，所以来回切不丢滚动位置也不丢状态（spec 1.10-01）。
 */
type TopView = 'chat' | 'workflow' | 'diagnostics';

/** 首页第一入口：1.11 起是对话面板，工作流退居第二视图。 */
export function App() {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<TopView>('chat');
  // 5.9-06：首屏隐私声明。首启动由 localStorage 判定，之后靠标题栏那颗按钮重开，两处共用同一份状态。
  const privacy = usePrivacyNotice();

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
            <button type="button" data-view="chat" className={tabClass('chat')} onClick={() => setView('chat')}>
              {t('nav.chat')}
            </button>
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
          {/* 5.9-06 的重入口：首屏那一层收起后必须还能一眼找回，否则"读过就再也看不见"是合规上的空洞 */}
          <button
            type="button"
            data-action="privacy-open"
            onClick={privacy.open}
            className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            <ShieldCheck size={14} />
            {t('privacy.entry')}
          </button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1">
        {/* 三个视图各自是一个容器，切换只改 display 不卸载，所以回来时滚动位置还在（1.10-01）。 */}
        <section
          data-view-scroll="chat"
          className={`${view === 'chat' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col p-6`}
        >
          <ChatPanel />
        </section>
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
            <LocatorLabPanel />
            <JobLabPanel />
            {/* 4.6-d 的话术候选面板紧跟 JD 库：候选 → 选中 → 打招呼是同一条链的三段，隔开放就要跨面板对目标 */}
            <ScriptPanel />
            <ResumePanel />
            <KbPanel />
            <GapPanel />
            <GeneratePanel />
            <WorkflowLabPanel />
            {/* 5.8-b 的指标看板排在用量面板前面：五级漏斗是「转化到哪一级」，下面那块是「今天还剩多少额度」 */}
            <MetricsPanel />
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

      {/* 5.9-06：首屏隐私声明是盖在工作台上的覆盖层（fixed），首启动不表态就进不去；
          收起后由标题栏那颗「隐私与条款」按钮随时重开，重开那一次不再算新的表态。 */}
      {privacy.visible && <PrivacyNotice isReopened={privacy.isReopened} onClose={privacy.close} />}
    </div>
  );
}
