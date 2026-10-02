/**
 * `kb.profile` 的装配用例（spec 4.2-01 / 4.2-02 / 4.2-03 / 4.2-04 / 4.2-08 / 4.3-11）。
 *
 * 打**真的 `node:sqlite` + 真临时目录**（AGENTS.md §7.5，产物不进仓库）：这一层要证明的是
 * 「派生出来的实体真的落了库、重复同步不裂行、工作副本改了之后库跟着收敛、删除与备份的计数对得上」，
 * 这些只有在真库里才成立。派生规则本身在 `entities.test.ts` 里逐条断言过，这里不重复。
 *
 * 4.3-a 的切片用例也放这里（而不是另开一份装配文件）：它要判的是「每一条实体的写删都带着它的切片」，
 * 而这件事只在真实事务路径上才成立——`sync` / `create` / `update` / `remove` / `importBackup` 五条写路径
 * 各自都要过一遍库里，换一份文件就得把这套装配脚手架（含真库与老库升级）重抄一遍（§2.2）。
 *
 * 语料仍是自造虚构简历；手机号写成明显编造的号段，用于顺带复验实体表里不落 PII 原文（对齐 4.1-09 / §8.5）。
 */
import {
  AppError,
  NO_CONFIG,
  Service,
  asApp,
  type AppErrorCode,
  type KbEntitiesChangedEvent,
  Context,
  type Fiber,
} from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { LogService } from '@auto-cc/plugin-logger';
import { ResumeDocService } from '@auto-cc/plugin-resume-doc';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { KB_BACKUP_SCHEMA_VERSION } from './backup.js';
import { deriveSectionChunks, entityChunkOf, indexTokens } from './chunks.js';
import {
  KB_CHUNKS_MIGRATION_VERSION,
  KB_PROFILE_MIGRATION_VERSION,
  KB_SEARCH_MIGRATION_VERSION,
  KbProfileService,
} from './profile-service.js';
import { ResumeParseService } from './parse-service.js';
import { waitForLogLine } from './log-file.js';
import { parseResumeText } from './sections.js';
import { FakeAgentToolsService } from './test-doubles.js';
import { KB_VECTOR_MIGRATION_VERSION, decodeVector } from './vectors.js';

const NOW_MS = 1_700_000_000_000;
const LATER_MS = 1_700_000_900_000;

/**
 * 虚构简历：两段经历 + 三条技能，正文里带一个假手机号用于脱敏复验。
 *
 * 两段经历之间**必须空一行**：`sections.ts` 按空行切条目（4.1 的既定规则），
 * 少了这个空行第二条经历会被并进第一条的正文——那是语料写错了，不是派生漏了。
 */
const RESUME_MD = [
  '张三',
  '电话：13800001111',
  '',
  '## 工作经历',
  '星桥科技｜后端工程师 2021.03-2024.06',
  '- 主导订单服务重构，P99 延迟下降 40%。',
  '',
  '沧海数据｜架构师 2024.07至今',
  '- 把发布流水线从 40 分钟压到 6 分钟。',
  '',
  '## 技能',
  '- TypeScript、Node.js',
  '- Go',
].join('\n');

/**
 * 「把工作副本里的经历删光」的那份语料（4.2-04 的同步侧用例用）。
 *
 * 技能行写得比语料 A 长是有意的：`sections.ts` 有 100 字的正文下限（4.1-03 的拒空判定），
 * 只留两行技能会被判成「文本太短」而根本进不到派生这一步，用例就会验到错的东西。
 */
const RESUME_MD_SKILLS_ONLY = [
  '张三',
  '电话：13800001111',
  '',
  '## 技能',
  '- TypeScript、Node.js、Go、Kubernetes、Docker、gRPC、PostgreSQL、Redis、Kafka、Prometheus',
  '- 分布式一致性、性能剖析、容量规划、链路追踪、灰度发布、成本治理',
].join('\n');

/**
 * 带「个人简介 / 教育经历 / 校园经历」三段区块的语料（4.3-a 的区块级切片用例用）。
 *
 * 这三类在裁定二里**不建实体行**（`entities.ts` 只派生经历 / 项目 / 技能 / 成果），
 * 于是它们进检索的唯一出路就是区块级切片——语料必须真的把这三段写出来，
 * 否则用例会退化成「断言空数组相等」，什么也没验到。
 */
const RESUME_MD_WITH_SECTIONS = [
  '张三',
  '电话：13800001111',
  '',
  '## 个人简介',
  '五年后端开发经验，长期负责高并发订单链路的稳定性治理与发布流水线提速。',
  '',
  '## 教育经历',
  '江海大学｜软件工程 2017.09-2021.06',
  '辅修分布式系统，在校完成过一次性处理千万级日志的课程设计。',
  '',
  '## 工作经历',
  '星桥科技｜后端工程师 2021.03-2024.06',
  '- 主导订单服务重构，P99 延迟下降 40%。',
  '',
  '## 校园经历',
  '校编程社｜社长 2018.09-2019.06',
  '- 组织过三十人规模的校内算法竞赛，负责赛题与判题机。',
].join('\n');

/**
 * 假的 `llm.embed`（spec 4.3-07 / 08 的单测替身，与 `test-doubles.ts` 里的 `FakeAgentToolsService` 同一种替身）。
 *
 * 只认一张「文本片段 → 向量」的 fixture 表：命中第一个出现在文本里的片段就用它的向量，否则给零向量。
 * 为什么自己造向量而不是打真端点：4.3-07 的判据是「融合会改变名次」，那需要一个**可控**的语义相关度；
 * 而本机没有 embedding key（plan §4.3-d 的诚实边界条），打真端点的用例在这台机器上只能是 BLOCKED。
 * 真端点下的增益对比复跑步骤写在 plan 里，等 key 到位再跑。
 */
class FakeEmbedService extends Service {
  static provide = 'llm.embed';
  // 与 `llmEmbedSchema` 同一种写法：`static Config` 会被 cordis 校验后作为第二个实参传进构造器，
  // 所以替身的 fixture 必须进 schema，写成 `strictObject({})` 会在挂载这一步就把三个键判成未知字段。
  static Config = z.strictObject({
    available: z.boolean(),
    model: z.string().nullable(),
    table: z.record(z.string(), z.array(z.number())),
  });

  /** 每次 `embed()` 收到的文本，用于断言「没配好时一次都不发」。 */
  readonly calls: string[][] = [];

  /** 置为 `timeout` 后每次 `embed()` 都抛 `LLM_REQUEST_FAILED`，用来验失败路径零写入。 */
  failWith: 'timeout' | null = null;

  constructor(
    ctx: Context,
    private readonly options: { available: boolean; model: string | null; table: Record<string, number[]> },
  ) {
    super(ctx, 'llm.embed');
  }

  /** 契约见 `EmbedGateway.status`。 */
  status(): { available: boolean; missing: Array<'baseUrl' | 'model' | 'apiKey'>; model: string | null } {
    if (!this.options.available) return { available: false, missing: ['baseUrl', 'model', 'apiKey'], model: null };
    return { available: true, missing: [], model: this.options.model };
  }

  /**
   * 契约见 `EmbedGateway.embed`：顺序与输入一致，维度取第一条的长度。
   * 不写成 `async`：存根里没有任何 `await` 表达式，加 `async` 只是白造一层微任务；
   * 契约要的是「返回 Promise」，失败半边用 `Promise.reject` 给的就是同一个被调用方 `catch` 住的错误。
   */
  embed(texts: readonly string[]): Promise<{ model: string; dim: number | null; vectors: number[][] }> {
    this.calls.push([...texts]);
    if (this.failWith === 'timeout') {
      return Promise.reject(
        new AppError('LLM_REQUEST_FAILED', '向量请求超时（测试存根）', 'llm.embed', { reason: 'timeout' }),
      );
    }
    const vectors = texts.map((text) => this.vectorOf(text));
    return Promise.resolve({ model: this.options.model ?? '', dim: vectors[0]?.length ?? null, vectors });
  }

  /**
   * 文本 → fixture 向量。
   * @param text 一段切片正文或查询
   * @returns 第一个片段命中的向量；一个都不命中时给零向量（余弦因此为 0，等于「语义上谁都不像」）
   */
  private vectorOf(text: string): number[] {
    for (const [fragment, vector] of Object.entries(this.options.table)) {
      if (text.includes(fragment)) return vector;
    }
    return [0, 0];
  }
}

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 建一个系统临时目录（`afterAll` 清理，不进仓库）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-kb-profile-'));
  sandboxes.push(dir);
  return dir;
}

/** 与 `cordis.yml` 一致的检索默认值（4.3-03 的「参数来自配置」用例靠覆盖它来成立）。 */
const SEARCH_DEFAULTS = {
  searchTopK: 10,
  searchMinScore: 0.2,
  bm25K1: 1.2,
  bm25B: 0.75,
  bm25Weight: 0.6,
  lexicalWeight: 0.4,
  substringFloorScore: 0.25,
  rrfK: 60,
  vectorMinCosine: 0.35,
};

/** 装配 `llm.embed` 替身时的形状（不传即整条向量腿缺席，与真实装配里「摘掉 llm-embed」同构）。 */
interface EmbedFixture {
  available: boolean;
  model: string | null;
  table: Record<string, number[]>;
}

/**
 * 挂起 config + log + store + resume.doc + kb.profile（外加 `resume.parse`，端到端那条用例要用）。
 * @param dir 复用哪个目录
 * @param evidence 反查阈值（4.2-03）；默认与 `cordis.yml` 一致，用于验证「阈值来自配置」那两条用例
 * @param search 检索参数（4.3-03），默认与 `cordis.yml` 一致；传部分键即只覆盖那几项
 * @param embed 向量服务替身（4.3-07 / 08）；不传就不挂 `llm.embed`，向量腿整条缺席——
 *              那正是「摘掉插件」的真实装配形态，也是 `unavailable` 分支的入口
 * @returns 实体服务、文档存储服务、导入服务与裸连接
 */
async function boot(
  dir = tempDir(),
  evidence: { topK: number; minScore: number } = { topK: 5, minScore: 0.34 },
  search: Partial<typeof SEARCH_DEFAULTS> = {},
  embed?: EmbedFixture,
) {
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(LogService, { level: 'info', buffer: 500, file: 'auto-cc.log', dir, redact: false }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  // 注册表先于本包上岗：`registerAgentTools` 是软取，晚挂载就只能登记出 0 个工具。
  fibers.push(await ctx.plugin(FakeAgentToolsService, NO_CONFIG));
  // 替身只在显式要求时挂：不挂就是真实装配里「注掉 llm-embed 那一行」的形态（4.3-08 的 `unavailable` 分支）。
  const embedStub = embed === undefined ? undefined : (await ctx.plugin(FakeEmbedService, embed), ctx.get('llm.embed'));
  fibers.push(await ctx.plugin(ResumeDocService, {}));
  fibers.push(
    await ctx.plugin(KbProfileService, {
      evidenceTopK: evidence.topK,
      evidenceMinScore: evidence.minScore,
      ...SEARCH_DEFAULTS,
      ...search,
    }),
  );
  fibers.push(await ctx.plugin(ResumeParseService, { maxBytes: 5_242_880 }));
  const app = asApp(ctx);
  return {
    ctx,
    tools: ctx.get('agent.tools') as unknown as FakeAgentToolsService,
    embed: embedStub as FakeEmbedService | undefined,
    kb: app['kb.profile'],
    doc: app['resume.doc'],
    parse: app['resume.parse'],
    store: app.store,
    db: app.store.db,
  };
}

/** `kb_entities` 的全部行数。 */
function entityCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS total FROM kb_entities').get() as { total: number | bigint };
  return Number(row.total);
}

/** `kb_chunks` 的全部行数。 */
function chunkCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS total FROM kb_chunks').get() as { total: number | bigint };
  return Number(row.total);
}

/**
 * 「实体级切片找不到对应实体行」的行数——spec 4.3-11 收口判据「删实体后索引无孤儿行」的机检形式。
 * @param db 裸连接
 * @returns 孤儿切片行数；正常路径下任何时刻都应为 0
 */
