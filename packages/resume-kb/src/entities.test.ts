/**
 * 派生规则的单元测试（spec 4.2-01 / 4.2-02，plan §1.4 裁定二）。
 *
 * 全部在内存里构造 P3.1 文档，不碰 SQLite 也不碰 cordis：这一层的判据是「哪一段简历文本变成哪个实体」，
 * 只有脱离装配才能逐条断言到字段级。语料是**明显虚构**的中文简历（编造的公司名与号段），
 * 不含任何真实个人信息（AGENTS.md §8.5 / 数据纪律）。
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
import { deriveEntities, payloadHashOf, type KbEntityDraft } from './entities.js';

const NOW_MS = 1_700_000_000_000;

/**
 * 构造一条条目。
 * @param kind 区块种类（决定哪些键被事实锁定）
 * @param id 条目 id（文档模型里按区块内序号生成，实体槽位取自它）
 * @param values 键值对
 * @returns 带正确 `locked` / `factKey` 的条目
 */
function makeEntry(kind: SectionKind, id: string, values: Record<string, string>): Entry {
  return { id, fields: Object.entries(values).map(([key, value]) => makeField(kind, key, value)) };
}

/**
 * 构造一个区块。
 * @param kind 区块种类
 * @param title 区块标题（原文，界面本地化不参与派生）
 * @param entries 条目列表
 * @returns 可直接放进 `sections` 的区块
 */
function makeSection(kind: SectionKind, title: string, entries: Entry[]): Section {
  return { id: kind, kind, title, entries };
}

/**
 * 组装一份含六类区块的虚构简历。
 * @param docId 文档 id（实体 id 由它钉住）
 * @returns 通过类型检查的完整文档
 */
