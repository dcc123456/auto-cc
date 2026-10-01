/**
 * `kb.profile` service（spec 4.2-01 / 4.2-02 / 4.2-03 / 4.2-04 / 4.2-08 + 4.3-11）：
 * 四类知识库实体的建表、派生入库、查询、证据反查、删除、备份，以及检索切片的派生索引表。
 *
 * 这一层只做八件事：把迁移 11 的 `kb_entities` 与迁移 12 的 `kb_chunks` 建出来、从 `resume_docs` 的
 * **当前工作副本**派生实体、按稳定 id 幂等 upsert 并清掉已不存在的派生行、给出界面与后续检索（4.3）
 * 要用的读接口、把一句陈述映射回支撑它的实体（4.2-03，判定在 `evidence.ts`）、本地备份文件的读写
 * （4.2-08，格式在 `backup.ts`）、4.2-05 / 06 需要的两条装配腿（写入后发 `kb/entities-changed` 事件、
 * 把读口 `list` 登记成 agent 工具——裁定三，界面与 agent 走同一个 service，不许各长一套），
 * 以及 4.3-a 的切片收敛：**每一条实体写删都在同一事务里带上它的切片**（4.3-11 的「无孤儿索引行」）。
 * 「文本 → 实体」的判定全在 `entities.ts`，「文本 → 切片」的判定全在 `chunks.ts`（两者都是纯函数，
 * 离线逐条断言），本文件不重复任何解析规则。
 *
 * 为什么读文档要经 `resume.doc` 而不是自己查 `resume_docs` 表：plan §1.4 裁定一把 `resume_docs` 定成
 * 可编辑工作副本的**唯一真相源**，而它的 `load()` 顺带做了 Schema 重新校验——绕过它就是用裸 SQL
 * 造第二条读取通道（AGENTS.md §2.5），库里被改坏的文档将不再被发现。
 */
import { AppError, asApp, Service, agentTool, registerAgentTools, type Context } from '@auto-cc/core';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { ResumeDocument } from '@auto-cc/plugin-resume-doc';
import {
  KB_ENTITY_KINDS,
  type KbEntityDraft,
  type KbEntityKind,
  deriveEntities,
  manualEntityId,
  payloadHashOf,
} from './entities.js';
import { type EvidenceOptions, type EvidenceRef, evidenceTextOf, rankEvidence } from './evidence.js';
import { decodeBackup, encodeBackup } from './backup.js';
import { type KbChunkDraft, type KbChunkView, chunkViewOf, deriveSectionChunks, entityChunkOf } from './chunks.js';

/** 迁移号段：**11 / 12**（账本 1 / agent 会话 2 / jobs 3 / workflow run 4 / conversation 5 / consent 6 /
 *  resume_docs 7 / resume_snapshots 8 / delivery_records 9 / resume_imports 10 / kb_entities 11 / kb_chunks 12）。
 *  撞号的表现是「见号已存在就跳过建表」——表根本没建，读写得到 `no such table`，所以号段必须在注释里列全并被单测断言。 */
export const KB_PROFILE_MIGRATION_VERSION = 11;

/** 检索切片表的迁移号段（spec 4.3-11，plan §4.3 切片拆分的 4.3-a）。 */
export const KB_CHUNKS_MIGRATION_VERSION = 12;

const kbEntitiesMigration = {
  version: KB_PROFILE_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    // 单表 + `kind` 判别（裁定二）：四类实体永远按 kind 过滤，四张表会把级联删除变成四种外键组合各写一遍。
    db.exec(`CREATE TABLE IF NOT EXISTS kb_entities (
      entity_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent_id TEXT,
      source_doc_id TEXT,
      payload_json TEXT NOT NULL,
      normalized_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (entity_id)
    )`);
    // 「这份文档派生出哪些实体」是同步与检索的主查询形态；「按父实体找下属」是级联删除的形态。
    db.exec('CREATE INDEX IF NOT EXISTS idx_kb_entities_doc ON kb_entities (source_doc_id, kind)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_kb_entities_parent ON kb_entities (parent_id)');
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS kb_entities');
  },
};

