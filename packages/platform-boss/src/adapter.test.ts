/**
 * BOSS 适配器的抓取用例（spec 2.2-06 的空壳 → 2.3-01 / 2.3-02 / 2.3-03 的落地）。
 *
 * 这里验的是三件事：
 * 1. **抓取请求的形状全部来自知识包**（用例断言 `extract` 收到的容器对象就是 `pack.locators.jobCard`
 *    那一个实例）——代码里若混进一条写死的选择器，这条断言立刻对不上；
 * 2. **页面读数按「不可信」处理**：缺标题或缺详情页地址的行不进列表，相对 href 按那一行的帧地址折算；
 * 3. **外发三个动作仍然是结构化失败**，并且各自说明等哪个子计划（2.5 / 2.6）。
 * 假手替身见 `test-doubles.ts`；测试不访问真实平台（AGENTS.md §7.2）。
 */
import { AppError, asApp, Context, NO_CONFIG, type Fiber } from '@auto-cc/core';
import type { PlatformAdapter } from '@auto-cc/plugin-browser';
import { PlatformRegistryService } from '@auto-cc/plugin-browser';
import type { JobDetail, JobSummary } from '@auto-cc/plugin-browser';
import { afterAll, describe, expect, it } from 'vitest';
import { createBossAdapter, resolveDetailUrl } from './adapter.js';
import { BossPlatformService, loadBossKnowledgePack } from './index.js';
import {
  cardRow,
  createFakePage,
  detailRow,
  extractOf,
  fieldHit,
  fieldMiss,
  LIST_URL,
  StubBrowserPageService,
  type PageScript,
  rowOf,
} from './test-doubles.js';

const pack = loadBossKnowledgePack();
const fibers: Fiber[] = [];

/**
 * 用一份读数脚本造适配器（连同它的假手，用例可以回头看调用记录）。
 * @param script 页面读数脚本
 * @returns 适配器与假手
 */
function withScript(script: PageScript): { adapter: PlatformAdapter; page: ReturnType<typeof createFakePage> } {
  const page = createFakePage(script);
  return { adapter: createBossAdapter(pack, page), page };
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
});

/** 一次「两卡片 + 两条详情」的标准脚本，多数用例从它出发。 */
const standardScript = (): PageScript => ({
  listContainer: pack.locators.jobCard!,
  list: [extractOf(LIST_URL, [cardRow(0, '1001'), cardRow(1, '1002')])],
  detail: [
    extractOf(`${LIST_URL}/detail?jobId=1001`, [detailRow('1001')]),
    extractOf(`${LIST_URL}/detail?jobId=1002`, [detailRow('1002')]),
  ],
});

describe('BOSS 适配器的自我声明（spec 2.2-06）', () => {
  const { adapter } = withScript(standardScript());

  it('meta 完全来自知识包：标识、显示名、起始地址与能力集', () => {
    expect(adapter.meta).toEqual({
      id: 'boss',
      displayName: 'BOSS 直聘',
      startUrl: LIST_URL,
      capabilities: ['search', 'detail', 'chat', 'sendResume', 'readReplies'],
    });
  });

  it('meta.capabilities 是拷贝，知识包对象后续被改也不影响已登记的读数', () => {
    pack.capabilities.push('search');
    expect(adapter.meta.capabilities).toHaveLength(5);
    pack.capabilities.pop();
  });
});

