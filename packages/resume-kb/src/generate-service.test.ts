/**
 * `resume.generate` 的装配用例（spec 4.5-01 / 02 / 05 / 06 / 09 / 10 / 12 / 14 的服务半边）。
 *
 * 三条规则本身已经在纯函数层断过了：顺序在 `generate-reorder.test.ts`、回答形状在
 * `generate-model.test.ts`、判据在 `fact-check.test.ts`。本文件只判**装配层**的事：
 * 产物是不是合法文档、拒绝时是不是真的没有产物、被拒那一轮是不是仍落一行记录、
 * 降级是不是可见、证据 id 是不是能读回、以及日志与库里查得到哨兵吗。
 *
 * 语料与 JD 都是自造的虚构中文简历，**不碰真实招聘平台**（§7.2）。
 * 两条腿共用同一个 `llm.chat`，所以 `kb.gap` 的模型腿在装配里**关掉**（`GAP_CONFIG`）——
 * 不关掉的话替身的调用计数里会混进拆解腿那一次，「一次都不发」「恰好两次」这类判据就不成立了；
 * 关掉之后本用例仍然拿到真实的相关性读数，词面腿就是缺口报告的基线（spec 4.4-02）。
 *
 * 4.5-14 的哨兵按判据七**植入**，四条各占一条通道（每条都有正向对照，没植进去时用例自己会红）：
 * 1. 简历抬头的手机号 → 4.1-09 在解析那一刻就掩码，产物里只有掩码形态；
 * 2. 经历正文里的邮箱 → 同上，但它住在**可改写的散文键**里，会随提示词出网；
 * 3. 模型回复里新增的手机号 → 数值守恒判据把它抓下来，违规行、重试提示词与生成记录里只剩掩码形态；
 * 4. JD 原文里的手机号 → 只进拆解，不许出现在证据 label / token、日志与记录行里。
 * 四条哨兵的原始串在**整份返回体**（含 `document` 本体）、日志文件、生成记录表三处一律查不到——
 * 这是 4.5-14 的字面口径；做得到是因为第 1/2 条被解析层挡在前面、第 3 条被数值判据挡在采纳之前。
 * 已知残余（如实记下，不写成"全拦住了"）：模型若往散文里新增一个**不含数字**的邮箱，三条判据都抓不到，
 * 它会原样进产物，由 4.5-11 的逐项人工接受兜底。
 */
import { AppError, Context, NO_CONFIG, asApp, numbersOf, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { LogService } from '@auto-cc/plugin-logger';
import { documentSchema, ResumeDocService, validateDocument, type ResumeDocument } from '@auto-cc/plugin-resume-doc';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { deriveEntities } from './entities.js';
import { generationTargetFields, type GenerationField } from './fact-check.js';
import {
  GENERATION_OUTCOMES,
  kbGenerateSchema,
  MAX_PENDING_PROPOSALS,
  RESUME_GENERATION_MIGRATION_VERSION,
  ResumeGenerateService,
  type GenerationRewriteView,
  type GenerationView,
  type KbGenerateConfig,
} from './generate-service.js';
import { preservesAllEntries } from './generate-reorder.js';
import { GENERATE_PROMPT_VERSION } from './prompts.js';
import { KbGapService, kbGapSchema } from './gap-service.js';
import { waitForLogLine } from './log-file.js';
import { KbProfileService, kbProfileSchema } from './profile-service.js';
import { parseResumeText } from './sections.js';
import { FakeAgentToolsService, FakeChatService } from './test-doubles.js';

/** 简历抬头的手机号（通道 1）：`redactText` 的手机号掩码是「前三后四」。 */
const PII_CORPUS_PHONE = '13800005555';
const MASKED_CORPUS_PHONE = '138****5555';
/** 经历正文里的邮箱（通道 2）：住在可改写散文键上，因此会进提示词。 */
const PII_CORPUS_EMAIL = 'zhangsan.tester@example.invalid';
/** 模型回复里新增的手机号（通道 3）：只有数值守恒判据认得它是"多出来的一个数"。 */
const PII_REPLY_PHONE = '13800009876';
const MASKED_REPLY_PHONE = '138****9876';
/** JD 原文里的招聘方电话（通道 4）：不是用户的信息，但同样不许随读数外流。 */
const PII_JD_PHONE = '13800002222';

/**
 * 装配用简历（虚构）。
 *
 * 区块顺序是有意的：技能区块排在最后，而样例 JD 的词面腿只命中技能行与学历，
 * 于是"有证据的区块被提前"在真实派生结果上必然发生（4.5-02 要的是真动过位置，不是断言一个空列表）。
 * 两段经历首尾相接同 4.4-c 的语料口径。正文里的手机号与邮箱写成**原始形态**，
 * 由解析层负责掩码——用例断言的正是"掩码发生在生成轨之前"。
 */
const CORPUS_MD = [
  '张三',
  `电话：${PII_CORPUS_PHONE}`,
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
  `- 负责推荐接口的容量规划与稳定性治理，对外接口文档见 ${PII_CORPUS_EMAIL}。`,
  '',
  '## 技能',
  '- Java、Spring Boot、MySQL',
  '- Kubernetes、Docker、Grafana',
].join('\n');

/** 样例 JD（虚构）：词面腿命中技能与学历，正文里带一条招聘方电话当哨兵。 */
const SAMPLE_JD = [
  '后端工程师（星桥科技）',
  `负责订单与推荐链路的后端服务，技术栈以 Java、Go、Kubernetes 为主，简历投至 ${PII_JD_PHONE}。`,
  '要求本科及以上学历，3 年以上相关工作经验，抗压能力强。',
].join('\n');

/** 判定基准时刻（2026 年 10 月，与 4.4-c 同一口径；两次运行要比 hash 就必须钉死时钟）。 */
const AS_OF_MS = new Date(2026, 9, 15, 12).getTime();

/** 入库用的文档 id。 */
const DOC_ID = 'resume-generate';

/** 生成轨配置的出厂值：不在测试里手抄阈值（同 4.4 的 `DEFAULT_CONFIG` 判断）。 */
const DEFAULT_GENERATE_CONFIG: KbGenerateConfig = kbGenerateSchema.parse({});

/** 缺口腿的出厂值 + 关掉它的模型腿（理由见文件头）。 */
const GAP_CONFIG = { ...kbGapSchema.parse({}), allowModelLeg: false };

const tempDirs: string[] = [];
const fibers: Fiber[] = [];

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  // 日志写流是异步开文件的（同 gap-service.test.ts），删目录前给一次宽限期。
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放，清理失败不该把一次通过的验收判成失败。
    }
  }
});

