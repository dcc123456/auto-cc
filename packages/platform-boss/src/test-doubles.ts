/**
 * 2.3 与 2.5 用例的替身（`adapter.test.ts` / `jd-capture.test.ts` / `conversation-store.test.ts` 共用）。
 *
 * 只替两只手：`createFakePage` 替「读页面的手」、`createFakeAct` 替「敲字与点击的手」。
 * 真实站点在自动化测试里不可用（AGENTS.md §7.2），而这几份用例要验收的是
 * 「页面读数怎么变成库里的行」「sent 是不是由页面回读说了算」，所以把页面与动作收成可编排的假手，
 * 登记处 / 库 / 账本一律用真实服务——把 sqlite mock 掉就等于没测幂等。
 */
import { Service, type Context, type WorkflowExecutorRegistry, type WorkflowNodeExecutor } from '@auto-cc/core';
import path from 'node:path';
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
import type { KnowledgePack } from '@auto-cc/plugin-browser';
import type { ActReadback, BossActionHand, BossPageHand } from './adapter.js';

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
export type PageKind = 'list' | 'detail' | 'status' | 'messages' | 'deliver-status';

/**
 * 会话页的读数脚本（spec 2.5-06 / 2.5-07）。
 *
 * 状态行与消息条各自用自己的容器身份来路由：适配器对两者都发「scope 为 self」的抽取，
 * 靠请求里的容器区分是唯一不掺代码 guess 的判法（同 `listContainer` 的判法）。
 */
export type ChatScript = {
  /** 状态行的定位声明：与请求容器内容相同即判为读状态行 */
  statusContainer?: LocateSpec;
  /** 状态行的读数（一行一字段 `status`） */
  status?: ExtractResultView;
  /** 消息条的定位声明 */
  messageContainer?: LocateSpec;
  /** 消息条的读数（每次读都是页面的全量可见消息） */
  messages?: ExtractResultView;
};

/**
 * 投递页的读数脚本（spec 2.6-04 / 07）。
 *
 * 状态行是一串**依次**回传的读数，而不是一份固定值：`sendResume` 要在动手前读一次（判目标还在不在）、
 * 点击后再读一次（判有没有递出去）。做成一份就表达不了「变了」，而「变了没有」正是这条契约的判据。
 */
export type DeliverScript = {
  /** 投递状态行的定位声明：与请求容器内容相同即判为读投递状态行 */
  statusContainer?: LocateSpec;
  /** 依次回传的状态行正文；`null` 表示这一行读不到，用尽后重复最后一份 */
  statuses?: (string | null)[];
};

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
  /** 会话页读数（打招呼的状态行与消息列表）；省略表示这一页什么都读不到 */
  chat?: ChatScript;
  /** 投递页读数（上传后的状态行，按次回传）；省略表示这一页什么都读不到 */
  deliver?: DeliverScript;
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
  // 会话页的两种读数各按自己的容器身份回话；没脚本到的那一类一律读成「一行都没有」，
  // 因为「读不到」在 2.5 的用例里是常态而不是异常（状态行读不到必须判 sent:false）。
  const chatFor = (request: ExtractRequest): ExtractResultView | null => {
    const chat = script.chat;
    if (!chat) return null;
    if (chat.statusContainer && sameLocator(request.container, chat.statusContainer)) {
      kinds.push('status');
      return chat.status ?? extractOf(navigated.at(-1) ?? LIST_URL, []);
    }
    if (chat.messageContainer && sameLocator(request.container, chat.messageContainer)) {
      kinds.push('messages');
      return chat.messages ?? extractOf(navigated.at(-1) ?? LIST_URL, []);
    }
    return null;
  };
  // 投递状态行按次序回话：动手前那次读到「已下架」与点击后那次读到「已送达」必须是两份读数。
  let deliverReads = 0;
  const deliverFor = (request: ExtractRequest): ExtractResultView | null => {
    const deliver = script.deliver;
    if (!deliver?.statusContainer || !sameLocator(request.container, deliver.statusContainer)) return null;
    kinds.push('deliver-status');
    const statuses = deliver.statuses ?? [];
    const text = statuses.length === 0 ? null : statuses[Math.min(deliverReads++, statuses.length - 1)]!;
    return extractOf(
      navigated.at(-1) ?? LIST_URL,
      text === null ? [] : [rowOf(0, navigated.at(-1) ?? LIST_URL, [fieldHit('status', text)])],
    );
  };
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
      const deliver = deliverFor(request);
      if (deliver) return Promise.resolve(deliver);
      const chat = chatFor(request);
      if (chat) return Promise.resolve(chat);
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

