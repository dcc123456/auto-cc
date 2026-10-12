import { Compass, KeyRound, LogOut, Radar, RefreshCw, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  KernelPageSnapshotView,
  KernelViewLoadError,
  SessionExpiredEvent,
  SessionPlatformView,
  SessionsStatusView,
  ShellStatus,
} from '@auto-cc/shared';
import {
  Banner,
  BLOCK_EDGE_CLASS,
  BLOCK_SURFACE_CLASS,
  DeskButton,
  DeskField,
  HAIRLINE_ROW_CLASS,
  Tag,
  type BannerTone,
} from './ui/controls';
import { DeskExplainer, DeskSection } from './ui/disclosure';
import { useBridgeAction } from './useBridgeAction';
import { reportDeskPlatforms } from './deskStatus';
import { formatClock } from './format';

/** 失效事件最多留几条：面板是验收入口，不是历史库。 */
const EXPIRED_LIMIT = 3;

/**
 * 登录态 → 语气档（03 稿的四色归属）：已核到登录态是"读回来的好消息"= 青玉，
 * 失效是"这件事现在得人来办"= 琥珀；不用 rose，朱砂只留给外发与不可逆。
 * 存 tone 名而不是 class 串：wash 字面量从此只在 `src/ui/**` 里（6.2-19），
 * 面板只负责说"这一格是哪一档"。
 */
const AUTH_TONE: Record<SessionPlatformView['auth'], BannerTone> = {
  active: 'jade',
  expired: 'amber',
  // 判不准不是"得人来办"（那一档是琥珀），也不是好消息；青玉/琥珀都不许借用，
  // 否则界面上就把"程序没有证据说话"读成了"要么登录着、要么等人重登"（spec 8.2-01）。
  unknown: 'celadon',
};

/**
 * 会话面板：内置内核的分区、落盘位置、cookie 名与登录判定（spec 1.8），以及内核页面的一次读取（spec 2.1-03）。
 *
 * 它是 `sessions.*` 五个能力的界面化身，也是仓库里第一个订阅**领域事件**的面板：
 * 失效横幅来自 `session/expired` 推送，不是轮询出来的（spec 1.8-06）。
 * 每次动作之后都重读快照，所以界面上永远是主进程当下的真相。
 * 「内核页面」那一段只把主进程读回的串画出来，不在这里解析 DOM——页面语义属于服务层。
 */
