import { Maximize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ResumeLocaleView } from '@auto-cc/shared';
import { ResumePaperFrame } from './ResumePaperFrame';
import { Banner, DeskButton, DeskSelect } from './ui/controls';
import { Modal } from './ui/overlays';

/**
 * 简历预览弹窗（spec 9.3-04）：纸面只吃 `resume.export.preview` 的打印 HTML，与导出同一份源。
 *
 * 这一层不发起任何跨进程调用；加载、失败与出纸语言都由 `ResumeDesk` 持有并递进来。
 * 唯一的写动作是页脚的「在 Office-cc 中编辑」，它仍走父级的 toPdf → openInCompanionEditor 两步。
 * @param open 弹窗是否展开
 * @param docLabel 这一份是谁（姓名；读不到时由父级给占位文案）
 * @param html 打印 HTML；undefined = 这一趟还没回来
 * @param loading 是否正在排版
 * @param error 排版失败的原因（有值时不再画上一份残留）
 * @param locale 出纸语言
 * @param onLocaleChange 换语言后父级会重新要一趟预览
 * @param onClose 关闭弹窗
 * @param onHandoff 交给 Office-cc
 * @param busy Office-cc 交接是否在途
 * @param busyReason 在途原因码
 * @param busyReasonLabel 原因码的人话
 */
export function ResumePreviewModal({
  open,
  docLabel,
  html,
  loading,
  error,
  locale,
  onLocaleChange,
  onClose,
  onHandoff,
  busy,
  busyReason,
  busyReasonLabel,
}: {
  readonly open: boolean;
  readonly docLabel?: string;
  readonly html?: string;
  readonly loading: boolean;
  readonly error?: string;
  readonly locale: ResumeLocaleView;
  readonly onLocaleChange: (locale: ResumeLocaleView) => void;
  readonly onClose: () => void;
  readonly onHandoff: () => void;
  readonly busy: boolean;
  readonly busyReason?: string;
  readonly busyReasonLabel?: string;
}) {
  const { t } = useTranslation();
  const title = docLabel ? t('resume.previewTitle', { doc: docLabel }) : t('resume.previewTitleUnnamed');

  return (
    <Modal
      action="resume-preview"
      open={open}
      title={title}
      onClose={onClose}
      width="960"
      dismissOnScrim
      testId="resume-preview-modal"
      closeLabel={t('resume.previewClose')}
      footer={
        <>
          <DeskButton action="resume-preview-close" variant="line" compact onClick={onClose}>
            {t('resume.previewClose')}
          </DeskButton>
          <DeskButton
            action="resume-preview-handoff"
            variant="line"
            compact
            busy={busy}
            disabled={busy || loading || error !== undefined || html === undefined}
            disabledReason={
              busy
                ? busyReason
                : loading
                  ? 'RESUME_PREVIEW_LOADING'
                  : error !== undefined
                    ? 'RESUME_PREVIEW_FAILED'
                    : html === undefined
                      ? 'RESUME_PREVIEW_MISSING'
                      : undefined
            }
            disabledReasonLabel={
              busy
                ? busyReasonLabel
                : loading
                  ? t('resume.reason.RESUME_PREVIEW_LOADING')
                  : error !== undefined
                    ? t('resume.reason.RESUME_PREVIEW_FAILED')
                    : html === undefined
                      ? t('resume.reason.RESUME_PREVIEW_MISSING')
                      : undefined
            }
            onClick={onHandoff}
          >
            <Maximize2 size={12} />
            {t('resume.previewHandoff')}
          </DeskButton>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1 text-[11px] text-slate-400">
            {t('resume.localeLabel')}
            <DeskSelect
              action="resume-preview-locale"
              data-testid="resume-preview-locale"
              value={locale}
              onValueChange={(value) => onLocaleChange(value as ResumeLocaleView)}
            >
              <option value="zh-CN">zh-CN</option>
              <option value="en">en</option>
            </DeskSelect>
          </label>
          <span className="text-[11px] text-slate-500" data-testid="resume-preview-status">
            {loading ? t('resume.previewLoading') : error ? t('resume.previewFailed') : t('resume.previewReady')}
          </span>
        </div>

        {error ? (
          <Banner tone="seal" markers={{ testid: 'resume-preview-error' }} className="break-all">
            {t('resume.previewError', { message: error })}
          </Banner>
        ) : null}

        <ResumePaperFrame
          html={loading || error !== undefined ? undefined : html}
          frameTestId="resume-preview-frame"
          frameTitle={t('resume.paper.aria')}
          sandbox=""
          emptyTestId="resume-preview-empty"
          emptyLabel={
            loading ? t('resume.previewLoading') : error ? t('resume.previewFailed') : t('resume.previewEmpty')
          }
          fit="width"
          slotTestId="resume-preview-slot"
          slotClassName="min-w-0 overflow-hidden p-3"
        />
      </div>
    </Modal>
  );
}
