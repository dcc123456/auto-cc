import { ChevronsLeft, ChevronsRight, Maximize2, Minimize2, PanelRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DeskButton } from './ui/controls';

/**
 * 右栏的三档宽度（从窄到宽）。第一档与主进程的兜底比例同源（`--kernel-view-width` = 38%），
 * 后两档是人在界面侧能拉到的上限——再宽就等于把工作台挤没，不如直接展开（`Maximize2` 那一档）。
 *
 * 写成固定 class 字面量而不是 `w-[${n}%]` 动态拼接：Tailwind 只生成它在源码里看得见的字符串，
 * 拼接出来的类名类型通过、画面上什么都没有。
 */
const WIDTH_CLASSES = ['w-(--kernel-view-width)', 'w-[55%]', 'w-[72%]'] as const;

/** 宽度档的偏好键：与 `auto-cc.lang`、`auto-cc.metrics.range` 同一份 localStorage，前缀同为 `auto-cc.`。 */
const WIDTH_STORAGE_KEY = 'auto-cc.kernel-slot-width';

/**
 * 读 localStorage 里那一档下标。
 * @returns 合法下标；存的形状不对（手改、旧版本残留、越界）一律回落到最窄档，不炸首屏
 */
function loadWidthIndex(): number {
  const stored = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
  return Number.isInteger(stored) && stored >= 0 && stored < WIDTH_CLASSES.length ? stored : 0;
}

/** 右栏槽位的布局状态与三只动作口，由 `App` 持有、`KernelViewSlot` 消费。 */
export interface KernelSlotLayout {
  /** 非展开态下的列宽 class（`WIDTH_CLASSES` 里的那一枚）。 */
  widthClass: string;
  /** 当下是不是展开态（盖住整个工作区）。 */
  isExpanded: boolean;
  canNarrow: boolean;
  canWiden: boolean;
  narrow: () => void;
  widen: () => void;
  toggleExpanded: () => void;
}

/**
 * 内核视图槽位的布局偏好：宽度档落 localStorage，展开态只活在本次会话。
 *
 * 展开态不落盘是刻意的：开机就把主区整块盖住在网页里，而"收起"那颗键此刻在画面边上，
 * 不像宽度那样能一眼看出自己改过它。宽度档没有这个问题（右栏一直在），所以值得留。
 * @returns 交给 `App` 与 `KernelViewSlot` 共用的布局状态
 */
export function useKernelSlotLayout(): KernelSlotLayout {
  const [widthIndex, setWidthIndex] = useState(loadWidthIndex);
  const [isExpanded, setIsExpanded] = useState(false);

  /**
   * 换一档并落盘。
   * @param next 目标下标（调用方已按边界钳过）
   */
  const move = (next: number): void => {
    const clamped = Math.max(0, Math.min(next, WIDTH_CLASSES.length - 1));
    setWidthIndex(clamped);
    localStorage.setItem(WIDTH_STORAGE_KEY, String(clamped));
  };

  return {
    widthClass: WIDTH_CLASSES[widthIndex] ?? WIDTH_CLASSES[0],
    isExpanded,
    canNarrow: widthIndex > 0,
    canWiden: widthIndex < WIDTH_CLASSES.length - 1,
    narrow: () => move(widthIndex - 1),
    widen: () => move(widthIndex + 1),
    toggleExpanded: () => setIsExpanded((previous) => !previous),
  };
}

/**
 * 内嵌内核视图的槽位：量出自己的几何报给主进程，并把宽度档与展开态摆在**视图盖不到的那一行**。
 *
 * 为什么要渲染层来量（spec 8.8-01）：原生 `WebContentsView` 铺在渲染层之上，主进程只能按固定比例硬铺，
 * 于是 38% 的宽度既铺不出真实站点的桌面布局（BOSS 在 456px 里必然显示不全），又会盖掉顶部标题栏与
 * 底部状态条。几何的权威从此在布局真正的主人手里。
 *
 * 工具行必须留在上报矩形之外：盖在下面的渲染层节点点不动（原生视图吃走命中测试），
 * 所以"展开/宽窄"这三颗键摆在槽位上方，而不是叠在网页上。
 * @param layout 槽位布局状态（由 `App` 持有，它还要用它决定主区让不让位）
 */
