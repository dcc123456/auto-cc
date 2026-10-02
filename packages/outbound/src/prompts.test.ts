/**
 * 话术注册表的纯函数测试（spec 4.6-01 的结构断言 + 4.6-04 的档位落点 + 4.6-06 的模板形状）。
 *
 * 只测「拼出来的文案形状」，不碰服务、不碰网络：分型的差别必须能在字符串上指认出来，
 * 否则四类话术共用一个组装函数就成了"三份文案其实是一份"（§2.5 的反面）。
 */
import { describe, expect, it } from 'vitest';
import { buildScriptMessages, renderScriptTemplate, SCRIPT_PROMPT_VERSION } from './prompts.js';
import { scriptRequestSchema, type ScriptKind, type ScriptRequest, type ScriptTone } from './script.js';

/**
 * 造一份合法入参（默认开场白），用例只覆盖自己关心的那几个字段。
 * @param overrides 要覆盖的字段（`kind` / `recruiterMessage` / `evidence` 等）
 * @returns `ScriptRequest` 形状的对象
 */
const request = (overrides: Partial<ScriptRequest> = {}): ScriptRequest => ({
  jdId: 'job-1001',
  title: '前端工程师',
  company: '示例科技',
  keywords: ['React', 'TypeScript'],
  evidence: [],
  kind: 'greeting',
  ...overrides,
});

describe('话术库的模板回落（spec 4.6-06）', () => {
  it('三类模板都点明岗位名与公司名，且各带自己的指涉对象（4.6-01 / 06）', () => {
    const greeting = renderScriptTemplate(request(), 'formal');
    const followUp = renderScriptTemplate(request({ kind: 'follow-up', recruiterMessage: '我们下周面试' }), 'formal');
    const rejection = renderScriptTemplate(
      request({ kind: 'rejection', recruiterMessage: '这个岗位已经招满了' }),
      'formal',
    );
    for (const text of [greeting, followUp, rejection]) {
      expect(text).toContain('前端工程师');
      expect(text).toContain('示例科技');
    }
    expect(greeting).toContain('方向：React、TypeScript');
    expect(followUp).toContain('我们下周面试');
    expect(rejection).toContain('这个岗位已经招满了');
    // 开场白是唯一会自我介绍的那一类：另两类不该再说"看到贵司在招"。
    expect(followUp).not.toContain('看到贵司');
    expect(rejection).not.toContain('看到贵司');
  });

  it('语气档位真的换收尾句：三档互不相同（4.6-04 的模板落点）', () => {
    const closings = (['formal', 'warm', 'brief'] as ScriptTone[]).map((tone) => {
      const text = renderScriptTemplate(request(), tone);
      return text.slice(text.lastIndexOf('，') + 1);
    });
    expect(new Set(closings).size).toBe(3);
  });

  it('有证据时引用第一条、证据里的换行压平且不整段照抄（4.6-06 的「不冒充个性化」边界）', () => {
    const withEvidence = renderScriptTemplate(
      request({ evidence: [{ fact: '主导过订单服务重构\nP99 延迟下降 40%', refId: 'chunk-77' }] }),
      'formal',
    );
    expect(withEvidence).toContain('订单服务重构 P99 延迟下降 40%');
    expect(withEvidence).not.toContain('\n');
    const tooLong = renderScriptTemplate(
      request({ evidence: [{ fact: '经'.repeat(60), refId: 'chunk-78' }] }),
      'formal',
    );
    expect(tooLong).toContain('…');
    expect(tooLong.length).toBeLessThan(60 + 80);
  });

  it('对方原话超 40 字时截成引子，不把整段对话抄进一句话术里', () => {
    const long = '我'.repeat(60);
    const text = renderScriptTemplate(request({ kind: 'follow-up', recruiterMessage: long }), 'formal');
    expect(text).toContain(`${'我'.repeat(40)}…`);
    expect(text).not.toContain(`${'我'.repeat(41)}`);
  });
});

describe('话术提示词的组装（spec 4.6-01 的结构断言）', () => {
  it('每条都是两句、角色次序固定，长度上限与档位都进了 system（4.6-04）', () => {
    for (const kind of ['greeting', 'follow-up', 'rejection'] as ScriptKind[]) {
      const messages = buildScriptMessages(request({ kind }), 120, 'brief');
      expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
      expect(messages[0]?.content).toContain('长度不超过 120 个字');
      expect(messages[0]?.content).toContain('简短直接');
    }
  });

  it('三类的角色句与任务句各不相同，共用的是同一份事实清单（§2.5：分型不是复制）', () => {
    const perKind = (['greeting', 'follow-up', 'rejection'] as ScriptKind[]).map((kind) =>
      buildScriptMessages(request({ kind, recruiterMessage: '下周再说' }), 200, 'formal'),
    );
    expect(new Set(perKind.map(([system]) => system?.content ?? '')).size).toBe(3);
    expect(new Set(perKind.map(([, user]) => user?.content ?? '')).size).toBe(3);
    // 事实清单这一份是共用的：岗位、公司、关键词三行在三类里逐字相同。
    const factLines = perKind.map(([, user]) => (user?.content ?? '').match(/岗位：.*\n公司：.*/s)?.[0] ?? '');
    expect(new Set(factLines).size).toBe(1);
  });

  it('证据与对方原话只在自己出现时进 user，不给模型一句没有依据的"您说过…"', () => {
    const bare = buildScriptMessages(request(), 200, 'formal')[1]?.content ?? '';
    expect(bare).not.toContain('可引用的经历');
    expect(bare).not.toContain('对方最后一条消息');
    const full =
      buildScriptMessages(
        request({
          kind: 'follow-up',
          evidence: [{ fact: '做过大促稳定性治理', refId: 'chunk-79' }],
          recruiterMessage: '下周再说',
        }),
        200,
        'formal',
      )[1]?.content ?? '';
    expect(full).toContain('可引用的经历：做过大促稳定性治理');
    expect(full).toContain('对方最后一条消息：下周再说');
  });

  it('三类都带上"不得编造 + 禁发凭据"这两条硬约束（§8.4 / §8.5 进提示词，不靠模型自律）', () => {
    for (const kind of ['greeting', 'follow-up', 'rejection'] as ScriptKind[]) {
      const system = buildScriptMessages(request({ kind, recruiterMessage: '下周再说' }), 200, 'formal')[0]?.content;
      expect(system).toContain('不得编造公司、职位、时间或数字');
      expect(system).toContain('验证码、密码');
    }
  });

  it('版本常量非空且与入参 schema 同源：改文案必须同改它（4.6-09）', () => {
    expect(SCRIPT_PROMPT_VERSION).toMatch(/^script-v\d+$/);
    expect(scriptRequestSchema.parse({ jdId: 'j', title: 't', company: 'c' }).kind).toBe('greeting');
  });
});
