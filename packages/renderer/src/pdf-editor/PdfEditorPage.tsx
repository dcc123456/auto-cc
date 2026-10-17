/**
 * WPS 形态 PDF 编辑器 = 全屏唯一工作台（2026-10-14 反转裁定后的整页编辑脸）。
 *
 * 布局四区（与已确认原型 wps-pdf-editor-design.html 同构）：
 * 标题栏 + Ribbon（顶）/ 页面缩略图（左）/ 纸面连续滚动（中）/ 属性卡（右）/ 状态条（底）。
 * 这一层只做装配与读数；会话状态全在 `usePdfEditor`，单页交互在 `PdfEditorPageCanvas`。
 */
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { DeskButton } from '../ui/controls';
import { usePdfEditor } from './usePdfEditor';
import { EditorHeader, EditorRibbon } from './PdfEditorChrome';
import { PageThumbRail } from './PageThumbRail';
import { ObjectPropertyCard } from './ObjectPropertyCard';
import { PdfEditorPageCanvas } from './PdfEditorPageCanvas';
import { zoomPercent } from './editor-tools';

export function PdfEditorPage({ filePath, onClose }: { filePath: string; onClose: () => void }) {
  const model = usePdfEditor(filePath, onClose);
  return <PdfEditorShell model={model} />;
}

