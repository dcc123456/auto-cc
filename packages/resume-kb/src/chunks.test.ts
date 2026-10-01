/**
 * 检索切片派生规则的单元测试（spec 4.3-11，plan §4.3 切片拆分的 4.3-a）。
 *
 * 与 `entities.test.ts` 同样的理由打离线：这一层的判据是「哪段文本变成一个可检索单元、
 * 它的预分词长什么样」，只有脱离 SQLite 与装配才能逐 token 断言。
 * 语料是自造虚构简历，不含真实个人信息（AGENTS.md §8.5）。
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
import { deriveSectionChunks, entityChunkOf, indexTokens } from './chunks.js';
import { evidenceTextOf } from './evidence.js';
import { tokenSequence } from './tokenize.js';

const NOW_MS = 1_700_000_000_000;

/**
 * 构造一条条目。
 * @param kind 区块种类（决定字段的事实锁定标记）
 * @param id 条目 id（切片槽位取自它）
 * @param values 键值对
 * @returns 带正确 `locked` / `factKey` 的条目
 */
function makeEntry(kind: SectionKind, id: string, values: Record<string, string>): Entry {
  return { id, fields: Object.entries(values).map(([key, value]) => makeField(kind, key, value)) };
}

/**
 * 构造一个区块。
 * @param kind 区块种类
 * @param entries 条目列表
 * @returns 可直接放进 `sections` 的区块
 */
function makeSection(kind: SectionKind, entries: Entry[]): Section {
  return { id: kind, kind, title: kind, entries };
}

/**
 * 构造一份只改 `sections` 的文档。
 * @param sections 区块列表
 * @param id 文档 id
 * @returns 结构合法的 P3.1 文档
 */
function makeDocument(sections: Section[], id = 'resume-test'): ResumeDocument {
  return { ...createEmptyDocument(id, NOW_MS), sections };
}

describe('indexTokens：写入侧预分词', () => {
  it('中文按重叠二字组切分并以空格连接', () => {
    expect(indexTokens('主导订单服务重构')).toBe('主导 导订 订单 单服 服务 务重 重构');
  });

  it('重复出现的二字组保留重复（bm25 的词频维度靠它，spike 轮次四 A 实测去重会改变排序）', () => {
    expect(indexTokens('订单订单')).toBe('订单 单订 订单');
  });

  it('单字成串时退化为单字 token，否则「剑」这种技能名永远匹配不上', () => {
    expect(indexTokens('剑')).toBe('剑');
  });

  it('拉丁词转小写、按非字母数字切段，单字母丢弃（`c` 语言不该在 `logo` 上误命中）', () => {
    expect(indexTokens('c 语言与 Go')).toBe('语言 言与 go');
  });

  it('全角与大小写先归一再切（NFKC），所以「ＱＰＳ」与「qps」同一把尺子', () => {
    expect(indexTokens('ＱＰＳ')).toBe('qps');
  });

  it('切不出 token 的文本给空串而不是报错——切片仍然入库，只是永远检索不到', () => {
    expect(indexTokens('！！！')).toBe('');
    expect(indexTokens('')).toBe('');
  });

  it('与 `tokenize()` 同源：集合是序列去掉重复，两边不会用不同的尺子', () => {
    const text = '高并发场景下的缓存预热';
    expect([...new Set(tokenSequence(text))].join(' ')).toBe(indexTokens(text));
  });
});

