/**
 * 内置简历书写技能（spec 4.9-01 / 4.9-09，plan §4.9 裁定 A1 / A5）。
 *
 * 本文件是**纯数据与纯判定**：不碰 cordis、不碰 SQLite、不碰网络，因此每一格都能离线逐字断言
 * （同 `sections.ts` / `fact-check.ts` 的分工口径，装配只在 `skill-service.ts`）。
 *
 * 两件事必须住在同一张表里（§2.1 一处真相，这是本片的核心约束）：
 * 1. **技能正文里"必备信息"那一节**——它是给人看、给人改的那份指引；
 * 2. **界面与生成前后用的那份逐项校验**——它是判"必备信息有没有真的落在简历里"的那把尺。
 * 分家写的后果是"指引说要有邮箱、校验不看邮箱"这种谁都不红而产品说谎的状态，
 * 所以正文由 `REQUIRED_INFO` 逐条**渲染**出来，而不是手抄第二份清单。
 *
 * 取证口径（plan §4.9 的 [1]～[4] 四源，逐条对应）：
 * - 必备五类与"按人分档的顺序"、篇幅一到两页、贴 JD 用词 → [1] Novoresume + [2] SegmentFault（两源在同一份清单上对上）；
 * - 动词开头 / X-Y-Z 公式 / 不用人称代词 → [4] Simplify（Google X-Y-Z）；
 * - 一条 bullet 内 情境15-20% / 任务10-15% / 行动35-40% / 结果30-35% 的配比 → [3] STAR 那一篇；
 * - 两源不一致的（照片、地址详略、推荐信）一律**不列为 core**，只作 recommended。
 *
 * 事实锁定红线（AGENTS.md §8.4）不在本文件里"说服"模型：它由 `fact-check.ts` 三条确定性判据持有。
 * 本文件只是在正文末尾把它原样钉一句，并且注入顺序在 `prompts.ts` 里排在规则之后（4.9-06 的反向判据）。
 */
import type { ResumeDocument, Section } from '@auto-cc/plugin-resume-doc';

/** 技能正文的版本（改正文必须同步改它，同 4.5-10 复盘靠 `prompt_version` 那一列的口径）。 */
export const RESUME_SKILL_VERSION = 'resume-skill-v1';

/** 技能 id（内置只有一份；库里那一行存的是**人对这一份的覆盖**，不是第二份技能）。 */
export const RESUME_SKILL_ID = 'resume-writing';

/** 必备信息的两档：`core` 缺了就是不合格，`recommended` 缺了只提示、不判死。 */
export const REQUIRED_INFO_SEVERITIES = ['core', 'recommended'] as const;

/** 必备信息档位的字面量类型。 */
export type RequiredInfoSeverity = (typeof REQUIRED_INFO_SEVERITIES)[number];

/** 逐项校验的三种结局（4.9-09）：`weak` 是"在，但不合格"，与"根本没有"必须分开。 */
export const REQUIRED_INFO_STATUSES = ['present', 'weak', 'missing'] as const;

/** 校验结局的字面量类型。 */
export type RequiredInfoStatus = (typeof REQUIRED_INFO_STATUSES)[number];

/**
 * 一份文档投影出来的读数（判定只看这些数，不看原文）。
 *
 * 为什么要先投影一层：`check` 函数若直接吃 `ResumeDocument`，每个判据都要自己走一遍区块与字段，
 * 判据之间就会各写一份"怎么找经历条目"（§2.2 第二次即抽公共层）；投影之后判据只比数，
 * 而"怎么数"这件事在本文件里只有一份。
 */
