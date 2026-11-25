/**
 * 每个提供商实例的「采样与思考参数」以及自定义请求头（2026-11-25 用户裁定：模型要支持自定义温度、
 * 最大 token、请求头、思考强度）。
 *
 * 三条纪律写在这一层：
 * 1. **`NULL` = 不发送**。字段整个不出现在请求体里——严格端点只接受 `temperature=1` 的那一类，
 *    塞一个默认 0.7 就是 400（本轮用户撞到的就是这一条）。所以「没配」与「配成 0」必须能分开。
 * 2. **请求头与 apiKey 同级**：值只进密钥库（`llm.provider-headers:<id>`），表里一个字节都不留；
 *    过界时只交名字，界面要改值就让人重新填。
 * 3. **`authorization` 不许自定义**：那一格是本服务写 key 的地方，两处都能写就是第二个真相（§2.5），
 *    保存时直接拒绝并说清原因，不许静默覆盖。
 */
import { AppError, maybeService, type Context } from '@auto-cc/core';
import type { ConfigService } from '@auto-cc/plugin-config';
import type { LlmReasoningEffort } from '@auto-cc/shared';
import { providerHeadersSecretPath } from './provider-pool.js';

/** 一条自定义请求头（值只在内存与密钥库里出现）。 */
export type ProviderHeader = { name: string; value: string };

/** 不允许自定义的那个头：本服务用 Bearer key 写它。 */
const RESERVED_HEADER = 'authorization';

/**
 * 校验一组自定义请求头。
 * @param headers 人填的键值对（可能重复、可能留空值）
 * @returns 去重并去掉名字两侧空白后的清单（名字保持原大小写）
 * @throws `INVALID_ARGUMENT`：用 `authorization`、同名重复、或名字为空
 */
export function normalizeHeaders(headers: readonly ProviderHeader[]): ProviderHeader[] {
  const seen = new Set<string>();
  const normalized: ProviderHeader[] = [];
  for (const header of headers) {
    const name = header.name.trim();
    if (name === '') {
      throw new AppError('INVALID_ARGUMENT', '自定义请求头不能有空名字：要么删掉这一行，要么填个名字', 'llm.settings');
    }
    const lower = name.toLowerCase();
    if (lower === RESERVED_HEADER) {
      throw new AppError(
        'INVALID_ARGUMENT',
        '`authorization` 由本服务用你的 API key 自己写，不能自定义（想换密钥就改 key 那一格）',
        'llm.settings',
        { header: name },
      );
    }
    if (seen.has(lower)) {
      throw new AppError('INVALID_ARGUMENT', `自定义请求头 \`${name}\` 重复了：同一个名字只能有一条`, 'llm.settings', {
        header: name,
      });
    }
    seen.add(lower);
    normalized.push({ name, value: header.value });
  }
  return normalized;
}

/**
 * 读某个实例的自定义请求头（解不开就按「没有」处理，不把解密失败传染成配置不可用）。
 * @param ctx 服务上下文
 * @param providerId 实例 id
 * @returns 头键值对；没存或解不开时为空数组
 */
export function readProviderHeaders(ctx: Context, providerId: string): ProviderHeader[] {
  const raw = maybeService<ConfigService>(ctx, 'config')?.getSecret(providerHeadersSecretPath(providerId)) ?? '';
  if (raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const headers: ProviderHeader[] = [];
    for (const item of parsed) {
      const name = (item as { name?: unknown } | null)?.name;
      const value = (item as { value?: unknown } | null)?.value;
      if (typeof name === 'string' && name !== '' && typeof value === 'string') headers.push({ name, value });
    }
    return headers;
  } catch {
    // 手改过配置、旧版本残留都可能让这一串不是合法 JSON：按「没有自定义头」处理，
    // 与 `settings.ts` 里「密钥库读不到就当没存」同一条口径。
    return [];
  }
}

/**
 * 存或清某个实例的自定义请求头。
 * @param ctx 服务上下文
 * @param providerId 实例 id
 * @param headers 目标清单；空数组 = 清掉那一格（不留空串占位）
 */
export function writeProviderHeaders(ctx: Context, providerId: string, headers: readonly ProviderHeader[]): void {
  const config = maybeService<ConfigService>(ctx, 'config');
  if (!config) return;
  const path = providerHeadersSecretPath(providerId);
  if (headers.length === 0) {
    config.clearSecret(path);
    return;
  }
  config.setSecret(path, JSON.stringify(headers));
}

/** 一个实例的采样/思考参数（`null` = 这一格不发送）。 */
export type ProviderTuning = {
  temperature: number | null;
  maxTokens: number | null;
  reasoningEffort: LlmReasoningEffort | null;
};

/**
 * 把「实例参数」与「通道配置」合成这一次请求真正要发的那几个值。
 *
 * 绑定到实例时**完全以实例为准**（包括它的 `null` = 不发送）：否则「实例上选了不发送」会被通道的
 * 默认值偷偷顶回去，用户改的那一格等于没改。没绑定时才用通道配置。
 * @param origin 端点来源（`pool` / `config` / `none`）
 * @param fromInstance 实例上的三格
 * @param fromConfig 通道配置里的三格
 * @returns 生效的三格
 */
export function effectiveTuning(
  origin: 'pool' | 'config' | 'none',
  fromInstance: ProviderTuning,
  fromConfig: ProviderTuning,
): ProviderTuning {
  return origin === 'pool' ? fromInstance : fromConfig;
}
