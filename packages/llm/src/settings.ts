/**
 * `llm.settings` —— 模型配置模块（spec 7.1-07 ~ 10 与 7.2-02 ~ 12）。
 *
 * 它是"用户自己配模型"这件事的唯一入口，做四件事：给出 OpenAI 兼容服务商目录、
 * 管**提供商实例池**（添加/改/删，每张提供商各自的 key 与已入库的模型清单）、
 * 读回两条模型腿当下用什么（按「绑定 > 兜底 > 未配置」现算），以及用一次最小请求验证连通性。
 *
 * 三条刻意的取舍：
 * 1. **不自建 HTTP**：`check()` / `checkProvider()` / `fetchModels()` 都走 `llm.chat` 那唯一出口，
 *    所以 `scripts/check-llm-single-entry.ts` 那道机检仍然成立——配置模块不是第二个 LLM 客户端（AGENTS.md §2.7）。
 * 2. **服务商目录只是数据**：预设的作用是把格子填上，`baseUrl`/模型名一律可改写，
 *    自定义端点与预设走完全同一条代码路径（spec 7.1-09）。
 * 3. **密钥不进配置层**：只经 `config` 的密钥库那几格（`secret.ts`：腿的兜底一格、每个提供商实例一格），
 *    所以它既不在 `trace()` 里，也不在 `settings.json` 里，更不会回传给渲染层（spec 7.1-06 / 7.2-10）。
 */
import { AppError, asApp, Service, maybeService, type Context } from '@auto-cc/core';
import type { ConfigService } from '@auto-cc/plugin-config';
import type { StoreService } from '@auto-cc/plugin-store';
import type {
  LlmCheckView,
  LlmFetchModelsView,
  LlmLegName,
  LlmLegView,
  LlmModelView,
  LlmProviderInstanceView,
  LlmProviderView,
  LlmSettingsView,
} from '@auto-cc/shared';
import { z } from 'zod';
import { resolveLeg } from './binding.js';
import { endpointOf, normalizeBaseUrl, presetIdOfBaseUrl, presetOf, PROVIDER_PRESETS } from './presets.js';
import {
  addModelsSchema,
  deleteProviderRow,
  saveProviderSchema,
  llmModelMigration,
  llmProviderMigration,
  modelRowsOf,
  providerRowOf,
  providerRowsOf,
  providerSecretPath,
  removeModelRow,
  saveProviderRow,
  addModelRows,
  type AddModelsInput,
  type ProviderRow,
  type SaveProviderInput,
} from './provider-pool.js';
import type { LlmChatService } from './index.js';

/** 两条模型腿：chat 是话术与规划，embed 是知识库的向量增强（各家网关通常不同，故各自配）。 */
export const llmLegSchema = z.enum(['chat', 'embed']);

/**
 * 角色绑定的入参（spec 7.2-11）：把一条腿指到池里某个实例、以及它已入库的某条模型。
 *
 * 这里的 `providerId` 是**实例 id**（`llm_providers.id`），写进 `llm` / `llm-embed` 那格；
 * 目录里的预设 id 只出现在读数里（`LlmLegView.providerId`，由地址反查），不再是一格配置。
 */
export const bindRoleSchema = z.strictObject({
  leg: llmLegSchema,
  providerId: z.string().min(1),
  model: z.string().min(1),
});

/** 一次角色绑定的入参形状（`origin` 之类没有缺省键，所以 input 与 output 同形）。 */
export type BindRoleInput = z.output<typeof bindRoleSchema>;

/** 腿 → 装配里的插件 id。 */
const LEG_PLUGIN: Record<LlmLegName, string> = { chat: 'llm', embed: 'llm-embed' };

