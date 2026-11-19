/**
 * 求职主链的纯判据（M2-B 10.3-01 / 10.3-03）。
 *
 * 这里只放**不碰服务与 IO** 的函数：意向 → 搜索条件、JD 版本与要求 id 的稳定派生、
 * 比对结果 → 可解释匹配行、面试材料的来源与数字校验。服务层（`journey-service.ts`）
 * 只负责把既有服务的结果喂进来并把这里的结果交出去，于是判据可以逐条单测。
 *
 * 三条刻意的取舍：
 * 1. **要求 id 不新造一张表**：`kb.gap` 的 `RequirementItem` 没有 id 字段，id 由
 *    `jdVersion + 序号` 稳定派生；同一份 JD 文本重复跑得到同一组 id，换 JD 文本就整体换版本。
 * 2. **匹配理由只来自比对结果**：每条理由都带 `kb.gap` 给出的证据 id，没有证据的要求如实记 `missing`，
 *    不允许为了让三个岗位"看起来都合适"而补一条无据理由。
 * 3. **面试材料的校验只认给定清单**：`resumeFactIds` / `requirementIds` 越界即违规；
 *    数字必须能在简历事实或这份 JD 里找到同值，找不到就判冲突（明确失败，不回落样例）。
 */
import { createHash } from 'node:crypto';
import { diffNumberMultiset } from '@auto-cc/core';
import type { GapReportView, KbIntentView } from '@auto-cc/plugin-resume-kb';
import type {
  JobRowView,
  JourneyIntentView,
  JourneyInterviewItemView,
  JourneyInterviewView,
  JourneyJobMatchView,
  JourneyRequirementView,
} from '@auto-cc/shared';
import { JOURNEY_MIN_CHECKLIST, JOURNEY_MIN_QA, type InterviewFact, type InterviewRequirement } from './prompts.js';

/** 意向四格里决定搜索条件的两格；空串表示没填，不拿默认城市/岗位替人决定。 */
export interface IntentCriteria {
  readonly keyword: string;
  readonly city: string | null;
  readonly missingFields: string[];
}

/**
 * 把母版意向四格换成搜索条件。
 * @param intent 母版求职意向（四格固定短答案，空串是合法读数）
 * @returns 关键词（期望岗位）与城市；`missingFields` 列出未填的格
 */
export function criteriaFromIntent(intent: KbIntentView): IntentCriteria {
  const keyword = intent.expectRole.trim();
  const city = intent.expectCity.trim();
  const missingFields: string[] = [];
  if (keyword === '') missingFields.push('expectRole');
  if (city === '') missingFields.push('expectCity');
  if (intent.expectSalary.trim() === '') missingFields.push('expectSalary');
  if (intent.expectStart.trim() === '') missingFields.push('expectStart');
  return { keyword, city: city === '' ? null : city, missingFields };
}

/**
 * 由母版文档内容算版本键；链上所有材料都按它对齐，母版一改版本就变。
 * @param docId 文档 id
 * @param contentHash 由 `resume.doc` 载入后算出的规范内容哈希
 * @returns `doc:<docId>:<哈希前 12 位>`
 */
export function resumeVersionOf(docId: string, contentHash: string): string {
  return `doc:${docId}:${contentHash.slice(0, 12)}`;
}

/**
 * 由 JD 正文算稳定版本键；同一份正文重复跑得到同一版本，换正文就换版本。
 * @param description JD 正文（去首尾空白后参与哈希）
 * @returns 12 位十六进制版本串
 */
export function jdVersionOf(description: string): string {
  return createHash('sha256').update(description.trim()).digest('hex').slice(0, 12);
}

/**
 * 派生一条要求的稳定 id。
 * @param jdVersion JD 版本键
 * @param index 该要求在本份比对里的序号（0 起）
 * @returns 形如 `<jdVersion>:R<序号>`；换 JD 文本即整体换前缀
 */
export function requirementIdOf(jdVersion: string, index: number): string {
  return `${jdVersion}:R${String(index + 1)}`;
}

/**
 * 把一份比对报告拍成可解释的岗位匹配行。
 * @param job 库内岗位行（提供 jobId/标题/公司/正文）
 * @param report `kb.gap.report(job.description)` 的读数
 * @returns 该岗位的匹配行；要求行与报告的 `rows` 同序，证据 id 原样抄自比对结果
 */
export function matchJob(job: JobRowView, report: GapReportView): JourneyJobMatchView {
  const jdVersion = jdVersionOf(job.description);
  const requirements: JourneyRequirementView[] = report.rows.map((row, index) => ({
    requirementId: requirementIdOf(jdVersion, index),
    kind: row.item.kind,
    label: row.item.label,
    quote: row.item.quote,
    state: row.state,
    factIds: row.evidence.map((evidence) => evidence.id),
    bestScore: row.bestScore,
  }));
  const matchedCount = requirements.filter((item) => item.state === 'matched').length;
  const partialCount = requirements.filter((item) => item.state === 'partial').length;
  const missingCount = requirements.filter((item) => item.state === 'missing').length;
  return {
    jobId: job.jobId,
    title: job.title,
    company: job.company,
    jdVersion,
    matchedCount,
    partialCount,
    missingCount,
    requirements,
  };
}

/**
 * 按可解释强度排序；同分按 jobId 升序，保证同输入两次排序一致。
 * @param matches 匹配行数组
 * @returns 新数组，不就地改入参
 */
export function sortMatches(matches: readonly JourneyJobMatchView[]): JourneyJobMatchView[] {
  return [...matches].sort(
    (left, right) =>
      right.matchedCount - left.matchedCount ||
      right.partialCount - left.partialCount ||
      left.jobId.localeCompare(right.jobId),
  );
}

