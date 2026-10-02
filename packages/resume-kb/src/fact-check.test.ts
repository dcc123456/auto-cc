/**
 * 定向生成的事实校验用例（spec 4.5-03 / 04 / 07 / 08 / 14 的确定性半边）。
 *
 * 覆盖口径照 plan §4.5 取证一写死：源仓库 `factCheckService` 用 levenshtein ≤3 容差，
 * 「字节跳动」与「字节科技」在那边判为一致——本项目必须把这条输入判成篡改，否则等于抄了个有洞的实现。
 * PII 哨兵是**植入**的（4.5-14 判据七：否定式"我们没打印"不算证据），哨兵没被植入时用例自己会红。
 *
 * 可改写面按 2026-10-02 用户裁定的 A 口径（plan §4.5 取证三 已同步更正）：
 * 散文键 `text / achievement / description` 可改写，受数值与具名两条判据约束；
 * 结构事实键整句原样引用。技能行不进生成腿的提议面，但仍在校验面内（下面单有一例锁住这个关系）。
 *
 * 数值抽取本身的口径测试不在这里：那份实现搬到 `@auto-cc/core` 的 `numbers.ts`（两个同级包共用），
 * 用例跟着搬去 `packages/core/src/numbers.test.ts`；本文件只测"校验读得出篡改"这一层。
 */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, makeField, type ResumeDocument, type Section } from '@auto-cc/plugin-resume-doc';
import {
  collectKnownNames,
  describeViolations,
  findUnknownEntityCandidates,
  generationEditableFields,
  generationTargetFields,
  verifyGeneration,
} from './fact-check.js';

/** 植入用的高置信哨兵：手机号 / 邮箱 / 身份证各一条，只出现在字段值里，绝不该出现在读数里。 */
const PII_PHONE = '13800001234';
const PII_EMAIL = 'xinqiao.sample@example.invalid';
const PII_ID = '110101199003074567';

/** 构造一份"基线简历"：三段区块，字段值里带着上面三条哨兵。 */
function makeBaselineDocument(): ResumeDocument {
  const sections: Section[] = [
    {
      id: 'summary',
      kind: 'summary',
      title: '个人简介',
      entries: [{ id: 's1', fields: [makeField('summary', 'text', `五年后端工程师，联系方式 ${PII_PHONE}。`)] }],
    },
    {
      id: 'experience',
      kind: 'experience',
      title: '工作经历',
      entries: [
        {
          id: 'e1',
          fields: [
            makeField('experience', 'company', '星桥科技'),
            makeField('experience', 'role', '后端工程师'),
            makeField('experience', 'period', '2021 - 2024'),
            makeField('experience', 'achievement', `主导订单服务重构，P99 延迟下降 40%，复用率 40%。${PII_EMAIL}`),
          ],
        },
        {
          id: 'e2',
          fields: [
            makeField('experience', 'company', '未名开源社区'),
            makeField('experience', 'role', '维护者'),
            makeField('experience', 'period', '2023 - 至今'),
            makeField('experience', 'achievement', '发布 PDF 打印工具链，月下载 2 万次。'),
          ],
        },
      ],
    },
    {
      id: 'education',
      kind: 'education',
      title: '教育背景',
      entries: [
        {
          id: 'd1',
          fields: [
            makeField('education', 'school', '北方理工大学'),
            makeField('education', 'degree', '本科'),
            makeField('education', 'major', '软件工程'),
          ],
        },
      ],
    },
  ];
  return { ...createEmptyDocument('doc-45', 0), sections };
}

/** 把基线里指定条段的 `text` 字段换成新句子，其余字段逐字不动（模拟"只润色散文"的合法生成）。 */
function withProse(original: ResumeDocument, sectionId: string, entryId: string, newText: string): ResumeDocument {
  return {
    ...original,
    sections: original.sections.map((section) =>
      section.id !== sectionId
        ? section
        : {
            ...section,
            entries: section.entries.map((entry) =>
              entry.id !== entryId
                ? entry
                : {
                    ...entry,
                    fields: entry.fields.map((field) => (field.key === 'text' ? { ...field, value: newText } : field)),
                  },
            ),
          },
    ),
  };
}

