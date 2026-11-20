/**
 * 岗位八态状态机与约面唯一来源的 U 半边（spec 10.8-01 / 10.8-02，plan §12.4）。
 *
 * 用系统临时目录里的真 SQLite：状态事件是只追加的事实，幂等/回退/重开都必须落在行数上才能断言；
 * 约面按岗位去重也直接读表。全程不出网、不碰真实平台。
 */
import { asApp, Context, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { FunnelRange } from '@auto-cc/shared';
import { JobTrackingService } from './tracking.js';

const fibers: Fiber[] = [];
const dirs: string[] = [];
const NOW = 1_764_000_000_000;
const PLATFORM = 'boss';

/** 起一套只含临时库的真追踪服务。 */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-tracking-'));
  dirs.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(JobTrackingService, {}));
  const app = asApp(ctx);
  return { tracking: app['journey.tracking'], db: app.store.db };
}

/** 取某岗位的事件行数（幂等断言要看行数，不看返回值）。 */
function eventCount(db: DatabaseSync, jobId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM job_status_events WHERE job_id = ?').get(jobId) as {
    n: number | bigint;
  };
  return Number(row.n);
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('八态状态机（10.8-01）', () => {
  it('第一次推进只能是 captured；正常序列逐态推进并留下事件', async () => {
    const { tracking } = await boot();
    expect(() =>
      tracking.record({ platform: PLATFORM, jobId: 'job-1', to: 'matched', sourceRef: 'x', at: NOW }),
    ).toThrow(/第一次推进只能是 captured/);
    tracking.record({ platform: PLATFORM, jobId: 'job-1', to: 'captured', sourceRef: 'capture:1', at: NOW });
    for (const to of ['matched', 'tailored', 'greeted', 'replied', 'delivered', 'interviewed'] as const) {
      tracking.record({ platform: PLATFORM, jobId: 'job-1', to, sourceRef: `ref:${to}`, at: NOW + 1 });
    }
    expect(tracking.current(PLATFORM, 'job-1')).toMatchObject({ state: 'interviewed' });
    expect(tracking.events(PLATFORM, 'job-1').map((event) => event.to)).toEqual([
      'captured',
      'matched',
      'tailored',
      'greeted',
      'replied',
      'delivered',
      'interviewed',
    ]);
  });

  it('同一事件重复到达不重复推进（幂等，行数不变）', async () => {
    const { tracking, db } = await boot();
    tracking.record({ platform: PLATFORM, jobId: 'job-1', to: 'captured', sourceRef: 'capture:1', at: NOW });
    tracking.record({ platform: PLATFORM, jobId: 'job-1', to: 'matched', sourceRef: 'match:1', at: NOW + 1 });
    const again = tracking.record({
      platform: PLATFORM,
      jobId: 'job-1',
      to: 'matched',
      sourceRef: 'match:1',
      at: NOW + 2,
    });
    expect(again.state).toBe('matched');
    expect(eventCount(db, 'job-1')).toBe(2);
  });

  it('允许跳级（tailored → delivered）但必须带来源；无来源的跳跃直接拒', async () => {
    const { tracking } = await boot();
    tracking.record({ platform: PLATFORM, jobId: 'job-1', to: 'captured', sourceRef: 'capture:1', at: NOW });
    tracking.record({ platform: PLATFORM, jobId: 'job-1', to: 'matched', sourceRef: 'match:1', at: NOW + 1 });
    tracking.record({ platform: PLATFORM, jobId: 'job-1', to: 'tailored', sourceRef: 'tailor:1', at: NOW + 2 });
    expect(() =>
      tracking.record({ platform: PLATFORM, jobId: 'job-1', to: 'delivered', sourceRef: '   ', at: NOW + 3 }),
    ).toThrow(/来源引用/);
    tracking.record({ platform: PLATFORM, jobId: 'job-1', to: 'delivered', sourceRef: 'delivery:9', at: NOW + 4 });
    expect(tracking.current(PLATFORM, 'job-1').state).toBe('delivered');
  });

  it('只进不退：回退请求按 JOB_STATUS_BACKWARD 拒绝', async () => {
    const { tracking } = await boot();
    tracking.record({ platform: PLATFORM, jobId: 'job-1', to: 'captured', sourceRef: 'c', at: NOW });
    tracking.record({ platform: PLATFORM, jobId: 'job-1', to: 'matched', sourceRef: 'm', at: NOW + 1 });
    tracking.record({ platform: PLATFORM, jobId: 'job-1', to: 'tailored', sourceRef: 't', at: NOW + 2 });
    expect(() =>
      tracking.record({ platform: PLATFORM, jobId: 'job-1', to: 'matched', sourceRef: 'back', at: NOW + 3 }),
    ).toThrow(/只进不退/);
  });

  it('结束必须带原因；closed 只能重开一次并回到结束前的态，重开留痕', async () => {
    const { tracking } = await boot();
    tracking.record({ platform: PLATFORM, jobId: 'job-1', to: 'captured', sourceRef: 'c', at: NOW });
    tracking.record({ platform: PLATFORM, jobId: 'job-1', to: 'matched', sourceRef: 'm', at: NOW + 1 });
    tracking.close({ platform: PLATFORM, jobId: 'job-1', reason: 'rejected', sourceRef: 'msg:9', at: NOW + 2 });
    const closed = tracking.current(PLATFORM, 'job-1');
    expect(closed).toMatchObject({ state: 'closed', closedReason: 'rejected' });
    expect(() =>
      tracking.record({ platform: PLATFORM, jobId: 'job-1', to: 'tailored', sourceRef: 'x', at: NOW + 3 }),
    ).toThrow(/已结束/);
    const reopened = tracking.reopen({
      platform: PLATFORM,
      jobId: 'job-1',
      reason: '对方又回消息了',
      sourceRef: 'msg:10',
      at: NOW + 4,
    });
    expect(reopened.state).toBe('matched');
    expect(reopened.reopenCount).toBe(1);
    tracking.close({ platform: PLATFORM, jobId: 'job-1', reason: 'no_reply', sourceRef: 'msg:11', at: NOW + 5 });
    expect(() =>
      tracking.reopen({ platform: PLATFORM, jobId: 'job-1', reason: 'again', sourceRef: 'msg:12', at: NOW + 6 }),
    ).toThrow(/重开过一次/);
  });
});

