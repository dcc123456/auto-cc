/**
 * 新标签接管的纯判定（spec 2.2-11）。
 *
 * 页面里的 `window.open()` / `target=_blank` 默认会开出 Electron 的独立窗口，脱离我们的视图与
 * 会话分区（等于逃逸成"外部浏览器"）。壳层的处置是：一律 `deny`，同源的那部分改由同分区子视图承载。
 * 本文件只放这件事里**不需要窗口**的两个判定，好让它们能被单测覆盖（真实挂视图的部分在 `index.ts`）。
 *
 * 与 `packages/browser/src/navigate-policy.ts` 的关系是刻意的重复，不是遗漏：那份判定的口径是
 * "已登记平台清单"、失败方式是抛 `AppError`，而它在 L2；壳层是 L1，**分层方向禁止 L1 反向依赖 L2**
 * （AGENTS.md §4.1），并且 `setWindowOpenHandler` 的回调里抛异常会穿透到主进程顶层。所以这里的口径
 * 更严（只认同源，跨源连"已登记"都不认），失败以返回值表达。两处各自服务自己的调用方，合并即破坏分层。
 */

/** 允许被接管进内核视图的协议：`javascript:` / `data:` 进视图就等于在站点会话里执行脚本。 */
const TAKEOVER_PROTOCOLS = new Set(['http:', 'https:']);

/** 一次接管准入的结局：接纳时带回解析后的地址，拒绝时带回一句能直接进日志的原因。 */
export type TakeoverDecision = { isAccepted: true; targetUrl: URL } | { isAccepted: false; reason: string };

/**
 * 判定「页面想开的新窗口」能不能被接管进当前内核视图。
 * @param rawUrl `HandlerDetails.url`，已由 Chromium 解析成绝对地址，但**来自外部页面，不可信**
 * @param pageUrl 发起方页面当前的地址（`webContents.getURL()`）；装载中时可能是空串
 * @returns 同源 http(s) → `isAccepted: true`；协议不允许 / 地址不可解析 / 跨源 → `isAccepted: false` 并给原因，
 *          本函数不抛异常（调用处在 Electron 的事件回调里）
 */
export function decideTakeover(rawUrl: string, pageUrl: string): TakeoverDecision {
  let targetUrl: URL;
  try {
    targetUrl = new URL(rawUrl);
  } catch {
    return { isAccepted: false, reason: `地址无法解析：${rawUrl}` };
  }
  if (!TAKEOVER_PROTOCOLS.has(targetUrl.protocol)) {
    return { isAccepted: false, reason: `不允许的协议 ${targetUrl.protocol}（只允许 http/https）` };
  }
  let pageUrlParsed: URL;
  try {
    pageUrlParsed = new URL(pageUrl);
  } catch {
    return { isAccepted: false, reason: `发起页地址不可解析，无同源依据：${pageUrl || '（空）'}` };
  }
  // 占位页是 `data:` URL，它的 origin 是字符串 'null'，永远等不上站点的 https origin，于是自然被拒。
  if (pageUrlParsed.origin !== targetUrl.origin) {
    return { isAccepted: false, reason: `跨源 ${pageUrlParsed.origin} → ${targetUrl.origin}，不在接管范围` };
  }
  return { isAccepted: true, targetUrl };
}

/**
 * 在接管子视图栈里挑出用户实际看到的那一个。
 *
 * 后挂上来的子视图叠在最上层（见 `index.ts` 的 `addChildView` 顺序），所以「活动页」是从栈顶往下
 * 第一个页面还活着的视图；栈里可能留着刚被页面 `window.close()` 掉、销毁事件尚未回调的视图。
 * @param stack 按创建顺序排列的子视图栈，末尾在最上层
 * @param isAlive 判断某个视图的页面是否还未销毁
 * @returns 活动视图；栈为空或全部已销毁时为 null（调用方回落到内核视图本身）
 */
export function topmostAlive<T>(stack: readonly T[], isAlive: (view: T) => boolean): T | null {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const candidate = stack[index];
    if (candidate !== undefined && isAlive(candidate)) return candidate;
  }
  return null;
}
