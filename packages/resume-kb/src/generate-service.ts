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
 * 1. **`run()` 不写工作副本**。产物是"提议态"，唯一的 `save()` 发生在 `accept()` 里、
 *    也就是用户逐项接受之后（4.5-11）。于是生成这条路对 `resume.doc` 只有 `load()`，
 *    这是 4.5-05 那句"拒绝产出"能被断言的前提：没有产物可捞，也没有半份改动留在副本里。
 *    接受侧同样不放松：写之前比基线、写之前复验，两道都过才动那份文档（见 `accept()`）。
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
import { validateDocument, type Entry, type ResumeDocument, type Section } from '@auto-cc/plugin-resume-doc';
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
 * 主进程侧最多同时保留几份待接受产物（4.5-11 的落点上限）。
 *
 * 要一个上限而不是"来多少存多少"：每份提议态装的是一整份简历文档，用户连着试十几段 JD 是正常用法，
 * 内存不该只跟着使用次数涨。也不做成"只留最近一份"——逐项接受要回头对比，生成第二次就把第一次的
 * 表态弄丢是不可接受的。超出即挤掉最早那份，界面对它得到 `KB_GENERATION_PROPOSAL_MISSING`。
 */
export const MAX_PENDING_PROPOSALS = 8;

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
 * **随改写一起过界的还有原文与位置标签**（4.5-c 补的一条，此前这里写的是"不回原文"）：
 * 逐项接受要人判断的是「这句改得对不对」，只给新写法就等于让人蒙着签字；而渲染层没有
 * 读工作副本的白名单口（`resume.doc.*` 一条都不在允许清单里），"界面自己去读原文"无从落地。
 * 过界的是**这一条被改动的字段**的那一份正文，不是 P3.1 文档模型本体——后者仍然不过桥（判据二）。
 */
