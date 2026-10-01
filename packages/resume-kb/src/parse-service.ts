/**
 * `resume.parse` service（spec 4.1-06 / 4.1-07 / 4.1-09 / 4.1-10）：把「一份简历文件」变成
 * 已入库的 P3.1 文档 + 待确认清单，是 4.1 三条输入腿在桌面端的唯一落点。
 *
 * 分工刻意窄：判定与抽取全在 `source.ts` / `sections.ts`（纯函数，离线可断言），这一层只做
 * 只有服务才该做的四件事——按上限读用户给的路径、在把字节交给 pdf.js **之前**算来源哈希
 * （`getDocument` 会 detach ArrayBuffer，顺序反了幂等键就废了）、经共享连接幂等入库、以及把解析结果
 * 交给 `resume.doc` 落成**可编辑工作副本**（plan §1.4 裁定一：不进这张表，3.x 的编辑与导出就读不到它）。
 *
 * 与 `outbound.deliver` 的 `readAttachment` 不合并：那条是「取投递附件并先验 `.pdf` 扩展名」，
 * 这一条是「取简历源文件并让解析层按魔数判格式」（4.1-01 要 pdf / docx / md / txt 四种），
 * 判定口径不同、失败语义也不同，抽成一份只会让两边都长出开关参数（AGENTS.md §2.7 的按事判断）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import type { ResumeDocument } from '@auto-cc/plugin-resume-doc';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import type { ParseIssue } from './sections.js';
import { type ResumeSourceFormat, parseResumeSource, sourceHashOf } from './source.js';

/** 迁移号段：账本 1 / agent 会话 2 / jobs 3 / workflow run 4 / conversation 5 / consent 6 / resume_docs 7 / resume_snapshots 8 / delivery_records 9，本表取 10。 */
export const RESUME_IMPORT_MIGRATION_VERSION = 10;

/** 导入结果的两个确定态（4.1-05 的「疑似扫描件」不是异常，是一条正常结论）。 */
export type ImportStatus = 'imported' | 'scanned';

