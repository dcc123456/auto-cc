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

/**
 * 一条候选在**真站点上**的取证凭据（P8 8.1-02）。
 *
 * 为什么要把证据写进数据而不是写在注释里：`docs/plans/02-browser-automation/plan.md:1036` 禁止发布
 * 未实测的选择器，而注释没人读、也没人机检。写成字段之后「这条定位录过证据没有」变成装载期就能判的事，
 * 也能让 `packStatus:'shipped'`（真要发给用户上线的那一份）在缺证据时直接挂不上线。
 */
const locatorEvidenceSchema = z.strictObject({
  /** 证据文件的仓库内相对路径（`docs/acceptance/08-real-platform-driving/8.0-03-…txt`） */
  ref: z.string().min(1),
  /** 取证时那一屏的地址（同一个 class 在不同页面上含义不同，只留选择器不够） */
  url: z.string().min(1),
  /** 取证时刻（毫秒）；改版检测与「证据多久没更新了」按它排 */
  verifiedAt: z.number().int().nonnegative(),
  /**
   * 当时该条件在页面上命中几个元素（1 是唯一寻址，>1 说明要靠更小的子节点）。
   *
   * **没数过就省略**：在场取证的窗口里有些选择器只记了「在页面上存在、形状如何」，没逐条数过命中数
   * （证据 8.0-04 / 8.0-05 第四节）。补一个猜出来的数字比留空更糟——这个字段的用途是防猜测，
   * 它自己不能是猜的。省略时外发通道照常按 `unverified` 那条纪律走，与命中数无关。
   */
  hits: z.number().int().nonnegative().optional(),
});

/** 定位声明的线格式：与 `shared` 的 `LocateSpec` 同构，用于校验外部 JSON（知识包是不可信输入）。 */
const locateCandidateSchema = z.strictObject({
  strategy: z.enum(['testId', 'id', 'name', 'role', 'text', 'css', 'xpath', 'fingerprint']),
  value: z.string().min(1).optional(),
  attribute: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  exact: z.boolean().optional(),
  /** 这条候选的在场取证凭据；与 `unverified` 二者必居其一（`packStatus:'shipped'` 时强制） */
  evidence: locatorEvidenceSchema.optional(),
  /**
   * 显式声明「这条候选没在目标站点上实测过」，而不是靠一段【未实测】的注释表达同样的意思。
   *
   * 它是有语义的：外发通道（打招呼 / 投递）遇到它就直接以 `LOCATOR_UNVERIFIED` 失败，一个动作都不发
   * （8.1-04）；抓取与读取通道仍然会试它——读错一条只是少一条数据，点错一下撤不回来。
   */
  unverified: z.boolean().optional(),
});

export const locateSpecSchema = z.strictObject({
  description: z.string().min(1),
  cardinality: z.enum(['single', 'many']),
  candidates: z.array(locateCandidateSchema).min(1),
  /** 注入类定位（如隐藏的 `input[type=file]`）设 false，见 `LocateSpec.requireActionable`。 */
  requireActionable: z.boolean().optional(),
  /** 通道归属，决定适用哪一档最低可用分（见 `LocateSpec.effect` 与 P8 裁定⑤）。 */
  effect: z.enum(['read', 'outbound']).optional(),
});

/** 一个知识包「允许可导航到」的源：必须是完整 origin（协议 + 主机 + 端口），不许带路径。 */
const originSchema = z
  .string()
  .min(1)
  .refine(
    (value) => /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+$/i.test(value),
    'origin 不许带路径、查询或锚（形如 https://example.com）',
  );

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
  /**
   * 经验筛选参数名；**站点没有这个维度时省略**（P8 8.0-03：真 BOSS 搜索表单上取证到的只有
   * `query` / `city` / `industry` / `position` 四项，没有一个"经验"参数名）。
   *
   * 这条从必填改成可选，是为了让"没取证到"在数据里看得出来：省略时适配器不带这个参数，
   * 而界面据 `null` 报"本次未按经验过滤"，比拿一个猜出来的参数名去真站点上撞要诚实。
   */
  experience: z.string().min(1).optional(),
});

