/**
 * 真纸面视图（spec 3.5-12 的查看半边，裁定㊳）：把用户手里那份 PDF 的那一页画成**它自己**。
 *
 * 这一格存在的理由仍然是那句报障：画布不该是"一堆框框"，而该是那份文件本身。
 * 位图来自 pdf.js 的真实渲染，装不下就整张缩小——到这里都不变。
 * 变的是裁定㊳之后这一格只剩"看"：悬停描边、就地改输入框、橡皮筋拖框、覆盖层叠画那四路交互与渲染
 * 整条摘除（改字与出纸归整页编辑那一屏；`usePdfView` 里已没有 draft，画布自然无层可叠，§2.4）。
 *
 * 两条不变量仍然成立：
 * ① 槽里任何时刻只有一张画布（spec 6.4-08）——控件在左列，画面只在这里；
 * ② 装不下就整张缩小（spec 6.4-12）——画布挂 `w-full`，位图按量出的 CSS 宽度铺，永不横向裁。
 *
 * 2026-10-15 友好化：空槽不再只给一行 mono 小灰字让人去左列找路径框——
 * 纸面槽直接是一张 WPS 式引导卡，主按钮弹系统选文件面板（选完即开）；
 * 纸打开后编辑入口就挂在纸面正上方，不用回左列翻。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileUp, FolderOpen, PenLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Banner, DeskButton } from './ui/controls';
import type { PdfViewModel } from './usePdfView';

/**
 * 位图重画的宽度阈值：拖把手时 `pointermove` 每帧都在改布局，而一页渲染是几十毫秒量级的活。
 * 变化不足这个比例就先用 CSS 拉伸既有位图（看着略糊），停手再重画清晰的那一张。
 */
const REPAINT_WIDTH_DELTA = 0.06;

/**
 * 简历屏 PDF 档的那一张真纸（只读）。
 * @param model 这一轨的唯一模型（`usePdfView`，desk 持有）
 * @param onOpenEditor 进 WPS 形态整页编辑器（纸就绪后入口直接挂在纸面上方）
 */
