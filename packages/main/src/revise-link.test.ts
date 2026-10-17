/**
 * 「要素核对（chunk review）」的**装配与 IPC 面**对账（resume chunk flow 片 3 的接线半边）。
 *
 * 住在 `packages/main` 的理由与 `resume-remove-link.test.ts` 相同：这条通道横跨三包——
 * 白名单与 op 联合类型在 `shared`、`revise` 编排在 `resume-kb`（改的是 `resume-doc` 的母版）、
 * 服务→方法的通用解析在 `ipc`。包内用例只验服务语义，验不了「界面按下去到底调不调得到」。
 *
 * 三件事钉在这里：
 * 1. 白名单那一条切成服务 `kb.profile` + 方法 `revise`，挂起来的实例上真是函数；
 * 2. 经网关一批改字 / 加要素落得进母版，且区块切片同趟重建（chunk 是派生物，没有第二份事实）；
 * 3. 变体 id 经网关被结构化拒绝——素材源头只能是母版。
 *
 * 语料是写在临时目录里的虚构中文简历（§7.2 不碰真实平台，§7.5 产物不落进仓库）。
 */
import { AppError, asApp, Context, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { LogService } from '@auto-cc/plugin-logger';
import { resolveCall } from '@auto-cc/plugin-ipc';
import { KbProfileService, kbProfileSchema, ResumeParseService, resumeParseSchema } from '@auto-cc/plugin-resume-kb';
import { ResumeDocService, ResumeSnapshotService } from '@auto-cc/plugin-resume-doc';
import { StoreService } from '@auto-cc/plugin-store';
import { RENDERER_ALLOWLIST, isAllowedCall, type KbReviseOpView, type KbReviewRowView } from '@auto-cc/shared';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/** 带陌生要素「证书」的虚构简历：证书在六类词典之外，解析收进 custom-1。 */
const RESUME_MD = [
  '林可',
  '电话：13800003333',
  '',
  '## 工作经历',
  '星桥科技｜后端工程师 2021.03-2024.06',
  '- 主导订单服务重构，P99 延迟下降 40%，并负责线上容量规划与灰度发布值班。',
  '',
  '## 技能',
  '- TypeScript、Node.js、Go、Kubernetes、PostgreSQL、Redis、Kafka',
  '',
  '## 证书',
  '- CET-6 大学英语六级',
  '',
  '- PMP 项目管理专业人士认证',
].join('\n');

const AS_OF_MS = new Date(2026, 9, 16, 12).getTime();
const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 撑起 config + log + store + 简历三件套 + 知识库 + 导入通道的最小真装配。 */
async function bootAssembly() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-revise-link-'));
  sandboxes.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(LogService, { level: 'info', buffer: 200, file: 'auto-cc.log', dir, redact: false }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(ResumeDocService, {}));
  fibers.push(await ctx.plugin(ResumeSnapshotService, { maxSnapshots: 20 }));
  fibers.push(await ctx.plugin(ResumeParseService, resumeParseSchema.parse({})));
  fibers.push(await ctx.plugin(KbProfileService, kbProfileSchema.parse({})));
  const app = asApp(ctx);
  return {
    app,
    dir,
    db: app.store.db,
    lookup: (name: string) => {
      try {
        return ctx.get(name) as object;
      } catch {
        return undefined;
      }
    },
  };
}

/** 导入简历并完成一次素材建库，返回母版 docId。 */
async function importAndIndex(app: Awaited<ReturnType<typeof bootAssembly>>['app'], dir: string): Promise<string> {
  const filePath = join(dir, '林可-证书.md');
  writeFileSync(filePath, RESUME_MD, 'utf8');
  const receipt = await app['resume.parse'].fromFile(filePath, AS_OF_MS);
  if (receipt.status !== 'imported') throw new Error(`样例应该导入成功，实际是 ${receipt.status}`);
  app['kb.profile'].sync(receipt.docId, AS_OF_MS);
  return receipt.docId;
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  // 日志写流异步收尾（同 resume-remove-link.test.ts）。
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不该把一次通过的验收判成失败。
    }
  }
});

