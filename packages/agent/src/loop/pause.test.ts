/**
 * `agent.pause` 的通道行为（spec 5.3-08 / 09 / 10 的服务半边）。
 *
 * 与 `policy.test.ts` 同一分工：这里测的是**这张单子本身**怎么开、怎么路由、怎么定局，
 * 「循环拿到定局之后怎么走」在 `loop.test.ts` 的那一节里测（同一件事不在两处各推一遍，AGENTS.md §2.2）。
 * 机制那半边（单号、超时、只生效一次）长在 `@auto-cc/core` 的 `PendingChannel` 上并已由
 * `pending-channel.test.ts` 钉住，本文件因此只挑**领域**那三条判据：
 * ① 两类单各能接住哪几种表态（`elicitation` 绝不接 `approve`，`approval` 绝不接 `supply`）；
 * ② `respond` 的三道边界校验不过时**不落地**，那张单照旧在等（界面可以改一句再按一次）；
 * ③ 服务销毁 / 让出 / 超时之后，迟到的表态一律读不成「同意了」。
 *
 * 全程不出网、不碰真实招聘平台（AGENTS.md §7.2），超时一律取配置下限 200 毫秒以便当场看到。
 */
import { ConfigService } from '@auto-cc/plugin-config';
import {
  AppError,
  asApp,
  Context,
  sleep,
  type AgentPauseAnswer,
  type AgentPauseView,
  type AppErrorPayload,
} from '@auto-cc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_USER_INPUT_CHARS } from '../session.js';
import { AgentPauseService, agentPauseSchema, type PausePayload } from './pause.js';

/** 拆卸清单（每个用例一套通道，跑完即拆）。 */
const opened: { dispose(): Promise<unknown> }[] = [];

afterEach(async () => {
  while (opened.length) await opened.pop()?.dispose();
});

/**
 * 装一套暂停通道。
 * @param pauseTimeoutMs 超时（毫秒）；带 `.default()` 的键在直接调用点必须显式给（AGENTS.md §9 的 1.3 实测）
 * @returns 上下文、通道句柄、两条事件的留档、fiber（销毁那条用例要单独摘掉它）
 */
async function bootPause(pauseTimeoutMs = 200) {
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  const fiber = ctx.plugin(AgentPauseService, { pauseTimeoutMs });
  await fiber;
  opened.push(fiber);
  /** `agent/pause-requested` 的载荷按到达顺序留档。 */
  const requested: AgentPauseView[] = [];
  /** `agent/pause-resolved` 的载荷按到达顺序留档（`[单号, 定局]`）。 */
  const resolved: [string, string][] = [];
  ctx.on('agent/pause-requested', (event) => {
    requested.push(event);
  });
  ctx.on('agent/pause-resolved', (event) => {
    resolved.push([event.requestId, event.outcome]);
  });
  return { ctx, pause: asApp(ctx)['agent.pause'], requested, resolved, fiber, pauseTimeoutMs };
}

/**
 * 卡片要显示的那几格的起手值（默认一张确认单，用例只改自己点名那一位）。
 * @param overrides 要覆盖的格
 * @returns 通道要的载荷（不含单号与时刻——那三位是通道的）
 */
function payloadFor(overrides: Partial<PausePayload> = {}): PausePayload {
  return {
    runId: 'run-1',
    planStepIndex: 0,
    toolId: 'outbound.greet.perform',
    kind: 'approval',
    reason: '这一步是「outbound」级动作，要先由你批准',
    missing: [],
    round: 1,
    ...overrides,
  };
}

/** 一张补充信息单（缺 `jobId` 那个形态，与循环里 `strictObject` 报出来的字段名同形状）。 */
const ELICITATION = payloadFor({ kind: 'elicitation', missing: ['jobId'] });

/**
 * 跑一次期望失败的调用，把它落成可断言的错误载荷。
 *
 * 为什么不直接 `toThrowError`：`respond` 的失败是**结构化**的（码 + 路径 + 细节），而 5.3-09 要钉的
 * 正是「查无此单」与「种类不合」落在不同码上、且细节里带着还等着的那几张——只看一句中文文案，
 * 就把「错误可核对」这条判据退化成「错误有个样子」。
 * @param action 期望抛出 `AppError` 的那次调用
 * @returns 抛出的错误经 `AppError.from` 归一后的载荷
 * @throws action 竟然成功时抛错（用例把「该拒的没拒」读成「断言通过」是本文件最不能接受的失效形态）
 */
