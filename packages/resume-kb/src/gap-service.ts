/**
 * `kb.gap` service（spec 4.4-01 的入口位 / 4.4-02 的模型腿与可见回落 / 4.4-03 的三态比对 /
 * 4.4-04 的反向比对 / 4.4-06 的建议随结论 / 4.4-07 的稳定读数 / 4.4-10 的来源标注）。
 *
 * 4.4 这条链在本包里做到「拆解 + 比对」为止：输入一段 JD 正文，产出带原文位置的四类要求，
 * 再拿它们与库内的实体比出三态与亮点候选。出口有两个，读的是同一个 `GapReportView`：
 * agent 工具面在本文件 `[Service.init]` 里登记（4.4-05 的双入口），界面呈现与证据链跳转
 * （4.4-05 / 4.4-02 的 V 半边）在渲染层的 `GapPanel`，本文件不写任何 UI（§4.1 的依赖方向）。
 *
 * 两条腿的分工是本服务的形状（plan §4.4-b 证据 [3] 对 4.4-a 草案的更正）：
 * **词面腿是基线，每次都跑；模型腿是增强，只在基线上补**。于是模型缺席时报告只是短一些，
 * 而拆解这件事本身不会失败——这正是 4.4-02 要的「功能不中断 + 回落可被看见」。
 * 比对腿（4.4-c）反过来是**硬依赖**：报告要比的是"我这本库里有没有"，库里没有可比对象时
 * 给一份全缺失的报告等于把装配问题说成能力问题，所以那条路直接结构化失败（`KB_LIBRARY_MISSING`）。
 *
 * 五条装配层的立身之本：
 * 1. **入参校验只在系统边界做**（§2.6）：JD 正文是从界面文本框或 `jobs.description` 进来的外部数据，
 *    所以过短在这里拒绝；判定本身仍旧全在 `requirements.ts` / `requirements-model.ts` /
 *    `requirements-compare.ts` 的纯函数里，本文件不重复任何规则（§2.5）。
 * 2. **模型只有一个入口**：本文件不出现端点、密钥与模型 SDK，全部经 `ChatGateway` 询问面拿
 *    （`llm.chat` 的实现，spec 2.5-12 / 4.4-08，由 `check-llm-single-entry` 机检）。
 * 3. **库也只有一个入口**：比对要的那些行了当是 `kb.profile` 的 `list()` / `listChunks()`，
 *    用的时候按名字现问（§9 的 2.5 实测条），不在本服务里存第二份实体事实。
 * 4. **不建新表**（plan §4.4 口径 3）：拆解是几次正则、词典扫描加一次模型调用，比对是同一把
 *    `coverageOf` 上的几次数，代价与一次检索同量级；而 `jobs.requirements_json` 已经装了
 *    「页面原样的要求标签」——那是 2.3 抓取的真相源，把派生结果写回同一列就是造第二个真相（4.2-11）。
 *    可重建的投影不落库，用时现算。
 * 5. **日志只记计数与状态**（延续 4.3-12 的脱敏口径）：JD 正文与简历正文一样是个人的，
 *    本服务落的两行只有字数、条数、丢弃数、模型腿状态与模型名、比对三态计数与截止日期，
 *    **不含 JD 正文，也不含模型原文或库内正文**。
 */
import {
  agentTool,
  AppError,
  chatGatewayOf,
  maybeService,
  registerAgentTools,
  Service,
  toolResult,
  type Context,
} from '@auto-cc/core';
import { z } from 'zod';
import { KB_ENTITY_KINDS, monthIndexOf, monthKeyOf, type KbEntityKind } from './entities.js';
import {
  compareRequirements,
  libraryEntityOf,
  type GapCompareResult,
  type GapHighlightView,
  type GapRequirementView,
  type GapState,
} from './requirements-compare.js';
import {
  extractRequirementsLexically,
  type LexicalExtractResult,
  type RequirementItem,
  type RequirementKind,
} from './requirements.js';
import type { KbProfileService } from './profile-service.js';
import { mergeModelWithLexical, readModelRequirements } from './requirements-model.js';
import { buildRequirementMessages, REQUIREMENT_PROMPT_VERSION } from './prompts.js';

