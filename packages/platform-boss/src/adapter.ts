/**
 * BOSS 平台适配器（spec 2.2-06 → 2.3 的 `search` / `detail` → 2.5 的 `chat` / `readReplies` → 2.6 的 `sendResume`）。
 *
 * 这里**不出现任何选择器**：页面结构一律经 `@auto-cc/plugin-browser` 的抓取声明按语义名取用，
 * 于是 2.2-08 的机检（`scripts/check-knowledge-pack.ts`）能把「选择器只许待在知识包里」钉住。
 * 同理，URL 上的查询参数名也在知识包里（`pack.search.params` 与 `pack.chat.targetParam`）——
 * 「BOSS 用哪个参数名搜城市」「会话页用哪个参数名切换聊天对象」是站点知识，不是我们的代码知识。
 *
 * 抓取是只读的；`chat` 是外发，但本文件**仍然一次 `entitlement.gate` 都不进**：闸门与频控属于
 * 编排层（2.5-e 的 `outbound.greet`），适配器只管「把这段文字打进这个会话并按页面回读判定结果」。
 * 把闸门写在这里会让「从界面点一次发送」与「从工作流跑一次发送」走两条不同的计量路（AGENTS.md §7.3）。
 */
import { AppError, type GreetTarget, type ResumeAttachment } from '@auto-cc/core';
import type {
  ExtractFieldReading,
  ExtractRequest,
  ExtractResultView,
  HitAddress,
  KernelPageSnapshotView,
  LocateSpec,
  PlatformMetaView,
} from '@auto-cc/shared';
import {
  outboundCandidates,
  resolveCityParam,
  type JobDetail,
  type JobSearchCriteria,
  type JobSummary,
  type KnowledgePack,
  type OutboundResult,
  type PlatformAdapter,
  type ReplyMessage,
} from '@auto-cc/plugin-browser';
import { cleanText, splitRequirements } from './normalize.js';

/**
 * 适配器用到的那只「读页面的手」（spec 2.3-01）。
 *
 * 只取三个方法而不是整个 `browser.page`：适配器不该有能力改视图、导航到许可外的地址，
 * 类型上收口比注释里叮嘱可靠（AGENTS.md §4.1）。测试递一只假手就能跑完整条抓取，不需要 Electron。
 */
export type BossPageHand = {
  /** 导航到同源地址（含搜索页与详情页） */
  navigate(url: string): Promise<KernelPageSnapshotView>;
  /** 一次「容器 × 字段」批量抽取 */
  extract(request: ExtractRequest): Promise<ExtractResultView>;
};

/**
 * 适配器用到的那只「动页面的手」（spec 2.5-06 / 2.6-04）。
 *
 * 只取 `type` / `click` / `waitFor` / `upload` 四个方法：敲字、点击、等待与文件注入的通道选择
 * （CDP 还是 DOM、事件是否受信）全由 `browser.act` 决定，适配器一侧不出现 `webContents`，也不猜坐标（plan §3 规则 3）。
 */
export type BossActionHand = {
  /** 往定位声明指向的控件里写文本，回读页面里的当前值 */
  type(spec: LocateSpec, text: string): Promise<ActReadback>;
  /** 点击定位声明指向的元素；带 `target` 时点的是那一格里第 `hitIndex` 个命中（spec 8.4-01） */
  click(spec: LocateSpec, target?: HitAddress): Promise<ActReadback>;
  /**
   * 只等不动手：超时是结局（`status:'timeout'`），不是异常。
   *
   * `appear` 那一支是 P8 8.3 抽真空现场逼出来的：`browser.page.navigate` 在 `load` 事件就返回，
   * 而真 BOSS 的卡片是 load 之后再发一支 XHR 才长出来的，所以抽取会拿到 `containers: 0`
   * （读数 `8.3-01-real-search.txt` 第二节）。等的就是抽取要用的那条容器声明，
   * 判据是候选选择器在页面上出现没有（`locator-script.ts` 的 `appear` 分支不做打分），
   * 所以读档的低阈值与歧义罚分都不会把"已经长出来了"判成"没长出来"。
   */
  waitFor(predicate: { kind: 'appear' | 'textChanges'; spec: LocateSpec }): Promise<ActReadback>;
  /**
   * 把一份本地文件注入 `input[type=file]`（隐藏控件的声明必须带 `requireActionable: false`）。
   * `valueAfter` 是**那个 input 自己报上来的** `files[0].name`，不是请求路径的文件名——投递的回读判据就取它。
   */
  upload(spec: LocateSpec, filePath: string): Promise<ActReadback>;
};

/** 一次动作的回读：只取适配器判据需要的三个字段（`ActResultView` 的窄化）。 */
export type ActReadback = {
  status: 'done' | 'timeout';
  waitedMs: number;
  valueAfter: string | null;
};

/** 一行的字段读数按名索引，省得每处都 `find`。 */
type FieldReadings = Map<string, ExtractFieldReading>;

