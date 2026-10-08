/**
 * 打招呼编排的骨架测试（spec 2.5-02 / 03 / 04 / 09 / 10 / 13 + 2.4-07 的让出 + 4.6-02 的来源入账）。
 *
 * 编排的每一步失败都在这里各测一遍，判据统一是「渠道有没有被调、账本有没有多一行」：
 * 被拒、命中黑名单、页面没确认、工作流让出——四种都没真发出去，所以都不许落账（plan §8.4 决策 1）。
 * 模型侧一律留空配置，让「话术生成」走模板回落且一次网络都不发（plan §12.6.1 第 1 条）；
 * 频控区间设成单点，等间隔这件事才能被断言成一个精确数字而不是「大概几秒」。
 */
import {
  asApp,
  Context,
  NO_CONFIG,
  Service,
  type Fiber,
  type GreetChannel,
  type GreetChannelSource,
  type WorkflowNodeSpec,
} from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import {
  DEFAULT_DAILY_LIMITS,
  EntitlementGateService,
  UsageLedgerService,
  type GateConfig,
} from '@auto-cc/plugin-entitlement';
import { LlmChatService, type LlmConfig } from '@auto-cc/plugin-llm';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GREET_ACTION, GREET_NODE_KIND, OutboundGreetService, type GreetConfig } from './greet.js';
import {
  DEFAULT_FORBIDDEN_PATTERNS,
  DEFAULT_OVERCLAIM_PATTERNS,
  OutboundScriptService,
  type OutboundScriptConfig,
} from './script.js';
import { FakeAgentToolsService, FakeSessionsService } from './test-doubles.js';
import { OutboundThrottleService, type OutboundThrottleConfig } from './throttle.js';

/** 判定基准：一个真实的当下毫秒数，测试里所有 `nowMs` 都在它附近，避免与本地日界打架。 */
const T0 = 1_760_000_000_000;

/** 打招呼每天只许 1 次的闸门配置；另两条留 shipped 默认，避免用例里抄一份额度数字。 */
const GATE_ONE_GREET: GateConfig = {
  mode: 'daily',
  dailyLimits: { ...DEFAULT_DAILY_LIMITS, greet: 1 },
};

const sandboxes: string[] = [];

afterAll(() => {
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放时允许残渣留在系统 temp（与 entitlement/outbound 用例同一处置）。
    }
  }
});

/** 模型侧固定「未配置」：`complete()` 在 fetch 之前就失败，回落因此是可测的。 */
const LLM_BASE: LlmConfig = {
  providerId: null,
  baseUrl: null,
  model: null,
  keyEnv: 'AUTO_CC_GREET_TEST_KEY',
  timeoutMs: 8000,
  maxTokens: 400,
  temperature: 0.7,
};

const SCRIPT_BASE: OutboundScriptConfig = {
  scriptVersion: 'v1',
  maxChars: 200,
  tone: 'formal',
  forbiddenPatterns: DEFAULT_FORBIDDEN_PATTERNS,
  overclaimPatterns: DEFAULT_OVERCLAIM_PATTERNS,
};

/** 一次渠道调用的读数。 */
type SentCall = { targetId: string; text: string };

/**
 * 假的 `platform.registry`：只回答「这个平台现在能不能打招呼」。
 *
 * 挂它是因为 `outbound.greet` 现在把平台层列为硬依赖（`inject`），而不是因为它有被测逻辑；
 * 登记表故意做成可增删的，用来证明编排层**每次外发都现问一次**、自己不缓存渠道（plan §12.13）。
 */
class FakePlatformRegistryService extends Service implements GreetChannelSource {
  static provide = 'platform.registry';
  static Config = z.strictObject({});

  private readonly channels = new Map<string, GreetChannel>();

  constructor(ctx: Context, _options: Record<string, never>) {
    super(ctx, 'platform.registry');
  }

  /**
   * 往登记表里放一条渠道（真实现里这一步是平台包登记自己的适配器）。
   * @param platform 平台标识
   * @param channel 渠道实现
   */
  add(platform: string, channel: GreetChannel): void {
    this.channels.set(platform, channel);
  }

  /**
   * 从登记表里取走一条渠道（演「适配器被摘掉」）。
   * @param platform 平台标识
   */
  remove(platform: string): void {
    this.channels.delete(platform);
  }