/** 一次装配里模型腿的形态；不给就是「装配里没有 llm.chat」。 */
interface ChatSetup {
  /**
   * 按次取用的回复（用尽后重复最后一条）。
   * 传空数组表示「只把替身挂进装配、不指望它被问到」（`allowModelLeg=false` 与纯重排那几条用例），
   * 此时给一条合法但内容为空清单的兜底回复：万一真的被问了，`readModelRewrites` 会报
   * 「模型未提出任何改写」而不是抛错，用例的调用计数断言随即把这条差异暴露出来。
   */
  replies?: string[];
  available?: boolean;
  model?: string | null;
  fail?: boolean;
}

/** 替身配置里 `replies` 的 `.min(1)` 与"挂上但不指望被问"这对需求的接缝（见 `ChatSetup.replies`）。 */
const NEVER_ASKED_REPLY = '{"entries":[]}';

/**
 * 建一份「真库 + 生成轨」的装配：config + log + store + resume.doc + kb.profile + agent.tools + kb.gap + resume.generate。
 *
 * 库里那几行不是手写的，而是**从简历文本经 4.1 区块解析、4.2 实体派生**得到的：本文件要判的
 * 正是"生成的顺序与证据回指得到库里真实的那几行"，自己造一批实体等于没接库（AGENTS.md §2.1）。
 * @param generateConfig `kb.generate` 的覆盖项（`allowModelLeg` 那条用例靠它）
 * @param chat 模型腿的形态；不传则连替身都不挂，生成轨只能报 `unavailable`
 * @returns 生成服务、实体服务、装配与 store 句柄、agent 工具替身、聊天替身、日志文件路径与工作副本基线
 */
async function bootGenerate(generateConfig: Partial<KbGenerateConfig> = {}, chat?: ChatSetup) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-kb-generate-'));
  tempDirs.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(LogService, { level: 'info', buffer: 200, file: 'auto-cc.log', dir, redact: false }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(ResumeDocService, {}));
  fibers.push(await ctx.plugin(KbProfileService, kbProfileSchema.parse({})));
  // 注册表先于本服务上岗：`registerAgentTools` 是软取，晚挂载就只能登记出 0 个工具（双入口的判据）。
  fibers.push(await ctx.plugin(FakeAgentToolsService, NO_CONFIG));
  let fake: FakeChatService | null = null;
  if (chat) {
    fibers.push(
      await ctx.plugin(FakeChatService, {
        available: chat.available ?? true,
        model: chat.model === undefined ? 'fake-generate-model' : chat.model,
        replies: chat.replies ?? [NEVER_ASKED_REPLY],
        fail: chat.fail ?? false,
      }),
    );
    fake = ctx.get('llm.chat');
  }
  fibers.push(await ctx.plugin(KbGapService, GAP_CONFIG));
  fibers.push(await ctx.plugin(ResumeGenerateService, { ...DEFAULT_GENERATE_CONFIG, ...generateConfig }));
  const app = asApp(ctx);
  const parsed = parseResumeText(CORPUS_MD, DOC_ID, AS_OF_MS);
  if (parsed.status !== 'ok') throw new Error(`语料解析失败：${parsed.status}`);
  app['resume.doc'].save(parsed.document);
  app['kb.profile'].sync(DOC_ID, AS_OF_MS);
  return {
    gen: app['resume.generate'],
    kb: app['kb.profile'],
    app,
    db: app.store.db,
    tools: ctx.get('agent.tools') as unknown as FakeAgentToolsService,
    fake,
    logFile: join(dir, 'auto-cc.log'),
    baseline: parsed.document,
  };
}

/**
 * 取一个**会被数值判据抓到**的待改写位置：把阿拉伯数字打码之后文本确实变了、且数值多重集少了。
 *
 * 为什么不只按 `numbersOf(text).length > 0` 筛：教育正文里那句「千万级日志」是中文数词，
 * 打码它（`\d` 替换）文本不变，`readModelRewrites` 会按"与原文逐字相同"丢弃那条改写，
 * 于是"第一轮动数值"变成"第一轮没返回可采信的改写"——用例判的就不是同一件事了。
 * @param targetFields 生成轨的待改写清单（`generationTargetFields` 的产物）
 * @returns 清单里第一个含阿拉伯数字的可改写位置
 * @throws 语料里没有带数字的散文段时直接失败——那是测试自己写错，宁可红也不空跑（判据七）
 */
function numberedTarget(targetFields: readonly GenerationField[]): GenerationField {
  const target = targetFields.find((field) => /\d/.test(field.text) && numbersOf(field.text).length > 0);
  if (target === undefined) throw new Error('语料里没有带阿拉伯数字的可改写散文段，数值守恒用例失去前提');
  return target;
}

/**
 * 拼一条模型回复（契约见 `generate-model.ts` 的 `strictObject`）。
 * @param target 待改写位置（位置由服务给的清单来，不是测试自己编的 id）
 * @param text 该位置的新写法
 * @returns 可直接当替身回复的 JSON 串
 */
function replyFor(target: GenerationField, text: string): string {
  return JSON.stringify({
    entries: [{ sectionId: target.sectionId, entryId: target.entryId, fieldKey: target.fieldKey, text }],
  });
}

/** 合法改写：原句照抄，末尾接一句不含数字与机构名的方向陈述——两条判据都必然通过。 */
function safeRewriteOf(target: GenerationField): string {
  return `${target.text}，方向与岗位要求一致。`;
}

/** 必失败改写：把阿拉伯数字全部打码，数值多重集必然少数（spec 4.5-08 的那一类篡改）。 */
function numberLosingRewriteOf(target: GenerationField): string {
  return target.text.replace(/\d/g, '#');
}

/** 凭空补一个手机号：数值守恒判据的"多一个数"半边，同时是 4.5-14 通道 3 的植入点。 */
function phoneAddingRewriteOf(target: GenerationField): string {
  return `${target.text} 需要沟通可拨 ${PII_REPLY_PHONE}。`;
}

/**
 * 查生成记录表的全部行（复盘视角，列名原样返回）。
 * @param db store 的连接句柄
 * @returns 按写入顺序排列的行
 */
function generationRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM resume_generations ORDER BY rowid').all();
}

/**
 * 按字节读回库里那份工作副本（`updated_at` + `doc_json`），用来断言"这次表态到底写没写盘"。
 * @param db store 的连接句柄
 * @returns 两个字段拼的对象；行不存在时抛错——那是装配问题，不能让比较悄悄通过
 */
