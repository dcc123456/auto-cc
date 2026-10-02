/**
 * 中文散文的数值抽取与守恒比对（唯一一份实现）。
 *
 * 住在 `core`（L0）而不是任何一个领域包，是因为它有两个**同级**消费者（AGENTS.md §4.1 禁止横向内部引用）：
 * `resume-kb` 的定向生成事实校验用它判「数值守恒」（spec 4.5-04 / 08），
 * `outbound` 的话术无据断言拦截用它判「模型报出的数在依据里有没有出处」（spec 4.6-02）。
 * 两处要的判据是同一件事——"这段中文里有哪些数、这两个口径下差在哪"，
 * 抽一份放中间层比在两个包各写一遍强（§2.2），也更便宜：口径只需要在一处解释清楚。
 *
 * 本文件不认识 cordis、不开数据库连接、不发网络请求：纯函数才谈得上"确定性"，
 * 校验规则必须能离线逐条断言（同 `redact.ts` / `paths.ts` 的规矩）。
 */

/**
 * 中文数词到数值的映射（单字）。
 * 「〇/零」在这里只作占位（`108` 式读法本项目不出现），出现即按 0 参与组合。
 * @internal
 */
const CN_DIGIT_VALUE: Readonly<Record<string, number>> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 节内单位（十 / 百 / 千）。@internal */
const CN_INNER_UNIT: Readonly<Record<string, number>> = { 十: 10, 百: 100, 千: 1000 };

/** 节单位（万 / 亿）。@internal */
const CN_SECTION_UNIT: Readonly<Record<string, number>> = { 万: 10000, 亿: 100000000 };

/** 中文数词字符集（含节单位），用于正则的字符类。@internal */
const CN_NUMERAL_CHARS = '〇零一二两三四五六七八九十百千万亿';

/**
 * 跟在中文数词后面才让它算"一个数值"的量词集。
 *
 * 这条限定不是可有可无：中文里「十分符合」「万分感谢」的「十 / 万」是副词强度，不是数据。
 * 不加限定，模型把「十分匹配」润色成「非常匹配」就会被判成"弄丢了一个 10"。
 * 「成」刻意不在表内（「两成」= 20%，与 2 无法在同一口径下比较，宁可两边都不数）。
 * @internal
 */
const CN_COUNTING_UNITS = '个年月日天周岁人次倍家项条元名级位种';

/**
 * 数值抽取用的单一正则：阿拉伯数字（可带千分位、小数、紧随的千百十万亿量级）或
 * 「中文数词 + 量词」。两个分支按位置从左到右互斥，避免「3万人」被数两遍。
 * @internal
 */
const NUMBER_RUN = new RegExp(
  [String.raw`\d[\d,]*(?:\.\d+)?[ ]?[千百十万亿]?`, `[${CN_NUMERAL_CHARS}]+[ ]?[${CN_COUNTING_UNITS}]`].join('|'),
  'g',
);

/**
 * 中文分支末尾那个量词的剥离式——与 `NUMBER_RUN` 第二分支的尾巴同源（同一个字符集，写一次）。
 * @internal
 */
const CN_COUNTING_UNIT_TAIL = new RegExp(`[ ]?[${CN_COUNTING_UNITS}]$`);

/**
 * 把中文数词串解析成数值。
 * @param run 只含 `CN_NUMERAL_CHARS` 的串，如「二十三」「两万」「百万」
 * @returns 解析出的数值；串里有认不出的字或读不成一个数时返回 null（调用方按"不是数值"处理）
 */
export function chineseNumeralToNumber(run: string): number | null {
  let total = 0;
  let section = 0;
  let pending = 0;
  for (const char of run) {
    const digit = CN_DIGIT_VALUE[char];
    if (digit !== undefined) {
      pending = digit;
      continue;
    }
    const inner = CN_INNER_UNIT[char];
    if (inner !== undefined) {
      // 「十」单独开头时读作 10（十个人），不是 0×10。
      section += (pending === 0 ? 1 : pending) * inner;
      pending = 0;
      continue;
    }
    const sectionUnit = CN_SECTION_UNIT[char];
    if (sectionUnit !== undefined) {
      const current = section + pending;
      total += (current === 0 ? 1 : current) * sectionUnit;
      section = 0;
      pending = 0;
      continue;
    }
    return null;
  }
  return total + section + pending;
}

/**
 * 把一段数值读数渲染成稳定的文本键，供多重集比对与界面播报（整数不带小数点，避免 20 与 20.0 分成两类）。
 * @param value 解析出的数值
 * @returns 文本键，如「20」「1.5」
 */
export function numberKeyOf(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

/**
 * 从一段文本里抽出全部数值（按出现顺序，含重复）。
 *
 * 归一化口径（plan §4.5 取证三）：量级折进数值（「2 万」=「20000」），百分号、货币与时间量词只作限定、
 * 不进比对；因此数值守恒判的是"这个数还在不在、有没有新数"，单位改写（3 个月 → 3 年）**不在本条射程内**，
 * 这一点在 spec 里如实标注，不写成"所有数字相关篡改都已拦"。
 * @param text 待抽取的文本
 * @returns 数值数组（含重复，按多重集使用）
 */
export function numbersOf(text: string): number[] {
  const values: number[] = [];
  for (const match of text.matchAll(NUMBER_RUN)) {
    const token = match[0];
    const arabic = /^\d/.test(token);
    if (arabic) {
      const digits = token.replace(/[,\s]/g, '');
      const magnitudeChar = /[千百十万亿]$/.test(digits) ? digits.slice(-1) : '';
      const body = magnitudeChar === '' ? digits : digits.slice(0, -1);
      const bodyValue = Number(body);
      if (!Number.isFinite(bodyValue)) continue;
      const magnitude =
        magnitudeChar === '' ? 1 : (CN_SECTION_UNIT[magnitudeChar] ?? CN_INNER_UNIT[magnitudeChar] ?? 1);
      values.push(bodyValue * magnitude);
      continue;
    }
    // 中文分支：末尾的量词只用来判"这串数词是不是在报数"，本身不进数值。
    const numeralRun = token.replace(CN_COUNTING_UNIT_TAIL, '');
    const value = chineseNumeralToNumber(numeralRun);
    if (value !== null) values.push(value);
  }
  return values;
}

/**
 * 比较两段散文的数值多重集。
 * @param originalText 基线散文（话术侧传"这次真喂进去的依据"）
 * @param proposedText 生成结果散文
 * @returns 少掉与多出的数值键；两者都空表示数值守恒。`added` 天然去重，顺序按在生成结果里首次出现的先后
 */
export function diffNumberMultiset(originalText: string, proposedText: string): { missing: string[]; added: string[] } {
  const counts = new Map<string, number>();
  for (const value of numbersOf(originalText))
    counts.set(numberKeyOf(value), (counts.get(numberKeyOf(value)) ?? 0) + 1);
  // 生成结果里的每个数都从计数里扣一份：扣成负数就是"多出来的数"，剩正数就是"丢掉的数"。
  // 用多重集而不是集合，否则「提升 20%，复用率 20%」改成一个 20% 也能过。
  for (const value of numbersOf(proposedText)) {
    const key = numberKeyOf(value);
    counts.set(key, (counts.get(key) ?? 0) - 1);
  }
  const missing: string[] = [];
  const added: string[] = [];
  for (const [key, count] of counts) {
    if (count > 0) missing.push(key);
    else if (count < 0) added.push(key);
  }
  return { missing, added };
}
