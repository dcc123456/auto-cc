/**
 * 「严格端点」的活体契约（2026-11-25 用户裁定：温度、最大 token、请求头、思考强度都要能自定义）。
 *
 * 为什么用真的本地 HTTP 服务而不是 stub fetch：这一片要验的正是**请求体里某个键到底出没出现**、
 * 以及**自定义头有没有到位**——stub 只会把我们自己的构造再回放一遍，验不出「对端会不会 400」。
 * 所以这里起一个真服务，行为写死成最挑剔的那种端点：
 * - 必须带自定义头 `x-custom-token: shh`，否则 401；
 * - `temperature` 只接受 1，出现别的值就 400（并回 `x-request-id`，验错误透出）；
 * - `reasoning_effort` 不接受 `low`；
 * - `max_tokens` 上限 9000。
 *
 * 六种组合各一条用例，另加两条：保存不许因为探测失败而失败、`authorization` 不许自定义。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { asApp, Context, NO_CONFIG } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { LlmChatService } from './index.js';
import { LlmSettingsService } from './settings.js';

const KEY_ENV = 'AUTO_CC_LLM_STRICT_KEY';
/** 自定义头里那枚值：中文注释说明它是密钥级数据，测试里也别写进注释把纪律说反。 */
const CUSTOM_TOKEN = 'shh';
/** 对端回的 request id：错误文案里必须原样带上（排障时唯一能对上厂商日志的东西）。 */
const REQUEST_ID = 'req-strict-20261125';

const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放时允许残渣留在系统 temp（与既有用例同一处置）。
    }
  }
});

/** 一条被 mock 端点收到的请求（body 已解析）。 */
type SeenRequest = { body: Record<string, unknown>; headers: Record<string, string> };

/**
 * 起一个「严格端点」。
 * @returns 服务、它的 baseUrl 与收到的请求清单
 */
