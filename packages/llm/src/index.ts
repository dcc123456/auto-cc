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
import { AppError, maybeService, Service, redactText, type Context } from '@auto-cc/core';
import type { StoreService } from '@auto-cc/plugin-store';
import { z } from 'zod';
import { readModelIds, resolveLeg, type ResolvedLeg } from './binding.js';
import { getJson, joinEndpoint, postJson } from './http.js';
import { readModelKey, type KeyProbe } from './key.js';
import { providerRowOf, providerSecretPath } from './provider-pool.js';

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
   * 角色绑定指向的**池实例 id**（spec 7.2-11）。`null` = 没绑定，这条腿用自己下面那个 `baseUrl`。
   *
   * 有绑定时端点与密钥路径都当场向池问（`resolveLeg`），这里**不复制**一份 `baseUrl`：
   * 用户改了那个实例的地址，下一次请求就该立刻跟着变（AGENTS.md §2.5 的"不存第二份事实"）。
   */
  providerId: z.string().min(1).nullable().default(null),
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
  /**
   * 这一腿的端点是谁给的（spec 7.2-12 的那三条读数）：
   * `pool` = 角色绑定指向的实例，`config` = 这条腿自己的配置格（yml/env 兜底），`none` = 两边都没有。
   */
  origin: ResolvedLeg['origin'];
  /** 生效的绑定实例 id；没绑定或绑定已回落时为 null。 */
  providerId: string | null;
}

/**
 * 探测态的目标（spec 7.2-04 / 05）：点名一个池实例与一条模型名，**不改绑定**。
 *
 * 只给 `providerId` 与 `model`，端点与密钥路径由本服务当场向池问：调用方（`llm.settings`）拼这两样
 * 就是替池存第二份事实（§2.5），而那两样恰恰是用户会改的东西。
 */
export interface LlmProbeTarget {
  /** 池实例 id */
  providerId: string;
  /** 这次探测用哪条模型名（清单探测用不到它，但连通测试必须点名一条） */
  model: string;
  /** 单次超时覆盖（毫秒）；省略时用这条腿自己的配置值 */
  timeoutMs?: number;
}

/** `/models` 的候选清单读数（spec 7.2-05）。 */
export interface LlmModelListing {
  /** 对端给的模型名，按回包原序（排序归入库后的清单，不在这里猜） */
  models: string[];
  /** 这份清单来自哪个端点，进界面文案与错误详情 */
  endpoint: string;
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
   * 解析这次请求打哪儿、该问密钥库哪一格（spec 7.2-12 的那条顺序）。
   *
   * 两种来源共用这一支：绑定态/兜底态读自己的配置格（`resolveLeg`），探测态按实例 id 现问池。
   * @param target 探测态的目标；给了它就**不**看绑定，界面上"测这家"测的就是它自己
   * @returns 端点前缀、模型名、密钥路径与兜底变量名
   * @throws 探测态点名池里没有的实例时 `LLM_PROVIDER_NOT_FOUND`
   */
  private resolve = (target?: LlmProbeTarget): ResolvedLeg => {
    if (!target) return resolveLeg(this.ctx, 'chat', this.options);
    const db = maybeService<StoreService>(this.ctx, 'store')?.db;
    const row = db ? providerRowOf(db, target.providerId) : undefined;
    if (!row) {
      throw new AppError('LLM_PROVIDER_NOT_FOUND', `池里没有这个提供商实例：${target.providerId}`, 'llm.chat', {
        providerId: target.providerId,
      });
    }
    return {
      baseUrl: row.base_url,
      model: target.model,
      secretPath: providerSecretPath(row.id),
      keyEnv: this.options.keyEnv,
      origin: 'pool',
      providerId: row.id,
    };
  };

  /**
   * 一次请求的实际超时（毫秒）：探测态可覆盖，否则用这条腿的配置值。
   * @param target 探测态的目标（可省）
   * @returns 传给 `AbortSignal.timeout` 的毫秒数
   */
  private timeoutOf = (target?: LlmProbeTarget): number => target?.timeoutMs ?? this.options.timeoutMs;

  /**
   * 读取 API key：**先问密钥库**（`config` 那一格，界面上填的），`keyEnv` 指向的环境变量只作兜底
   * （CI 与验收复跑的口子和 AGENTS.md §8.6 的"本地配置文件"两条都靠它）。
   * @param resolved 这一腿解析出来的目标，决定问密钥库哪一格（绑定的实例 / 腿自己）
   * @returns 明文与出处；两处都没有时 `value` 是空串，交由 `status()` 判为不可用
   * @throws 不抛异常
   */
  private readKey = (resolved: ResolvedLeg): KeyProbe => readModelKey(this.ctx, resolved.secretPath, resolved.keyEnv);

