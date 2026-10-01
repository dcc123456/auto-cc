/**
 * 中英文混排的轻量分词（spec 4.2-03 用，4.3 检索复用同一把尺子）。
 *
 * 两个视图共用一份切分实现：`tokenSequence()` 给写入侧的 FTS5 预分词列（有序、含重复），
 * `tokenize()` 给 4.2-03 的词面重合打分（去重集合）。切分规则只此一处，改这里等于同时改两侧——
 * 这是有意的：写入与查询用了不同的尺子，表现就是「明明在库里却搜不到」。
 *
 * 为什么不用现成的分词库：中文简历里要判的是「这两段话有没有在说同一件事」，词**级**精度不是必需项，
 * 而引入任何要下载词典 / 需要原生编译的分词器都会直接撞上 4.3-05 / 4.3-06（不许外部向量服务、
 * 不许用户机编译原生扩展）。CJK 相邻二字组（bigram）是这类匹配的最粗可用粒度：
 * 「高并发」与「并发优化」共享 `并发` 就能对上，而不需要知道词边界在哪。
 *
 * 归一化只做三件事：NFKC（全角转半角）、转小写、按「CJK 串」与「拉丁/数字串」切段。
 * 不做停用词表——那会变成一个必须与 4.3 一起维护的隐式清单，而这里的分数只用于排序，不做布尔判定。
 */

/** CJK 表意文字基本区 + 扩展 A + 兼容区（简历里出现的中文基本都在这三段内）。 */
const CJK_RANGES = /[㐀-䶿一-鿿豈-﫿]/;

/** 拉丁单词与数字串的最小可用长度：单字母（`c` 语言、列表记号）太容易误命中，直接丢。 */
const MIN_LATIN_TOKEN_LENGTH = 2;

/**
 * 把一段串切成**有序、含重复**的 token 序列（4.3-a 的写入侧预分词用，见 `chunks.ts` 的 `indexTokens`）。
 *
 * 为什么不复用 `tokenize()` 的去重结果：spike 实测（plan §4.3 预分词小节轮次四 A）去重列会让
 * `bm25()` 丢掉词频维度——「订单、订单、订单」这种堆叠句在去重索引里排不到前面，
 * 而 4.3-01 要的正是「相关项在前」。体积代价可忽略（2000 条真实长度条目：去重 103,082 字符 vs
 * 含重复 103,088 字符）。
 * @param text 任意文本
 * @returns 按原文出现顺序排列的 token；空文本或全是分隔符时返回空数组
 */
export function tokenSequence(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const tokens: string[] = [];
  let latinRun = '';
  let cjkRun = '';

  const flushCjk = (): void => {
    if (cjkRun === '') return;
    // 单字成串时给不出二字组，就退化成单字 token，否则「剑」这种技能名永远匹配不上。
    if (cjkRun.length === 1) tokens.push(cjkRun);
    for (let index = 0; index + 1 < cjkRun.length; index += 1) tokens.push(cjkRun.slice(index, index + 2));
    cjkRun = '';
  };

  const flushLatin = (): void => {
    for (const word of latinRun.split(/[^a-z0-9+#.]+/)) {
      if (word.length >= MIN_LATIN_TOKEN_LENGTH) tokens.push(word);
    }
    latinRun = '';
  };

  for (const character of normalized) {
    if (CJK_RANGES.test(character)) {
      flushLatin();
      cjkRun += character;
    } else {
      flushCjk();
      latinRun += character;
    }
  }
  flushCjk();
  flushLatin();
  return tokens;
}

/**
 * 把一段串切成 CJK 二字组与拉丁词（去重集合）。
 * @param text 任意文本（简历陈述、JD 要求、实体载荷都可以）
 * @returns token 集合；空文本返回空集合，调用方按「没有可比的东西」处理
 */
export function tokenize(text: string): Set<string> {
  return new Set(tokenSequence(text));
}
