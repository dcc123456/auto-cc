/**
 * 最小 PNG 解码（spec 1.6-10 的地基）。
 *
 * 只支持 Chromium `Page.captureScreenshot` 实际会产出的那一种形态：8bit 位深、非隔行、
 * colorType 2（RGB）或 6（RGBA）。其余形态一律点名拒绝，而不是解出个像是的东西——
 * 视觉回归的基线要是错的，后面所有「有没有改坏」的判定都不可信。
 *
 * 为什么自己写：引 pngjs/pixelmatch 会多一个运行时依赖，而 1.7 要审计「产物自包含、零下载」，
 * 依赖越少越好；这里需要的只是 IHDR + IDAT + inflate + 五种 filter 反变换。
 */
import { inflateSync } from 'node:zlib';

/** 解码后的像素缓冲：行主序 RGBA，每像素 4 字节。 */
export type Raster = { width: number; height: number; rgba: Buffer };

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 每个 chunk 的固定开销：4 字节长度 + 4 字节类型 + 4 字节 CRC。 */
const CHUNK_OVERHEAD = 12;

/** Paeth 预测器（PNG 规范定义的整数版本，不用浮点）。 */
function paeth(left: number, up: number, upperLeft: number): number {
  const p = left + up - upperLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upperLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upperLeft;
}

/**
 * 解码 PNG 字节为 RGBA 栅格。
 * @param bytes 文件原始字节
 * @param source 出错时点名是哪个文件（截图成对比较，不写清就会拿错基线）
 * @returns 宽高与 RGBA 缓冲
 * @throws 签名不符、格式超出支持范围、或 IDAT 解压失败
 */
export function decodePng(bytes: Buffer, source = '<memory>'): Raster {
  if (!bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw new Error(`不是 PNG 文件：${source}`);
  let offset = SIGNATURE.length;
  let header: { width: number; height: number; bitDepth: number; colorType: number; interlace: number } | undefined;
  const idat: Buffer[] = [];
  while (offset + CHUNK_OVERHEAD <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8] as number,
        colorType: data[9] as number,
        interlace: data[12] as number,
      };
      if (header.bitDepth !== 8) throw new Error(`只支持 8bit 位深，${source} 是 ${String(header.bitDepth)}`);
      if (header.colorType !== 2 && header.colorType !== 6) {
        throw new Error(`只支持 colorType 2/6（RGB/RGBA），${source} 是 ${String(header.colorType)}`);
      }
      // 隔行（Adam7）的行序完全不同，按上面的 stride 反变换会得到错位像素。
      if (header.interlace !== 0) throw new Error(`不支持隔行 PNG：${source}`);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += CHUNK_OVERHEAD + length;
  }
  if (!header) throw new Error(`缺少 IHDR 块：${source}`);
  if (idat.length === 0) throw new Error(`缺少 IDAT 块：${source}`);
  const { width, height, colorType } = header;
  const channels = colorType === 6 ? 4 : 3;
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  // 每行前面还有一个 filter 类型字节，所以解压出的长度是 height * (stride + 1)。
  if (inflated.length !== height * (stride + 1)) {
    throw new Error(`解压长度不符（${String(inflated.length)} ≠ ${String(height * (stride + 1))}）：${source}`);
  }

  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const filterType = inflated[y * (stride + 1)] as number;
    const current = Buffer.from(inflated.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    const previous = y === 0 ? Buffer.alloc(stride) : (rows[y - 1] as Buffer);
    // bpp 以字节计：8bit 下一像素 3 或 4 字节，Sub/Paeth 的左邻取样按它回退。
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? (current[x - channels] as number) : 0;
      const up = previous[x] as number;
      const upperLeft = x >= channels ? (previous[x - channels] as number) : 0;
      const raw = current[x] as number;
      if (filterType === 0) continue;
      else if (filterType === 1) current[x] = (raw + left) & 0xff;
      else if (filterType === 2) current[x] = (raw + up) & 0xff;
      else if (filterType === 3) current[x] = (raw + ((left + up) >> 1)) & 0xff;
      else if (filterType === 4) current[x] = (raw + paeth(left, up, upperLeft)) & 0xff;
      else throw new Error(`未知 filter 类型 ${String(filterType)}：${source}`);
    }
    rows.push(current);
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = rows[y] as Buffer;
    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      rgba[to] = row[from] as number;
      rgba[to + 1] = row[from + 1] as number;
      rgba[to + 2] = row[from + 2] as number;
      // RGB（无 alpha）补成不透明，比较时不必再分两种通道数。
      rgba[to + 3] = channels === 4 ? ((row[from + 3] as number) ?? 255) : 255;
    }
  }
  return { width, height, rgba };
}