/**
 * 模型腿的五种结局（spec 4.4-02 的「不可用要能被看见」就落在这个字段上）。
 *
 * 与 4.3-d 向量腿的 `unavailable / failed / merged` 同一套语言，区别在 4.4 多了 `disabled`
 * （本条腿可以整体关掉，向量腿不行——关了就退回纯词面检索，用户不会察觉是配置还是故障），
 * 以及 `rejected`（模型答得上来但一条都没收下：引文对不上原文或不合契约）。
 * 五态都必须能在日志与界面上区分开，否则「回落」就又变成静默失败。
 */
export const GAP_MODEL_STATUSES = ['merged', 'rejected', 'failed', 'unavailable', 'disabled'] as const;

/** 模型腿结局的字面量类型。 */
export type GapModelStatus = (typeof GAP_MODEL_STATUSES)[number];

/**
 * `kb.gap` 的可调项。
 *
 * 每类上限放配置而不是写死（同 4.3-03「代码内无魔法数」）：4.4-05 的分栏界面一栏放十几条就要滚动，
 * 而不同岗位的 JD 写法差异很大（有的列 30 个技术名词），这个数应该按岗位类型调而不是发版。
 */
export const kbGapSchema = z
  .strictObject({
    /** 每一类最多保留几条要求（超出按稳定序列头部截断，丢弃条数如实报出）。 */
    perKindLimit: z.number().int().min(1).max(50).default(12),
    /**
     * JD 正文的下限（字符）。短到这个数基本是粘贴错了对话框或详情页没加载完，
     * 拆出来的「要求」没有依据；判成错误比给一份空报告诚实（spec 4.4-01 的入参校验）。
     */
    minJdChars: z.number().int().min(1).max(2000).default(20),
    /**
     * 是否允许问模型腿。关掉后本服务退回纯词面拆解（4.4-02 的「没有模型也能用」在运行期也要成立，
     * 而不是只靠摘插件——离线演示、省额度、以及 4.4-e 的额度闸门都直接把这个开关递给用户）。
     */
    allowModelLeg: z.boolean().default(true),
    /** 模型腿单次回复的长度上限（token）。四类型别 + 每类上限的清单远小于对话全文，1200 足够且防跑飞。 */
    modelMaxTokens: z.number().int().min(128).max(4096).default(1200),
    /**
     * 模型腿的采样温度。与话术生成的 0.7 相反，这里取 0：拆解是**读数**不是创作，
     * 同一个 JD 两次拆出不同的清单会让 4.4-07 的稳定性验收无从谈起。
     */
    modelTemperature: z.number().min(0).max(2).default(0),

    // ---- 以下六项属比对腿（spec 4.4-03 / 04 / 06，plan §4.4-c 判据一 / 二）----
    // 其中三条（`evidenceHitMinScore` / `evidencePartialMinScore` / `highlightMinScore`）是**测量型**：
    // 它们是这把 token 尺子的刻度，4.4-e 已按人判标注集标定（语料 `gap-calibration-corpus.ts`、
    // 选值 `gap-calibration.ts`、回归锁 `gap-calibration.test.ts`、读数
    // `docs/acceptance/4.4/4.4-e-threshold-calibration.txt`）。改这三个数必须重跑 `pnpm calibrate`，
    // 否则那条"选值 = 出厂值"的回归锁会直接发红。
    // 另两条（`yearsPartialRatio` / `maxHighlights`）是**口径型**：一个问"干满几成算部分够"，
    // 一个是界面一栏放几条，都不进标定——给产品决策套上数据的外衣比拍初值更不诚实（plan §4.4-e 判据三）。
    /** 每条要求最多挂几条证据（界面分栏一屏装得下的量）。 */
    evidenceTopK: z.number().int().min(1).max(10).default(3),
    /**
     * ≥ 此强度算「命中」。标定值 0.58 取自 (0.5, 0.6667] 这条空带的中间：0.5 那一档是部分命中
     * （压测脚本 ≠ 高并发设计），0.6667 是「项目管理」被写全的那条命中读数——两侧各留 0.08 余量，
     * 而不是贴着某条样本（plan §4.4-e 判据三）。
     */
    evidenceHitMinScore: z.number().min(0).max(1).default(0.58),
    /**
     * ≥ 此强度算「部分命中」，低于它算「缺失」。标定值 0.33 落在标注尺子的最小刻度上：
     * `coverageOf` 给的是 1/n 的离散读数，0.25（四条 token 里对上三条）是"词面巧合"的量级，
     * 必须留在缺失侧。已知代价：0.3333 这一档同时装着人判「部分命中」与「缺失」各一条
     * （T15 / T24），任何阈值都分不开——报告里那条翻脸记录是**标注与刻度的冲突**，不是选值失误。
     */
    evidencePartialMinScore: z.number().min(0).max(1).default(0.33),
    /** 库内总年限 ≥ 要求 × 此比例算部分命中（年限是算术判断，与文本阈值无关）。 */
    yearsPartialRatio: z.number().min(0).max(1).default(0.6),
    /**
     * 亮点候选与 JD 全文的最低覆盖率——只判「JD 没提」会把驾照、六级当亮点推给用户。
     * 标定值 0.11 是可行带上**唯一**的网格点（不相关侧最高 0.1，相关侧最低 0.1111），
     * 所以它的可信度低于上面两条：这一条线只能保证"明写了岗位技术的实体不被漏"，
     * 拦不住词面巧合（H12），界面因此把它叫"候选"而不是"亮点结论"。
     */
    highlightMinScore: z.number().min(0).max(1).default(0.11),
    /** 亮点候选最多几条（超出按强度截断，丢弃数随结果报出）。 */
    maxHighlights: z.number().int().min(0).max(20).default(6),
  })
  // 两条文本阈值必须有序，写反等于造一把"任何命中都先被判成缺失"的尺子。配置是用户可编辑的
  // 系统边界，所以在挂载前拒掉而不是在比对里兜底（§2.6，与 `outbound.throttle` 的 `min ≤ max` 同形）。
  .refine((config) => config.evidencePartialMinScore <= config.evidenceHitMinScore, {
    message: 'evidencePartialMinScore 不能大于 evidenceHitMinScore',
    path: ['evidenceHitMinScore'],
  });

