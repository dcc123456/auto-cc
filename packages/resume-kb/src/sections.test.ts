/**
 * `parseResumeText` 的固定语料单测（spec 4.1-02 / 4.1-04 / 4.1-05 / 4.1-09）。
 *
 * 语料是**自造的虚构简历**（plan §4「固定语料」）：不含任何真实个人信息，联系方式用的是明显编造的号段，
 * 这样脱敏断言才能既验证「掩码生效」又不会因为测试数据泄露而成为风险面。
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_TEXT_CHAR_COUNT,
  parseResumeText,
  splitEntryBlocks,
  type ParsedResumeText,
  type ParseIssue,
} from './sections.js';

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
      // 4.1-18（裁定㉘ 第 2 条）：语料里那两行的项目符号不再被删掉，而是换成封闭文法里的 `- `，
      // 打印面据此渲染成列表（`resume-doc` 的 3.9）。抬头行与技能行不走这一条，见 `splitEntryBlocks` 的三种走法。
      '- 主导订单服务重构，P99 延迟下降 40%。\n- 搭建内核自动化打印管线。',
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
    // 裁定㉗「一行一条技能，各自一个条目」（spec 4.1-16）：`- ` 列表的两条从此是两个条目，不再粘成一条。
    expect(skills.entries).toHaveLength(2);
    expect(skills.entries[0]?.fields[0]).toMatchObject({ key: 'text', locked: false });
    expect(skills.entries.map((entry) => entry.fields[0]?.value)).toEqual(['TypeScript', 'Node.js / Electron']);
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

describe('4.1-09 敏感原文默认脱敏（范围按 2026-10-12 裁定收窄到四处）', () => {
  it('正文与待确认清单里只以掩码存在，而工作副本的联系方式是原文', () => {
    const parsed = parseResumeText(FIXTURE, 'resume-import', NOW_MS);
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    expect(parsed.document.profile.name).toBe('张三');
    // 裁定（2026-10-12）：拿去投递的简历必须有真号码，所以 `profile.contact` 存原文；
    // 掩码仍然覆盖正文区块、待确认清单、实体表与出网载荷这四处（4.9-12 逐处断言）。
    expect(parsed.document.profile.contact.phone).toBe('13800001111');
    expect(parsed.document.profile.contact.email).toBe('zhangsan@example.com');

    const body = JSON.stringify(parsed.document.sections);
    expect(body).not.toContain('13800001111');
    expect(body).not.toContain('zhangsan@example.com');
    expect(parsed.issues.filter((issue) => issue.code === 'sensitive-redacted').map((issue) => issue.fieldKey)).toEqual(
      ['email', 'phone'],
    );
  });

  it('联系方式缺项时写 null，不造一个占位值（4.9-08）', () => {
    const noContact = FIXTURE.replace('电话：13800001111\n', '').replace('邮箱：zhangsan@example.com\n', '');
    const parsed = parseResumeText(noContact, 'resume-import', NOW_MS);
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    expect(parsed.document.profile.contact.phone).toBeNull();
    expect(parsed.document.profile.contact.email).toBeNull();
  });
});

describe('4.9-b 抬头抽取：姓名与城市必须从同一行的联系方式里摘出来', () => {
  /** 真实 PDF 的抬头形状（用户手里那份就是这一族）：姓名｜电话｜邮箱｜城市挤在一条物理行里。 */
  const ONE_LINE_HEADER = [
    '李测试｜13800002222｜litest@example.com｜上海市',
    '',
    '## 个人简介',
    '五年前端工程师，专注可视化与打印管线。',
    '期望薪资 15000-25000。',
    '',
    '## 工作经历',
    '星桥科技｜前端工程师 2021.03-2024.06',
    '- 主导订单服务重构，P99 延迟下降 40%。',
    '- 搭建内核自动化打印管线。',
    '',
    '## 教育经历',
    '东海大学 计算机科学与技术 学士 2015.09-2019.06',
  ].join('\n');

  it('抬头一行写完时，姓名不再被手机号的数字连累，城市落进 contact.location', () => {
    const parsed = parseResumeText(ONE_LINE_HEADER, 'resume-header', NOW_MS);
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    expect(parsed.document.profile.name).toBe('李测试');
    expect(parsed.document.profile.contact.location).toBe('上海市');
    expect(parsed.document.profile.contact.phone).toBe('13800002222');
  });

  it('城市不带「市」后缀时也认（白名单内的高频写法），认不出就是 null', () => {
    const bare = ONE_LINE_HEADER.replace('上海市', '深圳');
    const parsed = parseResumeText(bare, 'resume-header', NOW_MS);
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    expect(parsed.document.profile.contact.location).toBe('深圳');
    expect(parsed.document.profile.name).toBe('李测试');

    const none = parseResumeText(ONE_LINE_HEADER.replace('｜上海市', ''), 'resume-header', NOW_MS);
    if (none.status !== 'ok') return expect(none.status).toBe('ok');
    expect(none.document.profile.contact.location).toBeNull();
  });

  it('姓名与城市同一行时，摘掉城市之后剩下的才是姓名（城市不许当人名）', () => {
    const noContact = ONE_LINE_HEADER.replace('｜13800002222｜litest@example.com', '');
    const parsed = parseResumeText(noContact, 'resume-header', NOW_MS);
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    expect(parsed.document.profile.name).toBe('李测试');
    expect(parsed.document.profile.contact.location).toBe('上海市');
  });
});

