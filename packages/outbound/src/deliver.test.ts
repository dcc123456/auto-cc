/**
 * 简历投递编排的骨架测试（spec 2.6-01 / 02 / 03 / 05 / 06 / 07）。
 *
 * 判据与打招呼那套一致：**渠道有没有被调、账本有没有多一行**。投递比打招呼多一个「等人」的环节，
 * 所以这里把「等人」的四种定局（批准 / 拒绝 / 超时 / 让出）各测一遍，四种都不许有一行账——
 * 「没人表态」永远不等于「同意」（AGENTS.md §8 第 3 条）。
 * 简历文件是真的：临时目录里写一份 pdf，`sha256` 与大小由同一份字节算出来，
 * 这样 `source` 那半条可追溯（2.6-05）才是查库断言而不是字符串拼接自检。
 * 测试不访问真实平台（AGENTS.md §7.2）：渠道是假登记表里那条，一次网络都不发。
 */
import {
  AppError,
  asApp,
  Context,
  Service,
  type DeliverApprovalView,
  type DeliverOutcome,
  type Fiber,
  type ResumeAttachment,
  type ResumeChannelSource,
  type ResumeDeliveryChannel,
  type WorkflowNodeSpec,
} from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import {
  DEFAULT_DAILY_LIMITS,
  EntitlementGateService,
  UsageLedgerService,
  type GateConfig,
} from '@auto-cc/plugin-entitlement';
import { StoreService } from '@auto-cc/plugin-store';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DELIVER_ACTION, DELIVER_NODE_KIND, OutboundDeliverService, type DeliverConfig } from './deliver.js';
import { FakeSessionsService } from './test-doubles.js';
import { OutboundThrottleService, type OutboundThrottleConfig } from './throttle.js';

/** 判定基准：一个真实的当下毫秒数，所有 `nowMs` 都在它附近，避免与本地日界打架。 */
const T0 = 1_760_000_000_000;

/** 投递每天只许 1 次的闸门配置；另两条留 shipped 默认，避免用例里抄一份额度数字。 */
const GATE_ONE_DELIVER: GateConfig = {
  mode: 'daily',
  dailyLimits: { ...DEFAULT_DAILY_LIMITS, deliver: 1 },
};

const sandboxes: string[] = [];

afterAll(() => {
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放时允许残渣留在系统 temp（与 greet/entitlement 用例同一处置）。
    }
  }
});

/** 那份「真简历」的字节：内容固定，hash 因此可预期。 */
const RESUME_CONTENT = Buffer.from('%PDF-1.4\n投递用例的假简历正文\n%%EOF\n', 'utf8');
/** 整份字节的 sha256（十六进制小写），`source` 取它的前 12 位（spec 2.6-05）。 */
const RESUME_SHA = createHash('sha256').update(RESUME_CONTENT).digest('hex');
/** 简历大小上限的最小合法值（schema 的 `min(1024)`），用例靠它演「超了就不该发」。 */
const MIN_RESUME_BYTES = 1024;

/**
 * 把假简历写进本次用例的沙箱。
 * @param dir 沙箱目录
 * @param name 文件名（`.txt` 用来演「不是 pdf」那一支）
 * @returns 文件的绝对路径
 */
function writeResume(dir: string, name = 'resume.pdf'): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, RESUME_CONTENT);
  return filePath;
}

/** 一次渠道调用的读数。 */
type DeliverCall = { targetId: string; attachment: ResumeAttachment };

/**
 * 假的 `platform.registry`：只回答「这个平台现在能不能递简历」。
 *
 * 挂它是因为 `outbound.deliver` 把平台层列为硬依赖（`inject`），而不是因为它有被测逻辑；
 * 登记表做成可增删的，用来证明编排层每次**现问**、自己不缓存渠道（plan §12.13）。
 */
class FakePlatformRegistryService extends Service implements ResumeChannelSource {
  static provide = 'platform.registry';
  static Config = z.strictObject({});

  private readonly channels = new Map<string, ResumeDeliveryChannel>();

  constructor(ctx: Context, _options: Record<string, never>) {
    super(ctx, 'platform.registry');
  }

  /**
   * 往登记表里放一条渠道（真实现里这一步是平台包登记自己的适配器）。
   * @param platform 平台标识
   * @param channel 渠道实现
   */
  add(platform: string, channel: ResumeDeliveryChannel): void {
    this.channels.set(platform, channel);
  }

