/**
 * `agent.run.evidence` 的路由与「确定结局」用例（spec 5.7-02 的代码半边）。
 *
 * 这只口的判据不是「每条引用都能读到正文」，而是**每条引用都有确定结局**：读到读数，或者
 * 说清为什么没有正文。所以本文件最重要的一条是前面那组逐前缀的性质断言（决策十一写进用例的那条：
 * 「别让 02 打成一个空心勾」）——它把 `evidence.ts` 里 `switch` 的**每一支**都走一遍，
 * 任一分支既没给正文也没给原因就是红的。
 *
 * 循环一侧用的是**真** `agent.loop`（跑一条只读假手，run 与步记录真落库），不是手搓的 `AgentRunView`：
 * 「这条引用真登记在那一步上吗」判的就是步记录里的 `evidence_refs_json`，用假视图测它就等于自证。
 * 归属服务七只一律用**结构替身**（本包按 5.1-08 / §4.1 的机检不许 import 能力包），
 * 因此真服务是否真的提供 `row` / `detail` / `load` / `importOf` / `receiptOf` / `evidenceBody` / `meta`
 * 这七只手，由 `packages/main/src/evidence-link.test.ts` 的装配用例负责（plan §7.5.7 决策十二的口径：
 * 方法名存在与否正则与原型都查不出来，活体装配才是活证）。
 *
 * 界面那半边（点引用→内联展开）在 5.7-d-2 的 harness 验收里，见 plan 的落地记录（AGENTS.md §7.1）。
 * 全程假工具、假读数，不碰真实招聘平台也不出网（§7.2）。
 */
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { Service, asApp, Context, toolResult, type Fiber } from '@auto-cc/core';
import type { JobRowView, LedgerRowView } from '@auto-cc/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChatSessionService } from '../session.js';
import { FakeTakeoverService } from '../test-doubles.js';
import { AgentToolsService, type AgentTool } from '../tools.js';
import { AGENT_RUN_MIGRATION_VERSION, AgentLoopService } from './loop.js';
import { EvidenceRefService } from './evidence.js';
import { AgentPauseService } from './pause.js';
import { AgentPolicyService } from './policy.js';

/** 拆卸清单与临时库目录（每个用例一套，跑完即拆即删）。 */
const opened: { dispose(): Promise<unknown> }[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (opened.length) await opened.pop()?.dispose();
  while (dirs.length) rmSync(dirs.shift() ?? '', { recursive: true, force: true });
});

/** 七只归属替身共用的空配置（与真实服务里那些无配置项的口同形）。 */
const NO_CONFIG = z.strictObject({});

/** `usage.ledger.row()` 的替身：只装一张按行 id 索引的表。 */
class FakeLedgerService extends Service {
  static provide = 'usage.ledger';
  static Config = NO_CONFIG;

  readonly rows = new Map<number, LedgerRowView>();

  /** 点名要「读挂」的行 id：演归属服务自己抛异常那一支（真装配里它是缺表，见 `evidence-link.test.ts`）。 */
  readonly failing = new Set<number>();

  constructor(ctx: Context, _options: z.output<typeof NO_CONFIG>) {
    super(ctx, 'usage.ledger');
  }

  /**
   * 按行 id 取一条外发记账。
   * @param id 行 id（正整数）
   * @returns 那一行的读数；表里没有返回 null（与真实账本同口径，不抛）
   * @throws 点名要失败的那一行时抛错，用来验路由口把它收成读数而不是穿出去
   */
  row(id: number): LedgerRowView | null {
    if (this.failing.has(id)) throw new Error('模拟：账本自己的表还没建起来');
    return this.rows.get(id) ?? null;
  }
}

/** `jd.store.detail()` 的替身：一条岗位，平台可选（`jd:` 那一支不传平台）。 */
class FakeJdStoreService extends Service {
  static provide = 'jd.store';
  static Config = NO_CONFIG;

  readonly jobs = new Map<string, JobRowView>();

