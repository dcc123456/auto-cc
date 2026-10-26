import { PanelRightClose } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import type { ResumeLocaleView } from '@auto-cc/shared';
import { ResumePaperFrame } from './ResumePaperFrame';
import { DeskButton, DeskSegmented } from './ui/controls';
import { DeskExplainer } from './ui/disclosure';

/**
 * 纸面槽的两档画面（裁定㊳后的形状）。
 *
 * 这两档不是两个页面，而是**同一张纸的两种看法**：
 * - `preview` 生成轨的产物（`resume.export.preview` 那份打印 HTML）
 * - `pdf` 本机那份真实 PDF 文件的查看画面（只读：挑文件、翻页，没有任何写口）
 *
 * 曾经的第三档 `layout`（编辑器 draft 挂进同一格）随裁定㊲整条搬进整页编辑那一屏——
 * 同一屏不许有两份草稿预览（spec 6.4-14 的④），而类型留着死分支就是第二份事实（§2.4），故收窄。
 */
export type ResumePaperMode = 'preview' | 'pdf';

/**
 * 这一张纸此刻的供料状态（`ResumeDesk` 是唯一判别人，槽位只转述）。
 * - `rendering` 左列刚改过，正在重出这一张（去抖 + 跨进程渲染在途）
 * - `idle` 纸上就是当下最新的那一版
 */
export type PaperStatus = 'idle' | 'rendering';

export interface ResumePaperStageProps {
  /** 槽位此刻是哪一档。 */
  mode: ResumePaperMode;
  /**
   * 换档。**父级是唯一判门的人**：按不动该说什么由 desk 决定，
   * 槽位自己不判（§2.5——判据在两处长出来就会漂）。
   */
  onModeChange: (mode: ResumePaperMode) => void;
  /**
   * 纸上的内容：**槽里唯一一张画面**由父级供给——`preview` 档给落库版（这一格不再有 draft 分支）。
   * undefined = 这一份还没渲过（画空态，不画上一份的残留）。
   */
  paperHtml?: string;
  /** 上一条供料的在途态（纸角那条读数条的唯一依据）。 */
  paperStatus: PaperStatus;
  /** 最近一次纸面落定的时刻（毫秒时间戳）；undefined = 这一张还没落过。 */
  paperUpdatedAt?: number;
  /** PDF 档的画面：那一档吃真实文件，画布有自己的缩放，父级**只在这一档**把它传进来（spec 6.4-08）。 */
  pdfView?: ReactNode;
  /** 纸上方那条窄栏的身份读数：这一张是谁的简历（姓名或 id）。 */
  docLabel?: string;
  /** 这一张用的哪套版式（模板展示名，由父级从模板清单里按 id 取）。 */
  templateName?: string;
  /** 纸面语言（`resume-locale` 那颗选择器的当前值，只作读数摆出来，不在这里改）。 */
  locale: ResumeLocaleView;
  /** 上一条动作在途：整组页签按不动的原因码走这一档。 */
  busy?: boolean;
  /**
   * 收起这一栏（2026-10-26 用户点名：预览面板默认收起）。
   * 展开的入口在左列「预览」/「PDF 查看」两颗键；这一颗是人看够了以后回去的那条路。
   */
  onCollapse: () => void;
}

