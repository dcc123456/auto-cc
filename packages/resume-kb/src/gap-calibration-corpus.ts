/**
 * 缺口比对的**人判标注集**（spec 4.4-03 / 4.4-04 的尺子标定用，plan §4.4-e 判据三）。
 *
 * 这份数据标的是**尺子**，不是功能：每条只记「要求文本 × 库内文本 → 人判三态」，
 * 由 `gap-calibration.ts` 直接喂 `coverageOf`，**不经过 `report()`**。理由写在 plan §4.4-e：
 * 走完整链路的话，一次翻脸分不清是拆解腿抓错了要求还是这把 token 尺子量错了，标定就白做。
 *
 * 四条诚实约束（都是判据，不是风格）：
 *
 * 1. **人判在先，读数在后**。每条 `reason` 说的是"作为读者我凭什么算它满足"，不引用分数。
 * 2. **标注必须是自己敢签字的判断，不是为了让带干净而摆的棋子**。第一版实测（plan §4.4-e 落地记录）
 *    被两条不自洽的标注带进死路：单 token 的代表词（`协作`、`英语`、`Java`）在词面尺子上
 *    读数只能是 0 或 1，给它标"部分命中"等于要求一把尺子输出它表达不了的档位；另一条是为了造
 *    冲突而写的"只沾一个二字组"的库内文本——真实简历里写得出「负责技术文档写作」，不会写成
 *    「编写过使用文档」还指望它命中。两处都按"先怀疑标注"改掉了（见下面 `T14` / `T15` 的注释）。
 * 3. **故意收边界样本**。`isBoundary` 标出的是"人判 X、朴素 token 覆盖会判成 Y"的条目，
 *    它们留在集里不删（反循环就卡在这里：标注与词面代表词都出自同一支笔，不收冲突样本的话
 *    标出来的只会是"尺子同意我自己"）。
 * 4. **承认盲区而不是修平它**。零重合（`coverageOf` 返 `null`）的条目对任何阈值都恒判缺失，
 *    那是词面尺子的能力边界（语义等价、同义改写、单字母语言名 `Go`），标定动不了它，只在报告里列出。
 *
 * 语料全是虚构内容（同 `requirements-compare.test.ts` 的人物与地名），没有一个字节来自真实招聘平台
 * 或真实简历（AGENTS.md §7.2 / spec 4.4-08）。
 */
import type { GapState } from './requirements-compare.js';

/** 一条词面标注：要求代表词 × 库内实体文本 → 人判三态。 */
export interface GapTextAnnotation {
  /** 稳定号，报告与回归锁都按它对账（改内容不改号） */
  readonly id: string;
  /** 拆解腿的 `label`（比对真正吃的字段，别名归一后的代表词） */
  readonly claim: string;
  /** 库内实体的可比文本（真库里是 `evidenceTextOf(payload)` 的产物） */
  readonly target: string;
  /** 人判三态 */
  readonly humanState: GapState;
  /** 人判依据（一句话，不引用分数） */
  readonly reason: string;
  /** 是否是刻意收进来的边界样本（人判与朴素词面覆盖不一致的那类） */
  readonly isBoundary: boolean;
}

/** 一条亮点标注：库内实体文本 × JD 全文 → 人判"算不算这个岗位的差异化亮点"。 */
export interface GapHighlightAnnotation {
  /** 稳定号 */
  readonly id: string;
  /** 库内实体文本（`skill` / `achievement` 两类才进这条通道，见 `findHighlights`） */
  readonly entityText: string;
  /** JD 全文（第二道闸的比对对象） */
  readonly jdText: string;
  /** 人判：相关（该进亮点）还是不相关（该被闸门挡掉） */
  readonly isRelated: boolean;
  /** 人判依据 */
  readonly reason: string;
  /** 是否是刻意收进来的边界样本 */
  readonly isBoundary: boolean;
}