describe('搜索与列表读取（spec 2.3-01 / 2.3-02）', () => {
  it('搜索地址用知识包登记的参数名，而不是代码里写死的 query / city / experience', async () => {
    const { adapter, page } = withScript(standardScript());
    await adapter.search({ keyword: '前端工程师', city: '上海', experience: '3-5 年' });
    const params = new URL(page.navigated[0]!).searchParams;
    // 参数名来自 `boss.json` 的 `search.params`：换站点改的是那份 JSON。
    expect(params.get('query')).toBe('前端工程师');
    expect(params.get('city')).toBe('上海');
    expect(params.get('experience')).toBe('3-5 年');
  });

  it('只给关键词时不拼空的筛选参数（拼进去等于把站点默认的筛选条件改掉）', async () => {
    const { adapter, page } = withScript(standardScript());
    await adapter.search({ keyword: '前端工程师' });
    const params = new URL(page.navigated[0]!).searchParams;
    expect([...params.keys()]).toEqual(['query']);
  });

  it('抽取请求的容器与字段候选都是知识包里的对象本身（代码里没有任何选择器）', async () => {
    const { adapter, page } = withScript(standardScript());
    await adapter.search({ keyword: '前端' });
    const request = page.requests[0]!;
    expect(request.container).toBe(pack.locators.jobCard);
    const declared = pack.capture.list.fields;
    expect(request.fields.map((field) => field.name)).toEqual(declared.map((field) => field.name));
    expect(request.fields[0]!.candidates).toBe(pack.locators.jobTitle!.candidates);
    // 详情页地址是「同一个定位、取 href 属性」：列表卡片与标题共用一条声明。
    const hrefField = request.fields.find((field) => field.name === 'detailHref');
    expect(hrefField?.attribute).toBe('href');
    expect(hrefField?.candidates).toBe(pack.locators.jobTitle!.candidates);
  });

  it('卡片拍成摘要：字段原样带回，jobId 从详情页地址派生', async () => {
    const { adapter } = withScript(standardScript());
    const summaries = await adapter.search({ keyword: '前端' });
    expect(summaries[0]).toMatchObject({
      platform: 'boss',
      jobId: '1001',
      title: '资深前端工程师 1001',
      company: '示例科技',
      salaryText: '25-40K·15薪',
      city: '上海 · 浦东新区',
      experience: '3-5 年',
      education: '本科',
      detailUrl: `${LIST_URL}/detail?jobId=1001`,
    });
    expect(summaries).toHaveLength(2);
  });

  it('缺标题或缺详情页地址的行不进列表——幂等键缺一半就无法入库', async () => {
    const { adapter } = withScript({
      listContainer: pack.locators.jobCard!,
      list: [
        extractOf(LIST_URL, [
          cardRow(0, '2001', { title: null }),
          cardRow(1, '2002', { href: null }),
          cardRow(2, '2003'),
        ]),
      ],
      detail: [],
    });
    const summaries = await adapter.search({ keyword: '前端' });
    expect(summaries.map((summary) => summary.jobId)).toEqual(['2003']);
  });

  it('相对 href 按该行所在帧的地址折算，不用顶层地址', async () => {
    const frame = 'http://127.0.0.1:10233/embed/search';
    const { adapter } = withScript({
      listContainer: pack.locators.jobCard!,
      list: [
        extractOf(frame, [
          rowOf(0, frame, [fieldHit('title', '帧内岗位'), fieldHit('detailHref', '', '/boss/detail?jobId=3001')]),
        ]),
      ],
      detail: [],
    });
    const [summary] = await adapter.search({ keyword: '前端' });
    expect(summary!.detailUrl).toBe(`${LIST_URL}/detail?jobId=3001`);
  });

  it('readListing 可以反复调用，同一岗位在第二次读到同一个 jobId（滚动加载后读新一屏）', async () => {
    const { adapter, page } = withScript({
      listContainer: pack.locators.jobCard!,
      list: [
        extractOf(LIST_URL, [cardRow(0, '4001'), cardRow(1, '4002')]),
        extractOf(LIST_URL, [cardRow(0, '4001'), cardRow(1, '4002'), cardRow(2, '4003')]),
      ],
      detail: [],
    });
    await adapter.openSearch({ keyword: '前端' });
    const first = await adapter.readListing();
    const second = await adapter.readListing();
    expect(first.map((summary) => summary.jobId)).toEqual(['4001', '4002']);
    expect(second.map((summary) => summary.jobId)).toEqual(['4001', '4002', '4003']);
    // 两次抽取打在同一个已加载的列表页上：不该再导航一次。
    expect(page.navigated).toHaveLength(1);
  });

  it('关键词为空时结构化失败，不打开一个「默认搜索页」', async () => {
    const { adapter, page } = withScript(standardScript());
    await expect(adapter.openSearch({ keyword: '   ' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      path: 'platform.boss',
    });
    expect(page.navigated).toEqual([]);
  });
});

describe('详情页读取（spec 2.3-02 / 2.3-03）', () => {
  it('详情走「导航 → 按 detailRoot 抽取」，任职要求按分隔符拆条', async () => {
    const { adapter, page } = withScript(standardScript());
    await adapter.search({ keyword: '前端' });
    const detail = await adapter.detail('1002');
    expect(detail).toMatchObject({
      summary: { jobId: '1002', title: '资深前端工程师 1002' },
      description: '负责 1002 号岗位的招聘页面自动化抓取',
      requirements: ['3 年 TypeScript 经验', '熟悉 Electron 主进程', '能独立排障'],
      postedText: '3 天前',
    });
    expect(page.navigated.at(-1)).toBe(`${LIST_URL}/detail?jobId=1002`);
    const request = page.requests.at(-1)!;
    expect(request.container).toBe(pack.locators.detailRoot);
    expect(request.fields.map((field) => field.name)).toEqual(['description', 'requirement', 'posted']);
  });

  it('没读过的 jobId 报错而不是猜一个详情页地址', async () => {
    const { adapter, page } = withScript(standardScript());
    const error = asErr(await adapter.detail('9999').catch((reason: unknown) => reason));
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain('9999');
    expect(page.navigated).toEqual([]);
  });

  it('详情页一个容器都没读到 → PAGE_SCRIPT_FAILED，而不是返回半空对象', async () => {
    const { adapter } = withScript({
      listContainer: pack.locators.jobCard!,
      list: [extractOf(LIST_URL, [cardRow(0, '5001')])],
      detail: [extractOf(`${LIST_URL}/detail?jobId=5001`, [])],
    });
    await adapter.search({ keyword: '前端' });
    await expect(adapter.detail('5001')).rejects.toMatchObject({
      code: 'PAGE_SCRIPT_FAILED',
      message: expect.stringContaining('没有读到任何容器'),
    });
  });

  it('读不到岗位职责正文同样失败：正文是 2.7 简历定制的输入，不能留空混过去', async () => {
    const { adapter } = withScript({
      listContainer: pack.locators.jobCard!,
      list: [extractOf(LIST_URL, [cardRow(0, '5002')])],
      detail: [extractOf(`${LIST_URL}/detail?jobId=5002`, [detailRow('5002', { description: null })])],
    });
    await adapter.search({ keyword: '前端' });
    await expect(adapter.detail('5002')).rejects.toMatchObject({ code: 'PAGE_SCRIPT_FAILED' });
  });

  it('缺任职要求与发布时间时不失败：正文在、这两样读不到就带回空值', async () => {
    const { adapter } = withScript({
      listContainer: pack.locators.jobCard!,
      list: [extractOf(LIST_URL, [cardRow(0, '5003')])],
      detail: [
        extractOf(`${LIST_URL}/detail?jobId=5003`, [
          rowOf(0, `${LIST_URL}/detail?jobId=5003`, [
            fieldHit('description', '只有正文'),
            fieldMiss('requirement'),
            fieldMiss('posted'),
          ]),
        ]),
      ],
    });
    await adapter.search({ keyword: '前端' });
    const detail: JobDetail = await adapter.detail('5003');
    expect(detail).toMatchObject({ description: '只有正文', requirements: [], postedText: '' });
  });
});

describe('详情页地址解析（spec 2.3-02 的一半）', () => {
  it('相对地址按帧地址折算，jobId 优先取查询参数', () => {
    expect(resolveDetailUrl('/boss/detail?jobId=1001', 'http://127.0.0.1:10233/boss')).toEqual({
      url: 'http://127.0.0.1:10233/boss/detail?jobId=1001',
      jobId: '1001',
    });
  });

  it('没有 jobId 参数时用路径最后一段，整条路径都没有时用绝对地址本身', () => {
    expect(resolveDetailUrl('/job/88', LIST_URL)?.jobId).toBe('88');
    expect(resolveDetailUrl('/', LIST_URL)?.jobId).toBe('http://127.0.0.1:10233/');
  });

  it('空 href、非 http(s) 协议、拼不出地址都返回 null（这行不算一条岗位）', () => {
    expect(resolveDetailUrl('   ', LIST_URL)).toBeNull();
    expect(resolveDetailUrl('javascript:alert(1)', LIST_URL)).toBeNull();
    expect(resolveDetailUrl('http://127.0.0.1:10233/boss/detail?jobId=1', '不是地址')).toBeNull();
  });
});

describe('外发三个动作仍然未实现（spec 2.2-06 的归因表）', () => {
  const adapter = createBossAdapter(pack, createFakePage(standardScript()));
  const OUTBOUND: readonly (readonly [keyof typeof adapter, string, () => Promise<unknown>])[] = [
    ['chat', '2.5', () => adapter.chat('1001', '您好，我对这个岗位很感兴趣')],
    ['sendResume', '2.6', () => adapter.sendResume('1001')],
    ['readReplies', '2.5', () => adapter.readReplies('1001')],
  ];

  it.each(OUTBOUND)('%s 以 METHOD_NOT_FOUND 失败并说明由子计划 %s 交付', async (method, plan, call) => {
    const error = asErr(await call().catch((reason: unknown) => reason));
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('METHOD_NOT_FOUND');
    expect(error.path).toBe('platform.boss');
    expect(error.message).toContain(plan);
    expect(error.details).toEqual({ method, deliveredBy: plan });
  });
});

describe('platform.boss 挂载即登记（spec 2.2-07）', () => {
  it('服务 init 把自己登记进 platform.registry，登记表按名取回的就是它', async () => {
    const ctx = new Context();
    const script = standardScript();
    const fake = createFakePage(script);
    // `browser.page` 是 `platform.boss` 的 inject 项：缺了它这个插件会停在 PENDING、init 根本不跑，
    // 所以这里挂一只替身（真实的那只要 Electron）。
    fibers.push(await ctx.plugin(StubBrowserPageService, { fake }));
    fibers.push(await ctx.plugin(PlatformRegistryService, NO_CONFIG));
    fibers.push(await ctx.plugin(BossPlatformService, {}));
    const registry = asApp(ctx)['platform.registry'];
    expect(registry.list().platforms.map((platform) => platform.id)).toEqual(['boss']);
    expect(registry.get('boss').meta).toEqual(createBossAdapter(pack, fake).meta);
    // 登记进来的适配器直接能用：搜索 → 两条摘要，说明登记的正是接好了页面通道的那一份。
    const summaries: JobSummary[] = await registry.get('boss').search({ keyword: '前端' });
    expect(summaries.map((summary) => summary.jobId)).toEqual(['1001', '1002']);
    expect(() => registry.get('liepin')).toThrowError(/未登记的平台适配器/);
  });
});

/** 把被拒的原因收成 `AppError`，好逐条断言码与 `details`（失败原因本身就是这条契约的一半）。 */
function asErr(error: unknown): AppError {
  return error as AppError;
}
