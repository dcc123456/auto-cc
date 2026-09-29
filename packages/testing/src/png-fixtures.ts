/**
 * 测试用的最小 PNG 编码器（只给单测造样本，不进任何运行路径）。
 *
 * 为什么要有它：解码器最值钱的部分是五种 filter 的反变换，而那正是「拿一张真截图喂进去」
 * 测不稳的地方——真图的 filter 分布不由我们决定。这里能按 filter 类型逐一造图，
 * 才能把每种反变换分别钉住。CRC 也按规范算，避免测试样本成为「只有我们能读的 PNG」。
 */
import { deflateSync } from 'node:zlib';

/** PNG 规范的多项式表（0xEDB88320 反向 CRC32）。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

/**
 * 计算 CRC32（PNG 的 chunk 校验把类型与数据一起算）。
 * @param bytes 参与校验的字节
 * @returns 无符号校验值
 */
function crc32(bytes: Buffer): number {
  let crc = -1;
  for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] as number);
  return (crc ^ -1) >>> 0;
}

/**
 * 拼一个 chunk：长度 + 类型 + 数据 + CRC。
 * @param type 四字节类型，如 `IHDR`
 * @param data 该类型的载荷
 */
function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
  return Buffer.concat([header, data, crc]);
}

/** 前向 Paeth 预测器，与解码端的整数定义一致。 */
function paethPredict(left: number, up: number, upperLeft: number): number {
  const p = left + up - upperLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upperLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upperLeft;
}

/**
 * 把 RGBA 像素编码成 PNG 字节。
 * @param rgba 行主序 RGBA 缓冲
 * @param width 像素宽
 * @param height 像素高
 * @param filterType 0-4（None/Sub/Up/Average/Paeth），决定解码端走哪条反变换
 * @param hasAlpha 为 false 时按 colorType 2（RGB）编码
 * @returns 完整 PNG 文件字节
 */
export function encodePng(rgba: Buffer, width: number, height: number, filterType = 0, hasAlpha = true): Buffer {
  const channels = hasAlpha ? 4 : 3;
  const stride = width * channels;
  // 先把每行的**原始**字节摊出来：PNG 的 filter 是相对原始值算的（left/up 取本行与上一行的
  // 未过滤字节），要是从已过滤的缓冲里回读，编解码就对不上，测试会假绿。
  const sourceRows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      if (hasAlpha) row[x] = rgba[y * stride + x] as number;
      else {
        const pixel = (y * width + Math.floor(x / 3)) * 4;
        row[x] = rgba[pixel + (x % 3)] as number;
      }
    }
    sourceRows.push(row);
  }

  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = filterType;
    const current = sourceRows[y] as Buffer;
    const previous = y === 0 ? Buffer.alloc(stride) : (sourceRows[y - 1] as Buffer);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? (current[x - channels] as number) : 0;
      const up = previous[x] as number;
      const upperLeft = x >= channels ? (previous[x - channels] as number) : 0;
      const predicted =
        filterType === 0
          ? 0
          : filterType === 1
            ? left
            : filterType === 2
              ? up
              : filterType === 3
                ? (left + up) >> 1
                : paethPredict(left, up, upperLeft);
      raw[rowStart + 1 + x] = ((current[x] as number) - predicted) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = hasAlpha ? 6 : 2; // color type
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 生成一块可预测的渐变 RGBA，便于断言「解出来的就是这张图」。 */
export function gradientRgba(width: number, height: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      rgba[offset] = (x * 7) & 0xff;
      rgba[offset + 1] = (y * 11) & 0xff;
      rgba[offset + 2] = (x * 3 + y * 5) & 0xff;
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}
