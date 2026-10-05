/**
 * 编辑会话的用例（spec 3.6-03 的 U 半边 + 3.6-04 的「切换不丢数据」+ 3.6-09 的 dirty 读数，plan §8.4 的 3.6-a）。
 */
import { describe, expect, it } from 'vitest';
import { createResumeEditorSession, type ResumeEditorSession } from './editor-session.js';
import { contentHash } from './normalize.js';
import { createEmptyDocument, makeField, type ResumeDocument, type Section } from './model.js';

/** 一份可直接编辑的合法文档：两个区块、第一个区块三条条目。 */
function fixture(): ResumeDocument {
  const sections: Section[] = [
    {
      id: 'exp',
      kind: 'experience',
      title: '经历',
      entries: ['e1', 'e2', 'e3'].map((id) => ({ id, fields: [makeField('experience', 'role', id)] })),
    },
    {
      id: 'skills',
      kind: 'skills',
      title: '技能',
      entries: [{ id: 'e4', fields: [makeField('skills', 'name', 'e4')] }],
    },
  ];
  return { ...createEmptyDocument('r', 0), sections };
}

/** 打开会话（模板固定成 classic，与各片一致的默认语言）。 */
function open(document = fixture()) {
  return createResumeEditorSession(document, { templateId: 'classic' });
}

/**
 * 按 id 取某个区块的条目 id 序列。
 * 区块重排之后"第 0 个区块"就不再是 `exp`，用例要认的是 id 而不是下标。
 */
function entryIds(session: ResumeEditorSession, sectionId: string): readonly (string | undefined)[] {
  return (
    session
      .document()
      .sections.find((item) => item.id === sectionId)
      ?.entries.map((entry) => entry.id) ?? []
  );
}

describe('3.6-03 撤销/重做与当前步骤', () => {
  it('刚打开既不 dirty、也没有可退的；一次真编辑同时翻动两个读数', () => {
    const session = open();
    expect(session.isDirty()).toBe(false);
    expect(session.canUndo()).toBe(false);
    expect(session.moveSection('exp', 1)).toBe(true);
    expect(session.isDirty()).toBe(true);
    expect(session.canUndo()).toBe(true);
  });

  it('空编辑一律不进栈：拖回原地、改成同一个值、越界与界外都是 false 且没有可退的一步', () => {
    const session = open();
    expect(session.moveSection('exp', 0)).toBe(false);
    expect(session.moveEntry('exp', 'e1', 0)).toBe(false);
    expect(session.setMetric('baseFontPt', 10.5)).toBe(false);
    expect(session.setMetric('baseFontPt', 99)).toBe(false);
    expect(session.setMetric('baseFontPt', Number.NaN)).toBe(false);
    expect(session.moveSection('zz', 1)).toBe(false);
    expect(session.canUndo()).toBe(false);
    expect(session.isDirty()).toBe(false);
    expect(session.document()).toEqual(fixture());
  });

  it('连续三步各退各的：退一步只少最近那一条，前两步留着（界面据此置灰按钮）', () => {
    const session = open();
    session.moveSection('exp', 1);
    session.setMetric('baseFontPt', 12);
    session.moveEntry('exp', 'e1', 2);
    expect(session.document().sections.map((item) => item.id)).toEqual(['skills', 'exp']);
    expect(entryIds(session, 'exp')).toEqual(['e2', 'e3', 'e1']);
    expect(session.canRedo()).toBe(false);

    expect(session.undo()).toBe(true);
    expect(entryIds(session, 'exp')).toEqual(['e1', 'e2', 'e3']);
    expect(session.document().layout.baseFontPt).toBe(12);

    expect(session.undo()).toBe(true);
    expect(session.document().layout.baseFontPt).toBe(10.5);
    expect(session.document().sections[0]?.id).toBe('skills');

    expect(session.redo()).toBe(true);
    expect(session.document().layout.baseFontPt).toBe(12);
    expect(session.canRedo()).toBe(true);
  });

  it('一路退到打开时那份，dirty 自己就回 false（判据是内容 hash，不是"按过几次"）', () => {
    const session = open();
    session.setMetric('lineHeight', 1.8);
    session.setMetric('lineHeight', 1.5);
    expect(session.isDirty()).toBe(false);
    expect(session.canUndo()).toBe(true);
    expect(session.document().layout.lineHeight).toBe(1.5);
  });

  it('新编辑作废重做分支：退回去之后再做一次编辑，前面那条重做就没路了', () => {
    const session = open();
    session.setMetric('baseFontPt', 11);
    session.undo();
    expect(session.canRedo()).toBe(true);
    session.setMetric('baseFontPt', 13);
    expect(session.canRedo()).toBe(false);
    expect(session.document().layout.baseFontPt).toBe(13);
  });

  it('document() 给的是副本：界面拿它改数组动不到会话里那份', () => {
    const session = open();
    const leaked = session.document();
    leaked.sections.length = 0;
    leaked.layout.baseFontPt = 2;
    expect(session.document().sections.map((section) => section.id)).toEqual(['exp', 'skills']);
    expect(session.isDirty()).toBe(false);
  });
});

describe('3.6-04 模板与语言切换不碰数据', () => {
  it('切换只动视图旋钮：文档逐字节相同、不产生撤销单元、dirty 仍是 false', () => {
    const session = open();
    const before = session.document();
    const beforeHash = contentHash(before);

    session.useTemplate('modern');
    session.useLocale('en');

    expect(session.templateId()).toBe('modern');
    expect(session.locale()).toBe('en');
    expect(contentHash(session.document())).toBe(beforeHash);
    expect(session.document()).toEqual(before);
    expect(session.canUndo()).toBe(false);
    expect(session.isDirty()).toBe(false);
  });

  it('切完之后区块/条目/字段一个都不少（判据原文的「断言数据字段齐全」）', () => {
    const session = open();
    session.useTemplate('minimal');
    const document = session.document();
    expect(document.sections.map((section) => section.id)).toEqual(['exp', 'skills']);
    expect(document.sections[0]?.entries.map((entry) => entry.id)).toEqual(['e1', 'e2', 'e3']);
    expect(document.sections[0]?.entries[0]?.fields.map((field) => field.key)).toEqual(['role']);
    expect(document.profile).toEqual(fixture().profile);
    expect(document.metrics).toEqual({ pages: 1 });
  });

  it('历史深度接得上：传 2 就只留两步，第三步挤掉最老的那一步', () => {
    const session = createResumeEditorSession(fixture(), { templateId: 'classic', historyCeiling: 2 });
    session.setMetric('baseFontPt', 11);
    session.setMetric('baseFontPt', 12);
    session.setMetric('baseFontPt', 13);
    expect(session.undo()).toBe(true);
    expect(session.undo()).toBe(true);
    expect(session.undo()).toBe(false);
    expect(session.document().layout.baseFontPt).toBe(11);
  });
});
