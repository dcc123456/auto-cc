/**
 * 「在文件管理器中显示」的目标判定（spec 6.2-12，plan §3.10）。
 *
 * 这一口把一条**来自渲染层的绝对路径**交给操作系统去打开，是本项目少见的"参数直接指向磁盘"的入口：
 * `RENDERER_ALLOWLIST` 管的是"能调哪个方法"，管不了参数，所以边界写在判定里——
 * 只允许主进程自己写出来的产物（`app.getPath('userData')` 之内）。
 *
 * 与 `view-takeover.ts` 同一条画法：不需要 Electron 窗口的纯判定放这里（可单测），
 * 真正调用 `shell.showItemInFolder` 的那一半在 `index.ts`。
 * 这里不抛异常，失败以返回值表达，原因码与那句给人读的话一起带回去。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AppErrorCode } from '@auto-cc/core';

/** 一次 reveal 准入的结局：接纳时带回解析后的绝对路径，拒绝时带回原因码与一句能直接进日志的原因。 */
export type RevealTarget =
  { isAccepted: true; resolvedPath: string } | { isAccepted: false; code: AppErrorCode; reason: string };

/**
 * 判定「渲染层要在文件管理器里显示的这一条」能不能打开。
 * @param filePath 渲染层递来的路径，形状没有任何保证（空串、相对路径、越界绝对路径都可能是它）；
 *        类型写 `unknown` 是因为 args 从 IPC 进来就是 `unknown[]`，网关只校验调的是哪个方法
 * @param userDataRoot 主进程自己的产物根目录（`app.getPath('userData')`），唯一的允许区
 * @returns 边界内且磁盘上真存在 → `isAccepted: true`；否则给原因码——
 *          Electron 44 的 `showItemInFolder` 返回 `void`，"存在与否"拿不到库的读数，必须自己判，
 *          否则文件被移走时这一口照样成功，界面按了什么都没发生。
 */
export function resolveRevealTarget(filePath: unknown, userDataRoot: string): RevealTarget {
  if (typeof filePath !== 'string' || filePath === '') {
    return { isAccepted: false, code: 'REVEAL_OUTSIDE_USER_DATA', reason: '没有要显示的文件' };
  }
  const resolved = path.resolve(filePath);
  // 用 relative 判包含，不用 startsWith：`…/auto-cc` 会把 `…/auto-cc-evil` 一起放行。
  const fromRoot = path.relative(path.resolve(userDataRoot), resolved);
  if (fromRoot === '' || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
    return {
      isAccepted: false,
      code: 'REVEAL_OUTSIDE_USER_DATA',
      reason: `只允许显示本机应用目录内的产物：${resolved}`,
    };
  }
  if (!existsSync(resolved)) {
    return { isAccepted: false, code: 'REVEAL_TARGET_MISSING', reason: `产物已不在磁盘上：${resolved}` };
  }
  return { isAccepted: true, resolvedPath: resolved };
}
