/**
 * 跨进程共享的协作式并发原语（spec 1.11 取消语义）。
 *
 * `sleep` 原先长在 `packages/workflow/src/index.ts` 里，聊天流是它的第二个真实使用者
 * （1.11-03 的分片推送按固定间隔让出），按 AGENTS.md §2.2「同一逻辑出现第二次必须抽公共层」提到这里。
 * cordis rc.10 没有公开的 `Scope` 类、只有 `Fiber.dispose`（plan §8.5 实测），
 * 所以"中断一次正在跑的任务"必须由调用方持有 `AbortController`，这里只负责让出。
 */

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