/**
 * 校验后的配置形状。
 *
 * 两条文本阈值必须有序（部分 ≤ 命中），否则任何命中都会先被判成缺失；配置是用户可编辑的系统边界，
 * 所以这条约束在 schema 上拒掉而不是在比对里兜底（§2.6）。
 */
export type KbGapConfig = z.infer<typeof kbGapSchema>;

/**
 * 单条能力要求的形状：它是 `GapExtractView.items` 的元素，因此跟着本服务的返回值一起对外。
 * 类型从 `requirements.ts` 转出而不是在这里重新声明一份——同一形状出现两份就会各自漂移（§2.5）。
 */
export type { RequirementItem, RequirementKind } from './requirements.js';

/** 一次拆解的读数（界面与后续比对拿它当输入）。 */
export interface GapExtractView {
  /** 四类要求条目，已按「四类表次序 → 原文起始位置」排成稳定序列（spec 4.4-07）；词面腿与模型腿已合并 */
  items: RequirementItem[];
  /** 参与拆解的正文字符数——日志与界面播报用计数，不落 JD 正文（4.3-12 同口径） */
  inputChars: number;
  /** 被每类上限丢弃的条数——只统计**词面腿**那一路，模型腿的触顶数在 `modelDropped` 里 */
  droppedByLimit: number;
  /** 词表版本，随结果一起进复盘记录（同 2.5-09 的 `scriptVersion`） */
  lexiconVersion: string;
  /** 模型腿这次是哪五种结局之一（spec 4.4-02 的界面播报判据） */
  modelStatus: GapModelStatus;
  /** `modelStatus` 非 merged 时必填：为什么没用上模型，界面按它播报；merged 时为 null */
  modelReason: string | null;
  /** 实际完成本次拆解的模型名（来自 `llm.chat`，不是配置里的猜测）；没问过模型时 null */
  model: string | null;
  /** 模型腿实际并入的条数（merged 时 > 0；rejected 时为 0） */
  modelAdded: number;
  /** 模型腿被丢弃的条数合计：契约不合格 + 引文定位不到 + 与词面腿重复 + 触顶（4.4-06 的"负面结论要给依据"） */
  modelDropped: number;
  /** 提示词版本，随结果进复盘；没问过模型时 null */
  promptVersion: string | null;
}

