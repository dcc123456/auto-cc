/**
 * 重排腿的单元测试（spec 4.5-02，plan §4.5 判据一）。
 *
 * 全部在内存里构造，不起 store、不碰 cordis：判据是「4.4 的那份读数怎么变成顺序与依据」，
 * 只有脱离装配才能逐条断言到下标。语料是**明显虚构**的中文简历（编造的公司名与号段），
 * 不含任何真实个人信息（AGENTS.md §8.5）。
 *
 * 实体一律经 `deriveEntities` 真派生，而不是手搓 id：本片的映射建立在「证据 id → entryId」上，
 * 伪造 id 会让测试与生产同时失真（4.5-a 那条 `entryId` 硬约束在这里被真正消费）。
 */
import {
  createEmptyDocument,
  makeField,
  type Entry,
  type ResumeDocument,
  type Section,
  type SectionKind,
} from '@auto-cc/plugin-resume-doc';
import { describe, expect, it } from 'vitest';
import { deriveEntities, type KbEntityDraft, type KbEntityKind } from './entities.js';
import { preservesAllEntries, reorderDocument } from './generate-reorder.js';
import type { GapEvidence, GapRequirementView } from './requirements-compare.js';
import type { RequirementKind } from './requirements.js';

const NOW_MS = 1_700_000_000_000;

/**
 * 构造一条条目。
 * @param kind 区块种类（决定哪些键被事实锁定）
 * @param id 条目 id（重排的依据按它定位）
 * @param values 键值对
 * @returns 带正确 `locked` / `factKey` 的条目
 */
function makeEntry(kind: SectionKind, id: string, values: Record<string, string>): Entry {
  return { id, fields: Object.entries(values).map(([key, value]) => makeField(kind, key, value)) };
}

/**
 * 构造一个区块。
 * @param kind 区块种类
 * @param entries 条目列表（顺序即基线顺序）
 * @returns 可直接放进 `sections` 的区块
 */
function makeSection(kind: SectionKind, entries: Entry[]): Section {
  return { id: kind, kind, title: `标题-${kind}`, entries };
}

/**
 * 组装一份四区块的虚构简历：基线顺序 summary → experience → project → education。
 * @returns 通过类型检查的完整文档
 */
function makeDoc(): ResumeDocument {
  const sections = [
    makeSection('summary', [makeEntry('summary', 'summary-1', { text: '五年后端工程师，专注高并发服务。' })]),
    makeSection('experience', [
      makeEntry('experience', 'experience-1', {
        company: '星桥科技',
        role: '后端工程师',
        period: '2021.03 - 2024.06',
        achievement: '主导订单服务重构，P99 延迟下降 40%。',
      }),
      makeEntry('experience', 'experience-2', {
        company: '沧海数据',
        role: '架构师',
        period: '2024.07 - 至今',
        achievement: '把发布流水线从 40 分钟压到 6 分钟。',
      }),
    ]),
    makeSection('project', [
      makeEntry('project', 'project-1', {
        company: '订单中台',
        role: '技术负责人',
        period: '2022.01 - 2023.12',
        achievement: '接口平均耗时下降 35%。',
      }),
      makeEntry('project', 'project-2', {
        company: '灰度平台',
        role: '发起人',
        period: '2024.09 - 2025.06',
        achievement: '上线回滚耗时压到 90 秒内。',
      }),
    ]),
    makeSection('education', [
      makeEntry('education', 'education-1', { school: '东海大学', degree: '学士', major: '计算机科学与技术' }),
    ]),
  ];
  return { ...createEmptyDocument('resume-demo', NOW_MS), sections };
}

/**
 * 取某条 entry 派生出的一条实体（按 kind 区分，经历条目同时有 experience 与 achievement 两条）。
 * @param drafts `deriveEntities` 的产出
 * @param entryId 条目 id
 * @param kind 实体种类
 * @returns 匹配的草案；找不到直接抛错——测试里的"没有这条实体"必须是显式失败而不是静默跳过
 */
function draftFor(drafts: readonly KbEntityDraft[], entryId: string, kind: KbEntityKind): KbEntityDraft {
  const matched = drafts.find((draft) => draft.entryId === entryId && draft.kind === kind);
  if (matched === undefined) throw new Error(`语料里没有 ${kind} 类的 ${entryId}`);
  return matched;
}

/**
 * 造一条证据引用（只填本片读到的字段，其余由 4.4 负责）。
 * @param draft 被引到的实体
 * @param score 强度
 * @param tokens 命中的 token
 * @returns `origin` 恒为 entity 的证据
 */
