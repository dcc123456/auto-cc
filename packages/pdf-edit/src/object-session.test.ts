/**
 * 编辑器会话（对象 + 页计划 + 撤销栈）的单测。
 *
 * 重点是两条：① 会话判据与另存同源（`planEditorObjects` / `planEditorPages`），
 * 界面放行的东西 saveEditor 必须也放行；② 空编辑不产生撤销单元，删页不能留下孤儿对象。
 */
import { describe, expect, it } from 'vitest';
import {
  createPdfEditorSession,
  type PdfEditorDraft,
  type PdfEditorSession,
} from './object-session.js';
import type { PdfEditorObjectInput, PdfEditorPageInput } from './object-model.js';

const limits = {
  maxObjects: 100,
  defaultTextSizePt: 11,
  minAreaRatio: 0.0001,
  maxPages: 10,
  defaultBlankWidthPt: 595.28,
  defaultBlankHeightPt: 841.89,
};

/** 两页源档的初始 draft。 */
function initial(): PdfEditorDraft {
  return {
    pages: [
      { id: 'p1', kind: 'source', sourcePageNumber: 1 },
      { id: 'p2', kind: 'source', sourcePageNumber: 2 },
    ],
    objects: [],
  };
}

function boot(sourcePageCount = 2): PdfEditorSession {
  return createPdfEditorSession(initial(), { sourcePageCount, limits });
}

/** 一个合法的高亮对象（最省字段的类型，专门用来演栈）。 */
function highlight(id: string, pageId = 'p1'): PdfEditorObjectInput {
  return { id, pageId, kind: 'highlight', rect: { xRatio: 0.1, yRatio: 0.1, widthRatio: 0.2, heightRatio: 0.05 } };
}

describe('对象增改删', () => {
  it('add/update/remove 后读得到；undo/redo 逐动作回放', () => {
    const session = boot();
    expect(session.canUndo()).toBe(false);
    expect(session.addObject(highlight('h1'))).toBe(true);
    expect(session.draft().objects).toHaveLength(1);

    expect(session.addObject(highlight('h1'))).toBe(false); // id 已占
    expect(session.updateObject(highlight('h1'))).toBe(false); // 逐字段相同＝空编辑
    const moved = highlight('h1');
    expect(session.updateObject({ ...moved, rect: { ...moved.rect, xRatio: 0.3 } })).toBe(true);
    expect(session.draft().objects[0]?.rect.xRatio).toBe(0.3);

    expect(session.removeObject('h1')).toBe(true);
    expect(session.removeObject('h1')).toBe(false); // 查无 id
    expect(session.draft().objects).toHaveLength(0);

    expect(session.canUndo()).toBe(true);
    expect(session.undo()).toBe(true); // 删退回去：对象回来
    expect(session.draft().objects[0]?.id).toBe('h1');
    session.undo(); // 移动退回
    expect(session.draft().objects[0]?.rect.xRatio).toBe(0.1);
    session.undo(); // 新增退回：空表
    expect(session.draft().objects).toHaveLength(0);
    expect(session.undo()).toBe(false); // 栈底
    expect(session.redo()).toBe(true);
    expect(session.draft().objects[0]?.id).toBe('h1');
  });

  it('非法对象 add 拒绝且不入栈', () => {
    const session = boot();
    const bad: PdfEditorObjectInput = { ...highlight('bad'), pageId: 'ghost' };
    expect(session.addObject(bad)).toBe(false);
    expect(session.draft().objects).toHaveLength(0);
    expect(session.canUndo()).toBe(false);
  });
});

describe('页计划替换', () => {
  it('合法排序整表替换并进撤销栈；与现值相同不进栈', () => {
    const session = boot();
    const reversed: readonly PdfEditorPageInput[] = [
      { id: 'p2', kind: 'source', sourcePageNumber: 2 },
      { id: 'p1', kind: 'source', sourcePageNumber: 1 },
    ];
    expect(session.setPages(reversed)).toBe(true);
    expect(session.draft().pages[0]?.id).toBe('p2');
    expect(session.setPages(reversed)).toBe(false); // 逐位相同
    session.undo();
    expect(session.draft().pages[0]?.id).toBe('p1');
  });

  it('插空白页与旋转合法；越界源页拒', () => {
    const session = boot();
    expect(
      session.setPages([
        { id: 'p1', kind: 'source', sourcePageNumber: 1, rotation: 90 },
        { id: 'b1', kind: 'blank' },
      ]),
    ).toBe(true);
    expect(session.draft().pages[1]?.kind).toBe('blank');
    expect(session.setPages([{ id: 'x', kind: 'source', sourcePageNumber: 9 }])).toBe(false);
  });

  it('删掉仍被对象绑着的页：整步拒绝（不允许产出孤儿对象；UI 删页时要自己把对象带走或一起删）', () => {
    const session = boot();
    session.addObject(highlight('h1', 'p2'));
    expect(session.setPages([{ id: 'p1', kind: 'source', sourcePageNumber: 1 }])).toBe(false);
    // draft 未被改动
    expect(session.draft().pages).toHaveLength(2);
    expect(session.canUndo()).toBe(true); // 上一条 add 仍在栈顶，被拒的 setPages 没污染栈
  });
});
