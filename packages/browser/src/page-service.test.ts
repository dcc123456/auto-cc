/**
 * `browser.page` 的截图分支用例（spec 2.4-04 的失败现场）。
 *
 * 本文件只覆盖「取一帧像素」这一条能力，理由是另外几条（导航 / 快照 / 抽取 / 滚动）读的是**真实页面**，
 * 只能用 harness 打 fixture 站点逐项验收（spec 2.1 / 2.3 的 V 类条目）；拿假视图再跑一遍求值，
 * 断言的其实是替身自己回的值（AGENTS.md §2.6）。
 * 截图正相反：它的三种结局在真实页面上无法稳定复现，而调用方（工作流的失败证据）对三者处置完全不同
 * ——有画面就落盘、取不到就在证据里记 null。所以这三条分支必须在用例里分别演一遍。
 *
 * 文末另有一组「agent 工具登记」用例（spec 2.8-08），它不违反上面的取舍：那组只读登记表里交出去的
 * 元数据、并把「未登记的源」与「不合法的入参」这两条**根本不该碰内核**的路径打死，
 * 真正要页面的成功分支仍归 harness 打 fixture 站点验收。
 */
import { Context, NO_CONFIG, runAsUserCall, type Fiber } from '@auto-cc/core';
import type { WebContents } from 'electron';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BrowserPageService, type BrowserPageConfig } from './index.js';
import {
  FAKE_PNG_BYTES,
  FakeAgentToolsService,
  FakePlatformRegistryService,
  FakeSessionsService,
  FakeShellService,
  fakeFrame,
  fakeView,
  fireViewEvent,
  viewListenerChannels,
} from './test-doubles.js';

/**
 * 页面服务配置的默认值。
 *
 * 直接调用点的类型是「补齐之后」的形状，带 `.default()` 的键必须显式给出（AGENTS.md §9 的 1.3 实测条）。
 */
const DEFAULT_PAGE_CONFIG: BrowserPageConfig = {
  navigateTimeoutMs: 1_000,
  // 自动化只跑本机靶站（2026-11-24 红线事故后的缺省）；要演真实域名才在单个用例里改这一格。
  allowRealAutomation: false,
  snapshotTextLimit: 4_000,
  extractRowLimit: 12,
  extractTextLimit: 4_000,
  maskSensitiveInShots: true,
  maskPaintTimeoutMs: 60,
};

const fibers: Fiber[] = [];

/**
 * 起一套「shell / sessions / platform.registry 替身 + 真页面服务」。
 *
 * 后两个替身是照真装配铺的：页面服务自 2026-11-22 起只依赖 `shell`，但 app 里那两个服务一定在，
 * 铺着才能保证「哪天有人往服务里再加一条跨包依赖」时用例立刻表现为注入失败，而不是悄悄变绿。
 * @param view 内核视图替身；null 表示还没有挂载会话
 * @param overrides 只覆盖要测的那一两个配置项，其余用默认值
 * @param withTools 是否先挂注册表替身（spec 2.8-08 的登记用例要它，其余用例不需要）
 * @returns 真的 `browser.page` 实例、它的 fiber，以及工具注册表替身
 */
async function boot(view: WebContents | null = null, overrides: Partial<BrowserPageConfig> = {}, withTools = false) {
  const ctx = new Context();
  // 注册表排在最前：登记发生在后挂的能力包里，顺序反了就是「界面上有工具、清单是空的」（plan §15.7 落点 2）。
  if (withTools) fibers.push(await ctx.plugin(FakeAgentToolsService, NO_CONFIG));
  fibers.push(await ctx.plugin(FakeShellService, NO_CONFIG));
  const registryFiber = await ctx.plugin(FakePlatformRegistryService, NO_CONFIG);
  const sessionsFiber = await ctx.plugin(FakeSessionsService, NO_CONFIG);
  fibers.push(registryFiber, sessionsFiber);
  const pageFiber = await ctx.plugin(BrowserPageService, { ...DEFAULT_PAGE_CONFIG, ...overrides });
  fibers.push(pageFiber);
  const shell = ctx.get('shell') as unknown as FakeShellService;
  shell.contents = view;
  return {
    ctx,
    page: ctx.get('browser.page') as BrowserPageService,
    pageFiber,
    shell,
    sessions: ctx.get('sessions') as unknown as FakeSessionsService,
    tools: withTools ? (ctx.get('agent.tools') as unknown as FakeAgentToolsService) : null,
  };
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
});

