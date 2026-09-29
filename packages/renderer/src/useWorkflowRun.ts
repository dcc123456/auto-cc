/**
 * 主进程那唯一一份 run 的界面订阅（spec 1.10-08）。
 *
 * 对话面板与工作流面板都读它：判据「两侧状态镜像一致」要真的有两个消费者才算数，
 * 而同一份订阅逻辑出现第二次就必须抽出来（AGENTS.md §2.2）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { WorkflowRunView } from '@auto-cc/shared';

/** 最近一条播报（步骤 id + 那句话），用来证明进度是推来的而不是轮询来的。 */
export type WorkflowLiveReading = { stepId: string | null; message: string | null };

/**
 * 挂载时读一次快照，之后只由 `workflow/progress` 事件推进。
 * @returns `run`（主进程快照，首个响应回来之前为 undefined）、`live`（最近一条播报）、`refresh`（主动重读）
 */
export function useWorkflowRun() {
  const [run, setRun] = useState<WorkflowRunView>();
  const [live, setLive] = useState<WorkflowLiveReading>();
  const bridge = window.autoCC;

  const refresh = useCallback(async () => {
    const reply = await bridge?.workflow['runner.current']();
    if (reply?.ok) setRun(reply.value);
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.on('workflow/progress', (event) => {
      setRun(event.run);
      setLive({ stepId: event.stepId, message: event.message });
    });
  }, [bridge]);

  return { run, live, refresh };
}
