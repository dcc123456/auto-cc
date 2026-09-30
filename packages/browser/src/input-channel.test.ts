import { describe, expect, it } from 'vitest';
import type { ElementRect } from '@auto-cc/shared';
import { fakeDebuggerView, fakeFrame, writeFrame } from './test-doubles.js';
import {
  centerOf,
  detach,
  dispatchClick,
  dispatchType,
  dispatchUpload,
  ensureAttached,
  foldFrameOffsets,
  frameOffsetsOf,
  insertTextCommandOf,
  isolatedWorldCommand,
  isUsable,
  mouseCommandsOf,
  nodeHandleCommand,
  setFileInputFilesCommand,
  toCallFunctionValue,
  toFrameEntries,
  toIsolatedContextId,
  toNodeObjectId,
  uploadDomainEnableCommands,
  uploadReadbackCommand,
  viewportPointOf,
} from './input-channel.js';

/** 一条子 iframe 位置读数。 */
const childRect = (src: string, name: string, x: number, y: number): ElementRect & { src: string; name: string } => ({
  src,
  name,
  x,
  y,
  width: 300,
  height: 200,
});

describe('坐标折算（spec 2.2-09 的 iframe 内点准）', () => {
  it('中心点 = 左上角 + 半个尺寸，帧偏移按层累加', () => {
    expect(centerOf({ x: 10, y: 20, width: 100, height: 40 })).toEqual({ x: 60, y: 40 });
    expect(
      foldFrameOffsets({ x: 60, y: 40 }, [
        { x: 5, y: 7, width: 1, height: 1 },
        { x: 11, y: 13, width: 1, height: 1 },
      ]),
    ).toEqual({ x: 76, y: 60 });
  });

  it('嵌套帧逐层认得出 iframe 元素时，视图坐标 = 帧内中心 + 各层偏移', async () => {
    const top = fakeFrame('http://127.0.0.1:10233/chat', {
      value: [childRect('http://127.0.0.1:10233/inner', 'chat', 200, 100)],
    });
    const inner = fakeFrame('http://127.0.0.1:10233/inner', { name: 'chat' });
    writeFrame(inner, { parent: top });
    writeFrame(top, { frames: [inner] });
    const offset = await frameOffsetsOf(inner);
    expect(offset).toEqual({ rects: [{ x: 200, y: 100, width: 300, height: 200 }], resolved: true });
    const point = await viewportPointOf(inner, { x: 10, y: 10, width: 100, height: 20 });
    expect(point).toEqual({ point: { x: 260, y: 120 }, resolved: true });
  });

  it('同地址的两个 iframe 按序号区分，不会永远认错第一个', async () => {
    const top = fakeFrame('http://127.0.0.1:10233/chat', {
      value: [
        childRect('http://127.0.0.1:10233/embed', '', 0, 0),
        childRect('http://127.0.0.1:10233/embed', '', 400, 50),
      ],
    });
    const first = fakeFrame('http://127.0.0.1:10233/embed');
    const second = fakeFrame('http://127.0.0.1:10233/embed');
    writeFrame(first, { parent: top });
    writeFrame(second, { parent: top });
    writeFrame(top, { frames: [first, second] });
    expect((await frameOffsetsOf(second)).rects[0]).toMatchObject({ x: 400, y: 50 });
    expect((await frameOffsetsOf(first)).rects[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('父帧里认不出对应的 iframe 元素时 resolved 为 false——上层据此退回 DOM 通道，而不是点一个猜出来的坐标', async () => {
    const top = fakeFrame('http://127.0.0.1:10233/chat', { value: [] });
    const inner = fakeFrame('http://127.0.0.1:10233/other', { name: 'x' });
    writeFrame(inner, { parent: top });
    writeFrame(top, { frames: [inner] });
    expect(await frameOffsetsOf(inner)).toEqual({ rects: [], resolved: false });
    const topFrame = fakeFrame('http://127.0.0.1:10233/chat');
    expect(await frameOffsetsOf(topFrame)).toEqual({ rects: [], resolved: true });
  });
});

describe('CDP 命令构造（spec 2.2-12）', () => {
  it('一次点击是移动 → 按下 → 抬起三条命令，坐标一致且 buttons 从 1 归 0', () => {
    const commands = mouseCommandsOf({ x: 60, y: 40 });
    expect(commands.map((item) => item.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(commands.map((item) => [item.params.x, item.params.y])).toEqual([
      [60, 40],
      [60, 40],
      [60, 40],
    ]);
    expect(commands[1]!.params).toMatchObject({ button: 'left', buttons: 1, clickCount: 1 });
    expect(commands[2]!.params).toMatchObject({ buttons: 0, clickCount: 1 });
    expect(mouseCommandsOf({ x: 1, y: 2 }, 2)[1]!.params.clickCount).toBe(2);
  });

  it('中文与 emoji 原样进 Input.insertText，不做逐键拆分——按键码打不出中文', () => {
    expect(insertTextCommandOf('自动化验收🎯')).toEqual({
      method: 'Input.insertText',
      params: { text: '自动化验收🎯' },
    });
  });
});

describe('调试器生命周期（spec 2.2-12 / 2.1-11 的残留口径）', () => {
  it('一个视图只惰性 attach 一次，之后的命令复用同一条通道', async () => {
    const { contents, log } = fakeDebuggerView();
    expect(ensureAttached(contents)).toBe(true);
    expect(ensureAttached(contents)).toBe(true);
    expect(log.attachCalls).toBe(1);
    await dispatchClick(contents, { x: 1, y: 2 });
    expect(log.attachCalls).toBe(1);
    expect(log.commands).toHaveLength(3);
    expect(isUsable(contents)).toBe(true);
    detach(contents);
    expect(log.detachCalls).toBe(1);
    expect(isUsable(contents)).toBe(false);
  });

  it('attach 被拒时不抛错，只报告不可用——外层据此改走 DOM 通道并如实标注 channel', async () => {
    const { contents, log } = fakeDebuggerView({ attachFails: true });
    expect(ensureAttached(contents)).toBe(false);
    expect(await dispatchClick(contents, { x: 1, y: 2 })).toBe(false);
    expect(await dispatchType(contents, { x: 1, y: 2 }, '招呼')).toBe(false);
    expect(log.commands).toHaveLength(0);
  });

  it('输入走 CDP 时顺序是先点落焦点再插字，命令被拒则整次算失败', async () => {
    const { contents, log } = fakeDebuggerView();
    expect(await dispatchType(contents, { x: 10, y: 20 }, '资深前端')).toBe(true);
    expect(log.commands.map((item) => item.method)).toEqual([
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.insertText',
    ]);
    expect(log.commands.at(-1)!.params.text).toBe('资深前端');
    const failing = fakeDebuggerView({ sendFails: true });
    expect(await dispatchType(failing.contents, { x: 1, y: 1 }, 'x')).toBe(false);
  });

  it('detach 遇到正在销毁的视图只清记录，不抛', () => {
    const { contents, log } = fakeDebuggerView({ isDestroyed: true });
    expect(ensureAttached(contents)).toBe(false);
    detach(contents);
    expect(log.detachCalls).toBe(0);
    expect(isUsable(contents)).toBe(false);
  });
});

const uploadUrl = 'http://127.0.0.1:10233/upload';
const resumePath = 'D:\\works\\resume\\资深前端-简历.pdf';

/**
 * 造一条「每一步都给得出回包」的注入链，按需把某一步改成失败形状。
 * @param overrides 覆盖某条命令的回包（值给成 Error 即该条被拒）
 * @returns 按 CDP 方法名组织的回包表
 */
function uploadResponses(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'Page.getFrameTree': { frameTree: { frame: { id: 'FRAME-1', url: uploadUrl }, childFrames: [] } },
    'Page.createIsolatedWorld': { executionContextId: 7 },
    'Runtime.evaluate': { result: { type: 'object', subtype: 'node', objectId: 'NODE-1' } },
    'Runtime.callFunctionOn': {
      result: {
        type: 'object',
        value: {
          changeCount: 1,
          isTrusted: true,
          filesCount: 1,
          fileName: '资深前端-简历.pdf',
          fileSize: 226,
          fileType: 'application/pdf',
        },
      },
    },
    ...overrides,
  };
}

/**
 * 沿注入链走一次。
 * @param responses 回包表
 * @param view attach 失败等视图级选项
 * @returns 注入结局与命令日志
 */
async function uploadOnce(responses: Record<string, unknown>, view: Parameters<typeof fakeDebuggerView>[0] = {}) {
  const handle = fakeDebuggerView({ url: uploadUrl, responses, ...view });
  const injection = await dispatchUpload(handle.contents, uploadUrl, 'HANDLE', resumePath, 'READBACK');
  return { injection, log: handle.log };
}

describe('文件注入通道（spec 2.6-04 / plan §13.3 第 4 条）', () => {
  it('链路就是被实测认下的那五步，每条命令只带被验证过的那几个参数', async () => {
    const { injection, log } = await uploadOnce(uploadResponses());
    expect(log.commands.map((item) => item.method)).toEqual([
      'Page.enable',
      'Runtime.enable',
      'DOM.enable',
      'Page.getFrameTree',
      'Page.createIsolatedWorld',
      'Runtime.evaluate',
      'DOM.setFileInputFiles',
      'Runtime.callFunctionOn',
    ]);
    expect(log.commands[4]!.params).toEqual({ frameId: 'FRAME-1', worldName: 'auto-cc-upload' });
    expect(log.commands[5]!.params).toMatchObject({ expression: 'HANDLE', returnByValue: false, contextId: 7 });
    expect(log.commands[6]!.params).toEqual({ files: [resumePath], objectId: 'NODE-1' });
    expect(log.commands[7]!.params).toMatchObject({
      objectId: 'NODE-1',
      functionDeclaration: 'READBACK',
      returnByValue: true,
      awaitPromise: true,
    });
    expect(injection).toMatchObject({
      ok: true,
      error: '',
      reading: { changeCount: 1, isTrusted: true, fileName: '资深前端-简历.pdf', fileSize: 226 },
    });
  });

  it('寻址只用 objectId：四条被实测否决的路一条都不进命令', async () => {
    const { log } = await uploadOnce(uploadResponses());
    const sent = JSON.stringify(log.commands);
    for (const rejected of ['selector', 'nodeId', 'requestNode']) expect(sent).not.toContain(rejected);
  });

  it('帧树里对不上这一帧时后面的命令一条都不发——跨帧注入必须是另一条已验证的路', async () => {
    const { injection, log } = await uploadOnce(
      uploadResponses({ 'Page.getFrameTree': { frameTree: { frame: { id: 'X', url: 'http://elsewhere/' } } } }),
    );
    expect(injection.ok).toBe(false);
    expect(injection.error).toContain('帧树里已经没有这一帧');
    expect(injection.reading.changeCount).toBe(0);
    expect(log.commands).toHaveLength(4);
  });

  it('回包畸形（没有 executionContextId）当作建世界失败，而不是拿 undefined 继续往下发', async () => {
    const { injection, log } = await uploadOnce(uploadResponses({ 'Page.createIsolatedWorld': {} }));
    expect(injection.error).toContain('创建隔离世界失败');
    expect(log.commands).toHaveLength(5);
  });

  it('求值交出 null 就是「定位时那一个节点已经不在了」，绝不退回去注第一个同类控件', async () => {
    const { injection, log } = await uploadOnce(
      uploadResponses({ 'Runtime.evaluate': { result: { type: 'object', subtype: 'null' } } }),
    );
    expect(injection.ok).toBe(false);
    expect(injection.error).toContain('页面里已经没有');
    expect(log.commands.map((item) => item.method)).not.toContain('DOM.setFileInputFiles');
  });

  it('脚本抛异常与「结果不是节点」两种回包各说各话，界面才知道是脚本挂了还是选错了控件', async () => {
    const thrown = await uploadOnce(uploadResponses({ 'Runtime.evaluate': { exceptionDetails: { text: 'boom' } } }));
    expect(thrown.injection.error).toContain('抛了异常');
    const notNode = await uploadOnce(
      uploadResponses({ 'Runtime.evaluate': { result: { type: 'string', value: 'x' } } }),
    );
    expect(notNode.injection.error).toContain('不是一个节点');
  });

  it('注入命令被拒时把 CDP 的原因原样带回来，并认定这次没有成功', async () => {
    const { injection, log } = await uploadOnce(uploadResponses({ 'DOM.setFileInputFiles': new Error('Not allowed') }));
    expect(injection.ok).toBe(false);
    expect(injection.error).toBe('Not allowed');
    expect(log.commands).toHaveLength(7);
  });

  it('回包读不到值时 ok 仍为真但读数全零——文件进没进控件由上层比对，不在这里替它宣称', async () => {
    const { injection } = await uploadOnce(uploadResponses({ 'Runtime.callFunctionOn': {} }));
    expect(injection.ok).toBe(true);
    expect(injection.reading).toEqual({
      changeCount: 0,
      isTrusted: false,
      filesCount: 0,
      fileName: '',
      fileSize: 0,
      fileType: '',
    });
  });

  it('调试通道挂不上（被别的客户端占用 / 视图已销毁）时直接失败，不抛异常', async () => {
    const attached = fakeDebuggerView({ attachFails: true, responses: uploadResponses() });
    expect((await dispatchUpload(attached.contents, uploadUrl, 'HANDLE', resumePath, 'READBACK')).ok).toBe(false);
    expect(attached.log.commands).toHaveLength(0);
    const destroyed = await uploadOnce(uploadResponses(), { isDestroyed: true });
    expect(destroyed.injection.error).toContain('调试器挂不上');
  });

  it('帧树拍平按由外到内、子帧在后；回包形状不对就是空表', () => {
    expect(
      toFrameEntries({
        frameTree: {
          frame: { id: 'A', url: 'http://top' },
          childFrames: [
            { frame: { id: 'B', url: 'http://mid' }, childFrames: [{ frame: { id: 'C', url: uploadUrl } }] },
          ],
        },
      }),
    ).toEqual([
      { frameId: 'A', url: 'http://top' },
      { frameId: 'B', url: 'http://mid' },
      { frameId: 'C', url: uploadUrl },
    ]);
    expect(toFrameEntries({})).toEqual([]);
    expect(toFrameEntries(null)).toEqual([]);
    expect(toFrameEntries({ frameTree: { frame: { id: 'A' } } })).toEqual([]);
  });

  it('上下文 id 与 objectId 各自钳齐：NaN、异常回包、非节点结果都拿不到可用的引用', () => {
    expect(toIsolatedContextId({ executionContextId: 7 })).toBe(7);
    expect(toIsolatedContextId({ executionContextId: Number.NaN })).toBeNull();
    expect(toIsolatedContextId({})).toBeNull();
    expect(toNodeObjectId({ result: { type: 'object', subtype: 'node', objectId: 'N' } })).toEqual({
      objectId: 'N',
      error: '',
    });
    expect(toNodeObjectId({ exceptionDetails: {} }).objectId).toBeNull();
    expect(toNodeObjectId({ result: { type: 'object', subtype: 'null' } }).error).toContain('已经没有');
    expect(toNodeObjectId({ result: { type: 'number', value: 1 } }).error).toContain('不是一个节点');
    expect(toCallFunctionValue({ result: { value: { changeCount: 2 } } })).toEqual({ changeCount: 2 });
    expect(toCallFunctionValue({ result: {} })).toEqual({});
    expect(toCallFunctionValue(undefined)).toEqual({});
  });

  it('命令构造器把「只用 objectId」这件事写在形状里：文件是绝对路径数组，回读绑定同一个引用', () => {
    expect(uploadDomainEnableCommands().map((item) => item.method)).toEqual([
      'Page.enable',
      'Runtime.enable',
      'DOM.enable',
    ]);
    expect(isolatedWorldCommand('F1')).toEqual({
      method: 'Page.createIsolatedWorld',
      params: { frameId: 'F1', worldName: 'auto-cc-upload' },
    });
    expect(nodeHandleCommand('EXPR', 3).params).toEqual({ expression: 'EXPR', returnByValue: false, contextId: 3 });
    expect(setFileInputFilesCommand([resumePath], 'N1').params).toEqual({ files: [resumePath], objectId: 'N1' });
    expect(uploadReadbackCommand('N1', 'FN').params).toMatchObject({ objectId: 'N1', awaitPromise: true });
  });
});
