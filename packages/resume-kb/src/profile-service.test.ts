/**
 * `kb.profile` 的装配用例（spec 4.2-01 / 4.2-02 / 4.2-03 / 4.2-04 / 4.2-08）。
 *
 * 打**真的 `node:sqlite` + 真临时目录**（AGENTS.md §7.5，产物不进仓库）：这一层要证明的是
 * 「派生出来的实体真的落了库、重复同步不裂行、工作副本改了之后库跟着收敛、删除与备份的计数对得上」，
 * 这些只有在真库里才成立。派生规则本身在 `entities.test.ts` 里逐条断言过，这里不重复。
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { KB_BACKUP_SCHEMA_VERSION } from './backup.js';
import { KB_PROFILE_MIGRATION_VERSION, KbProfileService } from './profile-service.js';
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
  it('挂载即建 kb_entities 表，迁移号段为 11', async () => {
    const { db } = await boot();
    expect(tableExists(db, 'kb_entities')).toBe(true);
    expect(KB_PROFILE_MIGRATION_VERSION).toBe(11);
  });

  it('迁移号段不复用任何已分配号段（撞号的表现是「见号已存在就跳过建表」，表根本没建）', () => {
    // 已分配：账本 1 / agent 会话 2 / jobs 3 / workflow run 4 / conversation 5 / consent 6 /
    // resume_docs 7 / resume_snapshots 8 / delivery_records 9 / resume_imports 10。
    const taken = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(taken.has(KB_PROFILE_MIGRATION_VERSION)).toBe(false);
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
 * 反查的接线用例（spec 4.2-03）。
 *
 * 算法本身在 `evidence.test.ts` 里逐条断言过，这里只验三件**只有装配起来才成立**的事：
 * 候选确实来自库里那些行、阈值确实读的是配置而不是写死在函数里、手工实体也在候选范围内。
 * @param dir 本次用的临时目录（每个用例独立一份库）
 * @param evidence 反查阈值
 * @returns 已同步好实体的 `kb.profile` 与文档存储服务
 */
async function seededKb(dir: string, evidence?: { topK: number; minScore: number }) {
  const booted = await boot(dir, evidence);
  const parsed = parseResumeText(RESUME_MD, 'resume-evidence', NOW_MS);
  if (parsed.status !== 'ok') throw new Error(`语料解析失败：${parsed.status}`);
  booted.doc.save(parsed.document);
  booted.kb.sync('resume-evidence', NOW_MS);
  return booted;
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
    expect(entityCount(db)).toBe(0);
    expect(kb.get(goodId)).toBeNull();
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