function orphanChunkCount(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total FROM kb_chunks
        WHERE chunk_kind = 'entity'
          AND chunk_id NOT IN (SELECT entity_id FROM kb_entities)`,
    )
    .get() as { total: number | bigint };
  return Number(row.total);
}

/**
 * 「倒排里有行但主表没有对应切片」的行数——4.3-b 的派生索引不变量。
 *
 * 与 `orphanChunkCount` 是两层：那一层管「切片找不到实体」，这一层管「倒排行找不到切片」。
 * 孤儿倒排行的表现不是报错而是**搜到已经不存在的内容**（召回阶段命中，join 回主表时才会掉，
 * 而子串通道根本不走 join，所以旧文本会直接出现在结果里），所以两边都要机检。
 * @param db 裸连接
 * @returns 孤儿倒排行数；任何一次写路径之后都应为 0
 */
function orphanFtsCount(db: DatabaseSync): number {
  const row = db
    .prepare('SELECT COUNT(*) AS total FROM kb_chunks_fts WHERE rowid NOT IN (SELECT seq FROM kb_chunks)')
    .get() as { total: number | bigint };
  return Number(row.total);
}

/** `kb_chunks_fts` 的全部行数。 */
function ftsCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS total FROM kb_chunks_fts').get() as { total: number | bigint };
  return Number(row.total);
}

/**
 * `kb_vectors` 的全部行数（4.3-08 的「零 BLOB 写入」判据靠它，而不是靠返回值自述）。
 * @param db 裸连接
 * @returns 行数；表不存在时抛错——用例本就该在未回滚的库上跑
 */
function vectorCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS total FROM kb_vectors').get() as { total: number | bigint };
  return Number(row.total);
}

/**
 * `kb_vectors` 里「切片已不在 `kb_chunks`」的行数——向量派生索引的孤儿判据。
 *
 * 与 `orphanFtsCount` 同理：孤儿向量的表现不是报错而是**语义召回已经删掉的内容**
 * （向量名单靠 id 回查主表，查不到才被丢掉，而丢掉之前它占了一个 topK 名额）。
 * @param db 裸连接
 * @returns 孤儿向量行数；任何一条写路径之后都应为 0
 */
function orphanVectorCount(db: DatabaseSync): number {
  const row = db
    .prepare('SELECT COUNT(*) AS total FROM kb_vectors WHERE chunk_id NOT IN (SELECT chunk_id FROM kb_chunks)')
    .get() as { total: number | bigint };
  return Number(row.total);
}

/** 表是否存在（回滚用例的判据）。 */
function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) as
    { name?: string } | undefined;
  return row?.name === name;
}

/** `kb_chunks` 上是否存在某一列（迁移 13 的 `norm_text` 加减半边）。 */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as readonly { name: string }[];
  return rows.some((row) => row.name === column);
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  // 见 `parse-service.test.ts` 的同款说明：日志写流异步开文件，删目录要给宽限期。
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放，清理失败不该把一次通过的验收判成失败。
    }
  }
});

describe('建表与迁移', () => {
  it('挂载即建 kb_entities / kb_chunks / kb_chunks_fts / kb_vectors 与 norm_text 列，迁移号段为 11 / 12 / 13 / 14', async () => {
    const { db } = await boot();
    expect(tableExists(db, 'kb_entities')).toBe(true);
    expect(tableExists(db, 'kb_chunks')).toBe(true);
    expect(tableExists(db, 'kb_chunks_fts')).toBe(true);
    expect(tableExists(db, 'kb_vectors')).toBe(true);
    expect(hasColumn(db, 'kb_chunks', 'norm_text')).toBe(true);
    expect(KB_PROFILE_MIGRATION_VERSION).toBe(11);
    expect(KB_CHUNKS_MIGRATION_VERSION).toBe(12);
    expect(KB_SEARCH_MIGRATION_VERSION).toBe(13);
    expect(KB_VECTOR_MIGRATION_VERSION).toBe(14);
  });

  it('迁移号段不复用任何已分配号段（撞号的表现是「见号已存在就跳过建表」，表根本没建）', () => {
    // 已分配：账本 1 / agent 会话 2 / jobs 3 / workflow run 4 / conversation 5 / consent 6 /
    // resume_docs 7 / resume_snapshots 8 / delivery_records 9 / resume_imports 10。
    const taken = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(taken.has(KB_PROFILE_MIGRATION_VERSION)).toBe(false);
    // 本包的四段彼此也不许撞：撞了就是后几个 `up()` 里的建表被「见号已存在」跳过。
    expect(new Set([...taken, KB_PROFILE_MIGRATION_VERSION]).has(KB_CHUNKS_MIGRATION_VERSION)).toBe(false);
    expect(
      new Set([...taken, KB_PROFILE_MIGRATION_VERSION, KB_CHUNKS_MIGRATION_VERSION]).has(KB_SEARCH_MIGRATION_VERSION),
    ).toBe(false);
    expect(
      new Set([...taken, KB_PROFILE_MIGRATION_VERSION, KB_CHUNKS_MIGRATION_VERSION, KB_SEARCH_MIGRATION_VERSION]).has(
        KB_VECTOR_MIGRATION_VERSION,
      ),
    ).toBe(false);
  });

  it('带 `down` 的迁移可以倒回去：回滚到 10 之后 kb_entities 表消失（spec 4.2-01 的 migration up/down 半边）', async () => {
    const { store, db } = await boot();
    expect(tableExists(db, 'kb_entities')).toBe(true);
    const result = store.rollback(KB_PROFILE_MIGRATION_VERSION - 1);
    expect(result.reverted).toContain(KB_PROFILE_MIGRATION_VERSION);
    expect(tableExists(db, 'kb_entities')).toBe(false);
    // 只倒回本表：出处表（号段 10）与文档表（号段 7）都还在，回滚不该波及别人的表。
    expect(tableExists(db, 'resume_imports')).toBe(true);
    expect(tableExists(db, 'resume_docs')).toBe(true);
  });

  it('切片表能单独倒回去：回滚 11 依次倒回 14 / 13 / 12，实体表与它的数据原样留着（spec 4.3-11 的 down 半边）', async () => {
    const { kb, doc, store, db } = await boot();
    const parsed = parseResumeText(RESUME_MD, 'resume-rollback-chunks', NOW_MS);
    if (parsed.status !== 'ok') throw new Error('样例简历解析失败');
    doc.save(parsed.document);
    kb.sync('resume-rollback-chunks', NOW_MS);
    expect(chunkCount(db)).toBeGreaterThan(0);

    const result = store.rollback(KB_PROFILE_MIGRATION_VERSION);
    // 倒序：14（向量表）→ 13（倒排表 + 归一列）→ 12（切片表），顺序反了会撞「表已不在」。
    expect(result.reverted).toEqual([
      KB_VECTOR_MIGRATION_VERSION,
      KB_SEARCH_MIGRATION_VERSION,
      KB_CHUNKS_MIGRATION_VERSION,
    ]);
    expect(tableExists(db, 'kb_chunks')).toBe(false);
    expect(tableExists(db, 'kb_chunks_fts')).toBe(false);
    expect(tableExists(db, 'kb_vectors')).toBe(false);
    // 派生索引删掉了，真相还在：实体表一行不少，重新挂载就能按实体补建回来（下面有用例判这条）。
    expect(tableExists(db, 'kb_entities')).toBe(true);
    expect(entityCount(db)).toBe(7);
  });

  it('倒排能单独倒回去：回滚 12 只删虚表、归一列与向量表，切片行一条不少（spec 4.3-01 的 down 半边）', async () => {
    const dir = tempDir();
    const { kb, store, db } = await syncedKb(
      dir,
      RESUME_MD_WITH_SECTIONS,
      'resume-rollback-fts',
      undefined,
      undefined,
      {
        available: true,
        model: 'BAAI/bge-m3',
        table: { 订单: [1, 0] },
      },
    );
    const before = chunkCount(db);
    expect(before).toBeGreaterThan(0);
    await kb.syncVectors(NOW_MS);
    expect(vectorCount(db)).toBe(before);

    const result = store.rollback(KB_CHUNKS_MIGRATION_VERSION);
    expect(result.reverted).toEqual([KB_VECTOR_MIGRATION_VERSION, KB_SEARCH_MIGRATION_VERSION]);
    expect(tableExists(db, 'kb_chunks_fts')).toBe(false);
    expect(tableExists(db, 'kb_vectors')).toBe(false);
    expect(hasColumn(db, 'kb_chunks', 'norm_text')).toBe(false);
    // 主表原样：切片是派生索引，倒排与向量只是它的两种加速结构，删加速结构不许动数据（否则回滚就成了破坏性操作）。
    expect(chunkCount(db)).toBe(before);
    expect(orphanChunkCount(db)).toBe(0);

    // 重新挂载即恢复：迁移 13 的 `up()` 把虚表与归一列按现有切片重建，检索立刻可用。
    const again = await boot(dir);
    expect(again.kb.listChunks()).toHaveLength(before);
    expect(ftsCount(again.db)).toBe(before);
    // 向量表跟着重建但**空着**：派生索引不自动回填（补建要出网，必须由用户/agent 显式触发，4.3-04 的离线保证靠这一条）。
    expect(vectorCount(again.db)).toBe(0);
    expect((await again.kb.search('订单')).hits.length).toBeGreaterThan(0);
  });
});

describe('同步：工作副本 → 实体表（4.2-01 / 02）', () => {
  it('工作副本不存在时给出确定的结构化失败，而不是静默产出空库', async () => {
    const { kb } = await boot();
    try {
      kb.sync('resume-not-here');
      throw new Error('应该抛错却没有抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('KB_SOURCE_MISSING');
      expect((error as AppError).message).toContain('工作副本');
    }
  });

  it('一份简历同步出经历 / 技能 / 成果三类实体，条数与派生结果一致', async () => {
    const { kb, doc } = await boot();
    const parsed = parseResumeText(RESUME_MD, 'resume-sync', NOW_MS);
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    doc.save(parsed.document);

    const result = kb.sync('resume-sync', NOW_MS);
    expect(result).toMatchObject({ docId: 'resume-sync', created: 7, updated: 0, removed: 0 });
    expect(kb.list({ kind: 'experience' }).map((entity) => entity.payload.company)).toEqual(['星桥科技', '沧海数据']);
    expect(
      kb
        .list({ kind: 'skill' })
        .map((entity) => entity.payload.text)
        .sort(),
    ).toEqual(['Go', 'Node.js', 'TypeScript']);
    expect(kb.list({ kind: 'achievement' })).toHaveLength(2);
  });

  it('重复同步同一份工作副本：不新增、不更新、不清理，行数纹丝不动（幂等）', async () => {
    const { kb, doc, db } = await boot();
    const parsed = parseResumeText(RESUME_MD, 'resume-idem', NOW_MS);
    if (parsed.status !== 'ok') throw new Error('样例简历解析失败');
    doc.save(parsed.document);
    kb.sync('resume-idem', NOW_MS);
    const firstCount = entityCount(db);

    const second = kb.sync('resume-idem', LATER_MS);
    expect(second).toMatchObject({ created: 0, updated: 0, removed: 0 });
    expect(entityCount(db)).toBe(firstCount);
  });

  it('稳定 id：同一份文档两次同步落到同一批实体上，成果的证据引用指向真实存在的经历（4.2-02）', async () => {
    const { kb, doc } = await boot();
    const parsed = parseResumeText(RESUME_MD, 'resume-stable', NOW_MS);
    if (parsed.status !== 'ok') throw new Error('样例简历解析失败');
    doc.save(parsed.document);
    kb.sync('resume-stable', NOW_MS);
    const before = kb.list({ sourceDocId: 'resume-stable' }).map((entity) => entity.entityId);

    kb.sync('resume-stable', LATER_MS);
    const after = kb.list({ sourceDocId: 'resume-stable' }).map((entity) => entity.entityId);
    expect(after.sort()).toEqual(before.sort());

    for (const achievement of kb.list({ kind: 'achievement', sourceDocId: 'resume-stable' })) {
      expect(achievement.parentId).not.toBeNull();
      expect(kb.get(achievement.parentId ?? '')?.kind).toBe('experience');
    }
  });

  it('编辑工作副本再同步：被删掉的经历连同它的成果一起收敛，库里不留孤儿行', async () => {
    const { kb, doc } = await boot();
    const parsed = parseResumeText(RESUME_MD, 'resume-edit', NOW_MS);
    if (parsed.status !== 'ok') throw new Error('样例简历解析失败');
    doc.save(parsed.document);
    kb.sync('resume-edit', NOW_MS);

    const loaded = doc.load('resume-edit');
    if (loaded.status !== 'found') throw new Error('工作副本读不回来');
    const edited = structuredClone(loaded.document);
    const experience = edited.sections.find((section) => section.kind === 'experience');
    experience!.entries = experience!.entries.slice(0, 1);
    edited.updatedAt = LATER_MS;
    doc.save(edited);

    const result = kb.sync('resume-edit', LATER_MS);
    // 被删的一条经历 + 它承载的一条成果。
    expect(result.removed).toBe(2);
    expect(kb.list({ kind: 'experience' })).toHaveLength(1);
    expect(kb.list({ kind: 'achievement' })).toHaveLength(1);
  });
});

describe('手工实体的建 / 查 / 改（4.2-01 的 CRUD 半边）', () => {
  it('新建 → 读取 → 改载荷 → 列表按种类过滤，全程即时生效', async () => {
    const { kb } = await boot();
    const created = kb.create({ kind: 'skill', payload: { text: 'Kotlin' } }, NOW_MS);
    expect(kb.get(created.entityId)?.payload.text).toBe('Kotlin');

    const updated = kb.update(created.entityId, { text: 'Kotlin / Ktor' }, LATER_MS);
    expect(updated.updatedAt).toBe(LATER_MS);
    expect(kb.list({ kind: 'skill' }).map((entity) => entity.entityId)).toContain(created.entityId);
  });

  it('手工实体不带来源文档，因此不会被任何一次同步清理掉', async () => {
    const { kb, doc } = await boot();
    const parsed = parseResumeText(RESUME_MD, 'resume-manual', NOW_MS);
    if (parsed.status !== 'ok') throw new Error('样例简历解析失败');
    doc.save(parsed.document);
    const handmade = kb.create({ kind: 'experience', payload: { company: '自行补录的公司', role: '工程师' } }, NOW_MS);

    kb.sync('resume-manual', LATER_MS);
    expect(kb.get(handmade.entityId)).not.toBeNull();
    expect(handmade.sourceDocId).toBeNull();
  });

  it('载荷没变时不重写时间戳：重复同步不该把界面排序搅乱', async () => {
    const { kb } = await boot();
    const created = kb.create({ kind: 'achievement', payload: { text: '带 3 人小组拿内部创新奖' } }, NOW_MS);
    const again = kb.update(created.entityId, { text: '带 3 人小组拿内部创新奖' }, LATER_MS);
    expect(again.updatedAt).toBe(NOW_MS);
  });

  it('入参非法的三种形态各自给出确定错误：种类不认识、载荷全空、归属指向不存在的实体', async () => {
    const { kb } = await boot();
    const failures: Array<[() => unknown, string]> = [
      [() => kb.create({ kind: 'hobby' as never, payload: { text: '钓鱼' } }, NOW_MS), 'INVALID_ARGUMENT'],
      [() => kb.create({ kind: 'skill', payload: { text: '   ' } }, NOW_MS), 'INVALID_ARGUMENT'],
      [
        () => kb.create({ kind: 'project', payload: { company: '某项目' }, parentId: 'kb-不存在' }, NOW_MS),
        'INVALID_ARGUMENT',
      ],
    ];
    for (const [call, expectedCode] of failures) {
      try {
        call();
        throw new Error('应该抛错却没有抛错');
      } catch (error) {
        expect((error as AppError).code).toBe(expectedCode);
      }
    }
  });

  it('改一条不存在的实体给出 `KB_ENTITY_NOT_FOUND`（界面按的是陈旧卡片）', async () => {
    const { kb } = await boot();
    try {
      kb.update('kb-nope', { text: '任何东西' }, NOW_MS);
      throw new Error('应该抛错却没有抛错');
    } catch (error) {
      expect((error as AppError).code).toBe('KB_ENTITY_NOT_FOUND');
    }
  });
});

describe('端到端：导入 → 工作副本 → 实体（裁定一 + 4.2-01）', () => {
  it('从真实文件导入的简历可以直接同步出实体，且实体表里不落手机号原文', async () => {
    const dir = tempDir();
    const filePath = join(dir, 'resume.md');
    writeFileSync(filePath, RESUME_MD);
    const { kb, parse, db } = await boot(dir);

    const receipt = await parse.fromFile(filePath, NOW_MS);
    expect(receipt.status).toBe('imported');
    const result = kb.sync(receipt.docId, NOW_MS);
    expect(result.created).toBeGreaterThan(0);
    expect(entityCount(db)).toBe(result.created);

    const stored = db
      .prepare('SELECT payload_json FROM kb_entities')
      .all()
      .map((row) => String(row.payload_json))
      .join('\n');
    expect(stored).not.toContain('13800001111');
  });
});

/**
 * 挂一份新库，把给定语料解析成工作副本并同步出实体。
 *
 * 反查（4.2-03）与切片（4.3-a）两组接线用例都要「一份同步好的库」这个前置，
 * 差别只在语料与阈值上，所以收成一处（AGENTS.md §2.2：同一逻辑出现第二次就抽公共层）。
 * @param dir 本次用的临时目录（每个用例独立一份库）
 * @param corpus 简历正文
 * @param docId 存进 `resume_docs` 时用的文档 id
 * @param evidence 反查阈值；省略时用装配默认值
 * @param search 检索参数；省略时用装配默认值
 * @param embed 向量服务替身；省略即整条向量腿缺席（4.3-08 的 `unavailable` 分支）
 * @returns 装配好的服务与裸连接
 */
async function syncedKb(
  dir: string,
  corpus: string,
  docId: string,
  evidence?: { topK: number; minScore: number },
  search?: Partial<typeof SEARCH_DEFAULTS>,
  embed?: EmbedFixture,
) {
  const booted = await boot(dir, evidence, search, embed);
  const parsed = parseResumeText(corpus, docId, NOW_MS);
  if (parsed.status !== 'ok') throw new Error(`语料解析失败：${parsed.status}`);
  booted.doc.save(parsed.document);
  booted.kb.sync(docId, NOW_MS);
  return booted;
}

/**
 * 反查的接线用例（spec 4.2-03）。
 *
 * 算法本身在 `evidence.test.ts` 里逐条断言过，这里只验三件**只有装配起来才成立**的事：
 * 候选确实来自库里那些行、阈值确实读的是配置而不是写死在函数里、手工实体也在候选范围内。
 * @param dir 本次用的临时目录（每个用例独立一份库）
 * @param evidence 反查阈值
 * @returns 已同步好实体的 `kb.profile` 与文档存储服务
 */
async function seededKb(dir: string, evidence?: { topK: number; minScore: number }) {
  return syncedKb(dir, RESUME_MD, 'resume-evidence', evidence);
}

describe('证据反查 evidenceFor（4.2-03）', () => {
  it('一句陈述同时命中承载它的经历与那条成果，且每个命中都能原样读回', async () => {
    const { kb } = await seededKb(tempDir());
    const hits = kb.evidenceFor('主导订单服务重构');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(new Set(hits.map((hit) => hit.kind))).toEqual(new Set(['experience', 'achievement']));
    for (const hit of hits) {
      expect(kb.get(hit.entityId)).not.toBeNull();
      expect(hit.reason).toBe('contains');
      expect(hit.score).toBe(1);
    }
  });

  it('弱命中被默认阈值挡在门外，把 minScore 调低才放出来并标 overlap（阈值来自配置）', async () => {
    const strict = await seededKb(tempDir());
    expect(strict.kb.evidenceFor('订单系统的性能')).toEqual([]);

    const lenient = await seededKb(tempDir(), { topK: 5, minScore: 0.05 });
    const hits = lenient.kb.evidenceFor('订单系统的性能');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.reason).toBe('overlap');
  });

  it('topK 来自配置：调成 1 就只回一条，且回的是同分时 id 最小的那条', async () => {
    const unbounded = await seededKb(tempDir());
    const claim = '主导订单服务重构';
    const all = unbounded.kb.evidenceFor(claim);
    expect(all.length).toBeGreaterThan(1);
    const smallestId = all.map((hit) => hit.entityId).sort()[0];

    const capped = await seededKb(tempDir(), { topK: 1, minScore: 0.34 });
    expect(capped.kb.evidenceFor(claim).map((hit) => hit.entityId)).toEqual([smallestId]);
  });

  it('候选范围可以按 kind 过滤：只在技能里找时不会漏出别的种类', async () => {
    const { kb } = await seededKb(tempDir());
    const skills = kb.evidenceFor('精通 TypeScript 与 Go', { kind: 'skill' });
    expect(skills.length).toBeGreaterThanOrEqual(2);
    for (const hit of skills) expect(hit.kind).toBe('skill');
  });

  it('手工建的实体（无来源文档）也在候选范围内', async () => {
    const { kb } = await seededKb(tempDir());
    const manual = kb.create({ kind: 'achievement', payload: { text: '组织过校园黑客松' } }, LATER_MS);
    const hits = kb.evidenceFor('组织过校园黑客松', { sourceDocId: null });
    expect(hits.map((hit) => hit.entityId)).toEqual([manual.entityId]);
  });

  it('库里没有相关实体时返回空数组而不是抛错——查无支撑是正常态', async () => {
    const { kb } = await seededKb(tempDir());
    expect(kb.evidenceFor('会做棉花糖')).toEqual([]);
    expect(kb.evidenceFor('')).toEqual([]);
  });
});

/**
 * 证据正文读口（spec 4.4-05 的证据链跳转）。
 *
 * 缺口报告里每条证据只有 id，界面点开时才现取正文，所以这个口必须同时能读**两类**据：
 * 库内实体（四类要求的技能/经历证据）与区块切片（学历那一路的据在区块级，4.2 裁定二）。
 * 判据是"两条路都不靠猜 id 前缀"——id 前缀是实现的副产品，拿它分派就等于把格式钉进调用方。
 */
describe('证据正文 evidenceBody（spec 4.4-05）', () => {
  it('传实体 id：读到的是该实体载荷拼出的正文，出处是它自己那份简历', async () => {
    const { kb } = await seededKb(tempDir());
    const entity = kb.list({ kind: 'achievement' })[0];
    if (entity === undefined) throw new Error('语料应该派生出成就实体');
    const body = kb.evidenceBody(entity.entityId);
    expect(body).not.toBeNull();
    expect(body?.id).toBe(entity.entityId);
    expect(body?.origin).toBe('entity');
    expect(body?.text).toContain('订单服务');
    expect(body?.sourceDocId).toBe('resume-evidence');
  });

  it('传区块切片 id：origin 标成 section_chunk，正文与 listChunks 里那条逐字相同', async () => {
    // 语料取带教育区块的那份：缺口报告的学历那条据正是 `sectionKind === 'education'` 的切片，
    // 这条用例要跳的就是那一类 id（默认简历语料只有会建实体行的区块，压根派不出切片）。
    const { kb } = await syncedKb(tempDir(), RESUME_MD_WITH_SECTIONS, 'resume-evidence-sections');
    const chunk = kb.listChunks().find((item) => item.sectionKind === 'education');
    if (chunk === undefined) throw new Error('语料应该派生出学历区块切片');
    const body = kb.evidenceBody(chunk.chunkId);
    expect(body?.origin).toBe('section_chunk');
    expect(body?.text).toBe(chunk.text);
    expect(body?.sourceDocId).toBe('resume-evidence-sections');
  });

  it('两类 id 都不问前缀：库里没有这个 id 时返回 null 而不是抛错', async () => {
    const { kb } = await seededKb(tempDir());
    expect(kb.evidenceBody('kb-does-not-exist')).toBeNull();
    expect(kb.evidenceBody('kbs-does-not-exist')).toBeNull();
    expect(kb.evidenceBody('')).toBeNull();
  });

  it('手工实体读得出正文，且出处为 null（它不属于任何一份简历）', async () => {
    const { kb } = await seededKb(tempDir());
    const manual = kb.create({ kind: 'skill', payload: { name: 'Kotlin' } }, LATER_MS);
    expect(kb.evidenceBody(manual.entityId)).toEqual({
      id: manual.entityId,
      origin: 'entity',
      text: 'Kotlin',
      sourceDocId: null,
    });
  });
});

/**
 * 断言一段同步调用抛出指定码的 `AppError`。
 *
 * 这一片要判的码有三种（`KB_ENTITY_NOT_FOUND` / `KB_ENTITY_DERIVED` / `INVALID_ARGUMENT`），
 * 每个都要顺手把 error 交回调用方读消息文本，所以抽成一个函数而不是抄五遍 try/catch（§2.2）。
 * @param code 期望的错误码
 * @param action 要执行的调用
 * @returns 捕获到的 `AppError`
 */
function expectAppError(code: AppErrorCode, action: () => unknown): AppError {
  try {
    action();
  } catch (error) {
    if (error instanceof AppError) {
      expect(error.code).toBe(code);
      return error;
    }
    throw error;
  }
  throw new Error(`应该抛 ${code} 却没有抛错`);
}

/** 全库「父引用不存在」的行数——4.2-04「不留孤儿行」的机检判据。 */
function orphanParentCount(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total FROM kb_entities
        WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT entity_id FROM kb_entities)`,
    )
    .get() as { total: number | bigint };
  return Number(row.total);
}

