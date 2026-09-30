/**
 * 2.3 用例的替身（`adapter.test.ts` 与 `jd-capture.test.ts` 共用）。
 *
 * 只替一只「读页面的手」：真实站点在自动化测试里不可用（AGENTS.md §7.2），而这两份用例要验收的是
 * 「页面读数怎么变成库里的行」，所以把 `browser.page` 收成可编排的假手，登记处 / 库 / 账本一律用
 * 真实服务——把 sqlite mock 掉就等于没测幂等。
 */
import { Service, type Context } from '@auto-cc/core';
import type {
  ExtractFieldReading,
  ExtractRequest,
  ExtractResultView,
  ExtractRowReading,
  KernelPageSnapshotView,
  LocateSpec,
  PageScrollReading,
} from '@auto-cc/shared';
import { z } from 'zod';
import type { BossPageHand } from './adapter.js';

/** 仿站的列表页地址（抽取行的 `frameUrl` 就是它，相对 href 按它折算）。 */
export const LIST_URL = 'http://127.0.0.1:10233/boss';
/** 仿站的详情页地址前缀。 */
export const DETAIL_BASE = 'http://127.0.0.1:10233/boss/detail';

/**
 * 造一个「命中」的字段读数。
 * @param name 字段名（与知识包 `capture.*.fields[].name` 对齐）
 * @param text 归一化后的正文
 * @param attribute 请求过属性时回读到的值；未请求为 null
 * @returns 抽取字段读数
 */
export function fieldHit(name: string, text: string, attribute: string | null = null): ExtractFieldReading {
  return { name, matched: true, text, attribute };
}

/**
 * 造一个「没命中」的字段读数（站点没渲染这一项或定位失配）。
 * @param name 字段名
 * @returns 正文与属性皆空的读数
 */
export function fieldMiss(name: string): ExtractFieldReading {
  return { name, matched: false, text: '', attribute: null };
}

/**
 * 造一行（一个容器 + 它的字段读数 + 所在帧地址）。
 * @param containerIndex 容器序号
 * @param frameUrl 该容器所在帧的地址
 * @param fields 字段读数
 * @returns 抽取行
 */
export function rowOf(containerIndex: number, frameUrl: string, fields: ExtractFieldReading[]): ExtractRowReading {
  return { containerIndex, frameUrl, fields };
}

/**
 * 造一次单帧抽取的读数。
 * @param frameUrl 帧地址（同时填进每一行）
 * @param rows 命中容器拍出来的行
 * @returns `browser.page.extract` 的返回体；`containers` 与行数一致、不声明截断
 */
export function extractOf(frameUrl: string, rows: ExtractRowReading[]): ExtractResultView {
  return { rows, containers: rows.length, truncated: false, frames: [{ url: frameUrl, ok: true, error: null }] };
}

/**
 * 造一张列表页卡片行（七个字段齐全）。
 * @param index 容器序号
 * @param jobId 平台侧岗位标识（写进详情页 href 的查询参数）
 * @param overrides 需要改动的字段：给 `null` 表示该字段读不到（`matched:false`）
 * @returns 一行抽取读数
 */
export function cardRow(
  index: number,
  jobId: string,
  overrides: Partial<
    Record<'title' | 'company' | 'salary' | 'city' | 'experience' | 'education' | 'href', string | null>
  > = {},
): ExtractRowReading {
  const text = (key: 'title' | 'company' | 'salary' | 'city' | 'experience' | 'education', fallback: string): string =>
    overrides[key] === null ? '' : (overrides[key] ?? fallback);
  const isMissing = (key: 'title' | 'company' | 'salary' | 'city' | 'experience' | 'education'): boolean =>
    overrides[key] === null;
  const href = overrides.href === null ? null : (overrides.href ?? `/boss/detail?jobId=${jobId}`);
  return rowOf(index, LIST_URL, [
    { name: 'title', matched: !isMissing('title'), text: text('title', `资深前端工程师 ${jobId}`), attribute: null },
    { name: 'company', matched: !isMissing('company'), text: text('company', '示例科技'), attribute: null },
    { name: 'salary', matched: !isMissing('salary'), text: text('salary', '25-40K·15薪'), attribute: null },
    { name: 'city', matched: !isMissing('city'), text: text('city', '上海 · 浦东新区'), attribute: null },
    { name: 'experience', matched: !isMissing('experience'), text: text('experience', '3-5 年'), attribute: null },
    { name: 'education', matched: !isMissing('education'), text: text('education', '本科'), attribute: null },
    { name: 'detailHref', matched: href !== null, text: '', attribute: href },
  ]);
}

