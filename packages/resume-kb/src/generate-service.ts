/**
 * `resume.generate` service（spec 4.5-01 / 02 / 05 / 06 / 09 / 10 / 12，plan §4.5 判据一～七）。
 *
 * 本服务是 4.5 那条闭环的**装配层**：判定全在它下面的三个模块里，这里只做取数、编排、落库、播报。
 * 分工固定，不允许在本文件里长出第四条规则（AGENTS.md §2.5）：
 *
 * - 顺序：`generate-reorder.ts`（判据一——顺序不进模型，由 4.4 的证据强度算）；
 * - 改写：`generate-model.ts`（判据六——回答形状只有「改写」，没有「新增」的通道）；
 * - 把关：`fact-check.ts`（判据四 / 七——确定性三条判据：字段原样、数值多重集守恒、具名候选回查）；
 * - 相关性读数：`kb.gap.report()`，本服务**不重开一条拆解或比对通道**（§2.5）。
 *
 * 五条装配层的立身之本：
 * 1. **不写工作副本**。产物是"提议态"，写入只发生在界面上用户逐项接受之后（4.5-11，归 4.5-c）。
 *    于是本服务对 `resume.doc` 只有 `load()` 一条读路径，一次 `save()` 都不发生——
 *    这是 4.5-05 那句"拒绝产出"能被断言的前提：没有产物可捞，也没有半份改动留在副本里。
 * 2. **产物与证据并排返回，不嵌进文档**（判据二）：`documentSchema` 是 `strictObject`，
 *    多一个私有键就同时破掉 4.5-01 与 4.5-12。所以返回体是
 *    `{ document, rewrites, evidence, reorderBases, checks, receipt }`，证据留在旁边那一份里。
 * 3. **拒绝也落一行记录**（判据三）：`resume_generations`（号段 15）存的是路径、计数、状态与证据 id，
 *    **不存任何正文**——被拒内容整段留在库里会诱导"绕过闸门自己捞出来用"，
 *    而 4.5-10 要的复盘只需要"哪一版提示词、哪个模型、动了哪些位置、为什么被拒"。
 * 4. **模型腿不可用不等于没产物**（判据四）：退回"仅重排、所有字段照抄"的保守版本，
 *    它必然通过校验（什么都没动），但 `modelStatus` / `modelReason` 会一路带到界面上，
 *    降级必须可见——与 4.6-06「模板话术标识『模板』」同一条口径。
 * 5. **不接额度闸门**（判据五）：生成既不在真实平台上留痕迹也不花钱（未配置时纯本地），
 *    接 `entitlement.gate` 会造出"改 20 次简历吃掉 20 轮抓取额度"这种新坏结果；
 *    销针在 `packages/llm/src/quota-boundary.test.ts`，真接的那天它会红。
 *
 * 隐私口径（§8.5 / 4.5-14）：日志与生成记录只有 id、计数、路径与状态；
 * 递给模型的提示词带的是**待改写的散文段本身**——那是 4.5 的功能（`allowModelLeg=false` 即纯本地路径），
 * 而联系资料（`profile`）与事实键（`company / role / period / school / degree / major`）
 * 不在改写面上，因此**不会**出现在提示词里。
 */
import {
  agentTool,
  AppError,
  asApp,
  chatGatewayOf,
  maybeService,
  registerAgentTools,
  Service,
  type Context,
} from '@auto-cc/core';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { validateDocument, type ResumeDocument } from '@auto-cc/plugin-resume-doc';
import { deriveEntities, type KbEntityDraft } from './entities.js';
import {
  describeViolations,
  GENERATION_EDITABLE_KEYS,
  generationTargetFields,
  verifyGeneration,
  type GenerationCheckReport,
  type GenerationField,
} from './fact-check.js';
import {
  applyRewrites,
  buildGenerateMessages,
  buildRetryAppendix,
  GENERATE_PROMPT_VERSION,
  readModelRewrites,
  type GeneratedRewrite,
} from './generate-model.js';
import { evidenceOfEntries, reorderDocument, type ReorderBasis } from './generate-reorder.js';
import { GAP_MODEL_STATUSES, wasAsked, type GapModelStatus, type KbGapService } from './gap-service.js';
import type { GapRequirementView } from './requirements-compare.js';
import type { RequirementKind } from './requirements.js';

