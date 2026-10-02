/**
 * 生成腿模型面的单元测试（spec 4.5-01 / 03 / 07 的代码半边，plan §4.5 判据四 / 六）。
 *
 * 不起 store、不发请求：这一层判的是「模型那句 JSON 怎么变成一份可安装的改写清单」，
 * 请求装配与重试在 `generate-service.test.ts`。语料是**明显虚构**的中文简历，
 * 不含任何真实个人信息（AGENTS.md §8.5）。
 */
import { createEmptyDocument, makeField, type ResumeDocument } from '@auto-cc/plugin-resume-doc';
import { describe, expect, it } from 'vitest';
import { generationTargetFields } from './fact-check.js';
import { applyRewrites, readModelRewrites } from './generate-model.js';
import { buildGenerateMessages, buildRetryAppendix, GENERATE_PROMPT_VERSION } from './prompts.js';

const NOW_MS = 1_700_000_000_000;
const MAX_CHARS = 600;

/** 生成腿专用的两份段简历：一条经历 + 一段简介，正文键分别是 achievement 与 text。 */
function makeDoc(): ResumeDocument {
  return {
    ...createEmptyDocument('resume-demo', NOW_MS),
    sections: [
      {
        id: 'summary',
        kind: 'summary',
        title: '个人简介',
        entries: [{ id: 'summary-1', fields: [makeField('summary', 'text', '五年后端工程师，专注高并发服务。')] }],
      },
      {
        id: 'experience',
        kind: 'experience',
        title: '工作经历',
        entries: [
          {
            id: 'experience-1',
            fields: [
              makeField('experience', 'company', '星桥科技'),
              makeField('experience', 'role', '后端工程师'),
              makeField('experience', 'period', '2021.03 - 2024.06'),
              makeField('experience', 'achievement', '主导订单服务重构，P99 延迟下降 40%。'),
            ],
          },
        ],
      },
    ],
  };
}

/** 取某位置的待改写清单条目（断言"提示词里给了它"与"回答能对回去"都读这份）。 */
function targetOf(doc: ResumeDocument, sectionId: string, fieldKey: string) {
  const matched = generationTargetFields(doc).find(
    (target) => target.sectionId === sectionId && target.fieldKey === fieldKey,
  );
  if (matched === undefined) throw new Error(`清单里没有 ${sectionId} 的 ${fieldKey}`);
  return matched;
}

describe('4.5-01 提示词的形状', () => {
  const doc = makeDoc();
  const targets = generationTargetFields(doc);

  it('清单里的三个 id 与原文都进了 user 消息，system 里写死不许动数字与具名信息', () => {
    const messages = buildGenerateMessages(
      '招后端工程师，要求 Kubernetes 与高并发。',
      ['Kubernetes', '高并发'],
      targets,
    );
    const [system, user] = messages;
    expect(messages).toHaveLength(2);
    expect(user?.content).toContain('"sectionId":"experience"');
    expect(user?.content).toContain('"fieldKey":"achievement"');
    expect(user?.content).toContain('主导订单服务重构');
    expect(user?.content).toContain('Kubernetes、高并发');
    expect(system?.content).toContain('不能新增、不能编造');
    expect(system?.content).toContain('数字与百分比一个都不许增减');
  });

  it('没有要求行时给一句「未拆出明确要求」而不是空字符串（界面不该看到一句半截话）', () => {
    const [, user] = buildGenerateMessages('JD 正文', [], targets);
    expect(user?.content).toContain('（未拆出明确要求）');
  });

  it('重试那一轮才追加约束补强，且带的是上一轮的违规行', () => {
    const appendix = buildRetryAppendix(['experience/experience-1.achievement → number-conservation（缺 40）']);
    expect(appendix).toContain('上一轮的改写未通过事实校验');
    expect(appendix).toContain('number-conservation');
    const withRetry = buildGenerateMessages('JD 正文', [], targets, appendix);
    expect(withRetry[0]?.content).toContain('上一轮的改写未通过事实校验');
    // 第一轮没有补强：system 结尾就是规则第 6 条
    expect(buildGenerateMessages('JD 正文', [], targets)[0]?.content).not.toContain('上一轮');
  });

  it('提示词版本常量随片固定，改文案必须改它（4.5-10 复盘要靠这一列分辨）', () => {
    expect(GENERATE_PROMPT_VERSION).toBe('resume-generate-v1');
  });
});