async function startStrictEndpoint(): Promise<{ server: Server; baseUrl: string; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = '';
    request.on('data', (chunk: string) => {
      raw += chunk;
    });
    request.on('end', () => {
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      seen.push({ body, headers: request.headers as Record<string, string> });
      const reply = (status: number, payload: unknown, replyHeaders: Record<string, string> = {}): void => {
        response.writeHead(status, { 'content-type': 'application/json', ...replyHeaders });
        response.end(JSON.stringify(payload));
      };
      if (request.headers['x-custom-token'] !== CUSTOM_TOKEN) {
        reply(401, { error: { message: 'missing custom header' } });
        return;
      }
      if (body.temperature !== undefined && body.temperature !== 1) {
        reply(
          400,
          { error: { message: 'temperature only 1 is allowed for this model' } },
          { 'x-request-id': REQUEST_ID },
        );
        return;
      }
      if (body.reasoning_effort === 'low') {
        reply(400, { error: { message: 'reasoning_effort low is not supported' } }, { 'x-request-id': REQUEST_ID });
        return;
      }
      if (typeof body.max_tokens === 'number' && body.max_tokens > 9000) {
        reply(400, { error: { message: 'max_tokens too large' } }, { 'x-request-id': REQUEST_ID });
        return;
      }
      reply(200, { choices: [{ message: { content: '好' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('mock 端点没起来');
  return { server, baseUrl: `http://127.0.0.1:${String(address.port)}/v1`, seen };
}

/**
 * 装一套最小内核，并让 `llm.chat` **绑定**到池里那个实例。
 *
 * 顺序刻意是「先存实例、再挂 chat」：测试里没有 `kernel` 服务，`bindRole` 的热改推不到已经挂载的服务
 * （真实装配里靠 kernel 应用配置）。直接以绑定态挂载，验的才是「绑定这一路真的把实例参数与头发出去」。
 * @param baseUrl 端点前缀
 * @param provider 实例入参里除 `baseUrl` 之外的字段
 * @returns 聊天服务、设置服务与保存后的实例 id
 */
async function bootBound(
  baseUrl: string,
  provider: {
    temperature?: number | null;
    maxTokens?: number | null;
    reasoningEffort?: 'low' | 'medium' | 'high' | null;
    headers?: { name: string; value: string }[];
  } = {},
): Promise<{ ctx: Context; chat: LlmChatService; settings: LlmSettingsService; providerId: string }> {
  process.env[KEY_ENV] = 'sk-strict-abcdef';
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-llm-strict-'));
  sandboxes.push(dir);
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' });
  await ctx.plugin(LlmSettingsService, NO_CONFIG);
  const settings = asApp(ctx)['llm.settings'];
  const saved = settings.saveProvider({
    presetId: 'custom',
    label: '严格端点',
    baseUrl,
    apiKey: 'sk-strict-abcdef',
    ...provider,
  });
  await ctx.plugin(LlmChatService, {
    providerId: saved.id,
    baseUrl: null,
    model: 'strict-model',
    keyEnv: KEY_ENV,
    timeoutMs: 8000,
    maxTokens: null,
    temperature: null,
    reasoningEffort: null,
  });
  return { ctx, chat: asApp(ctx)['llm.chat'], settings, providerId: saved.id };
}

afterEach(() => {
  delete process.env[KEY_ENV];
});

describe('严格端点：参数只在**显式配置**时出现在请求体里', () => {
  it('什么都没配：body 里没有 temperature / max_tokens / reasoning_effort，一次 200', async () => {
    const endpoint = await startStrictEndpoint();
    try {
      // 通道配置与实例都不配这三格 → 一个都不能发（真站点只接受 temperature=1 的那类端点就是这么过的）。
      const { chat } = await bootBound(endpoint.baseUrl, {
        headers: [{ name: 'x-custom-token', value: CUSTOM_TOKEN }],
      });
      await chat.complete({ messages: [{ role: 'user', content: '你好' }] });
      const body = endpoint.seen[0]?.body ?? {};
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('max_tokens');
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(endpoint.seen[0]?.headers['x-custom-token']).toBe(CUSTOM_TOKEN);
    } finally {
      endpoint.server.close();
    }
  });

  it('显式配 temperature=1 才发：body 里出现 1，200', async () => {
    const endpoint = await startStrictEndpoint();
    try {
      const { chat } = await bootBound(endpoint.baseUrl, {
        headers: [{ name: 'x-custom-token', value: CUSTOM_TOKEN }],
        temperature: 1,
      });
      await chat.complete({ messages: [{ role: 'user', content: '你好' }] });
      expect(endpoint.seen[0]?.body.temperature).toBe(1);
    } finally {
      endpoint.server.close();
    }
  });

  it('配成 0.7 撞上严格端点：400 且错误里带 request id 与「把温度设成不发送」的提示', async () => {
    const endpoint = await startStrictEndpoint();
    try {
      const { chat } = await bootBound(endpoint.baseUrl, {
        headers: [{ name: 'x-custom-token', value: CUSTOM_TOKEN }],
        temperature: 0.7,
      });
      await expect(chat.complete({ messages: [{ role: 'user', content: '你好' }] })).rejects.toMatchObject({
        code: 'LLM_REQUEST_FAILED',
        details: { status: 400, requestId: REQUEST_ID },
      });
      const error = (await chat
        .complete({ messages: [{ role: 'user', content: '你好' }] })
        .catch((reason: unknown) => reason)) as Error;
      expect(error.message).toContain('temperature only 1 is allowed');
      expect(error.message).toContain(REQUEST_ID);
      expect(error.message).toContain('temper');
      expect(error.message).toContain('不发送');
    } finally {
      endpoint.server.close();
    }
  });

  it('思考强度按配置出现：high 进 body 且 200', async () => {
    const endpoint = await startStrictEndpoint();
    try {
      const { chat } = await bootBound(endpoint.baseUrl, {
        headers: [{ name: 'x-custom-token', value: CUSTOM_TOKEN }],
        reasoningEffort: 'high',
      });
      await chat.complete({ messages: [{ role: 'user', content: '你好' }] });
      expect(endpoint.seen[0]?.body.reasoning_effort).toBe('high');
    } finally {
      endpoint.server.close();
    }
  });

  it('端点不认 low：400 且提示指向「思考强度」', async () => {
    const endpoint = await startStrictEndpoint();
    try {
      const { chat } = await bootBound(endpoint.baseUrl, {
        headers: [{ name: 'x-custom-token', value: CUSTOM_TOKEN }],
        reasoningEffort: 'low',
      });
      const error = (await chat
        .complete({ messages: [{ role: 'user', content: '你好' }] })
        .catch((reason: unknown) => reason)) as Error;
      expect(error.message).toContain('reasoning_effort low is not supported');
      expect(error.message).toContain('思考强度');
    } finally {
      endpoint.server.close();
    }
  });

  it('最大 token 与界面同值：配 900 就发 900', async () => {
    const endpoint = await startStrictEndpoint();
    try {
      const { chat } = await bootBound(endpoint.baseUrl, {
        maxTokens: 900,
        headers: [{ name: 'x-custom-token', value: CUSTOM_TOKEN }],
      });
      await chat.complete({ messages: [{ role: 'user', content: '你好' }] });
      expect(endpoint.seen[0]?.body.max_tokens).toBe(900);
    } finally {
      endpoint.server.close();
    }
  });

  it('超过端点容忍的上限：400 且提示指向「最大 token」', async () => {
    const endpoint = await startStrictEndpoint();
    try {
      const { chat } = await bootBound(endpoint.baseUrl, {
        maxTokens: 12000,
        headers: [{ name: 'x-custom-token', value: CUSTOM_TOKEN }],
      });
      const error = (await chat
        .complete({ messages: [{ role: 'user', content: '你好' }] })
        .catch((reason: unknown) => reason)) as Error;
      expect(error.message).toContain('max_tokens too large');
      expect(error.message).toContain('最大 token');
    } finally {
      endpoint.server.close();
    }
  });
});

describe('request id 的两种放法与真实对话口吃实例值', () => {
  it('对端把 request_id 放在**响应体**里也能透出（不只认响应头）', async () => {
    // 一个只在 body 里带 id 的端点：不少网关就是这么给的（QA 的 mock 亦然）。
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      request.on('data', () => undefined);
      request.on('end', () => {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ request_id: 'mock-body-400', error: { message: 'temperature only 1 is allowed' } }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('mock 没起来');
    try {
      const { chat } = await bootBound(`http://127.0.0.1:${String(address.port)}/v1`, {
        temperature: 0.7,
        headers: [{ name: 'x-custom-token', value: CUSTOM_TOKEN }],
      });
      const error = (await chat
        .complete({ messages: [{ role: 'user', content: '你好' }] })
        .catch((reason: unknown) => reason)) as Error & { details?: { requestId?: string | null } };
      expect(error.details?.requestId).toBe('mock-body-400');
      expect(error.message).toContain('mock-body-400');
    } finally {
      server.close();
    }
  });

  it('真实对话口（无探测覆盖）按实例发 max_tokens / 思考强度，温度照旧缺席', async () => {
    const endpoint = await startStrictEndpoint();
    try {
      // 这条就是助手/简历生成走的那条 `llm.chat.complete`：没有探测目标，实例值说了算。
      const { chat } = await bootBound(endpoint.baseUrl, {
        maxTokens: 1234,
        reasoningEffort: 'high',
        headers: [{ name: 'x-custom-token', value: CUSTOM_TOKEN }],
      });
      await chat.complete({ messages: [{ role: 'user', content: '随便聊一句' }] });
      const body = endpoint.seen[0]?.body ?? {};
      expect(body.max_tokens).toBe(1234);
      expect(body).not.toHaveProperty('temperature');
      expect(body.reasoning_effort).toBe('high');
    } finally {
      endpoint.server.close();
    }
  });
});

describe('request id 取不到时的写法（QA 的 P3）', () => {
  it('两边都没有 id 时明确写「对端未给」，不省掉括号', async () => {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      request.on('data', () => undefined);
      request.on('end', () => {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'temperature only 1 is allowed' } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('mock 没起来');
    try {
      const { chat } = await bootBound(`http://127.0.0.1:${String(address.port)}/v1`, {
        temperature: 0.7,
        headers: [{ name: 'x-custom-token', value: CUSTOM_TOKEN }],
      });
      const error = (await chat
        .complete({ messages: [{ role: 'user', content: '你好' }] })
        .catch((reason: unknown) => reason)) as Error;
      expect(error.message).toContain('对端未给 request id');
    } finally {
      server.close();
    }
  });
});

describe('保存与测试分离、以及密钥级数据的边界', () => {
  it('端点根本连不通也能保存：保存不探测、只落库', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-cc-llm-saveoffline-'));
    sandboxes.push(dir);
    const ctx = new Context();
    await ctx.plugin(ConfigService, { appName: 'auto-cc' });
    await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' });
    await ctx.plugin(LlmChatService, {
      providerId: null,
      baseUrl: null,
      model: null,
      keyEnv: KEY_ENV,
      timeoutMs: 8000,
      maxTokens: null,
      temperature: null,
      reasoningEffort: null,
    });
    await ctx.plugin(LlmSettingsService, NO_CONFIG);
    const settings = asApp(ctx)['llm.settings'];
    const saved = settings.saveProvider({
      presetId: 'custom',
      label: '连不通也算加上',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-strict-abcdef',
    });
    expect(saved.baseUrl).toBe('http://127.0.0.1:9/v1');
    expect(settings.listProviders().map((row) => row.id)).toContain(saved.id);
  });

  it('自定义头不许顶掉 authorization；同名重复也拒', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-cc-llm-headers-'));
    sandboxes.push(dir);
    const ctx = new Context();
    await ctx.plugin(ConfigService, { appName: 'auto-cc' });
    await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' });
    await ctx.plugin(LlmChatService, {
      providerId: null,
      baseUrl: null,
      model: null,
      keyEnv: KEY_ENV,
      timeoutMs: 8000,
      maxTokens: null,
      temperature: null,
      reasoningEffort: null,
    });
    await ctx.plugin(LlmSettingsService, NO_CONFIG);
    const settings = asApp(ctx)['llm.settings'];
    expect(() =>
      settings.saveProvider({
        presetId: 'custom',
        label: '冲突',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-strict-abcdef',
        headers: [{ name: 'Authorization', value: 'Bearer sneaky' }],
      }),
    ).toThrow(/authorization/i);
    expect(() =>
      settings.saveProvider({
        presetId: 'custom',
        label: '重复',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-strict-abcdef',
        headers: [
          { name: 'x-a', value: '1' },
          { name: 'X-A', value: '2' },
        ],
      }),
    ).toThrow(/重复/);
  });

  it('落库后只回名字不回值', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-cc-llm-headernames-'));
    sandboxes.push(dir);
    const ctx = new Context();
    await ctx.plugin(ConfigService, { appName: 'auto-cc' });
    await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' });
    await ctx.plugin(LlmChatService, {
      providerId: null,
      baseUrl: null,
      model: null,
      keyEnv: KEY_ENV,
      timeoutMs: 8000,
      maxTokens: null,
      temperature: null,
      reasoningEffort: null,
    });
    await ctx.plugin(LlmSettingsService, NO_CONFIG);
    const settings = asApp(ctx)['llm.settings'];
    const saved = settings.saveProvider({
      presetId: 'custom',
      label: '带头的实例',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-strict-abcdef',
      headers: [{ name: 'x-custom-token', value: 'shh-value' }],
    });
    expect(saved.headerNames).toEqual(['x-custom-token']);
    expect(JSON.stringify(saved)).not.toContain('shh-value');
    expect(saved.temperature).toBeNull();
    expect(saved.maxTokens).toBeNull();
    expect(saved.reasoningEffort).toBeNull();
  });
});
