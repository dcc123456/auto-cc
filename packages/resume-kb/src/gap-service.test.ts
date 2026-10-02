/**
 * `kb.gap` 的装配用例（spec 4.4-01 的入参边界 / 4.4-02 的模型腿五态与可见回落 /
 * 4.4-03 / 04 的三态比对与反向比对 / 4.4-06 的计数与建议可见 / 4.4-07 的全链确定性 /
 * 4.4-08 的离线口径 / 4.3-12 的脱敏延续）。
 *
 * 拆解与合并的规则本身在 `requirements.test.ts` 与 `requirements-model.test.ts` 里逐条断过了，
 * 三态怎么定、两道闸怎么设则在 `requirements-compare.test.ts` 的纯函数层断言；
 * 这里只判服务这一层的事：入参校验、每类上限走配置、**模型腿的五种结局各能观测到、
 * 且除 merged 之外的四种结局交回来的序列就是词面基线**、比对确实接的是 `kb.profile`、日志只有计数没有正文。
 * 语料是**写在文件里的本地样例**（§7.2 不许碰真实招聘平台），公司名与手机号都是虚构。
 *
 * 4.4-c 那组用例挂**真的 `node:sqlite` + 真派生结果**（简历文本经 4.1 区块解析、4.2 实体派生入库）：
 * 「拆出来的要求能不能比回库里那些行」只在真实装配路径上才成立，手写一批实体当库等于没接库（§2.1）。
 * 全链 hash（4.4-07）也在这一组里复跑——拆解腿那半边的 hash 稳定在 4.4-a 已归档。
 *
 * 模型腿用的是测试替身（`FakeChatService`）而不是真端点：本机没有对话模型的 key，
 * 而 4.4-02 要判的是「五态可区分 + 回落不断流」，那需要一个**可控**的回复。
 * 替身只在用例显式要求时才挂进装配——不挂就是真实装配里注掉 `llm` 那一行的形态（spec 4.4-02 的
 * 「装配缺包时功能照常」半边），这条判据只有分开挂才有意义。
 *
 * 4.4-08 的另一半（不联网）在这里是**结构性成立**而不是断言：替身一个端点都不碰、
 * 出网入口只在 `packages/llm` 由 `pnpm lint` 的 `check-llm-single-entry.ts` 机检。
 */
import {
  AppError,
  Context,
  Service,
  asApp,
  type ChatCompletionView,
  type ChatRequestView,
  type Fiber,
} from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { LogService } from '@auto-cc/plugin-logger';
import { ResumeDocService } from '@auto-cc/plugin-resume-doc';
import { StoreService } from '@auto-cc/plugin-store';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { KbGapService, type KbGapConfig, type GapReportView } from './gap-service.js';
import { waitForLogLine } from './log-file.js';
import { KbProfileService, kbProfileSchema } from './profile-service.js';
import { parseResumeText } from './sections.js';
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
  evidenceTopK: 3,
  evidenceHitMinScore: 0.62,
  evidencePartialMinScore: 0.3,
  yearsPartialRatio: 0.6,
  highlightMinScore: 0.12,
  maxHighlights: 6,
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

/**
 * 撑起缺口报告的库语料（虚构）。
 *
 * 两段经历**首尾相接**（2021.07-2024.06 与 2024.07 至今）是有意的：它让「相邻区间连成一段」这条
 * 判据在真派生结果上被走到，而不是只在纯函数用例里成立。「教育经历」那段决定学历腿有没有据
 * （4.2 裁定二：学历不产实体行，档位只能从区块切片读）。
 */
const LIBRARY_MD = [
  '张三',
  '电话：13800002222',
  '',
  '## 教育经历',
  '江海大学｜软件工程 本科 2017.09-2021.06',
  '辅修分布式系统，完成过千万级日志处理的课程设计。',
  '',
  '## 工作经历',
  '星桥科技｜后端工程师 2021.07-2024.06',
  '- 主导订单服务重构，把 P99 延迟压下降 40%。',
  '',
  '沧海数据｜架构师 2024.07至今',
  '- 负责推荐接口的容量规划与稳定性治理。',
  '',
  '## 技能',
  '- Java、Spring Boot、MySQL',
  '- Kubernetes、Docker、Grafana',
].join('\n');

/** `report()` 的判定基准时刻（2026 年 10 月，用本地时间构造，与 `monthKeyOf` 同一套时区口径）。 */
const AS_OF_MS = new Date(2026, 9, 15, 12).getTime();

