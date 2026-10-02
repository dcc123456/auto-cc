/**
 * Schema 校验与事实锁定用例（spec 3.1-02 可读错误 / 3.1-03 锁定字段篡改被拦 / 4.5-03 生成轨可改写白名单）。
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

describe('4.5-03 生成轨口径：只有白名单里的键可改写，其余原样引用', () => {
  /** 一份同时含「锁定事实 + 可改写正文 + 模型未标锁的事实字段」的基线，用来证明两道判据各管一段。 */
  const baseline: ResumeDocument = {
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
            fields: [
              makeField('experience', 'company', '星桥科技'),
              makeField('experience', 'period', '2021.03 - 至今'),
              makeField('experience', 'text', '负责订单服务'),
            ],
          },
        ],
      },
      {
        id: 'edu',
        kind: 'education',
        title: '教育',
        entries: [
          {
            id: 'd1',
            fields: [makeField('education', 'school', '北方理工大学'), makeField('education', 'degree', '本科')],
          },
        ],
      },
    ],
    metrics: { pages: 1 },
    updatedAt: 0,
  };

  /**
   * 把基线里若干字段的值换掉，其余逐字复用。
   * @param overrides 区块 id → 条目 id → 字段键 → 新值
   * @returns 改写字段后的新文档（不改动 baseline）
   */
  function rewrite(overrides: Record<string, Record<string, Record<string, string>>>): ResumeDocument {
    return {
      ...baseline,
      sections: baseline.sections.map((section) => ({
        ...section,
        entries: section.entries.map((entry) => ({
          ...entry,
          fields: entry.fields.map((field) => {
            const next = overrides[section.id]?.[entry.id]?.[field.key];
            return next === undefined ? field : { ...field, value: next };
          }),
        })),
      })),
    };
  }

  const editable = ['text'] as const;

  it('只改写白名单里的 text → 无违规（这正是生成轨唯一允许的动作）', () => {
    const proposed = rewrite({ exp: { e1: { text: '主导订单与结算服务重构，把接口 P99 从 800ms 压到 120ms' } } });
    expect(checkFactLock(baseline, proposed, editable)).toHaveLength(0);
    // 同一条改写放在 3.1-03 的缺省口径下也仍然放行：新增参数没有改变旧调用点的语义。
    expect(checkFactLock(baseline, proposed)).toHaveLength(0);
  });

  it('改写模型未标锁的 degree → 白名单口径按 editable-allowlist 拦下，factKey 为 null', () => {
    const proposed = rewrite({ edu: { d1: { degree: '硕士' } } });
    const violations = checkFactLock(baseline, proposed, editable);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.gate).toBe('editable-allowlist');
    expect(violations[0]?.factKey).toBeNull();
    expect(violations[0]?.before).toBe('本科');
    expect(violations[0]?.after).toBe('硕士');
    // 缺省口径（不传白名单）对这条完全不拦：证明生成轨确实**更严**，而不是把旧判据换了个名字。
    expect(checkFactLock(baseline, proposed)).toHaveLength(0);
  });

  it('改写锁定的 company → 仍归 fact-lock，白名单参数不放松事实锁', () => {
    const proposed = rewrite({ exp: { e1: { company: '星桥科技集团' } } });
    const violations = checkFactLock(baseline, proposed, editable);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.gate).toBe('fact-lock');
    expect(violations[0]?.factKey).toBe('company');
  });

  it('一次改写多处 → 违规逐条给全（界面要能一项一项回退）', () => {
    const proposed = rewrite({
      exp: { e1: { text: '改写正文', period: '2020.01 - 2023.01' } },
      edu: { d1: { school: '另一所大学' } },
    });
    const violations = checkFactLock(baseline, proposed, editable);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => `${v.sectionId}/${v.entryId}/${v.fieldKey}:${v.gate}`).sort()).toEqual([
      'edu/d1/school:editable-allowlist',
      'exp/e1/period:fact-lock',
    ]);
  });

  it('条目重排（4.5-02 允许的顺序调整）不产生任何违规', () => {
    const swapped: ResumeDocument = {
      ...baseline,
      sections: [
        baseline.sections[1]!,
        {
          ...baseline.sections[0]!,
          entries: [
            baseline.sections[0]!.entries[0]!,
            {
              id: 'e2',
              fields: [makeField('experience', 'company', '未名开源社区'), makeField('experience', 'text', '社区维护')],
            },
          ],
        },
      ],
    };
    expect(checkFactLock(baseline, swapped, editable)).toHaveLength(0);
  });
});