/** 备份文件里一条实体的手写形状（用于构造库里从来没有过的输入）。 */
interface HandwrittenEntity {
  readonly entityId: string;
  readonly kind: string;
  readonly parentId: string | null;
  readonly sourceDocId: string | null;
  readonly payload: Readonly<Record<string, string>>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * 把一份（可能故意不合法的）备份正文写到磁盘。
 * @param dir 落在哪个临时目录
 * @param name 文件名
 * @param body 备份正文；传字符串就原样写盘（「不是合法 JSON」那条用例靠它）
 * @returns 文件路径
 */
function writeBackup(dir: string, name: string, body: unknown): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return filePath;
}

/** 只含一条实体的合法备份正文。 */
function backupOf(entities: readonly HandwrittenEntity[]): Record<string, unknown> {
  return { schemaVersion: KB_BACKUP_SCHEMA_VERSION, exportedAt: NOW_MS, entities };
}

describe('删除与归属级联（4.2-04）', () => {
  it('删除手工实体：下属解除归属而不是被连带删掉，全库不留悬空引用', async () => {
    const { kb, db } = await boot();
    const owner = kb.create({ kind: 'experience', payload: { company: '手工雇主', role: '工程师' } }, NOW_MS);
    const child = kb.create(
      { kind: 'project', payload: { text: '挂在手工雇主下的项目' }, parentId: owner.entityId },
      NOW_MS,
    );

    expect(kb.remove(owner.entityId, LATER_MS)).toEqual({ entityId: owner.entityId, removed: 1, detached: 1 });
    expect(kb.get(owner.entityId)).toBeNull();
    // 有内容的那条不该跟着消失：4.2-04 定的是 detach，不是 cascade delete。
    expect(kb.get(child.entityId)?.parentId).toBeNull();
    expect(orphanParentCount(db)).toBe(0);
  });

  it('简历派生的实体拒绝在知识库删除：给 KB_ENTITY_DERIVED，且原行一条不少地留着', async () => {
    const { kb, db } = await seededKb(tempDir());
    const before = entityCount(db);
    const derived = kb.list({ kind: 'experience' })[0];
    if (derived === undefined) throw new Error('语料应该派生出经历实体');

    const error = expectAppError('KB_ENTITY_DERIVED', () => kb.remove(derived.entityId, NOW_MS));
    expect(error.message).toContain('工作副本');
    expect(error.details).toMatchObject({ sourceDocId: 'resume-evidence' });
    expect(entityCount(db)).toBe(before);
    expect(kb.get(derived.entityId)).not.toBeNull();
  });

  it('删除不存在的实体给 KB_ENTITY_NOT_FOUND，而不是静默返回成功', async () => {
    const { kb } = await boot();
    expectAppError('KB_ENTITY_NOT_FOUND', () => kb.remove('kb-not-there', NOW_MS));
  });

  it('在工作副本里删光经历再同步：派生经历消失，挂在它下面的手工实体被解除归属而不是留下悬空引用', async () => {
    const dir = tempDir();
    const { kb, doc, db } = await seededKb(dir);
    const derivedExperience = kb.list({ kind: 'experience' })[0];
    if (derivedExperience === undefined) throw new Error('语料应该派生出经历实体');
    const manual = kb.create(
      { kind: 'achievement', payload: { text: '记在那段经历下的补充成果' }, parentId: derivedExperience.entityId },
      NOW_MS,
    );

    // 只剩技能区块的一份工作副本：经历条目全没了，派生的经历与成果应当被清理掉。
    const skillsOnly = parseResumeText(RESUME_MD_SKILLS_ONLY, 'resume-evidence', LATER_MS);
    if (skillsOnly.status !== 'ok') throw new Error(`语料解析失败：${skillsOnly.status}`);
    doc.save(skillsOnly.document);
    kb.sync('resume-evidence', LATER_MS);

    expect(kb.list({ kind: 'experience' })).toEqual([]);
    expect(kb.get(manual.entityId)?.parentId).toBeNull();
    expect(orphanParentCount(db)).toBe(0);
  });
});

