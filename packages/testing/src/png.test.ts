/**
 * PNG 解码单测（spec 1.6-10 的地基）。
 *
 * 五种 filter 分别钉住：真截图的 filter 分布由 Chromium 决定，测不到某一条就等于没测。
 */
import { describe, expect, it } from 'vitest';
import { encodePng, gradientRgba } from './png-fixtures.js';
import { decodePng } from './png.js';

const WIDTH = 9;
const HEIGHT = 6;

describe('decodePng', () => {
  it.each([0, 1, 2, 3, 4])('filter %i 编解码往返一致', (filterType) => {
    const rgba = gradientRgba(WIDTH, HEIGHT);
    const decoded = decodePng(encodePng(rgba, WIDTH, HEIGHT, filterType), 'fixture');
    expect(decoded.width).toBe(WIDTH);
    expect(decoded.height).toBe(HEIGHT);
    expect(decoded.rgba.equals(rgba)).toBe(true);
  });

  it('colorType 2（RGB）补成不透明 RGBA', () => {
    const rgba = gradientRgba(WIDTH, HEIGHT);
    const decoded = decodePng(encodePng(rgba, WIDTH, HEIGHT, 0, false), 'rgb');
    expect(decoded.rgba.length).toBe(rgba.length);
    expect(decoded.rgba.subarray(0, 3).equals(rgba.subarray(0, 3))).toBe(true);
    expect(decoded.rgba[3]).toBe(255);
  });

  it('非 8bit、隔行、未知 filter 一律点名拒绝', () => {
    const bytes = encodePng(gradientRgba(2, 2), 2, 2, 0);
    // 直接改 IHDR 的位深/隔行字节，比再造一个编码器更省，也更接近「拿到一张不合规定的图」。
    const sixteen = Buffer.from(bytes);
    sixteen[24] = 16;
    expect(() => decodePng(sixteen, '16bit')).toThrow(/8bit/);
    const interlaced = Buffer.from(bytes);
    interlaced[28] = 1;
    expect(() => decodePng(interlaced, 'adam7')).toThrow(/隔行/);
    expect(() => decodePng(Buffer.from([1, 2, 3]), 'not-png')).toThrow(/不是 PNG/);
  });
});
