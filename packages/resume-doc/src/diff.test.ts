/**
 * 文档 diff 用例（spec 3.1-06 增 / 删 / 改三例，条目级 + 字段级）。
 */
import { describe, expect, it } from 'vitest';
import { diff } from './diff.js';
import { DEFAULT_LAYOUT, makeField, RESUME_SCHEMA_VERSION, type ResumeDocument, type Section } from './model.js';

function build(sections: Section[]): ResumeDocument {
  return {
    id: 'r',
    schemaVersion: RESUME_SCHEMA_VERSION,
    profile: { name: '张三', contact: { email: null, phone: null, location: null } },
    layout: DEFAULT_LAYOUT,
    sections,
    metrics: { pages: 1 },
    updatedAt: 0,
  };
}

const expSection = (entries: ResumeDocument['sections'][number]['entries']): Section => ({
  id: 'exp',
  kind: 'experience',
  title: '经历',
  entries,
});

describe('3.1-06 diff 三例', () => {
  it('字段级「改」：同一条目里 company 值变了', () => {
    const a = build([expSection([{ id: 'e1', fields: [makeField('experience', 'company', '旧公司')] }])]);
    const b = build([expSection([{ id: 'e1', fields: [makeField('experience', 'company', '新公司')] }])]);
    const result = diff(a, b);
    expect(result.isEmpty).toBe(false);
    const section = result.sections[0];
    expect(section?.change).toBe('modified');
    const entry = section?.entries[0];
    expect(entry?.change).toBe('modified');
    const field = entry?.fields[0];
    expect(field).toMatchObject({
      key: 'company',
      change: 'modified',
      before: '旧公司',
      after: '新公司',
      locked: true,
    });
  });

  it('条目级「增」：多出一条 e2', () => {
    const a = build([expSection([{ id: 'e1', fields: [makeField('experience', 'company', '公司')] }])]);
    const b = build([
      expSection([
        { id: 'e1', fields: [makeField('experience', 'company', '公司')] },
        { id: 'e2', fields: [makeField('experience', 'company', '另一家')] },
      ]),
    ]);
    const entryChanges = diff(a, b).sections[0]?.entries ?? [];
    const added = entryChanges.find((c) => c.entryId === 'e2');
    expect(added?.change).toBe('added');
  });

  it('条目级「删」：e1 从 b 中消失', () => {
    const a = build([expSection([{ id: 'e1', fields: [makeField('experience', 'company', '公司')] }])]);
    const b = build([expSection([])]);
    const sectionChange = diff(a, b).sections[0];
    expect(sectionChange?.entries.some((c) => c.entryId === 'e1' && c.change === 'removed')).toBe(true);
  });

  it('无差异 → isEmpty 为 true', () => {
    const s = expSection([{ id: 'e1', fields: [makeField('experience', 'company', '公司')] }]);
    expect(diff(build([s]), build([s])).isEmpty).toBe(true);
  });

  it('字段顺序不同不算差异（diff 前先归一化）', () => {
    const a = build([
      expSection([
        { id: 'e1', fields: [makeField('experience', 'company', 'X'), makeField('experience', 'role', 'Y')] },
      ]),
    ]);
    const b = build([
      expSection([
        { id: 'e1', fields: [makeField('experience', 'role', 'Y'), makeField('experience', 'company', 'X')] },
      ]),
    ]);
    expect(diff(a, b).isEmpty).toBe(true);
  });
});
