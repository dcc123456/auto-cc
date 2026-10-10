/**
 * 「删掉一份简历连同它的素材」的**装配与 IPC 面**对账（spec 4.1-14 的接线半边，plan 04 §4.7 的 60-c）。
 *
 * 为什么住在 `packages/main`（与 `editor-link.ts` / `generate-link.test.ts` 同一个理由）：
 * 这条腿横跨四个包——白名单与 `BridgeCalls` 在 `shared`、`removeDoc` 的编排在 `resume-kb`、被它硬注入的
 * `resume.snapshot` / `resume.parse` 分属两个包、`cordis.yml` 在仓库根。包内用例只判删除语义本体，
 * 判不了「界面按下去到底调不调得到」这一类只在真装配里才成立的缺陷。
 *
 * 四件事在这里钉住：
 * 1. **顺序**：`resume-snapshot` 与 `resume-parse` 排在 `kb-profile` **之前**。加了硬注入而清单顺序写反，
 *    表现是整只 `kb.profile` PENDING（§9 的 5.1-c），而单测把替身挂前面永远看不见。
 * 2. **切得对**：白名单那一条切成服务 `kb.profile` + 方法 `removeDoc`，且这个方法在挂起来的实例上真是函数；
 *    同时**没有**给渲染层开 `resume.doc.remove` 那类单表口——六个表各自删一半是界面最难解释的脏。
 * 3. **经网关删得动**：`resolveCall(...).invoke(docId)` 的回执逐表计数与库里少掉的行逐条相等。
 * 4. **审计保留**（裁定㉖）：`resume_generations` 那一行**不跟着删**——花过 token 是既成事实，
 *    台账与生成记录由别的包 own，删除腿碰不到它们。
 *
 * 语料是写在临时目录里的虚构中文简历（§7.2 不碰真实平台，§7.5 产物不落进仓库）。
 */
import { asApp, Context, type Fiber } from '@auto-cc/core';
import { AgentToolsService } from '@auto-cc/plugin-agent';
import { ConfigService } from '@auto-cc/plugin-config';
import { LogService } from '@auto-cc/plugin-logger';
import { resolveCall } from '@auto-cc/plugin-ipc';
import {
  KbGapService,
  kbGapSchema,
  KbProfileService,
  kbProfileSchema,
  ResumeGenerateService,
  kbGenerateSchema,
  ResumeParseService,
  resumeParseSchema,
} from '@auto-cc/plugin-resume-kb';
import { resumePrint, ResumeDocService, ResumeSnapshotService } from '@auto-cc/plugin-resume-doc';
import { StoreService } from '@auto-cc/plugin-store';
import { RENDERER_ALLOWLIST, isAllowedCall, type RemoveDocReceiptView } from '@auto-cc/shared';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

/** 导入用的虚构简历正文（两段经历 + 技能，够 4.1-03 的正文下限）。 */
const RESUME_MD = [
  '林可',
  '电话：13800003333',
  '',
  '## 工作经历',
  '星桥科技｜后端工程师 2021.03-2024.06',
  '- 主导订单服务重构，P99 延迟下降 40%。',
  '',
  '沧海数据｜架构师 2024.07至今',
  '- 把发布流水线从 40 分钟压到 6 分钟，并负责容量规划与灰度发布。',
  '',
  '## 技能',
  '- TypeScript、Node.js、Go、Kubernetes、PostgreSQL、Redis、Kafka',
  '- 分布式一致性、性能剖析、容量规划、链路追踪、成本治理',
].join('\n');

/** 生成腿要的 JD 正文（虚构）。 */
const JD_TEXT = '后端工程师（虚构：南汇云图）：负责交易链路的 Java 与 Go 服务，熟悉 Kafka；要求 5 年以上经验。';

const AS_OF_MS = new Date(2026, 9, 15, 12).getTime();
const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/**
 * 撑起「config + log + store + 简历三件套 + 知识库 + 缺口腿 + 生成腿 + 真工具注册表」的装配。
 *
 * 挂载顺序照 `cordis.yml`：`agent` 在能力包之前（工具登记是软取），`resume-snapshot` / `resume-parse`
 * 在 `kb-profile` 之前（它硬注入这两只，挂晚了整只服务 PENDING）。
 * @returns 应用句柄、按名查找口（网关用的那一种）与这份装配的临时目录
 */
