/**
 * 覆盖区到底用什么颜色（spec 3.5-14）。
 *
 * 这一层存在的唯一理由是那一句报障：「覆盖式方式太丑了，能明显看到底部的文字」。查实的四个来源里，
 * 头一个是**遮罩写死纯白**（`fillStyle='#ffffff'`）而纸底很少是纯白，第二个是**提交态还常驻一圈虚线**。
 * 于是颜色在这里收成一处：纸面画布取 `fillHex` / `inkHex`，另存的产物取 `fillRgb01` / `inkRgb01`，
 * **两条腿读同一个判据**（AGENTS.md §2.5）——画面上看到什么，产物里就是什么，这是 spec 3.5-02 的底线。
 *
 * 一条诚实的回落（不许猜白）：从位图上取不到可靠底色时，遮罩按**墨色**垫底、新字反白。
 * 宁可难看也要说得出真相：猜白会得到一张"看着像改好了、其实每一块都在纸底上泛出一只只白盒子"的产物，
 * 而那正是本轮要消掉的症状。回落这一处在界面上必须有一句话读数（`PdfPaperView` 的 `backdropFallback`）。
 */

/** 取不到页面底色时的垫底色（墨黑）。 */
const BACKDROP_FALLBACK_HEX = '#111111';
/** 墨底之上的新字只能反白，否则那一句根本看不见。 */
const INK_ON_FALLBACK_HEX = '#f8fafc';
/** 取到了底色、但这一行还没有可依据的原文墨色时用的墨色（与源文档常见的深墨同档）。 */
const DEFAULT_INK_HEX = '#0f172a';

/** 六个十六进制位组成的颜色（`#rrggbb`）——画布与 `pdf-lib` 都只吃得下这一种写法。 */
const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** 归一化后的颜色通道三元组，各通道 0..255。 */
type Rgb255 = readonly [number, number, number];

/**
 * 校验并归一化一条颜色（外部输入的唯一落点：渲染层递来的 `backdropHex` 在换算与绘制之前先过这一句）。
 * @param value 待判的值（不可信：来自跨进程的 JSON 实参）
 * @returns 小写的 `#rrggbb`；形状不对（非字符串、带 alpha、越界字符）一律 undefined，由调用方走同一句回落
 */
export function normalizeHexColor(value: unknown): string | undefined {
  if (typeof value !== 'string' || !HEX_PATTERN.test(value)) return undefined;
  return value.toLowerCase();
}

/**
 * 一条覆盖区在两条腿上的最终配色。
 *
 * `backdropHex` 是渲染层从**已渲染的位图**上量出来的那块纸的底色（见 `pdf-page-view.ts` 的 `sampleBackdrop`）；
 * 缺它即"没量到"，于是走墨色垫底并把新字反白——两条腿必须一起换，只换一条就会出现"屏幕上墨底白字、
 * 产物里墨底黑字"这种谁都不认的产物。
 * @param overlay 覆盖区里带得出颜色的那部分（`backdropHex` 可有可无）
 * @returns `sampled` 说明这块底色是不是量到的；两个 `*Rgb01` 是给 `pdf-lib` 的 0..1 写法
 */
export function colorsOfOverlay(overlay: { readonly backdropHex?: string }): {
  readonly fillHex: string;
  readonly fillRgb01: readonly [number, number, number];
  readonly inkHex: string;
  readonly inkRgb01: readonly [number, number, number];
  readonly sampled: boolean;
} {
  const sampled = normalizeHexColor(overlay.backdropHex);
  const fillHex = sampled ?? BACKDROP_FALLBACK_HEX;
  const inkHex = sampled === undefined ? INK_ON_FALLBACK_HEX : DEFAULT_INK_HEX;
  return {
    fillHex,
    fillRgb01: hexToRgb01(fillHex),
    inkHex,
    inkRgb01: hexToRgb01(inkHex),
    sampled: sampled !== undefined,
  };
}

