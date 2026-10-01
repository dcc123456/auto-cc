/**
 * 反查算法的用例（spec 4.2-03）。
 *
 * 全部离线：`rankEvidence` / `tokenize` 都不碰库、不碰 cordis，「给定句子命中正确项目」这件事
 * 只有在没有装配噪音的情况下才断言得干净。带库的接线用例在 `profile-service.test.ts` 的
 * 「证据反查」一节（那里验的是候选来自库里、阈值来自配置）。
 *
 * 语料仍是自造虚构简历（AGENTS.md §7.2：不打真实平台，也不引用任何真实公司）。
 */
import { describe, expect, it } from 'vitest';
import type { EvidenceTarget } from './evidence.js';
import { rankEvidence } from './evidence.js';
import { tokenize } from './tokenize.js';

const ORDER_EXPERIENCE: EvidenceTarget = {
  entityId: 'kb-order',
  kind: 'experience',
  text: '主导订单服务重构，P99 延迟下降 40%。',
};

/** 取选项的简写，避免每条用例都重复两个数字。 */
const options = (topK: number, minScore: number) => ({ topK, minScore });

describe('分词', () => {
  it('中文给相邻二字组、拉丁给单词、全角折半角并转小写', () => {
    const tokens = tokenize('高并发 ＴｙｐｅＳｃｒｉｐｔ 优化');
    expect(tokens.has('高并')).toBe(true);
    expect(tokens.has('并发')).toBe(true);
    expect(tokens.has('typescript')).toBe(true);
    expect(tokens.has('优化')).toBe(true);
  });

  it('丢掉单字母与标点，只保留可用的 token', () => {
    const tokens = tokenize('C 语言、3 年');
    expect(tokens.has('c')).toBe(false);
    expect(tokens.has('3')).toBe(false);
    expect(tokens.has('语言')).toBe(true);
  });

  it('单个汉字成串时退化为单字 token，否则永远匹配不上', () => {
    expect(tokenize('剑').has('剑')).toBe(true);
  });
});

describe('rankEvidence 的命中判定', () => {
  it('陈述整段落在一条长实体里时给满分并标 contains', () => {
    const hits = rankEvidence('主导订单服务重构', [ORDER_EXPERIENCE], options(5, 0.34));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.entityId).toBe('kb-order');
    expect(hits[0]?.reason).toBe('contains');
    expect(hits[0]?.score).toBe(1);
  });

  it('短实体（技能）被点名时同样算 contains——走的是实体覆盖率那一侧', () => {
    const skill: EvidenceTarget = { entityId: 'kb-skill-ts', kind: 'skill', text: 'TypeScript' };
    const hits = rankEvidence('精通 TypeScript 与高并发网关', [skill, ORDER_EXPERIENCE], options(5, 0.34));
    expect(hits[0]?.entityId).toBe('kb-skill-ts');
    expect(hits[0]?.reason).toBe('contains');
  });

  it('只沾一个词时是 overlap 而不是 contains', () => {
    // 陈述分词出 6 个二字组，实体里只有 `订单` 一个对得上 → 覆盖率 1/6，两边都不构成包含。
    const hits = rankEvidence('订单系统的性能', [ORDER_EXPERIENCE], options(5, 0.05));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.reason).toBe('overlap');
    expect(hits[0]?.score).toBe(0.1667);
    expect(hits[0]?.matchedTokens).toEqual(['订单']);
  });

  it('按 token 比而不是按子串比：技能 Go 不会被 logo 里的两个字母命中', () => {
    const skill: EvidenceTarget = { entityId: 'kb-go', kind: 'skill', text: 'Go' };
    expect(rankEvidence('负责 logo 设计', [skill], options(5, 0.01))).toEqual([]);
  });

  it('低于 minScore 的候选被丢掉——沾边不等于有证据', () => {
    expect(rankEvidence('订单系统的性能', [ORDER_EXPERIENCE], options(5, 0.34))).toEqual([]);
  });
});

describe('rankEvidence 的确定性', () => {
  const tieLeft: EvidenceTarget = { entityId: 'kb-b', kind: 'achievement', text: '发布流水线压缩' };
  const tieRight: EvidenceTarget = { entityId: 'kb-a', kind: 'achievement', text: '发布流水线压缩' };

  it('同分按 id 升序，与候选传入顺序无关', () => {
    const claim = '发布流水线压缩';
    const forward = rankEvidence(claim, [tieLeft, tieRight], options(5, 0.34)).map((hit) => hit.entityId);
    const backward = rankEvidence(claim, [tieRight, tieLeft], options(5, 0.34)).map((hit) => hit.entityId);
    expect(forward).toEqual(['kb-a', 'kb-b']);
    expect(backward).toEqual(forward);
  });

  it('topK 截断保留分数高的，不被截断的那条排在前面', () => {
    const weak: EvidenceTarget = { entityId: 'kb-weak', kind: 'experience', text: '订单系统的日常维护与性能观察' };
    const hits = rankEvidence('主导订单服务重构', [ORDER_EXPERIENCE, weak], options(1, 0.01));
    expect(hits.map((hit) => hit.entityId)).toEqual(['kb-order']);
  });

  it('同一输入两次调用结果逐字相等（含 matchedTokens 的顺序）', () => {
    const claim = '主导订单服务重构，延迟下降';
    const first = rankEvidence(claim, [ORDER_EXPERIENCE], options(5, 0.34));
    expect(rankEvidence(claim, [ORDER_EXPERIENCE], options(5, 0.34))).toEqual(first);
    expect(first[0]?.matchedTokens).toEqual([...(first[0]?.matchedTokens ?? [])].sort());
  });
});

describe('查无支撑是正常态而不是失败', () => {
  it('空陈述返回空数组，不抛错', () => {
    expect(rankEvidence('', [ORDER_EXPERIENCE], options(5, 0.34))).toEqual([]);
    expect(rankEvidence('！！！', [ORDER_EXPERIENCE], options(5, 0.34))).toEqual([]);
  });

  it('载荷为空的实体被跳过（它没有任何可比内容）', () => {
    const empty: EvidenceTarget = { entityId: 'kb-empty', kind: 'skill', text: '' };
    expect(rankEvidence('主导订单服务重构', [empty], options(5, 0.01))).toEqual([]);
  });
});