describe('失败现场截图（spec 2.4-04）', () => {
  it('还没有挂载会话时以 NO_KERNEL_SESSION 失败，而不是回一张空图', async () => {
    const { page } = await boot(null);
    await expect(page.screenshot()).rejects.toMatchObject({
      code: 'NO_KERNEL_SESSION',
      path: 'browser.page',
      details: { partition: '' },
    });
  });

  it('视图有画面时交出 PNG 字节与尺寸，路径一个字节都不碰', async () => {
    const { page } = await boot(fakeView(null, [], { capture: { width: 1_280, height: 720 } }));
    await expect(page.screenshot()).resolves.toEqual({ width: 1_280, height: 720, png: FAKE_PNG_BYTES });
  });

  it('视图取像素失败时转成结构化错误，并带回出错的页面地址', async () => {
    const { page } = await boot(fakeView(null, [], { capture: { fails: true } }));
    await expect(page.screenshot()).rejects.toMatchObject({
      code: 'PAGE_SCREENSHOT_FAILED',
      message: expect.stringContaining('渲染进程没有响应截图请求'),
      details: { url: 'http://127.0.0.1:10233/boss' },
    });
  });

  it('视图是隐藏的那一个（回空图）时同样失败，不给证据目录塞一张白图', async () => {
    const { page } = await boot(fakeView(null, [], { capture: { empty: true } }));
    await expect(page.screenshot()).rejects.toMatchObject({
      code: 'PAGE_SCREENSHOT_FAILED',
      message: expect.stringContaining('没有可截取的画面'),
      details: { url: 'http://127.0.0.1:10233/boss' },
    });
  });
});

/**
 * 遮罩与取像素的先后（spec 2.7-07）。
 *
 * 帧替身与视图替身共用同一个 `calls` 数组，为的就是这条顺序能断出来：分开记只看得到
 * 「发了两次脚本、取了一次像素」，而「盖在取之前、摘在取之后」才是这件事的全部内容。
 */
describe('截图前遮罩（spec 2.7-07）', () => {
  /** 把记下来的调用序列折成可读的步骤名。 */
  const steps = (calls: string[]): string[] =>
    calls.map((call) => (call === 'capturePage' ? 'capture' : call.includes('createRange') ? 'mask' : 'unmask'));

  const piiView = (calls: string[], capture: { width?: number; height?: number; fails?: boolean } = {}) =>
    fakeView(fakeFrame('http://127.0.0.1:10233/pii', { value: { hits: 3, covers: 3 }, calls }), [], {
      capture: { width: 800, height: 600, ...capture },
      calls,
    });

  it('默认配置下按「盖 → 截 → 摘」三步走', async () => {
    const calls: string[] = [];
    const { page } = await boot(piiView(calls));
    await expect(page.screenshot()).resolves.toMatchObject({ width: 800, height: 600, png: FAKE_PNG_BYTES });
    expect(steps(calls)).toEqual(['mask', 'capture', 'unmask']);
  });

  it('取像素失败时也要摘掉，不给站点留下我们盖的黑块', async () => {
    const calls: string[] = [];
    const { page } = await boot(piiView(calls, { fails: true }));
    await expect(page.screenshot()).rejects.toMatchObject({ code: 'PAGE_SCREENSHOT_FAILED' });
    expect(steps(calls)).toEqual(['mask', 'capture', 'unmask']);
  });

  it('所有帧都拒绝遮罩时以 PAGE_SCRIPT_FAILED 失败，绝不交出没脱敏的原图', async () => {
    const calls: string[] = [];
    const { page } = await boot(
      fakeView(fakeFrame('http://127.0.0.1:10233/pii', { error: '这一帧拒绝脚本', calls }), [], {
        capture: { width: 800, height: 600 },
        calls,
      }),
    );
    await expect(page.screenshot()).rejects.toMatchObject({ code: 'PAGE_SCRIPT_FAILED' });
    expect(calls).not.toContain('capturePage');
  });

  it('关掉开关时一个脚本都不发（开发者要看原图的唯一出口）', async () => {
    const calls: string[] = [];
    const { page } = await boot(piiView(calls), { maskSensitiveInShots: false });
    await expect(page.screenshot()).resolves.toMatchObject({ width: 800, height: 600 });
    expect(steps(calls)).toEqual(['capture']);
  });
});

