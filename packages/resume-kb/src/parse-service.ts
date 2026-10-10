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
 * 但「绝对路径 + 字节上限 + 读出字节」这一小段是同一条逻辑，3.5-a 的编辑轨是它的第二回使用，
 * 所以它已经上收到 `@auto-cc/core/file-read`（§2.2），本层只决定用哪个错误码。
 *
 * 出处（spec 4.1-14 / 裁定㉖）也归这一层记：`resume_imports` 是「哪份文件变成过这份简历」的唯一事实源，
 * 所以人选中的文件名在这里落库、`provenance()` 在这里读，而不是让渲染层自己拼一份"看起来像来路"的东西。
 */
import { AppError, agentTool, asApp, registerAgentTools, Service, toolResult, type Context } from '@auto-cc/core';
import { readBoundedFile } from '@auto-cc/core/file-read';
import type { ResumeDocument } from '@auto-cc/plugin-resume-doc';
import { z } from 'zod';
import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ParseIssue } from './sections.js';
import { type ResumeSourceFormat, parseResumeSource, sourceHashOf } from './source.js';

/** 迁移号段：账本 1 / agent 会话 2 / jobs 3 / workflow run 4 / conversation 5 / consent 6 / resume_docs 7 / resume_snapshots 8 / delivery_records 9，本表取 10（建表）+ 37（补出处列）。 */
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

/**
 * 迁移号段：**37**。号段台账（AGENTS.md §9 的 5.3-a）：36 是 `resume_preferences`、35 是投递记录的
 * `conversation_target`、33 是会话消息的同名列、30 预留给草稿表但未启用，**34 在本工作树读不到但不当空号用**。
 *
 * 这一支只补一列 `source_name`：这张表从前只存来源哈希，于是「这份简历是怎么来的」在界面上永远答不出
 * （spec 4.1-14 / 裁定㉖ 的来路那一问）。**不能把 `ADD COLUMN` 塞进上面那条第 10 版的 `up`**——
 * `runMigrations` 认的是台账里记没记过这一版，第 10 版在老库（含本机开发实例）上早已记过账，改了也不会重跑。
 */
export const RESUME_IMPORT_SOURCE_NAME_MIGRATION_VERSION = 37;

/**
 * 给 `resume_imports` 加出处列。
 * 可空是刻意的：**导入时人选中的那个文件名**只有从这一版起才拿得到，老行留 NULL 是事实而不是缺陷
 * （界面据此显示「没记下文件名」，绝不拿哈希或姓名冒充，见 `provenance()` 的注释）。
 */
const resumeImportSourceNameMigration = {
  version: RESUME_IMPORT_SOURCE_NAME_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec('ALTER TABLE resume_imports ADD COLUMN source_name TEXT');
  },
  down: (db: DatabaseSync) => {
    // SQLite 3.35+ 支持 DROP COLUMN（本机 sqlite 3.53.4）；回退就是把出处读数打回全 NULL。
    db.exec('ALTER TABLE resume_imports DROP COLUMN source_name');
  },
};

/** `resume.parse` 的可调项。 */
export const resumeParseSchema = z.strictObject({
  /** 单次导入的字节上限，与 `outbound.deliver` 的简历上限同量级，防止误选大文件把主进程吃掉。 */
  maxBytes: z.number().int().min(1024).max(52_428_800).default(5_242_880),
});

export type ResumeParseConfig = z.output<typeof resumeParseSchema>;

/**
 * `resume.parse.fromFile` 的工具入参（spec 5.1-07 的建档腿）。
 *
 * 只有 `filePath` 一个键，且刻意收成非空串就停：绝对路径、存在性、字节上限、格式识别全都由
 * `fromFile()` 自己判（它已经为此抛 `RESUME_IMPORT_FAILED`）。在这里再写一遍 `refine` 等于同一
 * 校验两处判、两处报的是不同错误码（§2.5）；而 `nowMs` 不进声明是 4.1 既定的口径——入库时间只能由
 * 服务取，让模型自己填就等于让它决定"这份简历是哪天导入的"。
 */
export const resumeParseRequestSchema = z.strictObject({
  filePath: z.string().min(1),
});

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
  /** 导入时人选中的文件名；第 37 版之前的老行为 null（当时没记），界面如实显示而不是猜。 */
  readonly sourceName: string | null;
}

/**
 * 一份导入的**来路**读数（spec 4.1-14 / 裁定㉖ 的「候选列表里每个一行小字」的数据源）。
 *
 * 与 `PendingImportView` 刻意不同形状：那一条是"待确认"的清单行，带 issues；
 * 这一条只回答"它从哪来、什么时候来的、当时是什么格式、读进来多少字"，所以它必须覆盖**全部**导入行
 * （一份解析得干干净净的简历同样有来路）。
 */
