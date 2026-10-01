/**
 * `kb.profile` service（spec 4.2-01 / 4.2-02）：四类知识库实体的建表、派生入库与查询。
 *
 * 这一层只做四件事：把迁移 11 的 `kb_entities` 建出来、从 `resume_docs` 的**当前工作副本**派生实体、
 * 按稳定 id 幂等 upsert 并清掉已不存在的派生行、以及给出界面与后续检索（4.3）要用的读接口。
 * 「文本 → 实体」的判定全在 `entities.ts`（纯函数，离线逐条断言），本文件不重复任何解析规则。
 *
 * 为什么读文档要经 `resume.doc` 而不是自己查 `resume_docs` 表：plan §1.4 裁定一把 `resume_docs` 定成
 * 可编辑工作副本的**唯一真相源**，而它的 `load()` 顺带做了 Schema 重新校验——绕过它就是用裸 SQL
 * 造第二条读取通道（AGENTS.md §2.5），库里被改坏的文档将不再被发现。
 */
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  KB_ENTITY_KINDS,
  type KbEntityDraft,
  type KbEntityKind,
  deriveEntities,
  manualEntityId,
  payloadHashOf,
} from './entities.js';

/** 迁移号段：**11**（账本 1 / agent 会话 2 / jobs 3 / workflow run 4 / conversation 5 / consent 6 /
 *  resume_docs 7 / resume_snapshots 8 / delivery_records 9 / resume_imports 10）。
 *  撞号的表现是「见号已存在就跳过建表」——表根本没建，读写得到 `no such table`，所以号段必须在注释里列全并被单测断言。 */
export const KB_PROFILE_MIGRATION_VERSION = 11;

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

/** `kb.profile` 的可调项：实体建模本身不需要运行期配置，检索参数属 4.3。 */
export const kbProfileSchema = z.strictObject({});
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
 * `KB_ENTITY_NOT_FOUND`（界面按下的是一张陈旧卡片）、`INVALID_ARGUMENT`（种类不在四类内、
 * 载荷为空、`parentId` 指向不存在的实体——引用完整性必须在写入前成立，见 4.2-02）。
 */
export class KbProfileService extends Service {
  static provide = 'kb.profile';
  static Config = kbProfileSchema;
  static inject = ['store', 'resume.doc'];

  constructor(ctx: Context, _options: KbProfileConfig) {
    super(ctx, 'kb.profile');
  }

  private get store() {
    return asApp(this.ctx).store;
  }

  private get docStore() {
    return asApp(this.ctx)['resume.doc'];
  }

  /**
   * 幂等地把本表迁移推进共享迁移列表并升级到最新。
   * @returns 无返回值
   */
  private ensureSchema(): void {
    const { migrations } = this.store;
    if (!migrations.some((item) => item.version === KB_PROFILE_MIGRATION_VERSION)) {
      migrations.push(kbEntitiesMigration);
    }
    this.store.upgrade();
  }

  [Service.init](): void {
    this.ensureSchema();
    this.ctx.logger.info(
      `[kb-profile] kb_entities 表就绪，迁移号段 ${String(KB_PROFILE_MIGRATION_VERSION)}，实体种类 ${KB_ENTITY_KINDS.join('/')}`,
    );
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
    const outcomes = drafts.map((draft) => this.upsert(draft, nowMs));
    const created = outcomes.filter((outcome) => outcome === 'created').length;
    const updated = outcomes.filter((outcome) => outcome === 'updated').length;
    const removed = this.prune(docId, drafts);

    this.ctx.logger.info(
      `[kb-profile] 同步 ${docId}：派生 ${String(drafts.length)} 条（新建 ${String(created)} / 更新 ${String(updated)} / 清理 ${String(removed)}）`,
    );
    return { docId, created, updated, removed };
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
    this.insert(draft, nowMs);
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
    this.store.db
      .prepare('UPDATE kb_entities SET payload_json = ?, normalized_hash = ?, updated_at = ? WHERE entity_id = ?')
      .run(JSON.stringify(nextPayload), hash, nowMs, entityId);
    const view = this.get(entityId);
    if (view === null) throw new AppError('KB_ENTITY_NOT_FOUND', `更新后的实体 ${entityId} 读不回来`);
    return view;
  }

  /**
   * 按稳定 id upsert 一条派生实体。
   * @param draft 派生出的实体
   * @param nowMs 写入时间戳（毫秒）
   * @returns `created`（新行）/ `updated`（内容变了）/ `unchanged`（内容一样，`updated_at` 也不动，
   *          免得重复同步把界面排序搅乱）
   */
  private upsert(draft: KbEntityDraft, nowMs: number): 'created' | 'updated' | 'unchanged' {
    const db = this.store.db;
    const existing = db
      .prepare('SELECT normalized_hash, payload_json FROM kb_entities WHERE entity_id = ?')
      .get(draft.entityId) as { normalized_hash: string; payload_json: string } | undefined;
    const payloadJson = JSON.stringify(draft.payload);
    if (existing === undefined) {
      this.insert(draft, nowMs);
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
    return 'updated';
  }

  /**
   * 插入一条实体行（`created_at` 与 `updated_at` 同为写入时间）。
   * @param draft 实体
   * @param nowMs 写入时间戳（毫秒）
   * @returns 无返回值
   */
  private insert(draft: KbEntityDraft, nowMs: number): void {
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
        nowMs,
        nowMs,
      );
  }

  /**
   * 删掉「属于这份文档、但已不在本次派生结果里」的实体行。
   *
   * 派生结果为空时必须走 `NOT IN ()` 之外的写法——空列表的 `IN ()` 在 SQLite 里是语法错误，
   * 而「用户把这份简历的经历全删光了」是一条正常路径。
   * @param docId 来源文档 id
   * @param drafts 本次派生出的实体
   * @returns 被清理的行数
   */
  private prune(docId: string, drafts: readonly KbEntityDraft[]): number {
    const db = this.store.db;
    if (drafts.length === 0) {
      return Number(db.prepare('DELETE FROM kb_entities WHERE source_doc_id = ?').run(docId).changes);
    }
    const placeholders = drafts.map(() => '?').join(', ');
    const ids = drafts.map((draft) => draft.entityId);
    return Number(
      db
        .prepare(`DELETE FROM kb_entities WHERE source_doc_id = ? AND entity_id NOT IN (${placeholders})`)
        .run(docId, ...ids).changes,
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
