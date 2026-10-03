/**
 * 话术生成的骨架测试（spec 2.5-01 / 09 / 10 + 4.6-01 / 02 / 04 / 05 / 06 / 11 / 12）。
 *
 * 三条主线：模型可用时用模型的、不可用时**可见地**回落模板、任何一路产出的文本都要过黑名单。
 * 4.6-b 起加两条：三类话术走同一个入口（分型只换文案与入参校验）、超长先按句末截断再决定回落。
 * 4.6-c 起再加三条：产物显式回指引用的证据（`evidenceRefs`）、模型编出来的数被判不合格、
 * 夸大与诱导承诺和凭据分两组但走同一条判据（发送腿硬拦、模型腿可见回落）。
 * 4.6-e 起再加一段：与 P2 的接口定型契约，用一只只会读字段的假消费方证明"不二次加工"（4.6-11）。
 * 网络一律用 `globalThis.fetch` 存根（模型端点与 fixture 都不真连，AGENTS.md §7.2），
 * 并且每次都断言请求次数——"回落"只有在确定没发网络时才是可测的（plan §12.6.1）。
 */
import { AppError, asApp, Context, NO_CONFIG } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { LlmChatService, type LlmConfig } from '@auto-cc/plugin-llm';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FORBIDDEN_PATTERNS,
  DEFAULT_OVERCLAIM_PATTERNS,
  outboundScriptSchema,
  OutboundScriptService,
  truncateToSentence,
  type OutboundScriptConfig,
  type ScriptDraftView,
} from './script.js';
import { FakeAgentToolsService, FakeJdReplyStatusService } from './test-doubles.js';
import { SCRIPT_PROMPT_VERSION } from './prompts.js';

const KEY_ENV = 'AUTO_CC_LLM_TEST_KEY';
// 值本身不进断言，只要非空即可；写成 sk- 开头会被 2.5-12 的入口唯一性检查当成密钥字面量拦下。
process.env[KEY_ENV] = 'unit-test-key-value';

/** 模型侧的默认配置：`ready` 里按需覆盖，缺 baseUrl 即"未配置"。 */
const LLM_BASE: LlmConfig = {
  baseUrl: null,
  model: null,
  keyEnv: KEY_ENV,
  timeoutMs: 8000,
  maxTokens: 400,
  temperature: 0.7,
};

/** 话术侧的默认配置：与 schema 的 default 一致（带 `.default()` 的键在直接调用点必须显式给出，AGENTS.md §9）。 */
const SCRIPT_BASE: OutboundScriptConfig = {
  scriptVersion: 'v1',
  maxChars: 200,
  tone: 'formal',
  forbiddenPatterns: DEFAULT_FORBIDDEN_PATTERNS,
  overclaimPatterns: DEFAULT_OVERCLAIM_PATTERNS,
};

const JD = { jdId: 'job-1001', title: '前端工程师', company: '示例科技', keywords: ['React', 'TypeScript'] };

/** 把 `fetch` 换成按脚本回话的存根，并记录每次请求体。 */
function stubFetch(reply: { status: number; body: unknown }): {
  bodies: Record<string, unknown>[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  const stub: typeof fetch = (_input, init) => {
    bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>);
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status }));
  };
  globalThis.fetch = stub;
  return { bodies, restore: () => (globalThis.fetch = original) };
}

/**
 * 装到 `outbound.script` 为止，并挂上一只 agent 工具注册表替身。
 * 替身必须早于本服务上岗：`registerAgentTools` 是软取，晚挂载只会登记出 0 个（2.8-08 的前提）。
 * @param llm 模型侧配置（`baseUrl: null` 即"未配置"，两类用例都靠它决定走模型还是走回落）
 * @param script 话术侧配置
 * @param withJdStore 是否挂上 `jd.store` 替身（spec 5.7-f：话术生成前要先问岗位键有没有出处）
 * @returns 话术服务、注册表替身，以及（挂了替身时）那份岗位表
 */
async function bootScript(llm: Partial<LlmConfig>, script: Partial<OutboundScriptConfig> = {}, withJdStore = false) {
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  await ctx.plugin(LlmChatService, { ...LLM_BASE, ...llm });
  await ctx.plugin(FakeAgentToolsService, NO_CONFIG);
  if (withJdStore) await ctx.plugin(FakeJdReplyStatusService, {});
  await ctx.plugin(OutboundScriptService, { ...SCRIPT_BASE, ...script });
  return {
    script: asApp(ctx)['outbound.script'],
    tools: ctx.get('agent.tools') as unknown as FakeAgentToolsService,
    jd: withJdStore ? (ctx.get('jd.store') as unknown as FakeJdReplyStatusService) : null,
  };
}

