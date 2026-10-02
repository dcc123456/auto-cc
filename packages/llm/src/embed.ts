/**
 * `llm.embed` —— 全仓唯一的**向量**出口（spec 4.3-07 / 08，plan §4.3-d 实现形状 1）。
 *
 * 为什么与 `llm.chat` 同包但不同服务：AGENTS.md §2.7 禁的是「第二套 LLM 客户端」，
 * 而传输骨架已经抽在 `http.ts` 里（§2.2）；两者要分开的是**配置**而不是**代码**。
 * 分开的实测依据（plan §4.3-d 证据 [4]）：DeepSeek 官方端点清单里**没有 embeddings**，
 * 聊天网关与向量网关在现实里就是两家服务，绑在一起配就会出现「为了要向量而把话术生成改地址」。
 * 所以这里一套独立的 `baseUrl` / `model` / `keyEnv`，`llm.chat` 未配置时本服务照常可用，反之亦然。
 *
 * provider 定在**硅基流动的 `BAAI/bge-m3`**（用户 2026-10-01 裁定）。三条来自实测的形状约束：
 * - 路径钉死为复数 `embeddings`（实测单数 `/v1/embedding` 回 404，复数无 key 回 401，证据 [1]）；
 * - 错误信封是顶层 `{code, data, message}` 而不是 OpenAI 的 `{error:{…}}`，由 `describeError` 第三支接住；
 * - **代码里不写维度**：bge-m3 的 `hidden_size=1024` 只是文档读数（证据 [3]），
 *   `dimensions` 默认 `null` = 不向对端传该字段，实际维度以响应为准并落进 `kb_vectors.dim` 列，
 *   否则「换模型要改代码」就被埋回实现里（4.3-03 的口径）。
 */
import { AppError, Service, type Context } from '@auto-cc/core';
import { z } from 'zod';
import { joinEndpoint, postJson } from './http.js';

/**
 * `llm.embed` 的可调项。
 *
 * 默认全空 = 未配置 = 不可用，且**一次网络都不发**（与 `llm.chat` 同口径）：
 * 4.3-04 的「无 key、断网时检索照常」靠的就是这一条，而不是靠调用方记得判空。
 */
export const llmEmbedSchema = z.strictObject({
  /**
   * 端点前缀（不含 `/embeddings`），例如 `https://api.siliconflow.cn/v1`。
   * `null` = 未配置；**不复用** `llm.chat` 的 `baseUrl`，理由见文件头证据 [4]。
   */
  baseUrl: z.url().nullable().default(null),
  /** 向量模型名，例如 `BAAI/bge-m3`；`null` = 未配置（不做默认值猜测）。 */
  model: z.string().min(1).nullable().default(null),
  /** API key 所在的**环境变量名**；清单里只写变量名，不写 key 本身（§8.6）。 */
  keyEnv: z.string().min(1).default('AUTO_CC_SILICONFLOW_API_KEY'),
  /**
   * 请求对端输出的维度（OpenAI 兼容契约里的 `dimensions`）。
   * `null` = 不传该字段、用模型默认维度；只有换 `bge-m3` 之类的套壳模型才需要显式给。
   */
  dimensions: z.number().int().min(8).max(8192).nullable().default(null),
  /** 一次 HTTP 喂多少条文本（`input` 是数组，实测契约支持批量）。 */
  batchSize: z.number().int().min(1).max(64).default(16),
  /**
   * 单批请求的超时（毫秒）。默认比 `llm.chat` 的 8s 长：一整批切片的编码耗时随批大小线性增长，
   * 沿用聊天默认值会把「批量」变成「批量超时」，而超时是不可重试的静默降级。
   */
  timeoutMs: z.number().int().min(1000).max(120000).default(15000),
});

/** 校验后的配置形状。 */
export type LlmEmbedConfig = z.infer<typeof llmEmbedSchema>;

