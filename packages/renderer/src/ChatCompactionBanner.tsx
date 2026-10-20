import { Minimize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChatCompactionView } from '@auto-cc/shared';
import { DeskExplainer } from './ui/disclosure';

/**
 * 一行「较早消息已压缩」的读数 + 那张**现问**回来的事实卡（spec 5.6-04 的界面半边，判据同 5.6-02）。
 *
 * 摘要不是谁说过的话，所以它绝不画成一条消息；而"这段对话还有多少没画出来"说的就是消息流本身，
 * 于是 2026-10-19 设计稿 v2 那一版把它从流**上方**的卡片改成**流内**第一条虚线窄行（用户裁定：
 * 「压缩读数改成流里一条虚线窄行」）——它压在最早那几句之上，位置自己就说出了「上面那些折掉了」。
 * 长度前后那一格跟着搬进输入卡下面那条读数带（`ChatPanel` 的 understrip），这里只留 `data-tokens-*`
 * 两支属性，同一份数字不在两处各写一句话（§2.5）。
 * 事实卡上每一位都写明它是**此刻**问回来的，不是从旧消息里摘的（plan §7.4 决策三）：
 * 那五位数字一旦是从文本里摘的，5.6-03 的「数值逐字不变」就永远只是近似。
 * @param compaction 快照里的那段压缩读数；没折过时为 undefined / null，整行不渲染
 * @returns 消息流第一条的一条虚线窄行，收起态只报「折了多少条」
 */
export function ChatCompactionBanner({ compaction }: { compaction: ChatCompactionView | null | undefined }) {
  const { t } = useTranslation();
  if (!compaction) return null;
  const facts = compaction.factCard;

  return (
    <div
      data-testid="chat-compaction-banner"
      data-covered-count={String(compaction.coveredCount)}
      data-tokens-before={String(compaction.tokensBefore)}
      data-tokens-after={String(compaction.tokensAfter)}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-dashed border-line-strong py-1.5 text-[11px] text-slate-400"
    >
      <Minimize2 size={11} className="shrink-0" aria-hidden="true" />
      <span data-testid="chat-compaction-covered">
        {t('chat.compress.covered', { total: compaction.coveredCount })}
      </span>
      {/* 事实清单十余行，按稿上的语气收在这颗触发词后面：窄行必须真是窄行，
          而 5.6-03 的那些读数只有点开才要，正文一展开仍逐位给得出。 */}
      <DeskExplainer id="chat.compaction-facts" label={t('chat.compress.section')}>
        <div className="text-[11px] text-slate-500">{t('chat.compress.factsHeading')}</div>
        <ul className="mt-1 space-y-0.5" data-testid="chat-compaction-facts">
          <li>{t('chat.compress.autonomy', { level: t(`agent.autonomy.${facts.autonomy}`) })}</li>
          {/* 额度那一位分两种「没有」：空数组是闸门没挂载（问不到），而 `remaining: null` 是 unlimited 模式下的
              「不限额」（1.9-02）。两者对使用者是完全不同的两件事，所以一个看数组长度、一个看那一位。 */}
          {facts.remainingByAction.length === 0 ? (
            <li>{t('chat.compress.quotaUnknown')}</li>
          ) : (
            facts.remainingByAction.map((entry) => (
              <li key={entry.action}>
                {entry.remaining === null
                  ? t('chat.compress.quotaUnlimited', { action: entry.action })
                  : t('chat.compress.quota', { action: entry.action, remaining: entry.remaining })}
              </li>
            ))
          )}
          <li>
            {facts.lastStopReason
              ? t('chat.compress.stopReason', { code: facts.lastStopReason })
              : t('chat.compress.stopNone')}
          </li>
          {/* 每个被拒的步单独一行：工具名与拒因都由语言包决定排版（§5.7 禁止在 JSX 里拼句子），
              key 带上拒因，允许同一工具被不同判定口拒过多次时不撞 key。 */}
          {facts.refusedSteps.length ? (
            facts.refusedSteps.map((step) => (
              <li key={`${step.toolId}:${step.code ?? ''}`}>
                {t('chat.compress.refused', { tool: step.toolId, code: step.code ?? '—' })}
              </li>
            ))
          ) : (
            <li>{t('chat.compress.refusedNone')}</li>
          )}
          <li>
            {facts.deliveredTargetIds.length
              ? t('chat.compress.delivered', { targets: facts.deliveredTargetIds.join('、') })
              : t('chat.compress.deliveredNone')}
          </li>
        </ul>
      </DeskExplainer>
    </div>
  );
}
