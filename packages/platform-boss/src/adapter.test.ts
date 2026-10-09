/**
 * BOSS 适配器的抓取用例（spec 2.2-06 的空壳 → 2.3-01 / 2.3-02 / 2.3-03 的落地）。
 *
 * 这里验的是四件事：
 * 1. **抓取请求的形状全部来自知识包**（用例断言 `extract` 收到的容器对象就是 `pack.locators.jobCard`
 *    那一个实例）——代码里若混进一条写死的选择器，这条断言立刻对不上；
 * 2. **页面读数按「不可信」处理**：缺标题或缺详情页地址的行不进列表，相对 href 按那一行的帧地址折算；
 * 3. **打招呼的 `sent` 由页面回读说了算**（spec 2.5-06）：三段判据少任何一段都返回 `sent:false`，
 *    而等待必须起在点击之前——基线晚于点击就永远读不到文本变化；
 * 4. **读回复是页面全量**（spec 2.5-07）：稳定 id 原样带回、正文为空的行不算消息；
 * 5. **投递的四段判据都在页面回读上**（spec 2.6-04 / 2.6-07）：已下架先抛错且一个动作都不做，
 *    文件名回读不符就不点确认按钮，成功样式由知识包声明——任何一段不成立都不是 `sent:true`。
 * 假手替身见 `test-doubles.ts`；测试不访问真实平台（AGENTS.md §7.2）。
 */
import { AppError, asApp, Context, NO_CONFIG, type Fiber } from '@auto-cc/core';
import type { ExtractRowReading } from '@auto-cc/shared';
import type { PlatformAdapter } from '@auto-cc/plugin-browser';
import { PlatformRegistryService } from '@auto-cc/plugin-browser';
import type { JobDetail, JobSummary, KnowledgePack } from '@auto-cc/plugin-browser';
import { afterAll, describe, expect, it } from 'vitest';
import { createBossAdapter, resolveDetailUrl, type BossActionHand, type BossPageHand } from './adapter.js';
import { BossPlatformService, loadBossKnowledgePack } from './index.js';
import {
  cardRow,
  chatScript,
  chatUrlOf,
  conversationRow,
  createFakeAct,
  createFakePage,
  deliverScript,
  deliverUrlOf,
  detailRow,
  extractOf,
  fieldHit,
  fieldMiss,
  LIST_URL,
  messageRow,
  rowOf,
  StubBrowserActService,
  StubBrowserPageService,
  type ActScript,
  type FakeAct,
  type FakePage,
  type PageScript,
} from './test-doubles.js';

// 本文件**缺省**打在本地仿站那份知识包上（AGENTS.md §7.2）：自 P8 8.1 起缺省是**上线包**（真 BOSS），
// 漏写就会让单测去断言真站点的类名。唯一的例外是「按会话坐标选中联系人」那一组——会话列表那一双定位
// 只在真包登记（仿站页没有那一屏，它靠 `targetParam` 直接拼地址），而那组仍然打假手、一次网络都不发。
const pack = loadBossKnowledgePack({ pack: 'fixture' });
const fibers: Fiber[] = [];

/**
 * 投递用例共用的简历附件（编排层已校验存在 / pdf / 大小上限并算好 sha256 的四要素）。
 *
 * 适配器不重复校验，只照它注入；8.1-04 那组也要拿同一份去敲 `sendResume`，所以放在模块级而不是
 * 某个 describe 里各写一遍（AGENTS.md §2.2）。
 */
const RESUME = {
  path: '/tmp/resume-2026.pdf',
  fileName: 'resume-2026.pdf',
  sizeBytes: 204800,
  sha256: 'a'.repeat(64),
};

/**
 * 用一份读数脚本造适配器（连同两只假手，用例可以回头看调用记录）。
 * @param script 页面读数脚本
 * @param actScript 动作脚本（敲字回读值、等待结局、点击是否失败）
 * @param packIn 知识包（缺省是仿站那份；8.1-04 的用例要递一份把某条定位标成 `unverified` 的包）
 * @returns 适配器、假页面手与假动作手
 */
