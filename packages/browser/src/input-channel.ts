/**
 * CDP 输入通道（spec 2.2-09 / 2.2-12）。
 *
 * 为什么走 `webContents.debugger` 而不是 `element.click()`：站点前端普遍监听 `isTrusted`，
 * 合成事件会被判定为脚本行为并静默丢弃（打招呼按钮点了没反应，日志却一片祥和）。
 * spike 实测（plan §9.4）：`Input.dispatchMouseEvent` 与 `Input.insertText` 产生的事件
 * `isTrusted` 为 true，中文与 emoji 原样进 value，且远程 CDP（harness 用的那条）仍然可用——
 * 也就是说这条通道和自测通道不打架。
 *
 * 坐标是帧内的 CSS 像素，所以要按祖先帧的 iframe 位置逐层折算成视图坐标才能点准。
 * 认不出某一层时**不猜**：直接宣告折算失败，让调用方退回 DOM 通道并如实标注 `channel: 'dom'`。
 */
import type { ElementRect } from '@auto-cc/shared';
import type { WebContents, WebFrameMain } from 'electron';
import { ordinalInParent } from './frame-channel.js';
import { buildIframeRectsScript, toIframeRects, type IframeRect } from './locator-script.js';

/** 视图坐标里的一个点（CSS 像素，与 CDP 输入同一坐标系）。 */
export type ViewportPoint = { x: number; y: number };

/** 一条待发送的 CDP 命令（抽出来是为了能在单测里断言命令形状）。 */
export type CdpCommand = { method: string; params: Record<string, unknown> };

/** 一次帧偏移折算的结果。 */
export type FrameOffsetReading = {
  /** 从最外层到目标帧的直接父帧，每一层 iframe 元素在各自父帧视口里的位置 */
  rects: ElementRect[];
  /** 是否每一层都认出来了；为 false 时 `rects` 不可用于点击 */
  resolved: boolean;
};

/** 已 attach 过的视图；WeakMap 让销毁的 `WebContents` 不会留在表里（spec 2.1-11 数的就是这类残留）。 */
const attachedViews = new WeakMap<WebContents, true>();

/**
 * 取矩形的中心点。
 * @param rect 元素在所属帧视口里的位置（CSS 像素）
 * @returns 中心点坐标
 */
export function centerOf(rect: ElementRect): ViewportPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * 把帧内坐标逐层加上父帧里 iframe 元素的偏移。
 * @param inner 目标元素在自身帧视口里的坐标
 * @param ancestorRects 由外到内的各层 iframe 位置
 * @returns 整个视图里的坐标
 */
export function foldFrameOffsets(inner: ViewportPoint, ancestorRects: ElementRect[]): ViewportPoint {
  return ancestorRects.reduce((acc, rect) => ({ x: acc.x + rect.x, y: acc.y + rect.y }), inner);
}

/**
 * 生成一次左键点击的 CDP 命令序列。
 * @param point 视图坐标
 * @param clickCount 第几次点击（连点要递增，浏览器靠它区分双击）
 * @returns 移动 → 按下 → 抬起三条命令
 */
export function mouseCommandsOf(point: ViewportPoint, clickCount = 1): CdpCommand[] {
  return [
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: point.x, y: point.y } },
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount, click: 'single' },
    },
    {
      method: 'Input.dispatchMouseEvent',
      params: {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button: 'left',
        buttons: 0,
        clickCount,
        click: 'single',
      },
    },
  ];
}

/**
 * 生成一次「把文本原样送进焦点控件」的 CDP 命令。
 *
 * 选 `Input.insertText` 而不是逐键 `dispatchKeyEvent`：中文串用按键码打不出来，
 * 而 insertText 在 spike 里回读到的 value 与输入完全一致。
 * @param text 待输入文本（可含中文与 emoji）
 * @returns 单条 CDP 命令
 */
export function insertTextCommandOf(text: string): CdpCommand {
  return { method: 'Input.insertText', params: { text } };
}

/**
 * 确保该视图的调试器已挂上（惰性 attach，一个视图只 attach 一次）。
 * @param contents 内核视图句柄
 * @returns 可用为 true；视图已销毁或被别的客户端占用为 false
 */
export function ensureAttached(contents: WebContents): boolean {
  if (contents.isDestroyed()) return false;
  if (attachedViews.get(contents) === true && contents.debugger.isAttached()) return true;
  try {
    contents.debugger.attach('1.3');
    attachedViews.set(contents, true);
    return true;
  } catch {
    attachedViews.delete(contents);
    return false;
  }
}