/** 把基线里某个字段换成新值，用于逐类篡改（公司 / 学校 / 成果 / 时间）。 */
function withField(
  original: ResumeDocument,
  sectionId: string,
  entryId: string,
  fieldKey: string,
  value: string,
): ResumeDocument {
  return {
    ...original,
    sections: original.sections.map((section) =>
      section.id !== sectionId
        ? section
        : {
            ...section,
            entries: section.entries.map((entry) =>
              entry.id !== entryId
                ? entry
                : {
                    ...entry,
                    fields: entry.fields.map((field) => (field.key === fieldKey ? { ...field, value } : field)),
                  },
            ),
          },
    ),
  };
}

const JD_TEXT = '岗位职责：负责订单与结算服务。公司名称：星桥科技。要求：熟悉 Kubernetes。';

describe('4.5-07 具名候选回查（启发式补刀，强保证在结构面）', () => {
  const known = collectKnownNames(makeBaselineDocument());

  it('库里没有的组织名被拦下', () => {
    expect(findUnknownEntityCandidates('曾任职于星辰科技有限公司，负责结算。', known, JD_TEXT)).toEqual([
      '曾任职于星辰科技有限公司',
    ]);
  });

  it('JD 原文里出现过的公司名不算虚构', () => {
    expect(findUnknownEntityCandidates('为星桥科技的订单服务做过重构。', known, JD_TEXT)).toEqual([]);
    // 候选串比 JD 里的写法更长（带"有限公司"后缀）时，靠"包含已知名"放行，不要求字面全等
    expect(findUnknownEntityCandidates('星桥科技有限公司的结算链路。', known, JD_TEXT)).toEqual([]);
  });

  it('指代词读法（本公司 / 该社区）不是具名实体，不产生违规', () => {
    expect(findUnknownEntityCandidates('在本公司负责订单服务，该社区项目持续维护。', known, JD_TEXT)).toEqual([]);
  });

  it('库里没有、JD 里也没有的学校名被拦下', () => {
    expect(findUnknownEntityCandidates('毕业于南方财经大学。', known, JD_TEXT)).toEqual(['毕业于南方财经大学']);
  });
});

