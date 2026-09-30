/**
 * `browser.act` 服务用例（spec 2.2-03 / 2.2-10 / 2.2-12 / 2.2-13）。
 *
 * 定位本身由 `locate-service.test.ts` 覆盖，这里挂的是**定位替身**，于是每条用例都只回答一个问题：
 * 动作的先后顺序对不对、通道与 `trusted` 有没有如实报告、失败是不是结构化的。
 * 「不猜坐标」这一条尤其重要：一旦按过期或认不出的坐标点下去，动作就打到了别的元素身上。
 */
import { AppError, Context, NO_CONFIG, type Fiber } from '@auto-cc/core';
import type { ActResultView, LocateResultView, LocateSpec, LocatedView } from '@auto-cc/shared';
import type { WebContents } from 'electron';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserActService, type BrowserActConfig } from './act-service.js';
import {
  FakeLocateService,
  FakePageService,
  FakeShellService,
  errorDetails,
  fakeDebuggerView,
  fakeFrame,
  fakeReading,
  fakeView,
  writeFrame,
  type ScriptKind,
} from './test-doubles.js';
const frameUrl = 'http://127.0.0.1:10233/locator';
const rect = { x: 10, y: 20, width: 100, height: 40 };

/** 动作服务配置的默认值（同 locate：直接调用点的类型是补齐之后的形状）。 */
const DEFAULT_ACT_CONFIG: BrowserActConfig = {
  waitForTimeoutMs: 5000,
  stableCheckSamples: 2,
  waitCheckMs: 100,
  cdpInputEnabled: true,
};

const fibers: Fiber[] = [];

const spec: LocateSpec = {
  description: '打招呼按钮',
  cardinality: 'single',
  candidates: [{ strategy: 'testId', attribute: 'data-testid', value: 'greet-button' }],
};

/**
 * 造一份「过线」的定位结局，`chosen` 落在 `frameUrl` 这一帧。
 * @param overrides 与默认胜选候选的差异项（帧地址、身份号……）
 * @returns 定位替身要回读的结局
 */
function matched(overrides: Partial<LocatedView> = {}): LocateResultView {
  const chosen: LocatedView = {
    ...fakeReading(frameUrl, { rect }),
    score: 100,
    reasons: ['testId 基线 100'],
    ...overrides,
  };
  return {
    status: 'matched',
    spec,
    chosen,
    ranked: [chosen],
    reason: '胜出候选 100 分（testId）',
    relocated: false,
    snapshotRef: `${frameUrl}@1`,
    snapshot: null,
    at: 1,
  };
}

/**
 * 起一套「shell / page / locate 替身 + 真动作服务」。
 * @param config 覆盖默认动作配置的项
 * @param view 内核视图替身；null 表示还没有挂载会话
 * @returns 动作服务、定位与页面替身，以及 shell 替身（换视图用）
 */
async function boot(config: Partial<BrowserActConfig> = {}, view: WebContents | null = null) {
  const ctx = new Context();
  fibers.push(
    await ctx.plugin(FakeShellService, NO_CONFIG),
    await ctx.plugin(FakePageService, NO_CONFIG),
    await ctx.plugin(FakeLocateService, NO_CONFIG),
    await ctx.plugin(BrowserActService, { ...DEFAULT_ACT_CONFIG, ...config }),
  );
  const shell = ctx.get('shell') as unknown as FakeShellService;
  shell.contents = view;
  return {
    act: ctx.get('browser.act') as BrowserActService,
    locate: ctx.get('browser.locate') as unknown as FakeLocateService,
    page: ctx.get('browser.page') as unknown as FakePageService,
    shell,
  };
}

/**
 * 造一块「各类脚本都给得出读数」的实验室视图。
 * @param scripts 按脚本类别给出的返回值
 * @returns 视图替身（带调试器日志，可断言 CDP 命令）
 */
function labView(scripts: Partial<Record<ScriptKind, unknown>> = {}) {
  const main = fakeFrame(frameUrl, { scripts });
  const view = fakeDebuggerView({ main, subtree: [main], url: frameUrl });
  return { ...view, main };
}

