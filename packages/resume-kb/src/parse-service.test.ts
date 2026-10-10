/**
 * `resume.parse` 的装配用例（spec 4.1-04 / 4.1-05 / 4.1-06 / 4.1-07 / 4.1-09 / 4.1-10）。
 *
 * 一律打**真的 `node:sqlite` + 真临时目录里的真文件**（AGENTS.md §7.5，产物不进仓库）：
 * 这一层存在的理由就是「装机后按路径导入会落库、会幂等、会脱敏、会把失败变成结构化错误」，
 * 判定逻辑本身在 `sections.test.ts` / `source.test.ts` 里已经逐字段断言过，这里不重复。
 *
 * 语料仍是**自造的虚构简历**（明显编造的号段），且日志侧故意把 `redact: false` 打开——
 * 4.1-09 要证明的是「本服务压根没把原文交给日志」，而不是「出口帮忙遮掉了」，两者是完全不同强度的结论。
 */
import { AppError, asApp, Context, NO_CONFIG, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { LogService } from '@auto-cc/plugin-logger';
import { ResumeDocService } from '@auto-cc/plugin-resume-doc';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdirSync, readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  RESUME_IMPORT_MIGRATION_VERSION,
  RESUME_IMPORT_SOURCE_NAME_MIGRATION_VERSION,
  ResumeParseService,
  type ImportReceipt,
} from './parse-service.js';
import { FakeAgentToolsService } from './test-doubles.js';

const NOW_MS = 1_700_000_000_000;
const LATER_MS = 1_700_000_900_000;

/** 虚构简历：抬头三行联系方式（手机号 / 邮箱 / 身份证）+ 五类区块，用于脱敏与幂等断言。 */
const RESUME_MD = [
  '张三',
  '电话：13800001111',
  '邮箱：zhangsan@example.com',
  '身份证：110101199003071234',
  '',
  '## 个人简介',
  '五年后端工程师，专注高并发服务与可观测性。',
  '期望薪资 15000-25000。',
  '',
  '## 工作经历',
  '星桥科技｜后端工程师 2021.03-2024.06',
  '- 主导订单服务重构，P99 延迟下降 40%。',
  '',
  '## 教育经历',
  '东海大学 计算机科学与技术 学士 2015.09-2019.06',
  '',
  '## 技能',
  '- TypeScript',
  '- Node.js / Electron',
].join('\n');

/** 疑似扫描件：只有标题与两三行字，抽文本长度必然低于 `MIN_TEXT_CHAR_COUNT`（4.1-05）。 */
const SCAN_LIKE_MD = '# 简历\n\n张三\n\n（本文件为图片型 PDF 的抽取结果，无文本层）\n';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 建一个系统临时目录（`afterAll` 清理，不进仓库）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-resume-import-'));
  sandboxes.push(dir);
  return dir;
}

/**
 * 把文本写成临时目录里的一份文件。
 * @param dir 哪个沙箱
 * @param name 文件名（只影响界面回显，格式按魔数判定）
 * @param content 文件正文
 * @returns 绝对路径，交给 `fromFile`
 */
function writeFile(dir: string, name: string, content: string | Uint8Array): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, content);
  return filePath;
}

/**
 * 挂起 config + log + store + resume.doc + resume.parse。
 * @param dir 复用哪个目录（演「换个进程重挂同一份库」时传同一个）
 * @param maxBytes 单次导入字节上限，用于测「超大文件」这条失败腿
 * @param withAgentTools 是否在本服务之前挂上 agent 工具注册表替身（默认不挂：5.1-c 之外的用例判的是
 *        入库与脱敏，不该被注册表分走注意力；要挂必须早于本服务，`registerAgentTools` 是软取）
 * @returns 解析服务、文档存储服务、日志出口、裸连接，以及（挂了替身时）注册表替身，未挂时为 null
 */
