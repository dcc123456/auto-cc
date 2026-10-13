import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/** 纸面槽左右内边距的**总**宽度（px）：与调用方 class 里的 `p-3`（12×2）是同一个数。 */
const PAPER_SLOT_PADDING_PX = 24;

export interface ResumePaperFrameProps {
  /**
   * 纸上的那份打印 HTML（与导出同一个 builder，spec 3.3-01「预览即导出所见」）。
   * `undefined` = 这一版还没渲出来：画空态，**不**画上一版的残留。
   */
  html?: string;
  /** iframe 的 `data-testid`（三档各有各的取证通道名，调用方给）。 */
  frameTestId: string;
  /** iframe 的无障碍名字。 */
  frameTitle: string;
  /**
   * 沙箱档位。**只读那一档必须是空串**：整屏编辑页要 `allow-same-origin` 才能在父页一侧量段矩形
   * （plan §15 的实测表：空串时 `contentDocument` 读不到），而 `allow-scripts` 那一档被否决——
   * 帧内一旦能跑脚本，页面里那份 HTML 就拿到了通向 app 渲染层的执行权（§8.1）。
   */
  sandbox: string;
  /** 空态那一格的 `data-testid`。 */
  emptyTestId: string;
  /** 空态那一格的话术（已翻译）。 */
  emptyLabel: string;
  /** 槽位（纸外面那一格）的 class：高度档由调用方决定，本组件只管缩放。 */
  slotClassName: string;
  /** 槽位的 `data-testid`（`resume-paper-slot` 是 spec 6.4-12 的取证通道）。 */
  slotTestId?: string;
  /**
   * 每一帧装好后把 iframe 交回调用方（整屏编辑页在这一刻挂命中测试、注入选中描边）。
   * 它是**单向的通知**，调用方自己决定要不要留着那个引用；换 `html` 就是换一份文档，所以每次装载都会再给一次。
   */
  onFrameLoad?: (frame: HTMLIFrameElement) => void;
}

/**
 * 一张纸：A4 宽度的 iframe + 「装不下就整张缩小」的那只手（从 `ResumePaperStage` 抽出，spec 3.10-06）。
 *
 * 抽出来的理由是 §2.2：右栏那一格与整屏编辑页要画的是**同一张纸**，缩放口径只许有一份
 * （两份 `fitPaper` 就会有两个"装不下"的判据，而 6.4-12 的判据原文只有一条）。
 * 画面内容仍然由调用方供给：这一格不发起任何跨进程调用，也不判断"该画哪一份"。
 *
 * 缩放只动显示倍率：iframe 仍是 `w-[210mm]`，A4 的物理宽度与折行一字未改，导出产物与这一格无关。
 * 倍率由 `--paper-scale` 给，**只写在这一个节点上**（与 `--kernel-slot-width` 同一口径，plan §3.24 记的那条 §5.2 偏离）：
 * 拖栏宽时 `pointermove` 每帧都在改布局，这里若把它写进 React state，整屏每帧重渲一次。
 * @param props 见 `ResumePaperFrameProps`
 * @returns 一格纸面：空态或那张纸
 */
export function ResumePaperFrame({
  html,
  frameTestId,
  frameTitle,
  sandbox,
  emptyTestId,
  emptyLabel,
  slotClassName,
  slotTestId,
  onFrameLoad,
}: ResumePaperFrameProps) {
  /** 纸的那一格：宽度跟着调用方给的那一栏走，倍率写在自己身上。 */
  const slotRef = useRef<HTMLDivElement | null>(null);
  /** 唯一那张纸（iframe）。`offsetWidth` 是它的**布局**宽度，不受 transform 影响，正好拿来当分母。 */
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  /**
   * 量一次槽宽并把显示倍率写成 CSS 变量。
   * 分母取 iframe 自己量出的布局宽度而不是写死的 794：`210mm` 换到多少 px 由浏览器与 DPI 口径决定，
   * 写死等于在界面里存第二份纸宽事实（§2.5）。
   * 分子要扣掉槽位自己的左右内边距（`PAPER_SLOT_PADDING_PX`）——扣了这一格，纸的右缘才会落在槽内，
   * 而 `overflow-hidden` 只是保险，不是"裁纸"的那一道（spec 6.4-12 的③）。
   */
  const fitPaper = useCallback(() => {
    const slot = slotRef.current;
    const frame = frameRef.current;
    if (!slot || !frame) return;
    const naturalWidth = frame.offsetWidth;
    const availWidth = slot.clientWidth - PAPER_SLOT_PADDING_PX;
    if (naturalWidth < 1 || availWidth < 1) return;
    slot.style.setProperty('--paper-scale', String(Math.min(1, availWidth / naturalWidth)));
  }, []);

  // 内容换了要重量一次：新挂上的 iframe 首帧还没有布局宽度。
  useLayoutEffect(() => {
    fitPaper();
  }, [fitPaper, html]);

  // 槽位宽度由 ResizeObserver 推：拖栏宽、缩窗口、展开内核视图都会让这一格重新布局。
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const observer = new ResizeObserver(() => fitPaper());
    observer.observe(slot);
    return () => observer.disconnect();
  }, [fitPaper]);

  return (
    <div ref={slotRef} data-testid={slotTestId} className={slotClassName}>
      {html === undefined ? (
        <div
          data-testid={emptyTestId}
          className="flex h-full w-full items-center justify-center rounded-control border border-dashed border-line bg-ink-850 px-6 text-center text-[11px] leading-relaxed text-slate-500"
        >
          {emptyLabel}
        </div>
      ) : (
        // `w-[210mm]` 是字面量：预览按 A4 的真实纸宽摆，装不下时整张缩小（`--paper-scale`），
        // 而不是压窄纸面、也不是横向滚——压窄了折行就与导出产物不是同一张纸（3.3-01），
        // 滚则等于把人刚要看的那张纸切掉一块（6.4-12 的③）。
        // 倍率是**视觉**缩放，布局盒仍是 794px，所以父级的 `overflow-hidden` 必须有：
        // 它在的是"倍率还没量到的首帧"那一格，而不是裁纸的口子。
        // 高度按倍率反算（`calc(100% / k)`）：缩放之后正好铺满槽位的内容盒。
        <iframe
          ref={frameRef}
          data-testid={frameTestId}
          title={frameTitle}
          sandbox={sandbox}
          onLoad={() => {
            if (frameRef.current) onFrameLoad?.(frameRef.current);
          }}
          srcDoc={html}
          className="h-[calc(100%/(var(--paper-scale)))] w-[210mm] shrink-0 origin-top-left scale-(--paper-scale) rounded-control border border-line bg-white shadow-sheet"
        />
      )}
    </div>
  );
}
