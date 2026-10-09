/**
 * `llm.presets` —— OpenAI 兼容提供商目录（spec 7.2-01 / 03，plan §7.1 的一手来源）。
 *
 * 19 家预设照搬 `browser-copilot/src/lib/providers.ts:71-271`（用户本人的项目，不存在 §8.7 的许可问题），
 * `id` / `baseUrl` / `defaultModel` / `docsUrl` 与端点变体逐条对得上——7.2-01 就是按这张对照表验收的。
 * 与来源不同的三处形状决定写在 `LlmProviderView` 的注释里（不声明腿、不带显示名、不带厂商说明）。
 *
 * 一条来自来源实现的教训随迁：那边的模型清单只当输入候选、不入库（`llm.ts:545-547` 注释），
 * 本项目按 2026-10-07 的裁定④改成"勾选入库"，所以这份目录只负责"怎么把地址填上"，
 * 不再承担任何"这一家有哪些模型"的事实——那是 7.2-b/05 之后的 `llm_models` 表。
 */
import type { LlmProviderView } from '@auto-cc/shared';

/** 目录全文：顺序即界面上的下拉顺序，`custom` 固定在末尾之前不参与排序优化。 */
export const PROVIDER_PRESETS: LlmProviderView[] = [
  {
    id: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-code',
    docsUrl: 'https://console.volcengine.com/ark',
    endpoints: [
      { id: 'ark-standard', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
      { id: 'ark-coding-plan', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3' },
    ],
  },
  {
    id: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-chat',
    docsUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2-0905-preview',
    docsUrl: 'https://platform.moonshot.cn/console/api-keys',
    endpoints: [
      { id: 'moonshot-standard', baseUrl: 'https://api.moonshot.cn/v1' },
      { id: 'moonshot-coding-plan', baseUrl: 'https://api.kimi.com/coding/v1' },
    ],
  },
  {
    id: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    docsUrl: 'https://bailian.console.aliyun.com/',
    endpoints: [
      { id: 'dashscope-standard', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { id: 'dashscope-coding-plan', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1' },
    ],
  },
  {
    id: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    docsUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen3:8b',
    docsUrl: 'https://ollama.com/',
  },
  {
    id: 'lmstudio',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
  },
  {
    id: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    docsUrl: 'https://open.bigmodel.cn/',
    endpoints: [
      { id: 'zhipu-standard', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
      { id: 'zhipu-coding-plan', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
      { id: 'zhipu-global-coding-plan', baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
    ],
  },
  {
    id: 'minimax',
    baseUrl: 'https://api.minimaxi.com/v1',
    defaultModel: 'MiniMax-Text-01',
    docsUrl: 'https://platform.minimaxi.com/',
    endpoints: [
      { id: 'minimax-cn', baseUrl: 'https://api.minimaxi.com/v1' },
      { id: 'minimax-global', baseUrl: 'https://api.minimax.io/v1' },
    ],
  },
  {
    id: 'stepfun',
    baseUrl: 'https://api.stepfun.com/v1',
    defaultModel: 'step-2-mini',
    docsUrl: 'https://platform.stepfun.com/',
  },
  {
    id: 'qianfan',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    defaultModel: 'ernie-4.0-turbo-8k',
    docsUrl: 'https://console.bce.baidu.com/qianfan/',
  },
  {
    id: 'githubmodels',
    baseUrl: 'https://models.github.ai/inference',
    defaultModel: 'gpt-4.1',
    docsUrl: 'https://github.com/marketplace/models',
  },
  {
    id: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    docsUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    docsUrl: 'https://www.mistral.ai/',
  },
  {
    id: 'xai',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-2-latest',
    docsUrl: 'https://console.x.ai/',
  },
  {
    id: 'nvidia',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'meta/llama-3.1-8b-instruct',
    docsUrl: 'https://integrate.api.nvidia.com/',
  },
  {
    id: 'custom',
    baseUrl: '',
    defaultModel: '',
  },
];

/** 目录里按 id 找不到时的回落项：任何 OpenAI 兼容地址都走这一条（spec 7.1-09 的同一条代码路径）。 */
const CUSTOM_PRESET = PROVIDER_PRESETS.find((item) => item.id === 'custom')!;

/**
 * 按 id 取一条预设。
 * @param id 提供商 id；可能来自上一次保存，此后目录里已经没有了
 * @returns 命中的预设；不命中一律回 `custom`（不抛，界面上那三个格子照常可编辑）
 */
export function presetOf(id: string): LlmProviderView {
  return PROVIDER_PRESETS.find((item) => item.id === id) ?? CUSTOM_PRESET;
}

/**
 * 这个地址是不是这家预设的（首条端点或任一变体）。
 *
 * 预设现在一条 `baseUrl` 之外还可能挂几条端点变体（方舟标准 / Coding Plan、智谱三条、MiniMax 双区域），
 * 所以"界面上显示的这一家"必须按变体也对得上，否则用户选了 Coding Plan，界面会指回标准端点那一家。
 * @param preset 目录里的一条预设
 * @param baseUrl 归一后的地址（`normalizeBaseUrl` 的输出）
 * @returns 命中时给该端点的 id；预设没写变体时给预设自身的 id；不命中回 undefined。
 *   空地址永不命中——`custom` 的首条本来就是空串，地址完全由人敲。
 */
export function endpointOf(preset: LlmProviderView, baseUrl: string): string | undefined {
  if (baseUrl === '') return undefined;
  if (preset.baseUrl === baseUrl) return preset.endpoints?.[0]?.id ?? preset.id;
  return preset.endpoints?.find((item) => item.baseUrl === baseUrl)?.id;
}

/**
 * 这个地址是目录里哪家的（spec 7.2-12 的显示半边）。
 *
 * 用在"这条腿没绑实例、走的是 yml/env 兜底地址"那一种读数上：界面要能说出"这看着像 DeepSeek"，
 * 而不是让人对着一条裸地址自己认亲。逐条比（含端点变体，同 `endpointOf` 的口径），认不出回 `custom`——
 * 反查只是显示，不构成任何写入：写的那一次表态在池那一行里。
 * @param baseUrl 归一后的地址（`normalizeBaseUrl` 的输出；空串表示根本没配）
 * @returns 目录里的预设 id；不命中是 `custom`
 */
export function presetIdOfBaseUrl(baseUrl: string): string {
  for (const preset of PROVIDER_PRESETS) {
    if (endpointOf(preset, baseUrl)) return preset.id;
  }
  return CUSTOM_PRESET.id;
}

/**
 * 把用户敲的地址收成"前缀"：请求路径由 `joinEndpoint` 再拼，所以入库的必须是不带尾斜杠的前缀。
 *
 * 收的四种形状（spec 7.2-03）：带尾斜杠、不带、把整条 `/chat/completions` 或 `/embeddings` 粘进来、前后带空格。
 * 不校验协议：`ollama` / `lmstudio` 的本地端点就是 `http`，强行要求 https 会把两家本地服务挡在门外。
 * @param raw 用户敲的原文
 * @returns 去掉首尾空白、尾斜杠与误粘的动作路径后的前缀；空输入回空串
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/(chat\/completions|embeddings)$/i, '');
}