/** 亮点腿用的那份 JD 正文（虚构岗位；`缓存`/`接口`/`文档` 这些词是真 JD 一定会写的）。 */
const JD_BACKEND =
  '后端工程师（交易方向）：负责交易链路的稳定性与容量规划，要求 Java、Spring Boot，' +
  '熟悉 MySQL、Redis 缓存、限流与降级，5 年以上经验，具备良好的文档写作习惯。';

/**
 * 词面标注集（三态）。
 *
 * 类的分界按这条口径判（plan §4.4-e 判据三的操作化）：
 * **命中** = 这条实体文本单独拿出来就够向面试官证明这条要求；
 * **部分命中** = 明显相关，但要多补一句才敢写进简历；
 * **缺失** = 没关系，或者只是词面巧合。
 */
export const GAP_TEXT_ANNOTATIONS: readonly GapTextAnnotation[] = [
  // ---- 命中：点名，或把要求说的那件事写全了 ----
  {
    id: 'T01',
    claim: 'Java',
    target: 'Java 微服务，负责推荐接口与订单服务',
    humanState: 'matched',
    reason: '技术栈直接点名，不需要任何推断',
    isBoundary: false,
  },
  {
    id: 'T02',
    claim: '分布式',
    target: '负责分布式订单中台的拆分与容量规划',
    humanState: 'matched',
    reason: '要求里的词原样出现在经历里，且带具体动作',
    isBoundary: false,
  },
  {
    id: 'T03',
    claim: '高并发',
    target: '高并发场景下的缓存与限流设计',
    humanState: 'matched',
    reason: '写明场景就是要这个场景的解法',
    isBoundary: false,
  },
  {
    id: 'T04',
    claim: 'Redis',
    target: '负责 Redis 缓存集群的选型与热点 key 治理',
    humanState: 'matched',
    reason: '点名且有治理动作，不是"了解过"',
    isBoundary: false,
  },
  {
    id: 'T05',
    claim: 'Kafka',
    target: '负责 Kafka 消息链路的顺序性与重放设计',
    humanState: 'matched',
    reason: '点名的中间件且处理的是它的难点',
    isBoundary: false,
  },
  {
    id: 'T06',
    claim: '文档写作',
    target: '负责技术文档写作与新人之后的评审',
    humanState: 'matched',
    reason: '交付物就是文档本身，写作能力可直接举证',
    isBoundary: false,
  },
  {
    id: 'T07',
    claim: '项目管理',
    target: '负责项目的整体管理与交付排期',
    humanState: 'matched',
    reason: '把"项目"和"管理"都写全了，这就是项目管理本身',
    isBoundary: false,
  },
  {
    id: 'T08',
    claim: '带团队',
    target: '带团队 6 人，负责季度述职与人才盘点',
    humanState: 'matched',
    reason: '有人数、有管理动作，没人会说这条没满足',
    isBoundary: false,
  },
  {
    id: 'T09',
    claim: 'RESTful 接口',
    target: '负责 RESTful 风格接口的设计与文档化',
    humanState: 'matched',
    reason: '按要求的写法点名了接口风格',
    isBoundary: false,
  },
  {
    id: 'T10',
    claim: 'Linux',
    target: '负责 Linux 服务器运维与性能调优',
    humanState: 'matched',
    reason: '点名且是日常职责',
    isBoundary: false,
  },
  {
    id: 'T11',
    claim: '英语',
    target: '英语六级，可阅读英文文档并撰写邮件',
    humanState: 'matched',
    reason: '等级证书加实际用途，够举证',
    isBoundary: false,
  },
  {
    id: 'T12',
    claim: 'MySQL',
    target: '负责 MySQL 主从切换与慢查询治理',
    humanState: 'matched',
    reason: '点名且处理过它的运维议题',
    isBoundary: false,
  },
  {
    id: 'T13',
    claim: '协作',
    target: '负责跨部门协作流程的梳理与落地',
    humanState: 'matched',
    reason: '软技能写到"跨部门协作"就是举证，词面尺子在单 token 代表词上只有 0/1 两档（见文件头第 2 条）',
    isBoundary: true,
  },

  // ---- 部分命中：明显相关，但撑不满 ----
  {
    id: 'T14',
    claim: '高并发',
    target: '负责大促活动的并发压测脚本编写',
    humanState: 'partial',
    reason: '压测脚本碰的是并发，但设计侧的经验还没举证出来',
    isBoundary: true,
  },
  {
    id: 'T15',
    claim: '项目管理',
    target: '参与营销项目的排期同步与物料跟进',
    humanState: 'partial',
    reason:
      '沾到"项目"且干的是跟进活，但没有管理与交付的完整举证（第一版把这条标成"缺失"，' +
      '实测下它与 T24 同为单字面重合却给不同档位，是我标得不干净，改判部分命中）',
    isBoundary: true,
  },
  {
    id: 'T16',
    claim: '高并发',
    target: '负责服务的容量规划与限流配置',
    humanState: 'partial',
    reason: '容量与限流是高并发的近邻手段，但没写过并发量级',
    isBoundary: false,
  },
  {
    id: 'T17',
    claim: 'SQL',
    target: '负责订单库的索引优化与慢查询治理',
    humanState: 'partial',
    reason: '干的就是 SQL 层的活，只是库里那句话没写字面 SQL',
    isBoundary: true,
  },
  {
    id: 'T18',
    claim: 'Kafka',
    target: '负责消息队列（RabbitMQ）的搭建与运维',
    humanState: 'partial',
    reason: '同类中间件，迁移成本低但不是要求点名的那个',
    isBoundary: true,
  },
  {
    id: 'T19',
    claim: 'Docker',
    target: '负责服务容器化改造与镜像瘦身',
    humanState: 'partial',
    reason: '容器化经验实质就是这项能力，缺的只是名字',
    isBoundary: true,
  },
  {
    id: 'T20',
    claim: '带团队',
    target: '在组内推动代码评审与新人辅导',
    humanState: 'partial',
    reason: '带人做事，但头衔和范围还没落到"团队"上',
    isBoundary: true,
  },
  {
    id: 'T21',
    claim: '英语',
    target: '自学过英文技术课程（Coursera）',
    humanState: 'partial',
    reason: '能读英文材料，但要求要的读写能力没直接举证',
    isBoundary: true,
  },

  // ---- 缺失：没关系，或只是词面巧合 ----
  {
    id: 'T22',
    claim: 'Flink',
    target: 'Java 微服务，负责推荐接口与订单服务',
    humanState: 'missing',
    reason: '库里没有任何实时计算的经历',
    isBoundary: false,
  },
  {
    id: 'T23',
    claim: 'MongoDB',
    target: '负责 MySQL 主从切换与慢查询治理',
    humanState: 'missing',
    reason: '关系库经验不能算文档型数据库的经验',
    isBoundary: false,
  },
  {
    id: 'T24',
    claim: '项目管理',
    target: '负责订单系统的性能管理与容量规划',
    humanState: 'missing',
    reason: '这里的"管理"管的是系统性能，不是项目：单字面巧合不该进证据链',
    isBoundary: true,
  },
  {
    id: 'T25',
    claim: '文档写作',
    target: '负责大促活动的活动页文案与推广物料',
    humanState: 'missing',
    reason: '"文案"与"技术文档写作"是两件事，别被"文"字沾上就算',
    isBoundary: true,
  },
  {
    id: 'T26',
    claim: 'Kubernetes',
    target: '负责 Jenkins 流水线与自动化发布',
    humanState: 'missing',
    reason: 'CI 与编排是两件事，别把自动化发布说成 K8s',
    isBoundary: false,
  },
  {
    id: 'T27',
    claim: 'React',
    target: '负责订单服务的接口幂等改造',
    humanState: 'missing',
    reason: '后端改造与前端框架毫无关系',
    isBoundary: false,
  },
  {
    id: 'T28',
    claim: 'Go',
    target: '负责营销页面的埋点与转化率分析',
    humanState: 'missing',
    reason: '库里没有该语言的任何痕迹',
    isBoundary: true,
  },
  {
    id: 'T29',
    claim: 'Spark',
    target: '负责数据仓库建模与 ETL 脚本编写',
    humanState: 'missing',
    reason: '数仓建模是 SQL 侧功夫，没写过分布式作业就不算',
    isBoundary: false,
  },
];

