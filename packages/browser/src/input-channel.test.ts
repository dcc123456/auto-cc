import { describe, expect, it } from 'vitest';
import type { ElementRect } from '@auto-cc/shared';
import { fakeDebuggerView, fakeFrame, writeFrame } from './test-doubles.js';
import {
  centerOf,
  detach,
  dispatchClick,
  dispatchType,
  ensureAttached,
  foldFrameOffsets,
  frameOffsetsOf,
  insertTextCommandOf,
  isUsable,
  mouseCommandsOf,
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
