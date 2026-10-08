/**
 * 外发这一步的三道闸门缺一即不外发（spec 5.3-11）+ 被拦下必进被拒流水（spec 5.3-12 的跨包半边）。
 *
 * 为什么这条住在 `packages/main`（与 4.4-09 / 3.7-02 同一理由）：判据是**三道闸门在同一条链上接力**，
 * 而 `agent` 包 import 不到 `outbound` 与 `entitlement`（AGENTS.md §4.1 的依赖方向，领域包之间禁止横向引用）。
 * 在 agent 包里只能拿替身演一遍「被拦下了」，而替身既不会拒绝也不会落账，那条断言是空的。
 *
 * 三维各关掉一次，每维断言两件事：**没出手**（假渠道的调用清单为空）与**没占额度**（用量表行数与事前相等）：
 * 1. 档位 `suggest` → `agent.policy` 交回 `TIER_SUGGEST_READ_ONLY`，并且**连确认单都不开**（批了也批不动，
 *    让用户按一只按不动的按钮是骗他点一下）；
 * 2. 档位 `auto` 但未加白 → 开一张 `approval` 单，人按拒绝 → `PAUSE_DENIED`，工具一次都没被调；
 * 3. 档位 `auto` 且已加白 → 不再开单、工具真被调，而 `entitlement.gate` 已到量 → `QUOTA_EXCEEDED`。
 *    这一格是「免确认 ≠ 免闸门」（plan §5.3 的 2026-10-03 裁定）唯一能被证成的形状：渠道仍没被调、
 *    用量表仍只有种子那一行，而被拦的这一次进了 `usage_denials`。
 * 4. 第四格是正向对照：三维都放行时确实发出一次并多落一行用量。缺了它，前三条的「没出手」全可以是空话。
 *
 * 只有平台层与风险签字是替身（真身 `inject` Electron 外壳，Node 侧挂不起来；先例见
 * `packages/outbound/src/test-doubles.ts`）。循环、判定口、暂停通道、工具注册表、打招呼编排、闸门、账本全是真身。
 * 签字恒为「已签」是刻意的：第四道闸门（2.7-06）的判序在 outbound 自己那份用例里已经钉过，
 * 这里再关掉一次就把 5.3-11 的三维混成四维。全程打本地假渠道，不出网也不碰真实招聘平台（§7.2）；
 * 模型腿留空配置，所以话术走模板回落、一次网络都不发。
 */
import {
  asApp,
  Context,
  Service,
  type AgentPauseAnswer,
  type AgentPauseView,
  type AutonomyLevel,
  type ConsentGate,
  type Fiber,
  type GreetChannel,
  type GreetChannelSource,
  type GreetTarget,
} from '@auto-cc/core';
import { greetTargetLabel } from '@auto-cc/shared';
import {
  AgentLoopService,
  AgentPauseService,
  AgentPolicyService,
  AgentToolsService,
  ChatSessionService,
  agentLoopSchema,
  agentPauseSchema,
  chatConfigSchema,
} from '@auto-cc/plugin-agent';
import { ConfigService } from '@auto-cc/plugin-config';
import { BrowserTakeoverService } from '@auto-cc/plugin-browser';
import { DEFAULT_DAILY_LIMITS, EntitlementGateService, UsageLedgerService } from '@auto-cc/plugin-entitlement';
import { LogService } from '@auto-cc/plugin-logger';
import { LlmChatService, llmSchema } from '@auto-cc/plugin-llm';
import {
  OutboundGreetService,
  OutboundScriptService,
  OutboundThrottleService,
  greetSchema,
  outboundScriptSchema,
  throttleSchema,
} from '@auto-cc/plugin-outbound';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

/** 被点名的那只手（`outbound.greet` 的 init 把它登记进真注册表）。 */
const GREET_TOOL_ID = 'outbound.greet.perform';

/** 假渠道唯一登记的平台。 */
const PLATFORM = 'boss';

/** 一句干净的文案：不含手机号/链接，所以 2.5-10 的黑名单不会先于三道闸门拦下它。 */
const GREET_TEXT = '您好，看到贵司这个岗位很感兴趣，方便聊聊吗';

/** 打招呼每天只许一次的闸门配置（三格关掉的那一格就是它见底之时）。 */
const ONE_GREET_PER_DAY = { mode: 'daily' as const, dailyLimits: { ...DEFAULT_DAILY_LIMITS, greet: 1 } };

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 建一个系统临时目录（`afterAll` 负责清理，产物不进仓库，§7.5）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-three-gate-'));
  sandboxes.push(dir);
  return dir;
}

/** 一次假渠道调用的读数。 */
type ChannelCall = { targetId: string; text: string };