function captureAppError(action: () => unknown): AppErrorPayload {
  try {
    action();
  } catch (error) {
    return AppError.from(error);
  }
  throw new Error('这次调用本该被拒，却成功了');
}

describe('开单与广播（spec 5.3-08）', () => {
  it('先登记再广播：订阅者一收到事件就能 `pending()` 读到这张单', async () => {
    const { ctx, pause, requested } = await bootPause(1000);
    /** 事件到达那一刻在等的张数——判的是顺序，不是内容。 */
    const sizesAtEvent: number[] = [];
    ctx.on('agent/pause-requested', (event) => {
      sizesAtEvent.push(pause.pending().length);
      expect(event).toMatchObject({ runId: 'run-1', planStepIndex: 0, toolId: 'outbound.greet.perform' });
    });
    const asking = pause.ask(payloadFor());
    expect(sizesAtEvent).toEqual([1]);
    // 单号与两个时刻是通道补齐的，调用方给不了（给了就是假账，§2.5）。
    const [waiting] = pause.pending();
    expect(waiting?.requestId).toMatch(/-/);
    expect(waiting?.expiresAt).toBe((waiting?.requestedAt ?? 0) + 1000);
    pause.respond(waiting?.requestId ?? '', { decision: 'approve' });
    const reply = await asking;
    expect(reply.request).toEqual(waiting);
    expect(reply.outcome).toEqual({ kind: 'answered', answer: { decision: 'approve' } });
    expect(requested).toHaveLength(1);
  });

  it('两张单并存时各按各的单号路由，互不串台', async () => {
    const { pause } = await bootPause(1000);
    const approval = pause.ask(payloadFor({ runId: 'run-A' }));
    const elicitation = pause.ask(payloadFor({ runId: 'run-B', kind: 'elicitation', missing: ['jobId'] }));
    const [first, second] = pause.pending();
    expect([first?.runId, second?.runId]).toEqual(['run-A', 'run-B']);
    pause.respond(second?.requestId ?? '', { decision: 'supply', text: '{"jobId":"jd-9"}' });
    // 第一张照旧在等：应答是**按单号**落地的，不是「把最新那张收掉」。
    expect(pause.pending().map((entry) => entry.runId)).toEqual(['run-A']);
    expect((await elicitation).outcome).toEqual({
      kind: 'answered',
      answer: { decision: 'supply', text: '{"jobId":"jd-9"}' },
    });
    pause.respond(first?.requestId ?? '', { decision: 'deny' });
    expect((await approval).outcome).toEqual({ kind: 'answered', answer: { decision: 'deny' } });
    expect(pause.pending()).toEqual([]);
  });

  it('超时到点定局，且收单事件照发——界面上那张卡片不能留成按不动的样子', async () => {
    const { pause, resolved } = await bootPause(200);
    const asking = pause.ask(payloadFor());
    const reply = await asking;
    expect(reply.outcome).toEqual({ kind: 'timed-out' });
    expect(pause.pending()).toEqual([]);
    expect(resolved).toEqual([[reply.request.requestId, 'timed-out']]);
    // 超时之后再按「批准」：改不了已经定局的单（5.3-10 的实质——超时不是没人按，是这一等已经结束了）。
    expect(() => pause.respond(reply.request.requestId, { decision: 'approve' })).toThrowError(/已不在等待中/);
  });

  it('让出信号在开单之前就已置位时也不放行：以 cancelled 定局，不等超时', async () => {
    const { pause } = await bootPause(1000);
    const controller = new AbortController();
    controller.abort();
    const reply = await pause.ask(payloadFor(), controller.signal);
    expect(reply.outcome).toEqual({ kind: 'cancelled' });
    expect(pause.pending()).toEqual([]);
  });

  it('卡片还开着时让出：等待以 cancelled 收，之后迟到的表态读不成「同意了」', async () => {
    const { pause } = await bootPause(1000);
    const controller = new AbortController();
    const asking = pause.ask(payloadFor(), controller.signal);
    const [waiting] = pause.pending();
    controller.abort();
    const reply = await asking;
    expect(reply.outcome).toEqual({ kind: 'cancelled' });
    expect(() => pause.respond(waiting?.requestId ?? '', { decision: 'approve' })).toThrowError(/已不在等待中/);
  });
});

