/**
 * 「这块视图还活着吗」的唯一判据（2026-11-23，真站上撞出来的 P1）。
 *
 * 症状：用户在 BOSS 搜索页点「公司行业」的下拉头之后，内核视图从 CDP 目标表里消失，
 * 紧接着 `shell.getStatus()` 与 `sessions.status()` 抛原生异常
 * `Cannot read properties of undefined (reading 'isDestroyed')`——**一个下拉把右栏与地址栏一起打废**。
 *
 * 根因形状：Electron 的 `WebContentsView.webContents` 在视图被销毁后**可能变成 `undefined`**，
 * 而壳层原先到处写的是 `view.webContents.isDestroyed()`：可选链只护住了 `view` 这一层，
 * `.webContents` 是 undefined 时那段判断本身就成了抛异常的那一行。
 *
 * 所以「活不活」收进这一个函数（AGENTS.md §2.2：同一判断出现第二次就要抽），
 * 调用方只认它给的句柄，不自己读 `view.webContents`。
 */

/** 视图最小的可用形状：只要求有一个可能为空的 `webContents`。 */
export type MaybeDeadView = { webContents?: unknown };

/**
 * judge 一个 `webContents` 是否还可读写。
 * @param contents 候选句柄（可能是 undefined / null / 已销毁对象）
 * @returns 有 `isDestroyed` 方法且返回 false 时为 true；其余一律 false
 */
function isAliveContents(contents: unknown): boolean {
  if (typeof contents !== 'object' || contents === null) return false;
  const probe = contents as { isDestroyed?: unknown };
  if (typeof probe.isDestroyed !== 'function') return false;
  try {
    return !(probe.isDestroyed as () => boolean)();
  } catch {
    // `isDestroyed` 自己抛（句柄在别的线程上已经没了）：按「不活」处理，绝不把异常抛给只读口。
    return false;
  }
}

/**
 * 取视图中还活着的 `webContents`。
 * @param view WebContentsView（或任何带 `webContents` 的对象）；可以是 null / 已销毁
 * @returns 活着的句柄；视图不存在、`webContents` 变成 undefined、或已销毁时为 null
 */
export function liveWebContentsOf<T>(view: MaybeDeadView | null | undefined): T | null {
  const contents = view?.webContents;
  return isAliveContents(contents) ? (contents as T) : null;
}

/**
 * 视图是否还活着（要不要把它从「当前视图」的记位上摘掉）。
 * @param view 同上
 * @returns 与 `liveWebContentsOf(...) !== null` 同义，读起来更直白的写法
 */
export function isViewLive(view: MaybeDeadView | null | undefined): boolean {
  return liveWebContentsOf(view) !== null;
}