describe('备份导出 / 导入（4.2-08）', () => {
  it('导出的文件不带派生哈希，且同一份库同样时间的两次导出逐字节相同', async () => {
    const dir = tempDir();
    const { kb } = await seededKb(dir);
    const firstPath = join(dir, 'backup-a.json');
    const secondPath = join(dir, 'backup-b.json');
    kb.exportBackup(firstPath, NOW_MS);
    kb.exportBackup(secondPath, NOW_MS);

    const content = readFileSync(firstPath, 'utf8');
    expect(content).toBe(readFileSync(secondPath, 'utf8'));
    expect(content).not.toContain('normalizedHash');
    expect(content).not.toContain('normalized_hash');
    expect(JSON.parse(content).schemaVersion).toBe(KB_BACKUP_SCHEMA_VERSION);
  });

  it('round-trip：新库导入后备份里的每条都原样回来，时间戳保持导出前的值', async () => {
    const sourceDir = tempDir();
    const source = await seededKb(sourceDir);
    source.kb.create({ kind: 'skill', payload: { text: '手工记录的 Kubernetes' } }, LATER_MS);
    const original = source.kb.list();
    const filePath = join(sourceDir, 'kb.json');
    source.kb.exportBackup(filePath, NOW_MS);

    const fresh = await boot(tempDir());
    expect(fresh.kb.importBackup(filePath, 'skip')).toEqual({
      filePath,
      total: original.length,
      created: original.length,
      overwritten: 0,
      skipped: 0,
      danglingParents: 0,
    });
    // 逐条等值（含 createdAt/updatedAt）：恢复备份不该把全部记录的时间戳刷成「刚刚」。
    expect(fresh.kb.list()).toEqual(original);
    expect(orphanParentCount(fresh.db)).toBe(0);
  });

  it('冲突默认 skip：库里改过的那条不被旧备份盖掉', async () => {
    const dir = tempDir();
    const { kb, db } = await seededKb(dir);
    const filePath = join(dir, 'kb.json');
    kb.exportBackup(filePath, NOW_MS);

    const experience = kb.list({ kind: 'experience' })[0];
    if (experience === undefined) throw new Error('语料应该派生出经历实体');
    kb.update(experience.entityId, { ...experience.payload, company: '用户改过的公司' }, LATER_MS);

    const result = kb.importBackup(filePath);
    expect(result).toMatchObject({ created: 0, overwritten: 0, skipped: result.total });
    expect(kb.get(experience.entityId)?.payload.company).toBe('用户改过的公司');
    expect(entityCount(db)).toBe(result.total);
  });

  it('冲突选 overwrite 时以文件为准，并把覆盖条数报出来', async () => {
    const dir = tempDir();
    const { kb } = await seededKb(dir);
    const filePath = join(dir, 'kb.json');
    kb.exportBackup(filePath, NOW_MS);

    const experience = kb.list({ kind: 'experience' })[0];
    if (experience === undefined) throw new Error('语料应该派生出经历实体');
    kb.update(experience.entityId, { ...experience.payload, company: '导入前要被盖掉的公司' }, LATER_MS);

    const result = kb.importBackup(filePath, 'overwrite');
    expect(result.overwritten).toBe(result.total);
    expect(result.created).toBe(0);
    expect(kb.get(experience.entityId)?.payload.company).toBe(experience.payload.company);
  });

  it('备份里指向库外的归属被置空并计数，不会写出悬空行', async () => {
    const dir = tempDir();
    const { kb, db } = await boot();
    const filePath = writeBackup(
      dir,
      'dangling.json',
      backupOf([
        {
          entityId: 'kb-mine-1',
          kind: 'skill',
          parentId: 'kb-parent-never-exists',
          sourceDocId: null,
          payload: { text: '引用了一个不存在的父' },
          createdAt: NOW_MS,
          updatedAt: NOW_MS,
        },
      ]),
    );

    const result = kb.importBackup(filePath, 'skip');
    expect(result).toMatchObject({ total: 1, created: 1, danglingParents: 1 });
    expect(kb.get('kb-mine-1')?.parentId).toBeNull();
    expect(orphanParentCount(db)).toBe(0);
  });

  it('中途一条载荷不合法就整批回滚：库里维持导入前的原状', async () => {
    const dir = tempDir();
    const { kb, db } = await boot();
    // 先落一条已有的手工实体：回滚要判的是「回到导入前」，库里原本就是空的就判不出「回到」。
    const keeper = kb.create({ kind: 'skill', payload: { text: '导入前就有的那条' } }, NOW_MS);
    const goodId = 'kb-rollback-good';
    const filePath = writeBackup(dir, 'broken.json', {
      schemaVersion: KB_BACKUP_SCHEMA_VERSION,
      exportedAt: NOW_MS,
      entities: [
        {
          entityId: goodId,
          kind: 'skill',
          parentId: null,
          sourceDocId: null,
          payload: { text: '这条是好的' },
          createdAt: NOW_MS,
          updatedAt: NOW_MS,
        },
        {
          entityId: 'kb-rollback-bad',
          kind: 'skill',
          parentId: null,
          sourceDocId: null,
          // 全空载荷：写库前必须被拒，而且不能把前一条留下成半个库。
          payload: { text: '   ' },
          createdAt: NOW_MS,
          updatedAt: NOW_MS,
        },
      ],
    });

    expectAppError('INVALID_ARGUMENT', () => kb.importBackup(filePath, 'skip'));
    expect(entityCount(db)).toBe(1);
    expect(kb.get(goodId)).toBeNull();
    // 4.3-a：实体回滚了，切片也必须跟着回滚——「实体写成功而切片留下」会让检索返回库里没有的内容。
    expect(chunkCount(db)).toBe(1);
    expect(kb.listChunks()[0]?.chunkId).toBe(keeper.entityId);
    expect(kb.listChunks()[0]?.text).toBe('导入前就有的那条');
  });

  it('不是合法 JSON、格式版本不认识、文件内部 id 重复，都在动库之前被拒', async () => {
    const dir = tempDir();
    const { kb, db } = await boot();
    const entity: HandwrittenEntity = {
      entityId: 'kb-dup',
      kind: 'skill',
      parentId: null,
      sourceDocId: null,
      payload: { text: '同一条出现两次' },
      createdAt: NOW_MS,
      updatedAt: NOW_MS,
    };

    expectAppError('INVALID_ARGUMENT', () => kb.importBackup(writeBackup(dir, 'not-json.json', '{oops'), 'skip'));
    expectAppError('INVALID_ARGUMENT', () =>
      kb.importBackup(
        writeBackup(dir, 'old-version.json', { schemaVersion: 99, exportedAt: NOW_MS, entities: [] }),
        'skip',
      ),
    );
    expectAppError('INVALID_ARGUMENT', () =>
      kb.importBackup(writeBackup(dir, 'duplicated.json', backupOf([entity, entity])), 'skip'),
    );
    expect(entityCount(db)).toBe(0);
  });

  it('文件读不到与目标目录不存在都给 INVALID_ARGUMENT，不往外抛裸 fs 错误', async () => {
    const dir = tempDir();
    const { kb } = await boot(dir);
    const unreachable = join(dir, 'no-such-dir', 'kb.json');

    const readError = expectAppError('INVALID_ARGUMENT', () => kb.importBackup(unreachable, 'skip'));
    expect(readError.message).toContain('读不到');
    const writeError = expectAppError('INVALID_ARGUMENT', () => kb.exportBackup(unreachable, NOW_MS));
    expect(writeError.message).toContain('写不出去');
  });

  it('备份带着出处：派生行的 source_doc_id 原样恢复，重复导入同一份文件一条也不会多写', async () => {
    const sourceDir = tempDir();
    const source = await seededKb(sourceDir);
    const filePath = join(sourceDir, 'kb.json');
    source.kb.exportBackup(filePath, NOW_MS);

    const fresh = await boot(tempDir());
    const total = fresh.kb.importBackup(filePath, 'skip').total;
    const derived = fresh.kb.list({ kind: 'experience' })[0];
    if (derived === undefined) throw new Error('备份里应该带着派生经历');
    expect(derived.sourceDocId).toBe('resume-evidence');
    // 同一份文件再导一次（默认 skip）：库里已经有这些 id，一条都不该重复写。
    expect(fresh.kb.importBackup(filePath)).toMatchObject({ created: 0, overwritten: 0, skipped: total });
  });
});