/** 装到 `outbound.script` 为止；`llm` 决定模型侧配置，`script` 决定话术侧配置。 */
async function ready(llm: Partial<LlmConfig>, script: Partial<OutboundScriptConfig> = {}) {
  return (await bootScript(llm, script)).script;
}

/** 模型正常回话的响应体（OpenAI 兼容形状，plan §12.6.1 第 2 条）。 */
const modelReply = (content: string) => ({
  status: 200,
  body: { model: 'test-model', choices: [{ message: { content } }] },
});

/**
 * 跑一次同步调用，把拦下来的那条读成可断言的四元组。
 *
 * 为什么不用 `toThrow*`  matcher：这几条验收要核对的是 `details` 里的**分组与序号**
 * （4.6-05 的两组、4.6-12 的各条规则），那是结构化契约而不是一句报错文本。
 * @param attempt 会（或不会）抛出的那次调用
 * @returns 没拦时 null；拦下时带错误码、规则序号、分组与内容来源
 */
const blockReading = (attempt: () => unknown): { code: string; rule: number; group: string; origin: string } | null => {
  try {
    attempt();
    return null;
  } catch (cause) {
    if (!(cause instanceof AppError)) throw cause;
    const details = cause.details as { rule?: number; group?: string; origin?: string };
    return { code: cause.code, rule: details.rule ?? -1, group: details.group ?? '', origin: details.origin ?? '' };
  }
};

describe('话术的岗位键必须有出处（spec 5.7-f / plan 决策十三）', () => {
  it('库里有这把岗位键：照常产出，且只在问模型之前问一次出处', async () => {
    const fixture = stubFetch({ status: 200, body: {} });
    try {
      const { script, jd } = await bootScript({}, {}, true);
      jd?.set('boss', JD.jdId, false);
      const draft = await script.generate(JD);
      expect(draft.jdId).toBe(JD.jdId);
      expect(jd?.keyAsks).toBe(1);
      expect(fixture.bodies).toHaveLength(0);
    } finally {
      fixture.restore();
    }
  });

  it('库里没有这把岗位键：以 OUTBOUND_JD_UNREGISTERED 拦下，不发网络、不产文案（5.7-d 那次的 1009 就是这一类）', async () => {
    const fixture = stubFetch({ status: 200, body: {} });
    try {
      const { script, jd } = await bootScript({}, {}, true);
      jd?.set('boss', 'other-job', true);
      const reading = await script
        .generate(JD)
        .then(() => null)
        .catch((cause: unknown) => (cause instanceof AppError ? { code: cause.code, details: cause.details } : null));
      expect(reading).toMatchObject({ code: 'OUTBOUND_JD_UNREGISTERED', details: { jdId: JD.jdId } });
      expect(fixture.bodies).toHaveLength(0);
    } finally {
      fixture.restore();
    }
  });

  it('问不到出处（`jd.store` 未挂载）时放行——有意为之的弱保证，判据与理由写在 plan 决策十三', async () => {
    const fixture = stubFetch({ status: 200, body: {} });
    try {
      const script = await ready({});
      const draft = await script.generate({ ...JD, jdId: 'no-such-job-in-a-store-that-is-not-mounted' });
      expect(draft.origin).toBe('template');
      expect(fixture.bodies).toHaveLength(0);
    } finally {
      fixture.restore();
    }
  });
});

