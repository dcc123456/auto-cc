/**
 * WPS 形态 PDF 编辑器的**统一对象模型**（2026-10-14 裁定㊳反转之后的新编辑轨）。
 *
 * 旧轨（`overlay-writer.ts`）只有「覆盖区 + 来源页号」一种对象，页序是一只来源页号数组；
 * 本模块把编辑器 draft 收成「**页计划 + 纸面对象**」两件：
 * - 页计划 `PdfEditorPageInput`：产物每一项是一个带稳定 id 的条目——源页副本或空白页，
 *   条目上可挂 0/90/180/270 的显示旋转。对象绑**条目 id** 而不是来源页号：
 *   WYSIWYG 语义下「复制这一页」复制的是用户看到的那一页（渲染层复制条目时把对象也复制一份，
 *   改绑新条目 id），引擎不替用户决定"另一份副本要不要带着批注"。
 * - 纸面对象 `PdfEditorObjectInput`：text（就地改字/文本框，同一对象靠有没有 `backdropHex` 区分）、
 *   image、shape（矩形）、highlight、note 五种；矩形一律**视觉比例坐标**（0..1，原点左上、y 向下），
 *   坐标相对的是该条目**旋转之后的显示面**（pdf.js viewport 那一版），所以渲染层不需要知道源档 MediaBox。
 *
 * 本文件与 `edit-session.ts` 同一条纪律：**一条 Node 能力都不许 import**（无 fs、无 pdf-lib），
 * 渲染层直接拿它做会话校验（AGENTS.md §2.5：会话与另存必须吃同一份判据）。
 * 真正的 pt 换算与旋转几何也放在这里（纯数，单测判得住），绘制侧只把结果交给 pdf-lib。
 */
import { normalizeHexColor } from './overlay-colors.js';
import { hasBundledGlyphCoverage, isFontFamilyHint } from './overlay-writer.js';
import type { FontFamilyHint } from './text-metrics.js';

/** 纸面对象的五种类型（P0/P1 的全集；橡皮只是删除动作，不是对象类型）。 */
export type PdfEditorObjectKind = 'text' | 'image' | 'shape' | 'highlight' | 'note';

/** 页面显示旋转（PDF /Rotate 只接受 90 的整数倍）。 */
export type PdfPageRotation = 0 | 90 | 180 | 270;

/** 比例矩形（0..1，原点左上、y 向下）：与旧 `PdfOverlayRect` 同一口径。 */
export interface PdfObjectRatioRect {
  readonly xRatio: number;
  readonly yRatio: number;
  readonly widthRatio: number;
  readonly heightRatio: number;
}

/**
 * 编辑器 draft 里的一个纸面对象（不可信输入：跨进程边界，所有字段都要在这里判形状）。
 */
export interface PdfEditorObjectInput {
  /** 渲染层给的稳定标识，错误信息用它指认是哪一个对象 */
  readonly id: string;
  /** 绑到页计划条目的 id（不是来源页号） */
  readonly pageId: string;
  readonly kind: PdfEditorObjectKind;
  /** 对象在**显示面**上的比例矩形 */
  readonly rect: PdfObjectRatioRect;

  // —— text / note 的文字半边 ——
  /** 文字内容（text 必有；note 可有可无） */
  readonly text?: string;
  /** 字号 pt（text 省略取默认；note 固定按默认便签字号，见 `NOTE_TEXT_SIZE_PT`） */
  readonly sizePt?: number;
  /** 文字墨色 / 形状描边色 / 高亮色（`#rrggbb`，形状不合即"没给"，走各类型的默认色） */
  readonly colorHex?: string;
  /** 形状填充色（省略即空心） */
  readonly fillHex?: string;
  /**
   * text 专用：就地改字时垫的纸色（渲染层从位图环带量来，口径与旧覆盖区相同）。
   * **有它就是"就地改字"**：先垫一块底再画字；没它就是"文本框"，只画字不垫底。
   */
  readonly backdropHex?: string;
  /** 字族档（衬线/无衬线/等宽），非拉丁侧不兑现（随包只有一只 Noto Sans SC） */
  readonly fontFamilyHint?: FontFamilyHint;
  /** 粗体（只对拉丁标准字体兑现：Helvetica-Bold 等；中文侧静默不兑现） */
  readonly bold?: boolean;
  /** 斜体（同上，拉丁侧走 Oblique） */
  readonly italic?: boolean;
  /** 下划线：在文字基线下画一条同色细线（两种字体都兑现） */
  readonly underline?: boolean;
  /**
   * 文字基线在**页面显示面**上的 y 比例（原点左上、y 向下）。
   * 就地改字时渲染层从行盒量来；省略时按矩形竖向居中回落。
   */
  readonly baselineYRatio?: number;

