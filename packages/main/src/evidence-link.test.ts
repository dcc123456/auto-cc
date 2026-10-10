/**
 * `agent.run.evidence` 的**真装配**判定（spec 5.7-02 的接线半边，plan §7.5.7 决策十一 / 十二）。
 *
 * 为什么这条住在 `packages/main`（与 `generate-link.test.ts` 同一理由）：`agent` 包按 §4.1 与 5.1-08
 * 不许 import 任何能力包，所以路由那侧的归属读数只能按**结构接口**取（`LedgerReader` / `JdStoreReader`…）。
 * 于是「真服务到底提不提供 `row` / `detail` / `load` / `importOf` / `receiptOf` / `evidenceBody` / `meta`
 * 这七只手、返回的那几位在不在」在包内**编译期查不出来**——只有把两边一起装起来才红（决策十二的口径：
 * 方法名存在与否正则与原型都查不出来，活体装配才是活证）。本文件就是那份活证。
 *
 * 四条判定各守一种只在真装配里才会出现的失效：
 * 1. **七只归属服务的读口都在**，且返回体能赋给跨进程 DTO（`LedgerRowView` / `JobRowView`）并克隆得过去
 *    ——IPC 载荷走结构化克隆，带函数或不可克隆成员的形状在包内用例里能通过，到进程边界才丢。
 * 2. **真数据读得出正文**：账本行、岗位行、工作副本、导入记录、生成回执、知识库依据、简历快照各走一遍
 *    各服务的**公开写入口**（不手搓 SQL），再由路由读回来。假替身存不住「这一行真在库里」这件事。
 * 3. **IPC 那一跳分派得到**：`agent.run.evidence` 在渲染层白名单里，且 `resolveCall` 把它切成
 *    服务 `agent.run` + 方法 `evidence`（三段名的最长优先是网关的既有规则，这里只钉住这一条新口没被切错）。
 * 4. **缺口也是确定读数**：`session:` / `page:` 这类本就没有正文的引用，过真装配给的还是那句人话原因，
 *    而不是抛异常或一片空白——5.7-02 判的正是「每一步都能回溯」，不是「每条都能读到正文」。
 *
 * 语料是文件里的虚构中文简历（§7.2 不碰真实招聘平台），手机号是假哨兵；没装 `llm.chat`，
 * 生成腿走 4.5-09 的仅重排保守版；模型腿是 5.2 那台桩（输入即脚本），所以全程零出网、零真实平台调用。
 * 循环真跑一步（`read` 级假手，`auto` 档下不必批准），步记录里的 `evidence_refs_json` 就是被点的那些引用——
 * 归属判据因此是**对着真落库的那一步**判的，不是对着手搓视图。
 */
import { asApp, Context, NO_CONFIG, toolResult, type EvidenceRefView, type Fiber } from '@auto-cc/core';
import {
  AgentLoopService,
  AgentPauseService,
  AgentPolicyService,
  AgentToolsService,
  ChatSessionService,
  EvidenceRefService,
  agentLoopSchema,
  agentPauseSchema,
  chatConfigSchema,
  type AgentTool,
} from '@auto-cc/plugin-agent';
import { BrowserTakeoverService, PlatformRegistryService } from '@auto-cc/plugin-browser';
import { ConfigService } from '@auto-cc/plugin-config';
import { UsageLedgerService } from '@auto-cc/plugin-entitlement';
import { resolveCall } from '@auto-cc/plugin-ipc';
import { ConversationStoreService, JdStoreService } from '@auto-cc/plugin-platform-boss';
import { ResumeDocService, ResumeSnapshotService } from '@auto-cc/plugin-resume-doc';
import {
  KbGapService,
  KbProfileService,
  ResumeGenerateService,
  ResumeParseService,
  kbGapSchema,
  kbGenerateSchema,
  kbProfileSchema,
  resumeParseSchema,
} from '@auto-cc/plugin-resume-kb';
import { StoreService } from '@auto-cc/plugin-store';
import { isAllowedCall, type JobRowView, type LedgerRowView } from '@auto-cc/shared';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

/** 虚构简历正文：够 4.1 的解析出区块，也够 4.4 的词面腿命中。 */
const CORPUS_MD = [
  '王五',
  '电话：13900008888',
  '',
  '## 教育经历',
  '南汇大学｜信息工程 本科 2016.09-2020.06',
  '',
  '## 工作经历',
  '云栖网络｜前端工程师 2020.07-2023.12',
  '- 负责结算前端的稳定性治理，把首屏耗时下降 35%。',
  '',
  '## 技能',
  '- TypeScript、React、Vite',
].join('\n');

