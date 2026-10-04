/**
 * CDP 客户端：通过 Electron 的 `--remote-debugging-port` 直接看页面、操作页面、截图。
 *
 * 这是「agent 自己测自己的页面」的通道（P1 plan §6），不依赖任何测试框架：
 * 只用 Node 24 内置的 `fetch` 与全局 `WebSocket`，不引 puppeteer / playwright。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 元素定位描述：优先 CSS 选择器（机读锚点），退化为可见文本 / placeholder / aria-label 匹配。 */
export type TargetSpec = { selector?: string; text?: string };

/**
 * 页面里跑的匹配器：以字符串存在，因此不参与本包的 DOM 类型检查。
 * 通过 `Runtime.callFunctionOn` 的实参传 spec，不再往页面全局挂临时变量。
 */
const MATCH_SOURCE = `(spec) => {
  if (spec.selector) return document.querySelector(spec.selector);
  const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], [role="tab"], input, textarea, select, label'));
  return nodes.find(
    (node) =>
      (node.textContent ?? '').trim().includes(spec.text) ||
      (node.getAttribute('placeholder') ?? '').includes(spec.text) ||
      (node.getAttribute('aria-label') ?? '').includes(spec.text),
  );
}`;

/** 定位并滚到视口中央，返回中心点坐标——真实点击要用它，`element.click()` 跳过了命中测试。 */
const RECT_SOURCE = `function (spec) {
  const el = (${MATCH_SOURCE})(spec);
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    isEnabled: !el.disabled,
  };
}`;

/**
 * 元素中心点的视口坐标（CSS 像素）——`locate` 与 `drag` 共用的读数形状。
 */
interface ElementRect {
  tag: string;
  x: number;
  y: number;
  isEnabled: boolean;
}

/**
 * 只量位置、**不滚动**的读数口。
 *
 * 拖拽必须用它：两端各自 `scrollIntoView` 会先把对方推出画面（第二次滚动改写了第一次的坐标系），
 * 于是按下点与松开点落在两个不同的滚动状态上，边永远连不上。正确顺序是「滚一次 → 等动画落定 → 两端各读一次」。
 */
const RECT_READ_SOURCE = `function (spec) {
  const el = (${MATCH_SOURCE})(spec);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    isEnabled: !el.disabled,
  };
}`;

/**
 * 目标元素当前的位置与尺寸（视口坐标，CSS 像素）。
 *
 * `inner` 是视口高度，用来判断元素是不是已经整个装进了画面。
 */
const SCROLL_STATE = `function (sel) {
  const target = document.querySelector(sel);
  if (!target) throw new Error('页面上没有匹配 ' + sel + ' 的元素');
  const rect = target.getBoundingClientRect();
  // 可见框不是整个窗口：渲染层把内容放在带 overflow-y-auto 的容器里，上方还有固定标题栏。
  // 只拿 window.innerHeight 判"到位"，会把被容器上沿裁掉的元素当成已经进画面（实测 5.10 校验列表 top=11 却看不见）。
  let clipTop = 0;
  let clipBottom = window.innerHeight;
  let ancestor = target.parentElement;
  while (ancestor) {
    if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(ancestor).overflowY)) {
      const box = ancestor.getBoundingClientRect();
      clipTop = Math.max(clipTop, box.top);
      clipBottom = Math.min(clipBottom, box.bottom);
    }
    ancestor = ancestor.parentElement;
  }
  return {
    top: Math.round(rect.top),
    height: Math.round(rect.height),
    clipTop: Math.round(clipTop),
    clipBottom: Math.round(clipBottom),
  };
}`;

/** 滚动收敛的轮数上限：到不了就报错，不拍一张拍错的东西当证据。 */
const SCROLL_MAX_ROUNDS = 40;

/** 单轮滚轮事件允许的最大位移（CSS 像素）——一次派发整段距离会被平滑动画放大，实测会直接冲到底。 */
const SCROLL_STEP = 300;

