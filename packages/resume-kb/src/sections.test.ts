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

  it('汉字序号前缀被摘掉后按词典归类，四类区块都落进文档', () => {
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    expect(parsed.document.sections.map((section) => section.kind)).toEqual(['summary', 'skills', 'experience']);
  });

  it('序号条目行（`（一）公司 - 职位 时间`）认得出公司与时间段', () => {
    if (parsed.status !== 'ok') return expect(parsed.status).toBe('ok');
    const company = fieldOf(parsed, 'experience', 0, 'company');
    expect(company).toContain('云栖网络');
    expect(fieldOf(parsed, 'experience', 0, 'period')).toBeTruthy();
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
