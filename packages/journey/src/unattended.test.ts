/**
 * 无人值守执行器的 U 半边（spec 10.6 / plan §12.2 第 5 片）。
 *
 * 全部用替身替「外面那些服务」：授权单、账本、生成轨、打招呼、投递、导出、节奏。被测的是执行器自己的判据——
 * 顺序、每笔前的守卫、断点续跑、中止语义——而不是既有外发闸门（那在 outbound/entitlement 的用例里）。
 */
import { AppError, asApp, Context, NO_CONFIG, Service, type Fiber } from '@auto-cc/core';
import { z } from 'zod';
import { afterAll, describe, expect, it } from 'vitest';
import { JourneyUnattendedService } from './unattended.js';

/** 零配置替身共用的 schema（与既有 journey 用例同形）。 */
const empty = z.strictObject({});
const NOW = 1_764_000_000_000;
const PLATFORM = 'boss';
const DOC_ID = 'resume-master';
const fibers: Fiber[] = [];

/** 授权单替身：用例直接改 `view` 演「暂停/过期/重启待确认」。 */
class FakeAuthorizationService extends Service {
  static provide = 'outbound.authorization';
  static Config = empty;
  view = {
    platform: PLATFORM,
    status: 'active',
    targets: ['job-1', 'job-2'],
    resumeVersion: 'doc:seed:aaaa',
  };
  constructor(ctx: Context) {
    super(ctx, 'outbound.authorization');
  }
  current = () => ({ ...this.view, targets: [...this.view.targets] });
}

/** 账本替身：成功位由用例种；`stopped` 演一键停用。 */
class FakeLedgerService extends Service {
  static provide = 'usage.ledger';
  static Config = empty;
  attempts = new Map<string, { status: string; ledgerId: number | null; targetId: string; action: string }>();
  stopped = false;
  constructor(ctx: Context) {
    super(ctx, 'usage.ledger');
  }
  attemptFor = (key: { platform: string; targetId: string; action: string; resumeVersion: string }) =>
    this.attempts.get(`${key.targetId}:${key.action}:${key.resumeVersion}`) ?? null;
  /** 同岗两种动作各有一条 succeeded（版本不限）即算推完。 */
  hasCompletedJob = (_platform: string, targetId: string): boolean => {
    const actions = new Set(
      [...this.attempts.values()]
        .filter((item) => item.targetId === targetId && item.status === 'succeeded')
        .map((item) => item.action),
    );
    return actions.has('greet') && actions.has('deliver');
  };
  outboundStatus = () => ({ stopped: this.stopped });
}

/** 生成轨替身：每岗给一版变体与一条招呼；`blockedFor` 演事实校验拦下。 */
class FakeJourneyService extends Service {
  static provide = 'journey';
  static Config = empty;
  blockedFor: string | null = null;
  tailorCalls: string[] = [];
  constructor(ctx: Context) {
    super(ctx, 'journey');
  }
  tailor = (input: { docId: string; jobId: string; platform?: string }) => {
    this.tailorCalls.push(input.jobId);
    if (this.blockedFor === input.jobId) {
      return Promise.reject(new AppError('JOURNEY_FACT_BLOCKED', '事实校验拦下', 'journey'));
    }
    return Promise.resolve({
      tailoredDocId: `variant-${input.jobId}`,
      tailoredResumeVersion: `doc:variant-${input.jobId}:bbbb`,
      greeting: { text: `招呼 ${input.jobId}` },
    });
  };
}

/** 外发入口替身：记调用顺序，可配置第 N 次抛结构化错误。 */
/** 两个假外发入口共用的行为（不继承：`super` 之前拿不到子类静态名）。 */
type SendFake = {
  calls: string[];
  failOn: { at: number; error: AppError } | null;
  onSuccess: (() => void) | null;
  ledger: FakeLedgerService | null;
};

/**
 * 记一次假外发并按需失败/回调；成功时把成功位写回假账本。
 * @param fake 假外发服务中心共享的字段
 * @param raw 执行器传来的入参
 * @param action 动作名（写进假账本）
 * @returns 假回执（带自增账本行）
 */
function performFake(fake: SendFake, raw: Record<string, unknown>, action: 'greet' | 'deliver') {
  fake.calls.push(String(raw['jobId']));
  if (fake.failOn !== null && fake.calls.length === fake.failOn.at) {
    return Promise.reject(fake.failOn.error);
  }
  const ledgerId = 100 + fake.calls.length;
  fake.ledger?.attempts.set(`${String(raw['jobId'])}:${action}:${String(raw['resumeVersion'])}`, {
    status: 'succeeded',
    ledgerId,
    targetId: String(raw['jobId']),
    action,
  });
  fake.onSuccess?.();
  return Promise.resolve({ ledgerId });
}

