/**
 * 一条模型腿的**解析顺序**（spec 7.2-12，plan §7.4）：角色绑定 > 配置格自己的端点（yml/env 兜底）> 未配置。
 *
 * 抽成一支纯函数的理由与 `key.ts` 同一条：chat 与 embed 对"这次到底打哪儿、用哪把 key"的判法完全同构，
 * 差别只有配置格的名字（AGENTS.md §2.2）。留在两个服务里各写一遍，就会长出"绑定了但只有聊天腿听绑定"这种缺陷。
 *
 * 这里**不存第二份事实**（§2.7）：池里那一行的 `baseUrl` 是当场问 `store` 拿的，所以用户改了某个实例的地址，
 * 下一次请求立刻跟着变，不需要任何一次"重新绑定"。`store` 是软取的——它没挂载时按"绑定读不到"回落，
 * 而不是让模型出口崩掉。
 */
import { maybeService, type Context } from '@auto-cc/core';
import type { StoreService } from '@auto-cc/plugin-store';
import { providerRowOf, providerSecretPath } from './provider-pool.js';

/** 哪条模型腿：chat 是话术与规划，embed 是知识库的向量增强。 */
export type LegName = 'chat' | 'embed';

/** 腿 → 密钥库里"没有绑定时"的那一格路径（与 `llm.settings` 的 7.1 读法同词）。 */
const LEG_SECRET: Record<LegName, string> = { chat: 'llm.chat', embed: 'llm.embed' };

/** 一条腿在自己配置格里的读法（`llm` / `llm-embed` 那两格的子集）。 */
export interface LegConfig {
  /** 角色绑定指向的池实例 id；`null` = 没绑定，走这条腿自己的端点。 */
  providerId: string | null;
  /** 配置格（yml / 持久层 / env 合并后）自己的端点前缀。 */
  baseUrl: string | null;
  /** 模型名。绑定态与兜底态都读这一格，所以"选了哪家"与"用哪条模型"是两次表态。 */
  model: string | null;
  /** key 的兜底环境变量名。 */
  keyEnv: string;
}

/**
 * 解析结果：这一腿实际用的端点、以及该问密钥库哪一格。
 * `model` 可能是 null —— "缺模型名"永远是这条腿自己的缺项，不由池替它决定。
 */
export interface ResolvedLeg {
  baseUrl: string | null;
  model: string | null;
  /** 读 key 时问的路径：绑定态是 `llm.provider:<实例 id>`，兜底态是腿自己的服务名。 */
  secretPath: string;
  keyEnv: string;
  /** 端点是谁给的：池实例 / 配置格自己 / 两边都没有。界面上"这一腿在用哪家"就读这一个值。 */
  origin: 'pool' | 'config' | 'none';
  /** 生效的绑定（读不到那一行时为 null，即回落）。 */
  providerId: string | null;
}

/**
 * 按「绑定 > 兜底 > 未配置」解析一条腿。
 * @param ctx 当前服务的上下文（用于按名字软取 `store`）
 * @param leg 哪条腿，决定兜底密钥路径
 * @param config 该腿配置格里的四个值
 * @returns 解析结果；不抛——"没绑定且没兜底"是合法形态，由调用方的 `status()` 列进 `missing`
 */
export function resolveLeg(ctx: Context, leg: LegName, config: LegConfig): ResolvedLeg {
  const fallback = { secretPath: LEG_SECRET[leg], keyEnv: config.keyEnv, model: config.model };
  if (config.providerId) {
    const db = maybeService<StoreService>(ctx, 'store')?.db;
    const row = db ? providerRowOf(db, config.providerId) : undefined;
    // 绑定了但那一行读不到（实例刚被删 / store 未挂载）：按兜底走并在读数里报回落，
    // 而不是抱着一个已经不存在的端点发请求。
    if (row) {
      return {
        baseUrl: row.base_url,
        providerId: row.id,
        origin: 'pool',
        secretPath: providerSecretPath(row.id),
        keyEnv: config.keyEnv,
        model: config.model,
      };
    }
    return { ...fallback, baseUrl: config.baseUrl, providerId: null, origin: config.baseUrl ? 'config' : 'none' };
  }
  return { ...fallback, baseUrl: config.baseUrl, providerId: null, origin: config.baseUrl ? 'config' : 'none' };
}

/**
 * 把 `/models` 的回包读成模型名数组（spec 7.2-05 的容错半边）。
 *
 * 实测里至少三种形状活着：OpenAI 的 `data[].id`、部分网关的 `models[]`（同族字段名不同），
 * 以及夹带非 OpenAI 字段的混合体。所以判定按**每项**做（`typeof id === 'string'`），
 * 脏项跳过而不是整包判坏——一家网关多带几个键不该让用户看不到清单。
 * 排序不在这里做：清单顺序由 `llm_models` 的 `ORDER BY model` 决定，回包原样进候选列表。
 * @param payload 对端 JSON（`requestJson` 的输出）
 * @returns 模型名数组；形状完全不认识时是空数组（调用方据此报"这份清单是空的"，不清已入库的行）
 */
export function readModelIds(payload: unknown): string[] {
  const root = payload as { data?: unknown; models?: unknown };
  const list = Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : [];
  const ids: string[] = [];
  for (const item of list) {
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && id !== '') ids.push(id);
  }
  return ids;
}
