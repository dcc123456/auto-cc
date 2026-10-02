/**
 * 「JD 的一条要求 ↔ 库内的证据」三态比对与反向比对（spec 4.4-03 / 4.4-04 / 4.4-06 / 4.4-07，
 * 判据定稿见 `docs/plans/04-resume-kb/plan.md` §4.4-c）。
 *
 * 与 `evidence.ts` 的分工：那一层只回答「这句话有哪些实体撑着、各多强」，本文件回答
 * 「JD 提的这条要求算不算被满足、没满足怎么办、库里还有什么 JD 没提但相关的」。
 * 打分**一律复用** `coverageOf`（同一把 token 尺子，AGENTS.md §2.1），本文件不新增任何相似度算法。
 *
 * 三条刻意的设计（都不是风格偏好，是判据）：
 *
 * 1. **四类要求不共用一把尺子**。技能类是文本相似度；年限是**算术**（JD 写「5 年经验」，库里的实体文本是
 *    「2019.03 - 至今」，两者零共同 token，词面尺子必然判"缺失"——那是假读数）；学历是**档位比较**。
 * 2. **"今天"是入参不是现状**。年限要把「至今」的哨兵终点夹到当前月，而当前月若在这里读 `Date.now()`，
 *    4.4-07 的"同一 JD + 同一库两次运行 hash 相同"会在跨月的那一刻莫名发红。所以本文件要 `nowMonth`，
 *    由服务层显式传入，界面把"截至某年某月"显示出来（4.4-d）。
 * 3. **建议只给 i18n key + 参数**（4.4-06 的机检半边）。服务不拼中文句子：文案归渲染层语言包（§5.5），
 *   「不得只输出负面结论」于是变成一个可断言的结构约束——非命中的每条 `suggestion` 必不为 `null`。
 *
 * 纯函数：不认识 cordis、不认识 SQLite（与 `requirements.ts` / `evidence.ts` 同规矩），所以这些判据
 * 不需要起 store 就能逐条断言。
 */
import type { KbEntityKind } from './entities.js';
import { monthSpanOf } from './entities.js';
import { coverageOf, evidenceTextOf } from './evidence.js';
import { EDUCATION_TIERS, educationRankOf, type RequirementItem } from './requirements.js';
import { tokenize } from './tokenize.js';

/** 三态（spec 4.4-03）。`partial` 的语义是"有相关的据，但不够强/不够格"，不是"半条命中"。 */
export const GAP_STATES = ['matched', 'partial', 'missing'] as const;

/** 三态之一的字面量类型。 */
export type GapState = (typeof GAP_STATES)[number];

/** 证据 id 的来源：库内实体，或学历区块的切片（4.2 裁定二：`education` 区块**不产实体行**，它的据只能在区块级）。 */
export const GAP_EVIDENCE_ORIGINS = ['entity', 'section_chunk'] as const;

/** 证据 id 的来源类型。 */
export type GapEvidenceOrigin = (typeof GAP_EVIDENCE_ORIGINS)[number];

/** 一条证据引用（界面按 id 反查库内文本并做跳转，spec 4.4-05 的证据链）。 */
export interface GapEvidence {
  readonly id: string;
  readonly origin: GapEvidenceOrigin;
  /** 实体种类；区块切片没有种类，给 `'education'`（与 KB 的四类实体不冲突，它是学历 label 的命名空间）。 */
  readonly kind: KbEntityKind | 'education';
  /** 0～1 的强度；年限那一路是「这条经历占总时长的比例」，学历那一路是「库内档位 / 要求档位」。 */
  readonly score: number;
  /** 命中的 token（升序），用于界面解释「为什么算这条撑着」；年限与学历是算术/档位判定，为空数组。 */
  readonly matchedTokens: readonly string[];
}

/** 补救建议的 i18n key（文案本体在渲染层语言包，服务只给 key 与插值参数，§5.5 / §5.7）。 */
export const GAP_SUGGESTION_KEYS = [
  'add_evidence',
  'strengthen_evidence',
  'years_gap',
  'education_gap',
  'education_missing',
] as const;

/** 建议 key 的字面量类型。 */
export type GapSuggestionKey = (typeof GAP_SUGGESTION_KEYS)[number];

/** 一条补救建议。 */
export interface GapSuggestion {
  readonly key: GapSuggestionKey;
  /** 插值参数（只放 id 与数字，**不放库内正文**——个人信息不进建议对象，4.3-12 的口径）。 */
  readonly params: Readonly<Record<string, string | number>>;
}

