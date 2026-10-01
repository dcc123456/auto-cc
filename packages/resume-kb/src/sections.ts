/**
 * 纯文本 / Markdown 简历的区块识别与结构化（spec 4.1-01 的 Markdown 一条腿、4.1-02、4.1-04、4.1-05、4.1-09）。
 *
 * 为什么先做这一半：PDF 与 DOCX 只负责「字节 → 文本」，真正决定解析质量的是**文本 → 实体**这一半，
 * 而后者零依赖、可离线、能用固定语料逐字段断言。单独成文件的收益是 4.1-01 的另两条依赖腿接进来时
 * 只多一个调用方，不必动这里的判定规则。
 *
 * 三条不可动摇的口径：
 * 1. **宁缺勿造**（4.1-04）：认不出的一律留空并产出 `ParseIssue`，绝不填「看起来像」的公司名——
 *    简历里的每一条陈述都可能被投出去，猜填等于制造假事实。
 * 2. **脱敏在入库之前**（4.1-09）：整段文本先过 `@auto-cc/core` 的 `redactText`，本包拿不到也不该拿到
 *    原始手机号 / 邮箱 / 身份证，落库与日志因此天然安全，而不是靠调用方记得再脱一次。
 * 3. **产物只有 P3.1 文档模型**（plan §3-5）：输出 `ResumeDocument`，事实字段由 `makeField` 自动打 `locked`，
 *    本包不新建第二份简历数据结构。
 *
 * 抽取来源标注（spec 4.1-12）：与 `ai-resume` 的 `server/src/utils/fileParser.ts` 属于同一类能力
 * （抽文本 + 短文本判扫描件），但本文件**未复制其代码**——该仓库仅在 README 声明 MIT、仓库内无 `LICENSE`
 * 文件，书面授权状态未决（见 `docs/specs/03-resume-pdf/spec.md` 3.3-13 的 `[!]`），故按 clean-room 自写处理。
 */
import { PII_VALUE_PATTERNS, redactText } from '@auto-cc/core';
import {
  createEmptyDocument,
  makeField,
  type Field,
  type ResumeDocument,
  type Section,
  type SectionKind,
} from '@auto-cc/plugin-resume-doc';
import { extractPeriod, type ParsedPeriod } from './period.js';

/**
 * 疑似扫描件的正文长度下限（spec 4.1-05）。
 * 低于它说明抽到的不是文本层而是空壳（图片型 PDF 抽文本必然得到近零字符），
 * 此时**明确失败并要求人工补录**，不引入 OCR 依赖（plan §6）。
 */
export const MIN_TEXT_CHAR_COUNT = 100;

/**
 * 解析不确定标记的种类（spec 4.1-04）。
 * `text-too-short` 抽文本过短；`missing-field` 该区块应有而缺失；`unparsable-field` 有写法但归一失败；
 * `sensitive-redacted` 原文含个人信息、已按最严口径掩码；`unknown-section` 有正文但落不进任何已知区块。
 */
export type ParseIssueCode =
  'text-too-short' | 'missing-field' | 'unparsable-field' | 'sensitive-redacted' | 'unknown-section';

/** 一条「待确认」记录：界面按它列清单（4.1-04 的 V 类判据）。 */
export interface ParseIssue {
  code: ParseIssueCode;
  /** 出问题的区块种类；文档级问题（过短、姓名缺失）为 `null`。 */
  sectionKind: SectionKind | null;
  /** 出问题的条目 id；文档级问题为 `null`。 */
  entryId: string | null;
  /** 缺失或认不出的字段键；无具体字段时为 `null`。 */
  fieldKey: string | null;
  /** 触发标记的原文片段（最多 40 字，且已脱敏），只用于人读定位。 */
  excerpt: string;
}

/** 解析成功的结果（spec 4.1-02）：文档 + 待确认清单 + 抽文本读数。 */
export interface ParsedResumeText {
  readonly status: 'ok';
  readonly document: ResumeDocument;
  readonly issues: readonly ParseIssue[];
  /** 去除空白后的正文字符数，扫描件判定的依据。 */
  readonly textLength: number;
}