/**
 * 生成记录表的迁移号段：**15**（账本 1 / agent 会话 2 / jobs 3 / workflow run 4 / conversation 5 /
 *  consent 6 / resume_docs 7 / resume_snapshots 8 / delivery_records 9 / resume_imports 10 /
 *  kb_entities 11 / kb_chunks 12 / kb_chunks_fts 13 / kb_vectors 14）。
 *  撞号的表现是「见号已存在就跳过建表」→ 表根本没建 → 读写 `no such table`，所以号段列全并进单测断言。
 */
export const RESUME_GENERATION_MIGRATION_VERSION = 15;

/**
 * 一次生成的三种结局。
 *
 * 与模型腿的五态（`GAP_MODEL_STATUSES`）是**两个维度**：五态说"模型那条腿这次怎么样了"，
 * 三态说"用户拿到了什么"。`reorder_only` 可能来自 `unavailable`（没配模型）也可能来自 `disabled`
 * （配置关掉），把它们混成一列会让 4.5-09 的"降级可见"变成"降级可读成一堆故障"。
 */
export const GENERATION_OUTCOMES = ['rewritten', 'reorder_only', 'rejected'] as const;

/** 生成结局的字面量类型。 */
export type GenerationOutcome = (typeof GENERATION_OUTCOMES)[number];

const resumeGenerationsMigration = {
  version: RESUME_GENERATION_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    // 两个 CHECK 的取值表由代码里的常量拼出来（§2.5）：库里允许的枚举与视图里的枚举
    // 分成两份字面量，改一处就会让另一处静默写不进（`SQLITE_CONSTRAINT_CHECK` 在事务里才炸）。
    db.exec(`CREATE TABLE IF NOT EXISTS resume_generations (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      jd_id TEXT,
      prompt_version TEXT,
      model TEXT,
      model_status TEXT NOT NULL CHECK (model_status IN ('${GAP_MODEL_STATUSES.join("','")}')),
      status TEXT NOT NULL CHECK (status IN ('${GENERATION_OUTCOMES.join("','")}')),
      retried INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      evidence_json TEXT NOT NULL,
      violations_json TEXT NOT NULL
    )`);
    // 复盘的主查询形态是「这份简历生成过哪几版」，按时间倒序；`jd_id` 只做归因不进索引。
    db.exec('CREATE INDEX IF NOT EXISTS idx_resume_generations_doc ON resume_generations (doc_id, created_at DESC)');
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS resume_generations');
  },
};

/**
 * `resume.generate` 的可调项（同 4.3-03 / 4.4 的口径：运行期要按岗位与成本调的不写死在代码里）。
 */
export const kbGenerateSchema = z.strictObject({
  /**
   * 是否允许问模型腿。关掉后本服务只做重排、所有字段照抄（4.5-09 的纯本地路径，
   * 离线演示与"这篇我不想发出去"都直接把这关递给用户）。
   */
  allowModelLeg: z.boolean().default(true),
  /**
   * 单次回复的长度上限（token）。清单里每段散文 100～600 字、最多十几段，2000 是"够写完但不许跑飞"的量；
   * 比拆解腿的 1200 大，因为这里要输出的是整段改写而不是几个词。
   */
  modelMaxTokens: z.number().int().min(256).max(8192).default(2000),
  /**
   * 采样温度，取 0。与"文案要有花样"相反，这里要的是**可复盘**：同一份 JD + 同一份工作副本
   * 重跑一次应当得到同一份产物，否则 4.5-10 的记录行无法解释自己（用户想更活可以在配置里调高）。
   */
  modelTemperature: z.number().min(0).max(2).default(0),
  /** 单段改写的长度上限（字符）。模型跑飞时把整段 JD 抄回来的那类，按契约不合格丢弃而不是收下。 */
  maxRewriteChars: z.number().int().min(50).max(4000).default(600),
});

