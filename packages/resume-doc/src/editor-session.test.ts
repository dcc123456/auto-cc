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

/** 取某一格的值（打字那条反复要读"这一格现在写的是什么"，缺键就给 `undefined`）。 */
function valueOf(
  session: ResumeEditorSession,
  sectionId: string,
  entryId: string,
  fieldKey: string,
): string | undefined {
  return session
    .document()
    .sections.find((item) => item.id === sectionId)
    ?.entries.find((entry) => entry.id === entryId)
    ?.fields.find((field) => field.key === fieldKey)?.value;
}

describe('3.6-03 撤销/重做与当前步骤', () => {
  it('刚打开既不 dirty、也没有可退的；一次真编辑同时翻动两个读数', () => {
    const session = open();
    expect(session.isDirty()).toBe(false);
    expect(session.canUndo()).toBe(false);
    expect(session.moveSection('exp', 1).ok).toBe(true);
    expect(session.isDirty()).toBe(true);
    expect(session.canUndo()).toBe(true);
  });

  it('空编辑不进栈、非法编辑不进会话：两种都不长撤销单元，但只有一种是失败', () => {
    const session = open();
    // 拖回原地 / 改成同一个值：判定是"通过"（界面不该报错），但没有新的一步。
    expect(session.moveSection('exp', 0)).toEqual({ ok: true, value: session.document() });
    expect(session.moveEntry('exp', 'e1', 0).ok).toBe(true);
    expect(session.setMetric('baseFontPt', 10.5).ok).toBe(true);
    // 界外、非有限数、未知 id：判定是"拒绝"，子原因原样上浮（3.6-b 的契约通道靠它拼提示）。
    expect(session.setMetric('baseFontPt', 99)).toMatchObject({ ok: false, code: 'out-of-bounds' });
    expect(session.setMetric('baseFontPt', Number.NaN)).toMatchObject({ ok: false, code: 'not-a-number' });
    expect(session.moveSection('zz', 1)).toMatchObject({ ok: false, code: 'unknown-section' });
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

  it('markSaved 把 dirty 基线推到当前内容：刚存过就不该再拦「未保存离开」，但历史照旧退得回去', () => {
    const session = open();
    session.setMetric('baseFontPt', 12);
    expect(session.isDirty()).toBe(true);

    session.markSaved();

    expect(session.isDirty()).toBe(false);
    expect(session.canUndo()).toBe(true);
    expect(session.undo()).toBe(true);
    // 退回到"打开时那份"之外的一步之后，与新的基线又不一样了——dirty 判的是"与上次保存的不同"。
    expect(session.isDirty()).toBe(true);
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

describe('3.11-02 打字改正文：一次调用一条撤销单元，改成同一个字不进栈', () => {
  it('敲进 e1 那一格：值换了、dirty 与 canUndo 同翻，退一步就回到敲之前', () => {
    const session = open();
    expect(session.setFieldText('exp', 'e1', 'role', '新的岗位名').ok).toBe(true);
    expect(valueOf(session, 'exp', 'e1', 'role')).toBe('新的岗位名');
    expect(session.isDirty()).toBe(true);
    expect(session.canUndo()).toBe(true);

    expect(session.undo()).toBe(true);
    expect(valueOf(session, 'exp', 'e1', 'role')).toBe('e1');
    expect(session.isDirty()).toBe(false);
  });

  it('打成同一个字：判定是"通过"但不长撤销单元——这一条不为打字另写判断，用的就是 `apply` 里那一份 `contentHash`', () => {
    const session = open();
    expect(session.setFieldText('exp', 'e1', 'role', 'e1')).toEqual({ ok: true, value: session.document() });
    expect(session.canUndo()).toBe(false);
    expect(session.isDirty()).toBe(false);
  });

  it('查无此键 / 查无区块都不进栈，子原因原样上浮（3.11-03 的契约通道靠它拼提示）', () => {
    const session = open();
    expect(session.setFieldText('exp', 'e1', 'description', 'x')).toMatchObject({ ok: false, code: 'unknown-field' });
    expect(session.setFieldText('zz', 'e1', 'role', 'x')).toMatchObject({ ok: false, code: 'unknown-section' });
    expect(session.canUndo()).toBe(false);
    expect(session.isDirty()).toBe(false);
    expect(session.document()).toEqual(fixture());
  });

  it('打字与拖拽、度量共用同一只栈：三步交错，退两步仍是那两步（3.10-07「会话只有一份」在这格续用）', () => {
    const session = open();
    session.setFieldText('exp', 'e1', 'role', '甲');
    session.setMetric('baseFontPt', 12);
    session.setFieldText('skills', 'e4', 'name', '乙');

    expect(session.undo()).toBe(true);
    expect(valueOf(session, 'skills', 'e4', 'name')).toBe('e4');
    expect(session.document().layout.baseFontPt).toBe(12);

    expect(session.undo()).toBe(true);
    expect(session.document().layout.baseFontPt).toBe(10.5);

    expect(session.undo()).toBe(true);
    expect(valueOf(session, 'exp', 'e1', 'role')).toBe('e1');
    expect(session.canUndo()).toBe(false);
  });
});
