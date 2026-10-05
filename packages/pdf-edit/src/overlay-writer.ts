/**
 * 覆盖区的坐标与校验（spec 3.5-03 的坐标计算半边 / plan §7.5 的比例口径）。
 *
 * 存的是**比例**（0..1）而不是 pt 绝对值：界面缩放、窗口变宽、导出的那份 PDF 是 A4 还是 Letter，
 * 都不该让人手动重画一遍框（plan §7.5 第 2 行）。于是换算这一步是这条链上唯一会把
 * 「人眼看到的相对位置」变成「PDF 里的绝对点」的地方，3.5-03 的「盖歪了会压住相邻文字」就判在这里。
 *
 * 两个坐标系必须写清楚，否则符号一错就整页颠倒：
 * - 入参 `PdfOverlayRect` 是**视觉坐标**：原点左上、y 向下（跟界面与 4.1 的预览同一个方向，人看着顺）。
 * - PDF 的页面坐标是原点**左下**、y 向上，`pdf-lib` 的 `drawRectangle` 的 `y` 是矩形**底边**。
 *   换算式：`yBottomPt = (1 - yRatio - heightRatio) * pageHeightPt`。
 */
import type { PdfPageMetric } from './pdf-document.js';

/** 覆盖区的矩形，比例坐标（0..1），原点左上、y 向下。 */
export interface PdfOverlayRect {
  readonly xRatio: number;
  readonly yRatio: number;
  readonly widthRatio: number;
  readonly heightRatio: number;
}

/** 一条覆盖区：白底矩形 + 可选的叠加文字（省略 `text` 就只涂白底）。 */
export interface PdfOverlayInput {
  /** 界面给的稳定标识，错误信息里用它指认是哪一区 */
  readonly id: string;
  /** 页号，**从 1 起**（人看到的是「第几页」，见 `PdfPageMetric.number`） */
  readonly pageNumber: number;
  readonly rect: PdfOverlayRect;
  /** 叠加文字；本片的闸门只放拉丁（见 `isLatinOnly` 的注释） */
  readonly text?: string;
  /** 字号（pt），省略取服务配置的 `defaultTextSizePt` */
  readonly sizePt?: number;
}

/** 换算完成的覆盖区：矩形在 PDF 坐标里（原点左下，`y` 是底边），文字基线一并算好。 */
export interface PlannedOverlay {
  readonly id: string;
  readonly pageNumber: number;
  readonly xPt: number;
  readonly yBottomPt: number;
  readonly widthPt: number;
  readonly heightPt: number;
  /** 叠加文字（拉丁，见 `isLatinOnly`）；省略即只涂白底。 */
  readonly text?: string;
  /** 字号（pt）：配置默认值或本区自带值，换算后总是确定的。 */
  readonly sizePt: number;
  /** 文字基线的 `y`（pt，PDF 坐标）：只在有 `text` 时给出，绘制侧不再自己算符号。 */
  readonly textBaselinePt?: number;
}

/**
 * 校验与换算的拒绝种类（中文提示由服务层决定，`details.code` 用这些机器码）。
 * `text-not-supported` 不是"用户写错了"，而是本片刻意留的缺口：中文叠加要随字体资产那条裁定才落。
 */
export type OverlayRejection =
  | { readonly ok: false; readonly code: 'too-many'; readonly detail: string }
  | { readonly ok: false; readonly code: 'out-of-page'; readonly detail: string }
  | { readonly ok: false; readonly code: 'out-of-bounds'; readonly detail: string }
  | { readonly ok: false; readonly code: 'too-small'; readonly detail: string }
  | { readonly ok: false; readonly code: 'bad-size'; readonly detail: string }
  | { readonly ok: false; readonly code: 'text-not-supported'; readonly detail: string };

/** 校验通过的结果：换算好的覆盖区列表，或第一条拒绝。 */
export type OverlayPlanOutcome = { readonly ok: true; readonly overlays: readonly PlannedOverlay[] } | OverlayRejection;

/** 服务侧的三条尺度（都来自配置，代码内无魔法数）。 */
export interface OverlayLimits {
  readonly maxOverlays: number;
  readonly defaultTextSizePt: number;
  /** 最小面积（比例），小于它说明框细到看不见，多半是拖拽出错 */
  readonly minAreaRatio: number;
}

/**
 * 判断一段文字是否只含拉丁字形可画的字符（Basic Latin + Latin-1 Supplement）。
 *
 * 为什么必须在边界上挡掉中文而不是"画出来看看"：`StandardFonts` 那 14 只标准字体**没有 CJK 字形**，
 * 硬画会产出豆腐块甚至空白（plan §7.2 结论③）——那就是"看似改过实则不可读"的坏文件。
 * 中文那条腿走 `@pdf-lib/fontkit` + 随包字体，按裁定⑧（2026-10-05）与资产路径一起再落。
 * @param text 界面给的叠加文字
 * @returns 全部字符都在拉丁范围内为 true
 */
export function isLatinOnly(text: string): boolean {
  return /^[\u0020-\u007e\u00a0-\u00ff]*$/.test(text);
}

