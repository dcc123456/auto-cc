/**
 * 真纸面视图（spec 3.5-12）：把用户手里那份 PDF 的那一页画成**它自己**，并在其上就地改。
 *
 * 这一格存在的理由就是那句报障：「希望 pdf 编辑可以直接在导入的 pdf 上进行编辑，而不是显示一堆框框」。
 * 改造前的画布是一张**纯白底**（`fillStyle='#ffffff'` 之后只描文本项矩形），人看到的框里根本没有字，
 * 位置与眼睛对不上任何东西；现在位图来自 pdf.js 的真实渲染，行盒只在悬停时才描边、点下去就是那一行。
 * 3.5-14 补上另一半：提交上去的覆盖区**用这一页自己的底色**（从位图上量的，不是猜的白），
 * 并且提交态**不再描任何边**——那一圈常驻的琥珀虚线就是"这里有一块补丁"的自供状。
 * 3.5-16 收掉最后一格：就地改的输入框**没有自己的底色**（那一行先在画布上盖好，框只是透明地坐在上面），
 * 而它显示的字号/字族/墨色与另存出来的那行字共用同一份读数（3.5-15 量来的那三个数）。
 *
 * 三条不变量：
 * ① 槽里任何时刻只有一张画布（spec 6.4-08）——控件在左列，画面只在这里；
 * ② 装不下就整张缩小（spec 6.4-12）——画布挂 `w-full`，位图按量出的 CSS 宽度铺，永不横向裁；
 * ③ 覆盖永远说「盖住」，不说「删掉原文」（§7.6 反伪装）：那两句里「原文字仍在文件里」这一句一字未动，
 *    3.5-14 只把机制那半句的「白底」换成「这一页自己的底色」——机制真的变了，措辞跟着变才算诚实；
 *    底色量不到时再多说一句（按墨色垫底、新字反白），不许静默猜白。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import { colorsOfOverlay } from '@auto-cc/plugin-pdf-edit/overlay-colors';
import { DeskButton, InlineEditField } from './ui/controls';
import type { PdfEditModel } from './usePdfEdit';
import type { PdfPaperRect, PdfTextLine } from './pdf-page-view';

/**
 * 位图重画的宽度阈值：拖把手时 `pointermove` 每帧都在改布局，而一页渲染是几十毫秒量级的活。
 * 变化不足这个比例就先用 CSS 拉伸既有位图（看着略糊），停手再重画清晰的那一张。
 */
const REPAINT_WIDTH_DELTA = 0.06;

/**
 * 「拖」的最小位移：起收点在比例坐标上的曼哈顿距离（横纵各占 0..1）不足这个数就算「点」。
 * 0.004 在 1000px 宽的纸面上约等于 4px——比一次手抖大，比一行字窄。
 */
const DRAG_MIN_MANHATTAN = 0.004;

/**
 * 起收点之间算不算一次拖拽（`move` 的橡皮筋与 `up` 的落覆盖区共用这一个判据，§2.5）。
 * @param from 起手点（比例）
 * @param to 当下的点（比例）
 */
function hasDragged(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return Math.abs(to.x - from.x) + Math.abs(to.y - from.y) >= DRAG_MIN_MANHATTAN;
}

/**
 * 把指针位置换算成页面内的比例坐标（原点左上）。
 * @param clientX 指针视口横坐标（px）
 * @param clientY 指针视口纵坐标（px）
 * @param canvas 正在操作的那块画布；宽高为 0（视图未激活）时返回 undefined，不做除零
 */
function ratioOfPointer(clientX: number, clientY: number, canvas: HTMLCanvasElement) {
  const box = canvas.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return undefined;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return { x: clamp((clientX - box.left) / box.width), y: clamp((clientY - box.top) / box.height) };
}

/**
 * 两点算一个矩形（拖拽的起点与落点谁在左上不限）。
 * @param from 起手点（比例）
 * @param to 落点（比例）
 */
function rectOfPoints(from: { x: number; y: number }, to: { x: number; y: number }): PdfPaperRect {
  return {
    xRatio: Math.min(from.x, to.x),
    yRatio: Math.min(from.y, to.y),
    widthRatio: Math.abs(to.x - from.x),
    heightRatio: Math.abs(to.y - from.y),
  };
}

