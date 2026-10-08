import { BadgeCheck, CircleAlert, FolderOpen, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { clearDeskToast, useDeskToast } from '../deskToast';
import { useBridgeAction } from '../useBridgeAction';
import { DeskButton } from './controls';

/**
 * 浮层的两档宽度（09 稿「浮层纪律」表：420/520 给抽屉，480/560/640 给弹窗）。
 * 必须写成完整字面量，Tailwind 扫不到拼出来的 class。
 */
const DRAWER_WIDTH = { '420': 'w-[420px]', '520': 'w-[520px]' } as const;
const MODAL_WIDTH = { '480': 'w-[480px]', '560': 'w-[560px]', '640': 'w-[640px]' } as const;

/** 遮罩：盖住工作台但不盖住状态条——底部读数在浮层期间仍然要看得见。 */
const SCRIM = 'fixed inset-0 z-40 bg-scrim';

/**
 * 抽屉的遮罩（09 稿形态④：「遮罩只盖住主区、不盖左栏导航（人随时能切走）」）。
 * 与 `SCRIM` 唯一的差别是起点让给左栏；弹窗仍用全屏那一档（形态⑤ 的入场条件就是"躲不掉"）。
 * 起点引用 `--desk-nav-width` 而不是抄一个 `184px`：左栏宽度改了，这条口径不会静默失配（§2.5）。
 */
const DRAWER_SCRIM = 'fixed inset-y-0 right-0 left-(--desk-nav-width) z-40 bg-scrim';

/**
 * 浮层层级（09 稿「打扰度递增」那条序）：一次 Esc 只关最上层那一只，不许一塌到底（纪律表第 4 行），
 * 焦点环同样只属于最上层那一层（第 2 行）。toast 10 < 抽屉 20 < 弹窗 30。
 * 数值既是关闭优先级也是焦点归属，谁都不许绕开这张表自己挂监听。
 */
const LAYER_TOAST = 10;
const LAYER_DRAWER = 20;
const LAYER_MODAL = 30;

/**
 * 当下挂着的浮层：层级 → 收起动作 + 对话节点。同一层只允许一只（纪律表第 1 行）。
 * `node` 为空的那一层不参与焦点环——09 稿把 toast 写成"通知不是对话框：不抢焦点"，
 * 它没有对话节点，于是 Esc 归它收，Tab 不归它管。
 */
const overlayLayers = new Map<number, { close: () => void; node: HTMLElement | null }>();

/**
 * 焦点环里能站的格子：与浏览器默认 Tab 口径一致的那几类原生可聚焦元素。
 * 本项目**不用原生 `disabled`**（按不动走 `aria-disabled` 三件套），所以闸门挡住的按钮**刻意留在环里**——
 * 稿上要求人能把焦点停在那颗键上读到原因，把它踢出环就等于"按不动"退化成"摸不到"。
 */
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

/**
 * 列出某个对话节点内可 Tab 到的元素，按 DOM 顺序（焦点环就按这个顺序转）。
 * @param node 对话节点（`role="dialog"` 那一层）
 * @returns 可聚焦元素列表；被卸载中、隐藏、`tabindex="-1"`、原生 `disabled`（第三方 chrome 的能力边界）都剔掉
 */
function focusableWithin(node: HTMLElement): HTMLElement[] {
  const ring: HTMLElement[] = [];
  for (const element of node.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (element.tabIndex < 0 || element.hasAttribute('disabled')) continue;
    if (element.getClientRects().length === 0) continue;
    ring.push(element);
  }
  return ring;
}

/**
 * 取当前最高那一级**带对话节点**的浮层：Tab 只往这一层里锁，比它低的层此时正被盖住。
 * @returns 该节点；只有 toast 挂着时返回 null（不接管 Tab）
 */
function topmostTrappedNode(): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestLayer = 0;
  for (const [layer, entry] of overlayLayers) {
    if (entry.node && layer > bestLayer) {
      bestLayer = layer;
      best = entry.node;
    }
  }
  return best;
}

/** 全渲染层唯一的那只 keydown 监听；没有浮层挂着时必须摘掉，否则留着一条空转的全局监听。 */
let overlayListener: ((event: KeyboardEvent) => void) | undefined;