/**
 * 把比例矩形换算成 PDF 页面坐标。
 * @param rect 比例矩形（0..1，原点左上）
 * @param metric 那一页的宽高读数（pt）
 * @returns PDF 坐标下的左下角与宽高（pt）
 */
export function toPageRect(
  rect: PdfOverlayRect,
  metric: PdfPageMetric,
): Omit<PlannedOverlay, 'id' | 'pageNumber' | 'text' | 'sizePt' | 'textBaselinePt'> {
  const widthPt = rect.widthRatio * metric.widthPt;
  const heightPt = rect.heightRatio * metric.heightPt;
  return {
    xPt: rect.xRatio * metric.widthPt,
    // 视觉坐标的顶边 y 换成 PDF 的底边：先加矩形高度得到视觉底边，再用 1 减过去翻轴。
    yBottomPt: metric.heightPt - (rect.yRatio + rect.heightRatio) * metric.heightPt,
    widthPt,
    heightPt,
  };
}

/**
 * 校验整份覆盖区清单并逐条换算成 PDF 坐标。
 * @param inputs 界面给的覆盖区（不可信输入，所以这里只做系统边界校验，见 AGENTS.md §2.6）
 * @param metrics 打开时量好的每页宽高
 * @param limits 三条尺度（条数上限、默认字号、最小面积）
 * @returns `ok` 带换算结果；否则第一条拒绝的机器码与一句技术原因（顺序按清单，第一条说了就算）
 */
export function planOverlays(
  inputs: readonly PdfOverlayInput[],
  metrics: readonly PdfPageMetric[],
  limits: OverlayLimits,
): OverlayPlanOutcome {
  if (inputs.length > limits.maxOverlays) {
    return reject('too-many', `${String(inputs.length)} 区，上限 ${String(limits.maxOverlays)}`);
  }
  const plans: PlannedOverlay[] = [];
  for (const input of inputs) {
    const metric = metrics.find((item) => item.number === input.pageNumber);
    if (metric === undefined) {
      return reject(
        'out-of-page',
        `覆盖区 ${input.id} 指向第 ${String(input.pageNumber)} 页，这份 PDF 只有 ${String(metrics.length)} 页`,
      );
    }
    const { rect } = input;
    const ratios = [rect.xRatio, rect.yRatio, rect.widthRatio, rect.heightRatio];
    const isOutOfPage =
      ratios.some((value) => !Number.isFinite(value) || value < 0 || value > 1) ||
      rect.xRatio + rect.widthRatio > 1 ||
      rect.yRatio + rect.heightRatio > 1;
    if (isOutOfPage) {
      return reject('out-of-bounds', `覆盖区 ${input.id} 的比例坐标越界（每格必须在 0..1 且矩形不出页）`);
    }
    const areaRatio = rect.widthRatio * rect.heightRatio;
    if (areaRatio < limits.minAreaRatio) {
      return reject(
        'too-small',
        `覆盖区 ${input.id} 的面积 ${String(areaRatio)} 小于下限 ${String(limits.minAreaRatio)}`,
      );
    }
    const sizePt = input.sizePt ?? limits.defaultTextSizePt;
    if (!Number.isFinite(sizePt) || sizePt <= 0 || sizePt > 96) {
      return reject('bad-size', `覆盖区 ${input.id} 的字号 ${String(sizePt)} pt 不在 0..96`);
    }
    if (input.text !== undefined && !isLatinOnly(input.text)) {
      return reject(
        'text-not-supported',
        `覆盖区 ${input.id} 的文字含非拉丁字符，中文叠加腿按裁定⑧ 随字体资产一起再落`,
      );
    }
    const pageRect = toPageRect(rect, metric);
    plans.push({
      id: input.id,
      pageNumber: input.pageNumber,
      ...pageRect,
      sizePt,
      ...(input.text === undefined
        ? {}
        : { text: input.text, textBaselinePt: baselinePt(pageRect.yBottomPt, pageRect.heightPt, sizePt) }),
    });
  }
  return { ok: true, overlays: plans };
}

/**
 * 造一条拒绝结果（六个校验点共用一个形状，`ok: false` 是与成功半边对上的判据字段）。
 * @param code 拒绝种类（进 `AppError.details.code`）
 * @param detail 一句技术原因（中文提示由服务层决定）
 * @returns 可直接 return 的拒绝结果
 */
function reject(code: OverlayRejection['code'], detail: string): OverlayRejection {
  return { ok: false, code, detail };
}

/**
 * 文字基线：把 em 盒在矩形里竖向居中，返回 PDF 坐标的 `y`。
 *
 * 为什么由这里算而不是绘制侧：3.5-03 的判据是「盖歪了会压住相邻文字」，那条只有单测能判，
 * 于是所有 pt 级的符号（翻轴、基线）都集中在这一层，绘制侧只把数交给 `pdf-lib`。
 * @param yBottomPt 矩形底边（PDF 坐标）
 * @param heightPt 矩形高度（pt）
 * @param sizePt 字号（pt）
 * @returns 基线的 `y`（pt）；矩形比字号还矮时基线会顶到矩形之外，那是人画的框本身放不下字，不在此处拦
 */
function baselinePt(yBottomPt: number, heightPt: number, sizePt: number): number {
  return yBottomPt + (heightPt - sizePt) / 2;
}