/** 向量服务的可用性读数（纯本地判定，不发请求）。 */
export interface LlmEmbedStatus {
  available: boolean;
  missing: Array<'baseUrl' | 'model' | 'apiKey'>;
  model: string | null;
  /** 完整端点；`baseUrl` 未配时为 null（此时连打哪儿都不知道）。 */
  endpoint: string | null;
  /** 配置里显式要求的维度，`null` = 用模型默认维度（不等于「维度未知所以不可用」）。 */
  dimensions: number | null;
}

/** 一次编码的结果。 */
export interface LlmEmbeddings {
  /** 对端回报的模型名（缺省回落到配置值）——知识库按它做向量表的失效判据。 */
  model: string;
  /** 这批向量的统一维度；`vectors` 为空时为 null（没有向量就没有维度）。 */
  dim: number | null;
  /** 与入参同序的向量数组。 */
  vectors: number[][];
}

/**
 * 对端响应里的一条 embedding（OpenAI 兼容契约，plan §4.3-d 契约小节）。
 * `index` 是**顺序的唯一依据**：契约允许对端乱序返回，按数组下标取就会把 A 句的向量配到 B 句上，
 * 那种错配在检索里表现为「相关但说不清」，几乎不可能被发现。
 */
interface RemoteEmbeddingItem {
  readonly embedding?: unknown;
  readonly index?: unknown;
}

/**
 * 把一条响应项校验成纯数字向量。
 * @param item 对端 `data` 数组里的一项
 * @param position 该项在数组里的下标（`index` 缺失时按它排序）
 * @param endpoint 报错时指认是哪个端点给的东西
 * @returns 下标与向量的配对
 * @throws 不是有限数字数组时 `LLM_REQUEST_FAILED`（`reason: 'bad_shape'`）
 */
function readItem(item: RemoteEmbeddingItem, position: number, endpoint: string): { index: number; vector: number[] } {
  const raw = item.embedding;
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    !raw.every((value) => typeof value === 'number' && Number.isFinite(value))
  ) {
    throw new AppError('LLM_REQUEST_FAILED', `向量响应第 ${String(position + 1)} 条不是数字数组`, 'llm.embed', {
      endpoint,
      reason: 'bad_shape',
    });
  }
  const index = typeof item.index === 'number' ? item.index : position;
  return { index, vector: raw as number[] };
}

export class LlmEmbedService extends Service {
  static provide = 'llm.embed';
  static Config = llmEmbedSchema;

  private readonly options: LlmEmbedConfig;

