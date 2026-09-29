import { KeyRound, LogOut, Radar, RefreshCw, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  KernelViewLoadError,
  SessionExpiredEvent,
  SessionPlatformView,
  SessionsStatusView,
  ShellStatus,
} from '@auto-cc/shared';
import { useBridgeAction } from './useBridgeAction';

/** 失效事件最多留几条：面板是验收入口，不是历史库。 */
const EXPIRED_LIMIT = 3;

/** 登录态 → 颜色：只用 Tailwind 静态类名，运行期拼类名会让样式缺失。 */
const AUTH_CLASS: Record<SessionPlatformView['auth'], string> = {
  active: 'bg-emerald-950 text-emerald-300 border-emerald-800',
  expired: 'bg-amber-950 text-amber-300 border-amber-800',
};

/** 时间戳 → 本地可读时间；null（会话型 cookie）显示「无期限」。 */
const formatExpiry = (ms: number | null, noneLabel: string): string =>
  ms === null ? noneLabel : new Date(ms).toLocaleString();

/**
 * 会话面板：内置内核的分区、落盘位置、cookie 名与登录判定（spec 1.8）。
 *
 * 它是 `sessions.*` 四个能力的界面化身，也是仓库里第一个订阅**领域事件**的面板：
 * 失效横幅来自 `session/expired` 推送，不是轮询出来的（spec 1.8-06）。
 * 每次动作之后都重读快照，所以界面上永远是主进程当下的真相。
 */
export function SessionPanel() {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<SessionsStatusView>();
  const [shell, setShell] = useState<ShellStatus>();
  const [expired, setExpired] = useState<SessionExpiredEvent[]>();
  const [viewError, setViewError] = useState<KernelViewLoadError | null>(null);
  const bridge = window.autoCC;

  const read = useCallback(async () => {
    const [sessionsReply, shellReply] = await Promise.all([bridge?.sessions.status(), bridge?.shell.getStatus()]);
    if (sessionsReply?.ok) setSnapshot(sessionsReply.value);
    if (shellReply?.ok) {
      setShell(shellReply.value);
      setViewError(shellReply.value.kernelViewLoadError);
    }
  }, [bridge]);

  const { busy, notice, run } = useBridgeAction(read);

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
    void run(t('session.actionOpen', { id: platform }), () => bridge?.sessions.open(platform), {
      apply: setSnapshot,
    });

  const probe = (platform: string) =>
    void run(t('session.actionProbe', { id: platform }), () => bridge?.sessions.probe(platform), {
      apply: mergePlatform,
    });

  const logout = (platform: string) =>
    void run(t('session.actionLogout', { id: platform }), () => bridge?.sessions.logout(platform), {
      apply: mergePlatform,
    });

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
            <KeyRound size={16} />
            {t('session.heading')}
          </h2>
          <button
            type="button"
            data-action="refresh"
            onClick={() => void read()}
            className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            <RefreshCw size={14} />
            {t('session.refresh')}
          </button>
        </div>

        {/* 内核视图地址是 percent-encoded 的长串，没有断行点：不 break-all 就会把整页撑出横向滚动条。 */}
        <p className="mt-2 break-all text-[11px] text-slate-500" data-stat="kernel-view">
          {t('session.viewUrl', { url: shell?.kernelViewUrl || t('session.viewIdle') })}
          {' · '}
          {t('session.viewPartition', { partition: shell?.kernelViewPartition || t('session.viewIdle') })}
          {' · '}
          {t('session.active', { id: snapshot?.activePlatform ?? t('session.none') })}
        </p>

        {viewError && (
          <p
            className="mt-2 break-all rounded-md border border-rose-800 bg-rose-950 px-3 py-2 text-[11px] text-rose-300"
            data-stat="view-error"
          >
            {t('session.viewError', { code: viewError.code, description: viewError.description, url: viewError.url })}
          </p>
        )}

        {(expired?.length ?? 0) > 0 && (
          <ul className="mt-2 flex flex-col gap-1" data-testid="session-expired">
            {(expired ?? []).map((event, index) => (
              <li
                key={`${event.platform}-${String(index)}`}
                data-expired-platform={event.platform}
                className="flex items-center gap-2 rounded-md border border-amber-800 bg-amber-950 px-3 py-2 text-[11px] text-amber-300"
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
          <p
            className="mt-2 rounded-md border border-slate-700 bg-slate-950/70 px-3 py-2 text-[11px] text-slate-300"
            data-testid="session-notice"
          >
            {notice}
          </p>
        )}

        <ul className="mt-3 flex flex-col gap-2">
          {(snapshot?.platforms ?? []).map((platform) => (
            <li
              key={platform.id}
              data-session-id={platform.id}
              className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-slate-200">{platform.id}</span>
                  <span className={`rounded border px-1.5 py-0.5 text-[11px] ${AUTH_CLASS[platform.auth]}`}>
                    {t(`session.auth.${platform.auth}`)}
                  </span>
                  <span className="text-[11px] text-slate-500">
                    {platform.isPersistent ? t('session.persistent') : t('session.inMemory')}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    data-action="open"
                    disabled={!!busy}
                    onClick={() => open(platform.id)}
                    className="flex items-center gap-1 rounded-md border border-sky-800 px-2 py-1 text-[11px] text-sky-300 hover:bg-sky-950 disabled:opacity-40"
                  >
                    <KeyRound size={12} />
                    {t('session.open')}
                  </button>
                  <button
                    type="button"
                    data-action="probe"
                    disabled={!!busy}
                    onClick={() => probe(platform.id)}
                    className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
                  >
                    <Radar size={12} />
                    {t('session.probe')}
                  </button>
                  <button
                    type="button"
                    data-action="logout"
                    disabled={!!busy}
                    onClick={() => logout(platform.id)}
                    className="flex items-center gap-1 rounded-md border border-rose-800 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-950 disabled:opacity-40"
                  >
                    <LogOut size={12} />
                    {t('session.logout')}
                  </button>
                </div>
              </div>
              <p className="mt-1 break-all text-[11px] text-slate-500">
                {t('session.partition', { name: platform.partition })}
                {' · '}
                {t('session.storagePath', { path: platform.storagePath ?? t('session.none') })}
              </p>
              <p className="mt-1 break-all text-[11px] text-slate-500">
                {t('session.cookieNames', { names: platform.cookieNames.join(', ') || t('session.none') })}
                {' · '}
                {t('session.expiresAt', {
                  time: formatExpiry(platform.expiresAt, t('session.noExpiry')),
                })}
              </p>
            </li>
          ))}
          {(snapshot?.platforms.length ?? 0) === 0 && <li className="text-xs text-slate-500">{t('session.empty')}</li>}
        </ul>
      </section>
    </div>
  );
}
