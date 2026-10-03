/**
 * agent 循环的界面侧状态（spec 5.2-03 / 04 / 10）：一次 run 的读数、五个动作、以及「已受理叫停」这一位。
 *
 * 进度**由 `agent/run-progress` 推**，`loop.read` 只负责「错过了也还在」——与 `outbound.deliver`
 * 那条审批单同一分工（事件提醒 + 现读兜底）。界面不自己数第几步：所有下标、状态、token 账都取自主进程，
 * 自己推导一份就是 §2.7 禁的第二份事实。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentRunView } from '@auto-cc/shared';
import { useBridgeAction } from './useBridgeAction';

/**
 * 挂一次 agent 循环的界面状态。
 * @returns `run`（当前这条 run 的读数，没起草过为 undefined）、`notice`、`propose` / `confirm` / `stop` /
 *   `resume` / `dismiss` 五个动作，以及 `stopAccepted`（点过叫停但 `paused` 还没落进来——界面此刻只能说「已受理」，不能说「已停止」）
 */
export function useAgentRun() {
  const { t } = useTranslation();
  const [run, setRun] = useState<AgentRunView>();
  const [stopAccepted, setStopAccepted] = useState(false);
  const bridge = window.autoCC;
  // 重读用的 id 存在 ref 里：`read` 要进 `useCallback` 的依赖，而 runId 变了不该换掉动作函数的身份。
  const runIdRef = useRef<string | undefined>(undefined);

  /** 现读当前 run 的落库读数（每个动作跑完由 `useBridgeAction` 调一次，界面不猜主进程当下的状态）。 */
  const read = useCallback(async () => {
    const runId = runIdRef.current;
    if (!runId) return;
    const reply = await bridge?.agent['loop.read'](runId);
    if (reply?.ok) setRun(reply.value);
  }, [bridge]);

  const action = useBridgeAction(read);

  useEffect(() => {
    if (!bridge) return;
    return bridge.on('agent/run-progress', (event) => {
      // 终态一到就把「已受理」撤掉：那一位只描述「按了但还没停」的中间态，停在界面停在库里得是同一刻。
      if (event.status !== 'running') setStopAccepted(false);
      setRun(event);
    });
  }, [bridge]);

  /**
   * 起草一份计划（spec 5.2-03）：这一步在主进程里不执行任何动作，返回的就是计划卡要画的那份读数。
   * @param goal 用户原文（去空由主进程按系统边界校验）
   */
  const propose = useCallback(
    async (goal: string): Promise<void> => {
      runIdRef.current = undefined;
      setStopAccepted(false);
      await action.run(t('agent.run.actionPropose'), () => bridge?.agent['loop.propose'](goal), {
        apply: (view) => {
          runIdRef.current = view.runId;
          setRun(view);
        },
      });
    },
    [action, bridge, t],
  );

  /** 确认这份计划并开始逐步执行（人按的那一口，模型按不到）。 */
  const confirm = useCallback(async (): Promise<void> => {
    const runId = runIdRef.current;
    if (!runId) return;
    await action.run(t('agent.run.actionConfirm'), () => bridge?.agent['loop.confirm'](runId), {
      apply: setRun,
    });
  }, [action, bridge, t]);

  /**
   * 叫停（spec 5.2-10）：正在跑的那一步不硬切，停在下一个安全点。
   * running 分支返回的读数仍是 `running`（那是事实），所以这里另立一位「已受理」。
   */
  const stop = useCallback(async (): Promise<void> => {
    const runId = runIdRef.current;
    if (!runId) return;
    setStopAccepted(true);
    await action.run(t('agent.run.actionStop'), () => bridge?.agent['loop.stop'](runId), {
      apply: (view) => {
        if (view.status !== 'running') setStopAccepted(false);
        setRun(view);
      },
    });
  }, [action, bridge, t]);

  /**
   * 恢复被人工接管按住的那条 run（spec 5.5-01 的第二个动作，机检 ⑧ 名单里「界面上那颗继续按钮」）。
   *
   * 它与 `confirm` 不是同一只手：`confirm` 是「这份计划我批了」，恢复发生在计划早就批过之后，
   * 人按下去表达的只有「页面我弄好了，接着跑」。所以这一口只画在 `paused` + `stopReason=TAKEOVER_HELD`
   * 那一格里，且必须先交还页面（`useTakeover.release`）——主进程在仍接管时以 `AGENT_LOOP_TAKEOVER_HELD`
   * 拒绝，界面不去猜「他大概已经弄完了」。
   */
  const resume = useCallback(async (): Promise<void> => {
    const runId = runIdRef.current;
    if (!runId) return;
    await action.run(t('agent.run.actionResume'), () => bridge?.agent['loop.resume'](runId), {
      apply: setRun,
    });
  }, [action, bridge, t]);

  /** 收起面板：只清界面上的这一份，库里的 run 一行都不动（随时可再读回来）。 */
  const dismiss = useCallback((): void => {
    runIdRef.current = undefined;
    setStopAccepted(false);
    setRun(undefined);
    action.setNotice(t('agent.run.dismissed'));
  }, [action, t]);

  return { run, busy: action.busy, notice: action.notice, stopAccepted, propose, confirm, stop, resume, dismiss };
}
