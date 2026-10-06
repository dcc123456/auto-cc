import { BadgeCheck, CircleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { clearDeskToast, useDeskToast } from '../deskToast';

/**
 * 浮层的两档宽度（09 稿「浮层纪律」表：420/520 给抽屉，480/560/640 给弹窗）。
 * 必须写成完整字面量，Tailwind 扫不到拼出来的 class。
 */
const DRAWER_WIDTH = { '420': 'w-[420px]', '520': 'w-[520px]' } as const;
const MODAL_WIDTH = { '480': 'w-[480px]', '560': 'w-[560px]', '640': 'w-[640px]' } as const;

/** 遮罩：盖住工作台但不盖住状态条——底部读数在浮层期间仍然要看得见。 */
const SCRIM = 'fixed inset-0 z-40 bg-scrim';

/**
 * 浮层层级（09 稿「打扰度递增」那条序）：一次 Esc 只关最上层那一只，不许一塌到底（纪律表第 4 行）。
 * toast 10 < 抽屉 20 < 弹窗 30。数值本身就是关闭优先级，谁都不许绕开这张表自己挂监听。
 */
const ESC_TOAST = 10;
const ESC_DRAWER = 20;
const ESC_MODAL = 30;

/** 当下挂着的 Esc 层：层级 → 收起动作。同一层只允许一只（抽屉/弹窗各自 ≤1 只，纪律表第 1 行）。 */
const escLayers = new Map<number, () => void>();

/** 全渲染层唯一的那只 keydown 监听；没有浮层挂着时必须摘掉，否则留着一条空转的全局监听。 */
let escListener: ((event: KeyboardEvent) => void) | undefined;

/**
 * 登记一层 Esc 收起动作。
 * @param layer 层级（上面那三个常量之一）
 * @param close 这一层被 Esc 命中时的动作
 * @returns 注销函数；层级空了就把全局监听一起摘掉
 */
function registerEscLayer(layer: number, close: () => void): () => void {
  escLayers.set(layer, close);
  if (!escListener) {
    escListener = (event) => {
      if (event.key !== 'Escape' || escLayers.size === 0) return;
      // 只放最上层那一只：低层留给人再按一次。
      escLayers.get(Math.max(...escLayers.keys()))?.();
    };
    window.addEventListener('keydown', escListener);
  }
  return () => {
    escLayers.delete(layer);
    if (escLayers.size === 0 && escListener) {
      window.removeEventListener('keydown', escListener);
      escListener = undefined;
    }
  };
}

/**
 * 浮层期间的公共副作用：按层级挂 Esc，弹窗那一层另外锁掉背后滚动。
 * @param open 是否开着（关了就不挂监听）
 * @param layer 这一层的 Esc 优先级
 * @param onClose 收起动作
 * @param lockScroll 是否锁底层滚动——09 稿纪律表第 3 行只给弹窗锁，抽屉**不许锁**（要边看边改）
 * @returns 无；只产生副作用
 */
function useOverlayBehavior(open: boolean, layer: number, onClose: () => void, lockScroll = true) {
  useEffect(() => {
    if (!open) return;
    const unregister = registerEscLayer(layer, onClose);
    const previousOverflow = lockScroll ? document.body.style.overflow : '';
    if (lockScroll) document.body.style.overflow = 'hidden';
    return () => {
      unregister();
      if (lockScroll) document.body.style.overflow = previousOverflow;
    };
  }, [open, layer, onClose, lockScroll]);
}

export interface DrawerProps {
  /** 该抽屉的 `data-action` 凭据（关闭按钮用它 + `-close` 后缀）。 */
  action: string;
  open: boolean;
  /** 抽屉标题（调用方翻译）。 */
  title: ReactNode;
  /** 副标题一行，通常放对象身份（哪份简历 / 哪个算子）。 */
  subtitle?: ReactNode;
  onClose: () => void;
  /** 宽度档，默认 420。 */
  width?: keyof typeof DRAWER_WIDTH;
  children: ReactNode;
}

/**
 * 抽屉（09 稿形态④）：从右栏滑出的**读与对照**容器——版本对照、算子参数、清单表。
 * 不用它做"确认"，确认走两步 armed 或遮罩弹窗。
 * @param action 关闭动作前缀
 * @param open 是否展开
 * @param title 标题
 * @param subtitle 副标题
 * @param onClose 收起动作
 * @param width 宽度档
 * @param children 内容
 */
export function Drawer({ action, open, title, subtitle, onClose, width = '420', children }: DrawerProps) {
  useOverlayBehavior(open, ESC_DRAWER, onClose, false);
  if (!open) return null;
  return (
    <>
      <div className={SCRIM} onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        data-action={`${action}-drawer`}
        className={`fixed inset-y-0 right-0 z-50 flex ${DRAWER_WIDTH[width]} flex-col border-l border-line-strong bg-ink-850 shadow-sheet animate-rise`}
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-50">{title}</h3>
            {subtitle ? <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            data-action={`${action}-close`}
            aria-label={typeof title === 'string' ? title : undefined}
            onClick={onClose}
            className="rounded-chip border border-line p-1 text-slate-400 hover:bg-ink-800 hover:text-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-celadon/70"
          >
            <X size={14} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </aside>
    </>
  );
}

export interface ModalProps {
  /** 关闭动作前缀。 */
  action: string;
  open: boolean;
  /** 标题（调用方翻译）。 */
  title: ReactNode;
  onClose: () => void;
  /** 尺寸档，默认 560。 */
  width?: keyof typeof MODAL_WIDTH;
  /**
   * 是否允许点遮罩收起。不可逆确认必须留 `false`（09 稿形态⑤的入场条件就是"躲不掉"）。
   */
  dismissOnScrim?: boolean;
  /** 风险级：seal 时卡片描边换朱砂，只用于外发/清空这类签字。 */
  tone?: 'neutral' | 'seal';
  /** 底部按钮区（由调用方放 DeskButton，保证五态规则只有一个实现）。 */
  footer?: ReactNode;
  children: ReactNode;
}

/** 不许被 Esc 关掉的弹窗（首次风险签字那一类：必须人表态）挂这一只，而不是每次渲染现造一个空函数。 */
const neverClose = (): void => {};

/**
 * 遮罩弹窗（09 稿形态⑤）：全 app 只允许 5 只，判据是「不可逆」或「必须读完整风险」。
 * 可逆的动作一律不许用——那会让用户学会不看内容直接关。
 * @param action 关闭动作前缀
 * @param open 是否显示
 * @param title 标题
 * @param onClose 收起动作
 * @param width 尺寸档
 * @param dismissOnScrim 点遮罩是否收起（同时决定 Esc 是否收得掉：不许点掉也就不许按掉）
 * @param tone 是否风险级
 * @param footer 底部按钮区
 * @param children 正文
 */
export function Modal({
  action,
  open,
  title,
  onClose,
  width = '560',
  dismissOnScrim = false,
  tone = 'neutral',
  footer,
  children,
}: ModalProps) {
  useOverlayBehavior(open, ESC_MODAL, dismissOnScrim ? onClose : neverClose);
  if (!open) return null;
  return (
    <>
      <div className={SCRIM} {...(dismissOnScrim ? { onClick: onClose } : {})} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
        <div
          role="dialog"
          aria-modal="true"
          data-action={`${action}-modal`}
          className={`flex max-h-full w-full ${MODAL_WIDTH[width]} flex-col overflow-hidden rounded-sheet border bg-ink-850 shadow-sheet animate-rise ${
            tone === 'seal' ? 'border-seal/55' : 'border-line-strong'
          }`}
        >
          <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-3">
            <h3 className="text-sm font-semibold text-slate-50">{title}</h3>
            <button
              type="button"
              data-action={`${action}-close`}
              onClick={onClose}
              className="rounded-chip border border-line p-1 text-slate-400 hover:bg-ink-800 hover:text-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-celadon/70"
            >
              <X size={14} />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-xs leading-relaxed text-slate-200">
            {children}
          </div>
          {footer ? (
            <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>
          ) : null}
        </div>
      </div>
    </>
  );
}

/** jade 那一只的停留时长（09 稿形态① 1-B 写死 8 秒）。 */
const TOAST_LINGER_MS = 8000;

/**
 * 左下角浮层 toast（09 稿形态① 的 1-B）：贴在主区左下角的一行颜色，**不抢焦点**、同时只 1 只。
 *
 * 判据是稿里那句"只有当结果需要离开当前视野才能看到时"——产物是磁盘上的一份文件、
 * 界面上翻不到，才允许在按钮自带回执之外再补这一只。它不接受 props：内容从
 * `deskToast` 汇流里现读，面板只能 `pushDeskToast`，这样"同时只 1 只"由通道自己保证（§2.5）。
 *
 * 三条行为各有出处：jade 8 秒自动收、seal 不收（等人读过，与 spec 6.2-02 的结果态同一条理由）、
 * 鼠标悬停暂停计时（稿里"鼠标移上去计时暂停"）、Esc 关掉（纪律表第 4 行，层级最低）。
 * @returns 当前那一只 toast；通道为空时不渲染任何东西
 */
export function Toast() {
  const toast = useDeskToast();
  const [isHovered, setHovered] = useState(false);
  // 暂停时要记住还剩多少，恢复不许把 8 秒重新发一遍——否则悬停一次就等于不消失。
  const remainingRef = useRef(TOAST_LINGER_MS);
  const deadlineRef = useRef(0);

  // 新的一只顶上来：计时从头算（后来者顶掉先来的，稿里同一时刻只允许一只）。
  useEffect(() => {
    remainingRef.current = TOAST_LINGER_MS;
  }, [toast]);

  useEffect(() => {
    if (!toast || toast.tone !== 'jade' || isHovered) return;
    deadlineRef.current = Date.now() + remainingRef.current;
    const timer = window.setTimeout(() => {
      remainingRef.current = TOAST_LINGER_MS;
      clearDeskToast();
    }, remainingRef.current);
    return () => {
      window.clearTimeout(timer);
      remainingRef.current = Math.max(0, deadlineRef.current - Date.now());
    };
  }, [toast, isHovered]);

  useEffect(() => {
    if (!toast) return;
    return registerEscLayer(ESC_TOAST, clearDeskToast);
  }, [toast]);

  if (!toast) return null;
  return (
    <div
      data-action={toast.action}
      data-toast={toast.tone}
      role="status"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`absolute bottom-[14px] left-[18px] z-30 flex items-center gap-2 rounded-control bg-ink-800 px-[13px] py-2 text-xs shadow-sheet animate-rise ${
        toast.tone === 'jade' ? 'border border-jade/50 text-jade-ink' : 'border border-seal/50 text-seal-ink'
      }`}
    >
      {toast.tone === 'jade' ? (
        <BadgeCheck size={14} aria-hidden="true" />
      ) : (
        <CircleAlert size={14} aria-hidden="true" />
      )}
      {toast.message}
    </div>
  );
}
