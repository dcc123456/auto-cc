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
import type { JourneyJobMatchView, UnattendedAuthorizationView, UnattendedRunView } from '@auto-cc/shared';
import { Banner, DeskButton, DeskCheck, DeskField } from './ui/controls';
import { DeskPathGuide } from './ui/disclosure';
import { reportDeskAuthorization } from './deskStatus';
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
  /** 本次搜岗返回的岗位（显式勾选，不接受"全部岗位"）；搜岗为空时退到库内岗位。 */
  jobs: readonly JourneyJobMatchView[];
  /**
   * 重读候选岗位（2026-11-24 萌新死路：候选是挂载那一刻的快照，抓完岗回来永远是空列表）。
   * 省略时不画那颗键——单测与没有回调的装配里 DOM 一字不变。
   */
  onReloadJobs?: () => void;
  /** 上一次重读候选失败的原话；有值就摆在候选格上，不静默留一个空列表。 */
  jobsError?: string;
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
  onReloadJobs,
  jobsError,
}: OutboundAuthorizationCardProps) {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [auth, setAuth] = useState<UnattendedAuthorizationView | null>(null);
  const [stopped, setStopped] = useState(false);
  const [dailyLimit, setDailyLimit] = useState('5');
  const [targets, setTargets] = useState<string[]>([]);
  const [runView, setRunView] = useState<UnattendedRunView | null>(null);
  /**
   * 在卡上直接定制出来的那一份（2026-11-24 裁定 N2）。
   *
   * 之前授权卡只认「本面板会话里刚跑过 journey.tailor」的版本，而新手是从岗位弹窗走简历生成链定制，
   * 于是卡上永远「定制 无」、`JOURNEY_AUTH_NO_TAILOR` 恒现。这里允许人在卡上对**勾选的库内岗位**
   * 直接触发 `journey.tailor`，定制完成后同一张卡即可开单。
   */
  const [localTailor, setLocalTailor] = useState<{
    jobId: string;
    platform: string;
    version: string;
    receipt: string;
  } | null>(null);
  /**
   * 卡上定制这一步的**三态**（2026-11-24 QA 的授权格死路）：
   * `running` 带已用秒数、`failed` 给原因码与原话并给「重试」、`done` 把版本与回执写进卡片并解锁授权。
   * 这组状态必须自己收尾——不依赖 `useBridgeAction` 的 `busy`：那一路是「动作跑完才撤」，
   * 而定制可能永远不回来（模型卡住/宿主关掉），界面上就成了整组永久 `aria-disabled` 的死路。
   */
  const [tailorState, setTailorState] = useState<{
    jobId: string;
    phase: 'running' | 'failed' | 'done';
    startedAt: number;
    errorCode?: string;
    errorText?: string;
  } | null>(null);
  /** 让「已用 N 秒」每秒走一格；只在 running 期间挂定时器。 */
  const [tailorNow, setTailorNow] = useState(Date.now());
  /** 母版 doc id：优先取传入的版本串，其次现读库内第一份母版（卡上定制需要它）。 */
  const [fallbackDocId, setFallbackDocId] = useState('');
  useEffect(() => {
    if (masterVersion !== '') return;
    void (async () => {
      const reply = await bridge?.resume['doc.list']();
      if (!reply?.ok) return;
      setFallbackDocId(reply.value.find((doc) => doc.parentDocId === null)?.id ?? '');
    })();
  }, [bridge, masterVersion]);

  /**
   * 重读授权单与停用位：动作之后一律重建读数，不自己猜主进程当下的状态。
   * @returns 无返回值
   */
  const reload = useCallback(async () => {
    const [authReply, stopReply] = await Promise.all([
      bridge?.outbound['authorization.current'](),
      bridge?.entitlement['gate.outboundStatus'](),
    ]);
    if (authReply?.ok) {
      setAuth(authReply.value);
      // 状态条那一格跟着这份读数走（plan §13.2：授权生效才显示「无人值守：已授权 N 岗」）。
      reportDeskAuthorization(authReply.value, stopReply?.ok === true && stopReply.value.stopped);
    }
    if (stopReply?.ok) setStopped(stopReply.value.stopped);
  }, [bridge]);

  const reloadRun = useCallback(async () => {
    const reply = await bridge?.journey['unattended.view']();
    if (reply?.ok) setRunView(reply.value);
  }, [bridge]);

  useEffect(() => {
    void reload();
    void reloadRun();
    // 风控暂停由主进程推过来：横幅与读数是同一份事实，事件到了就重读（不轮询）。
    const off = bridge?.on('outbound/authorization-paused', () => {
      void reload();
    });
    return () => off?.();
  }, [bridge, reload, reloadRun]);

  // 运行中每 800ms 读一次进度（执行器在主进程里跑，界面不推第二条状态）。
  useEffect(() => {
    if (runView?.status !== 'running') return;
    const timer = window.setInterval(() => {
      void reloadRun();
    }, 800);
    return () => window.clearInterval(timer);
  }, [runView?.status, reloadRun]);

  const { busy, notice, noticeTone, run, setNotice } = useBridgeAction(reload);
  const masterDocIdValue = masterVersion.startsWith('doc:')
    ? (masterVersion.split(':')[1] ?? '')
    : masterVersion || fallbackDocId;
  /** 生效的定制版本：卡上刚定制的那一份优先（且必须仍被勾选），否则用传入的那一份。 */
  const effectiveTailored =
    localTailor !== null && targets.includes(localTailor.jobId) ? localTailor.version : tailoredVersion;
  const effectiveReceipt =
    localTailor !== null && targets.includes(localTailor.jobId) ? localTailor.receipt : factCheckReceiptId;
  /** 生效的平台：卡上刚定制出来的那一份优先（与生效版本/回执同一条口径）。 */
  const effectivePlatform =
    localTailor !== null && targets.includes(localTailor.jobId) ? localTailor.platform : platform;
  const limit = Number(dailyLimit);
  const limitValid = Number.isInteger(limit) && limit >= 1 && limit <= 10;
  const canGrant =
    effectivePlatform !== '' &&
    masterDocIdValue !== '' &&
    effectiveTailored !== '' &&
    effectiveReceipt !== '' &&
    targets.length > 0 &&
    limitValid &&
    targets.length <= limit;

  /**
   * 开一张授权单；三要素任缺一项时按钮本就禁用，这里只走合法路径。
   * @returns 无返回值
   */
  const grant = () =>
    void run(
      t('journeyAuth.actionGrant'),
      () => {
        if (!bridge) return undefined;
        // 这颗键的字面承诺是**授权并开跑**（2026-11-24 萌新「勾选授权岗位 → 授权并开跑」那条路）。
        // 旧实现只开了授权单就结束：界面上再也没有任何地方调 `journey.unattended.start`，
        // 于是人开完单看着「已授权」干等，执行器一步都不跑——这也是那格死路的一部分。
        // 现在两步连起来：开单成功就立刻把执行器带起来（开始失败照原话上浮，授权单保留，人可以再点）。
        return (async () => {
          const granted = await bridge.outbound['authorization.grant']({
            platform: effectivePlatform,
            dailyLimit: limit,
            targets,
            masterResumeVersion: masterVersion !== '' ? masterVersion : `doc:${masterDocIdValue}`,
            resumeVersion: effectiveTailored,
            factCheckReceiptId: effectiveReceipt,
          });
          if (!granted.ok) return granted;
          return bridge.journey['unattended.start']({ docId: masterDocIdValue, platform: effectivePlatform });
        })();
      },
      { describe: () => t('journeyAuth.grantStarted') },
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

  /** 从母版版本串里取 doc id（执行器要的是文档 id，不是版本串）。 */
  const masterDocId = masterVersion.startsWith('doc:') ? (masterVersion.split(':')[1] ?? '') : masterVersion;

  /**
   * 开始一轮无人值守；执行器自己按授权单顺序跑，界面只轮询进度。
   * @returns 无返回值
   */
  const startRun = () =>
    void run(t('journeyAuth.runStart'), () => bridge?.journey['unattended.start']({ docId: masterDocId }), {
      apply: (value) => setRunView(value),
    });

  /**
   * 请求执行器停止（真正的外发停止仍由停用位保证）。
   * @returns 无返回值
   */
  const stopRun = () =>
    void run(t('journeyAuth.runStop'), () => bridge?.journey['unattended.stop'](), {
      apply: (value) => setRunView(value),
    });

  /**
   * 对勾选的那一岗做一次定制（只在卡上跑，产物是版本串 + 事实校验回执）。
   * @param jobId 要定制的岗位 id
   * @returns 无返回值；失败时提示行给出原文
   */
  /** 卡上定制的收尾上限（毫秒）：没有回执就落失败 + 重试，绝不留永久进行中。 */
  const TAILOR_TIMEOUT_MS = 120_000;

  /**
   * 对勾选的岗位做一次定制，并把**三种落点**都画出来（进行中 / 失败+重试 / 成功并解锁授权）。
   *
   * 与其它按钮不同，这里不走 `useBridgeAction.run`：它把「正在做」交给那一个 `busy` 标签，
   * 而这一步最长可能永远不返回，一旦不返回整张卡的所有键都被 `disabled` 连坐（QA 复现的死路）。
   * 所以这里自己的状态机 + 120 秒收尾：超时落失败，人点「重试」再来一次。
   * @param jobId 勾选中的库内岗位
   * @returns 无返回值（结果落在 `tailorState` 与 `localTailor` 上）
   */
  const tailorJob = (jobId: string): void => {
    if (masterDocIdValue === '') {
      setNotice(t('journeyAuth.reasonNoMaster'), 'amber');
      return;
    }
    if (!bridge) {
      setNotice(t('journeyAuth.tailorNoBridge'), 'amber');
      return;
    }
    const startedAt = Date.now();
    setTailorState({ jobId, phase: 'running', startedAt });
    setTailorNow(startedAt);
    void (async () => {
      /** 120 秒没回执就按失败收尾；底层调用即使后来回来了也不再改写这一格（人已经看到失败并可以重试）。 */
      let timer: number | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(t('journeyAuth.tailorTimeout'))), TAILOR_TIMEOUT_MS);
      });
      try {
        const reply = await Promise.race([bridge.journey.tailor({ docId: masterDocIdValue, jobId }), timeout]);
        if (!reply.ok) {
          setTailorState({
            jobId,
            phase: 'failed',
            startedAt,
            errorCode: reply.error.code,
            errorText: reply.error.message,
          });
          setNotice(t('journeyAuth.tailorFailedNotice'), 'seal');
          return;
        }
        const version = reply.value.tailoredResumeVersion;
        const receipt = reply.value.factCheckReceiptId;
        if (version === null || receipt === null || receipt === '') {
          // 服务回了成功但没给定制版本/回执：这一份不能用来开授权，如实摆在卡上。
          setTailorState({ jobId, phase: 'failed', startedAt, errorText: t('journeyAuth.tailorNoVersion') });
          setNotice(t('journeyAuth.tailorFailedNotice'), 'seal');
          return;
        }
        // 平台跟着这一份定制结果一起记下来：卡上定制是**唯一**能让三要素齐的一步，
        // 而调用方传进来的 `platform` 来自「按意向搜岗」的读数——没搜过岗就是空串，
        // 空串会让「授权并开跑」永远禁用（2026-11-24 QA 的授权格死路第二半）。
        setLocalTailor({ jobId, platform: reply.value.platform, version, receipt });
        setTailorState({ jobId, phase: 'done', startedAt });
        setNotice(t('journeyAuth.tailorDoneNotice'), 'celadon');
        await reload();
      } catch (error) {
        setTailorState({
          jobId,
          phase: 'failed',
          startedAt,
          errorText: error instanceof Error ? error.message : String(error),
        });
        setNotice(t('journeyAuth.tailorFailedNotice'), 'seal');
      } finally {
        if (timer !== undefined) window.clearTimeout(timer);
      }
    })();
  };

  /** running 期间每秒刷新「已用 N 秒」。 */
  useEffect(() => {
    if (tailorState?.phase !== 'running') return;
    const timer = window.setInterval(() => setTailorNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [tailorState?.phase, tailorState?.startedAt]);

  /** 这一格已用的整秒数（非进行中时为 0）。 */
  const tailorElapsedSeconds =
    tailorState?.phase === 'running' ? Math.max(0, Math.floor((tailorNow - tailorState.startedAt) / 1000)) : 0;

  /** 定制这一步是否正占着这一岗（其余岗位的键跟着禁用，避免同一时刻两个定制在飞）。 */
  const tailorRunning = tailorState?.phase === 'running';

  const reasonNoTailor = effectiveTailored === '' || effectiveReceipt === '' ? 'JOURNEY_AUTH_NO_TAILOR' : undefined;
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
      <DeskPathGuide
        testid="auth-path-guide"
        className="mb-2"
        here={t('guide.auth.here')}
        next={t('guide.auth.next')}
        exit={t('guide.auth.exit')}
        focusSelector='[data-action="journey-auth-limit"]'
        focusLabel={t('guide.focus')}
      />
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

      <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="journey-unattended">
        <DeskButton
          action="journey-unattended-start"
          variant="jade"
          compact
          busy={!!busy}
          disabled={!!busy || auth?.status !== 'active' || runView?.status === 'running'}
          disabledReason={
            auth?.status !== 'active'
              ? 'JOURNEY_AUTH_NOT_ACTIVE'
              : runView?.status === 'running'
                ? 'JOURNEY_RUNNING'
                : busy
                  ? 'ACTION_BUSY'
                  : undefined
          }
          disabledReasonLabel={
            auth?.status !== 'active'
              ? t('journeyAuth.reasonRunNeedsAuth')
              : runView?.status === 'running'
                ? t('journeyAuth.reasonRunning')
                : busy
                  ? t('journeyAuth.reasonBusy')
                  : undefined
          }
          onClick={startRun}
        >
          {t('journeyAuth.runStart')}
        </DeskButton>
        <DeskButton
          action="journey-unattended-stop"
          variant="line"
          compact
          busy={!!busy}
          disabled={!!busy || runView?.status !== 'running'}
          disabledReason={runView?.status !== 'running' ? 'JOURNEY_NOT_RUNNING' : busy ? 'ACTION_BUSY' : undefined}
          disabledReasonLabel={
            runView?.status !== 'running'
              ? t('journeyAuth.reasonNotRunning')
              : busy
                ? t('journeyAuth.reasonBusy')
                : undefined
          }
          onClick={stopRun}
        >
          {t('journeyAuth.runStop')}
        </DeskButton>
        {/* 「停用」按不动时写原因：此刻没有在跑的一轮（spec 10.10-18）。 */}
        {runView?.status !== 'running' ? (
          <span className="text-[11px] text-slate-400" data-testid="journey-unattended-stop-reason">
            {t('journeyAuth.reasonNotRunning')}
          </span>
        ) : null}
        {/* 「开始」按不动时把原因写在明面（spec 10.10-18）：授权没开单 / 已经在跑 / 上一条没回来。 */}
        {auth?.status !== 'active' && runView?.status !== 'running' ? (
          <span className="text-[11px] text-amber" data-testid="journey-unattended-start-reason">
            {t('journeyAuth.reasonRunNeedsAuth')}
          </span>
        ) : null}
        <span
          className="text-[11px] text-slate-400"
          data-testid="journey-unattended-status"
          data-status={runView?.status ?? 'idle'}
          data-completed={String(runView?.completed.length ?? 0)}
          data-failed={String(runView?.failed.length ?? 0)}
          data-pending={String(runView?.pending.length ?? 0)}
          data-current={runView?.currentTarget ?? ''}
        >
          {t('journeyAuth.runLine', {
            status: t(`journeyAuth.runStatus.${runView?.status ?? 'idle'}`),
            completed: runView?.completed.length ?? 0,
            failed: runView?.failed.length ?? 0,
            pending: runView?.pending.length ?? 0,
          })}
        </span>
      </div>

      {notice && (
        <Banner tone={noticeTone} size="compact" markers={{ testid: 'journey-auth-notice' }} className="mt-2">
          {notice}
        </Banner>
      )}

      {/* 卡上定制的三种落点（2026-11-24 QA 死路的修法）：进行中有秒数、失败给原因码+原话+重试、
          成功把版本与回执写进卡片并解锁「授权并开跑」。**任何一态都不许把整组键钉在禁用上**：
          进行中最多 120 秒，超时自动落失败。 */}
      {tailorState === null ? null : (
        <div
          className="mt-2 rounded-md border border-line bg-ink-900/40 px-2 py-1.5"
          data-testid="journey-auth-tailor-state"
          data-phase={tailorState.phase}
          data-job-id={tailorState.jobId}
          data-elapsed-seconds={String(tailorElapsedSeconds)}
          data-error-code={tailorState.errorCode ?? ''}
        >
          <p className="break-all text-[11px] text-slate-300">
            {tailorState.phase === 'running'
              ? t('journeyAuth.tailorRunning', { seconds: tailorElapsedSeconds })
              : tailorState.phase === 'done'
                ? t('journeyAuth.tailorDoneLine', {
                    jobId: tailorState.jobId,
                    version: localTailor?.version ?? '',
                    receipt: localTailor?.receipt ?? '',
                  })
                : t('journeyAuth.tailorFailedLine', {
                    jobId: tailorState.jobId,
                    code: tailorState.errorCode ?? t('journeyAuth.tailorFailedNoCode'),
                    message: tailorState.errorText ?? '',
                  })}
          </p>
          {tailorState.phase === 'failed' ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <DeskButton
                action="journey-auth-tailor-retry"
                variant="line"
                compact
                busy={!!busy}
                disabled={!!busy || tailorRunning}
                disabledReason={tailorRunning ? 'JOURNEY_AUTH_TAILOR_RUNNING' : undefined}
                disabledReasonLabel={tailorRunning ? t('journeyAuth.reasonTailorRunning') : undefined}
                onClick={() => tailorJob(tailorState.jobId)}
              >
                {t('journeyAuth.tailorRetry')}
              </DeskButton>
            </div>
          ) : null}
        </div>
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
          data-master-version={masterDocIdValue}
          data-tailored-version={effectiveTailored}
          data-receipt={effectiveReceipt}
        >
          {/* 三要素读的是**生效值**（含卡上刚定制出来的那一份），不是调用方传进来的快照：
              旧写法在这里读 props，于是卡上定制成功后卡片仍写「定制 无 · 回执 无」，
              人看到的就是"点了没反应"（2026-11-24 QA 的授权格死路读数之一）。 */}
          {t('journeyAuth.versionLine', {
            master: masterDocIdValue === '' ? t('journeyAuth.none') : masterDocIdValue,
            tailored: effectiveTailored || t('journeyAuth.none'),
            receipt: effectiveReceipt || t('journeyAuth.none'),
          })}
        </span>
      </div>

      <div className="mt-2 flex flex-col gap-1" data-testid="journey-auth-targets">
        {/* 候选是快照，抓完岗回来必须能就地重读（2026-11-24 萌新死路的出口）。
            没有回调时不画这颗键——探针与没有这一格的面板 DOM 一字不变。 */}
        {onReloadJobs ? (
          <div className="flex flex-wrap items-center gap-2">
            <DeskButton
              action="journey-auth-reload"
              variant="line"
              compact
              busy={!!busy}
              disabled={!!busy}
              disabledReason={busy ? 'ACTION_BUSY' : undefined}
              disabledReasonLabel={busy ? t('journeyAuth.reasonBusy') : undefined}
              onClick={onReloadJobs}
            >
              {t('journeyAuth.reloadTargets')}
            </DeskButton>
            <span className="min-w-0 flex-1 text-[11px] text-slate-500">{t('journeyAuth.targetsHint')}</span>
          </div>
        ) : null}
        {jobsError === undefined ? null : (
          <p className="text-[11px] text-amber" data-testid="journey-auth-targets-error">
            {t('journeyAuth.targetsReadFailed', { message: jobsError })}
          </p>
        )}
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
              label={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1">
                    {t('journeyAuth.targetRow', { title: match.title, company: match.company })}
                  </span>
                  {/* 卡上直接定制（2026-11-24 N2）：勾了这一岗但还没有定制版本时，这颗键就是出口。 */}
                  <DeskButton
                    action={`journey-auth-tailor-${match.jobId}`}
                    variant="ghost"
                    compact
                    busy={tailorState?.phase === 'running' && tailorState.jobId === match.jobId}
                    disabled={!!busy || !targets.includes(match.jobId) || tailorRunning}
                    disabledReason={
                      !targets.includes(match.jobId)
                        ? 'JOURNEY_AUTH_NOT_SELECTED'
                        : tailorRunning
                          ? 'JOURNEY_AUTH_TAILOR_RUNNING'
                          : undefined
                    }
                    disabledReasonLabel={
                      !targets.includes(match.jobId) ? t('journeyAuth.reasonTailorNeedsSelect') : undefined
                    }
                    onClick={() => tailorJob(match.jobId)}
                  >
                    {t('journeyAuth.actionTailor')}
                  </DeskButton>
                </span>
              }
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
      {/* 停用/收回按不动时同样写出原因：没有授权单时这三颗键一起灰，只给悬停气泡等于没解释。 */}
      {auth === null ? (
        <p className="mt-1 text-[11px] text-amber" data-testid="journey-auth-controls-reason">
          {t('journeyAuth.reasonNoAuth')}
        </p>
      ) : null}
      {/* 开单键按不动时把原因写在明面（spec 10.10-18）：只在悬停气泡里说，等于让新手以为按钮坏了。 */}
      {!canGrant || busy ? (
        <p className="mt-1 text-[11px] text-amber" data-testid="journey-auth-grant-reason">
          {reasonNoTailor
            ? t('journeyAuth.reasonNoTailor')
            : targets.length === 0
              ? t('journeyAuth.reasonNoTargets')
              : !limitValid
                ? t('journeyAuth.reasonLimit')
                : targets.length > limit
                  ? t('journeyAuth.reasonOverLimit', { limit })
                  : t('journeyAuth.reasonBusy')}
        </p>
      ) : null}
    </div>
  );
}