function PdfEditorShell({ model }: { model: ReturnType<typeof usePdfEditor> }) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);

  /** 跳到某一页（缩略图点击）：按两矩形差滚，容器内边距由 -12 吸收。 */
  const jumpToPage = useCallback((pageIndex: number) => {
    const container = scrollRef.current;
    const target = container?.querySelector(`[data-editor-page-index="${pageIndex}"]`);
    if (!container || !(target instanceof HTMLElement)) return;
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    container.scrollTo({
      top: container.scrollTop + (targetRect.top - containerRect.top) - 12,
      behavior: 'smooth',
    });
  }, []);

  // 进屏先适应一次宽度；侧栏开合时也重新适应（人手动缩过之后模型内部会拒绝自动档）。
  // 装载未就绪时容器还没挂，effect 自带判空，就绪那帧重跑即生效。
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    model.fitWidthAuto(container.clientWidth);
    const observer = new ResizeObserver(() => model.fitWidthAuto(container.clientWidth));
    observer.observe(container);
    return () => observer.disconnect();
  }, [model.loadState, model.thumbsOpen, model.propsOpen, model.fitWidthAuto]);

  // 纸宽是运行期值：写在滚动容器的 --re-page-w 上，每页用 w-(--re-page-w) 消费（AGENTS.md §5.1）。
  useEffect(() => {
    scrollRef.current?.style.setProperty('--re-page-w', `${model.pageWidthPx}px`);
  }, [model.pageWidthPx]);

  // 滚动照出当前页（哪一页在容器中线附近就亮哪张缩略图）。
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const pages = Array.from(container.querySelectorAll<HTMLElement>('[data-editor-page-index]'));
    const observer = new IntersectionObserver(
      (records) => {
        let best: { index: number; ratio: number } | undefined;
        for (const record of records) {
          const index = Number((record.target as HTMLElement).dataset.editorPageIndex);
          if (Number.isFinite(index) && (!best || record.intersectionRatio > best.ratio)) {
            best = { index, ratio: record.intersectionRatio };
          }
        }
        if (best && best.ratio > 0) model.setCurrentPageIndex(best.index);
      },
      { root: container, threshold: [0.1, 0.25, 0.5, 0.75] },
    );
    pages.forEach((page) => observer.observe(page));
    return () => observer.disconnect();
  }, [model.loadState, model.pages.length, model.pageWidthPx, model.setCurrentPageIndex]);

  // 装载中 / 失败两态占住整屏（所有 hook 已在上面挂完，不能提前返回）。
  if (model.loadState !== 'ready') {
    return (
      <div
        data-testid="pdf-editor-screen"
        className="flex h-full flex-col items-center justify-center gap-3 bg-ink-950 text-slate-300"
      >
        {model.loadState === 'loading' ? (
          <p data-testid="pdf-editor-loading" className="text-[13px]">
            {t('pdfEditor.loading')}
          </p>
        ) : (
          <>
            <p data-testid="pdf-editor-load-failed" className="max-w-[480px] text-center text-[13px] text-red-300">
              {t('pdfEditor.loadFailed')}
            </p>
            {model.loadError && (
              <p className="max-w-[560px] break-all text-center text-[11px] text-slate-500">{model.loadError}</p>
            )}
            <DeskButton action="pdf-editor-load-failed-back" variant="line" onClick={model.requestClose}>
              {t('pdfEditor.back')}
            </DeskButton>
          </>
        )}
      </div>
    );
  }

  const toolName = model.tool === 'pointer' ? t('pdfEditor.toolPointer') : t('pdfEditor.toolText');

  return (
    <div data-testid="pdf-editor-screen" className="flex h-full min-h-0 flex-col bg-ink-950">
      <EditorHeader model={model} />
      <EditorRibbon model={model} />

      {model.notice && (
        <div className="shrink-0 px-3 pt-2">
          <div
            data-testid="pdf-editor-notice"
            className={`rounded-md border px-3 py-1.5 text-[11px] break-all ${
              model.notice.tone === 'seal'
                ? 'border-red-800/60 bg-red-900/20 text-red-200'
                : model.notice.tone === 'amber'
                  ? 'border-amber-800/60 bg-amber-900/20 text-amber-200'
                  : 'border-emerald-800/60 bg-emerald-900/20 text-emerald-200'
            }`}
          >
            {model.notice.text}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {model.thumbsOpen && <PageThumbRail model={model} onJump={jumpToPage} />}

        <main
          ref={scrollRef}
          data-testid="pdf-editor-scroll"
          className="min-w-0 flex-1 overflow-auto bg-slate-200/90"
        >
          <div className="flex flex-col items-center gap-10 px-3 py-8">
            {model.pages.map((entry, index) => (
              <PdfEditorPageCanvas key={entry.id} model={model} pageIndex={index} />
            ))}
          </div>
        </main>

        {model.propsOpen && <ObjectPropertyCard model={model} />}
      </div>

      {/* 状态条 */}
      <footer
        data-testid="pdf-editor-statusbar"
        className="flex h-7 shrink-0 items-center gap-4 border-t border-line-strong bg-ink-950 px-3 text-[11px] text-slate-400"
      >
        <span data-testid="pdf-editor-page-reading">
          {t('pdfEditor.pageReading', { page: model.currentPageIndex + 1, count: model.pages.length })}
        </span>
        <span>{t('pdfEditor.statusTool', { tool: toolName })}</span>
        <span>{t('pdfEditor.statusObjects', { count: model.objects.length })}</span>
        <span className="ml-auto tabular-nums">{zoomPercent(model.pageWidthPx)}%</span>
      </footer>

      {/* 脏态离开拦截 */}
      {model.guardOpen && (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-black/50">
          <div
            data-testid="pdf-editor-guard"
            className="w-[380px] rounded-lg border border-line-strong bg-ink-900 p-4 shadow-2xl"
          >
            <h4 className="text-[13px] font-semibold text-slate-100">{t('pdfEditor.guardTitle')}</h4>
            <p className="mt-2 text-[12px] leading-relaxed text-slate-400">{t('pdfEditor.guardMessage')}</p>
            <div className="mt-4 flex justify-end gap-2">
              <DeskButton action="pdf-editor-guard-keep" variant="line" onClick={model.cancelGuard}>
                {t('pdfEditor.guardKeep')}
              </DeskButton>
              <DeskButton
                action="pdf-editor-guard-discard"
                variant="seal"
                markers={{ testid: 'pdf-editor-guard-discard' }}
                onClick={model.discardAndClose}
              >
                {t('pdfEditor.guardDiscard')}
              </DeskButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