/**
 * 一次缺口报告的读数 = 拆解视图（含模型腿五态）+ 比对结果。
 *
 * 界面上的"这次没用上模型"与"这三条JD要求你库里没据"要同时被看见，所以两层视图叠成一个返回体，
 * 而不是让渲染层自己拼两个调用（§5.9 双入口共用同一 service）。
 */
export interface GapReportView extends GapExtractView {
  /** 与 `items` 同序的三态行（比对不重排，界面分栏不再二次排序） */
  rows: readonly GapRequirementView[];
  /** 反向比对：库内具备、JD 未提、且与岗位相关的亮点候选（spec 4.4-04） */
  highlights: readonly GapHighlightView[];
  /** 因 `maxHighlights` 被截掉的候选条数 */
  highlightsDropped: number;
  /** 三态各多少条（4.4-06 的"计数可见"） */
  counts: Readonly<Record<GapState, number>>;
  /** 库内经验总月数（重叠区间合并后），界面换算成年 */
  totalExperienceMonths: number;
  /** 库内最高学历档位；库里没有学历区块时 null */
  libraryEducationRank: number | null;
  /** 参与比对的库内实体条数；0 条时界面上要说清"是没录简历，不是你不合格" */
  entityCount: number;
  /** 「至今」夹到的那个月（`YYYY-MM`）——年限读数的时间基准，界面必须播出去 */
  asOfMonth: string;
}

/**
 * 数出某一类的条数，供日志行用。
 * @param items 拆解结果
 * @param kind 四类之一的字面量
 * @returns 该类的条数
 */
function countOfKind(items: readonly RequirementItem[], kind: RequirementKind): number {
  return items.filter((item) => item.kind === kind).length;
}

/** 一次模型腿尝试的内部结果（`askModel` 的返回，直接摊进视图）。 */
interface ModelAttempt {
  status: GapModelStatus;
  reason: string | null;
  model: string | null;
  added: number;
  dropped: number;
  items: RequirementItem[];
}

/**
 * 这次是否真的把提示词发出去了（视图里的 `promptVersion` 与日志尾部的版本段共用这条判据）。
 *
 * 对外可见是因为 4.5 的生成腿共用同一套五态与同一条"没问过就不许报版本"的判断（§2.2）：
 * 生成记录表里的 `prompt_version` 也必须在这个函数说"没发过"时为 null，两处各写一遍迟早会分叉。
 * @param status 模型腿结局
 * @returns 走到"问"这一步（含问了但失败 / 被拒）时为 true
 */
export function wasAsked(status: GapModelStatus): boolean {
  return status !== 'disabled' && status !== 'unavailable';
}

export class KbGapService extends Service {
  static provide = 'kb.gap';
  static Config = kbGapSchema;

