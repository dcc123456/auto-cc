/**
 * `agent.tools` 与 `chat.session` 的行为测试（spec 1.11-04 / 05 / 08 / 09 / 13 / 14）。
 *
 * 这里刻意**不**测界面：1.11 的可视判据（首屏即聊天、气泡、卡片、档位可见）由 CDP harness
 * 驱动真实窗口验收（AGENTS.md §7.1）。单测负责的是结构事实：空表就是空表、调不到就是未注册、
 * 落库的只有已完成的消息、重启后历史还在、以及本包没有偷偷 import 任何业务能力。
 */
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { asApp, Context, toolResult, type ChatDeltaEvent, type ToolDescriptorView } from '@auto-cc/core';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CHAT_MIGRATION_VERSION, ChatSessionService, type ChatConfig } from './session.js';
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
  const chatFiber = ctx.plugin(ChatSessionService, { chunkChars: 40, chunkIntervalMs: 0, ...config });
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
    const remounted = ctx.plugin(ChatSessionService, { chunkChars: 40, chunkIntervalMs: 0 });
    await remounted;
    expect(chatVersions()).toBe(1);
    // 版本没重复只是一半，另一半是「重新挂载之后读到的还是那两份表」——upgrade() 在已到版本的库上是空转。
    const snapshot = asApp(ctx)['chat.session'].current();
    expect(snapshot.session.id).toBe(sessionId);
    expect(snapshot.session.autonomy).toBe('auto');
    expect(snapshot.messages).toHaveLength(2);
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
