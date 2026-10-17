/**
 * WPS 形态编辑器的编辑会话（纸面对象 + 页计划 + 撤销重做）。
 *
 * 与旧 `edit-session.ts` 同一条纪律：**纯模型，零 Node 依赖**（不碰 fs / pdf-lib / 服务层），
 * 渲染层直接 import 本文件做撤销栈；另存通道在主进程侧跑**同一份** `planEditorObjects` /
 * `planEditorPages` 判据（AGENTS.md §2.5：界面放行的东西另存必须也放行）。
 *
 * 历史机制一律走 `@auto-cc/core` 的 `createSnapshotStack`（不引入第二套历史栈）。
 * 「撤销一步」退的是用户的一次编辑动作，对象与页计划合在同一份快照里：
 * 先旋转一页再框一个对象，退一步只少那个对象、旋转不动。
 */
import { createSnapshotStack, DEFAULT_SNAPSHOT_HISTORY } from '@auto-cc/core/snapshot-stack';
import {
  planEditorObjects,
  planEditorPages,
  type EditorObjectLimits,
  type PdfEditorObjectInput,
  type PdfEditorPageInput,
} from './object-model.js';

/** 编辑器 draft：页计划 + 对象（对象按数组顺序绘制，后画的压先画的）。 */
export interface PdfEditorDraft {
  readonly pages: readonly PdfEditorPageInput[];
  readonly objects: readonly PdfEditorObjectInput[];
}

/** 会话尺度：对象侧三条 + 页数上限 + 空白页默认尺寸（会话不读文件，没有字节上限）。 */
export interface PdfEditorSessionLimits extends EditorObjectLimits {
  readonly maxPages: number;
  readonly defaultBlankWidthPt: number;
  readonly defaultBlankHeightPt: number;
}

/** 建会话时的读数。 */
export interface PdfEditorSessionOptions {
  /** 源档页数（页计划里 source 条目页号的上界；度量本身不需要——比例坐标不换算成 pt） */
  readonly sourcePageCount: number;
  readonly limits: PdfEditorSessionLimits;
  /** 历史深度，超出丢最老的 */
  readonly historyCeiling?: number;
}

/** 会话的读数与动作；每个动作只在**真的改了 draft** 时产生一条撤销单元。 */
export interface PdfEditorSession {
  draft(): PdfEditorDraft;
  canUndo(): boolean;
  canRedo(): boolean;
  /** 加一个对象；id 已被占或整表过不了校验时返回 false 且不入栈。 */
  addObject(object: PdfEditorObjectInput): boolean;
  /** 用新对象整体替换同 id 的那一个（拖拽、改字、改色都走这一只）；查无 id 或逐字段相同时返回 false。 */
  updateObject(object: PdfEditorObjectInput): boolean;
  /** 删一个对象；查无 id 时返回 false。 */
  removeObject(id: string): boolean;
  /**
   * 换成一份新页计划（排序/旋转/复制/删除/插空白页都由渲染层算好整表递进来）。
   * 非法或与现值逐位相同时返回 false。
   */
  setPages(pages: readonly PdfEditorPageInput[]): boolean;
  undo(): boolean;
  redo(): boolean;
}

/** 深拷一份 draft（嵌套 rect 必须另拷）。 */
function cloneDraft(draft: PdfEditorDraft): PdfEditorDraft {
  return {
    pages: draft.pages.map((page) => ({ ...page })),
    objects: draft.objects.map((object) => ({ ...object, rect: { ...object.rect } })),
  };
}

/** 两只页条目是否逐字段相同（页计划是整表替换，空编辑不进栈）。 */
function isSamePage(left: PdfEditorPageInput, right: PdfEditorPageInput): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    (left.kind === 'source'
      ? left.sourcePageNumber === (right as Extract<PdfEditorPageInput, { kind: 'source' }>).sourcePageNumber &&
        (left.rotation ?? null) === ((right as Extract<PdfEditorPageInput, { kind: 'source' }>).rotation ?? null)
      : left.widthPt === (right as Extract<PdfEditorPageInput, { kind: 'blank' }>).widthPt &&
        left.heightPt === (right as Extract<PdfEditorPageInput, { kind: 'blank' }>).heightPt &&
        (left.rotation ?? null) === ((right as Extract<PdfEditorPageInput, { kind: 'blank' }>).rotation ?? null))
  );
}

