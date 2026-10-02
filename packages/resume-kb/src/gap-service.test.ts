/**
 * `kb.gap` 的装配用例（spec 4.4-01 的入参边界 / 4.4-02 的模型腿五态与可见回落 /
 * 4.4-06 的计数可见 / 4.4-08 的离线口径 / 4.3-12 的脱敏延续）。
 *
 * 拆解与合并的规则本身在 `requirements.test.ts` 与 `requirements-model.test.ts` 里逐条断过了，
 * 这里只判服务这一层的四件事：入参校验、每类上限走配置、**模型腿的五种结局各能观测到、
 * 且除 merged 之外的四种结局交回来的序列就是词面基线**、日志只有计数没有 JD 正文。
 * 语料是**写在文件里的本地样例**（§7.2 不许碰真实招聘平台），公司名与手机号都是虚构。
 *
 * 模型腿用的是测试替身（`FakeChatService`）而不是真端点：本机没有对话模型的 key，
 * 而 4.4-02 要判的是「五态可区分 + 回落不断流」，那需要一个**可控**的回复。
 * 替身只在用例显式要求时才挂进装配——不挂就是真实装配里注掉 `llm` 那一行的形态（spec 4.4-02 的
 * 「装配缺包时功能照常」半边），这条判据只有分开挂才有意义。
 *
 * 4.4-08 的另一半（不联网）在这里是**结构性成立**而不是断言：替身一个端点都不碰、
 * 出网入口只在 `packages/llm` 由 `pnpm lint` 的 `check-llm-single-entry.ts` 机检。
 */
import { AppError, Context, Service, type ChatCompletionView, type ChatRequestView, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { LogService } from '@auto-cc/plugin-logger';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { KbGapService, type KbGapConfig } from './gap-service.js';
import { waitForLogLine } from './log-file.js';
import { REQUIREMENT_LEXICON_VERSION } from './requirements.js';
import { REQUIREMENT_PROMPT_VERSION } from './requirements-model.js';

/** 固定样例 JD（虚构）：四类齐全，正文里埋一句可当哨兵的长句与一个假手机号。 */
const SAMPLE_JD = [
  '后端工程师（星桥科技）',
  '负责订单与推荐链路的后端服务，技术栈以 Java、Go、Kafka 为主，联系电话 13800002222。',
  '要求本科及以上学历，3 年以上相关工作经验，抗压能力强。',
].join('\n');

/** 词表抓不到、只能靠模型腿补的一句（引文必须逐字来自 `SAMPLE_JD` 才会被采信）。 */
const LONG_TAIL_QUOTE = '负责订单与推荐链路的后端服务';

/** 一条会被采信的模型回复（契约见 `requirements-model.ts`）。 */
const GOOD_REPLY = `{"items":[{"kind":"hard_skill","label":"订单链路","quote":"${LONG_TAIL_QUOTE}"}]}`;

/** 装配用的默认配置（与 `cordis.yml` 的 `kb-gap` 段同源，改动要两边一起看）。 */
const DEFAULT_CONFIG: KbGapConfig = {
  perKindLimit: 12,
  minJdChars: 20,
  allowModelLeg: true,
  modelMaxTokens: 1200,
  modelTemperature: 0,
};

/** 替身的可调项（走 `static Config`，与真 `llm.chat` 同一条 cordis 传参路径，见 §9 实测 1.3）。 */
const fakeChatSchema = z.strictObject({
  available: z.boolean(),
  model: z.string().nullable(),
  reply: z.string(),
  fail: z.boolean(),
});

/**
 * 假的 `llm.chat`（spec 4.4-02 的单测替身，与 4.3-d 的 `FakeEmbedService` 同一种替身）。
 *
 * 只回一段写死的文本，可选地按指令抛 `LLM_REQUEST_FAILED`；`calls` 记下每次收到的消息序列，
 * 用来断言「不可用时一次都不发」（那是 `llm.chat` 自己的判据，这里当作替身的自检）。
 */
class FakeChatService extends Service {
  static provide = 'llm.chat';
  static Config = fakeChatSchema;

  /** 每次 `complete()` 收到的消息序列（断言提示词确实带着原文）。 */
  readonly calls: Array<Array<{ role: 'system' | 'user'; content: string }>> = [];

  constructor(
    ctx: Context,
    private readonly options: z.infer<typeof fakeChatSchema>,
  ) {
    super(ctx, 'llm.chat');
  }

  /** 契约见 `ChatGateway.status`。 */
  status(): { available: boolean; missing: Array<'baseUrl' | 'model' | 'apiKey'>; model: string | null } {
    if (!this.options.available) return { available: false, missing: ['baseUrl', 'model', 'apiKey'], model: null };
    return { available: true, missing: [], model: this.options.model };
  }

  /**
   * 契约见 `ChatGateway.complete`。
   * 不写成 `async`：存根里没有任何 `await` 表达式，加 `async` 只是白造一层微任务；
   * 契约要的是「返回 Promise」，失败半边用 `Promise.reject` 给的就是同一个被调用方 `catch` 住的错误。
   * 用普通方法而不是箭头属性：唯一的调用点是 `gateway.complete({...})`，`this` 由调用点绑定。
   */
  complete(request: ChatRequestView): Promise<ChatCompletionView> {
    this.calls.push(request.messages);
    if (this.options.fail) {
      return Promise.reject(
        new AppError('LLM_REQUEST_FAILED', '模型请求超时（测试存根）', 'llm.chat', { reason: 'timeout' }),
      );
    }
    return Promise.resolve({ text: this.options.reply, model: this.options.model ?? 'fake-model' });
  }
}

const tempDirs: string[] = [];
const fibers: Fiber[] = [];

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  // 日志写流是异步开文件的（同 profile-service.test.ts），删目录前给一次宽限期。
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放，清理失败不该把一次通过的验收判成失败。
    }
  }
});

