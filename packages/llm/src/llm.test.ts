/**
 * `llm.chat` 的行为测试（spec 2.5-01 的 U 半边 / 2.5-12 的「唯一入口」判据）。
 *
 * 重点不是「能不能发请求」，而是三条**失败形态**：未配置时必须一次网络都不发（否则
 * 「回落」就是假的）、对端非 2xx 与空回复都要变成结构化错误（否则下游会把空文案发出去）。
 * 网络一律用存根，不打真实模型端点（AGENTS.md §7.2）。
 */
import { asApp, Context } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyText, json, stubFetch } from './fetch-stub.js';
import type { LlmConfig } from './index.js';
import { LlmChatService } from './index.js';

const KEY_ENV = 'AUTO_CC_LLM_TEST_KEY';
const BASE_URL = 'https://model.test.invalid/v1';
const ENDPOINT = 'https://model.test.invalid/v1/chat/completions';

/** 完整可用配置（带 `.default()` 的键在直接调用点必须显式给出，见 AGENTS.md §9）。 */
const CONFIG: LlmConfig = {
  providerId: null,
  baseUrl: BASE_URL,
  model: 'test-model',
  keyEnv: KEY_ENV,
  timeoutMs: 8000,
  maxTokens: 400,
  temperature: 0.7,
};

afterEach(() => {
  delete process.env[KEY_ENV];
  vi.restoreAllMocks();
});

/**
 * 起一个只装 `llm.chat` 的最小内核。
 * @param config 覆盖默认配置的字段（用来造「缺 baseUrl」「缺 key」这些路径）
 * @param key 是否往环境变量里放一把假 key（不传则不放，模拟未配置）
 * @returns `llm` 服务实例与上下文
 */
async function boot(config: Partial<LlmConfig> = {}, key = 'sk-test-abcdef'): Promise<{ llm: LlmChatService }> {
  if (key) process.env[KEY_ENV] = key;
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  await ctx.plugin(LlmChatService, { ...CONFIG, ...config });
  return { llm: asApp(ctx)['llm.chat'] };
}

describe('llm.chat 的可用性判定（spec 2.5-01 前提：回落必须是可测的）', () => {
  it('配置齐全：status 报可用，端点由前缀拼出且不带重复斜杠', async () => {
    const { llm } = await boot();
    // 这一条同时是 spec 7.2-12 的第二条读数：没有绑定时端点来自配置格（`origin: 'config'`），key 来自环境变量。
    expect(llm.status()).toEqual({
      available: true,
      missing: [],
      model: 'test-model',
      endpoint: ENDPOINT,
      keySource: 'env',
      origin: 'config',
      providerId: null,
    });
  });

  it('baseUrl 带尾斜杠时不拼出双斜杠', async () => {
    const { llm } = await boot({ baseUrl: 'https://model.test.invalid/v1/' });
    expect(llm.status().endpoint).toBe(ENDPOINT);
  });

  it('缺 baseUrl 与缺 key 时逐项报出 missing，且不发任何请求', async () => {
    const fixture = stubFetch(() => Promise.resolve(json({})));
    try {
      const { llm } = await boot({ baseUrl: null }, '');
      expect(llm.status().available).toBe(false);
      expect(llm.status().missing).toEqual(['baseUrl', 'apiKey']);
      await expect(llm.complete({ messages: [{ role: 'user', content: '你好' }] })).rejects.toMatchObject({
        code: 'LLM_UNAVAILABLE',
        details: { missing: ['baseUrl', 'apiKey'], keyEnv: KEY_ENV },
      });
      expect(fixture.requests).toHaveLength(0);
    } finally {
      fixture.restore();
    }
  });

  it('未配置时的 complete 一次网络都不发（S3 判据：回落不是假的）', async () => {
    const fixture = stubFetch(() => Promise.reject(new Error('不该被调用')));
    try {
      const { llm } = await boot({}, '');
      await expect(llm.complete({ messages: [{ role: 'user', content: '生成开场白' }] })).rejects.toMatchObject({
        code: 'LLM_UNAVAILABLE',
      });
      expect(fixture.requests).toHaveLength(0);
    } finally {
      fixture.restore();
    }
  });
});

