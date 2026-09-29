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

/** 一个已连上某个 target 的 CDP 会话。 */
export class CdpSession {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, Pending>();
  /** CDP 事件等待队列（事件没有 id，只能按方法名匹配）。 */
  private readonly eventWaiters = new Map<string, Array<() => void>>();
  private nextId = 1;

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
    const result = await this.send<{ result?: { value?: T }; exceptionDetails?: { text: string } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
    );
    if (result.exceptionDetails) throw new Error(`页面求值失败：${result.exceptionDetails.text}`);
    return result.result?.value as T;
  }

  /**
   * 在页面里调用一个函数声明，实参走 CDP 序列化（不污染 window，也不拼字符串字面量）。
   * @param functionDeclaration 函数源码
   * @param args 可序列化实参
   */
  async callOn<T = unknown>(functionDeclaration: string, args: unknown[] = []): Promise<T> {
    const result = await this.send<{ result?: { value?: T }; exceptionDetails?: { text: string } }>(
      'Runtime.callFunctionOn',
      {
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        declaration: true,
        returnByValue: true,
        awaitPromise: true,
      },
    );
    if (result.exceptionDetails) throw new Error(`页面函数执行失败：${result.exceptionDetails.text}`);
    return result.result?.value as T;
  }

  /**
   * 截图并落盘。
   * @param file 输出 png 路径
   * @returns 写入的绝对路径
   */
  async screenshot(file: string): Promise<string> {
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    const target = path.resolve(file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(data, 'base64'));
    return target;
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

  /** 定位元素中心点；找不到返回 null（调用方决定是报错还是换 target）。 */
  locate(spec: TargetSpec): Promise<{ tag: string; x: number; y: number; isEnabled: boolean } | null> {
    return this.callOn(RECT_SOURCE, [spec]);
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

  /** 导航当前 target 并等 `Page.loadEventFired`。 */
  async navigate(url: string): Promise<void> {
    const loaded = this.waitForEvent('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
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