/** 判断「元素已完整进画面」时允许的像素误差（滚动位置带小数，取整后会差 1px）。 */
const SCROLL_TOLERANCE = 2;

/** 元素到位后离可见框上沿留出的像素间距——贴着上沿容易被标题栏/边框压住。 */
const SCROLL_EDGE_GAP = 24;

/** 一轮滚动之后留给平滑动画的时间（毫秒）——只等两帧会被动画截胡。 */
const SCROLL_SETTLE_MS = 100;

/** 聚焦目标元素，回读它的标签与当前值（输入前后的对照）。 */
const FOCUS_SOURCE = `function (spec) {
  const el = (${MATCH_SOURCE})(spec);
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  if (typeof el.focus === 'function') el.focus();
  return { tag: el.tagName.toLowerCase(), value: typeof el.value === 'string' ? el.value : null };
}`;

/** 读取元素的值 / 文本，作为断言的可观察落点。 */
const READ_SOURCE = `function (spec) {
  const el = (${MATCH_SOURCE})(spec);
  if (!el) return null;
  return { tag: el.tagName.toLowerCase(), value: typeof el.value === 'string' ? el.value : null, text: (el.textContent ?? '').trim() };
}`;

/** DOM 快照：把匹配到的节点压成机读结构，避免把整页 HTML 灌进上下文。 */
const SNAPSHOT_SOURCE = `function (spec) {
  const nodes = spec.selector ? Array.from(document.querySelectorAll(spec.selector)) : [];
  return nodes.map((node, index) => {
    const attrs = {};
    for (const name of spec.attrs ?? []) {
      const value = node.getAttribute(name);
      if (value !== null) attrs[name] = value;
    }
    return { index, tag: node.tagName.toLowerCase(), attrs, text: (node.textContent ?? '').trim().slice(0, 120) };
  });
}`;

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** 读取某个调试端口上的全部 target（页面、视图、worker 等）。 */
export async function listTargets(port: number): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`);
  if (!response.ok) throw new Error(`CDP /json/list 返回 HTTP ${String(response.status)}`);
  return (await response.json()) as CdpTarget[];
}

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void };

/** CDP 抛回页面异常时能拿到的字段（不同 Chrome 版本给的不全）。 */
type ExceptionDetails = {
  text: string;
  lineNumber?: number;
  exception?: { description?: string };
};

/**
 * 把页面异常拼成一句能直接读的原因。
 *
 * `text` 单独用几乎等于没报——求值失败时它固定是 `Uncaught`，真正的原因在
 * `exception.description`（含类型与消息）里。自测通道要求「失败原因留在输出里」，
 * 所以这里必须把两层都带上。
 */
function describeException(details: ExceptionDetails): string {
  const line = typeof details.lineNumber === 'number' ? ` @ 第 ${String(details.lineNumber + 1)} 行` : '';
  return `${details.exception?.description ?? details.text}${line}`;
}

/**
 * 本地测试地址的主机名：回环 v4/v6 与 `localhost`。
 *
 * `URL.hostname` 对 IPv6 会带回方括号（`http://[::1]:10222` → `[::1]`），所以两种写法都收。
 */
const LOCAL_TEST_HOST = /^(?:127\.(?:\d{1,3}\.){2}\d{1,3}|localhost|\[[\da-f:]+\])$/i;

/** 允许出现在本地测试地址上的协议：`file:` 开的是本机产物，其余四种只要主机是回环就不出网。 */
const LOCAL_TEST_PROTOCOLS = ['http:', 'https:', 'ws:', 'wss:'];

