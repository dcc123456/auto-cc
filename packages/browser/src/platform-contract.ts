/**
 * `PlatformAdapter` 契约与**站点知识包**的形状（spec 2.2-06 / 2.2-08）。
 *
 * 为什么契约放在内核侧而不是平台包里：plan §3 规则 1 规定 `browser` 不认识 BOSS，
 * 平台知识只能**被注册进来**。那么「注册进来的东西长什么样」就必须定义在被认识的那一侧，
 * 否则每个平台包各自解释一遍接口，`workflow` 就只能对着一堆互不兼容的形状写分支。
 *
 * 知识包与代码分离是这条契约的另一半：定位声明（含 CSS / XPath 字面量）、字段顺序、
 * 频控参数**全部是数据**。站点改版改的是数据，适配器代码不动——这也是 2.2-08 能被机检的原因
 * （`scripts/check-knowledge-pack.ts` 扫的就是「适配器源码里不许出现选择器字面量」）。
 */
import { AppError, type ResumeAttachment } from '@auto-cc/core';
import type { PlatformMetaView } from '@auto-cc/shared';
import { z } from 'zod';
import { validateSpec } from './locator-spec.js';

/** 定位声明的线格式：与 `shared` 的 `LocateSpec` 同构，用于校验外部 JSON（知识包是不可信输入）。 */
const locateCandidateSchema = z.strictObject({
  strategy: z.enum(['testId', 'id', 'name', 'role', 'text', 'css', 'xpath', 'fingerprint']),
  value: z.string().min(1).optional(),
  attribute: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  exact: z.boolean().optional(),
});

const locateSpecSchema = z.strictObject({
  description: z.string().min(1),
  cardinality: z.enum(['single', 'many']),
  candidates: z.array(locateCandidateSchema).min(1),
  /** 注入类定位（如隐藏的 `input[type=file]`）设 false，见 `LocateSpec.requireActionable`。 */
  requireActionable: z.boolean().optional(),
});

/**
 * 抓取字段声明：语义名 → 从哪个定位取，取正文还是取属性。
 *
 * 这里只放**定位名的引用**，不放选择器字面量（AGENTS.md §6.5 的机检 2.2-08 依赖这一点：
 * 选择器全部留在 `locators` 里，改版改的还是一份数据）。字段名与必填性也在这里，
 * 于是 2.6 换一个平台时新增的是 JSON，不是代码。
 */
const captureFieldSchema = z.strictObject({
  /** 字段名（适配器按名取用，如 `title` / `salary` / `description`） */
  name: z.string().min(1),
  /** 引用 `locators` 里的语义名；引用不存在的名字在加载时就报错 */
  locator: z.string().min(1),
  /** 要读的属性名（如 `href`）；省略则读元素正文 */
  attribute: z.string().min(1).optional(),
  /** 必填声明：抽取阶段原样带回命中与否，完整率判定归适配器 */
  required: z.boolean().optional(),
});

/** 一处页面（列表或详情）的批量抽取声明。 */
const captureSectionSchema = z.strictObject({
  /** 容器定位名（列表页是卡片，详情页是正文根节点） */
  container: z.string().min(1),
  fields: z.array(captureFieldSchema).min(1),
});

/** 搜索条件 → URL 查询参数名（2.3-01：三个维度都是平台的筛选参数，不是事后过滤）。 */
const searchParamsSchema = z.strictObject({
  /** 关键词参数名（如 `query`） */
  keyword: z.string().min(1),
  /** 城市参数名（如 `city`） */
  city: z.string().min(1),
  /** 经验筛选参数名（如 `experience`） */
  experience: z.string().min(1),
});

