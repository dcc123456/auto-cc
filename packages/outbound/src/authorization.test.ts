/**
 * 无人值守投递授权闸门的负对照（spec 10.6-01～10.6-08 / plan §12.2）。
 *
 * 全部使用系统临时目录里的真 SQLite：额度、被拒流水、四元组去重、成功账都走真实的
 * `usage.ledger` 与 `entitlement.gate`，不 mock 账本——被 mock 掉的账本就测不出「被拦下时零增行」。
 * 事实校验回执与简历版本血缘用两只窄替身（它们属于简历包，这里只需要「查得到/查不到」两态）。
 * 本文件不访问网络、不读用户库、不碰真实平台（AGENTS.md §7.2）。
 */
import { asApp, Context, maybeService, Service, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { DEFAULT_DAILY_LIMITS, EntitlementGateService, UsageLedgerService } from '@auto-cc/plugin-entitlement';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import type { ResumeDocSummaryView } from '@auto-cc/shared';
import { OutboundAuthorizationService, type UnattendedGrantRequest } from './authorization.js';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 判定基准：一个固定的本地日（用例里所有「今天」都以它为锚，跨日就是 +24h）。 */
const NOW = 1_764_000_000_000;
const PLATFORM = 'fixture';
const MASTER = 'resume-master';
const VARIANT = 'resume-variant';
const VARIANT_2 = 'resume-variant-2';
const RECEIPT = 'gen-1';

/** 两只证据替身的配置形状：无键，但构造器仍要接住 cordis 递来的第二个实参。 */
const NO_CONFIG = z.strictObject({});

/** 事实校验回执替身（`resume.generate.receiptOf` 的窄形状）。 */
class FakeGenerateService extends Service {
  static provide = 'resume.generate';
  static Config = NO_CONFIG;

  private readonly records = new Map<
    string,
    { docId: string; jdId: string | null; outcome: string; violations: readonly unknown[] }
  >();

  constructor(ctx: Context, _options: Record<string, never>) {
    super(ctx, 'resume.generate');
  }

  /**
   * 种一条生成回执。
   * @param id 回执 id
   * @param record 母版、JD 归因、结局与违规明细
   */
  seed(
    id: string,
    record: { docId: string; jdId: string | null; outcome: string; violations?: readonly unknown[] },
  ): void {
    this.records.set(id, { ...record, violations: record.violations ?? [] });
  }

  /**
   * 按 id 读回执。
   * @param id 回执 id
   * @returns 种过的回执；没种过返回 null（授权闸门据此拒绝开单）
   */
  receiptOf(
    id: string,
  ): { docId: string; jdId: string | null; outcome: string; violations: readonly unknown[] } | null {
    return this.records.get(id) ?? null;
  }
}

/** 简历版本血缘替身（`resume.doc.list()` 的窄形状）。 */
class FakeDocService extends Service {
  static provide = 'resume.doc';
  static Config = NO_CONFIG;

  private docs: readonly Pick<ResumeDocSummaryView, 'id' | 'parentDocId' | 'jdId'>[] = [];

  constructor(ctx: Context, _options: Record<string, never>) {
    super(ctx, 'resume.doc');
  }

  /**
   * 种一份版本清单。
   * @param docs 只含 id 与血缘的摘要
   */
  seed(docs: readonly Pick<ResumeDocSummaryView, 'id' | 'parentDocId' | 'jdId'>[]): void {
    this.docs = docs;
  }

  /**
   * 读版本清单。
   * @returns 当前种下的那批摘要
   */
  list(): readonly Pick<ResumeDocSummaryView, 'id' | 'parentDocId' | 'jdId'>[] {
    return this.docs;
  }
}

/** 一次装配的句柄：授权服务、闸门、账本、裸库连接与三只证据替身。 */
interface Harness {
  auth: OutboundAuthorizationService;
  ctx: Context;
  gate: EntitlementGateService;
  ledger: UsageLedgerService;
  generate: FakeGenerateService;
  docs: FakeDocService;
  db: DatabaseSync;
  authFiber: Fiber;
}

/**
 * 起一套只含临时库的真授权闸门。
 * @param gateConfig 闸门配置；默认 `unlimited`，让「超额度」只由授权日限额判，不与按动作日上限混在一起
 * @returns 服务句柄与裸库连接
 */
async function boot(
  gateConfig: { mode: 'unlimited' | 'daily'; dailyLimits: typeof DEFAULT_DAILY_LIMITS } = {
    mode: 'unlimited',
    dailyLimits: DEFAULT_DAILY_LIMITS,
  },
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-unattended-'));
  sandboxes.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(UsageLedgerService, {}));
  fibers.push(await ctx.plugin(EntitlementGateService, gateConfig));
  fibers.push(await ctx.plugin(FakeGenerateService, {}));
  fibers.push(await ctx.plugin(FakeDocService, {}));
  const authFiber = await ctx.plugin(OutboundAuthorizationService, {});
  fibers.push(authFiber);
  const app = asApp(ctx);
  const generate = maybeService<FakeGenerateService>(ctx, 'resume.generate');
  const docs = maybeService<FakeDocService>(ctx, 'resume.doc');
  if (!generate || !docs) throw new Error('证据替身没有挂上');
  // 默认种一条通过事实校验的回执与一对母版/变体：单条用例只覆盖自己要破坏的那一维。
  generate.seed(RECEIPT, { docId: MASTER, jdId: 'jd-1', outcome: 'rewritten' });
  docs.seed([
    { id: MASTER, parentDocId: null, jdId: null },
    { id: VARIANT, parentDocId: MASTER, jdId: 'jd-1' },
    { id: VARIANT_2, parentDocId: MASTER, jdId: 'jd-1' },
    { id: 'resume-job1', parentDocId: MASTER, jdId: 'job-1' },
    { id: 'resume-job2', parentDocId: MASTER, jdId: 'job-2' },
  ]);
  return {
    auth: app['outbound.authorization'],
    ctx,
    gate: app['entitlement.gate'],
    ledger: app['usage.ledger'],
    generate,
    docs,
    db: app.store.db,
    authFiber,
  };
}

