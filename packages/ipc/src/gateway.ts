/**
 * IPC 网关的纯逻辑（spec 1.4-04 / 1.4-05 / 1.4-06 / 1.4-07）。
 *
 * 刻意不 import `electron`：入站校验、路径解析、序列化检查这三件事是安全边界，
 * 必须能在 Node 里直接测；electron 侧的接线（`ipcMain` / 事件广播）留在 index.ts。
 */
import { AppError, type AppErrorPayload } from '@auto-cc/core';
import { isAllowedCall, type BridgeReply, type BridgeRequest } from '@auto-cc/shared';
import { resolveCall } from './resolve.js';

export interface GatewayDeps {
  /** 按服务名取实例；未挂载返回 undefined。 */
  lookup: (name: string) => object | undefined;
  /** 拒绝时的旁路回调，用于在主进程留一条可读日志（渲染层看到的仍是结构化错误）。 */
  onDenied?: (path: string, error: AppErrorPayload) => void;
}

/**
 * 返回值必须能过 structuredClone。
 *
 * 含函数/symbol 的对象跨进程时会被**静默丢字段**，那比直接报错难查得多（spec 1.4-05），
 * 所以在这里显式探一次，不可克隆就点名 path 与原因。
 */
function assertSerializable<T>(value: T, path: string): T {
  try {
    structuredClone(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AppError('NOT_SERIALIZABLE', `返回值无法跨进程序列化：${reason}`, path);
  }
  return value;
}

export class Gateway {
  private readonly deps: GatewayDeps;

  /** 在途 / 已完成 / 白名单拒绝计数：并发正确性（spec 1.4-06）与调用成功率（spec 1.6-12）的可观测面。 */
  private inFlight = 0;
  private completed = 0;
  private denied = 0;

  constructor(deps: GatewayDeps) {
    this.deps = deps;
  }

  get stats(): { inFlight: number; completed: number; denied: number } {
    return { inFlight: this.inFlight, completed: this.completed, denied: this.denied };
  }

  /**
   * 处理一次入站调用：白名单 → 解析 → 执行 → 序列化检查。
   *
   * 任何一步失败都转成 `{ ok: false, error }` 的结构化载荷并把异常吞在这里——
   * 跨进程抛裸异常会丢掉 message，界面上就只剩「An error occurred」。
   * 每次调用只用局部变量，不留「当前请求」这类共享可变态，因此并发不会互相串。
   */
  async invoke(request: BridgeRequest): Promise<BridgeReply<unknown>> {
    this.inFlight += 1;
    const path = typeof request?.path === 'string' ? request.path : '';
    try {
      if (path === '') throw this.deny(path, '调用载荷不合法：缺少 path');
      if (!isAllowedCall(path)) throw this.deny(path, `能力未在白名单中：${path}`);

      const target = resolveCall(path, this.deps.lookup);
      if (!target.ok) throw new AppError(target.code, target.message, path);

      const args = Array.isArray(request.args) ? request.args : [];
      const value = await target.invoke(...args);
      return { ok: true, value: assertSerializable(value, path) };
    } catch (error) {
      const payload = AppError.from(error, 'UNKNOWN');
      return { ok: false, error: { ...payload, path: payload.path ?? path } };
    } finally {
      this.inFlight -= 1;
      this.completed += 1;
    }
  }

  /**
   * 白名单拒绝的唯一出口：计数、留一条主进程日志、造出错误对象。
   *
   * 计数必须钉在这里而不是 catch 分支：`ipc.probeReject` 这类白名单内的方法会把内部的
   * `NOT_IN_ALLOWLIST` 原样抛出，按错误码数就会「点一次越权、面板 +2」。
   */
  private deny(path: string, message: string): AppError {
    const error = new AppError('NOT_IN_ALLOWLIST', message, path);
    this.denied += 1;
    this.deps.onDenied?.(path, error);
    return error;
  }
}