describe('4.5-03 / 04 字段原样引用', () => {
  it('只改可改写的 text，其余逐字不动 → 通过', () => {
    const base = makeBaselineDocument();
    const proposed = withProse(base, 'summary', 's1', `五年后端工程师，联系电话 ${PII_PHONE}，专注高并发与可观测性。`);
    const report = verifyGeneration({ original: base, proposed, jdText: JD_TEXT });
    expect(report.ok).toBe(true);
    expect(report.fieldViolations).toHaveLength(0);
  });

  it('公司名换成两字之差的另一家 → 必须拦住（源实现容差 3 会放行，plan §4.5 取证一）', () => {
    const base = makeBaselineDocument();
    const proposed = withField(base, 'experience', 'e1', 'company', '星桥科技集团');
    const report = verifyGeneration({ original: base, proposed, jdText: JD_TEXT });
    expect(report.ok).toBe(false);
    expect(report.fieldViolations).toHaveLength(1);
    // 带"集团"后缀的新串在法律上是另一条实体，`locked` 的公司名由模型级事实锁拦下
    expect(report.fieldViolations[0]?.gate).toBe('fact-lock');
    expect(report.fieldViolations[0]?.factKey).toBe('company');
  });

  it('学历区块的学校名被改 → 拦住，且标成白名单口径（模型里它不标锁）', () => {
    const base = makeBaselineDocument();
    const proposed = withField(base, 'education', 'd1', 'school', '北方理工大学深圳学院');
    const report = verifyGeneration({ original: base, proposed, jdText: JD_TEXT });
    expect(report.fieldViolations).toHaveLength(1);
    expect(report.fieldViolations[0]?.fieldKey).toBe('school');
    expect(report.fieldViolations[0]?.gate).toBe('editable-allowlist');
  });

  it('achievement 里把 40% 改成 60% → 由数值守恒拦下（4.5-08 的真实射程）', () => {
    const base = makeBaselineDocument();
    const proposed = withField(
      base,
      'experience',
      'e1',
      'achievement',
      '主导订单服务重构，P99 延迟下降 60%，复用率 40%。' + PII_EMAIL,
    );
    const report = verifyGeneration({ original: base, proposed, jdText: JD_TEXT });
    expect(report.ok).toBe(false);
    // 关键在"哪一条判据拦的"：整句锁死也能拦住这条，但那样连合法改写一起拦了（见下一条）。
    expect(report.fieldViolations).toHaveLength(0);
    expect(report.numberFindings).toHaveLength(1);
    expect(report.numberFindings[0]?.fieldKey).toBe('achievement');
    expect(report.numberFindings[0]?.missing).toEqual(['40']);
    expect(report.numberFindings[0]?.added).toEqual(['60']);
  });

  it('改写 achievement 但数与名都守住 → 通过（这才是生成轨每天在做的事）', () => {
    const base = makeBaselineDocument();
    const proposed = withField(
      base,
      'experience',
      'e1',
      'achievement',
      `面向高并发场景主导订单服务重构，P99 延迟下降 40%，配置复用率同为 40%。${PII_EMAIL}`,
    );
    const report = verifyGeneration({ original: base, proposed, jdText: JD_TEXT });
    expect(report.ok).toBe(true);
  });

  it('改写 achievement 时塞进库里没有的公司 → 具名回查拦下（4.5-07 的补刀）', () => {
    const base = makeBaselineDocument();
    const proposed = withField(
      base,
      'experience',
      'e1',
      'achievement',
      '为蓝海云计算公司主导订单服务重构，P99 延迟下降 40%，复用率 40%。' + PII_EMAIL,
    );
    const report = verifyGeneration({ original: base, proposed, jdText: JD_TEXT });
    expect(report.ok).toBe(false);
    expect(report.entityFindings.map((finding) => finding.fieldKey)).toEqual(['achievement']);
  });

  it('结构化事实键仍旧整句锁死：role / period 改一个字即违规', () => {
    const base = makeBaselineDocument();
    const report = verifyGeneration({
      original: base,
      proposed: withField(base, 'experience', 'e1', 'role', '后端开发工程师'),
      jdText: JD_TEXT,
    });
    expect(report.fieldViolations).toHaveLength(1);
    expect(report.fieldViolations[0]?.gate).toBe('fact-lock');
    expect(report.fieldViolations[0]?.factKey).toBe('role');
  });

  it('技能行不许生成腿改，但万一被改了仍按数值守恒检（校验面 ⊇ 提议面）', () => {
    const base: ResumeDocument = {
      ...makeBaselineDocument(),
      sections: [
        ...makeBaselineDocument().sections,
        {
          id: 'skills',
          kind: 'skills',
          title: '技能',
          entries: [{ id: 'k1', fields: [makeField('skills', 'text', 'TypeScript、Go，五年经验')] }],
        },
      ],
    };
    const proposed = withField(base, 'skills', 'k1', 'text', 'TypeScript、Rust，三年经验');
    // 提议面里没有这一条位置（`generationTargetFields` 不含 skills 区块），所以正常流程改不到它；
    // 这里直接喂给校验器，确认它不是"改了没人看"的死角。
    expect(generationTargetFields(base).some((field) => field.sectionId === 'skills')).toBe(false);
    expect(generationEditableFields(base).some((field) => field.sectionId === 'skills')).toBe(true);
    const report = verifyGeneration({ original: base, proposed, jdText: JD_TEXT });
    expect(report.numberFindings[0]?.missing).toEqual(['5']);
    expect(report.numberFindings[0]?.added).toEqual(['3']);
  });

  it('按 JD 相关性重排区块与条目顺序 → 零违规（比对按 id 对齐，重排对它不可见）', () => {
    const base = makeBaselineDocument();
    const reordered: ResumeDocument = {
      ...base,
      sections: [base.sections[1]!, base.sections[2]!, base.sections[0]!].map((section) =>
        section.id === 'experience' ? { ...section, entries: [...section.entries].reverse() } : section,
      ),
    };
    const report = verifyGeneration({ original: base, proposed: reordered, jdText: JD_TEXT });
    expect(report.ok).toBe(true);
  });
});