/**
 * 造一行详情页抽取读数。
 * @param jobId 岗位标识（只用于默认正文文案）
 * @param overrides 需要改动的字段：给 `null` 表示读不到
 * @returns 单容器的一行
 */
export function detailRow(
  jobId: string,
  overrides: Partial<Record<'description' | 'requirement' | 'posted', string | null>> = {},
): ExtractRowReading {
  const field = (name: 'description' | 'requirement' | 'posted', fallback: string): ExtractFieldReading => {
    const value = overrides[name];
    if (value === null) return fieldMiss(name);
    return fieldHit(name, value ?? fallback);
  };
  return rowOf(0, `${DETAIL_BASE}?jobId=${jobId}`, [
    field('description', `负责 ${jobId} 号岗位的招聘页面自动化抓取`),
    field('requirement', '3 年 TypeScript 经验；熟悉 Electron 主进程；能独立排障'),
    field('posted', '3 天前'),
  ]);
}

/** 页面快照的最小可用替身（适配器只看导航成没成，不读这些字段）。 */
export function snapshotOf(url: string): KernelPageSnapshotView {
  return {
    title: '仿站页面',
    url,
    readyState: 'complete',
    elementCount: 24,
    textLength: 120,
    bodyText: '示例正文',
    headings: ['资深前端工程师'],
    partition: 'persist:boss',
  };
}

/** 假手某一次抽取服务的是哪一类页面（用例靠它断言阶段先后，不必自己辨认容器）。 */
export type PageKind = 'list' | 'detail';

/** 假手的脚本：列表容器的身份 + 依次回传的读数。 */
export type PageScript = {
  /** 列表容器的定位声明：请求里的容器与它**内容相同**即判为读列表（见 `createFakePage`） */
  listContainer: LocateSpec;
  /** 依次回传的列表读数（一屏一份）；用尽后重复最后一份，模拟「滚了但页面没长出新东西」 */
  list: ExtractResultView[];
  /** 详情页读数，按各自的 `frames[].url`（即详情页地址）索引；没有脚本到的地址一律读成空 */
  detail: ExtractResultView[];
  /** 每次滚动的回读；省略表示页面到底了 */
  scroll?: PageScrollReading;
};

/** 带调用记账的假手。 */
export type FakePage = BossPageHand & {
  /** 按顺序记录每次导航的地址（第一个应当是搜索页，其后是详情页） */
  navigated: string[];
  /** 按顺序记录每次抽取的请求，用来断言「请求里的定位声明确实来自知识包」 */
  requests: ExtractRequest[];
  /** 与 `requests` 对齐的页面类别，用来断言「列表阶段整体先于详情阶段」 */
  kinds: PageKind[];
  /** 滚动次数 */
  scrolls: number;
};

/**
 * 两条定位声明是否等价。
 * @param left 请求里的容器声明
 * @param right 脚本里的列表容器
 * @returns 内容一致为 true（不比对象引用，理由见 `createFakePage`）
 */
function sameLocator(left: LocateSpec, right: LocateSpec): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 按脚本造一只假手。
 * @param script 读数脚本（见 `PageScript`）
 * @returns 记录调用的 `BossPageHand`
 */
