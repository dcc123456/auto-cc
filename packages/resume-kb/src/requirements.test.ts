/**
 * 词面拆解腿的离线用例（spec 4.4-01 / 4.4-07 / 4.4-08）。
 *
 * 语料是**写在文件里的本地样例**（4.4-08：JD 输入不得来自真实招聘平台，AGENTS.md §7.2），
 * 公司名与岗位都是虚构。这里断言的三件事各对应一条判据：
 * 1. 四类要求都能拆出来，且每条的 `quote` 能按 `start/end` 原样切回（4.4-01 的"带原文引用位置"）；
 * 2. 同一输入两次运行的 hash 相同（4.4-07 的稳定判据，用现成的 sha256 而不是"看起来一样"）；
 * 3. 误伤路径不产条目：`NoSQL` 不算 SQL、`2020年` 不算 20 年经验、`JavaScript` 不再重复产 Java。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  REQUIREMENT_KINDS,
  REQUIREMENT_LEXICON_VERSION,
  extractRequirementsLexically,
  type RequirementItem,
  type RequirementKind,
} from './requirements.js';

/** 固定样例 JD（虚构）：四类要求都在里面，另有三处刻意的误伤陷阱。 */
const SAMPLE_JD = [
  '后端工程师（星桥科技）',
  '工作职责：',
  '1. 负责订单与推荐链路的后端服务，技术栈以 Java / Go 为主，熟悉 Kafka、Redis、MySQL；',
  '2. 参与 NoSQL 与 SQL 的选型评审，能读懂英文文献；',
  '3. 2020 年 3 月 1 日团队成立，现要求 3 年以上相关工作经验，5 年及以上经验优先；',
  '任职要求：本科及以上学历，抗压能力强，具备良好的沟通表达能力，有带团队经验优先。',
  '加分项：写过 TypeScript、JavaScript，做过 CI/CD 与容器化部署，熟悉 Kubernetes（K8s）。',
].join('\n');

/** 每类上限给到 20 时的完整拆解（其余用例在它上面挑）。 */
const FULL_EXTRACT = extractRequirementsLexically(SAMPLE_JD, 20);

/**
 * 按四类取出的条目，供各条断言分别看自己的那一类。
 * @param kind 四类之一
 * @returns 该类的全部条目（保持 `items` 里的相对次序）
 */
function itemsOf(kind: RequirementKind): RequirementItem[] {
  return FULL_EXTRACT.items.filter((item) => item.kind === kind);
}

/**
 * 把拆解结果压成一个指纹，用于 4.4-07 的"两次运行一致"。
 * @param items 稳定序列
 * @returns 序列化的 sha256（十六进制）
 */
function fingerprint(items: readonly RequirementItem[]): string {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}

describe('词面拆解：四类要求与原文位置（spec 4.4-01）', () => {
  it('硬技能把 Java / Go / Kafka / Redis / MySQL / TypeScript / CI/CD / Kubernetes 都认出来', () => {
    const labels = itemsOf('hard_skill').map((item) => item.label);
    expect(labels).toEqual(expect.arrayContaining(['Java', 'Go', 'Kafka', 'Redis', 'MySQL', 'TypeScript']));
    // 别名归并：容器化 → Docker；K8s 与 Kubernetes 归成同一条（label 去重保早）。
    expect(labels).toEqual(expect.arrayContaining(['Docker', 'Kubernetes']));
    expect(labels.filter((label) => label === 'Kubernetes')).toHaveLength(1);
    expect(labels.filter((label) => label === 'CI/CD')).toHaveLength(1);
  });

  it('软技能、学历、经验年限各有产出', () => {
    const soft = itemsOf('soft_skill').map((item) => item.label);
    expect(soft).toEqual(expect.arrayContaining(['沟通表达', '抗压', '英语', '带团队']));
    expect(itemsOf('education').map((item) => item.label)).toContain('本科');
    const years = itemsOf('experience_years');
    expect(years.map((item) => item.years)).toEqual([3, 5]);
  });

  it('每条的 quote 都能按 start/end 从原文原样切回（界面高亮的依据，4.4-05 的前置）', () => {
    expect(FULL_EXTRACT.items.length).toBeGreaterThan(0);
    for (const item of FULL_EXTRACT.items) {
      expect(Number.isInteger(item.start)).toBe(true);
      expect(item.end).toBeGreaterThan(item.start);
      expect(SAMPLE_JD.slice(item.start, item.end)).toBe(item.quote);
      // 年限类的 quote 必带它自己的数值，否则界面读数与比对分叉。
      if (item.kind === 'experience_years') expect(item.quote).toContain(String(item.years));
      expect(item.via).toBe('lexicon');
    }
  });

  it('四类以外的 kind 不出现，且输出次序是四类表序 + 起始下标（稳定序列）', () => {
    const kinds = new Set(FULL_EXTRACT.items.map((item) => item.kind));
    for (const kind of kinds) expect(REQUIREMENT_KINDS).toContain(kind);
    const ranks = FULL_EXTRACT.items.map((item) => REQUIREMENT_KINDS.indexOf(item.kind));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });
});