describe('entityChunkOf：实体级切片（4.3-11 的 chunk 边界=实体边界）', () => {
  it('chunkId 直接取实体 id，命中切片即命中可引用实体', () => {
    const chunk = entityChunkOf({
      entityId: 'kb-0123456789abcdef',
      sourceDocId: 'resume-demo',
      payload: { company: '星桥科技', role: '后端工程师' },
    });
    expect(chunk.chunkId).toBe('kb-0123456789abcdef');
    expect(chunk.chunkKind).toBe('entity');
    expect(chunk.sectionKind).toBeNull();
    expect(chunk.sourceDocId).toBe('resume-demo');
  });

  it('正文与 4.2-03 的反查文本同一口径（键排序后拼接），界面解释与检索命中不会两套说法', () => {
    const payload = { role: '后端工程师', company: '星桥科技' };
    const chunk = entityChunkOf({ entityId: 'kb-1', sourceDocId: null, payload });
    expect(chunk.text).toBe(evidenceTextOf(payload));
    expect(chunk.tokens).toBe(tokenSequence(chunk.text).join(' '));
  });

  it('手工实体（sourceDocId 为 null）照样有切片，检索面不分派生与手工', () => {
    const chunk = entityChunkOf({ entityId: 'kb-manual', sourceDocId: null, payload: { text: '自学 Rust' } });
    expect(chunk.sourceDocId).toBeNull();
    expect(chunk.tokens).toContain('rust');
  });
});

describe('deriveSectionChunks：区块级切片（裁定二不建实体行的那三类的检索归宿）', () => {
  const document = makeDocument([
    makeSection('summary', [makeEntry('summary', 'summary-1', { text: '五年高并发后端经验' })]),
    makeSection('experience', [makeEntry('experience', 'experience-1', { company: '星桥科技' })]),
    makeSection('education', [
      makeEntry('education', 'education-1', { school: '沧海大学', major: '软件工程' }),
      makeEntry('education', 'education-2', { school: '继续教育学院' }),
    ]),
    makeSection('skills', [makeEntry('skills', 'skills-1', { text: 'Go、Rust' })]),
    makeSection('project', [makeEntry('project', 'project-1', { name: '订单平台' })]),
    makeSection('campus', [makeEntry('campus', 'campus-1', { role: '社团负责人' })]),
  ]);

  it('只出 summary / education / campus，其余三类一条不出（它们已经是指向实体的切片）', () => {
    const chunks = deriveSectionChunks(document);
    expect(chunks.map((chunk) => chunk.sectionKind)).toEqual(['summary', 'education', 'education', 'campus']);
    expect(chunks.every((chunk) => chunk.chunkKind === 'section')).toBe(true);
  });

  it('一个 entry 一条切片：粒度停在条目边界，没有滑窗也没有把整个区块并成一大段（4.3-11）', () => {
    const chunks = deriveSectionChunks(document);
    const entryCount = document.sections
      .filter((section) => ['summary', 'education', 'campus'].includes(section.kind))
      .reduce((sum, section) => sum + section.entries.length, 0);
    expect(chunks).toHaveLength(entryCount);
    expect(chunks.map((chunk) => chunk.chunkId)).toEqual([...new Set(chunks.map((chunk) => chunk.chunkId))]);
  });

  it('id 由「文档 + 区块种类 + 条目槽位」复算，重复派生完全一致，换一份文档则不撞车', () => {
    const first = deriveSectionChunks(document).map((chunk) => chunk.chunkId);
    expect(deriveSectionChunks(document).map((chunk) => chunk.chunkId)).toEqual(first);
    const other = deriveSectionChunks(makeDocument(document.sections, 'resume-other'));
    expect(other.map((chunk) => chunk.chunkId)).not.toEqual(first);
    expect(other.every((chunk) => chunk.sourceDocId === 'resume-other')).toBe(true);
  });

  it('正文取条目全部字段（教育这种多键条目不把 major 丢掉），预分词与正文同源', () => {
    const education = deriveSectionChunks(document).find((chunk) => chunk.sectionKind === 'education');
    expect(education?.text).toContain('软件工程');
    expect(education?.tokens).toBe(tokenSequence(education?.text ?? '').join(' '));
  });

  it('三类区块都不存在时返回空数组，不报错（3.1-04：缺失区块是正常态）', () => {
    expect(deriveSectionChunks(makeDocument([makeSection('experience', [makeEntry('experience', 'e1', {})])]))).toEqual(
      [],
    );
  });
});
