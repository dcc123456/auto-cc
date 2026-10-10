/**
 * 「在既有 PDF 上改」的左列控件（spec 3.5-01 / 02 / 03 / 07 / 09 的界面化身，3.5-12 换向后的那一半）。
 *
 * 形状是 2026-10-10 的第二次驳回定下来的：**控件在左列，纸在右栏**。
 * 原先这一格把画布与全部控件揉在一起（909 行的那只面板），于是「纸」既不在人眼前也不在自己的文档上，
 * 而报障里那句「不知如何下手」就是这么来的。现在这里只有清单与尺度，画面一律由 `PdfPaperView` 画在纸面槽里，
 * 两边吃的是同一份 `usePdfEdit` 模型（AGENTS.md §2.5：不许有第二份 draft）。
 *
 * 旧的可取证通道一条没断：`data-action` / `data-testid` 的名字原样保留
 * （`6.2-06-pdf-edit-readings.txt`、`6.4-08-paper-stage-readings.txt` 是既有读数）。
 *
 * @param model 这一轨的唯一模型
 */
import { ArrowDown, ArrowUp, Copy, FolderOpen, Pencil, Redo2, Save, Trash2, Undo2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Banner, DeskButton, DeskField, deskReason } from './ui/controls';
import { DeskExplainer } from './ui/disclosure';
import type { PdfEditModel } from './usePdfEdit';

/**
 * 比例坐标 → 读数用的人话百分比（界面只展示，不用它反算任何东西）。
 * @param ratio 0..1 的比例
 */
function percentOf(ratio: number): string {
  return (Math.round(ratio * 1000) / 10).toFixed(1);
}

/**
 * 把产物页序里的第 `from` 位与第 `to` 位换过来。
 * @param order 当前页序（产物逐页的来源页号）
 * @param from 起手下标
 * @param to 目标下标；越界时原样返回，会话会把原样那份判成「空编辑」
 */
function swapOrder(order: readonly number[], from: number, to: number): number[] {
  const next = [...order];
  const moved = next[from];
  const target = next[to];
  if (moved === undefined || target === undefined) return next;
  next[from] = target;
  next[to] = moved;
  return next;
}

/**
 * PDF 覆盖这一档的左列控件。
 * @param model `usePdfEdit` 的那一份唯一状态与动作
 */