export interface ImportProvenanceView {
  readonly docId: string;
  /** 导入时人选中的文件名；老行为 null。 */
  readonly sourceName: string | null;
  readonly format: ResumeSourceFormat;
  readonly status: ImportStatus;
  /** 那次导入落库的时刻（毫秒）——是「导入于何时」，不是「简历最后改动于何时」。 */
  readonly importedAt: number;
  /**
   * 那次导入读到的字数（裁定㉖ 第 3 条那句「读到 N 字」的唯一来源）。
   * 界面不许拿正文自己数（§2.5），也不许拿这一格去回答"简历有多长"——它是**导入当时**的读数。
   */
  readonly textLength: number;
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
  readonly source_name: string | null;
}

/** 由来源哈希直接推出文档 id：同一份文件重复导入必然落到同一个 id，不产生第二套实体。 */
function docIdOf(sourceHash: string): string {
  return `resume-${sourceHash.slice(0, 12)}`;
}

/**
 * 把 `resume_imports` 的一行转成界面读数（待确认清单与按哈希回看共用，§2.2 只此一份映射）。
 * @param row 库里的原始行（`bigint` 列在这里统一收成 number）
 * @returns 不含正文的记录视图
 */
function toPendingView(row: ResumeImportRow): PendingImportView {
  return {
    docId: row.doc_id,
    sourceHash: row.source_hash,
    format: row.format as ResumeSourceFormat,
    status: row.status as ImportStatus,
    textLength: Number(row.text_length),
    updatedAt: Number(row.updated_at),
    issues: JSON.parse(row.issues_json) as ParseIssue[],
    sourceName: row.source_name,
  };
}

/**
 * 把 `resume_imports` 的一行转成来路读数。
 * @param row 库里的原始行
 * @returns 不含正文与 issues 的出处视图
 */