/** 入库用的文档 id。 */
const LIBRARY_DOC_ID = 'resume-gap-report';

/**
 * 建一份「拆解 + 真库」的装配：config + log + store + resume.doc + kb.profile + kb.gap。
 *
 * 库里那几行不是手写的，而是**从简历文本经 4.1 的区块解析与 4.2 的实体派生**得到的——
 * 本条用例要判的正是「拆出来的要求能不能比回真实派生结果」，自己造一批实体等于没接库（AGENTS.md §2.1）。
 * @param gapConfig `kb.gap` 的覆盖项（亮点上限那条用例靠它）
 * @returns 缺口服务、实体服务与日志文件路径
 */
async function bootGapWithLibrary(gapConfig: Partial<KbGapConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-kb-gap-lib-'));
  tempDirs.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(LogService, { level: 'info', buffer: 200, file: 'auto-cc.log', dir, redact: false }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(ResumeDocService, {}));
  // 配置项一律取 schema 的默认值（与 `cordis.yml` 同源），不在测试里另抄一份阈值。
  fibers.push(await ctx.plugin(KbProfileService, kbProfileSchema.parse({})));
  fibers.push(await ctx.plugin(KbGapService, { ...DEFAULT_CONFIG, ...gapConfig }));
  const app = asApp(ctx);
  const parsed = parseResumeText(LIBRARY_MD, LIBRARY_DOC_ID, AS_OF_MS);
  if (parsed.status !== 'ok') throw new Error(`语料解析失败：${parsed.status}`);
  app['resume.doc'].save(parsed.document);
  app['kb.profile'].sync(LIBRARY_DOC_ID, AS_OF_MS);
  return { gap: app['kb.gap'], kb: app['kb.profile'], logFile: join(dir, 'auto-cc.log') };
}

/**
 * 取日志里最后一条含标记的那一行（整份文本一起断言会把上一条评论带进来，级别就判不准了）。
 * @param text `waitForLogLine` 拿到的完整日志文本
 * @param needle 定位用的子串
 * @returns 最后一行命中；没有命中时返回空串（调用方的正则断言随即失败，不给假通过）
 */
function lastLogLine(text: string, needle: string): string {
  return (
    text
      .split('\n')
      .filter((line) => line.includes(needle))
      .at(-1) ?? ''
  );
}