/** 打招呼替身。 */
class FakeGreetService extends Service {
  static provide = 'outbound.greet';
  static Config = empty;
  calls: string[] = [];
  failOn: { at: number; error: AppError } | null = null;
  onSuccess: (() => void) | null = null;
  ledger: FakeLedgerService | null = null;
  constructor(ctx: Context) {
    super(ctx, 'outbound.greet');
  }
  perform = (raw: Record<string, unknown>) => performFake(this, raw, 'greet');
}

/** 投递替身。 */
class FakeDeliverService extends Service {
  static provide = 'outbound.deliver';
  static Config = empty;
  calls: string[] = [];
  failOn: { at: number; error: AppError } | null = null;
  onSuccess: (() => void) | null = null;
  ledger: FakeLedgerService | null = null;
  constructor(ctx: Context) {
    super(ctx, 'outbound.deliver');
  }
  perform = (raw: Record<string, unknown>) => performFake(this, raw, 'deliver');
}

/** 导出替身。 */
class FakeExportService extends Service {
  static provide = 'resume.export';
  static Config = empty;
  exported: string[] = [];
  constructor(ctx: Context) {
    super(ctx, 'resume.export');
  }
  toPdf = (docId: string) => {
    this.exported.push(docId);
    return Promise.resolve({ path: `/tmp/${docId}.pdf`, snapshotId: `snap-${docId}` });
  };
}

/** 节奏替身：压到 1ms，保证用例不真的等。 */
class FakeThrottleService extends Service {
  static provide = 'outbound.throttle';
  static Config = empty;
  constructor(ctx: Context) {
    super(ctx, 'outbound.throttle');
  }
  nextGapMs = () => 1;
}

/** 一次装配：七只替身 + 真执行器。 */
async function boot() {
  const ctx = new Context();
  fibers.push(await ctx.plugin(FakeAuthorizationService, NO_CONFIG));
  fibers.push(await ctx.plugin(FakeLedgerService, NO_CONFIG));
  fibers.push(await ctx.plugin(FakeJourneyService, NO_CONFIG));
  fibers.push(await ctx.plugin(FakeGreetService, NO_CONFIG));
  fibers.push(await ctx.plugin(FakeDeliverService, NO_CONFIG));
  fibers.push(await ctx.plugin(FakeExportService, NO_CONFIG));
  fibers.push(await ctx.plugin(FakeThrottleService, NO_CONFIG));
  fibers.push(await ctx.plugin(JourneyUnattendedService, { stepTimeoutMs: 120_000 }));
  const app = asApp(ctx);
  const ledger = ctx.get('usage.ledger') as unknown as FakeLedgerService;
  const greet = ctx.get('outbound.greet') as unknown as FakeGreetService;
  const deliver = ctx.get('outbound.deliver') as unknown as FakeDeliverService;
  // 两个假外发入口把成功位写回假账本：否则执行器的「这岗推完了」永远读不到。
  greet.ledger = ledger;
  deliver.ledger = ledger;
  // 裁定 C：执行器状态变化必须推一条，角标靠它刷新（不是轮询）。这里记下来给用例断言。
  const changed: { status: string; pendingCount: number }[] = [];
  ctx.on('journey/unattended-changed', (reading: { status: string; pendingCount: number }) => {
    changed.push(reading);
  });
  return {
    executor: app['journey.unattended'],
    changed,
    auth: ctx.get('outbound.authorization') as unknown as FakeAuthorizationService,
    ledger,
    journey: ctx.get('journey') as unknown as FakeJourneyService,
    greet,
    deliver,
  };
}

