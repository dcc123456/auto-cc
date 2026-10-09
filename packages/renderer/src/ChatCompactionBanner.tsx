import { Minimize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChatCompactionView } from '@auto-cc/shared';
import { DeskSection } from './ui/disclosure';

/**
 * 一行「较早消息已压缩」的读数 + 那张**现问**回来的事实卡（spec 5.6-04 的界面半边，判据同 5.6-02）。
 *
 * 为什么单独成一格而不是塞进消息流里当一条假消息：摘要不是谁说过的话，把它画成气泡就会让人以为
 * 模型说过那句话；而库里那条压缩读数只是「区间 + 条数 + 长度前后」，把它拼成句子是界面的事（§5.5）。
 * 事实卡上每一位都写明它是**此刻**问回来的，不是从旧消息里摘的（plan §7.4 决策三）：
 * 那五位数字一旦是从文本里摘的，5.6-03 的「数值逐字不变」就永远只是近似。
 * @param compaction 快照里的那段压缩读数；没折过时为 undefined / null，整块不渲染
 * @returns 会话操作带下面的一格默认收起的段，标题行就带回「折了多少条」这一位读数
 */
export function ChatCompactionBanner({ compaction }: { compaction: ChatCompactionView | null | undefined }) {
  const { t } = useTranslation();
  if (!compaction) return null;
  const facts = compaction.factCard;

  return (
    // 收成默认收起的一格：那张事实卡有七到十余行，原先作为常驻带把消息流压回窄缝里。
    // 收起态仍把「折了多少条」这一行读数留在明面上（它就是这条带的标题），而 5.6-04 的三位数
    // 读数（covered / tokens 前后）挂在段容器上，属性名一字未改；要点开正文才拿得到事实清单。
    <DeskSection
      id="chat.compaction"
      className="mx-4 my-3"
      markers={{
        testid: 'chat-compaction-banner',
        'covered-count': String(compaction.coveredCount),
        'tokens-before': String(compaction.tokensBefore),
        'tokens-after': String(compaction.tokensAfter),
      }}
      title={
        <span className="flex items-center gap-1.5">
          <Minimize2 size={12} />
          {t('chat.compress.section')}
        </span>
      }
      summary={
        <span data-testid="chat-compaction-covered">
          {t('chat.compress.covered', { total: compaction.coveredCount })}
        </span>
      }
    >
      <div className="text-[11px] text-slate-400">
        {t('chat.compress.tokens', { before: compaction.tokensBefore, after: compaction.tokensAfter })}
      </div>
      <div className="mt-2 text-[11px] text-slate-500">{t('chat.compress.factsHeading')}</div>
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
    </DeskSection>
  );
}