  // —— image ——
  /**
   * 图片文件的**绝对路径**（用户经文件选择器选定）。字节不在 IPC 里过两次：
   * 渲染层预览走 `pdf.io.imageBytes` 只读一次，另存时主进程按这个路径再读一次（有界）。
   */
  readonly imagePath?: string;

  // —— shape ——
  /** 描边宽 pt（省略取默认 1.5） */
  readonly borderWidthPt?: number;
}

/**
 * 页计划的一个条目：源页副本或空白页。
 * `rotation` 省略时，源页**保留它原有的 /Rotate**（引擎拷页后读得到），空白页默认 0。
 */
export type PdfEditorPageInput =
  | {
      readonly id: string;
      readonly kind: 'source';
      /** 来源页号，1 起 */
      readonly sourcePageNumber: number;
      readonly rotation?: PdfPageRotation;
    }
  | {
      readonly id: string;
      readonly kind: 'blank';
      /** 空白页宽 pt（省略取默认 A4 竖版） */
      readonly widthPt?: number;
      /** 空白页高 pt */
      readonly heightPt?: number;
      readonly rotation?: PdfPageRotation;
    };

/** 校验规整后的页条目（旋转与空白页尺寸在这里变成确定值）。 */
export interface PlannedEditorPage {
  readonly id: string;
  readonly kind: 'source' | 'blank';
  readonly sourcePageNumber?: number;
  readonly widthPt: number;
  readonly heightPt: number;
  /**
   * 最终显示旋转。空白页总有值；**源页可能为 undefined——省略即保留源档原有的 /Rotate**
   * （引擎拷页后自己读得到原角度），显式给 0 才是"转正"。
   */
  readonly rotation?: PdfPageRotation;
}

/** 校验规整后的纸面对象（颜色已归一、布尔已落实、字号已确定）。 */
export interface PlannedEditorObject {
  readonly id: string;
  readonly pageId: string;
  readonly kind: PdfEditorObjectKind;
  readonly rect: PdfObjectRatioRect;
  readonly text?: string;
  readonly sizePt?: number;
  readonly colorHex?: string;
  readonly fillHex?: string;
  readonly backdropHex?: string;
  readonly fontFamilyHint?: FontFamilyHint;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly baselineYRatio?: number;
  readonly imagePath?: string;
  readonly borderWidthPt?: number;
}

/** 对象校验的三条尺度。 */
export interface EditorObjectLimits {
  readonly maxObjects: number;
  readonly defaultTextSizePt: number;
  readonly minAreaRatio: number;
}

/** 页计划校验的尺度（空白页默认尺寸与最大产物页数）。 */
export interface EditorPageLimits {
  readonly maxPages: number;
  readonly defaultBlankWidthPt: number;
  readonly defaultBlankHeightPt: number;
}

/** 页计划的拒绝原因。 */
export type EditorPageRejection =
  | { readonly ok: false; readonly code: 'empty-pages'; readonly detail: string }
  | { readonly ok: false; readonly code: 'too-many-pages'; readonly detail: string }
  | { readonly ok: false; readonly code: 'bad-page-id'; readonly detail: string }
  | { readonly ok: false; readonly code: 'duplicate-page-id'; readonly detail: string }
  | { readonly ok: false; readonly code: 'page-out-of-range'; readonly detail: string }
  | { readonly ok: false; readonly code: 'bad-blank-size'; readonly detail: string }
  | { readonly ok: false; readonly code: 'bad-rotation'; readonly detail: string };

export type EditorPagePlanOutcome = { readonly ok: true; readonly pages: readonly PlannedEditorPage[] } | EditorPageRejection;

