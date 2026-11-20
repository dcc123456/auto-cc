/**
 * 10.8-05 / 10.9-05 的逐条一致与抽样（C 类，真装配）。
 *
 * 判据两半都在这一个文件里：
 * ① 同区间漏斗五级 = 各归属表的逐条数（差异 0）；
 * ② 每片抽 ≥3 笔（含 1 笔失败）逐笔对四源：账本行 ←→ 尝试（四元组/状态/ledgerId/receiptId）←→ 投递记录
 *    （deliver 才有）←→ 失败笔必须没有账本行。
 * 再构造一条「账本多一行、没有对应尝试」的分歧，断言对账器必须抛错——差异 ≠0 就是发布阻断。
 *
 * 用真 SQLite 与真装配（`metrics-assembly`），不 mock 账本/尝试/投递记录：把数据源换成替身，
 * 「逐条一致」就成了替身自己跟自己一致。
 */
import { JobTrackingService } from '@auto-cc/plugin-journey';
import { startOfDay, type FunnelRange } from '@auto-cc/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { bootFunnelAssembly, type FunnelAssembly } from './metrics-assembly.js';

/** 判定基准：本地中午，避开日界；账本与尝试都用这同一个时刻。 */
const NOW = new Date(2026, 10, 20, 12).getTime();
const RANGE: FunnelRange = { fromMs: startOfDay(NOW), toMs: startOfDay(NOW) + 86_400_000 };
const PLATFORM = 'boss';
const RESUME_VERSION = 'doc:resume-1:abc123456789';

/** 一次抽样里每笔的四源读数（差异为 0 时就是发布允许的那份对账）。 */
type SampleView = {
  jobId: string;
  action: 'greet' | 'deliver';
  status: string;
  ledgerId: number | null;
  receiptId: string | null;
  hasDeliveryRecord: boolean;
};

const assemblies: FunnelAssembly[] = [];
const trackingFibers: { dispose(): Promise<unknown> }[] = [];

afterEach(async () => {
  while (trackingFibers.length > 0) await trackingFibers.pop()?.dispose();
  while (assemblies.length > 0) await assemblies.pop()?.dispose();
});

/**
 * 逐条对账器：先比漏斗与逐条数，再逐笔比四源；任何一处不一致都抛错（阻断发布）。
 * @param assembly 真装配
 * @param tracking 约面来源服务（已挂到同一 ctx）
 * @returns 抽到的样本（成功笔与失败笔都在内；顺序即尝试表的最近优先）
 * @throws 任一级漏斗数不等于逐条数、账本与尝试对不上、deliver 缺投递记录、失败笔有账本行
 */
function sampleReconcile(assembly: FunnelAssembly, tracking: JobTrackingService): SampleView[] {
  const { app } = assembly;
  const levels = app.funnel.query(RANGE, { nowMs: NOW }).levels;
  const direct: Record<string, number> = {
    search: app['jd.store'].countCaptured(RANGE),
    greet: app['usage.ledger'].countAction('greet', RANGE),
    reply: app['conversation.store'].repliedJobCount(RANGE),
    deliver: app['outbound.deliveries'].count(RANGE),
    interview: tracking.interviewedJobCount(RANGE),
  };
  const differences: string[] = [];
  for (const level of levels) {
    if (level.count === null) continue;
    if (direct[level.level] !== level.count) {
      differences.push(`${level.level}: 漏斗 ${String(level.count)} ≠ 逐条 ${String(direct[level.level])}`);
    }
  }
  const attempts = app['usage.ledger']
    .recentAttempts(50)
    .filter((attempt) => attempt.updatedAt >= RANGE.fromMs && attempt.updatedAt < RANGE.toMs);
  const ledgerRows = app['usage.ledger']
    .summary(50)
    .recent.filter((row) => row.ts >= RANGE.fromMs && row.ts < RANGE.toMs);
  for (const row of ledgerRows) {
    const matched = attempts.find((attempt) => attempt.ledgerId === row.id);
    if (!matched) differences.push(`账本行 ${String(row.id)}（${row.action}/${row.targetId ?? '-'}）找不到对应尝试`);
    else if (matched.status !== 'succeeded')
      differences.push(`账本行 ${String(row.id)} 对应的尝试状态是 ${matched.status}`);
  }
  const samples: SampleView[] = [];
  for (const attempt of attempts) {
    if (attempt.ledgerId === null) {
      // 失败笔：允许存在（结局未知/已确认没发），但绝不能补一条成功账。
      samples.push({
        jobId: attempt.targetId,
        action: attempt.action,
        status: attempt.status,
        ledgerId: null,
        receiptId: attempt.receiptId,
        hasDeliveryRecord: false,
      });
      continue;
    }
    const row = app['usage.ledger'].row(attempt.ledgerId);
    if (!row)
      differences.push(`尝试 ${attempt.action}/${attempt.targetId} 的 ledgerId ${String(attempt.ledgerId)} 查无账行`);
    else if (row.action !== attempt.action || row.targetId !== attempt.targetId) {
      differences.push(`账本行 ${String(attempt.ledgerId)} 与尝试的动作/目标不一致`);
    }
    const delivery = attempt.action === 'deliver' ? app['outbound.deliveries'].get(attempt.ledgerId) : null;
    if (attempt.action === 'deliver' && delivery === null) {
      differences.push(`投递账本行 ${String(attempt.ledgerId)} 缺 delivery_records 行`);
    }
    samples.push({
      jobId: attempt.targetId,
      action: attempt.action,
      status: attempt.status,
      ledgerId: attempt.ledgerId,
      receiptId: attempt.receiptId,
      hasDeliveryRecord: delivery !== null,
    });
  }
  if (differences.length > 0) throw new Error(`对账差异：${differences.join('；')}`);
  return samples;
}