  /**
   * 从登记表里取走一条渠道（演「适配器被摘掉」）。
   * @param platform 平台标识
   */
  remove(platform: string): void {
    this.channels.delete(platform);
  }

  /** 契约见 `ResumeChannelSource.deliverChannel`。 */
  deliverChannel = (platform: string): ResumeDeliveryChannel | null => this.channels.get(platform) ?? null;

  /** 契约见 `ResumeChannelSource.deliverablePlatforms`。 */
  deliverablePlatforms = (): string[] => [...this.channels.keys()];
}

/** `boot` 的装配项：额度、频控间隔、渠道、档位、确认超时、大小上限、默认简历、复用目录。 */
type BootOptions = {
  gate?: GateConfig;
  gapMs?: number;
  channel?: ResumeDeliveryChannel;
  dir?: string;
  autonomy?: DeliverConfig['autonomy'];
  approveTimeoutMs?: number;
  maxResumeBytes?: number;
  resumeFile?: string;
};

/**
 * 装配到 `outbound.deliver` 为止的整套真实服务（闸门/账本/频控都用真身，只有平台层是替身）。
 * @param options 见 `BootOptions`
 * @returns 上下文、投递服务、假登记表、账本，以及投递那一根的 `Fiber`（演「服务被重建」时用）
 */
async function boot(options: BootOptions = {}) {
  // 传 dir 是演「换个进程重挂同一份库」：库是那份库，实例是全新的一轮挂载。
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'auto-cc-deliver-'));
  if (!options.dir) sandboxes.push(dir);
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' });
  await ctx.plugin(UsageLedgerService, {});
  await ctx.plugin(EntitlementGateService, options.gate ?? { mode: 'unlimited', dailyLimits: DEFAULT_DAILY_LIMITS });
  const gap = options.gapMs ?? 0;
  const throttleConfig: OutboundThrottleConfig = { minGapMs: gap, maxGapMs: gap, scrollMinGapMs: 0, scrollMaxGapMs: 0 };
  await ctx.plugin(OutboundThrottleService, throttleConfig);
  await ctx.plugin(FakePlatformRegistryService, {});
  await ctx.plugin(FakeSessionsService, {});
  // 替身要在挂载之后取：`ctx.get` 返回的是那个真实例，用例才改得动它的登记表（同 greet 用例的先例）。
  const registry = ctx.get('platform.registry') as unknown as FakePlatformRegistryService;
  const sessions = ctx.get('sessions') as unknown as FakeSessionsService;
  // 默认当作「已经点过风险确认」（同 greet 用例）：本文件测的是投递的九种失败分支，
  // 要演「没签过字」的用例自己 `sessions.revoke('boss')`。
  sessions.grant('boss');
  if (options.channel) registry.add('boss', options.channel);
  const deliverConfig: DeliverConfig = {
    autonomy: options.autonomy ?? 'semi',
    approveTimeoutMs: options.approveTimeoutMs ?? 120_000,
    maxResumeBytes: options.maxResumeBytes ?? 5_242_880,
    ...(options.resumeFile === undefined ? {} : { resumeFile: options.resumeFile }),
  };
  const deliverFiber: Fiber = await ctx.plugin(OutboundDeliverService, deliverConfig);
  return {
    ctx,
    dir,
    deliver: asApp(ctx)['outbound.deliver'],
    registry,
    sessions,
    ledger: asApp(ctx)['usage.ledger'],
    deliverFiber,
  };
}

/**
 * 造一只「按脚本回话」的假投递渠道：记录每次调用，返回预设结局。
 * @param outcome 回读结局；给 Error 时按原样抛出（演「页面说岗位已下架」）
 * @returns 可登记进假登记表的渠道，附带调用读数
 */
function fakeChannel(outcome: DeliverOutcome | Error = { sent: true, reason: '状态行回读到成功样式：简历已送达' }): {
  channel: ResumeDeliveryChannel;
  calls: DeliverCall[];
} {
  const calls: DeliverCall[] = [];
  return {
    calls,
    channel: {
      send: (targetId: string, attachment: ResumeAttachment) => {
        calls.push({ targetId, attachment });
        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
      },
    },
  };
}

