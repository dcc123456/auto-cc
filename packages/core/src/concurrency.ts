/**
 * 跨进程共享的协作式并发原语（spec 1.11 取消语义）。
 *
 * `sleep` 原先长在 `packages/workflow/src/index.ts` 里，聊天流是它的第二个真实使用者
 * （1.11-03 的分片推送按固定间隔让出），按 AGENTS.md §2.2「同一逻辑出现第二次必须抽公共层」提到这里。
 * cordis rc.10 没有公开的 `Scope` 类、只有 `Fiber.dispose`（plan §8.5 实测），
 * 所以"中断一次正在跑的任务"必须由调用方持有 `AbortController`，这里只负责让出。
 * `assertNotYielded` 是 2.3 里 `jd.capture` 私有 `checkYield` 的第二个真实使用者（2.5-e 的打招呼
 * 也要在频控等待之后问一句），按同一条 §2.2 提到这里，`jd.capture` 改为调用它。
 */
import { AppError } from './errors.js';

/**
 * 可取消的等待。
 * @param ms 时长（毫秒）；0 或负数时立刻返回，不留下一个空转的定时器
 * @param signal 取消信号；abort 时**正常 resolve** 而不是 reject——暂停/中止不是失败，
 *               让出之后由调用方检查自己的状态决定要不要继续推进
 * @returns 等待结束（或被取消）的 Promise，永不 reject
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 协作让出检查点：信号已 abort 就抛，让长任务在中途停下（spec 2.4-07）。
 *
 * `sleep` 在 abort 时是**正常返回**的（暂停不是失败），所以「等完之后要不要继续」必须由
 * 调用方判定；这句话因此和 `sleep` 成对出现，抽到一处而不是每个长任务各写一份。
 * @param signal 让出信号；undefined 表示这次是界面直接触发的动作，不需要响应暂停
 * @param scope 抛错时归属的域（服务名，如 `jd.capture`），界面按它定位是谁收的手
 * @param action 正在做的事（中文短语，如「抓取」），拼进原因文案让日志读得通
 * @throws 已让出时以 `WORKFLOW_STEP_FAILED` 失败（未让出则正常返回）
 */
export function assertNotYielded(signal: AbortSignal | undefined, scope: string, action: string): void {
  if (!signal?.aborted) return;
  throw new AppError('WORKFLOW_STEP_FAILED', `工作流让出，${action}在中途收手`, scope);
}
