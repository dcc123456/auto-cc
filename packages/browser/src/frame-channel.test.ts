import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@auto-cc/core';
import type { LocatedReading } from '@auto-cc/shared';
import { fakeFrame, fakeReading, fakeView, fireViewEvent, viewListenerChannels, writeFrame } from './test-doubles.js';
import {
  ancestorChain,
  evaluateInFrames,
  findFrameByUrl,
  frameSummary,
  framesOf,
  ordinalInParent,
  readingsFromFrames,
  settleLoad,
} from './frame-channel.js';

/**
 * 把一帧的未知读数钳成候选数组。
 * @param raw 页面脚本回读的原始值（不可信输入）
 * @returns 是数组就当候选用，否则当空命中——非数组不是失败，交给「没读到」那条路径处理
 */
const clampReadings = (raw: unknown): LocatedReading[] => (Array.isArray(raw) ? (raw as LocatedReading[]) : []);

describe('多帧覆盖（spec 2.2-08）', () => {
  it('顶层排在第一位，其余子孙帧（含跨源）都进扫描面', () => {
    const main = fakeFrame('http://127.0.0.1:10233/boss', { value: [] });
    const sameOrigin = fakeFrame('http://127.0.0.1:10233/inner', { value: [] });
    const crossOrigin = fakeFrame('http://other-origin.example/frame', { value: [] });
    const contents = fakeView(main, [main, sameOrigin, crossOrigin]);
    expect(framesOf(contents).map((frame) => frame.url)).toEqual([
      'http://127.0.0.1:10233/boss',
      'http://127.0.0.1:10233/inner',
      'http://other-origin.example/frame',
    ]);
  });

  it('还没有文档的视图返回空帧表，而不是拿着 undefined 去求值', () => {
    expect(framesOf(fakeView(null))).toEqual([]);
  });

  it('逐帧求值把结果按帧带回来，并记下哪一帧是顶层', async () => {
    const main = fakeFrame('http://127.0.0.1:10233/boss', {
      value: [fakeReading('http://127.0.0.1:10233/boss', { nodeIndex: 1 })],
    });
    const inner = fakeFrame('http://127.0.0.1:10233/inner', { value: [] });
    const evaluations = await evaluateInFrames(fakeView(main, [main, inner]), '1');
    expect(evaluations.map((item) => [item.frameUrl, item.isMain, item.error])).toEqual([
      ['http://127.0.0.1:10233/boss', true, null],
      ['http://127.0.0.1:10233/inner', false, null],
    ]);
  });

  it('单帧失败只记那一帧的原因，其余帧照样读——站点自造的浮层不该掀翻整次扫描', async () => {
    const main = fakeFrame('http://127.0.0.1:10233/boss', { error: 'Frame is detached' });
    const inner = fakeFrame('http://127.0.0.1:10233/inner', {
      value: [fakeReading('http://127.0.0.1:10233/inner', { nodeIndex: 4 })],
    });
    const evaluations = await evaluateInFrames(fakeView(main, [main, inner]), '1');
    expect(frameSummary(evaluations)).toEqual([
      'http://127.0.0.1:10233/boss: Frame is detached',
      'http://127.0.0.1:10233/inner: ok',
    ]);
    const merged = readingsFromFrames(evaluations, clampReadings);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ frameUrl: 'http://127.0.0.1:10233/inner', nodeIndex: 4 });
  });

  it('所有帧都失败是 PAGE_SCRIPT_FAILED，和「读到了但没命中」区分开', async () => {
    const main = fakeFrame('http://127.0.0.1:10233/boss', { error: '拒绝注入' });
    const evaluations = await evaluateInFrames(fakeView(main, [main]), '1');
    expect(() => readingsFromFrames(evaluations, clampReadings)).toThrow(AppError);
    try {
      readingsFromFrames(evaluations, clampReadings);
    } catch (error) {
      expect((error as AppError).code).toBe('PAGE_SCRIPT_FAILED');
      expect((error as AppError).message).toContain('拒绝注入');
    }
  });

  it('一帧都没有时不报失败——空页面本来就没有可读的帧', () => {
    expect(readingsFromFrames([], clampReadings)).toEqual([]);
  });
});

