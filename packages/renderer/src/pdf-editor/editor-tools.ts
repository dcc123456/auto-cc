/**
 * WPS 形态 PDF 编辑器的工具与几何（纯函数 / 常量，渲染层零 Node）。
 *
 * 这一只文件只回答四件事：当下是哪只工具、指针落点换算成什么比例矩形、id 怎么发、
 * 文字在纸面上按什么像素规格画。会话状态在 `usePdfEditor`，纸面渲染在 `PdfEditorPageCanvas`，
 * 判据在主进程 `@auto-cc/plugin-pdf-edit/object-model`——这里不做第二套校验，只产出「人刚画的那一笔」。
 */
import type { FontFamilyHint } from '@auto-cc/plugin-pdf-edit/text-metrics';
import type { PdfObjectRatioRect, PdfEditorObjectInput } from '@auto-cc/plugin-pdf-edit/object-model';

/**
 *  Ribbon 上的工具。E2 只交付两只（指针/就地改字、文本框）；
 * 图片/形状/高亮/便签/橡皮在 E3 沿这同一个联合类型扩，调用方的穷举 switch 会替我们逼出缺的档。
 */
export type EditorTool = 'pointer' | 'text';

/**
 * 会话尺度与 `cordis.yml` 的 pdf-export / pdf-io 配置**逐位一致**（AGENTS.md §2.5：
 * 界面这一份只用于提前禁用与给原因，真正的判据在主进程服务侧再过一遍）。
 */
export const EDITOR_LIMITS = {
  maxPages: 64,
  maxObjects: 100,
  defaultTextSizePt: 11,
  minAreaRatio: 0.0001,
  defaultBlankWidthPt: 595.28,
  defaultBlankHeightPt: 841.89,
} as const;

/** 文字对象允许的最长输入（与引擎 `MAX_TEXT_LENGTH` 同值，超长在边界也会被拒）。 */
export const MAX_TEXT_INPUT = 2000;

/** 缩放下限/上限与步进（宽度口径，px；794 是 A4 210mm 在 96dpi 下的 CSS 宽度，即 100%）。 */
export const PAGE_WIDTH_100_PX = 794;
export const ZOOM_MIN_WIDTH_PX = 360;
export const ZOOM_MAX_WIDTH_PX = 1900;
/** 滚轮/按钮缩放的系数：每一格 ±12.5%（与常见 PDF 阅读器同一节奏）。 */
export const ZOOM_STEP = 1.125;

/** 拖框小于这个像素边长（在当下纸宽下）视为点击而不是新建对象（防手抖）。 */
export const RUBBER_MIN_PX = 6;
/** 对象最小可见边（比例），拖放/缩放都不许低于它，否则在纸面上就是一根找不到的线。 */
export const OBJECT_MIN_RATIO = 0.012;

/** 把宽度倍率换算成百分比读数（状态条上那一颗「100%」）。 */
export const zoomPercent = (pageWidthPx: number): number => Math.round((pageWidthPx / PAGE_WIDTH_100_PX) * 100);

/** 夹一个比例矩形到页面内（0..1），用于拖拽与缩放越界时把对象按回纸里。 */
export function clampRect(rect: PdfObjectRatioRect): PdfObjectRatioRect {
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
  return {
    xRatio: clamp01(rect.xRatio),
    yRatio: clamp01(rect.yRatio),
    widthRatio: Math.min(1, Math.max(OBJECT_MIN_RATIO, rect.widthRatio)),
    heightRatio: Math.min(1, Math.max(OBJECT_MIN_RATIO, rect.heightRatio)),
  };
}

/**
 * 起终两个指针点（比例坐标）规整成一只原点左上的矩形；拖得太小就回 undefined（按点击处理）。
 * @param start 按下点（相对页面，0..1）
 * @param end 抬起点
 */
export function rubberRect(
  start: { xRatio: number; yRatio: number },
  end: { xRatio: number; yRatio: number },
): PdfObjectRatioRect | undefined {
  const xRatio = Math.min(start.xRatio, end.xRatio);
  const yRatio = Math.min(start.yRatio, end.yRatio);
  const widthRatio = Math.abs(end.xRatio - start.xRatio);
  const heightRatio = Math.abs(end.yRatio - start.yRatio);
  if (widthRatio < OBJECT_MIN_RATIO || heightRatio < OBJECT_MIN_RATIO) return undefined;
  return clampRect({ xRatio, yRatio, widthRatio, heightRatio });
}

/**
 * 按某只手柄缩放一只矩形（八手柄之一）。锚点对侧不动，本侧跟着指针走；
 * 越过锚点时矩形翻面（x/宽与 y/高交换），手感与 WPS 拖框一致。
 * @param current 原矩形（比例）
 * @param handle 手柄方位
 * @param point 指针落点（比例）
 */