/**
 * 十六进制颜色 → 逐通道 0..1（`pdf-lib` 的 `rgb()` 只收这一种）。
 *
 * 入参只可能是本模块给出的那几个常量或 `normalizeHexColor` 的结果，所以这里不再判形状（§2.6）。
 * @param hex `#rrggbb`
 * @returns 归一化到 0..1 的三个通道
 */
function hexToRgb01(hex: string): readonly [number, number, number] {
  const [red, green, blue] = hexToRgb255(hex);
  return [red / 255, green / 255, blue / 255];
}

/**
 * 十六进制颜色 → 逐通道 0..255。
 * @param hex `#rrggbb`（本模块内部来源，形状已由 `normalizeHexColor` 保证）
 * @returns 三个通道的整数值
 */
function hexToRgb255(hex: string): Rgb255 {
  const body = hex.slice(1);
  return [
    Number.parseInt(body.slice(0, 2), 16),
    Number.parseInt(body.slice(2, 4), 16),
    Number.parseInt(body.slice(4, 6), 16),
  ];
}

/**
 * 一条环带的像素（`getImageData` 的原样返回物）与它中央那块要盖住的盒。
 *
 * 只给环带、不给整页：一页 150dpi 是三百来万像素，而底色只需要盒外那一圈几百个像素就能定下来，
 * 全页扫描在拖把手的那种节奏下会把主线程占满（spec 3.5-14 明确写着"一行一次，不做全页扫描"）。
 */
export interface BackdropBand {
  /** RGBA 逐行排列的带内像素（`ImageData.data`） */
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
  /** 盒在**带内**的左上角与宽高（px）：带是盒外扩一圈得到的，所以这四个数就是那条圈的内沿 */
  readonly innerX: number;
  readonly innerY: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
  /** 每隔几个像素取一个（环带可能有几千像素，取样到几百个足够定中位数） */
  readonly stepPx: number;
  /** 至少取到几个才算量到了底色；不足即 undefined（调用方走回落，绝不猜一个数） */
  readonly minSamples: number;
}

/**
 * 从行盒**之外**那一圈像素里定出页面的底色。
 *
 * 判据取**逐通道中位数**而不是平均值，这不是精度上的讲究而是这一条路线上绕不开的实测：
 * 一圈像素必然扫到相邻行的墨迹（纸上的行是上下叠着的），而一行字只占那一圈的一小段——
 * 平均值会被那几笔黑拉过去（`overlay-colors.test.ts` 里那张 12.5% 污染量的米白：红通道 255 被拉到 223），中位数不动。
 * @param band 环带像素与内沿
 * @returns `#rrggbb`；取样不足或带子无效时 undefined（**不猜白**）
 */
export function backdropOfBand(band: BackdropBand): string | undefined {
  if (band.width < 1 || band.height < 1 || band.data.length < band.width * band.height * 4) return undefined;
  const step = Math.max(1, Math.round(band.stepPx));
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  for (let y = 0; y < band.height; y += step) {
    for (let x = 0; x < band.width; x += step) {
      const inBox =
        x >= band.innerX && x < band.innerX + band.innerWidth && y >= band.innerY && y < band.innerY + band.innerHeight;
      if (inBox) continue;
      const offset = (y * band.width + x) * 4;
      // 透明像素不是纸（画布还没被 pdf.js 铺满的那些格子），把它们算进中位数会一路偏向白。
      if ((band.data[offset + 3] ?? 0) < 200) continue;
      red.push(band.data[offset] ?? 0);
      green.push(band.data[offset + 1] ?? 0);
      blue.push(band.data[offset + 2] ?? 0);
    }
  }
  if (red.length < band.minSamples) return undefined;
  return `#${[red, green, blue]
    .map((channel) => Math.round(medianOf(channel)).toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * 一组数的中位数（要求调用方给的数组非空）。
 * @param values 一组可排序的数
 * @returns 中间那一档；偶数个时取中间两数的平均
 */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((one, two) => one - two);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}