async function bootAssembly() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-resume-remove-link-'));
  sandboxes.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(LogService, { level: 'info', buffer: 200, file: 'auto-cc.log', dir, redact: false }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(ResumeDocService, {}));
  fibers.push(await ctx.plugin(ResumeSnapshotService, { maxSnapshots: 20 }));
  fibers.push(await ctx.plugin(ResumeParseService, resumeParseSchema.parse({})));
  fibers.push(await ctx.plugin(KbProfileService, kbProfileSchema.parse({})));
  fibers.push(await ctx.plugin(AgentToolsService, {}));
  fibers.push(await ctx.plugin(KbGapService, kbGapSchema.parse({})));
  fibers.push(await ctx.plugin(ResumeGenerateService, kbGenerateSchema.parse({})));
  const app = asApp(ctx);
  return {
    app,
    db: app.store.db,
    dir,
    lookup: (name: string) => {
      try {
        return ctx.get(name) as object;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * 导入一份真文件并把素材长齐：出处行、工作副本、派生实体、切片、两条快照。
 * @param app 装配句柄
 * @param dir 落样例文件用的临时目录（`fromFile` 要真实路径）
 * @param name 文件名（同时是 `resume_imports.source_name` 的来源）
 * @returns 本次导入的 docId
 */
async function importAndIndex(
  app: Awaited<ReturnType<typeof bootAssembly>>['app'],
  dir: string,
  name: string,
): Promise<string> {
  const filePath = join(dir, name);
  writeFileSync(filePath, RESUME_MD, 'utf8');
  const receipt = await app['resume.parse'].fromFile(filePath, AS_OF_MS);
  if (receipt.status !== 'imported') throw new Error(`样例应该导入成功，实际是 ${receipt.status}`);
  app['kb.profile'].sync(receipt.docId, AS_OF_MS);
  const loaded = app['resume.doc'].load(receipt.docId);
  if (loaded.status !== 'found') throw new Error(`导入后读不回工作副本：${loaded.status}`);
  app['resume.snapshot'].record(loaded.document, 'classic', resumePrint.fontSet, AS_OF_MS);
  app['resume.snapshot'].record(loaded.document, 'dense', resumePrint.fontSet, AS_OF_MS + 1000);
  return receipt.docId;
}

/**
 * 一份简历在各张表里剩下的行数（逐表读，不看界面回执）。
 * @param db 真 sqlite 连接
 * @param docId 哪一份简历
 * @returns 六格读数（`kb_chunks_fts` / `kb_vectors` 是派生索引，由包内用例的孤儿判据管）
 */
function footprint(db: DatabaseSync, docId: string) {
  const count = (sql: string): number => Number((db.prepare(sql).get(docId) as { total?: number | bigint }).total ?? 0);
  return {
    document: count('SELECT COUNT(*) AS total FROM resume_docs WHERE id = ?'),
    snapshots: count('SELECT COUNT(*) AS total FROM resume_snapshots WHERE doc_id = ?'),
    imports: count('SELECT COUNT(*) AS total FROM resume_imports WHERE doc_id = ?'),
    entities: count('SELECT COUNT(*) AS total FROM kb_entities WHERE source_doc_id = ?'),
    chunks: count('SELECT COUNT(*) AS total FROM kb_chunks WHERE source_doc_id = ?'),
  };
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  // 日志写流是异步开文件的（同 `generate-link.test.ts`）：不等一下就删目录会冒出收尾后的 ENOENT。
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不该把一次通过的验收判成失败。
    }
  }
});

describe('清单顺序与白名单形状（4.1-14 的接线半边）', () => {
  it('`resume-snapshot` 与 `resume-parse` 排在 `kb-profile` 之前，删腿要的注入才拿得到', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const cordisYml = readFileSync(join(here, '../../../cordis.yml'), 'utf8');
    const indexOf = (id: string): number => cordisYml.indexOf(`\n  - id: ${id}\n`);
    expect(indexOf('resume-snapshot')).toBeGreaterThan(-1);
    expect(indexOf('resume-parse')).toBeGreaterThan(-1);
    expect(indexOf('kb-profile')).toBeGreaterThan(-1);
    // 顺序写反在包内用例里看不出来（fixture 都把替身挂前面），真 app 里表现为整只知识库服务缺席。
    expect(indexOf('kb-profile')).toBeGreaterThan(indexOf('resume-snapshot'));
    expect(indexOf('kb-profile')).toBeGreaterThan(indexOf('resume-parse'));
  });

  it('白名单里只有 `kb.profile.removeDoc` 这一只删除手，渲染层拿不到任何单表删除口', () => {
    expect(RENDERER_ALLOWLIST.filter((id) => id.endsWith('removeDoc'))).toEqual(['kb.profile.removeDoc']);
    expect(isAllowedCall('kb.profile.removeDoc')).toBe(true);
    // 六张表各开一口就是"文档没了但素材还在"的半删；这三条必须是禁的（§2.5 一个入口）。
    expect(isAllowedCall('resume.doc.remove')).toBe(false);
    expect(isAllowedCall('resume.snapshot.removeAllForDoc')).toBe(false);
    expect(isAllowedCall('resume.parse.removeForDoc')).toBe(false);
  });
});