/**
 * 把抽取行里的字段读数按 `name` 收成一张表。
 * @param fields 一行里的全部字段读数
 * @returns 字段名 → 读数（同名字段后出现的覆盖前者；知识包里的字段名本来就该唯一）
 */
function fieldsByName(fields: ExtractFieldReading[]): FieldReadings {
  const map: FieldReadings = new Map();
  for (const field of fields) map.set(field.name, field);
  return map;
}

/** 取一个已命中字段的正文；未命中回空串。 */
function textOf(row: FieldReadings, name: string): string {
  const field = row.get(name);
  return field && field.matched ? cleanText(field.text) : '';
}

/** 取一个已命中字段的属性值；未命中回空串。 */
function attributeOf(row: FieldReadings, name: string): string {
  const field = row.get(name);
  return field && field.matched ? (field.attribute ?? '').trim() : '';
}

/**
 * 把卡片上的链接解析成绝对详情页地址，并取出平台侧岗位标识。
 *
 * 站点给的是相对 href（`/boss/detail?jobId=1003`），必须按**该卡片所在帧的地址**折算——
 * 用顶层地址折会在 iframe 站点上拼出错误来源（spec 2.3-02 的来源 URL 就是这么定的）。
 * @param href 卡片里读到的链接原文
 * @param baseUrl 那一行的帧地址（抽取行的 `frameUrl`）
 * @returns 绝对地址与 jobId（依次取 `jobId` 查询参数 → 路径最后一段 → 绝对地址本身）；
 * href 为空、协议不是 http(s) 或拼不出地址时为 null（这行不算岗位）
 */
export function resolveDetailUrl(href: string, baseUrl: string): { url: string; jobId: string } | null {
  if (!href.trim()) return null;
  try {
    const absolute = new URL(href, baseUrl || undefined);
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return null;
    const jobId =
      absolute.searchParams.get('jobId') ?? absolute.pathname.split('/').filter(Boolean).pop() ?? absolute.href;
    return { url: absolute.href, jobId };
  } catch {
    return null;
  }
}

/**
 * 用一份**已校验**的知识包造出 BOSS 适配器。
 *
 * 为什么是工厂而不是类：适配器的输入就是「这份知识 + 那只会读页面的手 + 那只会动手的手」，
 * 2.6 换一版知识包就换一个实例，不需要子类；而 `platform.registry` 要的是「一个实现了契约的对象」。
 * @param pack 经 `parseKnowledgePack` 校验过的知识包（结构已由 zod 保证，这里不再判空）
 * @param page 页面通道（见 `BossPageHand`）
 * @param act 动作通道（见 `BossActionHand`）；只有外发一侧（`chat` / `sendResume`）用它，抓取一行都不碰
 * @returns 契约完整、六个动作全部有真实现的平台适配器
 */
