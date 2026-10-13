/**
 * 排版编辑器的**装配与 IPC 面**对账（spec 3.6-02 的跨进程半边 + 3.6-05/06/07 的接线半边，plan §8.4 的 3.6-b）。
 *
 * 为什么住在 `packages/main`（与 `graph-link.test.ts` / `pdf-link.test.ts` 同一个理由）：这里要同时读到
 * 注册表、`cordis.yml`、渲染层白名单与网关的 `resolveCall`——四样东西分属四个包，只有装配层认识它们全部。
 * 判据也正是装配层的判据：`resume.editor` 的十三行口在包内单测里全绿，但**清单少一行、或它排在
 * `resume-doc` 前面**（§9 的 5.1-c：清单顺序就是挂载顺序），真 app 里界面照样一道都调不到。
 *
 * 编辑语义本体（界内界外、历史、dirty、撤销）在 `packages/resume-doc/src/editor-*.test.ts` 判，
 * 这里只钉五件只在真装配里才成立的事：
 * 1. **登记齐**：注册表与清单都有 `resume-editor`，且它排在 `resume-doc` 之后。
 * 2. **切得对**：白名单里每一条 `resume.editor.*` 都切成服务 `resume.editor` + **同名方法**，
 *    并且那个方法在挂起来的实例上真的存在（名单与实现各写各的、点到才发现没有，是这一类缺陷的形状）。
 * 3. **原因跨进程不丢**（3.6-02 的判据原文）：界外值经网关这一路抛出的仍是那条码，
 *    `message` 带着键名与界表两端、子原因留在 `details.reason`——替身服务给不出这个读数。
 * 4. **正文只从一颗口进来**（§8.1 第 1 条在 3.11 之后的形状，裁定㉚）：打字这一行过的确实是正文，
 *    但一次只一格、且只有 `resume.editor.text` 这一颗；除它以外没有任何一行能收正文，
 *    投影那份读数里也仍然一句原文都没有（**打字开的是写口，不是读口**）。
 * 5. **草稿与库仍然是两件事**：经网关打的字要 `resume.editor.save` 才进 `resume_documents.doc_json`。
 *
 * 语料是手搓的虚构中文文档（§7.2 不碰真实平台、§7.5 不落任何文件进仓库）。这里**不再挂打印端口替身**：
 * 预览的字体 base 自 spec 6.6-04 起是渲染层的相对路径（`PREVIEW_FONT_BASE`），编辑器连 `resume.print`
 * 都不引了——"排一版"与"印一版"分属两环这条边界从此由依赖表保证，不再靠一只抛错的替身看守。
 */
import { AppError, asApp, Context, type Fiber } from '@auto-cc/core';
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
import { PREVIEW_FONT_BASE, RENDERER_ALLOWLIST, isAllowedCall } from '@auto-cc/shared';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/** 这份装配用的工作副本 id（正文全虚构，只有它需要过界的是 id 本身）。 */
const DOC_ID = 'resume-editor-link';
const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/**
 * 撑起「config + store + resume.doc + resume.editor + agent.tools」的真装配。
 *
 * 挂载顺序照 `cordis.yml`：`agent` 在能力包之前（§9 的 5.1-c——若哪天给编辑器登记工具，
 * 晚挂的注册表会静默收不到），`resume-editor` 排在 `resume-doc` 之后。
 * @returns 上下文、`resume.doc` 句柄（只用来读库核对"打字有没有绕过保存"）、`resume.editor` 句柄、`agent.tools` 句柄与网关用的那种按名查找口
 */