function makeEvidence(draft: KbEntityDraft, score: number, tokens: readonly string[] = []): GapEvidence {
  return {
    id: draft.entityId,
    origin: 'entity',
    kind: draft.kind,
    score,
    matchedTokens: [...tokens].sort(),
  };
}

/**
 * 造一条三态行。
 * @param label 要求代表词
 * @param kind 要求类别
 * @param evidence 证据链
 * @returns 界面看得懂的最小 `GapRequirementView`
 */
function makeRow(label: string, kind: RequirementKind, evidence: readonly GapEvidence[]): GapRequirementView {
  const best = evidence.length === 0 ? null : Math.max(...evidence.map((item) => item.score));
  return {
    item: { kind, label, quote: label, start: 0, end: label.length, years: null, via: 'lexicon' },
    state: best === null ? 'missing' : 'matched',
    evidence,
    bestScore: best,
    suggestion: best === null ? { key: 'add_evidence', params: { label } } : null,
  };
}

/** 取区块的条目 id 序列（顺序断言都读这一句，比嵌套下标好核对）。 */
function entryIds(section: Section | undefined): string[] {
  return (section?.entries ?? []).map((entry) => entry.id);
}

describe('4.5-02 判据一：顺序由 4.4 的读数算出', () => {
  const doc = makeDoc();
  const drafts = deriveEntities(doc);

  it('拿到证据的条目被提前，零分条目保持原序接在后面，被挤动的那些也如实出一条依据', () => {
    const rows = [
      makeRow('Kubernetes', 'hard_skill', [makeEvidence(draftFor(drafts, 'experience-2', 'achievement'), 0.9)]),
    ];
    const result = reorderDocument(doc, rows, drafts);

    expect(result.sections.map((section) => section.id)).toEqual(['experience', 'summary', 'project', 'education']);
    expect(entryIds(result.sections[0])).toEqual(['experience-2', 'experience-1']);

    const movedEntry = result.bases.find((basis) => basis.id === 'experience-2' && basis.level === 'entry');
    expect(movedEntry).toMatchObject({ fromIndex: 1, toIndex: 0, score: 0.9 });
    expect(movedEntry?.hits).toHaveLength(1);
    // 被挤后的条目同样是"真正换了位置的对象"：分数 0、依据为空数组，界面因此能说"它没拿到据"而不是"它没动"。
    const pushedBack = result.bases.find((basis) => basis.id === 'experience-1' && basis.level === 'entry');
    expect(pushedBack).toMatchObject({ fromIndex: 0, toIndex: 1, score: 0, hits: [] });
  });

  it('平分保持基线原序：不做二次猜测', () => {
    const rows = [
      makeRow('Kubernetes', 'hard_skill', [
        makeEvidence(draftFor(drafts, 'experience-1', 'achievement'), 0.7),
        makeEvidence(draftFor(drafts, 'experience-2', 'achievement'), 0.7),
      ]),
    ];
    const result = reorderDocument(doc, rows, drafts);
    expect(entryIds(result.sections[0])).toEqual(['experience-1', 'experience-2']);
    expect(result.bases.filter((basis) => basis.level === 'entry')).toHaveLength(0);
  });

  it('区块分取其内条目的最高分而不是求和：两条各 0.4 的项目不该压过一条 0.6 的经历', () => {
    const rows = [
      makeRow('高并发', 'hard_skill', [
        makeEvidence(draftFor(drafts, 'project-1', 'project'), 0.4),
        makeEvidence(draftFor(drafts, 'project-2', 'project'), 0.4),
        makeEvidence(draftFor(drafts, 'experience-1', 'experience'), 0.6),
      ]),
    ];
    const result = reorderDocument(doc, rows, drafts);
    expect(result.sections[0]?.id).toBe('experience');
    expect(result.sections[1]?.id).toBe('project');
  });

  it('同一条目被多条要求撑住时取最强那次读数，依据按强度降序排好', () => {
    const achievement = draftFor(drafts, 'experience-2', 'achievement');
    const rows = [
      makeRow('CI/CD', 'hard_skill', [makeEvidence(achievement, 0.4, ['流水线'])]),
      makeRow('Kubernetes', 'hard_skill', [makeEvidence(achievement, 0.9, ['kubernetes'])]),
    ];
    const result = reorderDocument(doc, rows, drafts);
    const basis = result.bases.find((item) => item.id === 'experience-2' && item.level === 'entry');
    expect(basis?.score).toBe(0.9);
    expect(basis?.hits.map((hit) => hit.label)).toEqual(['Kubernetes', 'CI/CD']);
    // 依据带着界面要显示的全部读数：token 与类别都从 4.4 原样搬过来，不再问一次。
    expect(basis?.hits[1]).toMatchObject({ kind: 'hard_skill', score: 0.4, tokens: ['流水线'] });
  });

  it('同一份读数换个行序喂进来，产物逐字节相同（4.4-07 的确定性口径延伸到这里）', () => {
    const achievement = draftFor(drafts, 'experience-2', 'achievement');
    const forward = [
      makeRow('CI/CD', 'hard_skill', [makeEvidence(achievement, 0.4, ['流水线'])]),
      makeRow('Kubernetes', 'hard_skill', [makeEvidence(achievement, 0.9, ['kubernetes'])]),
    ];
    const backward = [...forward].reverse();
    expect(JSON.stringify(reorderDocument(doc, backward, drafts))).toBe(
      JSON.stringify(reorderDocument(doc, forward, drafts)),
    );
  });

  it('缺失项（证据恒为空）不参与打分，也不产生任何位移', () => {
    const result = reorderDocument(doc, [makeRow('Rust', 'hard_skill', [])], drafts);
    expect(result.sections.every((section, index) => section === doc.sections[index])).toBe(true);
    expect(result.bases).toHaveLength(0);
    expect(result.movedSections).toBe(0);
    expect(result.movedEntries).toBe(0);
  });

  it('回指不到本文档的证据一律忽略：手工实体、别份简历的实体、学历区块切片', () => {
    // 库里的手工实体：id 真实存在（4.2-d 的手工入口产的），但 `entryId` 是 null，对不上任何条目
    const manual: GapEvidence = {
      id: 'kb-0000000000000000',
      origin: 'entity',
      kind: 'achievement',
      score: 0.95,
      matchedTokens: ['kubernetes'],
    };
    // 别份简历派生的实体：id 由 sourceDocId 钉住，在本文档的草案表里查不到
    const foreign = deriveEntities({ ...doc, id: 'resume-other' })[0];
    if (foreign === undefined) throw new Error('语料变了：另一份简历没派生出任何实体');
    const rows = [
      makeRow('Kubernetes', 'hard_skill', [manual, makeEvidence(foreign, 0.9)]),
      // 学历那条证据的 id 是 `kb_chunks` 的切片 id，origin 也不是 entity（4.2 裁定二的已知后果）
      makeRow('本科', 'education', [
        { id: 'chunk-education-1', origin: 'section_chunk', kind: 'education', score: 1, matchedTokens: [] },
      ]),
    ];
    const result = reorderDocument(doc, rows, drafts);
    expect(result.bases).toHaveLength(0);
  });

  it('summary / education 永远拿不到分：它们不产实体行，因此只会被挤后而不会被提前', () => {
    const rows = [
      makeRow('Kubernetes', 'hard_skill', [makeEvidence(draftFor(drafts, 'experience-1', 'experience'), 0.8)]),
    ];
    const result = reorderDocument(doc, rows, drafts);
    expect(result.sections.map((section) => section.id).indexOf('summary')).toBeGreaterThan(0);
    const summaryBasis = result.bases.find((basis) => basis.level === 'section' && basis.id === 'summary');
    expect(summaryBasis?.score).toBe(0);
    expect(summaryBasis?.hits).toHaveLength(0);
  });
});

describe('4.5-01 重排的不变量：只换序，不减内容', () => {
  it('任何一次重排后条目数与字段数都不变', () => {
    const doc = makeDoc();
    const drafts = deriveEntities(doc);
    const rows = [
      makeRow('Kubernetes', 'hard_skill', [
        makeEvidence(draftFor(drafts, 'project-2', 'achievement'), 0.95),
        makeEvidence(draftFor(drafts, 'experience-2', 'experience'), 0.5),
      ]),
    ];
    const result = reorderDocument(doc, rows, drafts);
    expect(preservesAllEntries(doc, result.sections)).toBe(true);
  });

  it('谁删了条目，这条断言当场发红（4.5-07 的结构面兜底）', () => {
    const doc = makeDoc();
    const shrunk: ResumeDocument = { ...doc, sections: doc.sections.slice(0, 2) };
    expect(preservesAllEntries(doc, shrunk.sections)).toBe(false);
  });
});
