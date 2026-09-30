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
 *
 * 文件注入走的是另一条 CDP 路（`DOM.setFileInputFiles`）：它不需要坐标，也就不受 iframe 偏移
 * 折算成败的影响，但必须拿到「节点引用」——四条看着都能用的取路（`selector` / `nodeId` /
 * `backendNodeId` / `requestNode`）都被本机 spike 否决过，理由写在 plan §13.3 第 4 条，
 * 只留下 `Runtime.evaluate → objectId → setFileInputFiles` 这一条被实测通过的那一条。
 */
import type { ElementRect } from '@auto-cc/shared';
import type { WebContents, WebFrameMain } from 'electron';
import { ordinalInParent } from './frame-channel.js';
import {
  buildIframeRectsScript,
  toIframeRects,
  toUploadReading,
  type IframeRect,
  type UploadReading,
} from './locator-script.js';

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

/** 注入文件用的隔离世界名：同一帧重复注入复用同一个世界，探针也留在同一个 `globalThis` 上。 */
const UPLOAD_WORLD = 'auto-cc-upload';

/** 帧树里的一帧：CDP 只给 id 与地址，后面的取节点都要靠这两个。 */
export type FrameEntry = { frameId: string; url: string };

/** 一次 CDP 文件注入的结局。 */
export type UploadInjection = {
  /** 命令是否一条不落地走通了；至于文件有没有真进控件，看 `reading` */
  ok: boolean;
  /** 失败落在哪一步（含被拒的命令原文摘要）；成功时为空串 */
  error: string;
  /** 页面自己报上来的读数，`ok` 为 false 时是全零 */
  reading: UploadReading;
};

/**
 * 依次发送 CDP 命令并回传**第一条的响应体**。
 * @param contents 内核视图句柄
 * @param command 单条命令
 * @returns 该命令的回包（CDP 的空回包是 `{}`）
 * @throws 视图不可用或命令被拒时抛出，由调用方翻成结构化失败
 */
async function sendRequest(contents: WebContents, command: CdpCommand): Promise<unknown> {
  return contents.debugger.sendCommand(command.method, command.params);
}

/**
 * 生成文件注入前要开的三个 CDP 域。
 * @returns `Page` / `Runtime` / `DOM` 三条 enable 命令（取帧树、求值、注入各依赖其一）
 */
export function uploadDomainEnableCommands(): CdpCommand[] {
  return [
    { method: 'Page.enable', params: {} },
    { method: 'Runtime.enable', params: {} },
    { method: 'DOM.enable', params: {} },
  ];
}

/**
 * 生成读整棵帧树的命令。
 * @returns `Page.getFrameTree` 命令
 */
export function frameTreeCommand(): CdpCommand {
  return { method: 'Page.getFrameTree', params: {} };
}

/**
 * 生成「为目标帧建一个我们的执行上下文」的命令。
 *
 * `Runtime.evaluate` 不带 `contextId` 只会落在顶层主世界，所以子帧里的控件必须先建隔离世界才取到引用；
 * spike 实测隔离世界拿到的 objectId 就是页面上那个真节点，站点自己注册的 `change` 监听器照样被触发。
 * @param frameId 目标帧 id（来自 `frameTreeCommand()` 的回包）
 * @returns `Page.createIsolatedWorld` 命令
 */
export function isolatedWorldCommand(frameId: string): CdpCommand {
  return { method: 'Page.createIsolatedWorld', params: { frameId, worldName: UPLOAD_WORLD } };
}

/**
 * 生成「求值并把结果留成远端对象」的命令（`returnByValue:false` 才有 objectId）。
 * @param expression 节点引用脚本源码
 * @param contextId 隔离世界的执行上下文 id
 * @returns `Runtime.evaluate` 命令
 */
export function nodeHandleCommand(expression: string, contextId: number): CdpCommand {
  return { method: 'Runtime.evaluate', params: { expression, returnByValue: false, contextId } };
}

/**
 * 生成把文件塞进某个 `input[type=file]` 的命令。
 *
 * 只用 `objectId` 寻址：`selector` 会被当未知参数忽略（回包原文见 plan §13.2 第 2 条），
 * `nodeId` / `backendNodeId` 需要先 `DOM.getDocument` 才不是无效的 0，四条路里只有这一条实测可用。
 * @param files 待注入的**绝对路径**数组（一次只有一个，站点多为单选）
 * @param objectId 目标节点的远端引用
 * @returns `DOM.setFileInputFiles` 命令
 */
export function setFileInputFilesCommand(files: string[], objectId: string): CdpCommand {
  return { method: 'DOM.setFileInputFiles', params: { files, objectId } };
}

/**
 * 生成「在注入时那一个节点上回读文件」的命令。
 *
 * 走 `Runtime.callFunctionOn` 而不是重新求值一段脚本：函数体里的 `this` 就是当初那个 objectId，
 * 于是「注入的控件」与「回读的控件」在类型上就是同一个对象，不可能一个进了 A、另一个读的是 B。
 * @param objectId 注入时用的远端引用
 * @param functionDeclaration `buildUploadReadbackFunction()` 产出的函数声明源码
 * @returns `Runtime.callFunctionOn` 命令
 */
export function uploadReadbackCommand(objectId: string, functionDeclaration: string): CdpCommand {
  return {
    method: 'Runtime.callFunctionOn',
    params: { objectId, functionDeclaration, returnByValue: true, awaitPromise: true },
  };
}