async function boot(dir = tempDir(), maxBytes = 5_242_880, withAgentTools = false) {
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  // `redact: false`：见文件头说明，为了让 4.1-09 的日志半边断言到「根本没落原文」而不是「出口遮掉了」。
  fibers.push(await ctx.plugin(LogService, { level: 'info', buffer: 500, file: 'auto-cc.log', dir, redact: false }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  // 工作副本的落点（plan §1.4 裁定一）：`resume.parse` 现在 inject 了 `resume.doc`，不挂它整个服务会 PENDING。
  fibers.push(await ctx.plugin(ResumeDocService, {}));
  if (withAgentTools) fibers.push(await ctx.plugin(FakeAgentToolsService, NO_CONFIG));
  fibers.push(await ctx.plugin(ResumeParseService, { maxBytes }));
  const app = asApp(ctx);
  return {
    parse: app['resume.parse'],
    doc: app['resume.doc'],
    log: app.log,
    db: app.store.db,
    tools: withAgentTools ? (ctx.get('agent.tools') as unknown as FakeAgentToolsService) : null,
  };
}

/** `resume_imports` 的全部行数。 */
function rowCount(db: DatabaseSync): number {
  return db.prepare('SELECT source_hash FROM resume_imports').all().length;
}

/** 库里所有落盘的文本列拼成一句（脱敏断言的扫描面：正文与待确认清单都算）。 */
function allStoredText(db: DatabaseSync): string {
  return db
    .prepare('SELECT doc_json, issues_json FROM resume_imports')
    .all()
    .map((row) => `${String(row.doc_json)}${String(row.issues_json)}`)
    .join('\n');
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  // `LogService` 的落盘写流是**异步开文件**的：测试跑到最后几次挂载时，句柄可能还没打开，
  // 此时删目录会让写流在退出后抛未捕获的 ENOENT（把一次通过的验收判成失败）。给一个宽限期再删。
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不该把一次通过的验收判成失败（Windows 句柄延迟释放）。
    }
  }
});

describe('建表与迁移', () => {
  it('挂载即建 resume_imports 表，迁移号段为 10', async () => {
    const { db } = await boot();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='resume_imports'").get() as
      { name?: string } | undefined;
    expect(row?.name).toBe('resume_imports');
    expect(RESUME_IMPORT_MIGRATION_VERSION).toBe(10);
  });

  it('迁移号段不复用任何已分配号段（撞号的后果是「见号已存在就跳过建表」，表根本不存在）', () => {
    // 已分配：账本 1 / agent 会话 2 / jobs 3 / workflow run 4 / conversation 5 / consent 6 /
    // resume_docs 7 / resume_snapshots 8 / delivery_records 9。
    const taken = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(taken.has(RESUME_IMPORT_MIGRATION_VERSION)).toBe(false);
  });

  it('同一目录重开（换一批 fiber）后表与行都还在，证明落的是库不是内存', async () => {
    const dir = tempDir();
    const first = await boot(dir);
    const receipt = await first.parse.fromFile(writeFile(dir, 'a.md', RESUME_MD), NOW_MS);
    for (const fiber of fibers.splice(0)) await fiber.dispose();
    const second = await boot(dir);
    expect(rowCount(second.db)).toBe(1);
    expect(second.parse.pending().map((item) => item.docId)).toContain(receipt.docId);
  });
});

describe('4.1-07 幂等导入', () => {
  it('同一份文件导两次：行数与 docId 都不变，第二次 isNew 为 false 且 created_at 保持首次时间', async () => {
    const dir = tempDir();
    const { parse, db } = await boot(dir);
    const filePath = writeFile(dir, 'same.md', RESUME_MD);
    const first = await parse.fromFile(filePath, NOW_MS);
    const second = await parse.fromFile(filePath, LATER_MS);

    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.docId).toBe(first.docId);
    expect(second.sourceHash).toBe(first.sourceHash);
    expect(rowCount(db)).toBe(1);

    const row = db
      .prepare('SELECT created_at, updated_at, text_length FROM resume_imports WHERE source_hash = ?')
      .get(first.sourceHash) as { created_at: number; updated_at: number; text_length: number };
    expect(Number(row.created_at)).toBe(NOW_MS);
    expect(Number(row.updated_at)).toBe(LATER_MS);
    expect(Number(row.text_length)).toBe(first.textLength);
  });

  it('docId 由来源哈希推出：换一份内容就换一个 id，不会因为文件名相同而互相覆盖', async () => {
    const dir = tempDir();
    const { parse, db } = await boot(dir);
    const a = await parse.fromFile(writeFile(dir, 'resume.md', RESUME_MD), NOW_MS);
    const b = await parse.fromFile(writeFile(dir, 'resume.md', `${RESUME_MD}\n- Go\n`), NOW_MS);
    expect(a.docId).not.toBe(b.docId);
    expect(rowCount(db)).toBe(2);
  });

  it('哈希在抽取之前算：PDF 腿把 ArrayBuffer 移交给 pdf.js 之后，幂等键仍然是同一份字节的哈希', async () => {
    const dir = tempDir();
    const { parse } = await boot(dir);
    const filePath = writeFile(dir, 'resume.md', RESUME_MD);
    const first = await parse.fromFile(filePath, NOW_MS);
    expect(first.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    const again = await parse.fromFile(filePath, NOW_MS);
    expect(again.sourceHash).toBe(first.sourceHash);
  });
});