/** 解析被明确拒绝的结果（spec 4.1-05）：不抛异常、不返回半份文档，交给上层变成可读错误。 */
export interface RejectedResumeText {
  readonly status: 'too-short';
  readonly issues: readonly ParseIssue[];
  readonly textLength: number;
}

/** `parseResumeText` 的返回：成功给文档，过短只给判定读数（两条路径都带 issues，界面可复用同一套渲染）。 */
export type ParseTextResult = ParsedResumeText | RejectedResumeText;

/** 区块标题词典。顺序即优先级——「实习经历」归 experience 而不是 campus；英文词条给拉丁文 PDF/DOCX 腿用（匹配前统一小写）。 */
const HEADING_TERMS: ReadonlyArray<readonly [SectionKind, readonly string[]]> = [
  ['summary', ['个人简介', '自我介绍', '自我评价', '个人总结', '简介', 'summary', 'profile', 'objective']],
  [
    'experience',
    [
      '工作经历',
      '工作经验',
      '职业经历',
      '实习经历',
      '履历',
      'work experience',
      'employment history',
      'internship',
      'experience',
    ],
  ],
  ['project', ['项目经历', '项目经验', 'selected projects', 'projects', 'project']],
  ['education', ['教育经历', '教育背景', '学习经历', '教育', 'education']],
  ['skills', ['专业技能', '技能特长', '技能清单', '技能', 'technical skills', 'core skills', 'skills']],
  ['campus', ['校园经历', '校园活动', '学生活动', '社团活动', '志愿者', 'campus activities', 'volunteering']],
];

/** 标题行长度上限：超过它就认定是正文（正文里也常出现「工作经历梳理」这类词组）。 */
const MAX_HEADING_LENGTH = 16;

