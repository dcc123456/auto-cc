/**
 * 两张截图的像素级比对（spec 1.6-10）。
 *
 * 输出必须是**可判定的三项**：差异像素数、占比、包围盒。只回一个「不一样」不够用——
 * 视觉回归要回答的是「改坏了多大一块、在哪个区域」，包围盒还能反过来当回归证据。
 */
import { readFileSync } from 'node:fs';
import { decodePng, type Raster } from './png.js';

/** 差异像素的包围盒；两图重叠区之外的部分也算进包围盒（尺寸变化本身就是一种差异）。 */
export type DiffBox = { x: number; y: number; width: number; height: number };

export type DiffReport = {
  base: { file: string; width: number; height: number };
  head: { file: string; width: number; height: number };
  /** 单通道差值超过该阈值才算不同像素——抗抗子像素渲染与 JPEG 级噪声。 */
  threshold: number;
  isSizeMismatch: boolean;
  diffPixels: number;
  totalPixels: number;
  /** `diffPixels / totalPixels`，0 表示完全一致。 */
  ratio: number;
  box: DiffBox | null;
  isIdentical: boolean;
};

function load(file: string): Raster {
  return decodePng(readFileSync(file), file);
}

/**
 * 比对两张 PNG。
 * @param baseFile 基线截图路径
 * @param headFile 当前截图路径
 * @param threshold 单通道容差（0-255），默认 0 表示逐字节相等
 * @returns 差异像素数 / 占比 / 包围盒组成的报告
 */
export function diffPng(baseFile: string, headFile: string, threshold = 0): DiffReport {
  const base = load(baseFile);
  const head = load(headFile);
  const sharedWidth = Math.min(base.width, head.width);
  const sharedHeight = Math.min(base.height, head.height);
  const totalPixels = Math.max(base.width, head.width) * Math.max(base.height, head.height);

  let diffPixels = totalPixels - sharedWidth * sharedHeight;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  for (let y = 0; y < sharedHeight; y += 1) {
    for (let x = 0; x < sharedWidth; x += 1) {
      const offset = (y * base.width + x) * 4;
      const other = (y * head.width + x) * 4;
      const isDifferent =
        Math.abs((base.rgba[offset] as number) - (head.rgba[other] as number)) > threshold ||
        Math.abs((base.rgba[offset + 1] as number) - (head.rgba[other + 1] as number)) > threshold ||
        Math.abs((base.rgba[offset + 2] as number) - (head.rgba[other + 2] as number)) > threshold ||
        Math.abs((base.rgba[offset + 3] as number) - (head.rgba[other + 3] as number)) > threshold;
      if (isDifferent) {
        diffPixels += 1;
        grow(x, y);
      }
    }
  }

  const isSizeMismatch = base.width !== head.width || base.height !== head.height;
  // 尺寸不一致时差异其实铺满整张画布（重叠区外的像素根本没有对应物），报整张比报重叠区更诚实。
  const overlapBox: DiffBox | null = Number.isFinite(minX)
    ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
    : null;
  return {
    base: { file: baseFile, width: base.width, height: base.height },
    head: { file: headFile, width: head.width, height: head.height },
    threshold,
    isSizeMismatch,
    diffPixels,
    totalPixels,
    ratio: totalPixels === 0 ? 0 : diffPixels / totalPixels,
    box: isSizeMismatch ? { x: 0, y: 0, width: head.width, height: head.height } : overlapBox,
    isIdentical: diffPixels === 0,
  };
}
