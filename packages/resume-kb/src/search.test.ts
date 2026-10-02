/**
 * 检索打分的纯函数用例（spec 4.3-01 / 4.3-02 / 4.3-03 的判定半边，4.3-d 加上融合腿）。
 *
 * 这一份文件**不开数据库**：`search.ts` 里全是「两个 token 集合 → 一个分数」的算式，
 * 只有离线断言才能把每个系数的作用单独钉住（在装配用例里改一个参数会同时动召回、df、语料统计三样，
 * 失败时看不出是哪一条）。取数与两路召回的接线在 `profile-service.test.ts` 的 4.3-b 小节判。
 *
 * 语料自造（虚构公司与句子），不与任何真实简历同源。
 */
import { describe, expect, it } from 'vitest';
import { indexTokens } from './chunks.js';
import {
  type KbSearchCandidate,
  type KbSearchContext,
  type KbSearchHit,
  type KbSearchParams,
  type KbSearchReason,
  bm25ScoreOf,
  buildFtsQuery,
  fuseByRrf,
  normalizeBm25,
  queryTokensOf,
  quoteFtsTerm,
  rankChunks,
  tokensOf,
} from './search.js';

/** 与 `cordis.yml` 一致的一组默认参数（用例要判「改哪个系数动哪个结果」，所以基准值必须已知）。 */
const PARAMS: KbSearchParams = {
  topK: 10,
  minScore: 0,
  k1: 1.2,
  b: 0.75,
  bm25Weight: 0.6,
  lexicalWeight: 0.4,
  substringFloorScore: 0.25,
  rrfK: 60,
  vectorMinCosine: 0.35,
};

/** 造一条候选切片：只有 `text` / `tokens` 参与打分，其余字段是把命中认出来的标签。 */
function candidate(chunkId: string, text: string): KbSearchCandidate {
  return {
    chunkId,
    chunkKind: 'entity',
    sourceDocId: null,
    sectionKind: null,
    text,
    tokens: indexTokens(text),
    normText: text.normalize('NFKC').toLowerCase(),
    updatedAt: 0,
  };
}

/** 造一份打分上下文：df 表按调用方给的条数填，语料统计默认三条、平均长度现算。 */
function contextOf(
  candidates: readonly KbSearchCandidate[],
  df: Readonly<Record<string, number>> = {},
  substringChunkIds: readonly string[] = [],
): KbSearchContext {
  const totalTokens = candidates.reduce((sum, item) => sum + tokensOf(item.tokens).length, 0);
  return {
    corpus: {
      chunkCount: candidates.length,
      avgTokenCount: candidates.length === 0 ? 0 : totalTokens / candidates.length,
    },
    dfByToken: new Map(Object.entries(df)),
    substringChunkIds: new Set(substringChunkIds),
  };
}

