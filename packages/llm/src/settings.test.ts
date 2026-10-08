/**
 * `llm.settings` 的行为测试（spec 7.1-07 ~ 7.1-10）。
 *
 * 三条重点：key 的**优先级**（密钥库盖过环境变量，且 `status()` 说得出来源）、
 * 保存这条路径**只写持久层 + 密钥库**（明文不许进 `settings.json`，也不许回给界面），
 * 以及连通性测试**复用 `llm.chat` 的出口**（配置模块不能长成第二个 LLM 客户端，AGENTS.md §2.7）。
 *
 * 装配替身只换 `kernel` 一只：`packages/llm` 不依赖 `packages/kernel`（层间边界），
 * 而"热改到底会不会让实例拿到新值"是 spec 1.5-06 在内核测试里已经兑现的判据，
 * 这里只需要断言**调用形态**（给哪一格、什么补丁）。网络一律走存根（AGENTS.md §7.2）。
 */
import { asApp, Context } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyText, json, stubFetch } from './fetch-stub.js';
import { LlmChatService } from './index.js';
import type { LlmSettingsView } from '@auto-cc/shared';
import { providerSecretPath, type LlmProviderInstanceView } from './provider-pool.js';
import { LlmSettingsService } from './settings.js';
import { endpointOf, normalizeBaseUrl, presetOf, PROVIDER_PRESETS } from './presets.js';

const CHAT_ENV = 'AUTO_CC_LLM_API_KEY';
const EMBED_ENV = 'AUTO_CC_SILICONFLOW_API_KEY';
const BASE_URL = 'https://model.test.invalid/v1';

/** 一次保存要覆盖到的格子；`baseUrl: null` 用来造"这一腿还没配"的形态。 */
interface BootOptions {
  /** 放进环境变量的兜底 key */
  envKey?: string;
  baseUrl?: string | null;
  model?: string | null;
  /** 复用上一次 boot 的 userData（"重启仍然算数"那类用例的入口，spec 7.2-02 的持久半边） */
  userData?: string;
  /** 把绑定直接写进 `llm.chat` 的配置格（spec 7.2-12 绑定态的入口：内核是替身，热改不会重建服务，只能第二次装载时给） */
  chatProviderId?: string | null;
}

/** 一条腿的读数（按腿取，避免各处写下标）。 */
const legOf = (view: LlmSettingsView, leg: 'chat' | 'embed') => view.legs.find((item) => item.leg === leg)!;

/** boot 出来的读法：设置服务、模型出口、配置服务、内核替身的调用记录、本次的 userData 目录。 */
interface Harness {
  settings: LlmSettingsService;
  llm: LlmChatService;
  config: ConfigService;
  store: StoreService;
  db: DatabaseSync;
  applied: Array<{ id: string; patch: Record<string, unknown> }>;
  userData: string;
}

/**
 * 起一个「config + store + llm.chat + llm.settings（+ 内核读法替身）」的最小装配。
 *
 * `store` 挂真身而不替身：7.2 的池与清单就住在它的连接里，"迁移号段、连带删除、跨重启"这三件事
 * 换成替身全都判不出来（口径同 `packages/resume-kb/src/profile-service.test.ts`）。
 * @param options 见 {@link BootOptions}
 * @returns 四只服务与调用记录
 */
async function boot(options: BootOptions = {}): Promise<Harness> {
  if (options.envKey) process.env[CHAT_ENV] = options.envKey;
  const userData = options.userData ?? mkdtempSync(join(tmpdir(), 'auto-cc-71b-'));
  const baseUrl = options.baseUrl === undefined ? BASE_URL : options.baseUrl;
  const model = options.model === undefined ? 'test-model' : options.model;
  const chatProviderId = options.chatProviderId ?? null;

  // 内核替身：只实现 `llm.settings` 会用到的三件事，且行为与真内核一致（补丁写进生效值）。
  const effective = new Map<string, Record<string, unknown>>([
    ['llm', { providerId: chatProviderId, baseUrl, model }],
    ['llm-embed', {}],
  ]);
  const applied: Harness['applied'] = [];
  const ctx = new Context();
  ctx.provide('kernel', {
    snapshot: () => [...effective.keys()].map((id) => ({ id })),
    effectiveConfig: (id: string) => ({ values: effective.get(id) ?? {} }),
    applyConfig: (id: string, patch: Record<string, unknown>) => {
      applied.push({ id, patch });
      effective.set(id, { ...effective.get(id), ...patch });
      return Promise.resolve({ id, state: 'active' as const });
    },
  });

  await ctx.plugin(ConfigService, {
    appName: 'auto-cc',
    paths: { userDataDir: userData, logDir: join(userData, 'logs') },
  });
  await ctx.plugin(StoreService, { dir: userData, file: 'store.db', journal: 'delete' });
  await ctx.plugin(LlmChatService, {
    providerId: chatProviderId,
    baseUrl,
    model,
    keyEnv: CHAT_ENV,
    timeoutMs: 8000,
    maxTokens: 400,
    temperature: 0.7,
  });
  await ctx.plugin(LlmSettingsService, { providerId: 'deepseek', embedProviderId: 'custom' });
  const app = asApp(ctx);
  return {
    settings: app['llm.settings'],
    llm: app['llm.chat'],
    config: app.config,
    store: app.store,
    db: app.store.db,
    applied,
    userData,
  };
}

