/**
 * 检索打分（spec 4.3-01 / 4.3-02 / 4.3-03，plan §4.3 切片拆分的 4.3-b）。
 *
 * 纯函数：不认识 cordis、也不碰 SQLite，与 `evidence.ts` / `chunks.ts` 同构——「两个 token 集合怎么算出
 * 一个 0～1 的分数」必须能离线逐条断言，而取数（倒排召回、df、语料统计）全在 `profile-service.ts`。
 *
 * 为什么在应用层自己算 BM25 而不是直接用内置 `bm25()`（实测 spike6 §S1，双 runtime 一致）：
 * SQLite 的 `bm25(fts, …)` 后面的实参**只有列权重**，多给的数字被当成不存在列的权重丢弃，
 * 既不报错也不生效——`k1` / `b` 根本设不进去（连 `bm25(fts, 'k1', 1.2)` 这种写法都不报错）。
 * 而 4.3-03 要求「k1/b 来自 config，代码内无魔法数」，所以参数必须落在我们自己的实现里。
 * 实测同一份数据下自建 BM25 与内置 `bm25()` 给出**同一条排序**（spike6 §S7：`订单` → e6 > e2 > e1 两边一致），
 * 换 k1/b 只改分值不改头部次序，说明这条替换不牺牲召回质量。内置 `bm25()` 仍然被用作**召回排序**（省一次全表扫）。
 *
 * 两条腿合并成一条排序（不是两条各出一批结果）：
 * - `bm25` 腿：词频 + 稀有度 + 长度归一，负责「这条内容里这个词有多重」。
 * - `lexical` 腿：4.2-03 已有的覆盖率尺子（`coverageOf`），负责「查询词被这条内容覆盖了多少」。
 *   复用而不是重写：反查与检索如果在「什么算沾边」上各有一套，界面与检索就会给出互相矛盾的答案（§2.2 / §2.5）。
 * 两腿各自归一到 0～1 后按配置权重相加，所以阈值 `minScore` 的含义是**绝对**的，不随语料规模漂移——
 * 这正是内置 `bm25()` 做不到的（它是负值且量级随语料变，spike 轮次二 D 实测）。
 */
import type { SectionKind } from '@auto-cc/plugin-resume-doc';
import { type EvidenceReason, coverageOf } from './evidence.js';
import { type KbChunkKind, type KbChunkView } from './chunks.js';
import { normalizeText, tokenSequence } from './tokenize.js';

/** 命中理由：这条结果是被哪条通道 / 哪一腿分数撑起来的，界面按码取 i18n 文案。 */
export type KbSearchReason = 'bm25' | 'lexical' | 'substring';

/** 检索的可调项（全部来自 `kb.profile` 的配置，4.3-03 的判据就是「代码内无魔法数」）。 */
export interface KbSearchParams {
  /** 最多返回几条。 */
  readonly topK: number;
  /** 合并分低于此值不算命中（0～1 的绝对阈值，见文件头为什么能做成绝对）。 */
  readonly minScore: number;
  /** BM25 的词频饱和参数（越大越允许同一词重复计分）。 */
  readonly k1: number;
  /** BM25 的长度归一参数（0 = 不管长度，1 = 完全按长度惩罚）。 */
  readonly b: number;
  /** BM25 腿在合并分里的权重（两腿权重之和决定上限，见 `mergeScore`）。 */
  readonly bm25Weight: number;
  /** 词面覆盖腿的权重。 */
  readonly lexicalWeight: number;
  /**
   * 子串通道独有命中（与查询**没有任何 token 级重合**，只在 `norm_text` 里含这段字）的地板分。
   *
   * 必须有这一项：单字与词尾字查询在预分词索引里切不出可命中的 token（实测 spike 轮次五：
   * `订*` 前缀漏「提前预**订**」），两腿分数都是 0，不打一个地板分的话子串通道就永远进不了结果。
   */
  readonly substringFloorScore: number;
}

