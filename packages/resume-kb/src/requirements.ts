/**
 * JD 文本 → 能力要求列表的**词面腿**（spec 4.4-01 的四类判据 / 4.4-02 的回落分支 / 4.4-07 的稳定性 /
 * 4.4-08 的离线样例 / 4.4-10 的来源标注）。
 *
 * 这一层只认「JD 里出现了我们词典里就有的词」，并且把命中的**原文位置**一并交出去（4.4-01 要求"带原文引用位置"，
 * 界面 4.4-05 靠它跳转高亮）。它的定位是**回落而不是完整拆解**：中文 JD 的长尾表达（「熟悉分布式家族的那一套」）
 * 词面腿抓不到，那归 4.4-b 的模型腿；模型不可用时宁可少几条也不要瞎猜——少几条只是报告短一些，
 * 猜错则会把用户从没要求的东西算成缺口（AGENTS.md §8.4 事实锁定的同一立场）。
 *
 * 三条立身之本：
 * 1. **纯函数**：不碰 cordis、不开连接、不发请求（同 `entities.ts` / `search.ts` 的规矩，4.4-08 的判据就在这里），
 *    装配只发生在 `gap-service.ts`；
 * 2. **确定性**：同一个输入永远同一个输出，不依赖 `Date.now`、不依赖对象遍历顺序、不依赖随机数
 *    （4.4-07 的"两次运行 hash 相同"就是断言这件事，词表次序在下面 `LEXICON_ENTRIES` 的排序里定死）；
 * 3. **不落原文到日志**：本模块只返回结构，日志由服务层写计数（延续 4.3-12 的脱敏口径，JD 正文同样是个人的）。
 *
 * 来源标注（spec 4.4-10）：四类要求的**划分口径**（硬技能 / 软技能 / 学历 / 经验年限）参考了
 * `.research-repos/src/ai-resume-master/server/src/prompts/jdParse.ts`（同仓库 `keywordService.ts` 展示了
 * 它的比对做法），**本文件未复制其任何文本**——词表是本仓库自写的中文岗位常用词，判定写法也不同
 * （它把整份简历 stringify 后做 `includes` 只出一个百分比，我们要三态与证据 id，见 plan §4.4 证据 [2]）。
 * 该仓库的许可记录见 `docs/research/source-repos-analysis.md` §1.1（无 LICENSE 文件、`server/package.json` 写 ISC，
 * 且已由用户确认归其所有、可自由改授——见同文件 §1.2 的豁免记录）。
 */

/** 能力要求的四类（顺序即界面分栏与稳定序列的顺序，spec 4.4-01 / 4.4-05）。 */
export const REQUIREMENT_KINDS = ['hard_skill', 'soft_skill', 'education', 'experience_years'] as const;

/** 四类之一的字面量类型。 */
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

/**
 * 词表版本（同 2.5-09 的 `scriptVersion` 口径）：改词表必须同时改它，
 * 否则 4.4-07 复盘时分不清某份报告是哪一版词表产的。
 */
export const REQUIREMENT_LEXICON_VERSION = 'lex-v1';

/**
 * 一条能力要求。
 *
 * `start` / `end` 是 **JS 字符串下标（UTF-16 code unit）**，`end` 不含；之所以不是字节偏移，
 * 因为消费方（界面 `String.slice`、`rangeText`）都在 JS 字符串上操作，换一层字节只会引入错位。
 */
export interface RequirementItem {
  /** 四类之一 */
  kind: RequirementKind;
  /** 词表里的代表词（同一能力的别名会归到同一个 label，比对与检索按它走） */
  label: string;
  /** JD 原文里实际出现的形式，用于界面高亮与人工复核 */
  quote: string;
  /** 命中片段在 JD 原文里的起始下标（UTF-16 code unit，含） */
  start: number;
  /** 命中片段在 JD 原文里的结束下标（不含） */
  end: number;
  /** 经验年限类要求的年数；其余三类恒为 null（不用 0 表示"没有"，0 年是个合法读数的话就分不清了） */
  years: number | null;
  /** 这条是哪条腿产的：词面腿还是模型腿（4.4-b 才会出现 model，回落时界面据此播报，spec 4.4-02 的 V 类） */
  via: 'lexicon' | 'model';
}