async function bootAssembly() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-editor-link-'));
  sandboxes.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(AgentToolsService, {}));
  fibers.push(await ctx.plugin(ResumeDocService, {}));
  // 3.6-08 的两只阈值随配置走（带 `.default()` 的键在直接调用点必须显式给出，§9 的 1.3 那条）。
  fibers.push(await ctx.plugin(ResumeEditorService, { maxPreviewResponseMs: 1200, largeDocumentSectionCount: 5 }));
  const app = asApp(ctx);
  app['resume.doc'].save(fixtureDoc());
  // `resume.editor` 还没进 cordis 的 `AppServices` 声明（同 `workflow.graph` 那条），所以按名取时先落到
  // unknown、再由句柄类型收口——网关那侧的动态 lookup 走的仍是同一条路。
  const byName = app as unknown as Record<'resume.editor', unknown>;
  return {
    ctx,
    docs: app['resume.doc'],
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
            // 两条正文行：3.6-10 的拆点经网关只能递**整数**，这一条要有两行才拨得动那颗步进器。
            makeField('experience', 'achievement', `成果-${entryId}-首行\n成果-${entryId}-次行`),
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
 * 走 try/catch 而不是 `Promise.resolve(invoke(…)).catch(…)`：编辑器那十三行方法是**同步**的（会话在内存里），
 * 实参求值那一刻就抛了，挂在返回值上的 `.catch` 根本没机会接住——这条在 3.5 的另存通道（异步）不会显出来。
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

/**
 * 从**库里**（不是会话里）取经历区块第一条的某一格。
 *
 * 判"打字有没有绕过保存"只认这一份：会话里的 draft 是内存态，界面说什么"已经改了"都证明不了落盘。
 * @param docs `resume.doc` 句柄
 * @param fieldKey 字段键（只用来读 `value` 与 `locked` / `factKey` 三样）
 * @returns 那一格；读不到就当场抛错——"没有这一格"不能被当成"没改过"
 */
function storedField(
  docs: ResumeDocService,
  fieldKey: string,
): ResumeDocument['sections'][number]['entries'][number]['fields'][number] {
  const loaded = docs.load(DOC_ID);
  if (loaded.status !== 'found') throw new Error(`库里应读得出文档，实际 ${loaded.status}`);
  const field = loaded.document.sections[0]?.entries[0]?.fields.find((candidate) => candidate.key === fieldKey);
  if (field === undefined) throw new Error(`库里那份没有 ${fieldKey} 这一格`);
  return field;
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
  it('注册表与 cordis.yml 都有 resume-editor，且它排在 resume-doc 之后', () => {
    // 只写注册表不进清单，启动时这一道口根本不存在；只进清单不写注册表，插件树显示 failed。
    const here = fileURLToPath(new URL('.', import.meta.url));
    const registrySource = readFileSync(join(here, 'registry.ts'), 'utf8');
    expect(registrySource).toMatch(/^ {2}'resume-editor': ResumeEditorService,$/m);
    const cordisYml = readFileSync(join(here, '../../../cordis.yml'), 'utf8');
    const indexOf = (id: string): number => cordisYml.indexOf(`\n  - id: ${id}\n`);
    expect(indexOf('resume-editor')).toBeGreaterThan(-1);
    // 它 inject 了 `resume.doc`，而早挂的问不到晚注册的（§9 的 5.1-c）——顺序写反在包内用例里看不出来。
    // `resume.print` 从这一条里退场了：预览的字体 base 换成渲染层相对路径后，编辑器不再引那只端口（spec 6.6-04）。
    expect(indexOf('resume-editor')).toBeGreaterThan(indexOf('resume-doc'));
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

describe('白名单十三行都切成服务方法并经网关真的落到位（spec 3.6-05/06/07 的接线半边 + 3.6-10 / 3.11 三只新口）', () => {
  it('每条 `resume.editor.*` 都对应挂起来的实例上的同名函数', async () => {
    const { lookup, editor } = await bootAssembly();
    const rows = RENDERER_ALLOWLIST.filter((id) => id.startsWith('resume.editor.'));
    expect(rows).toHaveLength(13);
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

  it('拆与合经网关真的落到位，被拒时子原因照样跨进程（3.6-10 的 C 半边）', async () => {
    const { lookup } = await bootAssembly();
    const open = resolveCall('resume.editor.open', lookup);
    if (!open.ok) throw new Error('分派失败');
    open.invoke(DOC_ID);
    const split = resolveCall('resume.editor.split', lookup);
    const merge = resolveCall('resume.editor.merge', lookup);
    if (!split.ok || !merge.ok) throw new Error('分派失败');
    // 这两行递过去的实参只有 docId / 区块 id / 条目 id / 一个整数——拆与合本身一个字都不必改，
    // 要改字走下面 3.11 那一颗（这一条口径从 3.11 起必须这样收窄，不能再笼统说"界面递不出正文"）。
    const after = split.invoke(DOC_ID, 'exp', 'e1', 1) as ReturnType<ResumeEditorService['open']>;
    expect(after.sections[0]?.entries.map((entry) => entry.id)).toEqual(['e1', 'experience-1', 'e2']);
    expect(after.isDirty).toBe(true);
    const back = merge.invoke(DOC_ID, 'exp', 'experience-1') as ReturnType<ResumeEditorService['open']>;
    expect(back.sections[0]?.entries.map((entry) => entry.id)).toEqual(['e1', 'e2']);
    // 区块第一条没有上一条可并：这条原因界面要拿去把那颗按不动，所以它必须跨得过来。
    const rejected = rejectViaGateway(merge, [DOC_ID, 'exp', 'e1']);
    expect(rejected.code).toBe('RESUME_EDITOR_EDIT_REJECTED');
    expect(rejected.reason).toBe('nothing-to-merge');
  });
});

describe('3.11-02 / 03 打字经网关：一次一格进草稿，保存才进库，被拒时子原因照样跨进程', () => {
  it('打一句新正文：预览跟着变、投影读不到这句、库里仍是原文；保存之后库里才是新的', async () => {
    const { lookup, docs } = await bootAssembly();
    const open = resolveCall('resume.editor.open', lookup);
    if (!open.ok) throw new Error('分派失败');
    open.invoke(DOC_ID);
    const text = resolveCall('resume.editor.text', lookup);
    const preview = resolveCall('resume.editor.preview', lookup);
    const save = resolveCall('resume.editor.save', lookup);
    if (!text.ok || !preview.ok || !save.ok) throw new Error('分派失败');

    const after = text.invoke(DOC_ID, 'exp', 'e1', 'achievement', '经网关改过的一句') as ReturnType<
      ResumeEditorService['open']
    >;
    expect(after.isDirty).toBe(true);
    expect(after.canUndo).toBe(true);
    // 这一格跨进程的读数仍然只有**行数**（2 变 1）：3.11-03 的反向判据——打字是写口，投影没有因此多出正文。
    expect(after.sections[0]?.entries[0]?.bodyLineCount).toBe(1);
    expect(JSON.stringify(after)).not.toContain('经网关改过的一句');
    // 屏上的纸要立刻跟着变，靠的就是这一份打印 HTML（与导出同一源）；界面不另读一遍文档。
    expect(String(preview.invoke(DOC_ID))).toContain('经网关改过的一句');
    // 未保存的打字与未保存的度量同一条规则：库里动不了一个字。
    expect(storedField(docs, 'achievement').value).toBe('成果-e1-首行\n成果-e1-次行');
    save.invoke(DOC_ID);
    expect(storedField(docs, 'achievement').value).toBe('经网关改过的一句');
  });

  it('改到事实锁定那一格照样放行、那枚标跟着进库，查无此键则跨进程说得出为什么（裁定㉛）', async () => {
    const { lookup, docs } = await bootAssembly();
    const open = resolveCall('resume.editor.open', lookup);
    if (!open.ok) throw new Error('分派失败');
    open.invoke(DOC_ID);
    const text = resolveCall('resume.editor.text', lookup);
    const save = resolveCall('resume.editor.save', lookup);
    if (!text.ok || !save.ok) throw new Error('分派失败');

    const rejected = rejectViaGateway(text, [DOC_ID, 'exp', 'e1', '不存在的键', 'x']);
    expect(rejected.code).toBe('RESUME_EDITOR_EDIT_REJECTED');
    expect(rejected.reason).toBe('unknown-field');
    // 界面要把这句写在打字框旁边，所以"被拒不进历史"这一条也必须在网关这一侧成立。
    expect(rejected.message).toContain('不存在的键');
    const view = resolveCall('resume.editor.view', lookup);
    if (!view.ok) throw new Error('分派失败');
    const readings = view.invoke(DOC_ID) as ReturnType<ResumeEditorService['open']>;
    expect(readings.canUndo).toBe(false);
    expect(readings.isDirty).toBe(false);

    text.invoke(DOC_ID, 'exp', 'e1', 'company', '手改的公司名');
    save.invoke(DOC_ID);
    const company = storedField(docs, 'company');
    expect(company.value).toBe('手改的公司名');
    // ㉛ 的全部实现含义在进程边界这一侧的读数：值换了、标还在，`diff.ts` 因此仍读得出「待确认」。
    expect(company.locked).toBe(true);
    expect(company.factKey).not.toBeNull();
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

  it('样式补丁的形状判据也在网关这一侧生效：坏颜色给的仍是 `bad-color` 且说得出哪一格（6.6-05）', async () => {
    const { lookup } = await bootAssembly();
    const open = resolveCall('resume.editor.open', lookup);
    if (!open.ok) throw new Error('分派失败');
    open.invoke(DOC_ID);
    const design = resolveCall('resume.editor.design', lookup);
    if (!design.ok) throw new Error('分派失败');
    const rejected = rejectViaGateway(design, [DOC_ID, { inkHex: '#0z' }]);
    expect(rejected.code).toBe('RESUME_EDITOR_EDIT_REJECTED');
    expect(rejected.reason).toBe('bad-color');
    // 轴名要在 message 里：界面据此指到那一格，而不是笼统报"颜色不对"（同上面 metric 那条的口径）。
    expect(rejected.message).toContain('inkHex');
  });

  it('一次样式调用只长一条撤销单元，且退回去之后 `design` 整格消失（6.6-05 的一个撤销单元）', async () => {
    const { lookup } = await bootAssembly();
    const open = resolveCall('resume.editor.open', lookup);
    if (!open.ok) throw new Error('分派失败');
    open.invoke(DOC_ID);
    const design = resolveCall('resume.editor.design', lookup);
    const undo = resolveCall('resume.editor.undo', lookup);
    if (!design.ok || !undo.ok) throw new Error('分派失败');
    // 一次调用带四条轴（主题两色 + 正文两轴）：界面上这是一格"保存"，历史上也只能是一步。
    const after = design.invoke(DOC_ID, {
      inkHex: '#0b5c50',
      accentHex: '#a31621',
      body: { fontFamily: 'serif', weight: 'medium' },
      paragraph: { kind: 'experience', align: 'justify' },
    }) as ReturnType<ResumeEditorService['open']>;
    expect(after.layout.design).toMatchObject({
      inkHex: '#0b5c50',
      body: { fontFamily: 'serif', weight: 'medium' },
      paragraphs: { experience: { align: 'justify' } },
    });
    expect(after.canUndo).toBe(true);
    const back = undo.invoke(DOC_ID) as ReturnType<ResumeEditorService['open']>;
    expect(back.canUndo).toBe(false);
    // 退回去要退得干净：`design` 整格不存在，而不是留着空壳（空壳会让"未改过"与"改回原样"在产物里分不开）。
    expect('design' in back.layout).toBe(false);
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

describe('可达面边界：十三行只给界面，正文只从一颗口进来（§8.1 / §8.2 / 3.6-09 / 3.6-10 / 3.11-03）', () => {
  it('抄错的名字、带点的方法名、未登记的第十四又一口都进不来', () => {
    // 比 plan §8.3 那八条多登记了 `.use`（模板与语言必须由主进程的读数驱动，否则界面存第二份事实，§2.7）、
    // 6.6-05 的 `.design`（样式档名与颜色要过界，但判界与判形状都只在 `editor-ops.ts` 那一份），
    // 3.6-10 的 `.split` / `.merge`（拆点只能是**行号整数**），以及 3.11 的 `.text`
    // （**唯一**一颗收正文的口，一次只一格；新增就这一行，别多给）。
    expect(RENDERER_ALLOWLIST.filter((id) => id.startsWith('resume.editor.'))).toEqual([
      'resume.editor.open',
      'resume.editor.view',
      'resume.editor.move',
      'resume.editor.split',
      'resume.editor.merge',
      'resume.editor.metric',
      'resume.editor.design',
      'resume.editor.text',
      'resume.editor.use',
      'resume.editor.preview',
      'resume.editor.undo',
      'resume.editor.redo',
      'resume.editor.save',
    ]);
    expect(isAllowedCall('resume.editor.use')).toBe(true);
    expect(isAllowedCall('resume.editor.split')).toBe(true);
    expect(isAllowedCall('resume.editor.merge')).toBe(true);
    expect(isAllowedCall('resume.editor.text')).toBe(true);
    // 拆与合只有这一种递法：任何"把正文文本递过来"的变体都没登记（§8.1 第 1 条的可执行形式）。
    expect(isAllowedCall('resume.editor.splitAt')).toBe(false);
    expect(isAllowedCall('resume.editor.split.text')).toBe(false);
    expect(isAllowedCall('resume.editor.dropSession')).toBe(false);
    expect(isAllowedCall('resume.editor.save.all')).toBe(false);
    expect(isAllowedCall('resume.editor')).toBe(false);
    expect(isAllowedCall('Resume.editor.open')).toBe(false);
    // 3.11 之后这一条更要钉住：打字是"一格"的动作，任何**整份**写入的变体都不许存在——
    // 界面手里能拼出整份文档，`validateDocument` 那一道就只活在保存时，投影也不必再只给结构了。
    expect(isAllowedCall('resume.editor.texts')).toBe(false);
    expect(isAllowedCall('resume.editor.text.all')).toBe(false);
    expect(isAllowedCall('resume.editor.document')).toBe(false);
    expect(isAllowedCall('resume.editor.patch')).toBe(false);
    // 界面手里没有文档存储的任何一条口：正文因此不可能绕开会话那一份校验与草稿账（同 `generate-link.test.ts` 那一条口径）。
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
    expect(cloned.sections.map((section) => section.entries.map((entry) => entry.id)).flat()).toEqual([
      'e1',
      'e2',
      'e3',
    ]);
    // 3.6-10 为投影新增的那一格是**数字**（正文行数），不是正文：步进器拨到哪儿由它定，行内容一步都不过界。
    expect(cloned.sections[0]?.entries.map((entry) => entry.bodyLineCount)).toEqual([2, 2]);
    expect(cloned.sections[1]?.entries[0]?.bodyLineCount).toBe(1);
    const serialized = JSON.stringify(cloned);
    expect(serialized).not.toContain('岗位-e1');
    expect(serialized).not.toContain('星桥-e2');
    expect(serialized).not.toContain('成果-e1-首行');
    expect(serialized).not.toContain('经历');
    // 界面要看内容只有一条路：打印 HTML，与导出同一份源（spec 3.3-01 的口径续用到编辑器）。
    // 过界的那一份必须带**相对**字体 base（spec 6.6-04）：装机/开发两种运行态里纸面帧都只取同源字体，
    // 端口那一支绝对 `file://` 一旦漏进这条口，屏上就静默掉回系统字体——只有导出的 PDF 是对的。
    const preview = resolveCall('resume.editor.preview', lookup);
    if (!preview.ok) throw new Error('分派失败');
    expect(String(preview.invoke(DOC_ID))).toContain(`url('${PREVIEW_FONT_BASE}/noto-`);
    expect(String(preview.invoke(DOC_ID))).not.toContain('file://');
  });
});