function withScript(
  script: PageScript,
  actScript: ActScript = {},
  packIn: KnowledgePack = pack,
): { adapter: PlatformAdapter; page: FakePage; act: FakeAct } {
  const page = createFakePage(script);
  const act = createFakeAct(actScript);
  return { adapter: createBossAdapter(packIn, page, act), page, act };
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

  it('meta 完全来自知识包：标识、显示名、起始地址、许可源集合与能力集', () => {
    expect(adapter.meta).toEqual({
      id: 'boss',
      displayName: 'BOSS 直聘（本地仿站）',
      startUrl: LIST_URL,
      // 导航许可的唯一来源是知识包登记的 origins（P8 8.1-05），不是 startUrl 折算出来的那一个源。
      origins: ['http://127.0.0.1:10233'],
      capabilities: ['search', 'detail', 'chat', 'sendResume', 'readReplies'],
    });
  });

  it('meta.capabilities 是拷贝，知识包对象后续被改也不影响已登记的读数', () => {
    pack.capabilities.push('search');
    expect(adapter.meta.capabilities).toHaveLength(5);
    pack.capabilities.pop();
  });

  it('风控文案判据从知识包那一段原样带出（spec 2.7-01：这句话在 JSON 里，不在代码里）', () => {
    // 直接对着 JSON 断言：站点把拦下页那句话改了措辞，改的应该是 `boss.json` 而不是这里。
    expect(adapter.risk).toEqual({ pattern: pack.risk!.riskPattern });
  });

  it('知识包缺 risk 段时如实回 null：观测层据此只按状态码判，代码不猜文案', () => {
    const bare = createBossAdapter({ ...pack, risk: undefined }, createFakePage(standardScript()), createFakeAct({}));
    expect(bare.risk).toBeNull();
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

describe('打招呼：sent 由页面回读说了算（spec 2.5-06）', () => {
  const TEXT = '您好，我对这个岗位很感兴趣 🙂';

  it('三段判据齐全才判发出，并说清回读到了什么', async () => {
    const { adapter, page, act } = withScript(chatScript(pack, '第 3 条已送达服务端'));
    const result = await adapter.chat({ jobId: '1001' }, TEXT);
    expect(result).toEqual({
      sent: true,
      reason: expect.stringContaining('已送达服务端'),
      ledgerKey: null,
    });
    // 目标地址由 `chat.targetParam` 拼出来：不同 jobId 落在不同会话线程上。
    expect(page.navigated).toEqual([chatUrlOf('1001')]);
    // 外发那两只拿到的不是知识包里的那个对象，而是**筛过候选的那一份拷贝**（`outboundLocator`）：
    // 内容与声明一致，未取证的候选不在里面（spec 8.1-04）。所以这里断言相等而不是同一。
    expect(act.typed[0]!.spec).toEqual(pack.locators.chatInput);
    expect(act.typed[0]!.text).toBe(TEXT);
    expect(act.clicked[0]!.spec).toEqual(pack.locators.chatSendButton);
    // 等待必须起在点击**之前**：基线取的是脚本启动那一刻的文本，点完再等永远读不到变化。
    expect(act.waitedFor[0]!.spec).toBe(pack.locators.chatStatus);
    expect(act.waitsAtClick).toEqual([1]);
  });

  it('输入框回读与发出文本不一致时不发点击，直接判没发出', async () => {
    const { adapter, act } = withScript(chatScript(pack, '第 3 条已送达服务端'), {
      typedValue: '您好，我对这个岗位很感',
    });
    const result = await adapter.chat({ jobId: '1001' }, TEXT);
    expect(result.sent).toBe(false);
    expect(result.reason).toContain('输入框回读');
    // 一个点击都不该发生：字没进对，点发送只会发出一条半截话。
    expect(act.clicked).toEqual([]);
    expect(act.waitsStarted).toBe(0);
  });

  it('状态行变了但不含知识包声明的成功样式 → sent:false', async () => {
    const { adapter } = withScript(chatScript(pack, '第 3 条已发送，等待对方回复'));
    const result = await adapter.chat({ jobId: '1001' }, TEXT);
    expect(result).toEqual({ sent: false, reason: expect.stringContaining('不含成功样式'), ledgerKey: null });
  });

  it('状态行在超时窗口内没有变化 → sent:false 并如实报出等了多久', async () => {
    const { adapter } = withScript(chatScript(pack, null), { waitStatus: 'timeout', waitedMs: 5000 });
    const result = await adapter.chat({ jobId: '1001' }, TEXT);
    expect(result.sent).toBe(false);
    expect(result.reason).toContain('5000ms 内状态行没有变化');
  });

  it('正文为空时结构化失败，一个页面动作都不发', async () => {
    const { adapter, page, act } = withScript(chatScript(pack, '第 3 条已送达服务端'));
    await expect(adapter.chat({ jobId: '1001' }, '   ')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      path: 'platform.boss',
    });
    expect(page.navigated).toEqual([]);
    expect(act.typed).toEqual([]);
  });

  it('目标为空时同样拒绝——空 jobId 会拼出一个「谁的会话都不是」的地址', async () => {
    const { adapter, page } = withScript(chatScript(pack, '第 3 条已送达服务端'));
    await expect(adapter.chat({ jobId: '' }, TEXT)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(page.navigated).toEqual([]);
  });

  it('知识包没有 chat 段时拒绝打招呼，而不是拿空定位去点', async () => {
    const withoutChat: KnowledgePack = { ...pack, chat: undefined };
    const adapter = createBossAdapter(withoutChat, createFakePage(standardScript()), createFakeAct());
    await expect(adapter.chat({ jobId: '1001' }, TEXT)).rejects.toMatchObject({
      code: 'KNOWLEDGE_PACK_INVALID',
      message: expect.stringContaining('chat 段'),
    });
    await expect(adapter.readReplies({ jobId: '1001' })).rejects.toMatchObject({ code: 'KNOWLEDGE_PACK_INVALID' });
  });
});

describe('读回复：页面全量读 + 稳定 id（spec 2.5-07、2.5-08）', () => {
  it('抽取请求的容器、属性名与「读自身」全部来自知识包', async () => {
    const { adapter, page } = withScript(chatScript(pack, null, [messageRow(0)]));
    await adapter.readReplies({ jobId: '1001' });
    const request = page.requests.at(-1)!;
    expect(request.container).toBe(pack.locators.replyItem);
    expect(request.fields.map((field) => field.name)).toEqual(['text', 'externalId', 'direction']);
    // 正文是「读容器里面的正文节点」（scope 缺省即 subtree），候选来自知识包声明的定位名；
    // id 与方向是容器自身的属性，所以三者三种读法。
    expect(request.fields[0]!.candidates).toBe(pack.locators.chatMessageBody!.candidates);
    expect(request.fields[0]!.scope).toBeUndefined();
    expect(request.fields.slice(1).every((field) => field.scope === 'self')).toBe(true);
    expect(request.fields[1]!.attribute).toBe('data-message-id');
    expect(request.fields[2]!.attribute).toBe('data-direction');
  });

  it('方向按 inboundValue 判定，正文与稳定 id 原样带回', async () => {
    const { adapter } = withScript(
      chatScript(pack, null, [
        messageRow(0),
        messageRow(1, { direction: 'outbound' }),
        messageRow(2, { text: '方便，请问期望薪资？', direction: 'outbound' }),
      ]),
    );
    const messages = await adapter.readReplies({ jobId: '1001' });
    expect(messages.map((message) => message.from)).toEqual(['recruiter', 'self', 'self']);
    expect(messages[0]).toMatchObject({
      platform: 'boss',
      jobId: '1001',
      text: '方便聊聊吗',
      externalId: 'reply-0',
    });
    expect(messages[2]!.text).toBe('方便，请问期望薪资？');
    // 全量读：页面上有几条就回几条，不做「只回新消息」的裁剪（裁剪是会话库的去重职责）。
    expect(messages).toHaveLength(3);
  });

  it('页面没带稳定 id 时 externalId 为 null，交给库按方向+正文去重', async () => {
    const { adapter } = withScript(chatScript(pack, null, [messageRow(0, { externalId: null })]));
    const [message] = await adapter.readReplies({ jobId: '1001' });
    expect(message!.externalId).toBeNull();
  });

  it('正文为空的行不算消息（分割线与引导气泡），一条都没有是空数组而不是失败', async () => {
    const { adapter } = withScript(
      chatScript(pack, null, [messageRow(0, { text: null }), messageRow(1, { text: '' })]),
    );
    expect(await adapter.readReplies({ jobId: '1001' })).toEqual([]);
  });

  it('每次读都先导航到该目标的会话页（不同 jobId 不会读到同一个线程）', async () => {
    const { adapter, page } = withScript(chatScript(pack, null, [messageRow(0)]));
    await adapter.readReplies({ jobId: '1001' });
    await adapter.readReplies({ jobId: '2002' });
    expect(page.navigated).toEqual([chatUrlOf('1001'), chatUrlOf('2002')]);
  });
});

describe('按会话坐标选中联系人（spec 8.4-02，P8 裁定⑲ 的会话面寻址）', () => {
  // 这一组打在**上线知识包**的声明上，但两只手仍然是假的（`withScript` 造的 `createFakePage` /
  // `createFakeAct`）：会话列表那一双定位只在真包里登记（仿站页没有那一屏），而 AGENTS.md §7.2 禁的是
  // 访问真实平台，不是读一份 JSON 声明。整组用例一次网络都不发。
  const realPack = loadBossKnowledgePack({ pack: 'real' });
  /** 会话列表的三行读数（第 2 行带首尾空格，用来验比对前两边都折叠过空白）。 */
  const companyRows = (): ExtractRowReading[] => [
    conversationRow(0, '甲公司'),
    conversationRow(1, '乙公司'),
    conversationRow(2, '  丙公司  '),
  ];

  it('选中成功：等行出现 → 按标签那一格读 → 按命中序号点那一格，且绝不拼岗位地址', async () => {
    const { adapter, page, act } = withScript(chatScript(realPack, null, [messageRow(0)], companyRows()), {}, realPack);
    const messages = await adapter.readReplies({ conversationTarget: '丙公司' });
    // 会话坐标这一路只打开**入口页**：真包没有 `chat.targetParam`，所以既不会拼 `targetId=`，
    // 也绝不把联系人名字当岗位参数塞进地址（那是"谁的会话"两回事）。
    expect(page.navigated).toHaveLength(1);
    expect(page.navigated[0]).not.toContain('targetId');
    expect(page.navigated[0]).not.toContain('丙公司');
    expect(act.waitedFor[0]).toEqual({ kind: 'appear', spec: realPack.locators.chatConversationRow });
    // 读的是标签那一格（`scope:'self'`），不是整行——整行文本是「角标+时间+姓名+公司+职位+末句」的拼接。
    const request = page.requests[0]!;
    expect(request.container).toEqual(realPack.locators.chatConversationLabel);
    expect(request.fields).toEqual([{ name: 'target', candidates: [], scope: 'self' }]);
    // 点击带的是**索引寻址**：候选序号 0（标签声明只有一条候选）+ 命中行序号 + 期望文本。
    expect(act.clicked[0]!.spec).toEqual(realPack.locators.chatConversationLabel);
    expect(act.clicked[0]!.target).toEqual({ candidateIndex: 0, hitIndex: 2, expectText: '丙公司' });
    // 落库两侧的形状：会话坐标那一路填 conversationTarget，岗位格如实留 null（裁定⑲）。
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ jobId: null, conversationTarget: '丙公司' });
  });

  it('列表里没有那一条时停下：不点、也不读当前选中的那条', async () => {
    const { adapter, page, act } = withScript(chatScript(realPack, null, [messageRow(0)], companyRows()), {}, realPack);
    const error = asErr(await adapter.readReplies({ conversationTarget: '丁公司' }).catch((reason: unknown) => reason));
    expect(error.code).toBe('CONVERSATION_TARGET_NOT_FOUND');
    expect(error.details).toMatchObject({ conversationTarget: '丁公司', matched: 0, rows: 3, truncated: false });
    expect(act.clicked).toEqual([]);
    // 消息条根本没读：退化成"读页面当前选中的那条"会把上一个联系人的话记到这一行名下。
    expect(page.kinds).toEqual(['conversation']);
  });

  it('同一家公司的两个联系人撞成同名时同样停下（认不出该选哪一条就不点）', async () => {
    const { adapter, act } = withScript(
      chatScript(realPack, null, [messageRow(0)], [conversationRow(0, '甲公司'), conversationRow(1, '甲公司')]),
      {},
      realPack,
    );
    const error = asErr(await adapter.readReplies({ conversationTarget: '甲公司' }).catch((r: unknown) => r));
    expect(error.code).toBe('CONVERSATION_TARGET_NOT_FOUND');
    expect(error.details).toMatchObject({ matched: 2, rows: 2 });
    expect(act.clicked).toEqual([]);
  });

  it('标签声明有多条候选时整条停手：抽取行的序号不等于任何一条的命中序号', async () => {
    const label = realPack.locators.chatConversationLabel!;
    const doubled: KnowledgePack = {
      ...realPack,
      locators: {
        ...realPack.locators,
        chatConversationLabel: { ...label, candidates: [label.candidates[0]!, label.candidates[0]!] },
      },
    };
    const { adapter, page, act } = withScript(chatScript(realPack, null, [messageRow(0)], companyRows()), {}, doubled);
    const error = asErr(await adapter.readReplies({ conversationTarget: '甲公司' }).catch((r: unknown) => r));
    expect(error.code).toBe('LOCATE_SPEC_INVALID');
    expect(error.details).toEqual({ platform: 'boss', locator: 'chatConversationLabel' });
    // 停在门口：连「等列表出现」都没起，更没点过任何东西。
    expect(act.waitedFor).toEqual([]);
    expect(act.clicked).toEqual([]);
    expect(page.kinds).toEqual([]);
  });

  it('打招呼也先选行：选中之后才敲字、点发送', async () => {
    const { adapter, page, act } = withScript(
      chatScript(realPack, '第 3 条[送达]', [messageRow(0)], companyRows()),
      {},
      realPack,
    );
    const outcome = await adapter.chat({ conversationTarget: '乙公司' }, '您好 🙂');
    expect(outcome).toMatchObject({ sent: true, ledgerKey: null });
    expect(act.clicked.map((call) => call.spec)).toEqual([
      realPack.locators.chatConversationLabel,
      realPack.locators.chatSendButton,
    ]);
    expect(act.clicked[0]!.target).toEqual({ candidateIndex: 0, hitIndex: 1, expectText: '乙公司' });
    // 入口页只开一次（选行那一步开的），发送那一步不再导航。
    expect(page.navigated).toHaveLength(1);
    expect(page.navigated[0]).not.toContain('targetId');
  });

  it('两种坐标都没给 → INVALID_ARGUMENT；仿站包没声明这一双定位 → KNOWLEDGE_PACK_INVALID', async () => {
    const { adapter, page, act } = withScript(chatScript(realPack, null, [messageRow(0)], companyRows()), {}, realPack);
    await expect(adapter.readReplies({})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(adapter.chat({ conversationTarget: '   ' }, '您好')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(page.navigated).toEqual([]);
    expect(act.clicked).toEqual([]);
    // 仿站包只声明了 `targetParam` 那一路：拿会话坐标去打它是以"这条包不能按会话寻址"失败的，
    // 而不是静默按岗位名去拼地址。
    const fixtureAdapter = withScript(chatScript(pack, null, [messageRow(0)]), {}).adapter;
    await expect(fixtureAdapter.readReplies({ conversationTarget: '甲公司' })).rejects.toMatchObject({
      code: 'KNOWLEDGE_PACK_INVALID',
    });
  });
});

describe('投递：四段判据全由页面回读决定（spec 2.6-04 / 2.6-07）', () => {
  it('成功那条：导航到投递页 → 注文件 → 点击前先起等待 → 状态行回读到成功样式', async () => {
    // 两次读状态行：第一次是「还在不在招」，第二次是「点完以后变成了什么」。
    const { adapter, page, act } = withScript(deliverScript(pack, ['等待投递', '简历已送达，等待回复']));
    const outcome = await adapter.sendResume('1001', RESUME);
    expect(outcome).toEqual({
      sent: true,
      reason: '状态行回读到成功样式「简历已送达」：简历已送达，等待回复',
      ledgerKey: null,
    });
    expect(page.navigated).toEqual([deliverUrlOf('1001')]);
    // 外发定位是 `outboundLocator` 筛过候选的那一份拷贝（内容与声明一致，因为仿站包没有未取证候选）：
    // 所以断言用 `toEqual`；代码里若混进一条写死的选择器，它立刻对不上。
    expect(act.uploaded).toEqual([{ spec: pack.locators.resumeUploadInput, filePath: RESUME.path }]);
    expect(act.uploaded[0]!.spec).toEqual(pack.locators.resumeUploadInput);
    expect(act.waitedFor).toEqual([{ kind: 'textChanges', spec: pack.locators.resumeDeliverStatus }]);
    expect(act.clicked.map((call) => call.spec)).toEqual([pack.locators.resumeSendButton]);
    // 时序判据（与打招呼同一条）：等待必须起在点击之前，否则基线就是点击后的文本，永远等不到变化。
    expect(act.waitsAtClick).toEqual([act.waitsStarted]);
  });

  it('文件控件回读到的文件名与附件不一致 → sent:false 且不再点确认（防「定位到 A、文件塞进 B」）', async () => {
    const { adapter, act } = withScript(deliverScript(pack, ['等待投递']), { uploadedName: 'other-candidate.pdf' });
    const outcome = await adapter.sendResume('1001', RESUME);
    expect(outcome).toMatchObject({
      sent: false,
      reason: '文件控件回读到的文件名与附件不一致：页面「other-candidate.pdf」/ 附件「resume-2026.pdf」',
    });
    expect(act.clicked).toEqual([]);
    expect(act.waitsStarted).toBe(0);
  });

  it('页面根本没收到文件（回读空名）同样判 sent:false，不猜成成功', async () => {
    const { adapter } = withScript(deliverScript(pack, ['等待投递']), { uploadedName: '' });
    expect(await adapter.sendResume('1001', RESUME)).toMatchObject({ sent: false });
  });

  it('状态行回读到「已下架」→ DELIVER_TARGET_OFFLINE，且一个动作都不做（spec 2.6-07）', async () => {
    const { adapter, page, act } = withScript(deliverScript(pack, ['该岗位已下架，简历不会送达']));
    const error = asErr(await adapter.sendResume('1001', RESUME).catch((reason: unknown) => reason));
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('DELIVER_TARGET_OFFLINE');
    expect(error.path).toBe('platform.boss');
    expect(error.details).toEqual({ jobId: '1001', status: '该岗位已下架，简历不会送达' });
    // 只有「导航 + 读一次状态行」：下架的页面不该被注文件、也不该被点按钮。
    expect(page.navigated).toEqual([deliverUrlOf('1001')]);
    expect(page.kinds).toEqual(['deliver-status']);
    expect(act.uploaded).toEqual([]);
    expect(act.clicked).toEqual([]);
  });

  it('知识包没登记下架文案时跳过预校验，但结局里如实写明「这一条没做在招校验」（裁定㉒）', async () => {
    // 真 BOSS 那次在场没有下架样本（证据 8.0-06 第三节），所以上线包在这一格是缺的——缺的语义是
    // 「判不了」，不是「默认在招」：这句话必须随结局走，界面与账本才读得到。
    const noOffline: KnowledgePack = { ...pack, deliver: { ...pack.deliver!, offlinePattern: undefined } };
    const { adapter, act } = withScript(deliverScript(noOffline, ['等待投递', '简历已送达，等待回复']), {}, noOffline);
    const outcome = await adapter.sendResume('1001', RESUME);
    expect(outcome.sent).toBe(true);
    expect(outcome.reason).toContain('下架文案未登记：这一条没做在招校验');
    expect(act.uploaded).toHaveLength(1);
  });

  it('缺判据时页面那句话写着「已下架」也不抛 DELIVER_TARGET_OFFLINE：没有凭据就不猜（裁定㉒ 的负腿）', async () => {
    // 这一条钉的是"缺 offlinePattern 时代码自己编一句判据"这条路：文案是站点知识，
    // 拿仿站那句「岗位已下架」去真页面上撞，撞中了就是拿假凭据拦下一次真投递。
    const noOffline: KnowledgePack = { ...pack, deliver: { ...pack.deliver!, offlinePattern: undefined } };
    const { adapter, act } = withScript(
      deliverScript(noOffline, ['该岗位已下架，简历不会送达', '该岗位已下架，简历不会送达']),
      {},
      noOffline,
    );
    const outcome = await adapter.sendResume('1001', RESUME);
    expect(outcome.sent).toBe(false);
    expect(outcome.reason).toContain('不含成功样式');
    expect(outcome.reason).toContain('下架文案未登记');
    // 仍然走完四段判据（注文件、起等待、点确认），只是没有下架这一道门。
    expect(act.uploaded).toHaveLength(1);
    expect(act.clicked).toHaveLength(1);
  });

  it('状态行变了但不含成功样式 → sent:false 并写明读到的是哪句', async () => {
    const { adapter } = withScript(deliverScript(pack, ['等待投递', '请先与招聘者沟通']));
    expect(await adapter.sendResume('1001', RESUME)).toMatchObject({
      sent: false,
      reason: '状态行文本变了但不含成功样式：请先与招聘者沟通',
    });
  });

  it('点击后状态行没变化（等待超时）→ sent:false 并带上等待毫秒', async () => {
    const { adapter } = withScript(deliverScript(pack, ['等待投递', '等待投递']), {
      waitStatus: 'timeout',
      waitedMs: 8000,
    });
    expect(await adapter.sendResume('1001', RESUME)).toMatchObject({
      sent: false,
      reason: '点击后 8000ms 内状态行没有变化：等待投递',
    });
  });

  it('状态行读不到（一行都没有）→ sent:false，写成「读不到状态行」而不是猜', async () => {
    const { adapter } = withScript(deliverScript(pack, ['等待投递', null]));
    expect(await adapter.sendResume('1001', RESUME)).toMatchObject({
      sent: false,
      reason: '状态行文本变了但不含成功样式：（读不到状态行）',
    });
  });

  it('知识包缺 deliver 段 → KNOWLEDGE_PACK_INVALID，页面一次都不碰', async () => {
    const page = createFakePage(deliverScript(pack, ['等待投递']));
    const act = createFakeAct();
    const bare = createBossAdapter({ ...pack, deliver: undefined }, page, act);
    const error = asErr(await bare.sendResume('1001', RESUME).catch((reason: unknown) => reason));
    expect(error.code).toBe('KNOWLEDGE_PACK_INVALID');
    expect(error.details).toEqual({ platform: 'boss' });
    expect(page.navigated).toEqual([]);
    expect(act.uploaded).toEqual([]);
  });

  it('缺 jobId → INVALID_ARGUMENT，不导航也不注文件', async () => {
    const { adapter, page, act } = withScript(deliverScript(pack, ['等待投递']));
    const error = asErr(await adapter.sendResume('   ', RESUME).catch((reason: unknown) => reason));
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(page.navigated).toEqual([]);
    expect(act.uploaded).toEqual([]);
  });

  it('注入自身的失败（定位失配 / 回读不符）原样上浮，不吞成 sent:false', async () => {
    const { adapter } = withScript(deliverScript(pack, ['等待投递']), {
      uploadError: new AppError('LOCATE_FAILED', '候选打分全部低于阈值', 'browser.act', { name: 'resumeUploadInput' }),
    });
    const error = asErr(await adapter.sendResume('1001', RESUME).catch((reason: unknown) => reason));
    expect(error.code).toBe('LOCATE_FAILED');
  });
});

describe('未取证定位：外发停手、读取照试（spec 8.1-04）', () => {
  /**
   * 把某条定位的前若干条候选标成「未取证」，得到一份只服务本组用例的包。
   * @param name 定位语义名
   * @param count 标几条；省略表示整条定位一条证据都没有
   * @returns 新的知识包（浅拷贝 `locators`：模块级那份被其他用例共用，不许就地改）
   */
  const packWithUnverified = (name: string, count?: number): KnowledgePack => {
    const spec = pack.locators[name]!;
    return {
      ...pack,
      locators: {
        ...pack.locators,
        [name]: {
          ...spec,
          candidates: spec.candidates.map((candidate, index) =>
            count === undefined || index < count ? { ...candidate, unverified: true } : candidate,
          ),
        },
      },
    };
  };

  it('发送键一条证据都没有 → LOCATOR_UNVERIFIED，连会话页都不打开', async () => {
    const { adapter, page, act } = withScript(
      chatScript(pack, '第 3 条已送达服务端'),
      {},
      packWithUnverified('chatSendButton'),
    );
    const error = asErr(await adapter.chat({ jobId: '1001' }, '您好').catch((reason: unknown) => reason));
    expect(error.code).toBe('LOCATOR_UNVERIFIED');
    expect(error.path).toBe('platform.boss');
    expect(error.message).toContain('没有一条已取证的候选');
    expect(error.details).toEqual({ platform: 'boss', locator: 'chatSendButton' });
    // 「不发起任何动作」含导航：一条没取证的候选就足以让整次外发不该发生（spec 8.1-04）。
    expect(page.navigated).toEqual([]);
    expect(page.kinds).toEqual([]);
    expect(act.typed).toEqual([]);
    expect(act.clicked).toEqual([]);
    expect(act.waitsStarted).toBe(0);
  });

  it('输入框未取证同样整条停手：另一半还能用也不许发出去半截话', async () => {
    const { adapter, page, act } = withScript(
      chatScript(pack, '第 3 条已送达服务端'),
      {},
      packWithUnverified('chatInput'),
    );
    const error = asErr(await adapter.chat({ jobId: '1001' }, '您好').catch((reason: unknown) => reason));
    expect(error.code).toBe('LOCATOR_UNVERIFIED');
    expect(error.details).toEqual({ platform: 'boss', locator: 'chatInput' });
    expect(page.navigated).toEqual([]);
    expect(act.typed).toEqual([]);
  });

  it('只有部分候选未取证时，交给动作通道的声明里只剩已取证那几条，且原包一字未动', async () => {
    const bare = packWithUnverified('chatSendButton', 1);
    const { adapter, act } = withScript(chatScript(bare, '第 3 条已送达服务端'), {}, bare);
    expect(await adapter.chat({ jobId: '1001' }, '您好，我对这个岗位很感兴趣 🙂')).toMatchObject({ sent: true });
    const handed = act.clicked[0]!.spec;
    // 断言对象是**筛过的声明**（`LocateSpec` 的线上形状里没有取证那几个键，所以拿筛前那份去比）：
    // 交给动作通道的候选 = 声明里去掉被标未取证的那条。
    const declared = bare.locators.chatSendButton!.candidates;
    expect(handed.candidates).toEqual(declared.filter((candidate) => candidate.unverified !== true));
    expect(handed.candidates).toHaveLength(declared.length - 1);
    // 判定只作用于这一次外发要用的那份拷贝：知识包本身不能被测试改坏（第一条候选仍是已取证）。
    expect(pack.locators.chatSendButton!.candidates[0]!.unverified).toBeUndefined();
  });

  it('上传控件未取证 → LOCATOR_UNVERIFIED，不打开上传页也不读状态行', async () => {
    const { adapter, page, act } = withScript(
      deliverScript(pack, ['等待投递']),
      {},
      packWithUnverified('resumeUploadInput'),
    );
    const error = asErr(await adapter.sendResume('1001', RESUME).catch((reason: unknown) => reason));
    expect(error.code).toBe('LOCATOR_UNVERIFIED');
    expect(error.details).toEqual({ platform: 'boss', locator: 'resumeUploadInput' });
    expect(page.navigated).toEqual([]);
    expect(page.kinds).toEqual([]);
    expect(act.uploaded).toEqual([]);
  });

  it('抓取通道仍然试未取证的候选：读错一条只是少一条数据，不是撤不回来的动作', async () => {
    const bare = packWithUnverified('jobSalary');
    const { adapter, page } = withScript(standardScript(), {}, bare);
    const summaries = await adapter.search({ keyword: '前端' });
    // 候选列表原样递给了抽取（没有筛），并且薪资照常读回来了。
    expect(page.requests[0]!.fields.find((field) => field.name === 'salary')!.candidates).toBe(
      bare.locators.jobSalary!.candidates,
    );
    expect(summaries[0]!.salaryText).not.toBe('');
  });

  it('状态行属于读取通道：标了未取证也照样等、照样回读，sent 判据不受影响', async () => {
    const bare = packWithUnverified('chatStatus');
    const { adapter, act } = withScript(chatScript(bare, '第 3 条已送达服务端'), {}, bare);
    expect(await adapter.chat({ jobId: '1001' }, '您好，我对这个岗位很感兴趣 🙂')).toMatchObject({ sent: true });
    // 等待用的就是知识包那一个对象（未经筛选），这条是「读取通道不筛」的直接证据。
    expect(act.waitedFor[0]!.spec).toBe(bare.locators.chatStatus);
  });
});

describe('platform.boss 挂载即登记（spec 2.2-07）', () => {
  it('服务 init 把自己登记进 platform.registry，登记表按名取回的就是它', async () => {
    const ctx = new Context();
    const script = standardScript();
    const fake = createFakePage(script);
    // `browser.page` 与 `browser.act` 都是 `platform.boss` 的 inject 项：缺了任一，这个插件会停在
    // PENDING、init 根本不跑，所以这里挂两只替身（真实的那两只要 Electron）。
    fibers.push(await ctx.plugin(StubBrowserPageService, { fake }));
    fibers.push(await ctx.plugin(StubBrowserActService, { fake: createFakeAct() }));
    fibers.push(await ctx.plugin(PlatformRegistryService, NO_CONFIG));
    fibers.push(await ctx.plugin(BossPlatformService, { pack: 'fixture' }));
    const registry = asApp(ctx)['platform.registry'];
    expect(registry.list().platforms.map((platform) => platform.id)).toEqual(['boss']);
    expect(registry.get('boss').meta).toEqual(createBossAdapter(pack, fake, createFakeAct()).meta);
    // 登记进来的适配器直接能用：搜索 → 两条摘要，说明登记的正是接好了页面通道的那一份。
    const summaries: JobSummary[] = await registry.get('boss').search({ keyword: '前端' });
    expect(summaries.map((summary) => summary.jobId)).toEqual(['1001', '1002']);
    expect(() => registry.get('liepin')).toThrowError(/未登记的平台适配器/);
  });
});

describe('城市码换算进搜索地址（spec 8.3-05）', () => {
  /** 仿站包 + 一枚真站点坐实的城市码：只改这一处，好证明变的确实是地址上的那一个参数。 */
  const withCities = { ...pack, search: { ...pack.search, cities: { 上海: '101020100' } } };

  it('登记过的城市名在地址里换成站点码，而不是把人话原样塞进 URL', async () => {
    const { adapter, page } = withScript(standardScript(), {}, withCities);
    await adapter.search({ keyword: '前端工程师', city: '上海' });
    expect(new URL(page.navigated[0]!).searchParams.get('city')).toBe('101020100');
  });

  it('表非空却查不到这个名字时当场停下，一次导航都不发', async () => {
    // 把人话塞进真站点，它不报错，只是静默忽略这个参数按定位城市出结果——
    // "筛了上海"就成了谎话，而且是最难查的那种（列表确实长出来了）。
    const { adapter, page } = withScript(standardScript(), {}, withCities);
    const failure = await adapter.search({ keyword: '前端工程师', city: '杭州' }).catch((error: unknown) => error);
    expect(asErr(failure).code).toBe('INVALID_ARGUMENT');
    expect(page.navigated).toEqual([]);
  });
});

/** 把被拒的原因收成 `AppError`，好逐条断言码与 `details`（失败原因本身就是这条契约的一半）。 */
function asErr(error: unknown): AppError {
  return error as AppError;
}

describe('抽取之前先等容器长出来（spec 8.3-01）', () => {
  /**
   * 把两只假手包一层调用流水，为的是断言**先后**这一半契约（等排在抽之前才有意义）。
   * @param script 页面读数脚本
   * @param actScript 动作脚本（等待结局等）
   * @returns 适配器、两只假手与调用流水
   */
  function withCallLog(
    script: PageScript,
    actScript: ActScript = {},
  ): { adapter: PlatformAdapter; act: FakeAct; calls: string[] } {
    const calls: string[] = [];
    const page = createFakePage(script);
    const act = createFakeAct(actScript);
    const loggedPage: BossPageHand = {
      navigate: (url) => {
        calls.push('navigate');
        return page.navigate(url);
      },
      extract: (request) => {
        calls.push('extract');
        return page.extract(request);
      },
    };
    const loggedAct: BossActionHand = {
      type: (spec, text) => {
        calls.push('type');
        return act.type(spec, text);
      },
      click: (spec) => {
        calls.push('click');
        return act.click(spec);
      },
      waitFor: (predicate) => {
        calls.push(`wait:${predicate.kind}`);
        return act.waitFor(predicate);
      },
      upload: (spec, filePath) => {
        calls.push('upload');
        return act.upload(spec, filePath);
      },
    };
    return { adapter: createBossAdapter(pack, loggedPage, loggedAct), act, calls };
  }

  it('读列表：导航 → 等 appear → 抽取，等的是知识包那条容器声明', async () => {
    // 真站点的卡片是 load 之后再发一支 XHR 才长出来的（现场把这一格抽真空过：rounds=1 / containers=0 /
    // stoppedBy=no-new-content，而同一时刻页面里 `li.job-card-box` 实测 15 枚）。
    const { adapter, act, calls } = withCallLog(standardScript());
    await adapter.openSearch({ keyword: '前端' });
    const summaries = await adapter.readListing();
    expect(calls).toEqual(['navigate', 'wait:appear', 'extract']);
    expect(summaries).toHaveLength(2);
    expect(act.waitedFor).toEqual([{ kind: 'appear', spec: pack.locators.jobCard }]);
  });

  it('读详情：同样先等，等的是 detailRoot 那一条', async () => {
    const { adapter, act, calls } = withCallLog(standardScript());
    await adapter.search({ keyword: '前端' });
    calls.length = 0;
    const detail = await adapter.detail('1002');
    expect(detail.summary.jobId).toBe('1002');
    expect(calls).toEqual(['navigate', 'wait:appear', 'extract']);
    // 上面那次 `search` 已经为列表起过一轮等待，这里只看最近这一次等的是谁。
    expect(act.waitedFor).toHaveLength(2);
    expect(act.waitedFor[1]).toEqual({ kind: 'appear', spec: pack.locators.detailRoot });
  });

  it('等不到也照样抽：等待超时不是异常，结局由抽取读数说话（不许编一个"等到了"的假象）', async () => {
    const { adapter, calls } = withCallLog(
      { listContainer: pack.locators.jobCard!, list: [extractOf(LIST_URL, [])], detail: [] },
      { waitStatus: 'timeout' },
    );
    await adapter.openSearch({ keyword: '前端' });
    const summaries = await adapter.readListing();
    expect(summaries).toEqual([]);
    expect(calls).toEqual(['navigate', 'wait:appear', 'extract']);
  });
});
