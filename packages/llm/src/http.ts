/**
 * `llm.chat` 与 `llm.embed` 共用的 HTTP 骨架（spec 2.5-12 / 4.3-08）。
 *
 * 两个服务做的是**同一件事**：带 Bearer 头发一段 JSON、按超时掐断、把失败变成结构化错误
 * （POST 是补全与向量，GET 是 `/models` 清单探测，共用同一具骨架）。
 * AGENTS.md §2.2 要求「同一逻辑出现第二次就抽公共层」，而 §2.7 禁的是**第二个客户端**，
 * 不是同一个客户端的第二个方法——所以这里抽的是传输骨架，端点与响应解析仍各自留在两个服务里。
 *
 * `describeError()` 的第三支是实测逼出来的（plan §4.3-d 证据 [2]）：硅基流动的错误体是**顶层**
 * `{code, data, message}`，而 OpenAI / DeepSeek 是 `{error: {message, code}}`。只读后者的实现
 * 遇到前者会把整段 JSON 原文塞进界面文案，所以两种信封都要能吃下。
 */
import { AppError } from '@auto-cc/core';

/** 对端错误体的截断长度（错误文本会进界面与日志，不能整页 HTML 塞进去）。 */
const ERROR_TEXT_LIMIT = 200;

/**
 * 把端点前缀与一个路径拼成完整 URL。
 * @param baseUrl 配置里的端点前缀（可能带也可能不带尾斜杠，兼容 `https://api.deepseek.com` 与 `.../v1/`）
 * @param path 前缀之后的路径段（`chat/completions` 或 `embeddings`）
 * @returns 可直接 POST 的完整地址；重复斜杠由这里吃掉，不让它变成 404
 */
