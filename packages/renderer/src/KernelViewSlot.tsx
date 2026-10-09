import { Maximize2, Minimize2, PanelRight, PanelRightClose } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { DeskButton, NarrowLabel } from './ui/controls';

/**
 * 右栏可拖到的宽度区间（百分比）。下界与主进程的兜底比例同源（`--kernel-view-width` = 38% =
 * `KERNEL_VIEW_WIDTH_RATIO`），上界是人在界面侧能拉到的最宽——再宽就等于把工作台挤没了，
 * 那种需求属于「全屏」那一颗键（`Maximize2`）。
 *
 * 为什么不是 px 定宽：px 会让这条 `shrink-0` 的右栏在缩窗口时把主区挤死，而 8.8-01/03 的既有读数
 * 全部是"占这一行的比例"，百分比与它回落的那支令牌同单位，两套口径不会打架。
 */
const WIDTH_MIN = 38;
const WIDTH_MAX = 72;

/** 键盘微调的步长（百分点）：`ArrowLeft` / `ArrowRight` 一次走这么多。 */
const WIDTH_STEP = 2;

/** 宽度偏好键：与 `auto-cc.lang`、`auto-cc.metrics.range`、`auto-cc.desk.disclosure` 同一份 localStorage。 */
const WIDTH_STORAGE_KEY = 'auto-cc.kernel-slot-width';

/** 非展开态挂在 `<aside>` 上的那一枚宽度 class：唯一的字面量，值由 CSS 变量给。 */
const WIDTH_CLASS = 'w-(--kernel-slot-width)';

/**
 * 读持久化的宽度。
 * @returns 合法的百分比；形状不对（手改、非数字）一律回落到最窄档，不炸首屏
 */
function loadWidthRatio(): number {
  const stored = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
  if (Number.isInteger(stored) && stored >= WIDTH_MIN && stored <= WIDTH_MAX) return stored;
  // 旧形状（8.8-02 那三档）存的是**下标** `0|1|2`，与百分比值域算术上不相交，所以判得出来。
  // 这一轮把三颗档键删掉之后"档"这个概念本身没有了（宽度只由拖拽与键盘方向键决定），
  // 因此旧下标不再换算成某一档，直接落到下面的最窄档——它是一条迁移的终点，不是兼容垫片。
  return WIDTH_MIN;
}

/** 右栏槽位的布局状态与动作口（拖拽把手的宽度 + 全屏那一颗），由 `App` 持有、`KernelViewSlot` 消费。 */
export interface KernelSlotLayout {
  /** 当下宽度（百分比，38…72）：拖拽、键盘与双击写的都是这一个数。 */
  ratio: number;
  /** 当下是不是全屏态（整条右栏盖住主区）。 */
  isExpanded: boolean;
  /** 吸附与落盘都收在这一个口子里：拖拽、键盘、双击三条路径共用同一件事（§2.5）。 */
  setRatio: (next: number) => void;
  toggleExpanded: () => void;
}

/**
 * 内核视图槽位的布局偏好：宽度落 localStorage（整数百分比），全屏态只活在本次会话。
 *
 * 全屏态不落盘是刻意的：开机就把主区整块盖住在网页里，而"退出全屏"那颗键此刻在画面边上，
 * 不像宽度那样能一眼看出自己改过它。宽度没有这个问题（右栏一直在），所以值得留。
 * @returns 交给 `App` 与 `KernelViewSlot` 共用的布局状态
 */