/** 一次词面拆解的产出。 */
export interface LexicalExtractResult {
  /** 按 `kind` 次序 + `start` 升序排好的要求列表（稳定序列，4.4-07 直接对它做 hash） */
  items: RequirementItem[];
  /** 超出 `limitPerKind` 而被丢弃的条数（不是错误，但必须能被看见——4.4-06 的"不许只给负面结论"要求计数如实） */
  droppedByLimit: number;
  /** 词表版本，随结果一起进复盘记录 */
  lexiconVersion: string;
}

/** 词表的一条：一个代表词 + 它在中文 JD 里的若干书写形式。 */
interface LexiconGroup {
  readonly kind: RequirementKind;
  readonly label: string;
  readonly aliases: readonly string[];
}

/**
 * 硬技能词表。
 *
 * 收录门槛：在中文技术岗 JD 里**成词**、且不会与别的词重叠误伤的写法。
 * 故意**不收单字母形式**（C / G / R 这类）——中文正文里「3C数码」「C端」会把它们误捡起来，
 * 词面腿宁可漏（漏了少一条），错了就是凭空给用户造一个缺口。
 */
const HARD_SKILL_GROUPS: readonly LexiconGroup[] = [
  { kind: 'hard_skill', label: 'Java', aliases: ['Java', 'JVM', 'Spring Boot', 'SpringCloud', 'Spring Cloud'] },
  { kind: 'hard_skill', label: 'Python', aliases: ['Python', 'Django', 'FastAPI', 'Flask'] },
  { kind: 'hard_skill', label: 'Go', aliases: ['Golang', 'Go 语言', 'Go语言', 'Go'] },
  { kind: 'hard_skill', label: 'C++', aliases: ['C++'] },
  { kind: 'hard_skill', label: 'C#', aliases: ['C#', '.NET'] },
  { kind: 'hard_skill', label: 'Rust', aliases: ['Rust'] },
  { kind: 'hard_skill', label: 'JavaScript', aliases: ['JavaScript', 'JS 生态'] },
  { kind: 'hard_skill', label: 'TypeScript', aliases: ['TypeScript'] },
  { kind: 'hard_skill', label: 'Node.js', aliases: ['Node.js', 'NodeJS', 'Node'] },
  { kind: 'hard_skill', label: 'React', aliases: ['React'] },
  { kind: 'hard_skill', label: 'Vue', aliases: ['Vue.js', 'Vue3', 'Vue'] },
  { kind: 'hard_skill', label: '小程序', aliases: ['微信小程序', '小程序'] },
  { kind: 'hard_skill', label: 'Swift', aliases: ['Swift'] },
  { kind: 'hard_skill', label: 'Kotlin', aliases: ['Kotlin'] },
  { kind: 'hard_skill', label: 'Flutter', aliases: ['Flutter'] },
  { kind: 'hard_skill', label: 'SQL', aliases: ['SQL'] },
  { kind: 'hard_skill', label: 'MySQL', aliases: ['MySQL'] },
  { kind: 'hard_skill', label: 'PostgreSQL', aliases: ['PostgreSQL', 'PG 数据库'] },
  { kind: 'hard_skill', label: 'Redis', aliases: ['Redis'] },
  { kind: 'hard_skill', label: 'MongoDB', aliases: ['MongoDB'] },
  { kind: 'hard_skill', label: 'Elasticsearch', aliases: ['Elasticsearch', 'ES 检索'] },
  { kind: 'hard_skill', label: 'ClickHouse', aliases: ['ClickHouse'] },
  { kind: 'hard_skill', label: 'Kafka', aliases: ['Kafka'] },
  { kind: 'hard_skill', label: 'RabbitMQ', aliases: ['RabbitMQ'] },
  { kind: 'hard_skill', label: 'RocketMQ', aliases: ['RocketMQ'] },
  { kind: 'hard_skill', label: 'Spark', aliases: ['Spark'] },
  { kind: 'hard_skill', label: 'Flink', aliases: ['Flink'] },
  { kind: 'hard_skill', label: 'Hadoop', aliases: ['Hadoop'] },
  { kind: 'hard_skill', label: '数据仓库', aliases: ['数据仓库', '数仓', 'ETL'] },
  { kind: 'hard_skill', label: 'Docker', aliases: ['Docker', '容器化'] },
  { kind: 'hard_skill', label: 'Kubernetes', aliases: ['Kubernetes', 'K8s'] },
  { kind: 'hard_skill', label: 'Prometheus', aliases: ['Prometheus'] },
  { kind: 'hard_skill', label: 'Linux', aliases: ['Linux'] },
  { kind: 'hard_skill', label: 'CI/CD', aliases: ['CI/CD', '持续集成', '持续交付'] },
  { kind: 'hard_skill', label: '微服务', aliases: ['微服务'] },
  { kind: 'hard_skill', label: '分布式', aliases: ['分布式'] },
  { kind: 'hard_skill', label: '高并发', aliases: ['高并发', '并发编程'] },
  { kind: 'hard_skill', label: '消息队列', aliases: ['消息队列'] },
  { kind: 'hard_skill', label: '缓存', aliases: ['缓存'] },
  { kind: 'hard_skill', label: 'RESTful 接口', aliases: ['RESTful', 'REST 接口', 'OpenAPI'] },
  { kind: 'hard_skill', label: 'gRPC', aliases: ['gRPC', 'RPC'] },
  { kind: 'hard_skill', label: '机器学习', aliases: ['机器学习', '深度学习', 'PyTorch', 'TensorFlow'] },
  { kind: 'hard_skill', label: '推荐算法', aliases: ['推荐算法', '推荐系统'] },
  { kind: 'hard_skill', label: '风控模型', aliases: ['风控模型', '风控引擎', '反欺诈'] },
  { kind: 'hard_skill', label: '自动化测试', aliases: ['自动化测试', 'Selenium', '接口测试'] },
  { kind: 'hard_skill', label: '性能测试', aliases: ['性能测试', 'JMeter', '压测'] },
];