describe('变更事件与 agent 工具面（4.2-06 + 裁定三）', () => {
  it('新建 / 编辑 / 删除 / 导入 / 同步各推一条 kb/entities-changed，同步失败的写入不推', async () => {
    const { kb, doc, ctx } = await boot(tempDir());
    const events: KbEntitiesChangedEvent[] = [];
    ctx.on('kb/entities-changed', (event) => events.push(event));

    const created = kb.create({ kind: 'skill', payload: { name: 'Redis 缓存' } }, NOW_MS);
    kb.update(created.entityId, { name: 'Redis 缓存与失效策略' }, LATER_MS);
    kb.remove(created.entityId, LATER_MS);
    // 工作副本不存在时同步整笔失败：失败没有改过任何行，界面不该为此白跑一次重读。
    try {
      kb.sync('resume-not-there', NOW_MS);
    } catch (error) {
      expect((error as AppError).code).toBe('KB_SOURCE_MISSING');
    }

    const dir = tempDir();
    const filePath = join(dir, 'kb.json');
    kb.exportBackup(filePath, NOW_MS);
    kb.importBackup(filePath, 'skip');

    const parsed = parseResumeText(RESUME_MD, 'resume-events', NOW_MS);
    if (parsed.status !== 'ok') throw new Error(`语料解析失败：${parsed.status}`);
    doc.save(parsed.document);
    kb.sync('resume-events', NOW_MS);

    expect(events.map((event) => event.action)).toEqual(['create', 'update', 'remove', 'import', 'sync']);
    expect(events[0]).toMatchObject({ action: 'create', docId: null, changed: 1 });
    expect(events[3]).toMatchObject({ action: 'import', docId: null });
    expect(events[4]).toMatchObject({ action: 'sync', docId: 'resume-events' });
    expect(events[4]?.changed ?? 0).toBeGreaterThan(0);
    // 载荷只有动作与计数：实体内容由界面重读 `list()` 拿，事件里不塞副本（§2.5 不做两套真相）。
    expect(Object.keys(events[0] ?? {}).sort()).toEqual(['action', 'at', 'changed', 'docId']);
  });

  it('载荷没变的编辑不推事件（没写库就没有即时生效要证明）', async () => {
    const { kb, ctx } = await boot(tempDir());
    const events: KbEntitiesChangedEvent[] = [];
    ctx.on('kb/entities-changed', (event) => events.push(event));

    const created = kb.create({ kind: 'achievement', payload: { title: '开源贡献' } }, NOW_MS);
    kb.update(created.entityId, { title: '开源贡献' }, LATER_MS);
    expect(events.map((event) => event.action)).toEqual(['create']);
  });

  it('agent 工具面登记的是同一个 `list`：跑工具与直接调 service 逐行相等（裁定三禁止的两套查询）', async () => {
    const { kb, tools } = await seededKb(tempDir());
    const tool = tools.declarations.get('kb.profile.list');
    if (tool === undefined) throw new Error('kb.profile.list 未登记进 agent 工具面');
    expect(tool.effect).toBe('read');
    expect(tool.requiresConfirmation).toBe(false);
    expect(await tool.run({ kind: 'experience' })).toEqual(kb.list({ kind: 'experience' }));
    expect(await tool.run({})).toEqual(kb.list());
    // 入参是边界：种类不在四类内必须由 schema 挡下，而不是打到 service 里再猜。
    expect(tool.input.safeParse({ kind: 'no-such-kind' }).success).toBe(false);
  });

  it('检索登记的也是同一个入口：跑工具与直接调 service 逐字段相等，且空态是值而不是入参错误（裁定三 / 4.3-10）', async () => {
    const { kb, tools } = await seededKb(tempDir());
    const tool = tools.declarations.get('kb.profile.search');
    if (tool === undefined) throw new Error('kb.profile.search 未登记进 agent 工具面');
    expect(tool.effect).toBe('read');
    expect(tool.requiresConfirmation).toBe(false);
    expect(await tool.run({ query: '订单' })).toEqual(await kb.search('订单'));
    // 空查询必须过 schema：注册表那层的 `TOOL_INPUT_INVALID` 会把 4.3-10 要区分的两个确定空态吃成一个错误。
    expect(tool.input.safeParse({ query: '' }).success).toBe(true);
    expect(await tool.run({ query: '。。。' })).toEqual({
      status: 'no_query_tokens',
      hits: [],
      queryTokens: [],
      vectorStatus: 'not_attempted',
    });
    // 结果要落进消息 parts 并过 IPC，所以必须是纯 JSON（Map / Set 一旦漏进去就是「界面上拿到空对象」）。
    const serialized = JSON.parse(JSON.stringify(await tool.run({ query: '订单' }))) as { hits: unknown[] };
    expect(serialized.hits.length).toBeGreaterThan(0);
  });
});

/**
 * 检索切片的收敛用例（spec 4.3-11，plan §4.3 切片拆分的 4.3-a）。
 *
 * 派生规则本身在 `chunks.test.ts` 里逐条断言过，这里只判**只有装配起来才成立**的那件事：
 * `kb_chunks` 是派生索引，不是第二套真相——所以每一条会改 `kb_entities` 的路径
 * （sync / create / update / remove / importBackup）都必须在同一个事务里把切片一起改掉，
 * 任何一条路走漏，表现都是「检索返回一句库里已经没有的内容」。
 * 收口判据两句：**chunk 边界 = 实体边界**（下面的 id 集合双向相等）、
 * **删实体后索引无孤儿行**（`orphanChunkCount` 恒为 0）。
 */
describe('检索切片收敛（4.3-a / spec 4.3-11）', () => {
  it('实体级切片与实体一一对应：两边 id 集合双向相等，且切片正文就是那条实体的反查文本', async () => {
    const { kb } = await syncedKb(tempDir(), RESUME_MD, 'resume-chunk-align');
    const entityIds = kb.list().map((entity) => entity.entityId);
    const chunks = kb.listChunks();
    const entityChunkIds = chunks.filter((chunk) => chunk.chunkKind === 'entity').map((chunk) => chunk.chunkId);

    // 双向相等：既不允许「实体没有切片」（检索漏召回），也不允许「切片没有实体」（返回幽灵内容）。
    expect([...entityChunkIds].sort()).toEqual([...entityIds].sort());
    // 整行相等而不只是 id 相等：切片的内容必须逐字段等于纯派生结果（`entityChunkOf`），
    // 装配层自己不再算一遍文本，否则「键排序后拼接」那条口径就有第二份实现（§2.5）。
    for (const entity of kb.list()) {
      const chunk = chunks.find((item) => item.chunkId === entity.entityId);
      expect(chunk).toEqual({ ...entityChunkOf(entity), updatedAt: NOW_MS });
    }
  });

  it('区块级切片只覆盖不建实体行的三类区块，id 与 `deriveSectionChunks` 逐条相等', async () => {
    const { kb, doc } = await syncedKb(tempDir(), RESUME_MD_WITH_SECTIONS, 'resume-chunk-sections');
    const loaded = doc.load('resume-chunk-sections');
    if (loaded.status !== 'found') throw new Error('工作副本读不回来');
    const derived = deriveSectionChunks(loaded.document);

    const sectionChunks = kb.listChunks().filter((chunk) => chunk.chunkKind === 'section');
    expect(sectionChunks.map((chunk) => chunk.chunkId).sort()).toEqual(derived.map((draft) => draft.chunkId).sort());
    // 区块级切片带 sectionKind，实体级不带——检索结果的「来自哪个区块」全靠这一列。
    expect(new Set(sectionChunks.map((chunk) => chunk.sectionKind))).toEqual(
      new Set(['summary', 'education', 'campus']),
    );
    expect(sectionChunks.every((chunk) => chunk.sourceDocId === 'resume-chunk-sections')).toBe(true);
    expect(kb.listChunks().filter((chunk) => chunk.sectionKind !== null)).toHaveLength(sectionChunks.length);
  });

  it('三类区块与实体不重叠：既不会出现「同一段文字两条切片」，也不会三段都没进索引', async () => {
    const { kb } = await syncedKb(tempDir(), RESUME_MD_WITH_SECTIONS, 'resume-chunk-no-overlap');
    const chunks = kb.listChunks();
    const entityChunkIds = new Set(
      chunks.filter((chunk) => chunk.chunkKind === 'entity').map((chunk) => chunk.chunkId),
    );
    const sectionChunkIds = new Set(
      chunks.filter((chunk) => chunk.chunkKind === 'section').map((chunk) => chunk.chunkId),
    );
    for (const id of sectionChunkIds) expect(entityChunkIds.has(id)).toBe(false);
    expect(sectionChunkIds.size).toBeGreaterThan(0);
    // `chunk_id` 上有 UNIQUE，重复派生同一段文字会得到同一个 id；集合大小与总行数相等说明没有一条切片白占着。
    expect(entityChunkIds.size + sectionChunkIds.size).toBe(chunks.length);
  });

  it('改一条实体的载荷：切片正文与 token 一起换，旧词从索引里消失（不留「搜到已被改掉的话」）', async () => {
    const { kb, db } = await boot();
    const created = kb.create({ kind: 'skill', payload: { text: 'Rust 异步运行时' } }, NOW_MS);
    const before = kb.listChunks().find((chunk) => chunk.chunkId === created.entityId);
    expect(before?.tokens).toContain('运行');

    kb.update(created.entityId, { text: 'Go 微服务' }, LATER_MS);
    const after = kb.listChunks().find((chunk) => chunk.chunkId === created.entityId);
    expect(after?.text).toBe('Go 微服务');
    expect(after?.tokens).toBe(indexTokens('Go 微服务'));
    expect(after?.updatedAt).toBe(LATER_MS);
    // 全表扫一遍旧 token：`update` 只写自己那一行，别处本来就不该有；这里判的是「没有第二条切片留着旧文本」。
    const staleRows = db.prepare("SELECT COUNT(*) AS total FROM kb_chunks WHERE tokens LIKE '%运行%'").get() as {
      total: number | bigint;
    };
    expect(Number(staleRows.total)).toBe(0);
  });

  it('删一条手工实体：切片同删，索引里无孤儿行', async () => {
    const { kb, db } = await boot();
    const created = kb.create({ kind: 'project', payload: { name: '订单中台' } }, NOW_MS);
    kb.create({ kind: 'skill', payload: { text: 'Rust' } }, NOW_MS);
    expect(orphanChunkCount(db)).toBe(0);

    kb.remove(created.entityId, LATER_MS);
    expect(kb.listChunks().some((chunk) => chunk.chunkId === created.entityId)).toBe(false);
    expect(orphanChunkCount(db)).toBe(0);
  });

  it('同步清理派生实体时切片同删：工作副本删光经历再同步，实体级与区块级都不留旧行', async () => {
    const dir = tempDir();
    const { kb, doc, db } = await syncedKb(dir, RESUME_MD_WITH_SECTIONS, 'resume-chunk-sync');
    const before = kb.listChunks().length;
    expect(before).toBeGreaterThan(0);

    // 把整份工作副本换成「只有技能」：三类区块全没了，经历实体也没了。
    const parsed = parseResumeText(RESUME_MD_SKILLS_ONLY, 'resume-chunk-sync', LATER_MS);
    if (parsed.status !== 'ok') throw new Error('样例简历解析失败');
    doc.save(parsed.document);
    kb.sync('resume-chunk-sync', LATER_MS);

    const after = kb.listChunks();
    expect(orphanChunkCount(db)).toBe(0);
    expect(after.filter((chunk) => chunk.chunkKind === 'section')).toEqual([]);
    expect(after.map((chunk) => chunk.chunkId).sort()).toEqual(
      kb
        .list()
        .map((entity) => entity.entityId)
        .sort(),
    );
    expect(after.every((chunk) => chunk.sourceDocId === 'resume-chunk-sync')).toBe(true);
  });

  it('重复同步不重复建行：两次同步后切片条数与 id 集合都不动', async () => {
    const dir = tempDir();
    const { kb, db } = await syncedKb(dir, RESUME_MD_WITH_SECTIONS, 'resume-chunk-idem');
    const first = kb.listChunks();
    kb.sync('resume-chunk-idem', LATER_MS);
    const second = kb.listChunks();
    expect(second.map((chunk) => chunk.chunkId)).toEqual(first.map((chunk) => chunk.chunkId));
    expect(chunkCount(db)).toBe(first.length);
  });

  it('导入备份成功：切片跟着恢复出的实体一起回来，时间戳取文件里的值而不是「刚刚」', async () => {
    const dir = tempDir();
    const { kb, db } = await boot(dir);
    const restoredAt = NOW_MS - 1_000;
    const entity: HandwrittenEntity = {
      entityId: 'kb-chunk-restored',
      kind: 'skill',
      parentId: null,
      sourceDocId: null,
      payload: { text: '备份里的一条' },
      createdAt: restoredAt,
      updatedAt: restoredAt,
    };
    const filePath = writeBackup(dir, 'restored.json', backupOf([entity]));

    kb.importBackup(filePath, 'skip');
    const chunk = kb.listChunks().find((item) => item.chunkId === entity.entityId);
    // 实体在事务里逐条 upsert，切片是同一条路径带出来的——这里判的是「四条写路径都收口到 `upsert` / `insert`」
    // 这条接线真的成立，而不只是「切片表能写」。
    expect(chunk).toEqual({ ...entityChunkOf(entity), updatedAt: restoredAt });
    expect(orphanChunkCount(db)).toBe(0);
  });

  it('老库升级补建：回滚掉切片表后重新挂载，按现有实体与工作副本把索引补齐', async () => {
    const dir = tempDir();
    const { kb, store, db } = await syncedKb(dir, RESUME_MD_WITH_SECTIONS, 'resume-chunk-upgrade');
    const before = kb.listChunks().map((chunk) => chunk.chunkId);
    expect(before.length).toBeGreaterThan(0);

    // 模拟「带着 kb_entities 但没有 kb_chunks 的老库」：倒回迁移 12 会把表删掉，实体一行不少地留着。
    // 走回滚而不是 `DROP TABLE`，是因为台账里的第 12 版也必须一起删掉——补建只在「这一版真的被应用过」时发生。
    store.rollback(KB_CHUNKS_MIGRATION_VERSION - 1);
    expect(tableExists(db, 'kb_chunks')).toBe(false);

    const again = await boot(dir);
    expect(tableExists(again.db, 'kb_chunks')).toBe(true);
    // 实体级与区块级都补齐：前者按 `kb_entities` 现算，后者要遍历 `resume_docs` 才有，漏掉任何一边
    // 表现都是「升级完搜不到老数据」。
    expect(
      again.kb
        .listChunks()
        .map((chunk) => chunk.chunkId)
        .sort(),
    ).toEqual([...before].sort());
    expect(orphanChunkCount(again.db)).toBe(0);
  });

  it('全表不变量：每一条切片的 token 都是其正文按 `indexTokens` 现算的结果', async () => {
    const { kb } = await syncedKb(tempDir(), RESUME_MD_WITH_SECTIONS, 'resume-chunk-invariant');
    kb.create({ kind: 'achievement', payload: { text: 'P99 延迟下降 40%' } }, NOW_MS);
    for (const chunk of kb.listChunks()) {
      expect(chunk.tokens).toBe(indexTokens(chunk.text));
    }
    // 空正文是合法形态（切不出 token 就存空串），但绝不能存成 `undefined` 或别的字面。
    expect(kb.listChunks().every((chunk) => typeof chunk.tokens === 'string')).toBe(true);
  });
});