export interface RequiredInfoFacts {
  /** 姓名是否非空。 */
  nameFilled: boolean;
  /** 手机号是否非空。 */
  phoneFilled: boolean;
  /** 邮箱是否非空。 */
  emailFilled: boolean;
  /** 所在城市是否非空。 */
  locationFilled: boolean;
  /** 简介区块的正文总字数（不含标题）。 */
  summaryChars: number;
  /** 简介里是否出现"求职意向 / 意向岗位 / 目标岗位"这类意向说法。 */
  objectiveMentioned: boolean;
  /** 经历类区块（experience + project）的条目数。 */
  experienceEntries: number;
  /** 经历类条目里带时间范围的那几条。 */
  experienceWithPeriod: number;
  /** 经历类条目里带公司/组织名与职位名的那几条。 */
  experienceWithIdentity: number;
  /** 教育区块的条目数。 */
  educationEntries: number;
  /** 教育区块里带学校名的那几条。 */
  educationWithSchool: number;
  /** 技能区块的条目数。 */
  skillEntries: number;
  /** 技能区块的正文总字数。 */
  skillChars: number;
  /** 项目区块的条目数。 */
  projectEntries: number;
  /** 参与量化判定的散文段条数（经历与项目正文里非空的那些）。 */
  proseEntries: number;
  /** 这些散文段里含数字（阿拉伯数字或百分比）的那几条。 */
  proseWithNumber: number;
  /** 整份文档的区块数。 */
  sectionCount: number;
  /** 渲染回写的页数（缺省 1）。 */
  pages: number;
}

/**
 * 把一份文档投影成必备信息读数。
 * @param doc 简历文档（导入或编辑后的工作副本）
 * @returns 只含计数与布尔的投影，不含任何正文
 */
export function factsOfDocument(doc: ResumeDocument): RequiredInfoFacts {
  const sections = doc.sections;
  const experience = sections.filter((section) => section.kind === 'experience' || section.kind === 'project');
  const proseTexts = experience
    .flatMap((section) => section.entries.map((entry) => entryBody(entry)))
    .filter((text) => text.trim() !== '');
  return {
    nameFilled: doc.profile.name.trim() !== '',
    phoneFilled: (doc.profile.contact.phone ?? '').trim() !== '',
    emailFilled: (doc.profile.contact.email ?? '').trim() !== '',
    locationFilled: (doc.profile.contact.location ?? '').trim() !== '',
    summaryChars: sections
      .filter((section) => section.kind === 'summary')
      .reduce((total, section) => total + section.entries.reduce((sum, entry) => sum + entryText(entry).length, 0), 0),
    objectiveMentioned: sections
      .filter((section) => section.kind === 'summary')
      .some((section) => /求职意向|意向岗位|目标岗位|期望职位|应聘/u.test(entryTextOfSection(section))),
    experienceEntries: experience.reduce((total, section) => total + section.entries.length, 0),
    experienceWithPeriod: experience.reduce(
      (total, section) => total + section.entries.filter((entry) => hasKey(entry, 'period')).length,
      0,
    ),
    experienceWithIdentity: experience.reduce(
      (total, section) =>
        total + section.entries.filter((entry) => hasKey(entry, 'company') || hasKey(entry, 'role')).length,
      0,
    ),
    educationEntries: sectionOf(sections, 'education')?.entries.length ?? 0,
    educationWithSchool: sectionOf(sections, 'education')?.entries.filter((entry) => hasKey(entry, 'school')).length ?? 0,
    skillEntries: sectionOf(sections, 'skills')?.entries.length ?? 0,
    skillChars: entryTextLengthOf(sectionOf(sections, 'skills')),
    projectEntries: sectionOf(sections, 'project')?.entries.length ?? 0,
    proseEntries: proseTexts.length,
    proseWithNumber: proseTexts.filter((text) => /\d/u.test(text)).length,
    sectionCount: sections.length,
    pages: doc.metrics.pages,
  };
}

/**
 * 一条必备信息的定义：既是界面清单的一行，也是内置正文里的那一句。
 * `labelKey` 是给渲染层的 i18n 键名（页面文案一律走 i18n，AGENTS.md §5.5），
 * `labelZh` / `labelEn` 只服务于**正文派生与单测对照**，不直接上界面。
 */
