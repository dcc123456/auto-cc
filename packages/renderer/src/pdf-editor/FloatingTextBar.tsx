/**
 * 就地输入框上方那只浮动文字条（仿 WPS）：字号步进、粗体 / 斜体 / 下划线、墨色四选一。
 *
 * 只在输入框打开时出现，改的是 `model.inline` 这笔待提交草稿；提交时才连同文字一起进会话。
 * 「自动」墨色＝不指定 colorHex，由引擎按量到的纸色自己定墨（就地改字的默认口径）。
 * 粗/斜对中文不兑现（随包只有一只 Noto Sans SC），按钮不藏，但 title 如实说明。
 *
 * 控件只许出自 `src/ui/**`（6.2-14）：样式切换格也是 DeskButton，选中态走 solid 档。
 */
import { Bold, Italic, Minus, Plus, Underline } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DeskButton } from '../ui/controls';
import type { PdfEditorModel } from './usePdfEditor';

/** 字号步进的档位（pt）。 */
const SIZE_STEP_PT = 0.5;
const SIZE_MIN_PT = 6;
const SIZE_MAX_PT = 36;

/** 墨色预设：undefined＝自动（按纸色派生），其余三色是最常用的墨/朱/青。 */
const INK_PRESETS: readonly { hex: string | undefined; label: string; swatch: string }[] = [
  { hex: undefined, label: 'pdfEditor.inkAuto', swatch: 'linear-gradient(135deg,#1f2937 50%,#ffffff 50%)' },
  { hex: '#1f2937', label: 'pdfEditor.inkDark', swatch: '#1f2937' },
  { hex: '#dc2626', label: 'pdfEditor.inkRed', swatch: '#dc2626' },
  { hex: '#2563eb', label: 'pdfEditor.inkBlue', swatch: '#2563eb' },
];

/** 32×24 的方形小格（compact 按钮再压一档内边距）。 */
const CELL_CLASS = 'h-6 min-w-6 w-6 justify-center px-0';

export function FloatingTextBar({ model }: { model: PdfEditorModel }) {
  const { t } = useTranslation();
  const inline = model.inline;
  if (!inline) return null;

  return (
    <div
      data-testid="pdf-editor-floating-bar"
      className="absolute bottom-full left-0 z-50 mb-1 flex items-center gap-1 rounded-md border border-line-strong bg-ink-900/95 p-1 shadow-lg"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <DeskButton
        action="pdf-editor-inline-size-down"
        variant="ghost"
        compact
        className={CELL_CLASS}
        title={t('pdfEditor.sizeDown')}
        onClick={() =>
          model.patchInline({
            fontSizePt: Math.max(SIZE_MIN_PT, Math.round((inline.fontSizePt - SIZE_STEP_PT) * 10) / 10),
          })
        }
      >
        <Minus size={12} />
      </DeskButton>
      <span className="min-w-[38px] text-center text-[11px] tabular-nums text-slate-200">
        {Number(inline.fontSizePt.toFixed(1))}
      </span>
      <DeskButton
        action="pdf-editor-inline-size-up"
        variant="ghost"
        compact
        className={CELL_CLASS}
        title={t('pdfEditor.sizeUp')}
        onClick={() =>
          model.patchInline({
            fontSizePt: Math.min(SIZE_MAX_PT, Math.round((inline.fontSizePt + SIZE_STEP_PT) * 10) / 10),
          })
        }
      >
        <Plus size={12} />
      </DeskButton>
      <span className="mx-0.5 h-4 w-px bg-line-strong" />
      <DeskButton
        action="pdf-editor-inline-bold"
        variant={inline.bold ? 'solid' : 'ghost'}
        compact
        className={CELL_CLASS}
        title={t('pdfEditor.boldTitle')}
        markers={{ pressed: inline.bold ? 'true' : 'false' }}
        onClick={() => model.patchInline({ bold: !inline.bold })}
      >
        <Bold size={12} />
      </DeskButton>
      <DeskButton
        action="pdf-editor-inline-italic"
        variant={inline.italic ? 'solid' : 'ghost'}
        compact
        className={CELL_CLASS}
        title={t('pdfEditor.italicTitle')}
        markers={{ pressed: inline.italic ? 'true' : 'false' }}
        onClick={() => model.patchInline({ italic: !inline.italic })}
      >
        <Italic size={12} />
      </DeskButton>
      <DeskButton
        action="pdf-editor-inline-underline"
        variant={inline.underline ? 'solid' : 'ghost'}
        compact
        className={CELL_CLASS}
        title={t('pdfEditor.underlineTitle')}
        markers={{ pressed: inline.underline ? 'true' : 'false' }}
        onClick={() => model.patchInline({ underline: !inline.underline })}
      >
        <Underline size={12} />
      </DeskButton>
      <span className="mx-0.5 h-4 w-px bg-line-strong" />
      {INK_PRESETS.map((preset) => (
        // 色值挂在外层 span 的变量上（CSS 变量向后代继承），按钮的 class 只引用变量（AGENTS.md §5.1）。
        <span
          key={preset.hex ?? 'auto'}
          className="inline-flex"
          ref={(node) => node?.style.setProperty('--re-swatch', preset.swatch)}
        >
          <DeskButton
            action={`pdf-editor-inline-ink-${preset.hex === undefined ? 'auto' : preset.hex.replace('#', '')}`}
            variant="ghost"
            compact
            title={t(preset.label)}
            markers={{ pressed: inline.colorHex === preset.hex ? 'true' : 'false' }}
            className={`h-5 w-5 min-w-5 justify-center rounded-full px-0 [background:var(--re-swatch)] ${
              inline.colorHex === preset.hex ? 'border-blue-400 ring-2 ring-blue-400/40' : 'border-line-strong'
            }`}
            onClick={() => model.patchInline({ colorHex: preset.hex })}
          >
            <span className="sr-only">{t(preset.label)}</span>
          </DeskButton>
        </span>
      ))}
    </div>
  );
}
