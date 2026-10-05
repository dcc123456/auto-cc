/**
 * 排版编辑器的**装配与 IPC 面**对账（spec 3.6-02 的跨进程半边 + 3.6-05/06/07 的接线半边，plan §8.4 的 3.6-b）。
 *
 * 为什么住在 `packages/main`（与 `graph-link.test.ts` / `pdf-link.test.ts` 同一个理由）：这里要同时读到
 * 注册表、`cordis.yml`、渲染层白名单与网关的 `resolveCall`——四样东西分属四个包，只有装配层认识它们全部。
 * 判据也正是装配层的判据：`resume.editor` 的九条口在包内单测里全绿，但**清单少一行、或它排在
 * `resume-doc` 前面**（§9 的 5.1-c：清单顺序就是挂载顺序），真 app 里界面照样一道都调不到。
 *
 * 编辑语义本体（界内界外、历史、dirty、撤销）在 `packages/resume-doc/src/editor-*.test.ts` 判，
 * 这里只钉四件只在真装配里才成立的事：
 * 1. **登记齐**：注册表与清单都有 `resume-editor`，且它排在 `resume-doc` 与 `resume-print` 之后。
 * 2. **切得对**：白名单里每一条 `resume.editor.*` 都切成服务 `resume.editor` + **同名方法**，
 *    并且那个方法在挂起来的实例上真的存在（名单与实现各写各的、点到才发现没有，是这一类缺陷的形状）。
 * 3. **原因跨进程不丢**（3.6-02 的判据原文）：界外值经网关这一路抛出的仍是那条码，
 *    `message` 带着键名与界表两端、子原因留在 `details.reason`——替身服务给不出这个读数。
 * 4. **正文仍不过界**（§8.1 第 1 条）：经网关拿到的投影 `structuredClone` 得过去（IPC 载荷是结构化克隆），
 *    而克隆串里一句简历原文都没有；界面手里也没有 `resume.doc.*` 那两条读写口。
 *
 * 语料是手搓的虚构中文文档（§7.2 不碰真实平台、§7.5 不落任何文件进仓库）。打印端口是一只**只给
 * `fontBaseUrl()`** 的替身：真身 `ResumePrintService` 在 `@auto-cc/shell`（它才认识 Electron），
 * 在本机 vitest 的纯 Node 运行时挂不起来——与 `three-gate-link.test.ts` 用 `FakeSessionsService`
 * 顶掉 `sessions` 是同一个手法。
 */
import { AppError, asApp, Context, Service, type Fiber } from '@auto-cc/core';
import { AgentToolsService } from '@auto-cc/plugin-agent';
import { ConfigService } from '@auto-cc/plugin-config';
import { resolveCall } from '@auto-cc/plugin-ipc';
import {
  createEmptyDocument,
  EDITOR_METRIC_BOUNDS,
  makeField,
  ResumeDocService,
  ResumeEditorService,
  type ResumeDocument,
} from '@auto-cc/plugin-resume-doc';
import { StoreService } from '@auto-cc/plugin-store';
import type { ResumePrintPort, ResumePrintRequest } from '@auto-cc/shared';
import { RENDERER_ALLOWLIST, isAllowedCall } from '@auto-cc/shared';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { afterAll, describe, expect, it } from 'vitest';

/** 这份装配用的工作副本 id（正文全虚构，只有它需要过界的是 id 本身）。 */
const DOC_ID = 'resume-editor-link';
const FONT_BASE = 'file:///fake/fonts';
const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 只给字体 base 的打印端口替身：`render` 被调到即失败（排一版与印一版分属两环，plan §8.3）。 */
class FakePrintService extends Service implements ResumePrintPort {
  static provide = 'resume.print';
  static Config = z.strictObject({});

  constructor(ctx: Context, _options: z.infer<typeof FakePrintService.Config>) {
    super(ctx, 'resume.print');
  }

  fontBaseUrl(): string {
    return FONT_BASE;
  }