describe('词面拆解的误伤与回落判据（spec 4.4-01 / 4.4-02）', () => {
  it('纯字母别名的词边界：NoSQL 里不捡 SQL，JavaScript 里不重复捡 Java，logo 里不捡 Go', () => {
    const labels = FULL_EXTRACT.items.map((item) => item.label);
    // 样例里 `NoSQL` 与独立的 `SQL` 都在：只应该出一次 SQL，且位置是那独立的一次。
    expect(labels.filter((label) => label === 'SQL')).toHaveLength(1);
    const sqlItem = FULL_EXTRACT.items.find((item) => item.label === 'SQL');
    expect(sqlItem?.start).toBe(SAMPLE_JD.indexOf('与 SQL') + 2);
    // `Java` 只认「以 Java / Go 为主」那一次——JavaScript 已经先占了那一格，长别名优先。
    const javaStarts = FULL_EXTRACT.items.filter((item) => item.label === 'Java').map((item) => item.start);
    expect(javaStarts).toEqual([SAMPLE_JD.indexOf('以 Java') + 2]);
    expect(labels).toContain('JavaScript');
  });

  it('纯字母别名的词边界：logo 里不捡 Go，Node 单独成词才捡', () => {
    const { items } = extractRequirementsLexically('这个岗位做过 logo 设计即可，不需要写代码。', 20);
    expect(items.map((item) => item.label)).not.toContain('Go');
    const withNode = extractRequirementsLexically('熟练使用 Node 与 npm。', 20);
    expect(withNode.items.map((item) => item.label)).toContain('Node.js');
  });

  it('空文本与全空白都是合法读数：空列表、零丢弃，不抛异常', () => {
    for (const blank of ['', '   \n  ']) {
      const { items, droppedByLimit } = extractRequirementsLexically(blank, 20);
      expect(items).toEqual([]);
      expect(droppedByLimit).toBe(0);
    }
  });

  it('年限的数字边界：「2020年入职」不会被读成 20 年经验', () => {
    const { items } = extractRequirementsLexically('2020年入职，5 年以上经验优先。', 20);
    expect(items.filter((item) => item.kind === 'experience_years').map((item) => item.years)).toEqual([5]);
  });

  it('超出每类上限时按稳定次序截断，并把丢掉的条数如实报出（4.4-06 要求计数可见）', () => {
    const capped = extractRequirementsLexically(SAMPLE_JD, 3);
    const hard = capped.items.filter((item) => item.kind === 'hard_skill');
    expect(hard).toHaveLength(3);
    // 截断保的是序列头部，所以它必须是完整拆解的前三条同类。
    expect(hard.map((item) => item.label)).toEqual(
      itemsOf('hard_skill')
        .slice(0, 3)
        .map((item) => item.label),
    );
    // 每类的保留数是 `min(上限, 该类实际条数)`：样例里学历只有 1 条、年限 2 条，
    // 拿「上限 × 四类」去算保留数会把这两类算多，所以这里按实际条数算。
    const kept = REQUIREMENT_KINDS.reduce((sum, kind) => sum + Math.min(3, itemsOf(kind).length), 0);
    expect(capped.items).toHaveLength(kept);
    expect(capped.droppedByLimit).toBe(FULL_EXTRACT.items.length - kept);
  });
});

describe('词面拆解的确定性（spec 4.4-07）', () => {
  it('同一 JD 连跑三次，指纹与词表版本完全一致', () => {
    const first = extractRequirementsLexically(SAMPLE_JD, 20);
    const second = extractRequirementsLexically(SAMPLE_JD, 20);
    const third = extractRequirementsLexically(SAMPLE_JD, 20);
    expect(fingerprint(second.items)).toBe(fingerprint(first.items));
    expect(fingerprint(third.items)).toBe(fingerprint(first.items));
    expect(first.lexiconVersion).toBe(REQUIREMENT_LEXICON_VERSION);
  });

  it('语料顺序被打乱后重新拼接，同一条要求的 quote 与下标跟着原文走（位置是真的，不是数出来的）', () => {
    const line = '负责订单与推荐链路的后端服务，技术栈以 Java / Go 为主，熟悉 Kafka、Redis、MySQL；';
    const standalone = extractRequirementsLexically(line, 20);
    const javaInLine = standalone.items.find((item) => item.label === 'Java');
    expect(javaInLine?.quote).toBe('Java');
    expect(javaInLine?.start).toBe(line.indexOf('Java'));
  });
});