  /** 契约见 `GreetChannelSource.greetChannel`。 */
  greetChannel = (platform: string): GreetChannel | null => this.channels.get(platform) ?? null;

  /** 契约见 `GreetChannelSource.greetablePlatforms`。 */
  greetablePlatforms = (): string[] => [...this.channels.keys()];
}

/** 装配到 `outbound.greet` 为止的整套真实服务（闸门/账本/话术/频控都不用替身，只有平台层是）。 */
async function boot(
  options: {
    gate?: GateConfig;
    gapMs?: number;
    channel?: GreetChannel;
    dir?: string;
    agentTools?: boolean;
    greetConfig?: GreetConfig;
  } = {},
) {
  // 传 dir 是演「换个进程重挂同一份库」：库是那份库，实例是全新的一轮挂载。
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'auto-cc-greet-'));
  if (!options.dir) sandboxes.push(dir);
  const ctx = new Context();
  // 注册表先挂：登记发生在后挂的能力包里，顺序反了就是「界面上有工具、清单是空的」（plan §15.7 落点 2）。
  if (options.agentTools) await ctx.plugin(FakeAgentToolsService, NO_CONFIG);
  await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' });
  await ctx.plugin(UsageLedgerService, {});
  await ctx.plugin(EntitlementGateService, options.gate ?? { mode: 'unlimited', dailyLimits: DEFAULT_DAILY_LIMITS });
  await ctx.plugin(LlmChatService, LLM_BASE);
  await ctx.plugin(OutboundScriptService, SCRIPT_BASE);
  const gap = options.gapMs ?? 0;
  const throttleConfig: OutboundThrottleConfig = { minGapMs: gap, maxGapMs: gap, scrollMinGapMs: 0, scrollMaxGapMs: 0 };
  await ctx.plugin(OutboundThrottleService, throttleConfig);
  await ctx.plugin(FakePlatformRegistryService, {});
  await ctx.plugin(FakeSessionsService, {});
  // 替身要在挂载之后取：`ctx.get` 返回的是那个真实例，用例才改得动它的登记表（同 runner 用例的先例）。
  const registry = ctx.get('platform.registry') as unknown as FakePlatformRegistryService;
  const sessions = ctx.get('sessions') as unknown as FakeSessionsService;
  // 默认当作「已经点过风险确认」：本文件的用例测的是编排的十种失败分支，不该被 2.7-06 的判据挡住。
  // 要演「没签过字」那一支的用例自己 `sessions.revoke('boss')`（见文末的 2.7-06 段落）。
  sessions.grant('boss');
  // 渠道默认就登记好；要演「挂载时登记表是空的」那一支，用例自己 remove。
  if (options.channel) registry.add('boss', options.channel);
  const greetConfig: GreetConfig = options.greetConfig ?? {};
  const greetFiber: Fiber = await ctx.plugin(OutboundGreetService, greetConfig);
  const greet = asApp(ctx)['outbound.greet'];
  return {
    ctx,
    dir,
    greet,
    registry,
    sessions,
    greetFiber,
    ledger: asApp(ctx)['usage.ledger'],
    tools: options.agentTools ? (ctx.get('agent.tools') as unknown as FakeAgentToolsService) : null,
  };
}

/**
 * 造一只「按脚本回话」的假渠道：记录每次调用，返回预设结局。
 * @param sent 回读判定的结局（默认 true；false 用来验「页面说没发出去」那一支）
 * @returns 可直接登记进假登记表的渠道，附带调用读数
 */
function fakeChannel(sent = true): { channel: GreetChannel; calls: SentCall[] } {
  const calls: SentCall[] = [];
  return {
    calls,
    channel: {
      send: (targetId: string, text: string) => {
        calls.push({ targetId, text });
        return Promise.resolve({
          sent,
          reason: sent ? '状态行回读到成功样式：第 1 条已送达' : '状态行未变化，页面没有确认送达',
        });
      },
    },
  };
}

/** 一条合法的打招呼请求（默认手改文案那一路）。 */
const request = (over: Partial<{ jobId: string; text: string; workflowRunId: string | null }> = {}) => ({
  platform: 'boss',
  jobId: over.jobId ?? 'job-1001',
  text: over.text ?? '您好，看到贵司在招前端工程师，想进一步沟通。',
  workflowRunId: over.workflowRunId ?? null,
  nowMs: T0,
});

