import { describe, expect, it } from 'vitest';
import { isViewLive, liveWebContentsOf, pageVisibleOf } from './view-liveness.js';

/**
 * 「视图还活着吗」的判据面（2026-11-23 的 P1 负对照）。
 *
 * 真站上点一次「公司行业」下拉就能让内核视图消失，而壳层原先写的是
 * `view.webContents.isDestroyed()`：`webContents` 变成 undefined 时，那一行自己就是抛异常的地方
 * （`Cannot read properties of undefined (reading 'isDestroyed')`），
 * 于是一个下拉把 `shell.getStatus()` 与 `sessions.status()` 两条只读口一起打废。
 * 这里逐档钉住「不抛、给 null」，那就是「只读口只回读数」的结构保证。
 */
describe('视图活性判定（P1 负对照：视图没了也不许抛）', () => {
  it('活着：返回原句柄', () => {
    const contents = { isDestroyed: () => false, getURL: () => 'https://example.com' };
    expect(liveWebContentsOf({ webContents: contents })).toBe(contents);
    expect(isViewLive({ webContents: contents })).toBe(true);
  });

  it('已销毁：null，且不抛', () => {
    expect(liveWebContentsOf({ webContents: { isDestroyed: () => true } })).toBeNull();
    expect(isViewLive({ webContents: { isDestroyed: () => true } })).toBe(false);
  });

  it('webContents 变成 undefined（真站上撞到的形态）：null，且不抛', () => {
    expect(() => liveWebContentsOf({ webContents: undefined })).not.toThrow();
    expect(liveWebContentsOf({ webContents: undefined })).toBeNull();
    expect(() => liveWebContentsOf({})).not.toThrow();
    expect(isViewLive({})).toBe(false);
  });

  it('视图本身是 null / undefined：null，且不抛', () => {
    expect(liveWebContentsOf(null)).toBeNull();
    expect(liveWebContentsOf(undefined)).toBeNull();
    expect(isViewLive(null)).toBe(false);
  });

  it('isDestroyed 自己抛（句柄已在别处没了）：按不活处理，异常不穿到只读口', () => {
    const contents = {
      isDestroyed: () => {
        throw new Error('Object has been destroyed');
      },
    };
    expect(() => liveWebContentsOf({ webContents: contents })).not.toThrow();
    expect(liveWebContentsOf({ webContents: contents })).toBeNull();
  });

  it('没有 isDestroyed 方法的怪句柄：按不活处理，不猜它是好的', () => {
    expect(liveWebContentsOf({ webContents: {} })).toBeNull();
    expect(liveWebContentsOf({ webContents: 'x' })).toBeNull();
  });
});

/**
 * 页面层可见性（2026-11-24 的 P0 负对照）。
 *
 * 判据取 `mainFrame.visibilityState`：macOS 上应用被隐藏时 `BrowserWindow.isVisible()` 仍回 true，
 * 页面却已经 hidden。这一组分岔必须钉住，否则回归会重新漏回「后台投递留一条 unknown」。
 */
describe('页面可见性判定（P0 负对照：页面 hidden 就不许当可见）', () => {
  it('visible：true', () => {
    const contents = { isDestroyed: () => false, mainFrame: { visibilityState: 'visible' } };
    expect(pageVisibleOf(contents)).toBe(true);
  });

  it('hidden：false（应用被隐藏时就是这一格，与窗口对象的 isVisible() 分岔）', () => {
    const contents = { isDestroyed: () => false, mainFrame: { visibilityState: 'hidden' } };
    expect(pageVisibleOf(contents)).toBe(false);
  });

  it('已销毁 / 没有 mainFrame / mainFrame 抛：一律 false，且不抛', () => {
    expect(pageVisibleOf({ isDestroyed: () => true, mainFrame: { visibilityState: 'visible' } })).toBe(false);
    expect(pageVisibleOf({ isDestroyed: () => false })).toBe(false);
    expect(pageVisibleOf(null)).toBe(false);
    expect(pageVisibleOf(undefined)).toBe(false);
    const throwing = {
      isDestroyed: () => false,
      get mainFrame(): never {
        throw new Error('Object has been destroyed');
      },
    };
    expect(() => pageVisibleOf(throwing)).not.toThrow();
    expect(pageVisibleOf(throwing)).toBe(false);
  });
});
