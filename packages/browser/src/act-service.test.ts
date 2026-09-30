/**
 * `browser.act` 服务用例（spec 2.2-03 / 2.2-10 / 2.2-12 / 2.2-13 / 2.6-04）。
 *
 * 定位本身由 `locate-service.test.ts` 覆盖，这里挂的是**定位替身**，于是每条用例都只回答一个问题：
 * 动作的先后顺序对不对、通道与 `trusted` 有没有如实报告、失败是不是结构化的。
 * 「不猜坐标」这一条尤其重要：一旦按过期或认不出的坐标点下去，动作就打到了别的元素身上。
 */
import { AppError, Context, NO_CONFIG, type Fiber } from '@auto-cc/core';
import type { ActResultView, LocateResultView, LocateSpec, LocatedView } from '@auto-cc/shared';
import type { WebContents } from 'electron';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  uploadReadbackMs: 1500,
  uploadReadbackStepMs: 50,
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

/** 站点常见的上传声明：隐藏的 `input[type=file]`，靠「出现」而不是「可点」判就绪。 */
const uploadSpec: LocateSpec = {
  description: '附件上传框',
  cardinality: 'single',
  requireActionable: false,
  candidates: [{ strategy: 'testId', attribute: 'data-testid', value: 'resume-upload' }],
};

const resumeName = '资深前端-简历.pdf';
/** 真文件放在系统临时目录：注入要的是绝对路径与字节数，替身编不出一个合法的文件大小。 */
const uploadDir = mkdtempSync(join(tmpdir(), 'auto-cc-upload-'));
const resumeFile = join(uploadDir, resumeName);
writeFileSync(resumeFile, 'PDF'.padEnd(226, '.'));

/** 页面「收到了」的那次回读：文件名与字节数都和请求一致。 */
const delivered = {
  changeCount: 1,
  isTrusted: true,
  filesCount: 1,
  fileName: resumeName,
  fileSize: 226,
  fileType: 'application/pdf',
};

/**
 * 造一条「每一步都给得出回包」的注入链。
 * @param value `Runtime.callFunctionOn` 回包里页面报上来的读数
 * @param overrides 覆盖某条命令的回包（值给成 Error 即该条被拒）
 * @returns 按 CDP 方法名组织的回包表
 */
function cdpResponses(value: Record<string, unknown> = delivered, overrides: Record<string, unknown> = {}) {
  return {
    'Page.getFrameTree': { frameTree: { frame: { id: 'F1', url: frameUrl }, childFrames: [] } },
    'Page.createIsolatedWorld': { executionContextId: 7 },
    'Runtime.evaluate': { result: { type: 'object', subtype: 'node', objectId: 'NODE-1' } },
    'Runtime.callFunctionOn': { result: { value } },
    ...overrides,
  };
}

/**
 * 起一块「等待、定位、注入都走得通」的上传实验室视图。
 * @param scripts 各脚本类别的返回值（默认全通过）
 * @param responses 注入链的 CDP 回包表
 * @returns 视图替身（带命令日志）
 */
function uploadLab(
  scripts: Partial<Record<ScriptKind, unknown>> = readyScripts,
  responses: Record<string, unknown> = cdpResponses(),
) {
  const main = fakeFrame(frameUrl, { scripts });
  return fakeDebuggerView({ main, subtree: [main], url: frameUrl, responses });
}

const uploadChain = [
  'Page.enable',
  'Runtime.enable',
  'DOM.enable',
  'Page.getFrameTree',
  'Page.createIsolatedWorld',
  'Runtime.evaluate',
  'DOM.setFileInputFiles',
  'Runtime.callFunctionOn',
];

