/**
 * `kb.gap` service（spec 4.4-01 的入口位 / 4.4-07 的稳定读数 / 4.4-10 的来源标注，
 * 并为 4.4-02 的模型腿与回落播报留好了唯一接入口）。
 *
 * 4.4 这条链在本包里只做**拆解**：输入一段 JD 正文，输出带原文位置的四类能力要求。
 * 「拿这些要求去库里比三态」（4.4-03 / 04）与「界面呈现」（4.4-05 / 06）分属 4.4-c 与 4.4-d，
 * 现在就把比对与界面写进来会同时踩两条规矩：AGENTS.md §2.6（不为假想的未来做抽象）与 §0（一次只推进一个切片）。
 *
 * 三条装配层的立身之本：
 * 1. **入参校验只在系统边界做**（§2.6）：JD 正文是从界面文本框或 `jobs.description` 进来的外部数据，
 *    所以过短在这里拒绝；判定本身仍旧全在 `requirements.ts` 的纯函数里，本文件不重复任何规则（§2.5）。
 * 2. **不建新表**（plan §4.4 口径 3）：拆解是几次正则与词典扫描，代价与一次检索同量级，
 *    而 `jobs.requirements_json` 已经装了「页面原样的要求标签」——那是 2.3 抓取的真相源，
 *    把派生结果写回同一列就是造第二个真相（4.2-11 的同一件事）。可重建的投影不落库，用时现算。
 * 3. **日志只记计数**（延续 4.3-12 的脱敏口径）：JD 正文与简历正文一样是个人的，
 *    本服务落的一行只有字数、四类条数、丢弃数与词表版本。
 */
import { AppError, Service, type Context } from '@auto-cc/core';
import { z } from 'zod';
import { extractRequirementsLexically, type RequirementItem, type RequirementKind } from './requirements.js';

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
  /** 四类要求条目，已按「四类表次序 → 原文起始位置」排成稳定序列（spec 4.4-07） */
  items: RequirementItem[];
  /** 参与拆解的正文字符数——日志与界面播报用计数，不落 JD 正文（4.3-12 同口径） */
  inputChars: number;
  /** 被每类上限丢弃的条数（4.4-06 要求"负面结论也要给得出依据"，先保住计数可见） */
  droppedByLimit: number;
  /** 词表版本，随结果一起进复盘记录（同 2.5-09 的 `scriptVersion`） */
  lexiconVersion: string;
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
   * 把一段 JD 正文拆成四类能力要求（词面腿）。
   *
   * 4.4-b 会在这一层里先问 `llm.chat.status()`：可用就走模型腿、失败或不可用就退回这里现有的词面腿，
   * 并把 `via` 与回落原因随同一个视图返回（spec 4.4-02 的「功能不中断 + 界面播报」）。
   * @param jdText JD 正文（来自界面文本框或 `jobs.description`，单位：JS 字符串）
   * @returns 稳定序列 + 输入字数 + 丢弃计数 + 词表版本
   * @throws AppError(`INVALID_ARGUMENT`) 正文去空白后短于 `minJdChars`
   */
  extract(jdText: string): GapExtractView {
    const trimmed = jdText.trim();
    if (trimmed.length < this.options.minJdChars) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `JD 正文去空白后只有 ${String(trimmed.length)} 字，少于下限 ${String(this.options.minJdChars)} 字：拆不出可信的能力要求`,
      );
    }
    const { items, droppedByLimit, lexiconVersion } = extractRequirementsLexically(trimmed, this.options.perKindLimit);
    this.ctx.logger.info(
      `[kb-gap] 词面拆解 ${String(trimmed.length)} 字 → 硬技能 ${String(countOfKind(items, 'hard_skill'))}` +
        ` / 软技能 ${String(countOfKind(items, 'soft_skill'))} / 学历 ${String(countOfKind(items, 'education'))}` +
        ` / 年限 ${String(countOfKind(items, 'experience_years'))}（丢弃 ${String(droppedByLimit)}，词表 ${lexiconVersion}）`,
    );
    return { items, inputChars: trimmed.length, droppedByLimit, lexiconVersion };
  }
}