/**
 * 造一块能脚本化 `loadURL` 与快照的本地视图；不发任何网络请求。
 * @param loadURL 装载实现（用例在里面记地址、或按第几次调用决定拒绝）
 * @returns 可直接交给 `boot` 的视图替身
 */
const viewWithLoad = (loadURL: (url: string) => Promise<void>): WebContents => {
  const contents = fakeView(fakeFrame('http://127.0.0.1:10233/boss', { value: {} }));
  contents.loadURL = loadURL;
  contents.executeJavaScript = () =>
    Promise.resolve({
      title: '仿站搜索页',
      url: 'http://127.0.0.1:10233/boss?query=frontend',
      readyState: 'complete',
      elementCount: 3,
      textLength: 0,
      bodyText: '',
      headings: [],
    });
  return contents;
};

/**
 * 导航许可（spec 2.1-03 / 2.1-04；2026-11-22 裁定：内嵌的就是一个真实浏览器）。
 *
 * 名单与签字退役后，这里只剩两件事要钉住：① 任何 http(s) 地址都能走到内核装载；
 * ② 协议红线还在——`javascript:` 一个字节都不许进内核。放行之后的真实装载仍归 harness
 * 打 fixture 站点验收（spec 2.1 的 V 类条目），这里只演「交给内核的那一帧」。
 */
describe('导航许可（2026-11-22 裁定：只剩协议一道）', () => {
  it('未登记来源照旧走到内核装载（名单退役后没有「不属于已登记平台」这条路）', async () => {
    const urls: string[] = [];
    const contents = viewWithLoad((url) => {
      urls.push(url);
      setTimeout(() => fireViewEvent(contents, 'did-finish-load'), 0);
      return Promise.resolve();
    });
    const { page } = await boot(contents);
    await expect(page.navigate('http://127.0.0.1:10233/boss/detail?jobId=1001')).resolves.toMatchObject({
      readyState: 'complete',
      url: 'http://127.0.0.1:10233/boss?query=frontend',
    });
    expect(urls).toEqual(['http://127.0.0.1:10233/boss/detail?jobId=1001']);
  });

  it('自动化永远按自动化判：真实域名被闸拦下，一次也没碰到内核', async () => {
    const { page } = await boot(viewWithLoad(() => Promise.resolve()));
    await expect(page.navigate('https://www.zhipin.com/web/geek/jobs')).rejects.toMatchObject({
      code: 'REAL_PLATFORM_AUTOMATION_BLOCKED',
    });
  });

  it('人给的地址那只口在没有网关标时结构化拒绝（主进程自动化路径借不到它）', async () => {
    const { page } = await boot(viewWithLoad(() => Promise.resolve()));
    await expect(page.navigateFromUser('https://www.zhipin.com/')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('非 http(s) 协议仍被拦下，一次也没碰到内核', async () => {
    const urls: string[] = [];
    const { page } = await boot(
      viewWithLoad((url) => {
        urls.push(url);
        return Promise.resolve();
      }),
    );
    await expect(page.navigate('javascript:alert(1)')).rejects.toMatchObject({ code: 'NAVIGATE_URL_REJECTED' });
    expect(urls).toEqual([]);
  });
});

/**
 * 人那一路的真站接触审计（10.12-12）。
 *
 * 视图替身只记录交给 `loadURL` 的字符串，不发起任何网络请求；`runAsUserCall` 模拟网关给渲染层调用打的标。
 * 断言的对象是**日志原文**：host/source/时刻必须在，查询串与它的值不许出现。
 */
describe('人那一路的审计（10.12-12）', () => {
  it('非回环导航记且只记一条脱敏 INFO，行为本身不被自动化闸拦', async () => {
    const urls: string[] = [];
    const contents = viewWithLoad((url) => {
      urls.push(url);
      setTimeout(() => fireViewEvent(contents, 'did-finish-load'), 0);
      return Promise.resolve();
    });
    const { ctx, page } = await boot(contents);
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => undefined);
    try {
      await runAsUserCall(
        async () => await page.navigateFromUser('https://example.test/job/1001?query=secret&name=alice'),
      );
      const audit = info.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('人请求导航到非回环主机：'));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toContain('source=user');
      expect(audit[0]).toContain('host=example.test');
      expect(audit[0]).toMatch(/at=\d+/u);
      expect(audit[0]).not.toContain('query=');
      expect(audit[0]).not.toContain('secret');
      expect(urls).toEqual(['https://example.test/job/1001?query=secret&name=alice']);
    } finally {
      info.mockRestore();
    }
  });

  it('后续装载失败也仍留一条请求审计，不写成已导航成功', async () => {
    const { ctx, page } = await boot(viewWithLoad(() => Promise.reject(new Error('LOAD_FAILED'))));
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => undefined);
    try {
      await expect(
        runAsUserCall(async () => await page.navigateFromUser('https://example.test/fail?query=secret')),
      ).rejects.toThrow('LOAD_FAILED');
      const audit = info.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('人请求导航到非回环主机：'));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toContain('source=user');
      expect(audit[0]).toContain('host=example.test');
      expect(audit[0]).toMatch(/at=\d+/u);
      expect(audit[0]).not.toContain('query=');
    } finally {
      info.mockRestore();
    }
  });

  it('回环导航不产生审计行', async () => {
    const contents = viewWithLoad(() => {
      setTimeout(() => fireViewEvent(contents, 'did-finish-load'), 0);
      return Promise.resolve();
    });
    const { ctx, page } = await boot(contents);
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => undefined);
    try {
      await runAsUserCall(async () => await page.navigateFromUser('http://127.0.0.1:10233/chat?targetId=1001'));
      const audit = info.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('人请求导航到非回环主机：'));
      expect(audit).toEqual([]);
    } finally {
      info.mockRestore();
    }
  });
});