/** 一次装配里模型腿的形态。 */
interface ChatSetup {
  /** 不给就是「装配里没有 llm.chat」——摘掉 `llm` 包那一行的形态 */
  reply?: string;
  available?: boolean;
  model?: string | null;
  fail?: boolean;
}

/**
 * 建一份只挂知识库拆解这一条链的装配。
 * @param config `kb.gap` 的覆盖项（不传就用 `DEFAULT_CONFIG`）——每类上限那条用例要靠它
 * @param chat 模型腿的形态；不传则连替身都不挂，本服务只能报 `unavailable`
 * @returns 服务实例、日志文件路径、替身实例（没挂时 null）与临时目录（目录进 `tempDirs` 由 afterAll 清）
 */
async function bootGap(config: Partial<KbGapConfig> = {}, chat?: ChatSetup) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-kb-gap-'));
  tempDirs.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(LogService, { level: 'info', buffer: 50, file: 'auto-cc.log', dir, redact: false }));
  let fake: FakeChatService | null = null;
  if (chat) {
    fibers.push(
      await ctx.plugin(FakeChatService, {
        available: chat.available ?? true,
        model: chat.model === undefined ? 'fake-jd-model' : chat.model,
        reply: chat.reply ?? GOOD_REPLY,
        fail: chat.fail ?? false,
      }),
    );
    fake = ctx.get('llm.chat');
  }
  fibers.push(await ctx.plugin(KbGapService, { ...DEFAULT_CONFIG, ...config }));
  return { gap: ctx.get('kb.gap') as unknown as KbGapService, fake, logFile: join(dir, 'auto-cc.log') };
}