/**
 * 组装意向视图；`resumeVersion` 由服务层算好后传入，纯函数不碰文档存储。
 * @param intent 母版意向
 * @param docId 文档 id
 * @param resumeVersion 版本键
 * @returns 共享契约里的意向视图
 */
export function intentViewOf(intent: KbIntentView, docId: string, resumeVersion: string): JourneyIntentView {
  const criteria = criteriaFromIntent(intent);
  return {
    docId,
    resumeVersion,
    expectRole: intent.expectRole,
    expectCity: intent.expectCity,
    expectSalary: intent.expectSalary,
    expectStart: intent.expectStart,
    criteria: { keyword: criteria.keyword, city: criteria.city },
    missingFields: criteria.missingFields,
  };
}

/** 面试材料校验的结局；`violations` 全是稳定码 + id，不含正文。 */
export type InterviewValidation = {
  readonly ok: boolean;
  readonly violations: string[];
  readonly kit: JourneyInterviewView | null;
};

/** 校验用的上下文：事实清单、要求清单、这份 JD 的正文。 */
export interface InterviewContext {
  readonly docId: string;
  readonly platform: string;
  readonly jobId: string;
  readonly jdVersion: string;
  readonly resumeVersion: string;
  readonly facts: readonly InterviewFact[];
  readonly requirements: readonly InterviewRequirement[];
  readonly jdText: string;
}

/**
 * 从模型回答的正文里取 JSON 对象；代码围栏会被剥掉，但不在里面猜字段。
 * @param reply 模型回复正文
 * @returns 解析后的未知值；不是 JSON 对象时为 null
 */
export function parseInterviewJson(reply: string): Record<string, unknown> | null {
  const trimmed = reply
    .trim()
    .replace(/^```[a-zA-Z]*\s*/u, '')
    .replace(/\s*```$/u, '');
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * 检查一段文字里的数字是否都能在给定支撑文本里找到同值。
 * @param text 待查文字（问答或自我介绍）
 * @param supportedTexts 支撑文本（简历事实 + 这份 JD）
 * @returns 无支撑的数字键；全部有支撑时为空数组
 */
function unsupportedNumbers(text: string, supportedTexts: readonly string[]): string[] {
  return diffNumberMultiset(supportedTexts.join('\n'), text).added;
}

/**
 * 校验模型产出的面试材料：条数、来源 id、数字三类判据。
 * @param raw `parseInterviewJson` 的结果（不可信输入）
 * @param context 本次 JD 与母版事实
 * @returns 违规清单与可直接返回的视图；任一违规时 `kit` 为 null
 */
export function validateInterviewKit(raw: Record<string, unknown>, context: InterviewContext): InterviewValidation {
  const violations: string[] = [];
  const factIds = new Set(context.facts.map((fact) => fact.factId));
  const requirementIds = new Set(context.requirements.map((item) => item.requirementId));
  const supportedTexts = [...context.facts.map((fact) => fact.text), context.jdText];
  const selfIntro = typeof raw['selfIntro'] === 'string' ? raw['selfIntro'].trim() : '';
  if (selfIntro === '') violations.push('selfIntro:missing');
  else if (unsupportedNumbers(selfIntro, supportedTexts).length > 0) violations.push('selfIntro:unsupported-number');

  const rawQa = Array.isArray(raw['qa']) ? raw['qa'] : [];
  if (rawQa.length < JOURNEY_MIN_QA) violations.push(`qa:too-few:${String(rawQa.length)}`);
  const qa: JourneyInterviewItemView[] = [];
  rawQa.forEach((entry, index) => {
    const item = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    const question = typeof item['question'] === 'string' ? item['question'].trim() : '';
    const answer = typeof item['answer'] === 'string' ? item['answer'].trim() : '';
    const factRefs = Array.isArray(item['resumeFactIds'])
      ? item['resumeFactIds'].filter((value): value is string => typeof value === 'string')
      : [];
    const requirementRefs = Array.isArray(item['requirementIds'])
      ? item['requirementIds'].filter((value): value is string => typeof value === 'string')
      : [];
    if (question === '' || answer === '') violations.push(`qa[${String(index)}]:empty`);
    if (factRefs.length === 0) violations.push(`qa[${String(index)}]:no-fact`);
    if (requirementRefs.length === 0) violations.push(`qa[${String(index)}]:no-requirement`);
    for (const ref of factRefs) if (!factIds.has(ref)) violations.push(`qa[${String(index)}]:unknown-fact:${ref}`);
    for (const ref of requirementRefs) {
      if (!requirementIds.has(ref)) violations.push(`qa[${String(index)}]:unknown-requirement:${ref}`);
    }
    // 只查回答里的数字：问句常带序号（「问题 1」），那是组织材料的编号而不是事实陈述。
    if (unsupportedNumbers(answer, supportedTexts).length > 0) {
      violations.push(`qa[${String(index)}]:unsupported-number`);
    }
    qa.push({ question, answer, resumeFactIds: factRefs, requirementIds: requirementRefs });
  });

  const rawChecklist = Array.isArray(raw['checklist']) ? raw['checklist'] : [];
  const checklist = rawChecklist
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  if (checklist.length < JOURNEY_MIN_CHECKLIST) violations.push(`checklist:too-few:${String(checklist.length)}`);

  if (violations.length > 0) return { ok: false, violations, kit: null };
  return {
    ok: true,
    violations: [],
    kit: {
      docId: context.docId,
      platform: context.platform,
      jobId: context.jobId,
      jdVersion: context.jdVersion,
      resumeVersion: context.resumeVersion,
      selfIntro,
      qa,
      checklist,
    },
  };
}