afterEach(() => {
  delete process.env[CHAT_ENV];
  delete process.env[EMBED_ENV];
  vi.restoreAllMocks();
});

describe('服务商目录（spec 7.2-01：参考实现的全部 19 家）', () => {
  it('收录 19 家预设，`custom` 收口在末尾', () => {
    expect(PROVIDER_PRESETS.map((item) => item.id)).toEqual([
      'deepseek',
      'ark',
      'openai',
      'openrouter',
      'moonshot',
      'dashscope',
      'siliconflow',
      'ollama',
      'lmstudio',
      'zhipu',
      'minimax',
      'stepfun',
      'qianfan',
      'githubmodels',
      'groq',
      'mistral',
      'xai',
      'nvidia',
      'custom',
    ]);
    // 自定义项的端点必须为空：任何 OpenAI 兼容地址都走同一条路径，预设只是填格子的建议。
    expect(PROVIDER_PRESETS.at(-1)).toMatchObject({ id: 'custom', baseUrl: '', defaultModel: '' });
  });

  it('目录不再声明腿，也不再出现同一个地址的第二条条目（§2.5 / plan §7.2 裁定②）', () => {
    const seen = new Set<string>();
    for (const item of PROVIDER_PRESETS) {
      if (item.baseUrl === '') continue;
      expect(seen.has(item.baseUrl), `重复端点：${item.baseUrl}`).toBe(false);
      seen.add(item.baseUrl);
      // 端点变体的首条必须就是预设自身的地址，否则"选第一家"与"选标准端点"会指向两处。
      if (item.endpoints) expect(item.endpoints[0]?.baseUrl).toBe(item.baseUrl);
      // 从第二条起才是"另一个地址"，首条上面已经按同一条断言查过了。
      for (const endpoint of item.endpoints?.slice(1) ?? []) {
        expect(seen.has(endpoint.baseUrl), `重复端点：${endpoint.baseUrl}`).toBe(false);
        seen.add(endpoint.baseUrl);
      }
    }
    expect('legs' in PROVIDER_PRESETS[0]!).toBe(false);
  });
});

