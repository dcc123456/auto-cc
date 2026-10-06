import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppErrorPayload, BridgeReply } from '@auto-cc/shared';
import { useDeskResult } from './ui/controls';

/** `run` 拿到成功返回值之后的两个可选挂钩。 */
export interface BridgeActionHooks<T> {
  /** 把返回值落到本面板自己的 state。 */
  apply?: (value: T) => void;
  /** 覆盖默认成功提示：调用成功但结果不对时，「成功」是句假话。 */
  describe?: (value: T) => string | undefined;
  /**
   * 桥接返回结构化错误（`ok:false`）时的挂钩：面板要按 `code` 区分「还没有打开会话」
   * 与「定位未过线」这类语义完全不同的失败，一行提示装不下这个差别（spec 2.2-04）。
   * 提示行照旧设置，挂钩只负责把错误载荷落到面板 state。
   */
  onError?: (error: AppErrorPayload) => void;
}

/**
 * 面板动作的公共外壳：忙碌态、结果态、提示行，以及「动作跑完一律重读快照」。
 *
 * 这些面板是 app 的自测入口，所以失败原因必须留在界面上而不是弹窗——
 * harness 的截图才拿得到证据（AGENTS.md §7.1）。
 * 结果态（07 稿五态的最后两态）也挂在这一层而不是各面板自己计时：成功还是失败这里已经判过了
 * （`reply.ok`），再让每只按钮各长一套就是同一份事实的第二份副本（§2.5）。
 * @param read 本面板的快照读取函数；每个动作结束后都会调一次，界面不猜主进程当下的状态
 * @returns `busy`（正在执行的动作标签，用来禁用按钮防止重复触发）、`notice`、`setNotice`、`resultOf`（按标签取结果态）、`run`
 */
export function useBridgeAction(read: () => Promise<unknown>) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const { resultOf, markDone, markFailed, clearResult } = useDeskResult();

  /**
   * 跑一次白名单调用并把结果写成一行提示，同时给刚动过的那只按钮落一个结果态。
   * @param label 动作标签（禁用按钮的凭据、结果态的归属，也拼进提示文案）
   * @param call 实际调用；不在 Electron 宿主里时返回 undefined，此时提示桥接不可用
   * @param hooks 成功后的落值、文案覆盖，与结构化错误的落点
   */
  const run = useCallback(
    async <T>(
      label: string,
      call: () => Promise<BridgeReply<T>> | undefined,
      hooks: BridgeActionHooks<T> = {},
    ): Promise<void> => {
      setBusy(label);
      // 上一次的结果先撤掉：seal 那一档「不自动回落」的判据是「等人再动一次」，而这一次就是那一下。
      clearResult();
      const reply = await call();
      setBusy(undefined);
      if (!reply) setNotice(t('action.noBridge'));
      else if (reply.ok) {
        markDone(label);
        hooks.apply?.(reply.value);
        setNotice(hooks.describe?.(reply.value) ?? t('action.ok', { action: label }));
      } else {
        markFailed(label);
        hooks.onError?.(reply.error);
        setNotice(t('action.failed', { action: label, message: reply.error.message }));
      }
      await read();
    },
    [clearResult, markDone, markFailed, read, t],
  );

  return { busy, notice, resultOf, run, setNotice };
}