/** 假登记处的配置形状：无键，但构造器仍要接住 cordis 递来的第二个实参。 */
const fakeRegistrySchema = z.strictObject({});

/** 假登记处的配置形状（用例引用它，不重复推断一遍 zod）。 */
export type FakeRegistryConfig = z.output<typeof fakeRegistrySchema>;

/**
 * 假的执行器登记处（spec 2.4-01 的登记口）。 *
 * 平台包不能 import `plugin-workflow`（AGENTS.md §4.1：L2 领域不依赖 L3 流水线），所以这里按
 * `core` 的契约形状自带一张表。它只回答两个问题：服务挂起来时有没有真的把节点登记进来，
 * 以及被卸载时有没有摘掉——留在表里的那个函数指向已销毁的实例，下一次点「跑一遍」会给出无法解释的错误。
 */
export class FakeExecutorRegistryService extends Service implements WorkflowExecutorRegistry {
  static provide = 'workflow.executors';
  static Config = fakeRegistrySchema;

  constructor(ctx: Context, _options: FakeRegistryConfig) {
    super(ctx, 'workflow.executors');
  }

  /** kind → 执行函数。 */
  private readonly table = new Map<string, WorkflowNodeExecutor>();

  register = (kind: string, executor: WorkflowNodeExecutor): void => {
    this.table.set(kind, executor);
  };

  unregister = (kind: string): boolean => this.table.delete(kind);

  resolve = (kind: string): WorkflowNodeExecutor | null => this.table.get(kind) ?? null;

  list = (): string[] => [...this.table.keys()];
}

/** 假动作手的脚本：四只手各自回什么。 */
export type ActScript = {
  /** 敲字之后页面的回读值（`valueAfter`）；省略表示「与发出文本逐字一致」，即正常输入的样子 */
  typedValue?: string | null;
  /** 状态行等待的结局；省略表示「文本确实变了」 */
  waitStatus?: 'done' | 'timeout';
  /** 等待判为超时时的已等毫秒 */
  waitedMs?: number;
  /** 点击要不要失败（真实动作手在定位失配时是抛出而不是返回 false） */
  clickError?: Error;
  /** 文件注入后 input 自己报上来的文件名；省略表示「就是请求那个路径的文件名」（正常注入的样子） */
  uploadedName?: string | null;
  /** 注入要不要失败（真实动作手在回读不符时抛 `ACT_FAILED`） */
  uploadError?: Error;
};

/** 带调用记账的假动作手。 */
export type FakeAct = BossActionHand & {
  /** 按顺序记录敲过哪些（定位声明，文本） */
  typed: { spec: LocateSpec; text: string }[];
  /** 按顺序记录点过哪些定位声明 */
  clicked: LocateSpec[];
  /** 按顺序记录往哪些声明注过哪个文件（投递的回读判据从这里取） */
  uploaded: { spec: LocateSpec; filePath: string }[];
  /** 等待起过几次，以及**第几次点击之前**已经起好（2.5-06 的时序判据） */
  waitsStarted: number;
  /** 点击发生时的等待已起次数：等于 `waitsStarted` 才说明等待起在点击之前 */
  waitsAtClick: number[];
  /** 按顺序记录起过哪些等待谓词（用例断言等的确实是知识包那条状态行） */
  waitedFor: { kind: 'textChanges'; spec: LocateSpec }[];
};

