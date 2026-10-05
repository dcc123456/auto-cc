/**
 * 编辑会话（plan §7.3 的 `edit-session.ts`，接住 spec 3.5-08 的「撤销/重做基于既有历史机制」）。
 *
 * 装的是那份 **draft**：覆盖区列表 + 页序（`page-ops.ts` 那只数组）。两者合在一份快照里推进，
 * 因为"撤销一步"退的是用户的编辑，而不是某一列——用户先排页再框两个区，退一步只少一个框、页序不动，
 * 这才对得上按下去看到的东西。
 *
 * 为什么它是**纯模型**而不是又一只服务（§7.4 的表上 `pdf.edit` 那格暂不落服务）：
 * plan §7.1 的存储行定的是「会话态活在内存 + 渲染层」，而画布那份编辑栈就是这个形态——
 * `createWorkflowGraphEditor` 由渲染层直接拿（`packages/renderer/src/WorkflowCanvas.tsx`），不过 IPC。
 * 同一件事开第二条通道就是 §2.5 禁止的"两个都能用"。因此本文件**一条 Node 能力都不许 import**：
 * 没有 `node:fs`、没有 `pdf-lib`、连服务层那些带 `readBoundedFile` 的文件都不碰，
 * 否则渲染层将来取它就要把整支 PDF 引擎打进 Vite 的 bundle（`@auto-cc/core/snapshot-stack` 那条窄出口
 * 就是为这一步加的；本包自己的窄出口 `./edit-session` 等面板落地再登记，与 §7.12 顺延④ 同一口径）。
 *
 * 历史机制一律走 `@auto-cc/core` 的 `createSnapshotStack`（3.5-08 原文就写着"不引入第二套历史栈"）。
 */
import { createSnapshotStack, DEFAULT_SNAPSHOT_HISTORY } from '@auto-cc/core/snapshot-stack';
import type { PdfPageMetric } from './pdf-document.js';
import { planPageOrder } from './page-ops.js';
import { planOverlays, type OverlayLimits, type PdfOverlayInput, type PdfOverlayRect } from './overlay-writer.js';

/** 会话里那份可编辑的状态：覆盖区（比例坐标，页号是**源页号**）+ 产物逐页的来源页号。 */
export interface PdfEditDraft {
  readonly overlays: readonly PdfOverlayInput[];
  readonly pageOrder: readonly number[];
}

/**
 * 会话的尺度。比 `OverlayLimits` 多一条 `maxPages`，比服务配置 `PdfExportConfig` 少一条 `maxBytes`：
 * 会话不读文件，字节上限在那一步才有意义。不直接复用服务侧类型的理由是 `export-service.ts` 带 Node 依赖，
 * 本文件要能被渲染层安全 import（见头注）。
 */
export interface PdfEditSessionLimits extends OverlayLimits {
  /** 产物页数上限（与 `pdfExportSchema.maxPages` 同源，界面从配置读来传进来） */
  readonly maxPages: number;
}

/** 建会话时需要的读数。 */
export interface PdfEditSessionOptions {
  /** 打开那份 PDF 时量好的**源档**逐页宽高（会话不重新装载，见 §7.1 的存储行） */
  readonly pageMetrics: readonly PdfPageMetric[];
  readonly limits: PdfEditSessionLimits;
  /** 历史深度，超出丢最老的（默认与画布那一份同值，两处不该长出不一样的步数） */
  readonly historyCeiling?: number;
}

/** 会话的读数与动作。四个动作都只在**真的改了 draft** 时产生一条撤销单元。 */
export interface PdfEditSession {
  /** 当前 draft（**副本**：调用方改动手里的数组动不到栈里那份）。 */
  draft(): PdfEditDraft;
  canUndo(): boolean;
  canRedo(): boolean;
  /**
   * 加一个覆盖区。
   * @param overlay 比例坐标的新区（页号是源页号）
   * @returns 生效返回 true；id 已被占、或整表因此过不了 `planOverlays` 的校验时返回 false 且不入栈
   */
  addOverlay(overlay: PdfOverlayInput): boolean;
  /**
   * 改一个覆盖区的位置（拖拽落点）。
   * @param id 目标覆盖区标识
   * @param rect 新的比例矩形
   * @returns 生效返回 true；查无此 id 或矩形逐字段相同（空编辑）时返回 false
   */
  moveOverlay(id: string, rect: PdfOverlayRect): boolean;
  /**
   * 删一个覆盖区。
   * @param id 目标覆盖区标识
   * @returns 生效返回 true；查无此 id 时返回 false
   */
  removeOverlay(id: string): boolean;
  /**
   * 换成一份新页序（增页＝把同一项写两次、删页＝少写一项、重排＝换个顺序）。
   * @param order 产物逐页的源页号（1 起）
   * @returns 生效返回 true；页序非法（空 / 越界 / 超 `maxPages`）或与现值逐位相同时返回 false
   */
  setPageOrder(order: readonly number[]): boolean;
  /** 回退一步；栈空返回 false 且 draft 不变。 */
  undo(): boolean;
  /** 重做一步；没有可重做的返回 false。 */
  redo(): boolean;
}