const resumeImportMigration = {
  version: RESUME_IMPORT_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS resume_imports (
      doc_id TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      format TEXT NOT NULL,
      status TEXT NOT NULL,
      text_length INTEGER NOT NULL,
      doc_json TEXT NOT NULL,
      issues_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (source_hash)
    )`);
    // 幂等键就是来源哈希（4.1-07）：主键已保证唯一，这个索引只是把「按文档反查来源」变成索引扫描。
    db.exec('CREATE INDEX IF NOT EXISTS idx_resume_imports_doc ON resume_imports (doc_id, updated_at)');
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS resume_imports');
  },
};

/** `resume.parse` 的可调项。 */
export const resumeParseSchema = z.strictObject({
  /** 单次导入的字节上限，与 `outbound.deliver` 的简历上限同量级，防止误选大文件把主进程吃掉。 */
  maxBytes: z.number().int().min(1024).max(52_428_800).default(5_242_880),
});

export type ResumeParseConfig = z.output<typeof resumeParseSchema>;

/** 界面要的「一份已入库的简历」读数（不含文档正文，正文在库里，见 spec 4.1-c 的边界说明）。 */
export interface ImportReceipt {
  readonly status: ImportStatus;
  readonly docId: string;
  readonly sourceHash: string;
  readonly format: ResumeSourceFormat;
  /** 本轮是否真的新建了行；`false` 表示同哈希二次导入（4.1-07 的断言点）。 */
  readonly isNew: boolean;
  readonly textLength: number;
  /** 各区块的条目数，界面用它说明「读到了什么」。 */
  readonly sections: readonly { kind: string; title: string; entries: number }[];
  readonly issues: readonly ParseIssue[];
}

/** 待确认清单里的一行（4.1-04 的界面数据源）。 */
export interface PendingImportView {
  readonly docId: string;
  readonly sourceHash: string;
  readonly format: ResumeSourceFormat;
  readonly status: ImportStatus;
  readonly textLength: number;
  readonly updatedAt: number;
  readonly issues: readonly ParseIssue[];
}

interface ResumeImportRow {
  readonly doc_id: string;
  readonly source_hash: string;
  readonly format: string;
  readonly status: string;
  readonly text_length: number | bigint;
  readonly doc_json: string;
  readonly issues_json: string;
  readonly updated_at: number | bigint;
}

/** 由来源哈希直接推出文档 id：同一份文件重复导入必然落到同一个 id，不产生第二套实体。 */
function docIdOf(sourceHash: string): string {
  return `resume-${sourceHash.slice(0, 12)}`;
}

/**
 * 简历导入服务：读文件 → 抽文本 → 解析成 P3.1 文档 → 按来源哈希幂等入库。
 *
 * 失败一律抛 `AppError('RESUME_IMPORT_FAILED')`（4.1-06）：路径不是绝对路径、文件不存在、
 * 是个目录、超过 `maxBytes`、格式认不出来、PDF/DOCX 结构损坏，全部收敛成这一个码——
 * 它们在界面上的处置相同（一句可读中文 + 让人换个文件），拆成六个码只会让界面写六遍分支。
 */
export class ResumeParseService extends Service {
  static provide = 'resume.parse';
  static Config = resumeParseSchema;
  // `resume.doc` 是导入结果的**可编辑工作副本**唯一落点（plan §1.4 裁定一）：解析出的文档若只躺在
  // `resume_imports` 里，3.x 的编辑、快照、PDF 导出一条都读不到它——「按 JD 优化简历」会在入口就断。
  static inject = ['store', 'resume.doc'];

  constructor(
    ctx: Context,
    private readonly options: ResumeParseConfig,
  ) {
    super(ctx, 'resume.parse');
  }

  private get store() {
    return asApp(this.ctx).store;
  }

  /** P3 的文档存储服务——工作副本由它写，本包**不往 `resume_docs` 写裸 SQL**（AGENTS.md §2.5 一处真相源）。 */
  private get docStore() {
    return asApp(this.ctx)['resume.doc'];
  }

  /**
   * 幂等地把本表迁移推进共享迁移列表并升级到最新。
   * @returns 无返回值
   */
  private ensureSchema(): void {
    const { migrations } = this.store;
    if (!migrations.some((item) => item.version === RESUME_IMPORT_MIGRATION_VERSION)) {
      migrations.push(resumeImportMigration);
    }
    this.store.upgrade();
  }

  [Service.init](): void {
    this.ensureSchema();
    this.ctx.logger.info(
      `[resume-parse] resume_imports 表就绪，迁移号段 ${String(RESUME_IMPORT_MIGRATION_VERSION)}，单次上限 ${String(this.options.maxBytes)} 字节`,
    );
  }

  /**
   * 导入一份简历文件。
   * @param filePath 用户选的**绝对路径**（渲染层没有读文件的通道，字节只在主进程侧落地，对齐 §8 的隔离底线）
   * @param nowMs 入库时间戳（毫秒），由调用方注入以便测试断言
   * @returns 已入库的读数；文本过短（疑似扫描件，4.1-05）时 `status` 为 `scanned` 且不带文档
   * @throws `AppError('RESUME_IMPORT_FAILED')`——路径非法、读不出、格式不认识、文件结构损坏（4.1-06）
   */
  async fromFile(filePath: string, nowMs = Date.now()): Promise<ImportReceipt> {
    const bytes = this.readBounded(filePath);
    // 顺序是硬约束：pdf.js 会移交（detach）传入的 ArrayBuffer，抽取之后再算哈希就是空壳。
    const sourceHash = sourceHashOf(bytes);
    const docId = docIdOf(sourceHash);
    const parsed = await parseResumeSource(bytes, docId, nowMs);

    if (parsed.status === 'failed') {
      throw new AppError('RESUME_IMPORT_FAILED', `这份文件读不出内容：${parsed.reason}`, undefined, {
        code: parsed.code,
        sourceHash,
      });
    }
    if (parsed.status === 'too-short') {
      return this.persist({
        docId,
        sourceHash,
        format: parsed.format,
        status: 'scanned',
        textLength: parsed.textLength,
        document: null,
        issues: parsed.issues,
        nowMs,
      });
    }
    return this.persist({
      docId,
      sourceHash,
      format: parsed.format,
      status: 'imported',
      textLength: parsed.textLength,
      document: parsed.document,
      issues: parsed.issues,
      nowMs,
    });
  }

  /**
   * 列出所有还带着未处理条目的导入记录（4.1-04 的「待确认清单」）。
   * @returns 按更新时间倒序的记录；没有待确认项的文件不出现
   */
  pending(): readonly PendingImportView[] {
    const rows = this.store.db
      .prepare(
        `SELECT doc_id, source_hash, format, status, text_length, issues_json, updated_at
                  FROM resume_imports
                 WHERE issues_json <> '[]'
                 ORDER BY updated_at DESC`,
      )
      .all() as unknown as readonly ResumeImportRow[];
    return rows.map((row) => ({
      docId: row.doc_id,
      sourceHash: row.source_hash,
      format: row.format as ResumeSourceFormat,
      status: row.status as ImportStatus,
      textLength: Number(row.text_length),
      updatedAt: Number(row.updated_at),
      issues: JSON.parse(row.issues_json) as ParseIssue[],
    }));
  }

  /**
   * 读文件并卡住字节上限。
   * @param filePath 绝对路径
   * @returns 文件字节；调用方拿到的是副本，交给三方库前无需再复制
   */
  private readBounded(filePath: string): Uint8Array {
    if (!isAbsolute(filePath)) {
      throw new AppError('RESUME_IMPORT_FAILED', '简历路径必须是绝对路径');
    }
    if (!existsSync(filePath)) {
      throw new AppError('RESUME_IMPORT_FAILED', `没有找到这个文件：${filePath}`);
    }
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      throw new AppError('RESUME_IMPORT_FAILED', `这不是一个文件：${filePath}`);
    }
    if (stat.size > this.options.maxBytes) {
      throw new AppError(
        'RESUME_IMPORT_FAILED',
        `这份文件 ${String(stat.size)} 字节，超过上限 ${String(this.options.maxBytes)} 字节`,
      );
    }
    return new Uint8Array(readFileSync(filePath));
  }

  /**
   * 按来源哈希幂等落库并给出回执。
   *
   * 只存**已脱敏**的文档与条目（脱敏发生在 `parseResumeText` 之前，库里不可能落原始手机号 / 邮箱），
   * 日志也只落哈希与计数，不落正文（4.1-09 与 §8.5）。
   * @returns 带 `isNew` 的回执
   */
  private persist(input: {
    docId: string;
    sourceHash: string;
    format: ResumeSourceFormat;
    status: ImportStatus;
    textLength: number;
    document: ResumeDocument | null;
    issues: readonly ParseIssue[];
    nowMs: number;
  }): ImportReceipt {
    const db = this.store.db;
    const existing = db.prepare('SELECT doc_id FROM resume_imports WHERE source_hash = ?').get(input.sourceHash) as
      { doc_id: string } | undefined;
    const docJson = JSON.stringify(input.document ?? null);
    const issuesJson = JSON.stringify(input.issues);
    db.prepare(
      `INSERT INTO resume_imports (doc_id, source_hash, format, status, text_length, doc_json, issues_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_hash) DO UPDATE SET format = excluded.format, status = excluded.status,
         text_length = excluded.text_length, doc_json = excluded.doc_json,
         issues_json = excluded.issues_json, updated_at = excluded.updated_at`,
    ).run(
      input.docId,
      input.sourceHash,
      input.format,
      input.status,
      input.textLength,
      docJson,
      issuesJson,
      input.nowMs,
      input.nowMs,
    );
    // 工作副本只在「还没有」时建：重复导入按 4.1-07 的语义只刷新出处与时间，绝不能把用户已经改过的
    // 简历冲掉——那份改动属于 `resume_docs`，本表只是出处。
    if (input.document !== null && this.docStore.load(input.docId).status === 'missing') {
      this.docStore.save(input.document);
    }
    this.ctx.logger.info(
      `[resume-parse] ${existing === undefined ? '新建' : '覆盖'} ${input.docId}（来源 ${input.sourceHash.slice(0, 12)}，` +
        `${input.format} / ${String(input.textLength)} 字 / ${String(input.issues.length)} 条待确认）`,
    );
    return {
      status: input.status,
      docId: input.docId,
      sourceHash: input.sourceHash,
      format: input.format,
      isNew: existing === undefined,
      textLength: input.textLength,
      sections: summarizeSections(input.document),
      issues: input.issues,
    };
  }
}

/** 把文档压成「区块 → 条目数」的读数，避免整份 JSON 过进程边界。 */
function summarizeSections(
  document: ResumeDocument | null,
): readonly { kind: string; title: string; entries: number }[] {
  if (document === null) return [];
  return document.sections.map((section) => ({
    kind: section.kind,
    title: section.title,
    entries: section.entries.length,
  }));
}

declare module '@auto-cc/core' {
  interface AppServices {
    'resume.parse': ResumeParseService;
  }
}