describe('4.1-04 待确认清单', () => {
  it('带 issues 的导入出现在 pending() 里，逐字段可从库里读回（界面数据源就是这一条查询）', async () => {
    const dir = tempDir();
    const { parse } = await boot(dir);
    const receipt = await parse.fromFile(writeFile(dir, 'resume.md', RESUME_MD), NOW_MS);
    expect(receipt.issues.length).toBeGreaterThan(0);
    const [view] = parse.pending();
    if (view === undefined) return expect(parse.pending()).toHaveLength(1);
    expect(view).toMatchObject({
      docId: receipt.docId,
      sourceHash: receipt.sourceHash,
      format: 'markdown',
      status: 'imported',
      textLength: receipt.textLength,
      updatedAt: NOW_MS,
    });
    expect(view.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['sensitive-redacted']));
  });

  it('清单只含「还有未处理条目」的记录：issues 清空后该行不再出现', async () => {
    const dir = tempDir();
    const { parse, db } = await boot(dir);
    await parse.fromFile(writeFile(dir, 'resume.md', RESUME_MD), NOW_MS);
    expect(parse.pending()).toHaveLength(1);
    db.prepare(`UPDATE resume_imports SET issues_json = '[]'`).run();
    expect(parse.pending()).toEqual([]);
  });

  it('多条待确认按更新时间倒序（最新的在最前，界面不必再排）', async () => {
    const dir = tempDir();
    const { parse } = await boot(dir);
    await parse.fromFile(writeFile(dir, 'old.md', RESUME_MD), NOW_MS);
    await parse.fromFile(writeFile(dir, 'new.md', `${RESUME_MD}\n- Go\n`), LATER_MS);
    expect(parse.pending().map((item) => item.updatedAt)).toEqual([LATER_MS, NOW_MS]);
  });
});

