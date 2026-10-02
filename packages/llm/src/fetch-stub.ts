/**
 * 测试用的 `globalThis.fetch` 存根（只在 `*.test.ts` 里用，不进任何运行时路径）。
 *
 * `llm.chat` 与 `llm.embed` 都要「打本地存根、绝不真打模型端点」（AGENTS.md §7.2），
 * 记录下来的请求形态又是同一套读法，所以按 §2.2 抽在这里，两处测试共用。
 */

/** 一次被记录下来的调用。 */
export interface RecordedRequest {
  /** 存根收到的地址 */
  url: string;
  /** 存根收到的 fetch 第二参数（未传时记成空对象，测试里 `JSON.parse(bodyText(...))` 才不会炸） */
  init: RequestInit;
}

/**
 * 把 `globalThis.fetch` 换成存根并记录请求。
 * @param reply 存根回的响应（Response 或抛出的异常工厂）——由调用方决定回 200、回 401 还是直接 reject
 * @returns `requests` 每次调用的 url 与 init，`restore` 把全局 fetch 换回去
 */
export function stubFetch(reply: () => Promise<Response> | Promise<never>): {
  requests: RecordedRequest[];
  restore: () => void;
} {
  const requests: RecordedRequest[] = [];
  const original = globalThis.fetch;
  const stub: typeof fetch = (input, init) => {
    // `RequestInfo | URL` 里只有字符串这一支是被测代码实际传的，其余分支占位成可辨识的假地址。
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : '(request)';
    requests.push({ url, init: init ?? {} });
    return reply();
  };
  globalThis.fetch = stub;
  return { requests, restore: () => (globalThis.fetch = original) };
}

/**
 * 把存根记录下来的请求体取成文本。
 * @param init 存根收到的 fetch 第二参数
 * @returns `body` 的字符串形态（被测代码只传字符串；非字符串按空对象处理，测试会因此失败而不是误判）
 */
export const bodyText = (init: RequestInit): string => (typeof init.body === 'string' ? init.body : '{}');

/**
 * 造一个 JSON 响应。
 * @param value 响应体（会被 `JSON.stringify`）
 * @param status HTTP 状态码，默认 200（测非 2xx 分支时传 401 / 500）
 * @returns 真实 `Response` 实例，好让被测代码里的 `response.json()` 走原生解析
 */
export const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