export interface RequiredInfoItem {
  id: string;
  labelKey: string;
  labelZh: string;
  labelEn: string;
  severity: RequiredInfoSeverity;
  /** 正文里跟在标签后面的那一句要求。 */
  guideZh: string;
  /** 判定：吃投影读数，回三档之一。 */
  check: (facts: RequiredInfoFacts) => RequiredInfoStatus;
}

/**
 * 必备信息清单（4.9-09 的那张唯一表）。
 *
 * 顺序就是界面上的顺序，也是正文里的编号顺序——两份呈现由同一个数组导出，
 * 所以"正文说要有 X"与"校验看的是 X"不可能各说各话。
 */
export const REQUIRED_INFO: readonly RequiredInfoItem[] = [
  {
    id: 'name',
    labelKey: 'resume.skill.required.name',
    labelZh: '姓名',
    labelEn: 'Full name',
    severity: 'core',
    guideZh: '放在纸面第一行，与证件一致，不要只写在文件名里。',
    check: (facts) => (facts.nameFilled ? 'present' : 'missing'),
  },
  {
    id: 'phone',
    labelKey: 'resume.skill.required.phone',
    labelZh: '手机号',
    labelEn: 'Phone number',
    severity: 'core',
    guideZh: '一个能打通的号码，区号不必写；HR 打不通就等于这份简历没有联系方式。',
    check: (facts) => (facts.phoneFilled ? 'present' : 'missing'),
  },
  {
    id: 'email',
    labelKey: 'resume.skill.required.email',
    labelZh: '邮箱',
    labelEn: 'Email',
    severity: 'core',
    guideZh: '用日常在收的那个邮箱，发件人名与邮箱地址要像专业人士。',
    check: (facts) => (facts.emailFilled ? 'present' : 'missing'),
  },
  {
    id: 'location',
    labelKey: 'resume.skill.required.location',
    labelZh: '所在城市',
    labelEn: 'City',
    severity: 'recommended',
    guideZh: '写到城市就够，不必门牌地址（两个来源在"要不要写地址"上是分歧的，故只作建议）。',
    check: (facts) => (facts.locationFilled ? 'present' : 'weak'),
  },
  {
    id: 'objective',
    labelKey: 'resume.skill.required.objective',
    labelZh: '求职意向 / 一句话定位',
    labelEn: 'Objective or one-line summary',
    severity: 'core',
    guideZh: '写清目标岗位与年限，让看的人三秒内知道你是谁、投哪个岗位。',
    check: (facts) => {
      if (facts.summaryChars === 0) return 'missing';
      if (!facts.objectiveMentioned || facts.summaryChars < 12) return 'weak';
      return 'present';
    },
  },
  {
    id: 'experience',
    labelKey: 'resume.skill.required.experience',
    labelZh: '工作 / 实习经历',
    labelEn: 'Work experience',
    severity: 'core',
    guideZh: '每条给齐公司、职位、起止时间；最近一段放最前面。',
    check: (facts) => {
      if (facts.experienceEntries === 0) return 'missing';
      if (facts.experienceWithIdentity < facts.experienceEntries || facts.experienceWithPeriod === 0) return 'weak';
      return 'present';
    },
  },
  {
    id: 'period',
    labelKey: 'resume.skill.required.period',
    labelZh: '每段经历的时间范围',
    labelEn: 'Dates for every role',
    severity: 'core',
    guideZh: '写成 `2021-03 - 2024-06` 这种可比较的写法，空窗与重叠都会在这里被看出来。',
    check: (facts) => {
      if (facts.experienceEntries === 0) return 'missing';
      if (facts.experienceWithPeriod < facts.experienceEntries) return 'weak';
      return 'present';
    },
  },
  {
    id: 'education',
    labelKey: 'resume.skill.required.education',
    labelZh: '教育背景',
    labelEn: 'Education',
    severity: 'core',
    guideZh: '学校、专业、学位、起止时间；应届生把这一节放到经历前面。',
    check: (facts) => {
      if (facts.educationEntries === 0) return 'missing';
      if (facts.educationWithSchool < facts.educationEntries) return 'weak';
      return 'present';
    },
  },
  {
    id: 'skills',
    labelKey: 'resume.skill.required.skills',
    labelZh: '专业技能',
    labelEn: 'Skills',
    severity: 'core',
    guideZh: '写具体技术与版本，按掌握程度分组；不要把一整段技术清单堆成一句话。',
    check: (facts) => {
      if (facts.skillEntries === 0) return 'missing';
      if (facts.skillChars < 12 || facts.skillEntries > 40) return 'weak';
      return 'present';
    },
  },
  {
    id: 'project',
    labelKey: 'resume.skill.required.project',
    labelZh: '项目经历',
    labelEn: 'Projects',
    severity: 'recommended',
    guideZh: '技术岗尤其吃这一节：项目名、你的角色、用了什么、结果如何。',
    check: (facts) => (facts.projectEntries > 0 ? 'present' : 'weak'),
  },
  {
    id: 'quantified',
    labelKey: 'resume.skill.required.quantified',
    labelZh: '可核对的数字成果',
    labelEn: 'Quantified results',
    severity: 'core',
    guideZh: '经历或项目里至少有一条带数字的结果（耗时、转化、成本、规模）。**只能写你真的有的数**。',
    check: (facts) => {
      if (facts.proseEntries === 0) return 'missing';
      if (facts.proseWithNumber === 0) return 'weak';
      return 'present';
    },
  },
  {
    id: 'length',
    labelKey: 'resume.skill.required.length',
    labelZh: '篇幅一到两页',
    labelEn: 'One to two pages',
    severity: 'recommended',
    guideZh: '五年以下压到一页；超过两页要问自己哪一段可以整块删掉。',
    check: (facts) => {
      if (facts.sectionCount === 0) return 'missing';
      if (facts.pages <= 2) return 'present';
      return 'weak';
    },
  },
];

