import { Maximize2, Minimize2, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { DeskButton, NarrowLabel } from './ui/controls';
import { quantizeKernelViewRect } from './kernel-bounds';
import { KernelAddressBar } from './KernelAddressBar';
import { SplitHandle, useSplitWidth } from './ui/split';
import type { KernelSlotLayout } from './KernelViewSlot';
import {
  CANVAS_RIGHT_DEFAULT,
  CANVAS_RIGHT_MAX,
  CANVAS_RIGHT_MIN,
  CANVAS_RIGHT_STEP,
  CANVAS_RIGHT_STORAGE_KEY,
  CANVAS_RIGHT_VAR,
  CANVAS_RIGHT_WIDTH_CLASS,
  canvasZoom,
} from './useKernelViewMode';

/**
 * 常驻分栏态（canvas）的右栏：内核浏览器占主区右侧 65%（可拖 30~70%），左栏留给项目界面四屏。
 *
 * 与 `KernelViewSlot` 的分工：那一位是 `sidebar` 回滚分支的右栏槽位（三档宽度、把手、竖条，
 * 旧 8.8 代码整段保留）；本组件只在 `canvas` 分支渲染，宽度常量与落盘键各自独立（spec 11-08）。
 * 两者都走同一条上报通道（`shell.setKernelViewBounds` + `shell.setKernelViewZoomFactor`），
 * 不另开轮询：`ResizeObserver` 盯着右栏槽位，拖把手、窗口 resize、左轨 1120 换档、全屏往返
 * 都会让它重新布局并推一次。
 *
 * 缩放分母来自平台适配器的 `minLayoutWidth`（渲染层不许出现第二处 1224 字面量）；
 * 适配器没声明时按 `zoom=1` 并在 `data-zoom-source` 上如实标「未适配」。
 * @param layout 全屏态开关（由 `App` 持有，它还要用它决定左栏让不让位）
 */
export function KernelCanvasSlot({ layout }: { layout: KernelSlotLayout }) {
  const { t } = useTranslation();
  const slotRef = useRef<HTMLDivElement | null>(null);
  const bridge = window.autoCC;
  /** 本次挂载读到的最小布局宽；未适配为 undefined。 */
  const minLayoutWidthRef = useRef<number | undefined>(undefined);
  // 分栏态的宽度整件事（拖拽、键盘、双击、持久化、写 CSS 变量）复用 `ui/split.tsx`，
  // 与简历纸栏同源（§2.7）；这里只给它这一栏的配置与落点。
  // 组件随「视图隐藏」整块卸载，重新挂载时 `useSplitWidth` 会把持久宽度写回变量（`active` 默认 true）。
  const split = useSplitWidth<HTMLDivElement>({
    storageKey: CANVAS_RIGHT_STORAGE_KEY,
    cssVar: CANVAS_RIGHT_VAR,
    minPercent: CANVAS_RIGHT_MIN,
    maxPercent: CANVAS_RIGHT_MAX,
    stepPercent: CANVAS_RIGHT_STEP,
    // 双击回的是默认分栏（65%），不是最窄档——分栏态下「最窄」会把网页挤成不可读的一列。
    defaultPercent: CANVAS_RIGHT_DEFAULT,
  });

  /**
   * 现读当前平台的桌面最小布局宽。
   *
   * 平台取 `sessions.status().activePlatform`，值取 `platform.registry.list()` 里那一行；
   * 两处都是既有只读口，本组件不缓存第二份事实（AGENTS.md §2.7）。
   */
  const resolveMinLayoutWidth = useCallback(async () => {
    const sessions = await bridge?.sessions.status();
    if (!sessions?.ok) return;
    const active = sessions.value.activePlatform;
    if (active === null) return;
    const platforms = await bridge?.platform['registry.list']();
    if (!platforms?.ok) return;
    minLayoutWidthRef.current = platforms.value.platforms.find((item) => item.id === active)?.minLayoutWidth;
  }, [bridge]);

  /**
   * 把右栏槽位的矩形与缩放同帧报给主进程。
   *
   * 零尺寸（视图隐藏前的一帧、窗口最小化）直接跳过：那种几何过不了主进程判定，报上去只会得到一次被拒。
   * 报的宽是**右栏容器的实测宽**（spec 11-04 的分母口径），全精度算出的 zoom 不取整。
   */
  const report = useCallback(() => {
    const node = slotRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const minWidth = minLayoutWidthRef.current;
    const zoom = canvasZoom(rect.width, minWidth);
    node.dataset.zoomReading = String(Math.round(zoom * 1000) / 1000);
    node.dataset.zoomSource = minWidth === undefined ? 'unadapted' : 'platform';
    node.dataset.canvasRightWidth = String(Math.round(rect.width));
    // 分栏行的宽只用于读数：左栏宽 = 行宽 − 右栏宽（把手用负外边距叠在左栏右缘，不占行内宽度）。
    const stageWidth = node.parentElement?.getBoundingClientRect().width;
    node.dataset.canvasStageWidth = stageWidth === undefined ? '' : String(Math.round(stageWidth));
    // 上报侧取整：保证视图从上一块底边的上取整开始，不与地址栏产生亚像素重叠（10.11-27）。
    void bridge?.shell.setKernelViewBounds(quantizeKernelViewRect(rect));
    void bridge?.shell.setKernelViewZoomFactor(zoom);
  }, [bridge]);

  // 尺寸变化由 ResizeObserver 推：拖把手、键盘微调、窗口 resize、左轨 1120 换档、全屏往返
  // 都会让这一栏重新布局。全屏态也进依赖：那是同一块节点换了一种 flex 档位，重报一次不留旧几何。
  useEffect(() => {
    void resolveMinLayoutWidth().then(() => report());
    const observer = new ResizeObserver(() => report());
    if (slotRef.current) observer.observe(slotRef.current);
    return () => observer.disconnect();
  }, [report, resolveMinLayoutWidth, layout.isExpanded]);

  return (
    <>
      {/* 把手必须待在这一栏**之外**（同一条 flex 行的前一个兄弟）：上报矩形是右栏的
          `getBoundingClientRect()`，挂在里面就会被原生视图盖住、拖不动（8.8-04 的同一件事）。
          负外边距把 6px 叠到左栏右缘上：它既不占行内宽度（两栏之和仍是主区宽），
          右缘又恰好止于右栏左缘，视图永远盖不到它。全屏态整条右栏铺满主区，把手跟着不上屏。 */}
      {!layout.isExpanded && (
        <SplitHandle
          split={split}
          label={t('kernel.canvasResizeHandle')}
          action="kernel-canvas-resize-handle"
          testid="kernel-canvas-resize-handle"
          className="-ml-1.5"
        />
      )}
      <div
        ref={split.panelRef}
        data-testid="kernel-canvas-panel"
        className={`${
          layout.isExpanded ? 'min-w-0 flex-1' : `shrink-0 ${CANVAS_RIGHT_WIDTH_CLASS}`
        } flex min-h-0 flex-col border-l border-line bg-ink-900`}
      >
        {/* 地址栏落在**测量槽位之上**：上报矩形只取下面那个 div，所以原生视图不会盖住它（10.11-27）。 */}
        <KernelAddressBar />
        {/* 这一块的矩形就是原生视图的落位处：文字只在视图还没盖上来（首帧、或摆位被拒）时露出来。
            控制键不在这里，而在顶栏（上报矩形之外）——盖在下面的渲染层节点点不动。 */}
        <div ref={slotRef} data-testid="kernel-canvas-slot" data-zoom-source="pending" className="min-h-0 flex-1 p-4">
          <p className="text-[11px] leading-relaxed text-slate-500">{t('kernel.hint')}</p>
        </div>
      </div>
    </>
  );
}

/**
 * 分栏态顶栏上的两颗键：显示/隐藏站点视图、全屏往返（spec 11-03 / 11-06）。
 *
 * 单独成一支是为了让 `App` 的顶栏不必认识分栏几何；键在上报矩形之外（顶栏），
 * 原生视图盖不到它们。`sidebar` 回滚态仍由 `KernelViewSlot` 工具行上的两键承担。
 * @param props `layout` 全屏态开关；`visible` 站点视图此刻在不在
 */
export function KernelCanvasControls({ layout, visible }: { layout: KernelSlotLayout; visible: boolean }) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  return (
    <>
      {visible ? (
        <DeskButton
          action="kernel-canvas-expand"
          variant="line"
          title={t(layout.isExpanded ? 'kernel.collapse' : 'kernel.expand')}
          onClick={layout.toggleExpanded}
        >
          {layout.isExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          <NarrowLabel>{t(layout.isExpanded ? 'kernel.collapse' : 'kernel.expand')}</NarrowLabel>
        </DeskButton>
      ) : null}
      <DeskButton
        action="kernel-canvas-toggle"
        variant="line"
        title={t(visible ? 'kernel.hide' : 'kernel.show')}
        onClick={() => void bridge?.shell.setKernelViewVisible(!visible)}
      >
        {visible ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
        <NarrowLabel>{t(visible ? 'kernel.hide' : 'kernel.show')}</NarrowLabel>
      </DeskButton>
    </>
  );
}
