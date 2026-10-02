/**
 * 模型腿纯函数的用例（spec 4.4-02 的采信判据 / 4.4-07 的合并稳定性 / 4.4-08 的离线口径）。
 *
 * 这里**不起装配、不碰 cordis、不发请求**：`readModelRequirements` 接的是「模型回复的一段文本」，
 * 所以用例直接把文本写在文件里，等价于把真实回复录下来回放（同 `requirements.test.ts` 的做法）。
 * 语料是本地虚构样例（§7.2），公司名与手机号都是假的。
 */
import { describe, expect, it } from 'vitest';
import { mergeModelWithLexical, readModelRequirements } from './requirements-model.js';
import { buildRequirementMessages, REQUIREMENT_PROMPT_VERSION } from './prompts.js';
import { extractRequirementsLexically, type RequirementItem } from './requirements.js';

/** 固定样例 JD（虚构）：第二句里的「数据治理」「成本优化」不在词表里，正是模型腿要补的长尾。 */
const JD = [
  '数据平台工程师（星桥科技）',
  '负责订单与推荐链路的数据治理，具备成本优化意识，技术栈以 Java、Kafka 为主。',
  '要求本科及以上学历，3 年以上相关工作经验。',
].join('\n');

/**
 * 造一条模型腿的条目（只给合并用例需要的字段，其余走默认）。
 * @param overrides 需要改写的字段
 * @returns 一条 `via: model` 的要求
 */
function modelItem(overrides: Partial<RequirementItem> = {}): RequirementItem {
  return {
    kind: 'hard_skill',
    label: '数据治理',
    quote: '数据治理',
    start: JD.indexOf('数据治理'),
    end: JD.indexOf('数据治理') + 4,
    years: null,
    via: 'model',
    ...overrides,
  };
}

describe('提示词的拼装（spec 4.4-02 的契约）', () => {
  it('两条消息：system 定四类与每类上限并把引文要求写死，user 带原文', () => {
    const messages = buildRequirementMessages(JD, 7);
    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toContain('experience_years');
    expect(messages[0]?.content).toContain('每类最多 7 项');
    expect(messages[0]?.content).toContain('逐字摘自');
    expect(messages[1]?.content).toContain(JD);
  });

  it('提示词版本是可复盘的常量（同 2.5-09 的 scriptVersion 口径）', () => {
    expect(REQUIREMENT_PROMPT_VERSION).toBe('jdreq-v1');
  });
});

describe('模型输出的读取（spec 4.4-02 的事实锁定判据）', () => {
  it('合法 JSON：逐条定位回原文，位置由我们自己算、via 标成 model', () => {
    const read = readModelRequirements(
      '{"items":[{"kind":"hard_skill","label":"数据治理","quote":"负责订单与推荐链路的数据治理"}]}',
      JD,
    );
    expect(read.reason).toBeNull();
    expect(read.accepted).toHaveLength(1);
    const item = read.accepted[0];
    expect(item?.via).toBe('model');
    expect(item?.quote).toBe('负责订单与推荐链路的数据治理');
    // 下标必须能切回同一句原文——这是 4.4-01「带原文引用位置」在模型腿上的同一判据。
    expect(JD.slice(item?.start ?? -1, item?.end ?? -1)).toBe(item?.quote);
  });

  it('Markdown 代码围栏包起来的 JSON 同样能读（模型实测常见形态）', () => {
    const fenced = '```json\n{"items":[{"kind":"soft_skill","label":"成本优化","quote":"具备成本优化意识"}]}\n```';
    const read = readModelRequirements(fenced, JD);
    expect(read.reason).toBeNull();
    expect(read.accepted[0]?.label).toBe('成本优化');
    expect(read.accepted[0]?.kind).toBe('soft_skill');
  });

  it('引文在原文里找不到就丢弃并计数，绝不保留一条无据的要求（§8.4 的 4.4 对应物）', () => {
    const read = readModelRequirements(
      '{"items":[{"kind":"hard_skill","label":"Flink","quote":"精通 Flink 实时计算"}]}',
      JD,
    );
    expect(read.accepted).toHaveLength(0);
    expect(read.droppedUnlocatable).toBe(1);
    expect(read.reason).toContain('无法采信');
  });

  it('类别不在四类、字段缺失、文本超长都算契约不合格，逐条丢弃而不牵连其他条', () => {
    const read = readModelRequirements(
      '{"items":[' +
        '{"kind":"title","label":"岗位","quote":"数据平台工程师"},' +
        '{"kind":"hard_skill","label":"Kafka"},' +
        '{"kind":"hard_skill","label":"' +
        '超'.repeat(41) +
        '","quote":"Kafka"},' +
        '{"kind":"hard_skill","label":"Kafka 集群","quote":"Kafka"}]}',
      JD,
    );
    expect(read.droppedInvalid).toBe(3);
    expect(read.accepted.map((item) => item.label)).toEqual(['Kafka 集群']);
  });

  it('经验年限的数字从定位到的原文里取，不采信模型自己填的数', () => {
    const read = readModelRequirements(
      '{"items":[{"kind":"experience_years","label":"3 年以上经验","quote":"3 年以上相关工作经验"}]}',
      JD,
    );
    expect(read.accepted[0]?.years).toBe(3);
    const vague = readModelRequirements(
      '{"items":[{"kind":"experience_years","label":"丰富经验","quote":"相关工作经验"}]}',
      JD,
    );
    expect(vague.accepted[0]?.years).toBeNull();
  });

  it('整份产出不是 JSON、缺 items 数组、或空回复：给出可直接播报的原因而不是抛', () => {
    expect(readModelRequirements('我认为这个岗位需要 React。', JD).reason).toBe('模型产出不是合法 JSON');
    expect(readModelRequirements('{"result":[]}', JD).reason).toBe('模型产出缺少 items 数组');
    expect(readModelRequirements('   ', JD).reason).toBe('模型返回空内容');
  });

  it('模型重复认领同一处原文时，第二条按区间重叠丢弃', () => {
    const read = readModelRequirements(
      '{"items":[' +
        '{"kind":"hard_skill","label":"数据治理","quote":"数据治理"},' +
        '{"kind":"hard_skill","label":"治理","quote":"数据治理"}]}',
      JD,
    );
    expect(read.accepted.map((item) => item.label)).toEqual(['数据治理']);
    expect(read.droppedUnlocatable).toBe(1);
  });
});

