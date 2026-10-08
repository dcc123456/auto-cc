/**
 * `llm.settings` —— 模型配置模块（spec 7.1-07 ~ 7.1-10）。
 *
 * 它是"用户自己配模型"这件事的唯一入口，做四件事：给出 OpenAI 兼容服务商目录、
 * 读回当前配置与掩码密钥状态、把用户填的东西校验后**同时写持久层与热改运行时**、
 * 用一次最小请求验证连通性。
 *
 * 三条刻意的取舍：
 * 1. **不自建 HTTP**：`check()` 走 `llm.chat.complete()`，所以 `scripts/check-llm-single-entry.ts`
 *    那道机检仍然成立——配置模块不是第二个 LLM 客户端（AGENTS.md §2.7）。
 * 2. **服务商目录只是数据**：预设的作用是把三个格子填上，`baseUrl`/模型名一律可改写，
 *    自定义端点与预设走完全同一条代码路径（spec 7.1-09）。
 * 3. **密钥不进配置层**：只经 `config` 的密钥库那一格（`secret.ts`），所以它既不在 `trace()` 里，
 *    也不在 `settings.json` 里，更不会回传给渲染层（spec 7.1-06）。
 */
import { AppError, Service, maybeService, type Context } from '@auto-cc/core';
import type { ConfigService } from '@auto-cc/plugin-config';
import type {
  LlmCheckView,
  LlmLegName,
  LlmLegView,
  LlmProviderView,
  LlmSettingsApplyInput,
  LlmSettingsView,
} from '@auto-cc/shared';
import { z } from 'zod';
import { endpointOf, normalizeBaseUrl, presetOf, PROVIDER_PRESETS } from './presets.js';
import type { LlmChatService } from './index.js';

/** 两条模型腿：chat 是话术与规划，embed 是知识库的向量增强（各家网关通常不同，故各自配）。 */
export const llmLegSchema = z.enum(['chat', 'embed']);

/** 本插件的配置格：两条腿各自记住"用户选的是哪家"（扁平键，持久层不收嵌套对象）。 */
export const llmSettingsSchema = z.strictObject({
  providerId: z.string().min(1).default('custom'),
  embedProviderId: z.string().min(1).default('custom'),
});

/** 一次保存的入参：`apiKey` 省略或空串表示"不动已存的那条"（界面上的掩码框就是这个语义）。 */
export const applySettingsSchema = z.strictObject({
  leg: llmLegSchema.default('chat'),
  providerId: z.string().min(1).default('custom'),
  baseUrl: z.url(),
  model: z.string().min(1),
  apiKey: z.string().nullish(),
});

export type LlmSettingsConfig = z.output<typeof llmSettingsSchema>;

/** 腿 → 装配里的插件 id。 */
const LEG_PLUGIN: Record<LlmLegName, string> = { chat: 'llm', embed: 'llm-embed' };

/** 腿 → 密钥库里的路径（与服务名一致）。 */
const LEG_SECRET: Record<LlmLegName, string> = { chat: 'llm.chat', embed: 'llm.embed' };

/** 腿 → `llm-settings` 那一格里记录服务商的键名。 */
const LEG_PROVIDER_KEY: Record<LlmLegName, 'providerId' | 'embedProviderId'> = {
  chat: 'providerId',
  embed: 'embedProviderId',
};

/** 腿 → 兜底环境变量名（与各自 schema 的 `keyEnv` 默认值同词，界面当参数显示）。 */
const LEG_KEY_ENV: Record<LlmLegName, string> = {
  chat: 'AUTO_CC_LLM_API_KEY',
  embed: 'AUTO_CC_SILICONFLOW_API_KEY',
};

/** 内核那一格里可见的最小读法（装没装、生效值是什么、怎么热改）。 */
interface KernelReader {
  snapshot(): Array<{ id: string }>;
  effectiveConfig(id: string): { values: Record<string, unknown> };
  applyConfig(id: string, patch: Record<string, unknown>): Promise<unknown>;
}

export class LlmSettingsService extends Service {
  static provide = 'llm.settings';
  static Config = llmSettingsSchema;

  private readonly options: LlmSettingsConfig;

