/**
 * 全局助手：顶栏胶囊 + 主区右沿停靠面板（spec 10.11-10～14；plan §14.2 的 C 方案）。
 *
 * 三态：`open`（展开） / `minimized`（48px 状态条） / `closed`（只改 `display`，面板常驻挂载——
 * 收起不丢输入草稿、也不断正在跑的 run，这是 10.11-12 的判据）。
 * 非模态：无遮罩、不锁 Tab、背后页面照常可滚可点；Esc 关闭并把焦点还给胶囊（键盘那一半在 `App` 里挂，
 * 因为快捷键是全局的，且全屏退让也归壳层）。
 *
 * 为什么面板画在 `main` 里而不是窗口层：内核站点是原生 `WebContentsView`，DOM 悬在它上面不成立
 * （plan §14.6 的几何不重叠判据）。面板占主区右沿的宽度，内核视图由它自己的 `ResizeObserver`
 * 上报让位——不新建窗口、不新增 IPC、不赌 z-index。
 */
import { MessageCircle, Minus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ChatPanel } from './ChatPanel';
import { useAssistantStatus } from './assistantStatus';
import { DeskButton } from './ui/controls';

/** 助手面板的三种状态（收起只改 `display`，因此它不是一个未挂载分支）。 */
export type AssistantState = 'closed' | 'open' | 'minimized';

export interface AssistantCapsuleProps {
  /** 当前状态（决定 `aria-expanded`） */
  state: AssistantState;
  /** 点胶囊：收起时打开、打开时收起（最小化时也打开） */
  onToggle: () => void;
}

/**
 * 顶栏最右的「助手」胶囊。
 * @param props 见 `AssistantCapsuleProps`
 * @returns 一颗 32px 高的键：图标 + 短词（窄窗只留图标），右侧按三态挂角标
 */
export function AssistantCapsule({ state, onToggle }: AssistantCapsuleProps) {
  const { t } = useTranslation();
  const status = useAssistantStatus();
  const isOpen = state === 'open';
  const needsYou = status.needsYou ?? 0;
  return (
    <DeskButton
      action="assistant-capsule"
      variant={isOpen ? 'solid' : 'line'}
      compact
      className="h-8"
      aria-expanded={isOpen}
      aria-controls="assistant-panel"
      aria-keyshortcuts="Control+J Meta+J"
      markers={{ testid: 'assistant-capsule', state, needs: String(needsYou) }}
      aria-label={t('assistant.capsule')}
      onClick={onToggle}
    >
      <MessageCircle size={13} />
      <span className="hidden min-[1120px]:inline">{t('assistant.capsule')}</span>
      {/* 角标三态：需要你=琥珀计数、被拦=朱砂点、在跑=青瓷点；普通未读不亮（spec 10.11-11）。 */}
      {status.blocked ? (
        <span
          data-testid="assistant-badge"
          data-kind="blocked"
          className="size-1.5 rounded-full bg-seal"
          aria-label={t('assistant.badge.blocked')}
        />
      ) : needsYou > 0 ? (
        <span
          data-testid="assistant-badge"
          data-kind="needs"
          className="grid size-4 place-items-center rounded-full bg-amber text-[9px] font-semibold text-ink-900"
          aria-label={t('assistant.badge.needs', { count: needsYou })}
        >
          {needsYou}
        </span>
      ) : status.running ? (
        <span
          data-testid="assistant-badge"
          data-kind="running"
          className="size-1.5 rounded-full bg-celadon"
          aria-label={t('assistant.badge.running')}
        />
      ) : null}
    </DeskButton>
  );
}

export interface AssistantDockProps {
  /** 面板状态 */
  state: AssistantState;
  /** 最小化（保留 48px 状态条） */
  onMinimize: () => void;
  /** 从最小化恢复展开（与最小化分开：两颗键做的是两件事，不能共用一个回调） */
  onExpand: () => void;
  /** 关闭（收起，不卸载） */
  onClose: () => void;
}

/**
 * 停靠在主区右沿的助手面板。
 *
 * 收起态用 `hidden` 而不是卸载：`ChatPanel` 里的会话、草稿与 run 订阅都要原样留着（10.11-12）。
 * 最小化态只画一条 48px 状态条，点它回到展开。
 * @param props 见 `AssistantDockProps`
 * @returns aside（展开/最小化两态）+ 收起时的零高度占位
 */
export function AssistantDock({ state, onMinimize, onExpand, onClose }: AssistantDockProps) {
  const { t } = useTranslation();
  const isOpen = state === 'open';
  const isMin = state === 'minimized';
  return (
    <aside
      id="assistant-panel"
      data-testid="assistant-panel"
      data-state={state}
      aria-label={t('assistant.panelTitle')}
      className={`${state === 'closed' ? 'hidden' : 'flex'} w-[min(420px,100%-24px)] shrink-0 flex-col border-l border-line bg-ink-950/80 ${isMin ? 'h-12 self-start' : 'min-h-0'}`}
    >
      {/* 三态共用一条顶栏：最小化时它就是那 48px 的状态条，两个键换成「展开/关闭」。 */}
      <div
        data-testid={isMin ? 'assistant-minimized-bar' : undefined}
        className={`flex shrink-0 items-center gap-2 border-b border-line px-2 ${isMin ? 'h-12' : 'h-9'}`}
      >
        <MessageCircle size={13} className="shrink-0 text-slate-400" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-slate-300">
          {isMin ? t('assistant.minimizedLine') : t('assistant.panelTitle')}
        </span>
        {isMin ? (
          <DeskButton action="assistant-expand" variant="ghost" compact onClick={onExpand}>
            {t('assistant.expand')}
          </DeskButton>
        ) : (
          <DeskButton action="assistant-minimize" variant="ghost" compact onClick={onMinimize}>
            <Minus size={12} />
            <span className="sr-only">{t('assistant.minimize')}</span>
          </DeskButton>
        )}
        <DeskButton
          action={isMin ? 'assistant-close-min' : 'assistant-close'}
          variant="ghost"
          compact
          onClick={onClose}
        >
          <X size={12} />
          <span className="sr-only">{t('assistant.close')}</span>
        </DeskButton>
      </div>
      {/* 对话本体常驻挂载、只在最小化/收起时藏起来：草稿与 run 订阅都不许因为换态而丢（10.11-12）。 */}
      <div className={`${isOpen ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col`}>
        <ChatPanel />
      </div>
    </aside>
  );
}