describe('查询侧切分与 FTS5 表达式（4.3-02 的转义半边）', () => {
  it('二字查询切成重叠二字组，去重且保持首次出现顺序', () => {
    expect(queryTokensOf('订单')).toEqual(['订单']);
    expect(queryTokensOf('高并发')).toEqual(['高并', '并发']);
    expect(queryTokensOf('订单订单')).toEqual(['订单', '单订']);
    // 重复二字组只留一份（`订单，订单` 被逗号切成两段同串，去重后只剩一个 token）
    expect(queryTokensOf('订单，订单')).toEqual(['订单']);
    // 中英混排：拉丁段按词、CJK 段按二字组，两段互不吞并
    expect(queryTokensOf('P99 延迟')).toEqual(['p99', '延迟']);
  });

  it('切不出 token 的查询给空数组（调用方据此短路成确定空态）', () => {
    expect(queryTokensOf('')).toEqual([]);
    expect(queryTokensOf('　 ，。！？、')).toEqual([]);
    // 单字母被丢掉（`MIN_LATIN_TOKEN_LENGTH` 的既定规则），所以纯单字母查询也是空
    expect(queryTokensOf('a b')).toEqual([]);
  });

  it('逐 token 加双引号并用 OR 连接：裸输的 FTS5 语法词不会改变语义', () => {
    expect(buildFtsQuery('订单')).toBe('"订单"');
    expect(buildFtsQuery('高并发')).toBe('"高并" OR "并发"');
    // 这三个词裸拼会被 FTS5 当成运算符（实测 spike 轮次二 E：不报错但静默改语义），
    // 引号包起来之后 `or` / `not` 就退化成普通的拉丁 token，与中文二字组一样只是被检索的内容。
    expect(buildFtsQuery('订单 OR 库存')).toBe('"订单" OR "or" OR "库存"');
    expect(buildFtsQuery('NOT 高并发')).toBe('"not" OR "高并" OR "并发"');
    expect(buildFtsQuery('(订单)')).toBe('"订单"');
  });

  it('引号在 FTS5 表达式里成对转义；而查询串里的引号根本进不到 token（切分时就是分隔符）', () => {
    expect(quoteFtsTerm('a"b')).toBe('"a""b"');
    // 实测口径：`tokenSequence` 把非 `a-z0-9+#.` 都当切分点，所以用户多打的一个 `"` 不会留下
    // 半个未闭合的字符串——转义是给「将来 token 规则放宽」留的边界防护，不是当前可达路径。
    expect(buildFtsQuery('say "hi"')).toBe('"say" OR "hi"');
  });

  it('tokensOf 把空预分词串还原成空数组而不是一个假 token', () => {
    expect(tokensOf('')).toEqual([]);
    expect(tokensOf('订单 单服')).toEqual(['订单', '单服']);
  });
});

describe('BM25 腿（4.3-03：k1 / b 参与算式）', () => {
  const target = candidate('c1', '主导订单服务重构，提升订单吞吐');
  const others = [candidate('c2', '负责库存服务'), candidate('c3', '组织校内算法竞赛')];
  const all = [target, ...others];

  it('词频按 token 精确数，不做子串数（含 logo / django 的切片对 go 得 0 分）', () => {
    // 实测口径（spike6 §S3）：子串数会把 `logo` / `django` 里的 `go` 当成两次词频，
    // 于是「完全没有提到 Go 的经历」被顶到前面；token 精确数与 FTS5 `MATCH "go"` 一致，都是 0。
    const noGo = candidate('c1', '负责 logo 设计与 Django 后端');
    expect(bm25ScoreOf(tokensOf(noGo.tokens), ['go'], contextOf([noGo], { go: 1 }), PARAMS)).toBe(0);
    // 同一个切片里真的出现 go 这个词时才有分
    const withGo = candidate('c2', 'go 语言服务');
    expect(bm25ScoreOf(tokensOf(withGo.tokens), ['go'], contextOf([withGo], { go: 1 }), PARAMS)).toBeGreaterThan(0);
  });

  it('重复出现的词比分高，但按 k1 饱和而不是线性累加', () => {
    const once = candidate('once', '订单服务');
    const thrice = candidate('thrice', '订单、订单、订单服务');
    const ctx = contextOf([once, thrice], { 订单: 2 });
    const onceScore = bm25ScoreOf(tokensOf(once.tokens), ['订单'], ctx, PARAMS);
    const thriceScore = bm25ScoreOf(tokensOf(thrice.tokens), ['订单'], ctx, PARAMS);
    expect(thriceScore).toBeGreaterThan(onceScore);
    // tf 从 1 到 3（三倍）而分不到三倍，就是饱和项在起作用
    expect(thriceScore).toBeLessThan(onceScore * 3);
  });

  it('稀有词比常见词贡献更多分（idf 生效）', () => {
    const ctx = contextOf(all, { 订单: 3, 算法: 1 });
    const orderScore = bm25ScoreOf(tokensOf(target.tokens), ['订单'], ctx, PARAMS);
    const algScore = bm25ScoreOf(
      tokensOf(candidate('c4', '组织校内算法竞赛').tokens),
      ['算法'],
      contextOf(all, { 算法: 1, 订单: 3 }),
      PARAMS,
    );
    expect(algScore).toBeGreaterThan(orderScore);
  });

  it('df 记 0（token 从没统计过）时不抛错也不给负分', () => {
    const ctx = contextOf(all, {});
    expect(bm25ScoreOf(tokensOf(target.tokens), ['订单'], ctx, PARAMS)).toBeGreaterThanOrEqual(0);
  });

  it('b=0 时长度归一失效：同样词频的长短两条切片得分相同', () => {
    const short = candidate('short', '订单');
    const long = candidate('long', '订单服务重构与稳定性治理，覆盖下单、支付、对账三个链路的容量评估与压测方案');
    const ctx = contextOf([short, long], { 订单: 2 });
    expect(bm25ScoreOf(tokensOf(short.tokens), ['订单'], ctx, { k1: 1.2, b: 0 })).toBeCloseTo(
      bm25ScoreOf(tokensOf(long.tokens), ['订单'], ctx, { k1: 1.2, b: 0 }),
      10,
    );
    expect(bm25ScoreOf(tokensOf(short.tokens), ['订单'], ctx, PARAMS)).toBeGreaterThan(
      bm25ScoreOf(tokensOf(long.tokens), ['订单'], ctx, PARAMS),
    );
  });

  it('空语料与空候选都给 0 而不是除零', () => {
    const empty = contextOf([]);
    expect(bm25ScoreOf([], ['订单'], empty, PARAMS)).toBe(0);
    expect(bm25ScoreOf(tokensOf(target.tokens), ['订单'], empty, PARAMS)).toBe(0);
    expect(bm25ScoreOf([], ['订单'], contextOf(all, { 订单: 1 }), PARAMS)).toBe(0);
  });

  it('归一化有上界且不做除零：token 数为 0 时给 0，超过上界时截断到 1', () => {
    expect(normalizeBm25(0.5, 0, PARAMS)).toBe(0);
    expect(normalizeBm25(-1, 2, PARAMS)).toBe(0);
    expect(normalizeBm25(1000, 2, PARAMS)).toBe(1);
    expect(normalizeBm25(2.2 * 2, 2, PARAMS)).toBeCloseTo(1, 10);
  });
});

