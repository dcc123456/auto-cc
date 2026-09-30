/**
 * `llm.chat` —— 全仓**唯一**的模型出口（spec 2.5-12，plan §12.0）。
 *
 * 它只做三件事：拼一次 OpenAI 兼容的 chat completion 请求、按超时掐断、把失败变成结构化错误。
 * 不含 prompt 业务、不落库、不重试 —— 那些都属于调用方（话术生成在 `outbound.script`，
 * 简历内容在 P4，agent 规划在 P5）。之所以单独成包：`AGENTS.md §2.7` 禁的是「第二套 LLM 客户端」，
 * 而这句话隐含「第一套得有唯一归属」；不先立一个，三个计划会各长出一个 `fetch`。
 *
 * 零新依赖（不引 SDK）：请求形态按 DeepSeek / OpenAI 兼容端点实测（plan §12.6 S3）。
 * key 不进 `cordis.yml`（那是入库的清单，§8.6 禁止把密钥写进仓库），只从环境变量读。
 */
import { AppError, Service, type Context } from '@auto-cc/core';
import { z } from 'zod';

/** 消息角色：P2 的话术生成只用 system + user，assistant/tool 留给 P5 的对话循环。 */
export const chatRoleSchema = z.enum(['system', 'user']);

/** 一条待发送的消息（`content` 是纯文本，不支持多模态数组形态）。 */
export const chatMessageSchema = z.strictObject({
  role: chatRoleSchema,
  content: z.string().min(1),
});

/** 一次补全的入参：消息序列，以及可选的单次覆盖（不传就用配置默认值）。 */
export const chatRequestSchema = z.strictObject({
  messages: z.array(chatMessageSchema).min(1),
  maxTokens: z.number().int().min(1).max(8192).nullish(),
  temperature: z.number().min(0).max(2).nullish(),
});

export const llmSchema = z.strictObject({
  /**
   * 端点前缀（不含 `/chat/completions`），例如 `https://api.deepseek.com` 或
   * `https://api.openai.com/v1`。`null` = 未配置，此时本服务**一次网络请求都不发**。
   */
  baseUrl: z.url().nullable().default(null),
  /** 模型名，`null` = 未配置（与 `baseUrl` 同等对待：未配置即不可用，不做默认值猜测）。 */
  model: z.string().min(1).nullable().default(null),
  /** API key 所在的**环境变量名**（默认 `AUTO_CC_LLM_API_KEY`）；清单里只写变量名，不写 key 本身。 */
  keyEnv: z.string().min(1).default('AUTO_CC_LLM_API_KEY'),
  /** 单次请求的超时（毫秒）。取 `AbortSignal.timeout`，到点以 `LLM_REQUEST_FAILED` 失败而不是吊死。 */
  timeoutMs: z.number().int().min(1000).max(120000).default(8000),
  /** 回复长度上限（`max_tokens`），话术只需一两句，默认给到 400。 */
  maxTokens: z.number().int().min(1).max(8192).default(400),
  /** 采样温度；话术生成要稳定，默认 0.7。 */
  temperature: z.number().min(0).max(2).default(0.7),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type LlmConfig = z.infer<typeof llmSchema>;

/** 一条待发送的消息。 */
export type LlmChatMessage = z.infer<typeof chatMessageSchema>;

/** 一次补全的入参。 */
export type LlmChatRequest = z.infer<typeof chatRequestSchema>;

/** 补全结果：正文 + 实际用的模型名 + token 用量（对端未回报时为 null，不猜）。 */
export interface LlmCompletion {
  text: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

/** 可用性读数（纯本地，不发请求）：界面与调用方据此决定是「回落并播报」还是「照发」。 */
export interface LlmStatus {
  available: boolean;
  /** 不可用的原因项，`missing` 里的每一项都对应配置或环境里缺的一个东西。 */
  missing: Array<'baseUrl' | 'model' | 'apiKey'>;
  model: string | null;
  endpoint: string | null;
}

/** 对端错误体的截断长度（错误文本会进界面与日志，不能整页 HTML 塞进去）。 */
const ERROR_TEXT_LIMIT = 200;

/**
 * 把配置里的端点前缀与 `chat/completions` 拼成完整 URL。
 * @param baseUrl 端点前缀（可能带也可能不带尾斜杠，兼容 `https://api.deepseek.com` 与 `.../v1/`）
 * @returns 可直接 POST 的完整地址
 */
function completionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/**
 * 从对端的错误响应里读出一句人话。
 * @param status HTTP 状态码（拼进文案，便于区分 401 鉴权与 429 限流）
 * @param body 对端返回的原始文本（实测：无 key 时 DeepSeek 回的是**纯文本**而不是 JSON，两种都要能吃下）
 * @returns 截断到 200 字符的错误描述，进 `LLM_REQUEST_FAILED` 的 message
 */
function describeError(status: number, body: string): string {
  const trimmed = body.trim();
  let message = trimmed;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: { message?: string; code?: string } };
      message = parsed.error?.message ?? parsed.error?.code ?? trimmed;
    } catch {
      // 不是合法 JSON（或被截断），退回原文，不为了清洗把真实信息丢掉。
    }
  }
  const clipped = message.length > ERROR_TEXT_LIMIT ? `${message.slice(0, ERROR_TEXT_LIMIT)}…` : message;
  return `对端返回 ${String(status)}：${clipped}`;
}