export interface GenerationRewriteView {
  readonly sectionId: string;
  readonly entryId: string;
  readonly fieldKey: string;
  /** 区块标题（文档里的 `title` 原样，界面用它说"改的是哪一段"）。 */
  readonly sectionTitle: string;
  /** 条目标签（该条目里被事实锁定的字段值拼出来，见 `entryLabelOf`）。 */
  readonly entryLabel: string;
  /** 改写前的正文（就是工作副本里那一份，逐字）。 */
  readonly originalText: string;
  readonly rewrittenText: string;
  /**
   * 这段原文在知识库里的**出处 id**（4.5-06 的收口：被改写的原文本来就是库里那份记录）。
   * 与 `evidence` 那一份是两类依据：那份是"这条目命中了 JD 的哪条要求"，这份是"这段原文出自哪条实体"。
   *
   * 判据是**载荷逐字相等**（`sourceEvidenceIdsOf`）：实体草案是 `deriveEntities(基线)` 现算的，
   * 所以这里与"实体表同步过没有"无关，界面不许把它说成"你还没同步"。
   * 为空只有两种情况，靠下面的 `entryModeled` 分开，播报也各是一句（都不许伪装成"有依据"）：
   * ① `entryModeled` 为 false：该条目所属区块按 4.2 裁定二**不产实体行**（`summary` / `education` /
   *    `campus`）——那段散文在库里的形态是区块级切片，切片 id 属于 `kb.profile` 的派生索引，
   *    本服务不越包去读那张表（§2.7），所以这里给不出 id 也不是漏判；
   * ② `entryModeled` 为 true 但仍然为空：这个条目产了实体行，只是**这一个字段的原文**不是任何一条
   *    载荷的值（例如条目里的短字段没被单独建模）。这时界面要说"回查不到逐字出处，这句要人工确认"。
   */
  readonly sourceEvidenceIds: readonly string[];
  /** 该条目在库里是否派生出了实体行（区分上面两种空态用的那一位，不是"有没有出处"本身）。 */
  readonly entryModeled: boolean;
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
 * 一次换位的读数 + 界面要指认的对象标签（4.5-02 的 V 半边）。
 *
 * `ReorderBasis` 里只有 id 与下标——那是给代码看的。界面上"这段被提前了"必须说出**是哪段**，
 * 而标签只能从文档结构取（区块 `title` / 条目里被锁定的字段值），所以这一层在装配层补，
 * 不放进 `generate-reorder.ts`：那个文件是纯排序函数，让它去拼中文标签等于把展示逻辑塞进判据里。
 */
export interface GenerationReorderView extends ReorderBasis {
  readonly label: string;
}

/**
 * 界面上逐项表态的那一份（spec 4.5-11：接受后才写入工作副本）。
 *
 * 用**下标**而不是位置三键：改写列表是随一次生成给出去的，下标不会与别的产物串台；
 * 下标以 `view.rewrites` 的顺序为准（界面显示的就是那一份，表态必须落在看得见的那一行上）。
 * 下标越界一律以 `INVALID_ARGUMENT` 拒绝（那是"界面停在旧产物上"，不是"少接受一条"）；
 * 重复下标按"只接受一次"处理，不去猜用户为什么数了两遍。
 */
export interface GenerationDecision {
  readonly acceptedIndexes: readonly number[];
  /** 重排是整组接受 / 整组回退：逐条回退会让位置互相依赖变成二次猜测（判据一的稳定序前提就没了）。 */
  readonly applyReorder: boolean;
}

/** 接受成功后的读数（界面据此播报"写进去了几处、动没动顺序"）。 */
export interface GenerationAcceptResult {
  readonly docId: string;
  readonly receiptId: string;
  readonly appliedRewrites: number;
  readonly reorderApplied: boolean;
  readonly movedSections: number;
  readonly movedEntries: number;
  /** 写入后工作副本的 `updatedAt`（毫秒），界面上"改的是哪一版"的凭据。 */
  readonly updatedAt: number;
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
  readonly reorderBases: readonly GenerationReorderView[];
  readonly checks: GenerationChecksView;
  readonly receipt: GenerationReceipt;
}

/**
 * 主进程侧替用户暂存的那份提议态（4.5-11 的落点）。
 *
 * **为什么必须有**：逐项接受要写的是"基线 + 用户选中的那几处改写 + 要不要重排"，
 * 而这三样都不该由渲染层拼——正文不过进程边界（判据二），位置三键由界面回传就等于让界面决定
 * 往哪一格写什么。所以 `run()` 把这一份留在内存里，`accept()` 只认 `receiptId`。
 * 有意的取舍：**进程寿命内的状态**。热改配置会重建本服务（§9 实测 2.5），重建后旧 `receiptId`
 * 一律 `KB_GENERATION_PROPOSAL_MISSING`，界面据此提示"重新生成一次"；把提议态持久化会往
 * `resume_generations` 里加正文列，那是判据三明确不要的东西（被拒内容不留整段），不落库是规则而非疏漏。
 */
interface PendingProposal {
  /** 生成那一刻的工作副本（接受前要比对，用户中途改过简历就不能再按旧产物写）。 */
  readonly baseline: ResumeDocument;
  /** 重排后的区块序列（与 `view.reorderBases` 同源）。 */
  readonly sections: readonly Section[];
  /** 拼提示词时用的那份 JD 正文（`accept` 里复验具名回查要用，界面无从提供）。 */
  readonly jdText: string;
  readonly view: GenerationView;
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

