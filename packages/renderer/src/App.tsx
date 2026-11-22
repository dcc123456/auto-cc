import {
  Boxes,
  Briefcase,
  FileText,
  History,
  Languages,
  MessageSquare,
  Moon,
  Settings,
  ShieldCheck,
  Sun,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { switchLanguage, type SupportedLanguage } from './i18n';
import { useDeskTheme } from './theme';
import { HomePanel } from './HomePanel';
import { AssistantCapsule, AssistantDock, type AssistantState } from './AssistantDock';
import { pushDeskToast } from './deskToast';
import { JobLabPanel } from './JobLabPanel';
import { JourneyPanel } from './JourneyPanel';
import { KernelCanvasControls, KernelCanvasSlot } from './KernelCanvasSlot';
import { KernelViewSlot, useKernelSlotLayout } from './KernelViewSlot';
import { readKernelViewMode } from './useKernelViewMode';
import { JobTrackingPanel } from './JobTrackingPanel';
import { MetricsPanel } from './MetricsPanel';
import { ModelsPanel } from './ModelsPanel';
import { PrivacyNotice, usePrivacyNotice } from './PrivacyNotice';
import { UpdateSection } from './UpdateSection';
import { ResumeDesk } from './ResumeDesk';
import { ScriptPanel } from './ScriptPanel';
import { SessionPanel } from './SessionPanel';
import { SettingsPanel } from './SettingsPanel';
import { UsagePanel } from './UsagePanel';
import { WorkflowPanel } from './WorkflowPanel';
import { useWorkflowRun } from './useWorkflowRun';
import { useKernelViewVisible } from './useKernelViewVisible';
import { TAKEOVER_SLOT_ID } from './takeoverSlot';
import { deskTierReading, tightestQuota, useDeskStatus } from './deskStatus';
import { DeskButton, DeskTab, DeskViewTrail, NarrowLabel } from './ui/controls';
import { Toast } from './ui/overlays';
/**
 * 顶层视图的名字由 `viewTrail.ts` own：跨视图推进（09 稿形态⑥）是全 app 唯一一处要同时认识
 * 两个视图的契约，联合类型放在那儿才不会长第二份（§2.5）。
 * AGENTS.md §5.9 定的顺序：对话是第一入口；其后工作台按用户语言命名（岗位 / 简历 / 流程 / 模型 /
 * 运行记录），设置再低一档（spec 1.10-07）。七个视图都常驻挂载，切换只改 display，
 * 所以来回切不丢滚动位置也不丢状态（spec 1.10-01）——形态⑥ 的「返回时滚动位置不变」靠的正是这一条。
 */
import { clearViewTrail, useViewTrail, type TopView } from './viewTrail';
import { isLocalSessionUrl } from './platform-choice';
import { platformLabel } from './platform-label';

const otherLanguage = (current: string): SupportedLanguage => (current === 'zh-CN' ? 'en' : 'zh-CN');

/** 左轨导航的一项。 */
interface DeskEntry {
  view: TopView;
  icon: typeof MessageSquare;
  /** 诊断档为 false：字号与对比度都低一档，不跟工作台抢注意力。 */
  primary: boolean;
}

/** 导航顺序即信息架构：对话第一，四张工作台居中，模型独立成页，运行记录与设置沉底。 */
const DESK_ENTRIES: DeskEntry[] = [
  { view: 'chat', icon: MessageSquare, primary: true },
  { view: 'jobs', icon: Briefcase, primary: true },
  { view: 'resume', icon: FileText, primary: true },
  { view: 'workflow', icon: WorkflowIcon, primary: true },
  { view: 'models', icon: Boxes, primary: true },
  { view: 'trust', icon: History, primary: true },
  { view: 'diagnostics', icon: Settings, primary: false },
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
    <span
      className="flex shrink-0 items-center gap-1.5 whitespace-nowrap"
      data-testid="statusbar-item"
      data-item={item}
      data-state={state}
    >
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
  /**
   * 全局助手的三态（plan §14.2）：收起不动布局，展开/最小化占主区右沿一条宽度。
   * 为什么状态在壳层：快捷键是全局的，站点全屏时要先退全屏再开面板——这两件事都只有壳层知道。
   */
  const [assistant, setAssistant] = useState<AssistantState>('closed');
  const [theme, toggleTheme] = useDeskTheme();
  // 「进行中运行」这一格由既有订阅推来（跑到哪一步、说什么），状态条不新开一条轮询（spec 6.3-05）。
  const { live } = useWorkflowRun();
  // 其余三项各自由拥有它的面板报进汇流（`deskStatus.ts`）：状态条只读这一份，不自己去问第二遍（§2.5）。
  const desk = useDeskStatus();
  // 状态条只报真实平台（spec 10.10-10）：本机仿站是给开发/测试看的，摊在底栏会让人以为「我有三个账号」。
  const realPlatforms = (desk.platforms ?? []).filter((platform) => !isLocalSessionUrl(platform.startUrl));
  const activePlatformCount = realPlatforms.filter((platform) => platform.auth === 'active').length;
  const soleRealPlatform = realPlatforms.length === 1 ? realPlatforms[0] : undefined;
  // 掉线优先于计数：这一格先说出的必须是「哪一只刚掉线」，计数等下一次快照自己补齐（朱砂那一档）。
  const authValue = desk.expiredPlatform
    ? t('statusbar.authExpired', { platform: platformLabel(t, desk.expiredPlatform) })
    : !desk.platforms
      ? t('status.none')
      : realPlatforms.length === 0
        ? t('statusbar.authNone')
        : soleRealPlatform
          ? t('statusbar.authOne', {
              platform: platformLabel(t, soleRealPlatform.id),
              state: t(`session.auth.${soleRealPlatform.auth}`),
            })
          : t('statusbar.authValue', { active: activePlatformCount, total: realPlatforms.length });
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
  // 授权单生效时才报「无人值守：已授权 N 岗」（plan §13.2 的 2026-11-21 裁定）；
  // 撤权/停用后授权单不再是 active，这一格自动退回档位名——两处说法因此不会各说一套。
  const tierReading = deskTierReading(desk.tier, desk.authorization);
  const tierValue =
    tierReading.kind === 'unattended'
      ? t('statusbar.unattended', { count: tierReading.count })
      : tierReading.tier
        ? t(`agent.autonomy.${tierReading.tier}`)
        : t('status.none');
  // 档位的点色按「谁替谁做主」：全自动=外发不再逐步问人（朱砂），半自动=每一步等表态（琥珀），建议=只出主意（灰）。
  // 授权生效那一格不是档位读数，涂琥珀（等授权窗口），与「有人替你在发」的朱砂区分开。
  const tierState: DeskSlotState =
    tierReading.kind === 'unattended'
      ? 'ask'
      : tierReading.tier === 'auto'
        ? 'warn'
        : tierReading.tier === 'semi'
          ? 'ask'
          : 'none';
  // 11 片：布局模式启动时读一次（切换靠 reload 整体生效，不许两态同屏各握一份几何事实）。
  const kernelMode = readKernelViewMode();
  // 右栏那一槽位默认不占位（裁定⑱）：只有主进程的内核视图装着真实站点时它才存在，收起时那一条宽度还给主区。
  const kernelViewVisible = useKernelViewVisible();
  // 8.8-02 的展开态与宽度档：主区让不让位由这里判，可见性是它的前置条件——
  // 站点被收回右栏时如果还认着"展开"，主区就藏在一栏根本不存在的位置后面，界面等于空白。
  const kernelLayout = useKernelSlotLayout();
  const kernelExpanded = kernelViewVisible && kernelLayout.isExpanded;

  /**
   * 打开/收起助手。站点全屏时先退出全屏：面板要落在主区里，全屏态主区是被让位的。
   * @returns 无返回值
   */
  const toggleAssistant = (): void => {
    setAssistant((current) => (current === 'open' ? 'closed' : 'open'));
    if (kernelExpanded) {
      kernelLayout.toggleExpanded();
      pushDeskToast({ action: 'assistant-exit-fullscreen', tone: 'jade', message: t('assistant.toastExitFullscreen') });
    }
    // 展开后把焦点送进输入卡（10.11-13）：等一帧，面板那一支此时刚挂上。
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')?.focus();
    });
  };

  // 快捷键：Ctrl/⌘+J 呼出；Esc 收起并把焦点还给胶囊（非模态，Esc 只在助手开着时接管）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && (event.key === 'j' || event.key === 'J')) {
        event.preventDefault();
        toggleAssistant();
        return;
      }
      if (event.key === 'Escape' && assistant === 'open') {
        setAssistant('closed');
        document.querySelector<HTMLButtonElement>('[data-action="assistant-capsule"]')?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

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

  /**
   * 主区那棵四屏树：对话是第一入口（它自己不套工作台标题头），其余六屏按现有导航切换。
   *
   * 它被两种布局共用：常驻分栏态下是左栏（全屏态让位、`hidden` 不销毁，1.10-01），
   * sidebar 回滚态下仍是原来那一整块 `flex-1` 主区。抽成常量只为让两条分支共用同一份节点树，
   * 不新增长第二套视图（§2.5）。
   */
  const deskMain = (
    <main className="relative flex min-h-0 min-w-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <section
          data-view-scroll="chat"
          className={`${view === 'chat' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-5`}
        >
          <HomePanel />
        </section>
        {(['jobs', 'resume', 'workflow', 'models', 'trust', 'diagnostics'] as TopView[]).map(workspace)}

        {/* 09 稿形态① 1-B 的左下角 toast：挂在主区这一层，七张视图切来切去都只有这一只通道，
            各面板不许再各自长一份（同一时刻只允许一只由 deskToast 汇流自己保证）。 */}
        <Toast />
      </div>
      {/* 助手面板占主区右沿的一条宽度：内核站点在 `main` 之外，由它自己的 ResizeObserver 上报让位，
          所以「DOM 悬在原生视图上」这件事根本不会发生（plan §14.6 的几何判据）。 */}
      <AssistantDock
        state={assistant}
        onMinimize={() => setAssistant('minimized')}
        onExpand={() => setAssistant('open')}
        onClose={() => setAssistant('closed')}
      />
    </main>
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
          {/* 11-06：分栏态的两颗键（显示/隐藏、全屏往返）都在顶栏——顶栏在上报矩形之上，
              原生视图永远盖不到它们（旧实现的假矩形铺满整窗时，这颗键整颗被吃掉，皇上点不到）。
              sidebar 回滚态仍由 `KernelViewSlot` 工具行上的两键承担（旧代码整段保留）。 */}
          {kernelMode === 'canvas' ? <KernelCanvasControls layout={kernelLayout} visible={kernelViewVisible} /> : null}
          {/* 5.9-06 的重入口：首屏那一层收起后必须还能一眼找回，否则"读过就再也看不见"是合规上的空洞 */}
          <AssistantCapsule state={assistant} onToggle={toggleAssistant} />
          <DeskButton action="privacy-open" variant="line" title={t('privacy.entry')} onClick={privacy.open}>
            <ShieldCheck size={13} />
            <NarrowLabel>{t('privacy.entry')}</NarrowLabel>
          </DeskButton>
        </div>
      </header>

      {/* 接管横幅的全局槽位（spec 10.11-19）：`ChatPanel` 往这里 portal，横幅因此在任何视图上都常驻；
          助手面板收起后 `ChatPanel` 仍挂载，所以这份读数不会因为收起而消失。 */}
      <div id={TAKEOVER_SLOT_ID} data-testid="takeover-slot" className="shrink-0" />

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

        {/* 11-03 常驻分栏（canvas）：主区先分成左栏四屏 + 右栏站点，二者的父容器就是「主区」——
            右栏按它的 65% 算宽，上报矩形因此严格落在内容区之内（左轨以右、header 下沿到 footer 上沿）；
            旧的 `absolute inset-0` 会逃到最近定位祖先（没有就是视口）铺成整扇窗口，那种假矩形不再出现。
            全屏态左栏让位（节点不销毁），右栏 flex-1 盖满主区；控制键都在顶栏，落在上报矩形之外。
            裁定⑱ 仍成立：站点被收起时右栏整个不存在，左栏拿回整条宽度。
            回滚态（sidebar）结构一字不动：`KernelViewSlot` 仍直接挂在外层行里量右栏槽位（11-07）。 */}
        {kernelMode === 'canvas' ? (
          <div data-testid="kernel-canvas-stage" className="flex min-h-0 min-w-0 flex-1">
            {kernelExpanded ? null : deskMain}
            {kernelViewVisible ? <KernelCanvasSlot layout={kernelLayout} /> : null}
          </div>
        ) : (
          <>
            {kernelExpanded ? null : deskMain}
            <KernelViewSlot layout={kernelLayout} viewVisible={kernelViewVisible} />
          </>
        )}
      </div>

      {/* 底部状态条常驻：浮层开着时也看得见，所以层级压在遮罩之上（09 稿浮层纪律）。
          四项读数全部来自既有 service 的那一次读取或那一条推送（spec 6.3-05）：运行由 `workflow/progress` 推来，
          其余三项由 `SessionPanel` / `UsagePanel` / `ChatPanel` 各自重读后报进 `deskStatus` 汇流——这里零条定时器。 */}
      <footer
        data-testid="statusbar"
        className="flex flex-wrap items-center gap-x-4 gap-y-0.5 border-t border-line bg-ink-950 px-4 py-1.5 font-mono text-[10.5px] text-slate-500"
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
 * 岗位=搜与选（JD 库、话术候选），简历=导入与生成，流程=运行与编排，模型=提供商与默认模型，
 * 运行记录=登录态、额度与漏斗，设置=版本信息与更新检查（开发者实验台已从产品界面退场）。
 */
const PANELS: Record<TopView, ReactNode> = {
  chat: <></>,
  jobs: (
    <>
      <JobLabPanel />
      {/* M2-B 求职主链：意向 → 按意向搜岗 → 可解释匹配 → 定制/招呼 → 面试材料。放在岗位工作台内，
          不新增顶级菜单；每颗按钮直接打 journey.* 白名单口，与 agent 工具、工作流节点共用同一服务。 */}
      <JourneyPanel />
      {/* 4.6-d 的话术候选面板紧跟 JD 库：候选 → 选中 → 打招呼是同一条链的三段，隔开放就要跨面板对目标 */}
      <ScriptPanel />
    </>
  ),
  resume: <ResumeDesk />,
  workflow: <WorkflowPanel />,
  models: <ModelsPanel />,
  trust: (
    <>
      <SessionPanel />
      {/* 5.8-b 的指标看板排在用量面板前面：五级漏斗是「转化到哪一级」，下面那块是「今天还剩多少额度」 */}
      <MetricsPanel />
      <JobTrackingPanel />
      <UsagePanel />
    </>
  ),
  diagnostics: (
    <>
      <SettingsPanel />
      {/* 更新通道（5.9-b）是用户真正要用的那一块，留在设置页；其余开发者实验台已退场 */}
      <UpdateSection />
    </>
  ),
};
