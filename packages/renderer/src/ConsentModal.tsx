/**
 * 等用户承担平台自动化风险的那一只遮罩弹窗（09 稿形态⑤ 的 ⑤-1；spec 2.7-06 拦截点① 的画法）。
 *
 * 它替代原先贴在面板里的行内卡片（`data-testid="consent-card"` 因此**保留**在同一块内容节点上：
 * 2.7-06 的验收通道指着这个名字，改名等于把已验收条目的断言拆掉，见 `App.tsx` 里 `data-view` 同一条纪律）。
 * 判定语义一字未动——照样是 `useConsent` 按平台读 `sessions.consentStatus`、读不到按"没签"处理，
 * 本片只把"等人表态"这一层的打扰度从形态① 升到形态⑤。为什么值得升：稿上那句门槛
 * "不可逆、或必须先读完整风险"，而这张卡要求的正是**读完四行风险再逐条授权一次外发能力**，
 * 贴在面板里可以被滚动走过、可以被误当成一行提示，风险表态不该有这种走法。
 *
 * 三条退路一律不给（`dismissOnScrim` 一只 prop 同时关掉点遮罩 / 按 Esc / 右上角 ✕）：
 * 没表态就关掉，等于让"没读"看起来像"不同意"。退出这条路只有脚注里那只安全动作。
 */
import { Check, ShieldAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppErrorPayload, SessionConsentView } from '@auto-cc/shared';
import { formatClock } from './format';
import type { ConsentFacade } from './useConsent';
import { DeskButton, DeskCheck } from './ui/controls';
import { Modal } from './ui/overlays';

/** `ConsentModal` 的输入（与原行内卡片一致：三块面板各自持有 `useConsent` 的那一面）。 */
export interface ConsentModalProps {
  /** 等表态的那个平台标识。 */
  platform: string;
  /** `consentStatus` 的原文读数；读不到时为 null（此时弹窗不编 scope，只说读不到）。 */
  view: SessionConsentView | null;
  /** 「签字同意」按钮的忙碌态（写库那一次调用还在飞）。 */
  busy: boolean;
  /** 最近一次读状态 / 写状态的结构化错误。 */
  error?: AppErrorPayload;
  /** 用户勾满并按「签字同意」：由调用方写库并重放挂起的动作。 */
  onGrant: () => void;
  /** 用户按「先不启用」：挂起的动作被丢弃，什么都不发。 */
  onDeny: () => void;
}

/**
 * 风险签字弹窗本体。
 * @param platform 等表态的平台标识
 * @param view 该平台签字读数的原文
 * @param busy 写入是否还在飞
 * @param error 读/写失败的结构化错误
 * @param onGrant 签字并重放挂起动作
 * @param onDeny 丢弃挂起动作
 * @returns 盖住整窗的遮罩弹窗（面板一般挂 `ConsentOverlay`，由它决定画不画）
 */