describe('4.1-14 出处（来路看得见）', () => {
  it('迁移 37 给本表补上 source_name 列并记进台账；取号往后走、不回填', async () => {
    const { db } = await boot();
    const columns = db.prepare('PRAGMA table_info(resume_imports)').all() as unknown as readonly { name: string }[];
    expect(columns.map((column) => column.name)).toContain('source_name');
    // 取号纪律（AGENTS.md §9 的 5.3-a）：36 是当前最高已用号（`resume_preferences`），34 在本工作树读不到
    // 但按纪律不当成可占的号——所以新号必须**大于 36**，不是回填。
    expect(RESUME_IMPORT_SOURCE_NAME_MIGRATION_VERSION).toBe(37);
    expect(RESUME_IMPORT_SOURCE_NAME_MIGRATION_VERSION).toBeGreaterThan(36);
    const ledger = db.prepare('SELECT version FROM schema_migrations').all() as unknown as readonly {
      version: number | bigint;
    }[];
    expect(ledger.map((row) => Number(row.version))).toContain(RESUME_IMPORT_SOURCE_NAME_MIGRATION_VERSION);
  });

  it('导入时记下人选中的**文件名**（不含目录），provenance() 与 pending() 两条读数都带它', async () => {
    const dir = tempDir();
    const { parse } = await boot(dir);
    const receipt = await parse.fromFile(writeFile(dir, '张三-后端简历.md', RESUME_MD), NOW_MS);
    const [line] = parse.provenance();
    if (line === undefined) return expect(parse.provenance()).toHaveLength(1);
    expect(line).toMatchObject({ docId: receipt.docId, format: 'markdown', status: 'imported', importedAt: NOW_MS });
    expect(line.sourceName).toBe('张三-后端简历.md');
    // 目录不进库（§8.5 的默认脱敏：路径说的是"放在我哪块盘上"，对简历读数没有增益）。
    expect(line.sourceName).not.toContain(dir);
    expect(parse.pending()[0]?.sourceName).toBe('张三-后端简历.md');
  });

  it('来路覆盖**干净**导入：issues 清空后 pending() 不再出现，provenance() 仍然说得出它从哪来', async () => {
    const dir = tempDir();
    const { parse, db } = await boot(dir);
    await parse.fromFile(writeFile(dir, 'clean.md', RESUME_MD), NOW_MS);
    db.prepare(`UPDATE resume_imports SET issues_json = '[]'`).run();
    expect(parse.pending()).toEqual([]);
    expect(parse.provenance().map((item) => item.sourceName)).toEqual(['clean.md']);
  });

  it('第 37 版之前的老行就是 null：读路径不拿哈希、也不拿姓名冒充文件名', async () => {
    const dir = tempDir();
    const { parse, db } = await boot(dir);
    const receipt = await parse.fromFile(writeFile(dir, 'legacy.md', RESUME_MD), NOW_MS);
    db.prepare('UPDATE resume_imports SET source_name = NULL').run();
    const [line] = parse.provenance();
    expect(line?.sourceName).toBeNull();
    expect(line?.docId).toBe(receipt.docId);
    expect(parse.pending()[0]?.sourceName).toBeNull();
  });

  it('同一份内容换名重导：出处刷新成这次的名字，行数与 docId 都不变（4.1-07 的幂等不被出处破坏）', async () => {
    const dir = tempDir();
    const { parse, db } = await boot(dir);
    const first = await parse.fromFile(writeFile(dir, '旧名.md', RESUME_MD), NOW_MS);
    const second = await parse.fromFile(writeFile(dir, '新名.md', RESUME_MD), LATER_MS);
    expect(second.docId).toBe(first.docId);
    expect(rowCount(db)).toBe(1);
    expect(parse.provenance()).toHaveLength(1);
    expect(parse.provenance()[0]?.sourceName).toBe('新名.md');
  });

  it('removeForDoc 删掉本表的出处行并回报行数；从没导过的工作副本返回 0 而不是抛错', async () => {
    const dir = tempDir();
    const { parse, db } = await boot(dir);
    const receipt = await parse.fromFile(writeFile(dir, 'gone.md', RESUME_MD), NOW_MS);
    expect(parse.removeForDoc(receipt.docId)).toBe(1);
    expect(rowCount(db)).toBe(0);
    expect(parse.provenance()).toEqual([]);
    expect(parse.removeForDoc(receipt.docId)).toBe(0);
  });
});

describe('4.1-05 疑似扫描件', () => {
  it('抽文本过短返回 status: scanned（是结论不是异常），文档列留空而不是编一份', async () => {
    const dir = tempDir();
    const { parse, db } = await boot(dir);
    const receipt = await parse.fromFile(writeFile(dir, 'scan.md', SCAN_LIKE_MD), NOW_MS);
    expect(receipt.status).toBe('scanned');
    expect(receipt.sections).toEqual([]);
    expect(receipt.textLength).toBeLessThan(100);
    expect(receipt.issues.some((issue) => issue.code === 'text-too-short')).toBe(true);
    const row = db.prepare('SELECT doc_json FROM resume_imports WHERE source_hash = ?').get(receipt.sourceHash) as {
      doc_json: string;
    };
    expect(row.doc_json).toBe('null');
  });

  it('扫描件同样进待确认清单，界面据此提示人工补录', async () => {
    const dir = tempDir();
    const { parse } = await boot(dir);
    await parse.fromFile(writeFile(dir, 'scan.md', SCAN_LIKE_MD), NOW_MS);
    expect(parse.pending()[0]).toMatchObject({ status: 'scanned' });
  });
});