/** 行首装饰：Markdown 的 `#`、项目符号、有序列表号。 */
const LEADING_MARKUP = /^\s*(?:#{1,6}\s*|[-*+•·]\s*|\d+[.、)]\s*)/;

/** 条目内字段分隔：中英文竖线 / 间隔号 / 逗号分号 / 任意空白（英文公司名带空格会被切开，切多了就标待确认）。 */
const SEGMENT_SPLIT = /[|｜·•,，;；]|\s+/u;

/** 摘掉时间段后剩下的孤立标点（`-`、`至` 这类），不能让它冒充公司名进入模型。 */
const PUNCTUATION_ONLY = /^[-–—~～至到.,，;、|｜·•\s]+$/u;

/** 学位词表：教育区块里能识别出学位的那一段。 */
const DEGREE_TERM = /学士|硕士|博士|本科|大专|MBA|PhD|BSc|MSc/i;

/**
 * 去掉一行开头的 Markdown 标记与加粗符号，得到纯文字。
 * @param line 原始行
 * @returns 去掉装饰后的行文本（可能为空串）
 */
function stripMarkup(line: string): string {
  return line
    .replace(LEADING_MARKUP, '')
    .replace(/\*\*|__|`/g, '')
    .trim();
}

/**
 * 判断一行是否是区块标题并给出归类。
 * 要求「去装饰后足够短 + 等于或以词典词开头」，避免把正文当成标题。
 * @param line 原始行
 * @returns 命中的区块种类与该行去装饰后的字面；不是标题时返回 `null`
 */
function classifyHeading(line: string): { kind: SectionKind; title: string } | null {
  const text = stripMarkup(line).replace(/[:：]\s*$/, '');
  if (text === '' || [...text].length > MAX_HEADING_LENGTH) return null;
  const lower = text.toLowerCase();
  for (const [kind, terms] of HEADING_TERMS) {
    for (const term of terms) {
      const needle = term.toLowerCase();
      if (lower === needle || lower.startsWith(needle)) return { kind, title: text };
    }
  }
  return null;
}

/**
 * 按种类取核心脱敏判据里的一条正则（复用 `PII_VALUE_PATTERNS`，本包不再写第二份 PII 正则，AGENTS.md §2.1）。
 * @param kind 个人信息种类
 * @returns 带 `g` 标志的正则（`matchAll` 要求全局标志，核心判据的 `id` 已带、其余补齐）
 */
function piiPattern(kind: 'phone' | 'email' | 'id'): RegExp {
  const entry = PII_VALUE_PATTERNS.find((pattern) => pattern.kind === kind);
  if (entry === undefined) throw new Error(`core 的 PII 判据缺少 ${kind} 种类`);
  return new RegExp(entry.source, entry.flags.includes('g') ? entry.flags : `${entry.flags}g`);
}

/** 截取原文片段供界面定位（最多 40 字）。传入前必须已经过脱敏。 */
function excerptOf(text: string): string {
  return [...text.trim()].slice(0, 40).join('');
}

/**
 * 把归一化的时间转成写回简历 `period` 字段的标准文本。
 * @param period `parsePeriod` 的结果
 * @returns `2021-03 - 2023-11` 或 `2021-03 - 至今` 形态；两端都没认出来时返回 `null`（由调用方记待确认）
 */
export function periodText(period: ParsedPeriod): string | null {
  if (period.from === null && period.to === null) return null;
  const end = period.isCurrent ? '至今' : (period.to ?? '');
  if (period.from === null) return end === '' ? null : `- ${end}`;
  return end === '' ? period.from : `${period.from} - ${end}`;
}

/**
 * 把经历类区块的首行拆成「时间段」与「名称段」。
 *
 * 时间先整段摘掉再拆名字，是因为范围写法常跨空格（`2019 - 2022`）——若先按空白切开，
 * 孤立的 `-` 和半个年份就会冒充成公司名。摘完后仍剩下的标点段一并丢弃。
 * @param headerLine 区块内一条经历的首行
 * @returns 认出的时间（含 issues，供上层转待确认）与剩下的名称段；一个端点都没认出时 `period` 为 `null`
 */
function splitHeader(headerLine: string): { period: ParsedPeriod | null; titles: string[] } {
  const { period, rest } = extractPeriod(headerLine);
  const titles = rest
    .split(SEGMENT_SPLIT)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && !PUNCTUATION_ONLY.test(segment));
  // `unparsable` 说明这行压根没有四位年份形态的东西：当作「没有时间」，不能拿整行当时间。
  const recognized = period.precision === 'none' && !period.isCurrent ? null : period;
  return { period: recognized, titles };
}

/**
 * 由「名称段」装配经历 / 项目 / 校园区块的 company / role 字段。
 * @param kind 区块种类（决定 `makeField` 的事实锁定判定）
 * @param titles 去掉时间段后剩下的段
 * @returns 字段数组；一段都没有时返回空数组，由调用方记 `missing-field`
 */
function companyRoleFields(kind: SectionKind, titles: readonly string[]): Field[] {
  const [company, ...rest] = titles;
  if (company === undefined) return [];
  const fields = [makeField(kind, 'company', company)];
  const role = rest.join(' ');
  if (role !== '') fields.push(makeField(kind, 'role', role));
  return fields;
}

/**
 * 装配教育区块的 school / degree / major 字段。
 * @param titles 去掉时间段后剩下的段
 * @returns 字段数组；首段作学校，命中学位词的段作学位，其余拼成专业
 */
function educationFields(titles: readonly string[]): Field[] {
  const [school, ...rest] = titles;
  if (school === undefined) return [];
  const fields = [makeField('education', 'school', school)];
  const degree = rest.find((segment) => DEGREE_TERM.test(segment));
  const majors = rest.filter((segment) => segment !== degree).join(' ');
  if (degree !== undefined) fields.push(makeField('education', 'degree', degree));
  if (majors !== '') fields.push(makeField('education', 'major', majors));
  return fields;
}

/**
 * 把一个区块内的条目块转成 `Section`。
 * @param kind 区块种类，决定字段键（与 `resume-doc` 模板的槽位一致）
 * @param title 区块标题，保留简历原文（本地化标签由渲染轨按 kind 走 i18n）
 * @param blocks 按空行切出的条目块，每块首行是标题行
 * @param issues 待确认标记的收集数组（就地追加）
 * @returns 可直接放进 `ResumeDocument.sections` 的区块
 */
function buildSection(kind: SectionKind, title: string, blocks: readonly string[][], issues: ParseIssue[]): Section {
  const entries = blocks.map((block, blockIndex) => {
    const entryId = `${kind}-${String(blockIndex + 1)}`;
    const [headerLine = '', ...bodyLines] = block;
    const missing = (fieldKey: string | null): void => {
      issues.push({ code: 'missing-field', sectionKind: kind, entryId, fieldKey, excerpt: excerptOf(headerLine) });
    };

    if (kind === 'summary' || kind === 'skills') {
      return { id: entryId, fields: [makeField(kind, 'text', block.join('\n'))] };
    }

    const isEducation = kind === 'education';
    const { period, titles } = splitHeader(headerLine);
    const fields: Field[] = isEducation ? educationFields(titles) : companyRoleFields(kind, titles);

    // 段数多于 2 说明分隔符切不开「公司 职位」这种写法，不做猜测，整行交人工确认。
    if (!isEducation && titles.length > 2) {
      issues.push({
        code: 'unparsable-field',
        sectionKind: kind,
        entryId,
        fieldKey: 'company',
        excerpt: excerptOf(headerLine),
      });
    }
    if (fields.length === 0) missing(isEducation ? 'school' : 'company');

    if (period === null) {
      missing('period');
    } else if (period.issues.length > 0) {
      issues.push({
        code: 'unparsable-field',
        sectionKind: kind,
        entryId,
        fieldKey: 'period',
        excerpt: excerptOf(headerLine),
      });
      const normalized = periodText(period);
      if (normalized !== null) fields.push(makeField(kind, 'period', normalized));
    } else {
      const normalized = periodText(period);
      if (normalized === null) missing('period');
      else fields.push(makeField(kind, 'period', normalized));
    }

    const body = bodyLines.join('\n');
    if (body !== '') {
      // 教育区块正文暂存 `description`：当前模板不渲染它，但知识库要留着这条证据，不丢内容。
      fields.push(makeField(kind, isEducation ? 'description' : 'achievement', body));
    } else if (!isEducation) {
      missing('achievement');
    }
    return { id: entryId, fields };
  });

  return { id: kind, kind, title, entries };
}

/**
 * 收集原文里的个人信息命中项，为其产出「已脱敏，需人工确认」标记。
 * `excerpt` 只放掩码后的形态——待确认清单本身也会进日志与界面，不能变成新的泄露面。
 * @param rawText 未脱敏的原始文本（只用于匹配，不外传）
 * @returns 每种命中一项的待确认清单
 */
function sensitiveIssues(rawText: string): ParseIssue[] {
  const kinds: Array<{ kind: 'phone' | 'email' | 'id'; fieldKey: string }> = [
    { kind: 'email', fieldKey: 'email' },
    { kind: 'phone', fieldKey: 'phone' },
    { kind: 'id', fieldKey: 'id-card' },
  ];
  const hits: ParseIssue[] = [];
  for (const { kind, fieldKey } of kinds) {
    const matched = [...rawText.matchAll(piiPattern(kind))][0];
    if (matched === undefined) continue;
    hits.push({
      code: 'sensitive-redacted',
      sectionKind: null,
      entryId: null,
      fieldKey,
      excerpt: redactText(matched[0]),
    });
  }
  return hits;
}

/**
 * 从抬头行挑姓名。
 * 规则刻意保守：只看第一条抬头行，含数字或 `@`（手机号、邮箱）就判定「没认出姓名」，
 * 因为抬头里排第二第三的常是城市与微信，猜出来会把地点当人名。
 * @param headerLines 第一个区块标题之前的抬头行（已去装饰、已脱敏）
 * @returns 姓名字面；认不出时返回 `null`
 */
function pickName(headerLines: readonly string[]): string | null {
  const [firstLine] = headerLines;
  if (firstLine === undefined || firstLine === '') return null;
  if (/[0-9@]/.test(firstLine)) return null;
  const length = [...firstLine].length;
  return length >= 2 && length <= 12 ? firstLine : null;
}

/** 用原文里的命中位置 + 核心掩码函数，给出「已脱敏的联系方式」；原文不落到模型里。 */
function maskedContact(rawText: string, kind: 'email' | 'phone'): string | null {
  const matched = [...rawText.matchAll(piiPattern(kind))][0];
  return matched === undefined ? null : redactText(matched[0]);
}

/**
 * 把一份纯文本 / Markdown 简历解析成 P3.1 文档模型。
 *
 * 流程：整篇先过 `redactText`（4.1-09 的落点，之后全程只接触掩码文本）→ 按词典行切区块 →
 * 区块内按空行切条目 → 首行拆「公司 · 职位 + 时间段」→ 其余行作成果 / 职责正文。
 * 同一区块种类多次出现（分栏简历常见）合并进同一个 `Section`，以守住「区块 id 按 kind 唯一」的 diff 前提。
 * @param text PDF / DOCX / Markdown 抽出的原始文本（允许 CRLF、Markdown 标记、全角数字）
 * @param docId 文档 id，交给 `createEmptyDocument` 作存储寻址
 * @param nowMs 更新时间戳（毫秒），由调用方注入以保证测试可断言
 * @returns `status: 'ok'` 带文档与待确认清单；`status: 'too-short'` 只带判定读数（疑似扫描件，spec 4.1-05）
 */
export function parseResumeText(text: string, docId: string, nowMs: number): ParseTextResult {
  const raw = text.replace(/\r\n?/g, '\n');
  const textLength = [...raw.replace(/\s/g, '')].length;
  if (textLength < MIN_TEXT_CHAR_COUNT) {
    return {
      status: 'too-short',
      textLength,
      issues: [
        {
          code: 'text-too-short',
          sectionKind: null,
          entryId: null,
          fieldKey: null,
          excerpt: `${String(textLength)} / ${String(MIN_TEXT_CHAR_COUNT)}`,
        },
      ],
    };
  }

  const issues: ParseIssue[] = sensitiveIssues(raw);
  const safe = redactText(raw);

  const headerLines: string[] = [];
  const buckets = new Map<SectionKind, { title: string; blocks: string[][] }>();
  let current: { title: string; blocks: string[][] } | null = null;
  let block: string[] = [];

  /** 收掉当前条目块：空块直接丢弃，未开区块时（抬头区）不做收集。 */
  const flushBlock = (): void => {
    if (current !== null && block.length > 0) current.blocks.push(block);
    block = [];
  };

  for (const line of safe.split('\n')) {
    const heading = classifyHeading(line);
    if (heading !== null) {
      flushBlock();
      const existing = buckets.get(heading.kind);
      if (existing === undefined) {
        current = { title: heading.title, blocks: [] };
        buckets.set(heading.kind, current);
      } else {
        current = existing;
      }
      continue;
    }
    const content = stripMarkup(line);
    if (content === '') {
      flushBlock();
      continue;
    }
    if (current === null) headerLines.push(content);
    else block.push(content);
  }
  flushBlock();

  const document = createEmptyDocument(docId, nowMs);
  document.profile.contact = {
    email: maskedContact(raw, 'email'),
    phone: maskedContact(raw, 'phone'),
    location: null,
  };

  const name = pickName(headerLines);
  if (name === null) {
    issues.push({
      code: 'missing-field',
      sectionKind: null,
      entryId: null,
      fieldKey: 'name',
      excerpt: excerptOf(headerLines[0] ?? ''),
    });
  }
  document.profile.name = name ?? '';

  if (buckets.size === 0) {
    issues.push({
      code: 'unknown-section',
      sectionKind: null,
      entryId: null,
      fieldKey: null,
      excerpt: excerptOf(headerLines[0] ?? safe),
    });
  }
  for (const [kind, bucket] of buckets) {
    const section = buildSection(kind, bucket.title, bucket.blocks, issues);
    if (section.entries.length === 0) {
      issues.push({ code: 'missing-field', sectionKind: kind, entryId: null, fieldKey: null, excerpt: bucket.title });
    }
    document.sections.push(section);
  }

  return { status: 'ok', document, issues, textLength };
}
