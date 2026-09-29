/**
 * CDP 客户端：通过 Electron 的 `--remote-debugging-port` 直接看页面、操作页面、截图。
 *
 * 这是「agent 自己测自己的页面」的通道（P1 plan §6），不依赖任何测试框架：
 * 只用 Node 24 内置的 `fetch` 与全局 `WebSocket`，不引 puppeteer / playwright。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 注入页面执行的点击逻辑：只以字符串形式存在，因此不参与本包的 DOM 类型检查。 */
const CLICK_BY_TEXT = `(text) => {
  const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], [role="tab"]'));
  const hit = nodes.find((node) => (node.textContent ?? '').trim().includes(text));
  if (!hit) return false;
  hit.click();
  return true;
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
  private nextId = 1;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => this.onMessage(String(event.data)));
  }

  /**
   * 连接到一个页面型 target。
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

  /**
   * 按可见文本点击元素（按钮/链接），找不到就报错。
   * 自动化验收用它代替测试脚本里的选择器假设。
   */
  async clickText(text: string): Promise<boolean> {
    return this.evaluate<boolean>(`(${CLICK_BY_TEXT})(${JSON.stringify(text)})`);
  }

  /** 读取整页可见文本，用于把界面内容写进验收记录。 */
  readText(): Promise<string> {
    return this.evaluate<string>('document.body.innerText');
  }

  close(): void {
    this.socket.close();
  }

  private onMessage(raw: string) {
    const message = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message: string } };
    if (typeof message.id !== 'number') return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  }
}