describe('4.1-06 失败腿收敛成结构化错误', () => {
  /** 四条失败腿：相对路径、不存在、是目录、超过字节上限。 */
  const cases: { readonly name: string; readonly prepare: (dir: string) => string; readonly maxBytes?: number }[] = [
    { name: '相对路径', prepare: () => 'relative/resume.md' },
    { name: '文件不存在', prepare: (dir) => join(dir, 'missing.md') },
    { name: '是个目录', prepare: (dir) => join(dir, 'a-dir') },
    { name: '超过字节上限', prepare: (dir) => writeFile(dir, 'big.md', `${RESUME_MD}\n`.repeat(200)), maxBytes: 1024 },
  ];

  for (const item of cases) {
    it(`${item.name}：抛 AppError('RESUME_IMPORT_FAILED')，中文提示可读，主进程不抛裸异常`, async () => {
      const dir = tempDir();
      if (item.name === '是个目录') mkdirSync(join(dir, 'a-dir'));
      const { parse, db } = await boot(dir, item.maxBytes ?? 5_242_880);
      const error = await parse.fromFile(item.prepare(dir), NOW_MS).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        name: 'AppError',
        code: 'RESUME_IMPORT_FAILED',
      });
      expect((error as { message: string }).message).toMatch(/[\u4e00-\u9fa5]/);
      // 4.1-06 的字面判据是「跨进程返回 AppErrorPayload」：这里断言的是同一条错误能被网关转成结构化载荷。
      expect(AppError.from(error)).toMatchObject({ code: 'RESUME_IMPORT_FAILED' });
      expect(rowCount(db)).toBe(0);
    });
  }

  it('%PDF- 开头但结构损坏：细节里带机器码 invalid-pdf，底层原文不进界面文案以外的地方', async () => {
    const dir = tempDir();
    const { parse } = await boot(dir);
    const filePath = writeFile(dir, 'broken.pdf', '%PDF-1.4\n这不是合法的 PDF 结构\n');
    const error = (await parse.fromFile(filePath, NOW_MS).catch((caught: unknown) => caught)) as {
      code: string;
      details?: { code?: string; sourceHash?: string };
    };
    expect(error.code).toBe('RESUME_IMPORT_FAILED');
    expect(error.details?.code).toBe('invalid-pdf');
    expect(error.details?.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('既不是 PDF/DOCX 也不是合法 UTF-8 的二进制：unsupported-format，同样只有一个错误码', async () => {
    const dir = tempDir();
    const { parse } = await boot(dir);
    const filePath = writeFile(dir, 'raw.bin', Uint8Array.from([0x00, 0xff, 0xfe, 0x01, 0x02, 0xd8, 0x41]));
    const error = (await parse.fromFile(filePath, NOW_MS).catch((caught: unknown) => caught)) as {
      code: string;
      details?: { code?: string };
    };
    expect(error.code).toBe('RESUME_IMPORT_FAILED');
    expect(error.details?.code).toBe('unsupported-format');
  });
});

describe('4.1-09 入库与日志脱敏', () => {
  it('手机号 / 邮箱 / 身份证不以原文进入库的任何文本列', async () => {
    const dir = tempDir();
    const { parse, db } = await boot(dir);
    await parse.fromFile(writeFile(dir, 'resume.md', RESUME_MD), NOW_MS);
    const stored = allStoredText(db);
    expect(stored).not.toContain('13800001111');
    expect(stored).not.toContain('zhangsan@example.com');
    expect(stored).not.toContain('110101199003071234');
    expect(stored).toContain('***');
  });

  it('日志里只落 docId + 哈希前缀 + 计数：把脱敏出口关掉也扫不出原文（4.1-09 的强判据）', async () => {
    const dir = tempDir();
    const { parse, log } = await boot(dir);
    await parse.fromFile(writeFile(dir, 'resume.md', RESUME_MD), NOW_MS);
    const lines = log
      .tail(500)
      .map((line) => line.text)
      .join('\n');
    expect(lines).toMatch(/\[resume-parse\]/);
    expect(lines).not.toContain('13800001111');
    expect(lines).not.toContain('zhangsan@example.com');
    expect(lines).not.toContain('110101199003071234');
    expect(lines).not.toContain('五年后端工程师');
  });
});

describe('4.1-10 只用共享连接', () => {
  it('包内没有任何一处自己打开 SQLite 连接（只经 store.db），并显式 inject store', () => {
    const sources = readdirSync(import.meta.dirname)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => readFileSync(join(import.meta.dirname, name), 'utf8'))
      .join('\n');
    expect(sources).not.toContain('new DatabaseSync(');
    expect(sources).toContain("static inject = ['store', 'resume.doc']");
  });

  it('回执不带文档正文：过进程边界的只有区块计数（整份 JSON 留在库里）', async () => {
    const dir = tempDir();
    const { parse } = await boot(dir);
    const receipt = await parse.fromFile(writeFile(dir, 'resume.md', RESUME_MD), NOW_MS);
    expect(receipt.sections.map((section) => section.kind)).toEqual(['summary', 'experience', 'education', 'skills']);
    expect(Object.keys(receipt)).not.toContain('document');
    expect(JSON.stringify(receipt)).not.toContain('星桥科技');
  });
});