/** 一次检索的语料统计（由 service 用一条 SQL 取，见 `profile-service.ts` 的 `corpusStats`）。 */
export interface KbSearchCorpus {
  /** 参与检索的切片总条数（BM25 的 `N`）。 */
  readonly chunkCount: number;
  /** 每条切片的平均 token 数（BM25 的 `avgdl`）；空库时为 0。 */
  readonly avgTokenCount: number;
}

/** 一条候选切片（倒排召回 ∪ 子串召回的并集成员），形状就是 `KbChunkView`。 */
export type KbSearchCandidate = KbChunkView;

/** 一条命中。 */
export interface KbSearchHit {
  readonly chunkId: string;
  readonly chunkKind: KbChunkKind;
  readonly sourceDocId: string | null;
  readonly sectionKind: SectionKind | null;
  /** 切片正文，界面直接展示（原文不在倒排索引里，join 回主表取，见 plan §4.3 口径 5）。 */
  readonly text: string;
  /** 合并后的 0～1 分数，已按 4 位小数取整（浮点尾差会让断言与去重不稳定，同 4.2-03）。 */
  readonly score: number;
  /** BM25 腿归一分（单独留着：4.3-d 做 RRF 融合与 4.3-e 的评测集要比这一列）。 */
  readonly bm25Score: number;
  /** 词面覆盖腿的分。 */
  readonly lexicalScore: number;
  /** 覆盖腿的判定形态，界面用它区分「整段就是这句话」与「只是有重合」。 */
  readonly coverageReason: EvidenceReason | null;
  readonly reasons: readonly KbSearchReason[];
  /** 命中的 token（升序）；子串通道独有命中时给的是查询串本身。 */
  readonly matchedTokens: readonly string[];
}

/** 检索状态：`no_query_tokens` 是「这句话切不出可检索的 token」（全是标点 / 空白），与「库里没有」是两件事。 */
export type KbSearchStatus = 'ok' | 'no_query_tokens';

/** 一次检索的完整读数。 */
export interface KbSearchResult {
  readonly status: KbSearchStatus;
  readonly hits: readonly KbSearchHit[];
  /** 查询侧切出的 token（去重、升序），界面解释「按哪些词搜的」要用它。 */
  readonly queryTokens: readonly string[];
}

/** 打分需要的上下文：倒排召回之外的两项取数结果。 */
export interface KbSearchContext {
  readonly corpus: KbSearchCorpus;
  /** 每个查询 token 出现在多少条切片里（BM25 的 `df`，由 service 逐 token 问倒排表）。 */
  readonly dfByToken: ReadonlyMap<string, number>;
  /** 被子串通道（`instr(norm_text, 查询串)`）召回的切片 id（倒排切不出来的单字 / 词尾字，spike 轮次五实测）。 */
  readonly substringChunkIds: ReadonlySet<string>;
}

/**
 * 查询串 → 去重后的查询 token（保持首次出现顺序）。
 *
 * 单独导出是为了让取数侧（`profile-service.ts`）与打分侧用**同一份** token 列表：
 * df 要逐个 token 去问倒排表，如果两边各切一遍，就会出现「df 统计的词与打分用的词不是同一批」这种
 * 只能靠运气发现的偏差。
 * @param query 用户查询
 * @returns 去重 token 数组；全是标点或空白时为空数组（调用方据此给确定空态）
 */
export function queryTokensOf(query: string): string[] {
  return [...new Set(tokenSequence(query))];
}

/**
 * 单个 token → FTS5 短语形式。
 *
 * 逐 token 加双引号是有实测依据的（spike 轮次二 E）：裸拼会让用户输入里的 `OR` / `NOT` / `NEAR` / 括号
 * **静默改变语义**，而多余的一个 `"` 会抛 `unterminated string`；引号内的引号按 FTS5 规则翻倍转义。
 * @param token 查询或统计用的 token
 * @returns 形如 `"高并"` 的安全字面量
 */
