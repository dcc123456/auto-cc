/**
 * `resume.editor` 的用例（spec 3.6-02 的跨进程半边 + 3.6-01 / 03 / 04 / 09 的服务侧形状，plan §8.4 的 3.6-b）。
 *
 * 打**真的 config + store + `node:sqlite`**（系统临时目录，不进仓库，§7.5）：这一片要判的就是
 * "打开→改→不保存则库里不动→保存才动"，用内存替身自存自取证明不了这件事（同 `doc-store.test.ts` 的口径）。
 * 打印端口是一只**只给 `fontBaseUrl()`** 的假服务：编辑器只要这一个读数，
 * 另一条 `render()` 一旦被打到就抛错——那说明有人把"印一份"塞进了"排一版"（两件事分属两环，见 plan §8.3）。
 * 不复用 `export-service.test.ts` 里那只可拨动的假端口：那只的意义在于换字节、抛内核错、并发各写各的，
 * 这里的编辑器根本不碰渲染，把两者并成一份只会得到一份谁都用不顺手的替身（§2.7 判的是同一件事，不是同名函数）。
 */
import { AppError, asApp, Context, Service, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import type { ResumePrintPort, ResumePrintRequest } from '@auto-cc/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterAll, describe, expect, it } from 'vitest';
import { ResumeDocService } from './doc-store.js';
import { EDITOR_METRIC_BOUNDS } from './editor-ops.js';
import { ResumeEditorService } from './editor-service.js';
import { createEmptyDocument, makeField, type ResumeDocument } from './model.js';
import { resumePrint } from './print.js';

const FONT_BASE = 'file:///fake/fonts';
const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 只在字体 base 上给读数的假打印端口（`render` 被调到即失败）。 */
class FontOnlyPrintService extends Service implements ResumePrintPort {
  static provide = 'resume.print';
  static Config = z.strictObject({});

  constructor(ctx: Context, _options: z.infer<typeof FontOnlyPrintService.Config>) {
    super(ctx, 'resume.print');
  }

  fontBaseUrl(): string {
    return FONT_BASE;
  }

  render(_request: ResumePrintRequest): Promise<Uint8Array> {
    throw new Error('排版编辑器不该调打印端口的 render（预览只要 HTML，印一份是 export 轨的事）');
  }
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-resume-editor-'));
  sandboxes.push(dir);
  return dir;
}

/** 挂起 config + store + resume.doc + 假 resume.print + resume.editor，并把一份 fixture 落进库。 */
async function boot(document = fixture()) {
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir: tempDir(), file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(ResumeDocService, {}));
  fibers.push(await ctx.plugin(FontOnlyPrintService, {}));
  fibers.push(await ctx.plugin(ResumeEditorService, {}));
  const app = asApp(ctx);
  app['resume.doc'].save(document);
  // `resume.editor` 这个名字还没进 cordis 的 `AppServices` 声明（同 `workflow.graph` 那条），所以按名取时
  // 先落到 unknown、再由句柄类型收口——不影响网关那侧的动态 lookup 走同一条路。
  const byName = app as unknown as Record<'resume.editor', unknown>;
  return {
    docs: app['resume.doc'],
    editor: byName['resume.editor'] as ResumeEditorService,
  };
}

/** 两个区块、第一个三条条目的合法文档（与 `editor-session.test.ts` 同一形状，正文一律虚构）。 */
function fixture(): ResumeDocument {
  return {
    ...createEmptyDocument('r', 0),
    sections: [
      {
        id: 'exp',
        kind: 'experience',
        title: '经历',
        // 经历区块的核心槽位是 company + role（缺了模板会抛可定位错误，见 `bind.ts` 的 `toEntryView`），
        // 预览那一条用例要真的渲染，所以这里给全——内容全部虚构。
        entries: ['e1', 'e2', 'e3'].map((id) => ({
          id,
          fields: [makeField('experience', 'company', `星桥-${id}`), makeField('experience', 'role', `岗位-${id}`)],
        })),
      },
      {
        id: 'skills',
        kind: 'skills',
        title: '技能',
        entries: [{ id: 'e4', fields: [makeField('skills', 'text', '技能-e4')] }],
      },
    ],
  };
}

/** 取一条被拒动作的错误负载（三段断言各用一次，收成一口）。 */
function rejection(error: unknown): { code: string; message: string; reason?: string } {
  const payload = AppError.from(error);
  const details = payload.details as { reason?: string } | undefined;
  return { code: payload.code, message: payload.message, reason: details?.reason };
}