/** 虚构 JD：不需要模型也能出读数。 */
const JD_TEXT = '前端工程师（虚构：南汇云图）：负责结算链路，熟悉 TypeScript 与 React，本科及以上学历，3 年以上经验。';

/** 判定基准时刻（固定值，两次运行可比）。 */
const AS_OF_MS = new Date(2026, 9, 15, 12).getTime();

/** 唯一那只只读假手 id（桩模型按文本里点名的手出步）。 */
const TOOL_ID = 'demo.refs';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/**
 * 造一条「把入参点名的引用原样登记为这一步证据」的假手。
 * @returns `read` 级、不需批准的工具声明；引用取自调用时的入参，不在这里预存
 */
function makeRefsTool(): AgentTool<{ refs: string[] }> {
  return {
    id: TOOL_ID,
    titleKey: 'agent.tool.labels.demoRefs',
    description: '把入参里点名的引用原样登记为这一步的证据',
    input: z.strictObject({ refs: z.array(z.string()) }),
    effect: 'read',
    requiresConfirmation: false,
    run: (params) =>
      Promise.resolve(
        toolResult({ count: params.refs.length }, { summary: '假手留下了引用', evidenceRefs: [...params.refs] }),
      ),
  };
}

/**
 * 撑起「真循环 + 七只真归属服务 + 真路由口」的装配，并跑出一步带全部真引用的 run。
 * @param options.withConversations 摘掉会话库时，`jd.store.detail` 要 JOIN 的 `conversation_messages`
 *        就不存在了——那是装配被摘掉一块时**真会发生的**读挂，用它来判路由口的「从不抛」（决策十一）
 * @returns 应用句柄、路由口句柄、run id、步下标 0 的读数、本装配造出来的各真 id
 */
