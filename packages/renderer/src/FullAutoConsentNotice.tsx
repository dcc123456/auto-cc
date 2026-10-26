/**
 * 全自动档那句**一次性明示**（spec 8.10-01）：把档位切到全自动之后、真正开跑之前，摆在输入卡上方。
 *
 * 它不是每次执行前的追问——授权只登记一次（落在 SQLite，跨重启有效），之后这句话不再出现。
 * 摆在两处（输入卡上方 / 设置抽屉的档位格）是同一个原件的两次挂载：抽屉打开时输入卡被遮罩盖住，
 * 人若在抽屉里把档位切到全自动，那颗按键必须在**当下看得见的那一格**里，而不是藏在遮罩后面。
 */
import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DeskButton } from './ui/controls';

/**
 * 明示卡正文。
 * @param busy 主进程动作进行中（防止重复登记；那一次点击只该写一行）
 * @param onGrant 人按下「我了解，开始全自动」；写库成功后由调用方刷新读数、本卡随之收起
 * @returns 一句话 + 一句边界 + 一颗按键；不含任何"每次都会问"的语气
 */
export function FullAutoConsentNotice({ busy, onGrant }: { busy: boolean; onGrant: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="chat-full-auto-consent"
      className="mb-2 rounded-control border border-amber/40 bg-ink-800 px-3 py-2"
    >
      <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-amber-ink">
        <ShieldCheck size={13} className="shrink-0" aria-hidden="true" />
        {t('agent.fullAuto.title')}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-amber-ink/80">{t('agent.fullAuto.statement')}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <DeskButton action="full-auto-consent" variant="seal" compact busy={busy} onClick={onGrant}>
          <ShieldCheck size={11} />
          {t('agent.fullAuto.grant')}
        </DeskButton>
        <span className="text-[10px] text-amber-ink/70">{t('agent.fullAuto.once')}</span>
      </div>
    </div>
  );
}