/** 站点知识包：平台自己声明的「页面长什么样、动作怎么打、节奏怎么控」。 */
export const knowledgePackSchema = z.strictObject({
  platform: z.string().regex(/^[a-z][a-z0-9-]*$/, '平台标识要用小写字母开头的短名'),
  displayName: z.string().min(1),
  startUrl: z.url(),
  capabilities: z.array(z.enum(['search', 'detail', 'chat', 'sendResume', 'readReplies'])).min(1),
  /** 语义名 → 定位声明。适配器只按语义名取用，源码里不出现任何选择器。 */
  locators: z.record(z.string().min(1), locateSpecSchema),
  /** 抓取声明（2.3）：列表与详情各一处「容器 + 字段」。 */
  capture: z.strictObject({
    list: captureSectionSchema,
    detail: captureSectionSchema,
  }),
  /** 搜索 URL 的参数名（2.3-01）。拼 URL 的代码是通用的，参数名是站点知识。 */
  search: z.strictObject({
    params: searchParamsSchema,
  }),
  /**
   * 打招呼与对话的页面声明（2.5-d）。缺段即「这个平台还没有会话页知识」，
   * 适配器据此以结构化失败退出，而不是拿一套猜出来的选择器去点真实站点。
   */
  chat: z
    .strictObject({
      /** 会话页相对路径（按 `startUrl` 折算）；省略就在当前已打开的页面上动手（真实平台从岗位卡进会话） */
      entryPath: z.string().min(1).optional(),
      /**
       * 会话页地址上表示「和谁聊」的查询参数名。
       *
       * 有了它，`chat(jobId)` / `readReplies(jobId)` 才是按目标切换会话；没有它就只能整页读同一个线程，
       * 那时把读数写成传入的 jobId 就是假证据——所以适配器在缺这个键时只许在「当前页就是该会话」时用。
       */
      targetParam: z.string().min(1).optional(),
      /** 输入框定位名 */
      input: z.string().min(1),
      /** 发送按钮定位名 */
      sendButton: z.string().min(1),
      /** 发送状态行定位名：`sent` 由它回读，不是由「点过了」推断 */
      statusLine: z.string().min(1),
      /** 状态行里表示「已送达」的字样（各站点文案不同，所以是数据不是代码） */
      sentPattern: z.string().min(1),
      /** 一条消息项的定位名（读回复时的容器） */
      messageItem: z.string().min(1),
      /**
       * 消息正文在容器**里面**的定位名。
       *
       * 必须是数据而不是代码里的一句 `textContent`：页面上的方向标记（「对方：」这类）与正文常在同一个
       * 文本节点里，把整个容器读回来就会连标记一起存进会话表；而标记长什么样、单独装在哪个节点里，
       * 逐站点不同（spec 2.5-08 要的是正文干净）。
       */
      messageBody: z.string().min(1),
      /** 消息项上携带平台侧稳定标识的属性名，落库时按它去重 */
      messageIdAttribute: z.string().min(1),
      /** 消息项上区分方向的属性名 */
      directionAttribute: z.string().min(1),
      /** `directionAttribute` 里表示「对方发的」那个值，其余值都算自己发的 */
      inboundValue: z.string().min(1),
    })
    .optional(),
  /**
   * 简历投递的页面声明（spec 2.6-04 / 07，2.6-b）。缺段即「这个平台还没有上传页知识」，
   * 适配器据此以结构化失败退出，而不是拿一套猜出来的选择器去点真实站点——与 `chat` 段同一条纪律。
   */
  deliver: z
    .strictObject({
      /** 上传页相对路径（按 `startUrl` 折算）；省略就在当前已打开的页面上动手（真实站点从会话里点「发送简历」） */
      entryPath: z.string().min(1).optional(),
      /** 上传页地址上表示「递给谁」的查询参数名；没有它就只能对当前这一个会话动手 */
      targetParam: z.string().min(1).optional(),
      /**
       * 上传控件（`input[type=file]`）的定位名。
       *
       * 站点普遍把它藏在「选择文件」按钮背后，所以这条声明**应当带 `requireActionable: false`**：
       * 隐藏的控件读不到盒模型，按默认可点判据会在定位阶段就被 fail-closed 打掉（plan §13.6 第 1 条）。
       */
      uploadInput: z.string().min(1),
      /** 确认投递的按钮定位名 */
      sendButton: z.string().min(1),
      /** 投递状态行定位名：`sent` 由它回读；同一行也是「目标已下架」的读数来源 */
      statusLine: z.string().min(1),
      /** 状态行里表示「简历已递出」的字样（各站点文案不同，所以是数据不是代码） */
      sentPattern: z.string().min(1),
      /**
       * 状态行里表示「这个岗位已经不收了」的字样（spec 2.6-07 的二次校验依据）。
       *
       * 为什么不是 jobs 表上的一列：抓取那一刻的「在招」到投递这一刻早已过期，而库里没有状态列
       * （plan §13.4 第 3 条）——只有现问页面才是当时的真相，所以这份数据必须留在知识包里。
       */
      offlinePattern: z.string().min(1),
    })
    .optional(),
  /**
   * 风控页的文字判据（spec 2.7-01）。缺段即「这个平台只按 HTTP 状态判风控」，
   * 而不是「拿一套猜出来的文案去真实页面上撞」。
   *
   * 为什么是正则而不是文案数组：站点把「安全验证 / 请稍后重试 / 访问受限」放在标题、状态行
   * 或正文任意一处，而且各家措辞不同——这是页面知识，必须留在数据里（同 `sentPattern` 的理由）。
   */
  risk: z
    .strictObject({
      /** 命中即视为风控的源码（按 `new RegExp(source)` 解释，加载时先验证能否编译） */
      riskPattern: z.string().min(1),
    })
    .optional(),
  /** 抓取字段的声明顺序：列表页字段顺序变了也只改这份数据。 */
  fieldOrder: z.array(z.string().min(1)).default([]),
});

