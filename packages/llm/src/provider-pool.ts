/**
 * 提供商实例池的两张表：`llm_providers`（用户添加的每一家）与 `llm_models`（每家勾选入库的模型清单）
 * （spec 7.2-02 / 06 / 08 / 09 / 10 的存储半边，plan §7.3 的两张表原文）。
 *
 * 这一层只有 SQL 与「行 ↔ 结构」的转换：这把 key 从哪来、这条通道绑了谁，一律留在 `llm.settings`
 * 现问现算（两处都能判就是第二个真相，AGENTS.md §2.5）。过进程边界的那几份视图与入参类型
 * 出自 `@auto-cc/shared`（7.2-d），这里只做别名，不重抄字段。
 *
 * 号段 31 / 32 的由来：台账里已用过的最高值是 29，30 被 plan §8.3 预留给 3.6 的草稿表
 * （AGENTS.md §9 实测 5.3-a），所以加表只能另起号段——把 `CREATE TABLE` 塞进已记过账的老版本号里，
 * 老库（含本机开发实例）永远不会重跑那支 `up`。
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { LlmModelOrigin, LlmProviderAddModelsInput, LlmProviderSaveInput } from '@auto-cc/shared';
import { z } from 'zod';

/** 添加/修改一个提供商实例的入参（`id` 省略 = 新增）。 */
export const saveProviderSchema = z.strictObject({
  id: z.string().min(1).optional(),
  /** 目录里的预设 id；认不出来时由调用方先回落成 `custom`（`presetOf` 那条）。 */
  presetId: z.string().min(1),
  /** 界面显示名，用户可改。名字不进目录数据（那是语言包的活，§5.5），所以这里必须给。 */
  label: z.string().min(1),
  /** 端点前缀；入库前由 `llm.settings` 归一（spec 7.2-03）。 */
  baseUrl: z.url(),
  /** 明文 key：空/省略 = 不动已存的那把（与 7.1 掩码框同一条语义）。 */
  apiKey: z.string().nullish(),
  /**
   * 采样温度：`null` = 不发送；省略 = 不动已存值；数字 0–2 = 显式发送。
   * 上界 2 是既有口径；下界 0。
   */
  temperature: z.number().min(0).max(2).nullish(),
  /**
   * 回复长度上限：`null` = 不发送。上界放到 200000 而不是旧版 8192——
   * 旧值是把「话术只要一两句」的通道缺省当成了所有端点的极限（2026-11-25 用户裁定要能自定义）。
   */
  maxTokens: z.number().int().min(1).max(999_999).nullish(),
  /** 思考强度；`null` = 不发送。 */
  reasoningEffort: z.enum(['low', 'medium', 'high']).nullish(),
  /**
   * 自定义请求头：数组 = 整体替换（`[]` = 清空），省略 = 不动。
   *
   * 名字按 HTTP token 校验（拒绝会破坏请求行的字符），值允许任意可见文本；
   * **`authorization` 不许自定义**——那是本服务写 key 的那一格，两处都能写就是两个真相（§2.5）。
   */
  headers: z
    .array(
      z.strictObject({
        name: z
          .string()
          .min(1)
          .max(120)
          .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, '请求头名字只能含 HTTP token 允许的字符'),
        value: z.string().max(4000),
      }),
    )
    .nullish(),
});

/**
 * `saveProviderSchema` 校验后的形状：**别名指向 `shared` 里的那份契约**，不在这里重抄字段。
 * 一旦 schema 与契约漂移，`saveProviderRow(...)` 的实参处就会报 TS 错，不需要另写一层类型断言（AGENTS.md §2.6）。
 */
export type SaveProviderInput = LlmProviderSaveInput;

/** 一条模型清单的来源：自动获取勾进来的 / 人手敲的。 */
export const modelOriginSchema = z.enum(['fetched', 'manual']);

/** 勾选入库的入参：`models` 是界面上勾中的那几条，名字原样进表（不做大小写加工）。 */
export const addModelsSchema = z.strictObject({
  providerId: z.string().min(1),
  models: z.array(z.string().min(1)),
  origin: modelOriginSchema.default('fetched'),
});

