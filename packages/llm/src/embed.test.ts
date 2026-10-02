/**
 * `llm.embed` 的行为测试（spec 4.3-08 的 U 半边 / 4.3-07 的前提：向量增强必须是**可关**的）。
 *
 * 三条重点：
 * ① 未配置时 `status()` 报 unavailable 且 `embed()` 一次网络都不发——4.3-04 的「断网、无 key 也能检索」
 *    全靠这条，若它其实把请求发出去再失败，降级路径就等于没测；
 * ② 响应必须按 `index` 归位、条数与输入严格对齐——错配一条向量，检索就会「相关但说不清」；
 * ③ 维度不齐与信封异形（硅基流动的顶层 `{code,data,message}`）都变成结构化错误，绝不产出伪向量。
 * 网络一律用存根，不打真实向量网关（AGENTS.md §7.2）。
 */
import { asApp, Context } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyText, json, stubFetch } from './fetch-stub.js';
import type { LlmEmbedConfig } from './index.js';
import { LlmEmbedService } from './index.js';

const KEY_ENV = 'AUTO_CC_LLM_EMBED_TEST_KEY';
const BASE_URL = 'https://embed.test.invalid/v1';
const ENDPOINT = 'https://embed.test.invalid/v1/embeddings';

/** 完整可用配置（带 `.default()` 的键在直接调用点必须显式给出，见 AGENTS.md §9）。 */
const CONFIG: LlmEmbedConfig = {
  baseUrl: BASE_URL,
  model: 'BAAI/bge-m3',
  keyEnv: KEY_ENV,
  dimensions: null,
  batchSize: 16,
  timeoutMs: 15000,
};

afterEach(() => {
  delete process.env[KEY_ENV];
  vi.restoreAllMocks();
});

/**
 * 起一个只装 `llm.embed` 的最小内核。
 * @param config 覆盖默认配置的字段（用来造「缺 baseUrl」「缺 key」「小批量」这些路径）
 * @param key 放进环境变量假 key；传空串模拟未配置
 * @returns `embed` 服务实例
 */
async function boot(config: Partial<LlmEmbedConfig> = {}, key = 'sk-embed-test'): Promise<{ embed: LlmEmbedService }> {
  if (key) process.env[KEY_ENV] = key;
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  await ctx.plugin(LlmEmbedService, { ...CONFIG, ...config });
  return { embed: asApp(ctx)['llm.embed'] };
}

/**
 * 造一条 OpenAI 兼容的单条响应项。
 * @param index 对端回报的下标（测试用它验证乱序归位）
 * @param values 向量值
 * @returns `data` 数组里的一项
 */
const item = (index: number, values: number[]) => ({ index, object: 'embedding', embedding: values });

describe('llm.embed 的可用性判定（spec 4.3-08：降级必须是可测的）', () => {
  it('配置齐全：status 报可用，端点由前缀拼出复数 embeddings', async () => {
    const { embed } = await boot();
    expect(embed.status()).toEqual({
      available: true,
      missing: [],
      model: 'BAAI/bge-m3',
      endpoint: ENDPOINT,
      dimensions: null,
    });
  });

  it('缺 baseUrl / 缺 model / 缺 key 时逐项报出 missing', async () => {
    const { embed } = await boot({ baseUrl: null, model: null }, '');
    expect(embed.status().available).toBe(false);
    expect(embed.status().missing).toEqual(['baseUrl', 'model', 'apiKey']);
    expect(embed.status().endpoint).toBeNull();
  });

  it('未配置时 embed() 以 LLM_UNAVAILABLE 失败且一次网络都不发（判据：降级不是假的）', async () => {
    const fixture = stubFetch(() => Promise.reject(new Error('不该被调用')));
    try {
      const { embed } = await boot({ baseUrl: null, model: null }, '');
      await expect(embed.embed(['一段简历文本'])).rejects.toMatchObject({
        code: 'LLM_UNAVAILABLE',
        details: { missing: ['baseUrl', 'model', 'apiKey'], keyEnv: KEY_ENV },
      });
      expect(fixture.requests).toHaveLength(0);
    } finally {
      fixture.restore();
    }
  });

  it('空输入不发请求，回空向量列表且维度为 null', async () => {
    const fixture = stubFetch(() => Promise.reject(new Error('不该被调用')));
    try {
      const { embed } = await boot();
      expect(await embed.embed([])).toEqual({ model: 'BAAI/bge-m3', dim: null, vectors: [] });
      expect(fixture.requests).toHaveLength(0);
    } finally {
      fixture.restore();
    }
  });
});