/** 校验后的配置形状。 */
export type KbGenerateConfig = z.infer<typeof kbGenerateSchema>;

/**
 * 一条证据引用：文档里的哪个条目被库里哪条证据撑着（spec 4.5-06 的反查面）。
 *
 * 只带 id 不带正文（与 4.4-d 同一口径）：界面要展开原文时问 `kb.profile.evidenceBody(id)`，
 * 个人信息不随生成结果整份过 IPC（§8.5）。
 */
export interface GenerationEvidenceView {
  readonly sectionId: string;
  readonly entryId: string;
  readonly evidenceId: string;
  readonly kind: RequirementKind;
  /** JD 里那条要求的代表词（JD 内容，不是用户的个人信息）。 */
  readonly label: string;
  readonly score: number;
  readonly tokens: readonly string[];
}

/**
 * 界面逐项接受 / 回退要用的一条改写（4.5-11 的数据面）。
 *
 * 刻意**不回原文**：原文由界面从工作副本自己读（那份才是真相源），返回体里少一份正文就少一处脱敏面。
 */
export interface GenerationRewriteView {
  readonly sectionId: string;
  readonly entryId: string;
  readonly fieldKey: string;
  readonly rewrittenText: string;
}

/** 事实校验的读数（违规明细只到 `describeViolations()` 那种「路径 + 判据 + 长度」的形状）。 */
export interface GenerationChecksView {
  readonly ok: boolean;
  /** 是否为了过校验重跑过一轮（spec 4.5-05 的"自动重试一次"只有这一次，不做指数退避）。 */
  readonly retried: boolean;
  readonly violations: readonly string[];
  readonly violationCount: number;
}

/** 一次生成的凭证：与 `resume_generations` 那一行同内容，界面与 agent 都读它（4.5-10）。 */
export interface GenerationReceipt {
  readonly id: string;
  readonly docId: string;
  readonly jdId: string | null;
  readonly createdAt: number;
  /** 实际发过提示词时才是版本号；`disabled` / `unavailable` 时为 null（没发过就不许报版本）。 */
  readonly promptVersion: string | null;
  readonly model: string | null;
  readonly modelStatus: GapModelStatus;
  readonly modelReason: string | null;
  readonly outcome: GenerationOutcome;
  readonly retried: boolean;
  readonly movedSections: number;
  readonly movedEntries: number;
  /** 真正装进产物里的改写条数（被拒时为 0——没有产物）。 */
  readonly rewritesApplied: number;
  /** 模型回答里被丢弃的条数合计：不合契约 + 位置对不上 + 同位置重复 + 与原文逐字相同。 */
  readonly rewritesDropped: number;
}

/**
 * 一次定向生成的返回体（plan §4.5 判据二的"文档与证据并排"）。
 *
 * `document` 为 null 就是**没有产物**（4.5-05 的拒绝路径），界面此时只能给"需人工确认"与违规明细，
 * 不能给一个"看起来成功过"的空文档——那是源实现那种假闭环的样子（取证二）。
 */
export interface GenerationView {
  readonly document: ResumeDocument | null;
  readonly rewrites: readonly GenerationRewriteView[];
  readonly evidence: readonly GenerationEvidenceView[];
  /** 重排依据：只含真正换了位置的对象（4.5-02 的"引用命中项"）。 */
  readonly reorderBases: readonly ReorderBasis[];
  readonly checks: GenerationChecksView;
  readonly receipt: GenerationReceipt;
}

/** 一次模型腿尝试的内部结果（`askModel` 的返回）。 */
interface RewriteAttempt {
  status: GapModelStatus;
  reason: string | null;
  model: string | null;
  rewrites: readonly GeneratedRewrite[];
  dropped: number;
}