describe('4.5-08 text 里的量化数字守恒', () => {
  it('把「五年」改写成「5 年」→ 不误报（两种写法折到同一个数值）', () => {
    const base = makeBaselineDocument();
    const proposed = withProse(base, 'summary', 's1', `5 年后端工程师，电话 ${PII_PHONE}。`);
    expect(verifyGeneration({ original: base, proposed, jdText: JD_TEXT }).numberFindings).toHaveLength(0);
  });

  it('把量化数字换成模糊形容词 → 拦（少了 40 这一类读数在 text 里的场景）', () => {
    const base = makeBaselineDocument();
    const proposed = withProse(base, 'summary', 's1', `三年后端工程师，电话 ${PII_PHONE}。`);
    const report = verifyGeneration({ original: base, proposed, jdText: JD_TEXT });
    expect(report.numberFindings).toHaveLength(1);
    expect(report.numberFindings[0]?.missing).toEqual(['5']);
    expect(report.numberFindings[0]?.added).toEqual(['3']);
    expect(report.ok).toBe(false);
  });

  it('text 里凭空多出一个数 → 拦', () => {
    const base = makeBaselineDocument();
    const proposed = withProse(base, 'summary', 's1', `五年后端工程师，带过 12 人团队，电话 ${PII_PHONE}。`);
    const report = verifyGeneration({ original: base, proposed, jdText: JD_TEXT });
    expect(report.numberFindings[0]?.added).toEqual(['12']);
  });
});

describe('4.5-14 校验读数不带原文', () => {
  it('三条哨兵在任何一条读数里都取不到（植入式证明）', () => {
    const base = makeBaselineDocument();
    const tampered = withField(base, 'experience', 'e1', 'company', '星辰科技有限公司');
    const withFakeEntity = withProse(tampered, 'summary', 's1', `曾任职于蓝海云计算公司，五年经验，电话 ${PII_ID}。`);
    const report = verifyGeneration({ original: base, proposed: withFakeEntity, jdText: JD_TEXT });
    const lines = describeViolations(report);
    // 先证明这次校验确实产出了违规，否则下面的"取不到"是空跑：
    // 篡改公司名 → 字段违规；塞进库外的「蓝海云计算公司」→ 具名候选；把手机号换成身份证号 → 数值守恒
    expect(report.fieldViolations.length).toBeGreaterThan(0);
    expect(report.entityFindings.length).toBeGreaterThan(0);
    expect(report.numberFindings.length).toBeGreaterThan(0);
    expect(lines.length).toBe(
      report.fieldViolations.length + report.entityFindings.length + report.numberFindings.length,
    );
    const joined = lines.join('\n');
    expect(joined).not.toContain(PII_PHONE);
    expect(joined).not.toContain(PII_EMAIL);
    expect(joined).not.toContain(PII_ID);
    expect(joined).not.toContain('星桥科技');
    // 数值读数装的就是"少了哪个数"，而手机号本身就是一串数——整行过 redactText 后只剩前三后四
    expect(joined).toContain('138****');
  });

  it('读数给的是路径 + 长度，不是被改的字段值', () => {
    const base = makeBaselineDocument();
    const proposed = withField(base, 'education', 'd1', 'degree', '硕士');
    const lines = describeViolations(verifyGeneration({ original: base, proposed, jdText: JD_TEXT }));
    expect(lines).toEqual(['education/d1.degree → editable-allowlist（2 → 2 字符）']);
    expect(lines.join('')).not.toContain('硕士');
  });
});