/** 三要素齐备的授权单入参（用例按需覆盖其中一维）。 */
function grantInput(overrides: Partial<UnattendedGrantRequest> = {}): UnattendedGrantRequest {
  return {
    platform: PLATFORM,
    dailyLimit: 2,
    targets: ['job-1', 'job-2'],
    masterResumeVersion: MASTER,
    resumeVersion: VARIANT,
    factCheckReceiptId: RECEIPT,
    nowMs: NOW,
    ...overrides,
  };
}

/** 一笔无人值守外发的判定上下文。 */
function outboundContext(overrides: Record<string, unknown> = {}) {
  return {
    platform: PLATFORM,
    targetId: 'job-1',
    resumeVersion: VARIANT,
    workflowRunId: 'run-1',
    nowMs: NOW,
    ...overrides,
  };
}

/** 一次「页面动作」：返回值固定，调用次数由用例自己数。 */
function pageAction(): { task: () => Promise<{ value: string; receiptId: string }>; calls: () => number } {
  let calls = 0;
  return {
    task: () => {
      calls += 1;
      return Promise.resolve({ value: 'sent', receiptId: 'receipt-1' });
    },
    calls: () => calls,
  };
}

/** 读一张表的行数（负数断言到处都要，抽一处避免各处抄同一条 SQL）。 */
function countRows(
  db: DatabaseSync,
  table: 'usage_ledger' | 'delivery_records' | 'usage_denials' | 'outbound_attempts',
): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number | bigint };
  return Number(row.n);
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