describe('导航在途竞态（9.2-08 / 10.2-01）', () => {
  it('第一次遇 (-3) loading：先等原导航落定，再重试一次并回完整快照', async () => {
    const calls: string[] = [];
    const contents = viewWithLoad((url) => {
      calls.push(url);
      setTimeout(() => fireViewEvent(contents, 'did-finish-load'), 0);
      return calls.length === 1
        ? Promise.reject(new Error("UNKNOWN / (-3) loading 'http://127.0.0.1:10233/boss'"))
        : Promise.resolve();
    });
    const { page } = await boot(contents);
    await expect(page.navigate('http://127.0.0.1:10233/boss?query=frontend')).resolves.toMatchObject({
      readyState: 'complete',
      url: 'http://127.0.0.1:10233/boss?query=frontend',
    });
    expect(calls).toHaveLength(2);
    expect(viewListenerChannels(contents)).toEqual([]);
  });

  it('非 loading 竞态的导航错误原样上浮，不盲目重试', async () => {
    const calls: string[] = [];
    const contents = viewWithLoad((url) => {
      calls.push(url);
      return Promise.reject(new Error('ERR_CONNECTION_REFUSED'));
    });
    const { page } = await boot(contents);
    await expect(page.navigate('http://127.0.0.1:10233/boss?query=frontend')).rejects.toThrow('ERR_CONNECTION_REFUSED');
    expect(calls).toHaveLength(1);
  });
});

/**
 * 地址栏的第一入口：没有会话时自己起会话（2026-11-23 用户裁定）。
 *
 * 用户实测的现象不是「被拦」而是「点了没反应」：地址栏走 `browser.page.navigate`，它第一步要一块
 * 已挂载的视图，而视图停在占位页，于是直接 `NO_KERNEL_SESSION`。对「一个真实浏览器」的心智来说这是缺陷——
 * 用户不该先知道要「打开会话」才能输网址。判据两条：① 无会话时自己起来并真的导航过去；
 * ② 已有会话时**一个字都不动**（重建视图会丢页面与登录态现场）。
 */