  constructor(ctx: Context, options: LlmSettingsConfig) {
    // 必须接住第二个实参：cordis 递的是校验后的配置（AGENTS.md §9 实测 1.3）。
    super(ctx, 'llm.settings');
    this.options = options;
  }

  /**
   * 服务商目录（纯数据，不发请求）。
   * @returns 全部 19 条预设；两条腿都能选其中任何一条（不再有 `legs` 过滤）
   */
  catalog = (): LlmProviderView[] => PROVIDER_PRESETS;

  /**
   * 当前配置读数：两条腿的端点/模型名/密钥状态，加密钥存储的事实。
   *
   * 全部现问（不在本服务里存第二份事实，AGENTS.md §9 实测 2.5 那条），所以界面每次刷新都是真的当下值。
   * @returns 掩码读数；密钥库未装载时按"没存"处置而不抛
   */
  read = (): LlmSettingsView => {
    const legs = (['chat', 'embed'] as const).map((leg) => this.readLeg(leg));
    const config = maybeService<ConfigService>(this.ctx, 'config');
    return { legs, storage: config?.secretStorage() ?? { encrypted: false, unreadable: false, file: null } };
  };

  /**
   * 取某条腿的**生效配置**（五层合并后的值，含界面上一次保存的持久层）。
   *
   * 只问内核，不在本地存第二份事实（AGENTS.md §9 实测 2.5 那条）。先查快照是为了避开
   * `kernel.effectiveConfig` 对未列出插件抛错——清单里注掉某条腿是合法装配，此时按"没配"处置。
   * @param pluginId 装配里的插件 id
   * @returns 合并后的值；内核未装或该格不在清单里时为空表
   */
  private effectiveOf(pluginId: string): Record<string, unknown> {
    const kernel = maybeService<KernelReader>(this.ctx, 'kernel');
    if (!kernel?.snapshot().some((node) => node.id === pluginId)) return {};
    return kernel.effectiveConfig(pluginId).values;
  }

  /**
   * 读一条腿。
   * @param leg 哪条模型腿
   * @returns 该腿的读数，含"这把 key 现在从哪来"
   */
  private readLeg = (leg: LlmLegName): LlmLegView => {
    const pluginId = LEG_PLUGIN[leg];
    const config = maybeService<ConfigService>(this.ctx, 'config');
    const effective = this.effectiveOf(pluginId);
    const baseUrl = typeof effective.baseUrl === 'string' ? effective.baseUrl : null;
    const model = typeof effective.model === 'string' ? effective.model : null;
    const keyEnv = LEG_KEY_ENV[leg];
    const storedKey = config?.getSecret(LEG_SECRET[leg]) ?? '';
    const envKey = (process.env[keyEnv] ?? '').trim();
    const savedProvider = this.options[LEG_PROVIDER_KEY[leg]];
    // 存着的服务商只有在端点确实对得上时才继续算数（端点变体也算）：用户手改过 baseUrl 就该改口成「自定义」，
    // 否则界面会指着一家它已经没在用的提供商。
    const providerId = endpointOf(presetOf(savedProvider), baseUrl ?? '') ? savedProvider : 'custom';
    return {
      leg,
      pluginId,
      providerId,
      baseUrl,
      model,
      key: {
        present: storedKey !== '' || envKey !== '',
        tail: storedKey !== '' ? storedKey.slice(-4) : envKey.slice(-4),
        source: storedKey !== '' ? 'secret' : envKey !== '' ? 'env' : 'none',
        keyEnv,
      },
      missing: [
        ...(baseUrl ? [] : (['baseUrl'] as const)),
        ...(model ? [] : (['model'] as const)),
        ...(storedKey || envKey ? [] : (['apiKey'] as const)),
      ],
      available: Boolean(baseUrl) && Boolean(model) && (storedKey !== '' || envKey !== ''),
    };
  };

