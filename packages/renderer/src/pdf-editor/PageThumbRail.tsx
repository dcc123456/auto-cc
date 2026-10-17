/**
 * 左轨页面缩略图（E2：点击跳页 + 当前页高亮）。
 *
 * 缩略图也是 pdf.js 真位图（与大纸同源 `PdfPaperPage.paint`，只是 CSS 宽度取 120px），
 * 用 IntersectionObserver 懒画——整本连续滚动时不一次性渲染几十页。
 * E3 在这同一列上加拖拽排序、旋转/复制/删除/插空白页的浮层菜单（页计划改 model.setPages）。
 * 缩略格是 DeskButton（6.2-14），画面与读数包在它唯一的子节点里随列排布。
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { PdfEditorPageInput } from '@auto-cc/plugin-pdf-edit/object-model';
import { DeskButton } from '../ui/controls';
import type { PdfEditorModel } from './usePdfEditor';

/** 缩略图 CSS 宽（px）；高度由页面宽高比自然撑开。 */
const THUMB_WIDTH_PX = 120;

export function PageThumbRail({ model, onJump }: { model: PdfEditorModel; onJump: (pageIndex: number) => void }) {
  const { t } = useTranslation();
  return (
    <aside
      data-testid="pdf-editor-thumb-rail"
      className="flex w-[156px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-line-strong bg-ink-950/70 p-2"
    >
      <p className="px-1 text-[11px] font-semibold text-slate-400">{t('pdfEditor.pages')}</p>
      {model.pages.map((entry, index) => (
        <Thumb
          key={entry.id}
          model={model}
          entry={entry}
          index={index}
          active={index === model.currentPageIndex}
          onJump={onJump}
        />
      ))}
    </aside>
  );
}

function Thumb({
  model,
  entry,
  index,
  active,
  onJump,
}: {
  model: PdfEditorModel;
  entry: PdfEditorPageInput;
  index: number;
  active: boolean;
  onJump: (pageIndex: number) => void;
}) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paper = model.paperOf(entry.id);
  const widthPt = paper?.widthPt ?? 595.28;
  const heightPt = paper?.heightPt ?? 841.89;

  // 进视口再解析文本层（IO 观察缩略图自己，rootMargin 提前两屏备货）。
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) {
          model.ensurePaper(entry);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [entry, model]);

  // 纸面句柄就绪即画缩略位图。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !paper) return;
    void paper.paint(canvas, THUMB_WIDTH_PX);
  }, [paper]);

  return (
    // 外层 span 只是 IntersectionObserver 的观察靶（DeskButton 不收 ref）；宽高比变量也挂在这一层。
    <span ref={wrapRef} className="block">
      <DeskButton
        action={`pdf-editor-thumb-${index}`}
        variant="ghost"
        markers={{ testid: `pdf-editor-thumb-${index}`, on: active ? 'true' : 'false' }}
        className={`w-full justify-start rounded-md p-1 ${active ? 'border-blue-500 bg-blue-600/15 text-blue-300' : 'text-slate-400'}`}
        onClick={() => onJump(index)}
      >
        <span className="block w-full">
          <span
            className="relative block w-full overflow-hidden rounded-sm bg-white shadow-sm aspect-(--thumb-ar)"
            ref={(node) => {
              node?.style.setProperty('--thumb-ar', `${widthPt} / ${heightPt}`);
            }}
          >
            {entry.kind === 'source' ? (
              <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
            ) : (
              <span className="grid h-full place-items-center text-[9px] text-slate-300">
                {t('pdfEditor.blankPage')}
              </span>
            )}
          </span>
          <span className={`mt-1 block text-center text-[10px] ${active ? 'text-blue-300' : 'text-slate-400'}`}>
            {t('pdfEditor.pageOf', { index: index + 1 })}
          </span>
        </span>
      </DeskButton>
    </span>
  );
}
