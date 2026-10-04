import { Download, RefreshCw, Rocket } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UpdateState, UpdateView } from '@auto-cc/shared';

/**
 * 状态枚举 → 语言包键后缀。
 *
 * 状态机在主进程一侧（`packages/shell/src/update.ts`），这里只负责把枚举翻成人看得懂的一句话；
 * 上游原话（`detail`）属于数据不属于文案，原样显示、不翻译。
 * @param state 更新通道读数里的状态
 * @returns `update.state.<state>` 形态的键
 */
const stateKey = (state: UpdateState): string => `update.state.${state}`;

/** 一次动作之后怎么落状态：成功取读数，失败只留一句原话（判据要求"失败不阻塞使用"）。 */
type UpdateActionName = 'check' | 'download' | 'install';

/**
 * 更新通道区块（spec 5.9-03）：三条按钮各对应用户的一次表态。
 *
 * 为什么不塞进 `ShellPanel`：那块面板是 1.4 的桥接自检台，按钮都是"演示一次主进程行为"；
 * 这里是有一格状态机要维护的常驻读数，混在一起会让自检台长出第二套状态（§2.6 尽可能简洁）。
 * @returns 诊断视图里的「更新」小节
 */
export function UpdateSection() {
  const { t } = useTranslation();
  const bridge = window.autoCC;
  const [view, setView] = useState<UpdateView | undefined>();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * 调用一条更新口并把读数收进本地 state。
   * @param action 要调的那条口；渲染层不自己判状态机，被拒也由主进程回话
   */
  const run = async (action: UpdateActionName): Promise<void> => {
    if (!bridge) return;
    setBusy(true);
    setFailure(null);
    const reply = await bridge.update[action]();
    if (reply.ok) setView(reply.value);
    else setFailure([reply.error.code, reply.error.message].filter(Boolean).join(' · '));
    setBusy(false);
  };

  const stateLine = () => {
    if (!view) return t('update.idle');
    if (view.state === 'available')
      return t('update.available', { latest: view.latestVersion, current: view.currentVersion });
    if (view.state === 'downloaded') return t('update.downloaded', { latest: view.latestVersion });
    if (view.state === 'failed') return t('update.failed', { detail: view.detail ?? '' });
    return t(stateKey(view.state));
  };

  return (
    <section
      className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"
      data-testid="update-section"
      data-update-state={view?.state ?? 'idle'}
    >
      <h2 className="text-sm font-semibold text-slate-200">{t('update.heading')}</h2>
      <p className="mt-1 text-xs text-slate-500">{t('update.note')}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          data-action="update-check"
          disabled={busy}
          onClick={() => void run('check')}
          className="flex items-center gap-1 rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
        >
          <RefreshCw size={14} />
          {t('update.check')}
        </button>
        {view?.state === 'available' && (
          <button
            type="button"
            data-action="update-download"
            disabled={busy}
            onClick={() => void run('download')}
            className="flex items-center gap-1 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            <Download size={14} />
            {t('update.download')}
          </button>
        )}
        {view?.state === 'downloaded' && (
          <button
            type="button"
            data-action="update-install"
            disabled={busy}
            onClick={() => void run('install')}
            className="flex items-center gap-1 rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            <Rocket size={14} />
            {t('update.install')}
          </button>
        )}
      </div>
      <ul className="mt-3 space-y-1 text-xs text-slate-400">
        <li data-testid="update-state">{stateLine()}</li>
        {/* 版本号只在真的问过运行期之后才有值：`no-feed` 与 `idle` 两态下更新器单连都没解析，
            此时渲染一条「当前版本 」空尾巴看起来像坏了，所以没值就不出现。 */}
        {!!view?.currentVersion && <li>{t('update.currentVersion', { version: view.currentVersion })}</li>}
        {failure && <li className="break-all text-rose-300">{t('update.rejected', { message: failure })}</li>}
      </ul>
    </section>
  );
}