/**
 * 判一个 harness 要导航过去的地址是不是本地地址。
 *
 * 这是 AGENTS.md §7.2 的**运行期半边**：字符串面由 `scripts/check-compliance-redlines.ts` 规则三扫
 * 测试与脚本源码，但那里判不了变量拼出来的 URL（`harness open --url` 就是人现场敲的一个字符串）。
 * 主机在真正发请求之前拦，是这条规则唯一还能兜住人为失误的位置。
 * @param url 要导航的完整地址（相对地址一律拒绝：没有主机就无从判定）
 * @returns 放行返回 null；否则返回可直接打印的拒绝原因（**不抛异常**，好让单测把两半都判成表驱动）
 */
export function localTestUrlViolation(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `「${url}」不是完整 URL（相对地址无法判定主机，也就无法证明它不出网）`;
  }
  // `file:` 读本机磁盘，不会产生任何出网请求；验收里"打开导出产物看一眼"走的就是它。
  if (parsed.protocol === 'file:') return null;
  if (!LOCAL_TEST_PROTOCOLS.includes(parsed.protocol)) return `协议 ${parsed.protocol} 不在本地测试白名单内`;
  if (LOCAL_TEST_HOST.test(parsed.hostname)) return null;
  return (
    `主机「${parsed.hostname}」不是本地地址。harness 只许驱动本地 fixture 与 app 自己的页面` +
    '（127.0.0.1 / localhost / [::1]）；真实招聘平台只在用户在场时手动验证（AGENTS.md §7.2 / spec 4.4-08）'
  );
}