export function quoteFtsTerm(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * 查询串 → FTS5 MATCH 表达式。
 *
 * token 之间用 `OR` 而不是 `AND`：AND 会让「高并发 缓存预热」这种多词查询在只提到其中一个词的切片上
 * 直接归零，而 4.3-01 要的是「相关项在前」——部分命中也该进候选集，由分数决定次序。
 * @param query 用户查询（原样，可以带标点与全角字符）
 * @returns 形如 `"高并" OR "并发" OR "缓存"` 的表达式；切不出 token 时返回**空串**，
 *          调用方必须在进入 SQL 之前短路——`MATCH ''` 会抛 `fts5: syntax error near ""`（spike 轮次三 E）
 */
export function buildFtsQuery(query: string): string {
  return queryTokensOf(query).map(quoteFtsTerm).join(' OR ');
}

/**
 * 预分词串 → token 数组。
 * @param tokens `kb_chunks.tokens` 列的值（以空格连接的有序序列）
 * @returns 拆回的 token；空串给空数组（`''.split(' ')` 会得到 `['']`，那是一个永远匹配不上的假 token）
 */
export function tokensOf(tokens: string): string[] {
  return tokens === '' ? [] : tokens.split(' ');
}

/**
 * BM25 单条打分（Okapi 形式，词频饱和 + 长度归一）。
 * @param candidateTokens 候选切片的 token 序列（含重复，tf 由这里精确数）
 * @param queryTokens 查询侧去重后的 token
 * @param context 语料统计与 df 表
 * @param params `k1` / `b` 来自配置
 * @returns 未归一的原始分（≥0；一个 token 都没命中时为 0）
 * @remarks tf 必须按 token **精确**数而不是数子串：实测（spike6 §S3）查询 `go` 在含 `logo` / `django`
 *          的切片里子串数为 2 而精确数为 0，数子串会把不相干的经历顶到前面。
 */
export function bm25ScoreOf(
  candidateTokens: readonly string[],
  queryTokens: readonly string[],
  context: KbSearchContext,
  params: Pick<KbSearchParams, 'k1' | 'b'>,
): number {
  if (candidateTokens.length === 0 || context.corpus.chunkCount === 0) return 0;
  const avgdl = context.corpus.avgTokenCount;
  // avgdl 为 0 只可能是「全部切片都是空 token」，此时长度归一没有意义，按不惩罚长度处理而不是除零。
  const lengthNorm = avgdl === 0 ? 1 : candidateTokens.length / avgdl;
  const counts = new Map<string, number>();
  for (const token of candidateTokens) counts.set(token, (counts.get(token) ?? 0) + 1);

  let score = 0;
  for (const token of queryTokens) {
    const tf = counts.get(token) ?? 0;
    if (tf === 0) continue;
    const df = context.dfByToken.get(token) ?? 0;
    const idf = Math.log(1 + (context.corpus.chunkCount - df + 0.5) / (df + 0.5));
    score += (idf * tf * (params.k1 + 1)) / (tf + params.k1 * (1 - params.b + params.b * lengthNorm));
  }
  return score;
}

/**
 * BM25 原始分 → 0～1。
 *
 * 上界取「查询去重 token 数 × (k1+1)」：单个 token 的贡献在 tf→∞ 时收敛到 `idf × (k1+1)`，
 * 而本库的 idf ≤ ln(1 + (N+0.5)/0.5) 在 N 大时会超过 1，所以这个上界是**近似**的——
 * 近似是有意为之：用「本批命中里的最高分」归一会让阈值随查询漂移（4.2-03 标定 `minScore` 的老问题），
 * 而这里的归一与候选集无关，同一条切片在同一查询下永远得同一个数，且几乎总是落在 0～1 内（实测 spike6 §S7：0.61 / 0.69 / 0.61）。
 * @param rawScore `bm25ScoreOf` 的返回
 * @param queryTokenCount 查询去重 token 数（为 0 时直接给 0，不做除零）
 * @param params `k1` 参与上界
 * @returns 夹在 0～1 的分（超过 1 说明 idf 主导，截断即可，排序不受影响）
 */
export function normalizeBm25(rawScore: number, queryTokenCount: number, params: Pick<KbSearchParams, 'k1'>): number {
  if (queryTokenCount <= 0 || rawScore <= 0) return 0;
  return Math.min(1, rawScore / (queryTokenCount * (params.k1 + 1)));
}

/**
 * 两腿合并成一条排序。
 * @param query 用户查询原文
 * @param candidates 候选切片（倒排召回 ∪ 子串召回；重复 id 由这里收敛成一条）
 * @param context df 与语料统计
 * @param params 全部检索参数
 * @returns 读数：`status` 为 `no_query_tokens` 时 `hits` 必为空（切不出 token 就不进 SQL，也不给随机结果）；
 *          否则 `hits` 按合并分倒序、同分按 `chunkId` 升序，最多 `topK` 条，且每条 `reasons` / `matchedTokens` 非空
 * @remarks 合并分要求「至少命中一个 token」或「被子串通道召回」，两者都不成立的行直接丢掉——
 *          4.3-10 的确定空态靠这一条保证「空就是真空」，不会夹带一条解释不了的噪声。
 */
export function rankChunks(
  query: string,
  candidates: readonly KbSearchCandidate[],
  context: KbSearchContext,
  params: KbSearchParams,
): KbSearchResult {
  const queryTokens = queryTokensOf(query);
  if (queryTokens.length === 0) return { status: 'no_query_tokens', hits: [], queryTokens: [] };
  if (params.topK <= 0) return { status: 'ok', hits: [], queryTokens: queryTokens.sort() };

  const tokenSet = new Set(queryTokens);
  const unique = new Map<string, KbSearchCandidate>();
  for (const candidate of candidates) unique.set(candidate.chunkId, candidate);

  const hits: KbSearchHit[] = [];
  for (const candidate of unique.values()) {
    const candidateTokens = tokensOf(candidate.tokens);
    const raw = bm25ScoreOf(candidateTokens, queryTokens, context, params);
    const bm25 = normalizeBm25(raw, queryTokens.length, params);
    const covered = coverageOf(tokenSet, new Set(candidateTokens));
    const lexical = covered?.score ?? 0;
    const isSubstringHit = context.substringChunkIds.has(candidate.chunkId);
    const matched = covered?.matched ?? [];
    if (matched.length === 0 && !isSubstringHit) continue;

    const merged = params.bm25Weight * bm25 + params.lexicalWeight * lexical;
    // 没有任何 token 级重合、只被 `norm_text` 子串召回的行，两腿都是 0 分：打配置给的地板分，
    // 否则单字查询会「召回到却进不了结果」；地板分同时保证它排在有词面证据的命中之后。
    const isTokenless = matched.length === 0;
    const score = Math.round((isTokenless ? Math.max(merged, params.substringFloorScore) : merged) * 10_000) / 10_000;
    if (score < params.minScore) continue;

    const reasons: KbSearchReason[] = [];
    if (bm25 > 0) reasons.push('bm25');
    if (lexical > 0) reasons.push('lexical');
    if (isTokenless) reasons.push('substring');
    // 三个条件都不成立只可能是「有 token 重合但两腿都被权重压成 0」——此时它是靠子串通道进的候选集，
    // 理由必须说清来源，界面才不会显示一条解释不了的命中（4.3-01 的「理由非空」判据）。
    if (reasons.length === 0) reasons.push(isSubstringHit ? 'substring' : 'lexical');

    hits.push({
      chunkId: candidate.chunkId,
      chunkKind: candidate.chunkKind,
      sourceDocId: candidate.sourceDocId,
      sectionKind: candidate.sectionKind,
      text: candidate.text,
      score,
      bm25Score: Math.round(bm25 * 10_000) / 10_000,
      lexicalScore: lexical,
      coverageReason: covered?.reason ?? null,
      reasons,
      // 只有子串通道命中时没有 token 级重合可展示，给归一化后的查询串本身，界面上就是「按这句话搜到的」。
      matchedTokens: matched.length > 0 ? matched : [normalizeText(query)],
    });
  }

  hits.sort((left, right) => right.score - left.score || (left.chunkId < right.chunkId ? -1 : 1));
  return { status: 'ok', hits: hits.slice(0, params.topK), queryTokens: queryTokens.sort() };
}