describe('4.5-07 / 4.5-03 回答的读取：只收清单里的位置', () => {
  const doc = makeDoc();
  const targets = generationTargetFields(doc);

  it('合规回答被收下，并带回它那一处的原文', () => {
    const reply = JSON.stringify({
      entries: [
        {
          sectionId: 'experience',
          entryId: 'experience-1',
          fieldKey: 'achievement',
          text: '面向高并发场景主导订单服务重构，P99 延迟下降 40%。',
        },
      ],
    });
    const read = readModelRewrites(reply, targets, MAX_CHARS);
    expect(read.reason).toBeNull();
    expect(read.accepted).toHaveLength(1);
    expect(read.accepted[0]?.originalText).toBe('主导订单服务重构，P99 延迟下降 40%。');
  });

  it('代码围栏里的 JSON 照样能读（实测常见形态，判据只有一处）', () => {
    const inner = JSON.stringify({
      entries: [
        {
          sectionId: 'summary',
          entryId: 'summary-1',
          fieldKey: 'text',
          text: '五年后端工程师，专注高并发与可观测性。',
        },
      ],
    });
    const read = readModelRewrites(`\`\`\`json\n${inner}\n\`\`\``, targets, MAX_CHARS);
    expect(read.accepted).toHaveLength(1);
  });

  it('多写一个键即非法：新增字段 / 新增条目在契约上表达不出来（判据六）', () => {
    const read = readModelRewrites(
      JSON.stringify({
        entries: [
          {
            sectionId: 'experience',
            entryId: 'experience-2',
            fieldKey: 'achievement',
            text: '新写的一段经历',
            company: '蓝海云计算公司',
          },
        ],
      }),
      targets,
      MAX_CHARS,
    );
    expect(read.accepted).toHaveLength(0);
    expect(read.droppedInvalid).toBe(1);
  });

  it('位置不在清单里（模型自己拼的 id）整条丢弃并计数', () => {
    const read = readModelRewrites(
      JSON.stringify({
        entries: [
          { sectionId: 'experience', entryId: 'experience-9', fieldKey: 'achievement', text: '改写' },
          // 公司名不在散文白名单里，即使 id 对得上也不接受（4.5-03 的原样引用）
          { sectionId: 'experience', entryId: 'experience-1', fieldKey: 'company', text: '星辰科技' },
        ],
      }),
      targets,
      MAX_CHARS,
    );
    expect(read.accepted).toHaveLength(0);
    expect(read.droppedUnknown).toBe(2);
  });

  it('与原文逐字相同不算一次改写（模型一条都没改时播报 rejected 而不是假成功）', () => {
    const original = targetOf(doc, 'experience', 'achievement').text;
    const read = readModelRewrites(
      JSON.stringify({
        entries: [{ sectionId: 'experience', entryId: 'experience-1', fieldKey: 'achievement', text: original }],
      }),
      targets,
      MAX_CHARS,
    );
    expect(read.accepted).toHaveLength(0);
    expect(read.droppedUnchanged).toBe(1);
    expect(read.reason).toContain('逐字相同');
  });

  it('同一位置回答两次只收第一条，其余计入重复', () => {
    const read = readModelRewrites(
      JSON.stringify({
        entries: [
          { sectionId: 'experience', entryId: 'experience-1', fieldKey: 'achievement', text: '第一版改写。' },
          { sectionId: 'experience', entryId: 'experience-1', fieldKey: 'achievement', text: '第二版改写。' },
        ],
      }),
      targets,
      MAX_CHARS,
    );
    expect(read.accepted.map((item) => item.rewrittenText)).toEqual(['第一版改写。']);
    expect(read.droppedDuplicate).toBe(1);
  });

  it('单段长度超上限按不合契约丢弃（模型跑飞的一句保险，值来自配置）', () => {
    const read = readModelRewrites(
      JSON.stringify({
        entries: [
          { sectionId: 'experience', entryId: 'experience-1', fieldKey: 'achievement', text: '长'.repeat(601) },
        ],
      }),
      targets,
      MAX_CHARS,
    );
    expect(read.droppedInvalid).toBe(1);
  });

  it('三种不可用的回答各给一句不同的原因', () => {
    expect(readModelRewrites('', targets, MAX_CHARS).reason).toBe('模型返回空内容');
    expect(readModelRewrites('这不是 JSON', targets, MAX_CHARS).reason).toBe('模型产出不是合法 JSON');
    expect(readModelRewrites('{"items":[]}', targets, MAX_CHARS).reason).toBe('模型产出缺少 entries 数组');
    expect(readModelRewrites('{"entries":[]}', targets, MAX_CHARS).reason).toBe('模型未提出任何改写');
  });
});

describe('4.5-02 / 03 改写装回文档', () => {
  const doc = makeDoc();
  const targets = generationTargetFields(doc);

  it('只替换命中的那一个字段值，其余对象沿用同一份引用', () => {
    const read = readModelRewrites(
      JSON.stringify({
        entries: [
          {
            sectionId: 'summary',
            entryId: 'summary-1',
            fieldKey: 'text',
            text: '五年后端工程师，专注高并发与可观测性。',
          },
        ],
      }),
      targets,
      MAX_CHARS,
    );
    const proposed = applyRewrites(doc, read.accepted);
    expect(proposed.sections[1]).toBe(doc.sections[1]);
    expect(proposed.sections[0]).not.toBe(doc.sections[0]);
    const field = proposed.sections[0]?.entries[0]?.fields[0];
    expect(field?.value).toBe('五年后端工程师，专注高并发与可观测性。');
    // 标记不动：改写的是内容，`locked` / `factKey` 属于模型层事实，由白名单而不是改标记放行
    expect(field?.locked).toBe(false);
    expect(field?.factKey).toBeNull();
  });

  it('没有改写时产物与基线逐字相同（保守版走的是同一条装配）', () => {
    const proposed = applyRewrites(doc, []);
    expect(JSON.stringify(proposed)).toBe(JSON.stringify(doc));
    expect(proposed.updatedAt).toBe(doc.updatedAt);
  });

  it('achievement 改写后仍是标锁字段，但值已换（4.5-a 裁定 A 的落地形状）', () => {
    const read = readModelRewrites(
      JSON.stringify({
        entries: [
          {
            sectionId: 'experience',
            entryId: 'experience-1',
            fieldKey: 'achievement',
            text: '面向高并发场景主导订单服务重构，P99 延迟下降 40%。',
          },
        ],
      }),
      targets,
      MAX_CHARS,
    );
    const field = applyRewrites(doc, read.accepted).sections[1]?.entries[0]?.fields[3];
    expect(field?.locked).toBe(true);
    expect(field?.factKey).toBe('achievement');
    expect(field?.value).toContain('面向高并发场景');
  });
});
