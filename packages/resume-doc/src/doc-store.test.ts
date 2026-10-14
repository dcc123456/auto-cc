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
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ResumeDocService,
  RESUME_DOC_JD_LABEL_MIGRATION_VERSION,
  RESUME_DOC_MIGRATION_VERSION,
  RESUME_DOC_VARIANT_MIGRATION_VERSION,
} from './doc-store.js';
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

  it('只给 id / 姓名 / 更新时间 / 血缘，按更新先后倒序，且不含正文', async () => {
    const { docs } = await boot();
    docs.save(sampleDoc({ id: 'older', profile: { ...sampleDoc().profile, name: '王五' }, updatedAt: 1000 }));
    docs.save(sampleDoc({ id: 'newer', updatedAt: 2000 }));
    expect(docs.list()).toEqual([
      { id: 'newer', name: '张三', updatedAt: 2000, parentDocId: null, jdId: null, jdLabel: null },
      { id: 'older', name: '王五', updatedAt: 1000, parentDocId: null, jdId: null, jdLabel: null },
    ]);
  });

  it('profile.name 缺失时 name 为 null（界面回落到 id 显示）', async () => {
    const { docs, db } = await boot();
    docs.save(sampleDoc({ id: 'no-name' }));
    db.prepare("UPDATE resume_docs SET doc_json = json_remove(doc_json, '$.profile.name') WHERE id = 'no-name'").run();
    expect(docs.list()).toEqual([
      { id: 'no-name', name: null, updatedAt: 1234, parentDocId: null, jdId: null, jdLabel: null },
    ]);
  });
});

describe('删除工作副本（spec 4.1-14 的删除通道里属于本表的那一段）', () => {
  it('真删返回 true，再删同一份返回 false 而不是抛（删除的语义是「让它不存在」）', async () => {
    const { docs } = await boot();
    docs.save(sampleDoc({ id: 'gone' }));
    docs.save(sampleDoc({ id: 'kept' }));

    expect(docs.remove('gone')).toBe(true);
    expect(docs.exists('gone')).toBe(false);
    expect(docs.load('gone')).toEqual({ status: 'missing' });
    expect(docs.remove('gone')).toBe(false);
    // 本服务只管自己这张表：另一份一字不动，跨表的原子删除只有一个入口（`kb.profile.removeDoc`）。
    expect(docs.exists('kept')).toBe(true);
  });

  it('删掉的是一份的行，库里其它文档与清单读数跟着收敛', async () => {
    const { docs, db } = await boot();
    docs.save(sampleDoc({ id: 'a', updatedAt: 1000 }));
    docs.save(sampleDoc({ id: 'b', updatedAt: 2000 }));
    expect(docs.remove('a')).toBe(true);
    expect(docs.list().map((item) => item.id)).toEqual(['b']);
    const row = db.prepare('SELECT COUNT(*) AS total FROM resume_docs').get() as { total: number | bigint };
    expect(Number(row.total)).toBe(1);
  });
});

