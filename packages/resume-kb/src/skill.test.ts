/**
 * 内置书写技能的纯数据面用例（spec 4.9-09 / 4.9-08）。
 *
 * 这一片的核心约束是**一张表派生两份呈现**：技能正文里"必备信息"那一节与界面/生成用的逐项校验
 * 必须同源。所以这里判的不是"文案好不好看"，而是"两者会不会分叉"——分叉的形态是
 * 表里多一条而正文里没有（人看不到依据），或正文里有而表里不判（指引说谎）。
 */
import { createEmptyDocument, makeField, type ResumeDocument, type Section } from '@auto-cc/plugin-resume-doc';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_RESUME_SKILL_BODY,
  FACT_FLOOR_RULES,
  REQUIRED_INFO,
  RESUME_SKILL_ID,
  RESUME_SKILL_VERSION,
  WRITING_RULES,
  checkRequiredInfo,
  factsOfDocument,
  renderBuiltinSkillBody,
} from './skill.js';

const NOW_MS = 1_700_000_000_000;

/** 拼一份只带指定区块的文档（必备信息判定只看区块与抬头，不需要完整简历）。 */
function makeDoc(sections: Section[], profile?: ResumeDocument['profile']): ResumeDocument {
  return { ...createEmptyDocument('resume-skill', NOW_MS), ...(profile ? { profile } : {}), sections };
}

/** 一条经历条目：公司 / 职位 / 时间 / 成果四件套。 */
function experienceEntry(
  index: number,
  overrides: { period?: string; achievement?: string } = {},
): Section['entries'][number] {
  return {
    id: `experience-${String(index)}`,
    fields: [
      makeField('experience', 'company', '星桥科技'),
      makeField('experience', 'role', '前端工程师'),
      makeField('experience', 'period', overrides.period ?? '2021-03 - 2024-06'),
      makeField('experience', 'achievement', overrides.achievement ?? '将详情页首屏耗时从 2.4s 降到 0.6s。'),
    ],
  };
}

/** 一份"每一项都齐"的文档，用作 present 的基准（缺项用例在它上面逐项拆）。 */
function completeDoc(): ResumeDocument {
  return makeDoc(
    [
      {
        id: 'summary',
        kind: 'summary',
        title: '个人简介',
        entries: [
          {
            id: 'summary-1',
            fields: [makeField('summary', 'text', '求职意向：高级前端工程师，五年可视化与打印管线经验。')],
          },
        ],
      },
      {
        id: 'experience',
        kind: 'experience',
        title: '工作经历',
        entries: [experienceEntry(1)],
      },
      {
        id: 'education',
        kind: 'education',
        title: '教育经历',
        entries: [
          {
            id: 'education-1',
            fields: [
              makeField('education', 'school', '东海大学'),
              makeField('education', 'major', '计算机科学与技术'),
              makeField('education', 'degree', '学士'),
            ],
          },
        ],
      },
      {
        id: 'skills',
        kind: 'skills',
        title: '专业技能',
        entries: [
          { id: 'skills-1', fields: [makeField('skills', 'text', 'TypeScript / React / Electron / Vite 构建')] },
        ],
      },
      {
        id: 'project',
        kind: 'project',
        title: '项目经历',
        entries: [experienceEntry(1)],
      },
    ],
    { name: '张三', contact: { email: 'zhangsan@example.com', phone: '13800001111', location: '上海市' } },
  );
}

/** 取某一条必备信息的判定。 */
function statusOf(doc: ResumeDocument, id: string): string {
  const row = checkRequiredInfo(doc).find((item) => item.id === id);
  if (row === undefined) throw new Error(`清单里没有 ${id} 这一项`);
  return row.status;
}