describe('地址归一与端点归属（spec 7.2-03）', () => {
  it('四种输入形状都收成同一个前缀', () => {
    // 主机名一律用 RFC 2606 保留名：归一与主机无关，而测试面不许出现真实域名（AGENTS.md §7.2 / spec 4.4-08）。
    expect(normalizeBaseUrl('https://gw.test.invalid/v1')).toBe('https://gw.test.invalid/v1');
    expect(normalizeBaseUrl('  https://gw.test.invalid/v1/  ')).toBe('https://gw.test.invalid/v1');
    expect(normalizeBaseUrl('https://gw.test.invalid/v1///')).toBe('https://gw.test.invalid/v1');
    // 把整条动作路径粘进来是真实误填：不剥掉就会被 joinEndpoint 再拼一次。
    expect(normalizeBaseUrl('https://gw.test.invalid/v1/chat/completions')).toBe('https://gw.test.invalid/v1');
    expect(normalizeBaseUrl('https://gw.test.invalid/v1/embeddings')).toBe('https://gw.test.invalid/v1');
    expect(normalizeBaseUrl('')).toBe('');
    // 本地端点（Ollama / LM Studio）就是 http，不许被"必须 https"挡在门外。
    expect(normalizeBaseUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1');
  });

  it('目录里写着的每个地址本身已经是归一后的前缀', () => {
    // 这一条判的是数据而不是函数：目录若混进带尾斜杠或整条动作路径的地址，界面上"选了哪家"就会读回 custom。
    for (const preset of PROVIDER_PRESETS) {
      expect(normalizeBaseUrl(preset.baseUrl), `${preset.id} 的地址不是前缀`).toBe(preset.baseUrl);
      for (const endpoint of preset.endpoints ?? []) {
        expect(normalizeBaseUrl(endpoint.baseUrl), `${endpoint.id} 的地址不是前缀`).toBe(endpoint.baseUrl);
      }
    }
  });

  it('端点变体也算"这一家"，认不出的一律回 custom', () => {
    // 地址从目录里现取，不在用例里重敲字面量：重敲一遍就是抄第二份事实，且会随目录漂掉（§2.5）。
    for (const preset of PROVIDER_PRESETS) {
      for (const endpoint of preset.endpoints ?? []) {
        expect(endpointOf(preset, endpoint.baseUrl), `${preset.id} 认不出自己的变体 ${endpoint.id}`).toBe(endpoint.id);
      }
    }
    // 首条端点没有单独变体条目时，用预设自身的 id 作答（界面上不许多出一格"标准"）。
    expect(endpointOf(presetOf('deepseek'), presetOf('deepseek').baseUrl)).toBe('deepseek');
    expect(endpointOf(presetOf('openai'), 'https://evil.test.invalid/v1')).toBeUndefined();
    // 认不出的提供商 id 回落 custom，而 custom 不冒充任何地址（它的 baseUrl 本来就是空串）。
    expect(presetOf('不存在的 id').id).toBe('custom');
    expect(endpointOf(presetOf('不存在的 id'), presetOf('deepseek').baseUrl)).toBeUndefined();
    expect(endpointOf(presetOf('custom'), '')).toBeUndefined();
  });
});

describe('read()：密钥来源与可用性读数（spec 7.1-07）', () => {
  it('两处都没有 key 时报 missing=apiKey、source=none（端点与模型名已生效）', async () => {
    const { settings } = await boot();
    const chat = legOf(settings.read(), 'chat');
    expect(chat).toMatchObject({ baseUrl: BASE_URL, model: 'test-model', available: false });
    expect(chat.key).toMatchObject({ present: false, tail: '', source: 'none', keyEnv: CHAT_ENV });
    expect(chat.missing).toEqual(['apiKey']);
  });

  it('只有环境变量时报 source=env，且 `llm.chat.status()` 给出同一结论', async () => {
    const { settings, llm } = await boot({ envKey: 'sk-env-9900' });
    expect(legOf(settings.read(), 'chat').key).toMatchObject({ source: 'env', tail: '9900' });
    expect(llm.status()).toMatchObject({ available: true, keySource: 'env' });
  });

  it('密钥库与环境变量同时存在时以密钥库为准，source=secret', async () => {
    const { settings, llm, config } = await boot({ envKey: 'sk-env-9900' });
    config.setSecret('llm.chat', 'sk-store-1234');
    expect(legOf(settings.read(), 'chat').key).toMatchObject({ source: 'secret', tail: '1234' });
    expect(llm.status().keySource).toBe('secret');
  });

  it('向量腿未配置时缺三项，且 keyEnv 报的是它自己那一个', async () => {
    const { settings } = await boot({ envKey: 'sk-env-9900' });
    const embed = legOf(settings.read(), 'embed');
    expect(embed.missing).toEqual(['baseUrl', 'model', 'apiKey']);
    expect(embed.key.keyEnv).toBe(EMBED_ENV);
  });
});

describe('apply()：写持久层 + 密钥库 + 热改运行时（spec 7.1-08 / 7.1-06）', () => {
  it('保存后端点生效、密钥只以掩码露面，明文不进 settings.json 也不进出参', async () => {
    const { settings, config, applied, userData } = await boot();
    const view = await settings.apply({
      leg: 'chat',
      providerId: 'deepseek',
      baseUrl: BASE_URL,
      model: 'test-model',
      apiKey: 'sk-plain-5678',
    });
    expect(legOf(view, 'chat').key).toMatchObject({ present: true, source: 'secret', tail: '5678' });
    expect(config.persisted('llm')).toEqual({ baseUrl: BASE_URL, model: 'test-model' });
    expect(applied).toEqual([{ id: 'llm', patch: { baseUrl: BASE_URL, model: 'test-model' } }]);
    expect(readFileSync(join(userData, 'settings.json'), 'utf8')).not.toContain('sk-plain-5678');
    expect(JSON.stringify(view)).not.toContain('sk-plain-5678');
  });

  it('apiKey 省略时不动已存的那把（掩码框的语义就是"不改"）', async () => {
    const { settings } = await boot();
    await settings.apply({ leg: 'chat', baseUrl: BASE_URL, model: 'm', apiKey: 'sk-a-aaaa' });
    const view = await settings.apply({ leg: 'chat', baseUrl: BASE_URL, model: 'm2' });
    expect(legOf(view, 'chat').key.tail).toBe('aaaa');
  });

  it('非法 baseUrl 以 INVALID_ARGUMENT 失败并点名路径，一次落盘与一次热改都没有', async () => {
    const { settings, config, applied, userData } = await boot();
    await expect(settings.apply({ leg: 'chat', baseUrl: 'not-a-url', model: 'm' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { issues: ['baseUrl'] },
    });
    expect(config.persisted('llm')).toEqual({});
    expect(applied).toHaveLength(0);
    // 校验必须早于任何写：半途落盘会让界面显示一个系统实际没在用的端点。
    expect(existsSync(join(userData, 'settings.json'))).toBe(false);
  });

  it('手改 baseUrl 让预设对不上时，读数改口为 custom（不指着一家没在用的）', async () => {
    const { settings, config } = await boot();
    const view = await settings.apply({
      leg: 'chat',
      providerId: 'deepseek',
      baseUrl: 'https://custom.test.invalid/v1',
      model: 'local-llama',
    });
    expect(legOf(view, 'chat')).toMatchObject({ baseUrl: 'https://custom.test.invalid/v1', providerId: 'custom' });
    // 持久层记的是"下拉里选的那家"，两者不一致由 read() 自愈——规则只有一处。
    expect(config.persisted('llm-settings')).toEqual({ providerId: 'deepseek' });
  });

  it('误粘整条动作路径时入库的是归一后的前缀（spec 7.2-03）', async () => {
    const { settings, config } = await boot();
    const view = await settings.apply({
      leg: 'chat',
      baseUrl: 'https://gw.test.invalid/v1/chat/completions',
      model: 'm',
    });
    expect(legOf(view, 'chat').baseUrl).toBe('https://gw.test.invalid/v1');
    expect(config.persisted('llm')).toEqual({ baseUrl: 'https://gw.test.invalid/v1', model: 'm' });
  });

  it('clearKey 只清密钥，端点与模型名留着', async () => {
    const { settings } = await boot();
    await settings.apply({ leg: 'chat', baseUrl: BASE_URL, model: 'm', apiKey: 'sk-x-abcd' });
    const view = settings.clearKey('chat');
    expect(legOf(view, 'chat').key).toMatchObject({ present: false, source: 'none' });
    expect(legOf(view, 'chat').baseUrl).toBe(BASE_URL);
  });
});

describe('check()：连通性测试复用模型出口（spec 7.1-10）', () => {
  it('成功时回 ok 与模型名，发的是 `llm.chat` 那一条请求、带的是密钥库里那把 key', async () => {
    const fixture = stubFetch(() =>
      Promise.resolve(json({ model: 'test-model', choices: [{ message: { content: 'pong' } }] })),
    );
    try {
      const { settings, config } = await boot({ envKey: 'sk-env-9900' });
      config.setSecret('llm.chat', 'sk-store-9999');
      const result = await settings.check('chat');
      expect(result).toMatchObject({ ok: true, model: 'test-model', reason: null });
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]?.url).toBe(`${BASE_URL}/chat/completions`);
      // 掩码末 4 位与实发的 Bearer 对得上，才算"界面上说的那把就是正在用的那把"。
      expect(fixture.requests[0]?.init.headers).toMatchObject({ authorization: 'Bearer sk-store-9999' });
      expect(JSON.parse(bodyText(fixture.requests[0]!.init))).toMatchObject({ max_tokens: 8 });
    } finally {
      fixture.restore();
    }
  });

  it('对端 401 时回结构化失败，不把抛错透给界面', async () => {
    const fixture = stubFetch(() => Promise.resolve(json({ error: { message: 'bad key' } }, 401)));
    try {
      const { settings } = await boot({ envKey: 'sk-env-9900' });
      expect(await settings.check('chat')).toMatchObject({ ok: false, reason: 'LLM_REQUEST_FAILED' });
    } finally {
      fixture.restore();
    }
  });

  it('未配置时一次请求都不发（回落必须是可测的）', async () => {
    const fixture = stubFetch(() => Promise.reject(new Error('不该被调用')));
    try {
      const { settings, config } = await boot({ baseUrl: null, model: null });
      config.setSecret('llm.chat', 'sk-store-9999');
      expect(await settings.check('chat')).toMatchObject({ ok: false, reason: 'LLM_UNAVAILABLE' });
      expect(fixture.requests).toHaveLength(0);
    } finally {
      fixture.restore();
    }
  });

  it('向量腿本轮明确回 CHECK_NOT_SUPPORTED，而不是假称可用', async () => {
    const { settings } = await boot({ envKey: 'sk-env-9900' });
    expect(await settings.check('embed')).toMatchObject({ ok: false, reason: 'CHECK_NOT_SUPPORTED' });
  });
});