  constructor(
    ctx: Context,
    private readonly options: KbGapConfig,
  ) {
    // 必须接住第二个实参：cordis 递的是校验后的配置（AGENTS.md §9 实测 1.3）。
    super(ctx, 'kb.gap');
  }

  /**
   * 挂载时登记 agent 工具（spec 4.4-05 的双入口半边）。
   *
   * 这里只做登记，不 `inject` `kb.profile`、也不 `dependsOn`：报告需要库，但"库里还没录简历"要用
   * `KB_LIBRARY_MISSING` 在**调用那一刻**说出来（界面据此给「先去导入简历」），
   * 而硬依赖会让 `kb-gap` 整个服务起不来，界面就只能播一句"服务没起来"（plan §4.4-d 判据六）。
   * @returns 无返回值
   */
  [Service.init](): void {
    // 对话里问"这份 JD 我差在哪"和界面上的缺口面板必须打同一个 `report()`（§5.9：不许各长一套）。
    // `nowMs` 刻意不进工具入参：那等于让模型自己填"今天是几月"，而年限读数的基准只能由服务取当前时间
    // （4.4-07 要的是同一输入两次读数一致，不是一个模型可以随手编的输入）。
    const tools = registerAgentTools(this.ctx, [
      agentTool({
        id: 'kb.gap.report',
        titleKey: 'agent.tool.labels.kbGapReport',
        description:
          '把一段 JD 正文与本地简历知识库比对，返回三态缺口报告（命中 / 部分命中 / 缺失）、每条未命中要求的改写建议、库内具备而 JD 未提的相关亮点，以及经验月数与学历档位两个换算读数；模型腿不可用时自动退回词面拆解并在 modelStatus 里给出原因，全程只读本地库、不出网',
        input: z.strictObject({
          jdText: z.string(),
          kind: z.enum(KB_ENTITY_KINDS).optional(),
          sourceDocId: z.string().min(1).nullable().optional(),
        }),
        effect: 'read',
        requiresConfirmation: false,
        // 摘要不复述 JD 正文也不复述库内原文（4.3-12 的口径同样适用于返回值：它会经 IPC 落进渲染层日志），
        // 只报条数、参与比对的实体数与两个换算读数；引用给逐条撑着结论的证据 id。
        run: async (params) => {
          const report = await this.report(params.jdText, {
            kind: params.kind,
            sourceDocId: params.sourceDocId,
          });
          return toolResult(report, {
            summary:
              `缺口比对读毕：${String(report.rows.length)} 条要求逐条给出三态与依据 · ` +
              `库内 ${String(report.entityCount)} 条实体参与 · 经验合计 ${String(report.totalExperienceMonths)} 个月` +
              `（截至 ${report.asOfMonth}）· 亮点候选 ${String(report.highlights.length)} 条`,
            evidenceRefs: [
              ...new Set(report.rows.flatMap((row) => row.evidence.map((evidence) => `evidence:${evidence.id}`))),
              ...report.highlights.map((highlight) => `entity:${highlight.entityId}`),
            ],
          });
        },
      }),
    ]);
    // 库在不在装配里，是运行期每次调用都要现问的事实（§9 的 2.5-e：不存第二份），
    // 但启动时把当前读数写出来才有现场可诊断——`report()` 抛 `KB_LIBRARY_MISSING` 时日志里连一行都没有。
    const hasLibrary = maybeService<KbProfileService>(this.ctx, 'kb.profile') !== undefined;
    this.ctx.logger.info(
      `[kb-gap] 缺口比对就绪：阈值 topK=${String(this.options.evidenceTopK)}` +
        ` hit=${String(this.options.evidenceHitMinScore)} partial=${String(this.options.evidencePartialMinScore)}` +
        ` yearsRatio=${String(this.options.yearsPartialRatio)} highlight=${String(this.options.highlightMinScore)}` +
        ` maxHighlights=${String(this.options.maxHighlights)} · 模型腿 ${
          this.options.allowModelLeg ? '开' : '关（纯词面）'
        } · 知识库 ${hasLibrary ? '已装配' : '未装配（调用时报 KB_LIBRARY_MISSING）'}` +
        ` · agent 工具登记 ${String(tools)} 个${tools === 0 ? '（注册表未挂载）' : ''}`,
    );
  }

