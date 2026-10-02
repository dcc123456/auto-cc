/**
 * 文档模型 → 知识库实体的派生规则（spec 4.2-01 / 4.2-02，plan §1.4 裁定二）。
 *
 * 纯函数：不认识 cordis、也不碰 SQLite，「哪一段简历文本变成哪个实体」因此能离线逐条断言。
 * 四类实体与 `SectionKind` **不是一一对应**（映射表见 plan §1.4 裁定二）：
 * `experience` / `project` 取整条 entry，`skill` 把 `skills` 区块的自由文本按分隔符切开，
 * `achievement` **不是一个区块**——它是任何 entry 里 `factKey === 'achievement'` 的那条字段。
 * `summary / education / campus` 不建实体行：这是裁定二里写死的已知后果（检索侧 4.3-11 按区块级 chunk 索引它们），
 * 不是本文件的疏漏。
 *
 * id 的稳定性（4.2-02 的判据）建立在「`source_doc_id + kind + 条目槽位」这三段都是确定量」之上：
 * 条目槽位取自 P3.1 文档模型自己的 `entry.id`（`sections.ts` 按区块内序号生成，diff 也靠它对齐同一条记录），
 * 所以同一份文档重复派生必然落回同一批 id，`evidence_refs` 不会每次同步都换指。
 */
import { createHash, randomUUID } from 'node:crypto';
import { type Entry, type ResumeDocument } from '@auto-cc/plugin-resume-doc';
import { parsePeriod } from './period.js';

/** 知识库的四类实体（plan §1.4 裁定二），顺序即列表界面的分组顺序。 */
export const KB_ENTITY_KINDS = ['experience', 'project', 'skill', 'achievement'] as const;

/** 实体种类。 */
export type KbEntityKind = (typeof KB_ENTITY_KINDS)[number];

/** 派生出的一条实体（尚未落库的形态）。 */
export interface KbEntityDraft {
  /** 稳定 id：同一份文档重复派生必然相同（4.2-02，供 `evidence_refs` 反查）。 */
  readonly entityId: string;
  readonly kind: KbEntityKind;
  /** 上层归属：项目 → 时间重叠的经历、成果 → 承载它的条目；无归属为 `null`。 */
  readonly parentId: string | null;
  /** 来源文档 id；手工新建的实体为 `null`。 */
  readonly sourceDocId: string | null;
  /** 实体内容。经历/项目沿用文档模型的字段键（`company` / `role` / `period` / `achievement`），
   *  技能与成果用文档模型自己的通用键 `text`——不自造第三套键名。 */
  readonly payload: Readonly<Record<string, string>>;
  /** 载荷的规范化哈希：幂等比对与同文档内去重的键。 */
  readonly normalizedHash: string;
}

/** 技能自由文本的分隔符（顿号 / 中英文逗号分号 / 斜杠 / 竖线；换行单独先切）。 */
const SKILL_SEPARATOR = /[、，,;；/／|]/;

/** 「至今」这类开区间的终点哨兵：远大于任何真实简历年份，比较时等价于「还在继续」。 */
const OPEN_ENDED_MONTH = 99_999;

/**
 * 把文本压成可比较的形态（哈希与去重都用它）。
 * @param text 原始文本
 * @returns 折叠所有连续空白并去首尾空白的串
 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 载荷 → 规范化哈希。
 *
 * 键先排序再拼接，否则 `{a,b}` 与 `{b,a}` 会算出两个哈希，「同一条内容」在库里裂成两行。
 * @param kind 实体种类（参与哈希，防止同一串文本在两种 kind 下互相吃掉）
 * @param payload 实体载荷
 * @returns sha256 十六进制串
 */
export function payloadHashOf(kind: KbEntityKind, payload: Readonly<Record<string, string>>): string {
  const joined = Object.keys(payload)
    .sort()
    .map((key) => `${key}=${normalizeText(payload[key] ?? '')}`)
    .join('\u0000');
  return createHash('sha256').update(`${kind}\u0001${joined}`).digest('hex');
}

/**
 * 由「来源文档 + 种类 + 条目槽位」推出稳定实体 id。
 * @param sourceDocId 来源文档 id
 * @param kind 实体种类
 * @param slot 槽位：entry id，或技能 / 成果的带后缀形态（`skills-1#s2`）
 * @returns `kb-` + 16 位十六进制（与 `resume-<hash>` 的文档 id 同形，便于在库里一眼分辨前缀）
 */
function entityIdOf(sourceDocId: string, kind: KbEntityKind, slot: string): string {
  const digest = createHash('sha256').update(`${sourceDocId}\u0001${kind}\u0001${slot}`).digest('hex');
  return `kb-${digest.slice(0, 16)}`;
}