export function resizeRect(
  current: PdfObjectRatioRect,
  handle: 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w',
  point: { xRatio: number; yRatio: number },
): PdfObjectRatioRect {
  let { xRatio, yRatio, widthRatio, heightRatio } = current;
  const right = xRatio + widthRatio;
  const bottom = yRatio + heightRatio;
  if (handle.includes('w')) {
    xRatio = Math.min(point.xRatio, right - OBJECT_MIN_RATIO);
    widthRatio = right - xRatio;
  }
  if (handle.includes('e')) {
    widthRatio = Math.max(OBJECT_MIN_RATIO, point.xRatio - xRatio);
  }
  if (handle.includes('n')) {
    yRatio = Math.min(point.yRatio, bottom - OBJECT_MIN_RATIO);
    heightRatio = bottom - yRatio;
  }
  if (handle.includes('s')) {
    heightRatio = Math.max(OBJECT_MIN_RATIO, point.yRatio - yRatio);
  }
  return clampRect({ xRatio, yRatio, widthRatio, heightRatio });
}

/**
 * 平移一只矩形（指针工具拖对象），整体夹回页面内。
 * @param current 原矩形
 * @param dxRatio 横向位移（比例）
 * @param dyRatio 纵向位移（比例）
 */
export function moveRect(
  current: PdfObjectRatioRect,
  dxRatio: number,
  dyRatio: number,
): PdfObjectRatioRect {
  return clampRect({
    ...current,
    xRatio: current.xRatio + dxRatio,
    yRatio: current.yRatio + dyRatio,
  });
}

/** 发一个对象 id（界面内部键，主进程只校验唯一性）。 */
let objectSeq = 0;
export function nextObjectId(): string {
  objectSeq += 1;
  return `obj-${Date.now().toString(36)}-${objectSeq}`;
}

/**
 * 行盒就地改字对象的**确定性 id**：同一行再改是更新同一只对象，而不是盖第二层。
 * @param pageId 页计划条目 id
 * @param lineId 行盒 id（pdf.js 聚行后的 `L1..Ln`）
 */
export function lineObjectId(pageId: string, lineId: string): string {
  return `edit-${pageId}-${lineId}`;
}

/**
 * 字号 pt 与行高换算成纸上的像素规格。
 * @param sizePt 字号（pt）
 * @param pageWidthPx 这一页当下的 CSS 宽度（px）
 * @param pageWidthPt 这一页的宽（pt；旋转 90/270 时由调用方传**显示面**的宽）
 */
export function fontPxOf(sizePt: number, pageWidthPx: number, pageWidthPt: number): number {
  return (sizePt * pageWidthPx) / pageWidthPt;
}

/**
 * 字族提示到界面预览的 CSS 字族（写出时引擎按同一提示挑标准字体 / Noto SC）。
 * 拉丁字面必须排在 CJK 字面前：浏览器按字符逐枚回退，Helvetica/Arial 量宽与 PDF 标准字体同档，
 * 让 CJK 字体（PingFang 字面明显更宽）排在前面会把一行拉丁字排到换行（V 验收活体读数）。
 */
export function fontFamilyCssOf(hint: FontFamilyHint | undefined): string {
  switch (hint) {
    case 'serif':
      return '"Times New Roman", Times, Georgia, "Songti SC", "Noto Serif CJK SC", serif';
    case 'monospace':
      return '"Courier New", Courier, "Noto Sans Mono CJK SC", monospace';
    case 'sans-serif':
    default:
      return '"Helvetica Neue", Helvetica, Arial, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif';
  }
}

/** 按 CSS 字族缓存的升部占比（与 pdf-page-view 量 pdf.js 那一侧同口径）。 */
const cssAscentRatioCache = new Map<string, number>();
let ascentCanvas: HTMLCanvasElement | undefined;

/**
 * 量出**界面这支 CSS 字体**的升部占 em 比例。
 *
 * 行盒的 y 是按 PDF 内嵌字体的升部/降部量的（pdf-page-view.ascentRatioForFont），
 * 而 textarea/盒内文字按本机字体排——两套升部不同，基线就会错开一两个像素。
 * 这里量本机字体一侧，差值以内边距补回；无 DOM（单测）时回落 0.8。
 */
export function cssAscentRatioOf(familyCss: string): number {
  const cached = cssAscentRatioCache.get(familyCss);
  if (cached !== undefined) return cached;
  let ratio = 0.8;
  if (typeof document !== 'undefined') {
    ascentCanvas ??= document.createElement('canvas');
    const painter = ascentCanvas.getContext('2d');
    if (painter) {
      painter.font = `30px ${familyCss}`;
      const metrics = painter.measureText('');
      const ascent = metrics.fontBoundingBoxAscent;
      const descent = Math.abs(metrics.fontBoundingBoxDescent);
      if (ascent > 0 && ascent + descent > 0) ratio = ascent / (ascent + descent);
    }
  }
  cssAscentRatioCache.set(familyCss, ratio);
  return ratio;
}

/** 判断对象是不是「就地改字」（有垫底色）而不是文本框——预览框、属性卡措辞都按这一挡分。 */
export function isInPlaceText(object: PdfEditorObjectInput): boolean {
  return object.kind === 'text' && object.backdropHex !== undefined;
}
