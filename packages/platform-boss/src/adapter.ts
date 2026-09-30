/**
 * BOSS 平台适配器（spec 2.2-06 → 2.3 的 `search` / `detail` → 2.5 的 `chat` / `readReplies`）。
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
import { AppError } from '@auto-cc/core';
import type {
  ExtractFieldReading,
  ExtractRequest,
  ExtractResultView,
  KernelPageSnapshotView,
  LocateSpec,
  PlatformMetaView,
} from '@auto-cc/shared';
import type {
  JobDetail,
  JobSearchCriteria,
  JobSummary,
  KnowledgePack,
  OutboundResult,
  PlatformAdapter,
  ReplyMessage,
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
 * 适配器用到的那只「动页面的手」（spec 2.5-06）。
 *
 * 只取 `type` / `click` / `waitFor` 三个方法：敲字与点击的通道选择（CDP 还是 DOM）、事件是否受信，
 * 全由 `browser.act` 决定，适配器一侧不出现 `webContents`，也不猜坐标（plan §3 规则 3）。
 */
export type BossActionHand = {
  /** 往定位声明指向的控件里写文本，回读页面里的当前值 */
  type(spec: LocateSpec, text: string): Promise<ActReadback>;
  /** 点击定位声明指向的元素 */
  click(spec: LocateSpec): Promise<ActReadback>;
  /** 只等不动手：超时是结局（`status:'timeout'`），不是异常 */
  waitFor(predicate: { kind: 'textChanges'; spec: LocateSpec }): Promise<ActReadback>;
};

/** 一次动作的回读：只取适配器判据需要的三个字段（`ActResultView` 的窄化）。 */
export type ActReadback = {
  status: 'done' | 'timeout';
  waitedMs: number;
  valueAfter: string | null;
};

/** 尚未实现的动作（外发类，等自己的子计划）。 */
export type UnimplementedMethod = 'sendResume';

/** 每个动作由哪个子计划补齐：界面据此显示待办。 */
const DELIVERED_BY: Record<UnimplementedMethod, string> = {
  sendResume: '2.6',
};

/**
 * 统一的「还没实现」失败：说清等哪个子计划。
 *
 * 用 `METHOD_NOT_FOUND`（现有码里唯一的「能力不存在」语义）而不是 `OUTBOUND_FAILED`：
 * 后者意味着「真的发过但失败了」，会污染 2.7 的失败率统计，也会让账本看起来记过账。
 * @param method 被调用的契约方法名，同时是归因键
 * @returns 永不完成的 Promise：以 `METHOD_NOT_FOUND` 拒绝，`details.deliveredBy` 给出补齐它的子计划号
 */
const notImplemented = (method: UnimplementedMethod): Promise<never> =>
  Promise.reject(
    new AppError(
      'METHOD_NOT_FOUND',
      `BOSS 适配器的 ${method} 尚未实现，由子计划 ${DELIVERED_BY[method]} 交付`,
      'platform.boss',
      { method, deliveredBy: DELIVERED_BY[method] },
    ),
  );

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
 * @param act 动作通道（见 `BossActionHand`）；只有 `chat` 用它，抓取一侧一行都不碰
 * @returns 契约完整、`search` / `detail` / `chat` / `readReplies` 已实现、`sendResume` 以结构化错误失败的平台适配器
 */