  /**
   * 把一段 JD 正文拆成四类能力要求：先跑词面腿拿基线，再问模型腿做增强，最后合并成稳定序列。
   *
   * 模型腿的任何失败都不会让本方法失败（4.4-02 的「功能不中断」）：拿不到网关、没配 key、
   * 超时、返回的不是 JSON、引文对不上原文——一律退回词面腿的结果并把原因放进视图。
   * 唯一的例外是 `llm.chat` 抛 `INVALID_ARGUMENT`：那是我们拼错了请求而不是模型不可用，
   * 回落只会把 bug 藏起来（`outbound.script` 的同一判据）。
   * @param jdText JD 正文（来自界面文本框或 `jobs.description`，单位：JS 字符串）
   * @returns 合并后的稳定序列 + 两条腿各自的版本、计数与模型腿结局
   * @throws AppError(`INVALID_ARGUMENT`) 正文去空白后短于 `minJdChars`，或模型腿请求本身不合法
   */
  async extract(jdText: string): Promise<GapExtractView> {
    const trimmed = jdText.trim();
    if (trimmed.length < this.options.minJdChars) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `JD 正文去空白后只有 ${String(trimmed.length)} 字，少于下限 ${String(this.options.minJdChars)} 字：拆不出可信的能力要求`,
      );
    }
    const lexical = extractRequirementsLexically(trimmed, this.options.perKindLimit);
    const attempt = await this.askModel(trimmed, lexical.items);
    this.logExtract(trimmed.length, lexical, attempt);
    return {
      items: attempt.items,
      inputChars: trimmed.length,
      droppedByLimit: lexical.droppedByLimit,
      lexiconVersion: lexical.lexiconVersion,
      modelStatus: attempt.status,
      modelReason: attempt.reason,
      model: attempt.model,
      modelAdded: attempt.added,
      modelDropped: attempt.dropped,
      promptVersion: wasAsked(attempt.status) ? REQUIREMENT_PROMPT_VERSION : null,
    };
  }

  /**
   * 问一次模型腿，把五种结局收敛成一个 `ModelAttempt`，不在这里决定界面怎么播。
   * @param jdText 去空白后的 JD 正文（与提示词里那份同一个字符串，引文才定位得回去）
   * @param lexicalItems 词面腿的产出，作为合并的底座
   * @returns 合并后的序列与各计数；词面腿基线在任何分支下都完整保留在 `items` 里
   */
  private askModel = async (jdText: string, lexicalItems: readonly RequirementItem[]): Promise<ModelAttempt> => {
    // 除 merged 之外的四种结局，交回来的序列都是词面基线原样——这条不变量就是 4.4-02 的「功能不中断」。
    const fallback = (status: GapModelStatus, model: string | null, reason: string): ModelAttempt => ({
      status,
      reason,
      model,
      added: 0,
      dropped: 0,
      items: [...lexicalItems],
    });
    if (!this.options.allowModelLeg) {
      return fallback('disabled', null, '配置里关掉了模型腿（allowModelLeg=false）');
    }
    const gateway = chatGatewayOf(this.ctx);
    if (!gateway) {
      return fallback('unavailable', null, '模型出口 llm.chat 未装配，本次只做词面拆解');
    }
    const configured = gateway.status();
    if (!configured.available) {
      return fallback('unavailable', configured.model, `模型未配置，缺 ${configured.missing.join(' / ')}`);
    }
    let reply: string;
    let modelName: string;
    try {
      const completion = await gateway.complete({
        messages: buildRequirementMessages(jdText, this.options.perKindLimit),
        maxTokens: this.options.modelMaxTokens,
        temperature: this.options.modelTemperature,
      });
      reply = completion.text;
      // 用回复里回报的模型名，而不是配置里的：换了模型的报告要能看出来是哪一款产的。
      modelName = completion.model;
    } catch (cause) {
      // 模型侧的入参错误说明是我们的问题，回落只会掩盖它。
      if (cause instanceof AppError && cause.code === 'INVALID_ARGUMENT') throw cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      // 上游的句子已经以「模型请求…」开头（`llm.chat` 的文案），这里换个动词避免读成重复的一句。
      return fallback('failed', configured.model, `问模型失败：${message}`);
    }

    const read = readModelRequirements(reply, jdText);
    if (read.accepted.length === 0) {
      return {
        ...fallback('rejected', modelName, read.reason ?? '模型产出无法采信'),
        dropped: read.droppedUnlocatable + read.droppedInvalid,
      };
    }
    const merged = mergeModelWithLexical(lexicalItems, read.accepted, this.options.perKindLimit);
    const dropped = merged.droppedDuplicate + merged.droppedByLimit + read.droppedUnlocatable + read.droppedInvalid;
    if (merged.added === 0) {
      return {
        ...fallback('rejected', modelName, `模型产出的 ${String(read.accepted.length)} 条与词面腿完全重复`),
        dropped,
      };
    }
    return {
      status: 'merged',
      // 部分丢弃（引文对不上、契约不合格）时 reason 非 null：merged 也要能说清「模型的 5 条里我们只收了 2 条」。
      reason: read.reason,
      model: modelName,
      added: merged.added,
      dropped,
      items: merged.items,
    };
  };

  /**
   * 把一份 JD 与知识库比成缺口报告：三态比对 + 反向比对（spec 4.4-03 / 04 / 06 / 07）。
   *
   * 拆解**复用** `extract()`，本方法不重开一条拆解通道（§2.5）；判据全在 `requirements-compare.ts` 的纯函数里，
   * 这里只做投影（库内实体 / 学历区块）与播报。
   *
   * 与模型腿不同，**库是必需输入而不是增强**：`kb.profile` 不在装配里时抛 `KB_LIBRARY_MISSING`，
   * 而不是给一份"全是缺失"的报告——那是最容易骗到自己的一种假读数（plan §4.4-c 接线形状）。
   * @param jdText JD 正文（与 `extract()` 同一份入参口径）
   * @param filter 比对范围：`sourceDocId` 限定"针对哪份简历"，不传则全库（含手工实体）
   * @param nowMs 「今天」的时间戳（毫秒）。显式入参而不是在比对里读时钟：4.4-07 要"同一输入两次运行
   *              hash 相同"，隐式读现状会让报告在跨月的那一刻莫名变红。
   * @returns 拆解视图 + 三态行 + 亮点候选 + 三态计数与两个换算读数
   * @throws AppError(`INVALID_ARGUMENT`) JD 过短（由 `extract()` 判）；
   *         AppError(`KB_LIBRARY_MISSING`) 知识库服务未装配
   */
  async report(
    jdText: string,
    filter: { kind?: KbEntityKind; sourceDocId?: string | null } = {},
    nowMs = Date.now(),
  ): Promise<GapReportView> {
    const extracted = await this.extract(jdText);
    const profile = maybeService<KbProfileService>(this.ctx, 'kb.profile');
    if (!profile) {
      throw new AppError('KB_LIBRARY_MISSING', '知识库服务 kb.profile 未装配：缺口报告没有可比的对象');
    }
    const entities = profile.list(filter).map(libraryEntityOf);
    const educationChunks = profile
      .listChunks()
      .filter((chunk) => chunk.sectionKind === 'education')
      .map((chunk) => ({ chunkId: chunk.chunkId, text: chunk.text }));
    const compared = compareRequirements(
      { jdText: jdText.trim(), items: extracted.items, entities, educationChunks },
      {
        evidenceTopK: this.options.evidenceTopK,
        hitMinScore: this.options.evidenceHitMinScore,
        partialMinScore: this.options.evidencePartialMinScore,
        yearsPartialRatio: this.options.yearsPartialRatio,
        highlightMinScore: this.options.highlightMinScore,
        maxHighlights: this.options.maxHighlights,
        nowMonth: monthIndexOf(nowMs),
      },
    );
    this.logComparison(compared, entities.length, nowMs);
    return {
      ...extracted,
      rows: compared.rows,
      highlights: compared.highlights,
      highlightsDropped: compared.highlightsDropped,
      counts: compared.counts,
      totalExperienceMonths: compared.totalExperienceMonths,
      libraryEducationRank: compared.libraryEducationRank,
      entityCount: entities.length,
      asOfMonth: monthKeyOf(nowMs),
    };
  }

  /**
   * 写一行比对日志：只有三态计数、候选条数与"截至"的年月，**没有 JD 正文、没有实体文本**（4.3-12 口径）。
   * @param compared 一次比对的读数
   * @param entityCount 参与比对的库内实体条数
   * @param nowMs 「今天」的时间戳（毫秒），换算成 `YYYY-MM` 播报
   * @returns 无
   */
  private logComparison(compared: GapCompareResult, entityCount: number, nowMs: number): void {
    const line =
      `[kb-gap] 比对：要求 ${String(compared.rows.length)} 条 →` +
      ` 命中 ${String(compared.counts.matched)} / 部分 ${String(compared.counts.partial)} /` +
      ` 缺失 ${String(compared.counts.missing)}` +
      ` · 亮点候选 ${String(compared.highlights.length)}（丢弃 ${String(compared.highlightsDropped)}）` +
      ` · 库内实体 ${String(entityCount)} 条 · 经验合计 ${String(compared.totalExperienceMonths)} 月` +
      ` · 截至 ${monthKeyOf(nowMs)}`;
    // 一份全是缺失的报告是产品最该显眼的时刻，不该混在 INFO 流里。
    if (compared.counts.matched === 0 && compared.rows.length > 0) this.ctx.logger.warn(line);
    else this.ctx.logger.info(line);
  }

  /**
   * 写一行拆解日志（只记计数与状态，§8.5 / 4.3-12 的脱敏口径）。
   * @param inputChars 参与拆解的正文字符数
   * @param lexical 词面腿的产出
   * @param attempt 模型腿的结局
   * @returns 无
   */
  private logExtract(inputChars: number, lexical: LexicalExtractResult, attempt: ModelAttempt): void {
    const counts =
      `硬技能 ${String(countOfKind(lexical.items, 'hard_skill'))}` +
      ` / 软技能 ${String(countOfKind(lexical.items, 'soft_skill'))}` +
      ` / 学历 ${String(countOfKind(lexical.items, 'education'))}` +
      ` / 年限 ${String(countOfKind(lexical.items, 'experience_years'))}`;
    const leg =
      attempt.status === 'merged'
        ? `模型腿 merged 并入 ${String(attempt.added)} 条`
        : `模型腿 ${attempt.status}（${attempt.reason ?? ''}）`;
    // 没问过的两种结局（disabled / unavailable）不把提示词版本写进日志——那会读成"发过这份提示词"。
    const asked = wasAsked(attempt.status);
    const line =
      `[kb-gap] 拆解 ${String(inputChars)} 字 → 词面 ${String(lexical.items.length)} 条（${counts}，` +
      `丢弃 ${String(lexical.droppedByLimit)}） · ${leg} · 丢弃 ${String(attempt.dropped)} 条` +
      ` · 词表 ${lexical.lexiconVersion}` +
      (asked ? ` / 提示词 ${REQUIREMENT_PROMPT_VERSION}` : '');
    if (attempt.status === 'merged') this.ctx.logger.info(line);
    else this.ctx.logger.warn(line);
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'kb.gap': KbGapService;
  }
}