/** 校验后的知识包形状。 */
export type KnowledgePack = z.output<typeof knowledgePackSchema>;

/**
 * 校验一份知识包：结构过 zod，再逐条跑定位声明的语义校验，然后查抓取/会话/投递引用的定位名是否存在，
 * 最后编译一次风控正则。
 * @param raw 从 JSON 读出来的未知值（外部数据，一律视为不可信）
 * @returns 校验通过的知识包
 * @throws 结构、声明或引用非法时 `KNOWLEDGE_PACK_INVALID`，`details.problems` 逐条指出是哪一层的哪一条
 */
export function parseKnowledgePack(raw: unknown): KnowledgePack {
  const parsed = knowledgePackSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('KNOWLEDGE_PACK_INVALID', '站点知识包结构不合法', 'platform.contract', {
      problems: parsed.error.issues.map((issue) => `${issue.path.join('.')}：${issue.message}`),
    });
  }
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(parsed.data.locators)) {
    for (const problem of validateSpec(spec)) problems.push(`${name}：${problem}`);
  }
  // 抓取声明只引用定位名，所以名字拼错必须在加载时发现——否则要到抓取时才表现为「某字段永远读不到」，
  // 那种错误界面上一句「没抓到」就盖过去了。
  const locatorNames = new Set(Object.keys(parsed.data.locators));
  for (const [section, part] of Object.entries(parsed.data.capture)) {
    if (!locatorNames.has(part.container)) {
      problems.push(`capture.${section}.container：引用了不存在的定位名「${part.container}」`);
    }
    for (const field of part.fields) {
      if (!locatorNames.has(field.locator)) {
        problems.push(`capture.${section}.${field.name}：引用了不存在的定位名「${field.locator}」`);
      }
    }
  }
  // 会话页的五处定位名同理：拼错的名字必须在加载时发现，而不是等打招呼时点到一个不存在的按钮。
  const chat = parsed.data.chat;
  if (chat) {
    for (const [key, name] of [
      ['input', chat.input],
      ['sendButton', chat.sendButton],
      ['statusLine', chat.statusLine],
      ['messageItem', chat.messageItem],
      ['messageBody', chat.messageBody],
    ] as const) {
      if (!locatorNames.has(name)) problems.push(`chat.${key}：引用了不存在的定位名「${name}」`);
    }
  } else if (parsed.data.capabilities.some((item) => item === 'chat' || item === 'readReplies')) {
    // 声明了会话能力却没有会话知识 = 到了真实页面上只能靠猜，所以这里就判包不合法。
    problems.push('chat：capabilities 含 chat / readReplies，但知识包没有 chat 段（页面知识不能靠猜）');
  }
  // 投递页的三处定位名同上一条纪律：拼错的名字要在加载时发现，而不是等简历注进一个不存在的控件。
  const deliver = parsed.data.deliver;
  if (deliver) {
    for (const [key, name] of [
      ['uploadInput', deliver.uploadInput],
      ['sendButton', deliver.sendButton],
      ['statusLine', deliver.statusLine],
    ] as const) {
      if (!locatorNames.has(name)) problems.push(`deliver.${key}：引用了不存在的定位名「${name}」`);
    }
  } else if (parsed.data.capabilities.includes('sendResume')) {
    // 与 chat 段同一处判据：声明了投递能力却没有上传页知识，真到页面上只能靠猜，那就别让这份包上线。
    problems.push('deliver：capabilities 含 sendResume，但知识包没有 deliver 段（页面知识不能靠猜）');
  }
  // 风控判据是页面文字正则：写坏了不会报错，只会「永远不命中」，于是风控页被当成正常页面继续跑。
  // 那种失败静默且危险，所以必须在加载时就编译一次确认它至少是个合法正则。
  const risk = parsed.data.risk;
  if (risk) {
    try {
      new RegExp(risk.riskPattern);
    } catch (error) {
      problems.push(
        `risk.riskPattern：不是合法的正则源码（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
  }
  if (problems.length > 0) {
    throw new AppError(
      'KNOWLEDGE_PACK_INVALID',
      `站点知识包里的定位声明不可用：${problems.join('；')}`,
      'platform.contract',
      {
        problems,
      },
    );
  }
  return parsed.data;
}

/** 一次 JD 搜索的输入条件。 */
export type JobSearchCriteria = {
  /** 关键词（职位名、技能名） */
  keyword: string;
  /** 城市名；省略表示用平台的默认定位 */
  city?: string;
  /** 经验要求（如「3-5年」）；省略表示不限。列表页把它当筛选条件而不是事后过滤（spec 2.3-01） */
  experience?: string;
  /** 本次最多取回几条（节奏与额度都在编排侧：`outbound.throttle` 与 `entitlement.gate`，知识包不声明） */
  limit?: number;
};

/** 列表页上的一条 JD 摘要。 */
export type JobSummary = {
  platform: string;
  /** 平台侧的岗位标识；没有就用详情页地址派生，保证同一岗位在库里只有一行 */
  jobId: string;
  title: string;
  company: string;
  /** 薪资原文（「15-25K·14薪」），归一化留给调用方，不在这里丢信息 */
  salaryText: string;
  city: string;
  /** 经验要求原文（「3-5年」「经验不限」） */
  experience: string;
  /** 学历要求原文（「本科」「学历不限」） */
  education: string;
  detailUrl: string;
  capturedAt: number;
};

/** 详情页读出的岗位详情。 */
export type JobDetail = {
  summary: JobSummary;
  description: string;
  requirements: string[];
  /** 发布时间原文（「3 天前」「刚刚发布」），归一化后另存 */
  postedText: string;
};

/** 一次外发（打招呼 / 发简历）的结局。 */
export type OutboundResult = {
  /** 页面是否真的把动作做完（回读到成功态才算 true） */
  sent: boolean;
  /** 失败原因或风控提示；`sent` 为 true 时说明是哪一步确认的 */
  reason: string;
  /** 计量凭证：外发必经 `entitlement.gate`，回执里带回本次扣的额度键 */
  ledgerKey: string | null;
};

/** 会话里读到的一条回复。 */
export type ReplyMessage = {
  platform: string;
  jobId: string;
  /** 发送方角色：招聘者或求职者自己 */
  from: 'recruiter' | 'self';
  text: string;
  /** 读到这行的时刻（毫秒）：页面通常不给精确时间，落库用它而不是猜一个 */
  at: number;
  /**
   * 页面自带的稳定标识（`chat.messageIdAttribute` 读出来的属性值）。
   *
   * 它是 2.5-07 去重的唯一依据：真实平台不给游标，app 每次都是全量读可见的消息，
   * 只有这个 id 能区分「同一条又看见一次」与「对方又发了一条」。页面上没带就为 null
   * （那种行每次都会重新插入，所以知识包必须把属性名配对）。
   */
  externalId: string | null;
};

/**
 * 平台适配器契约：五个动作 + 两个列表页原语 + 一份自我声明 + 一份风控判据。
 *
 * 契约里**没有任何选择器**，也没有 `webContents`：适配器只会说「我要点 `greetButton`」，
 * 具体在页面哪个位置、用哪条通道，全由 `browser.locate` / `browser.act` 决定（plan §3 规则 3）。
 *
 * 为什么把 `openSearch` / `readListing` 也放进契约（而不是只留 `search`）：滚动加载的**编排**在
 * `jd.capture`（要按目标条数与「无新内容」判定停止，还要发进度事件），而「怎么打开搜索页」「一屏
 * 卡片怎么读成摘要」是站点知识，只能留在适配器里。拆开之后 `search` 仍是「一次调用拿到列表」的
 * 简单动作（工作流节点用它），`jd.capture` 用细粒度那两个。
 */
export interface PlatformAdapter {
  /** 平台自我声明（界面与 `platform.registry.list` 都读这份） */
  readonly meta: PlatformMetaView;
  /**
   * 风控页的文字判据（来自知识包的 `risk` 段）；缺段为 null，表示这个平台只按 HTTP 状态判风控。
   *
   * 为什么挂在适配器上而不是让 `browser.risk` 直接读知识包 JSON：风控判据是「这个平台长什么样」
   * 的一部分，取用路径必须和定位声明一样经过适配器这一层，否则内核侧又要自己找一份 JSON 读
   * （AGENTS.md §2.5 的第二套知识来源）。
   */
  readonly risk: { pattern: string } | null;
  /**
   * 把浏览器带到条件对应的搜索结果页（不读列表，翻页/滚动由调用方驱动）。
   * @param criteria 搜索条件；`keyword` 为空时结构化失败而不是打开默认页
   * @returns 无返回值：成功即表示搜索页已加载完成
   */
  openSearch(criteria: JobSearchCriteria): Promise<void>;
  /**
   * 读**当前**列表页上已渲染的卡片，按页面顺序返回摘要。
   *
   * 重复调用是预期用法（滚动加载后读新一屏），因此实现必须对「同一岗位读到两次」去重。
   * @returns 摘要列表；本屏一张卡都没读到是空数组，不是错误
   */
  readListing(): Promise<JobSummary[]>;
  /**
   * 按条件搜索岗位列表。
   * @param criteria 搜索条件
   * @returns 摘要列表，顺序即页面呈现顺序
   */
  search(criteria: JobSearchCriteria): Promise<JobSummary[]>;
  /**
   * 读取一个岗位的详情。
   * @param jobId 平台侧岗位标识
   * @returns 详情；页面结构读不出时以结构化错误失败，不返回半空对象
   */
  detail(jobId: string): Promise<JobDetail>;
  /**
   * 打招呼 / 发送一段话术（外发动作，必经额度闸门）。
   * @param jobId 目标岗位
   * @param text 话术正文
   * @returns 外发结局
   */
  chat(jobId: string, text: string): Promise<OutboundResult>;
  /**
   * 发送简历附件（外发动作，必经额度闸门——但闸门在编排层，适配器一次都不进）。
   * @param jobId 目标岗位
   * @param attachment 编排层已校验并算好 hash 的简历文件；传结构而不是只传路径，
   *        是为了让回读侧能直接比对「塞进控件的就是这几个字节」，不必再算一次（plan §13.3 第 1 条 / §2.2）
   * @returns 外发结局；目标已下架时抛 `DELIVER_TARGET_OFFLINE` 而不是回 `sent:false`（两者界面处置不同，spec 2.6-07）
   */
  sendResume(jobId: string, attachment: ResumeAttachment): Promise<OutboundResult>;
  /**
   * 读取会话里的新回复。
   * @param jobId 目标岗位
   * @returns 按时间升序的回复列表
   */
  readReplies(jobId: string): Promise<ReplyMessage[]>;
}
