/**
 * Schema 校验与事实锁定用例（spec 3.1-02 可读错误 / 3.1-03 锁定字段篡改被拦）。
 */
import { describe, expect, it } from 'vitest';
import { checkFactLock, validateDocument } from './schema.js';
import { createEmptyDocument, DEFAULT_LAYOUT, makeField, RESUME_SCHEMA_VERSION, type ResumeDocument } from './model.js';

describe('3.1-02 非法输入给可读错误，不抛裸异常', () => {
  const cases: Array<{ name: string; raw: unknown; want: string }> = [
    { name: '根不是对象', raw: 'not-an-object', want: '(root)' },
    {
      name: '缺 id',
      raw: {
        schemaVersion: 1,
        profile: { name: '', contact: { email: null, phone: null, location: null } },
        layout: DEFAULT_LAYOUT,
        sections: [],
        metrics: { pages: 1 },
        updatedAt: 0,
      },
      want: 'id',
    },
    {
      name: 'layout.baseFontPt 为负',
      raw: { ...createEmptyDocument('r', 0), layout: { ...DEFAULT_LAYOUT, baseFontPt: -3 } },
      want: 'layout.baseFontPt',
    },
    {
      name: 'section.kind 非法枚举',
      raw: { ...createEmptyDocument('r', 0), sections: [{ id: 's', kind: 'banana', title: '', entries: [] }] },
      want: 'sections[0].kind',
    },
    // strict 拒未知键：zod 把违规键写在 issue.message 里（path 停在父对象 → 根返回 `(root)`），
    // 所以断言同时接受「路径命中」与「可读消息命中」，两者都证明错误定位到了具体字段。
    { name: '未知顶层字段被 strict 拒', raw: { ...createEmptyDocument('r', 0), avatar_url: 'x' }, want: 'avatar_url' },
    {
      name: 'metrics.pages=0 非法',
      raw: { ...createEmptyDocument('r', 0), metrics: { pages: 0 } },
      want: 'metrics.pages',
    },
  ];

  for (const item of cases) {
    it(item.name, () => {
      const result = validateDocument(item.raw);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.length).toBeGreaterThan(0);
      // 每条错误都带路径 + 期望 + 实际（可读三件套）。
      for (const issue of result.issues) {
        expect(typeof issue.path).toBe('string');
        expect(issue.expected.length).toBeGreaterThan(0);
      }
      expect(result.issues.some((issue) => issue.path.includes(item.want) || issue.message.includes(item.want))).toBe(
        true,
      );
    });
  }
});

describe('3.1-03 事实锁定：篡改已锁字段被拦，改非锁字段放行', () => {
  const base: ResumeDocument = {
    id: 'r',
    schemaVersion: RESUME_SCHEMA_VERSION,
    profile: { name: '张三', contact: { email: null, phone: null, location: null } },
    layout: DEFAULT_LAYOUT,
    sections: [
      {
        id: 'exp',
        kind: 'experience',
        title: '经历',
        entries: [
          {
            id: 'e1',
            fields: [makeField('experience', 'company', '星桥科技'), makeField('experience', 'desc', '原描述')],
          },
        ],
      },
    ],
    metrics: { pages: 1 },
    updatedAt: 0,
  };

  it('生成轨改了 locked 的 company → 报违规，含 before/after', () => {
    const proposed: ResumeDocument = {
      ...base,
      sections: [
        {
          ...base.sections[0]!,
          entries: [
            {
              id: 'e1',
              fields: [makeField('experience', 'company', '凭空捏造公司'), makeField('experience', 'desc', '原描述')],
            },
          ],
        },
      ],
    };
    const violations = checkFactLock(base, proposed);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.factKey).toBe('company');
    expect(violations[0]?.before).toBe('星桥科技');
    expect(violations[0]?.after).toBe('凭空捏造公司');
  });

  it('生成轨只改非锁定的 desc → 无违规', () => {
    const proposed: ResumeDocument = {
      ...base,
      sections: [
        {
          ...base.sections[0]!,
          entries: [
            {
              id: 'e1',
              fields: [makeField('experience', 'company', '星桥科技'), makeField('experience', 'desc', '润色后的描述')],
            },
          ],
        },
      ],
    };
    expect(checkFactLock(base, proposed)).toHaveLength(0);
  });

  it('新增一条全新经历条目（非篡改既有事实）→ 无违规', () => {
    const proposed: ResumeDocument = {
      ...base,
      sections: [
        {
          ...base.sections[0]!,
          entries: [
            ...base.sections[0]!.entries,
            { id: 'e2', fields: [makeField('experience', 'company', '另一家公司')] },
          ],
        },
      ],
    };
    expect(checkFactLock(base, proposed)).toHaveLength(0);
  });
});
