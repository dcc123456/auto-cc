/**
 * agent 循环的界面侧状态（spec 5.2-03 / 04 / 10）：一次 run 的读数、五个动作、以及「已受理叫停」这一位。
 *
 * 进度**由 `agent/run-progress` 推**，`loop.read` 只负责「错过了也还在」——与 `outbound.deliver`
 * 那条审批单同一分工（事件提醒 + 现读兜底）。界面不自己数第几步：所有下标、状态、token 账都取自主进程，
 * 自己推导一份就是 §2.7 禁的第二份事实。
 *
 * 第三格是「连事件都没赶上」的那一种（重新挂载 / 进程停过一次）：那时无处可接推送，只能按当前会话
 * 现取最近一次 run 的读数（`agent.loop.latestRun`，spec 5.6-01）——四类记录本来就在 SQLite 里，缺的只是挂载时回看。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentRunView } from '@auto-cc/shared';
import { useBridgeAction } from './useBridgeAction';

/**
 * 挂一次 agent 循环的界面状态。
 * @param sessionId 当前会话 id（来自 `chat.session.current()`，未回来时为 undefined）——
 *   挂载回看按它认领「这一段对话的最近一次 run」，不传就不回看（免得在快照之前猜一个会话）
 * @returns `run`（当前这条 run 的读数，没起草过为 undefined）、`notice`、`propose` / `confirm` / `stop` /
 *   `resume` / `dismiss` 五个动作，以及 `stopAccepted`（点过叫停但 `paused` 还没落进来——界面此刻只能说「已受理」，不能说「已停止」）
 */
export function useAgentRun(sessionId?: string) {
  const { t } = useTranslation();
  const [run, setRun] = useState<AgentRunView>();
  const [stopAccepted, setStopAccepted] = useState(false);
  const bridge = window.autoCC;
  // 重读用的 id 存在 ref 里：`read` 要进 `useCallback` 的依赖，而 runId 变了不该换掉动作函数的身份。
  const runIdRef = useRef<string | undefined>(undefined);
  // 本地这份读数是从哪一段会话回看来的：同一会话里刚起草的那一条永远比库里的旧读数新，
  // 而换会话（`startSession`）之后必须换，否则上一段的计划卡会串到这一段对话里来。
  const restoredFromSessionRef = useRef<string | undefined>(undefined);

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
   * 挂载时回看这段会话的最近一次 run（spec 5.6-01）：`agent/run-progress` 只负责「此刻推得到的」，
   * 重新挂载（含进程停过一次）后要靠这一口从 `agent_run` + `agent_step` 把计划卡与逐步卡片流画回来。
   *
   * 分工与 `useAgentPause` 那条挂载回看同一口径（5.5-d 挂的就是这一格）。读数走 `agent.loop.read`
   * 那一份形状，所以参数是掩码（spec 5.6-05）——界面画的从来不是执行件。
   */
  useEffect(() => {
    if (!bridge || !sessionId) return;
    // 快照到位之前不发起（`sessionId` 为空），到位之后这一段只回看一次：依赖里只有 sessionId。
    let isCurrentMount = true;
    void (async () => {
      const reply = await bridge?.agent['loop.latestRun'](sessionId);
      if (!isCurrentMount || !reply?.ok) return;
      if (runIdRef.current && restoredFromSessionRef.current === sessionId) return;
      runIdRef.current = reply.value?.runId;
      restoredFromSessionRef.current = sessionId;
      setStopAccepted(false);
      // 该会话一次都没起草过时返回 null：这里必须清空，否则换会话之后画着的还是上一段那条 run。
      setRun(reply.value ?? undefined);
    })();
    return () => {
      isCurrentMount = false;
    };
  }, [bridge, sessionId]);

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
