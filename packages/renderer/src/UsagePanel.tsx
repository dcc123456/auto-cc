import { Gauge, RefreshCw, Send } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  OUTBOUND_SAMPLE_ACTIONS,
  QUOTA_ACTIONS,
  type GateDecisionView,
  type OutboundSampleAction,
  type QuotaAction,
  type UsageSummaryView,
} from '@auto-cc/shared';
import { AuditSection } from './AuditSection';
import { DeskButton } from './ui/controls';
import { useBridgeAction } from './useBridgeAction';

/** 这个动作能不能从面板代发（`search` 的账由 `jd.capture` 记，面板没有「发一次搜索」这种口）。 */
const isSampleAction = (action: QuotaAction): action is OutboundSampleAction =>
  (OUTBOUND_SAMPLE_ACTIONS as readonly string[]).includes(action);

/** 最近流水的显示条数：用量页是验收入口，不是历史库。 */
const RECENT_LIMIT = 5;

/**
 * 用量面板：外发额度闸门与 `usage.ledger` 的界面化身（spec 1.9 / 2.7-03）。
 *
 * 它是「闸门 + 账本」这条链路唯一能被眼睛检查的地方：上半部分读闸门判定（只展示，不放行），
 * 下半部分读账本分组，中间那个按钮走 `outbound.sample.send`——一次点击就把
 * 判定、外发、落账、回看四件事在同一张截图里连起来（spec 1.9-03 / 1.9-07）。
 * 判定行是**三条动作各一行**（`search` / `greet` / `deliver`）：额度按动作独立，所以「抓 40 轮
 * 不打招呼」与「打招呼用尽而投递照旧」都得在这一屏看得见，而不是靠测试用例自证。
 * `search` 那行没有代发按钮——它的消费者是抓取编排，面板伪造一次搜索只会让账本说谎。
 * 额度怎么改不在这里：配置项在装配面板的 `entitlement` 那一行，热更新即时生效。
 *
 * 2.7-e 起面板底部还挂了一段 `AuditSection`（spec 2.7-05 的审计回看）：账本的 `byAction` 那列
 * 在抓取进账之后第一次有三个值，只有摆出来才算得上「三个动作各自独立」的可见证据。
 */
export function UsagePanel() {
  const { t } = useTranslation();
  const [decisions, setDecisions] = useState<Record<string, GateDecisionView>>();
  const [summary, setSummary] = useState<UsageSummaryView>();
  /** 本面板已发过的条数，只用来给 fixture 生成不重复的 targetId。 */
  const [sent, setSent] = useState(0);
  const bridge = window.autoCC;

  const read = useCallback(async () => {
    const [summaryReply, ...gateReplies] = await Promise.all([
      bridge?.usage['ledger.summary'](RECENT_LIMIT),
      ...QUOTA_ACTIONS.map((action) => bridge?.entitlement['gate.check'](action)),
    ]);
    if (summaryReply?.ok) setSummary(summaryReply.value);
    const decisions: Record<string, GateDecisionView> = {};
    for (const [index, action] of QUOTA_ACTIONS.entries()) {
      const reply = gateReplies[index];
      // 一个动作读不到就整组丢掉：半屏额度数字比空白更容易骗人。
      if (!reply?.ok) {
        setDecisions(undefined);
        return;
      }
      decisions[action] = reply.value;
    }
    setDecisions(decisions);
  }, [bridge]);

  useEffect(() => {
    void read();
  }, [read]);

  const { busy, notice, run } = useBridgeAction(read);

  /**
   * 走一次真实外发样例：过闸门、打本地 fixture、落账，然后重读判定与账本。
   * @param action 动作名（额度按它单独计）
   */
  const send = (action: OutboundSampleAction) =>
    void run(
      t('usage.actionSend', { action }),
      () =>
        bridge?.outbound['sample.send']({
          action,
          targetId: `job-${String(sent + 1)}`,
          message: t('usage.sampleMessage', { action }),
        }),
      {
        apply: () => setSent((count) => count + 1),
        describe: (receipt) => t('usage.receipt', { id: receipt.ledgerId, count: receipt.delivered }),
      },
    );

  return (
    <section data-testid="usage-panel" className="rounded-xl border border-line bg-ink-900/60 p-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Gauge size={16} />
          {t('usage.heading')}
        </h2>
        <DeskButton action="refresh" variant="line" compact busy={!!busy} onClick={() => void read()}>
          <RefreshCw size={12} />
          {t('usage.refresh')}
        </DeskButton>
      </div>

      {notice && (
        <p
          className="mt-2 rounded-md border border-line bg-ink-950/70 px-3 py-2 text-[11px] text-slate-300"
          data-testid="usage-notice"
        >
          {notice}
        </p>
      )}

      <ul className="mt-3 flex flex-col gap-2">
        {QUOTA_ACTIONS.map((action) => {
          const decision = decisions?.[action];
          const canSend = isSampleAction(action);
          return (
            <li
              key={action}
              data-gate-action={action}
              className="flex items-center justify-between gap-2 rounded-lg border border-line bg-ink-950/60 px-3 py-2"
            >
              <span
                className={`break-all text-[11px] ${
                  decision && !decision.allowed
                    ? 'text-seal'
                    : decision?.remaining === null
                      ? 'text-jade'
                      : 'text-slate-300'
                }`}
              >
                <span className="font-mono text-xs text-slate-200">{action}</span>
                {' · '}
                {!decision
                  ? t('usage.gateUnknown')
                  : !decision.allowed
                    ? t('usage.denied', { reason: decision.reason ?? '' })
                    : decision.remaining === null
                      ? t('usage.unlimited')
                      : t('usage.remaining', { count: decision.remaining })}
              </span>
              {canSend ? (
                <DeskButton
                  action="send"
                  markers={{ sendAction: action }}
                  variant="seal"
                  compact
                  busy={!!busy}
                  disabled={!!busy}
                  disabledReason={busy !== undefined ? 'ACTION_BUSY' : undefined}
                  disabledReasonLabel={busy !== undefined ? t('usage.reasonBusy') : undefined}
                  onClick={() => send(action)}
                >
                  <Send size={12} />
                  {t('usage.send')}
                </DeskButton>
              ) : (
                <span className="text-[11px] text-slate-500" data-gate-note={action}>
                  {t('usage.consumedByCapture')}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span data-stat="usage-total">{t('usage.total', { count: summary?.total ?? 0 })}</span>
        <span data-stat="usage-today">{t('usage.today', { count: summary?.today ?? 0 })}</span>
      </p>

      {(summary?.byDay.length ?? 0) > 0 ? (
        <ul className="mt-2 flex flex-col gap-1" data-testid="usage-days">
          {summary?.byDay.map((day) => (
            <li key={day.day} data-day={day.day} className="text-[11px] text-slate-400">
              {t('usage.dayRow', { day: day.day, count: day.count })}
              {' · '}
              {day.actions.map((item) => t('usage.actionRow', { action: item.action, count: item.count })).join(' · ')}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[11px] text-slate-500">{t('usage.empty')}</p>
      )}

      {(summary?.recent.length ?? 0) > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5 font-mono text-[11px] text-slate-500" data-testid="usage-recent">
          {summary?.recent.map((row) => (
            <li key={String(row.id)} data-ledger-id={String(row.id)}>
              {t('usage.rowMeta', {
                id: row.id,
                action: row.action,
                target: row.targetId ?? t('usage.none'),
                time: new Date(row.ts).toLocaleTimeString(),
              })}
            </li>
          ))}
        </ul>
      )}

      <AuditSection />
    </section>
  );
}
