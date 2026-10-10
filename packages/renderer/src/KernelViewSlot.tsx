import { Maximize2, Minimize2, PanelRight, PanelRightClose } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DeskButton, NarrowLabel } from './ui/controls';
import { SplitHandle, useSplitWidth } from './ui/split';

/**
 * 右栏可拖到的宽度区间（百分比）。下界与主进程的兜底比例同源（`--kernel-view-width` = 38% =
 * `KERNEL_VIEW_WIDTH_RATIO`），上界是人在界面侧能拉到的最宽——再宽就等于把工作台挤没了，
 * 那种需求属于「全屏」那一颗键（`Maximize2`）。
 *
 * 为什么不是 px 定宽：px 会让这条 `shrink-0` 的右栏在缩窗口时把主区挤死，而 8.8-01/03 的既有读数
 * 全部是"占这一行的比例"，百分比与它回落的那支令牌同单位，两套口径不会打架。
 * 这两个数是喂给 `useSplitWidth` 的配置，不是本文件的实现——拖拽模型 2026-10-10 起抽在 `ui/split.tsx`
 * （简历纸栏是第二个消费者，§2.2）。`WIDTH_CLASS` 的字面量与 `WIDTH_MIN` 留在这里是机检第 4 段
 * （1.2-17）钉着的两枚锚点，搬走了 `pnpm lint` 即红。
 */
const WIDTH_MIN = 38;
const WIDTH_MAX = 72;

/** 键盘微调的步长（百分点）：`ArrowLeft` / `ArrowRight` 一次走这么多。 */
const WIDTH_STEP = 2;

/** 宽度偏好键：与 `auto-cc.lang`、`auto-cc.metrics.range`、`auto-cc.desk.disclosure` 同一份 localStorage。 */
const WIDTH_STORAGE_KEY = 'auto-cc.kernel-slot-width';

/** 命令式写在 `<aside>` 上的那一枚 CSS 变量名，值就是上面那个百分比。 */
const WIDTH_VAR = '--kernel-slot-width';

/** 非展开态挂在 `<aside>` 上的那一枚宽度 class：唯一的字面量，值由 CSS 变量给。 */
const WIDTH_CLASS = 'w-(--kernel-slot-width)';

/** 右栏槽位的布局状态（全屏那一颗），由 `App` 持有、`KernelViewSlot` 消费；宽度在下面自己长。 */
export interface KernelSlotLayout {
  /** 当下是不是全屏态（整条右栏盖住主区）。 */
  isExpanded: boolean;
  toggleExpanded: () => void;
}

/**
 * 内核视图槽位的布局偏好：全屏态只活在本次会话，宽度那一档交给 `useSplitWidth` 落盘。
 *
 * 全屏态不落盘是刻意的：开机就把主区整块盖住在网页里，而"退出全屏"那颗键此刻在画面边上，
 * 不像宽度那样能一眼看出自己改过它。宽度没有这个问题（右栏一直在），所以值得留。
 * @returns 交给 `App` 的展开态（它还要用它决定主区让不让位）
 */
export function useKernelSlotLayout(): KernelSlotLayout {
  const [isExpanded, setIsExpanded] = useState(false);
  return {
    isExpanded,
    toggleExpanded: () => setIsExpanded((previous) => !previous),
  };
}