function toProvenanceView(
  row: Pick<ResumeImportRow, 'doc_id' | 'format' | 'status' | 'updated_at' | 'source_name' | 'text_length'>,
): ImportProvenanceView {
  return {
    docId: row.doc_id,
    sourceName: row.source_name,
    format: row.format as ResumeSourceFormat,
    status: row.status as ImportStatus,
    importedAt: Number(row.updated_at),
    textLength: Number(row.text_length),
  };
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
    for (const migration of [resumeImportMigration, resumeImportSourceNameMigration]) {
      if (!migrations.some((item) => item.version === migration.version)) {
        migrations.push(migration);
      }
    }
    this.store.upgrade();
  }

  [Service.init](): void {
    this.ensureSchema();
    // 5.1-c 的建档腿：登记只转发 `fromFile`，判定与入库都在那一条路上（§5.9 双入口共用一条业务链，
    // 工具面不构成第二条导入通道）。注册表是软取（agent 可单独摘掉），没装时这里返回 0 并如实进日志。
    const tools = registerAgentTools(this.ctx, [
      agentTool({
        id: 'resume.parse.fromFile',
        titleKey: 'agent.tool.labels.parseFromFile',
        description:
          '把磁盘上的一份简历文件（pdf / docx / md / txt）导入知识库：抽正文、解析成可编辑的简历工作副本、按来源哈希幂等入库，并把解析里没把握的条目落成待确认清单。同一份文件重复导入只会落到同一个文档 id，不会产生第二套实体。只读用户给出的那一个绝对路径、只往本地库里写，不出网、不做任何外发；文本过短（疑似扫描件）时不产文档，只回一条 scanned 读数与原因',
        input: resumeParseRequestSchema,
        // `local-write`：写 `resume_imports` 与 `resume.doc` 的工作副本，一条网络请求都不发。
        // 需要批准是因为入参是一条任意本地路径、产物是简历库的工作副本——这两样都不该被对话静默做掉
        // （与 `resume.generate.run` 同一口径：不是外发，所以不占额度闸门，但也不是无人看一眼就落库）。
        effect: 'local-write',
        requiresConfirmation: true,
        // 「新建档」与「同哈希命中既有档」是两件不同的事（4.1-07 的幂等判据），摘要必须分开说；
        // 引用给文档 id 与来源哈希，界面无需再读正文就能对上是哪一份。
        run: async ({ filePath }) => {
          const receipt = await this.fromFile(filePath);
          return toolResult(receipt, {
            summary:
              `${receipt.isNew ? '已建档' : '同一哈希命中既有档'}：${receipt.docId}` +
              `（${receipt.format} · ${String(receipt.textLength)} 字 · ${String(receipt.sections.length)} 个区块` +
              `${receipt.status === 'scanned' ? ' · 判定为扫描件，未产文档' : ''}）`,
            evidenceRefs: [`doc:${receipt.docId}`, `hash:${receipt.sourceHash}`],
          });
        },
      }),
    ]);
    this.ctx.logger.info(
      `[resume-parse] resume_imports 表就绪，迁移号段 ${String(RESUME_IMPORT_MIGRATION_VERSION)} + ` +
        `${String(RESUME_IMPORT_SOURCE_NAME_MIGRATION_VERSION)}，单次上限 ${String(this.options.maxBytes)} 字节` +
        ` · agent 工具登记 ${String(tools)} 个${tools === 0 ? '（注册表未挂载）' : ''}`,
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
    const bytes = readBoundedFile(filePath, { maxBytes: this.options.maxBytes, code: 'RESUME_IMPORT_FAILED' });
    // 顺序是硬约束：pdf.js 会移交（detach）传入的 ArrayBuffer，抽取之后再算哈希就是空壳。
    const sourceHash = sourceHashOf(bytes);
    const docId = docIdOf(sourceHash);
    // 只记**文件名**，不记整条路径（§8.5 的默认脱敏：目录结构是"这份文件放在我哪块盘上"，
    // 对简历库的读数没有增益，却会在备份导出与界面里跟人一辈子）。
    const sourceName = basename(filePath);
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
        sourceName,
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
      sourceName,
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
        `SELECT doc_id, source_hash, format, status, text_length, issues_json, updated_at, source_name
                  FROM resume_imports
                 WHERE issues_json <> '[]'
                 ORDER BY updated_at DESC`,
      )
      .all() as unknown as readonly ResumeImportRow[];
    return rows.map(toPendingView);
  }

  /**
   * 列出所有导入过的**来路**（spec 4.1-14 / 裁定㉖：候选列表里每份简历要说清自己从哪来）。
   *
   * 为什么不复用 `pending()`：那一条按 4.1-04 只回"还带着未处理条目"的行，而"这份简历是哪份文件导入的"
   * 对一份解析得干干净净的简历同样成立——把它当出处读数，干净导入的那一行就永远没有来路。
   * 两条回答的是两个问题（待确认 vs 来路），各写一遍是对的；同一问题写两遍才是 §2.5 要拦的那种合并。
   * @returns 按导入时刻倒序的来路；每个 `docId` 至多一条（`doc_id` 由主键 `source_hash` 截出来，1:1）
   */
  provenance(): readonly ImportProvenanceView[] {
    const rows = this.store.db
      .prepare(
        `SELECT doc_id, format, status, updated_at, source_name, text_length
                  FROM resume_imports
                 ORDER BY updated_at DESC`,
      )
      .all() as unknown as readonly Pick<
      ResumeImportRow,
      'doc_id' | 'format' | 'status' | 'updated_at' | 'source_name' | 'text_length'
    >[];
    return rows.map(toProvenanceView);
  }

  /**
   * 按来源哈希定点读一次导入的记录（spec 5.7-02 的 `hash:<sourceHash>` 引用回看）。
   *
   * 为什么按哈希而不是按文档 id：建档那一步交回的两条引用里，`doc:` 指向可编辑的工作副本、
   * `hash:` 指向**那份原始文件的字节指纹**（4.1-07 的幂等键）。两者归两个服务，
   * 在证据口里把哈希截成文档 id 等于把 `docIdOf` 那条规则抄第二份（§2.5）。
   * @param sourceHash 来源文件的 sha256 十六进制串
   * @returns 那一行的读数（与待确认清单同形状）；库里没有返回 `null`
   */
  importOf(sourceHash: string): PendingImportView | null {
    const row = this.store.db
      .prepare(
        `SELECT doc_id, source_hash, format, status, text_length, issues_json, updated_at, source_name
                  FROM resume_imports
                 WHERE source_hash = ? LIMIT 1`,
      )
      .get(sourceHash) as unknown as ResumeImportRow | undefined;
    return row === undefined ? null : toPendingView(row);
  }

  /**
   * 删掉某文档的导入出处行（spec 4.1-14 的删除腿里属于本表的那一段）。
   *
   * **不在这里碰 `resume_docs` / 快照 / 素材**：那几张表各有各的持有者，跨表编排只有一个入口
   * （`kb.profile.removeDoc` 在同一条事务里逐表调用，见 plan 04 §4.7）。本方法只保证一件事——
   * 出处这张表不会留下一条指向已删文档的行。
   * @param docId 文档 id
   * @returns 被删掉的行数（0 是合法结果：手动新建的工作副本从来没导过文件）
   */
  removeForDoc(docId: string): number {
    const result = this.store.db.prepare('DELETE FROM resume_imports WHERE doc_id = ?').run(docId);
    return Number(result.changes);
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
    /** 导入时人选中的文件名（只到文件名，不含目录，§8.5）。 */
    sourceName: string;
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
      `INSERT INTO resume_imports (doc_id, source_hash, format, status, text_length, doc_json, issues_json, created_at, updated_at, source_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_hash) DO UPDATE SET format = excluded.format, status = excluded.status,
         text_length = excluded.text_length, doc_json = excluded.doc_json,
         issues_json = excluded.issues_json, updated_at = excluded.updated_at, source_name = excluded.source_name`,
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
      input.sourceName,
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