/**
 * 比例点是否落在这一行的行盒里（竖向放宽半个行高：人点的是字的中间，不必正好命中基线）。
 * @param point 纸面上的比例点
 * @param line 候选行
 */
function hitsLine(point: { x: number; y: number }, line: PdfTextLine): boolean {
  const pad = line.rect.heightRatio / 2;
  return (
    point.x >= line.rect.xRatio &&
    point.x <= line.rect.xRatio + line.rect.widthRatio &&
    point.y >= line.rect.yRatio - pad &&
    point.y <= line.rect.yRatio + line.rect.heightRatio + pad
  );
}

/**
 * 把比例矩形写成**某一个节点**上的四条 CSS 变量（§5.2 的那条已登记口径：动态几何不进内联 `style`，
 * 也不散进多颗节点——写在一个节点上，消费它的那两格用 Tailwind 的 `left-(--…)` 取值）。
 * @param node 承载变量的节点
 * @param prefix 变量前缀（`--pdf-hover` / `--pdf-edit` / `--pdf-rubber`）
 * @param rect 比例矩形；undefined = 这一格此刻不该画
 */
function putRectVars(node: HTMLElement, prefix: string, rect?: PdfPaperRect): void {
  for (const [key, value] of [
    ['left', rect === undefined ? '0%' : `${rect.xRatio * 100}%`],
    ['top', rect === undefined ? '0%' : `${rect.yRatio * 100}%`],
    ['width', rect === undefined ? '0%' : `${rect.widthRatio * 100}%`],
    ['height', rect === undefined ? '0%' : `${rect.heightRatio * 100}%`],
  ] as const) {
    node.style.setProperty(`--${prefix}-${key}`, value);
  }
}

/**
 * 就地改那一格的**字档**（字号 / 字族 / 墨色）写在同一个包裹节点上（§5.2：动态值不进内联 `style`，
 * 也不散进多颗节点）。三个数全部来自被盖住的那一行与刚在画布上盖好的那块底色，输入框只是 `inherit`——
 * 于是"人正在敲的那行字"与"另存出来那行字"出自同一份读数，不是两处各挑一次（spec 3.5-16）。
 * @param node 承载变量的节点（纸的包裹层）
 * @param font 字号（CSS px，按纸面当下的 CSS 宽度换算）、字族与墨色
 */
function putEditTypeVars(node: HTMLElement, font: { sizePx: number; family: string; inkHex: string }): void {
  node.style.setProperty('--pdf-edit-size', `${font.sizePx.toFixed(2)}px`);
  node.style.setProperty('--pdf-edit-font', font.family);
  node.style.setProperty('--pdf-edit-ink', font.inkHex);
}

/**
 * 简历屏 PDF 档的那一张真纸。
 * @param model 这一轨的唯一模型（`usePdfEdit`，desk 持有）
 */