describe('llm.embed 的请求形态与响应归位（plan §4.3-d 实测契约）', () => {
  it('发一次 POST：Bearer 头 + {model,input}，且不认识 dimensions 时对端收不到该字段', async () => {
    const fixture = stubFetch(() =>
      Promise.resolve(json({ model: 'BAAI/bge-m3', data: [item(0, [0.1, 0.2, 0.3])], usage: { total_tokens: 7 } })),
    );
    try {
      const { embed } = await boot();
      expect(await embed.embed(['第一段'])).toEqual({ model: 'BAAI/bge-m3', dim: 3, vectors: [[0.1, 0.2, 0.3]] });
      const [request] = fixture.requests;
      expect(request?.url).toBe(ENDPOINT);
      expect((request?.init.headers as Record<string, string>).authorization).toBe('Bearer sk-embed-test');
      expect(JSON.parse(bodyText(request?.init ?? {}))).toEqual({ model: 'BAAI/bge-m3', input: ['第一段'] });
    } finally {
      fixture.restore();
    }
  });

  it('配置了 dimensions 才带该字段（默认用模型维度，代码里不写 1024）', async () => {
    const fixture = stubFetch(() => Promise.resolve(json({ data: [item(0, [0.5])] })));
    try {
      const { embed } = await boot({ dimensions: 512 });
      await expect(embed.embed(['第一段'])).resolves.toMatchObject({ model: 'BAAI/bge-m3', dim: 1 });
      expect(JSON.parse(bodyText(fixture.requests[0]?.init ?? {}))).toEqual({
        model: 'BAAI/bge-m3',
        input: ['第一段'],
        dimensions: 512,
      });
    } finally {
      fixture.restore();
    }
  });

  it('对端乱序返回时按 index 归位，而不是照抄数组顺序', async () => {
    const fixture = stubFetch(() => Promise.resolve(json({ data: [item(1, [2, 2]), item(0, [1, 1])] })));
    try {
      const { embed } = await boot();
      const result = await embed.embed(['甲', '乙']);
      expect(result.vectors).toEqual([
        [1, 1],
        [2, 2],
      ]);
      // 对端没回报 model 时回落到配置值，向量表仍有一个稳定的失效判据。
      expect(result).toMatchObject({ model: 'BAAI/bge-m3', dim: 2 });
    } finally {
      fixture.restore();
    }
  });

  it('按 batchSize 串行切批，向量与入参同序拼回', async () => {
    let call = 0;
    const fixture = stubFetch(() => {
      // 每批回两条，值等于「本批序号 × 10 + 批内下标」，用来验证跨批拼接顺序；
      // 五条输入配 batchSize 2 会得到 2 / 2 / 1 三批，所以最后一批只回一条。
      const batch = call++;
      const size = batch === 2 ? 1 : 2;
      return Promise.resolve(
        json({ data: Array.from({ length: size }, (_, position) => item(position, [batch * 10 + position])) }),
      );
    });
    try {
      const { embed } = await boot({ batchSize: 2 });
      const result = await embed.embed(['a', 'b', 'c', 'd', 'e']);
      expect(fixture.requests).toHaveLength(3);
      expect(result.vectors).toEqual([[0], [1], [10], [11], [20]]);
      // 第三批只有一条输入，所以最后一次请求的 input 只剩 'e'。
      expect(JSON.parse(bodyText(fixture.requests[2]?.init ?? {}))).toMatchObject({ input: ['e'] });
    } finally {
      fixture.restore();
    }
  });

  it('对端回报的 model 名优先于配置值（换模型是换配置，不是换响应）', async () => {
    const fixture = stubFetch(() => Promise.resolve(json({ model: 'BAAI/bge-m3-awq', data: [item(0, [0])] })));
    try {
      const { embed } = await boot();
      await expect(embed.embed(['甲'])).resolves.toMatchObject({ model: 'BAAI/bge-m3-awq' });
    } finally {
      fixture.restore();
    }
  });
});

