/**
 * `resume.export` 编排用例（spec 3.3-01 / 09 / 11 / 12 的可单测半边；不含 Electron）。
 *
 * 这里验的是「读文档 → 装配请求 → 交端口渲染 → 落盘 + 回写页数」这条编排链本身：
 * 打印能力由一个**假 `resume.print` 端口**提供（可控返回字节 / 抛错），于是能在无 Electron 的进程里
 * 把「渲染失败」「产物不是 PDF」「文档缺失/损坏」这些失败腿逐条打分——真实 `printToPDF` 走 3.3 的 V 类腿与 spike。
 * 落盘一律打**系统临时目录**（经 config 的 userDataDir 覆盖注入，不进仓库，AGENTS.md §7.5）。
 */
import { asApp, Context, Service, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { PREVIEW_FONT_BASE, type ResumePrintPort, type ResumePrintRequest } from '@auto-cc/shared';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterAll, describe, expect, it } from 'vitest';
import { ResumeDocService } from './doc-store.js';
import { ResumeExportService } from './export-service.js';
import { DEFAULT_LAYOUT, makeField, RESUME_SCHEMA_VERSION, type ResumeDocument } from './model.js';
import { ResumeSnapshotService } from './snapshot-store.js';

/** 假端口认这份「PDF」为 2 页，用来断言页数回写把文档里的 1 改成了 2。 */
const TWO_PAGE_PDF = Buffer.from('%PDF-1.4 /Type /Page /Type /Page', 'latin1');

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 可被测试逐个拨动的假打印端口：换返回字节、令其抛错、记录最后一次收到的请求。 */
class FakePrintService extends Service implements ResumePrintPort {
  static provide = 'resume.print';
  static Config = z.strictObject({});

  pdf: Uint8Array = TWO_PAGE_PDF;
  shouldThrow = false;
  /** 打开后产物字节随请求 html 变化，用来证明并发导出各写各的、不串内容（3.3-12）。 */
  echoHtml = false;
  lastRequest: ResumePrintRequest | null = null;

  constructor(ctx: Context, _options: z.infer<typeof FakePrintService.Config>) {
    super(ctx, 'resume.print');
  }

  /** 假字体 base，用来证明预览/导出的 HTML 确实经过端口拼 base（3.3 接线为真）。 */
  fontBaseUrl(): string {
    return 'file:///fake/fonts';
  }

  /** 渲染桩：记录请求、按拨动态返回字节或抛错（抛错由 export 收敛成结构化失败）。 */
  render(request: ResumePrintRequest): Promise<Uint8Array> {
    this.lastRequest = request;
    if (this.shouldThrow) return Promise.reject(new Error('内核崩溃'));
    // 保留两页标记让页数读数不变，只在尾部带上请求 html，使不同文档产出可区分的字节。
    if (this.echoHtml)
      return Promise.resolve(Buffer.from(`${TWO_PAGE_PDF.toString('latin1')} ${request.html}`, 'utf8'));
    return Promise.resolve(this.pdf);
  }
}

/** 挂起 config(带 userDataDir 覆盖) + store + resume.doc + 假 resume.print + resume.snapshot + resume.export。 */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-export-'));
  sandboxes.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc', paths: { userDataDir: dir } }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(ResumeDocService, {}));
  fibers.push(await ctx.plugin(FakePrintService, {}));
  fibers.push(await ctx.plugin(ResumeSnapshotService, { maxSnapshots: 20 }));
  fibers.push(await ctx.plugin(ResumeExportService, {}));
  const app = asApp(ctx);
  return {
    dir,
    store: app.store,
    docs: app['resume.doc'],
    snapshots: app['resume.snapshot'],
    exporter: app['resume.export'],
    print: app['resume.print'] as unknown as FakePrintService,
  };
}

function sampleDoc(overrides: Partial<ResumeDocument> = {}): ResumeDocument {
  return {
    id: 'resume-1',
    schemaVersion: RESUME_SCHEMA_VERSION,
    profile: { name: '张三', contact: { email: 'z@x.com', phone: null, location: '上海' } },
    layout: DEFAULT_LAYOUT,
    sections: [
      {
        id: 'exp',
        kind: 'experience',
        title: '经历',
        entries: [
          {
            id: 'e1',
            fields: [makeField('experience', 'company', '星桥科技'), makeField('experience', 'role', '后端工程师')],
          },
        ],
      },
    ],
    metrics: { pages: 1 },
    updatedAt: 1234,
    ...overrides,
  };
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不该把一次通过的验收判成失败。
    }
  }
});