async function bootEvidenceAssembly(options: { withConversations?: boolean } = {}) {
  const withConversations = options.withConversations ?? true;
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-evidence-link-'));
  sandboxes.push(dir);
  const ctx = new Context();
  /** 挂一个插件并把 fiber 记进收尾清单。 */
  const mount = async (fiber: Fiber | PromiseLike<Fiber>): Promise<void> => {
    fibers.push(await fiber);
  };
  await mount(ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  await mount(ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  await mount(ctx.plugin(BrowserTakeoverService, {}));
  // 工具登记是软取，能力包在注册表之后挂载才登记得出工具（与 `cordis.yml` 同一顺序）。
  await mount(ctx.plugin(AgentToolsService, {}));
  await mount(ctx.plugin(UsageLedgerService, {}));
  await mount(ctx.plugin(JdStoreService, {}));
  // 岗位行的「已回复」是 JOIN 会话库现算的（2.5-14），所以真装配里它俩一起在场；
  // 平台注册表是会话库的依赖（它按平台找适配器换算消息方向），一起挂上。
  if (withConversations) {
    // 注册表没有可调项，但**实参仍然要递**：cordis 从构造器第二参反推调用点的配置类型（无键 schema 推成
    // `undefined`，所以这里不能写 `{}`），而运行期照旧拿 schema 解析一次实参（写空 = 挂载当场抛
    // 「expected object, received undefined」）。`NO_CONFIG` 就是 core 为这个类型坑备的那一份空配置。
    await mount(ctx.plugin(PlatformRegistryService, NO_CONFIG));
    await mount(ctx.plugin(ConversationStoreService, { platform: 'boss' }));
  }
  await mount(ctx.plugin(ResumeDocService, {}));
  await mount(ctx.plugin(ResumeSnapshotService, { maxSnapshots: 20 }));
  // `resume.parse` 也排在 `kb.profile` 之前：4.1-14 的删除腿让它硬注入了这两只，挂晚了就 PENDING（§9 的 5.1-c）。
  await mount(ctx.plugin(ResumeParseService, resumeParseSchema.parse({})));
  await mount(ctx.plugin(KbProfileService, kbProfileSchema.parse({})));
  await mount(ctx.plugin(KbGapService, kbGapSchema.parse({})));
  await mount(ctx.plugin(ResumeGenerateService, kbGenerateSchema.parse({})));
  await mount(ctx.plugin(ChatSessionService, chatConfigSchema.parse({})));
  await mount(ctx.plugin(AgentPolicyService, {}));
  await mount(ctx.plugin(AgentPauseService, agentPauseSchema.parse({})));
  await mount(ctx.plugin(AgentLoopService, agentLoopSchema.parse({})));
  await mount(ctx.plugin(EvidenceRefService, {}));
  const app = asApp(ctx);

  // 七类记录全部经各服务的**公开写入口**进来，不在这里手搓 SQL（手搓会把「服务真认得这一行」判成假）。
  const ledgerId = app['usage.ledger'].record({ action: 'greet', targetId: 'boss/9001', nowMs: AS_OF_MS });
  app['jd.store'].upsert({
    platform: 'boss',
    jobId: '9001',
    title: '前端工程师',
    company: '假司',
    salaryText: '20-30K',
    city: '上海',
    experience: '3-5 年',
    education: '本科',
    requirements: ['TypeScript', 'React'],
    sourceUrl: 'https://fixture.test.invalid/job/9001',
    capturedAt: AS_OF_MS,
  });
  const resumePath = join(dir, 'resume-link.md');
  writeFileSync(resumePath, CORPUS_MD, 'utf8');
  const imported = await app['resume.parse'].fromFile(resumePath, AS_OF_MS);
  app['kb.profile'].sync(imported.docId, AS_OF_MS);
  const [firstEntity] = app['kb.profile'].list({ sourceDocId: imported.docId });
  if (firstEntity === undefined) throw new Error('知识库没建出实体，`entity:` 引用无从回看');
  const generated = await app['resume.generate'].run(JD_TEXT, { docId: imported.docId, jdId: '9001' }, AS_OF_MS);
  const workingCopy = app['resume.doc'].load(imported.docId);
  if (workingCopy.status !== 'found') throw new Error(`工作副本没落库：${workingCopy.status}`);
  const snapshot = app['resume.snapshot'].record(workingCopy.document, 'classic', 'source-han', AS_OF_MS);

  const refs = [
    `ledger:${String(ledgerId)}`,
    'job:boss/9001',
    'jd:9001',
    `doc:${imported.docId}`,
    `hash:${imported.sourceHash}`,
    `generation:${generated.receipt.id}`,
    `entity:${firstEntity.entityId}`,
    `snapshot:${snapshot.snapshotId}`,
    'session:boss',
    'page:https://fixture.test.invalid/jobs',
    // 路由表里没有的一类：只有把它登记到步上，才走得过归属那道门、落到「不认识」这一支。
    'nonsense:1',
  ];
  app['agent.tools'].register(makeRefsTool());
  app['chat.session'].setAutonomy('auto');
  const proposed = await app['agent.loop'].propose(`${TOOL_ID} ${JSON.stringify({ refs })}`);
  const finished = await app['agent.loop'].confirm(proposed.runId);

  return {
    ctx,
    app,
    evidence: app['agent.run'],
    runId: finished.runId,
    step: finished.steps[0],
    refs,
    ledgerId,
    docId: imported.docId,
    sourceHash: imported.sourceHash,
    receiptId: generated.receipt.id,
    entityId: firstEntity.entityId,
    snapshotId: snapshot.snapshotId,
  };
}

/** 每类前缀在真装配里的期望正文线索（读到了就说明那只手真被按名字问到了）。 */
type Expectation = { ref: (h: Awaited<ReturnType<typeof bootEvidenceAssembly>>) => string; contains: string };

const EXPECTED: Expectation[] = [
  { ref: (h) => `ledger:${String(h.ledgerId)}`, contains: '动作：greet' },
  { ref: () => 'job:boss/9001', contains: '要求条目：2 条' },
  { ref: () => 'jd:9001', contains: '平台：boss' },
  { ref: (h) => `doc:${h.docId}`, contains: '这里不搬第二份全文' },
  { ref: (h) => `hash:${h.sourceHash}`, contains: '来源指纹' },
  { ref: (h) => `generation:${h.receiptId}`, contains: '生成的正文当时只进了预览' },
  { ref: (h) => `entity:${h.entityId}`, contains: '出处：' },
  { ref: (h) => `snapshot:${h.snapshotId}`, contains: '内容指纹：' },
];

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放，清理失败不该把一次通过的验收判成失败。
    }
  }
});

