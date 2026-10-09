/**
 * `resume.doc` 服务（spec 3.1-08）：简历文档 JSON 的唯一落点，复用 1.3 的 `store`（不新建连接）。
 *
 * 为什么这一片就要落库：3.1-08 要「文档 JSON 可安全往返存储」，而「往返」只有在真的写进 node:sqlite、
 * 再读回来重新校验时才验得出来——内存里自存自取证明不了解析 / 序列化不丢信息。
 * 存的是**归一化后**的文档 + 它的内容 hash（3.1-05 的 hash 复用在这里），读回时再跑一遍 Schema 校验，
 * 于是「库里那行是不是还能当合法文档用」成了一个被读路径主动确认的事实，而不是写入时的信任。
 *
 * 表只放文档本体；版本快照（3.7）与投递引用另立表，本服务不认识它们，保持「只管这一张表的读写」。
 */
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import type { StoreService } from '@auto-cc/plugin-store';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { ResumeDocument } from './model.js';
import { contentHash, normalizeDocument } from './normalize.js';
import { validateDocument } from './schema.js';

/**
 * 迁移号段：**7**（账本 1、agent 会话 2、jobs 3、workflow run 4、conversation_messages 5、consent 6）。
 * 撞号是运行期「静默不建表」而非编译错误——`ensureSchema` 的幂等 push 见号已存在就跳过，
 * 于是两个服务抢同一个号时，后挂载的那个表根本没被建，读写得「no such table」。所以占位必须在注释里列全。
 */
export const RESUME_DOC_MIGRATION_VERSION = 7;

/** 建 `resume_docs` 表：一文档一行，正文以归一化 JSON 存 TEXT，另存内容 hash 供完整性判断。 */
const resumeDocMigration = {
  version: RESUME_DOC_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS resume_docs (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      doc_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS resume_docs');
  },
};

/**
 * 迁移号段：**36**。
 * 号段台账（AGENTS.md §9 的 5.3-a 那条）：29 之前是各包自有号段，31/32 是提供商池，
 * 33 是 `conversation_target`，35 是投递记录的 `conversation_target`，30 预留给草稿表但未启用；
 * **34 在本工作树读不到但不能当成空号**（并行会话随时可能落地）。所以这张表取 36，不回填 34。
 *
 * 为什么"用哪套模板"必须落库而不能做配置键（AGENTS.md §9 的 5.3-b）：配置层只写内存运行期，
 * 重启即失；而模板选择是人对"我以后生成的简历长什么样"的表态，跨重启仍然算数才是它的全部意义。
 */
export const RESUME_PREFERENCE_MIGRATION_VERSION = 36;

/** 一张键值表：目前只有 `defaultTemplateId` 一支键，后续界面偏好同表追加，不再另立存储（§2.7）。 */
const resumePreferenceMigration = {
  version: RESUME_PREFERENCE_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS resume_preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS resume_preferences');
  },
};

/** 可写的界面偏好键（新增一支键要在这里登记，避免出现第二种取法）。 */
export type ResumePreferenceKey = 'defaultTemplateId';

/** 无配置服务（文档存储不需要运行期配置，配置留空 schema 以走 cordis 的构造器第二参约定）。 */
export const resumeDocSchema = z.strictObject({});
export type ResumeDocConfig = z.infer<typeof resumeDocSchema>;

/** `resume_docs` 一行的原始读数。 */
type DocRow = {
  id: string | null;
  schema_version: number | bigint | null;
  content_hash: string | null;
  doc_json: string | null;
  updated_at: number | bigint | null;
};

/** save 的返回：写入后的内容 hash（供快照 / diff 引用）。 */
export interface SaveResult {
  hash: string;
}

/** load 的返回三态：命中 / 不存在 / 命中但内容已损坏（JSON 或 Schema 校验没过）。 */
export type LoadResult =
  { status: 'found'; document: ResumeDocument } | { status: 'missing' } | { status: 'corrupt'; reason: string };

/** 一份简历的摘要（够界面摆出「定制哪一份」那一栏，不含正文）。 */
export interface ResumeDocSummary {
  id: string;
  /** 文档里的姓名；老库里存坏了或没填姓名时为 null，界面回退到 id。 */
  name: string | null;
  /** 最后改动时刻（毫秒），列表按它倒序排。 */
  updatedAt: number;
}

/**
 * 简历文档存储服务。
 */
export class ResumeDocService extends Service {
  static provide = 'resume.doc';
  static Config = resumeDocSchema;
  static inject = ['store'];

  constructor(ctx: Context, _options: ResumeDocConfig) {
    super(ctx, 'resume.doc');
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
    if (!migrations.some((item) => item.version === RESUME_DOC_MIGRATION_VERSION)) {
      migrations.push(resumeDocMigration);
    }
    if (!migrations.some((item) => item.version === RESUME_PREFERENCE_MIGRATION_VERSION)) {
      migrations.push(resumePreferenceMigration);
    }
    this.store.upgrade();
  }

