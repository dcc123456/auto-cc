import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/** 纸面槽内边距的**总**宽高（px）：与调用方 class 里的 `p-3`（12×2）是同一个数，上下左右同一个数。 */
const PAPER_SLOT_PADDING_PX = 24;
/** 纸的下缘与可见区下缘之间的余量（px）：不让纸正好压在最后一像素上。 */
const PAPER_BOTTOM_GUARD_PX = 8;
/**
 * A4 一页的高宽比（297 / 210）。一页的高度**由量出来的纸宽推**，
 * 而不是写成 `1123px` 那种第二份纸尺寸（§2.5；spec 6.4-24 的①）。
 */
const A4_HEIGHT_RATIO = 297 / 210;

/**
 * 「装不下」的判据口径（spec 6.4-24 的两档）。
 * - `page`：宽与**一页的高度**取小，纸高就是一整页 → A4 一页完整可见、不必在纸里滚（右栏那一格）。
 * - `width`：只看宽，纸高铺满可用高度、长文档在帧里滚（整屏编辑页：那一格是给 A4 原尺寸打字用的，见 3.12）。
 */
export type PaperFit = 'page' | 'width';

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
  /**
   * 「装不下」按哪一档判（spec 6.4-24 的两档，取值含义见 `PaperFit`）。
   * 两档共用同一只手，但**判据不同**：右栏那一格要"一页看全"，整屏编辑页那一格要"A4 原尺寸打字"，
   * 让其中一档去迁就另一档就会长出用户 2026-10-14 报的那个障（纸看不见底 / 纸被压成卡片）。
   */
  fit: PaperFit;
  /**
   * 槽位（纸外面那一格）的 class：只写宽度档与内边距。
   * **高度由本组件现算并写在节点上**（6.4-24 的③）：那一格的高度是"倍率之后那一截纸的视觉高度"，
   * 只有 `fitPaper` 量得出来，写进 class 就是存第二份事实。
   */
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
 * 槽位在这一屏里**还拿得到多高**（px，不含槽自己的上下内边距，也不含跟在纸后面的那几行）。
 *
 * 为什么不用 `100vh`：右栏那一格是 `sticky` 的（spec 6.4-12 的落地补片），粘住之前它下面还压着 app 自己的
 * `header` 与滚动容器的下缘（1200×772 实测：`header` 51、滚动容器下缘 742），按 `100vh` 算会把纸推出可见区，
 * 被推出去的正是回执条那一行（现状实测 section 底 790 > 742）。
 * @param slot 纸面槽
 * @returns 可用高度；可能为负（窗口矮到装不下纸之后那几行），调用方按"这一档不参与取小"处理
 */
function availableHeightOf(slot: HTMLDivElement): number {
  const rect = slot.getBoundingClientRect();
  let bottom = window.innerHeight;
  // 下缘取「窗口下缘」与「每一个祖先滚动容器下缘」里最靠上的那一个。
  for (let node: HTMLElement | null = slot; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') bottom = Math.min(bottom, node.getBoundingClientRect().bottom);
  }
  const column = slot.parentElement;
  const rowGap = column ? Number.parseFloat(getComputedStyle(column).rowGap) || 0 : 0;
  let below = 0;
  // 跟在纸之后的行是**条件挂载**的（披露条常驻、回执条只在导过之后长出来），所以逐行现量，不写死。
  for (let sibling = slot.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
    below += sibling.getBoundingClientRect().height + rowGap;
  }
  if (column) {
    const style = getComputedStyle(column);
    below += (Number.parseFloat(style.paddingBottom) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0);
  }
  return bottom - rect.top - PAPER_SLOT_PADDING_PX - below - PAPER_BOTTOM_GUARD_PX;
}