/**
 * 内嵌内核视图的槽位：量出自己的几何报给主进程，把宽度摆在**视图盖不到的那一行**，
 * 并在这一行的左外侧挂一根可连续拖的把手。视图被收掉时它退成右缘一条竖条，人随时按得回来。
 *
 * 为什么要渲染层来量（spec 8.8-01）：原生 `WebContentsView` 铺在渲染层之上，主进程只能按固定比例硬铺，
 * 于是 38% 的宽度既铺不出真实站点的桌面布局（BOSS 在 456px 里必然显示不全），又会盖掉顶部标题栏与
 * 底部状态条。几何的权威从此在布局真正的主人手里。
 *
 * 控件必须留在上报矩形之外：盖在下面的渲染层节点点不动（原生视图吃走命中测试），
 * 所以「全屏 / 收起」这两颗键摆在槽位上方。把手同理待在 aside **之外**（同一条 flex 行的前一个兄弟）——
 * 上报矩形是槽位 div 的边框盒，`p-4` 只往里缩它的**孩子**、不缩它自己，所以挂在 aside 左缘的 6px
 * 会整个落在视图盖住的那一块里（本轮活体读数：slot x=1286，aside 内缘 x=1285，两者左缘同一条线）。
 * @param layout 槽位布局状态（由 `App` 持有，它还要用它决定主区让不让位）
 * @param viewVisible 原生视图此刻在不在（唯一权威是主进程那份读数，见 `useKernelViewVisible`）：
 *   不在时这一栏只画一条竖条，宽度与槽位都不存在，因此也没有几何可报
 */