/**
 * 一条 entry 的字段数组 → 载荷对象。
 * @param entry 文档模型里的条目
 * @returns 字段键到文本值的映射；同名后者覆盖前者（文档模型不允许重复键，这里只是防御脏数据）
 */
function payloadOfEntry(entry: Entry): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const field of entry.fields) payload[field.key] = field.value;
  return payload;
}

/**
 * 把归一化后的时间段（`2021.03 - 2024.06` / `2021.03 - 至今`）拆成可比较的月份区间。
 *
 * 复用 `period.ts` 而不是在这里再写一遍正则（AGENTS.md §2.1）：时间归一的口径必须与解析轨一致，
 * 否则同一份简历在「事实锁定」和「实体归属」上会给出两个答案。
 * 4.4-c 的年限比对是第二个调用方（同一把尺子），故对外可见；它给的 `end` 在「至今」时是
 * `OPEN_ENDED_MONTH` 这个**哨兵值**，只做归属排序可用，任何求和都要先夹到"今天"（见 `requirements-compare.ts`）。
 * @param periodText 时间段文本，缺失或认不出时返回 `null`
 * @returns 以月为单位的闭区间；一端都没有时为 `null`
 */
export function monthSpanOf(periodText: string | undefined): { start: number; end: number } | null {
  if (periodText === undefined || periodText === '') return null;
  const period = parsePeriod(periodText);
  const start = endpointToMonth(period.from);
  const end = period.isCurrent ? OPEN_ENDED_MONTH : (endpointToMonth(period.to) ?? start);
  if (start === null || end === null) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

/**
 * 「今天」在绝对月序号尺度上的位置（4.4-c 的年限比对要把「至今」的哨兵终点夹到这里）。
 *
 * 时间由调用方**显式**给（毫秒时间戳），本函数不读运行期现状：比对层要满足 4.4-07 的
 * 「同一输入两次运行 hash 相同」，隐式读时钟会让报告在跨月的那一刻莫名变红。
 * @param nowMs 时间戳（毫秒）
 * @returns 与 `endpointToMonth` 同尺度的绝对月序号（自己拼的 key 必然可解析，`0` 只是让类型闭合）
 */
export function monthIndexOf(nowMs: number): number {
  return endpointToMonth(monthKeyOf(nowMs)) ?? 0;
}

/**
 * 毫秒时间戳 → `YYYY-MM`（比对结果里"截至某年某月"的播报口径，与 `monthIndexOf` 同一份拼法）。
 * @param nowMs 时间戳（毫秒）
 * @returns 补零后的年月串
 */
export function monthKeyOf(nowMs: number): string {
  const date = new Date(nowMs);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * `YYYY` 或 `YYYY-MM` → 绝对月序号。
 *
 * 对外可见是给 4.4-c 用的第二个调用方：它要把"今天"折算到**同一个**月序号尺度上再夹住「至今」的哨兵值，
 * 自己再写一份 `年 × 12 + 月` 就是造第二把尺子（AGENTS.md §2.2）。
 * @param endpoint 归一化后的时间端点
 * @returns 年 × 12 + 月（只有年时按 1 月）；端点为空返回 `null`
 */
export function endpointToMonth(endpoint: string | null): number | null {
  if (endpoint === null) return null;
  const matched = /^(\d{4})(?:-(\d{2}))?$/.exec(endpoint);
  if (matched === null) return null;
  const year = Number(matched[1]);
  const month = matched[2] === undefined ? 1 : Number(matched[2]);
  return year * 12 + month;
}

/**
 * 两个月份的区间的重叠月数。
 * @param left 左区间
 * @param right 右区间
 * @returns 重叠的月份数；不重叠为 0
 */
function overlapMonths(left: { start: number; end: number }, right: { start: number; end: number }): number {
  return Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start) + 1);
}

/**
 * 切一条技能自由文本。
 *
 * 先按行、再按分隔符，并剥掉列表记号——`skills` 区块在文档模型里整块存成一个 `text` 字段
 * （`sections.ts` 对 summary / skills 不做条目内切分），所以「一项技能」的粒度只能在这里恢复，
 * 否则 4.4 的缺口比对只能拿一整段自由文本去匹配关键词。
 * @param text 区块内的自由文本
 * @returns 单项技能串，已去空白与重复
 */
function splitSkills(text: string): string[] {
  const skills: string[] = [];
  for (const line of text.split('\n')) {
    const withoutMarker = line.replace(/^\s*[-*•·]\s*/, '');
    for (const fragment of withoutMarker.split(SKILL_SEPARATOR)) {
      const skill = normalizeText(fragment);
      if (skill !== '') skills.push(skill);
    }
  }
  return Array.from(new Set(skills));
}