const kbChunksMigration = {
  version: KB_CHUNKS_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    // 派生索引表，不是第二套真相（plan §4.3 口径 3）：内容全部由 `kb_entities` / 工作副本现算，
    // 任何一次写入都必须在**同一事务**里把它改掉或删除——留一份「重建一下就一致」的余地就够了，
    // 但 4.3-11 的验收判据是「删实体后索引无孤儿行」，所以这里给的是同事务而不是后台修补。
    db.exec(`CREATE TABLE IF NOT EXISTS kb_chunks (
      seq INTEGER PRIMARY KEY,
      chunk_id TEXT NOT NULL UNIQUE,
      chunk_kind TEXT NOT NULL CHECK (chunk_kind IN ('entity', 'section')),
      source_doc_id TEXT,
      section_kind TEXT,
      text TEXT NOT NULL,
      tokens TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    // 4.3-b 的 FTS5 虚表按 `seq` 对齐 rowid，所以 `seq` 必须是显式列（隐式 rowid 会被 VACUUM 重排，
    // 那会让倒排索引指向错误的行——spike 轮次一 Q6 / 轮次三 A 实测过这条维护路径）。
    db.exec('CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks (source_doc_id, chunk_kind)');
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS kb_chunks');
  },
};

/**
 * `kb.profile` 的可调项。
 *
 * 反查（spec 4.2-03）的两个阈值放这里而不是写死在函数里：同 4.3-03 的口径（检索类参数代码内无魔法数），
 * 也因为 4.5 做「JD 要求 → 支撑证据」时要按岗位松紧调它，而那不该是一次发版。
 */
export const kbProfileSchema = z.strictObject({
  /** 一次反查最多返回几条支撑实体。 */
  evidenceTopK: z.number().int().min(1).max(50).default(5),
  /** 低于此匹配强度（0～1）的实体不算支撑——「沾一点边」不等于有证据。 */
  evidenceMinScore: z.number().min(0).max(1).default(0.34),
});
export type KbProfileConfig = z.output<typeof kbProfileSchema>;

/** 一条实体的界面/服务读数（`payload` 已从 JSON 还原）。 */
export interface KbEntityView {
  readonly entityId: string;
  readonly kind: KbEntityKind;
  readonly parentId: string | null;
  readonly sourceDocId: string | null;
  readonly payload: Readonly<Record<string, string>>;
  readonly normalizedHash: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 一次同步的读数（4.2-01 的幂等断言点：第二次同步三项计数应为 0 / 0 / 0）。 */
export interface KbSyncResult {
  readonly docId: string;
  readonly created: number;
  readonly updated: number;
  readonly removed: number;
}

/** 手工新建实体的入参。 */
export interface KbCreateInput {
  readonly kind: KbEntityKind;
  readonly payload: Readonly<Record<string, string>>;
  readonly parentId?: string | null;
}

/** 一次删除的读数（4.2-04 的断言点：删一条要同时知道有多少下属被解除归属）。 */
export interface KbRemoveResult {
  readonly entityId: string;
  /** 被删掉的行数——本方法只删手工实体，恒为 1，保留计数是为了让断言不依赖「应该是一条」。 */
  readonly removed: number;
  /** 被解除归属（`parent_id` 置空）的下属行数。 */
  readonly detached: number;
}

/** 一次备份导出的读数。 */
export interface KbExportResult {
  readonly filePath: string;
  /** 写进文件的实体条数。 */
  readonly exported: number;
}

/**
 * 导入时的冲突策略（4.2-08）。
 * - `skip`：库里已有同 id 就保留库内的那条（默认——恢复备份不该静默盖掉用户这几周的手工修改）
 * - `overwrite`：以文件为准覆盖
 */
export type KbImportMode = 'skip' | 'overwrite';

/** 一次导入的读数。 */
export interface KbImportResult {
  readonly filePath: string;
  /** 文件里的总条数。 */
  readonly total: number;
  /** 库里原本没有、这次新建的条数。 */
  readonly created: number;
  /** `overwrite` 模式下被文件覆盖掉的条数。 */
  readonly overwritten: number;
  /** `skip` 模式下保留库内原值、没有写入的条数。 */
  readonly skipped: number;
  /** 归属指向库外且不在这份文件里的条数——按 4.2-04 的策略解除归属而不是留下悬空引用。 */
  readonly danglingParents: number;
}

interface KbEntityRow {
  readonly entity_id: string;
  readonly kind: string;
  readonly parent_id: string | null;
  readonly source_doc_id: string | null;
  readonly payload_json: string;
  readonly normalized_hash: string;
  readonly created_at: number | bigint;
  readonly updated_at: number | bigint;
}

/** 行 → 视图。`kind` 的窄化是有意的：库里只有派生与 `create` 两条写路径，两者都先校验过枚举。 */
function viewOf(row: KbEntityRow): KbEntityView {
  return {
    entityId: row.entity_id,
    kind: row.kind as KbEntityKind,
    parentId: row.parent_id,
    sourceDocId: row.source_doc_id,
    payload: JSON.parse(row.payload_json) as Record<string, string>,
    normalizedHash: row.normalized_hash,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * 知识库实体服务。
 *
 * 失败一律抛 `AppError`：`KB_SOURCE_MISSING`（工作副本不存在或已损坏，先重新导入）、
 * `KB_ENTITY_NOT_FOUND`（界面按下的是一张陈旧卡片）、`KB_ENTITY_DERIVED`（删除简历派生实体——
 * 它的真相在工作副本里，见 4.2-04）、`INVALID_ARGUMENT`（种类不在四类内、载荷为空、
 * `parentId` 指向不存在的实体——引用完整性必须在写入前成立，见 4.2-02；备份文件不合法，见 4.2-08）。
 */
export class KbProfileService extends Service {
  static provide = 'kb.profile';
  static Config = kbProfileSchema;
  static inject = ['store', 'resume.doc'];

  /** `withTransaction` 的嵌套深度：>0 表示已经在事务里，内层不再开新事务（SQLite 不允许嵌套 BEGIN）。 */
  private txDepth = 0;

  constructor(
    ctx: Context,
    private readonly options: KbProfileConfig,
  ) {
    super(ctx, 'kb.profile');
  }

  private get store() {
    return asApp(this.ctx).store;
  }

  private get docStore() {
    return asApp(this.ctx)['resume.doc'];
  }

  /**
   * 幂等地把本表的两条迁移推进共享迁移列表并升级到最新。
   *
   * 迁移 12 是「新加的一张派生表」，老库里在它建出来时 `kb_entities` 已经有数据了，
   * 所以只在**这一版真的被应用过**时做一次全量补建（`applied` 里有没有 12 就是判据，
   * 不用水位猜——台账与水位不互为换算关系，见 `store/migrate.ts` 的开头）。
   * @returns 无返回值
   */
  private ensureSchema(): void {
    const { migrations } = this.store;
    for (const migration of [kbEntitiesMigration, kbChunksMigration]) {
      if (!migrations.some((item) => item.version === migration.version)) {
        migrations.push(migration);
      }
    }
    const result = this.store.upgrade();
    if (result.applied.includes(KB_CHUNKS_MIGRATION_VERSION)) {
      const backfilled = this.reindexAllChunks();
      this.ctx.logger.info(
        `[kb-profile] 迁移 ${String(KB_CHUNKS_MIGRATION_VERSION)} 落地，全量补建检索切片 ${String(backfilled)} 条`,
      );
    }
  }

  [Service.init](): void {
    this.ensureSchema();
    // 裁定三：读口同时是 agent 工具。对话里问「库里有哪些和高并发相关的经历」必须走同一个 `list()`，
    // 界面与工具各长一套查询就是 §5.9 明确禁止的孤岛。
    const tools = registerAgentTools(this.ctx, [
      agentTool({
        id: 'kb.profile.list',
        description:
          '列出本地知识库里的经历 / 项目 / 技能 / 成果实体，可按种类过滤；sourceDocId 传 null 时只取用户手工创建的实体',
        input: z.strictObject({
          kind: z.enum(KB_ENTITY_KINDS).optional(),
          sourceDocId: z.string().min(1).nullable().optional(),
        }),
        effect: 'read',
        requiresConfirmation: false,
        run: (filter) => Promise.resolve(this.list(filter)),
      }),
    ]);
    this.ctx.logger.info(
      `[kb-profile] kb_entities / kb_chunks 就绪，迁移号段 ${String(KB_PROFILE_MIGRATION_VERSION)} / ${String(KB_CHUNKS_MIGRATION_VERSION)}，实体种类 ${KB_ENTITY_KINDS.join('/')}，反查阈值 topK=${String(this.options.evidenceTopK)} minScore=${String(this.options.evidenceMinScore)} · agent 工具登记 ${String(tools)} 个${tools === 0 ? '（注册表未挂载）' : ''}`,
    );
  }

  /**
   * 把「实体表被写过」推给渲染层（spec 4.2-06 的即时生效）。
   * @param action 触发变更的动作，界面按它取一句人话
   * @param docId 关联的简历文档 id；手工实体的增删不属于任何文档时传 `null`
   * @param changed 受影响的行数，只进提示文案——界面收到信号后重读 `list()`，不在渲染层改本地态（§2.5）
   * @returns 无返回值；事件是「推」的，没人订阅也不该让已经成功的写入因此失败
   */
  private announce(
    action: 'create' | 'update' | 'remove' | 'sync' | 'import',
    docId: string | null,
    changed: number,
  ): void {
    this.ctx.emit('kb/entities-changed', { action, docId, changed, at: Date.now() });
  }

  /**
   * 把一段写操作包进一个事务，嵌套调用只开一层。
   *
   * 4.3-a 需要的正是这一层：一条实体的写删现在必然带动 `kb_chunks` 的一行，
   * 「实体写成功、切片没跟上」是比整体失败更坏的状态（检索会返回已经不存在的内容），
   * 所以五条写路径（sync / create / update / remove / importBackup）统一走这里而不是各自 `BEGIN`。
   * 深度计数的嵌套守卫是必要的：`importBackup` 已经在一个事务里调用 `upsert`，
   * 而 SQLite 不支持事务套事务，内层再 `BEGIN` 会直接抛「cannot start a transaction within a transaction」。
   * @param fn 事务内的操作
   * @returns `fn` 的返回值；中途抛出时整批回滚，库里保持调用前的原状
   */
  private withTransaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth += 1;
      try {
        return fn();
      } finally {
        this.txDepth -= 1;
      }
    }
    const db = this.store.db;
    db.exec('BEGIN');
    this.txDepth = 1;
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      this.txDepth = 0;
    }
  }

  /**
   * 从某份简历的**当前工作副本**重新派生实体并入库。
   *
   * 语义是「同步」而不是「追加」：按稳定 id upsert，再把该文档名下已不在派生结果里的行删掉
   * （用户在工作副本里删了一条经历，库里不该留下一条孤实体）。手工建的实体（`source_doc_id IS NULL`）
   * 不在清理范围内。
   * @param docId 简历文档 id（`resume_docs` 的主键）
   * @param nowMs 写入时间戳（毫秒），由调用方注入以便断言
   * @returns 本次的创建 / 更新 / 清理计数
   * @throws `AppError('KB_SOURCE_MISSING')` 工作副本不存在、损坏或已导入但尚未建副本
   */
  sync(docId: string, nowMs = Date.now()): KbSyncResult {
    const loaded = this.docStore.load(docId);
    if (loaded.status !== 'found') {
      throw new AppError(
        'KB_SOURCE_MISSING',
        loaded.status === 'missing'
          ? `简历 ${docId} 还没有可编辑的工作副本，请先导入或新建一份`
          : `简历 ${docId} 的工作副本读不回合法文档：${loaded.reason}`,
        undefined,
        { docId, status: loaded.status },
      );
    }
    const drafts = deriveEntities(loaded.document);
    const outcome = this.withTransaction(() => {
      const outcomes = drafts.map((draft) => this.upsert(draft, nowMs));
      const removed = this.prune(docId, drafts);
      // 派生行删完再收敛归属：手工实体可以把 `parentId` 挂在一条简历经历上，而那条经历可能在
      // 工作副本里被删了。不同步这一步，库里就会留下「父已经不存在」的悬空引用（4.2-04 明令不留的行态）。
      const detached = this.detachOrphanParents(nowMs);
      return {
        created: outcomes.filter((item) => item === 'created').length,
        updated: outcomes.filter((item) => item === 'updated').length,
        removed,
        detached,
        sections: this.reindexSectionChunks(loaded.document, nowMs),
      };
    });
    if (outcome.detached > 0) {
      this.ctx.logger.info(`[kb-profile] 同步 ${docId} 后解除悬空归属 ${String(outcome.detached)} 条`);
    }

    this.ctx.logger.info(
      `[kb-profile] 同步 ${docId}：派生 ${String(drafts.length)} 条（新建 ${String(outcome.created)} / 更新 ${String(outcome.updated)} / 清理 ${String(outcome.removed)}）· 区块级切片 ${String(outcome.sections)} 条`,
    );
    this.announce('sync', docId, outcome.created + outcome.updated + outcome.removed);
    return { docId, created: outcome.created, updated: outcome.updated, removed: outcome.removed };
  }

  /**
   * 列出实体，可按种类与来源文档过滤。
   * @param filter `kind` 限定种类；`sourceDocId` 限定来源（传 `null` 只取手工建的）；都不传取全库
   * @returns 按更新时间倒序的实体读数
   */
  list(filter: { kind?: KbEntityKind; sourceDocId?: string | null } = {}): readonly KbEntityView[] {
    const conditions: string[] = [];
    const args: (string | null)[] = [];
    if (filter.kind !== undefined) {
      conditions.push('kind = ?');
      args.push(filter.kind);
    }
    if (filter.sourceDocId !== undefined) {
      // 手工实体的来源列是 NULL，`= ?` 永远匹配不到，必须走 `IS NULL`。
      conditions.push(filter.sourceDocId === null ? 'source_doc_id IS NULL' : 'source_doc_id = ?');
      if (filter.sourceDocId !== null) args.push(filter.sourceDocId);
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const rows = this.store.db
      .prepare(`SELECT * FROM kb_entities ${where} ORDER BY updated_at DESC, entity_id ASC`)
      .all(...args) as unknown as readonly KbEntityRow[];
    return rows.map(viewOf);
  }

  /**
   * 按 id 读一条实体。
   * @param entityId 实体 id
   * @returns 读数；不存在返回 `null`（读路径不抛错，让调用方能把「查无」当成正常态显示）
   */
  get(entityId: string): KbEntityView | null {
    const row = this.store.db.prepare('SELECT * FROM kb_entities WHERE entity_id = ?').get(entityId) as
      KbEntityRow | undefined;
    return row === undefined ? null : viewOf(row);
  }

  /**
   * 由一句陈述反查支撑它的实体（spec 4.2-03）。
   *
   * 判定全在 `evidence.ts` 的纯函数里（token 包含与重叠），**不经过模型**：
   * 「这句话有没有据可依」如果由模型自评，§8.4 的事实锁定就只剩一句提示词。
   * @param claim 待反查的陈述（简历里的一句话，或 JD 的一条要求）
   * @param filter 候选范围，与 `list()` 同义：`kind` 限定种类，`sourceDocId` 限定来源文档
   *               （传 `null` 只在手工实体里找）；不传则全库
   * @returns 命中列表（强度倒序、同分按 id 升序，取 `evidenceTopK` 条）；
   *          陈述与库里任何一条都搭不上时返回**空数组**——「查无支撑」是正常态而非失败，
   *          4.5 要靠它区分「有证据」和「这条是模型编的」
   */
  evidenceFor(
    claim: string,
    filter: { kind?: KbEntityKind; sourceDocId?: string | null } = {},
  ): readonly EvidenceRef[] {
    const options: EvidenceOptions = {
      topK: this.options.evidenceTopK,
      minScore: this.options.evidenceMinScore,
    };
    const targets = this.list(filter).map((entity) => ({
      entityId: entity.entityId,
      kind: entity.kind,
      text: evidenceTextOf(entity.payload),
    }));
    return rankEvidence(claim, targets, options);
  }

  /**
   * 手工新建一条实体。
   * @param input 种类 + 载荷，可选归属与来源
   * @param nowMs 写入时间戳（毫秒）
   * @returns 新建后的实体读数
   * @throws `AppError('INVALID_ARGUMENT')` 种类不合法、载荷全空、或 `parentId` 指向不存在的实体
   */
  create(input: KbCreateInput, nowMs = Date.now()): KbEntityView {
    assertKind(input.kind);
    const payload = nonEmptyPayload(input.payload);
    if (input.parentId != null && this.get(input.parentId) === null) {
      throw new AppError('INVALID_ARGUMENT', `归属实体 ${input.parentId} 不存在，不能挂上去`);
    }
    const draft: KbEntityDraft = {
      entityId: manualEntityId(),
      kind: input.kind,
      parentId: input.parentId ?? null,
      // 手工实体**不带来源文档**：同步按 `source_doc_id` 清理派生行，给它挂上 docId 就等于让用户手写的那条
      // 在下一次同步时被当成「已不在简历里」删掉。
      sourceDocId: null,
      payload,
      normalizedHash: payloadHashOf(input.kind, payload),
    };
    this.withTransaction(() => {
      this.insert(draft, nowMs);
    });
    this.announce('create', null, 1);
    this.ctx.logger.info(`[kb-profile] 手工新建 ${draft.entityId}（${draft.kind}）`);
    const view = this.get(draft.entityId);
    // 刚写完就读不到只可能是库被外部破坏，这里不做兜底：让异常暴露而不是返回一份假读数。
    if (view === null) throw new AppError('KB_ENTITY_NOT_FOUND', `刚写入的实体 ${draft.entityId} 读不回来`);
    return view;
  }

  /**
   * 更新一条实体的载荷（归属与来源不变）。
   * @param entityId 实体 id
   * @param payload 新载荷，整体覆盖旧值
   * @param nowMs 写入时间戳（毫秒）
   * @returns 更新后的实体读数
   * @throws `AppError('KB_ENTITY_NOT_FOUND')` 行不存在；`AppError('INVALID_ARGUMENT')` 载荷全空或种类不合法
   */
  update(entityId: string, payload: Readonly<Record<string, string>>, nowMs = Date.now()): KbEntityView {
    const existing = this.get(entityId);
    if (existing === null) {
      throw new AppError('KB_ENTITY_NOT_FOUND', `知识库实体 ${entityId} 不存在，可能已被同步清理`);
    }
    const nextPayload = nonEmptyPayload(payload);
    const hash = payloadHashOf(existing.kind, nextPayload);
    if (hash === existing.normalizedHash) return existing;
    this.withTransaction(() => {
      this.store.db
        .prepare('UPDATE kb_entities SET payload_json = ?, normalized_hash = ?, updated_at = ? WHERE entity_id = ?')
        .run(JSON.stringify(nextPayload), hash, nowMs, entityId);
      // 载荷变了，切片必须跟着变：`kb_chunks.text` 是切片展示与排序的正文来源，
      // 留着旧文本就等于让检索返回一句已经被用户改掉的话（4.3-11 的「派生索引」义务）。
      this.upsertChunk(entityChunkOf({ entityId, sourceDocId: existing.sourceDocId, payload: nextPayload }), nowMs);
    });
    const view = this.get(entityId);
    if (view === null) throw new AppError('KB_ENTITY_NOT_FOUND', `更新后的实体 ${entityId} 读不回来`);
    this.announce('update', existing.sourceDocId, 1);
    return view;
  }

  /**
   * 删除一条**手工**实体，并按 4.2-04 的策略处理它的下属。
   *
   * 策略是「解除归属」而不是「连带删除」：项目与成果可能是用户手写的、只是恰好挂在一条被删的
   * 经历下，连带删除会把还有内容的记录一起抹掉；置空 `parent_id` 同样满足「不留孤儿行」——
   * 孤儿指的是引用一个不存在的父，而不是没有父。**派生实体不走这里**：它们的真相在简历工作副本，
   * 直接删库里的行只会在下一次 `sync()` 时被原样写回来，用户会看到「删了又活过来」，
   * 所以这条路给的是明确失败 + 去简历里删的指引（`KB_ENTITY_DERIVED`）。
   * @param entityId 实体 id
   * @param nowMs 写入时间戳（毫秒）——下属的 `updated_at` 会被刷新，因为它们的归属真的变了
   * @returns 删除计数与解除归属计数
   * @throws `AppError('KB_ENTITY_NOT_FOUND')` 行不存在（界面点了张陈旧卡片，或已被同步清理）
   * @throws `AppError('KB_ENTITY_DERIVED')` 该行由简历派生，请在简历工作副本里删除后重新同步
   */
  remove(entityId: string, nowMs = Date.now()): KbRemoveResult {
    const existing = this.get(entityId);
    if (existing === null) {
      throw new AppError('KB_ENTITY_NOT_FOUND', `知识库实体 ${entityId} 不存在，可能已被同步清理`);
    }
    if (existing.sourceDocId !== null) {
      throw new AppError(
        'KB_ENTITY_DERIVED',
        `实体 ${entityId} 来自简历 ${existing.sourceDocId}，在知识库删除会在下次同步时被写回；请在简历工作副本里删掉它再同步`,
        undefined,
        { entityId, sourceDocId: existing.sourceDocId },
      );
    }
    const { detached, removed } = this.withTransaction(() => {
      const changed = Number(
        this.store.db
          .prepare('UPDATE kb_entities SET parent_id = NULL, updated_at = ? WHERE parent_id = ?')
          .run(nowMs, entityId).changes,
      );
      const deleted = Number(
        this.store.db.prepare('DELETE FROM kb_entities WHERE entity_id = ?').run(entityId).changes,
      );
      // 实体删了切片必须跟着删（4.3-a 的收口判据：删实体后索引无孤儿行）。
      // 归属被解除的下属不用重算切片——它们的载荷没变，变的只是 `parent_id`。
      this.deleteChunk(entityId);
      return { detached: changed, removed: deleted };
    });
    this.ctx.logger.info(`[kb-profile] 删除手工实体 ${entityId}（连带解除归属 ${String(detached)} 条）`);
    this.announce('remove', null, removed + detached);
    return { entityId, removed, detached };
  }

  /**
   * 把整个知识库导出为本地 JSON 备份文件（spec 4.2-08）。
   *
   * 导出的是**全库**（派生 + 手工）：只导手工那半在恢复时会得到「有实体树但没有简历出处」的库，
   * 而派生行反正会在下一次 `sync()` 里被幂等收敛，导出它们不会造成双份真相。
   * @param filePath 目标文件路径（父目录必须已存在——路径是界面与用户决定的，不在这里替它建目录）
   * @param nowMs 导出时间戳（毫秒），写进文件的 `exportedAt`
   * @returns 文件路径与写出的条数
   * @throws `AppError('INVALID_ARGUMENT')` 文件写不出去（路径不存在、权限不足等），原因拼在消息里
   */
  exportBackup(filePath: string, nowMs = Date.now()): KbExportResult {
    const entities = this.list();
    const content = encodeBackup(entities, nowMs);
    try {
      writeFileSync(filePath, content, 'utf8');
    } catch (error) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `备份文件写不出去：${filePath}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    this.ctx.logger.info(`[kb-profile] 导出备份 ${filePath}：${String(entities.length)} 条实体`);
    return { filePath, exported: entities.length };
  }

  /**
   * 从本地 JSON 备份文件恢复知识库（spec 4.2-08）。
   *
   * 三条不变量：
   * 1. **哈希重算**，不信任文件里的内容派生量——载荷才是真相，`normalized_hash` 由 `payloadHashOf` 现算，
   *    否则用户手改载荷而留着旧哈希时，同步的幂等比对会判成「没变」而不重写。
   * 2. **一个事务**：中途一条不合法就整批回滚，留下导入前的原状。半个库比失败更坏。
   * 3. **归属不悬空**：`parent_id` 既不在库里也不在这份文件里时置空并计数（同 4.2-04 的策略），
   *    而不是写出一条引用不存在父实体的行。
   * @param filePath 备份文件路径
   * @param mode 冲突策略，见 `KbImportMode`（默认 `skip`：默认值必须是「不动用户已有的数据」）
   * @returns 总数与各处置计数
   * @remarks 本方法**没有 `nowMs` 入参**：时间戳一律取文件里的原值，恢复备份不该把全部记录的
   *          `created_at`/`updated_at` 刷成「刚刚」——那会让界面的「最近改动」排序在每次恢复后失真。
   * @throws `AppError('INVALID_ARGUMENT')` 文件读不到、不是合法备份、格式版本不认识、内部 id 重复、载荷为空
   */
  importBackup(filePath: string, mode: KbImportMode = 'skip'): KbImportResult {
    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch (error) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `备份文件读不到：${filePath}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    const backup = decodeBackup(text);
    const libraryIds = new Set(
      (
        this.store.db.prepare('SELECT entity_id FROM kb_entities').all() as unknown as readonly { entity_id: string }[]
      ).map((row) => row.entity_id),
    );
    // 导入结束后库里会存在的 id 全集：原有的 + 这份文件里的。归属只要落在这个集合里就不算悬空
    // （文件内部「父排在子后面」是完全正常的写法，不能按遍历顺序判）。
    const knownIds = new Set<string>([...libraryIds, ...backup.entities.map((entry) => entry.entityId)]);

    let created = 0;
    let overwritten = 0;
    let skipped = 0;
    let danglingParents = 0;

    this.withTransaction(() => {
      for (const entry of backup.entities) {
        const existedBefore = libraryIds.has(entry.entityId);
        if (existedBefore && mode === 'skip') {
          skipped += 1;
          continue;
        }
        const isParentDangling = entry.parentId !== null && !knownIds.has(entry.parentId);
        if (isParentDangling) danglingParents += 1;
        const payload = nonEmptyPayload(entry.payload);
        const draft: KbEntityDraft = {
          entityId: entry.entityId,
          kind: entry.kind,
          parentId: isParentDangling ? null : entry.parentId,
          sourceDocId: entry.sourceDocId,
          payload,
          normalizedHash: payloadHashOf(entry.kind, payload),
        };
        // 时间戳取自文件而不是 `nowMs`：恢复备份是把过去的记录放回库里，不是「刚刚新建」。
        this.upsert(draft, entry.updatedAt, entry.createdAt);
        if (existedBefore) overwritten += 1;
        else created += 1;
      }
    });
    this.ctx.logger.info(
      `[kb-profile] 导入备份 ${filePath}（策略 ${mode}）：新建 ${String(created)} / 覆盖 ${String(overwritten)} / 跳过 ${String(skipped)} / 解除悬空归属 ${String(danglingParents)}`,
    );
    this.announce('import', null, created + overwritten);
    return {
      filePath,
      total: backup.entities.length,
      created,
      overwritten,
      skipped,
      danglingParents,
    };
  }

  /**
   * 按稳定 id upsert 一条实体（派生同步与备份导入共用）。
   * @param draft 待写入的实体
   * @param nowMs 本行的 `updated_at`（毫秒）
   * @param createdAt 新行的 `created_at`（毫秒）；省略时与 `nowMs` 相同——只有备份导入需要分开传，
   *                  因为文件里带着记录原本的出生时间
   * @returns `created`（新行）/ `updated`（内容变了）/ `unchanged`（内容一样，`updated_at` 也不动，
   *          免得重复同步把界面排序搅乱）
   * @remarks 三条出路都会让 `kb_chunks` 里对应切片处于「与当前载荷一致」的状态：
   *          新行与改动行重写切片，`unchanged` 行不动它（切片的 1:1 由建表补建与每条写路径共同保证）。
   */
  private upsert(draft: KbEntityDraft, nowMs: number, createdAt = nowMs): 'created' | 'updated' | 'unchanged' {
    const db = this.store.db;
    const existing = db
      .prepare('SELECT normalized_hash, payload_json FROM kb_entities WHERE entity_id = ?')
      .get(draft.entityId) as { normalized_hash: string; payload_json: string } | undefined;
    const payloadJson = JSON.stringify(draft.payload);
    if (existing === undefined) {
      this.insert(draft, nowMs, createdAt);
      return 'created';
    }
    // 哈希相同但键名换了（例如手工把 `role` 改成别的键）也要重写：所以比对 JSON 而不只比对哈希。
    if (existing.normalized_hash === draft.normalizedHash && existing.payload_json === payloadJson) {
      return 'unchanged';
    }
    db.prepare(
      `UPDATE kb_entities
          SET kind = ?, parent_id = ?, source_doc_id = ?, payload_json = ?, normalized_hash = ?, updated_at = ?
        WHERE entity_id = ?`,
    ).run(draft.kind, draft.parentId, draft.sourceDocId, payloadJson, draft.normalizedHash, nowMs, draft.entityId);
    this.upsertChunk(entityChunkOf(draft), nowMs);
    return 'updated';
  }

  /**
   * 插入一条实体行，并带上它的检索切片（4.3-11 的 1:1 不变量在这里落地）。
   * @param draft 实体
   * @param nowMs 本行的 `updated_at`（毫秒）
   * @param createdAt 本行的 `created_at`（毫秒）；派生同步与手工新建时与 `nowMs` 相同
   * @returns 无返回值
   */
  private insert(draft: KbEntityDraft, nowMs: number, createdAt = nowMs): void {
    this.store.db
      .prepare(
        `INSERT INTO kb_entities (entity_id, kind, parent_id, source_doc_id, payload_json, normalized_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draft.entityId,
        draft.kind,
        draft.parentId,
        draft.sourceDocId,
        JSON.stringify(draft.payload),
        draft.normalizedHash,
        createdAt,
        nowMs,
      );
    this.upsertChunk(entityChunkOf(draft), nowMs);
  }

  /**
   * 写或刷新一条切片（`chunk_id` 冲突时整行覆盖）。
   *
   * 切片没有「不变就不写」的分支：它的 `text` / `tokens` 完全由载荷现算，
   * 多写一行的代价远低于「比对逻辑写错导致索引停在旧文本」的代价。
   * @param draft 切片草案
   * @param nowMs 本行的 `updated_at`（毫秒），与所属实体同一时间戳
   * @returns 无返回值
   */
  private upsertChunk(draft: KbChunkDraft, nowMs: number): void {
    this.store.db
      .prepare(
        `INSERT INTO kb_chunks (chunk_id, chunk_kind, source_doc_id, section_kind, text, tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (chunk_id) DO UPDATE SET
           chunk_kind = excluded.chunk_kind,
           source_doc_id = excluded.source_doc_id,
           section_kind = excluded.section_kind,
           text = excluded.text,
           tokens = excluded.tokens,
           updated_at = excluded.updated_at`,
      )
      .run(draft.chunkId, draft.chunkKind, draft.sourceDocId, draft.sectionKind, draft.text, draft.tokens, nowMs);
  }

  /**
   * 删掉一条切片。
   * @param chunkId 切片 id（实体级即实体 id）
   * @returns 无返回值；行本来就不存在不算失败——调用点的语义是「让它不存在」，不是「删掉一行」
   */
  private deleteChunk(chunkId: string): void {
    this.store.db.prepare('DELETE FROM kb_chunks WHERE chunk_id = ?').run(chunkId);
  }

  /**
   * 重建一份文档的区块级切片（`summary / education / campus`，spec 4.3-11 的另一半）。
   *
   * 语义与实体同步一致：按稳定 id upsert，再清掉这份文档名下已不在派生结果里的切片
   * （用户把「校园经历」整块删掉，检索侧就不该再命中它）。
   * @param document 已读回的工作副本
   * @param nowMs 写入时间戳（毫秒）
   * @returns 本次落库的区块级切片条数（进同步日志，界面不读它）
   */
  private reindexSectionChunks(document: ResumeDocument, nowMs: number): number {
    const drafts = deriveSectionChunks(document);
    for (const draft of drafts) this.upsertChunk(draft, nowMs);
    const db = this.store.db;
    if (drafts.length === 0) {
      db.prepare(`DELETE FROM kb_chunks WHERE chunk_kind = 'section' AND source_doc_id = ?`).run(document.id);
      return 0;
    }
    // `NOT IN ()` 的空列表在 SQLite 里是语法错误，所以空派生结果走上一个分支单独处理（同 `prune`）。
    const placeholders = drafts.map(() => '?').join(', ');
    db.prepare(
      `DELETE FROM kb_chunks WHERE chunk_kind = 'section' AND source_doc_id = ? AND chunk_id NOT IN (${placeholders})`,
    ).run(document.id, ...drafts.map((draft) => draft.chunkId));
    return drafts.length;
  }

  /**
   * 全量补建切片：迁移 12 刚落地时把已有的实体与文档都算一遍。
   *
   * 只在「这一版迁移真的被应用过」时调用一次（见 `ensureSchema`）——它遍历全库，
   * 放在每次启动上就是无谓的冷启动开销，而增量写路径已经维护了 1:1。
   * @returns 补建后的切片总数（用于日志）
   */
  private reindexAllChunks(): number {
    const db = this.store.db;
    const entities = db
      .prepare('SELECT entity_id, source_doc_id, payload_json FROM kb_entities')
      .all() as unknown as readonly {
      entity_id: string;
      source_doc_id: string | null;
      payload_json: string;
    }[];
    const nowMs = Date.now();
    for (const row of entities) {
      this.upsertChunk(
        entityChunkOf({
          entityId: row.entity_id,
          sourceDocId: row.source_doc_id,
          payload: JSON.parse(row.payload_json) as Record<string, string>,
        }),
        nowMs,
      );
    }
    for (const docId of this.docStore.listIds()) {
      const loaded = this.docStore.load(docId);
      // 读不回合法文档的副本跳过而不是让整次补建失败：切片是派生索引，
      // 一份坏文档不该拖垮其余文档的索引重建（下一次 `sync()` 会明确报 `KB_SOURCE_MISSING`）。
      if (loaded.status !== 'found') continue;
      this.reindexSectionChunks(loaded.document, nowMs);
    }
    return Number(db.prepare('SELECT count(*) AS n FROM kb_chunks').get()?.n ?? 0);
  }

  /**
   * 列出全部检索切片（spec 4.3-11 的验证入口，也是 4.3-b 检索的候选集来源）。
   * @returns 按 `chunk_id` 升序的切片读数；空库返回空数组
   * @remarks 排序取 id 而不是 `updated_at`：切片是派生索引，界面不展示它，
   *          而 4.3-b 的打分断言要的是「两次调用同一顺序」的可复现性。
   */
  listChunks(): readonly KbChunkView[] {
    const rows = this.store.db
      .prepare(
        'SELECT chunk_id, chunk_kind, source_doc_id, section_kind, text, tokens, updated_at FROM kb_chunks ORDER BY chunk_id',
      )
      .all() as unknown as readonly {
      chunk_id: string;
      chunk_kind: string;
      source_doc_id: string | null;
      section_kind: string | null;
      text: string;
      tokens: string;
      updated_at: number | bigint;
    }[];
    return rows.map(chunkViewOf);
  }

  /**
   * 删掉「属于这份文档、但已不在本次派生结果里」的实体行，并连带删掉它们的切片。
   *
   * 派生结果为空时必须走 `NOT IN ()` 之外的写法——空列表的 `IN ()` 在 SQLite 里是语法错误，
   * 而「用户把这份简历的经历全删光了」是一条正常路径。
   * @param docId 来源文档 id
   * @param drafts 本次派生出的实体
   * @returns 被清理的实体行数
   */
  private prune(docId: string, drafts: readonly KbEntityDraft[]): number {
    const db = this.store.db;
    // 「本次派生结果里没有了」这个条件只写一遍：切片与实体按同一个判定删，
    // 分成两份表达式迟早会在空列表那一支上走散，走散的表现就是检索侧留孤儿行（4.3-11）。
    const ids = drafts.map((draft) => draft.entityId);
    const stale =
      drafts.length === 0
        ? { where: 'source_doc_id = ?', args: [docId] as (string | null)[] }
        : {
            where: `source_doc_id = ? AND entity_id NOT IN (${ids.map(() => '?').join(', ')})`,
            args: [docId, ...ids] as (string | null)[],
          };
    // 先删切片再删实体：那句子查询要从 `kb_entities` 里读待删 id，反过来就先没了参照对象。
    db.prepare(
      `DELETE FROM kb_chunks WHERE chunk_kind = 'entity' AND chunk_id IN (SELECT entity_id FROM kb_entities WHERE ${stale.where})`,
    ).run(...stale.args);
    return Number(db.prepare(`DELETE FROM kb_entities WHERE ${stale.where}`).run(...stale.args).changes);
  }

  /**
   * 把「父已经不在库里」的行解除归属（`parent_id` 置空），保证库里不存在悬空引用。
   *
   * 一条 SQL 覆盖所有方向：不区分父是被同步清理的派生行还是被 `remove()` 删掉的手工行，
   * 也不区分 child 是派生还是手工——「不留孤儿行」（4.2-04）说的是引用关系，不是某种行的专属义务。
   * @param nowMs 刷新这些行的 `updated_at`（毫秒）——归属确实变了，界面排序跟着变是对的
   * @returns 被解除归属的行数
   */
  private detachOrphanParents(nowMs: number): number {
    return Number(
      this.store.db
        .prepare(
          `UPDATE kb_entities
              SET parent_id = NULL, updated_at = ?
            WHERE parent_id IS NOT NULL
              AND parent_id NOT IN (SELECT entity_id FROM kb_entities)`,
        )
        .run(nowMs).changes,
    );
  }
}

/**
 * 校验实体种类在四类之内。
 * @param kind 待校验种类
 * @returns 无返回值
 * @throws `AppError('INVALID_ARGUMENT')` 不在 `KB_ENTITY_KINDS` 里
 */
function assertKind(kind: string): void {
  if (!KB_ENTITY_KINDS.includes(kind as (typeof KB_ENTITY_KINDS)[number])) {
    throw new AppError('INVALID_ARGUMENT', `实体种类 ${kind} 不属于四类知识库实体（${KB_ENTITY_KINDS.join(' / ')}）`);
  }
}

/**
 * 取有效载荷（丢掉空串，并拒绝「一个有效值都没有」的输入）。
 * @param payload 入参载荷
 * @returns 只含非空值的载荷
 * @throws `AppError('INVALID_ARGUMENT')` 全部为空
 */
function nonEmptyPayload(payload: Readonly<Record<string, string>>): Record<string, string> {
  const entries = Object.entries(payload).filter(([, value]) => value.trim() !== '');
  if (entries.length === 0) throw new AppError('INVALID_ARGUMENT', '实体载荷不能是空的');
  return Object.fromEntries(entries);
}

declare module '@auto-cc/core' {
  interface AppServices {
    'kb.profile': KbProfileService;
  }
}