/** `addModelsSchema` 的入参形状：契约出自 `shared`，`origin` 可省略（缺省由 schema 补成 `fetched`）。 */
export type AddModelsInput = LlmProviderAddModelsInput;

/** `llm_providers` 一行（列名与视图字段不同名，转换收在 `providerRowOf` 一侧）。 */
export type ProviderRow = {
  id: string;
  preset_id: string;
  label: string;
  base_url: string;
  endpoint_id: string | null;
  /** 采样温度；`NULL` = 不发送这个字段。 */
  temperature: number | null;
  /** 回复长度上限；`NULL` = 不发送。 */
  max_tokens: number | null;
  /** 思考强度；`NULL` = 不发送。 */
  reasoning_effort: 'low' | 'medium' | 'high' | null;
  created_at: number;
  updated_at: number;
};

/**
 * 自定义请求头在密钥库里的路径：与 apiKey 同一条加密路径、按实例 id 派生（一个值都不进表）。
 * @param id `llm_providers.id`
 * @returns `llm.provider-headers:<id>` 形态的路径
 */
export const providerHeadersSecretPath = (id: string): string => `llm.provider-headers:${id}`;

/**
 * 提供商实例的迁移号段：**31**（30 预留给 3.6 的草稿表，当前台账最高 29）。
 *
 * 这张表**一个字节密钥都没有**（spec 7.2-10）：key 只在 `config` 的密钥库那一格，
 * 路径由 `id` 派生（见 `providerSecretPath`）。
 */
export const LLM_PROVIDER_MIGRATION_VERSION = 31;

/** 建 `llm_providers`：短 id 主键，`preset_id` 只记来源不参与解析。 */
export const llmProviderMigration = {
  version: LLM_PROVIDER_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS llm_providers (
      id TEXT PRIMARY KEY,
      preset_id TEXT NOT NULL,
      label TEXT NOT NULL,
      base_url TEXT NOT NULL,
      endpoint_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS llm_providers');
  },
};

/**
 * 采样与思考参数三列的迁移号段：**47**（46 已被 `outbound_attempts` 重建用掉）。
 *
 * 为什么另起号段而不是改 31 的 `up`：迁移的判据是台账里「这一版记过账没有」，改老版本在新老库上都不会重跑
 * （AGENTS.md §9 实测 5.3-a）。三列都允许 `NULL`，**`NULL` 的语义是「这个字段不发送」**，
 * 与「发送默认值」是两件事——严格端点只接受 `temperature=1` 的那一类，塞一个 0.7 就是 400。
 * 自定义请求头**不在表里**：它与 apiKey 同级，只进密钥库（`llm.provider-headers:<id>`）。
 */
export const LLM_PROVIDER_TUNING_MIGRATION_VERSION = 47;

/** 给 `llm_providers` 加 `temperature` / `max_tokens` / `reasoning_effort` 三列。 */
export const llmProviderTuningMigration = {
  version: LLM_PROVIDER_TUNING_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec('ALTER TABLE llm_providers ADD COLUMN temperature REAL');
    db.exec('ALTER TABLE llm_providers ADD COLUMN max_tokens INTEGER');
    db.exec(
      "ALTER TABLE llm_providers ADD COLUMN reasoning_effort TEXT CHECK (reasoning_effort IN ('low', 'medium', 'high'))",
    );
  },
  down: (db: DatabaseSync) => {
    // SQLite 删列要重建表；这三列都是可空、无外键，`DROP COLUMN` 在 3.35+ 可用（本机 sqlite 3.53.4）。
    db.exec('ALTER TABLE llm_providers DROP COLUMN reasoning_effort');
    db.exec('ALTER TABLE llm_providers DROP COLUMN max_tokens');
    db.exec('ALTER TABLE llm_providers DROP COLUMN temperature');
  },
};

/**
 * 模型清单的迁移号段：**32**（与 31 同一片到货，一张表一支迁移，回滚时两张一起消失才算干净）。
 *
 * 主键就是 `(provider_id, model)`：重复入库走 upsert，所以"再拉一遍并全勾上"是幂等的（spec 7.2-06）。
 */
