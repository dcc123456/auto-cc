/**
 * `agent.tools` 与 `chat.session` 的行为测试（spec 1.11-04 / 05 / 08 / 09 / 13 / 14）。
 *
 * 这里刻意**不**测界面：1.11 的可视判据（首屏即聊天、气泡、卡片、档位可见）由 CDP harness
 * 驱动真实窗口验收（AGENTS.md §7.1）。单测负责的是结构事实：空表就是空表、调不到就是未注册、
 * 落库的只有已完成的消息、重启后历史还在、以及本包没有偷偷 import 任何业务能力。
 */
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { AppError, asApp, Context, toolResult, type ChatDeltaEvent, type ToolDescriptorView } from '@auto-cc/core';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CHAT_AUTONOMY_AUDIT_MIGRATION_VERSION,
  CHAT_MIGRATION_VERSION,
  CHAT_SESSION_META_MIGRATION_VERSION,
  ChatSessionService,
  chatConfigSchema,
  type ChatConfig,
} from './session.js';
import { AgentToolsService, type AgentTool } from './tools.js';

const opened: { dispose(): Promise<unknown> }[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (opened.length) await opened.pop()?.dispose();
  while (dirs.length) rmSync(dirs.shift() ?? '', { recursive: true, force: true });
});

/**
 * 装一套 store + 注册表 + 会话。
 * @param config 会话配置覆盖（默认单片 40 字、无间隔，让用例不必等真计时器）
 * @returns 上下文、两个服务句柄、采集到的 delta 事件数组，以及本次用的临时库目录
 */
async function boot(config: Partial<ChatConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-agent-'));
  dirs.push(dir);
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  const storeFiber = ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' });
  await storeFiber;
  const toolsFiber = ctx.plugin(AgentToolsService, {});
  await toolsFiber;
  // 先订阅再挂载：流式一旦跑起来，晚一行订阅就漏掉前面几片，"字数递增"就断言不出来了。
  const deltas: ChatDeltaEvent[] = [];
  ctx.on('chat/delta', (event) => deltas.push(event));
  const chatFiber = ctx.plugin(ChatSessionService, {
    chunkChars: 40,
    chunkIntervalMs: 0,
    // 带 `.default()` 的键在直接调用点必须显式给出（AGENTS.md §9 的 1.3 实测）；
    // 「装配里不给这一行」那半边由 `chatConfigSchema.parse({})` 的用例证明（5.3-02）。
    defaultAutonomy: 'suggest',
    ...config,
  });
  await chatFiber;
  opened.push(chatFiber, toolsFiber, storeFiber);
  const app = asApp(ctx);
  return { ctx, tools: app['agent.tools'], chat: app['chat.session'], deltas, dir, chatFiber };
}