  constructor(ctx: Context, _options: z.output<typeof NO_CONFIG>) {
    super(ctx, 'jd.store');
  }

  /**
   * 按岗位 id（可选平台）取一条岗位。
   * @param jobId 岗位 id
   * @param platform 平台标签；省略时按岗位 id 命中（与真实存储的跨平台同 id 取舍一致）
   * @returns 岗位行；没有则 null
   */
  detail(jobId: string, platform?: string): JobRowView | null {
    const key = platform === undefined ? jobId : `${platform}/${jobId}`;
    return this.jobs.get(key) ?? null;
  }
}

/** `resume.doc.load()` 的替身：三态各造一条，`corrupt` 用来验那句原话有没有带出来。 */
class FakeDocService extends Service {
  static provide = 'resume.doc';
  static Config = NO_CONFIG;

  readonly documents = new Map<string, unknown>();

  constructor(ctx: Context, _options: z.output<typeof NO_CONFIG>) {
    super(ctx, 'resume.doc');
  }

  /**
   * 按文档 id 读工作副本。
   * @param id 文档 id
   * @returns `found` / `missing` / `corrupt` 三态之一（替身按表里存的那一份直接给）
   */
  load(id: string): unknown {
    return this.documents.get(id) ?? { status: 'missing' };
  }
}

/** `resume.parse.importOf()` 的替身。 */
class FakeParseService extends Service {
  static provide = 'resume.parse';
  static Config = NO_CONFIG;

  readonly imports = new Map<string, unknown>();

  constructor(ctx: Context, _options: z.output<typeof NO_CONFIG>) {
    super(ctx, 'resume.parse');
  }

  /**
   * 按来源指纹取一条导入记录。
   * @param sourceHash 来源哈希（4.1-07 的幂等键）
   * @returns 导入读数；没有则 null
   */
  importOf(sourceHash: string): unknown {
    return this.imports.get(sourceHash) ?? null;
  }
}

/** `resume.generate.receiptOf()` 的替身。 */
class FakeGenerateService extends Service {
  static provide = 'resume.generate';
  static Config = NO_CONFIG;

  readonly receipts = new Map<string, unknown>();

  constructor(ctx: Context, _options: z.output<typeof NO_CONFIG>) {
    super(ctx, 'resume.generate');
  }

  /**
   * 按回执 id 取一次定向生成的落库记录。
   * @param receiptId 回执 id
   * @returns 记录读数；没有则 null
   */
  receiptOf(receiptId: string): unknown {
    return this.receipts.get(receiptId) ?? null;
  }
}

/** `kb.profile.evidenceBody()` 的替身（实体 id 与切片 id 共用一张表，与真实那只口同形）。 */
class FakeProfileService extends Service {
  static provide = 'kb.profile';
  static Config = NO_CONFIG;

  readonly bodies = new Map<string, unknown>();

  constructor(ctx: Context, _options: z.output<typeof NO_CONFIG>) {
    super(ctx, 'kb.profile');
  }

  /**
   * 按 id 取一条依据正文。
   * @param id 实体 id 或区块切片 id
   * @returns 正文读数；查不到则 null
   */
  evidenceBody(id: string): unknown {
    return this.bodies.get(id) ?? null;
  }
}

/** `resume.snapshot.meta()` 的替身。 */
class FakeSnapshotService extends Service {
  static provide = 'resume.snapshot';
  static Config = NO_CONFIG;

  readonly metas = new Map<string, unknown>();

  constructor(ctx: Context, _options: z.output<typeof NO_CONFIG>) {
    super(ctx, 'resume.snapshot');
  }

  /**
   * 按快照 id 取元数据（正文仍只经 `restore` 那条恢复通道）。
   * @param snapshotId 快照 id（uuid）
   * @returns 元数据；没有则 null
   */
  meta(snapshotId: string): unknown {
    return this.metas.get(snapshotId) ?? null;
  }
}