export function PdfPaperView({ model, onOpenEditor }: { model: PdfViewModel; onOpenEditor: () => void }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** 上一次真画时量到的 CSS 宽度（px）；0 = 还没画过。 */
  const paintedWidthRef = useRef(0);
  /** 重画序号：连改两次宽度时，慢的那一趟回来要整条丢弃（否则会盖掉新宽度那一张）。 */
  const paintSeqRef = useRef(0);
  /** 上一趟重绘的尾巴：新的一次一律排在它后面（见 `repaint` 那条注释）。 */
  const paintChainRef = useRef<Promise<void>>(Promise.resolve());
  /** 最近一次真渲染的耗时（ms）；-1 = 这一页还没画。与页数页号一起是「纸上到底有没有东西」的读数。 */
  const [paintMs, setPaintMs] = useState(-1);

  /** 画这一页：位图来自 pdf.js 的真实渲染，纯色纸面、不叠任何东西（查看档没有覆盖层）。 */
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
  }, [model.paperPage]);

  /**
   * 排一次重绘：挂载那一帧、观察器送来的第一帧、换页会在同一刻各敲一次，
   * 而 pdf.js 对同一块画布只允许一趟 `render()` 在跑——并发时第二趟当场被拒
   *（活体实测拿到 `Cannot use the same canvas during multiple render() operations`，
   * 表现就是"状态说这一页画好了、纸上却整张透明"，见 spec 3.5-12 的读数）。
   * 这里把几路触发汇成一条队（§2.5 合并到一个入口），排在后面的自然就是画上最后那一张的人。
   * 那条 `catch` 不是为了吞错，是为了**不让一段被拒的链条毒死后面的重绘**：
   * 链上任何一环 reject 而不接住，之后的每个 `.then` 都会被跳过，纸就再也画不出来了。
   */
  const repaint = useCallback((): Promise<void> => {
    paintChainRef.current = paintChainRef.current.then(paintNow, paintNow);
    return paintChainRef.current;
  }, [paintNow]);

  // 换页都重画这一张（`repaint` 的引用随换页换）。
  // 宽度变化不走这里：拖把手时每帧都在改宽度，它由下面那条观察器按阈值挑一次重画。
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

  const stateText =
    model.paperState === 'idle'
      ? t('pdfEdit.paperIdle')
      : model.paperState === 'loading'
        ? t('pdfEdit.paperLoading')
        : model.paperState === 'failed'
          ? t('pdfEdit.paperFailed', { message: model.paperError ?? '' })
          : t('pdfEdit.paperReading', { page: model.page, ms: paintMs });

  // 空槽（还没纸 / 在装载 / 画失败）：WPS 式引导卡，主入口是系统选文件面板——
  // 渲染层没有读文件的通道，手敲绝对路径那条老路降级成卡片里的一只次级按钮。
  if (model.paperState !== 'ready' || !model.paperPage) {
    const busy = !!model.busy;
    return (
      <div data-testid="pdf-edit-paper" className="flex flex-col gap-2">
        <p className="sr-only" data-testid="pdf-edit-paper-state" data-state={model.paperState}>
          {stateText}
        </p>
        <div className="flex min-h-[26rem] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line-strong bg-ink-900/40 px-6 py-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-line-strong bg-ink-900/60 text-jade-ink">
            <FileUp size={22} />
          </span>
          <h3 className="text-base font-semibold text-slate-100">{t('pdfEdit.landingTitle')}</h3>
          <p className="max-w-md text-[11px] leading-relaxed text-slate-500">{t('pdfEdit.landingBody')}</p>
          <DeskButton
            action="pdf-edit-pick-file"
            variant="jade"
            busy={busy}
            disabled={busy}
            disabledReason="ACTION_BUSY"
            disabledReasonLabel={t('pdfEdit.reason.ACTION_BUSY')}
            markers={{ testid: 'pdf-edit-landing-pick' }}
            onClick={model.pickSourceFile}
          >
            <FolderOpen size={13} />
            {t('pdfEdit.landingPick')}
          </DeskButton>
          <DeskButton
            action="pdf-edit-landing-manual"
            variant="ghost"
            compact
            disabled={busy}
            disabledReason="ACTION_BUSY"
            disabledReasonLabel={t('pdfEdit.reason.ACTION_BUSY')}
            onClick={() => {
              // 手敲路径那条老路仍在左列：替人把输入框滚进视野并聚焦，免得他满屏找。
              const pathInput = document.querySelector<HTMLInputElement>('[data-action="pdf-edit-path"]');
              pathInput?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              pathInput?.focus();
            }}
          >
            {t('pdfEdit.landingManual')}
          </DeskButton>
          {model.paperState === 'loading' && <p className="text-[11px] text-slate-500">{t('pdfEdit.paperLoading')}</p>}
          {(model.openError || model.paperState === 'failed') && (
            <Banner tone="seal" markers={{ testid: 'pdf-edit-landing-error' }}>
              {t('pdfEdit.landingFailed', {
                message: model.openError?.message ?? model.paperError ?? '',
              })}
            </Banner>
          )}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="pdf-edit-paper" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          className="font-mono text-[11px] text-slate-500"
          data-testid="pdf-edit-paper-state"
          data-state={model.paperState}
        >
          {stateText}
        </p>
        {/* 看完一眼就想改：编辑入口直接跟纸同格，不用回左列翻那颗按钮。 */}
        <DeskButton
          action="pdf-edit-open-editor"
          variant="jade"
          compact
          busy={!!model.busy}
          disabled={!!model.busy}
          disabledReason="ACTION_BUSY"
          disabledReasonLabel={t('pdfEdit.reason.ACTION_BUSY')}
          onClick={onOpenEditor}
        >
          <PenLine size={12} />
          {t('pdfEdit.openInEditor')}
        </DeskButton>
      </div>

      {/* 纸本体：位图占满这一格（`w-full` + `h-auto` 保住页面自己的长宽比，装不下就是整张缩小）。
          只读一张纸：没有手势、没有悬停框，指针就是普通指针。 */}
      <div className="relative min-w-0">
        <canvas
          ref={canvasRef}
          data-testid="pdf-edit-canvas"
          className="block h-auto w-full rounded-md border border-line-strong bg-white shadow-sheet"
        />
      </div>
    </div>
  );
}