describe('两腿合并成一条排序（4.3-01 / 4.3-02）', () => {
  const orderHit = candidate('e-order', '主导订单服务重构，P99 延迟下降 40%');
  const stockHit = candidate('e-stock', '负责库存服务与订单中心的接口设计');
  const unrelated = candidate('e-campus', '组织校内算法竞赛，负责赛题与判题机');
  const all = [orderHit, stockHit, unrelated];
  const ctx = contextOf(all, { 订单: 2 });

  it('切不出 token 的查询：status 为 no_query_tokens 且没有任何命中', () => {
    const result = rankChunks('。。。', all, ctx, PARAMS);
    expect(result).toEqual({ status: 'no_query_tokens', hits: [], queryTokens: [] });
  });

  it('相关项在前，且每条命中的理由与命中词都非空', () => {
    const result = rankChunks('订单', all, ctx, PARAMS);
    expect(result.status).toBe('ok');
    expect(result.hits.map((hit) => hit.chunkId)[0]).toBe('e-order');
    expect(result.hits.map((hit) => hit.chunkId)).not.toContain('e-campus');
    for (const hit of result.hits) {
      expect(hit.reasons.length).toBeGreaterThan(0);
      expect(hit.matchedTokens.length).toBeGreaterThan(0);
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
  });

  it('查询词被这条内容全部覆盖判为 contains，只覆盖一部分判为 overlap', () => {
    // `coverageOf` 取的是「查询被覆盖」与「这条被查询覆盖」两边的较大值，
    // 所以单 token 查询永远全是 contains——要区分两种形态必须用多字查询。
    const query = '订单服务重构';
    const exact = candidate('e-exact', '订单服务重构');
    const partial = candidate('e-partial', '负责库存服务与订单中心的接口设计');
    const corpus = [exact, partial];
    const result = rankChunks(query, corpus, contextOf(corpus, { 订单: 2 }), PARAMS);
    expect(result.hits.map((hit) => hit.chunkId)).toEqual(['e-exact', 'e-partial']);
    expect(result.hits[0]?.coverageReason).toBe('contains');
    expect(result.hits[1]?.coverageReason).toBe('overlap');
  });

  it('同分按 chunkId 升序，重复 id 的候选收敛成一条', () => {
    const first = candidate('a-same', '订单服务');
    const second = candidate('b-same', '订单服务');
    const result = rankChunks('订单', [second, first, second], contextOf([first, second], { 订单: 2 }), PARAMS);
    expect(result.hits.map((hit) => hit.chunkId)).toEqual(['a-same', 'b-same']);
  });

  it('topK 截断发生在排序之后（留下的是分高的那条而不是先来的那条）', () => {
    const result = rankChunks('订单', [...all].reverse(), ctx, { ...PARAMS, topK: 1 });
    expect(result.hits.map((hit) => hit.chunkId)).toEqual(['e-order']);
    expect(rankChunks('订单', all, ctx, { ...PARAMS, topK: 0 }).hits).toEqual([]);
  });

  it('minScore 是绝对阈值：抬到 1 时只有整条覆盖查询的命中留得下', () => {
    const loose = rankChunks('订单', all, ctx, { ...PARAMS, minScore: 0.1 });
    const strict = rankChunks('订单', all, ctx, { ...PARAMS, minScore: 1 });
    expect(loose.hits.length).toBeGreaterThan(strict.hits.length);
    expect(strict.hits.every((hit) => hit.score >= 1)).toBe(true);
  });

  it('两腿权重此消彼长：BM25 腿偏向「多个查询词都在里面」，覆盖腿偏向「整条就是查询的子集」', () => {
    // a-long 含 `订单` 与 `库存` 两个查询词但很长；b-short 只含 `订单` 却整条被查询覆盖。
    // 这两条腿的取向本来就不同，谁在前后正好由权重决定——所以这是「权重真的进了算式」的判据。
    const query = '订单库存';
    const long = candidate('a-long', '负责订单中心与库存服务的接口设计');
    const short = candidate('b-short', '订单');
    const corpus = [long, short];
    const ctxLocal = contextOf(corpus, { 订单: 2, 库存: 1 });
    const bm25Only = rankChunks(query, corpus, ctxLocal, { ...PARAMS, bm25Weight: 1, lexicalWeight: 0 });
    const lexicalOnly = rankChunks(query, corpus, ctxLocal, { ...PARAMS, bm25Weight: 0, lexicalWeight: 1 });
    expect(bm25Only.hits[0]?.chunkId).toBe('a-long');
    expect(lexicalOnly.hits[0]?.chunkId).toBe('b-short');
    // 一条腿权重为 0 时它的分就不再参与：把 BM25 腿整个关掉，合并分就等于覆盖腿的分本身
    const lexicalTop = lexicalOnly.hits[0];
    if (lexicalTop === undefined) throw new Error('覆盖腿应当有命中');
    expect(lexicalTop.score).toBeCloseTo(lexicalTop.lexicalScore, 10);
  });

  it('子串通道独有命中（无 token 重合）拿地板分，且理由标 substring', () => {
    // 「订」这个单字在预分词里切不出来，两腿都是 0 分，只有 instr 通道召回它
    const singleCharTarget = candidate('e-single', '提前预订机票');
    const result = rankChunks('订', [singleCharTarget], contextOf([singleCharTarget], { 订: 0 }, ['e-single']), PARAMS);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.reasons).toContain('substring');
    expect(result.hits[0]?.score).toBeCloseTo(PARAMS.substringFloorScore, 10);
    expect(result.hits[0]?.matchedTokens).toEqual(['订']);
  });

  it('地板分低于真实词面命中：单字命中排在有 token 证据的命中之后', () => {
    const tokenHit = candidate('e-token', '订单服务');
    const substringOnly = candidate('e-sub', '提前预订机票');
    const corpus = [tokenHit, substringOnly];
    const result = rankChunks('订单', corpus, contextOf(corpus, { 订单: 1 }, ['e-sub']), { ...PARAMS, minScore: 0 });
    expect(result.hits.map((hit) => hit.chunkId)).toEqual(['e-token', 'e-sub']);
  });

  it('既没有 token 重合也没被子串召回的候选直接丢掉（空就是真空，4.3-10）', () => {
    const result = rankChunks('订单', [unrelated], contextOf(all, { 订单: 0 }), PARAMS);
    expect(result.hits).toEqual([]);
  });

  it('查询 token 会回带给界面解释「按哪些词搜的」', () => {
    expect(rankChunks('高并发', all, ctx, PARAMS).queryTokens).toEqual(['并发', '高并']);
  });
});