/** 起一套真装配并挂上追踪服务（约面级要它才有个数）。 */
async function boot() {
  const assembly = await bootFunnelAssembly({ prefix: 'auto-cc-reconcile-' });
  assemblies.push(assembly);
  const trackingFiber = await assembly.ctx.plugin(JobTrackingService, {});
  // 装配的 dispose 只管它自己挂的那些；追踪服务记进这里的收尾清单。
  trackingFibers.push(trackingFiber);
  return { assembly, tracking: assembly.app['journey.tracking'] };
}

describe('10.8-05 逐条一致与抽样', () => {
  it('两成功 + 一失败的 3 笔逐笔对四源，漏斗各级与逐条数差异 0', async () => {
    const { assembly, tracking } = await boot();
    const { app } = assembly;
    const gate = app['entitlement.gate'];
    // 成功 1：打招呼
    await gate.performOutbound(
      'greet',
      { platform: PLATFORM, targetId: 'job-1', resumeVersion: RESUME_VERSION, nowMs: NOW },
      () => Promise.resolve({ value: 'sent', receiptId: 'receipt-greet-1' }),
    );
    // 成功 2：投递（同事务写投递记录）
    await gate.performOutbound(
      'deliver',
      { platform: PLATFORM, targetId: 'job-2', resumeVersion: RESUME_VERSION, nowMs: NOW },
      () => Promise.resolve({ value: 'delivered', receiptId: 'receipt-deliver-1' }),
      (ledgerId) => {
        app['outbound.deliveries'].record({
          ledgerId,
          platform: PLATFORM,
          jobId: 'job-2',
          conversationTarget: null,
          snapshotId: 'snap-1',
          ts: NOW,
        });
      },
    );
    // 失败 1：页面任务抛错 → 尝试记 unknown、账本零行
    await expect(
      gate.performOutbound(
        'greet',
        { platform: PLATFORM, targetId: 'job-3', resumeVersion: RESUME_VERSION, nowMs: NOW },
        () => Promise.reject(new Error('页面没确认')),
      ),
    ).rejects.toThrow(/页面没确认/);
    tracking.registerInterview({
      platform: PLATFORM,
      jobId: 'job-2',
      scheduledAt: NOW + 3_600_000,
      mode: 'video',
      sourceRef: 'msg:interview-1',
      at: NOW,
    });
    const samples = sampleReconcile(assembly, tracking);
    expect(samples).toHaveLength(3);
    expect(samples.filter((sample) => sample.status === 'succeeded')).toHaveLength(2);
    expect(samples.filter((sample) => sample.ledgerId === null)).toHaveLength(1);
    expect(samples.find((sample) => sample.action === 'deliver')?.hasDeliveryRecord).toBe(true);
  });

  it('构造一条「账本多一行、没有对应尝试」的分歧：对账器必须抛错（差异 ≠0 阻断）', async () => {
    const { assembly, tracking } = await boot();
    const { app } = assembly;
    await app['entitlement.gate'].performOutbound(
      'greet',
      { platform: PLATFORM, targetId: 'job-1', resumeVersion: RESUME_VERSION, nowMs: NOW },
      () => Promise.resolve({ value: 'sent', receiptId: 'receipt-greet-1' }),
    );
    // 人工往账本补一行（没有对应的 outbound_attempts）：这正是「对账异常」的样子。
    app['usage.ledger'].record({ action: 'greet', targetId: 'job-x', nowMs: NOW });
    expect(() => sampleReconcile(assembly, tracking)).toThrow(/对账差异/);
  });
});
