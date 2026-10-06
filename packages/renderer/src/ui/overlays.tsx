import { X } from 'lucide-react';
import { useEffect } from 'react';
import type { ReactNode } from 'react';

/**
 * 浮层的两档宽度（09 稿「浮层纪律」表：420/520 给抽屉，480/560/640 给弹窗）。
 * 必须写成完整字面量，Tailwind 扫不到拼出来的 class。
 */
const DRAWER_WIDTH = { '420': 'w-[420px]', '520': 'w-[520px]' } as const;
const MODAL_WIDTH = { '480': 'w-[480px]', '560': 'w-[560px]', '640': 'w-[640px]' } as const;

/** 遮罩：盖住工作台但不盖住状态条——底部读数在浮层期间仍然要看得见。 */
const SCRIM = 'fixed inset-0 z-40 bg-scrim';

/**
 * 浮层期间的公共副作用：锁掉背后滚动 + Esc 分层收起。
 * Esc 只在浮层真的开着时挂监听，关掉必须摘掉，否则多层叠着按一次 Esc 会全塌（09 稿纪律表第 4 行）。
 * @param open 是否打开
 * @param onClose 收起动作
 * @returns 无；只产生副作用
 */
function useOverlayBehavior(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);
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
  useOverlayBehavior(open, onClose);
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

/**
 * 遮罩弹窗（09 稿形态⑤）：全 app 只允许 5 只，判据是「不可逆」或「必须读完整风险」。
 * 可逆的动作一律不许用——那会让用户学会不看内容直接关。
 * @param action 关闭动作前缀
 * @param open 是否显示
 * @param title 标题
 * @param onClose 收起动作
 * @param width 尺寸档
 * @param dismissOnScrim 点遮罩是否收起
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
  useOverlayBehavior(open, onClose);
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

export interface ToastProps {
  /** 该提示的 `data-action` 值，harness 用它断言"回执真的长出来了"。 */
  action: string;
  /** 语气：jade=办完了，seal=办砸了（不自动消失，见 useDeskResult 的同一条理由）。 */
  tone: 'jade' | 'seal';
  children: ReactNode;
}

/**
 * 就地回执（09 稿形态①）：贴在控件旁边的一行颜色，**不是**弹窗、不是 toast 队列。
 * 只用来回答"这一下点到了没有"。
 * @param action 回执节点凭据
 * @param tone 语气
 * @param children 文案
 */
export function Toast({ action, tone, children }: ToastProps) {
  return (
    <span
      data-action={action}
      data-toast={tone}
      role="status"
      className={`inline-flex items-center gap-1.5 rounded-chip border px-2 py-1 text-[11px] animate-rise ${
        tone === 'jade' ? 'border-jade/45 bg-jade-wash text-jade' : 'border-seal/50 bg-seal-wash text-seal'
      }`}
    >
      {children}
    </span>
  );
}