/**
 * 假的 `platform.registry`：只回答「boss 现在能打招呼」，并把每次发送记进清单。
 *
 * 契约见 `GreetChannelSource`（core 里的窄投影）。渠道与登记表合成一只，是因为这里没有
 * 「登记了但没 chat 能力」那一支要演——那一支由 outbound 自己的用例判。
 */
class FakePlatformRegistryService extends Service implements GreetChannelSource {
  static provide = 'platform.registry';
  static Config = z.strictObject({});

  /** 每次 `send` 追加一条；判「没出手」就看它空不空。 */
  readonly calls: ChannelCall[] = [];

  constructor(ctx: Context, _options: Record<string, never>) {
    super(ctx, 'platform.registry');
  }

  /** 契约见 `GreetChannelSource.greetChannel`。 */
  greetChannel = (platform: string): GreetChannel | null => {
    if (platform !== PLATFORM) return null;
    return {
      send: (target: GreetTarget, text: string) => {
        // 落点标签与编排层用同一个 helper 取（§2.5）：这一格记的是「发给了谁」，
        // 岗位那一路与会话那一路在断言里都只有一条形状。
        this.calls.push({ targetId: greetTargetLabel(target), text });
        return Promise.resolve({ sent: true, reason: 'fixture 页面已确认发出' });
      },
    };
  };

  /** 契约见 `GreetChannelSource.greetablePlatforms`。 */
  greetablePlatforms = (): string[] => [PLATFORM];
}

/**
 * 假的 `sessions`：风险签字恒为「已签」。
 *
 * 真身 `inject` 了 Electron 外壳所以挂不起来（同 outbound 的 `FakeSessionsService`），
 * 而本片判的是档位／确认／额度三道闸，签字那一道留到全绿再说。
 */
class FakeSessionsService extends Service implements ConsentGate {
  static provide = 'sessions';
  static Config = z.strictObject({});

  constructor(ctx: Context, _options: Record<string, never>) {
    super(ctx, 'sessions');
  }

  /** 契约见 `ConsentGate.hasConsent`。 */
  hasConsent = (): boolean => true;

  /** 契约见 `ConsentGate.ensureConsent`：恒不拦。 */
  ensureConsent = (): void => {};
}