/** 把节点参数收成 `WorkflowNodeSpec`（只填执行器真正读的字段，其余按登记处的默认形状给）。 */
function nodeSpec(params: Record<string, string | number | boolean>): WorkflowNodeSpec {
  return {
    id: 'greet-1',
    kind: GREET_NODE_KIND,
    target: String(params.job ?? ''),
    params,
    effect: 'outbound',
    retryTimes: null,
    requiresHuman: false,
  };
}

describe('outbound.greet 的编排顺序与不落账的失败（spec 2.5-02…13）', () => {
  it('平台层没有带 chat 的适配器：结构化失败，不发网络也不落账（装配缺平台的形态）', async () => {
    const { greet, ledger } = await boot();
    await expect(greet.perform(request())).rejects.toMatchObject({
      code: 'OUTBOUND_CHANNEL_MISSING',
      details: { platform: 'boss', greetable: [] },
    });
    expect(ledger.count()).toBe(0);
  });

  it('手改文案那一路：渠道收到原文、回执带账本行，行的字段与请求一一对上（2.5-02 / 2.5-03）', async () => {
    const hand = fakeChannel();
    const { greet, ledger } = await boot({ channel: hand.channel });
    const receipt = await greet.perform(request({ workflowRunId: 'run-1' }));
    expect(receipt).toMatchObject({
      platform: 'boss',
      jobId: 'job-1001',
      origin: 'manual',
      source: 'manual:job-1001',
      waitedMs: 0,
    });
    expect(hand.calls).toEqual([{ targetId: 'job-1001', text: request().text }]);
    const row = ledger.summary().recent[0];
    expect(row).toMatchObject({
      id: receipt.ledgerId,
      action: GREET_ACTION,
      targetId: 'job-1001',
      workflowRunId: 'run-1',
      source: 'manual:job-1001',
      ts: T0,
    });
  });

  it('没给文案：走话术生成并按模板回落，来源写成 v1:greeting:<jdId> 且一次网络都不发（2.5-01 / 2.5-09）', async () => {
    const hand = fakeChannel();
    const original = globalThis.fetch;
    let networkRequestCount = 0;
    const stub: typeof fetch = () => {
      networkRequestCount += 1;
      return Promise.resolve(new Response('{}'));
    };
    globalThis.fetch = stub;
    try {
      const { greet, ledger } = await boot({ channel: hand.channel });
      const receipt = await greet.perform({
        platform: 'boss',
        jobId: 'job-2002',
        script: { jdId: 'job-2002', title: '前端工程师', company: '示例科技' },
        nowMs: T0,
      });
      expect(receipt.origin).toBe('template');
      expect(receipt.source).toBe('v1:greeting:job-2002');
      expect(hand.calls[0]?.text).toContain('前端工程师');
      expect(ledger.summary().recent[0]?.source).toBe('v1:greeting:job-2002');
      expect(networkRequestCount).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('界面选中候选再发：正文逐字符原样到渠道，账本来源带上类型与证据引用（4.6-02 / 4.6-e）', async () => {
    const hand = fakeChannel();
    const { greet, ledger } = await boot({ channel: hand.channel });
    const chosen = '您好，看到贵司在招前端工程师，我在示例科技做过同类岗位，想进一步沟通。';
    const receipt = await greet.perform({
      platform: 'boss',
      jobId: 'job-3003',
      text: chosen,
      // 界面把候选视图上的四个来源字段原样递回来（`ScriptPanel.tsx` 的 send），正文走 text 那一路。
      provenance: { jdId: '1002', kind: 'follow-up', scriptVersion: 'v1', evidenceRefs: ['chunk-11', 'chunk-22'] },
      nowMs: T0,
    });
    expect(receipt.origin).toBe('manual');
    expect(receipt.source).toBe('manual:v1:follow-up:1002#chunk-11,chunk-22');
    expect(hand.calls).toEqual([{ targetId: 'job-3003', text: chosen }]);
    expect(ledger.summary().recent[0]?.source).toBe('manual:v1:follow-up:1002#chunk-11,chunk-22');

    // 通用候选（未引用任何经历）不留一个空 `#` 段：账本里"没有引用"要读得出来。
    const generic = await greet.perform({
      platform: 'boss',
      jobId: 'job-3004',
      text: chosen,
      provenance: { jdId: '1002', kind: 'greeting', scriptVersion: 'v1', evidenceRefs: [] },
      nowMs: T0,
    });
    expect(generic.source).toBe('manual:v1:greeting:1002');
  });

  it('来源里的话术类型只认注册表那三个值：写错的 kind 直接拒，账本不留无法归类的行（4.6-01 / 4.6-09）', async () => {
    const hand = fakeChannel();
    const { greet, ledger } = await boot({ channel: hand.channel });
    await expect(
      greet.perform({
        ...request({ jobId: 'job-4001' }),
        provenance: { jdId: '1002', kind: 'thanks', scriptVersion: 'v1', evidenceRefs: [] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(hand.calls).toHaveLength(0);
    expect(ledger.count()).toBe(0);
  });

  it('额度到量：第 N+1 次以 QUOTA_EXCEEDED 被拒、渠道没被调、账本不增（2.5-02）', async () => {
    const hand = fakeChannel();
    const { greet, ledger } = await boot({ gate: GATE_ONE_GREET, channel: hand.channel });
    await greet.perform(request({ jobId: 'job-1001' }));
    await expect(greet.perform(request({ jobId: 'job-2002' }))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { action: GREET_ACTION, remaining: 0 },
    });
    expect(hand.calls).toHaveLength(1);
    expect(ledger.count()).toBe(1);
  });

  it('文案命中黑名单：直接拒发，不发渠道不落账（2.5-10「绕过它发送即失败」）', async () => {
    const hand = fakeChannel();
    const { greet, ledger } = await boot({ channel: hand.channel });
    await expect(greet.perform(request({ text: '您好，我的手机号是 13812345678，方便聊聊吗' }))).rejects.toMatchObject({
      code: 'OUTBOUND_FORBIDDEN_CONTENT',
    });
    expect(hand.calls).toHaveLength(0);
    expect(ledger.count()).toBe(0);
  });

  it('页面回读说没送达：以 OUTBOUND_NOT_DELIVERED 失败且不落账（决策 1 的外发版）', async () => {
    const hand = fakeChannel(false);
    const { greet, ledger } = await boot({ channel: hand.channel });
    await expect(greet.perform(request())).rejects.toMatchObject({
      code: 'OUTBOUND_NOT_DELIVERED',
      details: { jobId: 'job-1001' },
    });
    expect(hand.calls).toHaveLength(1);
    expect(ledger.count()).toBe(0);
  });

  it('频控以账本最近一条为钟：第二条等到整段间隔、账本时间戳差等于间隔（2.5-04）', async () => {
    const hand = fakeChannel();
    const { greet, ledger } = await boot({ gapMs: 25, channel: hand.channel });
    const started = Date.now();
    const first = await greet.perform(request({ jobId: 'job-1001' }));
    const second = await greet.perform(request({ jobId: 'job-2002' }));
    expect(first.waitedMs).toBe(0);
    expect(second.waitedMs).toBe(25);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    const timestamps = ledger
      .summary()
      .recent.map((row) => row.ts)
      .sort((a, b) => a - b);
    expect(timestamps).toEqual([T0, T0 + 25]);
  });

  it('同 run 同目标重发：第二次被拒；换一个 run 或换目标仍可发（2.5-13 的幂等键）', async () => {
    const hand = fakeChannel();
    const { greet, ledger } = await boot({ channel: hand.channel });
    await greet.perform(request({ jobId: 'job-1001', workflowRunId: 'run-1' }));
    await expect(greet.perform(request({ jobId: 'job-1001', workflowRunId: 'run-1' }))).rejects.toMatchObject({
      code: 'OUTBOUND_ALREADY_SENT',
      details: { jobId: 'job-1001', workflowRunId: 'run-1' },
    });
    await greet.perform(request({ jobId: 'job-2002', workflowRunId: 'run-1' }));
    await greet.perform(request({ jobId: 'job-1001', workflowRunId: 'run-2' }));
    expect(hand.calls).toHaveLength(3);
    expect(ledger.count()).toBe(3);
  });

  it('幂等拒因里的范围与判据口径一致：带 run 说「本次运行」，单发说「未挂工作流的那些」（5.4-c）', async () => {
    const hand = fakeChannel();
    const { greet } = await boot({ channel: hand.channel });
    await greet.perform(request({ jobId: 'job-1001', workflowRunId: 'run-1' }));
    await expect(greet.perform(request({ jobId: 'job-1001', workflowRunId: 'run-1' }))).rejects.toMatchObject({
      code: 'OUTBOUND_ALREADY_SENT',
      message: '目标 job-1001 在本次运行里已经打过招呼，不再重复发送',
    });
    // 界面与 agent 的单发没有 run，账本按 `workflow_run_id IS NULL` 数的是历史上所有单发（2.5-13），
    // 所以文案也必须换成那个范围——否则第二次单发会读到一句对不上号的话。
    await greet.perform(request({ jobId: 'job-3003' }));
    await expect(greet.perform(request({ jobId: 'job-3003' }))).rejects.toMatchObject({
      code: 'OUTBOUND_ALREADY_SENT',
      message: '目标 job-3003 在此前那些未挂工作流的发送里已经打过招呼，不再重复发送',
      details: { jobId: 'job-3003', workflowRunId: null },
    });
    expect(hand.calls).toHaveLength(2);
  });

  it('换个进程重挂同一份库：重复发送防护照样成立——判据在账本里，不在内存集合里（2.5-13）', async () => {
    const hand = fakeChannel();
    const { dir, greet, ledger } = await boot({ channel: hand.channel });
    await greet.perform(request({ jobId: 'job-1001', workflowRunId: 'run-1' }));

    const second = await boot({ dir, channel: hand.channel });
    await expect(second.greet.perform(request({ jobId: 'job-1001', workflowRunId: 'run-1' }))).rejects.toMatchObject({
      code: 'OUTBOUND_ALREADY_SENT',
    });
    expect(ledger.count()).toBe(1);
  });

  it('渠道是每次外发现问的：挂载时登记表为空不影响后来，登记表清空也不会留下可用的旧渠道（plan §12.13）', async () => {
    const hand = fakeChannel();
    // 编排层先挂载、平台包后登记（真实装配里 outbound-greet 就排在 platform-boss 之前）。
    const { greet, registry, ledger } = await boot();
    await expect(greet.perform(request())).rejects.toMatchObject({ code: 'OUTBOUND_CHANNEL_MISSING' });

    registry.add('boss', hand.channel);
    const receipt = await greet.perform(request());
    expect(receipt.jobId).toBe('job-1001');
    expect(hand.calls).toHaveLength(1);
    expect(ledger.count()).toBe(1);

    // 适配器被摘掉（卸载平台包 / 单独重启）：下一次外发立刻问出「没有渠道」，而不是打到旧页面上。
    registry.remove('boss');
    await expect(greet.perform(request({ jobId: 'job-2002' }))).rejects.toMatchObject({
      code: 'OUTBOUND_CHANNEL_MISSING',
      details: { platform: 'boss', greetable: [] },
    });
    expect(hand.calls).toHaveLength(1);
    expect(ledger.count()).toBe(1);
  });

  it('节点路径：参数进得来、runId 进幂等键；缺参数与让出都不发送不落账（2.5-e + 2.4-07）', async () => {
    const hand = fakeChannel();
    const { greet, ledger } = await boot({ gapMs: 25, channel: hand.channel });
    const controller = new AbortController();
    await greet.executeNode({
      runId: 'run-9',
      spec: nodeSpec({ platform: 'boss', job: 'job-1001', text: '您好，想请教岗位的具体要求。' }),
      attempt: 1,
      signal: controller.signal,
    });
    expect(hand.calls).toHaveLength(1);
    expect(ledger.summary().recent[0]?.workflowRunId).toBe('run-9');

    // 让出信号在频控等待之前就已经 aborted：`sleep` 会立即返回，靠发送前的检查点收手。
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      greet.executeNode({
        runId: 'run-10',
        spec: nodeSpec({ platform: 'boss', job: 'job-3003', text: '被暂停打断的一条' }),
        attempt: 1,
        signal: aborted.signal,
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_STEP_FAILED' });
    expect(hand.calls).toHaveLength(1);

    await expect(
      greet.executeNode({
        runId: 'run-11',
        spec: nodeSpec({ job: 'job-4004', title: '前端工程师', company: '示例科技' }),
        attempt: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(ledger.count()).toBe(1);
  });

  it('入参既没文案也没生成入参：INVALID_ARGUMENT，且不消耗任何额度', async () => {
    const hand = fakeChannel();
    const { ctx, greet } = await boot({ gate: GATE_ONE_GREET, channel: hand.channel });
    await expect(greet.perform({ platform: 'boss', jobId: 'job-1001', nowMs: T0 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(hand.calls).toHaveLength(0);
    const decision = asApp(ctx)['entitlement.gate'].check(GREET_ACTION, { nowMs: T0 });
    expect(decision.remaining).toBe(1);
  });
});

describe('首次启用自动化的风险确认（spec 2.7-06 的释放路径）', () => {
  it('没签过字：CONSENT_REQUIRED，且它排在「有没有渠道」之前', async () => {
    // 故意不登记渠道：如果判据顺序反了，这里会拿到 OUTBOUND_CHANNEL_MISSING，
    // 于是「先问签字」这条顺序就成了断言的内容而不是一句注释。
    const { greet, sessions, ledger } = await boot();
    sessions.revoke('boss');
    await expect(greet.perform(request())).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
      details: { platform: 'boss' },
    });
    expect(sessions.asks).toBe(1);
    expect(ledger.count()).toBe(0);
  });

  it('签过字之后同一条请求成功：确认是唯一的拦路石，不是永久禁用', async () => {
    const hand = fakeChannel();
    const { greet, sessions, ledger } = await boot({ channel: hand.channel });
    sessions.revoke('boss');
    await expect(greet.perform(request())).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    sessions.grant('boss');
    const receipt = await greet.perform(request());
    expect(receipt).toMatchObject({ platform: 'boss', jobId: 'job-1001' });
    expect(hand.calls).toHaveLength(1);
    expect(ledger.count()).toBe(1);
  });

  it('被签字拦下不扣额度：拦五次仍有一次额度，签字后那一次正好用掉', async () => {
    const hand = fakeChannel();
    const { ctx, greet, sessions } = await boot({ gate: GATE_ONE_GREET, channel: hand.channel });
    sessions.revoke('boss');
    for (const jobId of ['job-1001', 'job-2002', 'job-3003']) {
      await expect(greet.perform(request({ jobId }))).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    }
    expect(hand.calls).toHaveLength(0);
    const gate = asApp(ctx)['entitlement.gate'];
    expect(gate.check(GREET_ACTION, { nowMs: T0 })).toMatchObject({ allowed: true, remaining: 1 });
    sessions.grant('boss');
    await greet.perform(request());
    expect(gate.check(GREET_ACTION, { nowMs: T0 })).toMatchObject({ allowed: false, remaining: 0 });
  });

  it('工作流节点这一入口同样绕不过去（否则 runner 与 agent 工具会静默外发）', async () => {
    const hand = fakeChannel();
    const { greet, sessions, ledger } = await boot({ channel: hand.channel });
    sessions.revoke('boss');
    await expect(
      greet.executeNode({
        runId: 'run-20',
        spec: nodeSpec({ platform: 'boss', job: 'job-1001', text: '没签过字就想发出去的一条' }),
        attempt: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(hand.calls).toHaveLength(0);
    expect(ledger.count()).toBe(0);
  });
});

describe('agent 工具路径上的闸门与账本（spec 2.8-08 / 2.8-10）', () => {
  /** 工具入参的形状：只带声明里有的那三样（`nowMs` / `workflowRunId` 是编排内部字段）。 */
  const toolRequest = (over: { jobId?: string; text?: string } = {}) => ({
    platform: 'boss',
    jobId: over.jobId ?? 'job-1001',
    text: over.text ?? '您好，看到贵司在招前端工程师，想进一步沟通。',
  });

  it('挂载即在注册表里登记一只外发工具，id 与服务口名一致且带「需批准」', async () => {
    const { tools } = await boot({ agentTools: true });
    // 注册表是本包共享的：话术服务在同批装配里也登记自己的 `outbound.script.generate`（它在 script.test.ts 里
    // 有对应用例），所以这里按 id 取 greet 那一行，而不是断言整张清单——清单长度属于注册表自己的用例。
    expect(tools?.list().filter((entry) => entry.id === 'outbound.greet.perform')).toEqual([
      { id: 'outbound.greet.perform', effect: 'outbound', requiresConfirmation: true },
    ]);
  });

  it('人已做完的哨兵由装配配置给：没配就没有这一位，配了才原样进声明（spec 5.5-08）', async () => {
    // 哨兵**默认不给**是这一片的取向：猜中的那次会悄悄跳掉一次外发，猜不中的那次只是多问一句「要不要批准」。
    // 所以 shipped 配置里没有这句话时，声明上连这个键都不该出现——循环读到 `undefined` 走的正是「永不跳过」那条路。
    const unset = await boot({ agentTools: true });
    expect(unset.tools?.declarations.get('outbound.greet.perform')?.doneMarker).toBeUndefined();

    const calibrated = await boot({ agentTools: true, greetConfig: { doneMarker: '已从 iframe 内发出第' } });
    expect(calibrated.tools?.declarations.get('outbound.greet.perform')?.doneMarker).toBe('已从 iframe 内发出第');
    // 加了哨兵不改变这只手的其它任何读数：需要批准、外发级、清单长度都不许跟着动（那是另一码事）。
    expect(calibrated.tools?.list().filter((entry) => entry.id === 'outbound.greet.perform')).toEqual([
      { id: 'outbound.greet.perform', effect: 'outbound', requiresConfirmation: true },
    ]);
  });

  it('对话入口调外发：没签过字被 CONSENT_REQUIRED 拦下，渠道没被调也不落账（2.8-10）', async () => {
    const hand = fakeChannel();
    const { tools, sessions, ledger } = await boot({ channel: hand.channel, agentTools: true });
    sessions.revoke('boss');
    await expect(tools?.call('outbound.greet.perform', { request: toolRequest() })).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });
    expect(hand.calls).toHaveLength(0);
    expect(ledger.count()).toBe(0);
  });

  it('签过字后同一条经工具路径发出去，并落一条 greet 账（2.8-10 的另一半）', async () => {
    const hand = fakeChannel();
    const { tools, ledger } = await boot({ channel: hand.channel, agentTools: true });
    const reply = await tools?.call('outbound.greet.perform', { request: toolRequest() });
    expect(reply).toMatchObject({ ok: true });
    expect(hand.calls).toEqual([{ targetId: 'job-1001', text: toolRequest().text }]);
    expect(ledger.count()).toBe(1);
    expect(ledger.summary().recent[0]).toMatchObject({ action: GREET_ACTION, targetId: 'job-1001' });
  });

  it('额度用尽时工具路径同样被闸门拦下：工具层没有第二套判据', async () => {
    const hand = fakeChannel();
    const { tools, ledger } = await boot({ channel: hand.channel, agentTools: true, gate: GATE_ONE_GREET });
    await tools?.call('outbound.greet.perform', { request: toolRequest({ jobId: 'job-1001' }) });
    await expect(
      tools?.call('outbound.greet.perform', { request: toolRequest({ jobId: 'job-2002' }) }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(hand.calls).toHaveLength(1);
    expect(ledger.count()).toBe(1);
  });

  it('入参缺文案被声明自己的 schema 拦下：不进实现、也不落账', async () => {
    const hand = fakeChannel();
    const { tools, ledger } = await boot({ channel: hand.channel, agentTools: true });
    const missing = await tools?.call('outbound.greet.perform', { request: { platform: 'boss', jobId: 'job-1001' } });
    expect(missing).toEqual({ ok: false, reason: 'INPUT_INVALID' });
    expect(hand.calls).toHaveLength(0);
    expect(ledger.count()).toBe(0);
  });

  it('打招呼服务卸载时工具一起摘回：清单不会留着指向旧实例的入口', async () => {
    const { tools, greetFiber } = await boot({ agentTools: true });
    expect(tools?.declarations.has('outbound.greet.perform')).toBe(true);
    await greetFiber.dispose();
    expect(tools?.removed).toEqual(['outbound.greet.perform']);
    // 摘回只针对自己那一条：话术那条仍在（同一注册表，另一只服务的生命周期），断言它没被连带摘走。
    expect(tools?.list().map((entry) => entry.id)).toEqual(['outbound.script.generate']);
  });
});
