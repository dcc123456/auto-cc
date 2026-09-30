/**
 * `browser.risk` 服务用例（spec 2.7-01）。
 *
 * 这里验的是**观测层的四条边界**，不是正则怎么写：
 * ① 命中只发一条 `browser/risk-signal`，本服务不停工作流、不重试、更不识别验证码；
 * ② 状态码口径来自配置、文案判据来自知识包（本包不认识 BOSS）；
 * ③ 正文只在「那块视图确实属于这个平台」时才读（观测口挂在分区上，页面只有一块）；
 * ④ 读不到正文与没命中都不冒充「已经判过没问题」，只在日志里留一句。
 * 会话侧那个唯一的 webRequest 槽位在这里降级成「记下来，等用例手动喂读数」，
 * 所以每条用例都不需要 Electron 窗口，而 `ctx.emit` 与事件形状都是真的。
 */
import { Context, NO_CONFIG, type Fiber } from '@auto-cc/core';
import { partitionFor, type KernelPageSnapshotView, type RiskSignalEvent } from '@auto-cc/shared';
import type { WebContents } from 'electron';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserRiskService, browserRiskSchema, matchRiskText, type BrowserRiskConfig } from './risk-service.js';
import {
  FakePageService,
  FakePlatformRegistryService,
  FakeSessionsService,
  FakeShellService,
  fakeFrame,
  fakeView,
  fireViewEvent,
} from './test-doubles.js';

const BOSS_URL = 'http://127.0.0.1:10233/boss';

/** 直接调用点的配置类型是 schema 补齐之后的形状，所以默认值要写全。 */
const DEFAULT_RISK_CONFIG: BrowserRiskConfig = {
  riskStatusCodes: [403, 429],
  pageSettleTimeoutMs: 500,
};

const fibers: Fiber[] = [];

/** 等一条读数的异步判定跑完：观测 listener 是同步交出、异步处置，用例必须给它跑到尾的机会。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * 起一套「shell / sessions / page / registry 替身 + 真风控服务」，并接住它发出的信号。
 * @param config 覆盖默认配置的项（状态码口径、正文等待上限）
 * @param view 内核视图替身；null 表示还没有挂载会话
 * @returns 三个替身、风控服务的 fiber（卸载用）与它发出的信号
 */
async function boot(config: Partial<BrowserRiskConfig> = {}, view: WebContents | null = null) {
  const ctx = new Context();
  const signals: RiskSignalEvent[] = [];
  ctx.on('browser/risk-signal', (event) => {
    signals.push(event);
  });
  fibers.push(
    await ctx.plugin(FakeShellService, NO_CONFIG),
    await ctx.plugin(FakeSessionsService, NO_CONFIG),
    await ctx.plugin(FakePageService, NO_CONFIG),
    await ctx.plugin(FakePlatformRegistryService, NO_CONFIG),
  );
  const shell = ctx.get('shell') as unknown as FakeShellService;
  shell.contents = view;
  const riskFiber = await ctx.plugin(BrowserRiskService, { ...DEFAULT_RISK_CONFIG, ...config });
  fibers.push(riskFiber);
  return {
    riskFiber,
    sessions: ctx.get('sessions') as unknown as FakeSessionsService,
    page: ctx.get('browser.page') as unknown as FakePageService,
    registry: ctx.get('platform.registry') as unknown as FakePlatformRegistryService,
    signals,
  };
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
});