describe('3.3-09 导出成功回执 + 落盘 + 页数回写', () => {
  it('toPdf 返回路径/页数/字节/hash，产物落 userData/exports 且文档页数被回写成真实读数', async () => {
    const { dir, docs, exporter } = await boot();
    docs.save(sampleDoc());
    const receipt = await exporter.toPdf('resume-1', 'classic');
    expect(receipt.pages).toBe(2);
    expect(receipt.bytes).toBe(TWO_PAGE_PDF.length);
    expect(receipt.path).toBe(join(dir, 'exports', 'resume-1-classic.pdf'));
    expect(readFileSync(receipt.path)).toEqual(TWO_PAGE_PDF);
    const reloaded = docs.load('resume-1');
    expect(reloaded.status === 'found' && reloaded.document.metrics.pages).toBe(2);
  });

  it('预览与导出用同一份 HTML 源（3.3-01 预览即导出所见）', async () => {
    const { docs, exporter, print } = await boot();
    docs.save(sampleDoc());
    const previewHtml = exporter.preview('resume-1', 'classic');
    await exporter.toPdf('resume-1', 'classic');
    // 两份只允许在**字体 src 的 base** 上不同（其余字节必须逐位相同）：预览面是渲染层的 srcdoc 帧，
    // 那里取不到绝对 `file://`（spec 6.6-04 实测的 `NetworkError`），打印面是临时 `file://` 文档，
    // 只有绝对同源 URL 才读得到本地字体。base 之外的任何差异都意味着两条轨道又长了第二份版面。
    const withoutFontBase = (html: string): string => html.replace(/url\('[^']*?(?=\/noto-)/g, "url('<base>");
    expect(withoutFontBase(print.lastRequest?.html ?? '')).toBe(withoutFontBase(previewHtml));
    // 各自的 base 形状也钉住：预览=相对（走渲染层根），打印=端口给的绝对 `file://`（不是本地硬编码）。
    expect(previewHtml).toContain(`url('${PREVIEW_FONT_BASE}/noto-`);
    expect(print.lastRequest?.html).toContain("url('file:///fake/fonts/noto-");
  });
});

describe('3.3-11 失败腿全部收敛成 RESUME_EXPORT_FAILED', () => {
  it('产物不是合法 PDF → 结构化失败', async () => {
    const { docs, exporter, print } = await boot();
    docs.save(sampleDoc());
    print.pdf = Buffer.from('not a pdf at all', 'latin1');
    await expect(exporter.toPdf('resume-1', 'classic')).rejects.toThrow(/不是合法 PDF/);
  });

  it('端口渲染抛错 → 内核打印失败', async () => {
    const { docs, exporter, print } = await boot();
    docs.save(sampleDoc());
    print.shouldThrow = true;
    await expect(exporter.toPdf('resume-1', 'classic')).rejects.toThrow(/内核打印失败/);
  });

  it('文档不存在 → 结构化失败', async () => {
    const { exporter } = await boot();
    await expect(exporter.toPdf('never-saved', 'classic')).rejects.toThrow(/简历文档不存在/);
  });

  it('库里的行已损坏 → 无法导出', async () => {
    const { store, docs, exporter } = await boot();
    docs.save(sampleDoc());
    store.db.prepare("UPDATE resume_docs SET doc_json = '{ broken' WHERE id = 'resume-1'").run();
    await expect(exporter.toPdf('resume-1', 'classic')).rejects.toThrow(/已损坏/);
  });

  it('失败以 AppError 携带 RESUME_EXPORT_FAILED 码跨进程上浮', async () => {
    const { exporter } = await boot();
    await exporter.toPdf('never-saved', 'classic').then(
      () => expect.unreachable('应当抛出'),
      (error: unknown) => {
        expect((error as { code?: string }).code).toBe('RESUME_EXPORT_FAILED');
      },
    );
  });
});

describe('3.3-12 并发导出各写各的、不串内容', () => {
  it('同时导出两份不同文档：落到两条路径、各自字节只含自己的内容、回执 hash 各匹配各文档', async () => {
    const { docs, exporter, print } = await boot();
    print.echoHtml = true;
    docs.save(
      sampleDoc({ id: 'a', profile: { name: '甲员工', contact: { email: 'a@x.com', phone: null, location: '上海' } } }),
    );
    docs.save(
      sampleDoc({ id: 'b', profile: { name: '乙员工', contact: { email: 'b@x.com', phone: null, location: '上海' } } }),
    );
    const [ra, rb] = await Promise.all([exporter.toPdf('a', 'classic'), exporter.toPdf('b', 'classic')]);

    expect(ra.path).not.toBe(rb.path);
    const bytesA = readFileSync(ra.path, 'utf8');
    const bytesB = readFileSync(rb.path, 'utf8');
    // 各写各的：A 的产物只含 A 的姓名，B 反之——并发编排没有把两份内容搅在一起。
    expect(bytesA).toContain('甲员工');
    expect(bytesA).not.toContain('乙员工');
    expect(bytesB).toContain('乙员工');
    expect(bytesB).not.toContain('甲员工');
    // 回执 hash 各由自己文档的内容算出，两份必然不同（页数仍按两页标记各自回写）。
    expect(ra.hash).not.toBe(rb.hash);
    const reloadedA = docs.load('a');
    const reloadedB = docs.load('b');
    expect(reloadedA.status === 'found' && reloadedA.document.metrics.pages).toBe(2);
    expect(reloadedB.status === 'found' && reloadedB.document.metrics.pages).toBe(2);
    expect(reloadedA.status === 'found' && reloadedA.document.profile.name).toBe('甲员工');
    expect(reloadedB.status === 'found' && reloadedB.document.profile.name).toBe('乙员工');
  });
});

