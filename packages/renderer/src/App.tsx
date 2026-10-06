import {
  Activity,
  Briefcase,
  FileText,
  Languages,
  MessageSquare,
  Moon,
  PanelRight,
  ScrollText,
  ShieldCheck,
  Sun,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { KERNEL_VIEW_WIDTH_RATIO } from '@auto-cc/shared';
import { switchLanguage, type SupportedLanguage } from './i18n';
import { useDeskTheme } from './theme';
import { AssemblyPanel } from './AssemblyPanel';
import { ChatPanel } from './ChatPanel';
import { GapPanel } from './GapPanel';
import { GeneratePanel } from './GeneratePanel';
import { JobLabPanel } from './JobLabPanel';
import { KbPanel } from './KbPanel';
import { LocatorLabPanel } from './LocatorLabPanel';
import { MetricsPanel } from './MetricsPanel';
import { PrivacyNotice, usePrivacyNotice } from './PrivacyNotice';
import { UpdateSection } from './UpdateSection';
import { ResumePanel } from './ResumePanel';
import { ScriptPanel } from './ScriptPanel';
import { SessionPanel } from './SessionPanel';
import { ShellPanel } from './ShellPanel';
import { UsagePanel } from './UsagePanel';
import { WorkflowLabPanel } from './WorkflowLabPanel';
import { WorkflowPanel } from './WorkflowPanel';
import { useWorkflowRun } from './useWorkflowRun';
import { DeskButton } from './ui/controls';

const otherLanguage = (current: string): SupportedLanguage => (current === 'zh-CN' ? 'en' : 'zh-CN');

/**
 * 顶层视图。AGENTS.md §5.9 定的顺序：对话是第一入口；其后四张工作台按用户语言命名
 * （岗位 / 简历 / 流程 / 信任，评审裁定 Q2）；诊断面板再低一档（spec 1.10-07）。
 * 六个视图都常驻挂载，切换只改 display，所以来回切不丢滚动位置也不丢状态（spec 1.10-01）。
 */
type TopView = 'chat' | 'jobs' | 'resume' | 'workflow' | 'trust' | 'diagnostics';

/** 左轨导航的一项。 */
interface DeskEntry {
  view: TopView;
  icon: typeof MessageSquare;
  /** 诊断档为 false：字号与对比度都低一档，不跟工作台抢注意力。 */
  primary: boolean;
}

/** 导航顺序即信息架构：对话第一，四张工作台居中，诊断沉底。 */
const DESK_ENTRIES: DeskEntry[] = [
  { view: 'chat', icon: MessageSquare, primary: true },
  { view: 'jobs', icon: Briefcase, primary: true },
  { view: 'resume', icon: FileText, primary: true },
  { view: 'workflow', icon: WorkflowIcon, primary: true },
  { view: 'trust', icon: ScrollText, primary: true },
  { view: 'diagnostics', icon: Activity, primary: false },
];

/**
 * 每张工作台的标题与一句话说明（i18n 键前缀，实际文案在语言包里）。
 * @param view 目标视图
 * @returns `desk.<view>.title` / `desk.<view>.hint` 两个键
 */
const deskKeys = (view: TopView) => ({ title: `desk.${view}.title`, hint: `desk.${view}.hint` });

/** 首页第一入口：1.11 起是对话面板，四张工作台紧随其后，诊断退到最后一档。 */
export function App() {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<TopView>('chat');
  // 5.9-06：首屏隐私声明。首启动由 localStorage 判定，之后靠标题栏那颗按钮重开，两处共用同一份状态。
  const privacy = usePrivacyNotice();
  const [theme, toggleTheme] = useDeskTheme();
  // 底部状态条只报"有没有在跑、跑到哪一步"，读数来自既有订阅，不新开一条轮询（spec 6.3-05）。
  const { live } = useWorkflowRun();

  /**
   * 左轨按钮的样式，按层级分两档。
   * @param entry 该按钮代表的工作台
   * @returns 完整字面量的 class（Tailwind 扫得到），诊断档刻意比工作台低一档
   */
  const entryClass = (entry: DeskEntry) => {
    const isSelected = entry.view === view;
    if (!entry.primary) {
      return `flex items-center gap-2 rounded-control border-l-2 px-2.5 py-1.5 text-[11px] ${
        isSelected
          ? 'border-l-slate-500 bg-ink-800 text-slate-300'
          : 'border-l-transparent text-slate-500 hover:bg-ink-850 hover:text-slate-400'
      }`;
    }
    return `flex items-center gap-2.5 rounded-control border-l-2 px-2.5 py-2 text-xs font-medium ${
      isSelected
        ? 'border-l-celadon bg-ink-800 text-slate-50'
        : 'border-l-transparent text-slate-400 hover:bg-ink-850 hover:text-slate-100'
    }`;
  };

  /**
   * 一张工作台的容器：标题 + 说明 + 面板堆。
   * @param target 该容器承载的视图
   * @returns section 元素，隐藏时用 `hidden` 而不是不渲染（1.10-01）
   */
  const workspace = (target: TopView) => (
    <section
      data-view-scroll={target}
      className={`${target === view ? 'block' : 'hidden'} min-w-0 flex-1 overflow-y-auto p-5`}
    >
      <header className="mb-4 border-b border-line pb-3">
        <h2 className="text-sm font-semibold text-slate-50">{t(deskKeys(target).title)}</h2>
        <p className="mt-1 text-xs text-slate-400">{t(deskKeys(target).hint)}</p>
      </header>
      <div className="flex flex-col gap-4">{PANELS[target]}</div>
    </section>
  );

  return (
    <div className="flex h-full flex-col bg-ink-950 text-slate-50">
      <header className="flex items-center justify-between gap-4 border-b border-line px-4 py-2.5">
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-sm font-semibold tracking-wide">{t('title')}</h1>
          <p className="text-[11px] text-slate-400">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <DeskButton action="shell-theme-toggle" variant="line" onClick={toggleTheme}>
            {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
            {t(theme === 'dark' ? 'theme.toLight' : 'theme.toDark')}
          </DeskButton>
          <DeskButton
            action="shell-language-switch"
            variant="line"
            onClick={() => switchLanguage(otherLanguage(i18n.resolvedLanguage ?? 'zh-CN'))}
          >
            <Languages size={13} />
            {t('language.switchTo')}
          </DeskButton>
          {/* 5.9-06 的重入口：首屏那一层收起后必须还能一眼找回，否则"读过就再也看不见"是合规上的空洞 */}
          <DeskButton action="privacy-open" variant="line" onClick={privacy.open}>
            <ShieldCheck size={13} />
            {t('privacy.entry')}
          </DeskButton>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          data-testid="view-tabs"
          aria-label={t('nav.aria')}
          className="flex w-[184px] shrink-0 flex-col gap-0.5 border-r border-line bg-ink-900 p-2"
        >
          {DESK_ENTRIES.map((entry) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.view}
                type="button"
                // `chat` / `workflow` 两个值是 harness 与 smoke 脚本的既有凭据，改名等于拆掉验收通道
                data-view={entry.view}
                data-action={`nav-${entry.view}`}
                className={entryClass(entry)}
                onClick={() => setView(entry.view)}
              >
                <Icon size={entry.primary ? 15 : 12} className="shrink-0" />
                {t(`nav.${entry.view}`)}
              </button>
            );
          })}
        </nav>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* 对话是第一入口：它自己不套工作台标题头，输入区直接贴着桌面（§5.9）。 */}
          <section
            data-view-scroll="chat"
            className={`${view === 'chat' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col p-5`}
          >
            <ChatPanel />
          </section>
          {(['jobs', 'resume', 'workflow', 'trust', 'diagnostics'] as TopView[]).map(workspace)}
        </main>

        {/* 槽位宽度与主进程摆位同源：`--kernel-view-width` 必须等于 KERNEL_VIEW_WIDTH_RATIO（1.2-12） */}
        <aside className="flex w-(--kernel-view-width) flex-col border-l border-line bg-ink-900 p-4">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
            <PanelRight size={13} />
            {t('kernel.heading')}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">{t('kernel.hint')}</p>
          <p className="mt-4 font-mono text-[11px] text-slate-600">{KERNEL_VIEW_WIDTH_RATIO * 100}%</p>
        </aside>
      </div>

      {/* 底部状态条常驻：浮层开着时也看得见，所以层级压在遮罩之上（09 稿浮层纪律）。 */}
      <footer className="flex items-center gap-3 border-t border-line bg-ink-900 px-4 py-1.5 text-[11px] text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-celadon' : 'bg-slate-600'}`} aria-hidden="true" />
          {live?.message ?? t('statusbar.idle')}
        </span>
        {live?.stepId ? <span className="font-mono text-slate-500">{live.stepId}</span> : null}
        <span className="ml-auto text-slate-600">{t('statusbar.pointer')}</span>
      </footer>

      {/* 5.9-06：首屏隐私声明是盖在工作台上的覆盖层（fixed），首启动不表态就进不去；
          收起后由标题栏那颗「隐私与条款」按钮随时重开，重开那一次不再算新的表态。 */}
      {privacy.visible && <PrivacyNotice isReopened={privacy.isReopened} onClose={privacy.close} />}
    </div>
  );
}

