/**
 * key 的读取链（spec 7.1-07）：两条模型腿共用同一句话——**先看密钥库，再用环境变量兜底**。
 *
 * 放在同包的一支小函数里而不是各写一遍：`llm.chat` 与 `llm.embed` 对 key 的处置完全同构，
 * 差别只有密钥路径与变量名（AGENTS.md §2.2）。
 *
 * 每次调用都现问 `config` 服务，不在本地留副本：`config` 会因为热改配置而被重建，
 * 存下来的引用就变成第二份事实（§9 实测 2.5 那条踩过）。
 */
import { maybeService, type Context } from '@auto-cc/core';
import type { ConfigService } from '@auto-cc/plugin-config';

/** key 的出处读数。 */
export interface KeyProbe {
  /** 明文；两处都没有时是空串，由调用方的 `status()` 判为「缺 apiKey」。 */
  value: string;
  /** 这一把从哪来：密钥库 / 环境变量 / 没有。 */
  source: 'secret' | 'env' | 'none';
}

/**
 * 按「密钥库 → 环境变量」的顺序取一条模型 key。
 * @param ctx 当前服务的上下文（用于按名字现问 `config`）
 * @param secretPath 密钥库里的路径（服务名级别，如 `llm.chat`）
 * @param keyEnv 兜底的环境变量名（配置里的 `keyEnv`，保留它是为了让 CI 与验收复跑仍可 export 一把）
 * @returns 明文与出处；`config` 未装载时只走环境变量那一路，不抛
 */
export function readModelKey(ctx: Context, secretPath: string, keyEnv: string): KeyProbe {
  const stored = maybeService<ConfigService>(ctx, 'config')?.getSecret(secretPath)?.trim() ?? '';
  if (stored) return { value: stored, source: 'secret' };
  const fromEnv = process.env[keyEnv]?.trim() ?? '';
  return fromEnv ? { value: fromEnv, source: 'env' } : { value: '', source: 'none' };
}