describe('变体血缘与 JD 标题：迁移 39 + 40 与老库升级（spec 4.11-13 / 裁定㊱）', () => {
  /** 读 `resume_docs` 的列名集合（ALTER 有没有真的执行到位，只看这个而不是看服务起没起来）。 */
  function columnNames(db: DatabaseSync): string[] {
    const rows = db.prepare('PRAGMA table_info(resume_docs)').all() as unknown as readonly { name: string }[];
    return rows.map((row) => row.name);
  }

  it('挂载后台账记到 39 与 40，三列都在，且已有母版行的这三列是 NULL', async () => {
    const { docs, db } = await boot();
    docs.save(sampleDoc());
    expect(RESUME_DOC_VARIANT_MIGRATION_VERSION).toBe(39);
    expect(RESUME_DOC_JD_LABEL_MIGRATION_VERSION).toBe(40);
    const ledger = (
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as unknown as readonly {
        version: number | bigint;
      }[]
    ).map((row) => Number(row.version));
    expect(ledger).toContain(RESUME_DOC_MIGRATION_VERSION);
    expect(ledger).toContain(RESUME_DOC_VARIANT_MIGRATION_VERSION);
    expect(ledger).toContain(RESUME_DOC_JD_LABEL_MIGRATION_VERSION);
    expect(columnNames(db)).toEqual(expect.arrayContaining(['parent_doc_id', 'jd_id', 'jd_label']));
    const lineage = db
      .prepare('SELECT parent_doc_id AS p, jd_id AS j FROM resume_docs WHERE id = ?')
      .get('resume-1') as {
      p: string | null;
      j: string | null;
    };
    expect(lineage).toEqual({ p: null, j: null });
  });

  it('老库（只应用过 7 与 36，表只有五列）升级后血缘两列与标题列一起补上，旧行读得回来', async () => {
    // 片 3-A 那条夹具原样留着：它判的是"39 从没跑过的库"能不能一步升到最新形状（两列 + 一列标题）。
    const dir = tempDir();
    const seed = new DatabaseSync(join(dir, 'store.db'));
    seed.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    seed.exec('INSERT INTO schema_migrations (version, applied_at) VALUES (7, 1), (36, 1)');
    seed.exec(`CREATE TABLE resume_docs (
      id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, content_hash TEXT NOT NULL,
      doc_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`);
    seed
      .prepare('INSERT INTO resume_docs VALUES (?, ?, ?, ?, ?)')
      .run('legacy-doc', RESUME_SCHEMA_VERSION, 'legacy-hash', JSON.stringify(sampleDoc({ id: 'legacy-doc' })), 1000);
    seed.close();

    const { docs, db } = await boot(dir);
    expect(columnNames(db)).toEqual(expect.arrayContaining(['parent_doc_id', 'jd_id', 'jd_label']));
    const loaded = docs.load('legacy-doc');
    expect(loaded.status).toBe('found');
    expect(docs.list().map((item) => [item.id, item.parentDocId, item.jdId, item.jdLabel])).toEqual([
      ['legacy-doc', null, null, null],
    ]);
  });

  it('老库（7 / 36 / 39 都记过账，表里已有血缘两列）升级后多出 jd_label 列，旧行照读', async () => {
    // 这一条钉的是 §9 的 5.3-a 那个坑：给已有表加列必须**另起号段**，塞进已应用的版本的 `up` 里不会重跑。
    // 所以这里的夹具是"39 已经跑过"的那一份库（血缘两列已经在表上、台账记着 39），
    // 升级之后只应多出 40 那一列——假如有人把 `jd_label` 回填进 39，这一条就会以 `no such column` 红掉。
    const dir = tempDir();
    const seed = new DatabaseSync(join(dir, 'store.db'));
    seed.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    seed.exec('INSERT INTO schema_migrations (version, applied_at) VALUES (7, 1), (36, 1), (39, 1)');
    seed.exec(`CREATE TABLE resume_docs (
      id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, content_hash TEXT NOT NULL,
      doc_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      parent_doc_id TEXT, jd_id TEXT
    )`);
    seed
      .prepare(
        'INSERT INTO resume_docs (id, schema_version, content_hash, doc_json, updated_at, parent_doc_id, jd_id)' +
          ' VALUES (?, ?, ?, ?, ?, NULL, NULL)',
      )
      .run('legacy-doc', RESUME_SCHEMA_VERSION, 'legacy-hash', JSON.stringify(sampleDoc({ id: 'legacy-doc' })), 1000);
    seed.close();

    const { docs, db } = await boot(dir);
    expect(columnNames(db)).toEqual(expect.arrayContaining(['parent_doc_id', 'jd_id', 'jd_label']));
    // 旧行没被 ALTER 打坏，三列对老行就是 NULL（"它没有来路、也没记过标题"是事实，不是缺数据）。
    const loaded = docs.load('legacy-doc');
    expect(loaded.status).toBe('found');
    expect(docs.list().map((item) => [item.id, item.parentDocId, item.jdId, item.jdLabel])).toEqual([
      ['legacy-doc', null, null, null],
    ]);
  });
});