describe('风控信号观测（spec 2.7-01）', () => {
  it('挂载就占住会话侧那唯一的观测槽位，卸载时把它归还', async () => {
    const { sessions, riskFiber } = await boot();
    expect(sessions.observeCalls).toBe(1);

    await riskFiber.dispose();
    // 已经卸掉的那条从记账里摘掉，免得 afterAll 再卸一次。
    fibers.splice(fibers.indexOf(riskFiber), 1);
    // 归还必须是 1 次而不是 0 次：独占者退出时留一个哑 handler，下一个挂载者就被它盖掉。
    expect(sessions.unobserveCalls).toBe(1);
  });

  it('主文档 403 发一条 http-status 信号，并且一趟导航只发这一条', async () => {
    const { sessions, registry, page, signals } = await boot();
    // 连判据都备好了：状态码已经足够定性，再读一次页面只会把同一件事说两遍。
    registry.riskPattern = '安全验证';
    sessions.fireMainFrameResponse({
      url: BOSS_URL,
      statusCode: 403,
      statusLine: 'HTTP/1.1 403 Forbidden',
    });
    await flush();

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ platform: 'fixture', kind: 'http-status', detail: 'HTTP 403', url: BOSS_URL });
    expect(page.snapshotCalls).toBe(0);
  });

  it('状态码口径写在配置里：只把 429 当风控时 403 不再发信号，改回口径它就照发', async () => {
    const { sessions, signals } = await boot({ riskStatusCodes: [429] });
    sessions.fireMainFrameResponse({ url: BOSS_URL, statusCode: 403, statusLine: 'HTTP/1.1 403 Forbidden' });
    await flush();
    expect(signals).toHaveLength(0);

    sessions.fireMainFrameResponse({
      url: 'http://127.0.0.1:10233/boss?q=1',
      statusCode: 429,
      statusLine: 'HTTP/1.1 429 Too Many Requests',
    });
    await flush();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ kind: 'http-status', detail: 'HTTP 429' });
  });

  it('200 的验证页靠知识包那句文案判出来：kind 是 page-text，detail 就是命中的那段原文', async () => {
    const view = fakeView(fakeFrame(BOSS_URL));
    const { sessions, registry, page, signals } = await boot({}, view);
    registry.riskPattern = '安全验证|访问验证';
    page.snapshotOverride = { title: '安全验证 - 本地仿站', bodyText: '检测到异常访问，请输入验证码后继续。' };

    sessions.fireMainFrameResponse({ url: BOSS_URL, statusCode: 200, statusLine: 'HTTP/1.1 200 OK' });
    fireViewEvent(view, 'did-finish-load');
    await flush();

    // 整份对账（不是 toMatchObject）：事件里多一个键就是多泄一份数据——正文节选与 cookie 都不许出现在这儿。
    expect(signals).toEqual([
      {
        platform: 'fixture',
        kind: 'page-text',
        detail: '安全验证',
        url: BOSS_URL,
        at: expect.any(Number),
      },
    ]);
    expect(page.snapshotCalls).toBe(1);
  });

  it('知识包没声明文案判据时只按状态码判：200 的页面一次正文都不读', async () => {
    const view = fakeView(fakeFrame(BOSS_URL));
    const { sessions, page, signals } = await boot({}, view);
    sessions.fireMainFrameResponse({ url: BOSS_URL, statusCode: 200, statusLine: 'HTTP/1.1 200 OK' });
    await flush();

    expect(page.snapshotCalls).toBe(0);
    expect(signals).toHaveLength(0);
  });

  it('视图不属于这个平台、或根本没有视图时不读正文：拿别人的页面给这个平台定罪是错的', async () => {
    const otherView = await boot({}, fakeView(fakeFrame(BOSS_URL)));
    otherView.registry.riskPattern = '安全验证';
    // 替身的视图报的是 fixture 的分区，而这条读数按分区归属属于 boss。
    otherView.sessions.fireMainFrameResponse({
      platform: 'boss',
      url: BOSS_URL,
      statusCode: 200,
      statusLine: 'HTTP/1.1 200 OK',
    });
    await flush();
    expect(otherView.page.snapshotCalls).toBe(0);
    expect(otherView.signals).toHaveLength(0);
    // 顺带钉住这条判定依据的是分区归属，不是从地址里猜平台。
    expect(partitionFor('boss')).not.toBe(partitionFor('fixture'));

    const noView = await boot({}, null);
    noView.registry.riskPattern = '安全验证';
    noView.sessions.fireMainFrameResponse({ url: BOSS_URL, statusCode: 200, statusLine: 'HTTP/1.1 200 OK' });
    await flush();
    expect(noView.page.snapshotCalls).toBe(0);
    expect(noView.signals).toHaveLength(0);
  });

  it('等不到装载事件不判「没风控」：超时之后仍然读一次正文', async () => {
    const view = fakeView(fakeFrame(BOSS_URL));
    const { sessions, registry, page, signals } = await boot({ pageSettleTimeoutMs: 500 }, view);
    registry.riskPattern = '安全验证|访问验证';
    page.snapshotOverride = { bodyText: '访问验证，请稍后再试' };
    sessions.fireMainFrameResponse({ url: BOSS_URL, statusCode: 200, statusLine: 'HTTP/1.1 200 OK' });
    // 这条不喂装载事件，让 `settleLoad` 自己睡到上限（上限已经是配置允许的最小值，所以只等它一睡到底）。
    await new Promise((resolve) => {
      setTimeout(resolve, 650);
    });

    expect(page.snapshotCalls).toBe(1);
    expect(signals[0]).toMatchObject({ kind: 'page-text', detail: '访问验证' });
  });

  it('正文读不到时既不发信号、也不声称判过了：只留一句日志', async () => {
    const view = fakeView(fakeFrame(BOSS_URL));
    const { sessions, registry, page, signals } = await boot({}, view);
    registry.riskPattern = '安全验证';
    page.snapshotFails = true;
    sessions.fireMainFrameResponse({ url: BOSS_URL, statusCode: 200, statusLine: 'HTTP/1.1 200 OK' });
    fireViewEvent(view, 'did-fail-load');
    await flush();

    // 读一次是必要的（试过了），不发信号也是必要的（没证据就说「被拦了」会让界面停错地方）。
    expect(page.snapshotCalls).toBe(1);
    expect(signals).toHaveLength(0);
  });
});

