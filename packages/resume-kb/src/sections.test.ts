/**
 * `parseResumeText` 的固定语料单测（spec 4.1-02 / 4.1-04 / 4.1-05 / 4.1-09）。
 *
 * 语料是**自造的虚构简历**（plan §4「固定语料」）：不含任何真实个人信息，联系方式用的是明显编造的号段，
 * 这样脱敏断言才能既验证「掩码生效」又不会因为测试数据泄露而成为风险面。
 */
import { describe, expect, it } from 'vitest';
import { MIN_TEXT_CHAR_COUNT, parseResumeText, type ParsedResumeText, type ParseIssue } from './sections.js';

const NOW_MS = 1_700_000_000_000;

/** 一份带 Markdown 装饰的虚构简历：抬头 + 五类区块 + 两种经历条目写法。 */
const FIXTURE = [
  '张三',
  '电话：13800001111',
  '邮箱：zhangsan@example.com',
  '',
  '## 个人简介',
  '五年后端工程师，专注高并发服务与可观测性。',
  '期望薪资 15000-25000。',
  '',
  '## 工作经历',
  '星桥科技｜后端工程师 2021.03-2024.06',
  '- 主导订单服务重构，P99 延迟下降 40%。',
  '- 搭建内核自动化打印管线。',
  '',
  '未名开源社区｜维护者 2019 - 2022',
  '负责 PDF 工具链的发布与答疑。',
  '',
  '## 项目经历',
  '墨桥实验室｜PDF合成引擎 2022.01 至 2022.09',
  '自研字体子集化模块，体积下降 60%。',
  '',
  '## 教育经历',
  '东海大学 计算机科学与技术 学士 2015.09-2019.06',
  '',
  '## 技能',
  '- TypeScript',
  '- Node.js / Electron',
].join('\n');

/** 取文档里指定区块的指定条目字段值，缺失即失败（断言写成中文可读的键路径）。 */
function fieldOf(parsed: ParsedResumeText, kind: string, entryIndex: number, key: string): string | undefined {
  const section = parsed.document.sections.find((item) => item.kind === kind);
  return section?.entries[entryIndex]?.fields.find((field) => field.key === key)?.value;
}

describe('4.1-02 文本简历解析为文档模型', () => {
  const parsed = parseResumeText(FIXTURE, 'resume-import', NOW_MS);

  it('五类区块按出现顺序落进文档，区块 id 按 kind 唯一', () => {
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    expect(parsed.document.sections.map((section) => section.id)).toEqual([
      'summary',
      'experience',
      'project',
      'education',
      'skills',
    ]);
    expect(parsed.document.sections.map((section) => section.kind)).toEqual([
      'summary',
      'experience',
      'project',
      'education',
      'skills',
    ]);
  });

  it('经历条目的公司 / 职位 / 时间 / 成果四要素齐全，时间已归一', () => {
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    expect(fieldOf(parsed, 'experience', 0, 'company')).toBe('星桥科技');
    expect(fieldOf(parsed, 'experience', 0, 'role')).toBe('后端工程师');
    expect(fieldOf(parsed, 'experience', 0, 'period')).toBe('2021-03 - 2024-06');
    expect(fieldOf(parsed, 'experience', 1, 'company')).toBe('未名开源社区');
    expect(fieldOf(parsed, 'experience', 1, 'period')).toBe('2019 - 2022');
    expect(fieldOf(parsed, 'experience', 0, 'achievement')).toBe(
      '主导订单服务重构，P99 延迟下降 40%。\n搭建内核自动化打印管线。',
    );
  });

  it('公司 / 职位 / 时间 / 成果都被打上事实锁定标记，教育与技能不强绑', () => {
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    const experience = parsed.document.sections.find((section) => section.kind === 'experience')!;
    const locked = new Map(
      experience.entries[0]!.fields.map((field) => [field.key, [field.locked, field.factKey] as const]),
    );
    expect(locked.get('company')).toEqual([true, 'company']);
    expect(locked.get('role')).toEqual([true, 'role']);
    expect(locked.get('period')).toEqual([true, 'period']);
    expect(locked.get('achievement')).toEqual([true, 'achievement']);

    const skills = parsed.document.sections.find((section) => section.kind === 'skills')!;
    expect(skills.entries[0]?.fields[0]).toMatchObject({ key: 'text', locked: false });
    expect(skills.entries[0]?.fields[0]?.value).toBe('TypeScript\nNode.js / Electron');
  });

  it('项目经历与教育经历各自走本区块的字段键', () => {
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    expect(fieldOf(parsed, 'project', 0, 'company')).toBe('墨桥实验室');
    expect(fieldOf(parsed, 'project', 0, 'period')).toBe('2022-01 - 2022-09');
    expect(fieldOf(parsed, 'education', 0, 'school')).toBe('东海大学');
    expect(fieldOf(parsed, 'education', 0, 'degree')).toBe('学士');
    expect(fieldOf(parsed, 'education', 0, 'major')).toBe('计算机科学与技术');
    expect(fieldOf(parsed, 'education', 0, 'period')).toBe('2015-09 - 2019-06');
  });
});