/**
 * 一份合法的投递请求。
 * @param over 覆盖项（目标、文件路径、所属运行）
 * @returns 交给 `perform` / `stage` 的未知值
 */
function request(over: Partial<{ jobId: string; filePath: string | undefined; workflowRunId: string | null }> = {}) {
  return {
    platform: 'boss',
    jobId: over.jobId ?? 'job-1001',
    filePath: 'filePath' in over ? over.filePath : join('unused', 'resume.pdf'),
    title: '资深前端工程师',
    company: '示例科技',
    workflowRunId: over.workflowRunId ?? null,
    nowMs: T0,
  };
}

/**
 * 等一拍：编排是 async 的，确认卡片要过了 `stage` 才登记得上，用例因此得让出一次事件循环。
 * @param ms 等待毫秒
 * @returns 到点的 Promise
 */
const nap = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 收下一条同步抛出的结构化错误，好断言它的码（错误本身就是契约的一半）。
 * @param fn 应当抛出的那段调用
 * @returns 抛出的 `AppError`
 */
function thrown(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    return error as AppError;
  }
  throw new Error('应当抛出结构化错误');
}

/** 一条合法的节点参数（只填执行器真正读的字段，其余按登记处的默认形状给）。 */
function nodeSpec(params: Record<string, string | number | boolean>): WorkflowNodeSpec {
  return {
    id: 'deliver-1',
    kind: DELIVER_NODE_KIND,
    target: String(params.job ?? ''),
    params,
    effect: 'outbound',
    retryTimes: 0,
    requiresHuman: false,
  };
}