export class LlmChatService extends Service {
  static provide = 'llm.chat';
  static Config = llmSchema;

  private readonly options: LlmConfig;

  constructor(ctx: Context, options: LlmConfig) {
    // 必须接住第二个实参：cordis 递的是校验后的配置（AGENTS.md §9 实测 1.3）。
    super(ctx, 'llm.chat');
    this.options = options;
  }

  /**
   * 读取 API key（环境变量）。
   * @returns 密钥明文；未设置时为空串，交由 `status()` 判为不可用
   * @throws 不抛异常
   */
  private readKey = (): string => process.env[this.options.keyEnv]?.trim() ?? '';

  /**
   * 当前是否可用，以及不可用时缺了哪几样。**纯本地判定，不发任何网络请求。**
   * @returns 可用性读数（`endpoint` 为 null 表示连端点都还没配）
   */
  status = (): LlmStatus => {
    const missing: LlmStatus['missing'] = [];
    if (!this.options.baseUrl) missing.push('baseUrl');
    if (!this.options.model) missing.push('model');
    if (!this.readKey()) missing.push('apiKey');
    return {
      available: missing.length === 0,
      missing,
      model: this.options.model,
      endpoint: this.options.baseUrl ? completionsUrl(this.options.baseUrl) : null,
    };
  };

  /**
   * 发一次 chat completion 请求并取回正文。
   * @param request 消息序列（至少一条），以及可选的 `maxTokens` / `temperature` 单次覆盖
   * @returns 回复正文、实际模型名与 token 用量；**空回复视为失败**（不返回空串，见 plan §12.2「失败即抛」）
   * @throws 未配置时 `LLM_UNAVAILABLE`（且**不发请求**）；网络失败 / 超时 / 非 2xx / 空回复时 `LLM_REQUEST_FAILED`
   */
  complete = async (request: LlmChatRequest): Promise<LlmCompletion> => {
    const status = this.status();
    if (!status.available) {
      throw new AppError(
        'LLM_UNAVAILABLE',
        `模型服务未配置，缺 ${status.missing.join(' / ')}（key 从环境变量 ${this.options.keyEnv} 读取）`,
        'llm.chat',
        { missing: status.missing, keyEnv: this.options.keyEnv },
      );
    }
    const parsed = chatRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new AppError('INVALID_ARGUMENT', `模型请求不合法：${parsed.error.issues[0]?.message ?? ''}`, 'llm.chat');
    }
    const body = {
      model: status.model as string,
      messages: parsed.data.messages,
      max_tokens: parsed.data.maxTokens ?? this.options.maxTokens,
      temperature: parsed.data.temperature ?? this.options.temperature,
      stream: false,
    };
    let response: Response;
    try {
      response = await fetch(status.endpoint as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.readKey()}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (cause) {
      const isTimeout = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
      throw new AppError(
        'LLM_REQUEST_FAILED',
        isTimeout ? `模型请求超时（${String(this.options.timeoutMs)}ms）` : `模型请求发不出去：${this.reason(cause)}`,
        'llm.chat',
        { endpoint: status.endpoint, reason: isTimeout ? 'timeout' : 'network' },
      );
    }
    if (!response.ok) {
      throw new AppError('LLM_REQUEST_FAILED', describeError(response.status, await response.text()), 'llm.chat', {
        endpoint: status.endpoint,
        status: response.status,
      });
    }
    const payload = (await response.json().catch(() => null)) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;
    const text = payload?.choices?.[0]?.message?.content?.trim();
    if (!text) {
      // 空回复不能当成功返回：下游（打招呼文案）会把它当真内容发出去。
      throw new AppError('LLM_REQUEST_FAILED', '模型返回空回复', 'llm.chat', {
        endpoint: status.endpoint,
        reason: 'empty',
      });
    }
    this.ctx.logger.info(
      `模型回复已取回：${text.length} 字 · 用量 ${String(payload?.usage?.prompt_tokens ?? '?')}/${String(
        payload?.usage?.completion_tokens ?? '?',
      )} tokens`,
    );
    return {
      text,
      model: payload?.model ?? (status.model as string),
      promptTokens: payload?.usage?.prompt_tokens ?? null,
      completionTokens: payload?.usage?.completion_tokens ?? null,
    };
  };

  /**
   * 把未知异常压成一句短描述（只进日志与错误详情，不含 key）。
   * @param cause 捕获到的异常对象
   * @returns 异常消息或字符串化结果
   */
  private reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

  [Service.init](): void {
    const status = this.status();
    this.ctx.logger.info(
      status.available
        ? `模型出口就绪：${String(status.model)} @ ${String(status.endpoint)}`
        : `模型出口未就绪：缺 ${status.missing.join(' / ')}（调用方将走模板回落）`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'llm.chat': LlmChatService;
  }
}
