/**
 * 归一化与内容 hash 用例（spec 3.1-05 幂等）。
 */
import { describe, expect, it } from 'vitest';
import { contentHash, normalizeDocument } from './normalize.js';
import { DEFAULT_LAYOUT, makeField, RESUME_SCHEMA_VERSION, type ResumeDocument } from './model.js';

function doc(mutate: (d: ResumeDocument) => void): ResumeDocument {
  const base: ResumeDocument = {
    id: ' r1 ',
    schemaVersion: RESUME_SCHEMA_VERSION,
    profile: { name: '张三', contact: { email: ' z@x.com ', phone: '', location: null } },
    layout: DEFAULT_LAYOUT,
    sections: [
      {
        id: 'exp',
        kind: 'experience',
        title: ' 经历 ',
        entries: [
          { id: 'e1', fields: [makeField('experience', 'role', '前端'), makeField('experience', 'company', '星桥')] },
        ],
      },
    ],
    metrics: { pages: 1 },
    updatedAt: 0,
  };
  mutate(base);
  return base;
}

describe('3.1-05 归一化幂等', () => {
  it('normalize 两次结果字节一致（两次 hash 相等）', () => {
    const once = normalizeDocument(doc(() => {}));
    const twice = normalizeDocument(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(contentHash(once)).toBe(contentHash(twice));
  });

  it('字段顺序不同 → 归一后同一 hash（顺序被规范化）', () => {
    const a = doc((d) => {
      d.sections[0]!.entries[0]!.fields = [
        makeField('experience', 'role', '前端'),
        makeField('experience', 'company', '星桥'),
      ];
    });
    const b = doc((d) => {
      d.sections[0]!.entries[0]!.fields = [
        makeField('experience', 'company', '星桥'),
        makeField('experience', 'role', '前端'),
      ];
    });
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it('空串 contact 与 null contact 归一后相等', () => {
    const empty = doc((d) => {
      d.profile.contact.phone = '';
    });
    const nul = doc((d) => {
      d.profile.contact.phone = null;
    });
    expect(contentHash(empty)).toBe(contentHash(nul));
  });

  it('updatedAt 不同但内容相同 → hash 相同（时间不参与内容）', () => {
    const early = doc((d) => {
      d.updatedAt = 100;
    });
    const late = doc((d) => {
      d.updatedAt = 999999;
    });
    expect(contentHash(early)).toBe(contentHash(late));
  });
});