describe('表态的种类与单的种别相配（spec 5.3-09）', () => {
  /**
   * 跑一条「开单 → 按 `answer` 应答 → 等定局」的最小往返。
   * @param payload 卡片载荷
   * @param answer 要按下去的表态；null 表示不按（只验校验被拒之后单子还在等）
   * @returns 通道句柄、定局（未按则 null）、应答期的抛错（无则 null）、以及应答后的在等清单
   */
  async function roundTrip(payload: PausePayload, answer: AgentPauseAnswer | null) {
    const { pause } = await bootPause(1000);
    const asking = pause.ask(payload);
    const [waiting] = pause.pending();
    const requestId = waiting?.requestId ?? '';
    let failure: AppErrorPayload | null = null;
    let rest: AgentPauseView[] | null = null;
    if (answer !== null) {
      try {
        rest = pause.respond(requestId, answer);
      } catch (error) {
        failure = AppError.from(error);
      }
    }
    if (failure === null) {
      const reply = await asking;
      return { pause, reply, failure, rest };
    }
    // 校验没过时这张单**不许**被收掉：那张卡片还挂在那里，人改一句可以再按一次。
    expect(pause.pending().map((entry) => entry.requestId)).toEqual([requestId]);
    const finisher: AgentPauseAnswer =
      payload.kind === 'approval' ? { decision: 'deny' } : { decision: 'supply', text: '收尾用' };
    pause.respond(requestId, finisher);
    const reply = await asking;
    return { pause, reply, failure, rest };
  }

  it('确认单接 approve / deny', async () => {
    const approved = await roundTrip(payloadFor(), { decision: 'approve' });
    expect(approved.reply.outcome).toEqual({ kind: 'answered', answer: { decision: 'approve' } });
    const denied = await roundTrip(payloadFor(), { decision: 'deny' });
    expect(denied.reply.outcome).toEqual({ kind: 'answered', answer: { decision: 'deny' } });
  });

  it('补充信息单接 supply / deny，但不接 approve：那等于替用户点一个他没点过的批准', async () => {
    const supplied = await roundTrip(ELICITATION, { decision: 'supply', text: 'jd-9' });
    expect(supplied.reply.outcome).toEqual({ kind: 'answered', answer: { decision: 'supply', text: 'jd-9' } });
    const abandoned = await roundTrip(ELICITATION, { decision: 'deny' });
    expect(abandoned.reply.outcome).toEqual({ kind: 'answered', answer: { decision: 'deny' } });
    const crossed = await roundTrip(ELICITATION, { decision: 'approve' });
    expect(crossed.failure).toMatchObject({
      code: 'INVALID_ARGUMENT',
      path: 'agent.pause',
      details: { kind: 'elicitation', decision: 'approve' },
    });
    expect(crossed.failure?.message).toContain('补充信息单接不住「approve」');
    expect(crossed.reply.outcome).toEqual({ kind: 'answered', answer: { decision: 'supply', text: '收尾用' } });
  });

  it('确认单也不接 supply：卡片上没有输入框，就不该存在送得出这种表态的路', async () => {
    const crossed = await roundTrip(payloadFor(), { decision: 'supply', text: '随便一句' });
    expect(crossed.failure?.code).toBe('INVALID_ARGUMENT');
    expect(crossed.failure?.message).toContain('确认单接不住「supply」');
  });

  it('补充信息过的是与会话输入同一个长度上限，超限时单子照旧在等', async () => {
    const tooLong = await roundTrip(ELICITATION, { decision: 'supply', text: 'x'.repeat(MAX_USER_INPUT_CHARS + 1) });
    expect(tooLong.failure?.code).toBe('INVALID_ARGUMENT');
    expect(tooLong.failure?.message).toContain(`最长 ${String(MAX_USER_INPUT_CHARS)} 字`);
    const exact = await roundTrip(ELICITATION, { decision: 'supply', text: 'x'.repeat(MAX_USER_INPUT_CHARS) });
    expect(exact.failure).toBeNull();
    expect(exact.reply.outcome.kind).toBe('answered');
  });

  it('查无此单与重复应答都结构化失败，且把「还等着哪几张」附在错误里供核对', async () => {
    const { pause } = await bootPause(1000);
    const asking = pause.ask(payloadFor());
    const [waiting] = pause.pending();
    const requestId = waiting?.requestId ?? '';
    // 拼不出来的单号：不猜「他大概想应的是这张」，直接结构化失败。
    expect(captureAppError(() => pause.respond('no-such-request', { decision: 'approve' }))).toMatchObject({
      code: 'APPROVAL_NOT_FOUND',
      path: 'agent.pause',
      details: { requestId: 'no-such-request', pending: [requestId] },
    });
    pause.respond(requestId, { decision: 'approve' });
    await asking;
    // 同一条表态按第二次（界面上双击、或迟到的重放）也失败，且此时一张都不剩——第一句才是那句表态。
    expect(captureAppError(() => pause.respond(requestId, { decision: 'deny' }))).toMatchObject({
      code: 'APPROVAL_NOT_FOUND',
      details: { requestId, pending: [] },
    });
  });
});

