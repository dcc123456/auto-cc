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
import type { PlatformAdapter } from '@auto-cc/plugin-browser';
import { PlatformRegistryService } from '@auto-cc/plugin-browser';
import type { JobDetail, JobSummary, KnowledgePack } from '@auto-cc/plugin-browser';
import { afterAll, describe, expect, it } from 'vitest';
import { createBossAdapter, resolveDetailUrl } from './adapter.js';
import { BossPlatformService, loadBossKnowledgePack } from './index.js';
import {
  cardRow,
  chatScript,
  chatUrlOf,
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

const pack = loadBossKnowledgePack();
const fibers: Fiber[] = [];

/**
 * 用一份读数脚本造适配器（连同两只假手，用例可以回头看调用记录）。
 * @param script 页面读数脚本
 * @param actScript 动作脚本（敲字回读值、等待结局、点击是否失败）
 * @returns 适配器、假页面手与假动作手
 */
function withScript(
  script: PageScript,
  actScript: ActScript = {},
): { adapter: PlatformAdapter; page: FakePage; act: FakeAct } {
  const page = createFakePage(script);
  const act = createFakeAct(actScript);
  return { adapter: createBossAdapter(pack, page, act), page, act };
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
    const result = await adapter.chat('1001', TEXT);
    expect(result).toEqual({
      sent: true,
      reason: expect.stringContaining('已送达服务端'),
      ledgerKey: null,
    });
    // 目标地址由 `chat.targetParam` 拼出来：不同 jobId 落在不同会话线程上。
    expect(page.navigated).toEqual([chatUrlOf('1001')]);
    expect(act.typed[0]!.spec).toBe(pack.locators.chatInput);
    expect(act.typed[0]!.text).toBe(TEXT);
    expect(act.clicked[0]).toBe(pack.locators.chatSendButton);
    // 等待必须起在点击**之前**：基线取的是脚本启动那一刻的文本，点完再等永远读不到变化。
    expect(act.waitedFor[0]!.spec).toBe(pack.locators.chatStatus);
    expect(act.waitsAtClick).toEqual([1]);
  });

  it('输入框回读与发出文本不一致时不发点击，直接判没发出', async () => {
    const { adapter, act } = withScript(chatScript(pack, '第 3 条已送达服务端'), {
      typedValue: '您好，我对这个岗位很感',
    });
    const result = await adapter.chat('1001', TEXT);
    expect(result.sent).toBe(false);
    expect(result.reason).toContain('输入框回读');
    // 一个点击都不该发生：字没进对，点发送只会发出一条半截话。
    expect(act.clicked).toEqual([]);
    expect(act.waitsStarted).toBe(0);
  });

  it('状态行变了但不含知识包声明的成功样式 → sent:false', async () => {
    const { adapter } = withScript(chatScript(pack, '第 3 条已发送，等待对方回复'));
    const result = await adapter.chat('1001', TEXT);
    expect(result).toEqual({ sent: false, reason: expect.stringContaining('不含成功样式'), ledgerKey: null });
  });

  it('状态行在超时窗口内没有变化 → sent:false 并如实报出等了多久', async () => {
    const { adapter } = withScript(chatScript(pack, null), { waitStatus: 'timeout', waitedMs: 5000 });
    const result = await adapter.chat('1001', TEXT);
    expect(result.sent).toBe(false);
    expect(result.reason).toContain('5000ms 内状态行没有变化');
  });

  it('正文为空时结构化失败，一个页面动作都不发', async () => {
    const { adapter, page, act } = withScript(chatScript(pack, '第 3 条已送达服务端'));
    await expect(adapter.chat('1001', '   ')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      path: 'platform.boss',
    });
    expect(page.navigated).toEqual([]);
    expect(act.typed).toEqual([]);
  });

  it('目标为空时同样拒绝——空 jobId 会拼出一个「谁的会话都不是」的地址', async () => {
    const { adapter, page } = withScript(chatScript(pack, '第 3 条已送达服务端'));
    await expect(adapter.chat('', TEXT)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(page.navigated).toEqual([]);
  });

  it('知识包没有 chat 段时拒绝打招呼，而不是拿空定位去点', async () => {
    const withoutChat: KnowledgePack = { ...pack, chat: undefined };
    const adapter = createBossAdapter(withoutChat, createFakePage(standardScript()), createFakeAct());
    await expect(adapter.chat('1001', TEXT)).rejects.toMatchObject({
      code: 'KNOWLEDGE_PACK_INVALID',
      message: expect.stringContaining('chat 段'),
    });
    await expect(adapter.readReplies('1001')).rejects.toMatchObject({ code: 'KNOWLEDGE_PACK_INVALID' });
  });
});

describe('读回复：页面全量读 + 稳定 id（spec 2.5-07、2.5-08）', () => {
  it('抽取请求的容器、属性名与「读自身」全部来自知识包', async () => {
    const { adapter, page } = withScript(chatScript(pack, null, [messageRow(0)]));
    await adapter.readReplies('1001');
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
    const messages = await adapter.readReplies('1001');
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
    const [message] = await adapter.readReplies('1001');
    expect(message!.externalId).toBeNull();
  });

  it('正文为空的行不算消息（分割线与引导气泡），一条都没有是空数组而不是失败', async () => {
    const { adapter } = withScript(
      chatScript(pack, null, [messageRow(0, { text: null }), messageRow(1, { text: '' })]),
    );
    expect(await adapter.readReplies('1001')).toEqual([]);
  });

  it('每次读都先导航到该目标的会话页（不同 jobId 不会读到同一个线程）', async () => {
    const { adapter, page } = withScript(chatScript(pack, null, [messageRow(0)]));
    await adapter.readReplies('1001');
    await adapter.readReplies('2002');
    expect(page.navigated).toEqual([chatUrlOf('1001'), chatUrlOf('2002')]);
  });
});

describe('投递：四段判据全由页面回读决定（spec 2.6-04 / 2.6-07）', () => {
  // 附件是编排层（`outbound.deliver`）已经算好的四要素；适配器不重复校验，只照它注入。
  const RESUME = {
    path: '/tmp/resume-2026.pdf',
    fileName: 'resume-2026.pdf',
    sizeBytes: 204800,
    sha256: 'a'.repeat(64),
  };

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
    // 定位声明全部来自知识包：代码里出现一条写死的选择器，这里的 `toBe` 就对不上。
    expect(act.uploaded).toEqual([{ spec: pack.locators.resumeUploadInput, filePath: RESUME.path }]);
    expect(act.uploaded[0]!.spec).toBe(pack.locators.resumeUploadInput);
    expect(act.waitedFor).toEqual([{ kind: 'textChanges', spec: pack.locators.resumeDeliverStatus }]);
    expect(act.clicked).toEqual([pack.locators.resumeSendButton]);
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
    fibers.push(await ctx.plugin(BossPlatformService, {}));
    const registry = asApp(ctx)['platform.registry'];
    expect(registry.list().platforms.map((platform) => platform.id)).toEqual(['boss']);
    expect(registry.get('boss').meta).toEqual(createBossAdapter(pack, fake, createFakeAct()).meta);
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