describe('4.1-09 其余掩码判据（收窄范围后仍然生效）', () => {
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

describe('4.1-02 中文简历惯用的汉字序号标题（真实 PDF 抽出来的那一族形状）', () => {
  // 装机版实测的失效现场：一份真实导出的 PDF 抽成文本后标题长这样（`一、`、`（二）`），
  // 老规则只剥 Markdown 与阿拉伯数字，于是整份简历解析出**零个区块**、实体类也就无从生成。
  const NUMBERED = [
    '李四',
    '电话：13700002222',
    '',
    '一、基本信息',
    '姓名：李四 学历：本科',
    '',
    '二、求职意向：高级前端工程师',
    '八年前端经验，期望上海。',
    '',
    '四、职业技能',
    '1. 熟练掌握：JavaScript、TypeScript。',
    '',
    '五、工作经历',
    '（一）云栖网络科技有限公司 - 前端开发 2020.07 - 2023.12',
    '- 重构结算前端，首屏耗时下降 35%。',
  ].join('\n');
  const parsed = parseResumeText(NUMBERED, 'resume-numbered', NOW_MS);

  it('汉字序号前缀被摘掉后按词典归类；词典外的「基本信息」按 custom 保真、内容不丢', () => {
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    // 「一、基本信息」不在六类词典里：新口径下它是独立 custom 要素（原文标题保留），
    // 其下「姓名：李四 学历：本科」整行进正文，而不是像旧口径那样在抬头区被静默丢弃。
    expect(parsed.document.sections.map((section) => section.kind)).toEqual([
      'custom',
      'summary',
      'skills',
      'experience',
    ]);
    const basic = parsed.document.sections[0]!;
    expect(basic.title).toBe('基本信息');
    expect(basic.entries[0]!.fields[0]!.value).toContain('姓名：李四 学历：本科');
  });

  it('序号条目行（`（一）公司 - 职位 时间`）认得出公司与时间段', () => {
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    const company = fieldOf(parsed, 'experience', 0, 'company');
    expect(company).toContain('云栖网络');
    expect(fieldOf(parsed, 'experience', 0, 'period')).toBeTruthy();
  });
});

/**
 * custom 通用自定义要素：六类词典之外的标题一律收住，信息不丢、不吞邻区。
 */
describe('custom 陌生要素保真（证书 / 荣誉 / 语言等词典外标题）', () => {
  const CUSTOM_FIXTURE = [
    '张三',
    '电话：13800001111',
    'github.com/zhangsan 期望城市：上海',
    '',
    '## 个人简介',
    '五年后端工程师，专注高并发服务。',
    '',
    '## 证书',
    'CET-6（586）',
    '',
    'PMP 项目管理认证',
    '',
    '## 工作经历',
    '星桥科技｜后端工程师 2021.03-2024.06',
    '- 主导订单服务重构。',
    '',
    '## 荣誉奖项',
    '2023 年集团优秀员工',
    '',
    '## 语言能力',
    '英语：可作为工作语言',
  ].join('\n');
  const parsed = parseResumeText(CUSTOM_FIXTURE, 'resume-custom', NOW_MS);

  it('三个陌生标题各成一块 custom，原文标题保留，且不吞相邻的固定区块', () => {
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    const kinds = parsed.document.sections.map((section) => section.kind);
    expect(kinds).toEqual(['custom', 'summary', 'custom', 'experience', 'custom', 'custom']);
    const titles = parsed.document.sections.filter((section) => section.kind === 'custom').map((s) => s.title);
    expect(titles).toEqual(['其他信息', '证书', '荣誉奖项', '语言能力']);
  });

  it('custom 区块可多块并存：id 按文档序为 custom-1..4，条目 id 挂区块 id 前缀不撞号', () => {
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    const customs = parsed.document.sections.filter((section) => section.kind === 'custom');
    expect(customs.map((section) => section.id)).toEqual(['custom-1', 'custom-2', 'custom-3', 'custom-4']);
    expect(customs[1]!.entries.map((entry) => entry.id)).toEqual(['custom-2-1', 'custom-2-2']);
  });

  it('陌生区块的正文逐行进 text 字段，不被上一区块吞掉', () => {
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    const cert = parsed.document.sections.find((section) => section.title === '证书')!;
    expect(cert.entries.map((entry) => entry.fields[0]!.value)).toEqual(['CET-6（586）', 'PMP 项目管理认证']);
    const language = parsed.document.sections.find((section) => section.title === '语言能力')!;
    expect(language.entries[0]!.fields[0]!.value).toBe('英语：可作为工作语言');
  });

  it('抬头区残留（github / 期望城市）进 custom-1「其他信息」，姓名与电话不重复进正文', () => {
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    const other = parsed.document.sections[0]!;
    expect(other.kind).toBe('custom');
    const joined = other.entries.map((entry) => entry.fields[0]!.value).join('\n');
    // 抬头分词把 `/` 当分隔符（既有口径），github 路径会被空格分开——逐段断言即可。
    expect(joined).toContain('github.com');
    expect(joined).toContain('zhangsan');
    expect(joined).toContain('上海');
    expect(joined).not.toContain('13800001111');
    expect(joined).not.toContain('张三');
  });

  it('重复解析的 custom 区块 / 条目 id 完全一致（位置号稳定，供 diff 对齐）', () => {
    const again = parseResumeText(CUSTOM_FIXTURE, 'resume-custom-2', NOW_MS);
    if (parsed.status !== 'ok' || again.status !== 'ok') return expect(again.status).toBe('ok');
    const idsOf = (r: typeof again) =>
      r.document.sections.flatMap((section) => [section.id, ...section.entries.map((entry) => entry.id)]);
    expect(idsOf(again)).toEqual(idsOf(parsed));
  });

  it('护栏：带时间段的经历抬头行不被误切成 custom 标题', () => {
    const text = [
      '张三',
      '电话：13800001111',
      '',
      '## 工作经历',
      '星桥科技｜后端工程师 2021.03-2024.06',
      '主导订单服务重构，P99 延迟下降 40%，并负责新人培养与线上值守的完整闭环，相关指标连续四个季度达标。',
      '海图信息｜高级工程师 2018.03-2020.06',
      '搭建发布流水线与回滚预案，把平均发布耗时从四十分钟压到八分钟，事故恢复时间缩短一个数量级。',
    ].join('\n');
    const r = parseResumeText(text, 'resume-period-guard', NOW_MS);
    if (r.status !== 'ok') return expect(r.status).toBe('ok');
    expect(r.document.sections.map((section) => section.kind)).toEqual(['experience']);
  });

  it('护栏：句末标点收尾的句子、键值行、列表项不被认成 custom 标题', () => {
    const text = [
      '张三',
      '电话：13800001111',
      '',
      '## 个人简介',
      '五年后端工程师，做过交易、支付与风控三条核心链路，习惯用数据而不是感觉来判断优化是否成立。',
      '',
      '## 证书',
      '证书编号：CERT-2023-0001，请按需核验。',
      '- PMP 项目管理认证。',
      '这是一句完整的叙述句，以句号收尾，长度也在标题字数上限以内，但它不该成为标题，只能留在证书正文里。',
    ].join('\n');
    const r = parseResumeText(text, 'resume-custom-guard', NOW_MS);
    if (r.status !== 'ok') return expect(r.status).toBe('ok');
    expect(r.document.sections.map((section) => section.kind)).toEqual(['summary', 'custom']);
    const section = r.document.sections[1]!;
    expect(section.title).toBe('证书');
    // 三行全部留在唯一的证书区块里（切成几条由条目边界规则决定，但没有任何一块变成新区块）。
    expect(section.entries.map((entry) => entry.fields[0]!.value).join('\n')).toContain('证书编号：CERT-2023-0001');
    expect(section.entries.map((entry) => entry.fields[0]!.value).join('\n')).toContain('这是一句完整的叙述句');
  });
});

/**
 * 4.1-15 的条目边界判据（spec 与 plan §4.8 的四信号 + 四护栏逐条对得上）。
 * 语料形状取自真实简历 PDF 的文本层：**整篇零空行**，条目标题一律带汉字序号，
 * 条目内部的分点用阿拉伯数字与项目符号——那两者绝不能升成条目。
 */
describe('4.1-15 区块内的条目边界不再只认空行', () => {
  it('S1 汉字序号成条；条目内部的数字序号与项目符号仍进正文', () => {
    const blocks = splitEntryBlocks('experience', [
      '（一）云栖网络科技有限公司 - 前端开发 2020.07 - 2023.12',
      '1. 工作职责',
      '- 重构结算前端，首屏耗时下降 35%。',
      '（二）海图信息技术有限公司 - 高级前端 2018.03 - 2020.06',
      '2. 主要业绩',
      '- 封装 3 个公共组件，替换 20 处重复实现。',
    ]);
    expect(blocks.map((block) => block[0])).toEqual([
      '云栖网络科技有限公司 - 前端开发 2020.07 - 2023.12',
      '海图信息技术有限公司 - 高级前端 2018.03 - 2020.06',
    ]);
    expect(blocks[0]).toHaveLength(3);
  });

  it('护栏：序号标题不设长度上限——56 字的那一条仍然是新条目', () => {
    const long = '（八）MarkDown 移动端编辑器 App 与配套的桌面同步组件库 - 独立开发与架构者 2020.01 - 2020.06';
    const blocks = splitEntryBlocks('project', ['（一）车队箱货跟踪项目 - 项目负责人 2021.02 - 2021.08', long]);
    expect(blocks).toHaveLength(2);
    expect([...long.replace(/^（八）/u, '')].length).toBeGreaterThan(50);
  });

  it('S2 整行加粗成条，被加粗的一整段正文（>50 字）不成条', () => {
    const boldHeader = '**星桥科技 后端工程师 2021.03 - 2024.06**';
    const boldParagraph =
      '**这一段是加粗的正文说明，用来验证超长行不会被弱信号误升成条目标题，它写得足够长以超过五十个字符的阈值上限。**';
    const blocks = splitEntryBlocks('experience', ['星桥科技 后端工程师', boldHeader, boldParagraph]);
    expect(blocks.map((block) => block.length)).toEqual([1, 2]);
    // 正文行里**成对**的 `**` 从这里开始是留给渲染层的（spec 4.1-18 那半句 + 裁定㉘ 第 1 条的「成对才算格式」）：
    // 纸面上这一段真的加粗，而落单的那对仍被删掉——两种结局见 `richtext.test.ts` 的同名用例。
    expect(blocks[1]?.[1]).toBe(boldParagraph);
  });

  it('S3 Markdown 三级标题成条；区块词那一级的 `##` 仍归区块', () => {
    const blocks = splitEntryBlocks('project', [
      '### 检索增强生成平台',
      '1. 项目背景：企业知识库。',
      '### 车队数据大屏',
    ]);
    expect(blocks.map((block) => block[0])).toEqual(['检索增强生成平台', '车队数据大屏']);
  });

  it('S4 短行带成端点的时间段成条；正文里单个年份不成条', () => {
    const blocks = splitEntryBlocks('experience', [
      '未名开源社区 维护者 2019 - 2022',
      '负责 PDF 工具链的发布与答疑，全年支撑 2020 次线上发布并跟进缺陷直至收敛。',
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toHaveLength(2);
  });

  it('护栏：块内首行永不做边界判定；空行仍然是边界', () => {
    const blocks = splitEntryBlocks('experience', [
      '星桥科技 后端工程师',
      '主导订单服务重构。',
      '',
      '海图信息 前端开发',
    ]);
    expect(blocks.map((block) => block[0])).toEqual(['星桥科技 后端工程师', '海图信息 前端开发']);
  });

  it('summary 不在四信号射程内（散文切多条没有裁定依据，4.1-16 明写不动）', () => {
    const blocks = splitEntryBlocks('summary', [
      '五年后端工程师，专注高并发服务与可观测性。',
      '期望薪资 15000-25000，到岗时间 2026.01 - 2026.03。',
    ]);
    expect(blocks).toHaveLength(1);
  });
});

/** 4.1-16：裁定㉗「一行一条技能」读作**一条逻辑行**——折行碎片并回上一行，绝不长成独立技能。 */
describe('4.1-16 技能区块按逻辑行成条', () => {
  it('一句话被排版切成三个物理行，只出一条技能且中文相接不补空格', () => {
    const blocks = splitEntryBlocks('skills', [
      '熟练掌握 JavaScript 与 TypeScript，具备解决高难度',
      '技术问题的能力；CSS、HTML，能够精准实现页面',
      '的兼容性。',
    ]);
    expect(blocks).toEqual([
      ['熟练掌握 JavaScript 与 TypeScript，具备解决高难度技术问题的能力；CSS、HTML，能够精准实现页面的兼容性。'],
    ]);
  });

  it('分组小标题自己成一条，且紧跟其后的那行另起一条', () => {
    const blocks = splitEntryBlocks('skills', [
      '（一）编程语言',
      '熟练掌握 JavaScript 与 TypeScript，具备解决高难度技术问题的能力。',
      '（二）前端框架',
      '深入掌握 Vue.js，熟悉从项目搭建到上线的全流程。',
    ]);
    expect(blocks.map((block) => block[0])).toEqual([
      '编程语言',
      '熟练掌握 JavaScript 与 TypeScript，具备解决高难度技术问题的能力。',
      '前端框架',
      '深入掌握 Vue.js，熟悉从项目搭建到上线的全流程。',
    ]);
    expect(blocks.map((block) => block.length)).toEqual([1, 1, 1, 1]);
  });

  it('编号技能各成一条：上一行没说完但这一行带 `2.`，以序号信号为准', () => {
    const blocks = splitEntryBlocks('skills', [
      '1. 熟练使用大模型编辑器与插件，可',
      '以自己编写一些日常使用的 skill',
      '2. 版本控制与协作，通过优化流程减少线上问题。',
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.[0]).toBe('熟练使用大模型编辑器与插件，可以自己编写一些日常使用的 skill');
  });

  it('上一行以句末标点收尾时，下一行另起一条', () => {
    const blocks = splitEntryBlocks('skills', ['熟悉渲染性能优化。', '熟悉埋点与错误监控。']);
    expect(blocks).toEqual([['熟悉渲染性能优化。'], ['熟悉埋点与错误监控。']]);
  });

  it('被切开的英文单词相接时补一个空格', () => {
    const blocks = splitEntryBlocks('skills', ['Proficient in React', 'and Vue ecosystem tooling.']);
    expect(blocks).toEqual([['Proficient in React and Vue ecosystem tooling.']]);
  });

  it('项目符号列表一项一条（旧语料的那两条技能从此是两个条目）', () => {
    const blocks = splitEntryBlocks('skills', ['- TypeScript', '- Node.js / Electron']);
    expect(blocks).toEqual([['TypeScript'], ['Node.js / Electron']]);
  });
});

/** 端到端一条：整篇零空行的真实形状过 `parseResumeText`，条目数与字段装配同时成立。 */
describe('4.1-15 / 4.1-16 端到端：零空行的真实简历形状', () => {
  const ZERO_BLANK = [
    '一、基本信息',
    '姓名：李测试 联系电话：13800002222',
    '二、职业技能',
    '（一）编程语言',
    '熟练掌握 JavaScript 与 TypeScript，具备解决高难度前端问题的能力。',
    '（二）前端框架',
    '1. 深入掌握 Vue.js，熟悉从搭建到上线全流程。',
    '2. 熟练掌握 React，能够独立完成复杂交互模块。',
    '三、工作经历',
    '（一）云栖网络科技有限公司 - 前端开发 2020.07 - 2023.12',
    '1. 工作职责',
    '- 重构结算前端，首屏耗时下降 35%。',
    '（二）海图信息技术有限公司 - 高级前端 2018.03 - 2020.06',
    '- 封装 3 个公共组件，替换 20 处重复实现。',
  ].join('\n');
  const parsed = parseResumeText(ZERO_BLANK, 'resume-zero-blank', NOW_MS);

  it('经历切出两条、技能切出四条，公司与时间段照旧装配', () => {
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    expect(fieldOf(parsed, 'experience', 0, 'company')).toBe('云栖网络科技有限公司');
    expect(fieldOf(parsed, 'experience', 0, 'period')).toBe('2020-07 - 2023-12');
    expect(fieldOf(parsed, 'experience', 1, 'company')).toBe('海图信息技术有限公司');
    const skills = parsed.document.sections.find((section) => section.kind === 'skills');
    expect(skills?.entries.map((entry) => entry.fields[0]?.value)).toEqual([
      '编程语言',
      '熟练掌握 JavaScript 与 TypeScript，具备解决高难度前端问题的能力。',
      '前端框架',
      '深入掌握 Vue.js，熟悉从搭建到上线全流程。',
      '熟练掌握 React，能够独立完成复杂交互模块。',
    ]);
    expect(parsed.document.sections.find((section) => section.kind === 'experience')?.entries).toHaveLength(2);
  });
});