  /**
   * 保存（新增或覆盖）一份简历文档。
   *
   * 写入前先跑权威校验：非法文档根本不该进库，直接以结构化错误挡下（而不是写坏行再指望读回发现）。
   * @param doc 待保存的文档
   * @returns 落库后的内容 hash
   * @throws AppError(`INVALID_ARGUMENT`) 文档未通过权威校验
   */
  save = (doc: ResumeDocument): SaveResult => {
    const validated = validateDocument(doc);
    if (!validated.ok) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `文档未通过校验：${validated.issues.map((issue) => `${issue.path} ${issue.message}`).join('；')}`,
      );
    }
    const normalized = normalizeDocument(validated.document);
    const hash = contentHash(normalized);
    this.db
      .prepare(
        `INSERT INTO resume_docs (id, schema_version, content_hash, doc_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           schema_version = excluded.schema_version,
           content_hash = excluded.content_hash,
           doc_json = excluded.doc_json,
           updated_at = excluded.updated_at`,
      )
      .run(normalized.id, normalized.schemaVersion, hash, JSON.stringify(normalized), normalized.updatedAt);
    return { hash };
  };

  /**
   * 读一支界面偏好的当前值。
   * @param key 偏好键（目前只有 `defaultTemplateId`）
   * @returns 存过的值；从没存过时返回 null（调用方决定缺省值，库里不塞假默认）
   */
  getPreference = (key: ResumePreferenceKey): string | null => {
    const row = this.db.prepare('SELECT value FROM resume_preferences WHERE key = ?').get(key) as
      { value: string | null } | undefined;
    return row?.value ?? null;
  };

  /**
   * 写一支界面偏好（存在即覆盖）。
   * @param key 偏好键
   * @param value 值（非空串；空串在这里没有语义，直接拒）
   * @param nowMs 落库时刻（毫秒），由调用方给，避免同一份文档的 updated_at 与偏好时刻各取一次时钟
   * @throws AppError(`INVALID_ARGUMENT`) 值为空串
   */
  setPreference = (key: ResumePreferenceKey, value: string, nowMs: number): void => {
    if (value === '') throw new AppError('INVALID_ARGUMENT', `偏好「${key}」的值不能是空串`);
    this.db
      .prepare(
        `INSERT INTO resume_preferences (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, nowMs);
  };

  /**
   * 按 id 读回一份文档，读回时重新校验（3.1-08 的「安全往返」判据落在这里）。
   * @param id 文档 id
   * @returns found（合法文档）/ missing（无此行）/ corrupt（有行但 JSON 解析失败或校验不过，附原因）
   */
  load = (id: string): LoadResult => {
    const row = this.db
      .prepare('SELECT id, schema_version, content_hash, doc_json, updated_at FROM resume_docs WHERE id = ?')
      .get(id) as DocRow | undefined;
    if (!row || row.doc_json === null) return { status: 'missing' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.doc_json);
    } catch (error) {
      return { status: 'corrupt', reason: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
    }
    const validated = validateDocument(parsed);
    if (!validated.ok) {
      return { status: 'corrupt', reason: `读回校验失败：${validated.issues.map((issue) => issue.path).join('、')}` };
    }
    return { status: 'found', document: validated.document };
  };

  /**
   * 判断某 id 的文档是否存在。
   * @param id 文档 id
   * @returns 存在返回 true
   */
  exists = (id: string): boolean => {
    const row = this.db.prepare('SELECT 1 AS hit FROM resume_docs WHERE id = ?').get(id) as
      { hit?: number | bigint } | undefined;
    return row !== undefined;
  };

  /**
   * 列出库里所有**有正文**的文档 id（升序）。
   *
   * 只回 id 不回正文：全量重建派生索引（4.3-a 的 `kb_chunks` 补建）要遍历一遍库，
   * 但每份正文仍必须逐条经 `load()` 读——那才是带 Schema 复验的唯一通道（plan §1.4 裁定一），
   * 这里开一个「一次把所有 doc_json 捞出来」的口子就等于造了第二条读取通道。
   * `doc_json IS NULL` 的行没有正文，与 `load()` 返回 missing 同一口径，一并跳过。
   * @returns 文档 id 列表；空库返回空数组，不抛错
   */
  listIds = (): readonly string[] => {
    const rows = this.db
      .prepare('SELECT id FROM resume_docs WHERE doc_json IS NOT NULL ORDER BY id')
      .all() as unknown as readonly { id: string }[];
    return rows.map((row) => row.id);
  };

  /**
   * 列出库里每一份有正文的简历的**摘要**（id / 姓名 / 最后改动时刻），按最近改动排前面。
   *
   * 为什么只回摘要不回正文：界面要的是「定制哪一份」这一栏的候选，而不是原文——原文的唯一读取通道
   * 仍是带 Schema 复验的 `load()`（plan §1.4 裁定一），这里开第二条正文出口就等于绕过它。
   * 姓名用 `json_extract` 在 SQL 里取，因此不必把每份 `doc_json` 反序列化一遍。
   * @returns 摘要列表；空库返回空数组，不抛错
   */
  list = (): ResumeDocSummary[] => {
    const rows = this.db
      .prepare(
        `SELECT id, updated_at AS updatedAt, json_extract(doc_json, '$.profile.name') AS name
         FROM resume_docs WHERE doc_json IS NOT NULL ORDER BY updated_at DESC, id`,
      )
      .all() as unknown as readonly { id: string; updatedAt: number | bigint; name: string | null }[];
    return rows.map((row) => ({ id: row.id, name: row.name, updatedAt: Number(row.updatedAt) }));
  };

  [Service.init](): void {
    this.ensureSchema();
    this.ctx.logger.info('[resume-doc] resume_docs 表就绪，迁移号段 ' + String(RESUME_DOC_MIGRATION_VERSION));
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'resume.doc': ResumeDocService;
  }
}