/** 对象校验的拒绝原因。 */
export type EditorObjectRejection =
  | { readonly ok: false; readonly code: 'too-many-objects'; readonly detail: string }
  | { readonly ok: false; readonly code: 'bad-object-id'; readonly detail: string }
  | { readonly ok: false; readonly code: 'duplicate-object-id'; readonly detail: string }
  | { readonly ok: false; readonly code: 'unknown-kind'; readonly detail: string }
  | { readonly ok: false; readonly code: 'object-page-unknown'; readonly detail: string }
  | { readonly ok: false; readonly code: 'object-out-of-bounds'; readonly detail: string }
  | { readonly ok: false; readonly code: 'object-too-small'; readonly detail: string }
  | { readonly ok: false; readonly code: 'bad-size'; readonly detail: string }
  | { readonly ok: false; readonly code: 'bad-border-width'; readonly detail: string }
  | { readonly ok: false; readonly code: 'text-required'; readonly detail: string }
  | { readonly ok: false; readonly code: 'text-too-long'; readonly detail: string }
  | { readonly ok: false; readonly code: 'text-not-supported'; readonly detail: string }
  | { readonly ok: false; readonly code: 'image-path-required'; readonly detail: string };

export type EditorObjectPlanOutcome =
  | { readonly ok: true; readonly objects: readonly PlannedEditorObject[] }
  | EditorObjectRejection;

/** 便签默认字号 pt（便签是贴纸不是正文，固定比正文小一档）。 */
export const NOTE_TEXT_SIZE_PT = 9;
/** 单条文字的长度上限：再长就是在拿对象编辑当排版器，提示用户走文档模型那一条轨。 */
export const MAX_TEXT_LENGTH = 2000;
/** 空白页允许的边长区间（pt）：小过 0.5 英寸、大过 ~55 英寸都不像一页纸。 */
const MIN_BLANK_SIDE_PT = 36;
const MAX_BLANK_SIDE_PT = 4000;
/** A4 竖版（595.28 × 841.89 pt）：简历场景的默认纸面。 */
export const DEFAULT_BLANK_WIDTH_PT = 595.28;
export const DEFAULT_BLANK_HEIGHT_PT = 841.89;

function reject<T extends string>(code: T, detail: string): { readonly ok: false; readonly code: T; readonly detail: string } {
  return { ok: false, code, detail };
}

/** 是不是 0/90/180/270 之一（PDF /Rotate 的全部合法值）。 */
export function isPageRotation(value: unknown): value is PdfPageRotation {
  return value === 0 || value === 90 || value === 180 || value === 270;
}

/**
 * 校验并规整页计划。
 * @param inputs 渲染层 draft 的页条目（不可信）
 * @param sourcePageCount 源档页数：源条目的页号上界
 * @param limits 最大页数与空白页默认尺寸
 */
export function planEditorPages(
  inputs: readonly unknown[],
  sourcePageCount: number,
  limits: EditorPageLimits,
): EditorPagePlanOutcome {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return reject('empty-pages', '页计划为空会产出一份没有页的 PDF');
  }
  if (inputs.length > limits.maxPages) {
    return reject('too-many-pages', `产物页数 ${String(inputs.length)} 超过上限 ${String(limits.maxPages)}`);
  }
  const seenIds = new Set<string>();
  const pages: PlannedEditorPage[] = [];
  for (const input of inputs) {
    const entry = input as Partial<PdfEditorPageInput> | null;
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id.trim() === '') {
      return reject('bad-page-id', `第 ${String(pages.length + 1)} 个页条目没有合法 id`);
    }
    if (seenIds.has(entry.id)) {
      return reject('duplicate-page-id', `页条目 id 重复：${entry.id}`);
    }
    seenIds.add(entry.id);
    if (entry.rotation !== undefined && !isPageRotation(entry.rotation)) {
      return reject('bad-rotation', `页条目 ${entry.id} 的旋转角 ${String(entry.rotation)} 不是 0/90/180/270`);
    }
    if (entry.kind === 'source') {
      const pageNumber = entry.sourcePageNumber;
      if (typeof pageNumber !== 'number' || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > sourcePageCount) {
        return reject(
          'page-out-of-range',
          `页条目 ${entry.id} 指向源档第 ${String(pageNumber)} 页，源档只有 ${String(sourcePageCount)} 页`,
        );
      }
      pages.push({
        id: entry.id,
        kind: 'source',
        sourcePageNumber: pageNumber,
        // 源条目的宽高在引擎侧能从源档量到（这里给 0 占位）；
        // 旋转省略即保留源档原有 /Rotate，所以这个键在缺省时根本不出现。
        widthPt: 0,
        heightPt: 0,
        ...(entry.rotation === undefined ? {} : { rotation: entry.rotation }),
      });
    } else if (entry.kind === 'blank') {
      const widthPt = entry.widthPt ?? limits.defaultBlankWidthPt;
      const heightPt = entry.heightPt ?? limits.defaultBlankHeightPt;
      if (
        !Number.isFinite(widthPt) ||
        !Number.isFinite(heightPt) ||
        widthPt < MIN_BLANK_SIDE_PT ||
        heightPt < MIN_BLANK_SIDE_PT ||
        widthPt > MAX_BLANK_SIDE_PT ||
        heightPt > MAX_BLANK_SIDE_PT
      ) {
        return reject(
          'bad-blank-size',
          `空白页 ${entry.id} 的尺寸 ${String(widthPt)}×${String(heightPt)} pt 不在 ${String(MIN_BLANK_SIDE_PT)}…${String(MAX_BLANK_SIDE_PT)} 之间`,
        );
      }
      pages.push({ id: entry.id, kind: 'blank', widthPt, heightPt, rotation: entry.rotation ?? 0 });
    } else {
      return reject('bad-page-id', `页条目 ${entry.id} 的 kind 既不是 source 也不是 blank`);
    }
  }
  return { ok: true, pages };
}

