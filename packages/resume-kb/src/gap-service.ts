/**
 * `kb.gap` service（spec 4.4-01 的入口位 / 4.4-02 的模型腿与可见回落 / 4.4-07 的稳定读数 /
 * 4.4-10 的来源标注）。
 *
 * 4.4 这条链在本包里只做**拆解**：输入一段 JD 正文，输出带原文位置的四类能力要求。
 * 「拿这些要求去库里比三态」（4.4-03 / 04）与「界面呈现」（4.4-05 / 06）分属 4.4-c 与 4.4-d，
 * 现在就把比对与界面写进来会同时踩两条规矩：AGENTS.md §2.6（不为假想的未来做抽象）与 §0（一次只推进一个切片）。
 *
 * 两条腿的分工是本服务的全部形状（plan §4.4-b 证据 [3] 对 4.4-a 草案的更正）：
 * **词面腿是基线，每次都跑；模型腿是增强，只在基线上补**。于是模型缺席时报告只是短一些，
 * 而拆解这件事本身不会失败——这正是 4.4-02 要的「功能不中断 + 回落可被看见」。
 *
 * 四条装配层的立身之本：
 * 1. **入参校验只在系统边界做**（§2.6）：JD 正文是从界面文本框或 `jobs.description` 进来的外部数据，
 *    所以过短在这里拒绝；判定本身仍旧全在 `requirements.ts` / `requirements-model.ts` 的纯函数里，
 *    本文件不重复任何规则（§2.5）。
 * 2. **模型只有一个入口**：本文件不出现端点、密钥与模型 SDK，全部经 `ChatGateway` 询问面拿
 *    （`llm.chat` 的实现，spec 2.5-12 / 4.4-08，由 `check-llm-single-entry` 机检）。
 * 3. **不建新表**（plan §4.4 口径 3）：拆解是几次正则、词典扫描加一次模型调用，代价与一次检索同量级，
 *    而 `jobs.requirements_json` 已经装了「页面原样的要求标签」——那是 2.3 抓取的真相源，
 *    把派生结果写回同一列就是造第二个真相（4.2-11 的同一件事）。可重建的投影不落库，用时现算。
 * 4. **日志只记计数与状态**（延续 4.3-12 的脱敏口径）：JD 正文与简历正文一样是个人的，
 *    本服务落的一行只有字数、条数、丢弃数、模型腿状态与模型名，**不含 JD 正文，也不含模型原文**。
 */
import { AppError, chatGatewayOf, Service, type Context } from '@auto-cc/core';
import { z } from 'zod';
import {
  extractRequirementsLexically,
  type LexicalExtractResult,
  type RequirementItem,
  type RequirementKind,
} from './requirements.js';
import {
  buildRequirementMessages,
  mergeModelWithLexical,
  readModelRequirements,
  REQUIREMENT_PROMPT_VERSION,
} from './requirements-model.js';

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
export const kbGapSchema = z.strictObject({
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
});

/** 校验后的配置形状。 */
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
 * @param status 模型腿结局
 * @returns 走到"问"这一步（含问了但失败 / 被拒）时为 true
 */
function wasAsked(status: GapModelStatus): boolean {
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
    this.report(trimmed.length, lexical, attempt);
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
   * 写一行拆解日志（只记计数与状态，§8.5 / 4.3-12 的脱敏口径）。
   * @param inputChars 参与拆解的正文字符数
   * @param lexical 词面腿的产出
   * @param attempt 模型腿的结局
   * @returns 无
   */
  private report(inputChars: number, lexical: LexicalExtractResult, attempt: ModelAttempt): void {
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