/**
 * 生成轨服务。
 *
 * 失败抛 `AppError`：`KB_SOURCE_MISSING`（工作副本不存在 / 已损坏 / 库里一份都没有——先导入简历）、
 * `KB_LIBRARY_MISSING`（`kb.gap` 未装配，用户自己修不了，界面只能给"功能不可用"）、
 * `INVALID_ARGUMENT`（JD 过短——由 `kb.gap.report()` 判；或多份简历却没指定 `docId`）。
 * **校验不通过不抛错**：那是本条链的正常结局之一（4.5-05），以 `outcome:'rejected'` + 违规明细返回，
 * 界面上的"需人工确认"与日志里的那一行都从这个读数来。
 */
export class ResumeGenerateService extends Service {
  static provide = 'resume.generate';
  static Config = kbGenerateSchema;
  static inject = ['store', 'resume.doc'];

  constructor(
    ctx: Context,
    private readonly options: KbGenerateConfig,
  ) {
    // 必须接住第二个实参：cordis 递的是校验后的配置（AGENTS.md §9 实测 1.3）。
    super(ctx, 'resume.generate');
  }

  private get store() {
    return asApp(this.ctx).store;
  }

  private get docStore() {
    return asApp(this.ctx)['resume.doc'];
  }

  /** 幂等地把迁移 15 推进共享迁移列表并升级到最新。 */
  private ensureSchema(): void {
    const { migrations } = this.store;
    if (!migrations.some((item) => item.version === RESUME_GENERATION_MIGRATION_VERSION)) {
      migrations.push(resumeGenerationsMigration);
    }
    this.store.upgrade();
  }

  /**
   * 挂载时建表 + 登记 agent 工具（spec 4.5 的双入口半边）。
   *
   * `kb.gap` 与 `kb.profile` 都**不**写成 `inject`：它们缺席时的正确表现是调用那一刻抛
   * `KB_LIBRARY_MISSING`（界面给得出确定原因），而不是让整个 `resume.generate` 起不来、
   * 界面只剩一句"服务没起来"（同 4.4-d 对 `kb.gap` 的判断）。
   * @returns 无返回值
   */
  [Service.init](): void {
    this.ensureSchema();
    const tools = registerAgentTools(this.ctx, [
      agentTool({
        id: 'resume.generate.run',
        description:
          '按一段 JD 定制这份简历的内容：区块与条目顺序由知识库证据强度算出（不进模型），简介 / 经历成果 / 教育描述三类散文段交模型改写，改写后必过三条确定性事实校验（事实字段原样、数值多重集守恒、具名机构回查），不过则带违规明细重试一次、仍不过就拒绝产出；模型腿不可用时退回「仅重排、不改写」的保守版本并在 modelStatus 里给出原因。只产出提议态文档与证据 id，不写工作副本、不接外发额度闸门',
        input: z.strictObject({
          jdText: z.string(),
          docId: z.string().min(1).optional(),
          jdId: z.string().min(1).nullable().optional(),
        }),
        // `local-write`：本工具往生成记录表写一行，且（模型腿已配置时）把待改写散文发给模型。
        // 需要批准是有意的——真正的改写落进简历是界面上逐项接受那一步，但出网与建档这一步不该被静默做掉。
        effect: 'local-write',
        requiresConfirmation: true,
        run: (params) => this.run(params.jdText, { docId: params.docId, jdId: params.jdId }),
      }),
    ]);
    const hasGap = maybeService<KbGapService>(this.ctx, 'kb.gap') !== undefined;
    this.ctx.logger.info(
      `[kb-generate] resume_generations 就绪，迁移号段 ${String(RESUME_GENERATION_MIGRATION_VERSION)}` +
        ` · 可改写键 ${GENERATION_EDITABLE_KEYS.join(' / ')}（其余字段一律原样）` +
        ` · 模型腿 ${this.options.allowModelLeg ? '开' : '关（仅重排）'}` +
        ` maxTokens=${String(this.options.modelMaxTokens)} temp=${String(this.options.modelTemperature)}` +
        ` 单段上限=${String(this.options.maxRewriteChars)} 字` +
        ` · 缺口腿 ${hasGap ? '已装配' : '未装配（调用时报 KB_LIBRARY_MISSING）'}` +
        ` · agent 工具登记 ${String(tools)} 个${tools === 0 ? '（注册表未挂载）' : ''}`,
    );
  }