describe('提供商实例池（spec 7.2-02 / 06 / 08 / 10 的存储半边）', () => {
  /** 取某家预设的一条端点变体地址：字面量重敲一遍就是抄第二份事实，且会随目录漂掉（§2.5）。 */
  const variantOf = (presetId: string, endpointId: string): string => {
    const found = presetOf(presetId).endpoints?.find((item) => item.id === endpointId);
    if (!found) throw new Error(`目录里没有这条端点变体：${endpointId}`);
    return found.baseUrl;
  };

  /** 取一次同步调用的抛错：本包的入参校验都在同步路径上，`rejects` 那套用不上。 */
  const errorOf = (call: () => unknown): { code?: string; details?: Record<string, unknown> } => {
    try {
      call();
      return { code: 'NO_THROW' };
    } catch (error) {
      return error as { code?: string; details?: Record<string, unknown> };
    }
  };

  it('同一家可以同时存在两条实例，id 不撞（方舟标准 + Coding Plan）', async () => {
    const { settings, db } = await boot();
    const standard = settings.saveProvider({
      presetId: 'ark',
      label: '方舟 · 标准',
      baseUrl: presetOf('ark').baseUrl,
    });
    const codingPlan = settings.saveProvider({
      presetId: 'ark',
      label: '方舟 · Coding Plan',
      baseUrl: variantOf('ark', 'ark-coding-plan'),
    });
    expect(standard.id).not.toBe(codingPlan.id);
    expect(settings.listProviders()).toHaveLength(2);
    // 变体不是一格独立的表态，而是从地址认出来的：选了 Coding Plan 就记它，界面不会再指回标准端点。
    expect(codingPlan).toMatchObject({ endpointId: 'ark-coding-plan', presetId: 'ark' });
    expect(standard.endpointId).toBe('ark-standard');
    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_providers').get()).toMatchObject({ n: 2 });
  });

  it('改一条实例是就地改：id 与添加时间不动，端点变体跟着新地址重认', async () => {
    const { settings, db } = await boot();
    const saved = settings.saveProvider({ presetId: 'ark', label: '方舟', baseUrl: variantOf('ark', 'ark-standard') });
    expect(settings.listProviders()).toHaveLength(1);
    const createdBefore = db.prepare('SELECT created_at FROM llm_providers WHERE id = ?').get(saved.id) as unknown as {
      created_at: number;
    };

    const edited = settings.saveProvider({
      id: saved.id,
      presetId: 'ark',
      label: '方舟 · 换成 Coding Plan',
      baseUrl: variantOf('ark', 'ark-coding-plan'),
    });
    // 同一家换端点不算新增：id 是密钥路径与外键的锚，换了 id 就等于把已勾的清单和那把 key 都丢了。
    expect(edited.id).toBe(saved.id);
    expect(settings.listProviders()).toHaveLength(1);
    expect(edited).toMatchObject({ label: '方舟 · 换成 Coding Plan', endpointId: 'ark-coding-plan' });
    const createdAfter = db.prepare('SELECT created_at FROM llm_providers WHERE id = ?').get(saved.id) as unknown as {
      created_at: number;
    };
    expect(createdAfter.created_at).toBe(createdBefore.created_at);
    // id 给了但池里没有：报"这一行没有"，而不是悄悄当新增插一条。
    expect(
      errorOf(() =>
        settings.saveProvider({
          id: '没有这个 id',
          presetId: 'ark',
          label: '方舟',
          baseUrl: variantOf('ark', 'ark-standard'),
        }),
      ),
    ).toMatchObject({ code: 'LLM_PROVIDER_NOT_FOUND' });
    expect(settings.listProviders()).toHaveLength(1);
  });

  it('明文 key 只进派生路径那一格：表文件与 settings.json 里都 grep 不到', async () => {
    const { settings, config, db, userData } = await boot();
    const saved = settings.saveProvider({
      presetId: 'deepseek',
      label: 'DeepSeek',
      baseUrl: 'https://gw.test.invalid/v1',
      apiKey: 'sk-pool-7777',
    });
    expect(saved).toMatchObject({ hasKey: true, keyTail: '7777' });
    expect(config.getSecret(providerSecretPath(saved.id))).toBe('sk-pool-7777');
    expect(JSON.stringify(saved)).not.toContain('sk-pool-7777');
    // 整个 userData 里除密钥库那一格以外都 grep 不到明文（表文件、settings.json、日志都在这一次扫描里）：
    // `llm_providers` 一个密钥字节都不该有（spec 7.2-10），而这一条判据必须写成"扫目录"而不是"读某个文件名"——
    // 只添加提供商而不保存设置时 `settings.json` 根本还没被创建，按固定文件名去读会得到 ENOENT。
    const filesWithPlaintext = readdirSync(userData)
      .filter((name) => name !== 'secrets.bin')
      .filter((name) => {
        try {
          return readFileSync(join(userData, name)).includes('sk-pool-7777');
        } catch {
          // 子目录（logs/）不是文件，读它会抛 EISDIR；这一条的判据范围是 userData 下的落盘文件。
          return false;
        }
      });
    expect(filesWithPlaintext).toEqual([]);
    expect(JSON.stringify(db.prepare('SELECT * FROM llm_providers WHERE id = ?').get(saved.id))).not.toContain(
      'sk-pool-7777',
    );
  });

  it('勾选入库：勾了的才落，重复勾同一条是幂等的', async () => {
    const { settings } = await boot();
    const saved = settings.saveProvider({
      presetId: 'deepseek',
      label: 'DeepSeek',
      baseUrl: 'https://gw.test.invalid/v1',
    });
    expect(settings.addModels({ providerId: saved.id, models: ['a-model', 'b-model'] })).toHaveLength(2);
    // 再拉一遍并全勾上（含一条新的）：已有的不重复、没勾的一条不落。
    const after = settings.addModels({ providerId: saved.id, models: ['a-model', 'b-model', 'c-model'] });
    expect(after.map((item) => item.model)).toEqual(['a-model', 'b-model', 'c-model']);
    expect(after.every((item) => item.origin === 'fetched')).toBe(true);
    expect(settings.addModels({ providerId: saved.id, models: ['a-model'] })).toHaveLength(3);
    expect(settings.listProviders()[0]?.modelCount).toBe(3);
  });

  it('手工敲的那条记 origin=manual，与自动获取的分得开', async () => {
    const { settings } = await boot();
    const saved = settings.saveProvider({ presetId: 'custom', label: '本地', baseUrl: 'http://localhost:11434/v1' });
    expect(settings.addModels({ providerId: saved.id, models: ['qwen3:8b'], origin: 'manual' })).toMatchObject([
      { model: 'qwen3:8b', origin: 'manual' },
    ]);
    expect(settings.removeModel(saved.id, 'qwen3:8b')).toEqual([]);
  });

  it('删实例是连带的：模型清单清零、密钥库那一把也清掉', async () => {
    const { settings, config, db } = await boot();
    const saved = settings.saveProvider({
      presetId: 'deepseek',
      label: 'DeepSeek',
      baseUrl: 'https://gw.test.invalid/v1',
      apiKey: 'sk-pool-7777',
    });
    settings.addModels({ providerId: saved.id, models: ['a-model'] });
    expect(await settings.deleteProvider(saved.id)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_models WHERE provider_id = ?').get(saved.id)).toMatchObject({
      n: 0,
    });
    expect(config.getSecret(providerSecretPath(saved.id))).toBe('');
    // 删不存在的 id 要说清，不能静默成功（界面上那行是刚被别人删掉的话，刷新一次就得报出来）。
    await expect(settings.deleteProvider('不存在的 id')).rejects.toMatchObject({ code: 'LLM_PROVIDER_NOT_FOUND' });
  });

  it('迁移落在 31 / 32，回滚到 30 两张表一起消失（spec 7.2-08）', async () => {
    const { store, db } = await boot();
    expect(store.migrations.map((item) => item.version)).toEqual([31, 32]);
    expect(store.migrationResult.applied).toEqual([31, 32]);
    const tableNames = (): string[] =>
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'llm_%' ORDER BY name").all() as {
          name: string;
        }[]
      ).map((item) => item.name);
    expect(tableNames()).toEqual(['llm_models', 'llm_providers']);
    expect(store.rollback(30).reverted).toEqual([32, 31]);
    expect(tableNames()).toEqual([]);
    // 倒回去之后再 `upgrade()` 必须能把两张表建回来（`down` 写歪了的迁移在这里就会露出来）。
    expect(store.upgrade().applied).toEqual([31, 32]);
    expect(tableNames()).toEqual(['llm_models', 'llm_providers']);
  });

  it('跨重启仍然算数：同一目录第二次装载，实例与清单都还在', async () => {
    const first = await boot();
    const saved = first.settings.saveProvider({
      presetId: 'ark',
      label: '方舟',
      baseUrl: variantOf('ark', 'ark-coding-plan'),
      apiKey: 'sk-pool-7777',
    });
    first.settings.addModels({ providerId: saved.id, models: ['doubao-seed-code'] });

    const again = await boot({ userData: first.userData });
    expect(again.settings.listProviders()).toMatchObject([
      {
        id: saved.id,
        presetId: 'ark',
        label: '方舟',
        endpointId: 'ark-coding-plan',
        hasKey: true,
        keyTail: '7777',
        modelCount: 1,
      },
    ]);
    expect(again.settings.listModels(saved.id)).toMatchObject([{ model: 'doubao-seed-code', origin: 'fetched' }]);
  });

  it('入参不合法以 INVALID_ARGUMENT 失败，池里什么都没多出来', async () => {
    const { settings, db } = await boot();
    expect(
      errorOf(() => settings.saveProvider({ presetId: 'ark', label: '', baseUrl: 'https://gw.test.invalid/v1' })),
    ).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { issues: ['label'] },
    });
    expect(
      errorOf(() => settings.saveProvider({ presetId: 'ark', label: '方舟', baseUrl: 'not-a-url' })),
    ).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { issues: ['baseUrl'] },
    });
    expect(errorOf(() => settings.addModels({ providerId: '不在池里的 id', models: ['m'] }))).toMatchObject({
      code: 'LLM_PROVIDER_NOT_FOUND',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_providers').get()).toMatchObject({ n: 0 });
  });
});