export function PdfPaperView({ model }: { model: PdfEditModel }) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** 上一次真画时量到的 CSS 宽度（px）；0 = 还没画过。 */
  const paintedWidthRef = useRef(0);
  /** 重画序号：连改两次宽度时，慢的那一趟回来要整条丢弃（否则会盖掉新宽度那一张）。 */
  const paintSeqRef = useRef(0);
  /** 上一趟重绘的尾巴：新的一次一律排在它后面（见 `repaint` 那条注释）。 */
  const paintChainRef = useRef<Promise<void>>(Promise.resolve());
  const dragStartRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const [hovered, setHovered] = useState<PdfTextLine>();
  /** 最近一次真渲染的耗时（ms）；-1 = 这一页还没画。与行数一起是「纸上到底有没有东西」的读数。 */
  const [paintMs, setPaintMs] = useState(-1);

  /**
   * 把就地改那一格的字档（字号 / 字族 / 墨色）写成包裹节点上的三只变量。
   * 两个时机各写一次：**渲染那一帧**（effect——不写的话首帧的字号是继承来的，要等一趟异步重画才对上）、
   * 以及**重画之后**（`paintNow`——拖把手改的是 CSS 宽度，纸面缩放，字档必须跟着缩）。
   * 判据只有一处：底色走 `sampleBackdrop`，两色走 `colorsOfOverlay`，与画布上那块垫底同源。
   */
  const writeEditTypeVars = useCallback(() => {
    const node = wrapRef.current;
    const canvas = canvasRef.current;
    const page = model.paperPage;
    const line = model.editing?.line;
    if (!node || !canvas || !page || !line || canvas.clientWidth < 1) return;
    putEditTypeVars(node, {
      sizePx: (line.fontSizePt * canvas.clientWidth) / page.widthPt,
      family: line.fontFamilyHint,
      inkHex: colorsOfOverlay({ backdropHex: page.sampleBackdrop(line.rect) }).inkHex,
    });
  }, [model.editing?.line, model.paperPage]);

  /**
   * 画这一页：先要位图（pdf.js），再把已提交的覆盖区叠上去（**这一页自己的底色** + 新字，不描边），
   * 最后把**正在就地改的那一行也先盖好**（spec 3.5-16：输入框从此透明地坐在自己那一行上）。
   * 覆盖区画进同一块画布是「所见即所得」的最低要求——另存产物里那一块就是这个样子（spec 3.5-02）；
   * 所以纸面图像、垫底颜色与新字墨色**一律跟着产物走**（`colorsOfOverlay`），不跟主题走。
   */
  const paintNow = useCallback(async () => {
    const canvas = canvasRef.current;
    const page = model.paperPage;
    if (!canvas || !page) return;
    const cssWidth = Math.round(canvas.clientWidth);
    if (cssWidth < 1) return;
    const seq = paintSeqRef.current + 1;
    paintSeqRef.current = seq;
    const started = await page.paint(canvas, cssWidth);
    if (seq !== paintSeqRef.current) return;
    paintedWidthRef.current = cssWidth;
    setPaintMs(started);
    const painter = canvas.getContext('2d');
    if (!painter) return;
    const pxPerPt = canvas.width / page.widthPt;
    painter.setTransform(1, 0, 0, 1, 0, 0);
    for (const overlay of model.draft.overlays) {
      if (overlay.pageNumber !== page.pageNumber) continue;
      // 两条腿共用 `colorsOfOverlay` 这一句判据：画布上这块的颜色就是产物里那块的颜色（spec 3.5-02 的所见即所得）。
      const colors = colorsOfOverlay(overlay);
      const x = overlay.rect.xRatio * canvas.width;
      const y = overlay.rect.yRatio * canvas.height;
      const boxWidth = overlay.rect.widthRatio * canvas.width;
      const boxHeight = overlay.rect.heightRatio * canvas.height;
      // 向外溢 1px：行盒边缘那一圈是抗锯齿的半透明墨，只铺整盒会留一条看得见的花边（还是"看到底部文字"）。
      painter.fillStyle = colors.fillHex;
      painter.fillRect(x - 1, y - 1, boxWidth + 2, boxHeight + 2);
      // 提交态**不描边**（spec 3.5-14）：那一圈琥珀虚线是"这里有一块补丁"的自供状，
      // 而拖拽中的那一只已经有 DOM 里的青瓷虚线框在说（`pdf-edit-rubber-box`），不重复挂。
      if (overlay.text && model.limits) {
        const sizePt = overlay.sizePt ?? model.limits.defaultTextSizePt;
        // 字族与基线都取自被盖住的那一行（spec 3.5-15）：原先写死的 `sans-serif` + `textBaseline='bottom'`
        // 让替换字与原文在字族、基线两样上各差一截，那正是"一眼看出这里被动过"的那一截。
        painter.fillStyle = colors.inkHex;
        painter.font = `${String(sizePt * pxPerPt)}px ${overlay.fontFamilyHint ?? 'sans-serif'}`;
        painter.textBaseline = 'alphabetic';
        // 量到了基线就照那条线画；量不到（拖框那一腿没有行可依）才按 em 盒竖向居中。
        const baselineY =
          overlay.baselineRatio === undefined
            ? y + boxHeight - (boxHeight - sizePt * pxPerPt) / 2
            : overlay.baselineRatio * canvas.height;
        painter.fillText(overlay.text, x, baselineY);
      }
    }
    // 就地改还没提交，但**这一行先在画布上盖好**（spec 3.5-16）：输入框从此透明地坐在自己那一行上，
    // 而不是贴着一只 95% 不透明白盒子把原字压在底下。取色走同一句 `colorsOfOverlay`，
    // 所以预览这块与提交后那块同色；字号/字族/墨色同时写成这个节点上的三只变量（§5.2）。
    const editingLine = model.editing?.line;
    if (editingLine) {
      const rect = editingLine.rect;
      const colors = colorsOfOverlay({ backdropHex: page.sampleBackdrop(rect) });
      painter.fillStyle = colors.fillHex;
      painter.fillRect(
        rect.xRatio * canvas.width - 1,
        rect.yRatio * canvas.height - 1,
        rect.widthRatio * canvas.width + 2,
        rect.heightRatio * canvas.height + 2,
      );
      // 墨色与这块垫底是同一句 `colorsOfOverlay` 的两侧，所以预览与产物同色；字档写成变量给 DOM 那一格用。
      writeEditTypeVars();
    }
  }, [model.draft.overlays, model.editing?.line, model.limits, model.paperPage, writeEditTypeVars]);

  /**
   * 排一次重绘：挂载那一帧、观察器送来的第一帧、换页与翻主题会在同一刻各敲一次，
   * 而 pdf.js 对同一块画布只允许一趟 `render()` 在跑——并发时第二趟当场被拒
   *（活体实测拿到 `Cannot use the same canvas during multiple render() operations`，
   * 表现就是"状态说这一页画好了、纸上却整张透明"，见 spec 3.5-12 的读数）。
   * 这里把四路触发汇成一条队（§2.5 合并到一个入口），排在后面的自然就是画上最后那一张的人。
   * 那条 `catch` 不是为了吞错，是为了**不让一段被拒的链条毒死后面的重绘**：
   * 链上任何一环 reject 而不接住，之后的每个 `.then` 都会被跳过，纸就再也画不出来了。
   */
  const repaint = useCallback((): Promise<void> => {
    paintChainRef.current = paintChainRef.current.then(paintNow, paintNow);
    return paintChainRef.current;
  }, [paintNow]);

  // 换页 / 换覆盖区都重画这一张（`repaint` 的引用随这两样换）。
  // 宽度变化不走这里：拖把手时每帧都在改宽度，它由下面那条观察器按阈值挑一次重画。
  // 翻主题不再惊动画布（3.5-14 把它从依赖里摘掉）：纸上只剩两种颜色——那一页自己的位图，
  // 和覆盖区从位图上量到的那块纸色，两者都跟着产物走、不跟主题走；
  // 原先为那一圈琥珀虚线才取的 `deskTheme` 读数随虚线一起退役（§2.4：被替换的旧实现要删干净）。
  useEffect(() => {
    void repaint();
  }, [repaint]);

  // 槽宽变化（拖把手、缩窗口、展开内核视图）由观察器推：够一笔就重画清晰的那一张。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => {
      const cssWidth = Math.round(canvas.clientWidth);
      if (
        cssWidth < 1 ||
        (paintedWidthRef.current > 0 &&
          Math.abs(cssWidth - paintedWidthRef.current) / paintedWidthRef.current <= REPAINT_WIDTH_DELTA)
      ) {
        return;
      }
      void repaint();
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [repaint]);

  // 悬停 / 橡皮筋 / 就地改三只框的几何：都写在纸的包裹节点上，只有当下在场的那一格被画出来。
  // 依赖收到 `?.line` 这一层：就地改的草稿每敲一键都换对象，但那不影响行盒与字档（省掉每帧一次量色）。
  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    putRectVars(node, 'pdf-hover', hovered?.rect);
    putRectVars(node, 'pdf-rubber', model.rubber);
    putRectVars(node, 'pdf-edit', model.editing?.line.rect);
    writeEditTypeVars();
  }, [hovered, model.editing?.line, model.rubber, writeEditTypeVars]);

  /**
   * 纸上的手势：一次按下既可能是「点一行来改」，也可能是「拖一只覆盖区」（进阶腿）。
   * 分辨只看**起收点的位移**（`DRAG_MIN_MANHATTAN`）：够不上就当作点，那点上有行盒便进就地改；够上了按拖出来的矩形交进会话。
   * 监听在 `pointerdown` 当场挂上，不挂在后续渲染的 effect 里（3.6 活体那条教训：
   * harness 把 down/move/up 在几毫秒里派发完，effect 等渲染提交时 `pointerup` 早就过去了）。
   * @param event 画布上的 `pointerdown`
   */
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const startPoint = ratioOfPointer(event.clientX, event.clientY, canvas);
    if (!startPoint) return;
    dragStartRef.current = startPoint;
    const move = (moveEvent: PointerEvent) => {
      const current = dragStartRef.current;
      const point = ratioOfPointer(moveEvent.clientX, moveEvent.clientY, canvas);
      if (!current || !point) return;
      if (!hasDragged(current, point)) return;
      setHovered(undefined);
      model.setRubber(rectOfPoints(current, point));
    };
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const current = dragStartRef.current;
      const point = ratioOfPointer(upEvent.clientX, upEvent.clientY, canvas);
      dragStartRef.current = undefined;
      if (!current || !point) return;
      // 判"拖过没拖过"只看**这两点自己的位移**，不读 `model.rubber`：那个值是 pointerdown 那一次渲染的快照，
      // 在同一趟手势里永远是 `undefined`（活体实测：拖框那条腿从不落覆盖区，见 plan §11.5）。
      // 橡皮筋的显示仍然走 state，只是它不再是这条分支的判据（§2.5：一个判据一个出处）。
      const dragged = hasDragged(current, point);
      model.setRubber(undefined);
      if (dragged) {
        // 旧流程（先写字、再框位置）原样保留，只是降到进阶。
        model.commitOverlay(rectOfPoints(current, point));
        return;
      }
      const line = model.paperPage?.lines.find((candidate) => hitsLine(point, candidate));
      if (line) model.beginEdit(line);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** 悬停读数：只给"点得中的那一行"描边（§5.2「不可点的元素绝不长出 hover」的同一取向）。 */
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragStartRef.current !== undefined) return;
    const point = ratioOfPointer(event.clientX, event.clientY, event.currentTarget);
    if (!point) return;
    const line = model.paperPage?.lines.find((candidate) => hitsLine(point, candidate));
    setHovered(line);
  };

  /** 这一页有没有读得出的文字（扫描型的判据：为空就走那句诚实回落，绝不画假的可点行列表）。 */
  const lineCount = model.paperPage?.lines.length ?? 0;
  /**
   * 这一页上已提交的覆盖区，底色是不是**量到的**（spec 3.5-14 的那句读数）。
   * 判据不在此处再写一遍：取的就是 `colorsOfOverlay` 那句，界面上说的与两条腿上画的是同一件事。
   */
  const pageOverlays = model.draft.overlays.filter((overlay) => overlay.pageNumber === model.paperPage?.pageNumber);
  const sampledCount = pageOverlays.filter((overlay) => colorsOfOverlay(overlay).sampled).length;
  const unsampledCount = pageOverlays.length - sampledCount;
  const busyReason = model.busy !== undefined ? 'ACTION_BUSY' : undefined;

  return (
    <div data-testid="pdf-edit-paper" className="flex flex-col gap-2">
      <p
        className="font-mono text-[11px] text-slate-500"
        data-testid="pdf-edit-paper-state"
        data-state={model.paperState}
      >
        {model.paperState === 'idle'
          ? t('pdfEdit.paperIdle')
          : model.paperState === 'loading'
            ? t('pdfEdit.paperLoading')
            : model.paperState === 'failed'
              ? t('pdfEdit.paperFailed', { message: model.paperError ?? '' })
              : t('pdfEdit.paperReading', { page: model.page, lines: lineCount, ms: paintMs })}
      </p>

      {/* 纸本体：位图占满这一格（`w-full` + `h-auto` 保住页面自己的长宽比，装不下就是整张缩小）。
          三只框（悬停 / 橡皮筋 / 就地改）都是**同一个节点上的变量**的消费方，不在 DOM 里堆盒子。 */}
      <div ref={wrapRef} className="relative min-w-0">
        <canvas
          ref={canvasRef}
          data-testid="pdf-edit-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHovered(undefined)}
          className="block h-auto w-full cursor-crosshair rounded-md border border-line-strong bg-white shadow-sheet"
        />
        {hovered && !model.editing && (
          <span
            aria-hidden="true"
            data-testid="pdf-edit-hover-box"
            className="pointer-events-none absolute left-(--pdf-hover-left) top-(--pdf-hover-top) h-(--pdf-hover-height) w-(--pdf-hover-width) rounded-[2px] border border-amber"
          />
        )}
        {/* 就地改那一格：**没有自己的底色**（spec 3.5-16）——画布上这一行已经先盖好了，
            输入框透明地坐在上面，字号/字族/墨色一律继承这个节点上的三只变量。 */}
        {model.editing && (
          <div
            data-testid="pdf-edit-inline-wrap"
            className="absolute left-(--pdf-edit-left) top-(--pdf-edit-top) flex min-w-[160px] items-start gap-1 font-[family-name:var(--pdf-edit-font)] text-[color:var(--pdf-edit-ink)] text-[length:var(--pdf-edit-size)]"
          >
            <InlineEditField
              bare
              action="pdf-edit-inline-text"
              value={model.editing.text}
              onValueChange={model.changeEditText}
              onSave={model.commitEdit}
              onCancel={model.cancelEdit}
              className="min-w-0 flex-1"
            />
            <DeskButton
              action="pdf-edit-commit-inline"
              variant="amber"
              compact
              className="h-6"
              busy={!!model.busy}
              disabled={!!model.busy}
              disabledReason={busyReason}
              disabledReasonLabel={busyReason ? t('resume.reason.ACTION_BUSY') : undefined}
              onClick={model.commitEdit}
            >
              <Check size={11} />
              {t('pdfEdit.commitInline')}
            </DeskButton>
            <DeskButton
              action="pdf-edit-cancel-inline"
              variant="ghost"
              compact
              className="h-6"
              onClick={model.cancelEdit}
              aria-label={t('pdfEdit.cancelInline')}
            >
              <X size={11} />
            </DeskButton>
          </div>
        )}
        {model.rubber && (
          <span
            aria-hidden="true"
            data-testid="pdf-edit-rubber-box"
            className="pointer-events-none absolute left-(--pdf-rubber-left) top-(--pdf-rubber-top) h-(--pdf-rubber-height) w-(--pdf-rubber-width) border border-dashed border-celadon"
          />
        )}
      </div>

      {/* 底色读数（spec 3.5-14）：这几块补丁到底是量出来的纸色，还是量不到而回落的墨色——界面上要说得出条数。 */}
      {pageOverlays.length > 0 && (
        <p
          className="font-mono text-[11px] text-slate-500"
          data-testid="pdf-edit-backdrop-reading"
          data-overlays={pageOverlays.length}
          data-sampled={sampledCount}
          data-unsampled={unsampledCount}
        >
          {t('pdfEdit.backdropReading', { count: pageOverlays.length, sampled: sampledCount })}
        </p>
      )}
      {unsampledCount > 0 && (
        <p className="text-[11px] text-amber" data-testid="pdf-edit-backdrop-fallback">
          {t('pdfEdit.backdropFallback', { count: unsampledCount })}
        </p>
      )}

      {/* 两句诚实读数：反伪装那条的「原文字仍在文件里，只是被盖住了」一字不能改（3.5-04 已放弃字节级替换，
          覆盖永远不许说成涂黑），扫描型那一页没字就直说没字，仍然可以拖框。 */}
      <p className="text-[11px] text-amber" data-testid="pdf-edit-cover-hint">
        {t('pdfEdit.coverHint')}
      </p>
      {model.paperState === 'ready' && lineCount === 0 && (
        <p className="text-[11px] text-slate-400" data-testid="pdf-edit-scan-fallback">
          {t('pdfEdit.scanFallback')}
        </p>
      )}
      {model.paperState === 'ready' && lineCount > 0 && (
        <p className="text-[11px] text-slate-500" data-testid="pdf-edit-inline-hint">
          {t('pdfEdit.inlineHint')}
        </p>
      )}
    </div>
  );
}