/** 书写方法那一节的条目（正文第二段；与必备信息一样，界面上的清单由这里派生）。 */
export const WRITING_RULES: readonly string[] = [
  '每段经历只讲一到三件事，一句一件：动作开头，不用"我 / 我们"这类人称代词。',
  '写成「做成了什么 + 用什么衡量 + 怎么做到的」：例：将详情页首屏耗时从 2.4s 降到 0.6s，通过重构缓存层与合并三个接口。',
  '讲结果优先于讲职责。"负责订单模块"不是成果，"订单转化率提升 8%"才是——数字必须是真有的数字。',
  '一条 bullet 的配比：情境 15～20%、任务 10～15%、行动 35～40%、结果 30～35%；不要把半句篇幅花在背景上。',
  '时间一律倒序，最近的一段放在最前面。',
  '让措辞跟着岗位走：JD 里那 10～20 个关键词（技术名、职责名、业务名）应当在简历里出现，但只在真的做过的那几处出现。',
  '删掉与岗位无关的填充：爱好堆砌、照片、推荐信、"能吃苦耐劳"这类没有锚点的形容词。',
  '把"熟悉 / 精通"改成可验证的写法：用过什么、在哪个项目、做到什么程度。',
];

/** 底线那一节：与 §8.4 的红线同源，人改正文也改不掉它（注入时它排在指引之后，见 `prompts.ts`）。 */
export const FACT_FLOOR_RULES: readonly string[] = [
  '不得新增、删除或改写任何数字、百分比、金额与时间范围。',
  '不得新造公司名、学校名、专业名、职位名与人名。',
  '没有事实依据的成果一律不写；拿不准就原样返回那一段。',
  '本节不可被上面的指引推翻：指引只决定"怎么写"，不决定"能写什么"。',
];