describe('导入即建可编辑工作副本（plan §1.4 裁定一）', () => {
  /** `resume_docs` 的行数——工作副本是不是真的落到了 P3 那张表上。 */
  const workCopyCount = (db: DatabaseSync): number => {
    const row = db.prepare('SELECT COUNT(*) AS total FROM resume_docs').get() as { total: number | bigint };
    return Number(row.total);
  };

  it('导入后同一 docId 在 resume_docs 有行，且能被 resume.doc 合法读回（编辑与 PDF 导出从此有内容可读）', async () => {
    const dir = tempDir();
    const { parse, doc, db } = await boot(dir);
    const receipt = await parse.fromFile(writeFile(dir, 'resume.md', RESUME_MD), NOW_MS);
    expect(workCopyCount(db)).toBe(1);
    const loaded = doc.load(receipt.docId);
    expect(loaded.status).toBe('found');
    if (loaded.status !== 'found') return;
    expect(loaded.document.sections.map((section) => section.kind)).toEqual([
      'summary',
      'experience',
      'education',
      'skills',
    ]);
  });

  it('重复导入只刷新出处，不覆盖用户已经改过的工作副本', async () => {
    const dir = tempDir();
    const { parse, doc, db } = await boot(dir);
    const filePath = writeFile(dir, 'resume.md', RESUME_MD);
    const receipt = await parse.fromFile(filePath, NOW_MS);
    const loaded = doc.load(receipt.docId);
    if (loaded.status !== 'found') throw new Error('工作副本没建起来');
    // 把每个 entry 的第一个字段改成显眼的值，模拟用户在 3.x 里编辑过这份简历。
    doc.save({
      ...loaded.document,
      sections: loaded.document.sections.map((section) => ({
        ...section,
        entries: section.entries.map((entry) => ({
          ...entry,
          fields: entry.fields.map((field, index) => (index === 0 ? { ...field, value: '我改过的简历内容' } : field)),
        })),
      })),
    });
    const edited = JSON.stringify(doc.load(receipt.docId));

    const again = await parse.fromFile(filePath, LATER_MS);
    expect(again.isNew).toBe(false);
    expect(workCopyCount(db)).toBe(1);
    expect(JSON.stringify(doc.load(receipt.docId))).toBe(edited);
  });

  it('扫描件不建工作副本：没有可编辑文档，只留一条待人工补录的出处', async () => {
    const dir = tempDir();
    const { parse, db } = await boot(dir);
    const receipt = await parse.fromFile(writeFile(dir, 'tiny.md', '张三\n电话：13800001111'), NOW_MS);
    expect(receipt.status).toBe('scanned');
    expect(workCopyCount(db)).toBe(0);
  });
});