describe('帧身份与链（spec 2.2-09 的坐标折算依据）', () => {
  it('按地址找回帧对象；页面跳转后找不回就返回 null，让上层报「需要重新定位」', () => {
    const main = fakeFrame('http://127.0.0.1:10233/boss', { value: [] });
    const inner = fakeFrame('http://127.0.0.1:10233/inner', { value: [] });
    writeFrame(inner, { parent: main });
    const contents = fakeView(main, [main, inner]);
    expect(findFrameByUrl(contents, 'http://127.0.0.1:10233/inner')).toBe(inner);
    expect(findFrameByUrl(contents, 'http://127.0.0.1:10233/gone')).toBeNull();
  });

  it('祖先链由外到内，且不含自己——偏移要按这条链逐层累加', () => {
    const top = fakeFrame('http://127.0.0.1:10233/boss', { value: [] });
    const middle = fakeFrame('http://127.0.0.1:10233/mid', { value: [] });
    const leaf = fakeFrame('http://127.0.0.1:10233/leaf', { value: [] });
    writeFrame(middle, { parent: top });
    writeFrame(leaf, { parent: middle });
    expect(ancestorChain(leaf).map((frame) => frame.url)).toEqual([
      'http://127.0.0.1:10233/boss',
      'http://127.0.0.1:10233/mid',
    ]);
    expect(ancestorChain(top)).toEqual([]);
  });

  it('同地址的兄弟帧按各自位置编号，跨源时只有这个能把它们分开', () => {
    const top = fakeFrame('http://127.0.0.1:10233/boss', { value: [] });
    const first = fakeFrame('http://127.0.0.1:10233/embed', { value: [] });
    const second = fakeFrame('http://127.0.0.1:10233/embed', { value: [] });
    const unrelated = fakeFrame('http://127.0.0.1:10233/other', { value: [] });
    writeFrame(first, { parent: top });
    writeFrame(second, { parent: top });
    writeFrame(unrelated, { parent: top });
    writeFrame(top, { frames: [unrelated, first, second] });
    expect(ordinalInParent(top, first)).toBe(0);
    expect(ordinalInParent(top, second)).toBe(1);
  });

  it('身份比不上时退到最后一条同地址帧，而不是抛错', () => {
    const top = fakeFrame('http://127.0.0.1:10233/boss', { value: [] });
    const ghost = fakeFrame('http://127.0.0.1:10233/embed', { value: [] });
    const kept = fakeFrame('http://127.0.0.1:10233/embed', { value: [] });
    writeFrame(kept, { parent: top });
    writeFrame(top, { frames: [kept] });
    expect(ordinalInParent(top, ghost)).toBe(0);
  });
});

describe('等装载落定（spec 2.7-01 的正文可读时机）', () => {
  /**
   * 造一块只有顶层帧的视图。
   * @returns 视图替身（`once` / `removeListener` 由替身的事件表实现）
   */
  const viewOf = (): ReturnType<typeof fakeView> => fakeView(fakeFrame('http://127.0.0.1:10233/boss', { value: [] }));

  it('注册是同步发生的：调用返回那一刻两条监听就已经挂上，事件随后到达也不会丢', () => {
    const contents = viewOf();
    const pending = settleLoad(contents, 1_000);
    expect(viewListenerChannels(contents)).toEqual(['did-fail-load', 'did-finish-load']);
    fireViewEvent(contents, 'did-finish-load');
    return expect(pending).resolves.toBe('loaded');
  });

  it('装载失败与装载完成是两个不同的结局，不能都当成「可以读正文了」', () => {
    const contents = viewOf();
    const pending = settleLoad(contents, 1_000);
    fireViewEvent(contents, 'did-fail-load');
    return expect(pending).resolves.toBe('failed');
  });

  it('落定之后两条监听都摘干净：一次导航挂一对、挂十次就是在攒泄漏', async () => {
    const contents = viewOf();
    const pending = settleLoad(contents, 1_000);
    fireViewEvent(contents, 'did-finish-load');
    await expect(pending).resolves.toBe('loaded');
    // `once` 只保证发出那一条自己被摘掉，另一条要靠 `finish` 里的 removeListener 主动收。
    expect(viewListenerChannels(contents)).toEqual([]);
  });

  it('等不到事件就是 timeout，句柄与监听一起收掉（用假计时器，不真等）', async () => {
    const contents = viewOf();
    vi.useFakeTimers();
    try {
      let outcome = '未落定';
      const pending = settleLoad(contents, 1_000).then((value) => {
        outcome = value;
      });
      expect(viewListenerChannels(contents)).toEqual(['did-fail-load', 'did-finish-load']);
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;
      expect(outcome).toBe('timeout');
      // 计时器到点同样要走 `finish`：两条监听都得在表上消失，否则下一次装载会读到这一对的残留。
      expect(viewListenerChannels(contents)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