/** 等执行器离开 running（轮询不算测试依据，只是为了不引入假时钟）。 */
async function settled(executor: JourneyUnattendedService, timeoutMs = 3_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = executor.view(NOW).status;
    // `stopping` 也是「还在收尾」：它不是终态，要一直等到 stopped/done/… 才算落定。
    if (state !== 'running' && state !== 'stopping') return state;
    if (Date.now() > deadline) throw new Error(`执行器一直停在 ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
});

describe('无人值守执行器（10.6 / plan §12.2）', () => {
  it('按授权单顺序逐岗推进：每岗 定制 → 招呼 → 投递，且逐笔带 unattended', async () => {
    const { executor, greet, deliver, journey } = await boot();
    const started = executor.start({ docId: DOC_ID, nowMs: NOW });
    expect(started.status).toBe('running');
    expect(await settled(executor)).toBe('done');
    expect(journey.tailorCalls).toEqual(['job-1', 'job-2']);
    expect(greet.calls).toEqual(['job-1', 'job-2']);
    expect(deliver.calls).toEqual(['job-1', 'job-2']);
    const view = executor.view(NOW);
    expect(view.completed.map((item) => item.jobId)).toEqual(['job-1', 'job-2']);
    expect(view.failed).toEqual([]);
    expect(view.pending).toEqual([]);
  });

  it('额度用尽：本轮停下并标 blocked，不再推进下一岗', async () => {
    const { executor, greet, deliver } = await boot();
    greet.failOn = {
      at: 2,
      error: new AppError('AUTHORIZATION_QUOTA_EXHAUSTED', '今日额度已用尽', 'outbound.authorization'),
    };
    executor.start({ docId: DOC_ID, nowMs: NOW });
    expect(await settled(executor)).toBe('blocked');
    expect(greet.calls).toEqual(['job-1', 'job-2']);
    expect(deliver.calls).toEqual(['job-1']);
    const view = executor.view(NOW);
    expect(view.completed.map((item) => item.jobId)).toEqual(['job-1']);
    expect(view.lastError).toContain('额度');
  });

  it('一键停用：检测到停用位后不再发起下一笔，终态 stopped', async () => {
    const { executor, greet, deliver, ledger } = await boot();
    greet.onSuccess = () => {
      // 第一岗的招呼成功之后人按了停用：下一笔（投递）的守卫就该拦住。
      ledger.stopped = true;
    };
    executor.start({ docId: DOC_ID, nowMs: NOW });
    expect(await settled(executor)).toBe('stopped');
    expect(greet.calls).toEqual(['job-1']);
    expect(deliver.calls).toEqual([]);
    expect(executor.view(NOW).completed).toEqual([]);
  });

  it('执行器状态变了会推 journey/unattended-changed（角标靠它刷新，不轮询）', async () => {
    const { executor, changed } = await boot();
    executor.start({ docId: DOC_ID, nowMs: NOW });
    expect(changed.at(-1)?.status).toBe('running');
    expect(changed.at(-1)?.pendingCount).toBeGreaterThan(0);
    executor.stop(NOW + 1);
    expect(changed.at(-1)?.status).toBe('stopping');
    expect(await settled(executor)).toBe('stopped');
    expect(changed.at(-1)?.status).toBe('stopped');
  });

  it('按停止后状态立刻落到 stopping（不许还是 running），循环收尾再落 stopped', async () => {
    const { executor } = await boot();
    executor.start({ docId: DOC_ID, nowMs: NOW });
    // 起跑后立刻按停止：界面拿到的第一份读数就必须是 stopping，不能是 running
    expect(executor.stop(NOW + 1).status).toBe('stopping');
    // 再按一次也不许把状态改回 running
    expect(executor.stop(NOW + 2).status).toBe('stopping');
    // 循环在下一个检查点退出，终态仍是 stopped（finish 允许从 stopping 收尾）
    expect(await settled(executor)).toBe('stopped');
  });

  it('风控暂停：授权单转 paused 后整轮停手，终态 paused', async () => {
    const { executor, greet, deliver, auth } = await boot();
    greet.onSuccess = () => {
      auth.view.status = 'paused';
    };
    executor.start({ docId: DOC_ID, nowMs: NOW });
    expect(await settled(executor)).toBe('paused');
    expect(greet.calls).toEqual(['job-1']);
    expect(deliver.calls).toEqual([]);
    expect(executor.view(NOW).lastError).toContain('风控');
  });

  it('断点续跑：账本里已成功的招呼不再重发，只补投递；完成读数沿用原账行', async () => {
    const { executor, greet, deliver, ledger } = await boot();
    ledger.attempts.set('job-1:greet:doc:variant-job-1:bbbb', {
      status: 'succeeded',
      ledgerId: 77,
      targetId: 'job-1',
      action: 'greet',
    });
    executor.start({ docId: DOC_ID, nowMs: NOW });
    expect(await settled(executor)).toBe('done');
    expect(greet.calls).toEqual(['job-2']);
    expect(deliver.calls).toEqual(['job-1', 'job-2']);
    expect(executor.view(NOW).completed[0]).toMatchObject({ jobId: 'job-1', greetLedgerId: 77 });
  });

  it('起跑前置：重启未确认 / 跨日 / 暂停都不开跑', async () => {
    const { executor, auth } = await boot();
    auth.view.status = 'restart-required';
    expect(() => executor.start({ docId: DOC_ID, nowMs: NOW })).toThrow(/确认续跑/);
    auth.view.status = 'expired';
    expect(() => executor.start({ docId: DOC_ID, nowMs: NOW })).toThrow();
    auth.view.status = 'paused';
    expect(() => executor.start({ docId: DOC_ID, nowMs: NOW })).toThrow(/暂停/);
  });
});