/**
 * 校验并规整纸面对象清单（矩形仍是比例坐标；pt 换算发生在引擎绘制时，因为那时才知道每页的显示旋转）。
 * @param inputs 渲染层 draft 的对象（不可信）
 * @param pages 已通过校验的页计划：对象 pageId 必须认得到其中一个条目
 * @param limits 三条尺度
 */
export function planEditorObjects(
  inputs: readonly unknown[],
  pages: readonly PlannedEditorPage[],
  limits: EditorObjectLimits,
): EditorObjectPlanOutcome {
  if (!Array.isArray(inputs)) {
    return reject('too-many-objects', '对象清单不是数组');
  }
  if (inputs.length > limits.maxObjects) {
    return reject('too-many-objects', `${String(inputs.length)} 个对象，上限 ${String(limits.maxObjects)}`);
  }
  const pageIds = new Set(pages.map((page) => page.id));
  const seenIds = new Set<string>();
  const objects: PlannedEditorObject[] = [];
  for (const raw of inputs) {
    const input = raw as Partial<PdfEditorObjectInput> | null;
    if (input === null || typeof input !== 'object') {
      return reject('bad-object-id', `第 ${String(objects.length + 1)} 个对象不是对象形状`);
    }
    if (typeof input.id !== 'string' || input.id.trim() === '') {
      return reject('bad-object-id', `第 ${String(objects.length + 1)} 个对象没有合法 id`);
    }
    if (seenIds.has(input.id)) {
      return reject('duplicate-object-id', `对象 id 重复：${input.id}`);
    }
    seenIds.add(input.id);
    const kind = input.kind;
    if (kind !== 'text' && kind !== 'image' && kind !== 'shape' && kind !== 'highlight' && kind !== 'note') {
      return reject('unknown-kind', `对象 ${input.id} 的类型 ${String(kind)} 不在五种纸面对象之内`);
    }
    if (typeof input.pageId !== 'string' || !pageIds.has(input.pageId)) {
      return reject('object-page-unknown', `对象 ${input.id} 绑的页 ${String(input.pageId)} 不在页计划里`);
    }
    const rect: PdfObjectRatioRect | undefined = input.rect;
    if (rect === undefined || typeof rect !== 'object') {
      return reject('object-out-of-bounds', `对象 ${input.id} 没有矩形`);
    }
    const ratios = [rect.xRatio, rect.yRatio, rect.widthRatio, rect.heightRatio];
    const outOfPage =
      ratios.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) ||
      rect.xRatio + rect.widthRatio > 1 ||
      rect.yRatio + rect.heightRatio > 1;
    if (outOfPage) {
      return reject('object-out-of-bounds', `对象 ${input.id} 的比例坐标越界（每格必须在 0..1 且矩形不出页）`);
    }
    if (rect.widthRatio * rect.heightRatio < limits.minAreaRatio) {
      return reject(
        'object-too-small',
        `对象 ${input.id} 的面积 ${String(rect.widthRatio * rect.heightRatio)} 小于下限 ${String(limits.minAreaRatio)}`,
      );
    }

    const planned: PlannedEditorObject = {
      id: input.id,
      pageId: input.pageId,
      kind,
      rect: {
        xRatio: rect.xRatio,
        yRatio: rect.yRatio,
        widthRatio: rect.widthRatio,
        heightRatio: rect.heightRatio,
      },
      bold: input.bold === true,
      italic: input.italic === true,
      underline: input.underline === true,
    };

    if (kind === 'text') {
      if (typeof input.text !== 'string' || input.text.length === 0) {
        return reject('text-required', `文本对象 ${input.id} 没有文字`);
      }
      const textFailure = checkText(input.id, input.text);
      if (textFailure !== undefined) return textFailure;
      const sizeFailure = checkSize(input.id, input.sizePt);
      if (sizeFailure !== undefined) return sizeFailure;
      objects.push(withTextFields(planned, input, input.sizePt ?? limits.defaultTextSizePt));
      continue;
    }
    if (kind === 'note') {
      if (input.text !== undefined && input.text !== '') {
        const textFailure = checkText(input.id, input.text);
        if (textFailure !== undefined) return textFailure;
      }
      // 便签字号固定 9pt，不开放外部入参（防止把便签画成半页大字）。
      objects.push(withTextFields(planned, input, NOTE_TEXT_SIZE_PT));
      continue;
    }
    if (kind === 'image') {
      if (typeof input.imagePath !== 'string' || input.imagePath.trim() === '') {
        return reject('image-path-required', `图片对象 ${input.id} 没有图片路径`);
      }
      objects.push({ ...planned, imagePath: input.imagePath });
      continue;
    }
    if (kind === 'shape') {
      const colorHex = normalizeHexColor(input.colorHex);
      const fillHex = normalizeHexColor(input.fillHex);
      const borderWidthPt = input.borderWidthPt ?? 1.5;
      if (!Number.isFinite(borderWidthPt) || borderWidthPt < 0 || borderWidthPt > 24) {
        return reject('bad-border-width', `形状 ${input.id} 的描边宽 ${String(borderWidthPt)} pt 不在 0..24`);
      }
      objects.push({
        ...planned,
        ...(colorHex === undefined ? {} : { colorHex }),
        ...(fillHex === undefined ? {} : { fillHex }),
        borderWidthPt,
      });
      continue;
    }
    // highlight：颜色可给可不给（默认荧光黄在绘制侧），其余字段一律不认。
    const colorHex = normalizeHexColor(input.colorHex);
    objects.push({ ...planned, ...(colorHex === undefined ? {} : { colorHex }) });
  }
  return { ok: true, objects };
}