/** 软技能词表（JD 里的"素质要求"段）。 */
const SOFT_SKILL_GROUPS: readonly LexiconGroup[] = [
  {
    kind: 'soft_skill',
    label: '沟通表达',
    aliases: ['沟通能力强', '良好的沟通', '沟通表达', '跨部门沟通', '表达能力'],
  },
  { kind: 'soft_skill', label: '协作', aliases: ['团队协作', '跨部门协作', '合作精神', '配合度高'] },
  { kind: 'soft_skill', label: '抗压', aliases: ['抗压能力', '承受压力', '适应快节奏'] },
  { kind: 'soft_skill', label: '自驱', aliases: ['自我驱动', '自驱力', '主动性强', '主观能动性'] },
  { kind: 'soft_skill', label: '学习能力', aliases: ['学习能力强', '快速学习', '自学能力'] },
  { kind: 'soft_skill', label: '责任心', aliases: ['责任心', '责任感', '严谨细致'] },
  { kind: 'soft_skill', label: '带团队', aliases: ['带团队', '团队管理', '技术负责人', '带领小组'] },
  { kind: 'soft_skill', label: '项目管理', aliases: ['项目管理', '进度把控', '跨团队推进'] },
  { kind: 'soft_skill', label: '文档写作', aliases: ['文档编写', '技术方案撰写', '写作能力'] },
  { kind: 'soft_skill', label: '英语', aliases: ['英语读写', '英语口语', '英文文献', 'CET', '雅思'] },
];

