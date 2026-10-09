/**
 * 跨包关联查询（spec 3.7-02 的判据原文：投递记录引用 `snapshotId`，可回答「这份简历投给了哪个 JD、当时内容是什么」）。
 *
 * 为什么这条住在 `packages/main`：`delivery_records`（投递域，号段 9）与 `resume_snapshots`（简历域，号段 8）
 * 分属两个包、两张表，任何一侧单独测都只能证明「我写了自己那行」——关联是**同一个库文件**才有的事实。
 * 装配层是唯一同时看得见两个包的入口（pnpm 的严格依赖布局也让领域包之间 import 不了，§4.1 依赖方向）。
 *
 * 一律打真的 `node:sqlite`（系统临时目录，用完删，不进仓库，AGENTS.md §7.5）：
 * 两条迁移都跑过之后 JOIN 得到的一行，才是将来「投递追溯」界面要读的那一行。
 */
import { asApp, Context, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { DeliveryRecordService } from '@auto-cc/plugin-outbound';
import {
  createEmptyDocument,
  makeField,
  ResumeSnapshotService,
  resumePrint,
  type ResumeDocument,
} from '@auto-cc/plugin-resume-doc';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/** 关联查询里要回答的那个人名（内容侧唯一断言值）。 */
const CANDIDATE_NAME = '周未';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 建一个系统临时目录（`afterAll` 负责清理）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-delivery-link-'));
  sandboxes.push(dir);
  return dir;
}

/**
 * 在同一份库文件上同时挂起简历快照服务与投递记录服务——只有装配层能把两个包放进同一个 `store`。
 * @param dir 复用哪个目录
 * @returns 两个服务、裸连接与共享 `store` 的上下文
 */
async function bootTogether(dir = tempDir()) {
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(ResumeSnapshotService, { maxSnapshots: 20 }));
  fibers.push(await ctx.plugin(DeliveryRecordService, {}));
  const app = asApp(ctx);
  return { snapshots: app['resume.snapshot'], records: app['outbound.deliveries'], db: app.store.db };
}

/**
 * 一份合法的简历文档（内容全为虚构，只为让「当时内容是什么」问得出一个可核对的值）。
 * @returns 交给 `resume.snapshot.record` 的文档
 */
function sampleDoc(): ResumeDocument {
  return {
    ...createEmptyDocument('resume-link', 1234),
    profile: { name: CANDIDATE_NAME, contact: { email: null, phone: null, location: '上海' } },
    sections: [
      {
        id: 'exp',
        kind: 'experience',
        title: '工作经历',
        entries: [
          {
            id: 'e1',
            fields: [makeField('experience', 'company', '星桥科技'), makeField('experience', 'period', '2021 - 2024')],
          },
        ],
      },
    ],
  };
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不该把一次通过的验收判成失败（Windows 句柄延迟释放）。
    }
  }
});

describe('3.7-02 投递记录 ↔ 快照的关联查询', () => {
  it('一次投递一行经过 JOIN 一行快照，答得出「递给了哪个 JD」与「当时是哪一版内容」', async () => {
    const { snapshots, records, db } = await bootTogether();
    const { snapshotId, hash } = snapshots.record(sampleDoc(), 'classic', resumePrint.fontSet, 1_760_000_000_000);
    records.record({
      ledgerId: 42,
      platform: 'boss',
      jobId: 'job-777',
      conversationTarget: null,
      snapshotId,
      ts: 1_760_000_000_000,
    });

    const joined = db
      .prepare(
        `SELECT dr.job_id, dr.platform, dr.snapshot_id, rs.content_hash, rs.template_id, rs.doc_id
         FROM delivery_records dr
         JOIN resume_snapshots rs ON rs.snapshot_id = dr.snapshot_id
         WHERE dr.ledger_id = ?`,
      )
      .get(42) as
      | {
          job_id: string;
          platform: string;
          snapshot_id: string;
          content_hash: string;
          template_id: string;
          doc_id: string;
        }
      | undefined;
    expect(joined).toMatchObject({
      job_id: 'job-777',
      platform: 'boss',
      snapshot_id: snapshotId,
      content_hash: hash,
      template_id: 'classic',
      doc_id: 'resume-link',
    });

    // 内容的半边不在投递域里抄一份，而是拿引用回快照域读回来（§2.2 / §2.7）：读回的就是当初那一版。
    const restored = snapshots.restore(joined!.snapshot_id);
    expect(restored.status).toBe('restored');
    if (restored.status === 'restored') {
      expect(restored.hash).toBe(joined!.content_hash);
      expect(restored.document.profile.name).toBe(CANDIDATE_NAME);
    }
  });

  it('反方向也问得出：某一版简历先后递给了哪些岗位（快照 → 投递去处）', async () => {
    const { snapshots, records } = await bootTogether();
    const first = snapshots.record(sampleDoc(), 'classic', resumePrint.fontSet, 1_760_000_000_000);
    records.record({
      ledgerId: 1,
      platform: 'boss',
      jobId: 'job-A',
      conversationTarget: null,
      snapshotId: first.snapshotId,
      ts: 1_760_000_000_000,
    });
    records.record({
      ledgerId: 2,
      platform: 'liepin',
      jobId: 'job-B',
      conversationTarget: null,
      snapshotId: first.snapshotId,
      ts: 1_760_000_000_600,
    });
    const second = snapshots.record(sampleDoc(), 'compact', resumePrint.fontSet, 1_760_000_001_000);
    records.record({
      ledgerId: 3,
      platform: 'boss',
      jobId: 'job-C',
      conversationTarget: null,
      snapshotId: second.snapshotId,
      ts: 1_760_000_002_000,
    });

    expect(records.listBySnapshot(first.snapshotId).map((item) => item.jobId)).toEqual(['job-A', 'job-B']);
    expect(records.listBySnapshot(second.snapshotId).map((item) => item.platform)).toEqual(['boss']);
    // 快照列表与投递记录互不抄：同一份文档两次导出是两条不可变历史，各自被不同的投递引用。
    expect(snapshots.list('resume-link').map((item) => item.templateId)).toEqual(['compact', 'classic']);
  });

  it('经过引用了一个不存在的快照 → 读回是 missing，不编一份内容出来（悬空引用看得见）', async () => {
    const { snapshots, records } = await bootTogether();
    records.record({
      ledgerId: 7,
      platform: 'boss',
      jobId: 'job-dangling',
      conversationTarget: null,
      snapshotId: 'never-exported',
      ts: 1_760_000_000_000,
    });
    const row = records.get(7);
    expect(row?.snapshotId).toBe('never-exported');
    expect(snapshots.restore(row!.snapshotId!)).toEqual({ status: 'missing' });
  });
});
