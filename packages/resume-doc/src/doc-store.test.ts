/**
 * `resume.doc` 落库用例（spec 3.1-08 文档 JSON 安全往返）。
 *
 * 一律打**真的 `node:sqlite`**（系统临时目录，不进仓库，AGENTS.md §7.5）：
 * 「往返」这件事 mock 掉就等于没测——只有真的序列化进 TEXT 列、把服务连根拔掉再重开、读回来重新校验，
 * 才证明 JSON 一进一出没有丢信息、归一化与 hash 稳定、损坏行能被读路径识别成 corrupt 而不是崩。
 */
import { asApp, Context, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ResumeDocService, RESUME_DOC_MIGRATION_VERSION } from './doc-store.js';
import { contentHash } from './normalize.js';
import { DEFAULT_LAYOUT, makeField, RESUME_SCHEMA_VERSION, type ResumeDocument } from './model.js';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-resume-doc-'));
  sandboxes.push(dir);
  return dir;
}

/** 挂起 config + store + resume.doc，返回服务与裸连接。 */
async function boot(dir = tempDir()) {
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(ResumeDocService, {}));
  const app = asApp(ctx);
  return { store: app.store, docs: app['resume.doc'], db: app.store.db };
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
            fields: [makeField('experience', 'company', '星桥科技'), makeField('experience', 'period', '2021-2024')],
          },
        ],
      },
    ],
    metrics: { pages: 1 },
    updatedAt: 1234,
    ...overrides,
  };
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
  it('挂载即建 resume_docs 表，迁移号段为 7', async () => {
    const { db } = await boot();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='resume_docs'").get() as
      { name?: string } | undefined;
    expect(row?.name).toBe('resume_docs');
    expect(RESUME_DOC_MIGRATION_VERSION).toBe(7);
  });

  it('迁移号段不复用任何已分配号段（防止 ensureSchema 幂等 push 静默跳过建表）', () => {
    // 已分配：账本 1 / agent 会话 2 / jobs 3 / workflow run 4 / conversation 5 / consent 6。
    // 撞号不会抛错，而是让后挂载方「见号已存在就跳过 push」→ 表根本没建 → 读写报 no such table。
    // consent-store（spec 2.7-06）正是占 6 的那个——本包初稿误当 5 是最后一个，故把这条做成可执行护栏。
    const taken = new Set([1, 2, 3, 4, 5, 6]);
    expect(taken.has(RESUME_DOC_MIGRATION_VERSION)).toBe(false);
  });
});

describe('3.1-08 文档 JSON 安全往返', () => {
  it('save 后 load 得到内容一致的合法文档，hash 与直接计算相等', async () => {
    const { docs } = await boot();
    const doc = sampleDoc();
    const saved = docs.save(doc);
    expect(saved.hash).toBe(contentHash(doc));
    const loaded = docs.load('resume-1');
    expect(loaded.status).toBe('found');
    if (loaded.status === 'found') {
      expect(contentHash(loaded.document)).toBe(contentHash(doc));
      expect(loaded.document.sections[0]?.entries[0]?.fields.find((f) => f.key === 'company')?.value).toBe('星桥科技');
    }
  });

  it('拔掉服务重开同一目录后仍能读回（证明落的是库不是内存）', async () => {
    const dir = tempDir();
    const first = await boot(dir);
    first.docs.save(sampleDoc({ id: 'persist' }));
    // 释放这一套 fiber（含 store 关连接），再用同一个 dir 重开。
    for (const fiber of fibers.splice(0)) await fiber.dispose();
    const second = await boot(dir);
    const loaded = second.docs.load('persist');
    expect(loaded.status).toBe('found');
  });

  it('未保存的 id → missing，不抛异常', async () => {
    const { docs } = await boot();
    expect(docs.load('never-saved').status).toBe('missing');
  });

  it('库里塞进坏 JSON → load 判 corrupt 而非崩', async () => {
    const { docs, db } = await boot();
    docs.save(sampleDoc({ id: 'bad' }));
    db.prepare("UPDATE resume_docs SET doc_json = '{ this is not json' WHERE id = 'bad'").run();
    expect(docs.load('bad').status).toBe('corrupt');
  });

  it('save 非法文档（pages=0）→ 结构化 AppError，不落库', async () => {
    const { docs } = await boot();
    expect(() => docs.save(sampleDoc({ metrics: { pages: 0 } }))).toThrowError(/文档未通过校验/);
    expect(docs.exists(sampleDoc().id)).toBe(false);
  });

  it('重复 save 同一 id 覆盖而非报错（UPSERT）', async () => {
    const { docs } = await boot();
    docs.save(sampleDoc());
    docs.save(sampleDoc({ profile: { name: '李四', contact: { email: null, phone: null, location: null } } }));
    const loaded = docs.load('resume-1');
    expect(loaded.status === 'found' && loaded.document.profile.name).toBe('李四');
  });
});

describe('文档清单（生成轨的选文档口）', () => {
  it('空库返回空数组，不抛异常', async () => {
    const { docs } = await boot();
    expect(docs.list()).toEqual([]);
  });

  it('只给 id / 姓名 / 更新时间，按更新先后倒序，且不含正文', async () => {
    const { docs } = await boot();
    docs.save(sampleDoc({ id: 'older', profile: { ...sampleDoc().profile, name: '王五' }, updatedAt: 1000 }));
    docs.save(sampleDoc({ id: 'newer', updatedAt: 2000 }));
    expect(docs.list()).toEqual([
      { id: 'newer', name: '张三', updatedAt: 2000 },
      { id: 'older', name: '王五', updatedAt: 1000 },
    ]);
  });

  it('profile.name 缺失时 name 为 null（界面回落到 id 显示）', async () => {
    const { docs, db } = await boot();
    docs.save(sampleDoc({ id: 'no-name' }));
    db.prepare("UPDATE resume_docs SET doc_json = json_remove(doc_json, '$.profile.name') WHERE id = 'no-name'").run();
    expect(docs.list()).toEqual([{ id: 'no-name', name: null, updatedAt: 1234 }]);
  });
});
