/**
 * `llm.chat` —— 全仓**唯一**的对话模型出口（spec 2.5-12，plan §12.0）。
 *
 * 它只做四件事：拼一次 OpenAI 兼容的 chat completion 请求、把消息正文里的个人数据遮掉（spec 5.6-06）、
 * 按超时掐断、把失败变成结构化错误。
 * 不含 prompt 业务、不落库、不重试 —— 那些都属于调用方（话术生成在 `outbound.script`，
 * 简历内容在 P4，agent 规划在 P5）。之所以单独成包：`AGENTS.md §2.7` 禁的是「第二套 LLM 客户端」，
 * 而这句话隐含「第一套得有唯一归属」；不先立一个，三个计划会各长出一个 `fetch`。
 *
 * 同包的 `llm.embed`（spec 4.3-07 / 08，见 `embed.ts`）是这个客户端的**第二个方法**而不是第二套客户端：
 * 传输骨架共用 `http.ts`，只有配置各自独立——DeepSeek 没有 embeddings 端点而硅基流动有，
 * 两者绑在一起配就会变成「为了向量增强而改坏话术生成」（plan §4.3-d 证据 [4]）。
 *
 * 零新依赖（不引 SDK）：请求形态按 DeepSeek / OpenAI 兼容端点实测（plan §12.6 S3）。
 * key 不进 `cordis.yml`（那是入库的清单，§8.6 禁止把密钥写进仓库），只从环境变量读。
 */
import { AppError, Service, redactText, type Context } from '@auto-cc/core';
import { z } from 'zod';
import { joinEndpoint, postJson } from './http.js';
import { readModelKey, type KeyProbe } from './key.js';

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
  /**
   * API key 的**兜底环境变量名**（默认 `AUTO_CC_LLM_API_KEY`）；清单里只写变量名，不写 key 本身。
   * 读取顺序是「密钥库 → 这个变量」（spec 7.1-07）：界面上填的走密钥库，这条口子留给 CI 与验收复跑。
   */
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
  /**
   * 当前这把 key 从哪来（spec 7.1-07）：密钥库（界面里存的）> 环境变量（`keyEnv` 兜底口子）> 没有。
   * 报出来是为了让界面能说清"这次用的是你填的那把还是终端里 export 的那把"。
   */
  keySource: 'secret' | 'env' | 'none';
}

/**
 * 把配置里的端点前缀与 `chat/completions` 拼成完整 URL。
 * @param baseUrl 端点前缀（可能带也可能不带尾斜杠，兼容 `https://api.deepseek.com` 与 `.../v1/`）
 * @returns 可直接 POST 的完整地址
 */
function completionsUrl(baseUrl: string): string {
  return joinEndpoint(baseUrl, 'chat/completions');
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
   * 读取 API key：**先问密钥库**（`config` 那一格，界面上填的），`keyEnv` 指向的环境变量只作兜底
   * （CI 与验收复跑的口子和 AGENTS.md §8.6 的"本地配置文件"两条都靠它）。
   * @returns 明文与出处；两处都没有时 `value` 是空串，交由 `status()` 判为不可用
   * @throws 不抛异常
   */
  private readKey = (): KeyProbe => readModelKey(this.ctx, 'llm.chat', this.options.keyEnv);

  /**
   * 当前是否可用，以及不可用时缺了哪几样。**纯本地判定，不发任何网络请求。**
   * @returns 可用性读数（`endpoint` 为 null 表示连端点都还没配）
   */
  status = (): LlmStatus => {
    const missing: LlmStatus['missing'] = [];
    if (!this.options.baseUrl) missing.push('baseUrl');
    if (!this.options.model) missing.push('model');
    const key = this.readKey();
    if (!key.value) missing.push('apiKey');
    return {
      available: missing.length === 0,
      missing,
      model: this.options.model,
      endpoint: this.options.baseUrl ? completionsUrl(this.options.baseUrl) : null,
      keySource: key.source,
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
        `模型服务未配置，缺 ${status.missing.join(' / ')}（key 可在「信任」工作台里填，也可从环境变量 ${this.options.keyEnv} 兜底）`,
        'llm.chat',
        { missing: status.missing, keyEnv: this.options.keyEnv, keySource: status.keySource },
      );
    }
    const parsed = chatRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new AppError('INVALID_ARGUMENT', `模型请求不合法：${parsed.error.issues[0]?.message ?? ''}`, 'llm.chat');
    }
    const body = {
      model: status.model as string,
      // 出站前的唯一一道脱敏（spec 5.6-06，§8.5）：调用方拼 prompt 时会把 JD 正文、页面读数、
      // 简历段落塞进 messages，个人数据就这样离开了本机。放在这里而不是每个调用方各遮一遍，
      // 是因为「所有走模型的文本」只有这一个出口（§2.7 禁第二套 LLM 客户端），遮一处即遮全部。
      messages: parsed.data.messages.map((message) => ({
        role: message.role,
        content: redactText(message.content),
      })),
      max_tokens: parsed.data.maxTokens ?? this.options.maxTokens,
      temperature: parsed.data.temperature ?? this.options.temperature,
      stream: false,
    };
    // 传输骨架与 `llm.embed` 共用（§2.2）：这里只负责「请求体长什么样」和「回复怎么读」。
    const payload = (await postJson({
      endpoint: status.endpoint as string,
      apiKey: this.readKey().value,
      body,
      timeoutMs: this.options.timeoutMs,
      source: 'llm.chat',
      label: '模型请求',
    })) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = payload.choices?.[0]?.message?.content?.trim();
    if (!text) {
      // 空回复不能当成功返回：下游（打招呼文案）会把它当真内容发出去。
      throw new AppError('LLM_REQUEST_FAILED', '模型返回空回复', 'llm.chat', {
        endpoint: status.endpoint,
        reason: 'empty',
      });
    }
    this.ctx.logger.info(
      `模型回复已取回：${text.length} 字 · 用量 ${String(payload.usage?.prompt_tokens ?? '?')}/${String(
        payload.usage?.completion_tokens ?? '?',
      )} tokens`,
    );
    return {
      text,
      model: payload.model ?? (status.model as string),
      promptTokens: payload.usage?.prompt_tokens ?? null,
      completionTokens: payload.usage?.completion_tokens ?? null,
    };
  };

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

/** 同包的向量出口（spec 4.3-07 / 08）：包外只经这一个入口用它（§4.2）。 */
export * from './embed.js';

/** 同包的模型配置模块（spec 7.1-07 ~ 7.1-10）：服务商目录、掩码读数、保存与连通性测试。 */
export * from './settings.js';
