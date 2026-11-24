/**
 * 「这次调用是谁发起的」的唯一来源（2026-11-24 红线事故后的第二处收紧）。
 *
 * 为什么不用参数：`navigate(url, source)` 里的 `source` 是调用方自己写的字符串，任何自动化代码都能传 `'user'`
 * 把闸绕过去——那不是闸，是装饰。所以来源改由**入口**决定：IPC 网关（渲染层唯一的入口）在派发前打标，
 * 主进程内部调用没有这个标，`…FromUser` 那两只口一旦被主进程代码调到就当场拒绝。
 *
 * 只做两件事：进网关时打标、读时取值。判定（能不能去真站）留在各自的领域服务里，这里不认识浏览器也不认识平台。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from './errors.js';

/** 一次调用的来源：渲染层（人）或主进程内部（自动化）。缺省——也就是没有标——按自动化算。 */
export type CallOrigin = 'user' | 'automation';

/** 按异步上下文传来源：网关打标之后，服务里的 await 一路都读得到。 */
const origins = new AsyncLocalStorage<CallOrigin>();

/**
 * 以「人发起的调用」身份跑一段逻辑（只有 IPC 网关该调它）。
 * @param run 要执行的派发逻辑
 * @returns 派发结果
 */
export function runAsUserCall<T>(run: () => Promise<T>): Promise<T> {
  return origins.run('user', run);
}

/**
 * 现读这次调用的来源。
 * @returns 网关正在派发渲染层调用时为 `'user'`，其余一律 `'automation'`
 */
export function currentCallOrigin(): CallOrigin {
  return origins.getStore() ?? 'automation';
}

/**
 * 只有人发起的调用能走的口子（`…FromUser`）。
 *
 * @param entry 这只口的名字，进失败原话
 * @throws `INVALID_ARGUMENT`：调用不在渲染层发起的上下文里——主进程自动化路径借这只口就是越界
 */
export function assertUserCall(entry: string): void {
  if (currentCallOrigin() === 'user') return;
  throw new AppError(
    'INVALID_ARGUMENT',
    `${entry} 只接受人在界面上的调用：当前不在渲染层发起的上下文里，按自动化处理`,
    entry,
    { origin: currentCallOrigin() },
  );
}