/**
 * 按脚本造一只假动作手（spec 2.5-06 / 2.6-04）。
 *
 * 它只替 `browser.act` 的四只手，并且**如实记账等待与点击的先后**：适配器把 `textChanges`
 * 起在点击之前是这条契约的硬要求（基线晚于点击就永远读不到变化），所以用例要能查这个顺序。
 * @param script 动作脚本
 * @returns 记录调用的 `BossActionHand`
 */
export function createFakeAct(script: ActScript = {}): FakeAct {
  const typed: { spec: LocateSpec; text: string }[] = [];
  const clicked: LocateSpec[] = [];
  const uploaded: { spec: LocateSpec; filePath: string }[] = [];
  const waitsAtClick: number[] = [];
  const waitedFor: { kind: 'textChanges'; spec: LocateSpec }[] = [];
  let waitsStarted = 0;
  return {
    typed,
    clicked,
    uploaded,
    waitsAtClick,
    waitedFor,
    get waitsStarted() {
      return waitsStarted;
    },
    type: (spec: LocateSpec, text: string) => {
      typed.push({ spec, text });
      return Promise.resolve({
        status: 'done' as const,
        waitedMs: 0,
        valueAfter: 'typedValue' in script ? (script.typedValue ?? '') : text,
      });
    },
    click: (spec: LocateSpec) => {
      if (script.clickError) return Promise.reject(script.clickError);
      clicked.push(spec);
      waitsAtClick.push(waitsStarted);
      return Promise.resolve({ status: 'done' as const, waitedMs: 0, valueAfter: null });
    },
    // 回读的是「那个 input 自己报上来的文件名」，不是请求里的路径：注入到另一个控件上时这里就对不上，
    // 而适配器判的正是这个不一致（spec 2.6-04 的「定位到 A、文件塞进 B」防线）。
    upload: (spec: LocateSpec, filePath: string) => {
      if (script.uploadError) return Promise.reject(script.uploadError);
      uploaded.push({ spec, filePath });
      return Promise.resolve({
        status: 'done' as const,
        waitedMs: 0,
        valueAfter: 'uploadedName' in script ? (script.uploadedName ?? '') : path.basename(filePath),
      });
    },
    waitFor: (predicate) => {
      waitsStarted += 1;
      waitedFor.push(predicate);
      return Promise.resolve({
        status: script.waitStatus ?? 'done',
        waitedMs: script.waitedMs ?? 120,
        valueAfter: null,
      });
    },
  };
}

/** 替身 `browser.act` 的配置：把假动作手递进来（形状校验同 `stubPageSchema`）。 */
const stubActSchema = z.strictObject({
  fake: z.custom<FakeAct>(
    (value) => typeof value === 'object' && value !== null && 'type' in value && 'click' in value && 'waitFor' in value,
    'fake 必须是 createFakeAct 造出来的假动作手',
  ),
});

/** 校验后的替身配置形状。 */
export type StubActConfig = z.output<typeof stubActSchema>;

/**
 * `browser.act` 的测试替身：只交出适配器用到的三只手。
 *
 * 存在理由与 `StubBrowserPageService` 同一条：`platform.boss` 从 2.5-d 起 `inject` 了 `browser.act`，
 * 测试装配里没有它，这个插件会停在 PENDING 而 init 不跑。
 */
export class StubBrowserActService extends Service {
  static provide = 'browser.act';
  static Config = stubActSchema;

  constructor(
    ctx: Context,
    private readonly options: StubActConfig,
  ) {
    super(ctx, 'browser.act');
  }

  /**
   * 记一次敲字并回传脚本里的输入框回读值。
   * @param spec 输入框定位声明
   * @param text 要打进框的文本
   * @returns 动作回读（`valueAfter` 由脚本决定，缺省等于 `text`）
   */
  type(spec: LocateSpec, text: string): Promise<ActReadback> {
    return this.options.fake.type(spec, text);
  }

  /**
   * 记一次点击；脚本给了 `clickError` 时按原样失败。
   * @param spec 按钮定位声明
   * @returns 动作回读
   */
  click(spec: LocateSpec): Promise<ActReadback> {
    return this.options.fake.click(spec);
  }

