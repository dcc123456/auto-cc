/**
 * 像素比对单测（spec 1.6-10）：差异数量、包围盒、尺寸不一致三条路径都要有确定读数。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffPng } from './diff.js';
import { encodePng, gradientRgba } from './png-fixtures.js';

const WIDTH = 12;
const HEIGHT = 8;
const dir = mkdtempSync(join(tmpdir(), 'auto-cc-diff-'));

/** 写一张临时 PNG 并回传路径，让 diffPng 走真实的文件读取路径。 */
function write(fileName: string, bytes: Buffer): string {
  const file = join(dir, fileName);
  writeFileSync(file, bytes);
  return file;
}

describe('diffPng', () => {
  it('同一张图自比为完全一致', () => {
    const rgba = gradientRgba(WIDTH, HEIGHT);
    const file = write('same.png', encodePng(rgba, WIDTH, HEIGHT, 4));
    const report = diffPng(file, file);
    expect(report.isIdentical).toBe(true);
    expect(report.diffPixels).toBe(0);
    expect(report.box).toBeNull();
  });

  it('改一处像素能报出数量与包围盒', () => {
    const rgba = gradientRgba(WIDTH, HEIGHT);
    const base = write('base.png', encodePng(rgba, WIDTH, HEIGHT, 1));
    const touched = Buffer.from(rgba);
    const x = 5;
    const y = 2;
    touched[(y * WIDTH + x) * 4] = 0;
    const head = write('head.png', encodePng(touched, WIDTH, HEIGHT, 1));
    const report = diffPng(base, head);
    expect(report.isIdentical).toBe(false);
    expect(report.diffPixels).toBe(1);
    expect(report.box).toEqual({ x, y, width: 1, height: 1 });
  });

  it('容差能吸收亚像素级噪声', () => {
    const rgba = gradientRgba(WIDTH, HEIGHT);
    const base = write('tol-base.png', encodePng(rgba, WIDTH, HEIGHT, 0));
    const touched = Buffer.from(rgba);
    touched[0] = ((touched[0] as number) + 3) & 0xff;
    const head = write('tol-head.png', encodePng(touched, WIDTH, HEIGHT, 0));
    expect(diffPng(base, head).diffPixels).toBe(1);
    expect(diffPng(base, head, 5).isIdentical).toBe(true);
  });

  it('尺寸不同按整张差异算，并标出尺寸不一致', () => {
    const base = write('size-base.png', encodePng(gradientRgba(WIDTH, HEIGHT), WIDTH, HEIGHT, 0));
    const head = write('size-head.png', encodePng(gradientRgba(WIDTH + 2, HEIGHT), WIDTH + 2, HEIGHT, 0));
    const report = diffPng(base, head);
    expect(report.isSizeMismatch).toBe(true);
    expect(report.diffPixels).toBeGreaterThan(0);
    expect(report.box).toEqual({ x: 0, y: 0, width: WIDTH + 2, height: HEIGHT });
  });
});