  /**
   * 把一份工作副本按一段 JD 定制成提议态文档（spec 4.5-01 / 02 / 05 / 06 / 09 的总入口）。
   * @param jdText JD 正文（与缺口报告同一份入参口径，过短由 `kb.gap.report()` 拒绝）
   * @param filter `docId` 省略时只在"库里恰好一份简历"时才自动选；`jdId` 只进记录行做归因
   * @param nowMs 报告读数的时间基准（毫秒），原样递给 `report()`——年限的"今天"只能由服务取，
   *              不让模型自己填（同 4.4 的 `nowMs` 判断）
   * @returns 产物 + 证据 + 重排依据 + 校验读数 + 凭证；被拒时 `document` 为 null
   * @throws AppError(`KB_SOURCE_MISSING` / `KB_LIBRARY_MISSING` / `INVALID_ARGUMENT`)，
   *         以及 `llm.chat` 抛回的 `INVALID_ARGUMENT`（那是我们拼错了请求，回落只会把 bug 藏起来）
   */
  async run(
    jdText: string,
    filter: { docId?: string; jdId?: string | null } = {},
    nowMs = Date.now(),
  ): Promise<GenerationView> {
    const docId = this.resolveDocId(filter.docId);
    const loaded = this.docStore.load(docId);
    if (loaded.status !== 'found') {
      throw new AppError(
        'KB_SOURCE_MISSING',
        `工作副本 ${docId} ${loaded.status === 'missing' ? '不存在' : '已损坏'}：先在知识库里导入一份简历再定制内容`,
      );
    }
    const gap = maybeService<KbGapService>(this.ctx, 'kb.gap');
    if (gap === undefined) {
      throw new AppError('KB_LIBRARY_MISSING', '缺口比对服务 kb.gap 未装配：生成轨拿不到相关性读数');
    }
    const baseline = loaded.document;
    // 相关性、要求清单、证据强度全部来自 4.4 那一份报告——本服务不重算任何分数（§2.1）。
    const report = await gap.report(jdText, { sourceDocId: docId }, nowMs);
    const drafts = deriveEntities(baseline);
    const reordered = reorderDocument(baseline, report.rows, drafts);
    const reorderedDoc: ResumeDocument = { ...baseline, sections: [...reordered.sections] };
    const targets = generationTargetFields(reorderedDoc);
    const evidence = evidenceOf(reorderedDoc, report.rows, drafts);
    const requirementLines = report.items.map((item) =>
      item.kind === 'experience_years' && item.years !== null
        ? `${item.label}（${String(item.years)} 年）`
        : item.label,
    );

    let attempt = await this.askModel(jdText, requirementLines, targets);
    let check: GenerationCheckReport | null = null;
    let product: ResumeDocument | null = null;
    let retried = false;
    if (attempt.rewrites.length > 0) {
      const proposed = applyRewrites(reorderedDoc, attempt.rewrites);
      check = verifyGeneration({ original: baseline, proposed, jdText });
      if (check.ok) product = validated(proposed);
      else {
        // 只重试一次，且把上一轮的违规行贴回提示词（4.5-05 的 RETRY_APPEND 式补强）。
        // 不做多轮退避：每多一轮就多一次出网与多一批正文，而违规都是"动了不该动的东西"，
        // 一轮说清楚之后还不过，就是该让人看，而不是该让机器继续猜。
        retried = true;
        const second = await this.askModel(
          jdText,
          requirementLines,
          targets,
          buildRetryAppendix(describeViolations(check)),
        );
        attempt = second;
        if (second.rewrites.length > 0) {
          const secondProposed = applyRewrites(reorderedDoc, second.rewrites);
          check = verifyGeneration({ original: baseline, proposed: secondProposed, jdText });
          if (check.ok) product = validated(secondProposed);
        }
        // 第二轮没给出可采信的改写时 `check` 保留第一轮的违规明细：那才是被拒的真正原因。
      }
    } else if (targets.length > 0) {
      // 保守版（判据四）：仅重排、字段照抄。校验照样跑一遍——"它必然通过"是推断，
      // 断言它通过才是证据（4.5-09 的产物合法性不许靠注释声明）。
      product = validated(reorderedDoc);
      check = verifyGeneration({ original: baseline, proposed: product, jdText });
    }
    const outcome: GenerationOutcome =
      product !== null
        ? attempt.rewrites.length > 0 && check?.ok === true
          ? 'rewritten'
          : 'reorder_only'
        : 'rejected';

    const violations = check === null ? [] : describeViolations(check);
    const receipt = this.record({
      docId,
      jdId: filter.jdId ?? null,
      createdAt: nowMs,
      attempt,
      outcome,
      retried,
      evidence,
      violations,
      movedSections: reordered.movedSections,
      movedEntries: reordered.movedEntries,
      rewritesApplied: outcome === 'rejected' ? 0 : attempt.rewrites.length,
    });
    const view: GenerationView = {
      document: outcome === 'rejected' ? null : product,
      rewrites:
        outcome === 'rejected'
          ? []
          : attempt.rewrites.map((rewrite) => ({
              sectionId: rewrite.sectionId,
              entryId: rewrite.entryId,
              fieldKey: rewrite.fieldKey,
              rewrittenText: rewrite.rewrittenText,
            })),
      evidence,
      reorderBases: reordered.bases,
      checks: { ok: check?.ok === true, retried, violations, violationCount: violations.length },
      receipt,
    };
    this.logRun(view, report.rows.length);
    return view;
  }