/** 装配到「三闸门能同场」为止的整套真服务。 */
async function boot(options: { tier: AutonomyLevel; exempt: boolean; seedGreetUsage: boolean }) {
  const dir = tempDir();
  const ctx = new Context();
  /** 挂一个插件并把它的 fiber 记进收尾清单（`ctx.plugin` 返回 thenable 的 fiber，不是 `Promise<Fiber>`）。 */
  const mount = async (fiber: Fiber | PromiseLike<Fiber>): Promise<void> => {
    fibers.push(await fiber);
  };
  await mount(ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  await mount(ctx.plugin(LogService, { level: 'info', buffer: 200, file: 'auto-cc.log', dir, redact: false }));
  await mount(ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  // 5.5-a：接管态是判定口与循环的硬依赖，这里挂**真身**而不是替身——`browser.takeover` 只 inject `store`，
  // 而这一片要证的三道闸门本来就与接管无关（它恒为「没在接管」）。不挂它则 policy / loop 根本不挂载，
  // 三道闸门的用例就变成在测空气（替身已经够 agent 包内那两用例用，跨包链路面要的是装配里真有的那一份）。
  await mount(ctx.plugin(BrowserTakeoverService, {}));
  await mount(ctx.plugin(UsageLedgerService, {}));
  await mount(ctx.plugin(EntitlementGateService, ONE_GREET_PER_DAY));
  await mount(ctx.plugin(LlmChatService, llmSchema.parse({})));
  await mount(ctx.plugin(OutboundScriptService, outboundScriptSchema.parse({})));
  // 频控区间收成 0：本片判的是三道闸门，等间隔那件事在 2.5-05 自己判过。
  await mount(
    ctx.plugin(
      OutboundThrottleService,
      throttleSchema.parse({ minGapMs: 0, maxGapMs: 0, scrollMinGapMs: 0, scrollMaxGapMs: 0 }),
    ),
  );
  await mount(ctx.plugin(FakePlatformRegistryService, {}));
  await mount(ctx.plugin(FakeSessionsService, {}));
  // 注册表先于打招呼编排上岗：登记发生在后者的 init 里，顺序反了工具面就是空的（plan §15.7 落点 2）。
  await mount(ctx.plugin(AgentToolsService, {}));
  await mount(ctx.plugin(OutboundGreetService, greetSchema.parse({})));
  await mount(ctx.plugin(ChatSessionService, chatConfigSchema.parse({})));
  await mount(ctx.plugin(AgentPolicyService, {}));
  await mount(ctx.plugin(AgentPauseService, agentPauseSchema.parse({})));
  await mount(ctx.plugin(AgentLoopService, agentLoopSchema.parse({})));

  const app = asApp(ctx);
  const chat = app['chat.session'];
  // 档位由人显式改（`setAutonomy` 是那条唯一的写入口并留审计），所以先挂再改，不用配置起手。
  chat.setAutonomy(options.tier);
  if (options.exempt) app['agent.policy'].setExempt(GREET_TOOL_ID);
  if (options.seedGreetUsage) await app['entitlement.gate'].perform('greet', { targetId: 'job-seed' }, fakeDispatch);

  return {
    ctx,
    channel: ctx.get('platform.registry') as unknown as FakePlatformRegistryService,
    gate: app['entitlement.gate'],
    ledger: app['usage.ledger'],
    pause: app['agent.pause'],
    policy: app['agent.policy'],
    loop: app['agent.loop'],
  };
}

/**
 * 喂给闸门的假动作（种子那一行用它）。
 *
 * `perform` 的 `task` 签名是 `() => Promise<T>`，写 `async () => 'x'` 会被 eslint 的 `require-await`
 * 判成「async 里没有 await」，所以显式返回一个已完成的 Promise（同 `gap-quota-link.test.ts` 的先例）。
 * @returns 永远成功的假动作结果
 */
function fakeDispatch(): Promise<string> {
  return Promise.resolve('闸门种子的这一次已发生的 greet');
}

/**
 * 一句点名要打招呼的目标文本（5.2-01 的「输入即脚本」：桩模型按文本里点名的已注册工具起草一步）。
 * @param jobId 岗位 id
 * @returns 形如 `outbound.greet.perform {"request":{…}}` 的目标
 */
function goalFor(jobId: string): string {
  return `${GREET_TOOL_ID} ${JSON.stringify({ request: { platform: PLATFORM, jobId, text: GREET_TEXT } })}`;
}

/** 一张被观察到的确认单 + 测试这边按了什么。 */
type CardRecord = AgentPauseView & { decision: string | null };

/**
 * 装上「人会怎么按」的那只手：订阅暂停事件，逐张表态并留档。
 * @param ctx 本次装配的上下文
 * @param pause 暂停通道（应答要走它，才是在演真实链路而不是直接改内存）
 * @param answerFor 看到这张单时的表态；返回 null 表示没人理它
 * @returns 按开出顺序的卡片清单，供逐张断言「开没开、按了什么」
 */
function watchPauses(
  ctx: Context,
  pause: AgentPauseService,
  answerFor: (card: AgentPauseView) => AgentPauseAnswer | null,
): CardRecord[] {
  const cards: CardRecord[] = [];
  ctx.on('agent/pause-requested', (event) => {
    const card: CardRecord = { ...event, decision: null };
    cards.push(card);
    const answer = answerFor(card);
    if (answer === null) return;
    pause.respond(event.requestId, answer);
    card.decision = answer.decision;
  });
  return cards;
}

/**
 * 起草 + 确认这一条 run（三道闸门就落在这两步之间）。
 * @param ctx 本次装配的上下文
 * @param handles `boot` 的返回
 * @param answerFor 人对确认单的表态
 * @param jobId 目标岗位 id
 * @returns 跑完之后的 run 读数与开过的卡片清单
 */
async function runGreet(
  ctx: Context,
  handles: Awaited<ReturnType<typeof boot>>,
  answerFor: (card: AgentPauseView) => AgentPauseAnswer | null,
  jobId: string,
) {
  const cards = watchPauses(ctx, handles.pause, answerFor);
  const proposed = await handles.loop.propose(goalFor(jobId));
  const finished = await handles.loop.confirm(proposed.runId);
  return { cards, finished };
}

/**
 * 每维共用的两件事：没出手 + 没占额度。
 * @param handles `boot` 的返回
 * @param usageBefore 跑这一格之前的用量行数（种子那一条算在内）
 * @returns 用量与拒绝流水的读数，供各格再断自己那份拒因
 */
function expectNothingSent(handles: Awaited<ReturnType<typeof boot>>, usageBefore: number) {
  expect(handles.channel.calls).toEqual([]);
  const summary = handles.ledger.summary(50);
  expect(summary.total).toBe(usageBefore);
  return summary;
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  // 日志写流是异步开文件的：不等一下就先删目录会在收尾之后冒出 ENOENT 的未处理异常（同 4.4-09 那份用例）。
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放，清理失败不该把一次通过的验收判成失败。
    }
  }
});