/**
 * 深拷一份 draft：覆盖区逐条拷（嵌套的 `rect` 必须另拷），页序拷成新的数组。
 * @param draft 栈里存着的那份
 * @returns 内容相同、引用无关的新 draft
 */
function cloneDraft(draft: PdfEditDraft): PdfEditDraft {
  return {
    overlays: draft.overlays.map((overlay) => ({ ...overlay, rect: { ...overlay.rect } })),
    pageOrder: [...draft.pageOrder],
  };
}

/** 两个比例矩形是否逐字段相同（空编辑不进栈的判据，见 `moveOverlay`）。 */
function isSameRect(left: PdfOverlayRect, right: PdfOverlayRect): boolean {
  return (
    left.xRatio === right.xRatio &&
    left.yRatio === right.yRatio &&
    left.widthRatio === right.widthRatio &&
    left.heightRatio === right.heightRatio
  );
}

/** 两份页序是否逐位相同。 */
function isSameOrder(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((pageNumber, index) => pageNumber === right[index]);
}

/**
 * 建一只编辑会话。
 * @param initial 初始 draft（立刻被拷一份进去；调用方之后改原数组影响不到会话）。
 *                这里**不校验**初始值：会话的入口是 `pdf.io.open` 的量得结果加一份空列表，
 *                真要非法的东西在第一次动作或另存时都会被同一份判据挡下（§2.6 不在两处各写一遍）。
 * @param options 源档逐页度量、尺度、可选的历史深度
 * @returns 会话读数
 */
export function createPdfEditSession(initial: PdfEditDraft, options: PdfEditSessionOptions): PdfEditSession {
  const stack = createSnapshotStack(initial, cloneDraft, options.historyCeiling ?? DEFAULT_SNAPSHOT_HISTORY);

  /**
   * 把一份候选 draft 交回栈，前提是它整体合法。
   * @param next 候选 draft
   * @returns 真的推进了栈才 true
   */
  const commit = (next: PdfEditDraft): boolean => {
    // 覆盖区的合法性只有一个判据：另存时用的那一份（`planOverlays`）。会话里不写第二条规则，
    // 否则"界面放行而另存被拒"与"界面拦住而另存能过"迟早会分叉（§2.5）。
    if (!planOverlays(next.overlays, options.pageMetrics, options.limits).ok) return false;
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
    addOverlay(overlay) {
      const current = stack.present();
      if (current.overlays.some((candidate) => candidate.id === overlay.id)) return false;
      return commit({ overlays: [...current.overlays, overlay], pageOrder: current.pageOrder });
    },
    moveOverlay(id, rect) {
      const current = stack.present();
      const index = current.overlays.findIndex((candidate) => candidate.id === id);
      if (index < 0) return false;
      const previous = current.overlays[index] as PdfOverlayInput;
      if (isSameRect(previous.rect, rect)) return false;
      const overlays = current.overlays.map((candidate, position) =>
        position === index ? { ...candidate, rect } : candidate,
      );
      return commit({ overlays, pageOrder: current.pageOrder });
    },
    removeOverlay(id) {
      const current = stack.present();
      const overlays = current.overlays.filter((candidate) => candidate.id !== id);
      // 少一条只会更合法，不会更非法，所以这一腿不必再过一遍 `planOverlays`。
      if (overlays.length === current.overlays.length) return false;
      stack.commit({ overlays, pageOrder: current.pageOrder });
      return true;
    },
    setPageOrder(order) {
      const planned = planPageOrder(order, options.pageMetrics.length, options.limits.maxPages);
      if (!planned.ok) return false;
      const current = stack.present();
      // 直通与"就是现值"都不算一步编辑：空编辑进栈会让撤销一下退回一个长得一模一样的 draft。
      if (isSameOrder(current.pageOrder, planned.order)) return false;
      stack.commit({ overlays: current.overlays, pageOrder: planned.order });
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