/** 一次点击要经过的全部脚本：等得到、DOM 动作成功、回读到值。 */
const readyScripts = {
  wait: { satisfied: true, waitedMs: 3, readings: [] },
  domAction: { ok: true, valueAfter: '资深前端工程师🎯', error: '' },
  valueRead: { ok: true, valueAfter: '资深前端工程师🎯', error: '' },
};

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
});

describe('动作骨架的顺序与通道（spec 2.2-03 / 2.2-12）', () => {
  it('点击先等到可点，再走 CDP 派发三条真实输入事件', async () => {
    const view = labView(readyScripts);
    const { act, locate, page } = await boot({}, view.contents);
    locate.result = matched();
    const result = await act.click(spec);
    expect(result).toMatchObject({ action: 'click', status: 'done', channel: 'cdp', trusted: true, valueAfter: null });
    expect(view.log.commands.map((item) => item.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(view.log.commands[1]!.params).toMatchObject({ x: 60, y: 40, buttons: 1 });
    expect(result.located).toMatchObject({ score: 100, frameUrl });
    expect(page.snapshotCalls).toBe(0);
  });

  it('输入是「先点落焦点再插字」，且 valueAfter 取自页面回读而不是发出去的那个串', async () => {
    const view = labView(readyScripts);
    const { act, locate } = await boot({}, view.contents);
    locate.result = matched();
    const result = await act.type(spec, '资深前端');
    expect(view.log.commands.map((item) => item.method)).toEqual([
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.insertText',
    ]);
    expect(view.log.commands.at(-1)!.params.text).toBe('资深前端');
    expect(result).toMatchObject({ channel: 'cdp', trusted: true, valueAfter: '资深前端工程师🎯' });
  });

  it('<select> 固定走 DOM 通道并如实标注 trusted:false——原生弹层没有可信输入可模拟', async () => {
    const view = labView({ ...readyScripts, domAction: { ok: true, valueAfter: '3年经验', error: '' } });
    const { act, locate } = await boot({}, view.contents);
    locate.result = matched();
    const result = await act.select(spec, '3年经验');
    expect(result).toMatchObject({
      action: 'select',
      status: 'done',
      channel: 'dom',
      trusted: false,
      valueAfter: '3年经验',
    });
    expect(view.log.commands).toHaveLength(0);
  });

  it('关掉 cdpInputEnabled 就是显式降级：动作照样做完，但通道与受信标记一起改口', async () => {
    const view = labView(readyScripts);
    const { act, locate } = await boot({ cdpInputEnabled: false }, view.contents);
    locate.result = matched();
    const result = await act.click(spec);
    expect(result).toMatchObject({ status: 'done', channel: 'dom', trusted: false });
    expect(view.log.commands).toHaveLength(0);
  });

  it('调试通道被别的客户端占用时退回 DOM，不抛错也不冒充受信事件', async () => {
    const main = fakeFrame(frameUrl, { scripts: readyScripts });
    const view = fakeDebuggerView({ main, subtree: [main], url: frameUrl, attachFails: true });
    const { act, locate } = await boot({}, view.contents);
    locate.result = matched();
    const result = await act.click(spec);
    expect(result).toMatchObject({ channel: 'dom', trusted: false });
    expect(view.log.attachCalls).toBe(1);
  });
});

describe('不猜坐标（spec 2.2-09 / 2.2-10 的 iframe 与跳转）', () => {
  it('父帧里认不出目标 iframe 元素时整次动作改走 DOM，而不是按猜出来的坐标点一下', async () => {
    const top = fakeFrame(frameUrl, { scripts: { ...readyScripts, iframeRects: [] } });
    const inner = fakeFrame('http://127.0.0.1:10233/inner', { scripts: readyScripts });
    writeFrame(inner, { parent: top });
    writeFrame(top, { frames: [inner] });
    const view = fakeDebuggerView({ main: top, subtree: [top, inner], url: frameUrl });
    const { act, locate } = await boot({}, view.contents);
    locate.result = matched({ frameUrl: inner.url });
    const result = await act.click(spec);
    expect(result).toMatchObject({ status: 'done', channel: 'dom', trusted: false });
    expect(view.log.commands).toHaveLength(0);
  });

  it('页面跳转后按地址找不回那一帧时同样退回 DOM——过期坐标一律作废', async () => {
    const view = labView(readyScripts);
    const { act, locate } = await boot({}, view.contents);
    locate.result = matched({ frameUrl: 'http://127.0.0.1:10233/gone' });
    const result = await act.click(spec);
    expect(result).toMatchObject({ channel: 'dom', trusted: false });
    expect(view.log.commands).toHaveLength(0);
  });

  it('聊天框在子帧里也算等到（任一帧满足即满足）', async () => {
    const top = fakeFrame(frameUrl, { scripts: { wait: { satisfied: false, waitedMs: 1, readings: [] } } });
    const inner = fakeFrame('http://127.0.0.1:10233/inner', {
      scripts: { wait: { satisfied: true, waitedMs: 2, readings: [] } },
    });
    writeFrame(inner, { parent: top });
    const { act } = await boot({}, fakeView(top, [top, inner], { url: frameUrl }));
    const result = await act.waitFor({ kind: 'appear', spec });
    expect(result).toMatchObject({ action: 'wait', status: 'done', predicate: { kind: 'appear', satisfied: true } });
  });
});

describe('等待类结局（spec 2.2-03）', () => {
  it('等不到时 waitFor 返回 timeout 结局而不是抛错，且 trusted 恒为 false', async () => {
    const view = labView({ wait: { satisfied: false, waitedMs: 5000, readings: [] } });
    const { act } = await boot({}, view.contents);
    const result: ActResultView = await act.waitFor({ kind: 'clickable', spec });
    expect(result).toMatchObject({
      action: 'wait',
      status: 'timeout',
      channel: 'dom',
      trusted: false,
      predicate: { kind: 'clickable', satisfied: false },
    });
  });

  it('动作用例里等不到可点是结构化 WAIT_TIMEOUT，并带 spec、耗时与快照', async () => {
    const view = labView({ wait: { satisfied: false, waitedMs: 5000, readings: [] } });
    const { act, page } = await boot({}, view.contents);
    try {
      await act.click(spec);
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('WAIT_TIMEOUT');
      expect(errorDetails(error).spec).toEqual(spec);
      expect(typeof errorDetails(error).waitedMs).toBe('number');
      expect(String(errorDetails(error).snapshotRef)).toContain(`${frameUrl}@`);
      expect(errorDetails(error).snapshot).not.toBeNull();
      expect(page.snapshotCalls).toBe(1);
    }
  });

  it('定位没过线是 LOCATE_FAILED，动作没有下发过一条命令', async () => {
    const view = labView(readyScripts);
    const { act, locate } = await boot({}, view.contents);
    locate.result = { ...matched(), status: 'ambiguous', chosen: null, reason: '与次优候选只差 0 分' };
    try {
      await act.click(spec);
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('LOCATE_FAILED');
      expect(errorDetails(error).status).toBe('ambiguous');
      expect(view.log.commands).toHaveLength(0);
    }
  });

  it('CDP 命令被拒且 DOM 兜底也被页面拒绝时是 ACT_FAILED，并带回页面的原因', async () => {
    const main = fakeFrame(frameUrl, {
      scripts: {
        ...readyScripts,
        domAction: { ok: false, valueAfter: '', error: '目标节点已不在当前帧里，需要重新定位' },
      },
    });
    const failing = fakeDebuggerView({ main, subtree: [main], url: frameUrl, sendFails: true });
    const { act, locate } = await boot({}, failing.contents);
    locate.result = matched();
    try {
      await act.click(spec);
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('ACT_FAILED');
      expect((error as AppError).message).toContain('目标节点已不在当前帧里');
    }
  });

  it('还没有挂载会话时是 NO_KERNEL_SESSION，一条脚本都不会下发', async () => {
    const { act, page } = await boot({}, null);
    await expect(act.click(spec)).rejects.toBeInstanceOf(AppError);
    expect(page.snapshotCalls).toBe(0);
  });
});