describe('llm.embed 的失败形态（4.3-08：绝不产生伪向量）', () => {
  it('响应条数与输入不符：bad_shape 失败，不把缺的那条错配到别的切片上', async () => {
    const fixture = stubFetch(() => Promise.resolve(json({ data: [item(0, [1, 2])] })));
    try {
      const { embed } = await boot();
      await expect(embed.embed(['甲', '乙'])).rejects.toMatchObject({
        code: 'LLM_REQUEST_FAILED',
        message: expect.stringContaining('应 2 条'),
        details: { endpoint: ENDPOINT, reason: 'bad_shape' },
      });
      expect(fixture.requests).toHaveLength(1);
    } finally {
      fixture.restore();
    }
  });

  it('某条不是数字数组：bad_shape 失败（NaN 混进余弦会得到没有意义的数）', async () => {
    const fixture = stubFetch(() =>
      Promise.resolve(json({ data: [item(0, [1, 2]), { index: 1, embedding: ['2', '3'] }] })),
    );
    try {
      const { embed } = await boot();
      await expect(embed.embed(['甲', '乙'])).rejects.toMatchObject({
        code: 'LLM_REQUEST_FAILED',
        details: { reason: 'bad_shape' },
      });
    } finally {
      fixture.restore();
    }
  });

  it('跨批维度不一致：整次调用失败，不返回一半 1024 一半别的长度', async () => {
    let call = 0;
    const fixture = stubFetch(() => Promise.resolve(json({ data: [item(0, call++ === 0 ? [1, 2] : [1])] })));
    try {
      const { embed } = await boot({ batchSize: 1 });
      await expect(embed.embed(['甲', '乙'])).rejects.toMatchObject({
        code: 'LLM_REQUEST_FAILED',
        message: expect.stringContaining('维度不一致'),
      });
    } finally {
      fixture.restore();
    }
  });

  it('硅基流动的错误信封（顶层 {code,data,message}）读成一句人话，不塞整段 JSON', async () => {
    const fixture = stubFetch(() =>
      Promise.resolve(json({ code: 30014, data: null, message: 'Token is invalid.' }, 401)),
    );
    try {
      const { embed } = await boot();
      await expect(embed.embed(['甲'])).rejects.toMatchObject({
        code: 'LLM_REQUEST_FAILED',
        message: '对端返回 401：Token is invalid.',
        details: { endpoint: ENDPOINT, status: 401 },
      });
      expect(fixture.requests).toHaveLength(1);
    } finally {
      fixture.restore();
    }
  });

  it('超时：文案说的是「向量请求」，reason=timeout', async () => {
    const fixture = stubFetch(() => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      return Promise.reject(error);
    });
    try {
      const { embed } = await boot({ timeoutMs: 1000 });
      await expect(embed.embed(['甲'])).rejects.toMatchObject({
        code: 'LLM_REQUEST_FAILED',
        message: expect.stringContaining('向量请求超时（1000ms）'),
        details: { reason: 'timeout' },
      });
    } finally {
      fixture.restore();
    }
  });

  it('连不上：reason=network，且不泄漏 key', async () => {
    const fixture = stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    try {
      const { embed } = await boot();
      const failure = await embed.embed(['甲']).then(
        () => null,
        (error: unknown) => error as { code: string; message: string; details: unknown },
      );
      expect(failure).toMatchObject({
        code: 'LLM_REQUEST_FAILED',
        message: expect.stringContaining('fetch failed'),
        details: { reason: 'network' },
      });
      // key 只出现在请求头里，错误文案与详情都不能带上它（§8.6）。
      expect(`${String(failure?.message)}${JSON.stringify(failure?.details)}`).not.toContain('sk-embed-test');
      expect(fixture.requests).toHaveLength(1);
    } finally {
      fixture.restore();
    }
  });

  it('2xx 但响应不是 JSON：reason=bad_json，与「没拿到」区分开', async () => {
    const fixture = stubFetch(() => Promise.resolve(new Response('<html>gateway</html>', { status: 200 })));
    try {
      const { embed } = await boot();
      await expect(embed.embed(['甲'])).rejects.toMatchObject({
        code: 'LLM_REQUEST_FAILED',
        details: { endpoint: ENDPOINT, reason: 'bad_json' },
      });
      expect(fixture.requests).toHaveLength(1);
    } finally {
      fixture.restore();
    }
  });
});
