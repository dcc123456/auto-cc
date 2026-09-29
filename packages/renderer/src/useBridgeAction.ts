import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BridgeReply } from '@auto-cc/shared';

/** `run` 拿到成功返回值之后的两个可选挂钩。 */
export interface BridgeActionHooks<T> {
  /** 把返回值落到本面板自己的 state。 */
  apply?: (value: T) => void;
  /** 覆盖默认成功提示：调用成功但结果不对时，「成功」是句假话。 */
  describe?: (value: T) => string | undefined;
}

/**
 * 面板动作的公共外壳：忙碌态、提示行，以及「动作跑完一律重读快照」。
 *
 * 这些面板是 app 的自测入口，所以失败原因必须留在界面上而不是弹窗——
 * harness 的截图才拿得到证据（AGENTS.md §7.1）。
 * @param read 本面板的快照读取函数；每个动作结束后都会调一次，界面不猜主进程当下的状态
 * @returns `busy`（正在执行的动作标签，用来禁用按钮防止重复触发）、`notice`、`setNotice`、`run`
 */
export function useBridgeAction(read: () => Promise<unknown>) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();

  /**
   * 跑一次白名单调用并把结果写成一行提示。
   * @param label 动作标签（禁用按钮的凭据，也拼进提示文案）
   * @param call 实际调用；不在 Electron 宿主里时返回 undefined，此时提示桥接不可用
   * @param hooks 成功后的落值与文案覆盖
   */
  const run = useCallback(
    async <T>(
      label: string,
      call: () => Promise<BridgeReply<T>> | undefined,
      hooks: BridgeActionHooks<T> = {},
    ): Promise<void> => {
      setBusy(label);
      const reply = await call();
      setBusy(undefined);
      if (!reply) setNotice(t('action.noBridge'));
      else if (reply.ok) {
        hooks.apply?.(reply.value);
        setNotice(hooks.describe?.(reply.value) ?? t('action.ok', { action: label }));
      } else setNotice(t('action.failed', { action: label, message: reply.error.message }));
      await read();
    },
    [read, t],
  );

  return { busy, notice, run, setNotice };
}