describe('10.6-01 授权单三要素齐备才开跑', () => {
  it('日限额非整数或越界时拒绝开单，账本零增行', async () => {
    const { auth, db } = await boot();
    for (const dailyLimit of [0, 11, 2.5, -1]) {
      expect(() => auth.grant(grantInput({ dailyLimit }))).toThrow();
    }
    expect(auth.current(NOW)).toBeNull();
    expect(countRows(db, 'usage_ledger')).toBe(0);
    expect(countRows(db, 'outbound_attempts')).toBe(0);
  });

  it('岗位集合为空 / 超日限额 / 有重复 / 有空值时拒绝开单', async () => {
    const { auth } = await boot();
    expect(() => auth.grant(grantInput({ targets: [] }))).toThrow();
    expect(() => auth.grant(grantInput({ targets: ['job-1', 'job-2', 'job-3'] }))).toThrow();
    expect(() => auth.grant(grantInput({ targets: ['job-1', 'job-1'] }))).toThrow();
    expect(() => auth.grant(grantInput({ targets: ['job-1', '  '] }))).toThrow();
    expect(auth.current(NOW)).toBeNull();
  });

  it('简历版本未绑定或与母版相同：拒绝开单', async () => {
    const { auth } = await boot();
    expect(() => auth.grant(grantInput({ resumeVersion: '' }))).toThrow();
    expect(() => auth.grant(grantInput({ masterResumeVersion: '' }))).toThrow();
    expect(() => auth.grant(grantInput({ resumeVersion: MASTER }))).toThrow(/母版相同/);
    expect(auth.current(NOW)).toBeNull();
  });

  it('事实校验回执查无 / 被拒 / 母版对不上 / 变体血缘对不上：拒绝开单', async () => {
    const { auth, generate, docs } = await boot();
    expect(() => auth.grant(grantInput({ factCheckReceiptId: 'gen-missing' }))).toThrow(/查无此单/);

    generate.seed('gen-rejected', { docId: MASTER, jdId: 'jd-1', outcome: 'rejected' });
    expect(() => auth.grant(grantInput({ factCheckReceiptId: 'gen-rejected' }))).toThrow(/没过事实校验/);

    generate.seed('gen-other-master', { docId: 'resume-other', jdId: 'jd-1', outcome: 'rewritten' });
    expect(() => auth.grant(grantInput({ factCheckReceiptId: 'gen-other-master' }))).toThrow(/对不上/);

    docs.seed([{ id: MASTER, parentDocId: null, jdId: null }]);
    expect(() => auth.grant(grantInput())).toThrow(/不是母版/);
    expect(auth.current(NOW)).toBeNull();
  });

  it('三要素齐备才开出 active 单，剩余名额按日限额算', async () => {
    const { auth, db } = await boot();
    const view = auth.grant(grantInput());
    expect(view).toMatchObject({ status: 'active', platform: PLATFORM, dailyLimit: 2, remaining: 2 });
    expect(view.targets).toEqual(['job-1', 'job-2']);
    expect(countRows(db, 'usage_ledger')).toBe(0);
  });

  it('新单一开，上一张未结束的单作废（同一时刻只有一张有效授权）', async () => {
    const { auth, db } = await boot();
    auth.grant(grantInput());
    const second = auth.grant(grantInput({ targets: ['job-2'] }));
    expect(second.status).toBe('active');
    const row = auth.current(NOW);
    expect(row?.targets).toEqual(['job-2']);
    const revoked = db.prepare(`SELECT COUNT(*) AS n FROM outbound_authorizations WHERE status = 'revoked'`).get() as {
      n: number | bigint;
    };
    expect(Number(revoked.n)).toBe(1);
  });
});