  /**
   * 选出生成针对哪份工作副本。
   *
   * 对话入口不该逼模型先查一次 docId（它没有那个工具面），但也不许"随便挑一份"——
   * 库里多份简历时替用户挑一份是产品决定，不是解码器决定，所以这里宁可报一句可播读的歧义。
   * @param docId 显式指定的文档 id（界面总是给；agent 通常不给）
   * @returns 确定可用的文档 id
   * @throws AppError(`KB_SOURCE_MISSING`) 库里一份都没有；
   *         AppError(`INVALID_ARGUMENT`) 有多份但没说用哪份
   */
  private resolveDocId(docId: string | undefined): string {
    if (docId !== undefined) return docId;
    const ids = this.docStore.listIds();
    if (ids.length === 0) {
      throw new AppError('KB_SOURCE_MISSING', '工作副本里还没有任何简历文档：先在知识库里导入一份简历');
    }
    if (ids.length > 1) {
      throw new AppError('INVALID_ARGUMENT', `库里有 ${String(ids.length)} 份简历，需指明 docId 再定制内容`);
    }
    return ids[0] as string;
  }

  /**
   * 问一次模型腿，把五种结局收敛成一个 `RewriteAttempt`，不在这里决定要不要采纳它的改写。
   *
   * 与 4.4 的拆解腿同一套不变量：除 `merged` 之外的四种结局交回来的 `rewrites` 都是空数组，
   * 于是"模型不可用"在调用方只是一句 `if`，功能不断流（4.5-09）。
   * 唯一例外仍是 `llm.chat` 抛 `INVALID_ARGUMENT`：那是我们拼错了请求，必须让它穿透。
   * @param jdText JD 正文（与提示词里那份同一个字符串）
   * @param requirementLines 4.4 已拆出的要求代表词（不让模型再拆一遍，判据一 / §2.5）
   * @param targets 待改写清单；为空时**一次都不问**（没内容可改写还要发一遍简历是纯粹的泄露面）
   * @param retryAppendix 第二轮的约束补强（违规行，已过脱敏）
   * @returns 结局 + 可安装的改写 + 丢弃计数
   */
  private askModel = async (
    jdText: string,
    requirementLines: readonly string[],
    targets: readonly GenerationField[],
    retryAppendix: string | null = null,
  ): Promise<RewriteAttempt> => {
    const fallback = (status: GapModelStatus, model: string | null, reason: string): RewriteAttempt => ({
      status,
      reason,
      model,
      rewrites: [],
      dropped: 0,
    });
    if (!this.options.allowModelLeg) {
      return fallback('disabled', null, '配置里关掉了模型腿（allowModelLeg=false），本次只重排不改写');
    }
    // 清单为空 = 这份工作副本里没有可改写的散文段。这一条不走 `unavailable`：
    // 五态里没有一个词表示"无事可做"，而 `disabled` 的"本条腿这一轮没启用"是诚实的读法。
    if (targets.length === 0) {
      return fallback('disabled', null, '这份简历里没有可改写的散文段（技能行与事实字段不在生成轨的改写面上）');
    }
    const gateway = chatGatewayOf(this.ctx);
    if (!gateway) {
      return fallback('unavailable', null, '模型出口 llm.chat 未装配，本次只重排不改写');
    }
    const configured = gateway.status();
    if (!configured.available) {
      return fallback('unavailable', configured.model, `模型未配置，缺 ${configured.missing.join(' / ')}`);
    }
    let reply: string;
    let modelName: string;
    try {
      const completion = await gateway.complete({
        messages: buildGenerateMessages(jdText, requirementLines, targets, retryAppendix ?? ''),
        maxTokens: this.options.modelMaxTokens,
        temperature: this.options.modelTemperature,
      });
      reply = completion.text;
      // 用回复里回报的模型名，不用配置里的：换了模型的产物要能看出来是哪一款写的。
      modelName = completion.model;
    } catch (cause) {
      if (cause instanceof AppError && cause.code === 'INVALID_ARGUMENT') throw cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      return fallback('failed', configured.model, `问模型失败：${message}`);
    }
    const read = readModelRewrites(reply, targets, this.options.maxRewriteChars);
    const dropped = read.droppedInvalid + read.droppedUnknown + read.droppedDuplicate + read.droppedUnchanged;
    if (read.accepted.length === 0) {
      return { ...fallback('rejected', modelName, read.reason ?? '模型产出无法采信'), dropped };
    }
    return { status: 'merged', reason: null, model: modelName, rewrites: read.accepted, dropped };
  };

