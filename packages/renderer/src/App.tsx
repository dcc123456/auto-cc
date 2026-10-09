import {
  Activity,
  Briefcase,
  FileText,
  Languages,
  MessageSquare,
  Moon,
  ScrollText,
  ShieldCheck,
  Sun,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { switchLanguage, type SupportedLanguage } from './i18n';
import { useDeskTheme } from './theme';
import { AssemblyPanel } from './AssemblyPanel';
import { ChatPanel } from './ChatPanel';
import { GapPanel } from './GapPanel';
import { GeneratePanel } from './GeneratePanel';
import { JobLabPanel } from './JobLabPanel';
import { KbPanel } from './KbPanel';
import { KernelViewSlot, useKernelSlotLayout } from './KernelViewSlot';
import { LocatorLabPanel } from './LocatorLabPanel';
import { MetricsPanel } from './MetricsPanel';
import { ModelSettingsPanel } from './ModelSettingsPanel';
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
import { useKernelViewVisible } from './useKernelViewVisible';
import { tightestQuota, useDeskStatus } from './deskStatus';
import { DeskButton, DeskTab, DeskViewTrail, NarrowLabel } from './ui/controls';
import { Toast } from './ui/overlays';
/**
 * 顶层视图的名字由 `viewTrail.ts` own：跨视图推进（09 稿形态⑥）是全 app 唯一一处要同时认识
 * 两个视图的契约，联合类型放在那儿才不会长第二份（§2.5）。
 * AGENTS.md §5.9 定的顺序：对话是第一入口；其后四张工作台按用户语言命名（岗位 / 简历 / 流程 /
 * 信任，评审裁定 Q2）；诊断面板再低一档（spec 1.10-07）。六个视图都常驻挂载，切换只改 display，
 * 所以来回切不丢滚动位置也不丢状态（spec 1.10-01）——形态⑥ 的「返回时滚动位置不变」靠的正是这一条。
 */
import { clearViewTrail, useViewTrail, type TopView } from './viewTrail';

const otherLanguage = (current: string): SupportedLanguage => (current === 'zh-CN' ? 'en' : 'zh-CN');

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

/** 状态条一格的档位：点色按 plan §5 的归属语言走（灰那一档含「还没读到」与「建议档」两种安静态）。 */
type DeskSlotState = 'live' | 'ok' | 'warn' | 'ask' | 'none';

/** 一格状态点：进行中=青瓷、已核=青玉、被拦下=朱砂、等人表态=琥珀、安静/未读=灰。 */
const STATUS_DOT_CLASS: Record<DeskSlotState, string> = {
  live: 'bg-celadon',
  ok: 'bg-jade',
  warn: 'bg-seal',
  ask: 'bg-amber',
  none: 'bg-slate-600',
};

/**
 * 底部状态条的一格（06 稿 `.foot` 的画法：`标签 读数` + 一颗归属色点）。
 * @param item 这一格是哪一项读数（harness 按它断言，不用译文）
 * @param label 项名（已翻译）
 * @param value 读数文本；还没读到时是「尚未读取」而不是 0
 * @param state 归属档位，决定点色与 `data-state`
 * @returns 一格 span
 */
function statusSlot(item: string, label: string, value: string, state: DeskSlotState) {
  return (
    <span className="flex items-center gap-1.5" data-testid="statusbar-item" data-item={item} data-state={state}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT_CLASS[state]}`} aria-hidden="true" />
      <span className="text-slate-400">{label}</span>
      <span>{value}</span>
    </span>
  );
}

/** 首页第一入口：1.11 起是对话面板，四张工作台紧随其后，诊断退到最后一档。 */
export function App() {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<TopView>('chat');
  /**
   * 09 稿形态⑥（spec 6.2-24）：跨视图推进的那一跳。切格只改 `hidden`，六个容器都不卸载，
   * 所以「返回」时来源视图的滚动位置原样还在——这一条不是本片新加的机制，是 1.10-01 已有的画法。
   */
  const trail = useViewTrail();
  useEffect(() => {
    if (trail) setView(trail.targetView);
  }, [trail]);
  // 5.9-06：首屏隐私声明。首启动由 localStorage 判定，之后靠标题栏那颗按钮重开，两处共用同一份状态。
  const privacy = usePrivacyNotice();
  const [theme, toggleTheme] = useDeskTheme();
  // 「进行中运行」这一格由既有订阅推来（跑到哪一步、说什么），状态条不新开一条轮询（spec 6.3-05）。
  const { live } = useWorkflowRun();
  // 其余三项各自由拥有它的面板报进汇流（`deskStatus.ts`）：状态条只读这一份，不自己去问第二遍（§2.5）。
  const desk = useDeskStatus();
  const activePlatformCount = desk.platforms?.filter((platform) => platform.auth === 'active').length ?? 0;
  // 掉线优先于计数：这一格先说出的必须是「哪一只刚掉线」，计数等下一次快照自己补齐（朱砂那一档）。
  const authValue = desk.expiredPlatform
    ? t('statusbar.authExpired', { platform: desk.expiredPlatform })
    : !desk.platforms
      ? t('status.none')
      : desk.platforms.length === 0
        ? t('statusbar.authNone')
        : t('statusbar.authValue', { active: activePlatformCount, total: desk.platforms.length });
  const authState: DeskSlotState = desk.expiredPlatform ? 'warn' : activePlatformCount > 0 ? 'ok' : 'none';
  const quota = tightestQuota(desk.quota);
  const quotaValue = !quota
    ? t('status.none')
    : quota.isDenied
      ? t('statusbar.quotaDenied', { action: quota.action })
      : quota.remaining === null
        ? t('statusbar.quotaUnlimited')
        : t('statusbar.quotaValue', { action: quota.action, count: quota.remaining });
  const quotaState: DeskSlotState = !quota ? 'none' : quota.isDenied ? 'warn' : 'ok';
  const tierValue = desk.tier ? t(`agent.autonomy.${desk.tier}`) : t('status.none');
  // 档位的点色按「谁替谁做主」：全自动=外发不再逐步问人（朱砂），半自动=每一步等表态（琥珀），建议=只出主意（灰）。
  const tierState: DeskSlotState = desk.tier === 'auto' ? 'warn' : desk.tier === 'semi' ? 'ask' : 'none';
  // 右栏那一槽位默认不占位（裁定⑱）：只有主进程的内核视图装着真实站点时它才存在，收起时那一条宽度还给主区。
  const kernelViewVisible = useKernelViewVisible();
  // 8.8-02 的展开态与宽度档：主区让不让位由这里判，可见性是它的前置条件——
  // 站点被收回右栏时如果还认着"展开"，主区就藏在一栏根本不存在的位置后面，界面等于空白。
  const kernelLayout = useKernelSlotLayout();
  const kernelExpanded = kernelViewVisible && kernelLayout.isExpanded;

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
      {/* 只在"这一跳的目标正是这一格"时长出来；手动切视图不带面包屑（09 稿：同视图内锚点跳转也不需要）。 */}
      {trail && trail.targetView === target ? (
        <div className="mb-4">
          <DeskViewTrail
            action={`trail-${trail.sourceView}-to-${target}`}
            fromLabel={t('desk.trailFrom')}
            sourceTitle={trail.sourceTitle}
            sourceDetail={trail.sourceDetail}
            targetTitle={trail.targetTitle}
            targetDetail={trail.targetDetail}
            backLabel={t('desk.trailBack', { view: trail.sourceTitle })}
            onBack={() => {
              setView(trail.sourceView);
              clearViewTrail();
            }}
          />
        </div>
      ) : null}
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
          {/* 三颗系统级键都是"宽带文字、窄带图标"（<1120px 退成纯图标）：窗口一窄，
              最先被挤出标题栏的就是这一排，而它们各自只有一颗图标认得出来。 */}
          <DeskButton
            action="shell-theme-toggle"
            variant="line"
            title={t(theme === 'dark' ? 'theme.toLight' : 'theme.toDark')}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
            <NarrowLabel>{t(theme === 'dark' ? 'theme.toLight' : 'theme.toDark')}</NarrowLabel>
          </DeskButton>
          <DeskButton
            action="shell-language-switch"
            variant="line"
            title={t('language.switchTo')}
            onClick={() => switchLanguage(otherLanguage(i18n.resolvedLanguage ?? 'zh-CN'))}
          >
            <Languages size={13} />
            <NarrowLabel>{t('language.switchTo')}</NarrowLabel>
          </DeskButton>
          {/* 5.9-06 的重入口：首屏那一层收起后必须还能一眼找回，否则"读过就再也看不见"是合规上的空洞 */}
          <DeskButton action="privacy-open" variant="line" title={t('privacy.entry')} onClick={privacy.open}>
            <ShieldCheck size={13} />
            <NarrowLabel>{t('privacy.entry')}</NarrowLabel>
          </DeskButton>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          data-testid="view-tabs"
          aria-label={t('nav.aria')}
          className="flex w-(--desk-nav-width) shrink-0 flex-col gap-0.5 border-r border-line bg-ink-900 p-2"
        >
          {DESK_ENTRIES.map((entry) => (
            <DeskTab
              key={entry.view}
              // `chat` / `workflow` 两个值是 harness 与 smoke 脚本的既有凭据，改名等于拆掉验收通道
              view={entry.view}
              action={`nav-${entry.view}`}
              selected={entry.view === view}
              icon={entry.icon}
              tier={entry.primary ? 'primary' : 'muted'}
              onClick={() => {
                // 人自己切格就不带来源了：面包屑只属于"那一跳"，留着它会指向一条已经走不通的回程。
                clearViewTrail();
                setView(entry.view);
              }}
            >
              {t(`nav.${entry.view}`)}
            </DeskTab>
          ))}
        </nav>

        {/* 裁定⑱：内核视图没装着站点时这一栏整个**不存在**，`flex-1` 的主区拿回那一条宽度。
            展开态（8.8-02）把主区整个让出去：主区是同一棵 flex 里的兄弟，留着它就量不进右栏该占的矩形；
            收起时它原样回来，不销毁、各视图的滚动位置也不丢。
            `kernelExpanded` 必须同时看可见性——站点被收回时只认偏好，主区就藏在一栏不存在的位置后面。 */}
        {kernelExpanded ? null : (
          <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {/* 对话是第一入口：它自己不套工作台标题头，输入区直接贴着桌面（§5.9）。 */}
            <section
              data-view-scroll="chat"
              className={`${view === 'chat' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col p-5`}
            >
              <ChatPanel />
            </section>
            {(['jobs', 'resume', 'workflow', 'trust', 'diagnostics'] as TopView[]).map(workspace)}

            {/* 09 稿形态① 1-B 的左下角 toast：挂在主区这一层，六张视图切来切去都只有这一只通道，
                各面板不许再各自长一份（同一时刻只允许一只由 deskToast 汇流自己保证）。 */}
            <Toast />
          </main>
        )}

        {/* 槽位的几何由这一栏自己量、并报给主进程（`KernelViewSlot` / spec 8.8-01）：原生视图只铺报来的那一块，
            于是既盖不住顶部标题栏与底部状态条，也铺得出真实站点的桌面宽度。
            最窄那一档仍是 `--kernel-view-width`，与主进程的兜底比例同源（1.2-12 的机检照旧）。 */}
        {kernelViewVisible ? <KernelViewSlot layout={kernelLayout} /> : null}
      </div>

      {/* 底部状态条常驻：浮层开着时也看得见，所以层级压在遮罩之上（09 稿浮层纪律）。
          四项读数全部来自既有 service 的那一次读取或那一条推送（spec 6.3-05）：运行由 `workflow/progress` 推来，
          其余三项由 `SessionPanel` / `UsagePanel` / `ChatPanel` 各自重读后报进 `deskStatus` 汇流——这里零条定时器。 */}
      <footer
        data-testid="statusbar"
        className="flex items-center gap-4 border-t border-line bg-ink-950 px-4 py-1.5 font-mono text-[10.5px] text-slate-500"
      >
        {statusSlot('run', t('statusbar.run'), live?.message ?? t('statusbar.idle'), live ? 'live' : 'none')}
        {live?.stepId ? <span className="text-slate-600">{live.stepId}</span> : null}
        {statusSlot('auth', t('statusbar.auth'), authValue, authState)}
        {statusSlot('quota', t('statusbar.quota'), quotaValue, quotaState)}
        {statusSlot('tier', t('statusbar.tier'), tierValue, tierState)}
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
      {/* P7 · 7.1-11 的模型设置分区排在最后一格：信任这一栏讲的是"这台机器替谁说话"，
          而模型 key 就是那份凭证——它必须在人能看到登录态与额度的同一栏里，而不是新开一视。 */}
      <ModelSettingsPanel />
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