  /**
   * 把一个解析好的目标收成可用性读数（`status()` 与 `complete()` 共用，§2.2 的"出现第二次就抽"）。
   * @param resolved 见 `resolve`
   * @returns 缺项、实际端点与 key 出处；纯本地，一次网络都不发
   */
  private readiness = (resolved: ResolvedLeg): LlmStatus => {
    const missing: LlmStatus['missing'] = [];
    if (!resolved.baseUrl) missing.push('baseUrl');
    if (!resolved.model) missing.push('model');
    const key = this.readKey(resolved);
    if (!key.value) missing.push('apiKey');
    return {
      available: missing.length === 0,
      missing,
      model: resolved.model,
      endpoint: resolved.baseUrl ? completionsUrl(resolved.baseUrl) : null,
      keySource: key.source,
      origin: resolved.origin,
      providerId: resolved.providerId,
    };
  };

  /**
   * 当前是否可用，以及不可用时缺了哪几样。**纯本地判定，不发任何网络请求。**
   * @returns 可用性读数（`endpoint` 为 null 表示连端点都还没配；`origin` 说清端点是谁给的）
   */
  status = (): LlmStatus => this.readiness(this.resolve());

  /**
   * 发一次 chat completion 请求并取回正文。
   * @param request 消息序列（至少一条），以及可选的 `maxTokens` / `temperature` 单次覆盖
   * @param target 探测态的目标（spec 7.2-04「测试连通」走这一条，不改绑定）；省略时按 7.2-12 的顺序解析
   * @returns 回复正文、实际模型名与 token 用量；**空回复视为失败**（不返回空串，见 plan §12.2「失败即抛」）
   * @throws 未配置时 `LLM_UNAVAILABLE`（且**不发请求**）；网络失败 / 超时 / 非 2xx / 空回复时 `LLM_REQUEST_FAILED`
   */
  complete = async (request: LlmChatRequest, target?: LlmProbeTarget): Promise<LlmCompletion> => {
    const resolved = this.resolve(target);
    const reading = this.readiness(resolved);
    if (!reading.available) {
      throw new AppError(
        'LLM_UNAVAILABLE',
        `模型服务未配置，缺 ${reading.missing.join(' / ')}（key 可在「信任」工作台里填，也可从环境变量 ${resolved.keyEnv} 兜底）`,
        'llm.chat',
        {
          missing: reading.missing,
          keyEnv: resolved.keyEnv,
          keySource: reading.keySource,
          origin: reading.origin,
        },
      );
    }
    const parsed = chatRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new AppError('INVALID_ARGUMENT', `模型请求不合法：${parsed.error.issues[0]?.message ?? ''}`, 'llm.chat');
    }
    const body = {
      model: resolved.model as string,
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
      endpoint: completionsUrl(resolved.baseUrl as string),
      apiKey: this.readKey(resolved).value,
      body,
      timeoutMs: this.timeoutOf(target),
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
        endpoint: completionsUrl(resolved.baseUrl as string),
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
      model: payload.model ?? (resolved.model as string),
      promptTokens: payload.usage?.prompt_tokens ?? null,
      completionTokens: payload.usage?.completion_tokens ?? null,
    };
  };

  /**
   * 问一家网关要它的模型清单（spec 7.2-05）：`GET <baseUrl>/models`。
   *
   * 这是本客户端的**第三个方法而不是第三条腿**：`llm.settings` 一个字节都不发
   * （`scripts/check-llm-single-entry.ts` 为这一条守白名单），所以清单探测必须经这里出去。
   * 没有 key 也照发——实测有的网关的 `/models` 不鉴权，"这次没成"该由对端说话，而不是在本地预判。
   * @param target 探测态的目标（实例 id + 模型名；清单本身与模型名无关，但连通测试共用同一个形状）
   * @returns 回包原序的模型名列表；脏项（没有字符串 `id` 的那几条）由 `readModelIds` 跳过
   * @throws 实例不在池里 `LLM_PROVIDER_NOT_FOUND`；非 2xx / 超时 / 非 JSON `LLM_REQUEST_FAILED`
   */
  listModels = async (target: LlmProbeTarget): Promise<LlmModelListing> => {
    const resolved = this.resolve(target);
    if (!resolved.baseUrl) {
      throw new AppError('LLM_UNAVAILABLE', '这个提供商实例没有可用端点', 'llm.chat', {
        providerId: target.providerId,
      });
    }
    const endpoint = joinEndpoint(resolved.baseUrl, 'models');
    const payload = await getJson({
      endpoint,
      apiKey: this.readKey(resolved).value,
      timeoutMs: this.timeoutOf(target),
      source: 'llm.chat',
      label: '模型清单',
    });
    return { models: readModelIds(payload), endpoint };
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