export function SessionPanel() {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<SessionsStatusView>();
  const [shell, setShell] = useState<ShellStatus>();
  const [expired, setExpired] = useState<SessionExpiredEvent[]>();
  const [viewError, setViewError] = useState<KernelViewLoadError | null>(null);
  const [page, setPage] = useState<KernelPageSnapshotView | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  const bridge = window.autoCC;

  const read = useCallback(async () => {
    const [sessionsReply, shellReply] = await Promise.all([bridge?.sessions.status(), bridge?.shell.getStatus()]);
    if (sessionsReply?.ok) {
      setSnapshot(sessionsReply.value);
      // 状态条那一项跟着本面板的读数走：这里报一次，界面就不必为它单开一条调用（spec 6.3-05）。
      reportDeskPlatforms(sessionsReply.value.platforms);
    }
    if (shellReply?.ok) {
      setShell(shellReply.value);
      setViewError(shellReply.value.kernelViewLoadError);
    }
  }, [bridge]);

  const { busy, notice, noticeTone, resultOf, run } = useBridgeAction(read);

  /**
   * 六只动作的标签。这一串同时是 `run` 的提示文案凭据**与**结果态的归属键（07 稿五态的第四、五态），
   * 所以两处必须取同一个串——写成一份，按钮那边只问不猜（§2.2）。
   * 平台名进标签，于是「探测 fixture-alt 成功」只点亮那一行的按钮，不点亮别的平台。
   */
  const actionLabel = {
    open: (id: string) => t('session.actionOpen', { id }),
    probe: (id: string) => t('session.actionProbe', { id }),
    logout: (id: string) => t('session.actionLogout', { id }),
    close: () => t('session.actionClose'),
    snapshot: () => t('session.actionSnapshot'),
    navigate: () => t('session.actionNavigate'),
  };

  useEffect(() => {
    void read();
  }, [read]);

  useEffect(() => {
    if (!bridge) return;
    const offExpired = bridge.on('session/expired', (payload) => {
      setExpired((current) => [payload, ...(current ?? [])].slice(0, EXPIRED_LIMIT));
    });
    // 加载失败发生在 `sessions.open` 返回之后，所以错误态只能由推送补上（spec 1.8-09）。
    const offViewError = bridge.on('shell/view-error', setViewError);
    return () => {
      offExpired();
      offViewError();
    };
  }, [bridge]);

  /**
   * 把单个平台的最新读数合进快照。
   * @param view 刚读到的平台视图（`probe` / `logout` 的返回）
   */
  const mergePlatform = (view: SessionPlatformView) =>
    setSnapshot((current) => ({
      platforms: (current?.platforms ?? []).map((item) => (item.id === view.id ? view : item)),
      activePlatform: current?.activePlatform ?? null,
    }));

  const open = (platform: string) =>
    void run(actionLabel.open(platform), () => bridge?.sessions.open(platform), {
      apply: setSnapshot,
    });

  const probe = (platform: string) =>
    void run(actionLabel.probe(platform), () => bridge?.sessions.probe(platform), {
      apply: mergePlatform,
    });

  const logout = (platform: string) =>
    void run(actionLabel.logout(platform), () => bridge?.sessions.logout(platform), {
      apply: mergePlatform,
    });

  /** 收回站点页面：分区读数归快照，页面读数则当场作废——视图里已经换回占位页了。 */
  const closeView = () =>
    void run(actionLabel.close(), () => bridge?.sessions.close(), {
      apply: (value) => {
        setSnapshot(value);
        setPage(null);
      },
    });

  const readPage = () =>
    void run(actionLabel.snapshot(), () => bridge?.browser['page.snapshot'](), {
      apply: setPage,
    });

  /** 导航成功后返回的就是落地页的快照，直接落进本面板，省掉一次「点了但看不见」的等待。 */
  const navigate = () =>
    void run(actionLabel.navigate(), () => bridge?.browser['page.navigate'](urlDraft.trim()), {
      apply: setPage,
    });

  /**
   * 「导航」按不动的原因是哪一个（6.2-06）：先说在飞的这一条，再说地址没填。
   * 判据直接取调用点已有的两个条件，不在界面另数一遍（§2.5）。
   */
  const navigateReason = busy !== undefined ? 'ACTION_BUSY' : urlDraft.trim() === '' ? 'URL_EMPTY' : undefined;
  const navigateReasonLabel =
    navigateReason === 'ACTION_BUSY'
      ? t('session.reasonBusy')
      : navigateReason === 'URL_EMPTY'
        ? t('session.reasonUrlEmpty')
        : undefined;

  return (
    <>
      <DeskSection
        id="trust.sessions"
        defaultOpen
        markers={{ testid: 'session-panel' }}
        title={t('session.heading')}
        summary={
          <span data-stat="kernel-view">
            {t('session.viewUrl', { url: shell?.kernelViewUrl || t('session.viewIdle') })}
            {' · '}
            {t('session.viewPartition', { partition: shell?.kernelViewPartition || t('session.viewIdle') })}
            {' · '}
            {t('session.active', { id: snapshot?.activePlatform ?? t('session.none') })}
          </span>
        }
        actions={
          <>
            <DeskButton
              action="close-view"
              variant="ghost"
              compact
              disabled={!!busy}
              disabledReason={busy !== undefined ? 'ACTION_BUSY' : undefined}
              disabledReasonLabel={busy !== undefined ? t('session.reasonBusy') : undefined}
              result={resultOf(actionLabel.close())}
              doneLabel={t('desk.done.closedView')}
              onClick={closeView}
            >
              <LogOut size={12} />
              {t('session.close')}
            </DeskButton>
            <DeskButton
              action="refresh"
              variant="line"
              compact
              disabled={!!busy}
              disabledReason={busy !== undefined ? 'ACTION_BUSY' : undefined}
              disabledReasonLabel={busy !== undefined ? t('session.reasonBusy') : undefined}
              onClick={() => void read()}
            >
              <RefreshCw size={12} />
              {t('session.refresh')}
            </DeskButton>
          </>
        }
      >
        {viewError && (
          <Banner tone="seal" size="compact" markers={{ stat: 'view-error' }} className="break-all">
            {t('session.viewError', { code: viewError.code, description: viewError.description, url: viewError.url })}
          </Banner>
        )}

        {(expired?.length ?? 0) > 0 && (
          <ul className="mt-2 flex flex-col gap-1" data-testid="session-expired">
            {(expired ?? []).map((event, index) => (
              <li
                key={`${event.platform}-${String(index)}`}
                data-expired-platform={event.platform}
                className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-[11px] ${BLOCK_EDGE_CLASS.amber} ${BLOCK_SURFACE_CLASS} text-amber`}
              >
                <ShieldAlert size={12} />
                {t('session.expiredBanner', {
                  id: event.platform,
                  reason: t(`session.reason.${event.reason}`),
                  at: new Date(event.at).toLocaleTimeString(),
                })}
              </li>
            ))}
          </ul>
        )}

        {notice && (
          <Banner tone={noticeTone} size="compact" markers={{ testid: 'session-notice' }} className="mt-2">
            {notice}
          </Banner>
        )}

        {/* 一个平台一行：名字与状态在左、动作组贴右，元信息跟在名字后面。
            旧版把落盘路径与 cookie 名摊在行里（一条 percent-encoded 长串 + 十几个 cookie 名），
            三行灰字比平台名还显眼——那是取证明细，不是决策信息，挪到下面那一格按需展开。 */}
        <ul className="mt-2 flex flex-col" data-testid="session-list">
          {(snapshot?.platforms ?? []).map((platform) => (
            <li key={platform.id} data-session-id={platform.id} className={HAIRLINE_ROW_CLASS}>
              <span className="font-mono text-xs text-slate-200">{platform.id}</span>
              <Tag tone={AUTH_TONE[platform.auth]}>{t(`session.auth.${platform.auth}`)}</Tag>
              <span className="text-[11px] text-slate-500">
                {platform.isPersistent ? t('session.persistent') : t('session.inMemory')}
                {' · '}
                {/* `unknown` 没有期限可报：写成「无期限」会把"证据不够"谎报成"永远有效"（spec 8.2-01）。 */}
                {platform.auth === 'unknown'
                  ? t('session.unknownHint')
                  : t('session.expiresAt', { time: formatClock(platform.expiresAt, t('session.noExpiry')) })}
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                <DeskButton
                  action="open"
                  variant="solid"
                  compact
                  disabled={!!busy}
                  disabledReason={busy !== undefined ? 'ACTION_BUSY' : undefined}
                  disabledReasonLabel={busy !== undefined ? t('session.reasonBusy') : undefined}
                  result={resultOf(actionLabel.open(platform.id))}
                  doneLabel={t('desk.done.opened')}
                  onClick={() => open(platform.id)}
                >
                  <KeyRound size={12} />
                  {t('session.open')}
                </DeskButton>
                <DeskButton
                  action="probe"
                  variant="line"
                  compact
                  disabled={!!busy}
                  disabledReason={busy !== undefined ? 'ACTION_BUSY' : undefined}
                  disabledReasonLabel={busy !== undefined ? t('session.reasonBusy') : undefined}
                  result={resultOf(actionLabel.probe(platform.id))}
                  doneLabel={t('desk.done.probed')}
                  onClick={() => probe(platform.id)}
                >
                  <Radar size={12} />
                  {t('session.probe')}
                </DeskButton>
                {/* 退出登录清的是本机那份会话，动完就回不去——朱砂那一档正是"风险/不可逆"。 */}
                <DeskButton
                  action="logout"
                  variant="seal"
                  compact
                  disabled={!!busy}
                  disabledReason={busy !== undefined ? 'ACTION_BUSY' : undefined}
                  disabledReasonLabel={busy !== undefined ? t('session.reasonBusy') : undefined}
                  result={resultOf(actionLabel.logout(platform.id))}
                  doneLabel={t('desk.done.loggedOut')}
                  onClick={() => logout(platform.id)}
                >
                  <LogOut size={12} />
                  {t('session.logout')}
                </DeskButton>
              </span>
            </li>
          ))}
          {(snapshot?.platforms.length ?? 0) === 0 && <li className="text-xs text-slate-400">{t('session.empty')}</li>}
        </ul>

        {(snapshot?.platforms.length ?? 0) > 0 && (
          <DeskExplainer className="mt-2" id="trust.sessions.detail" label={t('session.detailToggle')}>
            <ul className="flex flex-col gap-1">
              {(snapshot?.platforms ?? []).map((platform) => (
                <li key={platform.id} className="break-all font-mono text-[11px] text-slate-400">
                  {platform.id}：{t('session.partition', { name: platform.partition })}
                  {' · '}
                  {t('session.storagePath', { path: platform.storagePath ?? t('session.none') })}
                  {' · '}
                  {t('session.cookieNames', { names: platform.cookieNames.join(', ') || t('session.none') })}
                </li>
              ))}
            </ul>
          </DeskExplainer>
        )}
      </DeskSection>

      <DeskSection
        id="trust.page"
        defaultOpen
        markers={{ testid: 'kernel-page' }}
        title={t('session.pageHeading')}
        summary={page ? t('session.snapshotSummary', { title: page.title }) : t('session.snapshotIdle')}
        actions={
          <DeskButton
            action="snapshot"
            variant="line"
            compact
            disabled={!!busy}
            disabledReason={busy !== undefined ? 'ACTION_BUSY' : undefined}
            disabledReasonLabel={busy !== undefined ? t('session.reasonBusy') : undefined}
            result={resultOf(actionLabel.snapshot())}
            doneLabel={t('desk.done.snapshotted')}
            onClick={readPage}
          >
            <RefreshCw size={12} />
            {t('session.snapshot')}
          </DeskButton>
        }
      >
        <div className="flex items-center gap-2">
          <DeskField
            action="navigate-url"
            data-testid="navigate-url"
            value={urlDraft}
            onValueChange={setUrlDraft}
            placeholder={t('session.navigatePlaceholder')}
            className="flex-1"
          />
          <DeskButton
            action="navigate"
            variant="solid"
            compact
            disabled={!!busy || urlDraft.trim() === ''}
            disabledReason={navigateReason}
            disabledReasonLabel={navigateReasonLabel}
            result={resultOf(actionLabel.navigate())}
            doneLabel={t('desk.done.navigated')}
            onClick={navigate}
          >
            <Compass size={12} />
            {t('session.navigate')}
          </DeskButton>
        </div>

        {page ? (
          <div className="mt-2 flex flex-col gap-1">
            <p className="text-[11px] text-slate-300" data-testid="page-snapshot">
              {t('session.snapshotReading', {
                title: page.title,
                readyState: page.readyState,
                elements: page.elementCount,
                textLength: page.textLength,
                bodyLength: page.bodyText.length,
                headings: page.headings.length,
              })}
            </p>
            <p
              className="break-all text-[11px] text-slate-500"
              data-page-url={page.url}
              data-page-partition={page.partition}
            >
              {t('session.snapshotUrl', { url: page.url, partition: page.partition || t('session.viewIdle') })}
            </p>
            {page.headings.length > 0 && (
              <p className="break-all text-[11px] text-slate-400" data-testid="page-headings">
                {t('session.snapshotHeadings', { items: page.headings.join(' / ') })}
              </p>
            )}
            <pre
              className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-ink-950/70 px-2 py-1 text-[11px] text-slate-400"
              data-page-body={String(page.bodyText.length)}
            >
              {page.bodyText}
            </pre>
          </div>
        ) : null}
      </DeskSection>
    </>
  );
}
