/**
 * 「用户设定用哪套模板生成」的用例（spec 3.2-03 的用户可设定半边 + AGENTS.md §9 的 5.3-b）。
 *
 * 这条表态必须落库而不能做配置键：配置层只写内存运行期、重启即失，而"我以后生成的简历用这套版式"
 * 恰恰要跨重启仍然算数。这里同时守住三件事：未知模板 id 不许被存进去、从没设定过时读出的是回退值
 * 而不是库里的假默认、以及**不给 templateId 的预览真的按人设的那套渲**（生轨与轨道共用这一条）。
 */
import { asApp, Context, Service, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import type { ResumePrintPort, ResumePrintRequest } from '@auto-cc/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterAll, describe, expect, it } from 'vitest';
import { RESUME_PREFERENCE_MIGRATION_VERSION, ResumeDocService } from './doc-store.js';
import { ResumeExportService } from './export-service.js';
import { DEFAULT_LAYOUT, makeField, RESUME_SCHEMA_VERSION, type ResumeDocument } from './model.js';
import { ResumeSnapshotService } from './snapshot-store.js';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 只拼 HTML 的打印桩：本文件判的是"用哪套模板渲"，不是内核打印本身（那在 export-service.test.ts）。 */
class HtmlEchoPrintService extends Service implements ResumePrintPort {
  static provide = 'resume.print';
  static Config = z.strictObject({});

  constructor(ctx: Context, _options: z.infer<typeof HtmlEchoPrintService.Config>) {
    super(ctx, 'resume.print');
  }

  /** 假字体 base（与真端口同形状，只为让 HTML 拼出来）。 */
  fontBaseUrl(): string {
    return 'file:///fake/fonts';
  }

  /** 把请求里的 HTML 原样当产物字节回，好让调用方能读回"这次渲的是哪一套"。 */
  render(request: ResumePrintRequest): Promise<Uint8Array> {
    return Promise.resolve(Buffer.from(request.html, 'utf8'));
  }
}

/** 挂起 config + store + resume.doc + 桩 resume.print + resume.snapshot + resume.export。 */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-preference-'));
  sandboxes.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc', paths: { userDataDir: dir } }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(ResumeDocService, {}));
  fibers.push(await ctx.plugin(HtmlEchoPrintService, {}));
  fibers.push(await ctx.plugin(ResumeSnapshotService, { maxSnapshots: 20 }));
  fibers.push(await ctx.plugin(ResumeExportService, {}));
  const app = asApp(ctx);
  return { docs: app['resume.doc'], exports: app['resume.export'] };
}

/**
 * 取一份打印 HTML 的**正文**部分。
 * 判"这次渲的是哪一套版式"只能看正文：工具类样式表（3.2 那套 Tailwind 对得上号的 utility）是整份内嵌进
 * `<style>` 的，`bg-red-800` 这种串在每一份 HTML 里都存在，拿整份字符串做包含判断必然为真、量不出模板差别。
 * @param html `resume.export.preview` 的返回值
 * @returns `<body>` 与 `</body>` 之间的标记串
 */
function bodyMarkup(html: string): string {
  const start = html.indexOf('<body>');
  const end = html.lastIndexOf('</body>');
  return html.slice(start + '<body>'.length, end);
}

/** 一份够小的合法文档（预览只需要能被模板渲出来）。 */
function sampleDoc(): ResumeDocument {
  return {
    id: 'resume-pref',
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
            fields: [
              makeField('experience', 'company', '星桥科技'),
              makeField('experience', 'role', '后端工程师'),
              makeField('experience', 'period', '2021-2024'),
            ],
          },
        ],
      },
    ],
    metrics: { pages: 1 },
    updatedAt: 1234,
  };
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

describe('界面偏好（默认模板）', () => {
  it('迁移号段是 36（不回填并行会话可能占用的 34，也不与已登记号段相撞）', () => {
    expect(RESUME_PREFERENCE_MIGRATION_VERSION).toBe(36);
  });

  it('从没设定过时读回回退值，写入后读回人设的那一套，重复写入覆盖', async () => {
    const { exports } = await boot();
    expect(exports.preference().templateId).toBe('classic');
    expect(exports.setPreference('sidebar-teal').templateId).toBe('sidebar-teal');
    expect(exports.preference().templateId).toBe('sidebar-teal');
  });

  it('未知模板 id 直接被拒，不会静默存进去等渲染时才炸', async () => {
    const { exports } = await boot();
    expect(() => exports.setPreference('no-such-template')).toThrow(/未知模板/);
    expect(exports.preference().templateId).toBe('classic');
  });

  it('模板清单出得去且至少 50 套（界面那一栏的数据源就是它，不另抄一份）', async () => {
    const { exports } = await boot();
    const list = exports.templates();
    expect(list.length).toBeGreaterThanOrEqual(50);
    expect(list.every((item) => item.id !== '' && item.name !== '')).toBe(true);
  });

  it('不给 templateId 的预览按人设定的模板渲，换一套就换一份 HTML（spec 3.2-02 的版面差异在导出链上成立）', async () => {
    const { docs, exports } = await boot();
    docs.save(sampleDoc());
    exports.setPreference('sales-target');
    const preferred = bodyMarkup(exports.preview('resume-pref'));
    // `sales-target` 是 banner 抬头 + 红底：类名进**正文**才算真按人设的那套渲了。
    expect(preferred).toContain('bg-red-800');
    exports.setPreference('quiet-gray');
    const switched = bodyMarkup(exports.preview('resume-pref'));
    expect(switched).not.toContain('bg-red-800');
    expect(switched).toContain('bg-zinc-600');
    expect(switched).not.toBe(preferred);
  });
});