/** 一条 JD 要求的比对结果。 */
export interface GapRequirementView {
  /** 拆解腿的原条目，界面靠它的 `start/end` 做原文高亮（spec 4.4-01 的位置判据）。 */
  readonly item: RequirementItem;
  readonly state: GapState;
  /** 证据链：`matched` / `partial` 非空，`missing` 恒为空数组（"没有据"不能靠塞弱据来圆场）。 */
  readonly evidence: readonly GapEvidence[];
  /** 最强那条证据的强度；完全无命中为 `null`（区别于"0 分"——0 分意味着至少沾上了一个词）。 */
  readonly bestScore: number | null;
  /** 非 `matched` 时必不为 `null`（spec 4.4-06 的结构断言点）。 */
  readonly suggestion: GapSuggestion | null;
}

/** 反向比对的一条亮点候选（spec 4.4-04：库内具备、JD 未提、且与这个岗位相关）。 */
export interface GapHighlightView {
  readonly entityId: string;
  readonly kind: KbEntityKind;
  /** 该实体与 **JD 全文** 的覆盖率——它衡量"相关"，不是"具备"（具备由它在库里这一事实给出）。 */
  readonly score: number;
  /** 相关性体现在哪几个词（升序），界面上"为什么算亮点"的读数。 */
  readonly relatedTokens: readonly string[];
}

/** 参与比对的库内实体投影（由服务层从 `kb.profile.list()` 投影而来，本文件不碰 SQLite）。 */
export interface GapLibraryEntity {
  readonly entityId: string;
  readonly kind: KbEntityKind;
  /** 该 kind 的全部载荷字段拼成的可比文本（`evidenceTextOf` 的产物）。 */
  readonly text: string;
  /** 载荷里的时间段原文（只有经历/项目有）；无或认不出时为 `null`。 */
  readonly periodText: string | null;
}

/** 参与比对的学历区块投影。 */
export interface GapEducationChunk {
  readonly chunkId: string;
  readonly text: string;
}

/** 一次比对的输入。 */
export interface GapCompareInput {
  /** JD 正文（与拆解腿同一份字符串——已经 `trim()` 过的那份，反向比对要在它上面算相关性）。 */
  readonly jdText: string;
  readonly items: readonly RequirementItem[];
  readonly entities: readonly GapLibraryEntity[];
  readonly educationChunks: readonly GapEducationChunk[];
}

/** 一次比对的可调项（全部来自 `kb.gap` 配置，代码内无魔法数，同 4.3-03）。 */
export interface GapCompareOptions {
  readonly evidenceTopK: number;
  /** ≥ 此强度算「命中」。 */
  readonly hitMinScore: number;
  /** ≥ 此强度算「部分命中」；低于它算「缺失」。 */
  readonly partialMinScore: number;
  /** 年限的「部分命中」比例：库内总年限 ≥ 要求 × 此比例时算部分命中。 */
  readonly yearsPartialRatio: number;
  /** 亮点候选与 JD 全文的最低覆盖率——只判「JD 没提」会把驾照、六级当亮点推给用户。 */
  readonly highlightMinScore: number;
  /** 亮点候选最多给几条。 */
  readonly maxHighlights: number;
  /** 「今天」的绝对月序号（`年 × 12 + 月`，与 `monthSpanOf` 同尺度），由服务层显式传入。 */
  readonly nowMonth: number;
}

/** 一次比对的读数。 */
export interface GapCompareResult {
  /** 与 `items` 同序（拆解腿已按「类别 → 原文位置」排成稳定序列，比对不重排，界面分栏才不用二次排序）。 */
  readonly rows: readonly GapRequirementView[];
  readonly highlights: readonly GapHighlightView[];
  /** 因 `maxHighlights` 被截掉的候选条数（计数可见，同 4.4-06 的"负面结论要给依据"）。 */
  readonly highlightsDropped: number;
  readonly counts: Readonly<Record<GapState, number>>;
  /** 库内经验总月数（区间**合并后**，重叠期不双计）；界面换算成年。 */
  readonly totalExperienceMonths: number;
  /** 库内最高学历档位；库里没有学历区块时为 `null`。 */
  readonly libraryEducationRank: number | null;
}

/**
 * 库内实体 → 比对输入里的投影。
 * @param entity 实体读数（`kb.profile.list()` 的元素）
 * @returns 只带比对要用的三个字段；`period` 按经历/项目的载荷键取
 */