  render(_request: ResumePrintRequest): Promise<Uint8Array> {
    throw new Error('编辑器不该调打印端口的 render');
  }
}

/**
 * 撑起「config + store + resume.doc + resume.editor + agent.tools」的真装配。
 *
 * 挂载顺序照 `cordis.yml`：`agent` 在能力包之前（§9 的 5.1-c——若哪天给编辑器登记工具，
 * 晚挂的注册表会静默收不到），`resume-editor` 排在 `resume-doc` 之后。
 * @returns 上下文、`resume.editor` 句柄、`agent.tools` 句柄与网关用的那种按名查找口
 */
async function bootAssembly() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-editor-link-'));
  sandboxes.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(AgentToolsService, {}));
  fibers.push(await ctx.plugin(ResumeDocService, {}));
  fibers.push(await ctx.plugin(FakePrintService, {}));
  // 3.6-08 的两只阈值随配置走（带 `.default()` 的键在直接调用点必须显式给出，§9 的 1.3 那条）。
  fibers.push(await ctx.plugin(ResumeEditorService, { maxPreviewResponseMs: 1200, largeDocumentSectionCount: 5 }));
  const app = asApp(ctx);
  app['resume.doc'].save(fixtureDoc());
  // `resume.editor` 还没进 cordis 的 `AppServices` 声明（同 `workflow.graph` 那条），所以按名取时先落到
  // unknown、再由句柄类型收口——网关那侧的动态 lookup 走的仍是同一条路。
  const byName = app as unknown as Record<'resume.editor', unknown>;
  return {
    ctx,
    editor: byName['resume.editor'] as ResumeEditorService,
    tools: app['agent.tools'],
    lookup: (name: string) => {
      try {
        return ctx.get(name) as object;
      } catch {
        return undefined;
      }
    },
  };
}

/** 两个区块的合法文档：经历区块给全核心槽位（company + role），缺了渲染会抛可定位错误。 */
function fixtureDoc(): ResumeDocument {
  return {
    ...createEmptyDocument(DOC_ID, 0),
    sections: [
      {
        id: 'exp',
        kind: 'experience',
        title: '经历',
        entries: ['e1', 'e2'].map((entryId) => ({
          id: entryId,
          fields: [
            makeField('experience', 'company', `星桥-${entryId}`),
            makeField('experience', 'role', `岗位-${entryId}`),
          ],
        })),
      },
      {
        id: 'skills',
        kind: 'skills',
        title: '技能',
        entries: [{ id: 'e3', fields: [makeField('skills', 'text', '技能-e3')] }],
      },
    ],
  };
}

/**
 * 经网关调一次，把抛出的错误翻成三段读数（不抛则当场报错，避免"没失败"被读成"失败但不判"）。
 *
 * 走 try/catch 而不是 `Promise.resolve(invoke(…)).catch(…)`：编辑器那九条方法是**同步**的（会话在内存里），
 * 实参求值那一刻就抛了，挂在返回值上的 `.catch` 根本没机会接住——这条在 3.5 的另存腿（异步）不会显出来。
 * @param resolution 网关的切分结果（调用方已确认它是 `ok: true` 那一支）
 * @param args 白名单签名里那串实参
 * @returns 错误负载的三段读数：码、人读原话、`details.reason` 里的子原因
 */
function rejectViaGateway(
  resolution: { invoke: (...args: unknown[]) => unknown },
  args: unknown[],
): { code: string; message: string; reason?: string } {
  let caught: unknown;
  try {
    caught = resolution.invoke(...args);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  const payload = AppError.from(caught);
  return {
    code: payload.code,
    message: payload.message,
    reason: (payload.details as { reason?: string } | undefined)?.reason,
  };
}

afterAll(async () => {
  // 先释放 fiber（关连接）再删目录：句柄延迟释放会挡住删除（§9 的环境事实）。
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不该把一次通过的验收判成失败。
    }
  }
});