/**
 * 登记一层浮层（收起动作 + 可选的对话节点），并把那条全局监听立起来。
 * Esc 与 Tab 共用同一张层级表：层级数字既是关闭优先级（纪律表第 4 行），也是焦点环的主人（第 2 行）。
 * @param layer 层级（上面那三个常量之一）
 * @param close 这一层被 Esc 命中时的动作
 * @param node 这一层的对话节点；传空表示这层不管焦点（toast）
 * @returns 注销函数；层级空了就把全局监听一起摘掉
 */
function registerOverlayLayer(layer: number, close: () => void, node: HTMLElement | null = null): () => void {
  overlayLayers.set(layer, { close, node });
  if (!overlayListener) {
    overlayListener = (event) => {
      if (overlayLayers.size === 0) return;
      if (event.key === 'Escape') {
        // 只放最上层那一只：低层留给人再按一次。
        overlayLayers.get(Math.max(...overlayLayers.keys()))?.close();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = topmostTrappedNode();
      if (!dialog) return;
      const ring = focusableWithin(dialog);
      // 环空（正文只读、一颗键都没有）：Tab 哪里都不去，否则默认口径会走进被盖住的背景。
      // 非空时同样一律吃掉默认动作——浏览器的顺序按**整份文档**排，放过去就会跨出浮层。
      event.preventDefault();
      if (ring.length === 0) return;
      const current = ring.indexOf(document.activeElement as HTMLElement);
      const step = event.shiftKey ? -1 : 1;
      // current 是 -1 表示焦点已经不在这一层里（环里那格刚被卸载、焦点掉回文档）：从端点重新起步。
      const nextIndex =
        current === -1 ? (event.shiftKey ? ring.length - 1 : 0) : (current + step + ring.length) % ring.length;
      ring[nextIndex]?.focus();
    };
    window.addEventListener('keydown', overlayListener);
  }
  return () => {
    overlayLayers.delete(layer);
    if (overlayLayers.size === 0 && overlayListener) {
      window.removeEventListener('keydown', overlayListener);
      overlayListener = undefined;
    }
  };
}

/**
 * 浮层期间的公共副作用：按层级挂 Esc + 焦点环，弹窗那一层另外锁掉背后滚动，收起时把焦点还给触发它的控件。
 *
 * 「背后摸不到」走的是 09 稿给的第二个口子（等价的焦点陷阱）而不是 `inert`：
 * `inert` 要挂在**背景容器**上，就得把浮层从面板里提到顶层（Portal），而第二十五片已经用活体判据确认
 * 「`display:none` 的祖先把 `fixed` 后代一起藏掉」正是"同一时刻 ≤1 只遮罩"的保证（§3.8 的落点选择）。
 * 鼠标这一路弹窗本来就摸不到——遮罩是 `fixed inset-0`，命中测试落在遮罩上；抽屉的遮罩让出左栏（形态④），
 * 那一条鼠标路是**故意留开的**，键盘这一路仍按纪律表「焦点」行锁在浮层内。所以这里补的是键盘那一路。
 * @param open 是否开着（关了就不挂监听）
 * @param layer 这一层的 Esc / 焦点优先级
 * @param onClose 收起动作
 * @param lockScroll 是否锁底层滚动——09 稿纪律表第 3 行只给弹窗锁，抽屉**不许锁**（要边看边改）
 * @param dialogRef 对话节点的 ref；节点没挂上就不接管 Tab
 * @returns 无；只产生副作用
 */
function useOverlayBehavior(
  open: boolean,
  layer: number,
  onClose: () => void,
  lockScroll: boolean,
  dialogRef: RefObject<HTMLElement | null>,
) {
  /**
   * 触发这一层浮层的那格控件，**在渲染阶段**记下（只在开→关、关→开那一刻换值）。
   * 等到 effect 里再读 `document.activeElement` 已经晚了：环里那格 `autoFocus`（纪律表第 2 行前半句）
   * 早已把焦点带进弹窗，届时只能拿到一个马上要被卸载的节点，焦点还得回去。
   * 键在 `open` 的跳变上而不是"取到一次就清一次"：StrictMode 的假卸载会跑一遍 effect 的 cleanup，
   * 在那里清空就等于把触发者丢掉，真关的时候谁也还不了焦点。
   */
  const triggerRef = useRef<{ open: boolean; element: HTMLElement | null }>({ open: false, element: null });
  if (triggerRef.current.open !== open) {
    const focused = document.activeElement;
    triggerRef.current = open
      ? { open: true, element: focused instanceof HTMLElement && focused !== document.body ? focused : null }
      : { open: false, element: null };
  }

  useEffect(() => {
    if (!open) return;
    const unregister = registerOverlayLayer(layer, onClose, dialogRef.current);
    const previousOverflow = lockScroll ? document.body.style.overflow : '';
    if (lockScroll) document.body.style.overflow = 'hidden';
    return () => {
      unregister();
      if (lockScroll) document.body.style.overflow = previousOverflow;
    };
  }, [open, layer, onClose, lockScroll, dialogRef]);

  /**
   * 纪律表第 2 行的后半句：关掉后焦点还给**触发它的那只控件**，否则人的位置随弹窗一起没了。
   * 只在"文档已经没了焦点"时才还——`activeElement === body` 正是环内那格被卸载后的读数，
   * 而 StrictMode 那次假卸载的 cleanup 里焦点还稳稳地在弹窗内，于是那一趟什么都不做（还早了就会把
   * `autoFocus` 拽回背景，第二十五片的落点腿会被这条抵消）。
   * 也不跟着 onClose 的引用变化重放：人正在环内走 Tab 时父层一次普通重渲染不该把焦点拽回背景。
   */
  useEffect(() => {
    if (!open) return;
    // 触发者在闭包里存住：cleanup 跑的时候渲染层已经把 triggerRef 换成"关"那一档了，现读会读到空。
    const trigger = triggerRef.current.element;
    return () => {
      if (document.activeElement !== document.body) return;
      trigger?.focus();
    };
  }, [open]);
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
 *
 * 与弹窗的两条行为分界都写在稿的纪律表上：遮罩让出左栏（`DRAWER_SCRIM`，鼠标随时能切走），
 * 底层滚动不锁（`lockScroll=false`，边看边改）；焦点环这一条**两者相同**（纪律表「焦点」行
 * 把抽屉与弹窗并列写："Tab 在浮层内循环不出来"），所以左栏在键盘那一路是摸不到的，
 * 稿上"人随时能切走"指的是鼠标。窄窗（<1120px）按尺寸档那条改为全宽覆盖。
 * @param action 关闭动作前缀
 * @param open 是否展开
 * @param title 标题
 * @param subtitle 副标题
 * @param onClose 收起动作
 * @param width 宽度档
 * @param children 内容
 */
export function Drawer({ action, open, title, subtitle, onClose, width = '420', children }: DrawerProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  useOverlayBehavior(open, LAYER_DRAWER, onClose, false, dialogRef);
  if (!open) return null;
  return (
    <>
      <div className={DRAWER_SCRIM} onClick={onClose} />
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        data-action={`${action}-drawer`}
        className={`fixed inset-y-0 right-0 z-50 flex ${DRAWER_WIDTH[width]} max-[1120px]:w-full flex-col border-l border-line-strong bg-ink-850 shadow-sheet animate-rise`}
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
  /**
   * 挂在 dialog 节点上的 `data-testid`：迁移到本原件之前的旧验收断言指着各自的测试名
   * （如 spec 5.9-06 的 `privacy-notice`），换形状不许把别人的验收通道弄断。
   */
  testId?: string;
  /**
   * 附加的 `data-*` 读数（与 `Banner` 的 `markers` 同形）：弹窗常常要带状态位，
   * 让 harness 直接断言，而不是靠调用方在 children 里塞一个隐藏节点。
   */
  markers?: Record<string, string>;
  /**
   * 右上角 ✕ 的无障碍名（调用方翻译好传入）。标题常常带图标、不是一个字符串，
   * 原件从 `title` 里推不出名字，而这只 ✕ 是弹窗唯一的一条"关掉算了"退路，读屏必须能报出它。
   */
  closeLabel?: string;
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
 * @param testId 附加的 `data-testid`（迁移旧验收用）
 * @param markers 附加 `data-*` 读数
 * @param closeLabel ✕ 的无障碍名
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
  testId,
  markers,
  closeLabel,
  footer,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useOverlayBehavior(open, LAYER_MODAL, dismissOnScrim ? onClose : neverClose, true, dialogRef);
  if (!open) return null;
  const headingId = `${action}-modal-title`;
  const markerAttrs = Object.fromEntries(
    Object.entries(markers ?? {}).map(([name, value]) => [`data-${name}`, value]),
  ) as Record<string, string>;
  return (
    <>
      <div className={SCRIM} {...(dismissOnScrim ? { onClick: onClose } : {})} />
      {/* 居中这一层是**整窗矩形**且压在遮罩之上（z-50 > z-40），默认会把指针事件整个接走：
          于是 `dismissOnScrim` 那条退路只有 `element.click()` 走得通（合成 click 跳过命中测试），
          真鼠标落在它身上而什么都不做（活体命中测试读数：背景点的 hit 就是这一层，不是 `.bg-scrim`）。
          它自己不吃事件、只让卡片吃——遮罩重新拿回命中，背景那层依旧被遮罩盖死。 */}
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-6">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={headingId}
          data-action={`${action}-modal`}
          {...markerAttrs}
          {...(testId ? { 'data-testid': testId } : {})}
          className={`pointer-events-auto flex max-h-full max-w-full ${MODAL_WIDTH[width]} flex-col overflow-hidden rounded-sheet border bg-ink-850 shadow-sheet animate-rise ${
            tone === 'seal' ? 'border-seal/55' : 'border-line-strong'
          }`}
        >
          <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-3">
            <h3 id={headingId} className="text-sm font-semibold text-slate-50">
              {title}
            </h3>
            {/* 关掉那颗只在"可安全取消"的弹窗上出现：`dismissOnScrim` 一只 prop 同时管三条退路
                （点遮罩 / 按 Esc / 按右上角的 ✕），必须表态的那几只因此一条退路都不留（09 稿⑤-1/⑤-5）。 */}
            {dismissOnScrim ? (
              <button
                type="button"
                data-action={`${action}-close`}
                aria-label={closeLabel ?? (typeof title === 'string' ? title : undefined)}
                onClick={onClose}
                className="rounded-chip border border-line p-1 text-slate-400 hover:bg-ink-800 hover:text-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-celadon/70"
              >
                <X size={14} />
              </button>
            ) : null}
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
 * 那颗 reveal 按钮文案里的系统目标名（spec 6.2-12）。稿上写「在访达 / 资源管理器中显示」，
 * 而那是张不知道跑在哪个系统上的静态图；app 侧按 §5.7 把平台名当参数，只出现当前那一个名字。
 * 现推自 `navigator.userAgent`，不为此多问一次 `shell.getStatus()`——那颗读数已由状态条的通道在报（§2.5）。
 * @returns 语言包 `desk.revealTarget` 下的那一级键名
 */
function revealTargetKey(): 'macos' | 'windows' | 'linux' {
  const agent = navigator.userAgent;
  if (agent.includes('Mac OS X')) return 'macos';
  if (agent.includes('Windows')) return 'windows';
  return 'linux';
}

/**
 * 左下角浮层 toast（09 稿形态① 的 1-B）：贴在主区左下角的一行颜色，**不抢焦点**、同时只 1 只。
 *
 * 判据是稿里那句"只有当结果需要离开当前视野才能看到时"——产物是磁盘上的一份文件、
 * 界面上翻不到，才允许在按钮自带回执之外再补这一只。它不接受 props：内容从
 * `deskToast` 汇流里现读，面板只能 `pushDeskToast`，这样"同时只 1 只"由通道自己保证（§2.5）。
 *
 * 三条行为各有出处：jade 8 秒自动收、seal 不收（等人读过，与 spec 6.2-02 的结果态同一条理由）、
 * 鼠标悬停暂停计时（稿里"鼠标移上去计时暂停"）、Esc 关掉（纪律表第 4 行，层级最低）。
 * 宽度上限 420px 与抽屉最窄那一档同源，超长路径靠 `break-words` 折行而不是省略号——
 * seal 那一格装的是失败原因，"必须人读过"不许被截掉（第二十四片 ⑧ 第 4 条欠的口径）。
 * @returns 当前那一只 toast；通道为空时不渲染任何东西
 */
export function Toast() {
  const toast = useDeskToast();
  const { t } = useTranslation();
  const [isHovered, setHovered] = useState(false);
  // reveal 失败的那一句话挂在按钮的 `title` 上（悬停同时把计时钉住，与 6.2-02 同一条理由）。
  const [revealError, setRevealError] = useState<string>();
  // 暂停时要记住还剩多少，恢复不许把 8 秒重新发一遍——否则悬停一次就等于不消失。
  const remainingRef = useRef(TOAST_LINGER_MS);
  const deadlineRef = useRef(0);
  const revealLabel = t('desk.reveal', { target: t(`desk.revealTarget.${revealTargetKey()}`) });
  // `read` 这一格传空 Promise：reveal 不回读数、toast 也没有要重读的面板状态，
  // 但五态（转针 / 结果 / 回落）必须继续走 `useBridgeAction` 那一份实现，不在这里另长一套（§2.5）。
  const { busy, resultOf, clearResult, run } = useBridgeAction(() => Promise.resolve());

  // 新的一只顶上来：计时从头算（后来者顶掉先来的，稿里同一时刻只允许一只），
  // 上一颗键的读数也跟着撤掉——结果态是按标签归属的，不清就会让新 toast 顶着旧 toast 的朱砂底。
  useEffect(() => {
    remainingRef.current = TOAST_LINGER_MS;
    setRevealError(undefined);
    clearResult();
  }, [toast, clearResult]);

  useEffect(() => {
    if (!toast || toast.tone !== 'jade' || isHovered || revealError) return;
    deadlineRef.current = Date.now() + remainingRef.current;
    const timer = window.setTimeout(() => {
      remainingRef.current = TOAST_LINGER_MS;
      clearDeskToast();
    }, remainingRef.current);
    return () => {
      window.clearTimeout(timer);
      remainingRef.current = Math.max(0, deadlineRef.current - Date.now());
    };
  }, [toast, isHovered, revealError]);

  useEffect(() => {
    if (!toast) return;
    // 只登记收起动作、**不传对话节点**：稿上写明 toast 不抢焦点，所以它进不了 Tab 环。
    return registerOverlayLayer(LAYER_TOAST, clearDeskToast);
  }, [toast]);

  /**
   * 点第二段动作：把产物在系统文件管理器里选中（`shell.revealInFolder`，spec 6.2-12）。
   * 五态全部复用 `useBridgeAction` 那一套，不为这颗键另长一份状态机（§2.5）。
   */
  const reveal = () => {
    setRevealError(undefined);
    void run(revealLabel, () => window.autoCC?.shell.revealInFolder(toast?.revealPath ?? ''), {
      onError: (error) => setRevealError(error.message),
    });
  };

  if (!toast) return null;
  return (
    <div
      data-action={toast.action}
      data-toast={toast.tone}
      {...(toast.revealPath ? { 'data-reveal-path': toast.revealPath } : {})}
      role="status"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`absolute bottom-[14px] left-[18px] z-30 flex max-w-[420px] items-center gap-2 rounded-control break-words bg-ink-800 px-[13px] py-2 text-xs shadow-sheet animate-rise ${
        toast.tone === 'jade' ? 'border border-jade/50 text-jade-ink' : 'border border-seal/50 text-seal-ink'
      }`}
    >
      {toast.tone === 'jade' ? (
        <BadgeCheck size={14} aria-hidden="true" />
      ) : (
        <CircleAlert size={14} aria-hidden="true" />
      )}
      <span className="min-w-0">{toast.message}</span>
      {/* 稿上 1-B 的第二段动作。只由通道里带了 `revealPath` 的那一只长出来：路径是主进程自己写的产物
          才配这颗键，用户敲进来的任意路径归面板自己的回执管（plan §3.10）。`shrink-0` 保证窄容器里
          被挤掉的永远是文案而不是这颗键。 */}
      {toast.revealPath ? (
        <DeskButton
          action={`${toast.action}-reveal`}
          variant="line"
          compact
          busy={busy === revealLabel}
          result={resultOf(revealLabel)}
          {...(revealError ? { title: revealError } : {})}
          className="shrink-0"
          onClick={reveal}
        >
          <FolderOpen size={12} aria-hidden="true" />
          {revealLabel}
        </DeskButton>
      ) : null}
    </div>
  );
}
