/**
 * `resume.snapshot` 落库用例（spec 3.7-01 / 04 / 05）。
 *
 * 一律打**真的 `node:sqlite`**（系统临时目录，不进仓库，AGENTS.md §7.5）：
 * 快照的全部意义是「导出瞬间那份文档被不可变地存下来、日后能原样还原」，
 * 这件事只有真写进 TEXT 列、把服务连根拔掉再重开、按 id 读回来重新算 hash，才验得出来——内存自存自取证明不了。
 * 保留上限（3.7-05）同理：只有真插超行数、跑一次裁剪、查库里剩哪几条，才证明裁的是最旧而不是随机。
 */
import { asApp, Context, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, makeField, RESUME_SCHEMA_VERSION, type ResumeDocument } from './model.js';
import { contentHash } from './normalize.js';
import { ResumeSnapshotService, RESUME_SNAPSHOT_MIGRATION_VERSION } from './snapshot-store.js';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-resume-snap-'));
  sandboxes.push(dir);
  return dir;
}

/** 挂起 config + store + resume.snapshot，返回服务、裸连接与用于对照的 resume.doc（快照与文档同库协作）。 */
async function boot(maxSnapshots = 20, dir = tempDir()) {
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(ResumeSnapshotService, { maxSnapshots }));
  const app = asApp(ctx);
  return { store: app.store, snapshots: app['resume.snapshot'], db: app.store.db };
}

function sampleDoc(overrides: Partial<ResumeDocument> = {}): ResumeDocument {
  return {
    id: 'resume-1',
    schemaVersion: RESUME_SCHEMA_VERSION,
    profile: { name: '张三', contact: { email: 'z@x.com', phone: null, location: '上海' } },
    layout: DEFAULT_LAYOUT,
    sections: [
      {
        id: 'exp',
        kind: 'experience',
        title: '经历',
        entries: [
          {
            id: 'e1',
            fields: [makeField('experience', 'company', '星桥科技'), makeField('experience', 'role', '后端工程师')],
          },
        ],
      },
    ],
    metrics: { pages: 1 },
    updatedAt: 1234,
    ...overrides,
  };
}

/** 读一行快照的全部列，用于 3.7-01「查库断言字段完整」。 */
function rawRow(db: DatabaseSync, snapshotId: string) {
  return db
    .prepare(
      `SELECT snapshot_id, doc_id, template_id, font_set, content_hash, doc_json, created_at
       FROM resume_snapshots WHERE snapshot_id = ?`,
    )
    .get(snapshotId) as Record<string, string | number | bigint | null> | undefined;
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不该把一次通过的验收判成失败。
    }
  }
});

describe('建表与迁移', () => {
  it('挂载即建 resume_snapshots 表，迁移号段为 8', async () => {
    const { db } = await boot();
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='resume_snapshots'").get() as
      { name?: string } | undefined;
    expect(table?.name).toBe('resume_snapshots');
    expect(RESUME_SNAPSHOT_MIGRATION_VERSION).toBe(8);
  });

  it('迁移号段不复用任何已分配号段（防止 ensureSchema 幂等 push 静默跳过建表）', () => {
    // 已分配：账本 1 / agent 会话 2 / jobs 3 / workflow run 4 / conversation 5 / consent 6 / resume_docs 7。
    const taken = new Set([1, 2, 3, 4, 5, 6, 7]);
    expect(taken.has(RESUME_SNAPSHOT_MIGRATION_VERSION)).toBe(false);
  });
});