/**
 * 每张工作台承载的面板清单：只是把既有面板归位，没有新增、没有改逻辑。
 * 归位依据是设计稿的信息架构（03/04/05/06 屏）：
 * 岗位=搜与选（JD 库、话术候选），简历=内容与生成，流程=运行与编排，信任=登录态、额度与漏斗，
 * 诊断=只有开发者看得懂的自测台（桥接自检、更新通道、定位实验室、装配与插件树）。
 */
const PANELS: Record<TopView, ReactNode> = {
  chat: <></>,
  jobs: (
    <>
      <JobLabPanel />
      {/* 4.6-d 的话术候选面板紧跟 JD 库：候选 → 选中 → 打招呼是同一条链的三段，隔开放就要跨面板对目标 */}
      <ScriptPanel />
    </>
  ),
  resume: (
    <>
      <ResumePanel />
      <KbPanel />
      <GapPanel />
      <GeneratePanel />
    </>
  ),
  workflow: <WorkflowPanel />,
  trust: (
    <>
      <SessionPanel />
      {/* 5.8-b 的指标看板排在用量面板前面：五级漏斗是「转化到哪一级」，下面那块是「今天还剩多少额度」 */}
      <MetricsPanel />
      <UsagePanel />
    </>
  ),
  diagnostics: (
    <>
      <ShellPanel />
      {/* 更新通道（5.9-b）紧挨桥接自检台：两者都是"主进程只在被点时动一下"的读数，放一起才对得上同一套口径 */}
      <UpdateSection />
      <LocatorLabPanel />
      <WorkflowLabPanel />
      <AssemblyPanel />
    </>
  ),
};
