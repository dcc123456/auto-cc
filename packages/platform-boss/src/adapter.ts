/**
 * BOSS 平台适配器（spec 2.2-06 的空壳 → 2.3 的 `search` / `detail` 落地）。
 *
 * 这里**不出现任何选择器**：页面结构一律经 `@auto-cc/plugin-browser` 的抓取声明按语义名取用，
 * 于是 2.2-08 的机检（`scripts/check-knowledge-pack.ts`）能把「选择器只许待在知识包里」钉住。
 * 同理，URL 上的查询参数名也在知识包里（`pack.search.params`）——「BOSS 用哪个参数名搜城市」
 * 是站点知识，不是我们的代码知识。
 *
 * 抓取动作全部是**只读**的：读列表、读详情，不点投递、不发简历、不打招呼，
 * 所以本文件一次 `entitlement.gate` 都不进（AGENTS.md §7.3 的必经口由 2.5 接上）。
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
import type { JobDetail, JobSearchCriteria, JobSummary, KnowledgePack, PlatformAdapter } from '@auto-cc/plugin-browser';
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

/** 尚未实现的三个动作（外发类，各自等自己的子计划）。 */
export type UnimplementedMethod = 'chat' | 'sendResume' | 'readReplies';

/** 每个动作由哪个子计划补齐：界面据此显示待办。 */
const DELIVERED_BY: Record<UnimplementedMethod, string> = {
  chat: '2.5',
  sendResume: '2.6',
  readReplies: '2.5',
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
 * 为什么是工厂而不是类：适配器的输入就是「这份知识 + 那只会读页面的手」，
 * 2.6 换一版知识包就换一个实例，不需要子类；而 `platform.registry` 要的是「一个实现了契约的对象」。
 * @param pack 经 `parseKnowledgePack` 校验过的知识包（结构已由 zod 保证，这里不再判空）
 * @param page 页面通道（见 `BossPageHand`）
 * @returns 契约完整、`search` / `detail` 已实现、外发动作以结构化错误失败的平台适配器
 */
export function createBossAdapter(pack: KnowledgePack, page: BossPageHand): PlatformAdapter {
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

  return {
    meta,
    openSearch,
    readListing,
    search: async (criteria: JobSearchCriteria): Promise<JobSummary[]> => {
      await openSearch(criteria);
      return readListing();
    },
    detail,
    chat: () => notImplemented('chat'),
    sendResume: () => notImplemented('sendResume'),
    readReplies: () => notImplemented('readReplies'),
  };
}