function withTextFields(
  planned: PlannedEditorObject,
  input: Partial<PdfEditorObjectInput>,
  sizePt: number,
): PlannedEditorObject {
  const colorHex = normalizeHexColor(input.colorHex);
  const backdropHex = normalizeHexColor(input.backdropHex);
  const fontFamilyHint = isFontFamilyHint(input.fontFamilyHint) ? input.fontFamilyHint : undefined;
  const baselineFinite =
    typeof input.baselineYRatio === 'number' &&
    Number.isFinite(input.baselineYRatio) &&
    input.baselineYRatio >= 0 &&
    input.baselineYRatio <= 1
      ? input.baselineYRatio
      : undefined;
  return {
    ...planned,
    text: input.text,
    sizePt,
    ...(colorHex === undefined ? {} : { colorHex }),
    ...(backdropHex === undefined ? {} : { backdropHex }),
    ...(fontFamilyHint === undefined ? {} : { fontFamilyHint }),
    ...(baselineFinite === undefined ? {} : { baselineYRatio: baselineFinite }),
  };
}

function checkText(id: string, text: string): EditorObjectRejection | undefined {
  if (text.length > MAX_TEXT_LENGTH) {
    return reject('text-too-long', `对象 ${id} 的文字长 ${String(text.length)} 字，超过单条上限 ${String(MAX_TEXT_LENGTH)}`);
  }
  if (!hasBundledGlyphCoverage(text)) {
    return reject(
      'text-not-supported',
      `对象 ${id} 的文字含随包字体没有的字符（中文与拉丁可画，emoji 等白名单外的码位不画）`,
    );
  }
  return undefined;
}

function checkSize(id: string, sizePt: number | undefined): EditorObjectRejection | undefined {
  if (sizePt === undefined) return undefined;
  if (!Number.isFinite(sizePt) || sizePt <= 0 || sizePt > 96) {
    return reject('bad-size', `对象 ${id} 的字号 ${String(sizePt)} pt 不在 0..96`);
  }
  return undefined;
}

/**
 * 视觉比例点 / 矩形落到 PDF 原生坐标时的放置结果。
 *
 * `xPt/yPt` 是绘制原点（矩形左下角、文字基线起点），`drawRotationDegrees` 是**反向旋转角**：
 * 页面带着 /Rotate=R 在阅读器里顺时针转正，我们的绘制就先逆时针转 R，
 * 阅读器转正之后它正好是正的（推导见 plan 修订条：V_R ∘ Rot(−R) = 恒等）。
 */