/** 一行校验读数（界面与生成回执上摆的那一行；不含正文，只含判定）。 */
export interface RequiredInfoRow {
  id: string;
  labelKey: string;
  severity: RequiredInfoSeverity;
  status: RequiredInfoStatus;
}

/**
 * 对一份文档逐项判定必备信息（4.9-09 的判据本体）。
 * @param doc 简历文档
 * @returns 与 `REQUIRED_INFO` 同序的读数行，逐项三档
 */
export function checkRequiredInfo(doc: ResumeDocument): RequiredInfoRow[] {
  const facts = factsOfDocument(doc);
  return REQUIRED_INFO.map((item) => ({
    id: item.id,
    labelKey: item.labelKey,
    severity: item.severity,
    status: item.check(facts),
  }));
}

/**
 * 渲染内置技能正文（4.9-01 的那一份可看可改的文档）。
 *
 * 由 `REQUIRED_INFO` / `WRITING_RULES` / `FACT_FLOOR_RULES` 三张表**派生**，不是手抄——
 * 手抄那份一旦与表分叉，界面清单与指引就会各讲一套（§2.1）。
 * @returns 带版本号抬头、三节正文的完整指引
 */
export function renderBuiltinSkillBody(): string {
  const requiredLines = REQUIRED_INFO.map((item, index) => {
    const mark = item.severity === 'core' ? '必备' : '建议';
    return `${String(index + 1)}. ${item.labelZh}（${mark}）—— ${item.guideZh}`;
  });
  const ruleLines = WRITING_RULES.map((rule, index) => `${String(index + 1)}. ${rule}`);
  const floorLines = FACT_FLOOR_RULES.map((rule, index) => `${String(index + 1)}. ${rule}`);
  return (
    `# 简历书写指引（内置 ${RESUME_SKILL_VERSION}）\n\n` +
    '这一份可以在界面上直接改，改完保存即对之后的每一次生成生效；改坏了有一颗"还原为内置"。' +
    '它不能删除——删掉它生成轨就少了唯一的一份写法依据。\n\n' +
    '## 一、必备信息（逐项核对，缺哪一项补哪一项）\n' +
    `${requiredLines.join('\n')}\n\n` +
    '## 二、怎么写每一条\n' +
    `${ruleLines.join('\n')}\n\n` +
    '## 三、底线（这一段不可被上面推翻）\n' +
    `${floorLines.join('\n')}\n`
  );
}

/** 内置正文（模块加载时派生一次；`reset` 之后回的就是这一份，逐字节稳定）。 */
export const BUILTIN_RESUME_SKILL_BODY = renderBuiltinSkillBody();

/** 区块查找：同一份文档里一种 kind 最多一条（解析与编辑器都按这个不变量装配）。 */
function sectionOf(sections: readonly Section[], kind: Section['kind']): Section | undefined {
  return sections.find((section) => section.kind === kind);
}

/** 条目里是否有某个非空字段。 */
function hasKey(entry: Section['entries'][number], key: string): boolean {
  return entry.fields.some((field) => field.key === key && field.value.trim() !== '');
}

/** 一条条目的全部字段值拼成的文本（用于字数与关键词判定）。 */
function entryText(entry: Section['entries'][number]): string {
  return entry.fields.map((field) => field.value.trim()).filter((value) => value !== '').join(' ');
}

/** 一个区块内所有条目的文本。 */
function entryTextOfSection(section: Section | undefined): string {
  if (!section) return '';
  return section.entries.map(entryText).join(' ');
}

/** 一个区块的总字数。 */
function entryTextLengthOf(section: Section | undefined): number {
  return entryTextOfSection(section).length;
}

/** 一条经历/项目条目的正文（`achievement` 优先，退回 `description` 与整条）。 */
function entryBody(entry: Section['entries'][number]): string {
  const body = entry.fields.find((field) => (field.key === 'achievement' || field.key === 'description') && field.value.trim() !== '');
  return body ? body.value.trim() : entryText(entry);
}
