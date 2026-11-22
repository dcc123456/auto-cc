/**
 * 内核视图地址推送的去重判据（spec 10.11-29 的事件面，2026-11-22 裁定②）。
 *
 * 为什么要这条规则：地址栏在「面板已经开着、站点后来才被打开」时收不到任何提示，
 * 只能等人按一次刷新或切走再回来（本轮实测：输入框停在占位 `data:` 页，按刷新被协议闸拒）。
 * 推送本身必须是**变化才发**——同一条 URL 每帧重发就是一场事件风暴，界面每收一次都要重画。
 * @param previous 上一次已经推过的地址（首推传空串）
 * @param next 这一次读到的地址
 * @returns 下一次要比的值，以及这一次要不要发（同值不发）
 */
export function markKernelViewUrl(previous: string, next: string): { previous: string; emit: boolean } {
  return { previous: next, emit: previous !== next };
}
