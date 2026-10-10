/**
 * `resume.snapshot` 服务（spec 3.7-01 / 04 / 05）：导出瞬间的文档不可变快照的唯一落点，复用 1.3 的 `store`（不新建连接）。
 *
 * 为什么单独一张表而不塞进 `resume_docs`：`resume_docs` 是「当前工作副本」（一行一份文档、随编辑 UPSERT 覆盖），
 * 而快照是「某一时刻导出了什么的不可变事实」——一次导出记一行、永不覆盖，两者读写语义相反，混在一张表里
 * 要么工作副本被历史污染、要么历史被覆盖丢失。表形状对齐 spec 的 `{snapshotId, docJson, templateId, fontSet, hash, createdAt}`。
 *
 * 「还原结果与原产物 hash 一致」（3.7-04）落在这里：存的是 `normalizeDocument` 后的文档 + `contentHash`，
 * 读回时对 doc_json 重新校验再算一次 hash——于是「这份快照还能不能还原成当初那份合法文档」是被读路径主动确认的事实。
 * hash 复用 3.1-05 那一条，不再造第二个摘要算法（§2.7 禁第二套）。
 *
 * 本服务不认识「投递引用快照」（3.7-02）与「快照 diff 界面」（3.7-03 的渲染部分）：前者是投递域的关联、后者是渲染层的呈现，
 * 都从这张表读，但不该由这张表来做（保持「只管这一张表的读写 + 保留上限」）。
 * 3.7-03 只在本服务加了一个 `diff(from, to)`：它把两份快照各自 `restore` 之后交给 3.1-06 的 `diff()`——
 * 比对算法不在这里重写一遍（§2.2），界面拿到的是同一形状的条目级 + 字段级读数。
 */
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import type { StoreService } from '@auto-cc/plugin-store';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { diff as documentDiff, type DocDiff } from './diff.js';
import type { ResumeDocument } from './model.js';
import { contentHash, normalizeDocument } from './normalize.js';
import { validateDocument } from './schema.js';

/**
 * 迁移号段：**8**（账本 1、agent 会话 2、jobs 3、workflow run 4、conversation_messages 5、consent 6、resume_docs 7）。
 * 撞号是运行期「静默不建表」而非编译错误——`ensureSchema` 的幂等 push 见号已存在就跳过，
 * 于是两个服务抢同一个号时，后挂载的那个表根本没被建，读写得「no such table」。所以占位必须在注释里列全。
 */
export const RESUME_SNAPSHOT_MIGRATION_VERSION = 8;

/**
 * 建 `resume_snapshots` 表：一次导出一行、正文以归一化 JSON 存 TEXT、另存内容 hash 供还原比对。
 * `(doc_id, created_at)` 索引服务两条读路径：按文档列历史、按保留上限裁最旧。
 */
const resumeSnapshotMigration = {
  version: RESUME_SNAPSHOT_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS resume_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      font_set TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      doc_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_resume_snapshots_doc ON resume_snapshots (doc_id, created_at)');
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS resume_snapshots');
  },
};

/**
 * 快照配置：每份文档保留的快照上限（3.7-05 的「可配置上限与清理策略」）。
 * 取「上限」而不是「TTL」：投递追溯关心的是「最近几次投了什么」，按份数裁比按时间裁更符合「不会无限膨胀」这条判据，
 * 且单测能确定性地断言「写了 5 份只留最新 3 份」，不依赖时钟。
 */
export const resumeSnapshotSchema = z.strictObject({
  maxSnapshots: z.number().int().positive().default(20),
});
export type ResumeSnapshotConfig = z.infer<typeof resumeSnapshotSchema>;

/** record 的返回：新快照的 id 与其内容 hash（与 `resume_docs` 那次 save 的回执 hash 同源一致）。 */
export interface SnapshotReceipt {
  snapshotId: string;
  hash: string;
}

/** 一条快照的摘要读数（不含正文，供列表 / 追溯用；正文只在 restore 时按需读回）。 */
export interface SnapshotMeta {
  snapshotId: string;
  docId: string;
  templateId: string;
  fontSet: string;
  hash: string;
  createdAt: number;
}

/** `resume_snapshots` 一行的原始读数（node:sqlite 的整数列可能是 number 或 bigint）。 */
type SnapshotRow = {
  snapshot_id: string | null;
  doc_id: string | null;
  template_id: string | null;
  font_set: string | null;
  content_hash: string | null;
  doc_json: string | null;
  created_at: number | bigint | null;
};

/** restore 的返回三态：命中（可还原的合法文档 + hash）/ 不存在 / 命中但内容已损坏。 */
export type RestoreResult =
  | { status: 'restored'; document: ResumeDocument; hash: string }
  | { status: 'missing' }
  | { status: 'corrupt'; reason: string };