describe('10.6-02 窗口只对本自然日 + 本次运行有效', () => {
  it('跨日后拒绝：页面零动作、账本零增行，状态转 expired', async () => {
    const { auth, db } = await boot();
    auth.grant(grantInput());
    const page = pageAction();
    await expect(
      auth.dispatch('greet', outboundContext({ nowMs: NOW + 24 * 60 * 60 * 1000 }), page.task),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_WINDOW_CLOSED' });
    expect(page.calls()).toBe(0);
    expect(countRows(db, 'usage_ledger')).toBe(0);
    expect(auth.current(NOW + 24 * 60 * 60 * 1000)?.status).toBe('expired');
  });

  it('重启后不自动续跑：新实例把旧单转 restart-required，确认后才从断点继续且不重复扣', async () => {
    const { auth, authFiber, ledger } = await boot();
    auth.grant(grantInput());
    await authFiber.dispose();
    const ctx = new Context();
    fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc-restart' }));
    // 复用同一个 store 目录：重启的语义是「同一个库、新的进程」，换目录就变成另一台机器了。
    const dir = sandboxes[sandboxes.length - 1];
    fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
    fibers.push(await ctx.plugin(UsageLedgerService, {}));
    fibers.push(await ctx.plugin(EntitlementGateService, { mode: 'unlimited', dailyLimits: DEFAULT_DAILY_LIMITS }));
    fibers.push(await ctx.plugin(FakeGenerateService, {}));
    fibers.push(await ctx.plugin(FakeDocService, {}));
    const restarted = await ctx.plugin(OutboundAuthorizationService, {});
    fibers.push(restarted);
    const app = asApp(ctx);
    const reopened = app['outbound.authorization'];
    expect(reopened.current(NOW)?.status).toBe('restart-required');
    // 未完成岗位原样留成待办（10.6-02 的「待办数 > 0」读数）。
    expect(reopened.current(NOW)?.pendingTargets).toEqual(['job-1', 'job-2']);

    const page = pageAction();
    await expect(reopened.dispatch('greet', outboundContext(), page.task)).rejects.toMatchObject({
      code: 'AUTHORIZATION_RECONFIRM_REQUIRED',
    });
    expect(page.calls()).toBe(0);
    expect(app['usage.ledger'].count()).toBe(0);

    const reconfirmed = reopened.reconfirm(NOW + 1_000);
    expect(reconfirmed.status).toBe('active');
    const resumed = await reopened.dispatch('greet', outboundContext({ nowMs: NOW + 2_000 }), page.task);
    expect(resumed.ledgerId).toBeGreaterThan(0);
    expect(page.calls()).toBe(1);
    expect(app['usage.ledger'].count()).toBe(1);
    expect(ledger.count()).toBe(1);
  });
});

describe('10.6-06 越权外发为 0（五种情形逐一拒绝）', () => {
  it('① 岗位不在授权集合：拒绝、留原因、页面与账本零增行', async () => {
    const { auth, db } = await boot();
    auth.grant(grantInput());
    const page = pageAction();
    await expect(auth.dispatch('greet', outboundContext({ targetId: 'job-999' }), page.task)).rejects.toMatchObject({
      code: 'OUTBOUND_TARGET_NOT_AUTHORIZED',
    });
    expect(page.calls()).toBe(0);
    expect(countRows(db, 'usage_ledger')).toBe(0);
    expect(countRows(db, 'usage_denials')).toBe(1);
  });

  it('② 超出授权日限额：拒绝且不再外发', async () => {
    const { auth, gate, db } = await boot();
    // 先由手动路径（workflowRunId 为 null）推进两个岗位，授权日限额就是 2。
    for (const targetId of ['job-3', 'job-4']) {
      await gate.performOutbound(
        'greet',
        { platform: PLATFORM, targetId, resumeVersion: 'v-manual', workflowRunId: null, nowMs: NOW },
        () => Promise.resolve({ value: 'sent', receiptId: 'manual' }),
      );
    }
    auth.grant(grantInput({ dailyLimit: 2, targets: ['job-1', 'job-2'] }));
    const page = pageAction();
    await expect(auth.dispatch('greet', outboundContext(), page.task)).rejects.toMatchObject({
      code: 'AUTHORIZATION_QUOTA_EXHAUSTED',
    });
    expect(page.calls()).toBe(0);
    expect(countRows(db, 'usage_ledger')).toBe(2);
  });

  it('③ 简历版本未授权：拒绝且页面零动作', async () => {
    const { auth, db } = await boot();
    auth.grant(grantInput());
    const page = pageAction();
    await expect(
      auth.dispatch('greet', outboundContext({ resumeVersion: 'resume-other' }), page.task),
    ).rejects.toMatchObject({ code: 'OUTBOUND_RESUME_VERSION_NOT_AUTHORIZED' });
    expect(page.calls()).toBe(0);
    expect(countRows(db, 'usage_ledger')).toBe(0);
  });

  it('③b 授权母版下、JD 归因为本岗的定制变体放行（批量执行器逐岗定制）', async () => {
    const { auth, db } = await boot();
    auth.grant(grantInput());
    const page = pageAction();
    await auth.dispatch('greet', outboundContext({ resumeVersion: 'doc:resume-job1:abc123456789' }), page.task);
    expect(page.calls()).toBe(1);
    expect(countRows(db, 'usage_ledger')).toBe(1);
  });

  it('③c 变体 JD 归因不是本岗：仍按越权拒绝', async () => {
    const { auth, db } = await boot();
    auth.grant(grantInput());
    const page = pageAction();
    await expect(
      auth.dispatch(
        'greet',
        outboundContext({ targetId: 'job-2', resumeVersion: 'doc:resume-job1:abc123456789' }),
        page.task,
      ),
    ).rejects.toMatchObject({ code: 'OUTBOUND_RESUME_VERSION_NOT_AUTHORIZED' });
    expect(page.calls()).toBe(0);
    expect(countRows(db, 'usage_ledger')).toBe(0);
  });

  it('④ 窗口外：跨日拒绝（同 10.6-02 的窗口判据）', async () => {
    const { auth, db } = await boot();
    auth.grant(grantInput());
    const page = pageAction();
    await expect(
      auth.dispatch('greet', outboundContext({ nowMs: NOW + 24 * 60 * 60 * 1000 }), page.task),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_WINDOW_CLOSED' });
    expect(page.calls()).toBe(0);
    expect(countRows(db, 'usage_ledger')).toBe(0);
  });

  it('⑤ 没有有效授权单（含重启未确认）：拒绝且页面零动作', async () => {
    const { auth, db } = await boot();
    const page = pageAction();
    await expect(auth.dispatch('greet', outboundContext(), page.task)).rejects.toMatchObject({
      code: 'UNATTENDED_NOT_AUTHORIZED',
    });
    expect(page.calls()).toBe(0);
    expect(countRows(db, 'usage_ledger')).toBe(0);
  });
});

describe('10.6-03 频控与额度在无人值守路径上不可关', () => {
  it('每笔外发前先问额度闸门：到量即拒，页面与成功账不增', async () => {
    const { auth, db } = await boot({
      mode: 'daily',
      dailyLimits: { ...DEFAULT_DAILY_LIMITS, greet: 1 },
    });
    auth.grant(grantInput({ dailyLimit: 2, targets: ['job-1', 'job-2'] }));
    await auth.dispatch('greet', outboundContext({ targetId: 'job-1' }), pageAction().task);
    const page = pageAction();
    await expect(auth.dispatch('greet', outboundContext({ targetId: 'job-2' }), page.task)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    expect(page.calls()).toBe(0);
    expect(countRows(db, 'usage_ledger')).toBe(1);
  });
});

describe('10.6-04 风控命中即整轮暂停', () => {
  it('验证码/限流信号到达后后续外发全拒、自动恢复 0 次，确认后才继续', async () => {
    const { auth, ctx, db } = await boot();
    auth.grant(grantInput());
    ctx.emit('browser/risk-signal', {
      platform: PLATFORM,
      kind: 'http-status',
      detail: 'HTTP 403',
      url: 'http://127.0.0.1:10233/jobs',
      at: NOW + 1,
    });
    expect(auth.current(NOW + 2)).toMatchObject({ status: 'paused', pauseReason: expect.stringContaining('HTTP 403') });

    const page = pageAction();
    for (const action of ['greet', 'deliver'] as const) {
      await expect(auth.dispatch(action, outboundContext({ nowMs: NOW + 3 }), page.task)).rejects.toMatchObject({
        code: 'OUTBOUND_RISK_PAUSED',
      });
    }
    expect(page.calls()).toBe(0);
    expect(countRows(db, 'usage_ledger')).toBe(0);
    // 再等一段时间也不会自己恢复：状态仍是 paused，仍然拒。
    expect(auth.current(NOW + 10 * 60 * 1000)?.status).toBe('paused');

    expect(auth.reconfirm(NOW + 11 * 60 * 1000).status).toBe('active');
    await auth.dispatch('greet', outboundContext({ nowMs: NOW + 12 * 60 * 1000 }), page.task);
    expect(page.calls()).toBe(1);
    expect(countRows(db, 'usage_ledger')).toBe(1);
  });
});

describe('10.6-05 一键停用即时生效', () => {
  it('停用后同一毫秒起不再外发、历史保留；恢复不自动补账', async () => {
    const { auth, gate, db } = await boot();
    auth.grant(grantInput());
    await auth.dispatch('greet', outboundContext({ targetId: 'job-1' }), pageAction().task);
    expect(countRows(db, 'usage_ledger')).toBe(1);

    gate.setOutboundStopped(true, NOW + 1);
    const page = pageAction();
    await expect(
      auth.dispatch('greet', outboundContext({ targetId: 'job-2', nowMs: NOW + 1 }), page.task),
    ).rejects.toMatchObject({ code: 'OUTBOUND_DISABLED' });
    expect(page.calls()).toBe(0);
    expect(countRows(db, 'usage_ledger')).toBe(1);

    gate.setOutboundStopped(false, NOW + 2);
    await auth.dispatch('greet', outboundContext({ targetId: 'job-2', nowMs: NOW + 3 }), page.task);
    expect(page.calls()).toBe(1);
    expect(countRows(db, 'usage_ledger')).toBe(2);
  });
});

describe('10.6-07 外发双落账可审计', () => {
  it('成功外发同事务写账本与投递记录；写投递记录失败则整体回滚、不落成功账', async () => {
    const { auth, ledger, db } = await boot();
    auth.grant(grantInput());
    const written: number[] = [];
    const { ledgerId } = await auth.dispatch(
      'deliver',
      outboundContext({ targetId: 'job-1' }),
      () => Promise.resolve({ value: 'delivered', receiptId: 'page-receipt-9' }),
      (id) => {
        written.push(id);
      },
    );
    expect(written).toEqual([ledgerId]);
    expect(ledger.row(ledgerId)).toMatchObject({ action: 'deliver', targetId: 'job-1' });
    expect(
      ledger.attemptFor({ platform: PLATFORM, targetId: 'job-1', action: 'deliver', resumeVersion: VARIANT }),
    ).toMatchObject({ status: 'succeeded', receiptId: 'page-receipt-9', ledgerId });

    // 第二批：投递记录写入器抛错 → 账本与成功位都必须回滚（失败侧不落成功账）。
    await expect(
      auth.dispatch(
        'deliver',
        outboundContext({ targetId: 'job-2', nowMs: NOW + 1_000 }),
        () => Promise.resolve({ value: 'delivered', receiptId: 'page-receipt-10' }),
        () => {
          throw new Error('投递记录写失败');
        },
      ),
    ).rejects.toThrow(/投递记录写失败/);
    expect(countRows(db, 'usage_ledger')).toBe(1);
    expect(
      ledger.attemptFor({ platform: PLATFORM, targetId: 'job-2', action: 'deliver', resumeVersion: VARIANT }),
    ).toMatchObject({ status: 'unknown', ledgerId: null });
  });
});

describe('10.6-08 去重两层', () => {
  it('四元组重放：第二笔拒发，页面只动一次、账本只增一行', async () => {
    const { auth, db } = await boot();
    auth.grant(grantInput());
    const page = pageAction();
    await auth.dispatch('greet', outboundContext(), page.task);
    await expect(auth.dispatch('greet', outboundContext(), page.task)).rejects.toMatchObject({
      code: 'OUTBOUND_ALREADY_SENT',
    });
    expect(page.calls()).toBe(1);
    expect(countRows(db, 'usage_ledger')).toBe(1);
    expect(countRows(db, 'outbound_attempts')).toBe(1);
  });

  it('同岗 24 小时上限：换简历版本也不叠加，且零扣额度', async () => {
    const { auth, db } = await boot();
    auth.grant(grantInput());
    await auth.dispatch('greet', outboundContext(), pageAction().task);
    // 换一张单、换一版定制简历，同一岗位同一动作仍在 24 小时内 → 拒。
    auth.grant(grantInput({ resumeVersion: VARIANT_2 }));
    const page = pageAction();
    await expect(
      auth.dispatch('greet', outboundContext({ resumeVersion: VARIANT_2, nowMs: NOW + 60 * 60 * 1000 }), page.task),
    ).rejects.toMatchObject({ code: 'OUTBOUND_SAME_JOB_WINDOW' });
    expect(page.calls()).toBe(0);
    expect(countRows(db, 'usage_ledger')).toBe(1);
  });

  it('同一岗位 24 小时内允许 1 次打招呼 + 1 次投递（共享一个岗位名额）', async () => {
    const { auth, db } = await boot();
    auth.grant(grantInput({ dailyLimit: 1, targets: ['job-1'] }));
    await auth.dispatch('greet', outboundContext(), pageAction().task);
    await auth.dispatch('deliver', outboundContext({ nowMs: NOW + 60_000, resumeVersion: VARIANT }), () =>
      Promise.resolve({ value: 'delivered', receiptId: 'r-2' }),
    );
    expect(countRows(db, 'usage_ledger')).toBe(2);
    expect(auth.current(NOW + 60_000)?.remaining).toBe(0);
  });
});