describe('模型清单获取与角色绑定（spec 7.2-04 / 05 / 07 / 09 / 11 / 12）', () => {
  /** 池实例的端点前缀：与 `BASE_URL` 刻意不同名，"腿读到的是池那个地址"才量得出来。 */
  const POOL_URL = 'https://gw.test.invalid/v1';
  const POOL_KEY = 'sk-pool-7777';

  /**
   * 起一家已入库两条模型的实例（清单获取与绑定的用例都从这一格开始）。
   * @param settings 已装载的配置服务
   * @returns 实例读数（id 是随机的，密钥与清单由本用例填）
   */
  const seededProvider = (settings: LlmSettingsService): LlmProviderInstanceView => {
    const saved = settings.saveProvider({
      presetId: 'deepseek',
      label: 'DeepSeek',
      baseUrl: POOL_URL,
      apiKey: POOL_KEY,
    });
    settings.addModels({ providerId: saved.id, models: ['a-model', 'b-model'] });
    return saved;
  };

  it('获取清单：两种信封都认、脏项逐条跳过，发的是 GET 且带的是那家自己的 key', async () => {
    let reply: () => Promise<Response> = () => Promise.resolve(json({ object: 'list', data: [] }));
    const fixture = stubFetch(() => reply());
    try {
      const { settings } = await boot();
      const saved = seededProvider(settings);

      reply = () =>
        Promise.resolve(json({ data: [{ id: 'a-model' }, { object: 'model' }, { id: 'z-model' }, { id: '' }] }));
      const reading = await settings.fetchModels(saved.id);
      expect(reading).toMatchObject({ ok: true, models: ['a-model', 'z-model'], reason: null, message: null });
      expect(reading.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]).toMatchObject({ url: `${POOL_URL}/models`, init: { method: 'GET' } });
      // 掩码末 4 位与实发的 Bearer 对得上，才算"界面上说的那把就是这次发出去的那把"；GET 不许带请求体。
      expect(fixture.requests[0]?.init.headers).toMatchObject({ authorization: `Bearer ${POOL_KEY}` });
      expect(fixture.requests[0]?.init.body).toBeUndefined();

      // 部分网关把清单放在 `models[]` 而不是 `data[]`：只认一种就会让用户看到"这家没给清单"。
      reply = () => Promise.resolve(json({ models: [{ id: 'c-model' }, { id: 'd-model' }] }));
      expect((await settings.fetchModels(saved.id)).models).toEqual(['c-model', 'd-model']);
    } finally {
      fixture.restore();
    }
  });

  it('拉取失败只播报：非 2xx / 空清单 / 超时 / 认不出这家 四种读法，已入库的行一条都不动', async () => {
    let reply: () => Promise<Response> = () => Promise.resolve(json({ object: 'list', data: [] }));
    const fixture = stubFetch(() => reply());
    try {
      const { settings } = await boot();
      const saved = seededProvider(settings);

      reply = () => Promise.resolve(json({ error: { message: 'bad key' } }, 401));
      expect(await settings.fetchModels(saved.id)).toMatchObject({
        ok: false,
        models: [],
        reason: 'LLM_REQUEST_FAILED',
      });

      // 拿到了但一条都没有：这是"这份清单是空的"，与"发不出去"是两个播报，界面文案不能混。
      reply = () => Promise.resolve(json({ object: 'list', data: [] }));
      expect(await settings.fetchModels(saved.id)).toMatchObject({
        ok: false,
        models: [],
        reason: 'EMPTY',
        message: '这家回给的模型清单是空的',
      });

      // 超时由传输骨架变成结构化失败，读法与非 2xx 同一个码、靠 message 分派。
      reply = () => Promise.reject(Object.assign(new Error('The operation was timed out'), { name: 'TimeoutError' }));
      const timedOut = await settings.fetchModels(saved.id);
      expect(timedOut).toMatchObject({ ok: false, reason: 'LLM_REQUEST_FAILED' });
      expect(timedOut.message).toContain('超时');

      expect(await settings.fetchModels('不在池里的 id')).toMatchObject({
        ok: false,
        reason: 'LLM_PROVIDER_NOT_FOUND',
      });
      // 四条失败态合起来判的是 spec 7.2-07 那一句：一次网络抖动不许让用户丢掉整家清单。
      expect(settings.listModels(saved.id).map((item) => item.model)).toEqual(['a-model', 'b-model']);
    } finally {
      fixture.restore();
    }
  });

  it('绑定角色：持久层与热改都只写两格、不复制 baseUrl，腿读回的是池那个地址', async () => {
    const { settings, config, applied } = await boot();
    const saved = seededProvider(settings);
    const view = await settings.bindRole({ leg: 'chat', providerId: saved.id, model: 'a-model' });

    // 端点不落持久层：用户改了那家的地址，这条腿下一次就该跟着变（§2.5 不存第二份事实）。
    expect(config.persisted('llm')).toEqual({ providerId: saved.id, model: 'a-model' });
    expect(applied).toEqual([{ id: 'llm', patch: { providerId: saved.id, model: 'a-model' } }]);
    expect(legOf(view, 'chat')).toMatchObject({
      baseUrl: POOL_URL,
      model: 'a-model',
      available: true,
      key: { present: true, source: 'secret', tail: '7777' },
    });
    // 另一腿不受这次绑定影响（一次绑定只动一格，风险表里"重建两次"那一条的读法）。
    expect(legOf(view, 'embed').missing).toEqual(['baseUrl', 'model', 'apiKey']);
  });

  it('绑定只认已入库的那条模型，三条负腿各报自己的码且一次落盘都没有', async () => {
    const { settings, config, applied } = await boot();
    const saved = seededProvider(settings);

    await expect(settings.bindRole({ leg: 'chat', providerId: saved.id, model: '没勾过的模型' })).rejects.toMatchObject(
      {
        code: 'INVALID_ARGUMENT',
        details: { reason: 'MODEL_NOT_ADDED' },
      },
    );
    await expect(
      settings.bindRole({ leg: 'chat', providerId: '不在池里的 id', model: 'a-model' }),
    ).rejects.toMatchObject({ code: 'LLM_PROVIDER_NOT_FOUND' });
    await expect(
      settings.bindRole({ leg: 'voice' as 'chat', providerId: saved.id, model: 'a-model' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { issues: ['leg'] } });
    expect(config.persisted('llm')).toEqual({});
    expect(applied).toHaveLength(0);
  });

  it('解析顺序三条读数：绑定盖过配置格，回落时照用兜底，两边都没有就报未配置（spec 7.2-12）', async () => {
    const first = await boot();
    const saved = seededProvider(first.settings);
    await first.settings.bindRole({ leg: 'chat', providerId: saved.id, model: 'a-model' });

    // ① 绑定态：客户端自己那一份读数也走池（第二次装载 = 热改重建后的等价形态，端点与密钥路径都来自那一家）。
    const bound = await boot({ userData: first.userData, chatProviderId: saved.id, model: 'a-model' });
    expect(bound.llm.status()).toMatchObject({
      available: true,
      model: 'a-model',
      endpoint: `${POOL_URL}/chat/completions`,
      keySource: 'secret',
      origin: 'pool',
      providerId: saved.id,
    });

    // ② 兜底态：没有绑定时用配置格自己的端点，key 走 `keyEnv` 那一路（7.1-07 那条链原样不动）。
    const fallback = await boot({ envKey: 'sk-env-9900' });
    expect(fallback.llm.status()).toMatchObject({
      available: true,
      keySource: 'env',
      endpoint: `${BASE_URL}/chat/completions`,
      origin: 'config',
      providerId: null,
    });

    // ③ 未配置：一次请求都不发，缺项照实列全（界面上的"测试连接"据此给锁定原因码）。
    // 上一条设的环境变量要到 `afterEach` 才清，所以这里先手动撤掉——"两处都没有"必须是真没有。
    delete process.env[CHAT_ENV];
    const none = await boot({ baseUrl: null, model: null });
    expect(none.llm.status()).toMatchObject({
      available: false,
      missing: ['baseUrl', 'model', 'apiKey'],
      endpoint: null,
      origin: 'none',
    });

    // 向量腿共用同一条解析（`resolveLeg` 抽在这里的理由）：绑定 embed 后它读的也是池那个地址。
    await first.settings.bindRole({ leg: 'embed', providerId: saved.id, model: 'b-model' });
    expect(legOf(first.settings.read(), 'embed')).toMatchObject({ baseUrl: POOL_URL, model: 'b-model' });
  });

  it('删掉正被绑定的实例：那条腿回落到兜底、热改一次 null，并报出缺的那一格', async () => {
    const { settings, config, applied } = await boot();
    const saved = seededProvider(settings);
    await settings.bindRole({ leg: 'chat', providerId: saved.id, model: 'a-model' });
    expect(applied).toHaveLength(1);

    await settings.deleteProvider(saved.id);
    // 悬空绑定必须当场撤掉：留着的话这条腿每次请求都要先解析一次才发现"这一行没有了"。
    expect(applied.at(-1)).toEqual({ id: 'llm', patch: { providerId: null, model: null } });
    // 绑定是一条原子表态（实例 + 模型名一起写的），所以撤它也是两条一起撤——
    // 留着那个模型名，界面就会拿着一个候选清单里已经不存在的值。
    expect(config.persisted('llm')).toEqual({ providerId: null, model: null });
    const chat = legOf(settings.read(), 'chat');
    // 端点回到配置格那一格（yml/env 兜底原样不动），缺的是模型名与那把随实例一起清掉的 key。
    expect(chat).toMatchObject({ baseUrl: BASE_URL, model: null, missing: ['model', 'apiKey'] });
  });

  it('测某一家连通性按实例点名探测，不碰全局绑定（spec 7.2-04）', async () => {
    const fixture = stubFetch(() =>
      Promise.resolve(json({ model: 'probe-model', choices: [{ message: { content: 'pong' } }] })),
    );
    try {
      const { settings, config, applied } = await boot();
      const saved = seededProvider(settings);
      const result = await settings.checkProvider(saved.id, 'probe-model');
      expect(result).toMatchObject({ ok: true, model: 'probe-model', reason: null });
      expect(fixture.requests[0]?.url).toBe(`${POOL_URL}/chat/completions`);
      expect(fixture.requests[0]?.init.headers).toMatchObject({ authorization: `Bearer ${POOL_KEY}` });
      // 探测点名哪条模型就是哪条，不拿绑定里那条去猜（用户此刻正决定要不要勾它）。
      expect(JSON.parse(bodyText(fixture.requests[0]!.init))).toMatchObject({ model: 'probe-model', max_tokens: 8 });

      expect(applied).toHaveLength(0);
      expect(config.persisted('llm')).toEqual({});

      // 负腿：点名了池里没有的实例，报"这一家没有"而不是发一次注定失败的请求。
      const requestsBefore = fixture.requests.length;
      expect(await settings.checkProvider('不在池里的 id', 'm')).toMatchObject({
        ok: false,
        reason: 'LLM_PROVIDER_NOT_FOUND',
      });
      expect(fixture.requests).toHaveLength(requestsBefore);
    } finally {
      fixture.restore();
    }
  });
});