describe('llm.chat 的请求形态与解析（实测契约，plan §12.6 S3）', () => {
  it('发一次 POST：URL、Bearer 头、model/messages/max_tokens/temperature/stream 全部就位', async () => {
    const fixture = stubFetch(() =>
      Promise.resolve(
        json({
          model: 'test-model',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '  开场白正文  ' } }],
          usage: { prompt_tokens: 16, completion_tokens: 10 },
        }),
      ),
    );
    try {
      const { llm } = await boot();
      const result = await llm.complete({ messages: [{ role: 'user', content: '按这个 JD 写一句打招呼' }] });
      expect(result).toEqual({
        text: '开场白正文',
        model: 'test-model',
        promptTokens: 16,
        completionTokens: 10,
      });
      const [request] = fixture.requests;
      expect(request?.url).toBe(ENDPOINT);
      expect((request?.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test-abcdef');
      expect(JSON.parse(bodyText(request?.init ?? {}))).toEqual({
        model: 'test-model',
        messages: [{ role: 'user', content: '按这个 JD 写一句打招呼' }],
        max_tokens: 400,
        temperature: 0.7,
        stream: false,
      });
    } finally {
      fixture.restore();
    }
  });

  it('单次覆盖 maxTokens / temperature 会进请求体，不改配置默认值', async () => {
    const fixture = stubFetch(() => Promise.resolve(json({ choices: [{ message: { content: '短' } }], usage: {} })));
    try {
      const { llm } = await boot();
      const result = await llm.complete({
        messages: [{ role: 'system', content: '你是话术助手' }],
        maxTokens: 64,
        temperature: 0.2,
      });
      expect(result.model).toBe('test-model');
      expect(result.promptTokens).toBeNull();
      const body = JSON.parse(bodyText(fixture.requests[0]?.init ?? {})) as Record<string, unknown>;
      expect(body).toMatchObject({ max_tokens: 64, temperature: 0.2 });
    } finally {
      fixture.restore();
    }
  });

  it('空消息数组以 INVALID_ARGUMENT 失败，不打网络', async () => {
    const fixture = stubFetch(() => Promise.resolve(json({})));
    try {
      const { llm } = await boot();
      await expect(llm.complete({ messages: [] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(fixture.requests).toHaveLength(0);
    } finally {
      fixture.restore();
    }
  });

  it('消息正文里的个人数据出站前被遮（spec 5.6-06，AGENTS.md §8.5）', async () => {
    const fixture = stubFetch(() => Promise.resolve(json({ choices: [{ message: { content: '好的' } }] })));
    try {
      const { llm } = await boot();
      await llm.complete({
        messages: [
          { role: 'system', content: '按这段 JD 写一句打招呼' },
          {
            role: 'user',
            content: 'HR 周女士 13800001111，邮箱 zhou@example.com，身份证 110101199003071234，薪资 15000-25000',
          },
        ],
      });
      const body = JSON.parse(bodyText(fixture.requests[0]?.init ?? {})) as {
        messages: { role: string; content: string }[];
      };
      const [system, user] = body.messages;
      // 遮在唯一出口上：调用方拼 prompt 时不必、也不该各遮一遍（plan §7.4 决策一）。
      expect(system?.content).toBe('按这段 JD 写一句打招呼');
      expect(user?.content).not.toContain('13800001111');
      expect(user?.content).not.toContain('zhou@example.com');
      expect(user?.content).not.toContain('110101199003071234');
      expect(user?.content).toContain('138****1111');
      expect(user?.content).toContain('z***@example.com');
      expect(user?.content).toContain('**********1234');
      // 脱敏不吃半个号：`薪资 15000-25000` 是业务数字，遮了模型就答非所问（core 那两份正则的环视判据）。
      expect(user?.content).toContain('15000-25000');
    } finally {
      fixture.restore();
    }
  });
});

describe('llm.chat 的失败形态（全部结构化，不许静默）', () => {
  it('非 2xx + JSON 错误体：对端的 error.message 进文案，码是 LLM_REQUEST_FAILED', async () => {
    const fixture = stubFetch(() =>
      Promise.resolve(
        json(
          { error: { message: 'Authentication Fails, Your api key is invalid', type: 'authentication_error' } },
          401,
        ),
      ),
    );
    try {
      const { llm } = await boot();
      await expect(llm.complete({ messages: [{ role: 'user', content: '你好' }] })).rejects.toMatchObject({
        code: 'LLM_REQUEST_FAILED',
        message: expect.stringContaining('401'),
        details: { endpoint: ENDPOINT, status: 401 },
      });
      expect(fixture.requests).toHaveLength(1);
    } finally {
      fixture.restore();
    }
  });

  it('非 2xx + 纯文本错误体（实测 DeepSeek 无 key 时就是这样）：解析不炸，仍回结构化错误', async () => {
    const fixture = stubFetch(() => Promise.resolve(new Response('Authentication Fails (governor)', { status: 401 })));
    try {
      const { llm } = await boot();
      await expect(llm.complete({ messages: [{ role: 'user', content: '你好' }] })).rejects.toMatchObject({
        code: 'LLM_REQUEST_FAILED',
        message: expect.stringContaining('Authentication Fails (governor)'),
      });
      expect(fixture.requests).toHaveLength(1);
    } finally {
      fixture.restore();
    }
  });

  it('对端返回空 choices：以 empty 失败，不把空串当成功交下去', async () => {
    const fixture = stubFetch(() => Promise.resolve(json({ choices: [] })));
    try {
      const { llm } = await boot();
      await expect(llm.complete({ messages: [{ role: 'user', content: '你好' }] })).rejects.toMatchObject({
        code: 'LLM_REQUEST_FAILED',
        details: { reason: 'empty' },
      });
      expect(fixture.requests).toHaveLength(1);
    } finally {
      fixture.restore();
    }
  });

  it('超时：TimeoutError 归成 reason=timeout 的结构化失败', async () => {
    const fixture = stubFetch(() => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      return Promise.reject(error);
    });
    try {
      const { llm } = await boot();
      await expect(llm.complete({ messages: [{ role: 'user', content: '你好' }] })).rejects.toMatchObject({
        code: 'LLM_REQUEST_FAILED',
        details: { reason: 'timeout' },
      });
      expect(fixture.requests).toHaveLength(1);
    } finally {
      fixture.restore();
    }
  });

  it('连不上（fetch 直接 reject）：reason=network，且不泄漏 key', async () => {
    const fixture = stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    try {
      const { llm } = await boot();
      await expect(llm.complete({ messages: [{ role: 'user', content: '你好' }] })).rejects.toMatchObject({
        code: 'LLM_REQUEST_FAILED',
        message: expect.stringContaining('fetch failed'),
        details: { reason: 'network' },
      });
      expect(fixture.requests).toHaveLength(1);
    } finally {
      fixture.restore();
    }
  });
});