/**
 * 5.1-c 的建档腿：`resume.parse` 要能被对话挑中，且挑中之后走的仍是 4.1 那一条导入链——
 * 判据与 4.5-b 的 `resume.generate.run` 同形（登记形状 / 两入口产物相等 / 入参是边界）。
 */
describe('resume.parse 的 agent 工具面（spec 5.1-07 的建档）', () => {
  /** 从替身注册表里取本包那只工具，取不到就直接失败（免得断言退化成对 undefined 取属性）。 */
  function parseTool(tools: FakeAgentToolsService | null) {
    const tool = tools?.declarations.get('resume.parse.fromFile');
    if (tool === undefined) throw new Error('resume.parse.fromFile 未登记进 agent 工具面');
    return tool;
  }

  it('挂载即登记一只 resume.parse.fromFile：本地写入、需批准、标题是 i18n 键不是文案', async () => {
    const { tools } = await boot(tempDir(), 5_242_880, true);
    if (tools === null) throw new Error('注册表替身未挂载');
    // 本包只往这里登记这一只（`kb.profile` / `kb.gap` 那几只在它们自己的服务里登记，本用例没挂它们）。
    expect([...tools.declarations.keys()]).toEqual(['resume.parse.fromFile']);
    const tool = parseTool(tools);
    expect(tool.effect).toBe('local-write');
    expect(tool.requiresConfirmation).toBe(true);
    expect(tool.titleKey).toBe('agent.tool.labels.parseFromFile');
    // 描述里必须写清「不出网、不外发、幂等」：模型据此判断这不是外发动作、重复导入不会长出第二套实体。
    expect(tool.description).toContain('不出网');
    expect(tool.description).toContain('幂等');
  });

  it('注册表没装时服务照常挂载并能导入：登记数为 0 而不是抛错（agent 可单独摘掉的前提）', async () => {
    const dir = tempDir();
    const { parse, db } = await boot(dir);
    const receipt = await parse.fromFile(writeFile(dir, 'no-tools.md', RESUME_MD), NOW_MS);
    expect(receipt.status).toBe('imported');
    expect(rowCount(db)).toBe(1);
  });

  it('跑工具与直接调 service 的产物逐字相等：两入口共用同一条导入链（§5.9）', async () => {
    const toolDir = tempDir();
    const serviceDir = tempDir();
    const { tools, db: toolDb, doc: toolDoc } = await boot(toolDir, 5_242_880, true);
    const { parse, db: serviceDb } = await boot(serviceDir);
    // 两份沙箱、同一份正文：`sourceHash` 由内容决定，所以两条腿必须落到同一个 docId。
    // 逐字比较而不是比字段，是因为 `ImportReceipt` 里没有时间戳（入库时间只进库列），相等就是整条链相等。
    const viaTool = (
      await parseTool(tools).run({
        filePath: writeFile(toolDir, 'same.md', RESUME_MD),
      })
    ).value as ImportReceipt;
    const viaService = await parse.fromFile(writeFile(serviceDir, 'same.md', RESUME_MD));
    expect(JSON.stringify(viaTool)).toBe(JSON.stringify(viaService));
    expect(rowCount(toolDb)).toBe(1);
    expect(rowCount(serviceDb)).toBe(1);
    // 工具那条腿同样把可编辑工作副本建起来了（只写 `resume_imports` 的话，3.x 的编辑与导出读不到它）。
    expect(toolDoc.load(viaTool.docId).status).toBe('found');
  });

  it('入参是边界：空路径与非声明键一律拒收，拒收时不碰文件系统', async () => {
    const dir = tempDir();
    const { tools } = await boot(dir, 5_242_880, true);
    const input = parseTool(tools).input;
    expect(input.safeParse({ filePath: writeFile(dir, 'ok.md', RESUME_MD) }).success).toBe(true);
    expect(input.safeParse({}).success).toBe(false);
    expect(input.safeParse({ filePath: '' }).success).toBe(false);
    // 入库时间只能由服务取：让模型填 `nowMs` 等于让它决定「这份简历是哪天导入的」（同 4.5-b 的 nowMs 判据）。
    expect(input.safeParse({ filePath: 'C:/x.md', nowMs: NOW_MS }).success).toBe(false);
  });
});