/** 腿 → 密钥库里的路径（与服务名一致）：这只在**兜底态**用得上，绑定态问的是 `llm.provider:<实例 id>`。 */
const LEG_SECRET: Record<LlmLegName, string> = { chat: 'llm.chat', embed: 'llm.embed' };

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
  /**
   * 本服务的配置格：一个键都不读（7.2-d 起）。7.1 那两格 `providerId` / `embedProviderId` 记的是
   * 「界面上上一次保存选了哪家」，现在由池那一行与 `llm` / `llm-embed` 里的绑定代替了。
   *
   * 这里用 `z.object` 而不是同类插件的 `z.strictObject({})`（`shellSchema` / `platformRegistrySchema`）：
   * 已经有人按 7.1 的界面存过那两个键，持久层是五层合并的一层，严格形状会让**所有装过 7.1 的机器**
   * 在挂载期就变 FAILED。剥离而不是报错，是因为这些残留没有读者，留着与删掉在行为上等价。
   */
  static Config = z.object({});
  // 必需依赖写进 inject（`@auto-cc/core` 的分工口径）：池的两张表住 `store` 那条连接里，
  // 没有它这些方法无处落盘；`config` / `kernel` / `llm.chat` 仍是用的时候现问，免得热改把本服务一起重建。
  static inject = ['store'];

  constructor(ctx: Context) {
    super(ctx, 'llm.settings');
  }

  /** `store` 句柄（连接与迁移清单的唯一来源，不在本地存第二份表结构事实）。 */
  private get store(): StoreService {
    return asApp(this.ctx).store;
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
   * 读一条腿（spec 7.2-12 的读数半边）：先按「绑定 > 兜底 > 未配置」解析，再照实报这一腿当下用什么。
   * @param leg 哪条模型腿
   * @returns 该腿的读数，含"这把 key 现在从哪来"——绑定时问的是那家实例自己的密钥格
   */
  private readLeg = (leg: LlmLegName): LlmLegView => {
    const pluginId = LEG_PLUGIN[leg];
    const config = maybeService<ConfigService>(this.ctx, 'config');
    const effective = this.effectiveOf(pluginId);
    const keyEnv = LEG_KEY_ENV[leg];
    // 端点、模型名与密钥路径都按解析顺序现算：绑定了实例就报实例的地址，读的是 `llm.provider:<id>` 那一格，
    // 界面看到的才是"这次真的在用什么"（spec 7.2-11 的判据）。
    const resolved = resolveLeg(this.ctx, leg, {
      providerId: typeof effective.providerId === 'string' ? effective.providerId : null,
      baseUrl: typeof effective.baseUrl === 'string' ? effective.baseUrl : null,
      model: typeof effective.model === 'string' ? effective.model : null,
      keyEnv,
    });
    const baseUrl = resolved.baseUrl;
    const model = resolved.model;
    const storedKey = config?.getSecret(resolved.secretPath) ?? '';
    const envKey = (process.env[keyEnv] ?? '').trim();
    // 「这一腿看起来像哪家」出自解析结果而不是任何本地记忆：绑定态直读那一行的 `preset_id`（确切事实），
    // 兜底态拿生效地址去目录里反查（端点变体也算），地址认不出就是「自定义」——
    // 界面指着的必须是真在用的那一家（spec 7.1-09 同一条纪律，只是现在不再需要有人先把选择存下来）。
    const db = maybeService<StoreService>(this.ctx, 'store')?.db;
    const boundRow = resolved.providerId && db ? providerRowOf(db, resolved.providerId) : undefined;
    const providerId = boundRow?.preset_id ?? presetIdOfBaseUrl(baseUrl ?? '');
    return {
      leg,
      pluginId,
      providerId,
      boundProviderId: resolved.providerId,
      origin: resolved.origin,
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
   * 池里全部提供商实例，按添加先后（spec 7.2-02）。
   * @returns 每行带掩码末 4 位与「已入库几条模型」；明文 key 不在这份读数的任何一格里
   */
  listProviders = (): LlmProviderInstanceView[] => providerRowsOf(this.store.db).map((row) => this.providerView(row));

  /**
   * 添加或修改一个提供商实例：地址归一后进表，key 只进密钥库那格（spec 7.2-10）。
   *
   * 表里一个密钥字节都没有，是这一条的判据而不是副产品——删提供商要连带清的就是这条派生路径，
   * 若把 key 也存进表，那条清理就会漏掉一份真相（AGENTS.md §2.5）。
   * @param input 预设 id、显示名、端点地址，以及可选的 key 明文（空/省略 = 不动已存的那把）
   * @returns 落库后的那一行读数
   * @throws 入参不合法 `INVALID_ARGUMENT`；`id` 给了但池里没有 `LLM_PROVIDER_NOT_FOUND`
   */
  saveProvider = (input: SaveProviderInput): LlmProviderInstanceView => {
    const parsed = saveProviderSchema.safeParse(input);
    if (!parsed.success) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `提供商入参不合法：${parsed.error.issues[0]?.message ?? ''}`,
        'llm.settings',
        {
          issues: parsed.error.issues.map((issue) => issue.path.join('.')),
        },
      );
    }
    const baseUrl = normalizeBaseUrl(parsed.data.baseUrl);
    const preset = presetOf(parsed.data.presetId);
    const row = saveProviderRow(
      this.store.db,
      { ...parsed.data, baseUrl, presetId: preset.id },
      endpointOf(preset, baseUrl) ?? null,
    );
    if (!row)
      throw new AppError('LLM_PROVIDER_NOT_FOUND', `池里没有这个提供商实例：${parsed.data.id ?? ''}`, 'llm.settings', {
        id: parsed.data.id,
      });
    const trimmedKey = parsed.data.apiKey?.trim() ?? '';
    if (trimmedKey !== '')
      maybeService<ConfigService>(this.ctx, 'config')?.setSecret(providerSecretPath(row.id), trimmedKey);
    return this.providerView(row);
  };

  /**
   * 删一个提供商实例：清单连带删、密钥库那一把一起清、引用它的角色绑定回落到未绑定（spec 7.2-09 的三条）。
   *
   * 三条都必须在这里做，缺一条就留下孤儿：行删了而 `llm_models` 留着是孤儿清单，密钥留着是孤儿凭证，
   * 绑定还指着它则是**悬空绑定**——那条腿每次请求都要先解析一次才发现"这一行没有了"，界面上看着像端点坏了。
   * 回落之后那条腿按 7.2-12 的顺序重解析（有 yml/env 兜底就用兜底），缺项由 `read()` 照报
   * （`missing` 里会重新长出 `model` / `apiKey`），所以界面不用自己拼这句话。
   * @param id 实例 id
   * @returns 删完之后剩下的实例（界面不用再补一刀）
   * @throws id 不在池里 `LLM_PROVIDER_NOT_FOUND`
   */
  deleteProvider = async (id: string): Promise<LlmProviderInstanceView[]> => {
    if (!deleteProviderRow(this.store.db, id)) {
      throw new AppError('LLM_PROVIDER_NOT_FOUND', `池里没有这个提供商实例：${id}`, 'llm.settings', { id });
    }
    maybeService<ConfigService>(this.ctx, 'config')?.clearSecret(providerSecretPath(id));
    const kernel = maybeService<KernelReader>(this.ctx, 'kernel');
    for (const leg of ['chat', 'embed'] as const) {
      const pluginId = LEG_PLUGIN[leg];
      if (this.effectiveOf(pluginId).providerId !== id) continue;
      // 绑定是一次原子表态（实例 + 模型名两条键一起写），撤它就得两条一起撤：只撤 `providerId`
      // 会让这条腿挂着一个已经不存在的模型名，而界面的候选出自 `llm_models`，那一格里再也没有它。
      const unset = { providerId: null, model: null };
      maybeService<ConfigService>(this.ctx, 'config')?.setPersisted(pluginId, unset, ['providerId', 'model']);
      if (kernel) await kernel.applyConfig(pluginId, unset);
    }
    return this.listProviders();
  };

  /**
   * 某家已经入库的模型清单（界面上「添加所选」之后的那份，也是角色绑定的候选源）。
   * @param providerId 实例 id
   * @returns 按模型名排的清单；这一格还没入库东西时是空数组
   */
  listModels = (providerId: string): LlmModelView[] =>
    modelRowsOf(this.store.db, providerId).map((row) => ({
      providerId: row.provider_id,
      model: row.model,
      origin: row.origin === 'manual' ? 'manual' : 'fetched',
      addedAt: Number(row.added_at),
    }));

  /**
   * 勾选入库：只有勾了的进表，重复勾同一条是幂等的（spec 7.2-06）。
   * @param input 实例 id 与勾中的模型名（`origin` 省略时记 `fetched`，手工敲的那条走 `manual`）
   * @returns 这家现在的清单
   * @throws 入参不合法 `INVALID_ARGUMENT`；实例不在池里 `LLM_PROVIDER_NOT_FOUND`
   */
  addModels = (input: AddModelsInput): LlmModelView[] => {
    const parsed = addModelsSchema.safeParse(input);
    if (!parsed.success) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `模型清单入参不合法：${parsed.error.issues[0]?.message ?? ''}`,
        'llm.settings',
        {
          issues: parsed.error.issues.map((issue) => issue.path.join('.')),
        },
      );
    }
    const { providerId, models, origin } = parsed.data;
    if (!providerRowOf(this.store.db, providerId)) {
      throw new AppError('LLM_PROVIDER_NOT_FOUND', `池里没有这个提供商实例：${providerId}`, 'llm.settings', {
        providerId,
      });
    }
    addModelRows(this.store.db, providerId, models, origin);
    return this.listModels(providerId);
  };

  /**
   * 从清单里摘掉一条模型。
   * @param providerId 实例 id
   * @param model 模型名（原样匹配）
   * @returns 这家剩下的清单
   */
  removeModel = (providerId: string, model: string): LlmModelView[] => {
    removeModelRow(this.store.db, providerId, model);
    return this.listModels(providerId);
  };

  /**
   * 问一家网关要它的模型清单（spec 7.2-05）：本服务一个字节都不发，转调 `llm.chat.listModels`。
   *
   * 失败**绝不清空**已入库的清单（spec 7.2-07）：这一条只读数、只播报，唯一的写路径是界面上随后的
   * 「添加所选」（`addModels`）。把"拉取失败"顺手变成"清空重来"会让用户一次网络抖动就丢掉整家清单。
   * @param providerId 池实例 id
   * @returns 结构化结果：`ok` 是否拿到、`models` 候选、`reason` 失败码（`EMPTY` = 拿到了但一条都没有）
   * @throws 不抛——失败以 `reason` 回给界面，与非 2xx / 超时同一套读法
   */
  fetchModels = async (providerId: string): Promise<LlmFetchModelsView> => {
    const started = Date.now();
    const chat = maybeService<LlmChatService>(this.ctx, 'llm.chat');
    if (!chat) {
      return { ok: false, models: [], reason: 'LLM_UNAVAILABLE', message: '模型出口未装载', elapsedMs: 0 };
    }
    try {
      // `model` 这一格清单探测用不上，但连通测试与它共用同一个目标形状（`LlmProbeTarget`），所以照样点名。
      const listing = await chat.listModels({ providerId, model: '' });
      if (listing.models.length === 0) {
        return {
          ok: false,
          models: [],
          reason: 'EMPTY',
          message: '这家回给的模型清单是空的',
          elapsedMs: Date.now() - started,
        };
      }
      return { ok: true, models: listing.models, reason: null, message: null, elapsedMs: Date.now() - started };
    } catch (error) {
      const payload = AppError.from(error, 'LLM_REQUEST_FAILED');
      return { ok: false, models: [], reason: payload.code, message: payload.message, elapsedMs: Date.now() - started };
    }
  };

  /**
   * 测某一家实例的连通性（spec 7.2-04）：发**一次**最小 chat 请求，判据与生产路径完全一致。
   * @param providerId 池实例 id
   * @param model 这次探测点名用哪条模型名（界面上「测试连通」旁边那条）
   * @returns 结构化结果；失败不抛，界面按 `reason` 说话
   */
  checkProvider = async (providerId: string, model: string): Promise<LlmCheckView> => {
    const started = Date.now();
    const chat = maybeService<LlmChatService>(this.ctx, 'llm.chat');
    if (!chat) return { ok: false, model: null, reason: 'LLM_UNAVAILABLE', message: '模型出口未装载', elapsedMs: 0 };
    try {
      const completion = await chat.complete(
        { messages: [{ role: 'user', content: 'ping' }], maxTokens: 8 },
        { providerId, model },
      );
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

  /**
   * 角色绑定：把一条腿指到池里某个实例的某条**已入库**模型（spec 7.2-11）。
   *
   * 候选只出自 `llm_models`，所以"能选到的就一定已经在清单里"——这条硬约束是为了不让界面长出一个
   * 可以手敲任意模型名的口子（那会让 7.2-12 的解析顺序变成猜）。
   * 落盘走 `config` 的持久层 + `kernel.applyConfig` 热改，所以保存后**不用重启**就生效（spec 7.1-08 同一条链）。
   * @param input 哪条腿、哪个实例、哪条模型
   * @returns 绑定后的读数（两条腿都重算，界面不用再补一刀）
   * @throws 入参不合法 `INVALID_ARGUMENT`；实例不在池里 `LLM_PROVIDER_NOT_FOUND`；模型没入库 `INVALID_ARGUMENT`（`details.reason = 'MODEL_NOT_ADDED'`）
   */
  bindRole = async (input: BindRoleInput): Promise<LlmSettingsView> => {
    const parsed = bindRoleSchema.safeParse(input);
    if (!parsed.success) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `角色绑定不合法：${parsed.error.issues[0]?.message ?? ''}`,
        'llm.settings',
        { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
      );
    }
    const { leg, providerId, model } = parsed.data;
    if (!providerRowOf(this.store.db, providerId)) {
      throw new AppError('LLM_PROVIDER_NOT_FOUND', `池里没有这个提供商实例：${providerId}`, 'llm.settings', {
        providerId,
      });
    }
    if (!modelRowsOf(this.store.db, providerId).some((row) => row.model === model)) {
      throw new AppError('INVALID_ARGUMENT', `这条模型还没有入库：${model}`, 'llm.settings', {
        providerId,
        model,
        reason: 'MODEL_NOT_ADDED',
      });
    }
    const config = maybeService<ConfigService>(this.ctx, 'config');
    if (!config) {
      throw new AppError('SETTING_NOT_ALLOWED', '配置服务未装载，角色绑定无处落盘', 'llm.settings', { leg });
    }
    const pluginId = LEG_PLUGIN[leg];
    // 只写 `providerId` 与 `model` 两个键，**不复制 baseUrl**：端点当场向池问（`resolveLeg`），
    // 否则用户改了那家的地址，这条腿还会拿着旧地址打（AGENTS.md §2.5）。
    config.setPersisted(pluginId, { providerId, model }, ['providerId', 'model']);
    const kernel = maybeService<KernelReader>(this.ctx, 'kernel');
    if (kernel) await kernel.applyConfig(pluginId, { providerId, model });
    return this.read();
  };

  /**
   * 一行实例 → 界面读数：掩码末 4 位现问密钥库，条数现数表。
   * @param row `llm_providers` 的一行
   * @returns 可以过进程边界的那份
   */
  private providerView = (row: ProviderRow): LlmProviderInstanceView => {
    const storedKey = maybeService<ConfigService>(this.ctx, 'config')?.getSecret(providerSecretPath(row.id)) ?? '';
    return {
      id: row.id,
      presetId: row.preset_id,
      endpointId: row.endpoint_id,
      label: row.label,
      baseUrl: row.base_url,
      hasKey: storedKey !== '',
      keyTail: storedKey.slice(-4),
      modelCount: modelRowsOf(this.store.db, row.id).length,
    };
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
    this.ensureSchema();
    const chat = this.readLeg('chat');
    this.ctx.logger.info(
      chat.available
        ? `模型设置已装载：${String(chat.model)} @ ${String(chat.baseUrl)} · key 来自 ${chat.key.source}`
        : `模型尚未配置完整：缺 ${chat.missing.join(' / ')}`,
    );
  }

  /**
   * 把提供商池的两支迁移登记进 `store.migrations` 并建表（号段 31 / 32，plan §7.3）。
   *
   * 幂等 push 是硬要求：插件重启会重新构造本服务，无条件 push 会在共享清单里留下两个 `version: 31`，
   * 之后任何一次 `upgrade()` 都直接抛「迁移版本重复」（口径同 `packages/scheduler/src/registry.ts`）。
   */
  private ensureSchema(): void {
    const { migrations } = this.store;
    for (const migration of [llmProviderMigration, llmModelMigration]) {
      if (!migrations.some((item) => item.version === migration.version)) migrations.push(migration);
    }
    this.store.upgrade();
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'llm.settings': LlmSettingsService;
  }
}