export function createBossAdapter(pack: KnowledgePack, page: BossPageHand, act: BossActionHand): PlatformAdapter {
  const meta: PlatformMetaView = {
    id: pack.platform,
    displayName: pack.displayName,
    startUrl: pack.startUrl,
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
   * 拼搜索页地址：起始地址 + 知识包登记的查询参数名。
   * @param criteria 搜索条件（关键词必填，城市与经验可省）
   * @returns 可直接导航的绝对地址
   */
  const searchUrl = (criteria: JobSearchCriteria): string => {
    const target = new URL(pack.startUrl);
    target.searchParams.set(pack.search.params.keyword, criteria.keyword);
    if (criteria.city) target.searchParams.set(pack.search.params.city, criteria.city);
    if (criteria.experience) target.searchParams.set(pack.search.params.experience, criteria.experience);
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

  const readListing = async (): Promise<JobSummary[]> => toSummaries(await page.extract(requestFor('list')));

  const detail = async (jobId: string): Promise<JobDetail> => {
    const summary = seen.get(jobId);
    if (!summary) {
      throw new AppError('INVALID_ARGUMENT', `没见过 jobId「${jobId}」，先跑一次搜索再读详情`, 'platform.boss', {
        jobId,
      });
    }
    await page.navigate(summary.detailUrl);
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
   * 拼某个目标的会话页地址。
   * @param knowledge 知识包会话段
   * @param jobId 目标岗位标识
   * @returns 绝对地址；知识包没声明 `entryPath` 时为 null，表示「当前页就是会话页」
   *          （真实平台从岗位卡点进会话，不给可直接拼的地址，那种站点由调用方先打开再动作）
   */
  const chatUrlFor = (knowledge: NonNullable<KnowledgePack['chat']>, jobId: string): string | null => {
    if (!knowledge.entryPath) return null;
    const target = new URL(knowledge.entryPath, pack.startUrl);
    // 参数名是站点知识：换平台只改 `chat.targetParam`，这一段代码不用动。
    if (knowledge.targetParam) target.searchParams.set(knowledge.targetParam, jobId);
    return target.href;
  };

  /**
   * 回读发送状态行的文本——`sent` 的唯一依据。
   * @param knowledge 知识包会话段
   * @returns 状态行正文；一行都没读到是空串（调用方按「没读到成功样式」处理，绝不猜成成功）
   */
  const readStatusLine = async (knowledge: NonNullable<KnowledgePack['chat']>): Promise<string> => {
    const result = await page.extract({
      container: locatorFor(knowledge.statusLine),
      fields: [{ name: 'status', candidates: [], scope: 'self' }],
    });
    const reading = fieldsByName(result.rows[0]?.fields ?? []).get('status');
    return reading?.matched ? cleanText(reading.text) : '';
  };

  /**
   * 把一段话术打进目标会话，并按**页面回读**判定有没有发出去（spec 2.5-06）。
   *
   * 三段判据缺一不可：输入框回读等于发出文本（中文与 emoji 原样落框）→ 状态行文本发生变化 →
   * 变化后的文本里含知识包声明的成功样式。任何一段不成立就返回 `sent:false` 并说明卡在哪一段，
   * 因为「点了按钮」离「对方收到了」之间还隔着页面自己的校验与网络请求。
   * @param jobId 目标岗位标识
   * @param text 话术正文（可含中文与 emoji）
   * @returns 外发结局；`ledgerKey` 恒为 null——计量凭证由编排层（2.5-e 的 `outbound.greet`）盖，
   *          适配器不碰额度也不记账（AGENTS.md §7.3 的必经口只有一处）
   * @throws 正文为空 `INVALID_ARGUMENT`（空话术不向页面发出任何动作）；缺会话段 `KNOWLEDGE_PACK_INVALID`；
   *         定位/动作自身的失败照 `browser.act` 的原样抛出（`LOCATE_FAILED` / `ACT_FAILED` / `WAIT_TIMEOUT`）
   */
  const chat = async (jobId: string, text: string): Promise<OutboundResult> => {
    const knowledge = chatKnowledge();
    if (!jobId.trim()) {
      throw new AppError('INVALID_ARGUMENT', '打招呼必须给出目标岗位', 'platform.boss', { platform: pack.platform });
    }
    if (!text.trim()) {
      throw new AppError('INVALID_ARGUMENT', '打招呼正文为空，不向页面发出任何动作', 'platform.boss', { jobId });
    }
    const url = chatUrlFor(knowledge, jobId);
    if (url) await page.navigate(url);
    const typed = await act.type(locatorFor(knowledge.input), text);
    if (typed.valueAfter !== text) {
      return {
        sent: false,
        reason: `输入框回读与发出文本不一致：页面 ${String(typed.valueAfter?.length ?? 0)} 字 / 发出 ${String(text.length)} 字`,
        ledgerKey: null,
      };
    }
    // 等待要在点击之前起：`textChanges` 的基线是脚本启动那一刻的文本，点完再等就永远「没有变化」。
    const changed = act.waitFor({ kind: 'textChanges', spec: locatorFor(knowledge.statusLine) });
    await act.click(locatorFor(knowledge.sendButton));
    const wait = await changed;
    const status = await readStatusLine(knowledge);
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
   * 读目标会话里页面上可见的全部消息（spec 2.5-07）。
   *
   * 是**全量读**而不是读增量：真实平台的会话页不给游标 API，页面上有什么就读什么，
   * 「这条见过没有」交给 `conversation_messages` 的唯一索引按 `externalId` 判（§12.6.2 第 3 条）。
   * 消息正文按页面原样返回（本地仿站给每条加了「对方：/我：」前缀，那也是页面事实，不替它删）。
   * @param jobId 目标岗位标识
   * @returns 按页面顺序的消息列表；正文为空的行不算消息（分割线与引导气泡），一条都没有是空数组
   * @throws 缺会话段 `KNOWLEDGE_PACK_INVALID`；jobId 为空 `INVALID_ARGUMENT`
   */
  const readReplies = async (jobId: string): Promise<ReplyMessage[]> => {
    const knowledge = chatKnowledge();
    if (!jobId.trim()) {
      throw new AppError('INVALID_ARGUMENT', '读会话必须给出目标岗位', 'platform.boss', { platform: pack.platform });
    }
    const url = chatUrlFor(knowledge, jobId);
    if (url) await page.navigate(url);
    const result = await page.extract({
      container: locatorFor(knowledge.messageItem),
      fields: [
        { name: 'text', candidates: [], scope: 'self' },
        { name: 'externalId', candidates: [], scope: 'self', attribute: knowledge.messageIdAttribute },
        { name: 'direction', candidates: [], scope: 'self', attribute: knowledge.directionAttribute },
      ],
    });
    const readAt = Date.now();
    const messages: ReplyMessage[] = [];
    for (const row of result.rows) {
      const fields = fieldsByName(row.fields);
      const text = textOf(fields, 'text');
      if (!text) continue;
      messages.push({
        platform: pack.platform,
        jobId,
        from: attributeOf(fields, 'direction') === knowledge.inboundValue ? 'recruiter' : 'self',
        text,
        at: readAt,
        externalId: attributeOf(fields, 'externalId') || null,
      });
    }
    return messages;
  };

  return {
    meta,
    openSearch,
    readListing,
    search: async (criteria: JobSearchCriteria): Promise<JobSummary[]> => {
      await openSearch(criteria);
      return readListing();
    },
    detail,
    chat,
    sendResume: () => notImplemented('sendResume'),
    readReplies,
  };
}
