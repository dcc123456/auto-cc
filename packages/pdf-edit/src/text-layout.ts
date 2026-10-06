/**
 * 文本项坐标（plan §7.3 的 `text-layout.ts` / §7.4 的 `pdf.layout`，spec 3.5-01 的「线框」半边）：
 * pdf.js 的一条文本项 → 页面上的一块矩形，存成**比例坐标**（原点左上、y 向下）。
 *
 * 为什么翻轴放在主进程这一侧而不是渲染层：线框和将来人亲手框出来的覆盖区必须是同一份
 * `PdfOverlayRect`（§7.5 第 2 行），否则「看得见的文本块」与「盖上去的位置」会差一个符号；
 * 而渲染层没有测试面（§7.1 的 V 腿要真实窗口），换算只有写在这里才可能被单测钉住。
 *
 * 两个坐标系（口径照 `overlay-writer.ts` 的头注释，两边必须对上）：
 * - pdf.js 的 `transform` 在 **PDF 用户空间**：原点左下、y 向上，`[a,b,c,d,e,f]` 的 `e/f` 是文字基线的左下角。
 * - 界面看的是**视觉坐标**：原点左上、y 向下。换算式 `yRatio = (pageHeightPt - (f + heightPt)) / pageHeightPt`。
 * - 页面宽高取 `PdfPageMetric`（即 pdf-lib 的 MediaBox），与另存腿换算 pt 用的是同一份数，
 *   因此 CropBox 与 MediaBox 不重合、或 MediaBox 原点非零的文档，线框与覆盖区会一起偏——这是继承自
 *   另存腿的既有口径（plan §7.15 记了这条限制），不在这条链上单独修。
 */
import type { PdfOverlayRect } from './overlay-writer.js';
import type { PdfPageMetric } from './pdf-document.js';

/**
 * pdf.js 文本项的结构切片——只声明换算真要用的四个成员，不依赖它的类型入口
 * （口径照 `packages/resume-kb/src/source.ts` 第 68 行那条：第三方类型跨版本漂移大）。
 */
export interface PdfTextItemSlice {
  /** 文本内容；本模块只用它判「这一项有没有可画的东西」，**不参与回传**（见 `layout-service.ts` 的脱敏注释） */
  readonly str?: unknown;
  /** 文字矩阵 `[a,b,c,d,e,f]` */
  readonly transform?: unknown;
  /** 项宽（PDF 用户空间单位，即 pt） */
  readonly width?: unknown;
  /** 项高（PDF 用户空间单位，即 pt） */
  readonly height?: unknown;
}

/**
 * 把一条文本项换算成视觉比例矩形。
 * @param item pdf.js 的文本项（成员类型是 `unknown`，本函数自己判合法性）
 * @param page 该页的度量（`widthPt` / `heightPt`，单位 pt，来自 `PdfPageMetric`）
 * @returns 比例矩形；空文本、尺寸非正、坐标不是有限数时返回 `null`，表示这一项不该画线框
 */
export function textItemRect(item: PdfTextItemSlice, page: PdfPageMetric): PdfOverlayRect | null {
  if (typeof item.str !== 'string' || item.str.trim() === '') return null;
  const transform = item.transform;
  if (!Array.isArray(transform) || transform.length < 6) return null;
  const leftPt = numberAt(transform, 4);
  // `f` 是基线，不是顶边：线框要罩住字形，所以底边取基线、高度取项高（升部与降部都算进去）。
  const bottomPt = numberAt(transform, 5);
  const widthPt = numberAt(item.width);
  const heightPt = numberAt(item.height);
  if (leftPt === null || bottomPt === null || widthPt === null || heightPt === null) return null;
  if (widthPt <= 0 || heightPt <= 0) return null;
  if (page.widthPt <= 0 || page.heightPt <= 0) return null;
  return {
    xRatio: leftPt / page.widthPt,
    yRatio: (page.heightPt - (bottomPt + heightPt)) / page.heightPt,
    widthRatio: widthPt / page.widthPt,
    heightRatio: heightPt / page.heightPt,
  };
}

/**
 * 读取数组或标量里的一个有限数。
 * @param value 待读的 `unknown`（数组按下标取，标量直接用）
 * @param index 下标（省略时按标量处理）
 * @returns 有限数，或 `null` 表示不是数
 */
function numberAt(value: unknown, index?: number): number | null {
  // `Array.isArray` 在 `unknown` 上会把元素收成 `any`，所以这里显式落回 `unknown`：本模块不接受任何 `any` 读数。
  const source: unknown =
    index === undefined ? value : Array.isArray(value) ? (value as readonly unknown[])[index] : undefined;
  return typeof source === 'number' && Number.isFinite(source) ? source : null;
}