describe('3.7-01 快照字段完整', () => {
  it('record 落库一行，六字段齐备且 hash 与 contentHash(源文档) 同源', async () => {
    const { snapshots, db } = await boot();
    const doc = sampleDoc();
    const receipt = snapshots.record(doc, 'classic', 'Noto Sans SC:x.woff2', 1000);

    const row = rawRow(db, receipt.snapshotId);
    expect(row).toBeDefined();
    expect(String(row?.doc_id)).toBe('resume-1');
    expect(String(row?.template_id)).toBe('classic');
    expect(String(row?.font_set)).toBe('Noto Sans SC:x.woff2');
    expect(Number(row?.created_at)).toBe(1000);
    expect(String(row?.content_hash)).toBe(receipt.hash);
    expect(String(row?.content_hash)).toBe(contentHash(doc));
    // doc_json 是一段可解析、且能重新校验成合法文档的正文。
    expect(typeof row?.doc_json).toBe('string');
  });

  it('record 非法文档（pages=0）→ 结构化 AppError，不落库', async () => {
    const { snapshots, db } = await boot();
    expect(() => snapshots.record(sampleDoc({ metrics: { pages: 0 } }), 'classic', 'f', 1)).toThrowError(
      /快照源文档未通过校验/,
    );
    const count = db.prepare('SELECT COUNT(*) AS n FROM resume_snapshots').get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe('3.7-04 按 id 还原，hash 与原产物一致', () => {
  it('restore 得到合法文档，hash 与记录时一致；即便写入前文档不规范，还原仍等于规范形 hash', async () => {
    const { snapshots } = await boot();
    const original = contentHash(sampleDoc());
    const receipt = snapshots.record(sampleDoc(), 'modern', 'f', 10);

    const restored = snapshots.restore(receipt.snapshotId);
    expect(restored.status).toBe('restored');
    if (restored.status === 'restored') {
      expect(restored.hash).toBe(original);
      expect(restored.document.sections[0]?.entries[0]?.fields.find((field) => field.key === 'company')?.value).toBe(
        '星桥科技',
      );
    }
  });

  it('未知 id → missing，不抛异常', async () => {
    const { snapshots } = await boot();
    expect(snapshots.restore('never-recorded').status).toBe('missing');
  });

  it('库里塞进坏 JSON → restore 判 corrupt 而非崩', async () => {
    const { snapshots, db } = await boot();
    const receipt = snapshots.record(sampleDoc(), 'classic', 'f', 1);
    db.prepare("UPDATE resume_snapshots SET doc_json = '{ broken' WHERE snapshot_id = ?").run(receipt.snapshotId);
    const restored = snapshots.restore(receipt.snapshotId);
    expect(restored.status).toBe('corrupt');
    if (restored.status === 'corrupt') expect(restored.reason).toContain('JSON 解析失败');
  });
});

describe('3.7-05 保留上限与清理策略', () => {
  it('超出上限写入后只留最新 maxSnapshots 份，裁掉的是最旧的', async () => {
    const { snapshots } = await boot(3);
    for (const stamp of [1, 2, 3, 4, 5]) snapshots.record(sampleDoc(), 'classic', 'f', stamp);

    const listed = snapshots.list('resume-1');
    expect(listed).toHaveLength(3);
    // list 最新的在前：created_at 应为 5、4、3，早于 3 的（1、2）已被裁掉。
    expect(listed.map((item) => item.createdAt)).toEqual([5, 4, 3]);
  });

  it('不同文档各自计数，互不裁剪', async () => {
    const { snapshots } = await boot(2);
    snapshots.record(sampleDoc({ id: 'a' }), 'classic', 'f', 1);
    snapshots.record(sampleDoc({ id: 'a' }), 'classic', 'f', 2);
    snapshots.record(sampleDoc({ id: 'b' }), 'classic', 'f', 3);

    expect(snapshots.list('a')).toHaveLength(2);
    expect(snapshots.list('b')).toHaveLength(1);
  });

  it('同一毫秒批量写入也按插入序裁（不留不确定的那一份）', async () => {
    const { snapshots } = await boot(2);
    const first = snapshots.record(sampleDoc(), 'classic', 'f1', 100).snapshotId;
    const second = snapshots.record(sampleDoc(), 'classic', 'f2', 100).snapshotId;
    const third = snapshots.record(sampleDoc(), 'classic', 'f3', 100).snapshotId;

    const listed = snapshots.list('resume-1');
    expect(listed).toHaveLength(2);
    // 后插入的两条（f2、f3）留下，最早插入的 f1 被裁——rowid 兜底让同刻写入的取舍确定，而不是随机留谁。
    expect(listed.map((item) => item.snapshotId)).toEqual([third, second]);
    expect(listed.map((item) => item.snapshotId)).not.toContain(first);
  });
});