/**
 * 学历要求词表。
 *
 * 「研究生」单列而不并进「硕士」：JD 写「研究生及以上学历」时按字面给「研究生」，
 * 三态比对（4.4-c）再按"硕士 ⊇ 研究生"的口径归并，那一步是有据的放宽，不该混进抽取阶段。
 */
const EDUCATION_GROUPS: readonly LexiconGroup[] = [
  { kind: 'education', label: '博士', aliases: ['博士'] },
  { kind: 'education', label: '硕士', aliases: ['硕士'] },
  { kind: 'education', label: '研究生', aliases: ['研究生'] },
  { kind: 'education', label: '本科', aliases: ['本科', '学士'] },
  { kind: 'education', label: '大专', aliases: ['大专', '专科'] },
];

/** 拍平并按"长别名先匹配"定死的词表：次序只由别名长度与字典序决定，与上面的书写顺序无关（4.4-07）。 */
const LEXICON_ENTRIES: readonly { kind: RequirementKind; label: string; alias: string }[] = [
  ...HARD_SKILL_GROUPS,
  ...SOFT_SKILL_GROUPS,
  ...EDUCATION_GROUPS,
]
  .flatMap((group) => group.aliases.map((alias) => ({ kind: group.kind, label: group.label, alias })))
  .sort((left, right) => right.alias.length - left.alias.length || left.alias.localeCompare(right.alias, 'en'));

/** 经验年限的两种常见写法：「3年以上工作经验」「经验要求 5 年」。`(?<!\d)` 防的是「2020年」里捡出「20年」。 */
const EXPERIENCE_YEAR_PATTERN = /(?<!\d)(\d{1,2})\s*年(?:以上|及以上)?\s*(?:相关)?(?:工作经验|经验|从业经验|工作年数)/g;

/**
 * 把别名转成可安全嵌入正则的形式。
 * @param alias 词表里的别名原文（含 `.` `+` `/` 这类正则元字符）
 * @returns 转义后的字面量片段
 */
function escapeForRegExp(alias: string): string {
  return alias.replace(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);
}

/**
 * 判断某条别名要不要加词边界。
 *
 * 只有"纯 ASCII 字母"的别名（`SQL`、`Node`、`AI`）需要：不加边界就会在 `NoSQL`、`logo` 里被捡走。
 * 带元字符或中文的别名（`C++`、`Node.js`、`数据仓库`）本身已经足够独特，加边界反而会伤到 `C++/Java` 这种连写。
 * @param alias 词表别名
 * @returns 需要边界时返回 true
 */
function needsWordBoundary(alias: string): boolean {
  return /^[A-Za-z]+$/.test(alias);
}

/**
 * 收集一段文本里所有不重叠的命中区间。
 * @param taken 已占用的区间列表（按起始升序维护，长别名先占位，短别名只能在缝里找）
 * @param start 待判区间的起始下标
 * @param end 待判区间的结束下标（不含）
 * @returns 与任何已占用区间都不重叠时返回 true
 */
function isFreeSpan(taken: readonly { start: number; end: number }[], start: number, end: number): boolean {
  return !taken.some((span) => start < span.end && span.start < end);
}

/**
 * 扫描词表命中的硬技能 / 软技能 / 学历条目。
 * @param jdText JD 原文（不做归一化：`quote` 必须能按原下标切回给用户看，归一化会改长度）
 * @param taken 命中区间登记表（就地追加，供跨类去重与年限扫描共用的重叠判定）
 * @returns 未排序、未去重的命中列表（同一 label 可能多条，去重在下面做）
 */
function scanLexicon(jdText: string, taken: { start: number; end: number }[]): RequirementItem[] {
  const found: RequirementItem[] = [];
  for (const entry of LEXICON_ENTRIES) {
    const body = escapeForRegExp(entry.alias);
    const pattern = needsWordBoundary(entry.alias) ? `(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])` : body;
    const matcher = new RegExp(pattern, 'gi');
    for (let match = matcher.exec(jdText); match !== null; match = matcher.exec(jdText)) {
      const start = match.index;
      const end = start + match[0].length;
      if (!isFreeSpan(taken, start, end)) continue;
      taken.push({ start, end });
      found.push({
        kind: entry.kind,
        label: entry.label,
        quote: jdText.slice(start, end),
        start,
        end,
        years: null,
        via: 'lexicon',
      });
    }
  }
  return found;
}