/** 一个已连上某个 target 的 CDP 会话。 */
export class CdpSession {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, Pending>();
  /** CDP 事件等待队列（事件没有 id，只能按方法名匹配）。 */
  private readonly eventWaiters = new Map<string, Array<() => void>>();
  private nextId = 1;
  /**
   * `callFunctionOn` 必须绑定到某个对象/执行上下文，Chrome 不接受裸函数声明。
   * 这里缓存 globalThis 的 objectId 复用；页面导航会销毁上下文，所以 navigate 之后要重取。
   */
  private globalObjectId?: string;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => this.onMessage(String(event.data)));
  }

  /**
   * 连接到一个页面 target。
   * @param port 调试端口
   * @param urlContains 可选：按 URL 子串挑选 target（渲染层与内核视图会同时存在）
   * @returns 已建立连接的会话
   */
  static async attach(port: number, urlContains?: string): Promise<CdpSession> {
    const targets = await listTargets(port);
    const candidates = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    const target = urlContains
      ? candidates.find((item) => item.url.includes(urlContains) || item.title.includes(urlContains))
      : candidates[0];
    if (!target?.webSocketDebuggerUrl) {
      throw new Error(
        `未找到可连接的页面 target（端口 ${String(port)}，过滤词 ${String(urlContains)}）。当前 targets：\n` +
          candidates.map((item) => `  - ${item.title} ${item.url}`).join('\n'),
      );
    }
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    const session = new CdpSession(socket);
    await session.send('Page.enable');
    return session;
  }

  /** 发送一条 CDP 命令并等待同一 id 的应答。 */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 等一条 CDP 事件（如 `Page.loadEventFired`），超时抛错。 */
  waitForEvent(method: string, timeoutMs = 15_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.eventWaiters.get(method) ?? [];
        this.eventWaiters.set(
          method,
          waiters.filter((waiter) => waiter !== settle),
        );
        reject(new Error(`等待事件超时（${String(timeoutMs)}ms）：${method}`));
      }, timeoutMs);
      const settle = () => {
        clearTimeout(timer);
        resolve();
      };
      this.eventWaiters.set(method, [...(this.eventWaiters.get(method) ?? []), settle]);
    });
  }

  /** 在页面上下文里求值，返回可序列化结果。 */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send<{ result?: { value?: T }; exceptionDetails?: ExceptionDetails }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
    );
    if (result.exceptionDetails) throw new Error(`页面求值失败：${describeException(result.exceptionDetails)}`);
    return result.result?.value as T;
  }

  /**
   * 取得（并缓存）页面全局对象的 objectId，作为 `callFunctionOn` 的宿主上下文。
   * @returns 可用的 objectId
   * @throws 页面没有可供绑定的全局对象
   */
  private async ensureGlobal(): Promise<string> {
    if (this.globalObjectId) return this.globalObjectId;
    const { result } = await this.send<{ result: { objectId?: string } }>('Runtime.evaluate', {
      expression: 'globalThis',
      returnByValue: false,
    });
    if (!result.objectId) throw new Error('页面未返回 globalThis 的 objectId');
    this.globalObjectId = result.objectId;
    return this.globalObjectId;
  }

  /**
   * 在页面里调用一个函数声明，实参走 CDP 序列化（不污染 window，也不拼字符串字面量）。
   * @param functionDeclaration 函数源码
   * @param args 可序列化实参
   */
  async callOn<T = unknown>(functionDeclaration: string, args: unknown[] = []): Promise<T> {
    const result = await this.send<{ result?: { value?: T }; exceptionDetails?: ExceptionDetails }>(
      'Runtime.callFunctionOn',
      {
        objectId: await this.ensureGlobal(),
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        declaration: true,
        returnByValue: true,
        awaitPromise: true,
      },
    );
    if (result.exceptionDetails) throw new Error(`页面函数执行失败：${describeException(result.exceptionDetails)}`);
    return result.result?.value as T;
  }

  /**
   * 截图并落盘。
   * @param file 输出 png 路径
   * @param reveal 可选 CSS 选择器：截图前把该元素滚进画面（长页面里目标面板常在折叠线以下）
   * @returns 写入的绝对路径
   */
  async screenshot(file: string, reveal?: string): Promise<string> {
    // 窗口被别的应用挡住时 Chrome 不再产出新帧，`captureScreenshot` 会一直等下去（实测挂满 60s）；
    // 先把这个 target 带到前台，截图才有确定的帧可取。
    await this.send('Page.bringToFront');
    if (reveal) await this.scrollTo(reveal);
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    const target = path.resolve(file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(data, 'base64'));
    return target;
  }

  /**
   * 把目标元素滚到视口上部。
   *
   * 不用 `scrollIntoView` / 写 `scrollTop`：实测那样只改 DOM，合成器画面仍然停在折叠线以上
   * （截图与未滚动时逐字节相同）。滚轮事件走浏览器真实的滚动路径，画面才会跟着动。
   * 一次滚轮会被当成一个手势平滑消化（要求滚 900 像素实测只走了 50），所以分多轮派发、每轮重量差值。
   * @param selector 目标元素的 CSS 选择器
   */
  private async scrollTo(selector: string): Promise<void> {
    let lastTop: number | undefined;
    for (let round = 0; round < SCROLL_MAX_ROUNDS; round += 1) {
      const { top, height, clipTop, clipBottom } = await this.callOn<{
        top: number;
        height: number;
        clipTop: number;
        clipBottom: number;
      }>(SCROLL_STATE, [selector]);
      // 整个元素都在可见框里（允许 2px 舍入）、或它比可见框还高（上下都溢出）都算到位，再滚只会把内容推过头。
      if (
        (top >= clipTop && top + height <= clipBottom + SCROLL_TOLERANCE) ||
        (top <= clipTop && top + height >= clipBottom)
      ) {
        return;
      }
      if (lastTop !== undefined && Math.abs(top - lastTop) < 1) {
        throw new Error(`已经滚到边界但 ${selector} 仍不在视口内，不拍错的东西`);
      }
      lastTop = top;
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 500,
        y: 400,
        deltaX: 0,
        deltaY: Math.max(-SCROLL_STEP, Math.min(SCROLL_STEP, top - (clipTop + SCROLL_EDGE_GAP))),
      });
      await this.settle();
    }
    throw new Error(`滚动 ${String(SCROLL_MAX_ROUNDS)} 轮后 ${selector} 仍未到位`);
  }

  /** 等平滑滚动动画落定（先给时间再等两帧），否则下一轮量到的是动画中途的位置。 */
  private async settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, SCROLL_SETTLE_MS));
    await this.callOn(
      'function () { return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))); }',
    );
  }

  /** 页面上是否出现了给定文本（用于断言渲染结果）。 */
  hasText(text: string): Promise<boolean> {
    return this.evaluate<boolean>(`document.body.innerText.includes(${JSON.stringify(text)})`);
  }

  /** 轮询等待给定文本出现，超时抛错。 */
  async waitForText(text: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.hasText(text)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`等待文本超时（${String(timeoutMs)}ms）：${text}`);
  }

  /**
   * 定位元素中心点；找不到返回 null（调用方决定是报错还是换 target）。
   *
   * 滚动之后必须复读一次：`scrollIntoView` 在带平滑滚动的容器里是**动画**，同一帧读到的 rect
   * 还是滚动前的位置（实测同一句柄两次读数差 67px，拖拽因此落在画面外的旧坐标上连不出边）。
   * 所以先滚、等动画落定、再量第二次，量不到的极端情况退回首帧读数。
   */
  async locate(spec: TargetSpec): Promise<ElementRect | null> {
    const scrolled = await this.callOn<ElementRect>(RECT_SOURCE, [spec]);
    if (!scrolled) return null;
    await this.settle();
    return (await this.callOn<ElementRect>(RECT_READ_SOURCE, [spec])) ?? scrolled;
  }

  /**
   * 真实点击：把鼠标事件发到元素中心点，走浏览器的命中测试与事件冒泡。
   * @returns 命中的元素标签
   * @throws 元素不存在
   */
  async click(spec: TargetSpec): Promise<string> {
    const hit = await this.locate(spec);
    if (!hit) throw new Error(`未找到可点击元素：${String(spec.selector ?? spec.text)}`);
    const base = { x: hit.x, y: hit.y, button: 'left' as const, clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' });
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
    return hit.tag;
  }

  /**
   * 真实拖拽：在 `fromSpec` 元素中心按住左键，分步移到 `toSpec` 元素中心后松开。
   *
   * 为什么非走 CDP 不可：react-flow 的连线与节点拖拽建在 d3-drag 上，它只认浏览器派发的**可信事件**——
   * 实测在页面里 `dispatchEvent` 一整套 pointer/mouse 序列之后 `.react-flow__edge` 数量纹丝不动
   * （spec 5.10-14 的活体缺口就是这个），所以连线类判据必须用这条真事件通道。
   * 中间的 `mouseMoved` 一律带 `buttons: 1`：不带就等于告诉浏览器"左键已松开"，拖拽会话刚起就结束。
   * @param fromSpec 起点元素（按住的那只句柄）
   * @param toSpec 终点元素（松开时落到的句柄）
   * @param steps 中间移动步数，默认 12；步数太少会让命中测试跳过目标句柄
   * @returns 起终点中心坐标，失败时用来定位是哪一个元素没量对
   * @throws 任一端元素不存在
   */
  async drag(
    fromSpec: TargetSpec,
    toSpec: TargetSpec,
    steps = 12,
  ): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } }> {
    // 只滚一次（把起点带到画面中间），等动画落定后两端各量一次：这样两个坐标出自同一份滚动状态，
    // 才可比。两端各自 scrollIntoView 会让第二次滚动把第一个端点推走——实测正是边连不上的原因。
    await this.callOn(RECT_SOURCE, [fromSpec]);
    await this.settle();
    const from = await this.callOn<ElementRect | null>(RECT_READ_SOURCE, [fromSpec]);
    if (!from) throw new Error(`拖拽起点未找到：${String(fromSpec.selector ?? fromSpec.text)}`);
    const to = await this.callOn<ElementRect | null>(RECT_READ_SOURCE, [toSpec]);
    if (!to) throw new Error(`拖拽终点未找到：${String(toSpec.selector ?? toSpec.text)}`);
    const viewport = await this.evaluate<{ width: number; height: number }>(
      '({ width: window.innerWidth, height: window.innerHeight })',
    );
    for (const [name, point] of [
      ['起点', from],
      ['终点', to],
    ] as const) {
      if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) {
        throw new Error(
          `拖拽${name}不在视口内（${String(Math.round(point.x))},${String(Math.round(point.y))}，视口 ` +
            `${String(viewport.width)}x${String(viewport.height)}）：拒绝往画面外派发事件，宁可报错也不拖出假证据`,
        );
      }
    }
    const button = 'left' as const;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: from.x,
      y: from.y,
      button,
      buttons: 1,
      clickCount: 1,
    });
    for (let step = 1; step <= steps; step += 1) {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.x + ((to.x - from.x) * step) / steps,
        y: from.y + ((to.y - from.y) * step) / steps,
        buttons: 1,
      });
    }
    // 松手前等两帧：xyflow 在 mousemove 里记"当前悬停的句柄"，最后一帧没被消化就松手会连不上。
    await this.settle();
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: to.x,
      y: to.y,
      button,
      buttons: 0,
      clickCount: 1,
    });
    return { from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } };
  }

  /**
   * 真实输入：先聚焦元素，再走 `Input.insertText`（与输入法同一条路径，会派发原生 input 事件）。
   * @returns 输入前后的值对照
   * @throws 元素不存在或不是可输入控件
   */
  async type(spec: TargetSpec, value: string): Promise<{ before: string | null; after: string | null; tag: string }> {
    const focused = await this.callOn<{ tag: string; value: string | null } | null>(FOCUS_SOURCE, [spec]);
    if (!focused) throw new Error(`未找到可输入元素：${String(spec.selector ?? spec.text)}`);
    // 先清空：insertText 是「插入」，不清就会把新值拼到旧值后面，界面上看着像没生效。
    await this.evaluate('document.activeElement && (document.activeElement.value = "")');
    await this.send('Input.insertText', { text: value });
    const after = await this.callOn<{ value: string | null } | null>(READ_SOURCE, [spec]);
    return { before: focused.value, after: after?.value ?? null, tag: focused.tag };
  }

  /**
   * 导航当前 target 并等 `Page.loadEventFired`。
   * @param url 目标地址，**必须是本地地址**（回环或 `file:`），见 `localTestUrlViolation`
   * @throws 非本地地址时先抛错、一个 CDP 命令都不发；其余同底层 `Page.navigate`
   */
  async navigate(url: string): Promise<void> {
    // 守卫放在发命令之前：`Page.navigate` 一旦送达，浏览器就已经把请求发出去了，再判就晚了。
    const violation = localTestUrlViolation(url);
    if (violation) throw new Error(`拒绝导航：${violation}`);
    const loaded = this.waitForEvent('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
    // 导航会销毁旧的执行上下文，缓存的 objectId 随之失效，下一次调用要重取。
    this.globalObjectId = undefined;
  }

  /** DOM 快照：匹配节点的机读结构（属性 + 截断文本）。 */
  snapshot(selector: string, attrs: string[] = []): Promise<unknown[]> {
    return this.callOn(SNAPSHOT_SOURCE, [{ selector, attrs }]);
  }

  /** 读取整页可见文本，用于把界面内容写进验收记录。 */
  readText(): Promise<string> {
    return this.evaluate<string>('document.body.innerText');
  }

  close(): void {
    this.socket.close();
  }

  private onMessage(raw: string) {
    const message = JSON.parse(raw) as {
      id?: number;
      method?: string;
      result?: unknown;
      error?: { message: string };
    };
    if (typeof message.id === 'number') {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    if (!message.method) return;
    const waiters = this.eventWaiters.get(message.method);
    if (!waiters?.length) return;
    const [settle, ...rest] = waiters;
    this.eventWaiters.set(message.method, rest);
    settle?.();
  }
}