function dbCopy(db: DatabaseSync): { updatedAt: number; body: string } {
  const row = db.prepare('SELECT updated_at, doc_json AS body FROM resume_docs WHERE id = ?').get(DOC_ID) as
    { updated_at?: number | bigint; body?: string } | undefined;
  if (row === undefined) throw new Error(`工作副本 ${DOC_ID} 没落进 resume_docs：装配或建表出了问题`);
  return { updatedAt: Number(row.updated_at ?? -1), body: String(row.body ?? '') };
}

/**
 * 取日志里最后一条含标记的那一行（整份文本一起断言会把上一条评论带进来，级别就判不准了）。
 * @param text `waitForLogLine` 拿到的完整日志文本
 * @param needle 定位用的子串
 * @returns 最后一行命中；没有命中时返回空串（调用方的断言随即失败，不给假通过）
 */
function lastLogLine(text: string, needle: string): string {
  return (
    text
      .split('\n')
      .filter((line) => line.includes(needle))
      .at(-1) ?? ''
  );
}

/**
 * 把文档摊成「位置 → 字段值」的表，用于断言"只有被要求改写的那一处变了"。
 * @param document 待摊平的文档
 * @returns 键为 `区块id#条目id#字段键` 的映射
 */
function fieldValuesByLocation(document: ResumeDocument): Map<string, string> {
  const values = new Map<string, string>();
  for (const section of document.sections) {
    for (const entry of section.entries) {
      for (const field of entry.fields) {
        values.set(`${section.id}#${entry.id}#${field.key}`, field.value);
      }
    }
  }
  return values;
}