export const LLM_MODEL_MIGRATION_VERSION = 32;

/** 建 `llm_models`：一条模型属于且仅属于一个提供商。 */
export const llmModelMigration = {
  version: LLM_MODEL_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS llm_models (
      provider_id TEXT NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      origin TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (provider_id, model)
    )`);
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS llm_models');
  },
};

/**
 * 提供商实例的密钥库路径：由实例 id 派生，不留第二份映射（spec 7.2-10）。
 * @param id `llm_providers.id`
 * @returns `llm.provider:<id>` 形态的路径
 */
export const providerSecretPath = (id: string): string => `llm.provider:${id}`;

/**
 * 新增或改一个提供商实例。
 *
 * `endpoint_id` 不是入参而是**算出来的**（由 `endpointOf` 按地址认）：地址与变体本是同一件事的两面，
 * 让人分两格表态就会长出"地址是 Coding Plan、变体记成标准"这种自相矛盾的行（§2.5）。
 * @param db store 的连接
 * @param input 已校验、`baseUrl` 已归一的入参（`apiKey` 不进这张表，调用方自己写密钥库）
 * @param endpointId 该地址在这家预设里的端点变体 id；认不出为 null
 * @param nowMs 时间戳基准（毫秒），测试传固定值
 * @returns 落库后的那一行；`input.id` 给了但池里没有时回 undefined（什么都没写）
 */
export function saveProviderRow(
  db: DatabaseSync,
  input: SaveProviderInput,
  endpointId: string | null,
  nowMs: number = Date.now(),
): ProviderRow | undefined {
  const existing = input.id ? providerRowOf(db, input.id) : undefined;
  if (input.id !== undefined && !existing) return undefined;
  // 三列都是三态：省略 = 不动已存值；显式 `null` = **清成「不发送」**；数字/枚举 = 显式发送。
  const temperature = input.temperature === undefined ? (existing?.temperature ?? null) : input.temperature;
  const maxTokens = input.maxTokens === undefined ? (existing?.max_tokens ?? null) : input.maxTokens;
  const reasoningEffort =
    input.reasoningEffort === undefined ? (existing?.reasoning_effort ?? null) : input.reasoningEffort;
  if (existing) {
    db.prepare(
      `UPDATE llm_providers
          SET preset_id = ?, label = ?, base_url = ?, endpoint_id = ?, temperature = ?, max_tokens = ?, reasoning_effort = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      input.presetId,
      input.label,
      input.baseUrl,
      endpointId,
      temperature,
      maxTokens,
      reasoningEffort,
      nowMs,
      existing.id,
    );
    return {
      ...existing,
      preset_id: input.presetId,
      label: input.label,
      base_url: input.baseUrl,
      endpoint_id: endpointId,
      temperature,
      max_tokens: maxTokens,
      reasoning_effort: reasoningEffort,
      updated_at: nowMs,
    };
  }
  const row: ProviderRow = {
    // id 只用来派生密钥路径和当外键，界面从不按它拼文案。
    id: randomUUID(),
    preset_id: input.presetId,
    label: input.label,
    base_url: input.baseUrl,
    endpoint_id: endpointId,
    temperature,
    max_tokens: maxTokens,
    reasoning_effort: reasoningEffort,
    created_at: nowMs,
    updated_at: nowMs,
  };
  db.prepare(
    `INSERT INTO llm_providers (id, preset_id, label, base_url, endpoint_id, temperature, max_tokens, reasoning_effort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.preset_id,
    row.label,
    row.base_url,
    row.endpoint_id,
    row.temperature,
    row.max_tokens,
    row.reasoning_effort,
    row.created_at,
    row.updated_at,
  );
  return row;
}

/**
 * 按 id 取一行。
 * @param db store 的连接
 * @param id 实例 id
 * @returns 那一行；不存在时 undefined（调用方据此报错，不在这里判"该不该存在"）
 */
export function providerRowOf(db: DatabaseSync, id: string): ProviderRow | undefined {
  try {
    return db.prepare('SELECT * FROM llm_providers WHERE id = ?').get(id) as unknown as ProviderRow | undefined;
  } catch (error) {
    // 「表还没建」不是这条查询的失败，而是**这一刻这一池还不可读**（2026-11-24 QA 的冷启动缺陷：
    // 全新空库首启时 `llm` 的 init 比建表的 `llm-settings` 先跑，读表直接炸掉整个服务，连带
    // outbound-greet / journey 一起 PENDING，工具面只剩 17 只）。按「绑定读不到就回落」的既有口径处理：
    // 回 undefined，调用方走通道自己的 baseUrl（模板回落），等建表插件挂上来之后自然读得到。
    if (typeof error === 'object' && error !== null && /no such table/i.test(String((error as Error).message))) {
      return undefined;
    }
    throw error;
  }
}

/**
 * 列全部实例，按添加先后。
 * @param db store 的连接
 * @returns 行数组；池是空的就回空数组，界面上那段显示"还没添加提供商"
 */
export function providerRowsOf(db: DatabaseSync): ProviderRow[] {
  return db.prepare('SELECT * FROM llm_providers ORDER BY created_at, id').all() as unknown as ProviderRow[];
}

/**
 * 删一个实例，并在**同一条事务**里删掉它的模型清单行。
 *
 * 为什么显式删子表而不靠 DDL 里那句 `ON DELETE CASCADE`：`store` 开连接时没有
 * `PRAGMA foreign_keys = ON`（本机实测：全仓没有一处设这个 pragma），外键约束默认不生效，
 * 只留 DDL 就会长出孤儿行。DDL 里那句仍然写着，是为了 pragma 一旦开起来两边行为一致。
 * @param db store 的连接
 * @param id 实例 id
 * @returns 是否真删掉了一行（false = 这个 id 不在池里）
 */
export function deleteProviderRow(db: DatabaseSync, id: string): boolean {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM llm_models WHERE provider_id = ?').run(id);
    const changes = db.prepare('DELETE FROM llm_providers WHERE id = ?').run(id).changes;
    db.exec('COMMIT');
    return Number(changes) > 0;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 把一个 id 从某家的清单里摘掉。
 * @param db store 的连接
 * @param providerId 实例 id
 * @param model 模型名（原样匹配，不做大小写加工）
 * @returns 是否删掉了行
 */
export function removeModelRow(db: DatabaseSync, providerId: string, model: string): boolean {
  return (
    Number(db.prepare('DELETE FROM llm_models WHERE provider_id = ? AND model = ?').run(providerId, model).changes) > 0
  );
}

/**
 * 勾选入库：已在清单里的原样跳过（幂等，spec 7.2-06），没勾的一条都不落。
 * @param db store 的连接
 * @param providerId 实例 id
 * @param models 勾选的模型名，原样存服务端给的那份
 * @param origin 这批的来源
 * @param nowMs 时间戳基准（毫秒）
 * @returns 本次新增的行数（勾了但早已在清单里 = 0）
 */
export function addModelRows(
  db: DatabaseSync,
  providerId: string,
  models: readonly string[],
  origin: LlmModelOrigin,
  nowMs: number = Date.now(),
): number {
  const statement = db.prepare(
    'INSERT INTO llm_models (provider_id, model, origin, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (provider_id, model) DO NOTHING',
  );
  db.exec('BEGIN');
  try {
    let added = 0;
    for (const model of models) {
      added += Number(statement.run(providerId, model, origin, nowMs).changes);
    }
    db.exec('COMMIT');
    return added;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** `llm_models` 一行的读数。 */
export type ModelRow = {
  provider_id: string;
  model: string;
  origin: string;
  added_at: number;
};

/**
 * 某家已入库的清单，按模型名排（界面上的候选顺序因此稳定，重开一次不会换序）。
 * @param db store 的连接
 * @param providerId 实例 id
 * @returns 行数组
 */
export function modelRowsOf(db: DatabaseSync, providerId: string): ModelRow[] {
  return db
    .prepare('SELECT * FROM llm_models WHERE provider_id = ? ORDER BY model')
    .all(providerId) as unknown as ModelRow[];
}