/**
 * 扫描经验年限要求。
 * @param jdText JD 原文
 * @param taken 词表已占用的区间（「5 年以上工作经验」里的「经验」二字没被词典占用，但年限自己登记区间，
 *               后续切片与高亮按同一套区间读）
 * @returns 年限条目（同一句里写了两次数值就出两条，交给 4.4-c 的比对去判松紧）
 */
function scanExperienceYears(jdText: string, taken: { start: number; end: number }[]): RequirementItem[] {
  const found: RequirementItem[] = [];
  for (const match of jdText.matchAll(EXPERIENCE_YEAR_PATTERN)) {
    const years = Number(match[1]);
    if (Number.isNaN(years)) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (!isFreeSpan(taken, start, end)) continue;
    taken.push({ start, end });
    found.push({
      kind: 'experience_years',
      label: `${String(years)} 年以上经验`,
      quote: jdText.slice(start, end),
      start,
      end,
      years,
      via: 'lexicon',
    });
  }
  return found;
}

/**
 * 四类内部分组用的序（`REQUIREMENT_KINDS` 的书写次序即稳定输出的次序）。
 * @param kind 四类之一
 * @returns 在四类表里的下标
 */
function kindRank(kind: RequirementKind): number {
  return REQUIREMENT_KINDS.indexOf(kind);
}

/**
 * 对同一 `kind + label` 只保留最早出现的那一条（别名的不同写法归成一条要求），
 * 并按「四类次序 → 起始下标」排成稳定序列。
 * @param items 未去重、未排序的命中列表
 * @returns 去重排序后的列表
 */
function dedupeAndSort(items: readonly RequirementItem[]): RequirementItem[] {
  const firstOf = new Map<string, RequirementItem>();
  for (const item of items) {
    const key = `${item.kind}:${item.label}`;
    const existing = firstOf.get(key);
    if (existing === undefined || item.start < existing.start) firstOf.set(key, item);
  }
  return [...firstOf.values()].sort(
    (left, right) => kindRank(left.kind) - kindRank(right.kind) || left.start - right.start,
  );
}

/**
 * 词面腿的拆解入口：把 JD 原文拆成带原文位置的能力要求列表。
 *
 * 全程无随机、无时间、无网络（4.4-07 / 4.4-08）；空文本不报错，返回空列表——
 * 「这条 JD 没写要求」是合法读数，而"是不是空 JD"该由服务层在系统边界判（spec 4.4-01 的入参校验在 4.4-b 的调用点）。
 * @param jdText JD 原文（来自本地样例文件或 `jobs.description`，单位：JS 字符串）
 * @param limitPerKind 每类最多保留几条（来自 `kb.gap` 配置，4.3-03 的"代码内无魔法数"同口径）
 * @returns 稳定序列 + 被上限丢弃的条数 + 词表版本
 */
export function extractRequirementsLexically(jdText: string, limitPerKind: number): LexicalExtractResult {
  const taken: { start: number; end: number }[] = [];
  const all = dedupeAndSort([...scanLexicon(jdText, taken), ...scanExperienceYears(jdText, taken)]);
  const usedByKind = new Map<RequirementKind, number>();
  const items: RequirementItem[] = [];
  let droppedByLimit = 0;
  for (const item of all) {
    const used = usedByKind.get(item.kind) ?? 0;
    if (used >= limitPerKind) {
      droppedByLimit += 1;
      continue;
    }
    usedByKind.set(item.kind, used + 1);
    items.push(item);
  }
  return { items, droppedByLimit, lexiconVersion: REQUIREMENT_LEXICON_VERSION };
}