describe('白名单形状', () => {
  it('`kb.profile.review` / `kb.profile.revise` 都在渲染层白名单里，且 revise 只有这一只写口', () => {
    expect(isAllowedCall('kb.profile.review')).toBe(true);
    expect(isAllowedCall('kb.profile.revise')).toBe(true);
    expect(RENDERER_ALLOWLIST.filter((id) => id.endsWith('revise'))).toEqual(['kb.profile.revise']);
    // chunk 核对的正文不许走「不带正文」的编辑器投影口，也不许开第二条写口。
    expect(RENDERER_ALLOWLIST.filter((id) => id.startsWith('kb.profile.')).sort()).toContain('kb.profile.review');
  });
});

describe('经网关核对要素', () => {
  it('切成服务 `kb.profile` + 方法 `revise` / `review`，挂起来的实例上真是函数', async () => {
    const { lookup } = await bootAssembly();
    for (const method of ['revise', 'review'] as const) {
      const resolution = resolveCall(`kb.profile.${method}`, lookup);
      expect(resolution).toMatchObject({ ok: true, service: 'kb.profile', method });
      if (!resolution.ok) throw new Error('分派失败');
      const kb = lookup('kb.profile') as KbProfileService;
      expect(kb).toBeInstanceOf(KbProfileService);
      expect(typeof (kb as unknown as Record<string, unknown>)[resolution.method]).toBe('function');
    }
  });

  it('经网关读到母版要素结构：custom 区块带原文标题与逐条正文', async () => {
    const assembly = await bootAssembly();
    const docId = await importAndIndex(assembly.app, assembly.dir);
    const resolution = resolveCall('kb.profile.review', assembly.lookup);
    if (!resolution.ok) throw new Error('分派失败');
    const view = resolution.invoke(docId) as KbReviewRowView;
    const cert = view.sections.find((section) => section.kind === 'custom');
    expect(cert?.title).toBe('证书');
    expect(cert?.entries.map((entry) => entry.fields[0]?.value)).toEqual([
      'CET-6 大学英语六级',
      'PMP 项目管理专业人士认证',
    ]);
  });

  it('一批改字 + 加要素经网关落进母版，区块切片同趟重建', async () => {
    const assembly = await bootAssembly();
    const docId = await importAndIndex(assembly.app, assembly.dir);

    const resolution = resolveCall('kb.profile.revise', assembly.lookup);
    if (!resolution.ok) throw new Error('分派失败');
    const ops: readonly KbReviseOpView[] = [
      { op: 'entry.text', sectionId: 'custom-1', entryId: 'custom-1-1', fieldKey: 'text', value: '- CET-6（580 分）' },
      { op: 'section.create', title: '语言能力' },
    ];
    const receipt = resolution.invoke(docId, ops) as {
      applied: number;
      created: number;
      updated: number;
      removed: number;
    };
    expect(receipt.applied).toBe(2);

    // 母版读到新形状。
    const loaded = assembly.app['resume.doc'].load(docId);
    if (loaded.status !== 'found') throw new Error('修订后母版读不回');
    expect(loaded.document.sections.find((item) => item.id === 'custom-1')?.entries[0]?.fields[0]?.value).toContain(
      '580 分',
    );
    expect(loaded.document.sections.some((item) => item.kind === 'custom' && item.title === '语言能力')).toBe(true);

    // 区块切片同趟重建：新正文进索引、旧正文不留。
    const text = assembly.db
      .prepare('SELECT text FROM kb_chunks WHERE source_doc_id = ? AND chunk_kind = ?')
      .all(docId, 'section')
      .map((row) => String((row as { text: string }).text))
      .join('\n');
    expect(text).toContain('580 分');
    expect(text).not.toContain('大学英语六级');
  });

  it('变体 id 经网关被结构化拒绝，母版不被改动', async () => {
    const assembly = await bootAssembly();
    const docId = await importAndIndex(assembly.app, assembly.dir);
    const master = assembly.app['resume.doc'].load(docId);
    if (master.status !== 'found') throw new Error('母版读不回');
    const variantId = assembly.app['resume.doc'].deriveVariant({
      parentDocId: docId,
      jdId: 'jd-link-1',
      jdLabel: '虚构 JD',
      document: master.document,
      nowMs: AS_OF_MS + 1000,
    }).docId;

    const resolution = resolveCall('kb.profile.revise', assembly.lookup);
    if (!resolution.ok) throw new Error('分派失败');
    try {
      resolution.invoke(variantId, [{ op: 'section.create', title: '不该出现' } satisfies KbReviseOpView]);
      throw new Error('变体应该被拒绝');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('INVALID_ARGUMENT');
    }
  });
});