/**
 * 简历屏的纸面槽：一条页签 + 一张按需展开的纸。
 *
 * 形状依据是 2026-10-10 的两条裁定加 2026-10 下旬的裁定㊲/㊳：
 * ① 几种看法共用一格、切换是条件挂载而不是 `hidden` 叠放
 * （隐藏态宽高为 0 会让同名选择器命中看不见的那一份，AGENTS.md §9 的 5.4-b ⑦）；
 * ② 纸住在**右栏**里，装不下时**整张缩放**而不是横向滚（spec 6.4-12）。
 * 2026-10-26 用户点名后，这一栏本身也走条件挂载：desk 只在人按「预览」/「PDF 查看」时才把它挂上，
 * 收起键由这一格自己的页签行给出。
 *
 * "装不下"的判据在 2026-10-14 由 6.4-24 加了第二条：这一格按**宽与一页的高取小**，
 * 所以 A4 一页完整可见、不必在纸里滚（代价是窗口矮时左右留白）。缩放的手术只住在 `ResumePaperFrame` 里，
 * 这一格不重述口径（§2.2），只供画面内容与取证通道名。
 *
 * 导出回执条从前常驻在纸下方——写端搬进整页编辑右轨（裁定㊲）后，回执跟着住在结果旁边，
 * 这一格不再持有第二条"产物落地"的读数（§2.5）。
 * @param props 见 `ResumePaperStageProps`
 * @returns 一栏纸面；被切走的那一档不在 DOM 里
 */
export function ResumePaperStage({
  mode,
  onModeChange,
  paperHtml,
  paperStatus,
  paperUpdatedAt,
  pdfView,
  docLabel,
  templateName,
  locale,
  busy = false,
  onCollapse,
}: ResumePaperStageProps) {
  const { t } = useTranslation();

  /** 两档页签的文案（值即 `data-action` 后缀：`paper-stage-preview` 这种，harness 按它切档）。 */
  const stageOptions = [
    { value: 'preview' as const, label: t('resume.paper.modePreview') },
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
        {/* 收起这一栏的路。与左列「预览」成对：那颗是展开，这颗是收回去——
            没有它，面板一旦展开就只能在两个页签之间切，收不起来。 */}
        <DeskButton
          action="paper-collapse"
          variant="ghost"
          compact
          tip={t('resume.paper.collapse')}
          tipPlacement="bottom"
          tipAlign="end"
          aria-label={t('resume.paper.collapse')}
          onClick={onCollapse}
        >
          <PanelRightClose size={13} />
        </DeskButton>
      </div>

      {/* 实时的那一条读数（spec 6.4-14 的②）：左列一动这张纸就自己重出，人不必去按"预览"，
          但必须看得出它是"正在重出"还是"已经是最新"。倍率不在这里写——它读 `--paper-scale`。 */}
      <p
        data-testid="paper-live"
        data-status={paperStatus}
        className="font-mono text-[11px] text-slate-500"
        data-dirty={paperStatus === 'rendering' ? 'true' : 'false'}
      >
        {paperStatus === 'rendering'
          ? t('resume.paper.liveRendering')
          : t('resume.paper.liveFresh', {
              time: paperUpdatedAt === undefined ? '-' : new Date(paperUpdatedAt).toLocaleTimeString(),
            })}
      </p>

      {/* 纸面本体：只有当前那一档在 DOM 里，且**槽里任何时刻只有一张画布**（spec 6.4-08）。
          从此不会再有"预览 iframe + PDF 画布"两张同屏，导出后画面自己变。 */}
      {mode === 'pdf' ? (
        <div className="min-w-0">{pdfView}</div>
      ) : (
        <ResumePaperFrame
          html={paperHtml}
          frameTestId="resume-preview"
          frameTitle={t('resume.paper.aria')}
          // 这一档是**只读**的那一张：帧里不跑脚本、父页也不读它（sandbox 空串）。
          // 整屏编辑页那一档才放开 `allow-same-origin`，为的是在父页一侧现量段矩形（spec 3.10-01）。
          sandbox=""
          emptyTestId="resume-preview-empty"
          emptyLabel={t('resume.previewEmpty')}
          slotTestId="resume-paper-slot"
          fit="page"
          slotClassName="min-w-0 overflow-hidden p-3"
        />
      )}

      {/* 「装不下就缩小」这件事必须有一句人话，否则人会觉得字突然变小是界面出了毛病。 */}
      <DeskExplainer id="resume.paper.fit" label={t('desk.resume.paperFit')}>
        {t('desk.resume.paperFitBody')}
      </DeskExplainer>
    </section>
  );
}