describe('4.1-09 敏感原文默认脱敏', () => {
  it('联系方式与正文里的个人信息都只以掩码形态存在', () => {
    const parsed = parseResumeText(FIXTURE, 'resume-import', NOW_MS);
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    expect(parsed.document.profile.name).toBe('张三');
    expect(parsed.document.profile.contact.phone).toBe('138****1111');
    expect(parsed.document.profile.contact.email).toBe('z***@example.com');

    const serialized = JSON.stringify(parsed.document);
    expect(serialized).not.toContain('13800001111');
    expect(serialized).not.toContain('zhangsan@example.com');
    expect(parsed.issues.filter((issue) => issue.code === 'sensitive-redacted').map((issue) => issue.fieldKey)).toEqual(
      ['email', 'phone'],
    );
  });

  it('脱敏不吃掉薪资区间与量化成果里的数字（值形态判据带环视）', () => {
    const parsed = parseResumeText(FIXTURE, 'resume-import', NOW_MS);
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    expect(fieldOf(parsed, 'summary', 0, 'text')).toContain('15000-25000');
    expect(fieldOf(parsed, 'experience', 0, 'achievement')).toContain('40%');
  });

  it('身份证形态在正文里同样被掩码，并留下一条待确认', () => {
    const withId = `${FIXTURE}\n\n## 技能\n证书登记号 11010119900307001X 备查，另有打印管线优化的完整复盘文档若干。`;
    const parsed = parseResumeText(withId, 'resume-import', NOW_MS);
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    expect(JSON.stringify(parsed.document)).not.toContain('11010119900307001X');
    expect(parsed.issues.some((issue) => issue.code === 'sensitive-redacted' && issue.fieldKey === 'id-card')).toBe(
      true,
    );
  });
});

describe('4.1-04 不确定项标待确认而非猜测', () => {
  const issuesOf = (text: string): readonly ParseIssue[] => {
    const result = parseResumeText(text, 'resume-import', NOW_MS);
    return result.status === 'ok' ? result.issues : [];
  };

  it('经历行没有时间 → 记 missing-field，且不会凭空造一个 period 字段', () => {
    const issues = issuesOf(
      `${'张三 '.repeat(4)}\n\n## 工作经历\n星桥科技｜后端工程师\n主导订单服务重构，P99 延迟下降 40%，并负责新人带的完整闭环。`.repeat(
        2,
      ),
    );
    expect(issues.some((issue) => issue.code === 'missing-field' && issue.fieldKey === 'period')).toBe(true);
  });

  it('时间写法认不出 → 记 unparsable-field，保留原文行供人工看', () => {
    const issues = issuesOf(
      `${'张三 '.repeat(4)}\n\n## 工作经历\n星桥科技｜后端工程师 工作期间\n主导订单服务重构，P99 延迟下降 40%，并负责新人带的完整闭环。`.repeat(
        2,
      ),
    );
    expect(issues.some((issue) => issue.fieldKey === 'period' && issue.code === 'missing-field')).toBe(true);
  });

  it('一段正文里出现三段时间 → 只取前两段的跨度，多出来的数字标 stray-digits 待确认', () => {
    const issues = issuesOf(
      `${'张三 '.repeat(4)}\n\n## 工作经历\n星桥科技｜后端工程师 2018.07 — 2020 至 2021.06\n主导订单服务重构，P99 延迟下降 40%，并负责新人带的完整闭环。`.repeat(
        2,
      ),
    );
    expect(issues.some((issue) => issue.code === 'unparsable-field' && issue.fieldKey === 'period')).toBe(true);
  });

  it('整份简历没有任何已知标题 → 标 unknown-section，不硬塞进 summary', () => {
    const issues = issuesOf(
      '张三\n这是一份没有标题的简历正文，通篇都在叙述做过的事情，长度足够通过扫描件判定，但一个区块标题都没有出现，所以只能整体标待确认。'.repeat(
        2,
      ),
    );
    expect(issues.some((issue) => issue.code === 'unknown-section')).toBe(true);
    expect(issues.some((issue) => issue.code === 'missing-field' && issue.fieldKey === 'name')).toBe(false);
  });

  it('抬头首行是手机号时不猜姓名，改为标 missing-field name', () => {
    const issues = issuesOf(
      `13800001111 邮箱 li@example.com\n${'这是一段足够长的抬头正文，用来说明这份简历里没有独立姓名行。'.repeat(3)}`,
    );
    expect(issues.some((issue) => issue.code === 'missing-field' && issue.fieldKey === 'name')).toBe(true);
  });
});

describe('4.1-05 疑似扫描件走明确失败路径', () => {
  it('抽文本过短时返回 too-short，只带判定读数、不带半份文档', () => {
    const result = parseResumeText('  扫描件封面 张三 2021.03  ', 'resume-import', NOW_MS);
    expect(result.status).toBe('too-short');
    if (result.status !== 'too-short') return expect(result.status).toBe('too-short');
    expect(result.textLength).toBeLessThan(MIN_TEXT_CHAR_COUNT);
    expect(result.issues[0]).toMatchObject({ code: 'text-too-short' });
    expect('document' in result).toBe(false);
  });

  it('刚好达到下限的文本才进入解析分支', () => {
    const short = parseResumeText('经'.repeat(MIN_TEXT_CHAR_COUNT - 1), 'resume-import', NOW_MS);
    const justEnough = parseResumeText('经'.repeat(MIN_TEXT_CHAR_COUNT), 'resume-import', NOW_MS);
    expect(short.status).toBe('too-short');
    expect(justEnough.status).toBe('ok');
  });
});