export function createBossAdapter(pack: KnowledgePack, page: BossPageHand, act: BossActionHand): PlatformAdapter {
  const meta: PlatformMetaView = {
    id: pack.platform,
    displayName: pack.displayName,
    startUrl: pack.startUrl,
    // 导航许可的唯一来源（spec 8.1-05）：知识包声明的源集合，不是 startUrl 那一行的源。
    origins: [...pack.origins],
    // 拷一份：登记表面向渲染层，不能让界面读数跟着知识包对象的后续修改漂移。
    capabilities: [...pack.capabilities],
  };

  /**
   * 最近一次读列表见过的岗位（jobId → 摘要）。
   *
   * `detail(jobId)` 需要详情页地址，而契约只给了 jobId：这份缓存就是它的唯一来源。
   * 没见过这个 id 时报错而不是猜一个 URL——猜出来的地址会把别的岗位写进这条记录。
   */
  const seen = new Map<string, JobSummary>();

  /**
   * 按语义名取定位声明。
   *
   * `parseKnowledgePack` 已经逐条核对过 `capture` 里的每个引用名都在 `locators` 里存在，所以这里
   * 只把 `noUncheckedIndexedAccess` 推出来的 `| undefined` 收掉：兜底成「现造一条定位声明」只会把
   * 「知识包写错了」变成「页面读不到」，那种错误在界面上比直接崩溃更难查。
   * @param name 语义名（容器名或字段引用的定位名）
   * @returns 该名的定位声明
   */
  const locatorFor = (name: string): LocateSpec => pack.locators[name]!;

  /**
   * 取**外发**通道要用的定位声明：把知识包里显式标成「未取证」的候选摘掉，一条不剩就当场失败（spec 8.1-04）。
   *
   * 为什么只拦外发：打招呼与投递是撤不回来的动作，拿一条没在真站点上录过证据的候选去点，
   * 点中的可能是页面上任何一个东西；而抓取/读状态行没有副作用，未取证的候选可以试，
   * 试不出来如实回「读不到」。这条分界与 `LocateSpec.effect` 的分档是同一件事的两个侧面。
   * @param name 定位语义名（会话页输入框 / 发送键 / 上传控件 / 投递确认键）
   * @returns 只含已取证候选的定位声明
   * @throws 全部候选都标了 `unverified` 时 `LOCATOR_UNVERIFIED`——要的是补取证，不是重试，
   *         所以它必须是独立错误码，不能混进 `LOCATE_FAILED`（后者意味着「到页面上试过没打过线」）
   */
  const outboundLocator = (name: string): LocateSpec => {
    const spec = locatorFor(name);
    const verified = outboundCandidates(spec);
    if (verified.length === 0) {
      throw new AppError(
        'LOCATOR_UNVERIFIED',
        `定位「${name}」没有一条已取证的候选，外发通道不试未录过真站点证据的控件`,
        'platform.boss',
        { platform: pack.platform, locator: name },
      );
    }
    return { ...spec, candidates: verified };
  };

  /**
   * 按知识包的抓取声明拼抽取请求（选择器仍然只来自数据）。
   * @param section 列表还是详情
   * @returns `browser.page.extract` 的请求体
   */
  const requestFor = (section: 'list' | 'detail'): ExtractRequest => {
    const part = pack.capture[section];
    return {
      container: locatorFor(part.container),
      fields: part.fields.map((field) => ({
        name: field.name,
        candidates: locatorFor(field.locator).candidates,
        ...(field.attribute ? { attribute: field.attribute } : {}),
        ...(field.required === undefined ? {} : { required: field.required }),
      })),
    };
  };

  /**
   * 拼搜索页地址：起始地址（或知识包登记的搜索入口路径）+ 那一站点的查询参数名。
   *
   * `entryPath` 这一支是 8.0-03 的读数逼出来的：真 BOSS 的搜索表单 action 是 `/web/geek/jobs`，
   * 而 `startUrl` 是站点根——只往根上拼参数，站点会整段忽略参数并把首页当结果页回，
   * 表现为「搜了，但列表还是默认岗位」这种最难查的失败。
   * @param criteria 搜索条件（关键词必填，城市与经验可省）
   * @returns 可直接导航的绝对地址
   */
  const searchUrl = (criteria: JobSearchCriteria): string => {
    const base = new URL(pack.startUrl);
    const target = pack.search.entryPath ? new URL(pack.search.entryPath, base.origin) : base;
    target.searchParams.set(pack.search.params.keyword, criteria.keyword);
    // 城市那一栏收的是人话，站点要的是码（P8 8.3）：换算与「查不到就停下」都归 `resolveCityParam`，
    // 这里不再原样塞值——原样塞会被站点静默忽略参数，"筛了上海"就成了谎话。
    const cityParam = resolveCityParam(criteria.city, pack.search.cities, pack.platform);
    if (cityParam !== undefined) target.searchParams.set(pack.search.params.city, cityParam);
    // 经验这一维不是每个站都有查询参数（真 BOSS 把它做成页面上的筛选控件，不在地址里，证据 8.0-03）：
    // 包里没登记参数名时，这一维就不进 URL，而不是编一个假的出来。
    if (criteria.experience && pack.search.params.experience) {
      target.searchParams.set(pack.search.params.experience, criteria.experience);
    }
    return target.href;
  };

  /**
   * 把抽取行拍成摘要列表。
   * @param result 一次列表抽取的读数
   * @returns 只包含「有标题且有详情页地址」的行；其余行不算岗位，直接不进列表
   */
  const toSummaries = (result: ExtractResultView): JobSummary[] => {
    const capturedAt = Date.now();
    const summaries: JobSummary[] = [];
    for (const row of result.rows) {
      const fields = fieldsByName(row.fields);
      const title = textOf(fields, 'title');
      const detail = resolveDetailUrl(attributeOf(fields, 'detailHref'), row.frameUrl);
      // 标题与详情页地址缺一个就不算「一条岗位」：幂等键正是这两样（spec 2.3-04）。
      if (!title || !detail) continue;
      const summary: JobSummary = {
        platform: pack.platform,
        jobId: detail.jobId,
        title,
        company: textOf(fields, 'company'),
        salaryText: textOf(fields, 'salary'),
        city: textOf(fields, 'city'),
        experience: textOf(fields, 'experience'),
        education: textOf(fields, 'education'),
        detailUrl: detail.url,
        capturedAt,
      };
      seen.set(summary.jobId, summary);
      summaries.push(summary);
    }
    return summaries;
  };

  /**
   * 抽一次之前先等容器长出来（P8 8.3-01）。
   *
   * 为什么不改成"多等一会儿"：等待上限由 `browser.act` 的配置说话（缺省 5000ms，页面上有 MutationObserver
   * 提前结束），把 `setTimeout` 写进适配器等于第二套节奏（AGENTS.md §2.7 禁止第二份同类基础设施，
   * 2.7-04 那条裁定过同一件事）。等不到也照样抽——抽取自己会回 `containers: 0`，
   * 编排层据此停并在结局里写 `no-new-content`，比在这里编一个"等到了"的假象诚实。
   * @param section 列表还是详情（等的就是那一段声明的容器定位）
   * @returns 等待结局，调用方不据此分支（判据始终在抽取读数那一侧）
   */
  const waitForContainers = async (section: 'list' | 'detail'): Promise<ActReadback> =>
    act.waitFor({ kind: 'appear', spec: locatorFor(pack.capture[section].container) });

  const readListing = async (): Promise<JobSummary[]> => {
    await waitForContainers('list');
    return toSummaries(await page.extract(requestFor('list')));
  };

  const detail = async (jobId: string): Promise<JobDetail> => {
    const summary = seen.get(jobId);
    if (!summary) {
      throw new AppError('INVALID_ARGUMENT', `没见过 jobId「${jobId}」，先跑一次搜索再读详情`, 'platform.boss', {
        jobId,
      });
    }
    await page.navigate(summary.detailUrl);
    // 详情页同样是异步长正文（列表页已经因此抽真空过一次，见 `waitForContainers`）。
    await waitForContainers('detail');
    const result = await page.extract(requestFor('detail'));
    // 详情页是单容器：命中多个容器（站点自己插的引导卡）时取第一个，其余不是这个岗位。
    const row = result.rows[0];
    if (!row) {
      throw new AppError('PAGE_SCRIPT_FAILED', '详情页没有读到任何容器，可能已被站点跳转或要求登录', 'platform.boss', {
        url: summary.detailUrl,
      });
    }
    const fields = fieldsByName(row.fields);
    const description = textOf(fields, 'description');
    if (!description) {
      throw new AppError('PAGE_SCRIPT_FAILED', '详情页读不到岗位职责正文', 'platform.boss', { url: summary.detailUrl });
    }
    return {
      summary,
      description,
      requirements: splitRequirements(textOf(fields, 'requirement')),
      postedText: textOf(fields, 'posted'),
    };
  };

  const openSearch = async (criteria: JobSearchCriteria): Promise<void> => {
    if (!criteria.keyword?.trim()) {
      throw new AppError('INVALID_ARGUMENT', '搜索必须给出关键词', 'platform.boss', { platform: pack.platform });
    }
    await page.navigate(searchUrl(criteria));
  };

  /**
   * 一处「可以用相对路径直接打开」的页面声明里最小的公共形状。
   *
   * `chat` 段与 `deliver` 段各自都带 `entryPath` / `targetParam` 两个键，而拼地址这件事与
   * 「这是会话页还是上传页」无关（AGENTS.md §2.2：同一逻辑出现第二次就抽公共层）。
   */
  type PageEntry = { entryPath?: string; targetParam?: string };

  /**
   * 取会话那一段站点知识（`chat` / `readReplies` 用到的全部页面事实都在里面）。
   * @returns 知识包的 `chat` 段
   * @throws 缺段时 `KNOWLEDGE_PACK_INVALID`。`parseKnowledgePack` 已经把过「声明了 chat 能力就必须带 chat 段」，
   *         走到这里只可能是调用方自己塞了一份不含会话段的包——那种适配器不该假装会打招呼
   */
  const chatKnowledge = (): NonNullable<KnowledgePack['chat']> => {
    const knowledge = pack.chat;
    if (!knowledge) {
      throw new AppError(
        'KNOWLEDGE_PACK_INVALID',
        '知识包缺少 chat 段，会话页的输入框与状态行无从取用',
        'platform.boss',
        { platform: pack.platform },
      );
    }
    return knowledge;
  };

  /**
   * 取投递那一段站点知识（上传控件、确认按钮、状态行与两种文案都在里面）。
   * @returns 知识包的 `deliver` 段
   * @throws 缺段时 `KNOWLEDGE_PACK_INVALID`——与 `chatKnowledge` 同一条纪律：
   *         没有上传页知识就绝不拿猜出来的选择器去点页面（简历是外发，撤不回来）
   */
  const deliverKnowledge = (): NonNullable<KnowledgePack['deliver']> => {
    const knowledge = pack.deliver;
    if (!knowledge) {
      throw new AppError(
        'KNOWLEDGE_PACK_INVALID',
        '知识包缺少 deliver 段，上传页的文件控件与状态行无从取用',
        'platform.boss',
        { platform: pack.platform },
      );
    }
    return knowledge;
  };

  /**
   * 拼某个目标页面的地址。
   * @param entry 该段知识里的入口声明（`chat` 或 `deliver` 的 `entryPath` / `targetParam`）
   * @param jobId 目标岗位标识；**null 表示这次没有岗位坐标**（按会话列表行选中目标那一类），
   *               此时绝不把任何东西写进 `targetParam`——参数名是站点的，值却不是岗位，页面会静默停在错误的那条会话
   * @returns 绝对地址；知识包没声明 `entryPath` 时为 null，表示「当前页就是那页」
   *          （真实平台从岗位卡点进会话/上传，不给可直接拼的地址，那种站点由调用方先打开再动作）
   */
  const pageUrlFor = (entry: PageEntry, jobId: string | null): string | null => {
    if (!entry.entryPath) return null;
    const target = new URL(entry.entryPath, pack.startUrl);
    // 参数名是站点知识：换平台只改 `targetParam`，这一段代码不用动。
    if (entry.targetParam && jobId !== null) target.searchParams.set(entry.targetParam, jobId);
    return target.href;
  };

  /**
   * 回读发送状态行的文本——`sent` 的唯一依据。
   * @param statusLineName 状态行的定位名（会话页与上传页各用各的那一行）
   * @returns 状态行正文；一行都没读到是空串（调用方按「没读到成功样式」处理，绝不猜成成功）
   */
  const readStatusLine = async (statusLineName: string): Promise<string> => {
    const result = await page.extract({
      container: locatorFor(statusLineName),
      fields: [{ name: 'status', candidates: [], scope: 'self' }],
    });
    const reading = fieldsByName(result.rows[0]?.fields ?? []).get('status');
    return reading?.matched ? cleanText(reading.text) : '';
  };

  /**
   * 取「按会话列表行选中目标」那一双定位（行容器 + 页面上用来认目标的那一格）。
   * @returns 两个语义名
   * @throws 任一只缺失时 `KNOWLEDGE_PACK_INVALID`。`parseKnowledgePack` 已保证两者成对出现，
   *         所以走到这里只剩一种可能：这份包根本没声明按行选中的能力（仿站包就是这种，它有 `targetParam`），
   *         而那种站点不该被会话坐标寻址——静默默认值会把话发给页面上恰好选中的另一个人
   */
  const conversationLocators = (): { row: string; label: string } => {
    const knowledge = chatKnowledge();
    if (!knowledge.conversationRow || !knowledge.conversationRowLabel) {
      throw new AppError(
        'KNOWLEDGE_PACK_INVALID',
        '知识包没有声明 chat.conversationRow / chat.conversationRowLabel，这份包不能按会话坐标寻址',
        'platform.boss',
        { platform: pack.platform },
      );
    }
    return { row: knowledge.conversationRow, label: knowledge.conversationRowLabel };
  };

  /**
   * 在会话列表里选中目标联系人（spec 8.4-02，P8 路线 A 的前置：`chat` 与 `readReplies` 都以它为前置）。
   *
   * 三步都不可省：等行出现（列表是异步长出来的，与 8.3 那批卡片同一形态）→ 按声明的那一格读文本并**整串比对**
   * → 按命中序号点那一格。比对不中就多行同名时一律停下，不做"取第一条"这种猜测。
   * @param conversationTarget 目标标识（真 BOSS 是行上的公司名那一格，证据 8.4-04 第三节）
   * @returns 无返回值：选中成功就是"页面上现在停在这条会话上"，失败一律以结构化错误上浮
   * @throws 目标为空 `INVALID_ARGUMENT`；包没声明这一双定位 `KNOWLEDGE_PACK_INVALID`；
   *         标签声明有多条候选 `LOCATE_SPEC_INVALID`（多候选时抽取行的序号不等于任何一条的命中序号，
   *         按它点会点到别的候选身上，而这一格错 = 把话发给另一个人）；
   *         列表里认不出唯一目标 `CONVERSATION_TARGET_NOT_FOUND`（读到的行数与同名行数进 details）；
   *         点击时那一格的文本与读回来的对不上 `LOCATE_FAILED`（动作层在点之前再比一次）
   */
  const selectConversation = async (conversationTarget: string): Promise<void> => {
    const knowledge = chatKnowledge();
    if (!conversationTarget.trim()) {
      throw new AppError('INVALID_ARGUMENT', '按会话寻址必须给出目标联系人', 'platform.boss', {
        platform: pack.platform,
      });
    }
    const { row: rowName, label: labelName } = conversationLocators();
    const labelSpec = locatorFor(labelName);
    if (labelSpec.candidates.length !== 1) {
      throw new AppError(
        'LOCATE_SPEC_INVALID',
        `会话标签「${labelName}」有 ${String(labelSpec.candidates.length)} 条候选，抽取行的序号与命中的序号对不上，不该按序号点`,
        'platform.boss',
        { platform: pack.platform, locator: labelName },
      );
    }
    // 会话坐标这一路没有岗位，绝不能把联系人的名字写进 `targetParam`（那是给岗位用的）。
    const url = pageUrlFor(knowledge, null);
    if (url) await page.navigate(url);
    await act.waitFor({ kind: 'appear', spec: locatorFor(rowName) });
    const reading = await page.extract({
      container: labelSpec,
      fields: [
        // scope:self：读容器自身那一格的正文。整行的文本是「角标+时间+姓名+公司+职位+末句」的拼接，
        // 拿它比对目标会把同一家公司的不同联系人一起撞进来（证据 8.4-04 第一节）。
        { name: 'target', candidates: [], scope: 'self' },
      ],
    });
    const wanted = cleanText(conversationTarget);
    const hits = reading.rows.filter((row) => textOf(fieldsByName(row.fields), 'target') === wanted);
    // 命中必须**唯一**：行数不等于 1 时不点（0 行是认不出，>1 行是同一家公司的两个联系人，猜哪个
    // 都是把话发给另一个人）。
    const hit = hits.length === 1 ? hits[0] : undefined;
    if (!hit) {
      throw new AppError(
        'CONVERSATION_TARGET_NOT_FOUND',
        hits.length === 0
          ? `会话列表里没有「${conversationTarget}」这一条，不点也不读当前选中的那条`
          : `会话列表里有 ${String(hits.length)} 行都写着「${conversationTarget}」，认不出该选哪一条`,
        'platform.boss',
        {
          conversationTarget,
          matched: hits.length,
          rows: reading.rows.length,
          truncated: reading.truncated,
        },
      );
    }
    // 点的是那一格而不是整行：整行中心被右侧操作区盖住、且行本身是虚拟列表的重渲染节点，
    // 按整行点实测过 WAIT_TIMEOUT（证据 8.0-05 第四节）。`expectText` 把「读到的那一格」与
    // 「点下去的那一格」锁成同一格——两次寻址之间页面重排了就 LOCATE_FAILED 停下，不会点到邻居。
    await act.click(labelSpec, { candidateIndex: 0, hitIndex: hit.containerIndex, expectText: wanted });
  };

  /**
   * 把一段话术打进目标会话，并按**页面回读**判定有没有发出去（spec 2.5-06）。
   *
   * 三段判据缺一不可：输入框回读等于发出文本（中文与 emoji 原样落框）→ 状态行文本发生变化 →
   * 变化后的文本里含知识包声明的成功样式。任何一段不成立就返回 `sent:false` 并说明卡在哪一段，
   * 因为「点了按钮」离「对方收到了」之间还隔着页面自己的校验与网络请求。
   * @param target 目标坐标：岗位（可用 `targetParam` 直接拼地址的站点）或会话对象（按列表行选中的站点，裁定⑲）
   * @param text 话术正文（可含中文与 emoji）
   * @returns 外发结局；`ledgerKey` 恒为 null——计量凭证由编排层（2.5-e 的 `outbound.greet`）盖，
   *          适配器不碰额度也不记账（AGENTS.md §7.3 的必经口只有一处）
   * @throws 两种坐标都没给 `INVALID_ARGUMENT`（空目标不向页面发出任何动作）；缺会话段 `KNOWLEDGE_PACK_INVALID`；
   *         输入框或发送键未取证 `LOCATOR_UNVERIFIED`（连会话页都不打开）；
   *         会话坐标选不出目标 `CONVERSATION_TARGET_NOT_FOUND`；
   *         定位/动作自身的失败照 `browser.act` 的原样抛出（`LOCATE_FAILED` / `ACT_FAILED` / `WAIT_TIMEOUT`）
   */
  const chat = async (target: GreetTarget, text: string): Promise<OutboundResult> => {
    const knowledge = chatKnowledge();
    // 正文为空这条判据留在**验票之前**（spec 8.1-04「不发起任何动作」含导航）：
    // 旧实现把它放在导航之后，于是空正文也会先打开会话页再抛错。
    if (!text.trim()) {
      throw new AppError('INVALID_ARGUMENT', '打招呼正文为空，不向页面发出任何动作', 'platform.boss', {
        platform: pack.platform,
      });
    }
    // 两道定位先验票，再看页面：一条没取证的候选就足以让整次外发不该发生，
    // 那就连「打开会话页」这一步都不做（spec 8.1-04 的「不发起任何动作」含导航）。
    const inputSpec = outboundLocator(knowledge.input);
    const sendSpec = outboundLocator(knowledge.sendButton);
    // 会话坐标优先（与编排层的幂等键同一个取舍，裁定⑲）：按行选中是"改页面状态"，
    // 而岗位地址是"换一页"，两者同时给时以人认出的那一条为准。
    if (target.conversationTarget) {
      await selectConversation(target.conversationTarget);
    } else {
      const jobId = (target.jobId ?? '').trim();
      if (!jobId) {
        throw new AppError('INVALID_ARGUMENT', '打招呼必须给出目标岗位或会话对象', 'platform.boss', {
          platform: pack.platform,
        });
      }
      const url = pageUrlFor(knowledge, jobId);
      if (url) await page.navigate(url);
    }
    const typed = await act.type(inputSpec, text);
    if (typed.valueAfter !== text) {
      return {
        sent: false,
        reason: `输入框回读与发出文本不一致：页面 ${String(typed.valueAfter?.length ?? 0)} 字 / 发出 ${String(text.length)} 字`,
        ledgerKey: null,
      };
    }
    // 等待要在点击之前起：`textChanges` 的基线是脚本启动那一刻的文本，点完再等就永远「没有变化」。
    const changed = act.waitFor({ kind: 'textChanges', spec: locatorFor(knowledge.statusLine) });
    await act.click(sendSpec);
    const wait = await changed;
    const status = await readStatusLine(knowledge.statusLine);
    if (status.includes(knowledge.sentPattern)) {
      return { sent: true, reason: `状态行回读到成功样式「${knowledge.sentPattern}」：${status}`, ledgerKey: null };
    }
    const detail = status || '（读不到状态行）';
    return {
      sent: false,
      reason:
        wait.status === 'done'
          ? `状态行文本变了但不含成功样式：${detail}`
          : `点击后 ${String(wait.waitedMs)}ms 内状态行没有变化：${detail}`,
      ledgerKey: null,
    };
  };

  /**
   * 把一份简历注进目标岗位的上传页，并按**页面回读**判定有没有递出去（spec 2.6-04 / 07）。
   *
   * 四段判据，顺序不能换：
   * ① 先看状态行有没有「已下架」样式——岗位不收了就**一个动作都不做**，直接抛错。这一步放在最前面，
   *    是因为库里那条 JD 是抓取那一刻的快照，只有页面能回答「现在还在不在招」（plan §13.4 第 3 条）。
   *    **知识包没登记下架文案时这一段跳过**（裁定㉒：真 BOSS 那次在场没有下架样本，编一条文案就是假判据），
   *    跳过不等于默认在招——结局里如实写明「这一条没做在招校验」，给人看的那张确认卡与账本都读得到这句话；
   * ② 文件注入后由**那个 input 自己报上来**的文件名必须等于附件名——这证明「塞进控件的就是这份字节」，
   *    不是「我们请求塞了个文件」；
   * ③ 点击前起 `textChanges` 等待，点击后状态行必须真的变过；
   * ④ 变化后的文本里含知识包声明的成功样式。
   * ②③④ 任何一段不成立就返回 `sent:false`（编排层据此不落账）；①是抛错，因为它意味着
   *    「这个目标别再试了」，与「这条没发出去但目标还在」在界面上是两种处置（spec 2.6-07）。
   * @param jobId 目标岗位标识
   * @param attachment 编排层已校验（存在 / pdf / 大小上限）并算好 sha256 的简历文件
   * @returns 外发结局；`ledgerKey` 恒为 null，理由与 `chat` 同一条——计量归编排层
   * @throws 目标已下架 `DELIVER_TARGET_OFFLINE`（不注入文件、不点按钮；知识包没登记下架文案时这一段不判）；
   *         jobId 为空 `INVALID_ARGUMENT`；
   *         缺投递段 `KNOWLEDGE_PACK_INVALID`；上传控件或确认键未取证 `LOCATOR_UNVERIFIED`（不打开上传页）；
   *         定位/注入自身的失败照 `browser.act` 原样抛出
   */
  const sendResume = async (jobId: string, attachment: ResumeAttachment): Promise<OutboundResult> => {
    const knowledge = deliverKnowledge();
    if (!jobId.trim()) {
      throw new AppError('INVALID_ARGUMENT', '投递必须给出目标岗位', 'platform.boss', { platform: pack.platform });
    }
    // 与 `chat` 同一条纪律：两条要动手的定位先验票，未取证就连上传页都不打开（spec 8.1-04）。
    const uploadSpec = outboundLocator(knowledge.uploadInput);
    const sendSpec = outboundLocator(knowledge.sendButton);
    // 缺下架文案时的补话，原样拼进结局：让"这一条判不了"随结果走，而不是只留在注释里。
    const skippedOfflineCheck = knowledge.offlinePattern
      ? ''
      : '（下架文案未登记：这一条没做在招校验，页面自己说的是不是"还在招"只有你看得见）';
    const url = pageUrlFor(knowledge, jobId);
    if (url) await page.navigate(url);
    const before = await readStatusLine(knowledge.statusLine);
    if (knowledge.offlinePattern && before.includes(knowledge.offlinePattern)) {
      throw new AppError(
        'DELIVER_TARGET_OFFLINE',
        `目标岗位已下架：状态行回读到「${knowledge.offlinePattern}」`,
        'platform.boss',
        {
          jobId,
          status: before,
        },
      );
    }
    const injected = await act.upload(uploadSpec, attachment.path);
    if (injected.valueAfter !== attachment.fileName) {
      return {
        sent: false,
        reason: `文件控件回读到的文件名与附件不一致：页面「${String(injected.valueAfter)}」/ 附件「${attachment.fileName}」`,
        ledgerKey: null,
      };
    }
    // 与打招呼同一条时序：等待在点击之前起，否则基线就是点击后的文本，永远等不到变化。
    const changed = act.waitFor({ kind: 'textChanges', spec: locatorFor(knowledge.statusLine) });
    await act.click(sendSpec);
    const wait = await changed;
    const status = await readStatusLine(knowledge.statusLine);
    if (status.includes(knowledge.sentPattern)) {
      return {
        sent: true,
        reason: `状态行回读到成功样式「${knowledge.sentPattern}」：${status}${skippedOfflineCheck}`,
        ledgerKey: null,
      };
    }
    const reading = status || '（读不到状态行）';
    return {
      sent: false,
      reason:
        (wait.status === 'done'
          ? `状态行文本变了但不含成功样式：${reading}`
          : `点击后 ${String(wait.waitedMs)}ms 内状态行没有变化：${reading}`) + skippedOfflineCheck,
      ledgerKey: null,
    };
  };

  /**
   * 读目标会话里页面上可见的全部消息（spec 2.5-07）。
   *
   * 是**全量读**而不是读增量：真实平台会话页不给游标 API，页面上有什么就读什么，
   * 「这条见过没有」交给 `conversation_messages` 的唯一索引按 `externalId` 判（§12.6.2 第 3 条）。
   * 正文取知识包 `chat.messageBody` 声明的那个节点，所以页面上的方向标记（本地仿站的「对方：/我：」）
   * 不会混进正文（spec 2.5-08）——标记本身仍然画在页面上给人看，只是不入库。
   * @param target 目标坐标：岗位或会话对象（两者至少一只，裁定⑲）
   * @returns 按页面顺序的消息列表；正文为空的行不算消息（分割线与引导气泡），一条都没有是空数组
   * @throws 缺会话段 `KNOWLEDGE_PACK_INVALID`；两种坐标都没给 `INVALID_ARGUMENT`；
   *         会话坐标选不出目标 `CONVERSATION_TARGET_NOT_FOUND`（绝不退化成"读当前选中的那条"）
   */
  const readReplies = async (target: GreetTarget): Promise<ReplyMessage[]> => {
    const knowledge = chatKnowledge();
    const conversationTarget = target.conversationTarget?.trim() ?? '';
    const jobId = target.jobId?.trim() ?? '';
    // 读之前先把页面落到那一条会话上（与 `chat` 同一个前置，spec 8.4-02）：
    // 真实平台的会话页没有可直接拼的地址，不选中就读等于把上一个人说的话记到这一行名下。
    if (conversationTarget) {
      await selectConversation(conversationTarget);
    } else {
      if (!jobId) {
        throw new AppError('INVALID_ARGUMENT', '读会话必须给出目标岗位或会话对象', 'platform.boss', {
          platform: pack.platform,
        });
      }
      const url = pageUrlFor(knowledge, jobId);
      if (url) await page.navigate(url);
    }
    const result = await page.extract({
      container: locatorFor(knowledge.messageItem),
      fields: [
        // 正文只认知识包声明的那个节点（scope 默认 subtree），id 与方向仍在容器自身上，所以三条不同源。
        { name: 'text', candidates: locatorFor(knowledge.messageBody).candidates },
        { name: 'externalId', candidates: [], scope: 'self', attribute: knowledge.messageIdAttribute },
        // 方向在真实站点上有两种形状：写成属性（本地仿站的 `data-direction`）或只写成 class token
        // （真 BOSS 的 `item-friend`，证据 8.0-05 第四节：那条消息行上没有任何方向属性）。
        // 后者要读的是容器自己的 class 串，所以知识包里选哪种，抽取的字段名就跟着换。
        ...(knowledge.directionAttribute
          ? [{ name: 'direction', candidates: [], scope: 'self' as const, attribute: knowledge.directionAttribute }]
          : [{ name: 'rowClass', candidates: [], scope: 'self' as const, attribute: 'class' }]),
      ],
    });
    /**
     * 判定读到的这一行是不是「对方发来的」。
     * @param fields 这一行的字段读数
     * @returns 属性形状按值比对，class 形状按**整词**比对（`item-friend` 不该撞到 `not-item-friend`）
     */
    const isInboundRow = (fields: FieldReadings): boolean => {
      if (knowledge.directionAttribute) return attributeOf(fields, 'direction') === knowledge.inboundValue;
      const token = knowledge.inboundClassToken;
      return token !== undefined && attributeOf(fields, 'rowClass').split(/\s+/).includes(token);
    };
    const readAt = Date.now();
    const messages: ReplyMessage[] = [];
    for (const row of result.rows) {
      const fields = fieldsByName(row.fields);
      const text = textOf(fields, 'text');
      if (!text) continue;
      messages.push({
        platform: pack.platform,
        // 两种坐标按哪一路读的就填哪一路，另一路如实留 null（落库才写空串，裁定⑲）。
        jobId: jobId || null,
        conversationTarget: conversationTarget || null,
        from: isInboundRow(fields) ? 'recruiter' : 'self',
        text,
        at: readAt,
        externalId: attributeOf(fields, 'externalId') || null,
      });
    }
    return messages;
  };

  return {
    meta,
    // 风控页文字判据取自知识包那一段；缺段回 null，观测层据此「只按 HTTP 状态判风控」，不猜文案。
    risk: pack.risk ? { pattern: pack.risk.riskPattern } : null,
    openSearch,
    readListing,
    search: async (criteria: JobSearchCriteria): Promise<JobSummary[]> => {
      await openSearch(criteria);
      return readListing();
    },
    detail,
    chat,
    sendResume,
    readReplies,
  };
}