/**
 * 钳制 `Runtime.callFunctionOn(returnByValue:true)` 的回包里的函数返回值。
 *
 * CDP 把兑现后的值放在 `result.value`，而 `result` 可能因为异常或跨上下文兑现失败而缺席；
 * 这里只做搬运，字段级的钳制仍归 `toUploadReading`，避免同一个读数被两处各校验一遍。
 * @param raw CDP 回包
 * @returns 页面函数 resolve 出来的那个对象；拿不到时为 `{}`（于是读数全零）
 */
export function toCallFunctionValue(raw: unknown): unknown {
  const value = (raw ?? {}) as Record<string, unknown>;
  const result = (value.result ?? {}) as Record<string, unknown>;
  return result.value ?? {};
}

/**
 * 钳制 `Page.getFrameTree` 回包：拍平成「帧 id + 地址」的表，含所有子帧。
 * @param raw CDP 回包
 * @returns 由外到内的帧条目；回包畸形时为空数组
 */
export function toFrameEntries(raw: unknown): FrameEntry[] {
  const entries: FrameEntry[] = [];
  const walk = (node: unknown): void => {
    const value = (node ?? {}) as Record<string, unknown>;
    const frame = (value.frame ?? {}) as Record<string, unknown>;
    if (typeof frame.id === 'string' && typeof frame.url === 'string') {
      entries.push({ frameId: frame.id, url: frame.url });
    }
    if (Array.isArray(value.childFrames)) value.childFrames.forEach(walk);
  };
  const tree = ((raw ?? {}) as Record<string, unknown>).frameTree;
  walk(tree);
  return entries;
}

/**
 * 钳制 `Page.createIsolatedWorld` 回包里的执行上下文 id。
 * @param raw CDP 回包
 * @returns 上下文 id；没有就返回 null（建世界失败）
 */
export function toIsolatedContextId(raw: unknown): number | null {
  const value = (raw ?? {}) as Record<string, unknown>;
  return typeof value.executionContextId === 'number' && isFinite(value.executionContextId)
    ? value.executionContextId
    : null;
}

/**
 * 钳制节点引用求值的回包。
 *
 * 三种「看着像成功、其实什么都能往下走」的形状都判为失败：脚本抛异常、求值结果是 null
 * （locator 选中的节点已经不在了）、结果不是节点。只有 `subtype === 'node'` 才配拿到 objectId。
 * @param raw `Runtime.evaluate` 回包
 * @returns 节点引用，以及拿不到时的一句原因
 */
export function toNodeObjectId(raw: unknown): { objectId: string | null; error: string } {
  const value = (raw ?? {}) as Record<string, unknown>;
  if (value.exceptionDetails) return { objectId: null, error: '取节点引用的脚本在本帧里抛了异常' };
  const result = (value.result ?? {}) as Record<string, unknown>;
  if (result.subtype === 'null') {
    return {
      objectId: null,
      error: '页面里已经没有「定位时选中的那一个」节点（被移除、几何已变，或它不是 input[type=file]）',
    };
  }
  if (result.type !== 'object' || result.subtype !== 'node' || typeof result.objectId !== 'string') {
    // 回包里的类型字段来自页面，拼进原因之前先各自钳成字符串，免得把对象原样印进日志。
    const typeName = typeof result.type === 'string' ? result.type : '未知';
    const subtypeName = typeof result.subtype === 'string' ? result.subtype : '无子类型';
    return { objectId: null, error: `求值结果不是一个节点（${typeName} / ${subtypeName}）` };
  }
  return { objectId: result.objectId, error: '' };
}

/**
 * 沿「取帧树 → 建隔离世界 → 取节点引用 → 注入 → 回读」走完一次文件注入（spec 2.6-04）。
 *
 * 每一步的失败都翻成读数而不是抛出：这条链上没有任何一步可以降级到 DOM 通道
 * （`input.files` 是只读的，脚本伪造不出一个真文件），所以调用方拿到的只有「成功 + 页面回读」
 * 与「失败 + 一句原因」两种结果。
 * @param contents 内核视图句柄
 * @param frameUrl 定位读数所在帧的地址（用它去帧树里对号）
 * @param handleScript `buildNodeHandleScript` 产出的表达式源码
 * @param filePath 待注入文件的绝对路径
 * @param readbackFunction `buildUploadReadbackFunction` 产出的函数声明源码
 * @returns 注入结局与页面回读；不抛异常
 */
export async function dispatchUpload(
  contents: WebContents,
  frameUrl: string,
  handleScript: string,
  filePath: string,
  readbackFunction: string,
): Promise<UploadInjection> {
  const failed = (error: string): UploadInjection => ({ ok: false, error, reading: toUploadReading(null) });
  if (!ensureAttached(contents)) return failed('调试器挂不上（视图已销毁，或已被别的客户端占用）');
  try {
    for (const command of uploadDomainEnableCommands()) await sendRequest(contents, command);
    const frames = toFrameEntries(await sendRequest(contents, frameTreeCommand()));
    const frame = frames.find((item) => item.url === frameUrl);
    if (!frame) return failed(`帧树里已经没有这一帧：${frameUrl || '（无地址）'}`);
    const contextId = toIsolatedContextId(await sendRequest(contents, isolatedWorldCommand(frame.frameId)));
    if (contextId === null) return failed(`为帧 ${frame.frameId} 创建隔离世界失败`);
    const handle = toNodeObjectId(await sendRequest(contents, nodeHandleCommand(handleScript, contextId)));
    if (!handle.objectId) return failed(handle.error);
    await sendRequest(contents, setFileInputFilesCommand([filePath], handle.objectId));
    const readback = await sendRequest(contents, uploadReadbackCommand(handle.objectId, readbackFunction));
    return { ok: true, error: '', reading: toUploadReading(toCallFunctionValue(readback)) };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}