export function libraryEntityOf(entity: {
  readonly entityId: string;
  readonly kind: KbEntityKind;
  readonly payload: Readonly<Record<string, string>>;
}): GapLibraryEntity {
  return {
    entityId: entity.entityId,
    kind: entity.kind,
    text: evidenceTextOf(entity.payload),
    periodText: entity.payload.period ?? null,
  };
}

/**
 * 月份闭区间的合并总月数（重叠/相接的区间只算一次）。
 * @param spans 已夹到"今天"的区间列表（顺序无关，内部自己排序）
 * @returns 覆盖到的月份总数；空列表为 0
 */
export function mergedMonthsOf(spans: readonly { start: number; end: number }[]): number {
  if (spans.length === 0) return 0;
  const ordered = [...spans].sort((left, right) => left.start - right.start || left.end - right.end);
  let total = 0;
  const first = ordered.at(0);
  if (first === undefined) return 0;
  let coverStart = first.start;
  let coverEnd = first.end;
  for (const span of ordered.slice(1)) {
    // 相接（差 1 个月）也算连成一段：2020.01-2020.06 与 2020.07-2021.01 是同一段连续经验。
    if (span.start <= coverEnd + 1) coverEnd = Math.max(coverEnd, span.end);
    else {
      total += coverEnd - coverStart + 1;
      coverStart = span.start;
      coverEnd = span.end;
    }
  }
  return total + (coverEnd - coverStart + 1);
}

/**
 * 一条经历的实际月数（「至今」夹到 `nowMonth`；起点在未来的返回 0 而不是负数）。
 * @param entity 库内实体投影（只有带 `periodText` 的经历/项目有意义）
 * @param nowMonth 「今天」的绝对月序号
 * @returns `{ months, span }`；时间段认不出时 `months` 为 0、`span` 为 `null`
 */
function clampedSpanOf(
  entity: GapLibraryEntity,
  nowMonth: number,
): { months: number; span: { start: number; end: number } | null } {
  const raw = monthSpanOf(entity.periodText ?? undefined);
  if (raw === null) return { months: 0, span: null };
  const end = Math.min(raw.end, nowMonth);
  if (end < raw.start) return { months: 0, span: null };
  return { months: end - raw.start + 1, span: { start: raw.start, end } };
}

/**
 * 库内最高学历档位：在学历区块切片里扫档位表的别名。
 * @param chunks 学历区块切片
 * @returns 最高档位与给出该档位的那条切片 id（并列时取 id 字典序最小者，保证与遍历顺序无关）
 */
function libraryEducationOf(chunks: readonly GapEducationChunk[]): {
  rank: number | null;
  chunkId: string | null;
} {
  let bestRank: number | null = null;
  let bestChunkId: string | null = null;
  // 先按切片 id 排序再遍历，且只在档位**严格更高**时替换：并列时留下 id 最小那条，结果与传入顺序无关。
  for (const chunk of [...chunks].sort((left, right) => (left.chunkId < right.chunkId ? -1 : 1))) {
    for (const tier of EDUCATION_TIERS) {
      if (!tier.aliases.some((alias) => chunk.text.includes(alias))) continue;
      if (bestRank === null || tier.rank > bestRank) {
        bestRank = tier.rank;
        bestChunkId = chunk.chunkId;
      }
    }
  }
  return { rank: bestRank, chunkId: bestChunkId };
}

/**
 * 给一条技能类（或档位表外的学历 label）要求找证据并按强度定三态。
 * @param item 拆解腿的要求条目
 * @param entities 库内实体投影
 * @param options 阈值与 topK
 * @returns 一条比对结果行
 */
function compareByText(
  item: RequirementItem,
  entities: readonly GapLibraryEntity[],
  options: GapCompareOptions,
): GapRequirementView {
  const claimTokens = tokenize(item.label);
  const hits: GapEvidence[] = [];
  for (const entity of entities) {
    const covered = coverageOf(claimTokens, tokenize(entity.text));
    if (covered === null || covered.score < options.partialMinScore) continue;
    hits.push({
      id: entity.entityId,
      origin: 'entity',
      kind: entity.kind,
      score: covered.score,
      matchedTokens: covered.matched,
    });
  }
  // 同分按 id 升序：不依赖 `list()` 的返回次序，两次运行必然同一序列（4.4-07）。
  hits.sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : 1));
  const top = hits.slice(0, options.evidenceTopK);
  const best = top.at(0)?.score ?? null;
  const state: GapState = best === null ? 'missing' : best >= options.hitMinScore ? 'matched' : 'partial';
  return {
    item,
    state,
    evidence: state === 'missing' ? [] : top,
    bestScore: best,
    suggestion: textSuggestion(state, item, top),
  };
}

