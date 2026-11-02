import { ArrowLeft, Eye, Maximize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GenerationRewriteRowView, ResumeDocSummaryView } from '@auto-cc/shared';
import { ResumeFormPanel } from './ResumeFormPanel';
import { DeskButton } from './ui/controls';

/**
 * 一份简历的整屏表单页（spec 9.3-02）：从简历列表点「编辑表单」进入，替换列表而不是弹窗或新系统窗口。
 *
 * 这一层只负责页头与三颗动作；表单本身仍由 `ResumeFormPanel` 持有，草稿、保存与结构操作语义不变。
 * @param doc 正在编辑的那一份简历摘要
 * @param isVariant 是否是按 JD 生成的变体（变体只读，编辑要回母版）
 * @param suggestions 「按岗位改写」留下的建议，透传给表单按格贴出
 * @param onBack 返回简历列表
 * @param onPreview 打开预览弹窗
 * @param onHandoff 交给 Office-cc
 * @param busy 上一条动作是否在途（Office-cc 交接会占这份忙碌态）
 * @param busyReason 在途时的原因码
 * @param busyReasonLabel 原因码的人话
 */
export function ResumeFormPage({
  doc,
  isVariant,
  suggestions,
  onBack,
  onPreview,
  onHandoff,
  busy,
  busyReason,
  busyReasonLabel,
}: {
  readonly doc: ResumeDocSummaryView;
  readonly isVariant: boolean;
  readonly suggestions?: readonly GenerationRewriteRowView[];
  readonly onBack: () => void;
  readonly onPreview: () => void;
  readonly onHandoff: () => void;
  readonly busy: boolean;
  readonly busyReason?: string;
  readonly busyReasonLabel?: string;
}) {
  const { t } = useTranslation();
  const docName = doc.name ?? t('resume.pendingUnnamed');

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="resume-form-page" data-doc-id={doc.id}>
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-ink-950/95 py-2 backdrop-blur">
        <DeskButton action="resume-form-back" variant="ghost" compact onClick={onBack}>
          <ArrowLeft size={13} />
          {t('resume.backToList')}
        </DeskButton>
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-100">
          {t('resume.formPageTitle', { doc: docName })}
        </h3>
        <DeskButton
          action="resume-form-preview"
          variant="line"
          compact
          busy={busy}
          disabled={busy}
          disabledReason={busyReason}
          disabledReasonLabel={busyReasonLabel}
          onClick={onPreview}
        >
          <Eye size={12} />
          {t('resume.preview')}
        </DeskButton>
        <DeskButton
          action="resume-form-office"
          variant="line"
          compact
          busy={busy}
          disabled={busy}
          disabledReason={busyReason}
          disabledReasonLabel={busyReasonLabel}
          onClick={onHandoff}
        >
          <Maximize2 size={12} />
          {t('resume.cardOffice')}
        </DeskButton>
      </header>

      <ResumeFormPanel docId={doc.id} isVariant={isVariant} suggestions={suggestions} />
    </div>
  );
}
