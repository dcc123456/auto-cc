import { describe, expect, it } from 'vitest';
import { clampWindowSize, DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE, parseWindowSize } from './window-size.js';

/**
 * 启动尺寸通道（2026-11-23 裁定：31 的三档取证只能起三次真实实例）。
 *
 * 判据的重点是**非法输入一律退回默认**：取证用的环境变量一旦被写坏（少一边、写成 `1024*768`），
 * 不能把窗口建成 0×0 让整轮读数作废——那不是「配置生效」，那是静默坏掉。
 * 「过小」不是非法：它按最小窗口抬升（299 不再建成 299，也不会静默变成 1200），见下面那条用例。
 */
describe('AUTO_CC_WINDOW_SIZE 的解析', () => {
  it('常规写法：1024x768 / 1280×800 都认', () => {
    expect(parseWindowSize('1024x768')).toEqual({ width: 1024, height: 768 });
    expect(parseWindowSize('1280×800')).toEqual({ width: 1280, height: 800 });
    expect(parseWindowSize(' 1600 x 1000 ')).toEqual({ width: 1600, height: 1000 });
  });

  it('未设置返回 null（调用方用默认 1200×800）', () => {
    expect(parseWindowSize(undefined)).toBeNull();
    expect(DEFAULT_WINDOW_SIZE).toEqual({ width: 1200, height: 800 });
  });

  it('非法一律 null：缺一边、分隔符不认识、非数字、超过最大边界', () => {
    expect(parseWindowSize('1024')).toBeNull();
    expect(parseWindowSize('1024*768')).toBeNull();
    expect(parseWindowSize('wide x tall')).toBeNull();
    expect(parseWindowSize('99999x768')).toBeNull();
    expect(parseWindowSize('')).toBeNull();
  });

  it('过小不算非法：解析照收、由调用方抬到最小窗口（不能静默变成 1200）', () => {
    expect(parseWindowSize('100x100')).toEqual({ width: 100, height: 100 });
    expect(clampWindowSize({ width: 100, height: 100 })).toEqual({ width: 720, height: 560 });
  });

  it('最小窗口 720×560：请求更窄时被抬到最小，合法的请求原样通过', () => {
    expect(MIN_WINDOW_SIZE).toEqual({ width: 720, height: 560 });
    // 299 那种整窗退化态（2026-11-24 裁定）——请求它只会得到最小窗口，不会建成 299。
    expect(clampWindowSize({ width: 299, height: 900 })).toEqual({ width: 720, height: 900 });
    expect(clampWindowSize({ width: 900, height: 400 })).toEqual({ width: 900, height: 560 });
    expect(clampWindowSize({ width: 720, height: 560 })).toEqual({ width: 720, height: 560 });
    expect(clampWindowSize({ width: 1600, height: 1000 })).toEqual({ width: 1600, height: 1000 });
    expect(clampWindowSize(DEFAULT_WINDOW_SIZE)).toEqual({ width: 1200, height: 800 });
  });
});
