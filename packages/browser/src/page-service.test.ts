/**
 * `browser.page` 的截图分支用例（spec 2.4-04 的失败现场）。
 *
 * 本文件只覆盖「取一帧像素」这一条能力，理由是另外几条（导航 / 快照 / 抽取 / 滚动）读的是**真实页面**，
 * 只能用 harness 打 fixture 站点逐项验收（spec 2.1 / 2.3 的 V 类条目）；拿假视图再跑一遍求值，
 * 断言的其实是替身自己回的值（AGENTS.md §2.6）。
 * 截图正相反：它的三种结局在真实页面上无法稳定复现，而调用方（工作流的失败证据）对三者处置完全不同
 * ——有画面就落盘、取不到就在证据里记 null。所以这三条分支必须在用例里分别演一遍。
 */
import { Context, NO_CONFIG, type Fiber } from '@auto-cc/core';
import type { WebContents } from 'electron';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserPageService, type BrowserPageConfig } from './index.js';
import { FAKE_PNG_BYTES, FakeSessionsService, FakeShellService, fakeView } from './test-doubles.js';

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
};

const fibers: Fiber[] = [];

/**
 * 起一套「shell / sessions 替身 + 真页面服务」。
 * @param view 内核视图替身；null 表示还没有挂载会话
 * @returns 真的 `browser.page` 实例（三条依赖里只有它是真的，视图与登记面都是替身）
 */
async function boot(view: WebContents | null = null) {
  const ctx = new Context();
  fibers.push(
    await ctx.plugin(FakeShellService, NO_CONFIG),
    await ctx.plugin(FakeSessionsService, NO_CONFIG),
    await ctx.plugin(BrowserPageService, DEFAULT_PAGE_CONFIG),
  );
  (ctx.get('shell') as unknown as FakeShellService).contents = view;
  return ctx.get('browser.page') as BrowserPageService;
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
});

describe('失败现场截图（spec 2.4-04）', () => {
  it('还没有挂载会话时以 NO_KERNEL_SESSION 失败，而不是回一张空图', async () => {
    const page = await boot(null);
    await expect(page.screenshot()).rejects.toMatchObject({
      code: 'NO_KERNEL_SESSION',
      path: 'browser.page',
      details: { partition: '' },
    });
  });

  it('视图有画面时交出 PNG 字节与尺寸，路径一个字节都不碰', async () => {
    const page = await boot(fakeView(null, [], { capture: { width: 1_280, height: 720 } }));
    await expect(page.screenshot()).resolves.toEqual({ width: 1_280, height: 720, png: FAKE_PNG_BYTES });
  });

  it('视图取像素失败时转成结构化错误，并带回出错的页面地址', async () => {
    const page = await boot(fakeView(null, [], { capture: { fails: true } }));
    await expect(page.screenshot()).rejects.toMatchObject({
      code: 'PAGE_SCREENSHOT_FAILED',
      message: expect.stringContaining('渲染进程没有响应截图请求'),
      details: { url: 'http://127.0.0.1:10233/boss' },
    });
  });

  it('视图是隐藏的那一个（回空图）时同样失败，不给证据目录塞一张白图', async () => {
    const page = await boot(fakeView(null, [], { capture: { empty: true } }));
    await expect(page.screenshot()).rejects.toMatchObject({
      code: 'PAGE_SCREENSHOT_FAILED',
      message: expect.stringContaining('没有可截取的画面'),
      details: { url: 'http://127.0.0.1:10233/boss' },
    });
  });
});
