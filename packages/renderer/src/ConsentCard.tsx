/**
 * 首次启用自动化前的风险确认卡片（spec 2.7-06 的界面拦截点 ①）。
 *
 * 形状照 `JobLabPanel` 的投递确认卡片：卡片本身不做判定，只把 `sessions.consentStatus` 的读数
 * 摊开给用户看，并把「同意」这一句交回给调用方去写库。之所以要有 `ConsentStatusRow`：
 * 「出现一次」这条验收（plan §14.3 第 6 条末段）要能被截图指认——签过之后界面必须留下
 * 「已确认于某时刻」这行读数，而不是什么都不显示，让人分不清「签过」和「还没点过」。
 */
import { Check, ShieldAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AppErrorPayload, SessionConsentView } from '@auto-cc/shared';
import { formatClock } from './format';

/** `ConsentCard` 的输入。 */
export interface ConsentCardProps {
  /** 等表态的那个平台标识。 */
  platform: string;
  /** `consentStatus` 的原文读数；读不到时为 null（此时卡片不编 scope，只说读不到）。 */
  view: SessionConsentView | null;
  /** 「我承担」按钮的忙碌态（写库那一次调用还在飞）。 */
  busy: boolean;
  /** 最近一次读状态 / 写状态的结构化错误。 */
  error?: AppErrorPayload;
  /** 用户点「我承担」：由调用方写库并重放挂起的动作。 */
  onGrant: () => void;
  /** 用户点「先不启用」：挂起的动作被丢弃，什么都不发。 */
  onDeny: () => void;
}

/**
 * 风险确认卡片本体。
 * @param props 见 `ConsentCardProps`
 */
export function ConsentCard({ platform, view, busy, error, onGrant, onDeny }: ConsentCardProps) {
  const { t } = useTranslation();
  return (
    <div
      className="mt-2 rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-100"
      data-testid="consent-card"
      data-consent-platform={platform}
    >
      <p className="flex items-center gap-1 font-semibold">
        <ShieldAlert size={12} />
        {t('consent.heading', { platform })}
      </p>
      <ul className="mt-1 flex flex-col gap-0.5">
        <li>{t('consent.riskSearch', { platform })}</li>
        <li>{t('consent.riskGreet')}</li>
        <li>{t('consent.riskDeliver')}</li>
      </ul>
      <p className="mt-1">{t('consent.riskAccount')}</p>
      <p className="mt-1 text-amber-200/80">{t('consent.once')}</p>
      {view ? (
        <p className="mt-1 break-all text-[11px] text-amber-200/70" data-testid="consent-scope">
          {t('consent.scopeRow', { scope: view.scope })}
        </p>
      ) : (
        <p className="mt-1 text-[11px] text-rose-300" data-testid="consent-read-unknown">
          {t('consent.readUnknown')}
        </p>
      )}
      {error && (
        <p
          className="mt-1 break-all text-[11px] text-rose-300"
          data-testid="consent-error"
          data-error-code={error.code}
        >
          {t('consent.errorRow', { code: error.code, message: error.message })}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          data-action="consent-grant"
          disabled={busy}
          onClick={onGrant}
          className="flex items-center gap-1 rounded-md border border-emerald-800 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-950 disabled:opacity-40"
        >
          <Check size={12} />
          {t('consent.grant')}
        </button>
        <button
          type="button"
          data-action="consent-deny"
          disabled={busy}
          onClick={onDeny}
          className="flex items-center gap-1 rounded-md border border-rose-800 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-950 disabled:opacity-40"
        >
          <X size={12} />
          {t('consent.deny')}
        </button>
      </div>
    </div>
  );
}

/**
 * 一行签字状态读数（已签显示时刻，未签明说未签）。
 * @param view `consentStatus` 的读数；undefined 表示这个面板还没读过它
 */
export function ConsentStatusRow({ view }: { view: SessionConsentView | undefined }) {
  const { t } = useTranslation();
  if (!view) return null;
  return (
    <p
      className={view.granted ? 'mt-1 text-[11px] text-emerald-300' : 'mt-1 text-[11px] text-amber-300'}
      data-testid={`consent-status-${view.platform}`}
      data-granted={view.granted ? 'true' : 'false'}
    >
      {view.granted
        ? t('consent.statusGranted', {
            platform: view.platform,
            time: formatClock(view.acknowledgedAt, t('consent.never')),
          })
        : t('consent.statusUnsigned', { platform: view.platform })}
    </p>
  );
}