  /**
   * 保存用户填的配置：先落盘（持久层 + 密钥库），再热改运行时让 `llm.chat` 立刻拿到新值。
   * @param input 服务商 id、端点、模型名，以及可选的 key 明文（空/省略 = 不动已存的）
   * @returns 保存后的读数（同 `read()`，界面不用再补一刀）
   * @throws 入参不合法 `INVALID_ARGUMENT`；`config` 未装载 `SETTING_NOT_ALLOWED`
   */
  apply = async (input: LlmSettingsApplyInput): Promise<LlmSettingsView> => {
    const parsed = applySettingsSchema.safeParse(input);
    if (!parsed.success) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `模型配置不合法：${parsed.error.issues[0]?.message ?? ''}`,
        'llm.settings',
        {
          issues: parsed.error.issues.map((issue) => issue.path.join('.')),
        },
      );
    }
    const { leg, providerId, baseUrl: rawBaseUrl, model, apiKey } = parsed.data;
    // 入库前先收前缀：粘进来的整条 `/chat/completions` 会被 `joinEndpoint` 再拼一次，留着就是双段路径（spec 7.2-03）。
    const baseUrl = normalizeBaseUrl(rawBaseUrl);
    const config = maybeService<ConfigService>(this.ctx, 'config');
    if (!config) {
      throw new AppError('SETTING_NOT_ALLOWED', '配置服务未装载，模型设置无处落盘', 'llm.settings', { leg });
    }
    const pluginId = LEG_PLUGIN[leg];
    config.setPersisted(pluginId, { baseUrl, model }, ['baseUrl', 'model']);
    config.setPersisted('llm-settings', { [LEG_PROVIDER_KEY[leg]]: presetOf(providerId).id }, [
      'providerId',
      'embedProviderId',
    ]);
    const trimmedKey = apiKey?.trim() ?? '';
    if (trimmedKey !== '') config.setSecret(LEG_SECRET[leg], trimmedKey);

    // 热改：让正在跑的 `llm.chat` 立刻拿到新的端点与模型名（spec 7.1-08）。
    // 走 kernel 而不是只写内存补丁——它会重建注入方，所以界面要播报一句"浏览器会话可能被关掉"（§9 实测 2.5）。
    const kernel = maybeService<KernelReader>(this.ctx, 'kernel');
    if (kernel) await kernel.applyConfig(pluginId, { baseUrl, model });
    return this.read();
  };

  /**
   * 清除某条腿已存的密钥（界面上的"删除密钥"）。
   * @param leg 哪条模型腿
   * @returns 清除后的读数
   */
  clearKey = (leg: LlmLegName): LlmSettingsView => {
    maybeService<ConfigService>(this.ctx, 'config')?.clearSecret(LEG_SECRET[leg]);
    return this.read();
  };

  /**
   * 连通性测试：发**一次**最小请求（spec 7.1-10）。
   *
   * 复用 `llm.chat` 的出口而不是自己 `fetch`：这样"测试通过"与"业务真的能用"是同一件事，
   * 也让超时、非 2xx、空回复这些失败形态与生产路径完全一致。
   * @param leg 目前只支持 `chat`（向量腿要的是 embeddings 端点，判据不同且暂无消费者）
   * @returns 结构化结果；失败不抛，界面按 `reason` 说话
   */
  check = async (leg: LlmLegName = 'chat'): Promise<LlmCheckView> => {
    if (leg !== 'chat') {
      return {
        ok: false,
        model: null,
        reason: 'CHECK_NOT_SUPPORTED',
        message: '向量腿的连通性测试本轮未接入',
        elapsedMs: 0,
      };
    }
    const chat = maybeService<LlmChatService>(this.ctx, 'llm.chat');
    if (!chat) return { ok: false, model: null, reason: 'LLM_UNAVAILABLE', message: '模型出口未装载', elapsedMs: 0 };
    const started = Date.now();
    try {
      const completion = await chat.complete({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 8 });
      return { ok: true, model: completion.model, reason: null, message: null, elapsedMs: Date.now() - started };
    } catch (error) {
      const payload = AppError.from(error, 'LLM_REQUEST_FAILED');
      return {
        ok: false,
        model: null,
        reason: payload.code,
        message: payload.message,
        elapsedMs: Date.now() - started,
      };
    }
  };

  [Service.init](): void {
    const chat = this.readLeg('chat');
    this.ctx.logger.info(
      chat.available
        ? `模型设置已装载：${String(chat.model)} @ ${String(chat.baseUrl)} · key 来自 ${chat.key.source}`
        : `模型尚未配置完整：缺 ${chat.missing.join(' / ')}`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'llm.settings': LlmSettingsService;
  }
}
