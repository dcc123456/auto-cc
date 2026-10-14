/**
 * `resume.doc` 服务（spec 3.1-08）：简历文档 JSON 的唯一落点，复用 1.3 的 `store`（不新建连接）。
 *
 * 为什么这一片就要落库：3.1-08 要「文档 JSON 可安全往返存储」，而「往返」只有在真的写进 node:sqlite、
 * 再读回来重新校验时才验得出来——内存里自存自取证明不了解析 / 序列化不丢信息。
 * 存的是**归一化后**的文档 + 它的内容 hash（3.1-05 的 hash 复用在这里），读回时再跑一遍 Schema 校验，
 * 于是「库里那行是不是还能当合法文档用」成了一个被读路径主动确认的事实，而不是写入时的信任。
 *
 * 表只放文档本体；版本快照（3.7）与投递引用另立表，本服务不认识它们，保持「只管这一张表的读写」。
 * 母版与每 JD 变体（裁定㉜ / spec 4.11）同存这张表：变体就是一份完整文档，差别只在 `parent_doc_id` /
 * `jd_id` 两列血缘，因此没有第二张正文表、也没有第二条正文读取通道（§2.7）。
 */
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import type { StoreService } from '@auto-cc/plugin-store';
import { randomUUID } from 'node:crypto';
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
 * 迁移号段：**39**。号段台账（AGENTS.md §9 的 5.3-a）：36 是 `resume_preferences`、
 * 37 是 `resume_imports.source_name`、38 是 `resume_skill_override`、35 是投递记录的 `conversation_target`、
 * 33 是会话消息的同名列、30 预留给草稿表但未启用，**34 在本工作树读不到但不当空号用**。
 *
 * 这一支只给 `resume_docs` 加两列血缘（spec 4.11-13 / 裁定㉜「母版 + 每 JD 一份变体」）。
 * 为什么加列而不另立一张表：变体装的就是**一份完整文档**，正文、hash、复验走的都是同一套通道，
 * 另立一张表等于造第二条正文出口（§2.7）；于是母版与变体在存储上的全部差别就是这两列。
 * 两列都可空且缺省 NULL——母版本来就没有来路，老库升级后库里每一份简历都仍是母版。
 */
export const RESUME_DOC_VARIANT_MIGRATION_VERSION = 39;

/** 给 `resume_docs` 加变体血缘列（`down` 反着序，先摘子再摘父列，与建列无关于可读性）。 */
const resumeDocVariantMigration = {
  version: RESUME_DOC_VARIANT_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec('ALTER TABLE resume_docs ADD COLUMN parent_doc_id TEXT');
    db.exec('ALTER TABLE resume_docs ADD COLUMN jd_id TEXT');
  },
  down: (db: DatabaseSync) => {
    // SQLite 3.35+ 支持 DROP COLUMN（本机 sqlite 3.53.4）；回退就是把血缘读数打回全 NULL。
    db.exec('ALTER TABLE resume_docs DROP COLUMN jd_id');
    db.exec('ALTER TABLE resume_docs DROP COLUMN parent_doc_id');
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
  /** 母版 id；这一行本身是母版时为 null（界面据此把列表分成「母版 / 变体」两组，裁定㉜）。 */
  parentDocId: string | null;
  /** 生成这一支变体时那段 JD 的 id；无归因的变体与母版一样是 null。 */
  jdId: string | null;
}

/**
 * `deriveVariant` 的读数：落成哪一行、内容 hash、以及这一趟是不是新建了行。
 *
 * `created` 不是给界面看的装饰，是给**调用方**分辨两种结局的：新建那一趟变体逐字等于母版
 * （什么都没改），覆盖那一趟则可能把上一次采纳的结果换掉——界面上"这一份 JD 的简历更新了"
 * 与"新建了这一份 JD 的简历"是两句话（spec 4.11-16）。
 */
export interface DeriveVariantResult {
  docId: string;
  hash: string;
  created: boolean;
}

/**
 * 变体行的 id（`resume-` + 12 位十六进制，与 `resume.parse` 那侧的导入 id 同形）。
 *
 * 取随机而不是取 `hash(母版 + JD)`：行属于哪一对由血缘两列说了算（`findVariantId` 那条查询），
 * id 里再编一次同一件事就成了第二个事实来源——两边哪天不一致（改列名、改算法）就查不到已有那一行，
 * 于是每次派生长出新行。前缀沿用 `resume-` 是因为界面的 `data-doc-id` 与老库读数都按这个形状认。
 * @returns 新变体行的 id
 */
