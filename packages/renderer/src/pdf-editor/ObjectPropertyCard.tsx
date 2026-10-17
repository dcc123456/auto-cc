/**
 * 右轨属性卡（E2：选中对象的读数与删除）。
 *
 * 读数全是**比例坐标**（与写出同一口径），pt 尺寸要等 E3 拿到页面旋转后的显示面宽高再补。
 * 就地改字对象在卡底固定挂一句诚实提示：盖写不等于删除原文（spec 3.5-04 的反伪装底线）。
 */
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DeskButton } from '../ui/controls';
import type { PdfEditorModel } from './usePdfEditor';

const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5 text-[11px]">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className="truncate tabular-nums text-slate-300" title={value}>
        {value}
      </span>
    </div>
  );
}

export function ObjectPropertyCard({ model }: { model: PdfEditorModel }) {
  const { t } = useTranslation();
  const object = model.selectedObject;
  const pageIndex = object ? model.pages.findIndex((page) => page.id === object.pageId) : -1;

  return (
    <aside
      data-testid="pdf-editor-property-card"
      className="flex w-[248px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-line-strong bg-ink-950/70 p-3"
    >
      <h3 className="text-[12px] font-semibold text-slate-300">{t('pdfEditor.props')}</h3>

      {!object && (
        <div className="rounded-md border border-dashed border-line-strong p-3 text-[11px] leading-relaxed text-slate-500">
          <p>{t('pdfEditor.propsEmpty')}</p>
        </div>
      )}

      {object && (
        <>
          <div className="rounded-md border border-line-strong bg-ink-900 p-2">
            <p className="mb-1 text-[12px] font-medium text-slate-200">
              {object.kind === 'text'
                ? object.backdropHex !== undefined
                  ? t('pdfEditor.kindTextInPlace')
                  : t('pdfEditor.kindTextBox')
                : t(`pdfEditor.kind_${object.kind}`)}
            </p>
            <Row label={t('pdfEditor.propPage')} value={t('pdfEditor.pageOf', { index: pageIndex + 1 })} />
            <Row label={t('pdfEditor.propX')} value={pct(object.rect.xRatio)} />
            <Row label={t('pdfEditor.propY')} value={pct(object.rect.yRatio)} />
            <Row label={t('pdfEditor.propW')} value={pct(object.rect.widthRatio)} />
            <Row label={t('pdfEditor.propH')} value={pct(object.rect.heightRatio)} />
            {object.kind === 'text' && (
              <>
                <Row label={t('pdfEditor.propSize')} value={`${object.sizePt ?? 11} pt`} />
                {object.backdropHex !== undefined && (
                  <Row label={t('pdfEditor.propBackdrop')} value={object.backdropHex} />
                )}
              </>
            )}
          </div>

          {object.kind === 'text' && (
            <div className="rounded-md border border-line-strong bg-ink-900 p-2">
              <p className="mb-1 text-[11px] text-slate-500">{t('pdfEditor.propContent')}</p>
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-all text-[11px] leading-relaxed text-slate-300">
                {object.text || '—'}
              </p>
            </div>
          )}

          {object.kind === 'text' && object.backdropHex !== undefined && (
            <p className="rounded-md bg-amber-900/20 p-2 text-[10px] leading-relaxed text-amber-200/90">
              {t('pdfEditor.coverNotDelete')}
            </p>
          )}

          <DeskButton
            action="pdf-editor-delete-object"
            variant="seal"
            compact
            markers={{ testid: 'pdf-editor-delete-object' }}
            className="h-8 justify-center"
            onClick={() => model.removeObject(object.id)}
          >
            <Trash2 size={13} />
            {t('pdfEditor.deleteObject')}
          </DeskButton>
        </>
      )}
    </aside>
  );
}