function makeDoc(docId = 'resume-demo'): ResumeDocument {
  const sections = [
    makeSection('summary', '个人简介', [
      makeEntry('summary', 'summary-1', { text: '五年后端工程师，专注高并发服务。' }),
    ]),
    makeSection('experience', '工作经历', [
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
    makeSection('project', '项目经历', [
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
      // 首行没有可认出的时间：不猜归属（宁缺勿造，与 4.1-04 同口径）。
      makeEntry('project', 'project-3', {
        company: '内部工具集',
        role: '维护者',
        achievement: '沉淀 12 个可复用脚本。',
      }),
    ]),
    makeSection('skills', '技能', [
      makeEntry('skills', 'skills-1', { text: 'TypeScript、Node.js / Electron\n- Go\nTypeScript' }),
    ]),
    makeSection('education', '教育经历', [
      makeEntry('education', 'education-1', {
        school: '东海大学',
        degree: '学士',
        major: '计算机科学与技术',
        period: '2015.09 - 2019.06',
      }),
    ]),
    makeSection('campus', '校园经历', [
      makeEntry('campus', 'campus-1', {
        company: '校算法竞赛组委会',
        role: '部长',
        period: '2016.09 - 2018.06',
        achievement: '组织 300 人规模的校赛。',
      }),
    ]),
  ];
  return { ...createEmptyDocument(docId, NOW_MS), sections };
}

/** 按种类取实体列表。 */
function kindOf(drafts: readonly KbEntityDraft[], kind: KbEntityDraft['kind']): KbEntityDraft[] {
  return drafts.filter((draft) => draft.kind === kind);
}

describe('四类实体的派生映射（裁定二）', () => {
  it('经历与项目按整条 entry 建实体，技能与成果按更细的粒度建', () => {
    const drafts = deriveEntities(makeDoc());
    expect(kindOf(drafts, 'experience').map((draft) => draft.payload.company)).toEqual(['星桥科技', '沧海数据']);
    expect(kindOf(drafts, 'project')).toHaveLength(3);
    expect(kindOf(drafts, 'skill').map((draft) => draft.payload.text)).toEqual([
      'TypeScript',
      'Node.js',
      'Electron',
      'Go',
    ]);
    // 成果不是区块：两条经历 + 三个项目 + 一条校园各出一条，共 6 条。
    expect(kindOf(drafts, 'achievement')).toHaveLength(6);
  });

  it('summary / education / campus 不建实体行（裁定二里写死的已知后果，不是漏派生）', () => {
    const drafts = deriveEntities(makeDoc());
    expect(drafts.some((draft) => draft.payload.school !== undefined)).toBe(false);
    expect(drafts.some((draft) => draft.payload.text === '五年后端工程师，专注高并发服务。')).toBe(false);
    // 但校园经历里的成果仍然是一条可引用证据（它的 parentId 为 null，因为 campus 本身不建实体）。
    const campusAchievement = kindOf(drafts, 'achievement').find(
      (draft) => draft.payload.text === '组织 300 人规模的校赛。',
    );
    expect(campusAchievement?.parentId).toBeNull();
  });

  it('项目挂到时间重叠最多的经历；认不出时间就不挂，而不是猜一条', () => {
    const drafts = deriveEntities(makeDoc());
    const experiences = kindOf(drafts, 'experience');
    const projects = kindOf(drafts, 'project');
    expect(projects[0]?.parentId).toBe(experiences[0]?.entityId);
    expect(projects[1]?.parentId).toBe(experiences[1]?.entityId);
    expect(projects[2]?.parentId).toBeNull();
  });

  it('成果的 parentId 指向承载它的经历 / 项目实体，供级联与证据链使用（4.2-02 引用完整性）', () => {
    const drafts = deriveEntities(makeDoc());
    const experiences = kindOf(drafts, 'experience');
    const ids = new Set(drafts.map((draft) => draft.entityId));
    for (const achievement of kindOf(drafts, 'achievement')) {
      if (achievement.parentId === null) continue;
      // 引用完整性：任何非空 parentId 都必须能在同一批派生结果里找到，否则 4.5-06 的证据反查会指向空行。
      expect(ids.has(achievement.parentId)).toBe(true);
    }
    const firstExperienceAchievement = kindOf(drafts, 'achievement').find(
      (draft) => draft.payload.text === '主导订单服务重构，P99 延迟下降 40%。',
    );
    expect(firstExperienceAchievement?.parentId).toBe(experiences[0]?.entityId);
  });

  it('同一文档内规范化后重复的成果只留第一条（经历正文与成果字段天然重复）', () => {
    const doc = makeDoc();
    const duplicated = makeEntry('experience', 'experience-3', {
      company: '北辰云',
      role: '工程师',
      period: '2020.01 - 2020.12',
      // 与 experience-1 的成果逐字相同。
      achievement: '主导订单服务重构，P99 延迟下降 40%。',
    });
    doc.sections[1]!.entries.push(duplicated);
    const drafts = deriveEntities(doc);
    const sameText = kindOf(drafts, 'achievement').filter(
      (draft) => draft.payload.text === '主导订单服务重构，P99 延迟下降 40%。',
    );
    expect(sameText).toHaveLength(1);
    // 但经历实体本身不去重：载荷含公司/职位/时间，三条就是三条。
    expect(kindOf(drafts, 'experience')).toHaveLength(3);
  });

  it('每条派生实体都带着它出自哪条 entry，证据反查不必重算槽位语法（4.5-02 / 4.5-06 的前提）', () => {
    const doc = makeDoc();
    const drafts = deriveEntities(doc);
    const entryIds = new Set(doc.sections.flatMap((section) => section.entries.map((entry) => entry.id)));

    // 反向也成立：派生结果的 entryId 必须全部是文档里真实存在的条目 id（不能是 `experience-1#achievement` 这类槽位串）。
    for (const draft of drafts) expect(entryIds.has(draft.entryId ?? '')).toBe(true);

    // 带后缀的槽位（成果 / 技能）回指到承载它的 entry，而不是自己造一个 id。
    const achievement = kindOf(drafts, 'achievement').find(
      (draft) => draft.payload.text === '主导订单服务重构，P99 延迟下降 40%。',
    );
    expect(achievement?.entryId).toBe('experience-1');
    expect(kindOf(drafts, 'skill').map((draft) => draft.entryId)).toEqual([
      'skills-1',
      'skills-1',
      'skills-1',
      'skills-1',
    ]);
    // 同一条 entry 派生出的多条实体（经历本体 + 它的成果）在 id 上必然不同，否则重排时无从分辨改的是哪一处。
    expect(achievement?.entityId).not.toBe(
      kindOf(drafts, 'experience').find((draft) => draft.entryId === 'experience-1')?.entityId,
    );
  });
});

describe('稳定 id（spec 4.2-02）', () => {
  it('同一份文档重复派生得到完全相同的一批 id 与顺序', () => {
    const first = deriveEntities(makeDoc());
    const second = deriveEntities(makeDoc());
    expect(second.map((draft) => draft.entityId)).toEqual(first.map((draft) => draft.entityId));
  });

  it('内容相同但来源文档不同 → id 不同：证据必须钉在一份具体的简历上', () => {
    const docA = makeDoc('resume-aaaa');
    const docB = makeDoc('resume-bbbb');
    const idsA = deriveEntities(docA).map((draft) => draft.entityId);
    const idsB = deriveEntities(docB).map((draft) => draft.entityId);
    expect(idsA.some((id) => idsB.includes(id))).toBe(false);
  });

  it('载荷哈希把连续空白折叠、并按键名排序，同一内容换个键顺序不会裂成两行', () => {
    const forward = payloadHashOf('experience', { company: '星桥科技', role: '后端 工程师' });
    const reversed = payloadHashOf('experience', { role: '后端   工程师', company: ' 星桥科技 ' });
    expect(reversed).toBe(forward);
    // 种类参与哈希：同样文本在 skill 与 achievement 下不该互相吃掉。
    expect(payloadHashOf('achievement', { company: '星桥科技', role: '后端工程师' })).not.toBe(forward);
  });
});