describe('resume.doc.deriveVariant：唯一的文档复制口（spec 4.11-14 / 裁定㉜）', () => {
  /** 直接读库里的血缘两列，绕开服务（服务自己回的行数与列值要有一条独立通道对得上）。 */
  function lineageOf(db: DatabaseSync, id: string): { parentDocId: string | null; jdId: string | null } | undefined {
    return db.prepare('SELECT parent_doc_id AS parentDocId, jd_id AS jdId FROM resume_docs WHERE id = ?').get(id) as
      { parentDocId: string | null; jdId: string | null } | undefined;
  }

  /** 读一行的内容 hash（母版一字不动这一条判据的唯一量法）。 */
  function hashOf(db: DatabaseSync, id: string): string | undefined {
    return (
      db.prepare('SELECT content_hash AS hash FROM resume_docs WHERE id = ?').get(id) as { hash: string } | undefined
    )?.hash;
  }

  it('派生新建一行：变体正文等于母版（只换 id 与时刻），血缘两列落定，母版 hash 一字不动', async () => {
    const { docs, db } = await boot();
    const master = sampleDoc();
    docs.save(master);
    const masterHash = hashOf(db, 'resume-1');

    const derived = docs.deriveVariant({
      parentDocId: 'resume-1',
      jdId: 'jd-a',
      jdLabel: null,
      document: master,
      nowMs: 5000,
    });
    expect(derived.created).toBe(true);
    expect(derived.docId).not.toBe('resume-1');
    expect(derived.docId).toMatch(/^resume-[0-9a-f]{12}$/);
    expect(hashOf(db, 'resume-1')).toBe(masterHash);
    expect(lineageOf(db, derived.docId)).toEqual({ parentDocId: 'resume-1', jdId: 'jd-a' });

    const variant = docs.load(derived.docId);
    expect(variant.status).toBe('found');
    if (variant.status === 'found') {
      expect(variant.document).toEqual({ ...master, id: derived.docId, updatedAt: 5000 });
    }
  });

  it('同一对 (母版, JD) 再派生只覆盖那一行：不长新行、id 不变、母版仍一字不动', async () => {
    const { docs, db } = await boot();
    docs.save(sampleDoc());
    const masterHash = hashOf(db, 'resume-1');
    const first = docs.deriveVariant({
      parentDocId: 'resume-1',
      jdId: 'jd-a',
      jdLabel: null,
      document: sampleDoc(),
      nowMs: 5000,
    });
    const second = docs.deriveVariant({
      parentDocId: 'resume-1',
      jdId: 'jd-a',
      jdLabel: null,
      document: sampleDoc({ profile: { ...sampleDoc().profile, name: '李四' } }),
      nowMs: 6000,
    });
    expect(second.created).toBe(false);
    expect(second.docId).toBe(first.docId);
    expect(hashOf(db, 'resume-1')).toBe(masterHash);
    expect(
      Number((db.prepare('SELECT COUNT(*) AS total FROM resume_docs').get() as { total: number | bigint }).total),
    ).toBe(2);
    const loaded = docs.load(second.docId);
    expect(loaded.status === 'found' && loaded.document.profile.name).toBe('李四');
  });

  it('两段 JD 各得一支变体，两行并存且血缘与标题各自对得上（spec 4.11-16 的数据面 / 裁定㊱）', async () => {
    const { docs, db } = await boot();
    docs.save(sampleDoc());
    const variantA = docs.deriveVariant({
      parentDocId: 'resume-1',
      jdId: 'jd-a',
      jdLabel: '后端工程师（上海）',
      document: sampleDoc(),
      nowMs: 5000,
    });
    const variantB = docs.deriveVariant({
      parentDocId: 'resume-1',
      jdId: 'jd-b',
      jdLabel: '数据平台工程师',
      document: sampleDoc(),
      nowMs: 6000,
    });
    expect(variantA.docId).not.toBe(variantB.docId);
    expect(lineageOf(db, variantB.docId)).toEqual({ parentDocId: 'resume-1', jdId: 'jd-b' });
    // 标题逐行回读：界面那句"这一支是为哪段 JD 生成的"只有这一列说得出，而它必须是**各自**的而不是同一个。
    expect(docs.list()).toEqual([
      {
        id: variantB.docId,
        name: '张三',
        updatedAt: 6000,
        parentDocId: 'resume-1',
        jdId: 'jd-b',
        jdLabel: '数据平台工程师',
      },
      {
        id: variantA.docId,
        name: '张三',
        updatedAt: 5000,
        parentDocId: 'resume-1',
        jdId: 'jd-a',
        jdLabel: '后端工程师（上海）',
      },
      { id: 'resume-1', name: '张三', updatedAt: 1234, parentDocId: null, jdId: null, jdLabel: null },
    ]);
  });

  it('同一对 (母版, JD) 重生成时标题跟着刷新，血缘仍是那一对（裁定㊱：标题是读数，不是身份）', async () => {
    const { docs, db } = await boot();
    docs.save(sampleDoc());
    const first = docs.deriveVariant({
      parentDocId: 'resume-1',
      jdId: 'jd-a',
      jdLabel: '后端工程师',
      document: sampleDoc(),
      nowMs: 5000,
    });
    const second = docs.deriveVariant({
      parentDocId: 'resume-1',
      jdId: 'jd-a',
      jdLabel: '资深后端工程师（薪资面议）',
      document: sampleDoc(),
      nowMs: 6000,
    });
    expect(second.docId).toBe(first.docId);
    expect(second.created).toBe(false);
    const row = db
      .prepare('SELECT parent_doc_id AS p, jd_id AS j, jd_label AS label FROM resume_docs WHERE id = ?')
      .get(second.docId) as { p: string | null; j: string | null; label: string | null };
    expect(row).toEqual({ p: 'resume-1', j: 'jd-a', label: '资深后端工程师（薪资面议）' });
  });

  it('无归因（jdId=null）也认同一行：SQL 用 IS 而不是 =，否则每派生一次长一行', async () => {
    const { docs, db } = await boot();
    docs.save(sampleDoc());
    const first = docs.deriveVariant({
      parentDocId: 'resume-1',
      jdId: null,
      jdLabel: null,
      document: sampleDoc(),
      nowMs: 5000,
    });
    const second = docs.deriveVariant({
      parentDocId: 'resume-1',
      jdId: null,
      jdLabel: null,
      document: sampleDoc(),
      nowMs: 6000,
    });
    expect(second.created).toBe(false);
    expect(second.docId).toBe(first.docId);
    expect(lineageOf(db, first.docId)).toEqual({ parentDocId: 'resume-1', jdId: null });
    expect(
      Number((db.prepare('SELECT COUNT(*) AS total FROM resume_docs').get() as { total: number | bigint }).total),
    ).toBe(2);
  });

  it('母版不存在时拒绝派生：不凭空造一支没有来路的变体', async () => {
    const { docs, db } = await boot();
    expect(() =>
      docs.deriveVariant({
        parentDocId: 'never-saved',
        jdId: 'jd-a',
        jdLabel: null,
        document: sampleDoc(),
        nowMs: 5000,
      }),
    ).toThrowError(/母版 never-saved 不存在/);
    expect(
      Number((db.prepare('SELECT COUNT(*) AS total FROM resume_docs').get() as { total: number | bigint }).total),
    ).toBe(0);
  });

  it('变体不再往下派生：血缘只许一层，否则界面排不出「这一份是谁的定制结果」', async () => {
    const { docs, db } = await boot();
    docs.save(sampleDoc());
    const variant = docs.deriveVariant({
      parentDocId: 'resume-1',
      jdId: 'jd-a',
      jdLabel: null,
      document: sampleDoc(),
      nowMs: 5000,
    });
    expect(() =>
      docs.deriveVariant({
        parentDocId: variant.docId,
        jdId: 'jd-b',
        jdLabel: null,
        document: sampleDoc(),
        nowMs: 6000,
      }),
    ).toThrowError(/本身是变体/);
    expect(docs.findVariantId(variant.docId, 'jd-b')).toBeNull();
    expect(
      Number((db.prepare('SELECT COUNT(*) AS total FROM resume_docs').get() as { total: number | bigint }).total),
    ).toBe(2);
  });

  it('文档不合校验时整趟回滚：不留一行"正文是变体、血缘是 NULL"的假母版', async () => {
    const { docs, db } = await boot();
    docs.save(sampleDoc());
    expect(() =>
      docs.deriveVariant({
        parentDocId: 'resume-1',
        jdId: 'jd-a',
        jdLabel: null,
        document: sampleDoc({ metrics: { pages: 0 } }),
        nowMs: 5000,
      }),
    ).toThrowError(/文档未通过校验/);
    expect(
      Number((db.prepare('SELECT COUNT(*) AS total FROM resume_docs').get() as { total: number | bigint }).total),
    ).toBe(1);
    expect(docs.findVariantId('resume-1', 'jd-a')).toBeNull();
  });

  it('变体被整屏编辑那侧的 save 覆盖一次之后，血缘两列一字不丢（spec 4.11-19 的存储半边）', async () => {
    const { docs, db } = await boot();
    docs.save(sampleDoc());
    const masterJson = (
      db.prepare('SELECT doc_json AS json FROM resume_docs WHERE id = ?').get('resume-1') as { json: string }
    ).json;
    const derived = docs.deriveVariant({
      parentDocId: 'resume-1',
      jdId: 'jd-a',
      jdLabel: null,
      document: sampleDoc(),
      nowMs: 5000,
    });
    const loaded = docs.load(derived.docId);
    expect(loaded.status).toBe('found');
    if (loaded.status !== 'found') return;
    // 编辑器那条通道就是 `save`（它不认识血缘）：变体正文换了，血缘两列必须原样留着。
    docs.save({ ...loaded.document, profile: { ...loaded.document.profile, name: '改了名' }, updatedAt: 9000 });
    expect(lineageOf(db, derived.docId)).toEqual({ parentDocId: 'resume-1', jdId: 'jd-a' });
    expect(
      (db.prepare('SELECT doc_json AS json FROM resume_docs WHERE id = ?').get('resume-1') as { json: string }).json,
    ).toBe(masterJson);
  });
});