describe('文件注入动作（spec 2.6-04）', () => {
  afterAll(() => {
    rmSync(uploadDir, { recursive: true, force: true });
  });

  it('先等出现、再按 objectId 注入，回读到的是那个 input 自己报上来的文件名', async () => {
    const view = uploadLab();
    const { act, locate, page } = await boot({}, view.contents);
    locate.result = matched({ tagName: 'input', visible: false, accessibleName: '' });
    const result = await act.upload(uploadSpec, resumeFile);
    expect(result).toMatchObject({
      action: 'upload',
      status: 'done',
      channel: 'cdp',
      trusted: true,
      valueAfter: resumeName,
      located: { strategy: 'testId' },
    });
    expect(view.log.commands.map((item) => item.method)).toEqual(uploadChain);
    // 取节点的脚本里带的就是定位用的那份候选——「选哪一个」只由 locator 决定，CDP 侧不做第二次选择。
    expect(view.log.commands[5]!.params.expression).toContain('resume-upload');
    expect(view.log.commands[6]!.params).toEqual({ files: [resumeFile], objectId: 'NODE-1' });
    expect(page.snapshotCalls).toBe(0);
  });

  it('隐藏控件用 appear 判就绪：等不到的文案说的是 appear，不是「可点击」', async () => {
    const view = uploadLab({ ...readyScripts, wait: { satisfied: false, waitedMs: 5000, readings: [] } });
    const { act, locate } = await boot({}, view.contents);
    locate.result = matched({ tagName: 'input', visible: false });
    try {
      await act.upload(uploadSpec, resumeFile);
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('WAIT_TIMEOUT');
      expect((error as AppError).message).toContain('appear');
    }
    expect(view.log.commands).toHaveLength(0);
  });

  it('路径不是绝对路径、或那个文件根本不存在时在动手之前就失败，一个脚本都不下发', async () => {
    const view = uploadLab();
    const { act, locate, page } = await boot({}, view.contents);
    locate.result = matched({ tagName: 'input', visible: false });
    for (const bad of ['relative/简历.pdf', join(uploadDir, '没有这个文件.pdf')]) {
      try {
        await act.upload(uploadSpec, bad);
        expect.unreachable(`应当拒绝 ${bad}`);
      } catch (error) {
        expect((error as AppError).code).toBe('INVALID_ARGUMENT');
      }
    }
    expect(view.log.commands).toHaveLength(0);
    expect(page.snapshotCalls).toBe(0);
  });

  it('定位没过线时上传一步都不发——注入用的地址只能来自定位', async () => {
    const view = uploadLab();
    const { act, locate } = await boot({}, view.contents);
    locate.result = { ...matched(), status: 'below-score', chosen: null, reason: '最优候选 50 分低于最低可用分 70' };
    try {
      await act.upload(uploadSpec, resumeFile);
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('LOCATE_FAILED');
    }
    expect(view.log.commands).toHaveLength(0);
  });

  it('命令都没报错但页面没收到 change 也算失败：不接受「调用没抛异常」当成功', async () => {
    const view = uploadLab(
      readyScripts,
      cdpResponses({ ...delivered, changeCount: 0, isTrusted: false, filesCount: 0, fileName: '', fileSize: 0 }),
    );
    const { act, locate, page } = await boot({}, view.contents);
    locate.result = matched({ tagName: 'input', visible: false });
    try {
      await act.upload(uploadSpec, resumeFile);
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('ACT_FAILED');
      expect((error as AppError).message).toContain('change');
      expect(errorDetails(error).filePath).toBe(resumeFile);
    }
    expect(view.log.commands).toHaveLength(8);
    expect(page.snapshotCalls).toBe(1);
  });

  it('回读的附件与请求不符时判失败，并把页面报的那个名字原样带回来', async () => {
    const view = uploadLab(readyScripts, cdpResponses({ ...delivered, fileName: '别人的简历.pdf', fileSize: 999 }));
    const { act, locate } = await boot({}, view.contents);
    locate.result = matched({ tagName: 'input', visible: false });
    try {
      await act.upload(uploadSpec, resumeFile);
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('ACT_FAILED');
      expect((error as AppError).message).toContain('别人的简历.pdf');
      expect((error as AppError).message).toContain('999');
    }
  });

  it('调试通道挂不上时上传直接失败——这条路没有 DOM 兜底，绝不能假装附件已经进去了', async () => {
    const main = fakeFrame(frameUrl, { scripts: readyScripts });
    const view = fakeDebuggerView({ main, subtree: [main], url: frameUrl, attachFails: true });
    const { act, locate } = await boot({}, view.contents);
    locate.result = matched({ tagName: 'input', visible: false });
    try {
      await act.upload(uploadSpec, resumeFile);
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('ACT_FAILED');
      expect((error as AppError).message).toContain('调试器挂不上');
    }
  });

  it('显式关掉 CDP 输入时上传报错，而不是像点击那样降级做成', async () => {
    const view = uploadLab();
    const { act, locate } = await boot({ cdpInputEnabled: false }, view.contents);
    locate.result = matched({ tagName: 'input', visible: false });
    try {
      await act.upload(uploadSpec, resumeFile);
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('ACT_FAILED');
      expect((error as AppError).message).toContain('没有 DOM 兜底');
    }
    expect(view.log.commands).toHaveLength(0);
  });

  it('页面答 isTrusted:false 时就如实报 false——注入是不是可信事件只有页面说得清', async () => {
    const view = uploadLab(readyScripts, cdpResponses({ ...delivered, isTrusted: false }));
    const { act, locate } = await boot({}, view.contents);
    locate.result = matched({ tagName: 'input', visible: false });
    const result = await act.upload(uploadSpec, resumeFile);
    expect(result).toMatchObject({ status: 'done', channel: 'cdp', trusted: false, valueAfter: resumeName });
  });
});