describe('outbound.script 的回落与黑名单（spec 2.5-01 / 09 / 10）', () => {
  it('模型未配置：回落模板、带上原因，且一次网络都不发（2.5-01）', async () => {
    const fixture = stubFetch({ status: 200, body: {} });
    try {
      const script = await ready({});
      const draft = await script.generate(JD);
      expect(draft.origin).toBe('template');
      expect(draft.fallbackReason).toContain('未配置');
      expect(draft.text).toContain('前端工程师');
      expect(draft.text).toContain('示例科技');
      expect(fixture.bodies).toHaveLength(0);
    } finally {
      fixture.restore();
    }
  });

  it('模型可用：用模型的产出，且请求里带上了岗位事实（2.5-01 的另一半）', async () => {
    const fixture = stubFetch(modelReply('您好，示例科技的前端工程师岗位我很感兴趣，想请教具体要求。'));
    try {
      const script = await ready({ baseUrl: 'https://model.test.invalid/v1', model: 'test-model' });
      const draft = await script.generate(JD);
      expect(draft.origin).toBe('model');
      expect(draft.fallbackReason).toBeUndefined();
      expect(draft.text).toContain('想请教具体要求');
      const messages = (fixture.bodies[0]?.messages ?? []) as { role: string; content: string }[];
      expect(messages).toHaveLength(2);
      expect(messages[1]?.content).toContain('前端工程师');
      expect(messages[1]?.content).toContain('React');
    } finally {
      fixture.restore();
    }
  });

  it('对端 5xx：回落模板并把状态码写进原因，不静默', async () => {
    const fixture = stubFetch({ status: 500, body: 'boom' });
    try {
      const script = await ready({ baseUrl: 'https://model.test.invalid/v1', model: 'test-model' });
      const draft = await script.generate(JD);
      expect(draft.origin).toBe('template');
      expect(draft.fallbackReason).toContain('500');
    } finally {
      fixture.restore();
    }
  });

  it('模型产出缺岗位名/公司名：判为不合格并回落，不发一句空话（§12.2 采纳的拒填机制）', async () => {
    const fixture = stubFetch(modelReply('您好，我对这个机会很感兴趣，方便聊聊吗？'));
    try {
      const script = await ready({ baseUrl: 'https://model.test.invalid/v1', model: 'test-model' });
      const draft = await script.generate(JD);
      expect(draft.origin).toBe('template');
      expect(draft.fallbackReason).toContain('缺少岗位名');
    } finally {
      fixture.restore();
    }
  });

  it('模型产出含手机号：不采用该文案，回落模板（2.5-10）', async () => {
    const fixture = stubFetch(modelReply('您好，示例科技的前端工程师岗位，我的电话 13800138000，请联系我。'));
    try {
      const script = await ready({ baseUrl: 'https://model.test.invalid/v1', model: 'test-model' });
      const draft = await script.generate(JD);
      expect(draft.origin).toBe('template');
      expect(draft.text).not.toContain('13800138000');
    } finally {
      fixture.restore();
    }
  });

  it('入参缺公司名：以 INVALID_ARGUMENT 失败，不碰模型', async () => {
    const fixture = stubFetch(modelReply('不该被用到'));
    try {
      const script = await ready({ baseUrl: 'https://model.test.invalid/v1', model: 'test-model' });
      // 少写 company 的入参形状：字段缺失是入参错误，不该走到模型那一步。
      await expect(script.generate({ jdId: JD.jdId, title: JD.title, keywords: JD.keywords })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      expect(fixture.bodies).toHaveLength(0);
    } finally {
      fixture.restore();
    }
  });

  it('模板文本命中黑名单：直接以 OUTBOUND_FORBIDDEN_CONTENT 拦下，两条路都不通就失败（2.5-10）', async () => {
    const fixture = stubFetch({ status: 200, body: {} });
    try {
      const script = await ready({});
      // 手机号是从入参进模板的：这就是"用户把联系方式塞进关键词"的真实形态。
      await expect(script.generate({ ...JD, keywords: ['13800138000'] })).rejects.toMatchObject({
        code: 'OUTBOUND_FORBIDDEN_CONTENT',
      });
      expect(fixture.bodies).toHaveLength(0);
    } finally {
      fixture.restore();
    }
  });

  it('配置有消费点：scriptVersion 与 maxChars 改了结果就跟着变（§12.2「配置改了行为不变=缺陷」）', async () => {
    const fixture = stubFetch({ status: 200, body: {} });
    try {
      const versioned = await ready({}, { scriptVersion: 'v2' });
      expect((await versioned.generate(JD)).scriptVersion).toBe('v2');
      const tight = await ready({}, { maxChars: 20 });
      await expect(tight.generate(JD)).rejects.toMatchObject({
        code: 'OUTBOUND_FORBIDDEN_CONTENT',
        details: { reason: 'over-length' },
      });
    } finally {
      fixture.restore();
    }
  });

  it('来源可追溯：结果带 jdId 与版本，供 2.5-e 写进账本的 source 列（2.5-09）', async () => {
    const fixture = stubFetch({ status: 200, body: {} });
    try {
      const script = await ready({});
      expect(await script.generate(JD)).toMatchObject({ jdId: 'job-1001', scriptVersion: 'v1', origin: 'template' });
    } finally {
      fixture.restore();
    }
  });
});

describe('outbound.script 的话术分型（spec 4.6-01 / 4.6-06）', () => {
  /** 追问的入参形状：比开场白多一句对方的原话。 */
  const FOLLOW_UP = { ...JD, kind: 'follow-up', recruiterMessage: '我们把简历都过一遍再联系你' };
  /** 拒绝应对的入参形状。 */
  const REJECTION = { ...JD, kind: 'rejection', recruiterMessage: '这个岗位我们想先看看内部转岗' };

  it('追问缺对方原话：以 INVALID_ARGUMENT 失败且一次网络都不发（4.6-01 的入参判据）', async () => {
    const fixture = stubFetch(modelReply('不该被用到'));
    try {
      const script = await ready({ baseUrl: 'https://model.test.invalid/v1', model: 'test-model' });
      await expect(script.generate({ ...JD, kind: 'follow-up' })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        details: { kind: 'follow-up' },
      });
      expect(fixture.bodies).toHaveLength(0);
    } finally {
      fixture.restore();
    }
  });

  it('三类各走同一个入口：模型不可用时都可见地回落模板，kind 原样回传（4.6-01 / 06）', async () => {
    const fixture = stubFetch({ status: 200, body: {} });
    try {
      const script = await ready({});
      const drafts = await Promise.all([script.generate(JD), script.generate(FOLLOW_UP), script.generate(REJECTION)]);
      expect(drafts.map((d) => d.kind)).toEqual(['greeting', 'follow-up', 'rejection']);
      expect(drafts.every((d) => d.origin === 'template')).toBe(true);
      // 追问必须指涉对方那句话，否则它只是第二条自我介绍；拒绝应对要提到那次的结果。
      expect(drafts[1]?.text).toContain('我们把简历都过一遍再联系你');
      expect(drafts[2]?.text).toContain('这个岗位我们想先看看内部转岗');
      expect(drafts.every((d) => d.text.includes('前端工程师') && d.text.includes('示例科技'))).toBe(true);
      expect(fixture.bodies).toHaveLength(0);
    } finally {
      fixture.restore();
    }
  });

  it('分型确实换了提示词：三类的角色句各不相同，追问与拒绝的 user 带上对方原话（4.6-01）', async () => {
    const fixture = stubFetch(modelReply('您好，示例科技的前端工程师岗位我想再确认下进展。'));
    try {
      const script = await ready({ baseUrl: 'https://model.test.invalid/v1', model: 'test-model' });
      await script.generate(JD);
      await script.generate(FOLLOW_UP);
      await script.generate(REJECTION);
      const messagesOf = (index: number) =>
        (fixture.bodies[index]?.messages ?? []) as { role: string; content: string }[];
      const systems = [0, 1, 2].map((index) => messagesOf(index)[0]?.content ?? '');
      expect(new Set(systems).size).toBe(3);
      expect(systems[0]).toContain('第一条打招呼消息');
      expect(systems[1]).toContain('追问消息');
      expect(systems[2]).toContain('拒绝应对');
      expect(messagesOf(1)[1]?.content).toContain('对方最后一条消息：我们把简历都过一遍再联系你');
      // 开场白不该出现"对方最后一条消息"这一行（它没有这句话）。
      expect(messagesOf(0)[1]?.content).not.toContain('对方最后一条消息');
    } finally {
      fixture.restore();
    }
  });
});