describe('3.6-b 打开与投影（正文不过界的那条边界要能被断言）', () => {
  it('open 给的投影带结构、度量、模板表与界表，但不带一句简历原文', async () => {
    const { editor } = await boot();
    const view = editor.open('r');
    expect(view.docId).toBe('r');
    expect(view.sections).toEqual([
      { id: 'exp', kind: 'experience', entryIds: ['e1', 'e2', 'e3'] },
      { id: 'skills', kind: 'skills', entryIds: ['e4'] },
    ]);
    expect(view.layout).toEqual(createEmptyDocument('r', 0).layout);
    expect(view.templateId).toBe('classic');
    expect(view.locale).toBe('zh-CN');
    expect(view.templates).toContain('classic');
    expect(view.metricBounds).toEqual(EDITOR_METRIC_BOUNDS);
    expect(view.isDirty).toBe(false);
    expect(view.canUndo).toBe(false);
    // 这条是 §8.1 第 1 条边界的可执行形式：字段值一旦出现在投影里，"界面只认 docId + 打印 HTML"就破了。
    expect(JSON.stringify(view)).not.toContain('岗位-e1');
    expect(JSON.stringify(view)).not.toContain('经历');
  });

  it('库里没有这份文档 / 模板 id 不认识，都是结构化失败而不是崩', async () => {
    const { editor } = await boot();
    expect(rejection(thrown(() => editor.open('没有这份')))).toMatchObject({
      code: 'RESUME_EDITOR_DOC_UNAVAILABLE',
      message: expect.stringContaining('没有这份'),
    });
    expect(rejection(thrown(() => editor.open('r', '不存在的模板')))).toMatchObject({
      code: 'RESUME_EDITOR_TEMPLATE_UNKNOWN',
      message: expect.stringContaining('不存在的模板'),
    });
  });

  it('没 open 过的任何动作都先撞上 `RESUME_EDITOR_NOT_OPEN`（不会悄悄替用户开一份）', async () => {
    const { editor } = await boot();
    expect(rejection(thrown(() => editor.view('r'))).code).toBe('RESUME_EDITOR_NOT_OPEN');
    expect(rejection(thrown(() => editor.move('r', 'exp', 1))).code).toBe('RESUME_EDITOR_NOT_OPEN');
    expect(rejection(thrown(() => editor.metric('r', 'baseFontPt', 12))).code).toBe('RESUME_EDITOR_NOT_OPEN');
    expect(rejection(thrown(() => editor.undo('r'))).code).toBe('RESUME_EDITOR_NOT_OPEN');
    expect(rejection(thrown(() => editor.preview('r'))).code).toBe('RESUME_EDITOR_NOT_OPEN');
  });
});

describe('3.6-01 / 03 动作后的读数与撤销', () => {
  it('拖一次区块：投影顺序变了、dirty 与 canUndo 一起翻，undo 退得回去、redo 再往前', async () => {
    const { editor } = await boot();
    editor.open('r');
    expect(
      editor
        .move('r', 'exp', 1)
        .sections.map((section) => section.id)
        .join('>'),
    ).toBe('skills>exp');
    const dirty = editor.view('r');
    expect(dirty.isDirty).toBe(true);
    expect(dirty.canUndo).toBe(true);

    const undone = editor.undo('r');
    expect(undone.sections.map((section) => section.id).join('>')).toBe('exp>skills');
    expect(undone.isDirty).toBe(false);
    expect(undone.canRedo).toBe(true);
    expect(
      editor
        .redo('r')
        .sections.map((section) => section.id)
        .join('>'),
    ).toBe('skills>exp');
  });

  it('条目只在自己区块内搬：跨区块给 unknown-entry，下标越界给 index-out-of-range，两者都不动投影', async () => {
    const { editor } = await boot();
    editor.open('r');
    const moved = editor.move('r', 'exp', 2, 'e1');
    expect(moved.sections[0]?.entryIds).toEqual(['e2', 'e3', 'e1']);

    expect(rejection(thrown(() => editor.move('r', 'skills', 0, 'e1')))).toMatchObject({
      code: 'RESUME_EDITOR_EDIT_REJECTED',
      reason: 'unknown-entry',
    });
    expect(rejection(thrown(() => editor.move('r', 'exp', 9)))).toMatchObject({
      code: 'RESUME_EDITOR_EDIT_REJECTED',
      reason: 'index-out-of-range',
    });
  });
});