describe('文案判据的取材面（statusLine / title / bodyText 三处都找）', () => {
  const pattern = /安全验证|访问验证|Forbidden/i;
  // 「一张正常的列表页」：正文里既没有判据，也没有可被判成的东西。
  const snapshot: KernelPageSnapshotView = {
    title: '职位列表 - 本地仿站',
    url: BOSS_URL,
    readyState: 'complete',
    elementCount: 1,
    textLength: 0,
    bodyText: '',
    headings: [],
    partition: partitionFor('fixture'),
  };

  it('反代拦下来时那句话在状态行里', () => {
    expect(matchRiskText('HTTP/1.1 403 Forbidden', snapshot, pattern)).toBe('Forbidden');
  });

  it('站点自造验证页时那句话常在标题里', () => {
    expect(matchRiskText('HTTP/1.1 200 OK', { ...snapshot, title: '安全验证 - BOSS 直聘' }, pattern)).toBe('安全验证');
  });

  it('「访问验证」藏在正文里也照样命中', () => {
    expect(matchRiskText('HTTP/1.1 200 OK', { ...snapshot, bodyText: '请先完成访问验证' }, pattern)).toBe('访问验证');
  });

  it('三处都没有就不算风控，回 null 而不是回一个空串', () => {
    expect(matchRiskText('HTTP/1.1 200 OK', snapshot, pattern)).toBeNull();
  });
});

describe('配置口径（spec 2.7-01 的「口径进配置」）', () => {
  it('状态码清单不能为空：空清单等于永不命中，那是摘掉观测层而不是改口径', () => {
    expect(browserRiskSchema.safeParse({ riskStatusCodes: [], pageSettleTimeoutMs: 500 }).success).toBe(false);
  });

  it('正文等待上限有边界：太短等于不给页面落定的机会', () => {
    expect(browserRiskSchema.safeParse({ riskStatusCodes: [403], pageSettleTimeoutMs: 100 }).success).toBe(false);
  });
});