export function KernelViewSlot({ layout, viewVisible }: { layout: KernelSlotLayout; viewVisible: boolean }) {
  const { t } = useTranslation();
  const slotRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const bridge = window.autoCC;
  const [measured, setMeasured] = useState<string>('');
  // 宽度那一整件事（拖拽、键盘、双击、持久化、把百分比写成 CSS 变量）都在 `ui/split.tsx`，
  // 这里只给它这一栏的配置与落点。`active: viewVisible` 是活体逼出来的那一条：收起态画的是竖条，
  // aside 节点不存在，重新打开时若 effect 不重跑，右栏就回到 `:root` 的 38% 而人存过的是别的宽度
  // （本轮读数：拖到 66% 收起再打开，aside 量回 456px 而持久值是 66）。
  const split = useSplitWidth({
    storageKey: WIDTH_STORAGE_KEY,
    cssVar: WIDTH_VAR,
    minPercent: WIDTH_MIN,
    maxPercent: WIDTH_MAX,
    stepPercent: WIDTH_STEP,
    // 双击回的是**最窄档**（8.8-10 的既有手势）；库里没有记录时同样落这一档。
    defaultPercent: WIDTH_MIN,
    active: viewVisible,
  });

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

  // 尺寸变化由 ResizeObserver 推：改宽度、拖把手、展开、缩窗口都会让槽位重新布局，收起时量到 0 自然跳过。
  // **工具行也在观察名单里**（spec 8.8-09）：上报矩形是从 aside 左缘算的，工具行哪天长高一行，
  // `rect.y` 变了而槽位尺寸没变 → 不重报 → 原生视图从此盖住第二行控件，那是静默的 8.8-04 回归。
  // 拖拽也**不另开第二条 IPC 通道**（同一条 spec）：`pointermove` 里只改 CSS 变量，
  // 布局变了自然由这一帧的 ResizeObserver 推一次——它本来就是每帧合并派发，比自造 rAF 合帧更省，
  // 而且不会被"窗口被遮挡时 rAF 不跑"这条环境事实拖住（§9 的 6.2 二三片）。
  useEffect(() => {
    report();
    const observer = new ResizeObserver(() => report());
    if (slotRef.current) observer.observe(slotRef.current);
    if (toolbarRef.current) observer.observe(toolbarRef.current);
    return () => observer.disconnect();
    // `viewVisible` 必须在依赖里：收起态没有槽位节点可观察，重新打开时若这个 effect 不重跑，
    // 原生视图就停在收起前那一块几何上，而右栏已经按持久宽度重画——两份宽度同时挂在画面上。
  }, [report, viewVisible]);

  // 收起态：整条右栏不存在，只留右缘一条竖条，竖条上那颗键把它带回来。
  // 可见性的权威在主进程那一份读数上（`useKernelViewVisible`），这里只发指令、不自己记「我收过」。
  if (!viewVisible) {
    return (
      <aside
        data-testid="kernel-slot-strip"
        className="flex w-9 shrink-0 flex-col items-center border-l border-line bg-ink-900 py-1.5"
      >
        <DeskButton
          action="kernel-slot-show"
          variant="ghost"
          compact
          aria-label={t('kernel.show')}
          title={t('kernel.show')}
          onClick={() => void bridge?.shell.setKernelViewVisible(true)}
        >
          <PanelRight size={13} />
        </DeskButton>
      </aside>
    );
  }

  return (
    <>
      {/* 这根 6px 的把手**必须待在 aside 之外**（同一条 flex 行的前一个兄弟）：上报矩形取的是槽位 div 的
          `getBoundingClientRect()`，那是它的**边框盒**，左缘就等于 aside 内缘（本轮活体读数：
          aside x=1285、slot x=1286、把手 x=1286 w=6 → 把手右缘 1292 落在视图盖住的 1286…2072 里）。
          挂在 aside 里等于把人唯一那根抓手交给原生视图去吃命中测试（8.8-04 的同一件事），
          挪到外侧之后把手右缘 1285 < slot x=1286，视图永远盖不到它。
          形状、键盘四件与 `aria-valuemin/max/now` 都在 `ui/split.tsx` 的 `<SplitHandle>` 里（那里记着
          `relative z-10` 与 `cursor-col-resize` 的来历）。全屏态整条右栏铺满工作区，把手跟着不上屏。 */}
      {!layout.isExpanded && (
        <SplitHandle
          split={split}
          label={t('kernel.resizeHandle')}
          action="kernel-resize-handle"
          testid="kernel-resize-handle"
        />
      )}
      <aside
        ref={split.panelRef}
        className={`${
          layout.isExpanded ? 'min-w-0 flex-1' : `shrink-0 ${WIDTH_CLASS}`
        } flex flex-col border-l border-line bg-ink-900`}
      >
        <div ref={toolbarRef} className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-1.5">
          <PanelRight size={13} className="shrink-0 text-slate-400" />
          <span className="truncate text-[11px] font-semibold text-slate-300">{t('kernel.heading')}</span>
          {/* 量出来的几何上屏：视图盖住槽位之后这是唯一能自证"渲染层报的是哪一块"的读数 */}
          <span data-testid="kernel-slot-measured" className="ml-auto shrink-0 font-mono text-[10.5px] text-slate-600">
            {measured}
          </span>
          {/* 宽度只有把手与方向键这一个出口（用户 2026-10-09 裁：收窄/加宽两颗档键删掉）。
              原先那两颗键的 `data-disabled-reason=WIDTH_MIN/WIDTH_MAX` 通道随之退役——
              把手上的 `aria-valuemin/max/now` 与拖到边界时的夹取读数是同一件事的新通道（spec 8.8-10）。 */}
          <DeskButton
            action="kernel-slot-expand"
            variant="line"
            compact
            title={t(layout.isExpanded ? 'kernel.collapse' : 'kernel.expand')}
            onClick={layout.toggleExpanded}
          >
            {layout.isExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            <NarrowLabel>{t(layout.isExpanded ? 'kernel.collapse' : 'kernel.expand')}</NarrowLabel>
          </DeskButton>
          {/* 收起整栏：原生视图与右栏一起收掉，界面只留右缘那条竖条——那颗键就是它的回来口。
              可见性写在主进程那一份读数上，这里只发指令，不自己记「我收过」。 */}
          <DeskButton
            action="kernel-slot-hide"
            variant="line"
            compact
            title={t('kernel.hide')}
            onClick={() => void bridge?.shell.setKernelViewVisible(false)}
          >
            <PanelRightClose size={13} />
            <NarrowLabel>{t('kernel.hide')}</NarrowLabel>
          </DeskButton>
        </div>

        {/* 这一块的矩形就是原生视图的落位处：文字只在视图还没盖上来（首帧、或摆位被拒）时露出来。 */}
        <div ref={slotRef} data-testid="kernel-view-slot" className="min-h-0 flex-1 p-4">
          <p className="text-[11px] leading-relaxed text-slate-500">{t('kernel.hint')}</p>
        </div>
      </aside>
    </>
  );
}
