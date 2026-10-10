import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { ExportReceiptView, ResumeLocaleView } from '@auto-cc/shared';
import { DeskButton, DeskSegmented } from './ui/controls';
import { DeskExplainer } from './ui/disclosure';
import { useRevealLabel } from './ui/overlays';

/**
 * 纸面槽的三档画面。
 *
 * 这三档不是三个页面，而是**同一张纸的三种看法**：
 * - `preview` 生成轨的产物（`resume.export.preview` 那份打印 HTML）
 * - `layout` 排版编辑器正在改的那份 draft（同一个 builder，只是还没落库）
 * - `pdf` 编辑轨的 PDF 覆盖层（改的是用户手里那份真实文件）
 */
export type ResumePaperMode = 'preview' | 'layout' | 'pdf';

/** 纸面槽左右内边距的**总**宽度（px）：与下面槽位 class 里的 `p-3`（12×2）是同一个数。 */
const PAPER_SLOT_PADDING_PX = 24;

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
   * 换档。**父级是唯一判门的人**：这一档需不需要当前简历、按不动该说什么，都由 desk 决定，
   * 槽位自己不判（§2.5——判据在两处长出来就会漂）。
   */
  onModeChange: (mode: ResumePaperMode) => void;
  /**
   * 纸上的内容：**槽里唯一一张画面**由父级供给——`preview` 档给落库版、`layout` 档给 draft 版，
   * 两者都画在**同一颗 iframe** 上（`ResumeEditor` 不再自己养第二张预览，spec 6.4-14 的④）。
   * undefined = 这一份还没渲过（画空态，不画上一份的残留）。
   */
  paperHtml?: string;
  /** 上一条供料的在途态（纸角那条读数条的唯一依据）。 */
  paperStatus: PaperStatus;
  /** 最近一次纸面落定的时刻（毫秒时间戳）；undefined = 这一张还没落过。 */
  paperUpdatedAt?: number;
  /** PDF 档的画面：那一档改的是真实文件，画布有自己的缩放，父级**只在这一档**把它传进来（spec 6.4-08）。 */
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
 * 形状依据是 2026-10-10 的两条裁定：① 三种看法共用一格、切换是条件挂载而不是 `hidden` 叠放
 * （隐藏态宽高为 0 会让同名选择器命中看不见的那一份，AGENTS.md §9 的 5.4-b ⑦）；
 * ② 纸住在**右栏**里，装不下时**整张缩放**而不是横向滚（spec 6.4-12）。
 *
 * 缩放只动显示倍率：iframe 仍是 `w-[210mm]`，A4 的物理宽度与折行一字未改，导出产物与这一格无关
 * （3.3-01「预览即导出所见」继续成立——倍率是放大镜，不是第二张纸）。倍率由 `--paper-scale` 给，
 * **只写在这一个节点上**（与 `--kernel-slot-width` 同一口径，plan §3.24 记的那条 §5.2 偏离）：
 * 拖右栏宽度时 `pointermove` 每帧都在改布局，这里若把它写进 React state，整屏每帧重渲一次。
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
  receipt,
  onReveal,
  busy = false,
}: ResumePaperStageProps) {
  const { t } = useTranslation();
  // 「在访达中显示」那一句与左下角 toast 的 reveal 键同源（同一句话在两处各拼一遍就是第二份事实，§2.2）。
  const revealLabel = useRevealLabel();
  /** 纸的那一格：宽度跟着右栏走，倍率写在自己身上。 */
  const slotRef = useRef<HTMLDivElement | null>(null);
  /** 唯一那张纸（iframe）。`offsetWidth` 是它的**布局**宽度，不受 transform 影响，正好拿来当分母。 */
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  /**
   * 量一次槽宽并把显示倍率写成 CSS 变量。
   * 分母取 iframe 自己量出的布局宽度而不是写死的 794：`210mm` 换到多少 px 由浏览器与 DPI 口径决定，
   * 写死等于在界面里存第二份纸宽事实（§2.5）。
   * 分子要扣掉槽位自己的左右内边距（`PAPER_SLOT_PADDING_PX`）——扣了这一格，纸的右缘才会落在槽内，
   * 而 `overflow-hidden` 只是保险，不是"裁纸"的那一道（spec 6.4-12 的③）。
   */
  const fitPaper = useCallback(() => {
    const slot = slotRef.current;
    const frame = frameRef.current;
    if (!slot || !frame) return;
    const naturalWidth = frame.offsetWidth;
    const availWidth = slot.clientWidth - PAPER_SLOT_PADDING_PX;
    if (naturalWidth < 1 || availWidth < 1) return;
    slot.style.setProperty('--paper-scale', String(Math.min(1, availWidth / naturalWidth)));
  }, []);

  /** 三档页签的文案（值即 `data-action` 后缀：`paper-stage-preview` 这种，harness 按它切档）。 */
  const stageOptions = [
    { value: 'preview' as const, label: t('resume.paper.modePreview') },
    { value: 'layout' as const, label: t('resume.paper.modeLayout') },
    { value: 'pdf' as const, label: t('resume.paper.modePdf') },
  ];

  /** 纸此刻在不在槽里（PDF 档换的是画布，不参与缩放）。 */
  const paperMounted = mode !== 'pdf';

  // 内容换了要重量一次：新挂上的 iframe 首帧还没有布局宽度。
  useLayoutEffect(() => {
    fitPaper();
  }, [fitPaper, paperHtml, paperMounted]);

  // 槽位宽度由 ResizeObserver 推：拖右栏把手、缩窗口、展开内核视图都会让这一格重新布局。
  // `mode` 必须在依赖里（与 `KernelViewSlot` 那条同一个理由）：PDF 档不画这一格，
  // 回到预览时节点是新的，effect 不重跑就没有观察器，纸会停在最后一次量到的倍率上。
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const observer = new ResizeObserver(() => fitPaper());
    observer.observe(slot);
    return () => observer.disconnect();
  }, [fitPaper, mode]);

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
          从此不会再有"预览 iframe + 编辑器 + PDF 画布"三张同屏，导出后画面自己变。 */}
      {mode === 'pdf' ? (
        <div className="min-w-0">{pdfView}</div>
      ) : (
        <div
          ref={slotRef}
          data-testid="resume-paper-slot"
          className="h-[min(72vh,900px)] min-h-[460px] min-w-0 overflow-hidden p-3"
        >
          {paperHtml === undefined ? (
            <div
              data-testid={mode === 'layout' ? 'resume-editor-preview-empty' : 'resume-preview-empty'}
              className="flex h-full w-full items-center justify-center rounded-control border border-dashed border-line bg-ink-850 px-6 text-center text-[11px] leading-relaxed text-slate-500"
            >
              {t(mode === 'layout' ? 'resume.editor.previewEmpty' : 'resume.previewEmpty')}
            </div>
          ) : (
            // `w-[210mm]` 是字面量：预览按 A4 的真实纸宽摆，装不下时整张缩小（`--paper-scale`），
            // 而不是压窄纸面、也不是横向滚——压窄了折行就与导出产物不是同一张纸（3.3-01），
            // 滚则等于把人刚要看的那张纸切掉一块（6.4-12 的③）。
            // 倍率是**视觉**缩放，布局盒仍是 794px，所以父级的 `overflow-hidden` 必须有：
            // 它在的是"倍率还没量到的首帧"那一格，而不是裁纸的口子。
            // 高度按倍率反算（`calc(100% / k)`）：缩放之后正好铺满槽位的内容盒，上下各留 `p-3`。
            <iframe
              ref={frameRef}
              data-testid={mode === 'layout' ? 'resume-editor-preview' : 'resume-preview'}
              title={t(mode === 'layout' ? 'resume.editor.heading' : 'resume.paper.aria')}
              sandbox=""
              srcDoc={paperHtml}
              className="h-[calc(100%/(var(--paper-scale)))] w-[210mm] shrink-0 origin-top-left scale-(--paper-scale) rounded-control border border-line bg-white shadow-sheet"
            />
          )}
        </div>
      )}

      {/* 「装不下就缩小」这件事必须有一句人话，否则人会觉得字突然变小是界面出了毛病。 */}
      <DeskExplainer id="resume.paper.fit" label={t('desk.resume.paperFit')}>
        {t('desk.resume.paperFitBody')}
      </DeskExplainer>

      {/* 回执条常驻在纸下方（裁定②：导出后画面要当场给反馈）。路径那一格留着既有
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