describe('3.6-02 界外被拒时，原因跨进程不丢', () => {
  it('界外值的 message 带键名、越界值与界表两端，details.reason 是子原因码', async () => {
    const { editor } = await boot();
    editor.open('r');
    const rejected = rejection(thrown(() => editor.metric('r', 'baseFontPt', 99)));
    expect(rejected.code).toBe('RESUME_EDITOR_EDIT_REJECTED');
    expect(rejected.reason).toBe('out-of-bounds');
    expect(rejected.message).toContain('baseFontPt');
    expect(rejected.message).toContain(String(EDITOR_METRIC_BOUNDS.baseFontPt.max));
    // 拒绝没动任何东西：读数仍是默认字号，也没有凭空多出一条可退的步骤。
    const after = editor.view('r');
    expect(after.layout.baseFontPt).toBe(10.5);
    expect(after.canUndo).toBe(false);
  });

  it('界内值改写度量并留进投影（滑杆读的就是同一张表，界面不必再抄一份判据）', async () => {
    const { editor } = await boot();
    editor.open('r');
    expect(editor.metric('r', 'lineHeight', 1.8).layout.lineHeight).toBe(1.8);
    expect(editor.metric('r', 'leftMm', 20).layout.margin.leftMm).toBe(20);
    expect(editor.view('r').layout).toEqual({
      ...createEmptyDocument('r', 0).layout,
      lineHeight: 1.8,
      margin: { ...createEmptyDocument('r', 0).layout.margin, leftMm: 20 },
    });
  });
});

describe('3.6-04 模板与语言：视图旋钮，不是数据', () => {
  it('换模板只动投影里的 templateId，文档一个字节没改、也不长出撤销单元', async () => {
    const { editor } = await boot();
    editor.open('r');
    const before = editor.view('r');
    const after = editor.use('r', 'modern', 'en');
    expect(after.templateId).toBe('modern');
    expect(after.locale).toBe('en');
    expect(after.layout).toEqual(before.layout);
    expect(after.sections).toEqual(before.sections);
    expect(after.canUndo).toBe(false);
    expect(after.isDirty).toBe(false);
  });

  it('预览是同一份 builder 的产物：字体 base 来自端口，未保存的 draft 也能被排出来', async () => {
    const { editor, docs } = await boot();
    editor.open('r');
    const draft = editor.metric('r', 'baseFontPt', 12).layout;
    const html = editor.preview('r');
    // 库里那份还没被改（12pt 只活在会话里），而预览已经是改后的样子——这就是"松开即预览更新"的形状。
    const loaded = docs.load('r');
    if (loaded.status !== 'found') throw new Error(`库里应读得出文档，实际 ${loaded.status}`);
    expect(loaded.document.layout.baseFontPt).toBe(10.5);
    expect(draft.baseFontPt).toBe(12);
    // 同一份 builder + 同一个 base 的直接展开：与 `export-service.test.ts` 钉住的 `resume.export.preview`
    // 的产出条件完全相同，于是"编辑器里看到的"与"导出出来的"在结构上不可能分叉（spec 3.3-01 续用到 3.6）。
    expect(html).toBe(resumePrint.buildHtml({ ...fixture(), layout: draft }, 'classic', 'zh-CN', FONT_BASE));
    expect(html).toContain(FONT_BASE);
  });
});

describe('3.6-09 保存是唯一的落点，未保存的东西不落', () => {
  it('不保存就重开：draft 消失，库里仍是打开时那份（裁定⑨「只拦不存」的服务侧形状）', async () => {
    const { editor } = await boot();
    editor.open('r');
    editor.metric('r', 'baseFontPt', 12);
    const reopened = editor.open('r');
    expect(reopened.layout.baseFontPt).toBe(10.5);
    expect(reopened.isDirty).toBe(false);
    expect(reopened.canUndo).toBe(false);
  });

  it('保存后库里就是改后的度量、dirty 归零而撤销历史留着', async () => {
    const { editor, docs } = await boot();
    editor.open('r');
    editor.move('r', 'exp', 1);
    editor.metric('r', 'baseFontPt', 12);
    const saved = editor.save('r');
    expect(saved.isDirty).toBe(false);
    expect(saved.canUndo).toBe(true);

    const loaded = docs.load('r');
    if (loaded.status !== 'found') throw new Error(`保存后读回应为 found，实际 ${loaded.status}`);
    expect(loaded.document.layout.baseFontPt).toBe(12);
    expect(loaded.document.sections.map((section) => section.id)).toEqual(['skills', 'exp']);
    // 存完再退一步：退的是编辑历史，不是把库里的内容改回去（保存是单向的一次落点）。
    expect(editor.undo('r').isDirty).toBe(true);
  });
});

/** 执行一段应当抛错的调用，把抛出的东西交出去（不抛则报错，避免"没失败"被读成"失败但不判"）。 */
function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('期望这一步被拒，但它成功了');
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});