describe('3.3-10 seedDemo 喂固定内容做端到端种子', () => {
  it('seedDemo 落一份可载入的合法文档，返回 id 与 hash，随后预览/导出直接吃它', async () => {
    const { docs, exporter } = await boot();
    const seeded = exporter.seedDemo();
    expect(seeded.docId).toBe('resume-demo');
    expect(seeded.hash).toBeTruthy();
    const loaded = docs.load('resume-demo');
    expect(loaded.status).toBe('found');
    if (loaded.status !== 'found') return;
    // 种子内容进得了预览（3.3-01 同一份 HTML 源），也导得出 PDF（端到端不用另存）。
    expect(exporter.preview('resume-demo', 'classic')).toContain('星桥科技');
    const receipt = await exporter.toPdf('resume-demo', 'classic');
    expect(receipt.docId).toBe('resume-demo');
    expect(receipt.pages).toBe(2);
  });

  it('重复 seedDemo 覆盖同一份 demo 文档，不留第二行', async () => {
    const { store, docs, exporter } = await boot();
    const first = exporter.seedDemo();
    const second = exporter.seedDemo();
    expect(second.docId).toBe(first.docId);
    expect(docs.load('resume-demo').status).toBe('found');
    const row = store.db.prepare('SELECT COUNT(*) AS n FROM resume_docs').get() as { n: number };
    expect(row.n).toBe(1);
  });
});

describe('3.7-01 每次导出产生一条不可变快照', () => {
  it('toPdf 成功后按 docId 列出一条快照，其 hash 与回执同源、还原结果一致', async () => {
    const { docs, exporter, snapshots } = await boot();
    docs.save(sampleDoc());
    const receipt = await exporter.toPdf('resume-1', 'classic');

    const listed = snapshots.list('resume-1');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.hash).toBe(receipt.hash);
    expect(listed[0]?.templateId).toBe('classic');
    // fontSet 由打印门面同源提供（不是快照服务自己拼的字符串）。
    expect(listed[0]?.fontSet).toContain('Noto Sans SC');
    // 3.7-04 round-trip：按快照 id 还原，hash 与导出回执一致、内容能重新校验成合法文档。
    const restored = snapshots.restore(listed[0]?.snapshotId ?? '');
    expect(restored.status).toBe('restored');
    if (restored.status === 'restored') expect(restored.hash).toBe(receipt.hash);
  });

  it('两次导出留两行快照（快照不可变、不随 resume_docs 的 UPSERT 被覆盖）', async () => {
    const { docs, exporter, snapshots } = await boot();
    docs.save(sampleDoc());
    await exporter.toPdf('resume-1', 'classic');
    await exporter.toPdf('resume-1', 'modern');
    const listed = snapshots.list('resume-1');
    expect(listed).toHaveLength(2);
    expect(new Set(listed.map((item) => item.templateId))).toEqual(new Set(['classic', 'modern']));
  });
});

describe('3.7-03 界面链路：两份种子 → 两次导出 → 快照差异非空', () => {
  it('base 与 edited 两种子各自导出后，diff 落在改动的字段与新增的区块上', async () => {
    const { exporter, snapshots } = await boot();
    const base = exporter.seedDemo('base');
    await exporter.toPdf(base.docId, 'classic');
    exporter.seedDemo('edited');
    await exporter.toPdf(base.docId, 'classic');

    // 列表最新的在前：起点取最旧那份，正是界面「快照历史」按钮预置的一对。
    const listed = snapshots.list(base.docId);
    expect(listed).toHaveLength(2);
    const result = snapshots.diff(listed[1]!.snapshotId, listed[0]!.snapshotId);
    expect(result.isEmpty).toBe(false);
    const kinds = result.sections.map((section) => `${section.kind}:${section.change}`);
    // edited 只动概述与技能两处自由文本，并整块加一段项目经历（锁定的公司/职位/时间随它进 diff）。
    expect(kinds).toEqual(expect.arrayContaining(['summary:modified', 'skills:modified', 'project:added']));
    const project = result.sections.find((section) => section.kind === 'project')!;
    expect(project.entries[0]!.fields.every((field) => field.locked)).toBe(true);
  });
});
