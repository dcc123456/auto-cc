/**
 * 无人值守投递的授权卡（spec 10.6-01/02/04/05 的界面半边；plan §12.2）。
 *
 * 它只画「这一轮授权长什么样」与三颗人才能按的键：开单、停用/恢复、确认续跑/收回。
 * 三要素、状态、剩余名额与待办全部来自 `outbound.authorization.*` 的只读视图，渲染层不自己算
 * （§2.7：额度按账本现算只有主进程那一处）。风控暂停由 `outbound/authorization-paused` 推过来，
 * 横幅与托盘读同一份原因原文——界面负责让它「回到页面第一眼就看见」，不负责解释或恢复。
 */
import { Ban, Play, ShieldAlert, Stamp } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { JourneyJobMatchView, UnattendedAuthorizationView } from '@auto-cc/shared';
import { Banner, DeskButton, DeskCheck, DeskField } from './ui/controls';
import { useBridgeAction } from './useBridgeAction';

/** 授权卡需要的三要素来源与可勾选岗位（都来自本轮已读出的主链读数）。 */
export interface OutboundAuthorizationCardProps {
  /** 本轮搜岗的平台标识；空串表示还没搜岗。 */
  platform: string;
  /** 母版简历版本（`doc:<id>:<hash>`），来自意向或定制读数。 */
  masterVersion: string;
  /** 定制简历版本；只有刚定制过的那一份才可用于开单。 */
  tailoredVersion: string;
  /** 那次定制的事实校验回执 id。 */
  factCheckReceiptId: string;
  /** 本次搜岗返回的岗位（显式勾选，不接受"全部岗位"）。 */
  jobs: readonly JourneyJobMatchView[];
}

/**
 * 授权卡本体。
 * @param props 见 {@link OutboundAuthorizationCardProps}
 * @returns 一张常驻卡：三要素、当前授权读数、暂停横幅与四颗人的按钮
 */