/**
 * 一张纸：A4 宽度的 iframe + 「装不下就整张缩小」的那只手（从 `ResumePaperStage` 抽出，spec 3.10-06）。
 *
 * 抽出来的理由是 §2.2：右栏那一格与整屏编辑页要画的是**同一张纸**，缩放口径只许有一份
 * （两份 `fitPaper` 就会有两个"装不下"的判据）。两格的差别只写在 `fit` 这一档入参上：
 * `width` 沿用 6.4-12 只看宽的原口径，`page` 按 6.4-24 再叠一条"一页的高度"。
 * 画面内容仍然由调用方供给：这一格不发起任何跨进程调用，也不判断"该画哪一份"。
 *
 * 缩放只动显示倍率：iframe 仍是 `w-[210mm]`，A4 的物理宽度与折行一字未改，导出产物与这一格无关。
 * 倍率与纸的布局高度由 `--paper-scale` / `--paper-height` 给，**只写在槽这一个节点上**（与 `--kernel-slot-width` 同一口径，plan §3.24 记的那条 §5.2 偏离）：
 * 拖栏宽时 `pointermove` 每帧都在改布局，这里若把它写进 React state，整屏每帧重渲一次。
 * 槽现在的高度不再由 class 给（6.4-24 的③）。原先 iframe 的高度是 `calc(100% ÷ 倍率)`：那是拿槽的显式高度
 * 反算布局高，槽只能靠 `h-[min(72vh,900px)]` 这种写死的视口算术来"跟着栏高走"。现在两个数都由 `fitPaper`
 * 现算并写在同一个节点上，于是纸的高度能真正跟着可见区走，而不是跟着一个 `vh` 常数走。
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
  fit,
  slotClassName,
  slotTestId,
  onFrameLoad,
}: ResumePaperFrameProps) {
  /** 纸的那一格：宽度跟着调用方给的那一栏走，倍率写在自己身上。 */
  const slotRef = useRef<HTMLDivElement | null>(null);
  /** 唯一那张纸（iframe）。`offsetWidth` 是它的**布局**宽度，不受 transform 影响，正好拿来当分母。 */
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  /**
   * 量一次纸宽、槽宽与这一屏的可用高度，把**显示倍率**与**纸的布局高度**写成两条 CSS 变量。
   * 分母取 iframe 自己量出的布局宽度而不是写死的 794：`210mm` 换到多少 px 由浏览器与 DPI 口径决定，
   * 写死等于在界面里存第二份纸宽事实（§2.5）。
   * 倍率的分子要扣掉槽位自己的内边距（`PAPER_SLOT_PADDING_PX`）——扣了这一格，纸的右缘才会落在槽内，
   * 而 `overflow-hidden` 只是保险，不是"裁纸"的那一道（spec 6.4-12 的③）。
   * `page` 那一档在这里加了第二条判据（spec 6.4-24）：一页 A4 的高度（由纸宽推，不存第二份纸尺寸）
   * 装不进可用高度时**按高缩**，代价是左右留白，换来的是整页看得见、不必在纸里滚。
   */
  const fitPaper = useCallback(() => {
    const slot = slotRef.current;
    const frame = frameRef.current;
    if (!slot || !frame) return;
    const naturalWidth = frame.offsetWidth;
    const availWidth = slot.clientWidth - PAPER_SLOT_PADDING_PX;
    if (naturalWidth < 1 || availWidth < 1) return;
    const pageHeight = naturalWidth * A4_HEIGHT_RATIO;
    const roomHeight = Math.max(1, availableHeightOf(slot));
    const widthScale = Math.min(1, availWidth / naturalWidth);
    const scale = fit === 'page' ? Math.min(widthScale, roomHeight / pageHeight) : widthScale;
    // `page`：纸上看到的是**一整页**——倍率已经保证这一页落得进可用高度，所以不必在纸里滚。
    // `width`：铺满可用高度，长文档在帧里滚（整屏打字那一档）。
    // 分两层是因为 `scale` 只改视觉、不改布局盒：iframe 的布局高 = 想让人看见的那一段 ÷ 倍率，
    // 而槽要抱住的是**视觉**那一格（`overflow-hidden` 夹住多出来的布局盒，与 6.4-12 当年同一手法）。
    const shownHeight = fit === 'page' ? pageHeight * scale : roomHeight;
    slot.style.setProperty('--paper-scale', String(scale));
    slot.style.setProperty('--paper-height', `${Math.round(shownHeight / scale)}px`);
    // 槽的高度只能现算：它等于倍率之后那一截纸的视觉高度，再加槽自己的上下内边距（同一个常量，不写第二遍）。
    slot.style.height = `${Math.round(shownHeight) + PAPER_SLOT_PADDING_PX}px`;
    // 按高缩之后左右各空出一截（裁定的原话就是"左右留白"），所以把纸摆正：`scale` 的原点在左上角，
    // 视觉左缘 = 布局左缘，推 `margin-left` 才是按 px 原样生效——写 `translate` 会被倍率再乘一次。
    frame.style.marginLeft = `${Math.max(0, Math.round((availWidth - naturalWidth * scale) / 2))}px`;
  }, [fit]);

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

  /**
   * 滚动要单独重量一次：右栏是 `sticky` 的（spec 6.4-12 的落地补片），粘住前后的 `top` 差着一截（实测 20px 上下），
   * 可用高度随之变，而 `ResizeObserver` 只看**尺寸**不看位移——不补这一条，滚到排版控件那一段时纸的下缘会越过可见区。
   * 一帧只量一次：滚动是连续发的，而重量一次要读十几条 computed style。
   */
  useEffect(() => {
    let pendingRaf = 0;
    const onScroll = () => {
      if (pendingRaf !== 0) return;
      pendingRaf = requestAnimationFrame(() => {
        pendingRaf = 0;
        fitPaper();
      });
    };
    // 捕获阶段：真正的滚动容器是祖先（app 的正文那一格），事件不会冒泡到 window。
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      if (pendingRaf !== 0) cancelAnimationFrame(pendingRaf);
      window.removeEventListener('scroll', onScroll, { capture: true });
    };
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
        // 高度由 `fitPaper` 量出来写成 px（`--paper-height`），不再写 `calc(100%/倍率)`：那一支百分比要求
        // 父格显式给高，而槽现在是抱住纸的（6.4-24 的③），百分比会退化成 `auto` = iframe 的 150px 默认高。
        <iframe
          ref={frameRef}
          data-testid={frameTestId}
          title={frameTitle}
          sandbox={sandbox}
          onLoad={() => {
            if (frameRef.current) onFrameLoad?.(frameRef.current);
          }}
          srcDoc={html}
          className="h-(--paper-height) w-[210mm] shrink-0 origin-top-left scale-(--paper-scale) rounded-control border border-line bg-white shadow-sheet"
        />
      )}
    </div>
  );
}