  /**
   * 记一次等待并回传脚本里的结局。
   * @param predicate 等待谓词（本用例只出现 `textChanges` 一种）
   * @returns 等待结局（`done` 或 `timeout`）
   */
  waitFor(predicate: Parameters<BossActionHand['waitFor']>[0]): Promise<ActReadback> {
    return this.options.fake.waitFor(predicate);
  }

  /**
   * 记一次文件注入并回传脚本里的「控件自己报上来的文件名」。
   * @param spec 上传控件定位声明
   * @param filePath 要注入的本地文件路径
   * @returns 动作回读（`valueAfter` 由脚本决定，缺省等于路径的文件名）
   */
  upload(spec: LocateSpec, filePath: string): Promise<ActReadback> {
    return this.options.fake.upload(spec, filePath);
  }
}

/** 仿站的会话页地址：与知识包 `chat.entryPath` + `chat.targetParam` 的拼法一致。 */
export const chatUrlOf = (jobId: string): string => `http://127.0.0.1:10233/chat?targetId=${jobId}`;

/** 仿站的投递页地址：与知识包 `deliver.entryPath` + `deliver.targetParam` 的拼法一致。 */
export const deliverUrlOf = (jobId: string): string => `http://127.0.0.1:10233/deliver?targetId=${jobId}`;

/**
 * 造一条消息的抽取行（正文读容器里的正文节点，稳定 id 与方向读容器自身）。
 *
 * 正文默认不带「对方：」这类方向标记——真实页面把标记装在兄弟节点里，正文节点只装话（见知识包
 * `chatMessageBody`），用例若把标记写进正文，就等于替适配器承认「前缀会入库」，2.5-08 的断言会当场失效。
 * @param index 容器序号
 * @param overrides 需要改动的字段：给 `null` 表示该字段读不到
 * @returns 一行抽取读数（帧地址固定为 `chatUrlOf('1001')`，会话侧用例不看它）
 */
export function messageRow(
  index: number,
  overrides: Partial<Record<'text' | 'externalId' | 'direction', string | null>> = {},
): ExtractRowReading {
  const url = chatUrlOf('1001');
  const text = overrides.text === null ? fieldMiss('text') : fieldHit('text', overrides.text ?? '方便聊聊吗');
  const externalId =
    overrides.externalId === null
      ? fieldMiss('externalId')
      : fieldHit('externalId', '', overrides.externalId ?? `reply-${String(index)}`);
  const direction =
    overrides.direction === null ? fieldMiss('direction') : fieldHit('direction', '', overrides.direction ?? 'inbound');
  return rowOf(index, url, [text, externalId, direction]);
}

/**
 * 造一份会话页脚本（状态行与消息条各按自己的容器身份回话）。
 * @param pack 知识包（三条定位声明都从它取，用例因此仍然「代码里没有选择器」）
 * @param status 状态行正文；给 `null` 表示这一行读不到（页面没渲染或定位失配）
 * @param messages 消息条的行
 * @returns 只服务会话页的假手脚本
 */
export function chatScript(pack: KnowledgePack, status: string | null, messages: ExtractRowReading[] = []): PageScript {
  const url = chatUrlOf('1001');
  return {
    listContainer: pack.locators.jobCard!,
    list: [],
    detail: [],
    chat: {
      statusContainer: pack.locators.chatStatus!,
      status: extractOf(url, status === null ? [] : [rowOf(0, url, [fieldHit('status', status)])]),
      messageContainer: pack.locators.replyItem!,
      messages: extractOf(url, messages),
    },
  };
}

/**
 * 造一份投递页脚本（只有状态行这一处读数，按次序回传）。
 * @param pack 知识包（投递段的定位名从它取，用例里仍然不出现选择器）
 * @param statuses 依次回传的状态行正文；`null` 表示那一行读不到
 * @returns 只服务投递页的假手脚本
 */
export function deliverScript(pack: KnowledgePack, statuses: (string | null)[]): PageScript {
  return {
    listContainer: pack.locators.jobCard!,
    list: [],
    detail: [],
    deliver: { statusContainer: pack.locators.resumeDeliverStatus!, statuses },
  };
}