  constructor(ctx: Context, options: LlmEmbedConfig) {
    // 必须接住第二个实参：cordis 递的是校验后的配置（AGENTS.md §9 实测 1.3）。
    super(ctx, 'llm.embed');
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
   * @returns 可用性读数
   */
  status = (): LlmEmbedStatus => {
    const missing: LlmEmbedStatus['missing'] = [];
    if (!this.options.baseUrl) missing.push('baseUrl');
    if (!this.options.model) missing.push('model');
    if (!this.readKey()) missing.push('apiKey');
    return {
      available: missing.length === 0,
      missing,
      model: this.options.model,
      endpoint: this.options.baseUrl ? joinEndpoint(this.options.baseUrl, 'embeddings') : null,
      dimensions: this.options.dimensions,
    };
  };

  /**
   * 把若干段文本编成向量，按 `batchSize` 切批、逐批串行发。
   *
   * 批与批之间**不并发**：这条路径的用途是「给整库补一遍向量」，几十上百个并发请求打第三方网关
   * 换来的是限流与不可解释的失败，而它不在用户等待的关键路径上（检索时只编查询那一句，一次请求）。
   * @param texts 待编码文本（顺序即返回顺序）；空数组**不发请求**，直接给空结果
   * @returns 模型名、统一维度（空输入时为 null）与逐条向量
   * @throws 未配置时 `LLM_UNAVAILABLE`（且不发请求）；网络 / 超时 / 非 2xx / 响应不合约定时 `LLM_REQUEST_FAILED`
   */
  embed = async (texts: readonly string[]): Promise<LlmEmbeddings> => {
    const status = this.status();
    if (texts.length === 0) {
      // 空输入不是错误：调用方（向量同步）在「没有待补切片」时也走这条路，为它发一个空请求毫无意义。
      return { model: (status.model as string) ?? '', dim: null, vectors: [] };
    }
    if (!status.available) {
      throw new AppError(
        'LLM_UNAVAILABLE',
        `向量服务未配置，缺 ${status.missing.join(' / ')}（key 从环境变量 ${this.options.keyEnv} 读取）`,
        'llm.embed',
        { missing: status.missing, keyEnv: this.options.keyEnv },
      );
    }
    const endpoint = status.endpoint as string;
    const model = status.model as string;
    const vectors: number[][] = [];
    // 对端回报的模型名以**首批**为准（同一批不可能来自不同模型；换模型是换配置，不是换响应）。
    let remoteModel: string | null = null;
    for (let start = 0; start < texts.length; start += this.options.batchSize) {
      const batch = texts.slice(start, start + this.options.batchSize);
      const body: Record<string, unknown> = { model, input: batch };
      // 只在配置显式给了维度时才带这个字段：对不认识它的网关，多余字段是 400 而不是忽略。
      if (this.options.dimensions !== null) body.dimensions = this.options.dimensions;
      const payload = await postJson({
        endpoint,
        apiKey: this.readKey(),
        body,
        timeoutMs: this.options.timeoutMs,
        source: 'llm.embed',
        label: '向量请求',
      });
      const parsed = parseBatch(payload, batch.length, endpoint);
      vectors.push(...parsed.vectors);
      remoteModel ??= parsed.model;
    }
    const dim = vectors[0]?.length ?? null;
    if (vectors.some((vector) => vector.length !== dim)) {
      // 同一次调用里维度不一致：混着算余弦会得到没有意义的数，所以宁可失败。
      throw new AppError('LLM_REQUEST_FAILED', '向量响应内部维度不一致', 'llm.embed', {
        endpoint,
        reason: 'bad_shape',
      });
    }
    this.ctx.logger.info(
      `向量已取回：${String(vectors.length)} 条 · 维度 ${String(dim ?? 0)} · 模型 ${remoteModel ?? model}`,
    );
    return { model: remoteModel ?? model, dim, vectors };
  };

  [Service.init](): void {
    const status = this.status();
    this.ctx.logger.info(
      status.available
        ? `向量出口就绪：${String(status.model)} @ ${String(status.endpoint)}${
            status.dimensions === null ? '' : ` · 维度 ${String(status.dimensions)}`
          }`
        : `向量出口未就绪：缺 ${status.missing.join(' / ')}（检索将只做词面与倒排，向量增强不可用）`,
    );
  }
}

/**
 * 把一批响应解析成「与入参同序」的向量列表，并带出对端回报的模型名。
 * @param payload 对端 JSON（`postJson` 已保证是合法 JSON）
 * @param expected 本批输入条数（响应条数不符即失败——少回一条就会把后面的向量错配到前面的切片上）
 * @param endpoint 报错时指认端点
 * @returns 按 `index` 归位后的向量，以及响应里的 `model`（没有则 null）
 * @throws 缺 `data` 数组、条数与输入不符、某条不是数字数组时 `LLM_REQUEST_FAILED`（`reason: 'bad_shape'`）
 */
function parseBatch(
  payload: unknown,
  expected: number,
  endpoint: string,
): { vectors: number[][]; model: string | null } {
  const body = payload as { data?: unknown; model?: unknown };
  const data = body.data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new AppError(
      'LLM_REQUEST_FAILED',
      `向量响应条数不符：应 ${String(expected)} 条，实 ${String(Array.isArray(data) ? data.length : '无 data 数组')}`,
      'llm.embed',
      { endpoint, reason: 'bad_shape' },
    );
  }
  const read = data.map((item, position) => readItem((item ?? {}) as RemoteEmbeddingItem, position, endpoint));
  // 按 `index` 归位而不是照抄数组顺序（见 `RemoteEmbeddingItem` 的注释）。
  read.sort((left, right) => left.index - right.index);
  return { vectors: read.map((entry) => entry.vector), model: typeof body.model === 'string' ? body.model : null };
}

declare module '@auto-cc/core' {
  interface AppServices {
    'llm.embed': LlmEmbedService;
  }
}