describe('投递的档位与人工确认（spec 2.6-01 / 2.6-06）', () => {
  it('默认档位 semi：确认卡片挂在服务上，点确认之前渠道一次都没被调', async () => {
    const hand = fakeChannel();
    const { dir, deliver, ledger } = await boot({ channel: hand.channel });
    const filePath = writeResume(dir);
    const pending = deliver.perform(request({ filePath }));
    await nap();

    // 「现在在等什么」是现读出来的，不是界面自己攒的：刷新/重开面板靠这一个方法就能重画卡片。
    const cards = deliver.pending();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      platform: 'boss',
      jobId: 'job-1001',
      title: '资深前端工程师',
      company: '示例科技',
      attachment: { fileName: 'resume.pdf', sizeBytes: RESUME_CONTENT.byteLength, sha256: RESUME_SHA },
    });
    expect(cards[0]!.expiresAt).toBe(cards[0]!.requestedAt + 120_000);
    // 绝对路径不进界面：它带用户名，而确认卡片只需要「递的是哪份文件」（AGENTS.md §8 第 5 条）。
    expect(cards[0]!.attachment).not.toHaveProperty('path');
    expect(hand.calls).toHaveLength(0);
    expect(ledger.count()).toBe(0);

    deliver.resolveApproval(cards[0]!.approvalId, true);
    const receipt = await pending;
    expect(receipt).toMatchObject({ committed: true, jobId: 'job-1001', waitedMs: 0 });
    expect(receipt.attachment).toEqual({
      fileName: 'resume.pdf',
      sizeBytes: RESUME_CONTENT.byteLength,
      sha256: RESUME_SHA,
    });
    expect(receipt.reason).toBe('状态行回读到成功样式：简历已送达');
    expect(hand.calls).toHaveLength(1);
    expect(deliver.pending()).toEqual([]);
  });

  it('等人表态是一次事件推送：载荷与 pending() 的读数逐字相同，定局后不再补发（spec 2.6-01）', async () => {
    const hand = fakeChannel();
    const { ctx, dir, deliver } = await boot({ channel: hand.channel });
    const emitted: DeliverApprovalView[] = [];
    const off = ctx.on('outbound/approval-requested', (event) => {
      emitted.push(event);
    });
    const pending = deliver.perform(request({ filePath: writeResume(dir) }));
    await nap();

    // 事件的用途只有「此刻提醒一下」，所以它必须与现读的那张单子**一模一样**：界面两条路画出同一张卡片。
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual(deliver.pending()[0]);
    expect(emitted[0]!.attachment).not.toHaveProperty('path');

    deliver.resolveApproval(emitted[0]!.approvalId, true);
    await pending;
    // 定局（批准/拒绝/超时）都以「单子在 pending() 里消失」表达，不是一条新事件：
    // 补发会让错过推送的界面永远留着那张卡片，而它其实只该信读数。
    expect(emitted).toHaveLength(1);
    off();
  });

  it('免审批的 auto 与只准备的 suggest 都不发确认事件：没人该被叫来看一张不存在的卡片', async () => {
    const hand = fakeChannel();
    const emitted: DeliverApprovalView[] = [];
    for (const autonomy of ['auto', 'suggest'] as const) {
      const { ctx, dir, deliver } = await boot({ channel: hand.channel, autonomy });
      const off = ctx.on('outbound/approval-requested', (event) => {
        emitted.push(event);
      });
      await deliver.perform(request({ filePath: writeResume(dir) }));
      expect(deliver.pending()).toEqual([]);
      off();
    }
    expect(emitted).toEqual([]);
    // `auto` 直接发出去了，`suggest` 只准备——两者都不经过「等人」这一步。
    expect(hand.calls).toHaveLength(1);
  });

  it('用户在卡片上点拒绝：OUTBOUND_APPROVAL_DENIED，不发送不落账', async () => {
    const hand = fakeChannel();
    const { dir, deliver, ledger } = await boot({ channel: hand.channel });
    const pending = deliver.perform(request({ filePath: writeResume(dir) }));
    await nap();
    deliver.resolveApproval(deliver.pending()[0]!.approvalId, false);
    await expect(pending).rejects.toMatchObject({ code: 'OUTBOUND_APPROVAL_DENIED', details: { jobId: 'job-1001' } });
    expect(hand.calls).toHaveLength(0);
    expect(ledger.count()).toBe(0);
    expect(deliver.pending()).toEqual([]);
  });

  it('没人表态：到超时按拒绝处理，绝不默认放行', async () => {
    const hand = fakeChannel();
    const { dir, deliver, ledger } = await boot({ channel: hand.channel, approveTimeoutMs: 20 });
    await expect(deliver.perform(request({ filePath: writeResume(dir) }))).rejects.toMatchObject({
      code: 'OUTBOUND_APPROVAL_DENIED',
      message: expect.stringContaining('按拒绝处理'),
    });
    expect(hand.calls).toHaveLength(0);
    expect(ledger.count()).toBe(0);
  });

  it('确认单只生效一次：定局之后再点、或点一个不存在的 id，都是 APPROVAL_NOT_FOUND 而不是放行', async () => {
    const hand = fakeChannel();
    const { dir, deliver } = await boot({ channel: hand.channel });
    const pending = deliver.perform(request({ filePath: writeResume(dir) }));
    await nap();
    const approvalId = deliver.pending()[0]!.approvalId;
    deliver.resolveApproval(approvalId, true);
    // 重复点击（界面按钮没禁用、或两次渲染都留了按钮）不该把同一次投递发两遍。
    expect(thrown(() => deliver.resolveApproval(approvalId, true)).code).toBe('APPROVAL_NOT_FOUND');
    // 服务被重建后 Map 是空的：老单子的 id 查不到就报结构化失败（fail-closed，与「找不到就发」相反）。
    const ghost = thrown(() => deliver.resolveApproval('00000000-0000-0000-0000-000000000000', true));
    expect(ghost.code).toBe('APPROVAL_NOT_FOUND');
    expect(ghost.details).toMatchObject({ pending: [] });
    await pending;
    expect(hand.calls).toHaveLength(1);
  });

  it('暂停能打断等待：让出时不发送、不落账，卡片也一起收掉（与打招呼的让出语义逐字一致）', async () => {
    const hand = fakeChannel();
    const { dir, deliver, ledger } = await boot({ channel: hand.channel });
    const controller = new AbortController();
    const pending = deliver.perform(request({ filePath: writeResume(dir) }), controller.signal);
    await nap();
    expect(deliver.pending()).toHaveLength(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'WORKFLOW_STEP_FAILED' });
    expect(deliver.pending()).toEqual([]);
    expect(hand.calls).toHaveLength(0);
    expect(ledger.count()).toBe(0);
  });

  it('等待期间服务被重建（改配置热改）：悬着的等待按拒绝收掉，不留悬挂（plan §13.3 第 2 条）', async () => {
    const hand = fakeChannel();
    const { dir, deliver, deliverFiber, ledger } = await boot({ channel: hand.channel });
    const pending = deliver.perform(request({ filePath: writeResume(dir) }));
    await nap();
    await deliverFiber.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'OUTBOUND_APPROVAL_DENIED' });
    expect(deliver.pending()).toEqual([]);
    expect(hand.calls).toHaveLength(0);
    expect(ledger.count()).toBe(0);
  });

  it('档位 auto：免审批直接投递，卡片一次都不出现', async () => {
    const hand = fakeChannel();
    const { dir, deliver, ledger } = await boot({ channel: hand.channel, autonomy: 'auto' });
    const receipt = await deliver.perform(request({ filePath: writeResume(dir) }));
    expect(receipt.committed).toBe(true);
    expect(deliver.pending()).toEqual([]);
    expect(hand.calls).toHaveLength(1);
    expect(ledger.count()).toBe(1);
  });

  it('档位 suggest：只准备不发送，回执 committed:false 且账本一行都不增（2.6-06）', async () => {
    const hand = fakeChannel();
    const { ctx, dir, deliver, ledger } = await boot({ channel: hand.channel, autonomy: 'suggest' });
    const receipt = await deliver.perform(request({ filePath: writeResume(dir) }));
    expect(receipt).toMatchObject({
      committed: false,
      ledgerId: null,
      waitedMs: 0,
      reason: '档位 suggest：已备好 resume.pdf，未发送',
      source: `resume:${RESUME_SHA.slice(0, 12)}@resume.pdf`,
    });
    expect(hand.calls).toHaveLength(0);
    expect(ledger.count()).toBe(0);
    // 只准备的那一步连闸门都不进：额度仍然满格（2.6-06 的「一键交给用户手动完成」不该吃掉一次额度）。
    expect(asApp(ctx)['entitlement.gate'].check(DELIVER_ACTION, { nowMs: T0 })).toMatchObject({ allowed: true });
  });

  it('suggest 档的工作流节点不算这一步成功：抛错让面板停在「未发送」而不是打勾', async () => {
    const hand = fakeChannel();
    const { dir, deliver, ledger } = await boot({ channel: hand.channel, autonomy: 'suggest' });
    const error = await deliver
      .executeNode({
        runId: 'run-1',
        spec: nodeSpec({ platform: 'boss', job: 'job-1001', file: writeResume(dir) }),
        attempt: 1,
        signal: new AbortController().signal,
      })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('OUTBOUND_APPROVAL_DENIED');
    expect((error as AppError).path).toBe(DELIVER_NODE_KIND);
    expect(hand.calls).toHaveLength(0);
    expect(ledger.count()).toBe(0);
  });
});

