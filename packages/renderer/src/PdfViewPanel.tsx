/**
 * 「看一份既有 PDF」的左列控件（spec 3.5-12 查看版的界面化身，裁定㊳）。
 *
 * 形状仍是 2026-10-10 第二次驳回定下来的那条：**控件在左列，纸在右栏**。
 * 画面一律由 `PdfPaperView` 画在纸面槽里，两边吃的是同一份 `usePdfView` 模型（AGENTS.md §2.5）。
 *
 * 2026-10 下旬的裁定㊳把这一格收窄成纯查看：覆盖层清单、页序重排、另存落点那三条写端整块摘除——
 * 改字与出纸归整页编辑那一屏。这里只剩挑文件、开路径、翻页与那几句读数。
 *
 * 旧的可取证通道里，查看那几条（`pdf-edit-path` / `pdf-edit-pick-file` / `pdf-edit-open` /
 * `pdf-edit-page-prev` / `pdf-edit-page-reading` / `pdf-edit-page-next` 等）
 * 名字原样保留（`6.2-06-pdf-edit-readings.txt`、`6.4-08-paper-stage-readings.txt` 是既有读数）；
 * 编辑那几条随功能一起退场，不留死锚点（§2.4）。
 *
 * @param model 这一轨的唯一模型
 */
import { Eye, FolderOpen, PenLine, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Banner, DeskButton, DeskField, deskReason } from './ui/controls';
import type { PdfViewModel } from './usePdfView';

/**
 * PDF 查看这一档的左列控件。
 * @param model `usePdfView` 的那一份唯一状态与动作
 * @param onOpenEditor 「在编辑器中打开」：切到 WPS 形态纸面编辑器（2026-10-14 反转裁定后的新整页编辑）
 */
export function PdfViewPanel({ model, onOpenEditor }: { model: PdfViewModel; onOpenEditor: () => void }) {
  const { t } = useTranslation();
  const { receipt, page, busy, notice, noticeTone, openError } = model;

  /**
   * 「按不动」必须带上原因码（07 稿④）。`busy` 排在每一条链首：在途时任何一颗都轮不到人按，
   * 这一档优先于该键自己的前置条件，和界面给出的转针读数一致。
   * 三件套的实现在 `deskReason`（墨案控件原件）——本面板与纸面视图共用那一份，不各写一遍（§2.2）。
   */
  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;
  const { label: reasonLabel, reason: afterBusy, dead } = deskReason(t, 'pdfEdit', busyReason);
  const openReason = afterBusy(model.filePath.trim() === '', 'PATH_EMPTY');

  return (
    <section data-testid="pdf-edit-panel" className="rounded-xl border border-line bg-ink-900/60 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Eye size={16} />
          {t('pdfEdit.heading')}
        </h3>
        <DeskButton
          action="pdf-edit-close"
          variant="ghost"
          compact
          busy={!!busy}
          disabled={busyReason !== undefined}
          disabledReason={busyReason}
          disabledReasonLabel={reasonLabel(busyReason)}
          onClick={model.onClose}
        >
          <X size={12} />
          {t('pdfEdit.close')}
        </DeskButton>
      </div>

      <p className="mt-1 text-[11px] text-slate-500" data-testid="pdf-edit-path-hint">
        {t('pdfEdit.pathHint')}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {/* 主入口是系统选文件面板（选完即开）；手敲路径只是备选，所以按钮排在输入框前面且用主色。 */}
        <DeskButton
          action="pdf-edit-pick-file"
          variant="jade"
          compact
          busy={!!busy}
          disabled={!!busy}
          disabledReason={busyReason}
          disabledReasonLabel={reasonLabel(busyReason)}
          onClick={model.pickSourceFile}
        >
          <FolderOpen size={12} />
          {t('pdfEdit.pickFile')}
        </DeskButton>
        <DeskField
          action="pdf-edit-path"
          data-testid="pdf-edit-path"
          value={model.filePath}
          onValueChange={model.setFilePath}
          placeholder={t('pdfEdit.pathPlaceholder')}
          className="min-w-[200px] flex-1"
        />
        <DeskButton
          action="pdf-edit-open"
          variant="line"
          compact
          busy={!!busy}
          disabled={openReason !== undefined}
          disabledReason={openReason}
          disabledReasonLabel={reasonLabel(openReason)}
          onClick={model.openPdf}
        >
          <Eye size={12} />
          {t('pdfEdit.open')}
        </DeskButton>
      </div>

      {openError && (
        <Banner tone="seal" markers={{ testid: 'pdf-edit-open-error' }} className="mt-2 break-all">
          {t('pdfEdit.failed', { code: openError.code, message: openError.message })}
        </Banner>
      )}

      {/* 提示行是全 app 共用 `useBridgeAction.notice` 的那一句，语气按 6.2-18 裁定① 由同一层给出
          （成功青瓷、失败朱红、桥接缺失琥珀），形状只有一只原件。 */}
      {notice && (
        <Banner tone={noticeTone} markers={{ testid: 'pdf-edit-notice' }} className="mt-2 break-all">
          {notice}
        </Banner>
      )}

      {!receipt && (
        <p data-testid="pdf-edit-empty" className="mt-3 text-[11px] text-slate-500">
          {t('pdfEdit.empty')}
        </p>
      )}

      {receipt && (
        <>
          <p className="mt-2 break-all text-[11px] text-slate-400" data-testid="pdf-edit-receipt">
            {t('pdfEdit.sourceHash', { hash: receipt.sourceHash })} ·{' '}
            {t('pdfEdit.pageCount', { count: receipt.pageCount })}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
            <DeskButton
              action="pdf-edit-page-prev"
              variant="line"
              compact
              busy={!!busy}
              {...dead(afterBusy(page <= 1, 'FIRST_PAGE'))}
              onClick={() => void model.showPage(page - 1)}
            >
              {t('pdfEdit.prev')}
            </DeskButton>
            <span data-testid="pdf-edit-page-reading" className="text-slate-300">
              {t('pdfEdit.pageReading', { page, count: receipt.pageCount })}
            </span>
            <DeskButton
              action="pdf-edit-page-next"
              variant="line"
              compact
              busy={!!busy}
              {...dead(afterBusy(page >= receipt.pageCount, 'LAST_PAGE'))}
              onClick={() => void model.showPage(page + 1)}
            >
              {t('pdfEdit.next')}
            </DeskButton>
          </div>

          {/* 2026-10-14 反转裁定的入口：查看档 → WPS 形态纸面编辑器（就地改字/加文本/另存）。 */}
          <div className="mt-3 border-t border-line-strong pt-3">
            <DeskButton
              action="pdf-edit-open-editor"
              variant="jade"
              compact
              busy={!!busy}
              disabled={busyReason !== undefined}
              disabledReason={busyReason}
              disabledReasonLabel={reasonLabel(busyReason)}
              onClick={onOpenEditor}
            >
              <PenLine size={12} />
              {t('pdfEdit.openInEditor')}
            </DeskButton>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{t('pdfEdit.openInEditorHint')}</p>
          </div>
        </>
      )}
    </section>
  );
}