export function createFakePage(script: PageScript): FakePage {
  const navigated: string[] = [];
  const requests: ExtractRequest[] = [];
  const kinds: PageKind[] = [];
  let screens = 0;
  // 列表一屏一屏地长：队列用尽后重复最后一份，就是无限滚动站点「不再加载」时的样子。
  const nextScreen = (): ExtractResultView =>
    script.list.length === 0 ? extractOf(LIST_URL, []) : script.list[Math.min(screens++, script.list.length - 1)]!;
  // 详情页按「当前停在哪个地址」回话，而不是按调用次序：真实页面就是这么工作的，
  // 而「跳过已读详情」「单条失败隔离」这些用例本就会打乱次序，用次序回话等于替用例排序。
  const detailFor = (url: string): ExtractResultView =>
    script.detail.find((entry) => entry.frames.some((frame) => frame.url === url)) ?? extractOf(url, []);
  return {
    navigated,
    requests,
    kinds,
    scrolls: 0,
    navigate: (url: string) => {
      navigated.push(url);
      return Promise.resolve(snapshotOf(url));
    },
    extract: (request: ExtractRequest) => {
      requests.push(request);
      // `platform.boss` 挂载时会自己再解析一遍知识包，请求里的容器与脚本里那条是「内容相同而非同一对象」；
      // 用 `===` 判会把整条挂载链路的列表读成详情，于是一条岗位都攒不出来。
      const isListing = sameLocator(request.container, script.listContainer);
      kinds.push(isListing ? 'list' : 'detail');
      return Promise.resolve(isListing ? nextScreen() : detailFor(navigated.at(-1) ?? LIST_URL));
    },
  };
}

/**
 * 替身服务的配置：把假手原样递进来。
 *
 * 为什么用配置注入而不是工厂造类：匿名类的类型无法具名导出（TS4094），而具名类要每个用例
 * 换一只假手就只能把假手放在构造参数上——cordis 恰好把 `Config` 校验后的对象作为第二个实参传入。
 */
const stubPageSchema = z.strictObject({
  fake: z.custom<FakePage>(
    (value) => typeof value === 'object' && value !== null && 'navigate' in value && 'extract' in value,
    'fake 必须是 createFakePage 造出来的假手',
  ),
  /** 滚动读数；省略表示页面已经到底 */
  scroll: z.custom<PageScrollReading>().optional(),
});

/** 校验后的替身配置形状。 */
export type StubPageConfig = z.output<typeof stubPageSchema>;

/**
 * `browser.page` 的测试替身：只交出本子计划用到的三只手。
 *
 * 存在的理由：`platform.boss` 与 `jd.capture` 都 `inject` 了 `browser.page`，装配清单里没有它
 * 这两个插件会停在 PENDING（依赖没满足不报错，这是 cordis 的语义），所以测试必须真提供一个同名服务。
 */
export class StubBrowserPageService extends Service {
  static provide = 'browser.page';
  static Config = stubPageSchema;

  constructor(
    ctx: Context,
    private readonly options: StubPageConfig,
  ) {
    super(ctx, 'browser.page');
  }

  /**
   * 记录一次导航并回一张最小快照。
   * @param url 目标地址
   * @returns 页面快照（假手不渲染，字段取自 `snapshotOf`）
   */
  navigate(url: string): Promise<KernelPageSnapshotView> {
    return this.options.fake.navigate(url);
  }

  /**
   * 按脚本回传一次抽取读数。
   * @param request 抽取请求（容器身份决定回列表还是详情）
   * @returns 该次抽取的行
   */
  extract(request: ExtractRequest): Promise<ExtractResultView> {
    return this.options.fake.extract(request);
  }

  /**
   * 记一次滚动并回传脚本里的滚动读数。
   * @returns 滚动位置；脚本没给就是「到底了」
   */
  scroll(): Promise<PageScrollReading> {
    this.options.fake.scrolls += 1;
    return Promise.resolve(this.options.scroll ?? { scrollY: 0, scrollHeight: 0, atBottom: true });
  }
}