describe('投递的账本、额度与频控（spec 2.6-02 / 03 / 05）', () => {
  it('成功那一路：账本一行的动作/目标/来源/时间戳与请求一一对上，source 带简历 hash', async () => {
    const hand = fakeChannel();
    const { dir, deliver, ledger } = await boot({ channel: hand.channel, autonomy: 'auto' });
    const filePath = writeResume(dir);
    const receipt = await deliver.perform(request({ filePath, workflowRunId: 'run-1' }));
    // 渠道拿到的是编排层校验过的那四要素：路径原样（动作层要按它把字节交给 CDP）。
    expect(hand.calls[0]).toEqual({
      targetId: 'job-1001',
      attachment: { path: filePath, fileName: 'resume.pdf', sizeBytes: RESUME_CONTENT.byteLength, sha256: RESUME_SHA },
    });
    const row = ledger.summary().recent[0];
    expect(row).toMatchObject({
      id: receipt.ledgerId,
      action: DELIVER_ACTION,
      targetId: 'job-1001',
      workflowRunId: 'run-1',
      ts: T0,
    });
    // spec 2.6-05 的可追溯形状：`resume:<sha256 前 12 位>@<文件名>`，复用已有的 `source` 列、不加迁移。
    expect(row!.source).toBe(`resume:${RESUME_SHA.slice(0, 12)}@resume.pdf`);
    expect(receipt.source).toBe(row!.source);
  });

  it('额度到量：第二次以 QUOTA_EXCEEDED 被拒并给出剩余额度，且等频控间隔之前就走（不白等）', async () => {
    const hand = fakeChannel();
    const gapMs = 3_000;
    const { dir, deliver, ledger } = await boot({
      gate: GATE_ONE_DELIVER,
      gapMs,
      autonomy: 'auto',
      channel: hand.channel,
    });
    const filePath = writeResume(dir);
    await deliver.perform(request({ filePath, jobId: 'job-1001' }));
    const started = Date.now();
    await expect(deliver.perform(request({ filePath, jobId: 'job-2002' }))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { action: DELIVER_ACTION, remaining: 0 },
    });
    expect(Date.now() - started).toBeLessThan(gapMs);
    expect(hand.calls).toHaveLength(1);
    expect(ledger.count()).toBe(1);
  });

  it('频控以账本最近一条 deliver 为钟：第二条等满整段间隔，账本时间戳差等于间隔', async () => {
    const hand = fakeChannel();
    const { dir, deliver, ledger } = await boot({ channel: hand.channel, autonomy: 'auto', gapMs: 25 });
    const filePath = writeResume(dir);
    const first = await deliver.perform(request({ filePath, jobId: 'job-1001' }));
    const second = await deliver.perform(request({ filePath, jobId: 'job-2002' }));
    expect(first.waitedMs).toBe(0);
    expect(second.waitedMs).toBe(25);
    const timestamps = ledger
      .summary()
      .recent.map((row) => row.ts)
      .sort((a, b) => a - b);
    expect(timestamps).toEqual([T0, T0 + 25]);
  });

  it('页面回读说没递出去：OUTBOUND_NOT_DELIVERED，渠道被调过但账本一行都不增（2.6-03 的失败侧）', async () => {
    const hand = fakeChannel({ sent: false, reason: '状态行未变化，页面没有确认送达' });
    const { dir, deliver, ledger } = await boot({ channel: hand.channel, autonomy: 'auto' });
    await expect(deliver.perform(request({ filePath: writeResume(dir) }))).rejects.toMatchObject({
      code: 'OUTBOUND_NOT_DELIVERED',
      details: { jobId: 'job-1001' },
    });
    expect(hand.calls).toHaveLength(1);
    expect(ledger.count()).toBe(0);
  });

  it('页面说岗位已下架：DELIVER_TARGET_OFFLINE 原样上浮、不落账——「别再试这个目标」与「这条没发出去」是两种结局（2.6-07）', async () => {
    const offline = new AppError(
      'DELIVER_TARGET_OFFLINE',
      '目标岗位已下架：状态行回读到「岗位已下架」',
      'platform.boss',
      {
        jobId: 'job-1001',
      },
    );
    const hand = fakeChannel(offline);
    const { dir, deliver, ledger } = await boot({ channel: hand.channel, autonomy: 'auto' });
    const error = await deliver.perform(request({ filePath: writeResume(dir) })).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('DELIVER_TARGET_OFFLINE');
    expect(ledger.count()).toBe(0);
  });

  it('同 run 同目标重递：第二次在 stage 就被拒，渠道与额度都不消耗（判据在账本里，不在内存集合里）', async () => {
    const hand = fakeChannel();
    const { dir, deliver, ledger } = await boot({ channel: hand.channel, autonomy: 'auto' });
    const filePath = writeResume(dir);
    await deliver.perform(request({ filePath, workflowRunId: 'run-1' }));
    await expect(deliver.perform(request({ filePath, workflowRunId: 'run-1' }))).rejects.toMatchObject({
      code: 'OUTBOUND_ALREADY_SENT',
      details: { jobId: 'job-1001', workflowRunId: 'run-1' },
    });
    // 换一个 run 或换一个目标仍可递（与打招呼同一口径）。
    await deliver.perform(request({ filePath, jobId: 'job-2002', workflowRunId: 'run-1' }));
    await deliver.perform(request({ filePath, workflowRunId: 'run-2' }));
    expect(hand.calls).toHaveLength(3);
    expect(ledger.count()).toBe(3);
  });

  it('换个进程重挂同一份库：重复投递防护照样成立', async () => {
    const hand = fakeChannel();
    const { dir, deliver } = await boot({ channel: hand.channel, autonomy: 'auto' });
    const filePath = writeResume(dir);
    await deliver.perform(request({ filePath, workflowRunId: 'run-1' }));
    const second = await boot({ dir, channel: hand.channel, autonomy: 'auto' });
    await expect(second.deliver.perform(request({ filePath, workflowRunId: 'run-1' }))).rejects.toMatchObject({
      code: 'OUTBOUND_ALREADY_SENT',
    });
    expect(hand.calls).toHaveLength(1);
  });
});