export function OutboundAuthorizationCard({
  platform,
  masterVersion,
  tailoredVersion,
  factCheckReceiptId,
  jobs,
}: OutboundAuthorizationCardProps) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [auth, setAuth] = useState<UnattendedAuthorizationView | null>(null);
  const [stopped, setStopped] = useState(false);
  const [dailyLimit, setDailyLimit] = useState('5');
  const [targets, setTargets] = useState<string[]>([]);

  /**
   * 重读授权单与停用位：动作之后一律重建读数，不自己猜主进程当下的状态。
   * @returns 无返回值
   */
  const reload = useCallback(async () => {
    const [authReply, stopReply] = await Promise.all([
      bridge?.outbound['authorization.current'](),
      bridge?.entitlement['gate.outboundStatus'](),
    ]);
    if (authReply?.ok) setAuth(authReply.value);
    if (stopReply?.ok) setStopped(stopReply.value.stopped);
  }, [bridge]);

  useEffect(() => {
    void reload();
    // 风控暂停由主进程推过来：横幅与读数是同一份事实，事件到了就重读（不轮询）。
    const off = bridge?.on('outbound/authorization-paused', () => {
      void reload();
    });
    return () => off?.();
  }, [bridge, reload]);

  const { busy, notice, noticeTone, run } = useBridgeAction(reload);
  const limit = Number(dailyLimit);
  const limitValid = Number.isInteger(limit) && limit >= 1 && limit <= 10;
  const canGrant =
    platform !== '' &&
    masterVersion !== '' &&
    tailoredVersion !== '' &&
    factCheckReceiptId !== '' &&
    targets.length > 0 &&
    limitValid &&
    targets.length <= limit;

  /**
   * 开一张授权单；三要素任缺一项时按钮本就禁用，这里只走合法路径。
   * @returns 无返回值
   */
  const grant = () =>
    void run(t('journeyAuth.actionGrant'), () =>
      bridge?.outbound['authorization.grant']({
        platform,
        dailyLimit: limit,
        targets,
        masterResumeVersion: masterVersion,
        resumeVersion: tailoredVersion,
        factCheckReceiptId,
      }),
    );

  /**
   * 一键停用 / 恢复总开关（停用即时生效由主进程保证，这里只是那颗键）。
   * @returns 无返回值
   */
  const toggleStop = () =>
    void run(t(stopped ? 'journeyAuth.actionRestore' : 'journeyAuth.actionStop'), () =>
      bridge?.entitlement['gate.setOutboundStopped'](!stopped),
    );

  /**
   * 人确认续跑（重启/跨日/风控暂停之后唯一能回到运行的入口）。
   * @returns 无返回值
   */
  const reconfirm = () =>
    void run(t('journeyAuth.actionReconfirm'), () => bridge?.outbound['authorization.reconfirm']());

  /**
   * 主动收回当前授权单。
   * @returns 无返回值
   */
  const revoke = () => void run(t('journeyAuth.actionRevoke'), () => bridge?.outbound['authorization.revoke']());

  const reasonNoTailor = tailoredVersion === '' || factCheckReceiptId === '' ? 'JOURNEY_AUTH_NO_TAILOR' : undefined;
  const grantReason =
    reasonNoTailor ??
    (targets.length === 0
      ? 'JOURNEY_AUTH_NO_TARGETS'
      : !limitValid
        ? 'JOURNEY_AUTH_LIMIT_INVALID'
        : targets.length > limit
          ? 'JOURNEY_AUTH_TARGETS_OVER_LIMIT'
          : busy
            ? 'ACTION_BUSY'
            : undefined);

  return (
    <div className="mt-3 rounded-md border border-line bg-ink-900/50 px-2 py-2" data-testid="journey-auth">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-[11px] text-slate-200">
          <Stamp size={12} />
          {t('journeyAuth.heading')}
        </span>
        <span
          className="text-[11px] text-slate-400"
          data-testid="journey-auth-status"
          data-status={auth?.status ?? 'none'}
          data-day={auth?.dayKey ?? ''}
          data-remaining={String(auth?.remaining ?? 0)}
          data-pending={String(auth?.pendingTargets.length ?? 0)}
        >
          {t('journeyAuth.statusLine', {
            status: t(`journeyAuth.status.${auth?.status ?? 'none'}`),
            remaining: auth?.remaining ?? 0,
            pending: auth?.pendingTargets.length ?? 0,
          })}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <DeskButton
            action="journey-auth-stop-toggle"
            variant={stopped ? 'seal' : 'line'}
            compact
            busy={!!busy}
            disabled={!!busy}
            disabledReason={busy ? 'ACTION_BUSY' : undefined}
            disabledReasonLabel={busy ? t('journeyAuth.reasonBusy') : undefined}
            onClick={toggleStop}
          >
            {stopped ? <Play size={12} /> : <Ban size={12} />}
            {t(stopped ? 'journeyAuth.actionRestore' : 'journeyAuth.actionStop')}
          </DeskButton>
          <DeskButton
            action="journey-auth-revoke"
            variant="ghost"
            compact
            busy={!!busy}
            disabled={!!busy || auth === null}
            disabledReason={auth === null ? 'JOURNEY_AUTH_NONE' : busy ? 'ACTION_BUSY' : undefined}
            disabledReasonLabel={
              auth === null ? t('journeyAuth.reasonNoAuth') : busy ? t('journeyAuth.reasonBusy') : undefined
            }
            onClick={revoke}
          >
            {t('journeyAuth.actionRevoke')}
          </DeskButton>
        </span>
      </div>

      {auth?.status === 'paused' ? (
        <Banner
          tone="amber"
          size="compact"
          reason={auth.pauseReason ?? 'unknown'}
          markers={{ testid: 'journey-auth-paused' }}
          className="mt-2"
          actions={
            <DeskButton
              action="journey-auth-reconfirm"
              variant="amber"
              compact
              busy={!!busy}
              disabled={!!busy}
              disabledReason={busy ? 'ACTION_BUSY' : undefined}
              disabledReasonLabel={busy ? t('journeyAuth.reasonBusy') : undefined}
              onClick={reconfirm}
            >
              <ShieldAlert size={12} />
              {t('journeyAuth.actionReconfirm')}
            </DeskButton>
          }
        >
          <span>{t('journeyAuth.pausedBanner', { reason: auth.pauseReason ?? t('journeyAuth.unknownReason') })}</span>
          <span className="text-[11px] text-amber-ink">{t('journeyAuth.needsYou')}</span>
        </Banner>
      ) : null}

      {auth?.status === 'restart-required' || auth?.status === 'expired' ? (
        <Banner
          tone="amber"
          size="compact"
          reason={auth.status}
          markers={{ testid: 'journey-auth-needs-confirm' }}
          className="mt-2"
          actions={
            <DeskButton
              action="journey-auth-reconfirm"
              variant="amber"
              compact
              busy={!!busy}
              disabled={!!busy}
              disabledReason={busy ? 'ACTION_BUSY' : undefined}
              disabledReasonLabel={busy ? t('journeyAuth.reasonBusy') : undefined}
              onClick={reconfirm}
            >
              {t('journeyAuth.actionReconfirm')}
            </DeskButton>
          }
        >
          <span>{t(`journeyAuth.needsConfirm.${auth.status}`)}</span>
          <span className="text-[11px] text-amber-ink">{t('journeyAuth.needsYou')}</span>
        </Banner>
      ) : null}

      {notice && (
        <Banner tone={noticeTone} size="compact" markers={{ testid: 'journey-auth-notice' }} className="mt-2">
          {notice}
        </Banner>
      )}

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <DeskField
          action="journey-auth-limit"
          label={t('journeyAuth.dailyLimitLabel')}
          type="number"
          min={1}
          max={10}
          value={dailyLimit}
          onValueChange={setDailyLimit}
          isInvalid={!limitValid}
          disabled={!!busy}
          disabledReason={busy ? 'ACTION_BUSY' : undefined}
          disabledReasonLabel={busy ? t('journeyAuth.reasonBusy') : undefined}
          className="w-20"
        />
        <span
          className="text-[11px] text-slate-400"
          data-testid="journey-auth-versions"
          data-master-version={masterVersion}
          data-tailored-version={tailoredVersion}
          data-receipt={factCheckReceiptId}
        >
          {t('journeyAuth.versionLine', {
            master: masterVersion || t('journeyAuth.none'),
            tailored: tailoredVersion || t('journeyAuth.none'),
            receipt: factCheckReceiptId || t('journeyAuth.none'),
          })}
        </span>
      </div>

      <div className="mt-2 flex flex-col gap-1" data-testid="journey-auth-targets">
        {jobs.length === 0 ? (
          <p className="text-[11px] text-slate-500">{t('journeyAuth.noTargets')}</p>
        ) : (
          jobs.map((match) => (
            <DeskCheck
              key={match.jobId}
              action={`journey-auth-target-${match.jobId}`}
              checked={targets.includes(match.jobId)}
              disabled={!!busy}
              disabledReason={busy ? 'ACTION_BUSY' : undefined}
              disabledReasonLabel={busy ? t('journeyAuth.reasonBusy') : undefined}
              onCheckedChange={(checked) =>
                setTargets((current) =>
                  checked ? [...current, match.jobId] : current.filter((target) => target !== match.jobId),
                )
              }
              label={t('journeyAuth.targetRow', { title: match.title, company: match.company })}
            />
          ))
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <DeskButton
          action="journey-auth-grant"
          variant="seal"
          compact
          busy={!!busy}
          disabled={!canGrant || !!busy}
          disabledReason={grantReason}
          disabledReasonLabel={
            reasonNoTailor
              ? t('journeyAuth.reasonNoTailor')
              : targets.length === 0
                ? t('journeyAuth.reasonNoTargets')
                : !limitValid
                  ? t('journeyAuth.reasonLimit')
                  : targets.length > limit
                    ? t('journeyAuth.reasonOverLimit', { limit })
                    : busy
                      ? t('journeyAuth.reasonBusy')
                      : undefined
          }
          onClick={grant}
        >
          {t('journeyAuth.actionGrant')}
        </DeskButton>
        <span className="text-[11px] text-slate-500">{t('journeyAuth.hint')}</span>
      </div>
    </div>
  );
}