describe('resume.generate 的产物面与 Schema（spec 4.5-01 / 12）', () => {
  it('模型腿给出合法改写时产出提议态文档：过 P3 Schema、顶层键与 schema 完全一致、且只改了这一处', async () => {
    const boot = await bootGenerate({}, {});
    const target = numberedTarget(generationTargetFields(boot.baseline));
    const rewritten = safeRewriteOf(target);
    const { gen, fake } = await bootGenerate({}, { replies: [replyFor(target, rewritten)] });
    const view = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    expect(view.document).not.toBeNull();
    expect(view.receipt.outcome).toBe('rewritten');
    // 4.5-12 的机检半边：同一份 JSON 过 P3 的权威校验，且序列化一圈回来仍是合法文档（要过 IPC）。
    const roundTrip = JSON.parse(JSON.stringify(view.document)) as ResumeDocument;
    expect(validateDocument(roundTrip).ok).toBe(true);
    expect(Object.keys(roundTrip).sort()).toEqual(Object.keys(documentSchema.shape).sort());
    // 未被要求改动的地方逐字相同：整份文档只允许那一个位置的值发生变化（4.5-03 的原样引用半边）。
    const before = fieldValuesByLocation(boot.baseline);
    const after = fieldValuesByLocation(roundTrip);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    const changed = [...after.keys()].filter((key) => before.get(key) !== after.get(key));
    expect(changed).toEqual([`${target.sectionId}#${target.entryId}#${target.fieldKey}`]);
    expect(after.get(changed[0] as string)).toBe(rewritten);
    expect(view.checks.ok).toBe(true);
    expect(view.checks.retried).toBe(false);
    // 逐项接受的行（4.5-11 的数据面）：除了"改成什么"，还带"改的是哪一段、原文逐字是什么、
    // 原文出自库里哪条实体"。原文取自工作副本而不是模型回报——界面上"改前"那一栏必须是用户自己的话。
    const rewriteRow = view.rewrites[0] as GenerationRewriteView;
    expect(rewriteRow).toMatchObject({
      sectionId: target.sectionId,
      entryId: target.entryId,
      fieldKey: target.fieldKey,
      originalText: target.text,
      rewrittenText: rewritten,
    });
    expect(view.rewrites).toHaveLength(1);
    expect(rewriteRow.sectionTitle.length).toBeGreaterThan(0);
    expect(rewriteRow.entryLabel.length).toBeGreaterThan(0);
    // 出处 id 只能指向这份文档派生出来的实体（4.5-06 的收口：认领方式是载荷逐字相等，不是猜）
    const derivedEntityIds = new Set(deriveEntities(boot.baseline).map((draft) => draft.entityId));
    expect(rewriteRow.sourceEvidenceIds.every((id) => derivedEntityIds.has(id))).toBe(true);
    // 两种空态分得开（4.5-06 的播报半边）：`entryModeled` 就是那一位——派生过实体行却给不出 id，
    // 才是"逐字载荷回查不到、这句要人工确认"；没派生过实体行是区块形态使然，不是漏判。
    expect(rewriteRow.entryModeled).toBe(
      deriveEntities(boot.baseline).some((draft) => draft.entryId === rewriteRow.entryId),
    );
    expect(view.rewrites.every((row) => row.sourceEvidenceIds.length === 0 || row.entryModeled)).toBe(true);
    expect(view.receipt.model).toBe('fake-generate-model');
    expect(view.receipt.promptVersion).toBe(GENERATE_PROMPT_VERSION);
    expect(fake?.calls).toHaveLength(1);
  });

  it('工作副本不存在时结构化失败，不给一份空白简历（4.5-01 的入参半边）', async () => {
    const { gen } = await bootGenerate();
    let caught: unknown;
    try {
      await gen.run(SAMPLE_JD, { docId: 'no-such-doc' }, AS_OF_MS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('KB_SOURCE_MISSING');
    expect((caught as AppError).message).toContain('导入');
  });

  it('库里多份简历而没指定 docId 时报歧义，不替用户挑一份', async () => {
    const { gen, app, baseline } = await bootGenerate();
    app['resume.doc'].save({ ...baseline, id: 'second-doc' });
    app['kb.profile'].sync('second-doc', AS_OF_MS);
    let caught: unknown;
    try {
      await gen.run(SAMPLE_JD, {}, AS_OF_MS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('INVALID_ARGUMENT');
    expect((caught as AppError).message).toContain('docId');
  });

  it('省略 docId 且库里恰好一份时自动选中（对话入口不必先查 id）', async () => {
    const { gen } = await bootGenerate();
    const view = await gen.run(SAMPLE_JD, {}, AS_OF_MS);
    expect(view.receipt.docId).toBe(DOC_ID);
  });
});

describe('resume.generate 的重排腿（spec 4.5-02）', () => {
  it('顺序由 4.4 的证据强度决定：拿分的对象被提前，依据里带命中的要求与证据 id', async () => {
    const { gen, baseline } = await bootGenerate({}, {});
    const view = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    expect(view.reorderBases).toHaveLength(view.receipt.movedSections + view.receipt.movedEntries);
    // 这份语料 + 这份 JD 必然真动过位置（技能区块基线在最后，而词面腿只命中技能行与学历）。
    expect(view.receipt.movedSections + view.receipt.movedEntries).toBeGreaterThan(0);
    for (const basis of view.reorderBases) {
      expect(basis.fromIndex).not.toBe(basis.toIndex);
      // 「它不是不相关，是没拿到据」：零分对象的依据必空，有依据的必带分。
      expect(basis.score > 0).toBe(basis.hits.length > 0);
      for (const hit of basis.hits) {
        expect(hit.evidenceId).not.toBe('');
        expect(hit.score).toBeGreaterThan(0);
      }
    }
    // 只换序不改内容：条目与字段总数守恒，区块集合不变。
    expect(view.document).not.toBeNull();
    expect(preservesAllEntries(baseline, view.document?.sections ?? [])).toBe(true);
    expect([...(view.document?.sections.map((section) => section.id) ?? [])].sort()).toEqual(
      baseline.sections.map((section) => section.id).sort(),
    );
  });

  it('同一份 JD + 同一份工作副本连跑两次：文档、证据与重排依据逐字相同（4.5-07 的确定性）', async () => {
    const first = await (await bootGenerate()).gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    const second = await (await bootGenerate()).gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    expect(JSON.stringify(second.document)).toBe(JSON.stringify(first.document));
    expect(JSON.stringify(second.reorderBases)).toBe(JSON.stringify(first.reorderBases));
    expect(JSON.stringify(second.evidence)).toBe(JSON.stringify(first.evidence));
    // 凭证里的一次性读数不参与比较：id 每次新生成，时间戳由入参钉死。
    expect(second.receipt.id).not.toBe(first.receipt.id);
    expect(second.receipt.createdAt).toBe(first.receipt.createdAt);
  });
});

describe('resume.generate 的证据反查（spec 4.5-06）', () => {
  it('每条证据都回指本份文档的派生实体，且能从库里原样读回正文；返回体里不带那段正文', async () => {
    const { gen, kb, baseline } = await bootGenerate();
    const view = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    expect(view.evidence.length).toBeGreaterThan(0);
    // 反查面锁死在「这份简历自己派生出来的实体」上：切片证据与手工实体都不进这里。
    const derivedWithEntry = new Map(
      deriveEntities(baseline)
        .filter((draft) => draft.entryId !== null)
        .map((draft) => [draft.entityId, draft.entryId]),
    );
    for (const evidence of view.evidence) {
      expect(derivedWithEntry.get(evidence.evidenceId)).toBe(evidence.entryId);
      const body = kb.evidenceBody(evidence.evidenceId);
      expect(body?.id).toBe(evidence.evidenceId);
      expect(Object.keys(evidence).sort()).toEqual(
        ['entryId', 'evidenceId', 'kind', 'label', 'score', 'sectionId', 'tokens'].sort(),
      );
    }
    // 个人信息不随生成结果整份过 IPC（§8.5）：证据面只有 id、词、分数与 token，正文要另问一次。
    const metadata = JSON.stringify([view.evidence, view.reorderBases]);
    expect(metadata).not.toContain('主导订单服务重构');
    expect(metadata).not.toContain('容量规划');
  });

  it('手工实体（回指不到条目）不参与排序，也不进证据面', async () => {
    const { gen, kb } = await bootGenerate();
    const before = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    // 载荷刻意与库里那行技能撞词（Kubernetes）：它在缺口报告里确实是一条证据，但没有 entryId。
    const handmade = kb.create({ kind: 'skill', payload: { text: 'Kubernetes 集群运维' } }, AS_OF_MS);
    expect(handmade.sourceDocId).toBeNull();
    const after = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    expect(after.evidence.every((evidence) => evidence.evidenceId !== handmade.entityId)).toBe(true);
    expect(JSON.stringify(after.reorderBases)).toBe(JSON.stringify(before.reorderBases));
    expect(JSON.stringify(after.document)).toBe(JSON.stringify(before.document));
  });
});

describe('resume.generate 的模型腿与重试（spec 4.5-05 / 09）', () => {
  it('第一轮动数值、第二轮改回来：恰好两次请求，第二轮的提示词里带着上一轮的违规行而不带原文', async () => {
    const boot = await bootGenerate({}, {});
    const target = numberedTarget(generationTargetFields(boot.baseline));
    const { gen, fake } = await bootGenerate(
      {},
      {
        replies: [replyFor(target, numberLosingRewriteOf(target)), replyFor(target, safeRewriteOf(target))],
      },
    );
    const view = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    expect(view.receipt.modelStatus).toBe('merged');
    expect(view.checks.retried).toBe(true);
    expect(view.receipt.outcome).toBe('rewritten');
    expect(fake?.calls).toHaveLength(2);
    const secondSystem = fake?.calls[1]?.[0]?.content ?? '';
    expect(secondSystem).toContain('上一轮的改写未通过事实校验');
    expect(secondSystem).toContain('number-preservation');
    // 违规行只给路径与判据名，不给字段原文（判据三 + 4.5-14）。
    expect(secondSystem).not.toContain('延迟压下降');
  });

  it('两轮都动数值：拒绝产出，但记录行、违规明细与重试标记都留下（4.5-05 / 判据三）', async () => {
    const boot = await bootGenerate({}, {});
    const target = numberedTarget(generationTargetFields(boot.baseline));
    const { gen, fake, db } = await bootGenerate(
      {},
      {
        replies: [replyFor(target, numberLosingRewriteOf(target))],
      },
    );
    const view = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    expect(view.document).toBeNull();
    expect(view.rewrites).toEqual([]);
    expect(view.receipt.outcome).toBe('rejected');
    expect(view.checks.ok).toBe(false);
    expect(view.checks.violationCount).toBeGreaterThan(0);
    expect(view.checks.retried).toBe(true);
    expect(fake?.calls).toHaveLength(2);
    const rows = generationRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('rejected');
    expect(rows[0]?.retried).toBe(1);
    expect(JSON.parse(rows[0]?.violations_json as string)).toHaveLength(view.checks.violationCount);
    // 拒绝的那一轮库里存的是路径与判据名，不是被拒正文
    expect(JSON.stringify(rows)).not.toContain('延迟压下降');
  });

  it('编出清单外的机构名：具名回查拦下，违规明细里只有 unknown-entity 而没有数值读数', async () => {
    const boot = await bootGenerate({}, {});
    const [target] = generationTargetFields(boot.baseline);
    if (target === undefined) throw new Error('语料里没有可改写散文段，具名回查用例失去前提');
    const { gen } = await bootGenerate({}, { replies: [replyFor(target, `${target.text}，服务过星辰集团。`)] });
    const view = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    expect(view.receipt.outcome).toBe('rejected');
    expect(view.checks.violations.some((line) => line.includes('unknown-entity'))).toBe(true);
    expect(view.checks.violations.some((line) => line.includes('number-preservation'))).toBe(false);
  });

  it('模型答得上来但一条都采不了信（非法 JSON）：产物退到仅重排，功能不断流（4.5-09）', async () => {
    const { gen, fake } = await bootGenerate({}, { replies: ['这不是 JSON'] });
    const view = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    expect(view.receipt.modelStatus).toBe('rejected');
    expect(view.receipt.outcome).toBe('reorder_only');
    expect(view.document).not.toBeNull();
    expect(validateDocument(view.document as ResumeDocument).ok).toBe(true);
    expect(view.rewrites).toEqual([]);
    expect(fake?.calls).toHaveLength(1);
  });

  it('请求抛错：回落为 failed 并给出那句可直接播报的话，产物仍是重排版', async () => {
    const { gen } = await bootGenerate({}, { fail: true });
    const view = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    expect(view.receipt.modelStatus).toBe('failed');
    expect(view.receipt.modelReason).toContain('问模型失败');
    expect(view.receipt.outcome).toBe('reorder_only');
    expect(view.checks.ok).toBe(true);
  });

  it('装配里没有 llm.chat：报 unavailable，一次都不发，产物是重排版（4.5-09 的降级可见）', async () => {
    const { gen } = await bootGenerate();
    const view = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    expect(view.receipt.modelStatus).toBe('unavailable');
    expect(view.receipt.modelReason).toContain('未装配');
    expect(view.receipt.promptVersion).toBeNull();
    expect(view.receipt.outcome).toBe('reorder_only');
    expect(view.document).not.toBeNull();
  });

  it('allowModelLeg=false：纯本地路径，不碰替身，产物仍合法（4.5-09 的另一半）', async () => {
    const { gen, fake } = await bootGenerate({ allowModelLeg: false }, {});
    const view = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    expect(fake?.calls).toHaveLength(0);
    expect(view.receipt.modelStatus).toBe('disabled');
    expect(view.receipt.modelReason).toContain('allowModelLeg');
    expect(view.receipt.outcome).toBe('reorder_only');
    expect(validateDocument(view.document as ResumeDocument).ok).toBe(true);
  });

  it('保守版也真跑一遍校验，不是注释里声明"它必然通过"（判据四的证据半边）', async () => {
    const { gen, baseline } = await bootGenerate({ allowModelLeg: false });
    const view = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    expect(view.checks.ok).toBe(true);
    expect(view.checks.violations).toEqual([]);
    // 除顺序外内容逐字未动：事实字段与散文都还是基线那一份。
    expect(fieldValuesByLocation(view.document as ResumeDocument)).toEqual(fieldValuesByLocation(baseline));
  });
});

describe('resume_generations 落库（spec 4.5-10 / 判据三）', () => {
  it('挂载即建表，迁移号段为 15 且不与前十四张表撞号', async () => {
    const { db } = await bootGenerate();
    expect(RESUME_GENERATION_MIGRATION_VERSION).toBe(15);
    const taken = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(taken.has(RESUME_GENERATION_MIGRATION_VERSION)).toBe(false);
    const names = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resume_generations'`)
      .all() as unknown as Array<{ name: string }>;
    expect(names.map((row) => row.name)).toEqual(['resume_generations']);
    const columns = db.prepare(`PRAGMA table_info(resume_generations)`).all() as unknown as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      'id',
      'doc_id',
      'jd_id',
      'prompt_version',
      'model',
      'model_status',
      'status',
      'retried',
      'created_at',
      'evidence_json',
      'violations_json',
    ]);
    // 复盘的主查询形态是「这份简历生成过哪几版」，索引必须真的建出来。
    const indexes = db.prepare(`PRAGMA index_list(resume_generations)`).all() as unknown as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain('idx_resume_generations_doc');
  });

  it('每次生成落一行：归因、腿状态、结局与证据 id 都在，且没有正文字段', async () => {
    const { gen, db } = await bootGenerate({ allowModelLeg: false });
    const view = await gen.run(SAMPLE_JD, { docId: DOC_ID, jdId: 'jd-42' }, AS_OF_MS);
    const rows = generationRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(view.receipt.id);
    expect(rows[0]?.doc_id).toBe(DOC_ID);
    expect(rows[0]?.jd_id).toBe('jd-42');
    expect(rows[0]?.model_status).toBe('disabled');
    expect(rows[0]?.status).toBe('reorder_only');
    // 没发过请求就不许报提示词版本（与 4.4 的 `wasAsked` 同一条判断，§2.2 共用一个函数）
    expect(rows[0]?.prompt_version).toBeNull();
    expect(rows[0]?.created_at).toBe(AS_OF_MS);
    expect(JSON.parse(rows[0]?.evidence_json as string)).toHaveLength(view.evidence.length);
    const columnNames = Object.keys(rows[0] as Record<string, unknown>);
    expect(columnNames.some((name) => /text|body|content|before|after/.test(name))).toBe(false);
  });

  it('同一份简历连续两次生成各落一行，按 doc_id 复盘查得到、按时间倒序', async () => {
    const boot = await bootGenerate({}, {});
    const target = numberedTarget(generationTargetFields(boot.baseline));
    const { gen, db } = await bootGenerate({}, { replies: [replyFor(target, numberLosingRewriteOf(target))] });
    const first = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    const second = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS + 1);
    const rows = generationRows(db);
    expect(rows).toHaveLength(2);
    // 两次都是「两轮都不过校验」，各自独立成行：复盘要看的是每一次的结局，不是一个聚合值。
    expect(rows.map((row) => row.status)).toEqual(['rejected', 'rejected']);
    expect(rows.map((row) => row.id)).toEqual([first.receipt.id, second.receipt.id]);
    const byDoc = db
      .prepare('SELECT id FROM resume_generations WHERE doc_id = ? ORDER BY created_at DESC')
      .all(DOC_ID) as unknown as Array<{ id: string }>;
    expect(byDoc.map((row) => row.id)).toEqual([second.receipt.id, first.receipt.id]);
  });

  it('结局枚举与库里的 CHECK 同源：写一个不在枚举里的值会被拒', async () => {
    const { db } = await bootGenerate();
    expect([...GENERATION_OUTCOMES]).toEqual(['rewritten', 'reorder_only', 'rejected']);
    let caught: unknown;
    try {
      db.prepare(
        `INSERT INTO resume_generations
         (id, doc_id, jd_id, prompt_version, model, model_status, status, retried, created_at, evidence_json, violations_json)
         VALUES ('x', 'd', NULL, NULL, NULL, 'merged', 'half_done', 0, 1, '[]', '[]')`,
      ).run();
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain('CHECK');
  });
});

describe('PII 不因生成流程外流（spec 4.5-14 / 判据七）', () => {
  it('四条通道的哨兵各自被植入、各自被挡在生成轨之外', async () => {
    const boot = await bootGenerate({}, {});
    const targets = generationTargetFields(boot.baseline);
    const target = numberedTarget(targets);
    // 正向对照：四条通道都真的植进去了（没植进的负向断言是空跑，判据七不许那样收口）。
    expect(boot.baseline.profile.contact.phone).toBe(MASKED_CORPUS_PHONE);
    const emailTarget = targets.find((field) => field.text.includes('@example.invalid'));
    if (emailTarget === undefined) throw new Error('邮箱哨兵没落在可改写散文段里，通道 2 失去前提');
    // 只断言"掩码过的那一份"，不写死它长什么样：4.1 的 `stripMarkup` 会吃掉连续星号里的成对 `**`，
    // 把 `z***@` 削成 `z*@`。断言字面量会把一条无关的去装饰细节变成用例失败，而这条通道要判的是
    // 「本地部分没了、域名还在」。
    expect(emailTarget.text).not.toContain('zhangsan.tester');
    expect(JSON.stringify(boot.baseline)).not.toContain(PII_CORPUS_EMAIL);
    expect(SAMPLE_JD).toContain(PII_JD_PHONE);

    // 通道 3：模型往散文里补一个手机号 → 数值守恒抓下来，读数与重试提示词里只剩掩码形态。
    const { gen, fake, db, logFile } = await bootGenerate(
      {},
      {
        replies: [replyFor(target, phoneAddingRewriteOf(target))],
      },
    );
    const rejected = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    expect(rejected.receipt.outcome).toBe('rejected');
    expect(rejected.document).toBeNull();
    const rejectionLines = rejected.checks.violations.join('\n');
    expect(rejectionLines).toContain('number-preservation');
    expect(rejectionLines).toContain(MASKED_REPLY_PHONE);
    expect(rejectionLines).not.toContain(PII_REPLY_PHONE);
    const retrySystem = fake?.calls[1]?.[0]?.content ?? '';
    expect(retrySystem).toContain(MASKED_REPLY_PHONE);

    // 通道 2：递出网的是文档里那份已掩码的正文，产物里也只剩掩码形态。
    const rewriteBoot = await bootGenerate({}, { replies: [replyFor(target, safeRewriteOf(target))] });
    const rewritten = await rewriteBoot.gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    expect(rewritten.receipt.outcome).toBe('rewritten');
    expect(JSON.stringify(rewritten.document)).toContain(emailTarget.text);
    const firstUserMessage = rewriteBoot.fake?.calls[0]?.[1]?.content ?? '';
    expect(firstUserMessage).toContain(emailTarget.text);
    expect(firstUserMessage).not.toContain(PII_CORPUS_EMAIL);

    const logText = await waitForLogLine(logFile, '[kb-generate]');
    const recordText = JSON.stringify(generationRows(db));
    for (const sentinel of [PII_CORPUS_PHONE, PII_CORPUS_EMAIL, PII_REPLY_PHONE, PII_JD_PHONE]) {
      expect(logText).not.toContain(sentinel);
      expect(recordText).not.toContain(sentinel);
      for (const view of [rejected, rewritten]) {
        // 判据七的"返回体"按字面判：整份对象序列化后都查不到原始哨兵。
        expect(JSON.stringify(view)).not.toContain(sentinel);
      }
    }
  });

  it('生成日志一行说清结局、腿状态与计数，级别按结局分（被拒与回落走 warn）', async () => {
    const { gen, logFile } = await bootGenerate();
    await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    const line = lastLogLine(await waitForLogLine(logFile, '[kb-generate]'), '[kb-generate]');
    expect(line).toMatch(
      /\[kb-generate\] gen-[0-9a-f-]+ · 结果 reorder_only · 要求 \d+ 条 · 重排 区块 \d+ \/ 条目 \d+ · 模型腿 unavailable/,
    );
    expect(line).toContain('WARN');
  });
});

describe('resume.generate 的 agent 工具面（spec 4.5 的双入口）', () => {
  it('本服务只登记一只 resume.generate.run：建档动作、需要批准、不当外发', async () => {
    const { tools } = await bootGenerate();
    // 注册表是共享的（`kb.gap` 也往这里登记 `kb.gap.report`），所以按本服务的前缀筛。
    expect([...tools.declarations.keys()].filter((id) => id.startsWith('resume.generate'))).toEqual([
      'resume.generate.run',
    ]);
    const tool = tools.declarations.get('resume.generate.run');
    if (tool === undefined) throw new Error('resume.generate.run 未登记进 agent 工具面');
    expect(tool.effect).toBe('local-write');
    expect(tool.requiresConfirmation).toBe(true);
    // 描述里必须写清"不写工作副本、不接额度闸门"：模型据此判断这不是外发动作（判据五）。
    expect(tool.description).toContain('不写工作副本');
    expect(tool.description).toContain('不接外发额度闸门');
  });

  it('跑工具与直接调 service 的产物逐字相等：两入口共用同一条生成链（§5.9）', async () => {
    const { gen, tools } = await bootGenerate({ allowModelLeg: false });
    const tool = tools.declarations.get('resume.generate.run');
    if (tool === undefined) throw new Error('resume.generate.run 未登记进 agent 工具面');
    // `run` 交回的是统一读数 `ToolResult`（spec 5.1-11），产物在 `.value` 里。
    // 这里显式收束成 `GenerationView`：工具面哪天少给一个键，下面那三行属性访问当场发红，
    // 而不是跟着 `JSON.stringify(undefined)` 双方都变成 undefined 而悄悄通过。
    const viaTool = (await tool.run({ jdText: SAMPLE_JD, docId: DOC_ID })).value as GenerationView;
    const viaService = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    expect(JSON.stringify(viaTool.document)).toBe(JSON.stringify(viaService.document));
    expect(JSON.stringify(viaTool.evidence)).toBe(JSON.stringify(viaService.evidence));
    expect(JSON.stringify(viaTool.checks)).toBe(JSON.stringify(viaService.checks));
  });

  it('入参是边界：正文必填、docId 非空串、基准时间一律拒收', async () => {
    const { tools } = await bootGenerate();
    const tool = tools.declarations.get('resume.generate.run');
    if (tool === undefined) throw new Error('resume.generate.run 未登记进 agent 工具面');
    expect(tool.input.safeParse({ jdText: SAMPLE_JD }).success).toBe(true);
    expect(tool.input.safeParse({}).success).toBe(false);
    expect(tool.input.safeParse({ jdText: SAMPLE_JD, docId: '' }).success).toBe(false);
    expect(tool.input.safeParse({ jdText: SAMPLE_JD, jdId: null }).success).toBe(true);
    // 时间基准只能由服务取：让模型自己填「今天是几月」会破坏 4.5-07 的确定性（同 4.4-05 的判据）
    expect(tool.input.safeParse({ jdText: SAMPLE_JD, nowMs: AS_OF_MS }).success).toBe(false);
  });
});

/**
 * 把模型给出的清单拼成一条回复（多条改写时按原样给）。
 * @param rewrites 每条改写的目标位置与新写法
 * @returns 可直接当替身回复的 JSON 串
 */
function multiReplyFor(rewrites: readonly GenerationField[]): string {
  return JSON.stringify({ entries: rewrites.map((item) => ({ ...item })) });
}

/**
 * 起一份「模型按 `picked` 逐条改写」的装配。
 *
 * 为什么要跑两遍装配：待改写清单的位置只能从服务给的 `generationTargetFields(baseline)` 里取
 * （自己编 id 就等于绕开判据六那道"位置必须在清单上"），而清单要先有一份基线文档才能算。
 * @param picked 要模型改的那几个位置（从第一次装配的清单里挑）
 * @returns 真正被使用的装配：生成服务、应用句柄与那次生成的视图
 */
async function bootRewrittenAt(picked: readonly GenerationField[]) {
  const rewrites = picked.map((field) => ({ ...field, text: safeRewriteOf(field) }));
  const { gen, app } = await bootGenerate({}, { replies: [multiReplyFor(rewrites)] });
  const view = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
  return { gen, app, view };
}

describe('resume.generate 的接受面（spec 4.5-11：逐项表态之后才写工作副本）', () => {
  it('接受全部改写并采纳重排：工作副本变成产物那一份，读回来仍过 P3 Schema', async () => {
    const boot = await bootGenerate({}, {});
    const target = numberedTarget(generationTargetFields(boot.baseline));
    const { gen, app, view } = await bootRewrittenAt([target]);
    expect(view.receipt.outcome).toBe('rewritten');
    const product = view.document;
    if (product === null) throw new Error('rewritten 的产物不该是 null');
    const result = gen.accept(view.receipt.id, { acceptedIndexes: [0], applyReorder: true }, AS_OF_MS + 1);
    expect(result).toEqual({
      docId: DOC_ID,
      receiptId: view.receipt.id,
      appliedRewrites: 1,
      reorderApplied: true,
      movedSections: view.receipt.movedSections,
      movedEntries: view.receipt.movedEntries,
      updatedAt: AS_OF_MS + 1,
    });
    const loaded = app['resume.doc'].load(DOC_ID);
    if (loaded.status !== 'found') throw new Error(`读回工作副本失败：${loaded.status}`);
    expect(validateDocument(loaded.document).ok).toBe(true);
    expect(JSON.stringify(loaded.document.sections)).toBe(JSON.stringify(product.sections));
  });

  it('只勾其中一条：另一处逐字留在原样，接受不是整份覆盖', async () => {
    const boot = await bootGenerate({}, {});
    const targets = generationTargetFields(boot.baseline);
    const picked = [targets[0] as GenerationField, targets[1] as GenerationField];
    const { gen, app, view } = await bootRewrittenAt(picked);
    expect(view.rewrites).toHaveLength(2);
    const accepted = view.rewrites[0] as GenerationRewriteView;
    const refused = view.rewrites[1] as GenerationRewriteView;
    expect(
      gen.accept(view.receipt.id, { acceptedIndexes: [0], applyReorder: false }, AS_OF_MS + 1).appliedRewrites,
    ).toBe(1);
    const loaded = app['resume.doc'].load(DOC_ID);
    if (loaded.status !== 'found') throw new Error(`读回工作副本失败：${loaded.status}`);
    const values = fieldValuesByLocation(loaded.document);
    expect(values.get(`${accepted.sectionId}#${accepted.entryId}#${accepted.fieldKey}`)).toBe(accepted.rewrittenText);
    // 没勾的那条：工作副本里仍是原文，而不是产物里那句新写法（部分接受必须真的部分）
    expect(values.get(`${refused.sectionId}#${refused.entryId}#${refused.fieldKey}`)).toBe(refused.originalText);
  });

  it('提议态不在 / 下标越界 / 重复接受：三种表态都不写盘，各给一句确定的话', async () => {
    const boot = await bootGenerate({}, {});
    const target = numberedTarget(generationTargetFields(boot.baseline));
    const { gen, app, view } = await bootRewrittenAt([target]);
    const row = dbCopy(app.store.db);
    // ① 界面拿着一个从没生成过的 id 来表态（重启过 / 过期了）：只能重生成，不能猜当时看到什么
    expect(() => gen.accept('gen-never-heard-of-it', { acceptedIndexes: [0], applyReorder: true })).toThrow(AppError);
    let caught: unknown;
    try {
      gen.accept('gen-never-heard-of-it', { acceptedIndexes: [0], applyReorder: true });
    } catch (error) {
      caught = error;
    }
    expect((caught as AppError).code).toBe('KB_GENERATION_PROPOSAL_MISSING');
    // ② 下标越界：那是"界面停在旧产物上"，不是"少接受一条"，所以按参数错拒绝而不是静默少写
    try {
      gen.accept(view.receipt.id, { acceptedIndexes: [7], applyReorder: true });
    } catch (error) {
      caught = error;
    }
    expect((caught as AppError).code).toBe('INVALID_ARGUMENT');
    expect(dbCopy(app.store.db)).toEqual(row);
    // ③ 一次接受用掉一份提议态：同一张单子接受第二次落在"重新生成"那句更清楚的话上
    gen.accept(view.receipt.id, { acceptedIndexes: [0], applyReorder: true }, AS_OF_MS + 1);
    try {
      gen.accept(view.receipt.id, { acceptedIndexes: [0], applyReorder: true }, AS_OF_MS + 2);
    } catch (error) {
      caught = error;
    }
    expect((caught as AppError).code).toBe('KB_GENERATION_PROPOSAL_MISSING');
  });

  it('生成之后用户自己改过简历：接受被拦下，用户那处改动原样留着（不叠两份改动）', async () => {
    const boot = await bootGenerate({}, {});
    const target = numberedTarget(generationTargetFields(boot.baseline));
    const { gen, app, view } = await bootRewrittenAt([target]);
    const loaded = app['resume.doc'].load(DOC_ID);
    if (loaded.status !== 'found') throw new Error(`读回工作副本失败：${loaded.status}`);
    // 只动时刻就足够构成"生成之后副本变了"——判定看的是逐字比较，不是挑某几个字段
    const edited = { ...loaded.document, updatedAt: AS_OF_MS + 5 };
    app['resume.doc'].save(edited);
    let caught: unknown;
    try {
      gen.accept(view.receipt.id, { acceptedIndexes: [0], applyReorder: true }, AS_OF_MS + 6);
    } catch (error) {
      caught = error;
    }
    expect((caught as AppError).code).toBe('KB_GENERATION_STALE_BASELINE');
    const after = app['resume.doc'].load(DOC_ID);
    expect(after.status).toBe('found');
    expect(JSON.stringify((after as { document: ResumeDocument }).document)).toBe(JSON.stringify(edited));
  });

  it('一条都没勾也没采纳重排：这声接受一次盘都不落，提议态也留着', async () => {
    const boot = await bootGenerate({}, {});
    const target = numberedTarget(generationTargetFields(boot.baseline));
    const { gen, app, view } = await bootRewrittenAt([target]);
    const before = dbCopy(app.store.db);
    const result = gen.accept(view.receipt.id, { acceptedIndexes: [], applyReorder: false }, AS_OF_MS + 3);
    expect(result).toMatchObject({ appliedRewrites: 0, reorderApplied: false, updatedAt: before.updatedAt });
    expect(dbCopy(app.store.db)).toEqual(before);
    // 什么都没写就不该把这单子判成"已用掉"：同一张单子随后仍能正常接受
    expect(
      gen.accept(view.receipt.id, { acceptedIndexes: [0], applyReorder: true }, AS_OF_MS + 4).appliedRewrites,
    ).toBe(1);
  });

  it('只采纳重排、一条改写都没勾：顺序按产物走，字段值一字未动', async () => {
    // 不挂模型腿的装配本身就是保守版（4.5-09）：`rewrites` 天然为空，正好用来判"只动顺序"这一支
    const { gen, app } = await bootGenerate();
    const before = app['resume.doc'].load(DOC_ID);
    if (before.status !== 'found') throw new Error(`读回工作副本失败：${before.status}`);
    const view = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    expect(view.receipt.outcome).toBe('reorder_only');
    expect(view.rewrites).toEqual([]);
    const result = gen.accept(view.receipt.id, { acceptedIndexes: [], applyReorder: true }, AS_OF_MS + 1);
    expect(result.reorderApplied).toBe(true);
    expect(result.movedSections + result.movedEntries).toBeGreaterThan(0);
    const after = app['resume.doc'].load(DOC_ID);
    if (after.status !== 'found') throw new Error(`读回工作副本失败：${after.status}`);
    expect(JSON.stringify(after.document.sections)).toBe(JSON.stringify(view.document?.sections));
    // 每条改写各自守恒数值，重排又不动内容，所以两侧的位置集合与取值必须逐字相同
    expect(fieldValuesByLocation(after.document)).toEqual(fieldValuesByLocation(before.document));
    expect(view.document?.updatedAt).toBe(before.document.updatedAt);
    expect(after.document.updatedAt).toBe(AS_OF_MS + 1);
  });

  it('被拒的那次没有提议态可接受：界面只能给"需人工确认"，捞不出一份产物', async () => {
    const boot = await bootGenerate({}, {});
    const target = numberedTarget(generationTargetFields(boot.baseline));
    const { gen, app } = await bootGenerate(
      {},
      {
        replies: [replyFor(target, numberLosingRewriteOf(target)), replyFor(target, numberLosingRewriteOf(target))],
      },
    );
    const view = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS);
    expect(view.receipt.outcome).toBe('rejected');
    expect(view.document).toBeNull();
    expect(view.rewrites).toEqual([]);
    expect(view.checks.violationCount).toBeGreaterThan(0);
    let caught: unknown;
    try {
      gen.accept(view.receipt.id, { acceptedIndexes: [], applyReorder: true });
    } catch (error) {
      caught = error;
    }
    expect((caught as AppError).code).toBe('KB_GENERATION_PROPOSAL_MISSING');
    expect(dbCopy(app.store.db).body).toContain('星桥科技');
  });

  it('提议态只留最近 `MAX_PENDING_PROPOSALS` 份：最早那份接受时报"重新生成一次"', async () => {
    const { gen, app } = await bootGenerate();
    const ids: string[] = [];
    // 循环里只生成不接受：工作副本一直停在同一份基线上，越界与过期两条判定都不会抢在前面，
    // 这里判的就只剩"保留窗口"这一件事（接受掉任何一份都会把它自己从窗口里删掉）。
    for (let index = 0; index <= MAX_PENDING_PROPOSALS; index += 1) {
      const view = await gen.run(SAMPLE_JD, { docId: DOC_ID }, AS_OF_MS + index);
      ids.push(view.receipt.id);
    }
    let caught: unknown;
    try {
      gen.accept(ids[0] as string, { acceptedIndexes: [], applyReorder: true });
    } catch (error) {
      caught = error;
    }
    expect((caught as AppError).code).toBe('KB_GENERATION_PROPOSAL_MISSING');
    // 最新那份还在窗口里：被挤掉的只有最早的那一份，不是"来第二次就把第一次弄丢"
    expect(
      gen.accept(ids[MAX_PENDING_PROPOSALS] as string, { acceptedIndexes: [], applyReorder: true }, AS_OF_MS).docId,
    ).toBe(DOC_ID);
    expect(app['resume.doc'].load(DOC_ID).status).toBe('found');
  });
});
