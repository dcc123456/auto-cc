/**
 * 中英文混排的轻量分词（spec 4.2-03 用，4.3 检索复用同一把尺子）。
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
 * 把一段串切成 CJK 二字组与拉丁词。
 * @param text 任意文本（简历陈述、JD 要求、实体载荷都可以）
 * @returns token 集合；空文本返回空集合，调用方按「没有可比的东西」处理
 */
export function tokenize(text: string): Set<string> {
  const normalized = text.normalize('NFKC').toLowerCase();
  const tokens = new Set<string>();
  let latinRun = '';
  let cjkRun = '';

  const flushCjk = (): void => {
    if (cjkRun === '') return;
    // 单字成串时给不出二字组，就退化成单字 token，否则「剑」这种技能名永远匹配不上。
    if (cjkRun.length === 1) tokens.add(cjkRun);
    for (let index = 0; index + 1 < cjkRun.length; index += 1) tokens.add(cjkRun.slice(index, index + 2));
    cjkRun = '';
  };

  const flushLatin = (): void => {
    for (const word of latinRun.split(/[^a-z0-9+#.]+/)) {
      if (word.length >= MIN_LATIN_TOKEN_LENGTH) tokens.add(word);
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