describe('4.9-09 一张表派生两份呈现', () => {
  it('清单有 12 项、id 与 i18n 键都不重复，且每一项都有可判的正文句', () => {
    expect(REQUIRED_INFO).toHaveLength(12);
    expect(new Set(REQUIRED_INFO.map((item) => item.id)).size).toBe(12);
    expect(new Set(REQUIRED_INFO.map((item) => item.labelKey)).size).toBe(12);
    for (const item of REQUIRED_INFO) {
      expect(item.labelZh.length).toBeGreaterThan(0);
      expect(item.guideZh.length).toBeGreaterThan(0);
      expect(['core', 'recommended']).toContain(item.severity);
    }
  });

  it('正文里逐条含每一条必备信息的标签与那句要求（表与正文不许分叉）', () => {
    for (const item of REQUIRED_INFO) {
      expect(BUILTIN_RESUME_SKILL_BODY).toContain(item.labelZh);
      expect(BUILTIN_RESUME_SKILL_BODY).toContain(item.guideZh);
    }
    for (const rule of WRITING_RULES) expect(BUILTIN_RESUME_SKILL_BODY).toContain(rule);
    for (const rule of FACT_FLOOR_RULES) expect(BUILTIN_RESUME_SKILL_BODY).toContain(rule);
  });

  it('正文里的必备信息按档位标注，且底线那一节排在最后（注入时它才是不可推翻的那一段）', () => {
    for (const item of REQUIRED_INFO) {
      const mark = item.severity === 'core' ? '（必备）' : '（建议）';
      expect(BUILTIN_RESUME_SKILL_BODY).toContain(`${item.labelZh}${mark}`);
    }
    expect(BUILTIN_RESUME_SKILL_BODY.indexOf('## 三、底线')).toBeGreaterThan(
      BUILTIN_RESUME_SKILL_BODY.indexOf('## 一、必备信息'),
    );
  });

  it('渲染是纯函数：同输入两次逐字节相同，版本号只出现在抬头一处', () => {
    expect(renderBuiltinSkillBody()).toBe(BUILTIN_RESUME_SKILL_BODY);
    expect(BUILTIN_RESUME_SKILL_BODY.split(RESUME_SKILL_VERSION)).toHaveLength(2);
    expect(RESUME_SKILL_ID).toBe('resume-writing');
  });
});

describe('4.9-07 / 4.9-08 逐项判定：齐就是齐，缺就分档', () => {
  it('齐备的文档里四项联系方式与四段内容全部 present', () => {
    const rows = checkRequiredInfo(completeDoc());
    for (const id of [
      'name',
      'phone',
      'email',
      'location',
      'objective',
      'experience',
      'period',
      'education',
      'skills',
      'project',
      'quantified',
      'length',
    ]) {
      expect(statusOf(completeDoc(), id)).toBe('present');
    }
    expect(rows).toHaveLength(REQUIRED_INFO.length);
  });

  it('空文档：core 项一律 missing，recommended 项不为 present（缺建议项不许判死）', () => {
    const rows = checkRequiredInfo(makeDoc([]));
    for (const row of rows) {
      if (row.severity === 'core') expect(row.status).toBe('missing');
      else expect(row.status).not.toBe('present');
    }
  });

  it('缺城市只是 weak，缺手机号是 missing（两个来源在地址上分歧，故不同档）', () => {
    const doc = completeDoc();
    const noCity = makeDoc(doc.sections, { ...doc.profile, contact: { ...doc.profile.contact, location: null } });
    expect(statusOf(noCity, 'location')).toBe('weak');
    const noPhone = makeDoc(doc.sections, { ...doc.profile, contact: { ...doc.profile.contact, phone: null } });
    expect(statusOf(noPhone, 'phone')).toBe('missing');
  });

  it('经历在但整段没有数字 → quantified 判 weak；一条都没写才算 missing', () => {
    const doc = completeDoc();
    const noNumber = makeDoc(
      doc.sections.map((section) =>
        section.kind === 'experience'
          ? {
              ...section,
              entries: [experienceEntry(1, { achievement: '负责订单模块的日常迭代与答疑。' })],
            }
          : section.kind === 'project'
            ? { ...section, entries: [] }
            : section,
      ),
      doc.profile,
    );
    expect(statusOf(noNumber, 'quantified')).toBe('weak');
    expect(statusOf(makeDoc([]), 'quantified')).toBe('missing');
  });

  it('经历缺时间 → period 判 weak 而不是 missing（段在、信息不全，两种说法必须分开）', () => {
    const doc = completeDoc();
    const noPeriod = makeDoc(
      doc.sections.map((section) =>
        section.kind === 'experience' ? { ...section, entries: [experienceEntry(1, { period: ' ' })] } : section,
      ),
      doc.profile,
    );
    expect(statusOf(noPeriod, 'period')).toBe('weak');
    // `experience` 那一档不因"某一段没时间"而降级：它判的是条目在不在、身份齐不齐，
    // 时间缺项由 `period` 这一行单独说——两行各判一件事，界面才不会同一件事报两遍。
    expect(statusOf(noPeriod, 'experience')).toBe('present');
  });

  it('投影层不含任何正文（判定吃的只是数，界面与日志因此不需要再脱敏一层）', () => {
    const serialized = JSON.stringify(factsOfDocument(completeDoc()));
    expect(serialized).not.toContain('星桥科技');
    expect(serialized).not.toContain('zhangsan@example.com');
    expect(serialized).not.toContain('13800001111');
  });
});