function isSamePages(left: readonly PdfEditorPageInput[], right: readonly PdfEditorPageInput[]): boolean {
  return (
    left.length === right.length && left.every((page, index) => isSamePage(page, right[index] as PdfEditorPageInput))
  );
}

/** 两个对象是否逐字段相同（嵌套 rect 也要比）。 */
function isSameObject(left: PdfEditorObjectInput, right: PdfEditorObjectInput): boolean {
  return (
    left.id === right.id &&
    left.pageId === right.pageId &&
    left.kind === right.kind &&
    left.rect.xRatio === right.rect.xRatio &&
    left.rect.yRatio === right.rect.yRatio &&
    left.rect.widthRatio === right.rect.widthRatio &&
    left.rect.heightRatio === right.rect.heightRatio &&
    left.text === right.text &&
    left.sizePt === right.sizePt &&
    left.colorHex === right.colorHex &&
    left.fillHex === right.fillHex &&
    left.backdropHex === right.backdropHex &&
    left.fontFamilyHint === right.fontFamilyHint &&
    (left.bold ?? false) === (right.bold ?? false) &&
    (left.italic ?? false) === (right.italic ?? false) &&
    (left.underline ?? false) === (right.underline ?? false) &&
    left.baselineYRatio === right.baselineYRatio &&
    left.imagePath === right.imagePath &&
    left.borderWidthPt === right.borderWidthPt
  );
}

/**
 * 建一只编辑器会话。
 * @param initial 初始 draft（通常是页计划 `1…n` 个 source 条目 + 空对象表）；立刻被拷一份，初始值不做校验
 * （非法的东西会在第一次动作或另存时被同一份判据挡下）。
 */
export function createPdfEditorSession(initial: PdfEditorDraft, options: PdfEditorSessionOptions): PdfEditorSession {
  const stack = createSnapshotStack(initial, cloneDraft, options.historyCeiling ?? DEFAULT_SNAPSHOT_HISTORY);
  const { limits } = options;

  /** 整表合法性：先过页计划，再过对象（对象页 id 依赖页计划的规整结果）。 */
  const validate = (draft: PdfEditorDraft): boolean => {
    const pages = planEditorPages(draft.pages, options.sourcePageCount, limits);
    if (!pages.ok) return false;
    const objects = planEditorObjects(draft.objects, pages.pages, limits);
    return objects.ok;
  };

  const commit = (next: PdfEditorDraft): boolean => {
    if (!validate(next)) return false;
    stack.commit(next);
    return true;
  };

  return {
    draft() {
      return stack.present();
    },
    canUndo() {
      return stack.canUndo();
    },
    canRedo() {
      return stack.canRedo();
    },
    addObject(object) {
      const current = stack.present();
      if (current.objects.some((candidate) => candidate.id === object.id)) return false;
      return commit({ pages: current.pages, objects: [...current.objects, object] });
    },
    updateObject(object) {
      const current = stack.present();
      const index = current.objects.findIndex((candidate) => candidate.id === object.id);
      if (index < 0) return false;
      if (isSameObject(current.objects[index] as PdfEditorObjectInput, object)) return false;
      const objects = current.objects.map((candidate, position) => (position === index ? object : candidate));
      return commit({ pages: current.pages, objects });
    },
    removeObject(id) {
      const current = stack.present();
      const objects = current.objects.filter((candidate) => candidate.id !== id);
      if (objects.length === current.objects.length) return false;
      // 少一个对象只会更合法，不必再过一遍判据。
      stack.commit({ pages: current.pages, objects });
      return true;
    },
    setPages(pages) {
      const planned = planEditorPages(pages, options.sourcePageCount, limits);
      if (!planned.ok) return false;
      const current = stack.present();
      if (isSamePages(current.pages, pages)) return false;
      // 页计划可能删掉了某个对象还绑着的页：整表一起过判据，不合法整步拒绝
      // （渲染层删页时应当同时把该页对象迁走或删掉；删页带对象是 UI 自己要给的话）。
      const objects = planEditorObjects(current.objects, planned.pages, limits);
      if (!objects.ok) return false;
      stack.commit({ pages, objects: current.objects });
      return true;
    },
    undo() {
      return stack.undo();
    },
    redo() {
      return stack.redo();
    },
  };
}
