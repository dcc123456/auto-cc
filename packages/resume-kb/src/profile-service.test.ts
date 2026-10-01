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
  type AgentToolDeclaration,
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
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { KB_BACKUP_SCHEMA_VERSION } from './backup.js';
import { deriveSectionChunks, entityChunkOf, indexTokens } from './chunks.js';
import { KB_CHUNKS_MIGRATION_VERSION, KB_PROFILE_MIGRATION_VERSION, KbProfileService } from './profile-service.js';
import { ResumeParseService } from './parse-service.js';
import { parseResumeText } from './sections.js';

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
 * 假的 `agent.tools`（裁定三的单测替身）。
 *
 * 与 `packages/browser/src/test-doubles.ts` 里那份同款，理由也一样：注册表属于 L3 对话插件，
 * 本包（L2）连测试都不该 import 它，而跨包共享一个替身要新建一个包（§4.3 得先在 plan 里记理由）。
 */
class FakeAgentToolsService extends Service {
  static provide = 'agent.tools';
  static Config = z.strictObject({});

  /** 收到的声明，迭代序即登记顺序。 */
  readonly declarations = new Map<string, AgentToolDeclaration>();

  constructor(ctx: Context) {
    super(ctx, 'agent.tools');
  }

  /** 契约见 `AgentToolRegistry.register`。 */
  register<I>(tool: AgentToolDeclaration<I>): void {
    this.declarations.set(tool.id, tool);
  }

  /** 契约见 `AgentToolRegistry.unregister`。 */
  unregister(id: string): boolean {
    return this.declarations.delete(id);
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

/**
 * 挂起 config + log + store + resume.doc + kb.profile（外加 `resume.parse`，端到端那条用例要用）。
 * @param dir 复用哪个目录
 * @param evidence 反查阈值（4.2-03）；默认与 `cordis.yml` 一致，用于验证「阈值来自配置」那两条用例
 * @returns 实体服务、文档存储服务、导入服务与裸连接
 */
async function boot(dir = tempDir(), evidence: { topK: number; minScore: number } = { topK: 5, minScore: 0.34 }) {
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(LogService, { level: 'info', buffer: 500, file: 'auto-cc.log', dir, redact: false }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  // 注册表先于本包上岗：`registerAgentTools` 是软取，晚挂载就只能登记出 0 个工具。
  fibers.push(await ctx.plugin(FakeAgentToolsService, NO_CONFIG));
  fibers.push(await ctx.plugin(ResumeDocService, {}));
  fibers.push(
    await ctx.plugin(KbProfileService, {
      evidenceTopK: evidence.topK,
      evidenceMinScore: evidence.minScore,
    }),
  );
  fibers.push(await ctx.plugin(ResumeParseService, { maxBytes: 5_242_880 }));
  const app = asApp(ctx);
  return {
    ctx,
    tools: ctx.get('agent.tools') as unknown as FakeAgentToolsService,
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

/** 表是否存在（回滚用例的判据）。 */
function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) as
    { name?: string } | undefined;
  return row?.name === name;
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
  it('挂载即建 kb_entities / kb_chunks 表，迁移号段为 11 / 12', async () => {
    const { db } = await boot();
    expect(tableExists(db, 'kb_entities')).toBe(true);
    expect(tableExists(db, 'kb_chunks')).toBe(true);
    expect(KB_PROFILE_MIGRATION_VERSION).toBe(11);
    expect(KB_CHUNKS_MIGRATION_VERSION).toBe(12);
  });

  it('迁移号段不复用任何已分配号段（撞号的表现是「见号已存在就跳过建表」，表根本没建）', () => {
    // 已分配：账本 1 / agent 会话 2 / jobs 3 / workflow run 4 / conversation 5 / consent 6 /
    // resume_docs 7 / resume_snapshots 8 / delivery_records 9 / resume_imports 10 / kb_entities 11。
    const taken = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(taken.has(KB_PROFILE_MIGRATION_VERSION)).toBe(false);
    expect(new Set([...taken, KB_PROFILE_MIGRATION_VERSION]).has(KB_CHUNKS_MIGRATION_VERSION)).toBe(false);
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

  it('切片表能单独倒回去：回滚 12 只删 `kb_chunks`，实体表与它的数据原样留着（spec 4.3-11 的 down 半边）', async () => {
    const { kb, doc, store, db } = await boot();
    const parsed = parseResumeText(RESUME_MD, 'resume-rollback-chunks', NOW_MS);
    if (parsed.status !== 'ok') throw new Error('样例简历解析失败');
    doc.save(parsed.document);
    kb.sync('resume-rollback-chunks', NOW_MS);
    expect(chunkCount(db)).toBeGreaterThan(0);

    const result = store.rollback(KB_PROFILE_MIGRATION_VERSION);
    expect(result.reverted).toEqual([KB_CHUNKS_MIGRATION_VERSION]);
    expect(tableExists(db, 'kb_chunks')).toBe(false);
    // 派生索引删掉了，真相还在：实体表一行不少，重新挂载就能按实体补建回来（下面有用例判这条）。
    expect(tableExists(db, 'kb_entities')).toBe(true);
    expect(entityCount(db)).toBe(7);
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
 * @returns 装配好的服务与裸连接
 */
async function syncedKb(dir: string, corpus: string, docId: string, evidence?: { topK: number; minScore: number }) {
  const booted = await boot(dir, evidence);
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

  it('运行期把 fetch / WebSocket / XHR 换成计数存根后，读+同步+增删改+反查+备份全链路零调用', async () => {
    const { kb, tools } = await seededKb(tempDir());
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