describe('5.3-11 三道闸门缺一即不外发（真循环 + 真判定口 + 真暂停通道 + 真闸门账本）', () => {
  it('第一维关掉：档位 suggest → 判定口拒掉且连确认单都不开，零副作用', async () => {
    const handles = await boot({ tier: 'suggest', exempt: false, seedGreetUsage: false });
    const usageBefore = handles.ledger.summary(50).total;
    const { cards, finished } = await runGreet(handles.ctx, handles, () => ({ decision: 'approve' }), 'job-9001');

    // 「连单子都不开」是这一维的独有判据：批不动的路径上摆一只批准按钮就是骗人点一下。
    expect(cards).toEqual([]);
    expect(finished).toMatchObject({ status: 'failed', stopReason: 'POLICY_REFUSED' });
    expect(finished.steps.map((step) => [step.planStepIndex, step.status, step.code])).toEqual([
      [0, 'refused', 'TIER_SUGGEST_READ_ONLY'],
    ]);
    expectNothingSent(handles, usageBefore);
    // 额度这一维根本没被问，所以既没有用量也没有被拒流水。
    expect(handles.ledger.summary(50).recentDenials).toEqual([]);
  });

  it('第二维关掉：档位 auto 未加白 → 开一张 approval 单，人按拒绝即 PAUSE_DENIED，工具没被调', async () => {
    const handles = await boot({ tier: 'auto', exempt: false, seedGreetUsage: false });
    const usageBefore = handles.ledger.summary(50).total;
    const { cards, finished } = await runGreet(handles.ctx, handles, () => ({ decision: 'deny' }), 'job-9002');

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: 'approval', toolId: GREET_TOOL_ID, decision: 'deny' });
    expect(finished).toMatchObject({ status: 'failed', stopReason: 'PAUSE_DENIED' });
    expect(finished.steps.map((step) => [step.status, step.code])).toEqual([['refused', 'PAUSE_DENIED']]);
    expectNothingSent(handles, usageBefore);
    // 没走到闸门，所以被拒流水也一条都不该有：这张表记的是「真被拦下的动作」，不是任何失败。
    expect(handles.ledger.summary(50).recentDenials).toEqual([]);
  });

  it('第三维关掉：auto + 已加白 + greet 额度见底 → 不开单、工具真被调，闸门拦下并留一条被拒流水', async () => {
    const handles = await boot({ tier: 'auto', exempt: true, seedGreetUsage: true });
    // 种子那一条就是唯一的用量行：事后行数不变，才说明被拦这次没花钱（spec 1.9 的原话在此复钉一次）。
    const usageBefore = handles.ledger.summary(50).total;
    expect(usageBefore).toBe(1);
    // 加白只由这一只人用的口进来，所以「免确认」是用户的表态而不是模型的自述。
    expect(handles.policy.exemptList().map((entry) => entry.toolId)).toEqual([GREET_TOOL_ID]);

    const { cards, finished } = await runGreet(handles.ctx, handles, () => ({ decision: 'approve' }), 'job-9003');

    expect(cards).toEqual([]);
    expect(finished).toMatchObject({ status: 'failed', stopReason: 'STEP_UNSUCCESSFUL' });
    // 注册表把 `run` 抛出的结构化错误收成 `TOOL_FAILED`（5.1-d 定的调用协议：卡片只说"这一步失败了"），
    // 所以这一格的两条读数分工是：`code` 证明"是闸门拦的而不是模型编的"看 `usage_denials`，
    // 人读的那句原话看观察文本——闸门给的「今日 1 次额度已用完」必须原样出现在卡片上。
    expect(finished.steps.map((step) => [step.status, step.code])).toEqual([['failed', 'TOOL_FAILED']]);
    expect(finished.steps[0]?.observation).toContain('额度已用完');
    expectNothingSent(handles, usageBefore);

    const denials = handles.ledger.summary(50).recentDenials;
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ action: 'greet', targetId: 'job-9003', code: 'QUOTA_EXCEEDED' });
    expect(denials[0]?.reason).toContain('额度已用完');
  });

  it('正向对照：三道闸门都放行时确实发出一次、多落一行用量，且没有被拒流水', async () => {
    const handles = await boot({ tier: 'auto', exempt: true, seedGreetUsage: false });
    const usageBefore = handles.ledger.summary(50).total;
    const { cards, finished } = await runGreet(handles.ctx, handles, () => ({ decision: 'approve' }), 'job-9004');

    // 前三格的「没出手」只有在落账口与渠道都是活的时候才有意义，所以这里当面向它们要一次。
    expect(cards).toEqual([]);
    expect(finished).toMatchObject({ status: 'completed', stopReason: 'COMPLETED' });
    expect(handles.channel.calls).toEqual([{ targetId: 'job-9004', text: GREET_TEXT }]);
    const summary = handles.ledger.summary(50);
    expect(summary.total).toBe(usageBefore + 1);
    expect(summary.recentDenials).toEqual([]);
    // 证据引用指到那一行账：5.2-09 的「对话里如实指向证据」在外发这一路就是账本行号。
    expect(finished.steps[0]?.evidenceRefs).toContain(`ledger:${String(summary.recent[0]?.id)}`);
  });
});