describe('kb.gap.report 的三态比对与反向比对（spec 4.4-03 / 4.4-04 / 4.4-07）', () => {
  it('每条实体证据都能从库里原样读回，三态计数与行数对得上', async () => {
    const { gap, kb } = await bootGapWithLibrary();
    const view = await gap.report(SAMPLE_JD, {}, AS_OF_MS);
    expect(view.entityCount).toBeGreaterThan(0);
    expect(view.rows).toHaveLength(view.items.length);
    expect(view.counts.matched + view.counts.partial + view.counts.missing).toBe(view.rows.length);
    let checked = 0;
    for (const row of view.rows) {
      for (const evidence of row.evidence) {
        if (evidence.origin !== 'entity') continue;
        expect(kb.get(evidence.id)).not.toBeNull();
        checked += 1;
      }
      // 命中与部分命中必须带据，缺失必须一条据都不给（4.4-03 的判据）。
      expect(row.state === 'missing' ? row.evidence.length === 0 : row.evidence.length > 0).toBe(true);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('年限腿在真库上走算术：首尾相接的两段合并成一段，换算成年后判命中', async () => {
    const { gap } = await bootGapWithLibrary();
    const view = await gap.report(SAMPLE_JD, {}, AS_OF_MS);
    // 2021.07 → 2026.10 连成一段 = 64 个月 = 5 整年 ≥ JD 要的 3 年
    expect(view.totalExperienceMonths).toBe(64);
    const yearsRow = view.rows.find((row) => row.item.kind === 'experience_years');
    expect(yearsRow?.state).toBe('matched');
    expect(yearsRow?.suggestion).toBeNull();
    expect(view.asOfMonth).toBe('2026-10');
  });

  it('学历腿从区块切片取档位，证据 id 落在切片而不是实体上（4.2 裁定二）', async () => {
    const { gap } = await bootGapWithLibrary();
    const view = await gap.report(SAMPLE_JD, {}, AS_OF_MS);
    const eduRow = view.rows.find((row) => row.item.kind === 'education');
    expect(eduRow?.state).toBe('matched');
    expect(view.libraryEducationRank).toBe(2);
    const chunkEvidence = eduRow?.evidence.filter((one) => one.origin === 'section_chunk') ?? [];
    expect(chunkEvidence).toHaveLength(1);
    expect(chunkEvidence[0]?.id).not.toBe('');
  });

  it('同一 JD + 同一库连跑两次，整份报告的 hash 逐字相同（4.4-07 的全链判据）', async () => {
    const first = await (await bootGapWithLibrary()).gap.report(SAMPLE_JD, {}, AS_OF_MS);
    const second = await (await bootGapWithLibrary()).gap.report(SAMPLE_JD, {}, AS_OF_MS);
    /**
     * 整份报告的稳定摘要（截取 16 位足够比对，全文进断言消息会太长）。
     * @param view 报告读数
     * @returns sha256 前 16 位
     */
    const digest = (view: GapReportView) =>
      createHash('sha256').update(JSON.stringify(view)).digest('hex').slice(0, 16);
    expect(digest(second)).toBe(digest(first));
  });

  it('filter 一路递到库里：只比技能类实体时证据全属技能类，且参与比对的实体变少', async () => {
    const { gap, kb } = await bootGapWithLibrary();
    const all = await gap.report(SAMPLE_JD, {}, AS_OF_MS);
    const skillsOnly = await gap.report(SAMPLE_JD, { kind: 'skill' }, AS_OF_MS);
    expect(skillsOnly.entityCount).toBeLessThan(all.entityCount);
    for (const row of skillsOnly.rows) {
      for (const evidence of row.evidence.filter((one) => one.origin === 'entity')) {
        expect(kb.get(evidence.id)?.kind).toBe('skill');
      }
    }
  });

  it('亮点候选受配置上限约束，被截掉的条数随报告一起返回', async () => {
    const uncapped = await (await bootGapWithLibrary()).gap.report(SAMPLE_JD, {}, AS_OF_MS);
    const capped = await (await bootGapWithLibrary({ maxHighlights: 0 })).gap.report(SAMPLE_JD, {}, AS_OF_MS);
    expect(capped.highlights).toEqual([]);
    expect(capped.highlightsDropped).toBe(uncapped.highlights.length);
    for (const highlight of uncapped.highlights) {
      expect(['skill', 'achievement']).toContain(highlight.kind);
      // 亮点是「JD 没提」那一侧的读数，不该与拆解出的要求撞车
      expect(highlight.relatedTokens.length).toBeGreaterThan(0);
    }
  });

  it('库里没有 kb.profile 时结构化失败：报告没有可比对象，而不是给一份全缺失的假报告', async () => {
    const { gap } = await bootGap();
    let caught: unknown;
    try {
      await gap.report(SAMPLE_JD, {}, AS_OF_MS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('KB_LIBRARY_MISSING');
    expect((caught as AppError).message).not.toContain('星桥科技');
  });
});

describe('kb.gap.report 的日志与播报（spec 4.4-06 / 4.3-12 的口径延续）', () => {
  it('比对日志只有计数与截止日期，查不到 JD 正文、库内正文与手机号', async () => {
    const { gap, logFile } = await bootGapWithLibrary();
    await gap.report(SAMPLE_JD, {}, AS_OF_MS);
    const line = lastLogLine(await waitForLogLine(logFile, '[kb-gap] 比对'), '[kb-gap] 比对');
    expect(line).toMatch(
      /\[kb-gap\] 比对：要求 \d+ 条 → 命中 \d+ \/ 部分 \d+ \/ 缺失 \d+ · 亮点候选 \d+（丢弃 \d+） · 库内实体 \d+ 条 · 经验合计 \d+ 月 · 截至 2026-10/,
    );
    expect(line).toContain('INFO');
    for (const sentinel of ['13800002222', '星桥科技', '抗压能力', '订单服务重构', 'Java']) {
      expect(line).not.toContain(sentinel);
    }
  });

  it('整份报告一条都没命中时那一行走 warn，让「这岗位不合适」在日志里也显眼', async () => {
    const { gap, logFile } = await bootGapWithLibrary();
    const view = await gap.report('要求精通 Rust、Zig 与 Unison，博士及以上学历，15 年以上经验。', {}, AS_OF_MS);
    expect(view.counts.matched).toBe(0);
    const line = lastLogLine(await waitForLogLine(logFile, '[kb-gap] 比对'), '[kb-gap] 比对');
    expect(line).toContain('WARN');
    expect(line).toContain('命中 0');
  });
});