describe('投递前的文件校验与渠道现问（spec 2.6-06 / plan §12.13）', () => {
  it('请求没带 filePath：用配置里的默认简历；两处都没给则 INVALID_ARGUMENT', async () => {
    const hand = fakeChannel();
    const { dir, deliver, ledger } = await boot({ channel: hand.channel, autonomy: 'auto' });
    await expect(deliver.perform(request({ filePath: undefined }))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('resumeFile'),
    });
    expect(hand.calls).toHaveLength(0);
    expect(ledger.count()).toBe(0);

    const withDefault = await boot({
      dir,
      channel: hand.channel,
      autonomy: 'auto',
      resumeFile: writeResume(dir, 'default-resume.pdf'),
    });
    const receipt = await withDefault.deliver.perform(request({ filePath: undefined, jobId: 'job-3003' }));
    expect(receipt.attachment.fileName).toBe('default-resume.pdf');
    expect(hand.calls).toHaveLength(1);
  });

  it('文件读不出 / 是个目录 / 不是 pdf / 超过大小上限：都在 stage 就失败，渠道一次都不被调', async () => {
    const hand = fakeChannel();
    const { dir, deliver, ledger } = await boot({ channel: hand.channel, autonomy: 'auto' });
    const missing = join(dir, 'missing.pdf');
    await expect(deliver.perform(request({ filePath: missing }))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { filePath: missing },
    });
    const directory = join(dir, 'a-directory');
    mkdirSync(directory);
    expect(
      (await deliver.perform(request({ filePath: directory })).catch((r: unknown) => r)) as AppError,
    ).toMatchObject({
      code: 'INVALID_ARGUMENT',
    });

    const textResume = writeResume(dir, 'resume.txt');
    await expect(deliver.perform(request({ filePath: textResume }))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('只支持 pdf'),
    });

    const oversized = join(dir, 'oversized.pdf');
    const oversizedBytes = MIN_RESUME_BYTES * 2;
    writeFileSync(oversized, Buffer.alloc(oversizedBytes, 0x25));
    const tight = await boot({ dir, channel: hand.channel, autonomy: 'auto', maxResumeBytes: MIN_RESUME_BYTES });
    await expect(tight.deliver.perform(request({ filePath: oversized }))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('超过上限'),
      details: { sizeBytes: oversizedBytes },
    });
    expect(hand.calls).toHaveLength(0);
    expect(ledger.count()).toBe(0);
  });

  it('渠道是每次现问的：挂载时登记表为空不影响后来；stage 之后被摘掉则以缺渠道失败', async () => {
    const hand = fakeChannel();
    const { dir, deliver, registry, ledger } = await boot({ autonomy: 'auto' });
    const filePath = writeResume(dir);
    await expect(deliver.perform(request({ filePath }))).rejects.toMatchObject({
      code: 'OUTBOUND_CHANNEL_MISSING',
      details: { platform: 'boss', deliverable: [] },
    });

    registry.add('boss', hand.channel);
    const receipt = await deliver.perform(request({ filePath, jobId: 'job-2002' }));
    expect(receipt.jobId).toBe('job-2002');
    expect(hand.calls).toHaveLength(1);
    expect(ledger.count()).toBe(1);

    // stage 之后、commit 之前适配器被摘掉（卸载平台包 / 单独重启）：以缺渠道失败，
    // 而不是拿一只已销毁的适配器往页面上点。
    const staged = deliver.stage(request({ filePath, jobId: 'job-3003' }));
    registry.remove('boss');
    const error = await deliver.commit(staged).catch((reason: unknown) => reason);
    expect((error as AppError).code).toBe('OUTBOUND_CHANNEL_MISSING');
    // `stage` 是同步的（这一段没有一处异步），所以缺渠道是直接抛而不是一个 rejected Promise。
    expect(thrown(() => deliver.stage(request({ filePath, jobId: 'job-4004' }))).code).toBe('OUTBOUND_CHANNEL_MISSING');
    expect(hand.calls).toHaveLength(1);
    expect(ledger.count()).toBe(1);
  });

  it('节点路径：参数进得来、runId 进幂等键、让出在发送之前收手', async () => {
    const hand = fakeChannel();
    const { dir, deliver, ledger } = await boot({ channel: hand.channel, autonomy: 'auto', gapMs: 25 });
    const filePath = writeResume(dir);
    await deliver.executeNode({
      runId: 'run-9',
      spec: nodeSpec({ platform: 'boss', job: 'job-1001', file: filePath }),
      attempt: 1,
      signal: new AbortController().signal,
    });
    expect(hand.calls).toHaveLength(1);
    expect(ledger.summary().recent[0]?.workflowRunId).toBe('run-9');

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      deliver.executeNode({
        runId: 'run-10',
        spec: nodeSpec({ platform: 'boss', job: 'job-3003', file: filePath }),
        attempt: 1,
        signal: aborted.signal,
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_STEP_FAILED' });
    expect(hand.calls).toHaveLength(1);

    await expect(
      deliver.executeNode({
        runId: 'run-11',
        spec: nodeSpec({ platform: 'boss', file: filePath }),
        attempt: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', path: DELIVER_NODE_KIND });
    expect(ledger.count()).toBe(1);
  });

  it('入参不合法（缺 jobId / 带未知键）：INVALID_ARGUMENT，不读文件也不消耗额度', async () => {
    const hand = fakeChannel();
    const { ctx, dir, deliver } = await boot({
      channel: hand.channel,
      autonomy: 'auto',
      gate: GATE_ONE_DELIVER,
    });
    const filePath = writeResume(dir);
    await expect(deliver.perform({ platform: 'boss', filePath, nowMs: T0 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(deliver.perform({ ...request({ filePath }), unknownKey: 1 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(hand.calls).toHaveLength(0);
    expect(asApp(ctx)['entitlement.gate'].check(DELIVER_ACTION, { nowMs: T0 })).toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });
});

describe('首次启用自动化的风险确认（spec 2.7-06 的投递侧）', () => {
  it('没签过字：CONSENT_REQUIRED，且 semi 档那张确认卡片一张都不出现', async () => {
    const hand = fakeChannel();
    const { dir, deliver, sessions, ledger } = await boot({ channel: hand.channel });
    const filePath = writeResume(dir);
    sessions.revoke('boss');
    await expect(deliver.perform(request({ filePath }))).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
      details: { platform: 'boss' },
    });
    // 确认卡片问的是「这一份要不要递」，风险确认问的是「要不要承担自动化风险」——
    // 后者没过就不该把用户拉进前者（界面会同时出现两张语义不同的卡片）。
    expect(deliver.pending()).toEqual([]);
    expect(hand.calls).toHaveLength(0);
    expect(ledger.count()).toBe(0);
  });

  it('签字判据排在额度之前：额度已见底的库，未签字给出的仍是 CONSENT_REQUIRED', async () => {
    const hand = fakeChannel();
    const { dir, deliver, sessions } = await boot({ channel: hand.channel, autonomy: 'auto', gate: GATE_ONE_DELIVER });
    const filePath = writeResume(dir);
    await deliver.perform(request({ filePath, jobId: 'job-1001' }));
    // 此时额度已用完：顺序反了就会拿到 QUOTA_EXCEEDED，而那是「明天再来」，不是「先点确认」。
    sessions.revoke('boss');
    await expect(deliver.perform(request({ filePath, jobId: 'job-2002' }))).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });
    expect(hand.calls).toHaveLength(1);
  });

  it('补上签字之后同一条路径走得通：确认是开门的那一下，不是永久禁用', async () => {
    const hand = fakeChannel();
    const { dir, deliver, sessions, ledger } = await boot({ channel: hand.channel, autonomy: 'auto' });
    const filePath = writeResume(dir);
    sessions.revoke('boss');
    await expect(deliver.perform(request({ filePath, jobId: 'job-1001' }))).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });
    sessions.grant('boss');
    const receipt = await deliver.perform(request({ filePath, jobId: 'job-2002' }));
    expect(receipt).toMatchObject({ committed: true, jobId: 'job-2002' });
    expect(hand.calls).toHaveLength(1);
    expect(ledger.count()).toBe(1);
  });
});