  /**
   * 落一行生成记录并给出随返回体走的凭证（4.5-10）。
   *
   * 被拒的那一轮**同样要落**（判据三）：失败才是最需要复盘的那一半。
   * @param input 本次生成的全部读数（不含正文）
   * @returns 与库里那一行同内容的凭证对象
   */
  private record(input: {
    docId: string;
    jdId: string | null;
    createdAt: number;
    attempt: RewriteAttempt;
    outcome: GenerationOutcome;
    retried: boolean;
    evidence: readonly GenerationEvidenceView[];
    violations: readonly string[];
    movedSections: number;
    movedEntries: number;
    rewritesApplied: number;
  }): GenerationReceipt {
    const id = `gen-${randomUUID()}`;
    const asked = wasAsked(input.attempt.status);
    const promptVersion = asked ? GENERATE_PROMPT_VERSION : null;
    this.store.db
      .prepare(
        `INSERT INTO resume_generations
         (id, doc_id, jd_id, prompt_version, model, model_status, status, retried, created_at, evidence_json, violations_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.docId,
        input.jdId,
        promptVersion,
        input.attempt.model,
        input.attempt.status,
        input.outcome,
        input.retried ? 1 : 0,
        input.createdAt,
        JSON.stringify(input.evidence),
        JSON.stringify(input.violations),
      );
    return {
      id,
      docId: input.docId,
      jdId: input.jdId,
      createdAt: input.createdAt,
      promptVersion,
      model: input.attempt.model,
      modelStatus: input.attempt.status,
      modelReason: input.attempt.reason,
      outcome: input.outcome,
      retried: input.retried,
      movedSections: input.movedSections,
      movedEntries: input.movedEntries,
      rewritesApplied: input.rewritesApplied,
      rewritesDropped: input.attempt.dropped,
    };
  }

  /**
   * 写一行生成日志（只记 id、计数与状态，§8.5 / 4.5-14 的脱敏口径）。
   * @param view 已经返回给调用方的读数（这里只读它的非正文部分）
   * @param requirementCount 参与本次生成的要求条数
   * @returns 无返回值；被拒与回落走 warn，让"用户拿到的其实只是重排"在日志里也显眼
   */
  private logRun(view: GenerationView, requirementCount: number): void {
    const { receipt, checks } = view;
    const leg =
      receipt.modelStatus === 'merged'
        ? `模型腿 merged 采纳 ${String(receipt.rewritesApplied)} 条（丢弃 ${String(receipt.rewritesDropped)}）`
        : `模型腿 ${receipt.modelStatus}（${receipt.modelReason ?? ''}）`;
    const line =
      `[kb-generate] ${receipt.id} · 结果 ${receipt.outcome} · 要求 ${String(requirementCount)} 条 ·` +
      ` 重排 区块 ${String(receipt.movedSections)} / 条目 ${String(receipt.movedEntries)} · ${leg}` +
      `${checks.retried ? ' · 已重试一次' : ''} · 校验 ${checks.ok ? '通过' : `未过（${String(checks.violationCount)} 条）`}` +
      `${receipt.promptVersion === null ? '' : ` · 提示词 ${receipt.promptVersion}`}`;
    if (receipt.outcome === 'rewritten') this.ctx.logger.info(line);
    else this.ctx.logger.warn(line);
  }
}

/**
 * 把「报告行 → 文档条目」的那份映射摊平成证据视图。
 *
 * 遍历的是**文档结构**而不是那张映射表：只有确实还在这份简历里的条目才出证据，
 * 顺序也因此跟文档一致（两次运行给同一份序列，4.5-07 的稳定性判据到这里仍然成立）。
 * @param document 重排后的文档（条目与基线同一批，只是序不同）
 * @param rows 缺口报告的三态行
 * @param drafts 同一份文档派生的实体草案
 * @returns 证据引用列表（按区块 → 条目 → 强度降序）
 */
function evidenceOf(
  document: ResumeDocument,
  rows: readonly GapRequirementView[],
  drafts: readonly KbEntityDraft[],
): GenerationEvidenceView[] {
  const relevance = evidenceOfEntries(rows, drafts);
  const views: GenerationEvidenceView[] = [];
  for (const section of document.sections) {
    for (const entry of section.entries) {
      const entryRelevance = relevance.get(entry.id);
      if (entryRelevance === undefined) continue;
      for (const hit of entryRelevance.hits) {
        views.push({
          sectionId: section.id,
          entryId: entry.id,
          evidenceId: hit.evidenceId,
          kind: hit.kind,
          label: hit.label,
          score: hit.score,
          tokens: hit.tokens,
        });
      }
    }
  }
  return views;
}

/**
 * 产物出厂前的最后一道 Schema 复验（4.5-01 的"通过 Schema 校验"落在生产代码里，而不只是测试里）。
 *
 * 单独成函数而不是在 `run()` 里内联三遍：保守版、第一轮产物、重试轮产物都要过同一道闸，
 * 少写一处就等于那条路径上的文档没被验过。
 * @param document 待复验的产物
 * @returns 校验通过的文档（`validateDocument` 的解析结果）
 * @throws AppError(`INVALID_ARGUMENT`) 自家代码产出的文档不合 Schema——那是 bug，结构化报出来而不是入库
 */
function validated(document: ResumeDocument): ResumeDocument {
  const result = validateDocument(document);
  if (!result.ok) {
    throw new AppError(
      'INVALID_ARGUMENT',
      `生成产物未通过 P3.1 Schema 校验：${result.issues.map((issue) => issue.path).join('、')}`,
    );
  }
  return result.document;
}

declare module '@auto-cc/core' {
  interface AppServices {
    'resume.generate': ResumeGenerateService;
  }
}