export function KernelViewSlot({ layout }: { layout: KernelSlotLayout }) {
  const { t } = useTranslation();
  const slotRef = useRef<HTMLDivElement | null>(null);
  const bridge = window.autoCC;
  const [measured, setMeasured] = useState<string>('');

  /**
   * 把槽位当前的视口矩形报给主进程。
   * 零尺寸（列被收起、还没布局）直接跳过：那种几何过不了主进程的判定，
   * 报上去只会得到一条 `KERNEL_VIEW_BOUNDS_INVALID`，而这里根本没有槽位可铺。
   */
  const report = useCallback(() => {
    const node = slotRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      setMeasured('');
      return;
    }
    setMeasured(`${Math.round(rect.width)}×${Math.round(rect.height)}`);
    void bridge?.shell.setKernelViewBounds({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }, [bridge]);

  // 尺寸变化由 ResizeObserver 推：改宽度档、展开、拖窗口都会让槽位重新布局，收起时量到 0 自然跳过。
  useEffect(() => {
    report();
    const node = slotRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => report());
    observer.observe(node);
    return () => observer.disconnect();
  }, [report]);

  return (
    <aside
      className={`${
        layout.isExpanded ? 'min-w-0 flex-1' : `shrink-0 ${layout.widthClass}`
      } flex flex-col border-l border-line bg-ink-900`}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1.5">
        <PanelRight size={13} className="shrink-0 text-slate-400" />
        <span className="truncate text-[11px] font-semibold text-slate-300">{t('kernel.heading')}</span>
        {/* 量出来的几何上屏：视图盖住槽位之后这是唯一能自证"渲染层报的是哪一块"的读数 */}
        <span data-testid="kernel-slot-measured" className="ml-auto shrink-0 font-mono text-[10.5px] text-slate-600">
          {measured}
        </span>
        <DeskButton
          action="kernel-slot-narrow"
          variant="line"
          compact
          disabled={!layout.canNarrow}
          // 原因码只在该当被挡的时候挂：挂着常亮的 `data-disabled-reason` 是对界面的谎，
          // 而 harness 正是按这个属性判"点不动是门禁还是缺陷"（§9 的 6.2 二三片②）。
          {...(layout.canNarrow ? {} : { disabledReason: 'WIDTH_MIN', disabledReasonLabel: t('kernel.atMin') })}
          onClick={layout.narrow}
        >
          <ChevronsLeft size={13} />
          {t('kernel.narrow')}
        </DeskButton>
        <DeskButton
          action="kernel-slot-widen"
          variant="line"
          compact
          disabled={!layout.canWiden}
          {...(layout.canWiden ? {} : { disabledReason: 'WIDTH_MAX', disabledReasonLabel: t('kernel.atMax') })}
          onClick={layout.widen}
        >
          <ChevronsRight size={13} />
          {t('kernel.widen')}
        </DeskButton>
        <DeskButton action="kernel-slot-expand" variant="line" compact onClick={layout.toggleExpanded}>
          {layout.isExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          {t(layout.isExpanded ? 'kernel.collapse' : 'kernel.expand')}
        </DeskButton>
      </div>

      {/* 这一块的矩形就是原生视图的落位处：文字只在视图还没盖上来（首帧、或摆位被拒）时露出来。 */}
      <div ref={slotRef} data-testid="kernel-view-slot" className="min-h-0 flex-1 p-4">
        <p className="text-[11px] leading-relaxed text-slate-500">{t('kernel.hint')}</p>
      </div>
    </aside>
  );
}
