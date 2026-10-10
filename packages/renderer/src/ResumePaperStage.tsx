import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { ExportReceiptView, ResumeLocaleView } from '@auto-cc/shared';
import { DeskButton, DeskSegmented } from './ui/controls';
import { useRevealLabel } from './ui/overlays';

/**
 * 纸面槽的三档画面。
 *
 * 这三档不是三个页面，而是**同一张纸的三种看法**：
 * - `preview` 生成轨的产物（`resume.export.preview` 那份打印 HTML）
 * - `layout` 排版编辑器（区块顺序与排版度量，改的是同一份文档）
 * - `pdf` 编辑轨的 PDF 覆盖层（改的是用户手里那份真实文件）
 */
export type ResumePaperMode = 'preview' | 'layout' | 'pdf';

export interface ResumePaperStageProps {
  /** 槽位此刻是哪一档。 */
  mode: ResumePaperMode;
  /**
   * 换档。**父级是唯一判门的人**：这一档需不需要当前简历、按不动该说什么，都由 desk 决定，
   * 槽位自己不判（§2.5——判据在两处长出来就会漂）。
   */
  onModeChange: (mode: ResumePaperMode) => void;
  /** 预览档的 HTML；undefined 表示这一份还没渲过（画空态，不画上一份的残留）。 */
  previewHtml?: string;
  /** 排版档的画面：父级**只在这一档**把编辑器传进来，于是槽里任何时刻只有一张画布（spec 6.4-08）。 */
  layoutView?: ReactNode;
  /** PDF 档的画面，同上。 */
  pdfView?: ReactNode;
  /** 纸上方那条窄栏的身份读数：这一张是谁的简历（姓名或 id）。 */
  docLabel?: string;
  /** 这一张用的哪套版式（模板展示名，由父级从模板清单里按 id 取）。 */
  templateName?: string;
  /** 纸面语言（`resume-locale` 那颗选择器的当前值，只作读数摆出来，不在这里改）。 */
  locale: ResumeLocaleView;
  /** 上一次导出的回执；undefined 表示这次会话还没导过。 */
  receipt?: ExportReceiptView;
  /** 「在访达中显示」那一段动作（同样是父级的 `run`，槽位不自己开一条桥接通道）。 */
  onReveal: () => void;
  /** 上一条动作在途：整组页签按不动的原因码走这一档。 */
  busy?: boolean;
}

/**
 * 简历屏的纸面槽：一条页签 + 一张常驻的纸 + 纸右下角那条导出回执。
 *
 * 形状依据是 2026-10-09 的裁定③（"同一纸面槽位换装，键位仍由按钮进入"）：改造前预览 iframe、
 * 排版编辑器、PDF 覆盖层三张画面在同一条纵向流里**依序叠着**，面板自己的注释写着"免得两张图
 * 分不清谁是谁"——那是靠注释解释一个形状缺陷。现在三种看法共用一格，切换是条件挂载而不是
 * `hidden` 叠放：隐藏态宽高为 0 会让同名选择器命中看不见的那一份（AGENTS.md §9 的 5.4-b ⑦），
 * 而"槽里同时只有一份画面"本身也才是这条判据要的正腿。
 * @param props 见 `ResumePaperStageProps`
 * @returns 一栏纸面；被切走的那一档不在 DOM 里
 */
export function ResumePaperStage({
  mode,
  onModeChange,
  previewHtml,
  layoutView,
  pdfView,
  docLabel,
  templateName,
  locale,
  receipt,
  onReveal,
  busy = false,
}: ResumePaperStageProps) {
  const { t } = useTranslation();
  // 「在访达中显示」那一句与左下角 toast 的 reveal 键同源（同一句话在两处各拼一遍就是第二份事实，§2.2）。
  const revealLabel = useRevealLabel();

  /** 三档页签的文案（值即 `data-action` 后缀：`paper-stage-preview` 这种，harness 按它切档）。 */
  const stageOptions = [
    { value: 'preview' as const, label: t('resume.paper.modePreview') },
    { value: 'layout' as const, label: t('resume.paper.modeLayout') },
    { value: 'pdf' as const, label: t('resume.paper.modePdf') },
  ];

  return (
    <section
      data-testid="resume-paper"
      data-stage-mode={mode}
      className="flex min-h-0 min-w-0 flex-col gap-2 rounded-sheet border border-line bg-ink-900/60 p-3"
    >
      {/* 页签与身份读数同一条行：页签说"现在看的是哪一种"，右边那两个字说"看的是谁的、用的哪套"。
          身份读数用 11px + `slate-500`（6.1-09 的灰阶档只许活在 ≤11px 里）。 */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <DeskSegmented
          action="paper-stage"
          options={stageOptions}
          value={mode}
          onSelect={onModeChange}
          busy={busy}
          disabledReason={busy ? 'ACTION_BUSY' : undefined}
          disabledReasonLabel={busy ? t('resume.reason.ACTION_BUSY') : undefined}
          markers={{ testid: 'resume-paper-stage' }}
        />
        <p
          className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-slate-500"
          data-testid="resume-paper-who"
        >
          {docLabel ? t('resume.paper.who', { doc: docLabel, template: templateName ?? '-', locale }) : null}
        </p>
      </div>

      {/* 纸面本体：只有当前那一档在 DOM 里。三张画布（iframe / 编辑器 DOM / PDF canvas）
          从此不会再同时存在，导出后画面自己变，人不必去读小字回执才知道发生了什么。 */}
      {mode === 'layout' ? (
        <div className="min-w-0">{layoutView}</div>
      ) : mode === 'pdf' ? (
        <div className="min-w-0">{pdfView}</div>
      ) : (
        <div className="min-w-0 overflow-x-auto">
          {previewHtml === undefined ? (
            <div
              data-testid="resume-preview-empty"
              className="flex h-[460px] w-full items-center justify-center rounded-control border border-dashed border-line bg-ink-850 px-6 text-center text-[11px] leading-relaxed text-slate-500"
            >
              {t('resume.previewEmpty')}
            </div>
          ) : (
            // `w-[210mm]` 是字面量：预览要按 A4 的真实纸宽摆，比容器窄时让这一栏横向滚，
            // 而不是把纸压成 600px——压窄了的行折位置与导出产物就不是同一张纸（3.3-01「预览即导出所见」）。
            <iframe
              data-testid="resume-preview"
              title={t('resume.paper.aria')}
              sandbox=""
              srcDoc={previewHtml}
              className="h-[min(72vh,900px)] min-h-[460px] w-[210mm] shrink-0 rounded-control border border-line bg-white shadow-sheet"
            />
          )}
        </div>
      )}

      {/* 回执条常驻在纸下方（裁定②：导出后画面要当场给反馈）。路径那一格留着既有的
          `resume-receipt-path` 通道名，harness 的旧读数不断。没导过时整条不画，而不是摆一个 0 页。 */}
      {receipt && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-line pt-2">
          <p
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-500"
            data-testid="resume-receipt-path"
            title={receipt.path}
          >
            {receipt.path}
          </p>
          <p className="shrink-0 font-mono text-[11px] text-slate-400" data-testid="resume-receipt-metrics">
            {t('resume.paper.receipt', { pages: receipt.pages, bytes: receipt.bytes })}
          </p>
          <DeskButton action="resume-reveal-pdf" variant="line" compact onClick={onReveal}>
            {revealLabel}
          </DeskButton>
        </div>
      )}
    </section>
  );
}