/**
 * 简历导出快照服务。
 */
export class ResumeSnapshotService extends Service {
  static provide = 'resume.snapshot';
  static Config = resumeSnapshotSchema;
  static inject = ['store'];

  private readonly options: ResumeSnapshotConfig;

  constructor(ctx: Context, options: ResumeSnapshotConfig) {
    // 必须接住第二个实参：cordis 递的是校验后的配置（AGENTS.md §9 实测 1.3），`maxSnapshots` 从它取。
    super(ctx, 'resume.snapshot');
    this.options = options;
  }

  private get store(): StoreService {
    return asApp(this.ctx).store;
  }

  private get db(): DatabaseSync {
    return this.store.db;
  }

  /** 幂等地把本表迁移推进共享迁移列表并升级到最新。 */
  private ensureSchema(): void {
    const { migrations } = this.store;
    if (!migrations.some((item) => item.version === RESUME_SNAPSHOT_MIGRATION_VERSION)) {
      migrations.push(resumeSnapshotMigration);
    }
    this.store.upgrade();
  }

  /**
   * 记一份导出快照（spec 3.7-01 由 `resume.export` 在每次成功导出后调用）。
   *
   * 写入前先跑权威校验：非法文档不该进历史表；随后归一化并算 hash（与 `resume_docs.save` 同一条链），
   * 存的是归一化后的 JSON，所以「还原」不依赖写入方当初传的是否规范。写完立即按保留上限裁最旧（3.7-05）。
   * @param doc 导出瞬间的文档（页数已回写）
   * @param templateId 本次导出所用模板 id
   * @param fontSet 本次导出所用字体集标识（`resumePrint.fontSet`）
   * @param createdAt 快照时间戳（毫秒），由调用方注入以保持可测的确定性
   * @returns 新快照 id 与其内容 hash
   * @throws AppError(`INVALID_ARGUMENT`) 源文档未通过权威校验
   */
  record = (doc: ResumeDocument, templateId: string, fontSet: string, createdAt: number): SnapshotReceipt => {
    const validated = validateDocument(doc);
    if (!validated.ok) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `快照源文档未通过校验：${validated.issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}`,
      );
    }
    const normalized = normalizeDocument(validated.document);
    const hash = contentHash(normalized);
    const snapshotId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO resume_snapshots (snapshot_id, doc_id, template_id, font_set, content_hash, doc_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(snapshotId, normalized.id, templateId, fontSet, hash, JSON.stringify(normalized), createdAt);
    this.prune(normalized.id);
    return { snapshotId, hash };
  };

  /**
   * 把某文档的快照数裁到 `maxSnapshots`：只保留最新的若干条，删除更早的（3.7-05）。
   * 「最新」以 `created_at` 为准，同一毫秒写入的再按插入序（`rowid`）分先后——否则同一刻批量写入会留谁不确定。
   * @param docId 被裁剪的文档 id（不同文档各自计数，互不影响）
   */
  private prune(docId: string): void {
    this.db
      .prepare(
        `DELETE FROM resume_snapshots
         WHERE doc_id = ?
           AND snapshot_id NOT IN (
             SELECT snapshot_id FROM resume_snapshots
             WHERE doc_id = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?
           )`,
      )
      .run(docId, docId, this.options.maxSnapshots);
  }

  /**
   * 按快照 id 还原为新工作副本（spec 3.7-04 的「还原结果与原产物 hash 一致」）。
   * @param snapshotId 快照 id
   * @returns restored（合法文档 + 重算 hash）/ missing（无此行）/ corrupt（有行但 JSON 解析失败或校验不过，附原因）
   */
  restore = (snapshotId: string): RestoreResult => {
    const row = this.db
      .prepare('SELECT doc_json, content_hash FROM resume_snapshots WHERE snapshot_id = ?')
      .get(snapshotId) as { doc_json: string | null; content_hash: string | null } | undefined;
    if (!row || row.doc_json === null) return { status: 'missing' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.doc_json);
    } catch (error) {
      return { status: 'corrupt', reason: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
    }
    const validated = validateDocument(parsed);
    if (!validated.ok) {
      return { status: 'corrupt', reason: `还原校验失败：${validated.issues.map((issue) => issue.path).join('、')}` };
    }
    return { status: 'restored', document: validated.document, hash: contentHash(validated.document) };
  };

  /**
   * 比对两份快照的内容差异（spec 3.7-03 的数据半边，界面直接摆这个读数）。
   *
   * 不重写比对：两侧各走一次已有的 `restore`（含权威校验），再交给 3.1-06 的 `diff()`——
   * 于是「条目级 + 字段级」的口径与 3.1-06 完全一致，界面不存在第二套判据（§2.2 / §2.7）。
   * @param fromSnapshotId 基线快照 id（界面上的「起点」）
   * @param toSnapshotId 对照快照 id（界面上的「终点」）
   * @returns 结构化差异（只列有变化的区块 / 条目 / 字段；两版一致时 `isEmpty` 为 true）
   * @throws AppError(`INVALID_ARGUMENT`) 任一侧查无此快照，或快照行存在但内容已损坏（附原因）
   */
  diff = (fromSnapshotId: string, toSnapshotId: string): DocDiff =>
    documentDiff(this.requireRestorable(fromSnapshotId, '起点'), this.requireRestorable(toSnapshotId, '终点'));

  /**
   * 取回某快照指向的合法文档，取不回来就说得出一句人话（`diff` 的前置，不改变 `restore` 的三态语义）。
   * @param snapshotId 快照 id
   * @param role 出现在错误文案里的角色名（「起点」/「终点」），让界面能指出是哪一侧失败了
   * @returns 可继续比对的文档
   * @throws AppError(`INVALID_ARGUMENT`) 快照不存在或已损坏
   */
  private requireRestorable(snapshotId: string, role: '起点' | '终点'): ResumeDocument {
    const result = this.restore(snapshotId);
    if (result.status === 'restored') return result.document;
    throw new AppError(
      'INVALID_ARGUMENT',
      `快照${role}读不回合法文档：${snapshotId}${result.status === 'corrupt' ? `（${result.reason}）` : '（查无此快照）'}`,
    );
  }

  /**
   * 列出某文档的历史快照（最新的在前），只回摘要不回正文。
   * @param docId 文档 id
   * @returns 快照摘要数组；无历史时为空数组
   */
  list = (docId: string): SnapshotMeta[] => {
    const rows = this.db
      .prepare(
        `SELECT snapshot_id, doc_id, template_id, font_set, content_hash, created_at
         FROM resume_snapshots WHERE doc_id = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(docId) as SnapshotRow[];
    return rows.map((row) => ({
      snapshotId: String(row.snapshot_id),
      docId: String(row.doc_id),
      templateId: String(row.template_id),
      fontSet: String(row.font_set),
      hash: String(row.content_hash),
      createdAt: Number(row.created_at),
    }));
  };

  /**
   * 按快照 id 定点读那一行的元数据（spec 5.7-02 的 `snapshot:<id>` 引用回看）。
   *
   * 只回元数据不回正文：正文经 `restore()` 读，而那是「把工作副本换回去」那一步的手，
   * 证据回看不该顺手改任何东西（与 `doc-store.listIds` 同一口径——不另开一条捞全文的通道）。
   * @param snapshotId 快照 id（投递回执里 `snapshot:` 后面那一段）
   * @returns 那一行的元数据；库里没有返回 `null`（引用可能来自定位器的一次内存快照，那本来就不落库）
   */
  meta = (snapshotId: string): SnapshotMeta | null => {
    const row = this.db
      .prepare(
        `SELECT snapshot_id, doc_id, template_id, font_set, content_hash, created_at
         FROM resume_snapshots WHERE snapshot_id = ? LIMIT 1`,
      )
      .get(snapshotId) as unknown as SnapshotRow | undefined;
    if (row === undefined) return null;
    return {
      snapshotId: String(row.snapshot_id),
      docId: String(row.doc_id),
      templateId: String(row.template_id),
      fontSet: String(row.font_set),
      hash: String(row.content_hash),
      createdAt: Number(row.created_at),
    };
  };

  /**
   * 删掉某文档的**全部**快照历史（spec 4.1-14：版本历史是这份文档的，删简历就该把它一起带走）。
   *
   * 与 `prune` 的区别是刻意的：那条按 `maxSnapshots` 留下最新的几份，这一条一份都不留——
   * 「保留上限」管的是同一份简历反复导出把表撑大，不管「这份简历已经不存在」这种情形。
   * @param docId 文档 id
   * @returns 被删掉的快照行数（0 是合法结果：从没导出过的简历没有历史）
   */
  removeAllForDoc = (docId: string): number =>
    Number(this.db.prepare('DELETE FROM resume_snapshots WHERE doc_id = ?').run(docId).changes);

  [Service.init](): void {
    this.ensureSchema();
    this.ctx.logger.info(
      `[resume-snapshot] resume_snapshots 表就绪，迁移号段 ${String(RESUME_SNAPSHOT_MIGRATION_VERSION)}，` +
        `每份文档保留上限 ${String(this.options.maxSnapshots)} 个快照`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'resume.snapshot': ResumeSnapshotService;
  }
}
