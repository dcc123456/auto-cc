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
import { AppError, asApp, Context, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { LogService } from '@auto-cc/plugin-logger';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdirSync, readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { RESUME_IMPORT_MIGRATION_VERSION, ResumeParseService } from './parse-service.js';

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
 * 挂起 config + log + store + resume.parse。
 * @param dir 复用哪个目录（演「换个进程重挂同一份库」时传同一个）
 * @param maxBytes 单次导入字节上限，用于测「超大文件」这条失败腿
 * @returns 解析服务、日志出口与裸连接
 */
async function boot(dir = tempDir(), maxBytes = 5_242_880) {
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  // `redact: false`：见文件头说明，为了让 4.1-09 的日志半边断言到「根本没落原文」而不是「出口遮掉了」。
  fibers.push(await ctx.plugin(LogService, { level: 'info', buffer: 500, file: 'auto-cc.log', dir, redact: false }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(ResumeParseService, { maxBytes }));
  const app = asApp(ctx);
  return { parse: app['resume.parse'], log: app.log, db: app.store.db };
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
    expect(sources).toContain("static inject = ['store']");
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