describe('约面唯一来源（10.8-02）', () => {
  const range: FunnelRange = { fromMs: NOW, toMs: NOW + 86_400_000 };

  it('登记后按岗位去重计数：同岗两条仍算 1，未登记不计入', async () => {
    const { tracking } = await boot();
    tracking.registerInterview({
      platform: PLATFORM,
      jobId: 'job-1',
      scheduledAt: NOW + 3_600_000,
      mode: 'video',
      sourceRef: 'msg:1',
      at: NOW + 10,
    });
    tracking.registerInterview({
      platform: PLATFORM,
      jobId: 'job-1',
      scheduledAt: NOW + 7_200_000,
      mode: 'phone',
      sourceRef: 'msg:2',
      at: NOW + 20,
    });
    expect(tracking.interviewedJobCount(range)).toBe(1);
    expect(tracking.interviewedJobCount({ fromMs: NOW + 30, toMs: NOW + 40 })).toBe(0);
  });

  it('缺来源/方式不认识/时间非法一律拒（没有来源的约面不计入）', async () => {
    const { tracking } = await boot();
    expect(() =>
      tracking.registerInterview({
        platform: PLATFORM,
        jobId: 'job-1',
        scheduledAt: NOW,
        mode: 'video',
        sourceRef: ' ',
      }),
    ).toThrow(/来源引用/);
    expect(() =>
      tracking.registerInterview({
        platform: PLATFORM,
        jobId: 'job-1',
        scheduledAt: NOW,
        mode: 'carrier-pigeon' as never,
        sourceRef: 'msg:1',
      }),
    ).toThrow(/方式/);
    expect(() =>
      tracking.registerInterview({
        platform: PLATFORM,
        jobId: 'job-1',
        scheduledAt: -1,
        mode: 'video',
        sourceRef: 'msg:1',
      }),
    ).toThrow(/时间/);
  });
});