describe('服务下线时收单（AGENTS.md §9 的 2.5 实测那条）', () => {
  it('销毁通道服务：在等的单全部按 cancelled 收，不留一个悬着的 await', async () => {
    const { pause, fiber, resolved } = await bootPause(60000);
    // 超时取 60 秒：这张单只可能因为**服务被摘掉**而定局，不会是自己到点的。
    const asking = pause.ask(payloadFor());
    expect(pause.pending()).toHaveLength(1);
    await fiber.dispose();
    const reply = await asking;
    expect(reply.outcome).toEqual({ kind: 'cancelled' });
    expect(resolved).toEqual([[reply.request.requestId, 'cancelled']]);
    expect(pause.pending()).toEqual([]);
    // 摘掉之后这张单再应答也不落地：等待状态不跨重启，也没有库里那份「旧的还在等」。
    expect(captureAppError(() => pause.respond(reply.request.requestId, { decision: 'approve' })).code).toBe(
      'APPROVAL_NOT_FOUND',
    );
  });
});

describe('配置边界（超时那一格的可调范围）', () => {
  it('缺省即 120 秒，且下限 200 毫秒 / 上限 10 分钟都在 schema 上收口', () => {
    expect(agentPauseSchema.parse({})).toEqual({ pauseTimeoutMs: 120000 });
    expect(agentPauseSchema.safeParse({ pauseTimeoutMs: 199 }).success).toBe(false);
    expect(agentPauseSchema.safeParse({ pauseTimeoutMs: 600001 }).success).toBe(false);
    expect(agentPauseSchema.safeParse({ pauseTimeoutMs: 1.5 }).success).toBe(false);
    // 上限之外不许有第二种写法：这一格改一次就会连带重建 `agent.loop`（§9 的 2.5 实测）。
    expect(agentPauseSchema.safeParse({ unknownKey: 1 }).success).toBe(false);
  });
});

/**
 * 5.3-10 的反面：到点之前这张单不会自己动。
 *
 * 单独一条用例而不是在超时用例里顺手看一眼——「没人表态时不放行」要排除的是「中途有个别的东西替人表了态」，
 * 所以判据是**期间**没有任何收单事件，而不是最后那个事件恰好是 `timed-out`。
 */
describe('没人表态时什么都不发生', () => {
  it('一张单挂到超时为止，期间没有第二次定局事件，也没有被应答', async () => {
    const { pause, resolved } = await bootPause(200);
    const asking = pause.ask(payloadFor());
    await sleep(60);
    expect(resolved).toEqual([]);
    expect(pause.pending()).toHaveLength(1);
    await asking;
    expect(resolved).toHaveLength(1);
  });
});