/**
 * 亮点标注集（二态）。
 *
 * 这条通道要拦的是"确实有、但与这个岗位无关"的东西（plan §4.4-c 判据二的第二道闸），
 * 所以判据问的是**相关**，不是**具备**——具备由"它在库里"这个事实给出。
 */
export const GAP_HIGHLIGHT_ANNOTATIONS: readonly GapHighlightAnnotation[] = [
  {
    id: 'H01',
    entityText: '负责大促活动的限流与降级预案设计',
    jdText: JD_BACKEND,
    isRelated: true,
    reason: 'JD 正面临门点名要限流与降级，这条就是同一件事',
    isBoundary: false,
  },
  {
    id: 'H02',
    entityText: '交易链路容量规划与全链路压测',
    jdText: JD_BACKEND,
    isRelated: true,
    reason: '职责句几乎同一措辞，是该写进自我介绍的差异化经验',
    isBoundary: false,
  },
  {
    id: 'H03',
    entityText: 'Redis 缓存的热点治理与降级兜底',
    jdText: JD_BACKEND,
    isRelated: true,
    reason: 'JD 要 Redis 缓存，治理过难点就是亮点',
    isBoundary: false,
  },
  {
    id: 'H04',
    entityText: '沉淀组件文档写作与接口评审规范',
    jdText: JD_BACKEND,
    isRelated: true,
    reason: 'JD 明写"良好的文档写作习惯"，能定规范就是超出要求',
    isBoundary: false,
  },
  {
    id: 'H05',
    entityText: '机动车驾驶证 C1',
    jdText: JD_BACKEND,
    isRelated: false,
    reason: '与岗位毫无关系，正是第二道闸存在的理由',
    isBoundary: false,
  },
  {
    id: 'H06',
    entityText: '组织公司内部篮球赛与季度团建',
    jdText: JD_BACKEND,
    isRelated: false,
    reason: '真实但无关，推上去会让整份报告失去可信度',
    isBoundary: false,
  },
  {
    id: 'H07',
    entityText: '英语六级 520 分',
    jdText: JD_BACKEND,
    isRelated: false,
    reason: 'JD 没提语言要求，对交易后端岗不构成差异化',
    isBoundary: false,
  },
  {
    id: 'H08',
    entityText: 'Rust 编译器插件开源维护',
    jdText: JD_BACKEND,
    isRelated: false,
    reason: '含金量高但与这个岗位的方向不相干',
    isBoundary: true,
  },
  {
    id: 'H09',
    entityText: '参与开源 Dubbo 组件贡献',
    jdText: JD_BACKEND,
    isRelated: true,
    reason: 'Java 生态的开源贡献，对这个岗位是强加分',
    isBoundary: true,
  },
  {
    id: 'H10',
    entityText: 'NoSQL 选型与迁移',
    jdText: JD_BACKEND,
    isRelated: true,
    reason: 'JD 要 MySQL/Redis，能讲清存储选型就是相关经验',
    isBoundary: true,
  },
  {
    id: 'H11',
    entityText: '负责数据看板与 BI 报表搭建',
    jdText: JD_BACKEND,
    isRelated: false,
    reason: '同属技术但方向是分析，不是交易链路稳定性',
    isBoundary: false,
  },
  {
    id: 'H12',
    entityText: '带 3 人小组负责营销活动的后端交付',
    jdText: JD_BACKEND,
    isRelated: false,
    reason: 'JD 只要个人贡献，管理经验对这个岗不构成亮点',
    isBoundary: true,
  },
  {
    id: 'H13',
    entityText: 'MySQL 分库分表与索引优化',
    jdText: JD_BACKEND,
    isRelated: true,
    reason: 'JD 明列 MySQL，做过分库分表是硬加分',
    isBoundary: true,
  },
];