function newDocId(): string {
  return `resume-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
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

  /** 幂等地把本表的两支迁移（正文表 7 + 偏好键值表 36）与变体血缘列 39 推进共享迁移列表并升级到最新。 */
  private ensureSchema(): void {
    const { migrations } = this.store;
    if (!migrations.some((item) => item.version === RESUME_DOC_MIGRATION_VERSION)) {
      migrations.push(resumeDocMigration);
    }
    if (!migrations.some((item) => item.version === RESUME_PREFERENCE_MIGRATION_VERSION)) {
      migrations.push(resumePreferenceMigration);
    }
    if (!migrations.some((item) => item.version === RESUME_DOC_VARIANT_MIGRATION_VERSION)) {
      migrations.push(resumeDocVariantMigration);
    }
    this.store.upgrade();
  }

  /**
   * 保存（新增或覆盖）一份简历文档。
   *
   * 写入前先跑权威校验：非法文档根本不该进库，直接以结构化错误挡下（而不是写坏行再指望读回发现）。
   * UPSERT 只写正文那四列，**血缘两列（`parent_doc_id` / `jd_id`）一字不碰**：变体被整屏编辑页改一次
   * 之后仍然挂在那支母版、那一段 JD 下面（spec 4.11-19），而新建行的血缘只有 `deriveVariant` 一个口（4.11-14）。
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
   * 查一支变体的行 id：同一母版 + 同一段 JD 只认一行（spec 4.11-14 的幂等半边）。
   *
   * `jd_id IS ?` 而不是 `=` 是刻意的：无归因的那一支（`jdId` 为 null）用 `=` 比永远为假，
   * 于是每次派生都长出一行新变体，界面按 JD 排开后全是同一份简历的副本。
   * @param parentDocId 母版 id
   * @param jdId 生成它的那段 JD 的 id，null 也照样参与比较
   * @returns 已存在的变体行 id；这对 (母版, JD) 从没派生过时 null
   */
  findVariantId = (parentDocId: string, jdId: string | null): string | null => {
    const row = this.db
      .prepare('SELECT id FROM resume_docs WHERE parent_doc_id = ? AND jd_id IS ? ORDER BY id LIMIT 1')
      .get(parentDocId, jdId) as { id: string } | undefined;
    return row?.id ?? null;
  };

  /**
   * 把一份文档落成「(母版, JD) 那一支变体」——全仓**唯一**的新行入口（spec 4.11-14 / 裁定㉜）。
   *
   * 为什么必须有这一个口，而不是让调用方自己换一个 id 去 `save`：变体的身份由血缘决定
   * （同一支母版 + 同一段 JD 永远落在同一行上），所以"查已有 / mint 新 id / 写血缘 / 覆盖正文"
   * 四步必须绑在一起发生。分开写就会出现第二种结局：两个调用点各自造一支同 JD 的变体，
   * 界面上长出两行、删一删不干净，而"只改 JD 就能生成不同简历"这句话就没有落地对象了。
   * 已有变体时**整份覆盖正文、血缘列一字不动**——再按同一段 JD 生成一次是更新那一份，不是长出新的一份。
   * @param input.parentDocId 母版 id（必须已存在**且它自己不是变体**：血缘只许一层）
   * @param input.jdId 生成它的那段 JD 的 id；null 表示无归因（界面显示「未标明 JD」，不拿哈希冒充）
   * @param input.document 要装进变体的文档；它的 `id` 在这里被换成变体 id，其余字段原样落库
   * @param input.nowMs 变体行的 `updatedAt`（毫秒），由调用方给，避免同一份改动在两处各取一次时钟
   * @returns 变体行的 id、落库后的内容 hash、以及这一趟是否新建了行
   * @throws AppError(`INVALID_ARGUMENT`) 母版不存在 / 母版本身是变体（第二层血缘），或文档未通过 `save` 那侧的权威校验
   */
  deriveVariant = (input: {
    parentDocId: string;
    jdId: string | null;
    document: ResumeDocument;
    nowMs: number;
  }): DeriveVariantResult => {
    const parent = this.db
      .prepare('SELECT parent_doc_id AS parentDocId FROM resume_docs WHERE id = ?')
      .get(input.parentDocId) as { parentDocId: string | null } | undefined;
    if (parent === undefined) {
      throw new AppError('INVALID_ARGUMENT', `母版 ${input.parentDocId} 不存在，派不出变体：先导入或新建一份简历`);
    }
    // 血缘只许一层。变体再生变体在形状上毫无限制，在读数上是灾难：界面排不出"这一份是谁的定制结果"，
    // 而删掉最上面那一支时，下面那支的来路就指向一个不存在的行（这张表的 DDL 没有外键子句，级联不会被声明出来）。
    if (parent.parentDocId !== null) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `${input.parentDocId} 本身是变体（母版 ${String(parent.parentDocId)}）：变体不再往下派生`,
      );
    }
    const existingId = this.findVariantId(input.parentDocId, input.jdId);
    const docId = existingId ?? newDocId();
    const doc: ResumeDocument = { ...input.document, id: docId, updatedAt: input.nowMs };
    // 已派生过：只覆盖正文（`save` 的 UPSERT 不碰血缘列），界面读到的还是那一行、那一段 JD。
    if (existingId !== null) return { docId, hash: this.save(doc).hash, created: false };
    // 新建那一趟要把正文与血缘一起落：`save` 只认正文（它服务五条既有调用点，不认识血缘），
    // 血缘只在这一个口里写，所以两条语句必须同成同败：崩溃在中间会留下一行"正文是变体、血缘是 NULL"的假母版。
    this.db.exec('BEGIN');
    try {
      const saved = this.save(doc);
      this.db
        .prepare('UPDATE resume_docs SET parent_doc_id = ?, jd_id = ? WHERE id = ?')
        .run(input.parentDocId, input.jdId, docId);
      this.db.exec('COMMIT');
      return { docId, hash: saved.hash, created: true };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
   * 删掉一份简历的工作副本行（spec 4.1-14 的删除通道里属于本表的那一段）。
   *
   * **只管这张表**：跨六张表的原子删除只有一个入口（`kb.profile.removeDoc`，plan 04 §4.7 的事实②——
   * 包依赖单向 kb→doc，本服务够不到 `kb_*` 那三张表），所以快照、出处、素材都由编排方在事务里逐个删。
   * @param id 文档 id
   * @returns 真的删掉了一行返回 true；本来就没有返回 false——调用点的语义是「让它不存在」，不是「删掉一行」
   */
  remove = (id: string): boolean => {
    return Number(this.db.prepare('DELETE FROM resume_docs WHERE id = ?').run(id).changes) > 0;
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
   * 列出库里每一份有正文的简历的**摘要**（id / 姓名 / 最后改动时刻 / 血缘），按最近改动排前面。
   *
   * 为什么只回摘要不回正文：界面要的是「定制哪一份」这一栏的候选，而不是原文——原文的唯一读取通道
   * 仍是带 Schema 复验的 `load()`（plan §1.4 裁定一），这里开第二条正文出口就等于绕过它。
   * 姓名用 `json_extract` 在 SQL 里取，因此不必把每份 `doc_json` 反序列化一遍。
   * 血缘两列一并回（spec 4.11-16 的分组半边）：界面要把同一支母版生出的若干变体排到它下面，
   * 而"这行是谁生的"只有这两列说了算，让界面自己按 id 前缀猜就等于没有这条事实。
   * @returns 摘要列表；空库返回空数组，不抛错
   */
  list = (): ResumeDocSummary[] => {
    const rows = this.db
      .prepare(
        `SELECT id, updated_at AS updatedAt, json_extract(doc_json, '$.profile.name') AS name,
                parent_doc_id AS parentDocId, jd_id AS jdId
         FROM resume_docs WHERE doc_json IS NOT NULL ORDER BY updated_at DESC, id`,
      )
      .all() as unknown as readonly {
      id: string;
      updatedAt: number | bigint;
      name: string | null;
      parentDocId: string | null;
      jdId: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      updatedAt: Number(row.updatedAt),
      parentDocId: row.parentDocId,
      jdId: row.jdId,
    }));
  };

  [Service.init](): void {
    this.ensureSchema();
    this.ctx.logger.info(
      `[resume-doc] resume_docs 表就绪，迁移号段 ${String(RESUME_DOC_MIGRATION_VERSION)} + ` +
        String(RESUME_DOC_VARIANT_MIGRATION_VERSION) +
        `（变体血缘两列），偏好表 ${String(RESUME_PREFERENCE_MIGRATION_VERSION)}`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'resume.doc': ResumeDocService;
  }
}