describe('两条腿的合并（spec 4.4-02 / 4.4-07）', () => {
  /** 词面腿的基线（同一份 JD、每类上限放宽到不会触顶）。 */
  const lexical = extractRequirementsLexically(JD, 12).items;

  it('词面腿是底座：合并后每条原始条目都在，且模型条目排在同类别后', () => {
    const merged = mergeModelWithLexical(lexical, [modelItem()], 12);
    expect(merged.added).toBe(1);
    expect(merged.droppedDuplicate).toBe(0);
    for (const item of lexical) {
      expect(merged.items.some((kept) => kept.kind === item.kind && kept.start === item.start)).toBe(true);
    }
    // 稳定序列的判据：同类别内部按起始下标升序，类别按四类表次序。
    const hard = merged.items.filter((item) => item.kind === 'hard_skill');
    const starts = hard.map((item) => item.start);
    expect(starts).toEqual([...starts].sort((left, right) => left - right));
    // 「数据治理」在原文里出现在 Java / Kafka 之前，所以它排在这同类的第一条——合并不是简单追加。
    expect(hard.map((item) => item.label)).toEqual(['数据治理', 'Java', 'Kafka']);
  });

  it('同一处原文或同一要求（忽略大小写与空格）不双计，词面那条留下', () => {
    const sameLabel = modelItem({
      label: ' kafka ',
      quote: 'Kafka',
      start: JD.indexOf('Kafka'),
      end: JD.indexOf('Kafka') + 5,
    });
    const overlapping = modelItem({
      label: '订单链路',
      quote: 'Java',
      start: JD.indexOf('Java'),
      end: JD.indexOf('Java') + 4,
    });
    const merged = mergeModelWithLexical(lexical, [sameLabel, overlapping], 12);
    expect(merged.added).toBe(0);
    expect(merged.droppedDuplicate).toBe(2);
    expect(merged.items.filter((item) => item.via === 'model')).toEqual([]);
  });

  it('该类别已被词面腿占满上限时，模型条目计入触顶丢弃', () => {
    const hardOnly = lexical.filter((item) => item.kind === 'hard_skill');
    const merged = mergeModelWithLexical(hardOnly, [modelItem()], 1);
    expect(merged.added).toBe(0);
    expect(merged.droppedByLimit).toBe(1);
    // 底座原样保留：触顶只挡"再加一条"，不会把词面腿已有的条目挤掉。
    expect(merged.items).toEqual(hardOnly);
  });

  it('同一份词面 + 同一份模型输出，无论模型给的次序如何，合并序列完全一致（4.4-07）', () => {
    const a = modelItem({ label: '数据治理' });
    const b = modelItem({
      label: '成本优化',
      kind: 'soft_skill',
      quote: '成本优化',
      start: JD.indexOf('成本优化'),
      end: JD.indexOf('成本优化') + 4,
    });
    const first = mergeModelWithLexical(lexical, [a, b], 12).items;
    const second = mergeModelWithLexical(lexical, [b, a], 12).items;
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.filter((item) => item.via === 'model')).toHaveLength(2);
  });
});