describe('5.7-02 七只归属服务的读口在真装配里都点得着', () => {
  it('方法名与返回形状都在（结构接口与真服务不漂移）', async () => {
    const { app } = await bootEvidenceAssembly();
    // 编译期已经要求这些方法存在；这几行把它们钉成**运行期**也读得到的读数，并过一遍进程边界。
    const row: LedgerRowView | null = app['usage.ledger'].row(1);
    expect(row).not.toBeNull();
    expect(structuredClone(row as LedgerRowView).action).toBe('greet');
    const job: JobRowView | null = app['jd.store'].detail('9001', 'boss');
    expect(structuredClone(job as JobRowView).title).toBe('前端工程师');
    expect(app['resume.doc'].load('nope').status).toBe('missing');
    expect(app['resume.parse'].importOf('nope')).toBeNull();
    expect(app['resume.generate'].receiptOf('nope')).toBeNull();
    expect(app['kb.profile'].evidenceBody('nope')).toBeNull();
    expect(app['resume.snapshot'].meta('nope')).toBeNull();
  });

  it('八条真引用逐条读到正文，逐条都过得了结构化克隆', async () => {
    const handles = await bootEvidenceAssembly();
    for (const expectation of EXPECTED) {
      const ref = expectation.ref(handles);
      const view = handles.evidence.evidence(handles.runId, 0, ref);
      expect(view.body, ref).not.toBeNull();
      expect(view.body, ref).toContain(expectation.contains);
      // 界面拿到的必须是纯数据（带函数的读数在 `invoke` 那一步就丢了）。
      expect(structuredClone(view)).toEqual(view);
    }
  });

  it('真落库的那一步登记着全部十条引用，一条不多一条不少', async () => {
    const handles = await bootEvidenceAssembly();
    expect(handles.step?.evidenceRefs).toEqual(handles.refs);
  });
});

describe('5.7-02 缺口在真装配里同样给一句人话而不是抛', () => {
  it('会话与页面引用没有正文，但拒因说清了归谁看', async () => {
    const handles = await bootEvidenceAssembly();
    const session = handles.evidence.evidence(handles.runId, 0, 'session:boss');
    const page = handles.evidence.evidence(handles.runId, 0, 'page:https://fixture.test.invalid/jobs');
    expect(session.body).toBeNull();
    expect(session.unavailableReason).toContain('boss 的登录分区');
    expect(page.unavailableReason).toContain('DOM 正文没有随引用落盘');
  });

  it('引用没登记在那一步上时，真归属服务一次都没被问到', async () => {
    const handles = await bootEvidenceAssembly();
    const view = handles.evidence.evidence(handles.runId, 0, `ledger:${String(handles.ledgerId + 999)}`);
    expect(view.body).toBeNull();
    expect(view.unavailableReason).toContain('没有这一条');
  });

  it('路由表里没有的一类不编读数', async () => {
    const handles = await bootEvidenceAssembly();
    expect(handles.app['agent.run']).toBeInstanceOf(EvidenceRefService);
    const outcome: EvidenceRefView = handles.evidence.evidence(handles.runId, 0, 'nonsense:1');
    expect(outcome.body).toBeNull();
    expect(outcome.unavailableReason).toContain('路由表里没有');
  });

  it('归属服务因为装配被摘掉一块而读挂时，给的是原因而不是穿透进程的异常', async () => {
    // 真失效现场：`jd.store.detail` 要 JOIN `conversation_messages`，那张表归会话库自己建（2.5-14）。
    // 装配面板可以把会话包单个摘掉而留下岗位库——那时点引用必须还能给出一句看得懂的话。
    const handles = await bootEvidenceAssembly({ withConversations: false });
    const view = handles.evidence.evidence(handles.runId, 0, 'job:boss/9001');
    expect(view.body).toBeNull();
    expect(view.unavailableReason).toContain('归属服务读数失败');
    expect(view.unavailableReason).toContain('conversation_messages');
    // 同一份装配里其余读数不受影响：账本那条引用照旧读得到正文。
    expect(handles.evidence.evidence(handles.runId, 0, `ledger:${String(handles.ledgerId)}`).body).toContain(
      '动作：greet',
    );
  });
});

describe('5.7-02 白名单与网关的分派（三段名切法）', () => {
  it('`agent.run.evidence` 在渲染层白名单里', () => {
    expect(isAllowedCall('agent.run.evidence')).toBe(true);
  });

  it('真装配把这条路径切成服务 `agent.run` + 方法 `evidence` 并调得通', async () => {
    const handles = await bootEvidenceAssembly();
    const resolution = resolveCall('agent.run.evidence', (name) => {
      try {
        return handles.ctx.get(name) as object;
      } catch {
        return undefined;
      }
    });
    expect(resolution).toMatchObject({ ok: true, service: 'agent.run', method: 'evidence' });
    if (!resolution.ok) throw new Error('分派失败');
    const invoked = resolution.invoke(handles.runId, 0, `ledger:${String(handles.ledgerId)}`) as EvidenceRefView;
    expect(invoked.body).toContain('动作：greet');
  });
});