/**
 * 城市名 → 站点城市码（P8 8.3）。
 *
 * 为什么需要这张表：界面上那一栏收的是人话（占位符写着「城市，如『上海』」），
 * 而真 BOSS 的 `city` 参数要的是**城市码**（`101020100`，证据 8.0-03 第一节：那一枚是页面自己
 * 写在 `input[type=hidden].city-code` 里的）。原样把人话塞进 URL，站点不会报错，它会**忽略这个参数**
 * 并按定位城市出结果——于是"筛了上海"是一句谎话，而这正是本项目最贵的一类缺陷（看起来通了）。
 *
 * 键的写法刻意用 `z.record(z.string(), cityCodeSchema)` 而不是枚举城市名：城市名是站点知识，
 * 每登记一家平台就多一份，硬码进类型等于把知识搬回代码里（AGENTS.md §2.7 的反面）。
 * 值的形状按实测的码位收窄（6～9 位数字），填不进猜得出来的东西。
 */
const cityCodeSchema = z.string().regex(/^\d{6,9}$/, '城市码是站点侧的数字码（真 BOSS 是 9 位，如 101020100）');
const searchCitiesSchema = z.record(z.string().min(1), cityCodeSchema);

/** 站点知识包：平台自己声明的「页面长什么样、动作怎么打、节奏怎么控」。 */
export const knowledgePackSchema = z.strictObject({
  platform: z.string().regex(/^[a-z][a-z0-9-]*$/, '平台标识要用小写字母开头的短名'),
  displayName: z.string().min(1),
  startUrl: z.url(),
  /**
   * 包的状态（P8 8.1-02）：`shipped` 表示这份包是要随 app 发给用户、在真实站点上动手的，
   * 于是每条定位候选必须**要么带在场取证凭据、要么显式 `unverified`**；`draft` 不查这一条
   * （本地仿站那份的证据来自历次自动化验收，形状与真站点无关，硬要求它带 verifiedAt 只会逼出假证据）。
   *
   * 默认 `draft` 是刻意的：新增一份包的人默认落在「不上线」这一档，要上线必须写出来。
   */
  packStatus: z.enum(['draft', 'shipped']).default('draft'),
  /**
   * 这个平台允许导航到的源集合（P8 8.1-01 / 8.1-05：导航许可的名单来源）。
   *
   * 必须包含 `startUrl` 的 origin；真站点的登录页、会话页常常与起始页不同源，
   * 只按 startUrl 折 origin 会把正常工作流挡在门外，所以这份名单由平台自己声明。
   */
  origins: z.array(originSchema).min(1),
  capabilities: z.array(z.enum(['search', 'detail', 'chat', 'sendResume', 'readReplies'])).min(1),

  /** 语义名 → 定位声明。适配器只按语义名取用，源码里不出现任何选择器。 */
  locators: z.record(z.string().min(1), locateSpecSchema),
  /** 抓取声明（2.3）：列表与详情各一处「容器 + 字段」。 */
  capture: z.strictObject({
    list: captureSectionSchema,
    detail: captureSectionSchema,
  }),
  /** 搜索 URL 的参数名与入口路径（2.3-01 / P8 8.0-03）。拼 URL 的代码是通用的，参数名是站点知识。 */
  search: z.strictObject({
    /**
     * 搜索页的路径（按 `startUrl` 折算）；省略就用 `startUrl` 自己的路径。
     *
     * 真 BOSS 的搜索表单 action 是 `/web/geek/jobs`，而 `startUrl` 是站点根（证据 8.0-03 第一节）——
     * 没有这个键，拼出来的搜索地址会落在首页上，参数被站点整个忽略，表现为"搜了但列表还是默认岗位"。
     */
    entryPath: z.string().min(1).optional(),
    params: searchParamsSchema,
    /** 城市名 → 城市码；**缺席即「这家平台还没登记城市码表」**，此时 `resolveCityParam` 原样传值（见该函数）。 */
    cities: searchCitiesSchema.default({}),
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
       * 会话列表里「一行 = 一个联系人」的定位名（spec 8.4-05，证据 8.4-04 第一节）。
       *
       * 与下面那只成对出现，且只在 `targetParam` 缺席时才是必需的：真 BOSS 的会话页不给可直接拼的
       * 地址（`/web/geek/chat` 后面挂什么都没用），未选中会话时输入框根本不挂载，
       * 所以「先选中哪一行」是打招呼的前置，不是可选优化。
       */
      conversationRow: z.string().min(1).optional(),
      /**
       * 会话行上**用于认出目标**的那个小节点的定位名（真 BOSS 实测是公司名那一格，证据 8.4-04 第二节）。
       *
       * 必须是小节点而不是整行：整行的中心被行右侧的操作图盖住，且行本身是虚拟列表的重渲染节点，
       * 按整行点会得到 `WAIT_TIMEOUT` 或点错行（同一条实测负结论记在 8.0-05 第四节）。
       */
      conversationRowLabel: z.string().min(1).optional(),
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
      /**
       * 消息项上区分方向的属性名，与 `inboundValue` 同现（本地仿站是 `data-direction="inbound"`）。
       *
       * 真站点常常**没有**方向属性——方向是挂在 class token 上（P8 8.0-05 实测：BOSS 的对方消息项带
       * `item-friend` 这个类名，属性上一个方向标记都没有）。那种站点填 `inboundClassToken`，
       * 两个键都没有就在 `parseKnowledgePack` 判包不合法：没有方向的判据就把整条会话读成"都是对方发的"，
       * 那是假证据而不是缺数据。
       */
      directionAttribute: z.string().min(1).optional(),
      /** `directionAttribute` 里表示「对方发的」那个值，其余值都算自己发的 */
      inboundValue: z.string().min(1).optional(),
      /**
       * 「对方发的」那条 class token（按空白切词整词比对，不是子串）。
       *
       * 与上面那一对互斥必居其一：`readReplies` 因此在两种页面形状上都只有一条「读容器属性 → 比对」的路径，
       * 而不是各写一遍判定（AGENTS.md §2.2）。
       */
      inboundClassToken: z.string().min(1).optional(),
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
 * 一条定位声明在校验后的形状。
 *
 * 它比 `shared` 的 `LocateSpec` 多出取证那几个键，所以适配器上的外发闸门要按这个类型读
 * （按 `LocateSpec` 读看不见 `unverified`，判定就静默失效了）。
 */
export type LocateDeclaration = z.output<typeof locateSpecSchema>;

/**
 * 取外发通道**可以用**的候选：把显式标了 `unverified` 的那几条剔掉。
 *
 * 为什么在这里筛而不是让 `browser.locate` 认这个字段：打分与自愈是内核的通用能力，
 * 它不该知道"知识包有没有取证过"这件事（那是平台侧的发布纪律，plan §3 规则 1）。
 * 筛完一条都不剩时由调用方抛 `LOCATOR_UNVERIFIED`（spec 8.1-04）。
 * @param spec 知识包里的定位声明（校验后的那份）
 * @returns 有取证凭据（或至少没自称未取证）的候选，声明顺序即优先级不变
 */
export function outboundCandidates(spec: LocateDeclaration): LocateDeclaration['candidates'] {
  return spec.candidates.filter((candidate) => candidate.unverified !== true);
}

/**
 * 把人话城市名换成站点城市码（P8 8.3）。
 *
 * 四条分支，每条都对应一种"不能含糊"的情形：
 * 1. 空值 ⇒ `undefined`，调用方不带这个参数（缺省城市是合法搜索，不是错误）；
 * 2. 纯数字 ⇒ 原样传——**已经是码**，再查一遍表只会把「我知道码但表里还没有」这条路堵死
 *    （8.3 这一窗只有上海一枚是双证坐实的，其余城市要在搜索页的筛选器上现读现补，那之前人得能用）；
 * 3. 表里查得到 ⇒ 交出差额里那一枚码；
 * 4. 表**空** ⇒ 原样传。这条是刻意的：未标定不等于标定失败，仿站那份包本来就没有城市码表，
 *    而它要保住 2.3 那批已验收行为一字不变（§7.2 的自动化面）。
 *    真正的兜底在下一格：表**非空**却查不到，说明这家平台已经登记过城市口径，
 *    此时把人话塞进 URL 就是明知故犯——站点会静默忽略参数、按定位城市出结果，
 *    "筛了上海"变成一句谎话。所以它必须以结构化失败停下，而不是继续发这一发。
 * @param city 界面上那一栏的原文（可空）
 * @param cities 该平台的 `search.cities` 表（缺席即空表）
 * @param platform 平台标识，只用于报错文案与 `details`
 * @returns 要写进 URL 的城市参数值；`undefined` 表示不带这个参数
 * @throws `INVALID_ARGUMENT`（表非空但查不到这个名字，`details.known` 给出可填的名字清单）
 */
export function resolveCityParam(
  city: string | undefined,
  cities: KnowledgePack['search']['cities'],
  platform: string,
): string | undefined {
  const trimmed = city?.trim() ?? '';
  if (trimmed === '') return undefined;
  if (/^\d+$/.test(trimmed)) return trimmed;
  const knownNames = Object.keys(cities);
  if (knownNames.length === 0) return trimmed;
  const code = cities[trimmed];
  if (code === undefined) {
    throw new AppError('INVALID_ARGUMENT', `平台 ${platform} 的城市码表里没有「${trimmed}」`, 'browser', {
      city: trimmed,
      known: knownNames.sort(),
    });
  }
  return code;
}

/**
 * 校验一份知识包：结构过 zod，再逐条跑定位声明的语义校验，然后查抓取/会话/投递引用的定位名是否存在，
 * 然后查上线包取证（P8 8.1-02）、方向判据、外发通道的档位归属与许可名单（8.1-01/05），
 * 最后编译一次风控正则。
 * @param raw 从 JSON 读出来的未知值（外部数据，一律视为不可信）
 * @returns 校验通过的知识包
 * @throws 结构、声明、引用、取证或许可非法时 `KNOWLEDGE_PACK_INVALID`，`details.problems` 逐条指出是哪一层的哪一条
 */
export function parseKnowledgePack(raw: unknown): KnowledgePack {
  const parsed = knowledgePackSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('KNOWLEDGE_PACK_INVALID', '站点知识包结构不合法', 'platform.contract', {
      problems: parsed.error.issues.map((issue) => `${issue.path.join('.')}：${issue.message}`),
    });
  }
  const problems: string[] = [];
  const shipped = parsed.data.packStatus === 'shipped';
  for (const [name, spec] of Object.entries(parsed.data.locators)) {
    for (const problem of validateSpec(spec)) problems.push(`${name}：${problem}`);
    // 上线包逐条查证据：没取证过的候选不许混在真要动手的那一份包里而不留记号。
    // 「有证据」与「显式 unverified」必须有一个，两者都没有就是「写的时候没看过页面」。
    if (shipped) {
      spec.candidates.forEach((candidate, index) => {
        if (candidate.evidence || candidate.unverified === true) return;
        problems.push(
          `${name} 候选 ${String(index)}（${candidate.strategy}）：上线包里的每条候选要么带 evidence，要么显式 unverified:true`,
        );
      });
      // 整条定位的所有候选都标 unverified 是**合法**数据（那个通道的页面知识还没录到），装载期不许
      // 因此拒整个包——那会让一处没测通的通道把整站抓取一起带走。停手长在外发通道自己那一侧：
      // `LOCATOR_UNVERIFIED`（spec 8.1-04）。
    }
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
  // 会话页的各处定位名：拼错的名字必须在加载时发现，而不是等打招呼时点到一个不存在的按钮。
  const chat = parsed.data.chat;
  if (chat) {
    // 选行那两只只在声明了才查——它们是可选形状（仿站靠 URL 参数切会话，根本没有列表行）。
    const chatLocatorKeys: [string, string][] = [
      ['input', chat.input],
      ['sendButton', chat.sendButton],
      ['statusLine', chat.statusLine],
      ['messageItem', chat.messageItem],
      ['messageBody', chat.messageBody],
    ];
    if (chat.conversationRow) chatLocatorKeys.push(['conversationRow', chat.conversationRow]);
    if (chat.conversationRowLabel) chatLocatorKeys.push(['conversationRowLabel', chat.conversationRowLabel]);
    for (const [key, name] of chatLocatorKeys) {
      if (!locatorNames.has(name)) problems.push(`chat.${key}：引用了不存在的定位名「${name}」`);
    }
    // 成对规则：只声明一只选不出目标（有行没标签=不知道认哪个字，有标签没行=等不到列表长出来）。
    if (Boolean(chat.conversationRow) !== Boolean(chat.conversationRowLabel)) {
      problems.push('chat：conversationRow 与 conversationRowLabel 必须成对出现（选行这一步两只都要用）');
    }
    // 「按 URL 切会话」与「按列表行选会话」必须至少有一种，否则 `chat` / `readReplies` 只能对着
    // **当时屏幕上恰好选中的那条**动手——那既是发错人，也是把别人的消息记成调用方要的那个 jobId。
    if (!chat.targetParam && !chat.conversationRow) {
      problems.push(
        'chat：既没有 targetParam（URL 能直接定位会话）也没有 conversationRow/conversationRowLabel（按列表行选中），无法确定动作要落在哪条会话上',
      );
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
  // 方向判据（2026-10-08 在场补录）：真站点的消息方向是 class token，仿站的是属性，两种形状都必须能表达，
  // 但**一种都不许缺**——没有方向判据时 `readReplies` 会把整条会话读成「都是对方发的」，那是假证据。
  if (chat) {
    const hasAttribute = Boolean(chat.directionAttribute && chat.inboundValue);
    const hasToken = Boolean(chat.inboundClassToken);
    if (!hasAttribute && !hasToken) {
      problems.push('chat：方向判据缺失（必须给 directionAttribute + inboundValue，或 inboundClassToken）');
    } else if (hasAttribute && hasToken) {
      problems.push('chat：directionAttribute 与 inboundClassToken 只能填一种（两种方向形状同时声明无从判定用哪个）');
    } else if (hasAttribute && (!chat.directionAttribute || !chat.inboundValue)) {
      problems.push('chat：directionAttribute 与 inboundValue 必须成对出现');
    }
  }
  // 裁定⑤（2026-10-08）：最低可用分按通道分档，读取/抓取降档、外发保持严的那一档。
  // 于是「外发用哪几条定位」必须在装载期就锁死通道归属：谁把发送键标成 read 想去拿低阈值，这里就拦下。
  //
  // 名单里**只有真的会动手的那三只**（输入框、发送键、上传控件）。状态行不在名单里是刻意的：
  // 它只被读、不被点，而真站点上它常常只有 class 可选（真 BOSS 是 `i.message-status.status-delivery`，
  // 35 分）——把它钉在 70 分档等于「真实站点永远等不到状态行变化」，那条外发反而变成必失败。
  // 读错状态行的代价由另一半判据兜着：`sent` 要求回读文本**含**成功样式，不是「读到了东西」。
  const outboundNames = new Set(
    [
      ...(chat ? [chat.input, chat.sendButton] : []),
      ...(deliver ? [deliver.uploadInput, deliver.sendButton] : []),
    ].filter((name): name is string => Boolean(name)),
  );
  for (const name of outboundNames) {
    const spec = parsed.data.locators[name];
    if (spec?.effect === 'read') {
      problems.push(`${name}：外发通道引用的定位不许声明 effect:'read'（那是去够读档的低阈值，与裁定⑤ 相反）`);
    }
  }
  // 许可名单的来源就是这份声明（8.1-01 / 8.1-05）：startUrl 的 origin 必须在里面，
  // 否则适配器第一个导航动作就会被自己的包拒掉。
  const startOrigin = new URL(parsed.data.startUrl).origin;
  if (!parsed.data.origins.includes(startOrigin)) {
    problems.push(`origins：不含 startUrl 的源「${startOrigin}」（许可名单必须覆盖自己的起始页）`);
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