export function PdfEditPanel({ model }: { model: PdfEditModel }) {
  const { t } = useTranslation();
  const { receipt, draft, page, limits, busy, notice, noticeTone, outPath, saved, saveError, openError } = model;

  /**
   * 「按不动」必须带上原因码（07 稿④）。`busy` 排在每一条链首：在途时任何一颗都轮不到人按，
   * 这一档优先于该键自己的前置条件，和界面给出的转针读数一致。
   * 三件套的实现在 `deskReason`（墨案控件原件）——本面板与排版编辑器共用那一份，不各写一遍（§2.2）。
   */
  const busyReason = busy !== undefined ? 'ACTION_BUSY' : undefined;
  const { label: reasonLabel, reason: afterBusy, dead } = deskReason(t, 'pdfEdit', busyReason);
  const openReason = afterBusy(model.filePath.trim() === '', 'PATH_EMPTY');
  /** 另存的理由链三档：在途 → 尺度没读到（会话根本建不起来）→ 产物路径为空。顺序即优先级。 */
  const saveAsReason =
    busyReason ?? (!limits ? 'LIMITS_PENDING' : undefined) ?? (outPath.trim() === '' ? 'OUT_PATH_EMPTY' : undefined);
  /** 是否已到产物页数上限——尺度还没读到时按「到顶」处理，此时另存/复制都无意义（会话根本建不起来）。 */
  const isAtPageCap = model.isAtPageCap;
  /** 当下这一页的行数（就地改的入口有没有长出来，就看这个数）。 */
  const lineCount = model.paperPage?.lines.length ?? 0;

  return (
    <section data-testid="pdf-edit-panel" className="rounded-xl border border-line bg-ink-900/60 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Pencil size={16} />
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
        <DeskField
          action="pdf-edit-path"
          data-testid="pdf-edit-path"
          value={model.filePath}
          onValueChange={model.setFilePath}
          placeholder={t('pdfEdit.pathPlaceholder')}
          className="min-w-[200px] flex-1"
        />
        <DeskButton
          action="pdf-edit-pick-file"
          variant="line"
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
          <Pencil size={12} />
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
          {!limits && (
            <p className="mt-1 text-[11px] text-celadon" data-testid="pdf-edit-limits-pending">
              {t('pdfEdit.limitsPending')}
            </p>
          )}

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
              {t('pdfEdit.pageReading', { page, count: receipt.pageCount, lines: lineCount })}
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
            {/* 撤销 / 重做是本地同步动作，不挂 busy：它们在桥调用在途时照样按得动（原样保留，
                唯一变化是「没步可退」现在说得出原因）。 */}
            <DeskButton
              action="pdf-edit-undo"
              variant="ghost"
              compact
              {...dead(model.canUndo ? undefined : 'NOTHING_TO_UNDO')}
              onClick={() => model.stepHistory('undo')}
            >
              <Undo2 size={12} />
              {t('pdfEdit.undo')}
            </DeskButton>
            <DeskButton
              action="pdf-edit-redo"
              variant="ghost"
              compact
              {...dead(model.canRedo ? undefined : 'NOTHING_TO_REDO')}
              onClick={() => model.stepHistory('redo')}
            >
              <Redo2 size={12} />
              {t('pdfEdit.redo')}
            </DeskButton>
          </div>

          <div className="mt-3">
            <h4 className="text-[11px] font-semibold text-slate-300">{t('pdfEdit.overlays')}</h4>
            {draft.overlays.length === 0 ? (
              <p className="mt-1 text-[11px] text-slate-500" data-testid="pdf-edit-overlays-empty">
                {t('pdfEdit.overlaysEmpty')}
              </p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {draft.overlays.map((overlay) => (
                  <li
                    key={overlay.id}
                    data-testid={`pdfEdit-overlay-${overlay.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line bg-ink-950/70 px-2 py-1 text-[11px] text-slate-300"
                  >
                    <span className="break-all">
                      {t('pdfEdit.overlayRow', {
                        page: overlay.pageNumber,
                        x: percentOf(overlay.rect.xRatio),
                        y: percentOf(overlay.rect.yRatio),
                        w: percentOf(overlay.rect.widthRatio),
                        h: percentOf(overlay.rect.heightRatio),
                        text: overlay.text ?? t('pdfEdit.overlayBlank'),
                      })}
                    </span>
                    <DeskButton
                      action={`pdf-edit-remove-overlay-${overlay.id}`}
                      variant="ghost"
                      compact
                      busy={!!busy}
                      {...dead(busyReason)}
                      onClick={() => model.removeOverlay(overlay.id)}
                    >
                      <Trash2 size={11} />
                      {t('pdfEdit.removeOverlay')}
                    </DeskButton>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-3 flex flex-col gap-1">
            <label className="text-[11px] text-slate-400" htmlFor="pdf-edit-out-path">
              {t('pdfEdit.outPathLabel')}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <DeskField
                action="pdf-edit-out-path"
                id="pdf-edit-out-path"
                data-testid="pdf-edit-out-path"
                value={outPath}
                onValueChange={model.setOutPath}
                placeholder={t('pdfEdit.outPathPlaceholder')}
                className="min-w-[180px] flex-1"
              />
              <DeskButton
                action="pdf-edit-pick-save-path"
                variant="line"
                compact
                busy={!!busy}
                disabled={!!busy}
                disabledReason={busyReason}
                disabledReasonLabel={reasonLabel(busyReason)}
                onClick={model.pickSavePath}
              >
                <Save size={12} />
                {t('pdfEdit.pickSavePath')}
              </DeskButton>
              <DeskButton
                action="pdf-edit-save-as"
                variant="amber"
                compact
                busy={!!busy}
                {...dead(saveAsReason)}
                onClick={model.saveAs}
              >
                <Save size={12} />
                {t('pdfEdit.saveAs')}
              </DeskButton>
            </div>
            <p className="text-[11px] text-slate-500">{t('pdfEdit.outPathHint')}</p>
          </div>

          {/* 两条被降级的腿（plan 片 58 步骤 3）：旧流程「先在输入框里写好字、再到空白画布上拖橡皮筋」
              与页序调整。键名与 `data-action` 值原样保留，取证通道不断；变的只是它们住在披露层里。 */}
          <DeskExplainer id="pdfEdit.advanced" label={t('pdfEdit.advanced')}>
            <div className="flex flex-col gap-3">
              <label className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                {t('pdfEdit.overlayText')}
                <DeskField
                  action="pdf-edit-overlay-text"
                  data-testid="pdf-edit-overlay-text"
                  value={model.overlayText}
                  onValueChange={model.setOverlayText}
                  className="w-[180px]"
                />
                <span className="text-slate-500">{t('pdfEdit.dragHint')}</span>
              </label>

              <div>
                <h4 className="text-[11px] font-semibold text-slate-300">{t('pdfEdit.pageOrder')}</h4>
                <p className="mt-1 text-[11px] text-slate-500">{t('pdfEdit.pageOrderHint')}</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {draft.pageOrder.map((sourcePage, index) => (
                    <li
                      key={`${index}-${sourcePage}`}
                      data-testid={`pdfEdit-page-row-${index}`}
                      // 窄列里让图标簇换到第二排：这一行的页码文案是**数据**（产物第几页对源第几页），
                      // 裁掉就等于把判定依据藏起来，比多出一排高更糟。
                      className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line bg-ink-950/70 px-2 py-1 text-[11px] text-slate-300"
                    >
                      <DeskButton
                        action={`pdf-edit-view-page-${sourcePage}`}
                        variant="line"
                        compact
                        busy={!!busy}
                        className="justify-start"
                        {...dead(busyReason)}
                        onClick={() => void model.showPage(sourcePage)}
                      >
                        {t('pdfEdit.pageRow', { out: index + 1, source: sourcePage })}
                      </DeskButton>
                      <span className="flex items-center gap-1">
                        {/* 四只图标键没有文字，compact 的字号撑不出行高（活体读数 17px），显式对齐到同行那档 24px。 */}
                        <DeskButton
                          action={`pdf-edit-move-up-${index}`}
                          variant="solid"
                          compact
                          className="h-6"
                          busy={!!busy}
                          aria-label={t('pdfEdit.moveUp')}
                          {...dead(afterBusy(index === 0, 'FIRST_ROW'))}
                          onClick={() => model.setPageOrder(swapOrder(draft.pageOrder, index, index - 1))}
                        >
                          <ArrowUp size={11} />
                        </DeskButton>
                        <DeskButton
                          action={`pdf-edit-move-down-${index}`}
                          variant="solid"
                          compact
                          className="h-6"
                          busy={!!busy}
                          aria-label={t('pdfEdit.moveDown')}
                          {...dead(afterBusy(index === draft.pageOrder.length - 1, 'LAST_ROW'))}
                          onClick={() => model.setPageOrder(swapOrder(draft.pageOrder, index, index + 1))}
                        >
                          <ArrowDown size={11} />
                        </DeskButton>
                        <DeskButton
                          action={`pdf-edit-duplicate-${index}`}
                          variant="solid"
                          compact
                          className="h-6"
                          busy={!!busy}
                          aria-label={t('pdfEdit.duplicatePage')}
                          {...dead(afterBusy(isAtPageCap, 'AT_PAGE_CAP'))}
                          onClick={() =>
                            model.setPageOrder(
                              draft.pageOrder.flatMap((candidate, position) =>
                                position === index ? [candidate, candidate] : [candidate],
                              ),
                            )
                          }
                        >
                          <Copy size={11} />
                        </DeskButton>
                        <DeskButton
                          action={`pdf-edit-remove-page-${index}`}
                          variant="ghost"
                          compact
                          className="h-6"
                          busy={!!busy}
                          aria-label={t('pdfEdit.removePage')}
                          {...dead(afterBusy(draft.pageOrder.length <= 1, 'LAST_PAGE_REMAINING'))}
                          onClick={() =>
                            model.setPageOrder(draft.pageOrder.filter((_, position) => position !== index))
                          }
                        >
                          <Trash2 size={11} />
                        </DeskButton>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </DeskExplainer>

          {saveError && (
            <Banner tone="seal" markers={{ testid: 'pdf-edit-save-error' }} className="mt-2 break-all">
              {t('pdfEdit.failed', { code: saveError.code, message: saveError.message })}
            </Banner>
          )}

          {saved && (
            <Banner tone="jade" markers={{ testid: 'pdf-edit-saved' }} className="mt-2 break-all">
              {t('pdfEdit.saved', { path: saved.outPath, count: saved.pageCount, hash: saved.sha256.slice(0, 12) })}
            </Banner>
          )}
        </>
      )}
    </section>
  );
}