describe('outbound.script 的长度与语气约束（spec 4.6-04）', () => {
  it('模型超长：截到最后一个完整句，不半句话糊在对方屏幕上（4.6-04）', async () => {
    const fixture = stubFetch(
      modelReply(
        '您好，示例科技的前端工程师岗位我很感兴趣，想请教具体要求。第二句是模型收不住写的一大段补充说明，本该被切掉。',
      ),
    );
    try {
      const script = await ready({ baseUrl: 'https://model.test.invalid/v1', model: 'test-model' }, { maxChars: 30 });
      const draft = await script.generate(JD);
      expect(draft.origin).toBe('model');
      expect(draft.text).toBe('您好，示例科技的前端工程师岗位我很感兴趣，想请教具体要求。');
      expect(draft.text.length).toBeLessThanOrEqual(30);
      expect(draft.text.endsWith('。')).toBe(true);
    } finally {
      fixture.restore();
    }
  });

  it('上限内切不出完整句：回落模板并说清原因（4.6-04 的另一半）', async () => {
    const fixture = stubFetch(
      modelReply('这段回复一路写下去不带任何句末标点所以窗口里找不到可以整句保留的位置'.repeat(4)),
    );
    try {
      const script = await ready({ baseUrl: 'https://model.test.invalid/v1', model: 'test-model' }, { maxChars: 100 });
      const draft = await script.generate(JD);
      expect(draft.origin).toBe('template');
      expect(draft.fallbackReason).toContain('切不出完整句');
    } finally {
      fixture.restore();
    }
  });

  it('禁发内容在被截掉的那半段里：整条判不可信，不靠截断蒙过去（4.6-04 × 2.5-10）', async () => {
    // 岗位名与公司名取短形态，是为了让模板本身能落进 60 字上限——回落那一腿必须还能过校验，
    // 否则这条用例测到的是"模板超长"而不是"凭据出现在被截掉的段落里"。
    const shortJd = { jdId: 'job-1002', title: '前端', company: '示例', keywords: [] };
    const filler =
      '这里再写一段与主题无关的铺垫文字，它的作用只是把长度顶到上限之外，好让截断看起来能把后面的内容切掉。';
    const fixture = stubFetch(
      modelReply(`您好，示例的前端岗位我很感兴趣，想请教具体要求。${filler}我的手机号是 13800138000，请联系我。`),
    );
    try {
      const script = await ready({ baseUrl: 'https://model.test.invalid/v1', model: 'test-model' }, { maxChars: 60 });
      const draft = await script.generate(shortJd);
      expect(draft.origin).toBe('template');
      expect(draft.fallbackReason).toContain('含禁发内容');
      expect(draft.text).not.toContain('13800138000');
    } finally {
      fixture.restore();
    }
  });

  it('语气档位有消费点：brief 与 formal 的模板收尾句不同（§12.2「配置改了行为不变=缺陷」）', async () => {
    const fixture = stubFetch({ status: 200, body: {} });
    try {
      const formal = await ready({}, { tone: 'formal' });
      const brief = await ready({}, { tone: 'brief' });
      expect((await formal.generate(JD)).text.endsWith('方便的话希望进一步沟通，谢谢！')).toBe(true);
      expect((await brief.generate(JD)).text.endsWith('方便聊聊吗？')).toBe(true);
    } finally {
      fixture.restore();
    }
  });

  it('截断函数自己的边界：等长原样返回、半角标点也算句末、窗口里没有标点就 null（4.6-04）', () => {
    expect(truncateToSentence('短句。', 20)).toBe('短句。');
    expect(truncateToSentence('第一句。第二句很长很长很长很长。', 12)).toBe('第一句。');
    expect(truncateToSentence('First line! Second line here.', 12)).toBe('First line!');
    expect(truncateToSentence('没有标点的一句话但是已经超过上限长度', 8)).toBeNull();
  });

  it('版本默认取自注册表常量：改文案的那一次就会看到它（4.6-09 的可版本化落点）', () => {
    expect(outboundScriptSchema.parse({}).scriptVersion).toBe(SCRIPT_PROMPT_VERSION);
  });
});

