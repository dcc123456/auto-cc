/**
 * 对话卡片上一条证据引用的「点开 → 内联展开这段读数」（spec 5.7-02 / plan §7.5.7 决策十一）。
 *
 * 界面只画 `EvidenceRefView` 那个外壳，**不认识引用前缀归谁管**：分派全在主进程那一只手
 * （`agent.run.evidence`）里，这里若自己按前缀决定「调哪个服务」，就等于抄第二份路由表（AGENTS.md §2.5）。
 * 呈现形状刻意与 `NodeEvidenceSection` 一致（首次展开才读、之后复用读到的那份）：同一种「回看」在
 * 两个视图里该长一个样，而那只口的读数本就是一次性的、写完不再变。
 *
 * 两种结局都要显眼（判据是「每一步都能回溯」，不是「每条都能读到正文」）：
 * 读到正文用 `ScrollText`，读不到用 `SearchX` 并把**原因原文**留在屏幕上——
 * 「这类引用压根不落正文」「归属服务此刻没挂载」是主进程写的人读原话，按内容显示、不进语言包
 * （与 `SedimentCard` 的拒因、5.2-c 的观察原文同一口径）。
 */
import { ChevronDown, ChevronRight, ScrollText, SearchX } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EvidenceRefView } from '@auto-cc/shared';
import { formatClock } from './format';
import { useBridgeAction } from './useBridgeAction';
import { DeskButton } from './ui/controls';

/**
 * 一格证据引用。
 * @param runId 这一步所属的 run（来自 `AgentStepView.runId`，不是用户输入）
 * @param planStepIndex 这一步的计划下标（主进程先按它验归属，再读记录）
 * @param evidenceRef 引用原文，与步记录上的 `evidenceRefs` 逐字相同
 */
export function EvidenceRefButton({
  runId,
  planStepIndex,
  evidenceRef,
}: {
  runId: string;
  planStepIndex: number;
  evidenceRef: string;
}) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<EvidenceRefView>();
  /** 回看是一次读数，没有「动作跑完重读快照」这回事；复用外壳只为了忙碌态与失败提示的同一套呈现。 */
  const nothingToReread = useCallback(() => Promise.resolve(), []);
  const { busy, notice, run: read } = useBridgeAction(nothingToReread);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !view) {
      void read(t('chat.evidence.actionRead'), () => bridge?.agent['run.evidence'](runId, planStepIndex, evidenceRef), {
        apply: setView,
      });
    }
  };

  // 主进程给的 `unavailableReason` 与 `body` 只会有一方非空（那只口的两条组装函数各写死一位），
  // 所以这里按「读到 / 读不到」两支画，不需要再判第三态；两者都空是契约破坏，画缺口而不是画空白。
  const outcome = view === undefined ? 'pending' : view.body !== null ? 'read' : 'unavailable';

  return (
    <li data-evidence-ref={evidenceRef} className="w-full break-all">
      <DeskButton
        action="evidence-ref"
        variant="line"
        compact
        className="font-mono"
        markers={{ ref: evidenceRef, step: String(planStepIndex) }}
        onClick={toggle}
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {evidenceRef}
      </DeskButton>

      {open && (
        <div
          className="mt-1 rounded-md border border-line bg-ink-950/70 px-2.5 py-1.5 text-[11px]"
          data-evidence-outcome={outcome}
        >
          {busy && (
            <p data-testid="evidence-ref-loading" className="text-celadon">
              {t('chat.evidence.loading')}
            </p>
          )}
          {!busy && !view && notice && (
            <p data-testid="evidence-ref-error" className="break-words text-seal">
              {notice}
            </p>
          )}
          {view && (
            <div className="flex flex-col gap-1">
              <p className="flex items-center gap-1 font-medium text-slate-200" data-testid="evidence-ref-title">
                {outcome === 'read' ? <ScrollText size={12} /> : <SearchX size={12} />}
                {view.title ?? t('chat.evidence.untitled')}
              </p>
              <p className="break-all text-slate-500" data-testid="evidence-ref-at">
                {t('chat.evidence.at', { at: formatClock(view.at, t('chat.evidence.none')) })}
              </p>
              {outcome === 'read' ? (
                <p className="whitespace-pre-wrap break-words text-slate-300" data-testid="evidence-ref-body">
                  {view.body}
                </p>
              ) : (
                <p className="whitespace-pre-wrap break-words text-slate-400" data-testid="evidence-ref-reason">
                  {view.unavailableReason ?? t('chat.evidence.hollow')}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