/**
 * 由一份 P3.1 简历文档派生知识库实体（spec 4.2-01 的派生映射，plan §1.4 裁定二）。
 *
 * 输出顺序：按文档里区块的原始顺序、区块内条目顺序遍历，因此**重复调用完全一致**（4.4-07 依赖这一点）。
 * 同一种类里载荷规范化后相同的实体只保留第一条（成果文本与所属经历正文重复的场景靠这条收敛）。
 * @param document 已通过 P3.1 校验的简历文档
 * @returns 实体草案列表；空文档返回空列表，不报错
 */
export function deriveEntities(document: ResumeDocument): readonly KbEntityDraft[] {
  const experiences = document.sections
    .filter((section) => section.kind === 'experience')
    .flatMap((section) => section.entries)
    .map((entry) => ({
      entityId: entityIdOf(document.id, 'experience', entry.id),
      span: monthSpanOf(payloadOfEntry(entry).period),
    }));

  const drafts: KbEntityDraft[] = [];
  const seen = new Set<string>();

  const push = (draft: KbEntityDraft): void => {
    const dedupKey = `${draft.kind}\u0001${draft.normalizedHash}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    drafts.push(draft);
  };

  for (const section of document.sections) {
    for (const entry of section.entries) {
      const payload = payloadOfEntry(entry);

      if (section.kind === 'experience' || section.kind === 'project') {
        const kind: KbEntityKind = section.kind === 'experience' ? 'experience' : 'project';
        const ownSpan = monthSpanOf(payload.period);
        const parentId = kind === 'project' ? mostOverlappingExperience(experiences, ownSpan) : null;
        push({
          entityId: entityIdOf(document.id, kind, entry.id),
          kind,
          parentId,
          sourceDocId: document.id,
          payload,
          normalizedHash: payloadHashOf(kind, payload),
        });
      }

      // 成果不是区块：任何条目里被锁成 `achievement` 事实的字段都要能单独被引用（4.5-06 的证据粒度）。
      const achievementValue = payload.achievement;
      if (achievementValue !== undefined && normalizeText(achievementValue) !== '') {
        const owner =
          section.kind === 'experience' || section.kind === 'project'
            ? entityIdOf(document.id, section.kind, entry.id)
            : null;
        push({
          entityId: entityIdOf(document.id, 'achievement', `${entry.id}#achievement`),
          kind: 'achievement',
          parentId: owner,
          sourceDocId: document.id,
          payload: { text: achievementValue },
          normalizedHash: payloadHashOf('achievement', { text: achievementValue }),
        });
      }

      if (section.kind === 'skills') {
        const rawText = payload.text ?? '';
        splitSkills(rawText).forEach((skill, skillIndex) => {
          push({
            entityId: entityIdOf(document.id, 'skill', `${entry.id}#s${String(skillIndex + 1)}`),
            kind: 'skill',
            parentId: null,
            sourceDocId: document.id,
            payload: { text: skill },
            normalizedHash: payloadHashOf('skill', { text: skill }),
          });
        });
      }
    }
  }
  return drafts;
}

/**
 * 给一条项目找它最可能归属的经历（时间重叠最多的那条）。
 *
 * 只按时间重叠判定，**不按公司名相同判定**：中文简历里「集团 / 子公司 / 事业部」的写法差异太大，
 * 按名字匹配会把项目挂到错误的经历上——挂错比不挂更坏（宁缺勿造，同 4.1-04 的口径）。
 * @param experiences 同文档内的经历实体及其时间区间
 * @param projectSpan 项目的时间区间，认不出时间为 `null`
 * @returns 重叠最多的经历 id；无时间或无重叠时 `null`
 */
function mostOverlappingExperience(
  experiences: readonly { entityId: string; span: { start: number; end: number } | null }[],
  projectSpan: { start: number; end: number } | null,
): string | null {
  if (projectSpan === null) return null;
  let bestId: string | null = null;
  let bestOverlap = 0;
  for (const experience of experiences) {
    if (experience.span === null) continue;
    const overlap = overlapMonths(projectSpan, experience.span);
    // 重叠数相同时取 id 字典序小的一条：不依赖遍历顺序，两次派生必然同一个答案。
    if (
      overlap > bestOverlap ||
      (overlap === bestOverlap && overlap > 0 && (bestId === null || experience.entityId < bestId))
    ) {
      bestOverlap = overlap;
      bestId = experience.entityId;
    }
  }
  return bestId;
}

/**
 * 手工新建实体的 id（不由文档派生，因此没有可复算的槽位）。
 * @returns `kb-` + uuid
 */
export function manualEntityId(): string {
  return `kb-${randomUUID()}`;
}