export function ConsentModal({ platform, view, busy, error, onGrant, onDeny }: ConsentModalProps) {
  const { t } = useTranslation();
  // 必须勾满才谈得上签字：稿上⑤-1 与⑤-5 是仅有的两只"必须打字 / 必须勾满"的弹窗。
  const [isAccepted, setIsAccepted] = useState(false);

  // 一次动作可能牵多个平台，`useConsent` 会把 request 换成下一个未签的平台（组件不卸载）。
  // 勾选必须跟着清零：让上一个平台的表态盖着下一个平台的签字，就是替用户点头。
  useEffect(() => {
    setIsAccepted(false);
  }, [platform]);

  const reason = busy ? 'ACTION_BUSY' : !isAccepted ? 'CONSENT_NOT_CHECKED' : undefined;
  const reasonLabel =
    reason === 'ACTION_BUSY'
      ? t('consent.reason.ACTION_BUSY')
      : reason === 'CONSENT_NOT_CHECKED'
        ? t('consent.reason.CONSENT_NOT_CHECKED')
        : undefined;

  return (
    <Modal
      action="consent"
      open
      title={t('consent.heading', { platform })}
      onClose={onDeny}
      width="560"
      tone="seal"
      footer={
        <>
          {/* 焦点落在默认安全动作（09 稿浮层纪律表第 2 行）：没读清楚之前唯一不该发生的是一次外发。
              「先不启用」什么都不发，所以退成 ghost——拒绝不该被涂成危险色（与岗位屏的拒绝同一口径）。 */}
          <DeskButton action="consent-deny" variant="ghost" autoFocus disabled={busy} onClick={onDeny}>
            <X size={14} />
            {t('consent.deny')}
          </DeskButton>
          {/* 「签字同意」签完之后紧接着就是重放那一次外发，所以它是 `seal` 而不是旧写法的 emerald：
              这一层从来没有"已经办成"的语义，它只有一个待表态的风险。 */}
          <DeskButton
            action="consent-grant"
            variant="seal"
            busy={busy}
            disabled={busy || !isAccepted}
            disabledReason={reason}
            disabledReasonLabel={reasonLabel}
            onClick={onGrant}
          >
            <Check size={14} />
            {t('consent.grant')}
          </DeskButton>
        </>
      }
    >
      <div data-testid="consent-card" data-consent-platform={platform}>
        <p className="flex items-center gap-1.5 text-xs font-semibold text-seal-ink">
          <ShieldAlert size={13} aria-hidden="true" />
          {t('consent.mustRead')}
        </p>
        <ul className="mt-2 flex flex-col gap-1">
          <li>{t('consent.riskSearch', { platform })}</li>
          <li>{t('consent.riskGreet')}</li>
          <li>{t('consent.riskDeliver')}</li>
          <li>{t('consent.riskAccount')}</li>
          {/* 「不识别验证码、不绕过风控」这条隐私屏已经写过一遍，这里现读同一句（§2.5）：
              两处各存一份措辞，改一处漏一处，风险声明就会长成两个版本。 */}
          <li>{t('privacy.riskNoEvasion')}</li>
          <li>{t('consent.riskFact')}</li>
        </ul>
        <p className="mt-3 text-slate-400">{t('consent.once')}</p>

        <label
          className="mt-3 flex cursor-pointer items-start gap-2 rounded-control border border-line bg-ink-950/70 px-3 py-2"
          htmlFor="consent-accept"
        >
          <DeskCheck
            action="consent-accept"
            id="consent-accept"
            checked={isAccepted}
            onCheckedChange={setIsAccepted}
            tone="seal"
            data-testid="consent-accept"
          />
          <span className={isAccepted ? 'text-jade-ink' : 'text-slate-200'}>{t('consent.checkbox')}</span>
        </label>

        {view ? (
          <p className="mt-2 break-all text-[11px] text-slate-400" data-testid="consent-scope">
            {t('consent.scopeRow', { scope: view.scope })}
          </p>
        ) : (
          <p className="mt-2 text-[11px] text-seal-ink" data-testid="consent-read-unknown">
            {t('consent.readUnknown')}
          </p>
        )}
        {error ? (
          <p
            className="mt-2 break-all text-[11px] text-seal-ink"
            data-testid="consent-error"
            data-error-code={error.code}
          >
            {t('consent.errorRow', { code: error.code, message: error.message })}
          </p>
        ) : null}
      </div>
    </Modal>
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
      className={view.granted ? 'mt-1 text-[11px] text-jade' : 'mt-1 text-[11px] text-amber'}
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

/**
 * 弹窗真正要用的那四面。之所以不直接收 `ConsentFacade`：面板为了改名 `refresh` 会把它拆出去
 * （`const { refresh, ...consent } = useConsent()`），收整面就等于要求调用方交出它已经交出去的东西。
 */
type ConsentOverlaySource = Pick<ConsentFacade, 'request' | 'busy' | 'error' | 'grant' | 'deny'>;

/**
 * 挂载点：把「有 request 才画弹窗」这一句收起来，三块面板各写一次就是三份复制（§2.2）。
 * @param consent 该面板自己的 `useConsent()` 那一面（判定与挂起动作都在里面，这里只决定画不画）
 */
export function ConsentOverlay({ consent }: { consent: ConsentOverlaySource }) {
  const request = consent.request;
  if (!request) return null;
  return (
    <ConsentModal
      platform={request.platform}
      view={request.view}
      busy={consent.busy}
      error={consent.error}
      onGrant={() => void consent.grant()}
      onDeny={consent.deny}
    />
  );
}