describe('本地检索：倒排召回 + 子串召回 + 合并排序（spec 4.3-01 / 02 / 03）', () => {
  /** 供检索用例复用的语料同步（`RESUME_MD_WITH_SECTIONS` 里同时有区块级与实体级切片）。 */
  async function searchableKb(search: Partial<typeof SEARCH_DEFAULTS> = {}, embed?: EmbedFixture) {
    return syncedKb(tempDir(), RESUME_MD_WITH_SECTIONS, 'resume-search', undefined, search, embed);
  }

  it('五条写路径跑完之后：倒排行数与切片行数严格相等且两侧都无孤儿', async () => {
    const dir = tempDir();
    const { kb, doc, db } = await syncedKb(dir, RESUME_MD_WITH_SECTIONS, 'resume-search-integrity');
    const created = kb.create({ kind: 'achievement', payload: { text: '把订单链路 P99 压到 200 毫秒' } }, NOW_MS);
    kb.update(created.entityId, { text: '把库存链路 P99 压到 200 毫秒' }, LATER_MS);
    kb.sync('resume-search-integrity', LATER_MS);
    expect(ftsCount(db)).toBe(chunkCount(db));
    expect(orphanFtsCount(db)).toBe(0);

    kb.remove(created.entityId, LATER_MS);
    expect(ftsCount(db)).toBe(chunkCount(db));
    expect(orphanFtsCount(db)).toBe(0);

    // 把工作副本里的经历删光再同步：`prune` 与区块级重建两支都要带走倒排行
    const parsed = parseResumeText(RESUME_MD_SKILLS_ONLY, 'resume-search-integrity', LATER_MS);
    if (parsed.status !== 'ok') throw new Error('精简语料解析失败');
    doc.save(parsed.document);
    kb.sync('resume-search-integrity', LATER_MS);
    expect(ftsCount(db)).toBe(chunkCount(db));
    expect(orphanFtsCount(db)).toBe(0);
    expect(orphanChunkCount(db)).toBe(0);
  });

  it('按「订单」检索：相关切片在前，每条命中的理由与命中词都非空', async () => {
    const { kb } = await searchableKb();
    const result = await kb.search('订单');
    expect(result.vectorStatus).toBe('unavailable');
    expect(result.status).toBe('ok');
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.text).toContain('订单');
    // 切片级命中要能把出处带回来（4.5 的事实锁定靠这一列反查实体）
    for (const hit of result.hits) {
      expect(hit.reasons.length).toBeGreaterThan(0);
      expect(hit.matchedTokens.length).toBeGreaterThan(0);
      expect(hit.chunkId).toBeTruthy();
      expect(result.queryTokens).toContain('订单');
    }
    // 与订单无关的校园那条不该进来
    expect(result.hits.some((hit) => hit.text.includes('判题机'))).toBe(false);
  });

  it('中文能力词查询命中对应那条：「高并发」找到简介里的稳定性、「算法竞赛」找到校园经历（spec 4.3-02）', async () => {
    const { kb } = await searchableKb();

    // 语料里只有个人简介那一段写了「高并发」，命中它就是「二字组索引按中文切开了」的直接证据
    const concurrency = await kb.search('高并发');
    expect(concurrency.status).toBe('ok');
    expect(concurrency.hits[0]?.text).toContain('高并发');
    expect(concurrency.hits[0]?.matchedTokens).toEqual(['并发', '高并']);

    // 校园段那条被 4.1 锁成了 `achievement` 事实，所以它既有实体级切片、又有区块级切片——
    // 同一个中文查询两侧都命中。两条切片的内容是同一句话，**只断句子不断段头**，
    // 否则断言会莫名挂在「区块切片多带了公司名与时间」这种与检索无关的差异上。
    const contest = await kb.search('算法竞赛');
    expect(contest.hits.map((hit) => hit.text)).toContain('组织过三十人规模的校内算法竞赛，负责赛题与判题机。');
    expect(new Set(contest.hits.map((hit) => hit.chunkKind))).toEqual(new Set(['entity', 'section']));

    // 手工建的技能实体同样进得了检索：切片与实体的 1:1 对能力词查询成立
    const skill = kb.create({ kind: 'skill', payload: { name: '推荐算法与召回排序' } }, NOW_MS);
    expect((await kb.search('推荐算法')).hits.map((hit) => hit.chunkId)).toContain(skill.entityId);
  });

  it('单字查询走子串通道：倒排切不出来的「订」仍然命中，并标 substring 理由', async () => {
    const { kb, db } = await searchableKb();
    // 前置事实：倒排里确实没有单字 `订` 这个 token（预分词是二字组），否则这条用例就没在判子串通道。
    const ftsRows = db.prepare('SELECT rowid FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ?').all('"订"') as unknown;
    expect(ftsRows).toEqual([]);

    const result = await kb.search('订');
    expect(result.status).toBe('ok');
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((hit) => hit.text.includes('订'))).toBe(true);
    expect(result.hits.some((hit) => hit.reasons.includes('substring'))).toBe(true);
  });

  it('全角与大小写在归一列上相遇：查「Ｐ９９」命中库内写成半角的 P99', async () => {
    const { kb } = await searchableKb();
    const result = await kb.search('Ｐ９９');
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.some((hit) => hit.text.includes('P99'))).toBe(true);
  });

  it('切不出 token 的查询给确定空态，而不是把 FTS5 语法错误抛给界面', async () => {
    const { kb } = await searchableKb();
    expect(await kb.search('。。。')).toEqual({
      status: 'no_query_tokens',
      hits: [],
      queryTokens: [],
      vectorStatus: 'not_attempted',
    });
    expect(await kb.search('')).toMatchObject({ status: 'no_query_tokens', vectorStatus: 'not_attempted' });
  });

  it('参数来自配置：topK、minScore、两腿权重各自改动都会改变结果（4.3-03 的无魔法数判据）', async () => {
    const { kb: baselineKb } = await searchableKb();
    const baseline = await baselineKb.search('订单');
    expect(baseline.hits.length).toBeGreaterThan(1);

    const { kb: cappedKb } = await searchableKb({ searchTopK: 1 });
    const capped = await cappedKb.search('订单');
    expect(capped.hits).toHaveLength(1);
    expect(capped.hits[0]?.chunkId).toBe(baseline.hits[0]?.chunkId);

    const { kb: strictKb } = await searchableKb({ searchMinScore: 0.99 });
    const strict = await strictKb.search('订单');
    expect(strict.hits.length).toBeLessThan(baseline.hits.length);

    // 只留覆盖腿与只留 BM25 腿是两种取向，头部次序应当能被其中一条腿翻掉；
    // 若两腿权重根本不进算式，这三条断言会给出完全相同的结果。
    const { kb: bm25Kb } = await searchableKb({ bm25Weight: 1, lexicalWeight: 0 });
    const { kb: lexKb } = await searchableKb({ bm25Weight: 0, lexicalWeight: 1 });
    const bm25Only = await bm25Kb.search('订单服务重构');
    const lexicalOnly = await lexKb.search('订单服务重构');
    expect(bm25Only.hits.map((hit) => hit.score)).not.toEqual(lexicalOnly.hits.map((hit) => hit.score));
    expect(lexicalOnly.hits.every((hit) => hit.score <= 1)).toBe(true);
  });

  it('grep 判据：九个参数的默认值只活在 `cordis.yml` 里，检索源码一处赋数字都没有（4.3-03 的 C 半边）', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const yaml = readFileSync(join(here, '../../../cordis.yml'), 'utf8');
    const profileStart = yaml.indexOf('- id: kb-profile');
    expect(profileStart).toBeGreaterThan(-1);
    const rest = yaml.slice(profileStart);
    const block = rest.slice(0, rest.indexOf('\n  - id:'));
    const searchKeys = [
      'searchTopK',
      'searchMinScore',
      'bm25K1',
      'bm25B',
      'bm25Weight',
      'lexicalWeight',
      'substringFloorScore',
      'rrfK',
      'vectorMinCosine',
    ];
    for (const key of searchKeys) expect(block).toMatch(new RegExp(`^\\s+${key}: \\d`, 'm'));

    // 注释里写着实测拿到的数字（spike 结论里的 1.2 / 0.75），先把注释行剔掉再查赋值：
    // 这条判据要拦的是代码里的默认值，不是解释。
    const codeOnly = (file: string): string =>
      readFileSync(join(here, file), 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n');
    const scoring = codeOnly('search.ts');
    const wiring = codeOnly('profile-service.ts');
    // 参数名（应用侧的叫法，与 `cordis.yml` 的键名不同源）一旦被赋数字，表现就是「改了配置检索没变」，
    // 而这条只能靠源码检查发现——运行期断言拿到的永远是装配时传进去的那份配置。
    for (const name of [
      'k1',
      'b',
      'topK',
      'minScore',
      'bm25Weight',
      'lexicalWeight',
      'substringFloorScore',
      'rrfK',
      'vectorMinCosine',
    ]) {
      const assigned = new RegExp(`\\b${name}\\s*[:=]\\s*\\d`);
      expect(scoring.match(assigned)?.[0] ?? null).toBeNull();
      expect(wiring.match(assigned)?.[0] ?? null).toBeNull();
    }
  });

  it('实体改过之后倒排立即收敛：旧句子搜不到、新句子搜得到', async () => {
    const { kb } = await searchableKb();
    // 两条文本刻意不共享任何二字组（`链路` 这种两边都有的词会让「搜不到」变成假阴性判据）
    const created = kb.create({ kind: 'project', payload: { text: '订单中心的对账流程治理' } }, NOW_MS);
    expect((await kb.search('对账流程')).hits.some((hit) => hit.chunkId === created.entityId)).toBe(true);
    expect((await kb.search('灰度放量')).hits.some((hit) => hit.chunkId === created.entityId)).toBe(false);

    kb.update(created.entityId, { text: '商品中心的灰度放量机制' }, LATER_MS);
    expect((await kb.search('对账流程')).hits.some((hit) => hit.chunkId === created.entityId)).toBe(false);
    expect((await kb.search('灰度放量')).hits.some((hit) => hit.chunkId === created.entityId)).toBe(true);
  });

  it('只缺倒排表的老库重新挂载即可检索：迁移 13 自己把倒排行与归一列回填（不留给启动路径补建）', async () => {
    const dir = tempDir();
    const { kb, store, db } = await syncedKb(dir, RESUME_MD_WITH_SECTIONS, 'resume-search-backfill');
    expect((await kb.search('订单')).hits.length).toBeGreaterThan(0);

    // 模拟「带着 kb_chunks 但没有倒排」的老库：倒回一格就是只回滚 13，切片行与实体行都不动。
    store.rollback(KB_CHUNKS_MIGRATION_VERSION);
    expect(tableExists(db, 'kb_chunks_fts')).toBe(false);

    const again = await boot(dir);
    expect(tableExists(again.db, 'kb_chunks_fts')).toBe(true);
    expect(ftsCount(again.db)).toBe(chunkCount(again.db));
    // 回填的归一列必须一起补上，否则升级后子串通道对老数据永久失效（表现为「单字搜不到」这种最难查的缺口）
    expect(again.kb.listChunks().every((chunk) => chunk.normText === chunk.text.normalize('NFKC').toLowerCase())).toBe(
      true,
    );
    expect((await again.kb.search('订单')).hits.length).toBeGreaterThan(0);
    expect((await again.kb.search('订')).hits.some((hit) => hit.reasons.includes('substring'))).toBe(true);
  });
});

