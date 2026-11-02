import { ArrowLeft, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GenerationRunRowView, ResumeDocSummaryView } from '@auto-cc/shared';
import { GeneratePanel } from './GeneratePanel';
import { DeskButton } from './ui/controls';

/**
 * 按岗位生成简历的整屏子页面（spec 9.3-02）：岗位页的「用这份 JD 生成简历」与简历列表的「按 JD 生成」
 * 都落到这里。生成逻辑、候选清单与接受写口仍全在 `GeneratePanel`，这一层只加页头与返回。
 * @param docs 可被定制的母版（变体不能再往下派生）
 * @param docId 当前目标母版；空串表示库里还没有简历
 * @param onDocIdChange 换目标母版
 * @param refreshDocs 接受写完后请父级重读清单
 * @param onAccepted 一次接受写完变体后的通知
 * @param onPreview 把提议态转述给父级（表单页按格贴建议）
 * @param onBack 返回简历列表
 */
export function ResumeGeneratePage({
  docs,
  docId,
  onDocIdChange,
  refreshDocs,
  onAccepted,
  onPreview,
  onBack,
}: {
  readonly docs: readonly ResumeDocSummaryView[];
  readonly docId: string;
  readonly onDocIdChange: (docId: string) => void;
  readonly refreshDocs: () => Promise<void>;
  readonly onAccepted: (writtenDocId: string) => void;
  readonly onPreview: (preview: GenerationRunRowView | undefined) => void;
  readonly onBack: () => void;
}) {
  const { t } = useTranslation();
  const targetName =
    docs.find((doc) => doc.id === docId)?.name ??
    (docs.length === 0 ? t('resume.empty') : t('resume.generatePageTarget'));

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="resume-generate-page">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-ink-950/95 py-2 backdrop-blur">
        <DeskButton action="resume-generate-back" variant="ghost" compact onClick={onBack}>
          <ArrowLeft size={13} />
          {t('resume.backToList')}
        </DeskButton>
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-100">
          <span className="mr-1 inline-flex align-middle text-slate-400">
            <Sparkles size={13} aria-hidden />
          </span>
          {t('resume.generatePageTitle', { target: targetName })}
        </h3>
      </header>

      <GeneratePanel
        docs={docs}
        docId={docId}
        onDocIdChange={onDocIdChange}
        refreshDocs={refreshDocs}
        onAccepted={onAccepted}
        onPreview={onPreview}
      />
    </div>
  );
}