/**
 * 技能类的建议：缺失要给"补一条可验证的陈述"，部分命中要给"用库里哪条改写"。
 * @param state 本行判出的三态
 * @param item 要求条目
 * @param top 已经排好序的证据（`missing` 时为空）
 * @returns 非命中时的建议；命中时为 `null`
 */
function textSuggestion(state: GapState, item: RequirementItem, top: readonly GapEvidence[]): GapSuggestion | null {
  if (state === 'matched') return null;
  const strongest = top.at(0);
  if (state === 'partial' && strongest !== undefined) {
    return { key: 'strengthen_evidence', params: { label: item.label, evidenceId: strongest.id } };
  }
  return { key: 'add_evidence', params: { label: item.label } };
}

/**
 * 年限要求的算术比对：库内经验总时长（合并后）够不够 JD 要的年数。
 * @param item 年限要求（`years` 为拆解腿从原文取出的数字）
 * @param entities 库内实体投影（只有 `experience` 参与）
 * @param options 阈值与 `nowMonth`
 * @returns 一条比对结果行；库里一条可解析时间段都没有时判缺失并给"补时间"的建议
 */
function compareByYears(
  item: RequirementItem,
  entities: readonly GapLibraryEntity[],
  options: GapCompareOptions,
): GapRequirementView {
  const experiences = entities.filter((entity) => entity.kind === 'experience');
  const measured = experiences.map((entity) => ({ entity, ...clampedSpanOf(entity, options.nowMonth) }));
  const ownTotal = measured.reduce((sum, one) => sum + one.months, 0);
  const totalMonths = mergedMonthsOf(measured.flatMap((one) => (one.span === null ? [] : [one.span])));
  const required = item.years ?? 0;
  const haveYears = Math.floor(totalMonths / 12);
  // 取 floor 而不是四舍五入：3 年 5 个月对「4 年以上」就是不满足，宁可少算不可多算。
  // 「0 年」不是真实 JD 会写的要求，但拆解腿的数字来自原文，这里不为它造一个特殊态：按已满足处理。
  const state: GapState =
    required === 0 || haveYears >= required
      ? 'matched'
      : haveYears >= required * options.yearsPartialRatio
        ? 'partial'
        : 'missing';
  const evidence: GapEvidence[] =
    ownTotal === 0
      ? []
      : measured
          .filter((one) => one.months > 0)
          .sort((left, right) => right.months - left.months || (left.entity.entityId < right.entity.entityId ? -1 : 1))
          .slice(0, options.evidenceTopK)
          .map((one) => ({
            id: one.entity.entityId,
            origin: 'entity',
            kind: one.entity.kind,
            // 占比按**各自月数之和**算：合并只为防重叠双计，占比要回答的是"哪条经历最长"。
            score: Math.round((one.months / ownTotal) * 10_000) / 10_000,
            matchedTokens: [],
          }));
  return {
    item,
    state,
    evidence: state === 'missing' ? [] : evidence,
    bestScore: evidence.at(0)?.score ?? null,
    suggestion:
      state === 'matched'
        ? null
        : {
            key: 'years_gap',
            params: {
              label: item.label,
              required,
              haveYears,
              ...(ownTotal === 0 ? { noPeriod: 1 } : {}),
            },
          },
  };
}

/**
 * 学历要求的档位比对。
 * @param item 学历要求（label 是本仓库的 5 档之一时才有档位）
 * @param chunks 学历区块切片
 * @returns 一条比对结果行；`label` 在档位表外（模型腿给的「中专」之类）时返回 `null`，调用方退回文本反查
 */
function compareByEducation(item: RequirementItem, chunks: readonly GapEducationChunk[]): GapRequirementView | null {
  const required = educationRankOf(item.label);
  if (required === null) return null;
  const library = libraryEducationOf(chunks);
  if (library.rank === null) {
    // 库里没有学历区块 = 无据，而不是"差一点"：把空库读成部分命中是最容易骗到自己的一种假读数。
    return {
      item,
      state: 'missing',
      evidence: [],
      bestScore: null,
      suggestion: { key: 'education_missing', params: { label: item.label } },
    };
  }
  const state: GapState = library.rank >= required ? 'matched' : library.rank === required - 1 ? 'partial' : 'missing';
  const evidence: GapEvidence[] =
    state === 'missing'
      ? []
      : [
          {
            id: library.chunkId ?? '',
            origin: 'section_chunk',
            kind: 'education',
            score: Math.round((Math.min(library.rank, required) / required) * 10_000) / 10_000,
            matchedTokens: [],
          },
        ];
  return {
    item,
    state,
    evidence,
    bestScore: evidence.at(0)?.score ?? null,
    suggestion:
      state === 'matched'
        ? null
        : { key: 'education_gap', params: { requiredLabel: item.label, haveRank: library.rank } },
  };
}