/**
 * 向量补建与 RRF 融合的装配用例（spec 4.3-07 / 08，plan §4.3-d）。
 *
 * 纯函数那半边（float32 往返、余弦、名次合成）在 `vectors.test.ts` 与 `search.test.ts` 里逐条断言过，
 * 这里只判**只有真库 + 真挂载才成立**的四件事：
 * ① 补建向量的三条出口（未挂载 / 未配置 / 编码失败）都**一个 BLOB 都不写、一次请求都不发**——4.3-08 的正文；
 * ② `model` 列真的是失效判据（换模型即整表作废，不做「半新半旧混着算余弦」）；
 * ③ 切片的每一条写路径都带着它的向量行一起收敛（派生索引不许留孤儿，4.3-11 延伸到这张表）；
 * ④ 检索的四态（`unavailable` / `no_vectors` / `failed` / `ok`）与「语义命中能进结果」是装配出来的结果。
 *
 * 向量替身为什么按「正文片段 → 向量」造而不是打真端点：4.3-07 的判据要的是**可控**的语义相关度，
 * 而本机没有 embedding key（plan §4.3-d 的诚实边界条）。真端点下的增益对比复跑步骤写在 plan 里。
 */
describe('向量补建与 RRF 融合（4.3-d / spec 4.3-07 / 08）', () => {
  /** 替身模型名，与硅基流动的 `BAAI/bge-m3` 同形：代码不认识具体模型名，换它只换配置（4.3-03）。 */
  const FIXTURE_MODEL = 'fixture-bge-m3';

  /**
   * 词面与语义**故意给出不同名次**的一张表。
   *
   * 「发布流水线」只在个人简介那段出现，「重构」只在工作经历那条出现，而查询「订单」两边都含：
   * 于是词面腿把「主导订单服务重构」排在前，语义腿把简介那条排在最前（余弦 0.995 vs 0.0995）。
   * 片段按声明顺序匹配，所以特异片段必须写在通用片段前面，否则两边都落到 `[10,1]` 上、名次就不分了。
   */
  const SEMANTIC_TABLE: Record<string, number[]> = {
    发布流水线: [10, 0],
    重构: [0, 10],
    订单: [10, 1],
  };

  /** 装配一份「同步好切片 + 挂上向量替身」的库。 */
  async function embedKb(
    dir: string,
    docId: string,
    table: Record<string, number[]>,
    search: Partial<typeof SEARCH_DEFAULTS> = {},
    available = true,
  ) {
    return syncedKb(dir, RESUME_MD_WITH_SECTIONS, docId, undefined, search, {
      available,
      model: available ? FIXTURE_MODEL : null,
      table,
    });
  }

  it('向量表随挂载而建、空表就是正确状态：没人按补建就没有一行向量，检索也不发编码请求', async () => {
    const dir = tempDir();
    const { kb, embed, db } = await embedKb(dir, 'resume-vectors-empty', SEMANTIC_TABLE);
    expect(chunkCount(db)).toBeGreaterThan(0);
    expect(vectorCount(db)).toBe(0);

    const result = await kb.search('订单');
    expect(result.vectorStatus).toBe('no_vectors');
    expect(result.hits.length).toBeGreaterThan(0);
    // 「库里没有同源向量」与「向量不可用」是两态，但共同点是不出网：一条编码请求都不该发（4.3-04）
    expect(embed?.calls).toEqual([]);
  });

  it('未挂载 `llm.embed` 时补建给 `unavailable` 且零写入（摘掉插件是降级，不是崩溃）', async () => {
    const { kb, db } = await syncedKb(tempDir(), RESUME_MD_WITH_SECTIONS, 'resume-vectors-unmounted');
    expect(await kb.syncVectors(NOW_MS)).toMatchObject({
      status: 'unavailable',
      model: null,
      pending: 0,
      written: 0,
      removed: 0,
      dim: null,
    });
    expect(vectorCount(db)).toBe(0);
    expect((await kb.search('订单')).vectorStatus).toBe('unavailable');
  });

  it('挂载了但没配好（缺 baseUrl / model / key）同样零写入、零请求：`available:false` 不是「试一下再失败」', async () => {
    const { kb, embed, db } = await embedKb(tempDir(), 'resume-vectors-unconfigured', {}, undefined, false);
    expect(await kb.syncVectors(NOW_MS)).toMatchObject({ status: 'unavailable', written: 0 });
    expect(vectorCount(db)).toBe(0);
    expect((await kb.search('订单')).vectorStatus).toBe('unavailable');
    expect(embed?.calls).toEqual([]);
  });

  it('配好后补建：一次批量喂全部切片、float32 落库、维度取响应，重复补建幂等且不再出网', async () => {
    const { kb, embed, db } = await embedKb(tempDir(), 'resume-vectors-happy', SEMANTIC_TABLE);
    const chunks = kb.listChunks();
    expect(await kb.syncVectors(NOW_MS)).toMatchObject({
      status: 'ok',
      model: FIXTURE_MODEL,
      pending: chunks.length,
      written: chunks.length,
      removed: 0,
      dim: 2,
    });
    expect(vectorCount(db)).toBe(chunks.length);
    expect(embed?.calls).toHaveLength(1);
    // 一条切片一次 HTTP 会让数百条切片变成数百次往返，这里断的就是「一次批量」这件事
    expect(embed?.calls[0]).toHaveLength(chunks.length);

    const target = chunks.find((chunk) => chunk.text.includes('重构'));
    if (target === undefined) throw new Error('语料里没有带「重构」的切片，fixture 失效');
    const stored = db
      .prepare('SELECT model, dim, vec, updated_at FROM kb_vectors WHERE chunk_id = ?')
      .get(target.chunkId) as {
      model: string;
      dim: number;
      vec: unknown;
      updated_at: number;
    };
    expect(stored.model).toBe(FIXTURE_MODEL);
    expect(stored.dim).toBe(2);
    expect(stored.updated_at).toBe(NOW_MS);
    expect(decodeVector(stored.vec)).toEqual([0, 10]);

    expect(await kb.syncVectors(LATER_MS)).toMatchObject({ status: 'ok', pending: 0, written: 0, removed: 0 });
    expect(embed?.calls).toHaveLength(1);
  });

  it('换 embedding 模型即整表作废重算：`model` 是失效判据，不留半新半旧混着算余弦', async () => {
    const dir = tempDir();
    const old = await embedKb(dir, 'resume-vectors-model', SEMANTIC_TABLE);
    await old.kb.syncVectors(NOW_MS);
    const before = vectorCount(old.db);
    expect(before).toBeGreaterThan(0);

    const fresh = await boot(dir, undefined, undefined, {
      available: true,
      model: 'another-model',
      table: SEMANTIC_TABLE,
    });
    expect(await fresh.kb.syncVectors(LATER_MS)).toMatchObject({ status: 'ok', removed: before, written: before });
    const models = fresh.db
      .prepare('SELECT DISTINCT model FROM kb_vectors ORDER BY model')
      .all() as unknown as readonly {
      model: string;
    }[];
    expect(models.map((row) => row.model)).toEqual(['another-model']);
  });

  it('编码中途失败（超时）：返回 `failed`、`written: 0`，表里一个 BLOB 都没有（4.3-08 的判据）', async () => {
    const { kb, embed, db } = await embedKb(tempDir(), 'resume-vectors-fail', SEMANTIC_TABLE);
    if (embed === undefined) throw new Error('向量替身未挂载');
    const pending = chunkCount(db);
    embed.failWith = 'timeout';
    expect(await kb.syncVectors(NOW_MS)).toMatchObject({
      status: 'failed',
      pending,
      written: 0,
      removed: 0,
      dim: null,
    });
    expect(vectorCount(db)).toBe(0);
    expect(embed.calls).toHaveLength(1);
  });

  it('向量跟着切片一起收敛：改正文即删旧向量、删实体与区块重建都不留孤儿行（4.3-11 延伸到向量表）', async () => {
    const { kb, doc, db } = await embedKb(tempDir(), 'resume-vectors-hygiene', SEMANTIC_TABLE);
    await kb.syncVectors(NOW_MS);
    const before = kb.listChunks();
    expect(vectorCount(db)).toBe(before.length);

    const editable = before.find((chunk) => chunk.chunkKind === 'entity');
    if (editable === undefined) throw new Error('语料里没有实体级切片');
    kb.update(editable.chunkId, { text: '改了正文，旧向量就不再同源了' }, LATER_MS);
    expect(vectorCount(db)).toBe(before.length - 1);

    // 新建的切片**不自动补向量**：补建要出网，只能是显式动作（4.3-04 的离线冒烟靠这一条成立）
    const created = kb.create({ kind: 'achievement', payload: { text: '订单中心的对账流程治理' } }, LATER_MS);
    expect(vectorCount(db)).toBe(before.length - 1);
    expect(orphanVectorCount(db)).toBe(0);
    expect(await kb.syncVectors(LATER_MS)).toMatchObject({ status: 'ok', pending: 2, written: 2 });

    kb.remove(created.entityId, LATER_MS);
    expect(orphanVectorCount(db)).toBe(0);

    // 把工作副本里的经历删光再同步：区块级切片重建要连带删掉它们的向量行
    const parsed = parseResumeText(RESUME_MD_SKILLS_ONLY, 'resume-vectors-hygiene', LATER_MS);
    if (parsed.status !== 'ok') throw new Error('精简语料解析失败');
    doc.save(parsed.document);
    kb.sync('resume-vectors-hygiene', LATER_MS);
    expect(orphanVectorCount(db)).toBe(0);
    expect(vectorCount(db)).toBeLessThan(before.length);
  });

  it('检索四态之 `failed`：查询侧编码失败就退回纯词面，命中与没有向量腿时逐字段相等', async () => {
    const dir = tempDir();
    const seeded = await embedKb(dir, 'resume-rrf-failed', SEMANTIC_TABLE);
    await seeded.kb.syncVectors(NOW_MS);
    if (seeded.embed === undefined) throw new Error('向量替身未挂载');
    seeded.embed.failWith = 'timeout';

    const plain = await boot(dir);
    const lexical = await plain.kb.search('订单');
    const degraded = await seeded.kb.search('订单');
    expect(degraded.vectorStatus).toBe('failed');
    expect(degraded.status).toBe('ok');
    expect(degraded.hits).toEqual(lexical.hits);
  });

  it('融合会改变名次：语义最近的那条升到首位，而每条命中的词面读数原样保留（spec 4.3-07）', async () => {
    const dir = tempDir();
    const seeded = await embedKb(dir, 'resume-rrf', SEMANTIC_TABLE);
    await seeded.kb.syncVectors(NOW_MS);
    const plain = await boot(dir);
    const lexical = await plain.kb.search('订单');
    expect(lexical.hits.length).toBeGreaterThan(1);

    const fused = await seeded.kb.search('订单');
    expect(fused.vectorStatus).toBe('ok');
    expect(fused.hits[0]?.text).toContain('发布流水线');
    expect(fused.hits[0]?.reasons).toContain('vector');
    expect(fused.hits[0]?.vectorScore).toBeGreaterThan(0.9);
    // 词面腿的第一名（那条「主导订单服务重构」）在融合后掉到了后面——这就是「融合优于纯 BM25」的机制证据
    const lexicalFirst = lexical.hits[0];
    if (lexicalFirst === undefined) throw new Error('词面基线没有命中');
    expect(lexicalFirst.text).not.toContain('发布流水线');
    expect(fused.hits.findIndex((hit) => hit.chunkId === lexicalFirst.chunkId)).toBeGreaterThan(0);
    // 融合只改次序、不改读数：同一条切片在两次的三个词面读数必须完全一致
    for (const hit of lexical.hits) {
      const merged = fused.hits.find((candidate) => candidate.chunkId === hit.chunkId);
      expect(merged?.score).toBe(hit.score);
      expect(merged?.bm25Score).toBe(hit.bm25Score);
      expect(merged?.lexicalScore).toBe(hit.lexicalScore);
    }
  });

  it('只被语义捞到的切片也能进结果：查询「比赛」与库内「竞赛」没有任何共用 token，词面腿 0 命中', async () => {
    const dir = tempDir();
    const seeded = await embedKb(dir, 'resume-rrf-semantic', { 竞赛: [1, 0], 比赛: [1, 0] });
    await seeded.kb.syncVectors(NOW_MS);

    const plain = await boot(dir);
    expect((await plain.kb.search('比赛')).hits).toEqual([]);

    const result = await seeded.kb.search('比赛');
    expect(result.vectorStatus).toBe('ok');
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every((hit) => hit.text.includes('竞赛'))).toBe(true);
    expect(result.hits.every((hit) => hit.reasons.includes('vector'))).toBe(true);
    // 词面分为 0 也照样进结果：`minScore` 是词面腿的门槛，不许拿来挡语义命中（plan §4.3-d 的落地更正）
    expect(result.hits.every((hit) => hit.score === 0)).toBe(true);
  });

  it('向量下限来自配置：0.35 挡掉「词面强但语义远」的那条，放到 0.05 就让它进向量名单（4.3-03）', async () => {
    const dir = tempDir();
    const seeded = await embedKb(dir, 'resume-rrf-threshold', SEMANTIC_TABLE);
    await seeded.kb.syncVectors(NOW_MS);

    const strict = await seeded.kb.search('订单');
    const strictVectorHits = strict.hits.filter((hit) => hit.reasons.includes('vector'));
    expect(strictVectorHits.length).toBeGreaterThan(0);
    expect(strictVectorHits.every((hit) => hit.text.includes('发布流水线'))).toBe(true);

    const lenient = await boot(
      dir,
      undefined,
      { vectorMinCosine: 0.05 },
      { available: true, model: FIXTURE_MODEL, table: SEMANTIC_TABLE },
    );
    const relaxed = await lenient.kb.search('订单');
    expect(relaxed.hits.some((hit) => hit.reasons.includes('vector') && hit.text.includes('重构'))).toBe(true);
  });

  it('补建向量在 agent 工具面登记为 `outbound` + 需确认：把简历正文交给外部端点不是读操作', async () => {
    const { tools } = await syncedKb(tempDir(), RESUME_MD, 'resume-vectors-tool');
    const tool = tools.declarations.get('kb.profile.syncVectors');
    if (tool === undefined) throw new Error('kb.profile.syncVectors 未登记进 agent 工具面');
    expect(tool.effect).toBe('outbound');
    expect(tool.requiresConfirmation).toBe(true);
    expect(tool.input.safeParse({}).success).toBe(true);
    expect(tool.input.safeParse({ docId: 'anything' }).success).toBe(false);
  });
});