/** 等一小段时间，用来确认「没有再发生任何事」。 */
async function settle(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询等待条件成立，用来替代"猜一个 settle 时长"。
 * @param until 判定函数，每 10 毫秒调一次
 * @param timeoutMs 最长等待（毫秒），超时就失败，不让用例挂住
 * @param reason 超时信息里要说的话（写清在等什么，失败时才看得懂）
 */
async function waitUntil(until: () => boolean, timeoutMs: number, reason: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!until()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${reason}`);
    await settle(10);
  }
}

/**
 * 跑一支会抛的调用并把 `AppError.code` 取出来。
 * 界面与桥接层分支靠的是 code 而不是 message，所以判结构化失败要断这一位（5.6-c 起三处这么查，抽成一份）。
 * @param action 要跑的调用
 * @returns 抛出的 AppError 的 code；压根没抛时返回 null，用例据此失败而不是静默通过
 */
function codeOf(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? null;
  }
}

/** 一个合规的假工具：只用来验证协议字段与 schema 校验，不碰任何真实能力。 */
function makeEchoTool(): AgentTool<{ text: string }> {
  return {
    id: 'demo.echo',
    titleKey: 'agent.tool.labels.demoEcho',
    description: '把入参原样返回',
    input: z.object({ text: z.string().min(1) }),
    effect: 'read',
    requiresConfirmation: false,
    run: (params) => Promise.resolve(toolResult({ echoed: params.text }, { summary: '回声完成' })),
  };
}

/**
 * 一只「执行就留下副作用」的靶工具（spec 5.1-04 / 05 / 10 的判据都要能证明"什么都没发生"）。
 * @param sideEffects 副作用清单，每进一次 `run` 追加一条；调用方断言它空与非空
 * @returns 合规声明：入参是 `strictObject`（多余键也算非法），`run` 把文本记进清单
 */
function makeCountedTool(sideEffects: string[]): AgentTool<{ text: string }> {
  return {
    id: 'demo.counted',
    titleKey: 'agent.tool.labels.demoCounted',
    description: '把入参记进副作用清单',
    input: z.strictObject({ text: z.string().min(1) }),
    effect: 'local-write',
    requiresConfirmation: true,
    run: (params) => {
      sideEffects.push(params.text);
      return Promise.resolve(toolResult({ echoed: params.text }, { summary: `已记入 ${params.text}` }));
    },
  };
}

describe('agent.tools 空表与调用协议（1.11-04 / 05 / 09）', () => {
  it('单元台架里没有能力包登记，注册表是空表（1.11-04；真注册表的 9 只见 2.8-08 活体）', async () => {
    const { tools } = await boot();
    expect(tools.list()).toEqual([]);
  });

  it('调用不存在的工具返回未注册，而不是抛异常把整条消息抹掉（1.11-04 / 09）', async () => {
    const { tools } = await boot();
    const reply = await tools.call('demo.echo', { text: 'hi' });
    expect(reply).toMatchObject({ ok: false, code: 'TOOL_NOT_REGISTERED' });
  });

  it('外发类工具名一律调不到：打招呼 / 投递 / 发送简历都不在表里（1.11-09）', async () => {
    const { tools } = await boot();
    for (const toolId of ['greet.send', 'job.deliver', 'resume.send']) {
      const reply = await tools.call(toolId, {});
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.code).toBe('TOOL_NOT_REGISTERED');
    }
    expect(tools.list()).toEqual([]);
  });

  it('注册后元数据带齐协议五个字段，入参不合法被 schema 拦下（1.11-05 / 5.1-01）', async () => {
    const { tools } = await boot();
    tools.register(makeEchoTool());
    const view: ToolDescriptorView[] = tools.list();
    expect(view).toEqual([
      {
        id: 'demo.echo',
        titleKey: 'agent.tool.labels.demoEcho',
        description: '把入参原样返回',
        effect: 'read',
        requiresConfirmation: false,
      },
    ]);
    const invalid = await tools.call('demo.echo', { text: '' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.code).toBe('TOOL_INPUT_INVALID');
    const ok = await tools.call('demo.echo', { text: 'hi' });
    expect(ok).toEqual({
      ok: true,
      result: { summary: '回声完成', value: { echoed: 'hi' }, evidenceRefs: [] },
    });
  });

  it('工具自己抛错时原样回报为 TOOL_FAILED，不改口成「已完成」（§1.7 第 8 条）', async () => {
    const { tools } = await boot();
    tools.register({
      ...makeEchoTool(),
      run: () => Promise.reject(new Error('站点返回验证码')),
    });
    const reply = await tools.call('demo.echo', { text: 'hi' });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.message).toContain('站点返回验证码');
  });

  it('同 id 重复登记被拒：两个同 id 的工具会让白名单失去意义', async () => {
    const { tools } = await boot();
    tools.register(makeEchoTool());
    expect(() => tools.register(makeEchoTool())).toThrowError(/已注册/);
  });
});

describe('工具调用的三条硬拦（spec 5.1-04 / 05 / 10）', () => {
  it('非法入参被 schema 拦在门外：一次副作用都没发生（spec 5.1-04）', async () => {
    const { tools } = await boot();
    const sideEffects: string[] = [];
    tools.register(makeCountedTool(sideEffects));
    // 五种非法形状各拦一次：缺必填、空串（min(1)）、类型错、多余键（strictObject 的作用）、键名拼错。
    const invalidInputs: unknown[] = [{}, { text: '' }, { text: 42 }, { text: 'hi', extra: 1 }, { tex: 'hi' }];
    for (const input of invalidInputs) {
      const reply = await tools.call('demo.counted', input);
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.code).toBe('TOOL_INPUT_INVALID');
    }
    // 判据的实质：拦下来不是"返回了错误"，而是**实现根本没被叫起来**——副作用清单必须还是空的。
    expect(sideEffects).toEqual([]);
    await expect(tools.call('demo.counted', { text: 'hi' })).resolves.toMatchObject({ ok: true });
    expect(sideEffects).toEqual(['hi']);
  });

  it('未注册 id 一律明确报错：近似名、大小写、多余空格都不猜（spec 5.1-05）', async () => {
    const { tools } = await boot();
    const sideEffects: string[] = [];
    tools.register(makeCountedTool(sideEffects));
    // 表里只有 `demo.counted` 一只。下面每一项都离它「很近」：改一截后缀、改大小写、带个尾空格，
    // 以及两条真实存在过的能力名（`boss.greets` 是 spec 原文点名的例子）——注册表一个都不认。
    for (const toolId of [
      'demo.counter',
      'demo.count',
      'DEMO.COUNTED',
      'demo.counted ',
      'outbound.greet',
      'boss.greets',
    ]) {
      const reply = await tools.call(toolId, { text: 'hi' });
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.code).toBe('TOOL_NOT_REGISTERED');
      // 猜名一旦成立，"未注册"就会变成"调到了别的能力"，白名单与副作用归属同时失去意义。
      if (!reply.ok) expect(reply.message).toContain(toolId);
    }
    expect(sideEffects).toEqual([]);
  });

  it('声明 disabled 的工具：清单列不到、调用也调不到（spec 5.1-10）', async () => {
    const { tools } = await boot();
    const sideEffects: string[] = [];
    tools.register({ ...makeCountedTool(sideEffects), disabled: true });
    // 对 agent 不可见（1.11-04 的清单口径）……
    expect(tools.list()).toEqual([]);
    // ……而且不是一条"看不见但能按"的暗门（§2.5：同一条通路只留一套口径）。
    const reply = await tools.call('demo.counted', { text: 'hi' });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.code).toBe('TOOL_DISABLED');
    expect(sideEffects).toEqual([]);
    // 打开它走的是同一条登记路径：先摘再登记，不引入第二份"启用表"。
    expect(tools.unregister('demo.counted')).toBe(true);
    tools.register(makeCountedTool(sideEffects));
    expect(tools.list().map((entry) => entry.id)).toEqual(['demo.counted']);
    await expect(tools.call('demo.counted', { text: 'hi' })).resolves.toMatchObject({ ok: true });
    expect(sideEffects).toEqual(['hi']);
  });
});

/**
 * `validateInput` 只读校验（spec 5.3-09 的「卡片上写着还缺哪几个字段」的来源）。
 *
 * 它与 `call` 分两半是因为循环里多了一个时机：**先问缺什么、再问能不能补**——
 * 5.3-09 的补充信息单要在人不表态之前就知道「还缺 `jobId`」，而不能靠真的跑一次把手伸进副作用。
 * 于是这里钉三件只有本函数才有的性质：字段名清单（界面上的措辞靠它，不靠中文原话）、
 * 「没有这只手」不进字段清单（那是事实陈述不是入参问题）、以及**禁用不在它的口径内**
 * （校验管的是形状，开放与否只有 `call` 拦得住，见 spec 5.1-10）。
 */
describe('入参的只读校验与缺失字段清单（spec 5.3-09）', () => {
  /**
   * 一只两个必填字段的靶工具（`missing` 要能列出两条才看得出「按字段名给」这件事）。
   * @returns 合规声明：`strictObject` 且 `run` 什么都不做
   */
  function makeTwoFieldTool(): AgentTool<{ text: string; jobId: string }> {
    return {
      id: 'demo.two-fields',
      titleKey: 'agent.tool.labels.demoTwoFields',
      description: '两个必填字段的只读校验靶',
      input: z.strictObject({ text: z.string().min(1), jobId: z.string().min(1) }),
      effect: 'read',
      requiresConfirmation: false,
      run: (params) =>
        Promise.resolve(toolResult({ echoed: params.text }, { summary: `已回读 ${params.text} / ${params.jobId}` })),
    };
  }

  it('合格入参给出收窄后的值：调用方不必再解析一遍原始对象', async () => {
    const { tools } = await boot();
    tools.register(makeTwoFieldTool());
    expect(tools.validateInput('demo.two-fields', { text: 'hi', jobId: 'jd-1' })).toEqual({
      ok: true,
      input: { text: 'hi', jobId: 'jd-1' },
    });
  });

  it('缺哪几个字段就报哪几个字段名，中文原话里带着同样的字段名', async () => {
    const { tools } = await boot();
    tools.register(makeTwoFieldTool());
    const check = tools.validateInput('demo.two-fields', { text: '' });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    // 顺序跟着 schema 的声明顺序，界面上「还缺」那一行按它排；两条都缺就都列出来，
    // 不做「先补一条再看下一条」的挤牙膏——那样一个人要点两轮才填得完。
    expect(check.missing).toEqual(['text', 'jobId']);
    expect(check.message).toContain('text');
    expect(check.message).toContain('jobId');
  });

  it('整段不是对象时用 `-` 占位：卡片说「入参得是个对象」而不是「还缺一个空字段名的东西」', async () => {
    const { tools } = await boot();
    tools.register(makeTwoFieldTool());
    const check = tools.validateInput('demo.two-fields', '请把第几次补上');
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.missing).toEqual(['-']);
  });

  it('没有这只手时 missing 是空数组：那句原话是事实陈述，不是入参问题', async () => {
    const { tools } = await boot();
    const check = tools.validateInput('demo.not-here', {});
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.missing).toEqual([]);
    expect(check.message).toContain('未注册');
  });

  it('声明 disabled 的手在这里照样过形状校验：禁用是「开放」问题，只有 call 拦得住', async () => {
    const { tools } = await boot();
    tools.register({ ...makeTwoFieldTool(), disabled: true });
    expect(tools.validateInput('demo.two-fields', { text: 'hi', jobId: 'jd-1' })).toMatchObject({ ok: true });
    // 同一次调用走 `call` 才是那条拦得住的路（spec 5.1-10 的口径没有第二份）。
    await expect(tools.call('demo.two-fields', { text: 'hi', jobId: 'jd-1' })).resolves.toMatchObject({
      ok: false,
      code: 'TOOL_DISABLED',
    });
  });
});

/**
 * 登记一只「交回统一读数」的假工具（spec 5.1-11 的三条判据共用一个构造口）。
 * @param tools 本次挂载的注册表
 * @param run 实现侧要交回的东西：成功读数或直接抛错，由用例决定
 */
function registerReadingTool(tools: AgentToolsService, run: AgentTool<{ docId: string }>['run']): void {
  tools.register({
    id: 'demo.reading',
    titleKey: 'agent.tool.labels.demoReading',
    description: '交回一条统一读数的假工具',
    input: z.strictObject({ docId: z.string().min(1) }),
    effect: 'read',
    requiresConfirmation: false,
    run,
  });
}

describe('成功侧只有一种读数（spec 5.1-11）', () => {
  it('成功回复带齐 summary / value / evidenceRefs：界面不必按工具 id 猜形状', async () => {
    const { tools } = await boot();
    registerReadingTool(tools, ({ docId }) =>
      Promise.resolve(toolResult({ docId }, { summary: `已读到 ${docId}`, evidenceRefs: ['entity:doc-1'] })),
    );
    await expect(tools.call('demo.reading', { docId: 'doc-1' })).resolves.toEqual({
      ok: true,
      result: { summary: '已读到 doc-1', value: { docId: 'doc-1' }, evidenceRefs: ['entity:doc-1'] },
    });
  });

  it('库里确实没有依据时 evidenceRefs 是空数组而不是缺字段：「没依据」与「没数」是两种读数', async () => {
    const { tools } = await boot();
    registerReadingTool(tools, () => Promise.resolve(toolResult({ hits: [] }, { summary: '词面未命中' })));
    const reply = await tools.call('demo.reading', { docId: 'doc-1' });
    expect(reply.ok).toBe(true);
    if (!reply.ok) throw new Error('这条用例只该走成功侧');
    expect(reply.result.evidenceRefs).toEqual([]);
  });

  it('实现抛错时收成 TOOL_FAILED 并把原因带出来：成功侧不会给出 undefined 冒充完成', async () => {
    const { tools } = await boot();
    registerReadingTool(tools, () => Promise.reject(new Error('额度已用尽')));
    await expect(tools.call('demo.reading', { docId: 'doc-1' })).resolves.toEqual({
      ok: false,
      code: 'TOOL_FAILED',
      message: expect.stringContaining('额度已用尽'),
    });
  });

  it('实现抛的是结构化错误时，原码跟着 `reasonCode` 一起交回（spec 5.5-04 分「页面变了」靠的就是它）', async () => {
    const { tools } = await boot();
    registerReadingTool(tools, () =>
      Promise.reject(
        new AppError('LOCATE_FAILED', '定位未过线，动作没有执行：最优候选得分低于阈值', 'browser.act', {
          snapshotRef: 'fixture.local@1',
          snapshot: '<html>整页正文</html>',
        }),
      ),
    );
    const reply = await tools.call('demo.reading', { docId: 'doc-1' });
    // `code` 那一格留 `TOOL_FAILED`（界面对四种注册表结局的既有口径），实现的码是**加**在旁边的第二位数。
    expect(reply).toMatchObject({ ok: false, code: 'TOOL_FAILED', reasonCode: 'LOCATE_FAILED' });
    if (reply.ok) throw new Error('这条用例只该走失败侧');
    expect(reply.message).toContain('定位未过线');
    // `details` 不跟着出来：那里装着整页快照，进会话与步行就是几 KB 正文（与 5.2-06 同一口径）。
    expect('details' in reply).toBe(false);
    // 反向半边：非结构化的错误没有原码可报，这一位**不出现**而不是编一个——省得循环把「不知道」读成一种因由。
    tools.unregister('demo.reading');
    registerReadingTool(tools, () => Promise.reject(new Error('额度已用尽')));
    const plain = await tools.call('demo.reading', { docId: 'doc-1' });
    if (plain.ok) throw new Error('这条用例只该走失败侧');
    expect('reasonCode' in plain).toBe(false);
  });
});

describe('chat.session 会话与流式（1.11-02 / 03 / 08 / 13）', () => {
  it('首次读取就地建会话：默认档位 suggest、消息为空', async () => {
    const { chat } = await boot();
    const snapshot = chat.current();
    expect(snapshot.session.autonomy).toBe('suggest');
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.session.messageCount).toBe(0);
  });

  it('发消息得到分片增量，字数一片比一片多（1.11-03）', async () => {
    const { chat, deltas } = await boot({ chunkChars: 8, chunkIntervalMs: 5 });
    const started = chat.send('你好');
    expect(started.isStreaming).toBe(true);
    await settle(300);
    const pieces = deltas.filter((delta) => !delta.done);
    expect(pieces.length).toBeGreaterThan(2);
    const cumulative: number[] = [];
    let seen = 0;
    for (const piece of pieces) {
      seen += piece.text.length;
      cumulative.push(seen);
    }
    const monotonic = cumulative.every((length, index) => index === 0 || length > (cumulative[index - 1] ?? -1));
    expect(monotonic).toBe(true);
    // 模板长度随文案变，这里不猜片数×间隔，直接等到收尾那一条：判据是「最后一片 done 为 true」。
    await waitUntil(() => deltas.at(-1)?.done === true, 6000, '分片回复没有收尾');
    expect(deltas.at(-1)?.done).toBe(true);
  });

  it('落库的只有已完成的消息：流式中读快照能看见内存里那一条', async () => {
    const { chat } = await boot({ chunkChars: 1, chunkIntervalMs: 10 });
    chat.send('慢慢说');
    const during = chat.current();
    expect(during.messages).toHaveLength(2);
    expect(during.messages.filter((message) => message.isStreaming)).toHaveLength(1);
    // 单片 1 字 × 约 85 片的回复跑完之后，内存里那条必须换成落库的那条（isStreaming 为 false）。
    await waitUntil(() => !chat.current().messages.some((message) => message.isStreaming), 6000, '分片回复没有收尾');
    expect(chat.current().messages.filter((message) => message.isStreaming)).toHaveLength(0);
  });

  it('跑完之后用户与助手各一行，助手文本是完整的模板回复（1.11-02）', async () => {
    const { chat } = await boot();
    chat.send('帮我看看这个岗位');
    await settle(120);
    const snapshot = chat.current();
    expect(snapshot.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(snapshot.messages.every((message) => !message.isStreaming)).toBe(true);
    expect(snapshot.session.messageCount).toBe(2);
    const first = snapshot.messages[1]?.parts[0];
    expect(first?.kind === 'text' && first.text).toContain('帮我看看这个岗位');
  });

  it('/tool 指名未登记的工具：卡片失败态，原因写着未注册，id 是用户点的那只（1.11-06 + 09）', async () => {
    const { chat } = await boot();
    chat.send('/tool 打个招呼');
    await settle(120);
    const assistant = chat.current().messages.at(-1);
    const part = assistant?.parts.find((candidate) => candidate.kind === 'tool');
    expect(part?.kind === 'tool' ? part.state : null).toBe('failed');
    expect(part?.kind === 'tool' ? part.errorText : '').toContain('TOOL_NOT_REGISTERED');
    // 2.8-09 之后不再固定打到某个演示 id：用户点谁就是谁，未登记即失败，会话层不兜底改名。
    expect(part?.kind === 'tool' ? part.toolId : '').toBe('打个招呼');
  });

  it('裸 /tool 真调默认工具，卡片推 running→done 两次跳变并带耗时与结果（2.8-09）', async () => {
    const { chat, tools, deltas } = await boot({ chunkChars: 50, chunkIntervalMs: 1 });
    tools.register({
      id: 'jd.capture.run',
      titleKey: 'agent.tool.labels.jdCapture',
      description: '假抓取：只回一个计数',
      input: z.object({ criteria: z.unknown() }),
      effect: 'outbound',
      requiresConfirmation: true,
      run: () => Promise.resolve(toolResult({ captured: 3 }, { summary: '抓到 3 条', evidenceRefs: ['search:demo'] })),
    });
    chat.send('/tool');
    await waitUntil(() => deltas.at(-1)?.done === true, 6000, '工具卡片没有收尾');
    const jumps = deltas.filter((delta) => delta.tool);
    expect(jumps.map((delta) => delta.tool?.state)).toEqual(['running', 'done']);
    expect(jumps[0]?.tool?.durationMs).toBeNull();
    expect(jumps[1]?.tool?.durationMs).toBeTypeOf('number');
    // 2.8-09 之后 output 就是统一读数（spec 5.1-11）：摘要 + 产出 + 证据引用三样，卡片不必再按工具 id 猜形状。
    expect(jumps[1]?.tool?.output).toEqual({
      summary: '抓到 3 条',
      value: { captured: 3 },
      evidenceRefs: ['search:demo'],
    });
    expect(jumps[1]?.tool?.input).toEqual({ criteria: { keyword: '前端', city: '上海', limit: 3 } });
    const part = chat
      .current()
      .messages.at(-1)
      ?.parts.find((candidate) => candidate.kind === 'tool');
    expect(part?.kind === 'tool' ? part.state : null).toBe('done');
  });

  it('流式途中停止：已产出的部分如实落库，不留下「永远在流式」的行（1.11-13）', async () => {
    const { chat, deltas } = await boot({ chunkChars: 4, chunkIntervalMs: 20 });
    chat.send('这是一段比较长的输入，用来确保停止时还有内容没吐完');
    await settle(50);
    const stopped = chat.stop();
    expect(stopped).not.toBeNull();
    expect(stopped?.isStreaming).toBe(false);
    const partial = stopped?.parts[0];
    const text = partial?.kind === 'text' ? partial.text : '';
    expect(text.length).toBeGreaterThan(0);
    await settle(120);
    // 停止之后再推一片就是「假装还在说」，正是 1.11-13 要防的形态。
    expect(deltas.filter((delta) => !delta.done).every((delta) => delta.messageId === stopped?.id)).toBe(true);
    const after = chat.current().messages;
    expect(after.filter((message) => message.isStreaming)).toHaveLength(0);
    expect(chat.stop()).toBeNull();
  });

  it('上一条还在流式时再发：结构化失败而不是把两条回复搅在一起', async () => {
    const { chat } = await boot({ chunkChars: 2, chunkIntervalMs: 20 });
    chat.send('第一条');
    expect(() => chat.send('第二条')).toThrowError(/上一条回复还在生成中/);
    chat.stop();
    expect(() => chat.send('第二条')).not.toThrow();
  });

  it('空输入与超长输入被边界校验拦下', async () => {
    const { chat } = await boot();
    expect(() => chat.send('   ')).toThrowError(/内容为空/);
    expect(() => chat.send('x'.repeat(2001))).toThrowError(/最长/);
    expect(chat.current().messages).toEqual([]);
  });

  it('档位可切三态、非法值结构化失败（1.11-07）', async () => {
    const { chat } = await boot();
    for (const level of ['suggest', 'semi', 'auto']) {
      expect(chat.setAutonomy(level).autonomy).toBe(level);
    }
    expect(() => chat.setAutonomy('yolo')).toThrowError(/未知自治档位/);
  });

  it('新建会话不清空旧会话：旧行按 id 仍可回看（1.11-08）', async () => {
    const { chat, ctx } = await boot();
    chat.send('旧会话的消息');
    await settle(120);
    const oldId = chat.current().session.id;
    chat.setAutonomy('semi');
    const fresh = chat.startSession();
    expect(fresh.messages).toEqual([]);
    expect(fresh.session.id).not.toBe(oldId);
    // 直接查库确认旧行一条都没动——界面只看当前会话，所以这里必须由数据层说话。
    const store = asApp(ctx).store;
    const rows = store.db
      .prepare('SELECT parts FROM chat_message WHERE session_id = ? ORDER BY created_at ASC')
      .all(oldId) as { parts: string }[];
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]?.parts ?? '[]')[0]).toMatchObject({ kind: 'text', text: '旧会话的消息' });
  });

  it('停掉再重新挂载：迁移不被 push 两遍，历史与档位仍在（plan §8.4 决策 5 的姊妹项）', async () => {
    const { chat, ctx, chatFiber } = await boot();
    chat.send('重启前说的话');
    await settle(120);
    chat.setAutonomy('auto');
    const sessionId = chat.current().session.id;
    const chatVersions = () =>
      asApp(ctx).store.migrations.filter((migration) => migration.version === CHAT_MIGRATION_VERSION).length;
    expect(chatVersions()).toBe(1);

    await chatFiber.dispose();
    const remounted = ctx.plugin(ChatSessionService, {
      chunkChars: 40,
      chunkIntervalMs: 0,
      defaultAutonomy: 'suggest',
    });
    await remounted;
    expect(chatVersions()).toBe(1);
    // 版本没重复只是一半，另一半是「重新挂载之后读到的还是那两份表」——upgrade() 在已到版本的库上是空转。
    const snapshot = asApp(ctx)['chat.session'].current();
    expect(snapshot.session.id).toBe(sessionId);
    expect(snapshot.session.autonomy).toBe('auto');
    expect(snapshot.messages).toHaveLength(2);
  });
});

describe('会话三操作：标题、软删与恢复途径（spec 5.6-07）', () => {
  /**
   * 数一张表现在有几行。
   * @param ctx 本次台架的上下文
   * @param table 表名（只用在测试里已知的两张表上）
   * @returns 行数（`COUNT(*)` 在 node:sqlite 下回 bigint，这里统一收成 number）
   */
  function rowCount(ctx: Context, table: string): number {
    const row = asApp(ctx).store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number | bigint };
    return Number(row.n ?? 0);
  }

  it('默认没有标题；改名落在同一行，去空格由主进程做', async () => {
    const { ctx, chat } = await boot();
    const sessionId = chat.current().session.id;
    expect(chat.current().session.title).toBeNull();
    expect(chat.current().session.deletedAt).toBeNull();
    const renamed = chat.rename('  投简历这条  ');
    expect(renamed.id).toBe(sessionId);
    expect(renamed.title).toBe('投简历这条');
    // 直接查库：改名是 UPDATE 而不是 INSERT，界面看到的与库里的是同一行。
    const row = asApp(ctx)
      .store.db.prepare('SELECT title, deleted_at FROM chat_session WHERE id = ?')
      .get(sessionId) as unknown as { title: string | null; deleted_at: number | null };
    expect(row.title).toBe('投简历这条');
    expect(row.deleted_at).toBeNull();
    expect(rowCount(ctx, 'chat_session')).toBe(1);
  });

  it('标题里的手机号与邮箱在进库之前就被遮掉（与消息正文同一只手）', async () => {
    const { ctx, chat } = await boot();
    const renamed = chat.rename('联系 13800001111 或 zhou@example.com');
    const stored = asApp(ctx)
      .store.db.prepare('SELECT title FROM chat_session WHERE id = ?')
      .get(renamed.id) as unknown as { title: string };
    expect(stored.title).not.toContain('13800001111');
    expect(stored.title).not.toContain('zhou@example.com');
    expect(stored.title).toContain('138****1111');
    expect(stored.title).toContain('z***@example.com');
    // 没遮坏：这句话剩下的部分还在，人才读得懂自己起的名为什么少了几位。
    expect(stored.title).toContain('联系');
    expect(JSON.stringify(chat.current())).not.toContain('13800001111');
  });

  it('空标题与超长标题结构化失败，标题位与库里都不留痕', async () => {
    const { ctx, chat } = await boot();
    const sessionId = chat.current().session.id;
    expect(codeOf(() => chat.rename('   '))).toBe('CHAT_TITLE_EMPTY');
    expect(codeOf(() => chat.rename('x'.repeat(61)))).toBe('CHAT_TITLE_TOO_LONG');
    expect(chat.rename('x'.repeat(60)).title).toBe('x'.repeat(60));
    expect(chat.current().session.id).toBe(sessionId);
    expect(rowCount(ctx, 'chat_session')).toBe(1);
  });

  it('软删只打一位标记：被删那条的消息行一条不少，当前会话落到上一条', async () => {
    const { ctx, chat } = await boot();
    chat.send('旧会话的消息');
    await settle(120);
    const oldId = chat.current().session.id;
    chat.startSession();
    chat.send('新会话的消息');
    await settle(120);
    const removed = chat.remove();
    expect(removed.id).not.toBe(oldId);
    expect(removed.deletedAt).not.toBeNull();
    // 判据的前半句：删的是「这条会话此刻不再被看到」，不是它下面那两段对话。
    const rowsOf = (sessionId: string) =>
      asApp(ctx).store.db.prepare('SELECT parts FROM chat_message WHERE session_id = ?').all(sessionId) as unknown as {
        parts: string;
      }[];
    expect(rowsOf(removed.id)).toHaveLength(2);
    expect(rowsOf(oldId)).toHaveLength(2);
    expect(chat.current().session.id).toBe(oldId);
    expect(chat.current().messages).toHaveLength(2);
    expect(chat.trashed().map((row) => row.id)).toEqual([removed.id]);
    // 未删与已删的两行都还在表里：号段 23 写的只是 deleted_at，硬删从没发生。
    expect(rowCount(ctx, 'chat_session')).toBe(2);
    expect(rowCount(ctx, 'chat_message')).toBe(4);
  });

  it('恢复途径是真的：restore 之后那条又成为当前会话，标题与消息都在', async () => {
    const { chat } = await boot();
    chat.send('要说的事');
    await settle(120);
    const titled = chat.rename('改过名字的会话');
    const removed = chat.remove();
    expect(removed.id).toBe(titled.id);
    const restored = chat.restore(removed.id);
    expect(restored.deletedAt).toBeNull();
    expect(restored.title).toBe('改过名字的会话');
    expect(chat.trashed()).toEqual([]);
    expect(chat.current().session.id).toBe(removed.id);
    expect(chat.current().messages).toHaveLength(2);
  });

  it('查无此单与「根本没删过」都结构化失败，一行都不动', async () => {
    const { chat } = await boot();
    const sessionId = chat.current().session.id;
    expect(codeOf(() => chat.restore('00000000-0000-0000-0000-000000000000'))).toBe('CHAT_SESSION_NOT_FOUND');
    expect(codeOf(() => chat.restore(sessionId))).toBe('CHAT_SESSION_NOT_DELETED');
    expect(chat.current().session.id).toBe(sessionId);
    expect(chat.current().session.deletedAt).toBeNull();
    expect(chat.trashed()).toEqual([]);
  });

  it('一条不剩地全删掉：current() 就地建一条默认档位的，绝不把已删的那条再端出来', async () => {
    const { chat } = await boot();
    const only = chat.current().session.id;
    expect(chat.remove().id).toBe(only);
    expect(codeOf(() => chat.remove())).toBe('CHAT_SESSION_NOT_FOUND');
    const snapshot = chat.current();
    expect(snapshot.session.id).not.toBe(only);
    expect(snapshot.session.autonomy).toBe('suggest');
    expect(snapshot.messages).toEqual([]);
    // 回收站那一条不能因为「没有未删的了」就被当成当前会话——那是 5.6-07 判据里「软删」二字的反面。
    expect(chat.trashed().map((row) => row.id)).toEqual([only]);
  });

  it('号段 23 只登记一次：停掉重挂不重复 push，标题与删除标记都读得回来', async () => {
    const { ctx, chat, chatFiber } = await boot();
    const titled = chat.rename('重启之前起的名字');
    const versions = () =>
      asApp(ctx).store.migrations.filter((migration) => migration.version === CHAT_SESSION_META_MIGRATION_VERSION)
        .length;
    expect(versions()).toBe(1);

    await chatFiber.dispose();
    await ctx.plugin(ChatSessionService, { chunkChars: 40, chunkIntervalMs: 0, defaultAutonomy: 'suggest' });
    expect(versions()).toBe(1);
    const remounted = asApp(ctx)['chat.session'];
    expect(remounted.current().session.id).toBe(titled.id);
    expect(remounted.current().session.title).toBe('重启之前起的名字');
    expect(remounted.trashed()).toEqual([]);
    expect(remounted.remove().deletedAt).not.toBeNull();
    expect(remounted.trashed().map((row) => row.id)).toEqual([titled.id]);
    expect(remounted.restore(titled.id).deletedAt).toBeNull();
  });
});

describe('对话骨架的业务边界（1.11-14 / 1.11-15）', () => {
  /**
   * 递归列出本包 src 下的所有实现文件（5.2-a 起循环长在 `src/loop/` 里，只扫平铺一层会漏掉它）。
   * @param dir 要扫的目录
   * @returns 非测试的 `.ts` 文件绝对路径
   */
  function implementationFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) return implementationFiles(fullPath);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [fullPath] : [];
    });
  }

  /**
   * 读本包所有实现文件的 import 行，断言没有触达任何业务能力。
   * @returns 命中的违规行数组（空即通过）
   */
  function forbiddenImportLines(): string[] {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const banned = [
      'plugin-platform',
      'plugin-browser',
      'plugin-resume',
      'plugin-kb',
      'plugin-outbound',
      'plugin-entitlement',
      'plugin-sessions',
    ];
    return implementationFiles(here).flatMap((path) =>
      readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.includes('import') && banned.some((token) => line.includes(token))),
    );
  }

  it('agent.* 不 import 任何平台 / 简历 / 外发 / 闸门模块（1.11-14）', async () => {
    await boot();
    expect(forbiddenImportLines()).toEqual([]);
  });

  it('协议里流式、卡片状态、批准位三件事各有承载字段（1.11-15 的反向验证）', async () => {
    const { tools } = await boot();
    const tool = makeEchoTool();
    tools.register(tool);
    // `requiresConfirmation` 在元数据里可见（批准前执行的策略位）；
    // 卡片状态见 `ChatToolPart.state`，流式见 `chat/delta` 事件——三者都不依赖任何外部库。
    expect(tools.list()[0]).toHaveProperty('requiresConfirmation');
    expect(tool.effect).toBe('read');
  });
});

describe('档位的默认值、回落与变更审计（spec 5.3-02 / 05）', () => {
  it('装配不给 defaultAutonomy：schema 补出来的就是最保守档', () => {
    // 5.3-02 的验证操作是「删配置 → 断言档位为建议模式」。这里删的是配置里的这一行，
    // 而 `cordis.yml` 的 `chat` 条目本来就没写它——所以这条断言读的是真实装配，不是想象中的装配。
    expect(chatConfigSchema.parse({}).defaultAutonomy).toBe('suggest');
    const cordisYml = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '../../../cordis.yml'), 'utf8');
    const chatEntryBlock = cordisYml.match(/\n {2}- id: chat\n[\s\S]*?(?=\n {2}- id: )/)?.[0] ?? '';
    // 注释行要剔掉再判：装配文件里写着「这一行为什么不给」的说明，那不是配置键本身。
    const chatConfigLines = chatEntryBlock
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(chatConfigLines).toContain('chunkChars');
    expect(chatConfigLines).not.toContain('defaultAutonomy');
  });

  it('新会话落在配置的默认档，而不是写死的某个档', async () => {
    const first = await boot();
    expect(first.chat.current().session.autonomy).toBe('suggest');
    const second = await boot({ defaultAutonomy: 'semi' });
    expect(second.chat.current().session.autonomy).toBe('semi');
  });

  it('库里读到认不出的档位：一律回落到最保守档，不把它读成一个更宽的档', async () => {
    const { ctx, chat } = await boot();
    const snapshot = chat.current();
    asApp(ctx)
      .store.db.prepare('UPDATE chat_session SET autonomy = ? WHERE id = ?')
      .run('superman', snapshot.session.id);
    expect(chat.current().session.autonomy).toBe('suggest');
  });

  it('每次真的改档都留一条审计（时间/前档/后档/来源=用户），没变更就不留', async () => {
    const { chat } = await boot();
    const sessionId = chat.current().session.id;
    // 建会话本身不是「变更」：它落的是默认档，此时审计必须是空的，否则审计里全是噪音行。
    expect(chat.autonomyAudit(sessionId)).toEqual([]);
    chat.setAutonomy('semi');
    chat.setAutonomy('auto');
    chat.setAutonomy('auto');
    const rows = chat.autonomyAudit(sessionId);
    expect(rows).toHaveLength(2);
    // 倒序：最新一条在前，界面与排查都是先看最近一次改档。
    expect(rows[0]).toMatchObject({ fromAutonomy: 'semi', toAutonomy: 'auto', source: 'user' });
    expect(rows[1]).toMatchObject({ fromAutonomy: 'suggest', toAutonomy: 'semi', source: 'user' });
    expect(Number(rows[0]!.createdAt)).toBeGreaterThanOrEqual(Number(rows[1]!.createdAt));
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  it('非法档位仍按结构化失败拒掉，且不动档位列、不留审计', async () => {
    const { chat } = await boot();
    const sessionId = chat.current().session.id;
    // 断的是 `AppError.code` 而不是 message：桥接层按 code 回结构化失败，界面按它取文案。
    expect(codeOf(() => chat.setAutonomy('yolo'))).toBe('CHAT_AUTONOMY_INVALID');
    expect(chat.current().session.autonomy).toBe('suggest');
    expect(chat.autonomyAudit(sessionId)).toEqual([]);
  });

  it('老库（只有号段 2、没有审计表）重新挂载后能建出审计表并写进行', async () => {
    // 这一条是实跑探针抓出来的缺陷回归位：审计表最初挂在号段 2 的 `up` 里，而 `runMigrations` 认的是
    // `schema_migrations` 台账——已记「2 已应用」的库根本不会重跑那支迁移，老用户机上第一次切档位
    // 就以 `no such table` 失败。每个用例都从空库起，所以单测全绿照不出这条腿（详见 plan §5.3-a 的更正）。
    const { ctx, chatFiber } = await boot();
    const store = asApp(ctx).store;
    store.db.exec('DROP TABLE chat_autonomy_audit');
    store.db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(CHAT_AUTONOMY_AUDIT_MIGRATION_VERSION);
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'chat_autonomy_audit'").get()).toBeUndefined();

    await chatFiber.dispose();
    await ctx.plugin(ChatSessionService, { chunkChars: 40, chunkIntervalMs: 0, defaultAutonomy: 'suggest' });
    const remounted = asApp(ctx)['chat.session'];
    const sessionId = remounted.current().session.id;
    remounted.setAutonomy('semi');
    expect(remounted.autonomyAudit(sessionId)).toMatchObject([{ fromAutonomy: 'suggest', toAutonomy: 'semi' }]);
  });
});

/**
 * 5.6-a：对话记录的脱敏（spec 5.6-05）。
 *
 * 三条去路各查一遍是这条判据的全部要点：`chat/delta` 事件（界面正在显示的那一份）、
 * `current()` 的内存镜像（重启前屏幕上残留的那一份）、`chat_message` 行（落盘的那一份）。
 * 只查库是这类判据最常见的假通过——遮在写库那一行，前面两条还是原文。
 */
describe('进入对话记录之前先脱敏（spec 5.6-05）', () => {
  /** 一句同时带手机、邮箱、身份证的 JD 素材（值形态三条正则各有对象）。 */
  const PII_TEXT = '这个岗位 HR 姓周，手机 13800001111，邮箱 zhou@example.com，身份证 110101199003071234';

  /**
   * 把库里现有的每条消息正文拼成一段可 grep 的文本。
   * @param ctx 本次台架的上下文
   * @returns 所有 `chat_message.parts` 的原始 JSON（按时间序，含用户行与助手行）
   */
  function storedParts(ctx: Context): string {
    const rows = asApp(ctx)
      .store.db.prepare('SELECT parts FROM chat_message ORDER BY created_at ASC')
      .all() as unknown as { parts: string }[];
    return rows.map((row) => row.parts).join('\n');
  }

  it('用户贴进一段带联系方式的 JD：落库、内存镜像、流式事件三处都不可还原', async () => {
    const { ctx, chat, deltas } = await boot();
    chat.send(PII_TEXT);
    await waitUntil(() => !chat.current().messages.some((message) => message.isStreaming), 6000, '回复没有收尾');
    const stored = storedParts(ctx);
    expect(stored).not.toContain('13800001111');
    expect(stored).not.toContain('zhou@example.com');
    expect(stored).not.toContain('110101199003071234');
    expect(stored).toContain('138****1111');
    expect(stored).toContain('z***@example.com');
    expect(stored).toContain('**********1234');
    // 展示半边①：推给界面的每一个字。
    expect(deltas.map((delta) => delta.text).join('')).not.toContain('13800001111');
    // 展示半边②：`current()` 现读值（ChatPanel 就是按它画气泡的）。
    expect(JSON.stringify(chat.current())).not.toContain('13800001111');
    // 脱敏遮的是号码，不是这句话：上下文与被遮的值都还在，人才看得懂为什么少了几位。
    expect(stored).toContain('HR 姓周');
  });

  it('工具卡片的入参与产出都遮，而注册表实收的是原样入参（遮号码不等于遮功能）', async () => {
    const { ctx, chat, tools, deltas } = await boot();
    const received: unknown[] = [];
    tools.register({
      id: 'demo.pii',
      titleKey: 'agent.tool.labels.demoPii',
      description: '假联系：把收件人手机号回进摘要与产出',
      input: z.object({ to: z.string() }),
      effect: 'read',
      requiresConfirmation: false,
      run: (params) => {
        received.push(params);
        return Promise.resolve(
          toolResult({ phone: '13800001111' }, { summary: '已联系 13800001111', evidenceRefs: ['contact:demo'] }),
        );
      },
    });
    chat.send('/tool demo.pii {"to":"13800001111"}');
    await waitUntil(() => deltas.at(-1)?.done === true, 6000, '工具卡片没有收尾');
    const card = deltas.filter((delta) => delta.tool).at(-1)?.tool;
    expect(card?.output).toMatchObject({
      summary: '已联系 138****1111',
      value: { phone: '138****1111' },
      evidenceRefs: ['contact:demo'],
    });
    expect(card?.input).toEqual({ to: '138****1111' });
    // 判据的反面：工具真收到的必须是原样。`part.input` 是展示与记录，`registry.call` 才是执行。
    expect(received).toEqual([{ to: '13800001111' }]);
    expect(storedParts(ctx)).not.toContain('13800001111');
  });

  it('失败原因里的邮箱也遮，而错误码一字不动：原样回报说的是原因不被改写', async () => {
    const { ctx, chat, tools, deltas } = await boot();
    tools.register({
      id: 'demo.pii-fail',
      titleKey: 'agent.tool.labels.demoPiiFail',
      description: '假失败：报错信息里带收件人邮箱',
      input: z.object({}),
      effect: 'read',
      requiresConfirmation: false,
      run: () => Promise.reject(new Error('收件人 zhou@example.com 不在联系人列表里')),
    });
    chat.send('/tool demo.pii-fail');
    await waitUntil(() => deltas.at(-1)?.done === true, 6000, '失败卡片没有收尾');
    const card = deltas.filter((delta) => delta.tool).at(-1)?.tool;
    expect(card?.state).toBe('failed');
    expect(card?.errorText).toContain('TOOL_FAILED');
    expect(card?.errorText).not.toContain('zhou@example.com');
    expect(card?.errorText).toContain('z***@example.com');
    expect(storedParts(ctx)).not.toContain('zhou@example.com');
  });
});
