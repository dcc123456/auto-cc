/**
 * `kb.profile` service（spec 4.2-01 / 4.2-02 / 4.2-03 / 4.2-04 / 4.2-08 + 4.3-11 / 4.3-01 / 4.3-02 / 4.3-03）：
 * 四类知识库实体的建表、派生入库、查询、证据反查、删除、备份，以及检索切片的派生索引与本地检索。
 *
 * 这一层只做十件事：把迁移 11 的 `kb_entities`、迁移 12 的 `kb_chunks`、迁移 13 的
 * `kb_chunks_fts`（FTS5 虚表 + `norm_text` 列）、迁移 14 的 `kb_vectors`（向量派生索引）建出来、
 * 从 `resume_docs` 的**当前工作副本**派生实体、按稳定 id 幂等 upsert 并清掉已不存在的派生行、给出界面与后续检索（4.3）
 * 要用的读接口、把一句陈述映射回支撑它的实体（4.2-03，判定在 `evidence.ts`）、本地备份文件的读写
 * （4.2-08，格式在 `backup.ts`）、4.2-05 / 06 需要的两条装配腿（写入后发 `kb/entities-changed` 事件、
 * 把读口 `list` 登记成 agent 工具——裁定三，界面与 agent 走同一个 service，不许各长一套），
 * 4.3-a 的切片收敛：**每一条实体写删都在同一事务里带上它的切片**（4.3-11 的「无孤儿索引行」），
 * 4.3-b 的检索取数：倒排召回 ∪ 子串召回 → 把语料统计与 df 交给 `search.ts` 打分（判定全在纯函数里），
 * 以及 4.3-d 的向量增强：按当前 embedding 模型补向量（`syncVectors`）与在检索里做一次 RRF 融合
 * （`fuseByRrf`）——向量服务没配就整条腿跳过，**一个 BLOB 都不写**（4.3-08）。
 * 「文本 → 实体」的判定全在 `entities.ts`，「文本 → 切片」的判定全在 `chunks.ts`，
 * 「切片 → 分数」的判定全在 `search.ts`，「向量 → 名次」的度量全在 `vectors.ts`
 * （四者都是纯函数，离线逐条断言），本文件不重复任何规则。
 *
 * 为什么读文档要经 `resume.doc` 而不是自己查 `resume_docs` 表：plan §1.4 裁定一把 `resume_docs` 定成
 * 可编辑工作副本的**唯一真相源**，而它的 `load()` 顺带做了 Schema 重新校验——绕过它就是用裸 SQL
 * 造第二条读取通道（AGENTS.md §2.5），库里被改坏的文档将不再被发现。
 */
import { AppError, asApp, embedGatewayOf, Service, agentTool, registerAgentTools, type Context } from '@auto-cc/core';
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
import { normalizeText } from './tokenize.js';
import {
  type KbSearchCandidate,
  type KbSearchContext,
  type KbSearchParams,
  type KbSearchResult,
  type KbSearchCorpus,
  type KbVectorStatus,
  buildFtsQuery,
  fuseByRrf,
  queryTokensOf,
  quoteFtsTerm,
  rankChunks,
} from './search.js';
import {
  KB_VECTOR_MIGRATION_VERSION,
  type KbVectorRow,
  type KbVectorScore,
  encodeVector,
  kbVectorsMigration,
  rankByCosine,
} from './vectors.js';

/** 迁移号段：**11 / 12 / 13**（账本 1 / agent 会话 2 / jobs 3 / workflow run 4 / conversation 5 / consent 6 /
 *  resume_docs 7 / resume_snapshots 8 / delivery_records 9 / resume_imports 10 / kb_entities 11 / kb_chunks 12 /
 *  kb_chunks_fts 13 / kb_vectors 14（号段常量在 `vectors.ts`））。
 *  撞号的表现是「见号已存在就跳过建表」——表根本没建，读写得到 `no such table`，所以号段必须在注释里列全并被单测断言。 */
export const KB_PROFILE_MIGRATION_VERSION = 11;

/** 检索切片表的迁移号段（spec 4.3-11，plan §4.3 切片拆分的 4.3-a）。 */
export const KB_CHUNKS_MIGRATION_VERSION = 12;

/** 检索索引的迁移号段（spec 4.3-01 / 4.3-02，plan §4.3 切片拆分的 4.3-b）。 */
export const KB_SEARCH_MIGRATION_VERSION = 13;

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