describe('outbound.script 的证据绑定（spec 4.6-02）', () => {
  /** 两条不同证据 + 同一条的第二路命中（同一个 refId 出现两次），用来验去重与保序。 */
  const EVIDENCED = {
    ...JD,
    evidence: [
      { fact: '主导过订单服务重构', refId: 'chunk-11' },
      { fact: '覆盖 30 万用户', refId: 'chunk-22' },
      { fact: '同一实体的第二条分片', refId: 'chunk-11' },
    ],
  };

  it('产物回指证据 id：去重且保持入参顺序，与模型是否引用无关（4.6-02 的回指面）', async () => {
    const fixture = stubFetch({ status: 200, body: {} });
    try {
      const script = await ready({});
      const draft = await script.generate(EVIDENCED);
      expect(draft.evidenceRefs).toEqual(['chunk-11', 'chunk-22']);
    } finally {
      fixture.restore();
    }
  });

  it('模型只引用其中一条时，回指清单仍是喂进去的全部证据（回指记录的是这次依据，不是模型的取舍）', async () => {
    const fixture = stubFetch(modelReply('您好，示例科技的前端工程师岗位，我主导过订单服务重构。'));
    try {
      const script = await ready({ baseUrl: 'https://model.test.invalid/v1', model: 'test-model' });
      const draft = await script.generate(EVIDENCED);
      expect(draft.origin).toBe('model');
      expect(draft.evidenceRefs).toEqual(['chunk-11', 'chunk-22']);
    } finally {
      fixture.restore();
    }
  });

  it('没有任何证据时回指是空数组：这是"没个性化过"的读数，不是缺字段（4.6-02 / 06 同一口径）', async () => {
    const fixture = stubFetch({ status: 200, body: {} });
    try {
      const script = await ready({});
      expect((await script.generate(JD)).evidenceRefs).toEqual([]);
    } finally {
      fixture.restore();
    }
  });

  it('证据缺 refId：以 INVALID_ARGUMENT 失败且不碰模型——只带正文的证据事后无从核对出处', async () => {
    const fixture = stubFetch(modelReply('不该被用到'));
    try {
      const script = await ready({ baseUrl: 'https://model.test.invalid/v1', model: 'test-model' });
      await expect(script.generate({ ...JD, evidence: [{ fact: '主导过订单服务重构' }] })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      expect(fixture.bodies).toHaveLength(0);
    } finally {
      fixture.restore();
    }
  });

  it('模型写出没有出处的数字：判不合格并可见回落，原因里带着那个数（4.6-02 的拦截面）', async () => {
    const fixture = stubFetch(modelReply('您好，示例科技的前端工程师岗位，我把延迟下降了 40%。'));
    try {
      const script = await ready({ baseUrl: 'https://model.test.invalid/v1', model: 'test-model' });
      const draft = await script.generate({ ...JD, evidence: [{ fact: '主导过订单服务重构', refId: 'chunk-11' }] });
      expect(draft.origin).toBe('template');
      expect(draft.fallbackReason).toContain('没有证据支撑的数字');
      expect(draft.fallbackReason).toContain('40');
    } finally {
      fixture.restore();
    }
  });

  it('同一个数在证据里有过出处就放过：拦的是编造，不是引用（4.6-02 的反向验证）', async () => {
    const fixture = stubFetch(modelReply('您好，示例科技的前端工程师岗位，我把延迟下降了 40%。'));
    try {
      const script = await ready({ baseUrl: 'https://model.test.invalid/v1', model: 'test-model' });
      const draft = await script.generate({
        ...JD,
        evidence: [{ fact: '主导订单服务重构，延迟下降 40%', refId: 'chunk-11' }],
      });
      expect(draft.origin).toBe('model');
      expect(draft.fallbackReason).toBeUndefined();
    } finally {
      fixture.restore();
    }
  });

  it('对方原话里的数字算出处：追问引用对方说过的排期不是编造（4.6-01 × 02 的交界）', async () => {
    const fixture = stubFetch(modelReply('您好，示例科技的前端工程师岗位，那我们就 3 天后见面。'));
    try {
      const script = await ready({ baseUrl: 'https://model.test.invalid/v1', model: 'test-model' });
      const draft = await script.generate({ ...JD, kind: 'follow-up', recruiterMessage: '我们 3 天后面试' });
      expect(draft.origin).toBe('model');
    } finally {
      fixture.restore();
    }
  });
});

describe('outbound.script 的夸大与诱导承诺拦截（spec 4.6-05）', () => {
  it('模型产出承诺"包过"：不采用，回落原因说的是夸大承诺而不是凭据（分组各说各的话）', async () => {
    const fixture = stubFetch(modelReply('您好，示例科技的前端工程师岗位，我这边包过。'));
    try {
      const script = await ready({ baseUrl: 'https://model.test.invalid/v1', model: 'test-model' });
      const draft = await script.generate(JD);
      expect(draft.origin).toBe('template');
      expect(draft.fallbackReason).toContain('夸大或诱导承诺');
      expect(draft.text).not.toContain('包过');
    } finally {
      fixture.restore();
    }
  });

  it('发送腿对四类夸大/诱导说法逐条硬拦，并带上组别与规则序号（4.6-05 的可核对清单）', async () => {
    const fixture = stubFetch({ status: 200, body: {} });
    try {
      const script = await ready({});
      const cases: Array<[string, number]> = [
        ['这个岗位包过，放心投。', 1],
        ['我们保证录用。', 2],
        ['一定能拿到 offer。', 3],
        ['方便的话加我微信细聊。', 4],
        ['我有付费内推渠道。', 5],
        ['请点击链接查看我的简历。', 6],
      ];
      for (const [text, rule] of cases) {
        expect(blockReading(() => script.assertSendable(text, 'manual'))).toEqual({
          code: 'OUTBOUND_FORBIDDEN_CONTENT',
          rule,
          group: 'overclaim',
          origin: 'manual',
        });
      }
    } finally {
      fixture.restore();
    }
  });

  it('「包含过」这类正常表述不误伤：黑名单收窄到承诺形状（机检之外的人工边界）', async () => {
    const fixture = stubFetch({ status: 200, body: {} });
    try {
      const script = await ready({});
      expect(blockReading(() => script.assertSendable('我的职责包含过支付与结算两块。', 'model'))).toBeNull();
    } finally {
      fixture.restore();
    }
  });

  it('overclaimPatterns 有消费点：配置给了就整体替换内置六条（§12.2「配置改了行为不变=缺陷」）', async () => {
    const fixture = stubFetch({ status: 200, body: {} });
    try {
      const custom = await ready({}, { overclaimPatterns: [String.raw`内定名单`] });
      expect(blockReading(() => custom.assertSendable('这个岗位包过。', 'manual'))).toBeNull();
      expect(blockReading(() => custom.assertSendable('你在内定名单上。', 'manual'))).toMatchObject({
        group: 'overclaim',
        rule: 1,
      });
    } finally {
      fixture.restore();
    }
  });
});

describe('outbound.script 的凭据黑名单分组（spec 4.6-12）', () => {
  it('三条凭据规则各拦各的形状，组别都是 credential、序号与内置清单对得上', async () => {
    const fixture = stubFetch({ status: 200, body: {} });
    try {
      const script = await ready({});
      const cases: Array<[string, number]> = [
        ['我的手机 13800138000，请直接联系我。', 1],
        // 合成串：只保证形状（17 位数字 + X），不是真实身份证，测试不落个人信息（§8.5）。
        ['证件号 12010100000000000X 已上传。', 2],
        ['我的验证码：123456，麻烦帮忙看下。', 3],
      ];
      for (const [text, rule] of cases) {
        expect(blockReading(() => script.assertSendable(text, 'manual'))).toEqual({
          code: 'OUTBOUND_FORBIDDEN_CONTENT',
          rule,
          group: 'credential',
          origin: 'manual',
        });
      }
    } finally {
      fixture.restore();
    }
  });

  it('凭据优先于夸大：两组同一条判据入口，先判会伤人的那一组', async () => {
    const fixture = stubFetch({ status: 200, body: {} });
    try {
      const script = await ready({});
      expect(blockReading(() => script.assertSendable('包过，我的验证码：123456。', 'manual'))).toMatchObject({
        group: 'credential',
        rule: 3,
      });
    } finally {
      fixture.restore();
    }
  });
});

/**
 * `outbound.script` 与 P2（打招呼编排）的接口定型（spec 4.6-11 的契约单测）。
 *
 * 判据是"P2 不再二次加工"，因此这里的主角是一只**假消费方**：它只准读视图上的既有字段，
 * 拼字符串的能力一概不给（能拼就能改写，那条断言就废了）。加工一旦发生在消费方，
 * 界面上看到的和真正发出去的就分成两份事实（§2.5）。
 *
 * 命名对账（写在代码里，因为它是这份契约唯一的入口名读数）：spec 4.6-11 原文写的是
 * `script.greeting`，实现里的口是 `outbound.script.generate` + 入参 `kind='greeting'`
 * （4.6-b 的裁定：三类共用一只口，不按界面需要拆成三个入口）。这里锁的是那只口的**输出形状**，
 * 与名字无关——名字对不上是文档滞后，形状对不上才是缺陷。
 */
describe('outbound.script 与 P2 的接口定型（spec 4.6-11）', () => {
  /** 视图上锁死的六个必填键（升序）。多一个必填键意味着 P2 要重新推断它是什么，少一个就是来源断了。 */
  const REQUIRED_DRAFT_KEYS = ['evidenceRefs', 'jdId', 'kind', 'origin', 'scriptVersion', 'text'];

  /**
   * 该条候选**应当**有的键集合：模型腿六个，模板腿多一个 `fallbackReason`。
   * @param draft 话术视图
   * @returns 升序键名清单（可选键只在它出现的那条腿上出现，所以集合随 `origin` 而定，这是契约的一部分）
   */
  const pinnedDraftKeys = (draft: ScriptDraftView): string[] =>
    draft.origin === 'model' ? REQUIRED_DRAFT_KEYS : [...REQUIRED_DRAFT_KEYS, 'fallbackReason'].sort();

  /** 假消费方的读数：正文原样收到的那份，加上它从视图上抄下来的来源串。 */
  interface Consumed {
    text: string;
    source: string;
  }

  /**
   * 一只只会"读字段"的消费方，模拟 `outbound.greet` 拿到候选后做的事。
   * @param draft 话术视图
   * @returns 消费读数：正文未经任何改写，来源串只由视图既有字段拼成（`join` 是记账格式，不是加工）
   */
  const consume = (draft: ScriptDraftView): Consumed => {
    const chain = [draft.scriptVersion, draft.kind, draft.jdId].join(':');
    return {
      text: draft.text,
      source: draft.evidenceRefs.length > 0 ? `${chain}#${draft.evidenceRefs.join(',')}` : chain,
    };
  };

  it('开场白视图：必填六键一字不多不少，消费方逐字符原样发出且来源取自视图（4.6-11）', async () => {
    const fixture = stubFetch(
      modelReply('您好，示例科技的前端工程师岗位，我有 React 与 TypeScript 经验，想进一步沟通。'),
    );
    try {
      const script = await ready({ baseUrl: 'https://model.test.invalid/v1', model: 'test-model' });
      const draft = await script.generate(JD);
      expect(Object.keys(draft).sort()).toEqual(pinnedDraftKeys(draft));
      expect(draft.origin).toBe('model');
      const consumed = consume(draft);
      // 二次加工的两种常见形态：改标点/空白、按 origin 分支重排。这里要求逐字符相等。
      expect(consumed.text).toBe(draft.text);
      expect(consumed.source).toBe('v1:greeting:job-1001');
      // 消费方抄出来的那份正文仍然过得了发送腿的判据——它不需要"先修一修再发"。
      expect(script.assertSendable(consumed.text, draft.origin)).toBeUndefined();
    } finally {
      fixture.restore();
    }
  });

  it('三类共用同一形状：kind 只是值，消费方不为分型加任何分支（4.6-01 × 4.6-11）', async () => {
    const fixture = stubFetch({ status: 200, body: {} });
    try {
      const script = await ready({});
      const drafts = await Promise.all([
        script.generate(JD),
        script.generate({ ...JD, kind: 'follow-up', recruiterMessage: '我们把简历都过一遍再联系你' }),
        script.generate({ ...JD, kind: 'rejection', recruiterMessage: '这个岗位我们想先看看内部转岗' }),
        script.generate({ ...JD, evidence: [{ fact: '做过三个 React 后台项目', refId: 'chunk-11' }] }),
      ]);
      for (const draft of drafts) expect(Object.keys(draft).sort()).toEqual(pinnedDraftKeys(draft));
      expect(drafts.map((draft) => consume(draft).source)).toEqual([
        'v1:greeting:job-1001',
        'v1:follow-up:job-1001',
        'v1:rejection:job-1001',
        'v1:greeting:job-1001#chunk-11',
      ]);
      expect(fixture.bodies).toHaveLength(0);
    } finally {
      fixture.restore();
    }
  });

  it('回落那条也不逼消费方加工：fallbackReason 是读数，来源链与模型腿同形（4.6-06 × 4.6-11）', async () => {
    const fixture = stubFetch({ status: 503, body: {} });
    try {
      const script = await ready({ baseUrl: 'https://model.test.invalid/v1', model: 'test-model' });
      const draft = await script.generate(JD);
      expect(draft.origin).toBe('template');
      expect(draft.fallbackReason).toBeTruthy();
      expect(Object.keys(draft).sort()).toEqual(pinnedDraftKeys(draft));
      expect(consume(draft)).toEqual({ text: draft.text, source: 'v1:greeting:job-1001' });
    } finally {
      fixture.restore();
    }
  });
});

/**
 * 5.1-c 的话术腿：`outbound.script` 要能被对话挑中（spec 5.1-07 的「生成话术」），
 * 且挑中之后走的仍是 2.5 / 4.6 那一条生成链。三段判据与 `resume-kb` 的建档腿同形：
 * 登记形状、两入口产物逐字相等、入参是边界。
 */
describe('outbound.script 的 agent 工具面（spec 5.1-07 的生成话术）', () => {
  /** 从替身注册表里取本服务那只工具，取不到就当场失败（免得断言退化成对 undefined 取属性）。 */
  function scriptTool(tools: FakeAgentToolsService) {
    const tool = tools.declarations.get('outbound.script.generate');
    if (tool === undefined) throw new Error('outbound.script.generate 未登记进 agent 工具面');
    return tool;
  }

  it('挂载即登记一只 outbound.script.generate：本地写入、需批准、标题是 i18n 键不是文案', async () => {
    const { tools } = await bootScript({ baseUrl: null, model: null });
    // 打招呼与投递那两只是外发（effect 为 outbound），它们在各自服务里登记，本用例没挂它们。
    expect([...tools.declarations.keys()]).toEqual(['outbound.script.generate']);
    const tool = scriptTool(tools);
    expect(tool.effect).toBe('local-write');
    expect(tool.requiresConfirmation).toBe(true);
    expect(tool.titleKey).toBe('agent.tool.labels.scriptGenerate');
    // 描述里必须写清「只产文案，不发送、不占外发额度」：否则模型会把它当成打招呼那一步的替代口（判据五）。
    expect(tool.description).toContain('不发送');
    expect(tool.description).toContain('不占外发额度');
  });

  it('跑工具与直接调 service 的产物逐字相等：两入口共用同一条生成链（§5.9）', async () => {
    const { script, tools } = await bootScript({ baseUrl: null, model: null });
    const tool = scriptTool(tools);
    // 模型端点未配置 → 两条腿都走可见回落，产物只由配置与入参决定，因此逐字比较是确定的。
    const viaTool = (await tool.run(tool.input.parse(JD))).value as ScriptDraftView;
    const viaService = await script.generate(JD);
    expect(JSON.stringify(viaTool)).toBe(JSON.stringify(viaService));
    expect(viaTool.origin).toBe('template');
    expect(viaTool.kind).toBe('greeting');
  });

  it('入参是边界：缺岗位名/公司名与非声明键一律拒收，kind / evidence / keywords 由 schema 补默认', async () => {
    const { tools } = await bootScript({ baseUrl: null, model: null });
    const input = scriptTool(tools).input;
    expect(input.safeParse(JD).success).toBe(true);
    expect(input.safeParse({ jdId: 'job-1001', title: '前端工程师' }).success).toBe(false);
    expect(input.safeParse({ ...JD, maxChars: 20 }).success).toBe(false);
    // 默认值由 schema 补而不是由调用方记：界面、工作流节点、agent 三面传的是同一份最小入参。
    expect(input.parse(JD)).toMatchObject({ kind: 'greeting', evidence: [], keywords: ['React', 'TypeScript'] });
  });
});
