import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * 主画布态的内核视图容器（11-03 / 11-04）：铺满内容区，量出矩形与缩放后一次上报。
 *
 * 与 `KernelViewSlot` 的分工：那一位是 `sidebar` 回滚分支的右栏槽位（三档宽度、把手、竖条），
 * 本组件只在 `canvas` 分支渲染。两者都走同一条上报通道（`shell.setKernelViewBounds` +
 * `shell.setKernelViewZoomFactor`），不另开轮询：`ResizeObserver` 盯着这一块，窗口 resize、
 * 左轨 1120 换档、视图显隐都会让它重新布局并推一次。
 *
 * 缩放分母来自平台适配器的 `minLayoutWidth`（渲染层不许出现第二处 1224 字面量）；
 * 适配器没声明时按 `zoom=1` 并在 `data-zoom-source` 上如实标「未适配」。
 */
export function KernelCanvasSlot() {
  const { t } = useTranslation();
  const slotRef = useRef<HTMLDivElement | null>(null);
  const bridge = window.autoCC;
  /** 本次挂载读到的最小布局宽；未适配为 undefined。 */
  const minLayoutWidthRef = useRef<number | undefined>(undefined);

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
   * 把容器矩形与缩放同帧报给主进程。
   *
   * 零尺寸（切视图瞬间、窗口最小化）直接跳过：那种几何过不了主进程判定，报上去只会得到一次被拒。
   */
  const report = useCallback(() => {
    const node = slotRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const minWidth = minLayoutWidthRef.current;
    const zoom = minWidth === undefined || minWidth <= 0 ? 1 : Math.min(1, rect.width / minWidth);
    node.dataset.zoomReading = String(Math.round(zoom * 1000) / 1000);
    node.dataset.zoomSource = minWidth === undefined ? 'unadapted' : 'platform';
    void bridge?.shell.setKernelViewBounds({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
    void bridge?.shell.setKernelViewZoomFactor(zoom);
  }, [bridge]);

  useEffect(() => {
    void resolveMinLayoutWidth().then(() => report());
    const observer = new ResizeObserver(() => report());
    if (slotRef.current) observer.observe(slotRef.current);
    return () => observer.disconnect();
  }, [report, resolveMinLayoutWidth]);

  return (
    <div
      ref={slotRef}
      data-testid="kernel-canvas-slot"
      data-zoom-source="pending"
      className="pointer-events-none absolute inset-0"
    >
      {/* 视图盖上来之前这一块是空的：文字不铺进来，免得首帧看起来像“页面在加载” */}
      <span className="sr-only">{t('kernel.heading')}</span>
    </div>
  );
}