/**
 * 该视图当前是否走得了 CDP 通道。
 * @param contents 内核视图句柄
 * @returns 可发送命令为 true
 */
export function isUsable(contents: WebContents): boolean {
  return !contents.isDestroyed() && contents.debugger.isAttached();
}

/**
 * 摘掉调试器。
 * @param contents 内核视图句柄
 */
export function detach(contents: WebContents): void {
  attachedViews.delete(contents);
  if (contents.isDestroyed() || !contents.debugger.isAttached()) return;
  try {
    contents.debugger.detach();
  } catch {
    // 视图正在销毁时 detach 会抛，摘掉记录就够了——没有别的资源要还。
  }
}

/**
 * 依次发送 CDP 命令。
 * @param contents 内核视图句柄
 * @param commands `mouseCommandsOf` / `insertTextCommandOf` 产出的命令
 * @throws 视图不可用或某条命令被拒时抛出，由调用方退回 DOM 通道
 */
export async function sendCommands(contents: WebContents, commands: CdpCommand[]): Promise<void> {
  for (const command of commands) {
    await contents.debugger.sendCommand(command.method, command.params);
  }
}

/**
 * 在视图里点一个点（先确保挂上调试器）。
 * @param contents 内核视图句柄
 * @param point 视图坐标
 * @returns 成功发出为 true；attach 失败或命令被拒为 false（调用方据此改走 DOM 通道）
 */
export async function dispatchClick(contents: WebContents, point: ViewportPoint): Promise<boolean> {
  if (!ensureAttached(contents)) return false;
  try {
    await sendCommands(contents, mouseCommandsOf(point));
    return true;
  } catch {
    return false;
  }
}

/**
 * 往当前焦点控件里输入一段文本（可含中文）。
 * @param contents 内核视图句柄
 * @param point 先落在这上面的点（输入前必须让控件拿到焦点）
 * @param text 待输入文本
 * @returns 成功发出为 true
 */
export async function dispatchType(contents: WebContents, point: ViewportPoint, text: string): Promise<boolean> {
  if (!ensureAttached(contents)) return false;
  try {
    await sendCommands(contents, [...mouseCommandsOf(point), insertTextCommandOf(text)]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读某一帧里直接子 iframe 元素的位置。
 * @param frame 要读的那一帧
 * @returns 每个直接子 iframe 一条位置记录
 */
async function readIframeRects(frame: WebFrameMain): Promise<ReturnType<typeof toIframeRects>> {
  const raw = await frame.executeJavaScript(buildIframeRectsScript(), true);
  return toIframeRects(raw);
}

/**
 * 折算目标帧各层 iframe 的偏移（spec 2.2-09 的「iframe 内也能点准」）。
 *
 * 跨源帧读不到 `frameElement`，所以只能按「解析后的 src 相同」+「同 src 里的第几个」来认；
 * 认不出任何一层就返回 `resolved: false`，让上层改走 DOM 通道，而不是点一个猜出来的坐标。
 * @param frame 目标帧
 * @returns 由外到内的各层偏移，以及是否每一层都认出来了
 */
export async function frameOffsetsOf(frame: WebFrameMain): Promise<FrameOffsetReading> {
  const rects: ElementRect[] = [];
  let child = frame;
  let parent = child.parent;
  let resolved = true;
  while (parent) {
    let siblings: IframeRect[] = [];
    try {
      siblings = await readIframeRects(parent);
    } catch {
      resolved = false;
      break;
    }
    const sameSrc = siblings.filter((item) => item.src === child.url);
    const byName = siblings.filter((item) => item.name !== '' && item.name === child.name);
    const pool = sameSrc.length > 0 ? sameSrc : byName;
    const hit = pool[ordinalInParent(parent, child)] ?? pool[0];
    if (!hit) {
      resolved = false;
      break;
    }
    rects.unshift({ x: hit.x, y: hit.y, width: hit.width, height: hit.height });
    child = parent;
    parent = child.parent;
  }
  return { rects, resolved };
}

/**
 * 把目标帧里的一个矩形折算成视图坐标。
 * @param frame 目标帧
 * @param rect 元素在自身帧视口里的位置
 * @returns 视图坐标，以及每一层偏移是否都认出来了（为 false 时调用方必须改走 DOM 通道）
 */
export async function viewportPointOf(
  frame: WebFrameMain,
  rect: ElementRect,
): Promise<{ point: ViewportPoint; resolved: boolean }> {
  const offset = await frameOffsetsOf(frame);
  return { point: foldFrameOffsets(centerOf(rect), offset.rects), resolved: offset.resolved };
}
