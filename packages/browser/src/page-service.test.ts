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
import { Context, NO_CONFIG, type Fiber } from '@auto-cc/core';
import type { WebContents } from 'electron';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserPageService, type BrowserPageConfig } from './index.js';
import {
  FAKE_PNG_BYTES,
  FakeAgentToolsService,
  FakeSessionsService,
  FakeShellService,
  fakeFrame,
  fakeView,
} from './test-doubles.js';

/**
 * 页面服务配置的默认值。
 *
 * 直接调用点的类型是「补齐之后」的形状，带 `.default()` 的键必须显式给出（AGENTS.md §9 的 1.3 实测条）。
 */
const DEFAULT_PAGE_CONFIG: BrowserPageConfig = {
  navigateTimeoutMs: 1_000,
  snapshotTextLimit: 4_000,
  extractRowLimit: 12,
  extractTextLimit: 4_000,
  maskSensitiveInShots: true,
  maskPaintTimeoutMs: 60,
};

const fibers: Fiber[] = [];

/**
 * 起一套「shell / sessions 替身 + 真页面服务」。
 * @param view 内核视图替身；null 表示还没有挂载会话
 * @param overrides 只覆盖要测的那一两个配置项，其余用默认值
 * @param withTools 是否先挂注册表替身（spec 2.8-08 的登记用例要它，其余用例不需要）
 * @returns 真的 `browser.page` 实例、它的 fiber，以及注册表替身（没挂就是 null）
 */
async function boot(view: WebContents | null = null, overrides: Partial<BrowserPageConfig> = {}, withTools = false) {
  const ctx = new Context();
  // 注册表排在最前：登记发生在后挂的能力包里，顺序反了就是「界面上有工具、清单是空的」（plan §15.7 落点 2）。
  if (withTools) fibers.push(await ctx.plugin(FakeAgentToolsService, NO_CONFIG));
  fibers.push(await ctx.plugin(FakeShellService, NO_CONFIG), await ctx.plugin(FakeSessionsService, NO_CONFIG));
  const pageFiber = await ctx.plugin(BrowserPageService, { ...DEFAULT_PAGE_CONFIG, ...overrides });
  fibers.push(pageFiber);
  (ctx.get('shell') as unknown as FakeShellService).contents = view;
  return {
    page: ctx.get('browser.page') as BrowserPageService,
    pageFiber,
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

  it('从工具路径导航到未登记平台的源被许可判定拦下，一次也没碰到内核', async () => {
    // 视图替身没有 `loadURL`：真走到内核那一步拿到的是 TypeError 而不是这个错误码，
    // 所以「码是 NAVIGATE_URL_REJECTED」这件事本身就证明了对话侧的字符串没能驱动内核。
    const { tools } = await boot(fakeView(null, []), {}, true);
    await expect(tools?.call('browser.page.navigate', { url: 'https://example.com/jd' })).rejects.toMatchObject({
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
