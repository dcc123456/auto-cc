/**
 * 失败节点的证据展开段（spec 2.8-04）。
 *
 * 数据只从 `workflow.runner.readEvidence` 那一口读：它是主进程自己写下的那份证据 JSON 的投影，
 * 界面不复制判定、不二次脱敏（脱敏发生在写盘那一次，见 `writeEvidence`），也不碰磁盘路径。
 * 独立成组件的原因：每一格失败节点都要有一段，把它塞进面板会让 `WorkflowPanel` 同时管两件事。
 */
import { ChevronDown, ChevronRight, ImageOff } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkflowEvidenceView } from '@auto-cc/shared';
import { formatClock } from './format';
import { useBridgeAction } from './useBridgeAction';
import { DeskButton } from './ui/controls';

/**
 * 一格失败节点的证据。首次展开才去主进程读，之后复用读到的那份（证据文件写完就不再变）。
 * @param runId 本次 run 的 id（来自 `runner.current` 的镜像，不是用户输入）
 * @param nodeId 节点 id（与镜像里的 `step.id` 同源）
 */
export function NodeEvidenceSection({ runId, nodeId }: { runId: string; nodeId: string }) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState<WorkflowEvidenceView>();
  /** 证据是一次读数，没有「动作跑完重读快照」这回事；复用外壳只为了忙碌态与失败提示的同一套呈现。 */
  const nothingToReread = useCallback(() => Promise.resolve(), []);
  const { busy, notice, run: read } = useBridgeAction(nothingToReread);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !evidence) {
      void read(t('workflow.evidence.actionRead'), () => bridge?.workflow['runner.readEvidence'](runId, nodeId), {
        apply: setEvidence,
      });
    }
  };

  return (
    <div className="mt-1.5" data-testid={`evidence-${nodeId}`}>
      <DeskButton
        action="evidence"
        markers={{ node: nodeId }}
        variant="line"
        compact
        aria-expanded={open}
        onClick={toggle}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {t('workflow.evidence.toggle')}
      </DeskButton>

      {/* 证据块是「这一步为什么停」的真相，属 celadon 族（进行中/系统/证据），
          不是错误块——错误已经在标题那行的 `evidence-code` 上涂过朱砂了，整块再涂红就没人读得出层级。 */}
      {open && (
        <div className="mt-1 rounded-md border border-celadon/40 bg-celadon-wash px-3 py-2 text-[11px] text-slate-100">
          {busy && <p data-testid="evidence-loading">{t('workflow.evidence.loading')}</p>}
          {!busy && !evidence && notice && <p data-testid="evidence-error">{notice}</p>}
          {evidence && (
            <div className="flex flex-col gap-1.5">
              <p className="break-all" data-testid="evidence-attempt">
                {t('workflow.evidence.attempt', {
                  attempt: evidence.attempt,
                  at: formatClock(evidence.at, t('workflow.evidence.none')),
                })}
              </p>
              <p className="break-all" data-testid="evidence-reason">
                <span className="font-mono text-seal" data-testid="evidence-code">
                  {evidence.error.code}
                </span>
                {' · '}
                <span data-testid="evidence-message">{evidence.error.message}</span>
              </p>

              {evidence.page ? (
                <div data-testid="evidence-page">
                  <p className="break-all font-mono" data-testid="evidence-url">
                    {evidence.page.url}
                  </p>
                  <p className="break-all" data-testid="evidence-title">
                    {evidence.page.title}
                  </p>
                  <p
                    className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-all text-slate-400"
                    data-testid="evidence-text"
                  >
                    {evidence.page.bodyText}
                  </p>
                </div>
              ) : (
                <p data-testid="evidence-page-none">{t('workflow.evidence.pageNone')}</p>
              )}

              {'dataUrl' in evidence.screenshot ? (
                <figure data-testid="evidence-shot" className="flex flex-col gap-1">
                  <img
                    src={evidence.screenshot.dataUrl}
                    alt={t('workflow.evidence.shotAlt')}
                    width={evidence.screenshot.width}
                    height={evidence.screenshot.height}
                    className="max-h-48 w-auto max-w-full rounded-md border border-line"
                  />
                  <figcaption className="text-slate-500">
                    {t('workflow.evidence.shotMeta', {
                      width: evidence.screenshot.width,
                      height: evidence.screenshot.height,
                      bytes: evidence.screenshot.bytes,
                    })}
                  </figcaption>
                </figure>
              ) : (
                <p
                  className="flex items-center gap-1 text-slate-400"
                  data-testid="evidence-omitted"
                  data-omitted={evidence.screenshot.omitted}
                >
                  <ImageOff size={12} />
                  {t(`workflow.evidence.omitted.${evidence.screenshot.omitted}`)}
                </p>
              )}

              <p className="break-all font-mono text-slate-500" data-testid="evidence-ref">
                {t('workflow.evidence.ref', { ref: evidence.ref })}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