export function joinEndpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path}`;
}

/**
 * 从对端的错误响应里读出一句人话。
 * @param status HTTP 状态码（拼进文案，便于区分 401 鉴权与 429 限流）
 * @param body 对端返回的原始文本（实测：无 key 时 DeepSeek 回的是**纯文本**而不是 JSON，两种都要能吃下）
 * @returns 截断到 200 字符的错误描述，进 `LLM_REQUEST_FAILED` 的 message
 */
export function describeError(status: number, body: string): string {
  const trimmed = body.trim();
  let message = trimmed;
  if (trimmed.startsWith('{')) {
    try {
      // 三种信封同时认：OpenAI 系的 `error.message`、硅基流动的顶层 `message`（实测见文件头），
      // 以及只有码没有句的情况。读不出人话就退回原文，不为了清洗把真实信息丢掉。
      const parsed = JSON.parse(trimmed) as {
        error?: { message?: string; code?: string };
        message?: string;
        code?: string | number;
      };
      const remoteMessage = parsed.error?.message ?? parsed.error?.code ?? parsed.message;
      const remoteCode = typeof parsed.code === 'string' ? parsed.code : undefined;
      message =
        remoteMessage ??
        remoteCode ??
        (parsed.code === undefined ? trimmed : `${trimmed}（码 ${String(parsed.code)}）`);
    } catch {
      // 不是合法 JSON（或被截断），退回原文。
    }
  }
  const clipped = message.length > ERROR_TEXT_LIMIT ? `${message.slice(0, ERROR_TEXT_LIMIT)}…` : message;
  return `对端返回 ${String(status)}：${clipped}`;
}

/** 一次 JSON 请求的实参（`method` 省略时是 POST）。 */
export interface JsonRequest {
  /** 完整地址（由 `joinEndpoint` 拼出），也进错误详情，便于界面指出打的是哪个端点。 */
  readonly endpoint: string;
  /** Bearer 头的值；由调用方从环境变量读，未配置时应在调用本函数之前就短路。 */
  readonly apiKey: string;
  /** 请求体（会被 `JSON.stringify`）；GET 不带。 */
  readonly body?: unknown;
  /** 超时毫秒数，取 `AbortSignal.timeout`。 */
  readonly timeoutMs: number;
  /** 错误归属（`llm.chat` / `llm.embed`），进 `AppError.path`。 */
  readonly source: string;
  /** 文案里的动作名：chat 侧「模型请求」、embed 侧「向量请求」，用户看到的是一句能分清的事。 */
  readonly label: string;
  /** 动作名，默认 `POST`；`GET` 目前只用于 `/models` 清单探测（spec 7.2-05）。 */
  readonly method?: 'GET' | 'POST';
}

/** 一次 JSON POST 的实参。 */
export type JsonPost = JsonRequest & { body: unknown; method?: 'POST' };

/** 一次 JSON GET 的实参（没有请求体）。 */
export type JsonGet = JsonRequest & { body?: undefined; method?: 'GET' };

/**
 * 发一次带 Bearer 头的 JSON 请求并取回解析后的响应体。
 *
 * 只负责「发出去、拿到 JSON」这一段：非 2xx、发不出去、超时都变成结构化错误，
 * 而**响应内容合不合契约**（缺字段、空数组、维度不齐）归调用方判——那属于各端点的语义，
 * 抽到这里就会把两种完全不同的「不合约定」压成同一个错误。
 * @param request 见 `JsonRequest`；`apiKey` 不进任何错误详情，只在头里出现
 * @returns 对端 JSON（已 `JSON.parse`）
 * @throws 非 2xx / 发不出去 / 超时 / 响应不是 JSON 时 `LLM_REQUEST_FAILED`（`details.reason` 区分形态）
 */
export async function requestJson(request: JsonRequest): Promise<unknown> {
  const method = request.method ?? 'POST';
  let response: Response;
  try {
    response = await fetch(request.endpoint, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${request.apiKey}` },
      // GET 带 body 在 fetch 里是直接 TypeError，所以只有真有 body 时才挂上（POST 那一路形状不变）。
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  } catch (cause) {
    const isTimeout = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
    throw new AppError(
      'LLM_REQUEST_FAILED',
      isTimeout
        ? `${request.label}超时（${String(request.timeoutMs)}ms）`
        : `${request.label}发不出去：${cause instanceof Error ? cause.message : String(cause)}`,
      request.source,
      { endpoint: request.endpoint, reason: isTimeout ? 'timeout' : 'network' },
    );
  }
  if (!response.ok) {
    throw new AppError('LLM_REQUEST_FAILED', describeError(response.status, await response.text()), request.source, {
      endpoint: request.endpoint,
      status: response.status,
    });
  }
  // 2xx 但回的不是 JSON（网关把错误包成 HTML、或被中间层改写）：这是「拿到了但读不懂」，
  // 与「没拿到」共用 `LLM_REQUEST_FAILED`，但 reason 单独给 `bad_json`，界面才不会提示重试网络。
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null) {
    throw new AppError('LLM_REQUEST_FAILED', `${request.label}的响应不是合法 JSON`, request.source, {
      endpoint: request.endpoint,
      reason: 'bad_json',
    });
  }
  return payload;
}

/**
 * 发一次 JSON POST（chat completion 与 embeddings 那两条腿）。
 * @param request 见 `JsonPost`
 * @returns 对端 JSON
 * @throws 同 `requestJson`
 */
export async function postJson(request: JsonPost): Promise<unknown> {
  return requestJson({ ...request, method: 'POST' });
}

/**
 * 发一次 JSON GET（目前只有 `/models` 清单探测，spec 7.2-05）。
 *
 * 与 POST 共用同一具骨架是硬要求：`scripts/check-llm-single-entry.ts` 守的就是"这一个客户端"，
 * 为清单探测另写一遍 fetch/超时/错误信封会把那条机检变成摆设（AGENTS.md §2.7）。
 * @param request 见 `JsonGet`
 * @returns 对端 JSON
 * @throws 同 `requestJson`
 */
export async function getJson(request: JsonGet): Promise<unknown> {
  return requestJson({ ...request, method: 'GET' });
}