/**
 * RRF 融合（4.3-d / spec 4.3-07 的判定半边）。
 *
 * 这里的命中全部手搭，不调 `rankChunks`：融合这段的判据是「名次怎么合成一条次序」，
 * 如果输入本身是另一段被测代码算出来的，那么一次改动就会同时动两个环节，
 * 失败时看不出是词面打分坏了还是融合坏了。装配（真库 + 真取数）在 `profile-service.test.ts` 判。
 */
describe('RRF 融合只改名次、不改读数（4.3-07）', () => {
  /** 造一条词面腿命中：只有 `chunkId` 与三项读数参与融合的算式，其余是把命中认出来的标签。 */
  function lexicalHit(chunkId: string, score: number, reasons: readonly KbSearchReason[] = ['bm25']): KbSearchHit {
    return {
      chunkId,
      chunkKind: 'entity',
      sourceDocId: null,
      sectionKind: null,
      text: `正文-${chunkId}`,
      score,
      bm25Score: score,
      lexicalScore: score / 2,
      vectorScore: null,
      coverageReason: 'overlap',
      reasons,
      matchedTokens: ['订单'],
    };
  }

  /** 造一条向量腿命中（`rankByCosine` 的读数形状）。 */
  function vectorHit(chunkId: string, cosine: number) {
    return { chunkId, cosine };
  }

  /** 只给了词面名单：次序与每一条读数都原样留着（降级路径必须与「没有这层代码」等价）。 */
  it('向量名单为空时等价于纯词面结果', () => {
    const lexical = [lexicalHit('e-a', 0.9), lexicalHit('e-b', 0.5), lexicalHit('e-c', 0.2)];
    expect(fuseByRrf('订单', lexical, [], new Map(), { rrfK: PARAMS.rrfK, topK: 10 })).toEqual(lexical);
  });

  it('两边都命中的那条只被补上余弦与理由，三项词面读数一个字都不动', () => {
    const lexical = [lexicalHit('e-a', 0.9, ['bm25', 'lexical']), lexicalHit('e-b', 0.5)];
    const fused = fuseByRrf('订单', lexical, [vectorHit('e-a', 0.8765)], new Map(), { rrfK: PARAMS.rrfK, topK: 10 });
    const top = fused[0];
    if (top === undefined) throw new Error('两边都命中的那条应当还在结果里');
    // 合并分是 0～1 的词面证据强度，把它换成量纲完全不同的 RRF 值会让 `minScore` 失去意义（文件头口径）。
    expect(top.score).toBe(0.9);
    expect(top.bm25Score).toBe(0.9);
    expect(top.lexicalScore).toBe(0.45);
    expect(top.vectorScore).toBe(0.8765);
    expect(top.reasons).toEqual(['bm25', 'lexical', 'vector']);
    expect(top.text).toBe('正文-e-a');
    // 另一条没进向量名单，读数保持 null 而不是被填成 0（「没算过」与「算出 0」在界面上是两件事）。
    expect(fused[1]?.vectorScore).toBeNull();
  });

  it('只被向量捞到的切片从 `views` 补全正文，词面三项读数记 0', () => {
    const vectorOnly = candidate('e-semantic', '组织校内算法竞赛，负责赛题与判题机');
    const fused = fuseByRrf(
      '竞赛',
      [],
      [vectorHit('e-semantic', 0.9123)],
      new Map([[vectorOnly.chunkId, vectorOnly]]),
      { rrfK: PARAMS.rrfK, topK: 10 },
    );
    expect(fused).toHaveLength(1);
    const top = fused[0];
    if (top === undefined) throw new Error('只被语义捞到的那条应当进结果');
    expect(top.text).toBe(vectorOnly.text);
    expect(top.chunkKind).toBe(vectorOnly.chunkKind);
    expect(top.score).toBe(0);
    expect(top.bm25Score).toBe(0);
    expect(top.lexicalScore).toBe(0);
    expect(top.coverageReason).toBeNull();
    expect(top.reasons).toEqual(['vector']);
    // 与子串通道同一种处理：没有 token 级重合可展示时给归一化后的查询串本身，界面不能留空白字段。
    expect(top.matchedTokens).toEqual(['竞赛']);
  });

  it('向量名单里的 id 在 `views` 缺行时跳过，而不是造一条没有正文的命中', () => {
    // 唯一真实来路是「切片刚被删掉、向量行还没跟上」；那种时候给界面一条空文本结果是自造故障。
    const fused = fuseByRrf('订单', [lexicalHit('e-a', 0.9)], [vectorHit('e-gone', 0.99)], new Map(), {
      rrfK: PARAMS.rrfK,
      topK: 10,
    });
    expect(fused.map((hit) => hit.chunkId)).toEqual(['e-a']);
  });

  it('rrfK 真的进了算式：k=1 时词面第一名压过双第二，k=60 时反过来', () => {
    // a = 词面第 1 + 向量第 4；b = 词面第 2 + 向量第 2（两边都靠前的那条另说，这里要判的是阻尼）。
    // k=1：a = 1/2 + 1/5 = 0.700 > b = 2/3 ≈ 0.667；k=60：a = 1/61 + 1/64 ≈ 0.03202 < b = 2/62 ≈ 0.03226。
    // 头部名次「值多少」完全由这个常数决定，所以两侧各跑一次就能证明它是配置项而不是装饰。
    const a = lexicalHit('a-solo-top', 0.9);
    const b = lexicalHit('b-mid-both', 0.5);
    const views = new Map<string, KbSearchCandidate>([
      ['v-head', candidate('v-head', '负责库存服务')],
      ['v-tail', candidate('v-tail', '参与开源社区维护')],
    ]);
    const vectors = [
      vectorHit('v-head', 0.99),
      vectorHit('b-mid-both', 0.9),
      vectorHit('v-tail', 0.8),
      vectorHit('a-solo-top', 0.7),
    ];
    const dampened = { topK: 10 };
    expect(fuseByRrf('订单', [a, b], vectors, views, { ...dampened, rrfK: 1 }).map((hit) => hit.chunkId)).toEqual([
      'a-solo-top',
      'b-mid-both',
      'v-head',
      'v-tail',
    ]);
    expect(fuseByRrf('订单', [a, b], vectors, views, { ...dampened, rrfK: 60 }).map((hit) => hit.chunkId)).toEqual([
      'b-mid-both',
      'a-solo-top',
      'v-head',
      'v-tail',
    ]);
  });

  it('融合总分同分时按 chunkId 升序，且 topK 截断发生在融合之后', () => {
    // 两条都只在自己的那条腿里排第一：`1/(k+1)` 完全相同，于是次序只能由 chunkId 决定。
    const lexical = [lexicalHit('z-lexical', 0.9)];
    const vectors = [vectorHit('a-vector', 0.9)];
    const views = new Map<string, KbSearchCandidate>([['a-vector', candidate('a-vector', '组织校内算法竞赛')]]);
    expect(fuseByRrf('订单', lexical, vectors, views, { rrfK: PARAMS.rrfK, topK: 10 })).toHaveLength(2);
    // 截断留下的是融合后的头部而不是先来那条腿的头名：`topK: 1` 时活下来的是 id 更小的 `a-vector`。
    expect(
      fuseByRrf('订单', lexical, vectors, views, { rrfK: PARAMS.rrfK, topK: 1 }).map((hit) => hit.chunkId),
    ).toEqual(['a-vector']);
    expect(fuseByRrf('订单', lexical, vectors, views, { rrfK: PARAMS.rrfK, topK: 0 })).toEqual([]);
  });
});