/**
 * 反向比对：库里具备、JD 没提、但与这个岗位相关的实体（spec 4.4-04 的差异化亮点候选）。
 *
 * 两道闸缺一不可（plan §4.4-c 判据二）：只判「JD 没提」会把驾照、英语六级这类**确实有但无关**的东西推上去；
 * 第二道闸用的还是同一把 `coverageOf`，只是把「要求」换成「JD 全文」，于是它同样确定、同样可解释
 * （`relatedTokens` 就是"相关在哪"的读数）。
 * @param input 比对输入（要 JD 正文、要求列表、全库实体）
 * @param options 阈值与条数上限
 * @returns 排好序、截断后的候选，以及被上限截掉的条数
 */
function findHighlights(
  input: GapCompareInput,
  options: GapCompareOptions,
): { highlights: GapHighlightView[]; dropped: number } {
  const jdTokens = tokenize(input.jdText);
  const requirementTokens = input.items.map((item) => tokenize(item.label));
  const candidates: GapHighlightView[] = [];
  for (const entity of input.entities) {
    // 只有"一句话能力"适合当亮点：经历/项目是整段文本，且它们的技能面已由 skill/achievement 代表。
    if (entity.kind !== 'skill' && entity.kind !== 'achievement') continue;
    const entityTokens = tokenize(entity.text);
    if (entityTokens.size === 0) continue;
    let requested = 0;
    for (const tokens of requirementTokens) {
      const covered = coverageOf(tokens, entityTokens);
      if (covered !== null && covered.score >= options.partialMinScore) {
        requested = Math.max(requested, covered.score);
      }
    }
    if (requested >= options.partialMinScore) continue; // JD 提过了，不是"未提的亮点"
    const related = coverageOf(entityTokens, jdTokens);
    if (related === null || related.score < options.highlightMinScore) continue; // 与这个岗位无关
    candidates.push({
      entityId: entity.entityId,
      kind: entity.kind,
      score: related.score,
      relatedTokens: related.matched,
    });
  }
  candidates.sort((left, right) => right.score - left.score || (left.entityId < right.entityId ? -1 : 1));
  return {
    highlights: candidates.slice(0, options.maxHighlights),
    dropped: Math.max(0, candidates.length - options.maxHighlights),
  };
}

/**
 * 把一份拆解结果与一份库读数比成缺口报告（本文件的唯一入口）。
 *
 * 判据分派写死在这里（plan §4.4-c 判据一）：年限走算术、学历走档位、其余走文本反查；
 * 学历 label 在档位表外时**退回文本反查**而不是猜一档。
 * @param input JD 正文、要求条目、库内实体与学历区块
 * @param options 阈值、topK 与「今天」的月序号
 * @returns 三态行（与输入同序）、亮点候选、三态计数与两个换算用的读数
 */
export function compareRequirements(input: GapCompareInput, options: GapCompareOptions): GapCompareResult {
  const counts: Record<GapState, number> = { matched: 0, partial: 0, missing: 0 };
  const rows = input.items.map((item) => {
    if (item.kind === 'experience_years' && item.years !== null) {
      return compareByYears(item, input.entities, options);
    }
    if (item.kind === 'education') {
      const byTier = compareByEducation(item, input.educationChunks);
      if (byTier !== null) return byTier;
    }
    return compareByText(item, input.entities, options);
  });
  for (const row of rows) counts[row.state] += 1;
  const highlights = findHighlights(input, options);
  const experiences = input.entities.filter((entity) => entity.kind === 'experience');
  const spans = experiences
    .map((entity) => clampedSpanOf(entity, options.nowMonth).span)
    .filter((span): span is { start: number; end: number } => span !== null);
  return {
    rows,
    highlights: highlights.highlights,
    highlightsDropped: highlights.dropped,
    counts,
    totalExperienceMonths: mergedMonthsOf(spans),
    libraryEducationRank: libraryEducationOf(input.educationChunks).rank,
  };
}
