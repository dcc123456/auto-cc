import { Bug, PanelRightClose, PanelRightOpen, Plus, RefreshCw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RENDERER_ALLOWLIST, type AppErrorPayload, type RendererBridge, type ShellStatus } from '@auto-cc/shared';
import { Banner, DeskButton } from './ui/controls';

/** 统计 `window.autoCC` 上真实存在的函数数量，用于对照白名单长度。 */
const countBridgeMethods = (bridge: RendererBridge): number =>
  Object.values(bridge as unknown as Record<string, Record<string, unknown>>)
    // 顶层只有命名空间对象与 `on`；对函数取 `Object.values` 得空数组，因此 `on` 不计数。
    .flatMap((group) => Object.values(group))
    .filter((value) => typeof value === 'function').length;

/** 结构化错误 → 一行可读文本：code 与 path 是 ASCII，message 由主进程给出。 */
const describeError = (error: AppErrorPayload): string =>
  [error.code, error.path, error.message].filter(Boolean).join(' · ');

const requireIsUndefined = (): boolean => typeof (globalThis as { require?: unknown }).require === 'undefined';

type Reply = { kind: 'rejected' | 'captured' | 'escaped'; message: string };

/**
 * 桥接自检面板：状态读取、本地 state 变更、非法调用拒绝、主进程错误捕获、内核视图显隐。
 * 这些按钮同时是 1.2 / 1.4 的验收入口，自动化 harness 直接点击它们取证据。
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

  /**
   * 让主进程按一个未登记的 path 走一遍网关（spec 1.4-04 / 1.4-07）。
   *
   * 白名单外的能力在界面上根本不存在，所以只能请主进程演示它自己的拒绝。
   * 选一个「服务在、但这个能力从来没有过」的名字，避免误调到真实方法。
   */
  const callIllegal = async () => {
    const result = await bridge?.ipc.probeReject('shell.readFile');
    // 没有桥接（不在 Electron 宿主里）时这次调用根本没发生，不记结果。
    if (!result) return;
    // 正常结论是 ok:false + NOT_IN_ALLOWLIST；若网关放行了未登记的能力，就是白名单失守。
    setReply(
      result.ok
        ? { kind: 'escaped', message: `${result.value === undefined ? 'undefined' : JSON.stringify(result.value)}` }
        : { kind: 'rejected', message: describeError(result.error) },
    );
  };

  const crashMain = async () => {
    const result = await bridge?.shell.probeMainCrash();
    if (result && !result.ok) setReply({ kind: 'captured', message: describeError(result.error) });
    await readStatus();
  };

  const toggleKernel = async () => {
    // 兜底值跟主进程一致（裁定⑱ 之后默认是收起的）：还没读到状态时按「现在看不见」算，
    // 于是这一颗按下是展开而不是把一个已经展开的视图再展开一次。
    await bridge?.shell.setKernelViewVisible(!(status?.kernelViewVisible ?? false));
    await readStatus();
  };

  /**
   * 桥接缺席（不在 Electron 宿主里渲染）时，四只动作口都会**静默**不动——`bridge?.x()` 拿到
   * undefined，界面上什么也没发生，看起来像按钮坏了。禁用并把原因挂到节点上，才算说了实话。
   * 「加一」不吃这个码：它只改本地 state，没有桥接照样能用。
   */
  const bridgeReason = bridge === undefined ? 'BRIDGE_MISSING' : undefined;
  const reasonLabel = (code?: string): string | undefined =>
    code === undefined ? undefined : t(`probe.reason.${code}`);

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-line bg-ink-900/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-200">{t('status.heading')}</h2>
          <DeskButton
            action="status-refresh"
            variant="line"
            compact
            disabled={bridgeReason !== undefined}
            disabledReason={bridgeReason}
            disabledReasonLabel={reasonLabel(bridgeReason)}
            onClick={() => void readStatus()}
          >
            <RefreshCw size={14} />
            {t('status.refresh')}
          </DeskButton>
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
          {/* 「没有错误」不能用失败色画：那是把安全说成风险，同一行两种意思要两种颜色 */}
          <dd className={`text-right ${status?.lastError ? 'text-seal' : 'text-slate-200'}`}>
            {status?.lastError ?? t('status.none')}
          </dd>
        </dl>
      </section>

      <section className="rounded-xl border border-line bg-ink-900/60 p-4">
        <h2 className="text-sm font-semibold text-slate-200">{t('probe.heading')}</h2>
        {!bridge && (
          <Banner tone="amber" className="mt-2">
            {t('probe.bridgeMissing')}
          </Banner>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {/* 归属色按「这个动作动到谁」分，与流程屏同一句规则（plan §5）：
              加一只纯本地计数器 → `solid`（中性强调，不带语义）；
              「非法调用」只是请主进程演示它自己的拒绝，一行都不写 → `line`；
              内核视图显隐改的是本机运行期状态 → `amber`；
              「主进程崩溃」打死整个进程，这一轮会话再也回不来 → `seal`（本屏唯一给朱砂的口）。 */}
          <DeskButton action="probe-increment" variant="solid" compact onClick={() => setCount((value) => value + 1)}>
            <Plus size={14} />
            {t('probe.increment')}
          </DeskButton>
          <DeskButton
            action="probe-illegal-call"
            variant="line"
            compact
            disabled={bridgeReason !== undefined}
            disabledReason={bridgeReason}
            disabledReasonLabel={reasonLabel(bridgeReason)}
            onClick={() => void callIllegal()}
          >
            <ShieldAlert size={14} />
            {t('probe.illegalCall')}
          </DeskButton>
          <DeskButton
            action="probe-main-crash"
            variant="seal"
            compact
            disabled={bridgeReason !== undefined}
            disabledReason={bridgeReason}
            disabledReasonLabel={reasonLabel(bridgeReason)}
            onClick={() => void crashMain()}
          >
            <Bug size={14} />
            {t('probe.mainCrash')}
          </DeskButton>
          <DeskButton
            action="probe-kernel-toggle"
            variant="amber"
            compact
            disabled={bridgeReason !== undefined}
            disabledReason={bridgeReason}
            disabledReasonLabel={reasonLabel(bridgeReason)}
            onClick={() => void toggleKernel()}
          >
            {status?.kernelViewVisible === false ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
            {status?.kernelViewVisible === false ? t('probe.kernelShow') : t('probe.kernelHide')}
          </DeskButton>
        </div>
        <ul className="mt-3 space-y-1 text-xs text-slate-400">
          <li>{t('probe.count', { count })}</li>
          <li>{t('probe.bridgeMethods', { visible: visibleMethods, allowlist: RENDERER_ALLOWLIST.length })}</li>
          <li>{t('probe.requireUndefined', { value: String(requireIsUndefined()) })}</li>
        </ul>
      </section>

      <section className="rounded-xl border border-line bg-ink-900/60 p-4">
        <h2 className="text-sm font-semibold text-slate-200">{t('result.heading')}</h2>
        <p
          className={`mt-2 break-all text-xs ${
            reply?.kind === 'captured' ? 'text-seal' : reply?.kind === 'escaped' ? 'text-amber' : 'text-slate-400'
          }`}
        >
          {reply ? t(`result.${reply.kind}`, { message: reply.message }) : t('result.idle')}
        </p>
      </section>
    </div>
  );
}