export interface NativePlacement {
  readonly xPt: number;
  readonly yPt: number;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly drawRotationDegrees: PdfPageRotation;
}

/** 一页在引擎侧的几何读数：原生 MediaBox 与显示面（旋转后）的宽高。 */
export interface PageGeometry {
  readonly widthPt: number;
  readonly heightPt: number;
  readonly rotation: PdfPageRotation;
}

/** 旋转后显示面的宽高（90/270 时宽高互换）。 */
export function displayedSize(geometry: PageGeometry): { readonly widthPt: number; readonly heightPt: number } {
  return geometry.rotation === 90 || geometry.rotation === 270
    ? { widthPt: geometry.heightPt, heightPt: geometry.widthPt }
    : { widthPt: geometry.widthPt, heightPt: geometry.heightPt };
}

/**
 * 把显示面（y 向上坐标）上的一个点映射成 PDF 原生坐标的绘制原点。
 *
 * 四个角的对应（阅读器顺时针转 R）：
 * - R=0：(x,y) → (x,y)
 * - R=90：原生左上落显示右上，逆映射 x0=W−y、y0=x
 * - R=180：x0=W−x、y0=y（180 时 y 不动）
 * - R=270：x0=y、y0=H−x
 * @param cx 显示面 y 向上的 x（pt）
 * @param cy 显示面 y 向上的 y（pt）
 */
export function visualPointToNative(cx: number, cy: number, geometry: PageGeometry): { readonly xPt: number; readonly yPt: number } {
  const { widthPt: W, heightPt: H, rotation: R } = geometry;
  switch (R) {
    case 0:
      return { xPt: cx, yPt: cy };
    case 90:
      return { xPt: W - cy, yPt: cx };
    case 180:
      return { xPt: W - cx, yPt: cy };
    case 270:
      return { xPt: cy, yPt: H - cx };
  }
}

/**
 * 把显示面上的比例矩形换算成原生放置（含反向旋转角）。
 * @param rect 比例矩形（0..1，原点左上、y 向下，相对显示面）
 */
export function placeVisualRect(rect: PdfObjectRatioRect, geometry: PageGeometry): NativePlacement {
  const display = displayedSize(geometry);
  const widthPt = rect.widthRatio * display.widthPt;
  const heightPt = rect.heightRatio * display.heightPt;
  // 显示面 y 向上的左下角：左上 y 换成左下要先加矩形高度再翻轴。
  const cxLeft = rect.xRatio * display.widthPt;
  const cyBottom = display.heightPt - (rect.yRatio + rect.heightRatio) * display.heightPt;
  const anchor = visualPointToNative(cxLeft, cyBottom, geometry);
  return { xPt: anchor.xPt, yPt: anchor.yPt, widthPt, heightPt, drawRotationDegrees: geometry.rotation };
}

/** PNG / JPEG 的文件头魔数（格式判据只认字节，不认扩展名）。 */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/**
 * 按文件头魔数嗅探图片格式（纯字节判断，渲染层预览与主进程另存共用同一份判据）。
 * @param bytes 图片字节
 * @returns `png` / `jpeg`；都不是给 undefined
 */
export function sniffImageMagic(bytes: Uint8Array): 'png' | 'jpeg' | undefined {
  if (bytes.length >= 4 && PNG_MAGIC.every((byte, index) => bytes[index] === byte)) return 'png';
  if (bytes.length >= 3 && JPEG_MAGIC.every((byte, index) => bytes[index] === byte)) return 'jpeg';
  return undefined;
}

/**
 * 把显示面上的比例点（y 向下）换算成原生绘制原点。
 * @param xRatio 显示面 x 比例
 * @param yRatio 显示面 y 比例（原点左上、y 向下）
 */
export function placeVisualPointRatio(
  xRatio: number,
  yRatio: number,
  geometry: PageGeometry,
): { readonly xPt: number; readonly yPt: number; readonly drawRotationDegrees: PdfPageRotation } {
  const display = displayedSize(geometry);
  const cx = xRatio * display.widthPt;
  const cy = (1 - yRatio) * display.heightPt;
  const anchor = visualPointToNative(cx, cy, geometry);
  return { xPt: anchor.xPt, yPt: anchor.yPt, drawRotationDegrees: geometry.rotation };
}