const kbSearchMigration = {
  version: KB_SEARCH_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    // 子串兜底通道必须在**归一化后的正文**上做 `instr`：实测（spike6 §S6）查 `p99` 时原文列命中 0 行、
    // 归一列命中 3 行，而全角「Ｐ９９」只有归一后才与库内的半角形式相遇。
    // NFKC 是 Unicode 操作，SQLite 没有对应函数（内置无 ICU，见 plan §4.3 依赖取证），所以只能在 JS 侧算列存。
    db.exec(`ALTER TABLE kb_chunks ADD COLUMN norm_text TEXT NOT NULL DEFAULT ''`);
    // 独立内容（非 external content）的 FTS5 虚表：只索引预分词串，原文仍只在 `kb_chunks` 存一份
    // （spike 轮次一 Q8 实测预分词列是原文的 1.58~1.63 倍，再复制一份原文就是 2.6 倍体积而无收益）。
    // `rowid` 对齐 `kb_chunks.seq`，所以倒排里不存 chunk_id——join 回主表就是 4.3-b 的取数形态（plan 口径 5）。
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(tokens, tokenize='unicode61')`);
    // 老库升级时的回填：12 已经建好并补过切片，这里按同一份 `tokens` 把倒排行与归一列补齐。
    // 放在迁移里而不是放在 service 的补建钩子上，是因为这一轮**只读同一张表**，SQL 与 JS 都能拿到，
    // 不像 4.3-a 那样需要跨 `resume.doc` 读工作副本——能自己收尾的迁移不留给启动路径（避免冷启动开销）。
    const rows = db.prepare('SELECT seq, text, tokens FROM kb_chunks').all() as unknown as readonly {
      seq: number | bigint;
      text: string;
      tokens: string;
    }[];
    const writeNorm = db.prepare('UPDATE kb_chunks SET norm_text = ? WHERE seq = ?');
    const dropFtsRow = db.prepare('DELETE FROM kb_chunks_fts WHERE rowid = ?');
    const insertFtsRow = db.prepare('INSERT INTO kb_chunks_fts(rowid, tokens) VALUES (?, ?)');
    for (const row of rows) {
      const seq = Number(row.seq);
      writeNorm.run(normalizeText(row.text), seq);
      // 先删后插：`rowid` 复用时 FTS5 不会自动清旧行，留着就是「一条切片两个倒排版本」（spike7 §C 实测路径）。
      dropFtsRow.run(seq);
      insertFtsRow.run(seq, row.tokens);
    }
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS kb_chunks_fts');
    // SQLite 3.35 起支持 DROP COLUMN（本机 3.53.1 / 3.53.4 实测可用，且能在事务里，见 spike7 §B）；
    // 事务包装由 `store.runMigrations` 统一负责，这里不再自己 BEGIN。
    db.exec('ALTER TABLE kb_chunks DROP COLUMN norm_text');
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
  /** 一次检索最多返回几条切片（spec 4.3-01 的 topK）。 */
  searchTopK: z.number().int().min(1).max(100).default(10),
  /**
   * 合并分低于此值不算命中（0～1 的**绝对**阈值）。
   *
   * 与 `evidenceMinScore` 是两个独立键：反查问的是「这句话有没有据」，检索问的是「这条内容相关吗」，
   * 两个语义共享一个阈值就会互相牵制（标定各自在 4.3-e / 4.5 做，见 plan §4.3 的标定项）。
   */
  searchMinScore: z.number().min(0).max(1).default(0.2),
  /** BM25 词频饱和参数（4.3-03：代码内无魔法数，实测默认值 1.2 是 Okapi 惯用值，spike6 §S7 换档只动分值不动头部次序）。 */
  bm25K1: z.number().min(0).max(3).default(1.2),
  /** BM25 长度归一参数（默认 0.75，同上）。 */
  bm25B: z.number().min(0).max(1).default(0.75),
  /** 合并分里 BM25 腿的权重。 */
  bm25Weight: z.number().min(0).max(1).default(0.6),
  /** 合并分里词面覆盖腿的权重（两腿权重之和建议 ≤1，超过 1 时分数会被截断的风险见 `search.ts` 的 `normalizeBm25`）。 */
  lexicalWeight: z.number().min(0).max(1).default(0.4),
  /**
   * 子串兜底通道（`instr` on `norm_text`）召回的切片在合并分里的折扣系数。
   *
   * 这条通道给不出词频与稀有度，只能靠「原文确实含这段字」立据，所以默认低于 1——
   * 实测（spike 轮次五）单字与词尾字只有它有结果，不打折会让一条只沾一个字的切片排到前面。
   */
  substringFloorScore: z.number().min(0).max(1).default(0.25),
  /**
   * RRF 融合常数（spec 4.3-07，plan §4.3-d 实现形状 4）。
   *
   * 60 是 IR 社区做 rank fusion 的惯用值（原始 RRF 论文用的就是 k=60），它的作用是压平头部名次的差距：
   * k 越小越相信「第一名就是第一名」。默认沿用惯用值而不自己调一个：4.3-07 的判据是
   * 「融合只改名次不改分数、k 来自配置」，真实的取值标定需要评测集，归 4.3-e。
   */
  rrfK: z.number().int().min(1).max(1000).default(60),
  /**
   * 向量腿的余弦门限（低于它就不进融合）。
   *
   * 与 `searchMinScore` 分开的理由是量纲不同：那边是 0～1 的合并分，这边是 -1～1 的余弦，
   * 共用一个数就会变成「调检索松紧顺手把向量腿也调了」。默认值给的是 bge-m3 上偏保守的常见区间，
   * 与 `rrfK` 同理，真实取值等 4.3-e 的评测集标定（届时的动作是改 `cordis.yml`，不改代码）。
   */
  vectorMinCosine: z.number().min(0).max(1).default(0.35),
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

/**
 * 一次向量补建的读数（spec 4.3-07 / 08：界面要能说清「补了几条、为什么一条没补」）。
 *
 * 只有计数与模型名，没有任何切片正文（4.3-12 的口径同样适用于返回值——它会经 IPC 落进渲染层日志）。
 */
export interface KbVectorSyncResult {
  /** `unavailable` = 没配好向量服务（未出网）；`failed` = 出网了但没成功（未写入）；`ok` = 本次无需写入或已全部写入。 */
  readonly status: 'ok' | 'unavailable' | 'failed';
  /** 当前配置的 embedding 模型（`kb_vectors.model` 的键）；未配置时为 null。 */
  readonly model: string | null;
  /** 待补条数（`unavailable` 时没有可比的模型，故为 0）。 */
  readonly pending: number;
  /** 本次 upsert 的行数；`failed` / `unavailable` 时为 0（零 BLOB 写入是 4.3-08 的判据）。 */
  readonly written: number;
  /** 清掉的「不属于当前模型」的向量行数（换模型后的失效清理）。 */
  readonly removed: number;
  /** 实际维度，以响应为准（配置里可以不写维度）；本次没有向量时为 null。 */
  readonly dim: number | null;
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

/** `kb_chunks` 的读数行（`listChunks` 与 4.3-b 的两条召回通道共用同一个形状）。 */
interface KbChunkRow {
  readonly chunk_id: string;
  readonly chunk_kind: string;
  readonly source_doc_id: string | null;
  readonly section_kind: string | null;
  readonly text: string;
  readonly tokens: string;
  readonly norm_text: string;
  readonly updated_at: number | bigint;
}

/** `kb_chunks` 的列清单，可选带表别名前缀（倒排召回要 join 主表，子串召回直接读主表）。 */
function chunkSelect(alias: string): string {
  const prefix = alias === '' ? '' : `${alias}.`;
  return ['chunk_id', 'chunk_kind', 'source_doc_id', 'section_kind', 'text', 'tokens', 'norm_text', 'updated_at']
    .map((column) => `${prefix}${column}`)
    .join(', ');
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
   * 幂等地把本服务的四条迁移（11 / 12 / 13 / 14）推进共享迁移列表并升级到最新。
   *
   * 迁移 12 是「新加的一张派生表」，老库里在它建出来时 `kb_entities` 已经有数据了，
   * 所以只在**这一版真的被应用过**时做一次全量补建（`applied` 里有没有 12 就是判据，
   * 不用水位猜——台账与水位不互为换算关系，见 `store/migrate.ts` 的开头）。
   * 迁移 13（倒排表 + 归一列）的补建写在它自己的 `up()` 里：那一轮只读 `kb_chunks` 同一张表，
   * 不需要跨服务取工作副本，所以不留给启动路径。两条补建的先后是安全的：13 先按当时已有的切片建倒排，
   * 之后 12 的补建若再写新行，走的都是 `upsertChunk`——它自己就维护倒排行与归一列。
   * 迁移 14（`kb_vectors`）**只建空表、不补建**：向量要发网络请求才能算出来，冷启动时替用户发一批
   * 是与「不联网也能用」直接冲突的（4.3-04 / 4.3-08），所以补建只在显式的 `syncVectors()` 里发生，
   * 表空着本身就是合法状态。
   * @returns 无返回值
   */
  private ensureSchema(): void {
    const { migrations } = this.store;
    for (const migration of [kbEntitiesMigration, kbChunksMigration, kbSearchMigration, kbVectorsMigration]) {
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
      // 检索口同时是工具（裁定三）：对话里「找找和高并发相关的经历」与界面上的检索框必须打同一个 `search()`。
      // 入参不设 `min(1)`：空查询在库里表现为「切不出 token」而不是「参数不合法」，
      // 注册表那层的 `TOOL_INPUT_INVALID` 会把 4.3-10 要区分的两个确定空态吃成一个错误。
      agentTool({
        id: 'kb.profile.search',
        description:
          '在本地知识库里按关键词检索经历 / 项目 / 技能 / 成果与简历区块切片，返回按 BM25 与词面覆盖合并打分的排序结果，每条命中带出处、分数与命中词；默认纯本地不联网，只有已配置并补建过向量时才额外做一次查询编码（结果里的 vectorStatus 说明本次用了哪条腿）',
        input: z.strictObject({ query: z.string() }),
        effect: 'read',
        requiresConfirmation: false,
        run: ({ query }) => this.search(query),
      }),
      // 向量补建（spec 4.3-07 / 08）：这一只把手是**出网的**（切片文本要发给 embedding 端点），
      // 所以 `effect: 'outbound'` + 需要批准，与 `jd.capture` 同一口径（plan §15.7 落点 4）。
      // 它不做成「检索时自动补建」：那等于用户每搜一句就把整库发出去一次，而 4.3-04 要的是
      // 「不联网也能用」——出网必须是显式动作，界面与对话都只在用户按下去时才发。
      agentTool({
        id: 'kb.profile.syncVectors',
        description:
          '为本地知识库中尚无向量的检索切片调用 embedding 端点补建向量（会出网，按当前配置的模型；已配好则只报告待补条数），返回逐条计数而不含正文',
        input: z.strictObject({}),
        effect: 'outbound',
        requiresConfirmation: true,
        run: () => this.syncVectors(),
      }),
    ]);
    this.ctx.logger.info(
      `[kb-profile] kb_entities / kb_chunks / kb_chunks_fts / kb_vectors 就绪，迁移号段 ${String(KB_PROFILE_MIGRATION_VERSION)} / ${String(KB_CHUNKS_MIGRATION_VERSION)} / ${String(KB_SEARCH_MIGRATION_VERSION)} / ${String(KB_VECTOR_MIGRATION_VERSION)}，实体种类 ${KB_ENTITY_KINDS.join('/')}，反查阈值 topK=${String(this.options.evidenceTopK)} minScore=${String(this.options.evidenceMinScore)}，检索阈值 topK=${String(this.options.searchTopK)} minScore=${String(this.options.searchMinScore)} k1=${String(this.options.bm25K1)} b=${String(this.options.bm25B)}，向量腿 rrfK=${String(this.options.rrfK)} minCosine=${String(this.options.vectorMinCosine)}${this.vectorGatewayHint()} · agent 工具登记 ${String(tools)} 个${tools === 0 ? '（注册表未挂载）' : ''}`,
    );
  }

  /**
   * 装配日志尾部的向量腿状态（spec 4.3-08 的可读性：现场要能一眼看出这次检索到底有没有语义腿）。
   * @returns 一句 ` · 向量增强 …` 后缀；未挂载 / 未配置时把缺的项一并写出来
   */
  private vectorGatewayHint(): string {
    const gateway = embedGatewayOf(this.ctx);
    if (gateway === undefined) return ' · 向量增强 未挂载 llm.embed';
    const status = gateway.status();
    if (!status.available) return ` · 向量增强 未配置（缺 ${status.missing.join('/')}）`;
    return ` · 向量增强 ${status.model ?? '(未知模型)'}`;
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
   * 写或刷新一条切片（`chunk_id` 冲突时整行覆盖），并同步它的倒排行。
   *
   * 切片没有「不变就不写」的分支：它的 `text` / `tokens` 完全由载荷现算，
   * 多写一行的代价远低于「比对逻辑写错导致索引停在旧文本」的代价。
   * 倒排行与切片行**必须在这里一起写**：4.3-b 的召回只读 `kb_chunks_fts`，漏一步的表现是
   * 「用户刚改过的那句话搜不到，而旧句子还在结果里」——比整体失败更难被发现。
   * @param draft 切片草案
   * @param nowMs 本行的 `updated_at`（毫秒），与所属实体同一时间戳
   * @returns 无返回值
   * @remarks `RETURNING seq` 是这条路径的关键：倒排按 `kb_chunks.seq` 对齐 rowid（4.3-a 把 `seq` 定成显式列
   *          就是为了这一步），而 `INSERT ... ON CONFLICT DO UPDATE` 在新建行与复用旧行两种情况下
   *          都返回同一个 `seq`（实测 spike7 §A），不需要先查一次再决定插入或更新。
   */
  private upsertChunk(draft: KbChunkDraft, nowMs: number): void {
    const row = this.store.db
      .prepare(
        `INSERT INTO kb_chunks (chunk_id, chunk_kind, source_doc_id, section_kind, text, tokens, norm_text, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (chunk_id) DO UPDATE SET
           chunk_kind = excluded.chunk_kind,
           source_doc_id = excluded.source_doc_id,
           section_kind = excluded.section_kind,
           text = excluded.text,
           tokens = excluded.tokens,
           norm_text = excluded.norm_text,
           updated_at = excluded.updated_at
         RETURNING seq`,
      )
      .get(
        draft.chunkId,
        draft.chunkKind,
        draft.sourceDocId,
        draft.sectionKind,
        draft.text,
        draft.tokens,
        draft.normText,
        nowMs,
      ) as { seq: number | bigint };
    this.replaceFtsRow(Number(row.seq), draft.tokens);
    // 正文一变，旧向量就不再描述这一行（它与新文本的余弦毫无意义，比"没有向量"更糟：它会被选进融合名单）。
    // 所以这里删而不是更新——更新要再发一次网络请求，而切片写入这条路径必须能在离线时走完（4.3-04）。
    // 删掉之后这一行就落回 `syncVectors()` 的待补集合，语义与"从没编过"完全一致。
    this.store.db.prepare('DELETE FROM kb_vectors WHERE chunk_id = ?').run(draft.chunkId);
  }

  /**
   * 让某个 `seq` 的倒排行等于给定 token 串（先删后插）。
   *
   * FTS5 的 rowid 复用时不会自动覆盖旧行（实测 spike7 §C：不删就出现「一条切片两个倒排版本」），
   * 而 `UPDATE kb_chunks_fts SET …` 在独立内容表上要走 `'rebuild'` 级别的命令，代价与复杂度都更高。
   * @param seq `kb_chunks.seq`（= 倒排 rowid）
   * @param tokens 写入侧预分词串
   * @returns 无返回值
   */
  private replaceFtsRow(seq: number, tokens: string): void {
    const db = this.store.db;
    db.prepare('DELETE FROM kb_chunks_fts WHERE rowid = ?').run(seq);
    db.prepare('INSERT INTO kb_chunks_fts(rowid, tokens) VALUES (?, ?)').run(seq, tokens);
  }

  /**
   * 按谓词批量删切片，并连带删掉它们的倒排行与向量行。
   *
   * 「先删派生行再删主表行」的顺序是硬约束：删倒排与向量都靠
   * `SELECT seq / chunk_id FROM kb_chunks WHERE <同一个谓词>`，主表行先没了就没有参照对象（同 `prune` 里实体与切片的先后）。
   * 三条批量删除路径（同步清理派生行、区块级重建、删单条）都走这里，避免其中一条忘了带上派生表（§2.2）——
   * 4.3-11 的「无孤儿索引行」现在要多守一张表：留着的向量行搜不到主表内容，却仍会进 RRF 名单。
   * @param where 作用在 `kb_chunks` 上的谓词（不含 `WHERE`）
   * @param args 谓词参数
   * @returns 被删掉的主表行数（倒排行数与它相等，由单测断言）
   */
  private deleteChunksWhere(where: string, args: readonly (string | null)[]): number {
    const db = this.store.db;
    db.prepare(`DELETE FROM kb_chunks_fts WHERE rowid IN (SELECT seq FROM kb_chunks WHERE ${where})`).run(...args);
    db.prepare(`DELETE FROM kb_vectors WHERE chunk_id IN (SELECT chunk_id FROM kb_chunks WHERE ${where})`).run(...args);
    return Number(db.prepare(`DELETE FROM kb_chunks WHERE ${where}`).run(...args).changes);
  }

  /**
   * 删掉一条切片（连同它的倒排行）。
   * @param chunkId 切片 id（实体级即实体 id）
   * @returns 无返回值；行本来就不存在不算失败——调用点的语义是「让它不存在」，不是「删掉一行」
   */
  private deleteChunk(chunkId: string): void {
    this.deleteChunksWhere('chunk_id = ?', [chunkId]);
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
    if (drafts.length === 0) {
      this.deleteChunksWhere(`chunk_kind = 'section' AND source_doc_id = ?`, [document.id]);
      return 0;
    }
    // 空派生结果单独走上面一支：实测（SQLite 3.53.1 / 3.53.4）`NOT IN ()` **不报语法错误**而是返回全部行，
    // 行为与这里的意图恰好一致，但「靠一个空列表把谓词退化成全表」太脆——将来换写法就会静默留旧行。
    const placeholders = drafts.map(() => '?').join(', ');
    this.deleteChunksWhere(`chunk_kind = 'section' AND source_doc_id = ? AND chunk_id NOT IN (${placeholders})`, [
      document.id,
      ...drafts.map((draft) => draft.chunkId),
    ]);
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
      .prepare(`SELECT ${chunkSelect('')} FROM kb_chunks ORDER BY chunk_id`)
      .all() as unknown as readonly KbChunkRow[];
    return rows.map(chunkViewOf);
  }

  /**
   * 本地检索一句查询（spec 4.3-01 / 4.3-02 / 4.3-03 / 4.3-07 / 4.3-08）。
   *
   * 本方法只负责**取数**，一条分数都不在这里算：
   * ① 倒排召回（FTS5 `OR` 短语，见 `buildFtsQuery` 为什么不许裸拼也不许用 `AND`）；
   * ② 子串召回（`instr(norm_text, 查询串)`，补倒排切不出来的单字与词尾字，spike 轮次五实测）；
   * ③ 语料统计（`N` 与 `avgdl`，一条 SQL，实测与 JS 侧 token 数完全一致，spike6 §S4）；
   * ④ 逐个查询 token 的 `df`（同一句 prepared 语句复用，2000 条语料下 8 个 token 约 0ms，spike6 §S5）。
   * 两路召回的并集连同 ③④ 交给 `rankChunks` 合并打分与排序（判定全在纯函数里，可离线断言）。
   * ⑤ 向量腿（4.3-d）：只在 `llm.embed` 已配置**且**库里已有当前模型的向量时才编一次查询，
   *   把余弦名单与词面名单交给 `fuseByRrf` 按名次融合。这条腿缺席时结果内容与次序都不变，
   *   缺席的原因写进 `vectorStatus`——降级必须看得见（4.3-08）。
   * @param query 用户查询原文（可以带标点、全角字符、引号）
   * @returns 命中读数；`status` 为 `no_query_tokens` 时**没有进过 SQL、也没有出网**（`MATCH ''` 会抛语法错误，
   *          且「这句话切不出词」与「库里没有」对界面是两种确定空态，见 4.3-10）
   * @remarks 日志只记 token 数与命中数，不记查询原文与切片正文（4.3-12 的日志脱敏：查询本身就是用户的
   *          简历语汇，落到日志文件等于把内容抄了一份到别处）。
   */
  async search(query: string): Promise<KbSearchResult> {
    const db = this.store.db;
    const queryTokens = queryTokensOf(query);
    if (queryTokens.length === 0) {
      return { status: 'no_query_tokens', vectorStatus: 'not_attempted', hits: [], queryTokens: [] };
    }

    const candidates: KbSearchCandidate[] = [];
    const recalled = db
      .prepare(
        `SELECT ${chunkSelect('c')} FROM kb_chunks_fts AS f JOIN kb_chunks AS c ON c.seq = f.rowid
                 WHERE kb_chunks_fts MATCH ? ORDER BY bm25(kb_chunks_fts)`,
      )
      .all(buildFtsQuery(query)) as unknown as readonly KbChunkRow[];
    candidates.push(...recalled.map(chunkViewOf));

    // 子串通道给的是「原文确实含这几个字」，与倒排的「预分词里有这个 token」是两种证据，
    // 所以它的 id 单独记一份交给打分侧——那一腿 0 分的命中要靠它才有理由进结果（`substringFloorScore`）。
    const substringChunkIds = new Set<string>();
    const normalizedQuery = normalizeText(query);
    if (normalizedQuery !== '') {
      const substringRows = db
        .prepare(`SELECT ${chunkSelect('')} FROM kb_chunks WHERE instr(norm_text, ?) > 0 ORDER BY chunk_id`)
        .all(normalizedQuery) as unknown as readonly KbChunkRow[];
      candidates.push(...substringRows.map(chunkViewOf));
      for (const row of substringRows) substringChunkIds.add(row.chunk_id);
    }

    const stats = db
      .prepare(
        `SELECT count(*) AS n,
                SUM(CASE WHEN tokens = '' THEN 0 ELSE length(tokens) - length(replace(tokens, ' ', '')) + 1 END) AS total
           FROM kb_chunks`,
      )
      .get() as unknown as { n: number | bigint; total: number | bigint | null };
    const chunkCount = Number(stats.n ?? 0);
    const corpus: KbSearchCorpus = {
      chunkCount,
      avgTokenCount: chunkCount === 0 ? 0 : Number(stats.total ?? 0) / chunkCount,
    };

    const dfStatement = db.prepare('SELECT count(*) AS n FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ?');
    const dfByToken = new Map<string, number>();
    for (const token of queryTokens) {
      const row = dfStatement.get(quoteFtsTerm(token)) as unknown as { n: number | bigint } | undefined;
      dfByToken.set(token, Number(row?.n ?? 0));
    }

    const params = this.searchParams();
    const context: KbSearchContext = { corpus, dfByToken, substringChunkIds };
    const lexical = rankChunks(query, candidates, context, params);
    const vector = await this.vectorRanking(query, params);
    const views = new Map<string, KbSearchCandidate>(candidates.map((candidate) => [candidate.chunkId, candidate]));
    // 向量腿可以给出一条**词面一点都没召回**的切片（查询「性能优化」对上「P99 延迟下降 40%」就是这种：
    // 没有共同 token、`norm_text` 里也不含查询串）。这正是它存在的理由，所以要把这些 id join 回主表补进
    // 候选视图——不补的话语义名单会被词面召回集裁掉，RRF 退化成「只给已有结果换换序」，增强就成了装饰。
    const missingIds = vector.scores.map((score) => score.chunkId).filter((chunkId) => !views.has(chunkId));
    if (missingIds.length > 0) {
      const semanticRows = db
        .prepare(
          `SELECT ${chunkSelect('')} FROM kb_chunks WHERE chunk_id IN (${missingIds.map(() => '?').join(', ')}) ORDER BY chunk_id`,
        )
        .all(...missingIds) as unknown as readonly KbChunkRow[];
      for (const row of semanticRows) views.set(row.chunk_id, chunkViewOf(row));
    }
    // 名单为空时也照走一遍融合：`fuseByRrf` 对空名单给出的就是词面原序，
    // 少一个「名单空了就绕过融合」的分支，就少一处「两条路径的 tie-break 不一样」的地方。
    const hits = vector.status === 'ok' ? fuseByRrf(query, lexical.hits, vector.scores, views, params) : lexical.hits;
    const result: KbSearchResult = { ...lexical, hits, vectorStatus: vector.status };
    this.ctx.logger.info(
      `[kb-profile] 检索 ${String(queryTokens.length)} 个 token / ${String(candidates.length)} 条候选 → ${String(result.hits.length)} 条命中（${result.status} · 向量腿 ${result.vectorStatus} / 语义名单 ${String(vector.scores.length)} 条）`,
    );
    return result;
  }

  /**
   * 向量腿取数：把一句查询编成向量，并在**当前模型**下按余弦排名（spec 4.3-07）。
   *
   * 三道本地判定把出网次数压到最少：服务没挂载 / 没配置 → `unavailable`；库里没有该模型的行 →
   * `no_vectors`（为了一句查询去编整库是浪费，补建只在 `syncVectors()` 里发生）。两种都一次网络都不发。
   * @param query 用户查询原文（只有这一句出网，切片正文不外发）
   * @param params 余弦门限与 `topK`
   * @returns 融合用的名单与状态；`failed` 是发了但没成功（超时 / 对端错误 / 维度不合），
   *          此时名单为空、检索退回纯词面——**任何一支路都不产生伪向量**（4.3-08 判的就是这个）
   */
  private async vectorRanking(
    query: string,
    params: KbSearchParams,
  ): Promise<{ status: KbVectorStatus; scores: KbVectorScore[] }> {
    const gateway = embedGatewayOf(this.ctx);
    const availability = gateway?.status();
    const model = availability?.model ?? null;
    if (gateway === undefined || availability?.available !== true || model === null) {
      return { status: 'unavailable', scores: [] };
    }
    const db = this.store.db;
    const existing = db.prepare('SELECT count(*) AS n FROM kb_vectors WHERE model = ?').get(model) as unknown as
      { n: number | bigint } | undefined;
    if (Number(existing?.n ?? 0) === 0) return { status: 'no_vectors', scores: [] };

    let encoded: { model: string; dim: number | null; vectors: number[][] };
    try {
      encoded = await gateway.embed([query]);
    } catch (error) {
      // 只记错误码：`AppError.message` 里带端点与对端文案，把它抄进日志等于把「谁的 key 在打不通」
      // 写进一个通常会被一起提交/贴出的文件；正文本来就不进日志（4.3-12）。
      const code = error instanceof AppError ? error.code : '未知错误';
      this.ctx.logger.warn(`[kb-profile] 查询向量编码失败（${code}），本次退回纯词面检索`);
      return { status: 'failed', scores: [] };
    }
    // `.at(0)` 而不是 `[0]`：这条边界是真的会被触发——对端把错误包成 2xx + 空 `data` 时向量数组就是空的，
    // 而「没有查询向量」与「编码失败」在检索侧是同一种处置（退回纯词面），不是拿 `undefined` 去算余弦。
    const queryVector = encoded.vectors.at(0);
    if (queryVector === undefined) return { status: 'failed', scores: [] };

    const rows = db
      .prepare('SELECT chunk_id AS chunkId, vec AS vec FROM kb_vectors WHERE model = ? ORDER BY chunk_id')
      .all(model) as unknown as readonly KbVectorRow[];
    const ranked = rankByCosine(queryVector, rows, params.topK).filter(
      (score) => score.cosine >= params.vectorMinCosine,
    );
    return { status: 'ok', scores: ranked };
  }

  /**
   * 为库里尚无当前模型向量的切片补建向量（spec 4.3-07 / 08，本片唯一的出网入口）。
   *
   * 三步：① 现问 `llm.embed` 可用性——不可用就直接返回，**一次网络都不发、一个 BLOB 都不写**（4.3-08）；
   * ② 把 `kb_chunks` 里缺 `(chunk_id, 当前模型)` 行的文本一次性交给 `gateway.embed()`
   *   （分批由那一侧的 `batchSize` 负责，这里不重复一套批量逻辑，§2.2）；
   * ③ 全部拿到之后才在**一个事务**里 upsert——中途失败整体不落库，库里保持「这批还没有向量」的原状，
   *   而不是留下半库向量（半库会让 RRF 名单随重试次数变化，比没有更难解释）。
   * 顺带清掉 `model ≠ 当前模型` 的行：换 embedding 模型后旧向量与新查询向量不同源，余弦毫无意义
   * （plan §4.3-d 形状 3，`model` 列就是失效判据）。
   * @param nowMs 写入时间戳（毫秒），注入以便单测断言
   * @returns 逐条计数读数，不含任何切片正文；`status` 为 `unavailable` 时 `pending` 与 `written` 都是 0
   *          （没有「当前模型」可比，所以连待补数都问不出来，这不是失败而是未配置）
   */
  async syncVectors(nowMs = Date.now()): Promise<KbVectorSyncResult> {
    const gateway = embedGatewayOf(this.ctx);
    const availability = gateway?.status();
    const model = availability?.model ?? null;
    if (gateway === undefined || availability?.available !== true || model === null) {
      this.ctx.logger.info('[kb-profile] 向量补建跳过：llm.embed 未挂载或未配置，库里没有写入任何向量');
      return { status: 'unavailable', model: null, pending: 0, written: 0, removed: 0, dim: null };
    }

    const db = this.store.db;
    // 失效行先清：这一支是纯本地删除，即使后面的编码失败也不该把上一个模型的向量留下——
    // 留在库里只会被下一次检索的 `model = ?` 过滤掉，白占空间还可能被误读成「有向量」。
    const removed = Number(db.prepare('DELETE FROM kb_vectors WHERE model <> ?').run(model).changes);
    const pendingRows = db
      .prepare(
        `SELECT c.chunk_id AS chunk_id, c.text AS text
           FROM kb_chunks AS c
          WHERE NOT EXISTS (SELECT 1 FROM kb_vectors AS v WHERE v.chunk_id = c.chunk_id AND v.model = ?)
          ORDER BY c.chunk_id`,
      )
      .all(model) as unknown as readonly { chunk_id: string; text: string }[];
    if (pendingRows.length === 0) {
      this.ctx.logger.info(`[kb-profile] 向量补建：模型 ${model} 下 ${String(removed)} 条失效向量已清理，无待补切片`);
      return { status: 'ok', model, pending: 0, written: 0, removed, dim: null };
    }

    let encoded: { model: string; dim: number | null; vectors: number[][] };
    try {
      encoded = await gateway.embed(pendingRows.map((row) => row.text));
    } catch (error) {
      const code = error instanceof AppError ? error.code : '未知错误';
      this.ctx.logger.warn(
        `[kb-profile] 向量补建失败（${code}）：${String(pendingRows.length)} 条待补，未写入任何向量`,
      );
      return { status: 'failed', model, pending: pendingRows.length, written: 0, removed, dim: null };
    }
    // 键用**配置里的那个模型名**，不用响应回显的名字：检索与待补查询都拿 `status().model` 过滤，
    // 写进另一个名字就等于造一批永远取不到的行（回显与配置不同的情形会真实发生，见 `embed.ts` 的 model 取值）。
    const dim = encoded.dim;
    const written = this.withTransaction(() => {
      const statement = db.prepare(
        `INSERT INTO kb_vectors (chunk_id, model, dim, vec, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (chunk_id) DO UPDATE SET
           model = excluded.model,
           dim = excluded.dim,
           vec = excluded.vec,
           updated_at = excluded.updated_at`,
      );
      pendingRows.forEach((row, index) => {
        const vector = encoded.vectors[index] as number[];
        statement.run(row.chunk_id, model, dim ?? vector.length, encodeVector(vector), nowMs);
      });
      return pendingRows.length;
    });
    this.ctx.logger.info(
      `[kb-profile] 向量补建完成：模型 ${model} 维度 ${String(dim ?? '未知')}，写入 ${String(written)} 条 / 清理失效 ${String(removed)} 条`,
    );
    return { status: 'ok', model, pending: pendingRows.length, written, removed, dim };
  }

  /**
   * 配置 → 检索参数（4.3-03 的判据：`k1` / `b` / 权重 / `topK` 全部来自 config，代码内无魔法数）。
   *
   * 单独一个方法而不是就地读 `this.options`：改配置会重建本 service 实例（AGENTS.md §9 的 2.5-d 实测），
   * 所以每次检索现取就是取到当前值，不需要额外的热更新通道。
   * @returns 直接喂给 `rankChunks` 与 `fuseByRrf` 的参数集
   */
  private searchParams(): KbSearchParams {
    return {
      topK: this.options.searchTopK,
      minScore: this.options.searchMinScore,
      k1: this.options.bm25K1,
      b: this.options.bm25B,
      bm25Weight: this.options.bm25Weight,
      lexicalWeight: this.options.lexicalWeight,
      substringFloorScore: this.options.substringFloorScore,
      rrfK: this.options.rrfK,
      vectorMinCosine: this.options.vectorMinCosine,
    };
  }

  /**
   * 删掉「属于这份文档、但已不在本次派生结果里」的实体行，并连带删掉它们的切片。
   *
   * 派生结果为空时走「只有 `source_doc_id = ?`」那一支：实测（SQLite 3.53.1 / 3.53.4）空列表的
   * `IN ()` 返回 0 行、`NOT IN ()` 返回全部行，都不报错，所以两种写法结果一样——但把「删光这份文档的派生行」
   * 写成依赖空列表的语义，读者必须先去查 SQLite 手册才敢改，显式分支更稳（「用户把经历全删光了」是正常路径）。
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
    // 走 `deleteChunksWhere` 而不是自己写 `DELETE FROM kb_chunks`：倒排行必须跟主表行同一条路径清理，
    // 漏掉的那一支表现为「删掉的经历仍然搜得到」，而它只在同步之后才发生，最容易滑过人工检查。
    this.deleteChunksWhere(
      `chunk_kind = 'entity' AND chunk_id IN (SELECT entity_id FROM kb_entities WHERE ${stale.where})`,
      stale.args,
    );
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