/** 台架要装的七只归属替身及其服务名（`without` 就是「摘掉这一行装配」）。 */
const OWNERS = [
  ['usage.ledger', FakeLedgerService],
  ['jd.store', FakeJdStoreService],
  ['resume.doc', FakeDocService],
  ['resume.parse', FakeParseService],
  ['resume.generate', FakeGenerateService],
  ['kb.profile', FakeProfileService],
  ['resume.snapshot', FakeSnapshotService],
] as const;

/**
 * 一条「执行就把入参点名的引用原样交回」的假手（循环落步的 `evidence_refs_json` 就是它给的那一份）。
 * @returns 合规声明：`read` 级、不要求批准（`auto` 档下循环直接跑）；引用取自调用时的入参，不在这里预存
 */
function makeRefsTool(): AgentTool<{ refs: string[] }> {
  return {
    id: 'demo.refs',
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
 * 逐前缀点名用的引用清单（每种前缀至少一条，含两条形状不对的）。
 *
 * 这份清单是 `evidence.ts` 里 `switch` 的**分支表**的镜像：加一支前缀而不加一条引用，
 * 下面那组性质用例就会漏测它，所以两边要一起改（同一件事的第二个来源，§2.5）。
 */
const ALL_REFS = [
  'ledger:7',
  'ledger:404',
  'ledger:999',
  'job:boss/9',
  'job:boss/gone',
  'jd:job-9',
  'doc:doc-1',
  'doc:doc-corrupt',
  'doc:doc-gone',
  'hash:deadbeef',
  'hash:none-here',
  'generation:rcpt-1',
  'entity:ent-1',
  'evidence:evd-1',
  'evidence:gone',
  'snapshot:00000000-0000-4000-8000-000000000001',
  'snapshot:00000000-0000-4000-8000-000000000999',
  'snapshot:demo.refs@1700000000000',
  'session:boss',
  'search:boss/前端',
  'page:https://fixture.test.invalid/jobs',
  'frame:https://fixture.test.invalid/chat',
  'ledger:',
  'nonsense:1',
];

/** 一条岗位行（`job:` 与 `jd:` 两支共用；字段取到判据看得见的几位，其余给占位值）。 */
function jobRow(platform: string, jobId: string): JobRowView {
  return {
    id: 1,
    platform,
    jobId,
    title: '前端工程师',
    company: '假司',
    salaryText: '20-30K',
    salary: null,
    city: '上海',
    experience: '3-5 年',
    education: '本科',
    description: '负责桌面端界面',
    requirements: ['TypeScript', 'React'],
    postedText: '3 天前',
    postedAt: null,
    sourceUrl: `https://fixture.test.invalid/job/${jobId}`,
    capturedAt: 1_700_000_000_000,
    detailCapturedAt: null,
    replied: true,
    inboundCount: 2,
  };
}

/** 一条外发记账行（`ledger:` 那一支的表内容）。 */
function ledgerRow(id: number): LedgerRowView {
  return {
    id,
    action: 'greet',
    targetId: 'boss/9',
    workflowRunId: null,
    ts: 1_700_000_001_000,
    source: null,
    remoteRef: null,
  };
}

/**
 * 装一套「真循环 + 七只归属替身 + 真路由口」，并跑出一步带着 `ALL_REFS` 的 run。
 *
 * `rereadToolId` 指到台架唯一那只只读假手上：循环只在**动作级**那一步之前现问它，
 * 本文件的每一步都是 `read` 级，那条重读路压根不走，因此不必为它另登记一只手（§2.6）。
 * @param without 摘掉哪些归属服务的装配（服务名数组；用来演「没挂载」那一支拒因）
 * @returns 路由口句柄、run id、步下标为 0 的那一步读数、七只替身句柄
 */
async function bootEvidence(without: readonly string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-evidence-'));
  dirs.push(dir);
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  const storeFiber = ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' });
  await storeFiber;
  const toolsFiber = ctx.plugin(AgentToolsService, {});
  await toolsFiber;
  const chatFiber = ctx.plugin(ChatSessionService, {
    chunkChars: 40,
    chunkIntervalMs: 0,
    defaultAutonomy: 'suggest',
    compactTriggerTokens: 600,
    compactKeepRecentMessages: 8,
  });
  await chatFiber;
  const takeoverFiber = ctx.plugin(FakeTakeoverService, {});
  await takeoverFiber;
  const policyFiber = ctx.plugin(AgentPolicyService, {});
  await policyFiber;
  const pauseFiber = ctx.plugin(AgentPauseService, { pauseTimeoutMs: 1000 });
  await pauseFiber;
  const loopFiber = ctx.plugin(AgentLoopService, {
    stepLimit: 12,
    tokenBudget: 4000,
    contextCharsCap: 1200,
    rereadToolId: 'demo.refs',
    replanLimit: 2,
  });
  await loopFiber;
  const app = asApp(ctx);
  app['agent.tools'].register(makeRefsTool());
  app['chat.session'].setAutonomy('auto');

  const owners = new Map<string, Service>();
  const fibers: Fiber[] = [storeFiber, toolsFiber, chatFiber, takeoverFiber, policyFiber, pauseFiber, loopFiber];
  for (const [name, plugin] of OWNERS) {
    if (without.includes(name)) continue;
    const fiber = ctx.plugin(plugin, {});
    await fiber;
    fibers.push(fiber);
    owners.set(name, ctx.get(name));
  }
  const evidenceFiber = ctx.plugin(EvidenceRefService, {});
  await evidenceFiber;
  opened.push(...[evidenceFiber, ...fibers].reverse());

  // 装好归属替身之后先喂数据：`importOf` 之类是纯表查，喂在跑循环前后都一样，这里集中在装完之后。
  seedOwners(owners);

  const proposed = await app['agent.loop'].propose(`demo.refs ${JSON.stringify({ refs: ALL_REFS })}`);
  const finished = await app['agent.loop'].confirm(proposed.runId);
  const evidence = asApp(ctx)['agent.run'];
  return { ctx, evidence, runId: finished.runId, step: finished.steps[0], owners };
}

/**
 * 给七只替身喂各前缀用得上的一条数据（缺哪一只就跳过哪只，配合 `without` 演「没挂载」）。
 * @param owners 服务名 → 替身实例
 */
function seedOwners(owners: Map<string, Service>): void {
  const ledger = owners.get('usage.ledger') as FakeLedgerService | undefined;
  if (ledger) {
    ledger.rows.set(7, ledgerRow(7));
    // 第 999 行不是「没有」而是「读挂」：路由口必须把异常收成一句读数（真装配里缺表就是这一支）。
    ledger.failing.add(999);
  }
  const jd = owners.get('jd.store') as FakeJdStoreService | undefined;
  if (jd) {
    jd.jobs.set('boss/9', jobRow('boss', '9'));
    jd.jobs.set('job-9', jobRow('boss', 'job-9'));
  }
  const doc = owners.get('resume.doc') as FakeDocService | undefined;
  if (doc) {
    doc.documents.set('doc-1', {
      status: 'found',
      document: {
        id: 'doc-1',
        profile: { name: '张三' },
        sections: [
          { title: '工作经历', entries: [1, 2] },
          { title: '技能', entries: [3] },
        ],
        metrics: { pages: 1 },
        updatedAt: 1_700_000_002_000,
      },
    });
    doc.documents.set('doc-corrupt', { status: 'corrupt', reason: '文档 JSON 与指纹不符（内容 hash 校验未过）' });
  }
  const parsed = owners.get('resume.parse') as FakeParseService | undefined;
  if (parsed) {
    parsed.imports.set('deadbeef', {
      docId: 'doc-1',
      sourceHash: 'deadbeef',
      format: 'pdf',
      status: 'needs-review',
      textLength: 1234,
      updatedAt: 1_700_000_003_000,
      issues: [{ code: 'DATE_AMBIGUOUS', sectionKind: 'experience', excerpt: '2020 年至今' }],
    });
  }
  const generated = owners.get('resume.generate') as FakeGenerateService | undefined;
  if (generated) {
    generated.receipts.set('rcpt-1', {
      id: 'rcpt-1',
      docId: 'doc-1',
      jdId: 'job-9',
      createdAt: 1_700_000_004_000,
      promptVersion: 'v1',
      model: 'stub',
      modelStatus: 'stub',
      outcome: 'accepted',
      retried: false,
      evidenceIds: ['evd-1'],
      violations: [],
    });
  }
  const profile = owners.get('kb.profile') as FakeProfileService | undefined;
  if (profile) {
    profile.bodies.set('ent-1', { id: 'ent-1', origin: 'resume', text: '负责过订单中台', sourceDocId: 'doc-1' });
    profile.bodies.set('evd-1', { id: 'evd-1', origin: 'resume', text: '五年 React 经验', sourceDocId: null });
  }
  const snapshot = owners.get('resume.snapshot') as FakeSnapshotService | undefined;
  if (snapshot) {
    snapshot.metas.set('00000000-0000-4000-8000-000000000001', {
      snapshotId: '00000000-0000-4000-8000-000000000001',
      docId: 'doc-1',
      templateId: 'classic',
      fontSet: 'source-han',
      hash: 'abc123',
      createdAt: 1_700_000_005_000,
    });
  }
}

describe('逐前缀的确定结局（5.7-02 的判据核心）', () => {
  it('每一条引用要么给正文、要么给原因，绝不两者都给或都不给，也不抛', async () => {
    const { evidence, runId } = await bootEvidence();
    for (const ref of ALL_REFS) {
      const view = evidence.evidence(runId, 0, ref);
      const hasBody = view.body !== null;
      const hasReason = view.unavailableReason !== null;
      // 异或：两支里恰好挑中一支。这条断言红了就说明某个 `case` 既没 readBack 也没 unreadBack。
      expect(hasBody !== hasReason, `引用 ${ref} 的结局不确定`).toBe(true);
      expect(view.ref).toBe(ref);
      expect(view.kind).toBe(ref.slice(0, ref.indexOf(':')));
      // 读到正文必须有标题行；只给原因就必须把原因写成人话而不是空串。
      if (hasBody) expect(view.title).not.toBeNull();
      else expect((view.unavailableReason ?? '').length).toBeGreaterThan(0);
    }
  });

  it('不认识的引用不编读数，只说「路由表里没有这一类」', async () => {
    const { evidence, runId } = await bootEvidence();
    const view = evidence.evidence(runId, 0, 'nonsense:1');
    expect(view.body).toBeNull();
    expect(view.unavailableReason).toContain('nonsense');
  });

  it('只有前缀没有 id 的引用算「没有可定点读的东西」，不去问任何归属服务', async () => {
    const { evidence, runId } = await bootEvidence();
    const view = evidence.evidence(runId, 0, 'ledger:');
    expect(view.unavailableReason).toContain('没有 id');
  });
});

describe('读到正文的那几支给的是归属读数', () => {
  it('账本行给动作与对象，并把行上的时刻原样带出', async () => {
    const { evidence, runId } = await bootEvidence();
    const view = evidence.evidence(runId, 0, 'ledger:7');
    expect(view.title).toContain('greet');
    expect(view.body).toContain('对象：boss/9');
    expect(view.at).toBe(1_700_000_001_000);
  });

  it('岗位引用两种形状都能读到，正文含薪资、要求条数与回复状态', async () => {
    const { evidence, runId } = await bootEvidence();
    const viaJob = evidence.evidence(runId, 0, 'job:boss/9');
    const viaJd = evidence.evidence(runId, 0, 'jd:job-9');
    expect(viaJob.title).toBe('前端工程师 · 假司');
    expect(viaJob.body).toContain('要求条目：2 条');
    expect(viaJob.body).toContain('来话 2 条');
    expect(viaJd.body).toContain('平台：boss');
    expect(viaJd.at).toBe(1_700_000_000_000);
  });

  it('简历工作副本只给结构读数，并明说全文在简历页——不在这里搬第二份全文', async () => {
    const { evidence, runId } = await bootEvidence();
    const view = evidence.evidence(runId, 0, 'doc:doc-1');
    expect(view.title).toContain('张三');
    expect(view.body).toContain('工作经历（2 条）');
    expect(view.body).toContain('这里不搬第二份全文');
  });

  it('导入记录带出待确认条目，条数超过展示上限时只说「另 N 条」', async () => {
    const { evidence, runId, owners } = await bootEvidence();
    const parsed = owners.get('resume.parse') as FakeParseService;
    const record = parsed.imports.get('deadbeef') as { issues: unknown[] };
    record.issues = Array.from({ length: 7 }, (_unused, index) => ({
      code: `CODE_${String(index)}`,
      sectionKind: null,
      excerpt: `片段${String(index)}`,
    }));
    const view = evidence.evidence(runId, 0, 'hash:deadbeef');
    expect(view.body).toContain('待确认条目：7 条');
    expect(view.body).toContain('…另 2 条');
  });

  it('生成回执读的是库里那一行，含模型、依据条目数与未通过项', async () => {
    const { evidence, runId } = await bootEvidence();
    const view = evidence.evidence(runId, 0, 'generation:rcpt-1');
    expect(view.title).toContain('accepted');
    expect(view.body).toContain('依据条目：1 条');
    expect(view.body).toContain('事实校验未通过项：无');
  });

  it('实体与切片两种前缀共用 `evidenceBody`，正文原样带出、出处缺失也如实说', async () => {
    const { evidence, runId } = await bootEvidence();
    const entity = evidence.evidence(runId, 0, 'entity:ent-1');
    const slice = evidence.evidence(runId, 0, 'evidence:evd-1');
    expect(entity.body).toContain('负责过订单中台');
    expect(entity.body).toContain('出处：doc-1');
    expect(slice.body).toContain('手工录入（没有来源文档）');
  });

  it('简历快照给元数据而不是第二份全文', async () => {
    const { evidence, runId } = await bootEvidence();
    const view = evidence.evidence(runId, 0, 'snapshot:00000000-0000-4000-8000-000000000001');
    expect(view.title).toContain('classic');
    expect(view.body).toContain('内容指纹：abc123');
    expect(view.at).toBe(1_700_000_005_000);
  });
});

describe('读不到正文的那几支，各有各的一句原因', () => {
  it('会话引用说明登录态是现读的，不假装有一条正文', async () => {
    const { evidence, runId } = await bootEvidence();
    const view = evidence.evidence(runId, 0, 'session:boss');
    expect(view.unavailableReason).toContain('boss 的登录分区');
  });

  it('搜索引用说明它是入口而不是记录 id，并把人指向逐条引用', async () => {
    const { evidence, runId } = await bootEvidence();
    const view = evidence.evidence(runId, 0, 'search:boss/前端');
    expect(view.unavailableReason).toContain('不是一条记录的 id');
  });

  it('页面与帧引用说明 DOM 没随引用落盘，并说明截图归工作流那份', async () => {
    const { evidence, runId } = await bootEvidence();
    const page = evidence.evidence(runId, 0, 'page:https://fixture.test.invalid/jobs');
    const frame = evidence.evidence(runId, 0, 'frame:https://fixture.test.invalid/chat');
    expect(page.unavailableReason).toContain('DOM 正文没有随引用落盘');
    expect(frame.unavailableReason).toContain('工作流那边按 run + 节点另存');
  });

  it('带时刻的 snapshot 引用按时刻解释，并把那个时刻原样交回界面格式化', async () => {
    const { evidence, runId } = await bootEvidence();
    const view = evidence.evidence(runId, 0, 'snapshot:demo.refs@1700000000000');
    expect(view.body).toBeNull();
    expect(view.unavailableReason).toContain('记的是时刻不是文件');
    expect(view.at).toBe(1_700_000_000_000);
  });

  it('归属服务没挂载时说「没挂载」，与「库里没有这一行」是两句不同的话', async () => {
    const { evidence, runId } = await bootEvidence(['usage.ledger']);
    const absent = evidence.evidence(runId, 0, 'ledger:7');
    expect(absent.unavailableReason).toContain('没有挂载');
    expect(absent.unavailableReason).toContain('用量账本');
  });

  it('服务在、库里那一行不在：每类前缀说的都是「查不到这一条」而不是「没挂载」', async () => {
    const { evidence, runId } = await bootEvidence();
    const cases: [string, string][] = [
      ['ledger:404', '账本里没有第 404 行'],
      ['job:boss/gone', '库里没有第 boss 平台的岗位 gone'],
      ['doc:doc-gone', '工作副本里没有'],
      ['hash:none-here', '导入记录里没有指纹'],
      ['evidence:gone', '知识库里查不到'],
      ['snapshot:00000000-0000-4000-8000-000000000999', '快照表里没有'],
    ];
    for (const [ref, expected] of cases) {
      const view = evidence.evidence(runId, 0, ref);
      expect(view.body).toBeNull();
      expect(view.unavailableReason, ref).toContain(expected);
      expect(view.unavailableReason, ref).not.toContain('没有挂载');
    }
  });

  it('工作副本读回校验失败时把校验那句原话带出来，不折成一句「读不到」', async () => {
    const { evidence, runId } = await bootEvidence();
    const view = evidence.evidence(runId, 0, 'doc:doc-corrupt');
    expect(view.unavailableReason).toContain('文档 JSON 与指纹不符');
  });

  it('归属服务自己抛出来时收成一句读数，异常不穿到进程边界外', async () => {
    const { evidence, runId } = await bootEvidence();
    const view = evidence.evidence(runId, 0, 'ledger:999');
    expect(view.body).toBeNull();
    expect(view.unavailableReason).toContain('归属服务读数失败');
    // 服务自己的原话要带出来：只说「读不到」会让人去查错地方。
    expect(view.unavailableReason).toContain('模拟：账本自己的表还没建起来');
  });
});

describe('归属没验过就不读别人的记录', () => {
  it('run 查不到时不给任何归属读数', async () => {
    const { evidence } = await bootEvidence();
    const view = evidence.evidence('run-does-not-exist', 0, 'ledger:7');
    expect(view.body).toBeNull();
    expect(view.unavailableReason).toContain('查不到这条 run');
  });

  it('步下标不是整数或越界时算「不属于这一步」', async () => {
    const { evidence, runId } = await bootEvidence();
    expect(evidence.evidence(runId, 3, 'ledger:7').unavailableReason).toContain('没有落步记录');
    expect(evidence.evidence(runId, -1, 'ledger:7').unavailableReason).toContain('不是一个合法的步骤序号');
    expect(evidence.evidence(runId, 0.5, 'ledger:7').unavailableReason).toContain('不是一个合法的步骤序号');
  });

  it('那一步没登记过的引用被挡下，不去查归属服务', async () => {
    const { evidence, runId } = await bootEvidence();
    const view = evidence.evidence(runId, 0, 'ledger:8');
    expect(view.body).toBeNull();
    expect(view.unavailableReason).toContain('没有这一条');
  });

  it('空引用直接被拒，不去问 run 也不去问任何服务', async () => {
    const { evidence, runId } = await bootEvidence();
    expect(evidence.evidence(runId, 0, '').unavailableReason).toContain('这条引用是空的');
  });
});

describe('这只口不建表、不改任何东西', () => {
  it('挂上它之后号段里仍然只有循环那一份（它自己不占迁移号段）', async () => {
    const { ctx } = await bootEvidence();
    const store = asApp(ctx).store;
    const versions = store.migrations.map((migration) => migration.version);
    expect(versions.filter((version) => version === AGENT_RUN_MIGRATION_VERSION)).toHaveLength(1);
    expect(ctx.get('agent.run')).toBeInstanceOf(EvidenceRefService);
  });
});
