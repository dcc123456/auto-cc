import { Bug, PanelRightClose, PanelRightOpen, Plus, RefreshCw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RENDERER_ALLOWLIST, type BridgeReply, type RendererBridge, type ShellStatus } from '@auto-cc/shared';

/** 统计 `window.autoCC` 上真实存在的函数数量，用于对照白名单长度。 */
const countBridgeMethods = (bridge: RendererBridge): number =>
  Object.values(bridge as unknown as Record<string, Record<string, unknown>>)
    .flatMap((group) => Object.values(group))
    .filter((value) => typeof value === 'function').length;

const requireIsUndefined = (): boolean => typeof (globalThis as { require?: unknown }).require === 'undefined';

type Reply = { kind: 'rejected' | 'captured' | 'escaped'; message: string };

/**
 * 桥接自检面板：状态读取、本地 state 变更、非法调用拒绝、主进程错误捕获、内核视图显隐。
 * 这些按钮同时是 1.2 的验收入口，自动化 harness 直接点击它们取证据。
 */
export function ShellPanel() {
  const { t } = useTranslation();
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState<ShellStatus | undefined>();
  const [reply, setReply] = useState<Reply | undefined>();
  const bridge = window.autoCC;
  const visibleMethods = bridge ? countBridgeMethods(bridge) : 0;

  const readStatus = async () => {
    const result = await bridge?.shell.getStatus();
    if (result?.ok) setStatus(result.value);
  };

  const callIllegal = async () => {
    const outer = await bridge?.shell.probeIllegalCall();
    const inner = outer?.ok ? (outer.value as BridgeReply<unknown>) : undefined;
    if (inner && !inner.ok) setReply({ kind: 'rejected', message: inner.error });
    else if (outer && !outer.ok) setReply({ kind: 'rejected', message: outer.error });
    else setReply({ kind: 'escaped', message: t('result.idle') });
  };

  const crashMain = async () => {
    const result = await bridge?.shell.probeMainCrash();
    if (result && !result.ok) setReply({ kind: 'captured', message: result.error });
    await readStatus();
  };

  const toggleKernel = async () => {
    await bridge?.shell.setKernelViewVisible(!(status?.kernelViewVisible ?? true));
    await readStatus();
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-200">{t('status.heading')}</h2>
          <button
            type="button"
            onClick={() => void readStatus()}
            className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
          >
            <RefreshCw size={14} />
            {t('status.refresh')}
          </button>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-400">
          <dt>{t('status.app')}</dt>
          <dd className="text-right text-slate-200">{status?.appVersion ?? t('status.idle')}</dd>
          <dt>{t('status.electron')}</dt>
          <dd className="text-right text-slate-200">{status?.electronVersion ?? t('status.idle')}</dd>
          <dt>{t('status.node')}</dt>
          <dd className="text-right text-slate-200">{status?.nodeVersion ?? t('status.idle')}</dd>
          <dt>{t('status.platform')}</dt>
          <dd className="text-right text-slate-200">{status?.platform ?? t('status.idle')}</dd>
          <dt>{t('status.windowVisible')}</dt>
          <dd className="text-right text-slate-200">
            {status === undefined ? t('status.idle') : String(status.windowVisible)}
          </dd>
          <dt>{t('status.kernelView')}</dt>
          <dd className="text-right text-slate-200">
            {status ? `${status.kernelViewBounds.width}x${status.kernelViewBounds.height}` : t('status.idle')}
          </dd>
          <dt>{t('status.lastError')}</dt>
          <dd className="text-right text-red-300">{status?.lastError ?? t('status.none')}</dd>
        </dl>
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-sm font-semibold text-slate-200">{t('probe.heading')}</h2>
        {!bridge && <p className="mt-2 text-xs text-amber-400">{t('probe.bridgeMissing')}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setCount((value) => value + 1)}
            className="flex items-center gap-1 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
          >
            <Plus size={14} />
            {t('probe.increment')}
          </button>
          <button
            type="button"
            onClick={() => void callIllegal()}
            className="flex items-center gap-1 rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
          >
            <ShieldAlert size={14} />
            {t('probe.illegalCall')}
          </button>
          <button
            type="button"
            onClick={() => void crashMain()}
            className="flex items-center gap-1 rounded-md border border-rose-800 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-950"
          >
            <Bug size={14} />
            {t('probe.mainCrash')}
          </button>
          <button
            type="button"
            onClick={() => void toggleKernel()}
            className="flex items-center gap-1 rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
          >
            {status?.kernelViewVisible === false ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
            {status?.kernelViewVisible === false ? t('probe.kernelShow') : t('probe.kernelHide')}
          </button>
        </div>
        <ul className="mt-3 space-y-1 text-xs text-slate-400">
          <li>{t('probe.count', { count })}</li>
          <li>{t('probe.bridgeMethods', { visible: visibleMethods, allowlist: RENDERER_ALLOWLIST.length })}</li>
          <li>{t('probe.requireUndefined', { value: String(requireIsUndefined()) })}</li>
        </ul>
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-sm font-semibold text-slate-200">{t('result.heading')}</h2>
        <p
          className={`mt-2 break-all text-xs ${
            reply?.kind === 'captured'
              ? 'text-rose-300'
              : reply?.kind === 'escaped'
                ? 'text-amber-400'
                : 'text-slate-400'
          }`}
        >
          {reply ? t(`result.${reply.kind}`, { message: reply.message }) : t('result.idle')}
        </p>
      </section>
    </div>
  );
}