describe('装配对账（plan §8.3 的两处登记）', () => {
  it('注册表与 cordis.yml 都有 resume-editor，且它排在 resume-doc 与 resume-print 之后', () => {
    // 只写注册表不进清单，启动时这一道口根本不存在；只进清单不写注册表，插件树显示 failed。
    const here = fileURLToPath(new URL('.', import.meta.url));
    const registrySource = readFileSync(join(here, 'registry.ts'), 'utf8');
    expect(registrySource).toMatch(/^ {2}'resume-editor': ResumeEditorService,$/m);
    const cordisYml = readFileSync(join(here, '../../../cordis.yml'), 'utf8');
    const indexOf = (id: string): number => cordisYml.indexOf(`\n  - id: ${id}\n`);
    expect(indexOf('resume-editor')).toBeGreaterThan(-1);
    // 它 inject 了这两只，而早挂的问不到晚注册的（§9 的 5.1-c）——顺序写反在包内用例里看不出来。
    expect(indexOf('resume-editor')).toBeGreaterThan(indexOf('resume-doc'));
    expect(indexOf('resume-editor')).toBeGreaterThan(indexOf('resume-print'));
  });

  it('真上下文里挂起来的名字就是 `resume.editor`，且没往 agent 工具面登记任何一只手', async () => {
    const { editor, tools } = await bootAssembly();
    // 句柄是 `bootAssembly` 里按名 `app['resume.editor']` 取出来的：名字没挂上时那一步就抛错，
    // 所以这一行是"装配里真的有它"的正向对照，下面那条空清单因此不只是"什么都没装"。
    expect(editor).toBeInstanceOf(ResumeEditorService);
    // 改版面是人对"投出去的那份简历"的表态（§3 第 1 条 / §8.4）：白名单里有 ≠ 模型能调。
    // 正向对照是上一行——服务确实挂起来了，所以这里的空清单不是"什么都没装"。
    expect(
      tools
        .list()
        .map((tool) => tool.id)
        .filter((id) => id.startsWith('resume.editor')),
    ).toEqual([]);
    expect(tools.list()).toHaveLength(0);
  });
});

describe('白名单九条都切成服务方法并经网关真的落到位（spec 3.6-05/06/07 的接线半边）', () => {
  it('每条 `resume.editor.*` 都对应挂起来的实例上的同名函数', async () => {
    const { lookup, editor } = await bootAssembly();
    const rows = RENDERER_ALLOWLIST.filter((id) => id.startsWith('resume.editor.'));
    expect(rows).toHaveLength(9);
    const methods = editor as unknown as Record<string, unknown>;
    for (const row of rows) {
      const resolution = resolveCall(row, lookup);
      expect(resolution).toMatchObject({
        ok: true,
        service: 'resume.editor',
        method: row.slice('resume.editor.'.length),
      });
      if (!resolution.ok) throw new Error(`${row} 切分失败`);
      // 名单里写了而服务上没有，界面按下去得到的是"方法不是函数"那种 Nobody 报错，不是结构化失败。
      expect(typeof methods[resolution.method]).toBe('function');
    }
  });

  it('经网关 open 一份存在的文档，读数与直调服务同源', async () => {
    const { lookup } = await bootAssembly();
    const resolution = resolveCall('resume.editor.open', lookup);
    if (!resolution.ok) throw new Error('分派失败');
    const viaGateway = resolution.invoke(DOC_ID, 'modern') as ReturnType<ResumeEditorService['open']>;
    expect(viaGateway.docId).toBe(DOC_ID);
    expect(viaGateway.templateId).toBe('modern');
    expect(viaGateway.sections.map((section) => section.id)).toEqual(['exp', 'skills']);
  });
});