export function useKernelSlotLayout(): KernelSlotLayout {
  const [ratio, setRatioState] = useState(loadWidthRatio);
  const [isExpanded, setIsExpanded] = useState(false);

  /**
   * 吸附到合法区间并落盘（取整：拖到 43.6% 存的是 44）。
   * @param next 目标百分比（调用方给什么都行，越界由这里夹）
   */
  const setRatio = useCallback(
    (next: number) => {
      const clamped = Math.round(Math.max(WIDTH_MIN, Math.min(next, WIDTH_MAX)));
      setRatioState(clamped);
      localStorage.setItem(WIDTH_STORAGE_KEY, String(clamped));
    },
    // `setRatioState` 与 localStorage 都是稳定的，这个回调因此只创建一次；
    // 拖拽里每帧都拿到同一个引用，不会因为重渲而换掉监听。
    [],
  );

  return {
    ratio,
    isExpanded,
    setRatio,
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
  const asideRef = useRef<HTMLElement | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const bridge = window.autoCC;
  const [measured, setMeasured] = useState<string>('');
  /** 拖拽进行中的即时宽度（百分比）：只写 CSS 变量与这支 ref，不落 React state。 */
  const liveRatioRef = useRef(layout.ratio);

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

  // 宽度落到 CSS 变量上：JSX 里不许出现 `style`（eslint），而连续拖出来的值 Tailwind 也扫不见，
  // 因此只能命令式写在**这一个节点**上（plan §3.24 记了这条对 §5.2 的刻意偏离）。
  // 拖拽、键盘、双击三条路径最后都汇到 `layout.ratio`，由这一处覆盖，画面不会有第二份宽度事实。
  useLayoutEffect(() => {
    asideRef.current?.style.setProperty('--kernel-slot-width', `${layout.ratio}%`);
    // 键盘与双击都走 state，因此这里同时把 ref 对齐：拖拽与 `Arrow*` 读的是这支 ref，
    // 不同步就会从上一次的拖拽值起步（那是一条只在"拖过再用键盘"时才现身的错位）。
    liveRatioRef.current = layout.ratio;
    // `viewVisible` 也在依赖里（与上面那条观察器同一个道理）：收起态画的是竖条，aside 节点不存在，
    // 这一格的写入空转；重新打开时若 effect 不重跑，右栏就回到 `:root` 的 38% 而人存过的是别的宽度
    // ——本轮活体读数：拖到 66% 收起再打开，aside 量回 456px（= 38%）而持久值是 66。
  }, [layout.ratio, viewVisible]);

  /**
   * 从把手起拖：整段拖拽只改一支 CSS 变量，收尾才落一次 state 与盘。
   * @param event 把手上的 `pointerdown`
   */
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const aside = asideRef.current;
    // 比例的分母是**整行**的宽度，不是 aside 自己：`ratio` 的定义就是"占这一行多少"。
    const row = aside?.parentElement;
    if (!aside || !row) return;
    const rowWidth = row.getBoundingClientRect().width;
    if (rowWidth < 1) return;
    event.preventDefault();
    const startX = event.clientX;
    // 拖拽起点取的是**这一帧的 state 值**，不是 `liveRatioRef`：ref 在拖的过程中会被每帧覆盖，
    // 而起点必须固定，否则位移会叠加自己。
    const startRatio = layout.ratio;
    // 监听在 `pointerdown` 当场挂上，不放进后续渲染的 effect（3.6 活体那条教训：
    // harness 把 down/move/up 在几毫秒里派发完，effect 等渲染提交时 `pointerup` 早就过去了）。
    const move = (moveEvent: PointerEvent) => {
      // 把手在 aside 的左外侧，所以**往左拖是变宽**：位移取负号再换算成百分比。
      const dragged = (((startRatio / 100) * rowWidth - (moveEvent.clientX - startX)) / rowWidth) * 100;
      const clamped = Math.max(WIDTH_MIN, Math.min(dragged, WIDTH_MAX));
      liveRatioRef.current = clamped;
      aside.style.setProperty('--kernel-slot-width', `${clamped}%`);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      layout.setRatio(liveRatioRef.current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /**
   * 把手上的键盘微调：让"能拖"不是唯一的到达方式。
   * @param event 把手（`role="slider"`）上的 `keydown`
   */
  const resizeByKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // 方向按**手势**而不是按"值变大"：把手在左缘，向左按是变宽，与拖拽同向。
    const step = { ArrowLeft: WIDTH_STEP, ArrowUp: WIDTH_STEP, ArrowRight: -WIDTH_STEP, ArrowDown: -WIDTH_STEP }[
      event.key
    ];
    if (step !== undefined) {
      event.preventDefault();
      layout.setRatio(liveRatioRef.current + step);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      layout.setRatio(WIDTH_MIN);
    } else if (event.key === 'End') {
      event.preventDefault();
      layout.setRatio(WIDTH_MAX);
    } else if (event.key === 'Escape') {
      // 拖到一半不满意：回到持久化的那一档（拖完才会落盘，所以这里读的就是上一次人真正定下来的宽度）。
      event.preventDefault();
      layout.setRatio(loadWidthRatio());
    }
  };

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
          `cursor-col-resize` 是 app 自己画的那对双向箭头（系统边框的箭头属于窗口管理器，app 管不着）；
          `onPointerDown` + `onKeyDown` 同时是这条 `hover:` 的交互凭据（机检只认这些，`cursor-col-resize` 本身不算）。
          全屏态整条右栏铺满工作区，把手跟着不上屏。
          `relative z-10` 是活体逼出来的：拖到 72% 时主区只剩 146px，里面的接管按钮行**溢出到主区盒子之外**
          （读数：`main.right=330` 而那颗按钮 `right=389`），而溢出内容画在同一行更早的兄弟（把手 330…336）之上，
          于是 `elementFromPoint(333,396)` 回的是那枚按钮里的 `svg`——**加宽之后再也拖不回来**。
          把手抬到 z-10 之后它在自己那 6px 上永远赢命中测试（aside 本来就画在 main 之后，不受这一条影响）。 */}
      {!layout.isExpanded && (
        <div
          role="slider"
          tabIndex={0}
          aria-label={t('kernel.resizeHandle')}
          aria-orientation="horizontal"
          aria-valuemin={WIDTH_MIN}
          aria-valuemax={WIDTH_MAX}
          aria-valuenow={layout.ratio}
          data-action="kernel-resize-handle"
          data-testid="kernel-resize-handle"
          title={t('kernel.resizeHandle')}
          onPointerDown={startResize}
          onKeyDown={resizeByKey}
          onDoubleClick={() => layout.setRatio(WIDTH_MIN)}
          className="relative z-10 w-1.5 shrink-0 cursor-col-resize self-stretch bg-line transition-colors duration-150 hover:bg-celadon focus-visible:bg-celadon"
        />
      )}
      <aside
        ref={asideRef}
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