  /**
   * 待用户逐项表态的产物（`receiptId` → 提议态），4.5-11 的唯一落点。
   *
   * 有意是**进程内**状态：见 `PendingProposal` 的注释（不落库是判据三的规则，不是疏漏）。
   */
  private readonly proposals = new Map<string, PendingProposal>();

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
      document: product,
      // 逐条改写的原文与位置标签从**文档**这一侧取（不是从模型回答取）：界面上"改了什么"必须
      // 与简历里那一条逐字对得上，而模型回报的位置只是请求清单的复读（判据六）。
      rewrites: product === null ? [] : rewriteRows(reorderedDoc, attempt.rewrites, drafts),
      evidence,
      // 被拒时没有产物，重排依据也不播报——留着就会长成"看起来提前过但又没东西可看"。
      reorderBases: product === null ? [] : reorderLabelsWith(reorderedDoc, reordered.bases),
      checks: { ok: check?.ok === true, retried, violations, violationCount: violations.length },
      receipt,
    };
    if (product !== null) {
      // 提议态留在主进程：`accept` 认的是 `receiptId`，位置三键与正文都不经界面来回（判据二 / 4.5-11）。
      this.remember(receipt.id, {
        baseline,
        sections: reordered.sections,
        jdText,
        view,
      });
    }
    this.logRun(view, report.rows.length);
    return view;
  }

  /**
   * 按用户在界面上的逐项表态，把选中的改写与（可选的）重排写进工作副本（spec 4.5-11）。
   *
   * 三条不放行的判定，都在"写"之前：
   * 1. **提议态还在**（本服务重启过 / 超出保留窗口 → 让界面重新生成，不猜用户当时看到什么）；
   * 2. **工作副本逐字未变**（生成之后用户自己改过简历 → 两份改动叠在一起是谁都没法解释的产物）；
   * 3. **子集再过一次同一套校验**（每条改写各自守恒数值，所以子集必然通过；这里跑它不是为了防模型，
   *    是为了防"界面回传的下标拼出来一份我们没验过的组合"——写用户简历是全片唯一不可逆的动作）。
   * 一条都没勾且重排也没采纳时**一次盘都不落**（见函数体里那条早退），返回的是零改写的读数。
   * @param receiptId 一次生成的凭证 id（`receipt.id`，同时是 `resume_generations` 那一行的主键）
   * @param decision 逐项表态：接受哪几条改写（下标）、要不要采纳重排
   * @param nowMs 写入时刻（毫秒），只用于比对与读数，不进 `save`
   * @returns 写进去的改写条数、是否采纳重排、以及工作副本写入后的 `updatedAt`
   * @throws AppError(`KB_GENERATION_PROPOSAL_MISSING` / `INVALID_ARGUMENT` / `KB_SOURCE_MISSING` /
   *         `KB_GENERATION_STALE_BASELINE` / `KB_GENERATION_CHECK_FAILED`)
   */
  accept(receiptId: string, decision: GenerationDecision, nowMs = Date.now()): GenerationAcceptResult {
    const proposal = this.proposals.get(receiptId);
    if (proposal === undefined) {
      throw new AppError(
        'KB_GENERATION_PROPOSAL_MISSING',
        `找不到 ${receiptId} 的提议态：服务重启过或该产物已超出保留窗口，请重新生成一次`,
      );
    }
    if (proposal.view.document === null) {
      throw new AppError('INVALID_ARGUMENT', `${receiptId} 那次生成被拒绝产出，没有可接受的改写`);
    }
    const docId = proposal.view.receipt.docId;
    // 表态的是**界面看见的那一行**（`view.rewrites`），不是模型回答里的那一条：两者的顺序不同
    // （行按文档结构排，回答按模型给的顺序排），拿回答侧的下标就等于让用户签他没看见的东西。
    const rows = proposal.view.rewrites;
    const shouldApply = new Set<number>();
    for (const index of decision.acceptedIndexes) {
      if (rows[index] === undefined) {
        throw new AppError(
          'INVALID_ARGUMENT',
          `接受列表里的第 ${String(index)} 条不在 ${receiptId} 的改写清单里：界面可能停在旧产物上，请重新生成`,
        );
      }
      shouldApply.add(index);
    }
    const selected = rows
      .filter((_, index) => shouldApply.has(index))
      .map((row) => ({
        sectionId: row.sectionId,
        entryId: row.entryId,
        fieldKey: row.fieldKey,
        originalText: row.originalText,
        rewrittenText: row.rewrittenText,
      }));
    const loaded = this.docStore.load(docId);
    if (loaded.status !== 'found') {
      throw new AppError('KB_SOURCE_MISSING', `工作副本 ${docId} ${loaded.status === 'missing' ? '不存在' : '已损坏'}`);
    }
    if (JSON.stringify(loaded.document) !== JSON.stringify(proposal.baseline)) {
      throw new AppError(
        'KB_GENERATION_STALE_BASELINE',
        `工作副本 ${docId} 在生成之后被改过：先重新生成，再逐项接受，不要把两份改动叠在一起`,
      );
    }
    if (selected.length === 0 && !decision.applyReorder) {
      // 一条没勾、重排也没采纳：这声"接受"没有要写的内容，就一次盘都不落。
      // 写下去会顶掉 `updated_at`，用户明明什么都没采纳，简历却显示"刚刚被改过"——
      // 那是界面读数在撒谎。提议态也留着不删（这次表态还没用完）。
      return {
        docId,
        receiptId,
        appliedRewrites: 0,
        reorderApplied: false,
        movedSections: 0,
        movedEntries: 0,
        updatedAt: loaded.document.updatedAt,
      };
    }
    const sections = decision.applyReorder ? proposal.sections : proposal.baseline.sections;
    const proposed = applyRewrites({ ...proposal.baseline, sections: [...sections] }, selected);
    const verified = verifyGeneration({ original: proposal.baseline, proposed, jdText: proposal.jdText });
    if (!verified.ok) {
      // 违规读数走 `describeViolations`，它每条都过 `redactText`（4.5-14 的偏离二），
      // 所以这句错文可以安全地进日志与界面。
      throw new AppError(
        'KB_GENERATION_CHECK_FAILED',
        `接受后的文档未过事实校验（${describeViolations(verified).join('；')}）：本次不写入工作副本`,
      );
    }
    // 时刻由这次表态决定，而不是沿用基线：`resume.doc.save()` 存的是文档自带的 `updatedAt`，
    // 不重新打点。内容换了、时刻还停在导入那一刻，3.7 的快照与界面上的"哪一版"就都读不出先后。
    this.docStore.save(validated({ ...proposed, updatedAt: nowMs }));
    // 一次接受用掉一份提议态：同一个 receiptId 再接受一次，读到的就是刚才那份副本（必然撞上面
    // 那条 stale），删掉它让它落在"重新生成"这句更清楚的话上。
    this.proposals.delete(receiptId);
    return {
      docId,
      receiptId,
      appliedRewrites: selected.length,
      reorderApplied: decision.applyReorder,
      movedSections: decision.applyReorder ? proposal.view.receipt.movedSections : 0,
      movedEntries: decision.applyReorder ? proposal.view.receipt.movedEntries : 0,
      updatedAt: nowMs,
    };
  }

  /**
   * 记住一份提议态，并把超出保留窗口的旧产物挤掉。
   * @param receiptId 那次生成的凭证 id
   * @param proposal 装配好的提议态
   * @returns 无返回值
   */
  private remember(receiptId: string, proposal: PendingProposal): void {
    this.proposals.set(receiptId, proposal);
    while (this.proposals.size > MAX_PENDING_PROPOSALS) {
      const oldest = this.proposals.keys().next();
      if (oldest.done === true) break;
      this.proposals.delete(oldest.value);
    }
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

/** 位置三键的拼接（区块 / 条目 / 字段），与 `applyRewrites`、`checkFactLock` 的定位口径一致。 */
const positionKey = (sectionId: string, entryId: string, fieldKey: string): string =>
  [sectionId, entryId, fieldKey].join('\u0001');

/**
 * 一个条目在界面上的名字（4.5-11 的"这条改得对不对"要先能指认是哪一条）。
 *
 * 取**被事实锁定的那几个字段值**，因为它们是"这是哪一段经历"的坐标（公司 · 职位 / 学校 · 专业）；
 * 散文段不当名字：改写面就是那段散文，用旧内容当标题会让"改前 / 改后"两栏看着一模一样。
 * 一个锁定字段都没有（技能与校园那类只有 `text`）时退回正文前 40 字——那是该条目唯一的可指认信息。
 * @param entry 文档里的一个条目
 * @returns 一句短标签；条目没有任何非空字段时为空串（Schema 要求字段有值，读到空即文档本身已异常）
 */
function entryLabelOf(entry: Entry): string {
  const locked = entry.fields
    .filter((field) => field.locked)
    .map((field) => field.value.trim())
    .filter((value) => value !== '')
    .slice(0, 2);
  if (locked.length > 0) return locked.join(' · ');
  const body = (entry.fields.find((field) => field.value.trim() !== '')?.value ?? '').trim();
  return body.length > 40 ? body.slice(0, 40) + '…' : body;
}

/**
 * 这段原文在知识库里的出处实体 id（spec 4.5-06 的收口半边）。
 *
 * 认领方式是**载荷逐字相等**：不做 id 反解（`entityId` 是哈希前 16 位，不可逆，见
 * `KbEntityDraft.entryId` 的注释），也不加一张 fieldKey→kind 映射表——那张表就是第二份真相源（§2.5），
 * 而"这段被改写的散文在库里是哪条实体"这个问题，内容相等这一条判据已经足够回答。
 * 命中多条全部带上（一条经历同时派生出经历实体与成果实体是正常的），顺序等于派生顺序（确定序）。
 * @param entryId 被改写条目在文档里的 id
 * @param originalText 改写前那份正文（工作副本里的逐字原文）
 * @param drafts 同一份文档现算的实体草案
 * @returns 出处实体 id 列表；为空就是 `GenerationRewriteView.sourceEvidenceIds` 注释里那两种情况之一
 */
function sourceEvidenceIdsOf(entryId: string, originalText: string, drafts: readonly KbEntityDraft[]): string[] {
  return drafts
    .filter((draft) => draft.entryId === entryId && Object.values(draft.payload).includes(originalText))
    .map((draft) => draft.entityId);
}

/**
 * 把采信进产物的改写摊成界面上逐项表态的一行（spec 4.5-11 的数据面）。
 *
 * 遍历方向是**文档 → 改写**而不是改写 → 文档：原文、区块标题、条目标签必须取自工作副本那一份，
 * 所以传进来的是"重排后、改写前"的那份文档，不是产物——产物的字段值已经是改写后的内容，
 * 拿它当原文等于把改后的那句话印进"改前"栏，逐项接受就变成让人对着新写法签旧写法。
 * 顺序按文档结构（区块 → 条目 → 字段）而不是模型回答顺序：界面要按简历的阅读次序排。
 * @param document 改写**前**的那一份（结构已重排、字段值仍是基线）
 * @param rewrites 通过契约与位置校验、装进产物的那些改写（未通过的不在这里）
 * @param drafts 同一份文档现算的实体草案，供出处回查
 * @returns 与 `rewrites` 等长的行列表；位置对不上的改写不会出现（`readModelRewrites` 已按清单核对过位置）
 */
function rewriteRows(
  document: ResumeDocument,
  rewrites: readonly GeneratedRewrite[],
  drafts: readonly KbEntityDraft[],
): GenerationRewriteView[] {
  const rewriteAt = new Map(
    rewrites.map((rewrite) => [positionKey(rewrite.sectionId, rewrite.entryId, rewrite.fieldKey), rewrite]),
  );
  // 一位集合而不是每条再扫一遍草案：界面分两种空态要用的就是"这个条目派生过实体行没有"。
  const modeledEntryIds = new Set(drafts.map((draft) => draft.entryId));
  const rows: GenerationRewriteView[] = [];
  for (const section of document.sections) {
    for (const entry of section.entries) {
      for (const field of entry.fields) {
        const rewrite = rewriteAt.get(positionKey(section.id, entry.id, field.key));
        if (rewrite === undefined) continue;
        rows.push({
          sectionId: section.id,
          entryId: entry.id,
          fieldKey: field.key,
          sectionTitle: section.title,
          entryLabel: entryLabelOf(entry),
          originalText: field.value,
          rewrittenText: rewrite.rewrittenText,
          sourceEvidenceIds: sourceEvidenceIdsOf(entry.id, field.value, drafts),
          entryModeled: modeledEntryIds.has(entry.id),
        });
      }
    }
  }
  return rows;
}

/**
 * 给每个换位对象补上"它是哪一段"的名字（spec 4.5-02 的 V 半边）。
 *
 * `ReorderBasis` 只有 id 与下标，那是判据用的读数；界面上"这段被提前了"必须说得出是哪段，
 * 而名字只在文档结构里（区块 `title` / 条目里被锁定的字段值）。读的是改写**前**那份文档，
 * 与 `rewriteRows` 同一口径：位置是这次生成造成的，名字得是用户当时看见的那一份。
 * @param document 改写前的那一份（结构已重排）
 * @param bases 只含真正换了位置的对象
 * @returns 与 `bases` 等长同序的读数，每条多一个 `label`（id 在文档里查不到时退回 id 本身，不编名字）
 */
function reorderLabelsWith(document: ResumeDocument, bases: readonly ReorderBasis[]): GenerationReorderView[] {
  const labelAt = new Map<string, string>();
  for (const section of document.sections) {
    labelAt.set(section.id, section.title);
    for (const entry of section.entries) {
      labelAt.set(entry.id, entryLabelOf(entry));
    }
  }
  return bases.map((basis) => ({ ...basis, label: labelAt.get(basis.id) ?? basis.id }));
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