describe('经网关删得动，且回执的每个数都来自库', () => {
  it('`kb.profile.removeDoc` 切成服务与方法，方法在挂起来的实例上真是函数', async () => {
    const { lookup } = await bootAssembly();
    const resolution = resolveCall('kb.profile.removeDoc', lookup);
    expect(resolution).toMatchObject({ ok: true, service: 'kb.profile', method: 'removeDoc' });
    if (!resolution.ok) throw new Error('分派失败');
    const kb = lookup('kb.profile') as KbProfileService;
    expect(kb).toBeInstanceOf(KbProfileService);
    expect(typeof (kb as unknown as Record<string, unknown>)[resolution.method]).toBe('function');
  });

  it('走网关删一份真导入的简历：回执逐表计数与库里少掉的行逐条相等，删完无处可寻', async () => {
    const assembly = await bootAssembly();
    const docId = await importAndIndex(assembly.app, assembly.dir, '林可-简历.md');
    const before = footprint(assembly.db, docId);
    expect(before).toMatchObject({ document: 1, snapshots: 2, imports: 1 });
    expect(before.entities).toBeGreaterThan(0);
    expect(before.chunks).toBeGreaterThan(0);

    const resolution = resolveCall('kb.profile.removeDoc', assembly.lookup);
    if (!resolution.ok) throw new Error('分派失败');
    const receipt = resolution.invoke(docId) as RemoveDocReceiptView;
    // 回执就是库里少掉的那些行：界面那句成功文案的数字全部由服务给，渲染层不自己数（§2.5）。
    expect(receipt).toEqual({ docId, ...before, detached: 0 });
    expect(footprint(assembly.db, docId)).toEqual({
      document: 0,
      snapshots: 0,
      imports: 0,
      entities: 0,
      chunks: 0,
    });
  });

  it('库里没有这份文档时不抛错：回执逐表为 0，界面据读数说一句人话', async () => {
    const { db, lookup } = await bootAssembly();
    const resolution = resolveCall('kb.profile.removeDoc', lookup);
    if (!resolution.ok) throw new Error('分派失败');
    expect(resolution.invoke('resume-库里从来没有')).toEqual({
      docId: 'resume-库里从来没有',
      document: 0,
      snapshots: 0,
      imports: 0,
      entities: 0,
      chunks: 0,
      detached: 0,
    });
    expect(footprint(db, 'resume-库里从来没有').document).toBe(0);
  });
});

describe('审计事实不跟着删（裁定㉖ 的第 1 条）', () => {
  it('删掉简历之后 `resume_generations` 那一行还在：花过的 token 是既成事实', async () => {
    const assembly = await bootAssembly();
    const docId = await importAndIndex(assembly.app, assembly.dir, '林可-带生成.md');
    // 没挂 `llm.chat`，所以这一条走 4.5-09 的仅重排保守版——但记录照样落一行，正是审计要的形态。
    await assembly.app['resume.generate'].run(JD_TEXT, { docId, jdId: 'jd-remove-link-1' }, AS_OF_MS);
    const generations = Number(
      (
        assembly.db.prepare('SELECT COUNT(*) AS total FROM resume_generations WHERE doc_id = ?').get(docId) as {
          total: number | bigint;
        }
      ).total,
    );
    expect(generations).toBe(1);

    assembly.app['kb.profile'].removeDoc(docId, AS_OF_MS);

    expect(footprint(assembly.db, docId)).toMatchObject({ document: 0, entities: 0, chunks: 0 });
    expect(
      Number(
        (
          assembly.db.prepare('SELECT COUNT(*) AS total FROM resume_generations WHERE doc_id = ?').get(docId) as {
            total: number | bigint;
          }
        ).total,
      ),
    ).toBe(1);
  });
});