describe('没有会话时自己起会话（2026-11-23 裁定）', () => {
  it('无会话时先起会话、再导航，落定后回完整快照', async () => {
    const urls: string[] = [];
    const contents = viewWithLoad((url) => {
      urls.push(url);
      setTimeout(() => fireViewEvent(contents, 'did-finish-load'), 0);
      return Promise.resolve();
    });
    const rig = await boot(null);
    rig.sessions.onEnsure = () => {
      rig.shell.contents = contents;
    };
    await expect(rig.page.navigate('http://127.0.0.1:10233/boss/detail?jobId=1001')).resolves.toMatchObject({
      readyState: 'complete',
    });
    expect(rig.sessions.ensureCalls).toBe(1);
    expect(urls).toEqual(['http://127.0.0.1:10233/boss/detail?jobId=1001']);
  });

  it('已有会话时不动会话：会话一个都不起，导航走原来那条路', async () => {
    const urls: string[] = [];
    const contents = viewWithLoad((url) => {
      urls.push(url);
      setTimeout(() => fireViewEvent(contents, 'did-finish-load'), 0);
      return Promise.resolve();
    });
    const rig = await boot(contents);
    await expect(rig.page.navigate('http://127.0.0.1:10233/boss/detail?jobId=1002')).resolves.toMatchObject({
      readyState: 'complete',
    });
    expect(rig.sessions.ensureCalls).toBe(0);
    expect(urls).toEqual(['http://127.0.0.1:10233/boss/detail?jobId=1002']);
  });

  it('会话起完仍然拿不到视图时如实报 NO_KERNEL_SESSION，不假装导航成功', async () => {
    const rig = await boot(null);
    await expect(rig.page.navigate('http://127.0.0.1:10233/boss/detail?jobId=1003')).rejects.toMatchObject({
      code: 'NO_KERNEL_SESSION',
    });
    expect(rig.sessions.ensureCalls).toBe(1);
  });
});

/**
 * agent 工具登记（spec 2.8-08 / plan §15.7 落点 3）。
 *
 * 页面这两只手都是 `read`：它们只把页面读数交给对话侧，不往站点点任何东西，
 * 「不需要批准」正是它们与外发那几只手的分界（plan §15.7 落点 4）。
 * 成功分支要读真实页面，仍归 harness 打 fixture 站点验收（本文件头部的取舍）。
 */
describe('agent 工具登记（spec 2.8-08）', () => {
  it('挂载即把 navigate 与 snapshot 交给注册表，两只都标 read 且不需批准', async () => {
    const { tools } = await boot(null, {}, true);
    expect(tools?.list()).toEqual([
      { id: 'browser.page.navigate', effect: 'read', requiresConfirmation: false },
      { id: 'browser.page.snapshot', effect: 'read', requiresConfirmation: false },
    ]);
  });

  it('工具面里只有自动化那只口：人那一路的 navigateFromUser 不登记给 agent', async () => {
    // 这条把「自动化借不到 user 那条路」钉在工具面这一层：模型能调的只有 navigate（永远按自动化判），
    // 而 navigateFromUser 既不在白名单工具里、调它还要网关标，两条一起断掉伪造来源的路。
    const { tools } = await boot(null, {}, true);
    const ids = (tools?.list() ?? []).map((tool) => tool.id);
    expect(ids).toContain('browser.page.navigate');
    expect(ids).not.toContain('browser.page.navigateFromUser');
  });

  it('从工具路径传非 http(s) 协议仍被许可判定拦下，一次也没碰到内核', async () => {
    // 视图替身没有 `loadURL`：真走到内核那一步拿到的是 TypeError 而不是这个错误码，
    // 所以「码是 NAVIGATE_URL_REJECTED」这件事本身就证明了对话侧的字符串没能驱动内核。
    const { tools } = await boot(fakeView(null, []), {}, true);
    await expect(tools?.call('browser.page.navigate', { url: 'javascript:alert(1)' })).rejects.toMatchObject({
      code: 'NAVIGATE_URL_REJECTED',
      path: 'browser',
    });
  });

  it('入参不合法时被注册表的 schema 拦下，三个调用都不往下走', async () => {
    const { tools } = await boot(null, {}, true);
    await expect(tools?.call('browser.page.navigate', {})).resolves.toEqual({ ok: false, reason: 'INPUT_INVALID' });
    await expect(tools?.call('browser.page.snapshot', { maxChars: 0 })).resolves.toEqual({
      ok: false,
      reason: 'INPUT_INVALID',
    });
    await expect(tools?.call('browser.page.snapshot', { maxChars: 999_999 })).resolves.toEqual({
      ok: false,
      reason: 'INPUT_INVALID',
    });
  });

  it('页面服务卸载时把两只都摘回：悬着的 run 指向已销毁实例就是下一个无法解释的错误', async () => {
    const { tools, pageFiber } = await boot(null, {}, true);
    await pageFiber.dispose();
    expect(tools?.removed).toEqual(['browser.page.navigate', 'browser.page.snapshot']);
    expect(tools?.list()).toEqual([]);
  });
});