describe('零上行审计（spec 4.2-07：知识库数据全本地）', () => {
  /**
   * 结构面：整包源码里不允许出现任何网络能力的入口。
   *
   * Node 内置模块的 ESM 命名空间是只读的（`http.request` 改不动），所以运行期想靠打桩覆盖全部通道做不到；
   * 与其留一个假的安全感，不如把「这个包根本不 import 网络模块」变成断言——它是永久机检，不是一次快照。
   */
  it('包内没有任何网络模块入口（node:http/https/net/dns/tls/dgram、fetch、WebSocket、第三方 http 客户端）', () => {
    const forbidden = [
      /node:(http|https|net|dns|tls|dgram)\b/,
      /\bfetch\s*\(/,
      /\bWebSocket\b/,
      /\bXMLHttpRequest\b/,
      /\b(undici|axios|got|superagent|node-fetch)\b/,
    ];
    const offenders: string[] = [];
    for (const file of readdirSync(import.meta.dirname)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      for (const pattern of forbidden) {
        if (pattern.test(text)) offenders.push(`${file} 命中 ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('运行期把 fetch / WebSocket / XHR 换成计数存根后，读+同步+增删改+反查+检索+向量补建+备份全链路零调用', async () => {
    const { kb, tools, db } = await seededKb(tempDir());
    const docId = kb.list()[0]?.sourceDocId;
    if (typeof docId !== 'string') throw new Error('种子库里没有派生实体，sync 路径没被覆盖');
    const backupPath = join(tempDir(), 'kb-zero-uplink.json');

    const uplink: string[] = [];
    const globalChannels = globalThis as { WebSocket?: unknown; XMLHttpRequest?: unknown };
    const original = {
      fetch: globalThis.fetch,
      webSocket: globalChannels.WebSocket,
      xhr: globalChannels.XMLHttpRequest,
    };
    globalThis.fetch = (url: unknown) => {
      uplink.push(`fetch ${String(url)}`);
      return Promise.resolve(new Response('{}'));
    };
    globalChannels.WebSocket = class {
      constructor() {
        uplink.push('WebSocket');
      }
    };
    globalChannels.XMLHttpRequest = class {
      open() {
        uplink.push('XMLHttpRequest.open');
      }
    };

    try {
      expect(kb.list({ kind: 'experience' }).length).toBeGreaterThan(0);
      expect(kb.evidenceFor('主导订单服务重构').length).toBeGreaterThan(0);
      // 4.3-b 的检索入口也在同一条存根下跑一遍：它新引入了 FTS5 查询与 `instr` 全表扫，
      // 但读的全是本地库文件，一条网络语句都不该有（spec 4.2-07 / 4.3-05 的「零上行」延伸到检索）。
      expect((await kb.search('订单')).hits.length).toBeGreaterThan(0);
      // 4.3-d 的向量补建是本包唯一的出网入口：`llm.embed` 没挂载时它必须原样返回「未配置」，
      // 既不发起请求，也不留下任何 BLOB（spec 4.3-04 的离线冒烟 + 4.3-08 的零写入判据）。
      expect(await kb.syncVectors(LATER_MS)).toMatchObject({ status: 'unavailable', written: 0 });
      expect(vectorCount(db)).toBe(0);
      const created = kb.create({ kind: 'skill', payload: { name: 'Kafka' } }, NOW_MS);
      kb.update(created.entityId, { name: 'Kafka / 消息队列' }, LATER_MS);
      kb.sync(docId, LATER_MS);
      kb.exportBackup(backupPath, LATER_MS);
      kb.importBackup(backupPath, 'skip');
      expect(kb.remove(created.entityId).removed).toBe(1);
      // agent 工具面走的是同一个入口，所以它也得在这套存根下跑一遍。
      const tool = tools.declarations.get('kb.profile.list');
      if (tool === undefined) throw new Error('kb.profile.list 未登记进 agent 工具面');
      await tool.run({});
    } finally {
      globalThis.fetch = original.fetch;
      globalChannels.WebSocket = original.webSocket;
      globalChannels.XMLHttpRequest = original.xhr;
    }

    expect(uplink).toEqual([]);
  });
});

describe('日志脱敏：检索与派生日志不落正文与 PII（4.3-e / spec 4.3-12）', () => {
  /**
   * 语料里出现的原文哨兵（正文短语 + 姓名 + 手机号）。
   *
   * 前三条同时也是「会被检索命中的内容」，后两条是 PII（对齐 4.1-09 / §8.5 的口径：
   * 派生表里只放结构化字段，原文不外溢到日志）。查询原文与切片正文共用同一串是**有意的**：
   * 一条断言就同时锁死「不记查询原文」和「不记命中内容」两件事，
   * 比 spec 的「只记查询与命中 id」更严（plan §4.3-e 的口径：计数行足够排障，原文没有必要）。
   */
  const RAW_TEXT_SENTINELS = ['主导订单服务重构', 'P99 延迟下降 40%', '沧海数据', '张三', '13800001111'];

  it('五条写路径 + 检索 + 反查跑完后，日志有计数行而查不到任何原文哨兵', async () => {
    const dir = tempDir();
    const booted = await syncedKb(dir, RESUME_MD, 'resume-log');
    const { kb } = booted;
    const logFile = asApp(booted.ctx).log.filePath;
    if (logFile === undefined) throw new Error('日志服务未落盘，4.3-12 无处可断');

    // 检索与反查都要真的命中，否则「日志里没有正文」可能只是「什么都没发生」。
    const searchResult = await kb.search('主导订单服务重构');
    expect(searchResult.hits.length).toBeGreaterThan(0);
    expect(kb.evidenceFor('主导订单服务重构').length).toBeGreaterThan(0);

    // 其余四条写路径按 4.2 的装配顺序扫一遍：新建 → 改 → 同步 → 导出 → 导入 → 删除。
    const created = kb.create({ kind: 'skill', payload: { name: 'Kafka' } }, NOW_MS);
    kb.update(created.entityId, { name: 'Kafka / 消息队列' }, LATER_MS);
    kb.sync('resume-log', LATER_MS);
    const backupPath = join(tempDir(), 'kb-log.json');
    kb.exportBackup(backupPath, LATER_MS);
    kb.importBackup(backupPath, 'skip');
    expect(kb.remove(created.entityId).removed).toBe(1);

    // `remove` 是本用例最后一条会写日志的操作，等到它即等到全部。
    const logText = await waitForLogLine(logFile, '删除手工实体');

    // —— 正向半边：检索计数行确实存在，用例不是靠「日志压根没写」通过的 ——
    expect(logText).toMatch(
      /\[kb-profile\] 检索 \d+ 个 token \/ \d+ 条候选 → \d+ 条命中（\w+ · 向量腿 \w+ \/ 语义名单 \d+ 条）/,
    );
    expect(logText).toContain('同步 resume-log：派生');

    const leaks = RAW_TEXT_SENTINELS.filter((sentinel) => logText.includes(sentinel));
    expect(leaks).toEqual([]);
  });

  it('向量腿失败与退库路径也不带切片正文（warn 分支同样只记计数与原因）', async () => {
    const dir = tempDir();
    const booted = await syncedKb(dir, RESUME_MD, 'resume-log-vector', undefined, undefined, {
      available: true,
      model: 'bge-m3',
      table: { 订单: [1, 0] },
    });
    const { kb } = booted;
    const embed = booted.embed;
    if (embed === undefined) throw new Error('向量替身没挂上，本用例退不出 `failed` 分支');
    const logFile = asApp(booted.ctx).log.filePath;
    if (logFile === undefined) throw new Error('日志服务未落盘，4.3-12 无处可断');

    // 先补建（fixture 表里只有「订单」这个片段，所以只有含它的切片会写向量），
    // 再让检索走一趟正常融合；最后把存根打成超时，逼出 `warn` 那条退回纯词面的分支。
    await kb.syncVectors(NOW_MS);
    expect((await kb.search('订单')).hits.length).toBeGreaterThan(0);
    embed.failWith = 'timeout';
    const failed = await kb.search('主导订单服务重构');
    expect(failed.vectorStatus).toBe('failed');

    const logText = await waitForLogLine(logFile, '退回纯词面检索');
    expect(logText).toMatch(/向量编码失败/);
    const leaks = RAW_TEXT_SENTINELS.filter((sentinel) => logText.includes(sentinel));
    expect(leaks).toEqual([]);
  });
});