describe('kb.gap 的拆解入口（spec 4.4-01 / 4.4-06）', () => {
  it('四类齐全，计数与词表版本随结果返回，且每条都是词面腿产的', async () => {
    const { gap } = await bootGap();
    const view = await gap.extract(SAMPLE_JD);
    const kinds = new Set(view.items.map((item) => item.kind));
    expect([...kinds].sort()).toEqual(['education', 'experience_years', 'hard_skill', 'soft_skill'].sort());
    expect(view.items.every((item) => item.via === 'lexicon')).toBe(true);
    expect(view.lexiconVersion).toBe(REQUIREMENT_LEXICON_VERSION);
    expect(view.droppedByLimit).toBe(0);
    expect(view.items.length).toBeGreaterThan(0);
  });

  it('先去空白再判长度：输入两端留白不影响 inputChars 与产出（界面粘贴的常见形态）', async () => {
    const { gap } = await bootGap();
    const padded = await gap.extract(`   \n${SAMPLE_JD}\n\n  `);
    const plain = await gap.extract(SAMPLE_JD);
    expect(padded.inputChars).toBe(SAMPLE_JD.length);
    expect(padded.inputChars).toBe(plain.inputChars);
    expect(JSON.stringify(padded.items)).toBe(JSON.stringify(plain.items));
  });

  it('过短的 JD 结构化失败，而不是给一份空报告（spec 4.4-01 的入参校验）', async () => {
    const { gap } = await bootGap();
    let caught: unknown;
    try {
      await gap.extract('后端工程师');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('INVALID_ARGUMENT');
    // 错误消息里带的必须是**字数**而不是 JD 正文（脱敏同样适用于错误路径）。
    expect((caught as AppError).message).toContain('字');
    expect((caught as AppError).message).not.toContain('后端工程师');
  });

  it('每类上限来自配置：调小之后只留稳定序列头部，丢弃条数如实报出', async () => {
    const { gap } = await bootGap({ perKindLimit: 1 });
    const capped = await gap.extract(SAMPLE_JD);
    const full = await (await bootGap()).gap.extract(SAMPLE_JD);
    const hard = capped.items.filter((item) => item.kind === 'hard_skill');
    expect(hard).toHaveLength(1);
    expect(hard[0]?.label).toBe(full.items.find((item) => item.kind === 'hard_skill')?.label);
    expect(capped.droppedByLimit).toBe(full.items.length - 4);
  });
});

describe('kb.gap 的模型腿五态（spec 4.4-02）', () => {
  it('merged：词面基线一条不少，模型补的长尾带上 via=model 与可对回原文的位置', async () => {
    const { gap, fake } = await bootGap({}, {});
    const view = await gap.extract(SAMPLE_JD);
    expect(view.modelStatus).toBe('merged');
    expect(view.modelReason).toBeNull();
    expect(view.model).toBe('fake-jd-model');
    expect(view.modelAdded).toBe(1);
    expect(view.promptVersion).toBe(REQUIREMENT_PROMPT_VERSION);
    expect(fake?.calls).toHaveLength(1);
    // 提示词里带的确实是这份原文，否则引文根本定位不回去（4.4-01 的位置判据）。
    expect(fake?.calls[0]?.at(1)?.content).toContain(LONG_TAIL_QUOTE);
    const fromModel = view.items.filter((item) => item.via === 'model');
    expect(fromModel.map((item) => item.label)).toEqual(['订单链路']);
    expect(SAMPLE_JD.slice(fromModel[0]?.start ?? -1, fromModel[0]?.end ?? -1)).toBe(fromModel[0]?.quote);
  });

  it('装配里没有 llm.chat：报 unavailable，产出就是词面基线（4.4-02 的功能不中断）', async () => {
    const lexicalOnly = await (await bootGap()).gap.extract(SAMPLE_JD);
    const baseline = await (await bootGap({}, { reply: '这不是 JSON' })).gap.extract(SAMPLE_JD);
    expect(lexicalOnly.modelStatus).toBe('unavailable');
    expect(lexicalOnly.modelReason).toContain('未装配');
    expect(lexicalOnly.promptVersion).toBeNull();
    expect(JSON.stringify(baseline.items)).toBe(JSON.stringify(lexicalOnly.items));
  });

  it('unavailable：配齐了替身但模型没配 key，一次请求都不发（spec 4.4-02 的「不发」）', async () => {
    const { gap, fake } = await bootGap({}, { available: false });
    const view = await gap.extract(SAMPLE_JD);
    expect(view.modelStatus).toBe('unavailable');
    expect(view.modelReason).toContain('缺');
    expect(fake?.calls).toHaveLength(0);
  });

  it('failed：请求抛错就回落，原因里带上那句可直接播报的话', async () => {
    const { gap } = await bootGap({}, { fail: true });
    const view = await gap.extract(SAMPLE_JD);
    expect(view.modelStatus).toBe('failed');
    expect(view.modelReason).toContain('问模型失败');
    expect(view.modelReason).toContain('超时');
    expect(view.promptVersion).toBe(REQUIREMENT_PROMPT_VERSION);
  });

  it('rejected：模型答得上来但一条都采不了信——引文对不上原文', async () => {
    const { gap } = await bootGap(
      {},
      { reply: '{"items":[{"kind":"hard_skill","label":"Flink","quote":"精通 Flink"}]}' },
    );
    const view = await gap.extract(SAMPLE_JD);
    expect(view.modelStatus).toBe('rejected');
    expect(view.modelDropped).toBe(1);
    expect(view.modelReason).toContain('无法采信');
    expect(view.items.every((item) => item.via === 'lexicon')).toBe(true);
  });

  it('rejected：模型报的与词面腿完全重复时也不虚增条数', async () => {
    const { gap } = await bootGap({}, { reply: '{"items":[{"kind":"hard_skill","label":"Java","quote":"Java"}]}' });
    const view = await gap.extract(SAMPLE_JD);
    expect(view.modelStatus).toBe('rejected');
    expect(view.modelAdded).toBe(0);
    expect(view.modelDropped).toBe(1);
    expect(view.modelReason).toContain('完全重复');
  });

  it('disabled：allowModelLeg=false 时不碰模型，哪怕替身是可用状态', async () => {
    const { gap, fake } = await bootGap({ allowModelLeg: false }, {});
    const view = await gap.extract(SAMPLE_JD);
    expect(view.modelStatus).toBe('disabled');
    expect(view.modelReason).toContain('allowModelLeg');
    expect(view.promptVersion).toBeNull();
    expect(fake?.calls).toHaveLength(0);
  });

  it('温度取 0：拆解是读数不是创作（4.4-07 的稳定判据）', () => {
    expect(DEFAULT_CONFIG.modelTemperature).toBe(0);
  });
});

describe('kb.gap 的日志脱敏（延续 spec 4.3-12 的口径）', () => {
  it('日志里只有四类计数与腿状态，查不到 JD 正文、手机号与模型原文', async () => {
    const { gap, logFile } = await bootGap({}, {});
    await gap.extract(SAMPLE_JD);
    const logText = await waitForLogLine(logFile, '[kb-gap] 拆解');
    expect(logText).toMatch(
      /\[kb-gap\] 拆解 \d+ 字 → 词面 \d+ 条（硬技能 \d+ \/ 软技能 \d+ \/ 学历 \d+ \/ 年限 \d+，丢弃 \d+） · 模型腿 merged 并入 \d+ 条/,
    );
    for (const sentinel of [LONG_TAIL_QUOTE, '13800002222', '星桥科技', '抗压能力', '订单链路']) {
      expect(logText).not.toContain(sentinel);
    }
  });

  it('回落那一路走 warn，让「没用上模型」在日志里也是显眼的', async () => {
    const { gap, logFile } = await bootGap({}, { available: false });
    await gap.extract(SAMPLE_JD);
    const logText = await waitForLogLine(logFile, '模型腿 unavailable');
    expect(logText).toContain('WARN');
  });
});