describe('拒绝的原因跨进程不丢（spec 3.6-02 的判据原文）', () => {
  it('界外值经网关抛出的仍是那条码，message 带键名与界表两端、details 带子原因', async () => {
    const { lookup } = await bootAssembly();
    const open = resolveCall('resume.editor.open', lookup);
    if (!open.ok) throw new Error('分派失败');
    open.invoke(DOC_ID);
    const metric = resolveCall('resume.editor.metric', lookup);
    if (!metric.ok) throw new Error('分派失败');
    const rejected = rejectViaGateway(metric, [DOC_ID, 'baseFontPt', EDITOR_METRIC_BOUNDS.baseFontPt.max + 1]);
    expect(rejected.code).toBe('RESUME_EDITOR_EDIT_REJECTED');
    expect(rejected.reason).toBe('out-of-bounds');
    expect(rejected.message).toContain('baseFontPt');
    // 界面据此拼提示，所以"跨进程不丢"判的就是这三个成分都在负载里，而不只是码对。
    expect(rejected.message).toContain(String(EDITOR_METRIC_BOUNDS.baseFontPt.max));
  });

  it('没有会话与库里没有这份文档，是两条不同的话术（界面的处置不同）', async () => {
    const { lookup } = await bootAssembly();
    const metric = resolveCall('resume.editor.metric', lookup);
    if (!metric.ok) throw new Error('分派失败');
    expect(rejectViaGateway(metric, [DOC_ID, 'lineHeight', 1.8]).code).toBe('RESUME_EDITOR_NOT_OPEN');

    const open = resolveCall('resume.editor.open', lookup);
    if (!open.ok) throw new Error('分派失败');
    const missing = rejectViaGateway(open, ['库里没有的那份']);
    expect(missing.code).toBe('RESUME_EDITOR_DOC_UNAVAILABLE');
    expect(missing.message).toContain('库里没有的那份');
  });
});

describe('可达面边界：九条只给界面，正文仍然不过界（§8.1 / §8.2 / 3.6-09）', () => {
  it('抄错的名字、带点的方法名、未登记的第第十口都进不来', () => {
    // 比 plan §8.3 那八条多登记了 `.use`（模板与语言必须由主进程的读数驱动，否则界面存第二份事实，§2.7）。
    expect(RENDERER_ALLOWLIST.filter((id) => id.startsWith('resume.editor.'))).toEqual([
      'resume.editor.open',
      'resume.editor.view',
      'resume.editor.move',
      'resume.editor.metric',
      'resume.editor.use',
      'resume.editor.preview',
      'resume.editor.undo',
      'resume.editor.redo',
      'resume.editor.save',
    ]);
    expect(isAllowedCall('resume.editor.use')).toBe(true);
    expect(isAllowedCall('resume.editor.dropSession')).toBe(false);
    expect(isAllowedCall('resume.editor.save.all')).toBe(false);
    expect(isAllowedCall('resume.editor')).toBe(false);
    expect(isAllowedCall('Resume.editor.open')).toBe(false);
    // 界面手里没有文档存储的任何一条口：正文因此不可能过界（同 `generate-link.test.ts` 那一条口径）。
    expect(isAllowedCall('resume.doc.save')).toBe(false);
    expect(isAllowedCall('resume.doc.load')).toBe(false);
  });

  it('经网关的投影克隆得过去，且一句简历原文都不在里面', async () => {
    const { lookup } = await bootAssembly();
    const open = resolveCall('resume.editor.open', lookup);
    if (!open.ok) throw new Error('分派失败');
    const view = open.invoke(DOC_ID) as ReturnType<ResumeEditorService['open']>;
    // 结构化克隆是 IPC 载荷的真实通路：带函数或不可克隆成员的形状在单测里能过、到边界才丢。
    const cloned = structuredClone(view);
    expect(cloned.sections.map((section) => section.entryIds).flat()).toEqual(['e1', 'e2', 'e3']);
    const serialized = JSON.stringify(cloned);
    expect(serialized).not.toContain('岗位-e1');
    expect(serialized).not.toContain('星桥-e2');
    expect(serialized).not.toContain('经历');
    // 界面要看内容只有一条路：打印 HTML，与导出同一份源（spec 3.3-01 的口径续用到编辑器）。
    const preview = resolveCall('resume.editor.preview', lookup);
    if (!preview.ok) throw new Error('分派失败');
    expect(String(preview.invoke(DOC_ID))).toContain(FONT_BASE);
  });
});
