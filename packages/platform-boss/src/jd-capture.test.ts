/**
 * `jd.capture` 的编排用例（spec 2.3-01 / 2.3-04 / 2.3-06 / 2.3-07 / 2.3-08 / 2.3-11 / 2.7-03）
 * 与节点执行器用例（spec 2.4-01 / 2.4-07 / 2.4-09）。
 *
 * 这条链路挂**真实**的平台适配器、库、账本与闸门，只替一只读页面的手和一张登记处的表：
 * 「停止条件」「阶段先后」「单条失败隔离」「抓取占哪一条额度」都是这几位协作的行为，
 * 任何一位被 mock 掉都会让对应的那条验收变成自证。页面读数来自 `test-doubles.ts` 的脚本，
 * 全程不访问真实平台（AGENTS.md §7.2）。登记处之所以能用替身：平台包不能 import L3 的
 * `plugin-workflow`（AGENTS.md §4.1），而这里要验收的是「init 有没有交出去、让出有没有中途收手」，
 * 登记处那张表本身由 `packages/workflow/src/runner.test.ts` 用真服务覆盖。
 */
import {
  asApp,
  Context,
  executorRegistryOf,
  fiberState,
  NO_CONFIG,
  type Fiber,
  type WorkflowNodeInvocation,
  type WorkflowNodeSpec,
} from '@auto-cc/core';
import { PlatformRegistryService } from '@auto-cc/plugin-browser';
import { ConfigService } from '@auto-cc/plugin-config';
import {
  DEFAULT_DAILY_LIMITS,
  EntitlementGateService,
  UsageLedgerService,
  type GateConfig,
} from '@auto-cc/plugin-entitlement';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { conversationMigration } from './conversation-store.js';
import { BossPlatformService, loadBossKnowledgePack } from './index.js';
import {
  JdCaptureService,
  jdCaptureSchema,
  draftFromDetail,
  draftFromSummary,
  type JdCaptureConfig,
} from './jd-capture.js';
import { JdStoreService } from './jd-store.js';
import {
  cardRow,
  createFakeAct,
  createFakePage,
  DETAIL_BASE,
  detailRow,
  extractOf,
  FakeAgentToolsService,
  FakeExecutorRegistryService,
  LIST_URL,
  StubBrowserActService,
  StubBrowserPageService,
  StubOutboundThrottleService,
  StubSessionsService,
  type PageScript,
} from './test-doubles.js';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];
const pack = loadBossKnowledgePack();

/** 进度事件读数（与 `core` 的 `jd/progress` 声明同形）。 */
type ProgressEvent = {
  phase: 'listing' | 'detail' | 'done';
  round: number;
  containers: number;
  stored: number;
  target: number;
  currentTitle: string;
  at: number;
};

/** 抓取配置的默认值（用例只改自己在意的那一项）。 */
const captureConfig = (overrides: Partial<JdCaptureConfig> = {}): JdCaptureConfig => ({
  platform: 'boss',
  targetCount: 20,
  maxRounds: 8,
  ...overrides,
});

/**
 * 挂起一整条抓取链路。
 * @param script 页面读数脚本
 * @param config 抓取配置覆盖项
 * @param pacer 节奏替身的滚动间隔（毫秒）；默认 0 让用例不等，取消类用例才拉大
 * @param gate 闸门配置；默认 `unlimited`（抓取现在过闸门，spec 2.7-03：不装闸门这条链路根本挂不起来，
 *        而无限模式既放行也照样落账，正好用来观察「一轮 run 记一条 search」）
 * @param agentTools 是否先挂注册表替身（spec 2.8-08 的登记用例要它，其余用例不需要）
 * @returns 上下文、`jd.capture` / `jd.store` 服务、执行器登记处替身、`jd.capture` 的 fiber（卸载用例要先停它）、
 *          假手记账与进度事件列表，以及节奏替身（`draws` 是「取了几次节奏」的读数）
 */
async function boot(
  script: PageScript,
  config: Partial<JdCaptureConfig> = {},
  pacerGapMs = 0,
  gate: GateConfig = { mode: 'unlimited', dailyLimits: DEFAULT_DAILY_LIMITS },
  agentTools = false,
) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-jd-capture-'));
  sandboxes.push(dir);
  const ctx = new Context();
  // 注册表排在最前：登记发生在后挂的能力包里，顺序反了就是「界面上有工具、清单是空的」（plan §15.7 落点 2）。
  if (agentTools) fibers.push(await ctx.plugin(FakeAgentToolsService, NO_CONFIG));
  const events: ProgressEvent[] = [];
  ctx.on('jd/progress', (event: ProgressEvent) => events.push(event));
  const fake = createFakePage(script);

  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  // 登记处排在最前：装配是顺序 await 的，`jd.store` / `jd.capture` 的 init 才拿得到它（spec 2.4-01）。
  fibers.push(await ctx.plugin(FakeExecutorRegistryService, {}));
  fibers.push(await ctx.plugin(StubBrowserPageService, { fake }));
  // `platform.boss` 从 2.5-d 起还 inject 了 `browser.act`：这只替身必须一起装，否则适配器停在 PENDING、
  // 下面的抓取链路一步都走不动（本用例只读页面，那只假动作手一次也不会被用到）。
  fibers.push(await ctx.plugin(StubBrowserActService, { fake: createFakeAct() }));
  fibers.push(await ctx.plugin(StubOutboundThrottleService, { scrollGapMs: pacerGapMs }));
  // 风险确认替身：`jd.capture` 从 2.7-e 起 inject 了 `sessions`（spec 2.7-06 的抓取侧硬拦）。
  // 默认让它「已签过 boss」，本文件的用例才继续测抓取本身；没签那一支在文末单独演。
  fibers.push(await ctx.plugin(StubSessionsService, {}));
  const sessions = ctx.get('sessions') as unknown as StubSessionsService;
  sessions.grant('boss');
  fibers.push(await ctx.plugin(PlatformRegistryService, NO_CONFIG));
  fibers.push(await ctx.plugin(UsageLedgerService, {}));
  // 真实闸门（不是替身）：2.7-03 要验收的正是「抓取走的是那个唯一的判定 + 落账口」，mock 掉它等于自证。
  fibers.push(await ctx.plugin(EntitlementGateService, gate));
  fibers.push(await ctx.plugin(JdStoreService, {}));
  // 真实适配器：`browser.page` 那一步取到的是上面那只替身。
  fibers.push(await ctx.plugin(BossPlatformService, {}));
  const captureFiber = await ctx.plugin(JdCaptureService, captureConfig(config));
  fibers.push(captureFiber);

  const app = asApp(ctx);
  // `jd.store.list` 现在左连会话表算「已回复」（spec 2.5-08），真实装配里那张表由 `conversation.store` 建，
  // 这里只补 DDL：本用例测的是抓取，不需要整条会话链路，也不该把迁移台账推到号段 5。
  conversationMigration.up(app.store.db);
  return {
    ctx,
    capture: app['jd.capture'],
    jd: app['jd.store'],
    ledger: app['usage.ledger'],
    gate: app['entitlement.gate'],
    executors: executorRegistryOf(ctx),
    captureFiber,
    fake,
    sessions,
    pacer: ctx.get('outbound.throttle') as StubOutboundThrottleService,
    events,
    tools: agentTools ? (ctx.get('agent.tools') as unknown as FakeAgentToolsService) : null,
  };
}

/**
 * 造一个 `jd.capture` 的节点声明，用来直接调用登记处里那个执行函数。
 * @param params 计划作者写的参数（`query` / `city` / `target`）
 * @returns runner 会递给执行器的完整声明
 */
function captureNodeSpec(params: WorkflowNodeSpec['params']): WorkflowNodeSpec {
  return {
    id: 'jd-capture',
    kind: 'jd.capture',
    target: '',
    params,
    effect: 'read',
    retryTimes: null,
    requiresHuman: false,
  };
}

/**
 * 造一次执行输入。
 * @param spec 节点声明
 * @param signal 让出信号（省略就是不取消的第一次尝试）
 * @returns 执行器的入参
 */
function invocationOf(spec: WorkflowNodeSpec, signal = new AbortController().signal): WorkflowNodeInvocation {
  return { runId: 'run-unit', spec, attempt: 1, signal };
}

/** 两屏列表：第二屏把第一屏的卡片留在 DOM 里，另外长出新的（无限滚动的常态）。 */
const twoScreenScript = (detailJobIds: string[]): PageScript => ({
  listContainer: pack.locators.jobCard!,
  list: [
    extractOf(LIST_URL, [cardRow(0, '1001'), cardRow(1, '1002')]),
    extractOf(LIST_URL, [cardRow(0, '1001'), cardRow(1, '1002'), cardRow(2, '1003')]),
  ],
  detail: detailJobIds.map((jobId) => extractOf(`${DETAIL_BASE}?jobId=${jobId}`, [detailRow(jobId)])),
});

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上句柄延迟释放会留下残渣：清理失败不该判失败。
    }
  }
});

describe('抓取编排（spec 2.3-01 / 2.3-06）', () => {
  it('先滚够列表、再逐条读详情：详情页的导航一定排在所有列表抽取之后', async () => {
    const { capture, fake, jd } = await boot(twoScreenScript(['1001', '1002', '1003']), { targetCount: 3 });
    const run = await capture.run({ keyword: '前端工程师', city: '上海' });

    expect(run).toMatchObject({
      platform: 'boss',
      keyword: '前端工程师',
      city: '上海',
      rounds: 2,
      stoppedBy: 'target-count',
    });
    expect(run.containers).toBe(5);
    expect(run.stored).toBe(3);
    expect(run.total).toBe(3);
    expect(jd.status()).toMatchObject({ total: 3, withDetail: 3 });

    // 两阶段的硬约束：抽取请求先是 2 次列表、再是 3 次详情；导航第一次是搜索页，其后才是详情页。
    // 类别由假手自己记账——`platform.boss` 用的是它自己那份知识包实例，测试里的 `pack.locators.jobCard`
    // 与请求里的容器「内容相同但不是同一对象」，在测试侧比引用会全部判成详情。
    expect(fake.kinds).toEqual(['list', 'list', 'detail', 'detail', 'detail']);
    expect(fake.navigated[0]).toContain('query=');
    expect(fake.navigated.slice(1)).toEqual(['1001', '1002', '1003'].map((jobId) => `${DETAIL_BASE}?jobId=${jobId}`));
    // 只滚了一次：第二轮攒够目标条数就不该再触发加载。
    expect(fake.scrolls).toBe(1);
  });

  it('页面不再长出新内容时停在 no-new-content，不空转到轮数上限', async () => {
    const { capture, fake } = await boot(
      {
        listContainer: pack.locators.jobCard!,
        list: [extractOf(LIST_URL, [cardRow(0, '2001'), cardRow(1, '2002')])],
        detail: [
          extractOf(`${DETAIL_BASE}?jobId=2001`, [detailRow('2001')]),
          extractOf(`${DETAIL_BASE}?jobId=2002`, [detailRow('2002')]),
        ],
      },
      { targetCount: 10, maxRounds: 6 },
    );
    const run = await capture.run({ keyword: '前端' });
    expect(run).toMatchObject({ rounds: 2, containers: 4, stored: 2, stoppedBy: 'no-new-content' });
    expect(fake.scrolls).toBe(1);
  });

  it('每屏都长出新东西时靠 maxRounds 硬停，绝不无限滚', async () => {
    const { capture, fake } = await boot(
      {
        listContainer: pack.locators.jobCard!,
        list: [
          extractOf(LIST_URL, [cardRow(0, '3001'), cardRow(1, '3002')]),
          extractOf(LIST_URL, [cardRow(0, '3003'), cardRow(1, '3004')]),
          extractOf(LIST_URL, [cardRow(0, '3005')]),
        ],
        detail: [],
      },
      { targetCount: 50, maxRounds: 2 },
    );
    const run = await capture.run({ keyword: '前端' });
    expect(run).toMatchObject({ rounds: 2, containers: 4, stored: 4, stoppedBy: 'max-rounds' });
    // 详情队列为空 → 详情页什么都读不到 → 四条都记进 skipped，整轮仍然收尾。
    expect(run.skipped).toHaveLength(4);
    expect(fake.scrolls).toBe(2);
  });

  it('criteria.limit 在配置目标之内收紧本次目标条数（界面「先抓 5 条」就靠它）', async () => {
    const { capture, fake } = await boot(twoScreenScript(['1001', '1002']), { targetCount: 20 });
    const run = await capture.run({ keyword: '前端', limit: 2 });
    expect(run).toMatchObject({ rounds: 1, stored: 2, stoppedBy: 'target-count' });
    expect(fake.scrolls).toBe(0);
  });

  it('关键词为空时结构化失败，且不留下半个运行读数', async () => {
    const { capture, jd } = await boot(twoScreenScript(['1001']), { targetCount: 1 });
    await expect(capture.run({ keyword: '  ' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      path: 'platform.boss',
    });
    expect(jd.count()).toBe(0);
    expect(capture.status().lastRun).toBeNull();
  });

  it('目标平台没登记时报平台未登记，并说明当前装着哪些', async () => {
    const { capture } = await boot(twoScreenScript(['1001']), { platform: 'lagou' });
    await expect(capture.run({ keyword: '前端' })).rejects.toMatchObject({ code: 'PLATFORM_NOT_REGISTERED' });
  });
});

describe('重复抓取（spec 2.3-04 的实际收益）', () => {
  it('第二轮不再跑已经读过详情的行，库里也只有一行一岗', async () => {
    const { capture, fake, jd } = await boot(twoScreenScript(['1001', '1002', '1003']), { targetCount: 3 });
    const first = await capture.run({ keyword: '前端' });
    const detailRequestsAfterFirst = fake.kinds.filter((kind) => kind === 'detail').length;

    const second = await capture.run({ keyword: '前端' });
    const detailRequestsAfterSecond = fake.kinds.filter((kind) => kind === 'detail').length;

    expect(first.total).toBe(3);
    expect(second).toMatchObject({ stored: 3, skipped: [], stoppedBy: 'target-count' });
    // 第二次只碰列表：三条都有详情了，阶段 B 无事可做。
    expect(detailRequestsAfterSecond).toBe(detailRequestsAfterFirst);
    expect(jd.count()).toBe(3);
    expect(jd.status().withDetail).toBe(3);
  });

  it('上一屏已入库的行不会因为这一屏重读而变成第二行', async () => {
    const { capture, jd } = await boot(twoScreenScript(['1001', '1002', '1003']), { targetCount: 3 });
    await capture.run({ keyword: '前端' });
    expect(jd.list(500).rows.map((row) => row.title)).toEqual([
      '资深前端工程师 1003',
      '资深前端工程师 1002',
      '资深前端工程师 1001',
    ]);
    expect(jd.count()).toBe(3);
  });
});

describe('单条失败隔离（spec 2.3-08）', () => {
  it('一条详情页读不到只进 skipped，其余照常落库', async () => {
    const { capture, jd } = await boot(
      {
        listContainer: pack.locators.jobCard!,
        list: [extractOf(LIST_URL, [cardRow(0, '4001'), cardRow(1, '4002')])],
        detail: [
          extractOf(`${DETAIL_BASE}?jobId=4001`, [detailRow('4001')]),
          extractOf(`${DETAIL_BASE}?jobId=4002`, [detailRow('4002', { description: null })]),
        ],
      },
      { targetCount: 5 },
    );
    const run = await capture.run({ keyword: '前端' });
    expect(run.stoppedBy).toBe('no-new-content');
    expect(run.skipped).toEqual([
      {
        title: '资深前端工程师 4002',
        sourceUrl: `${DETAIL_BASE}?jobId=4002`,
        reason: '详情页读不到岗位职责正文',
      },
    ]);
    expect(jd.status()).toMatchObject({ total: 2, withDetail: 1 });
    // 失败的那条保留了列表页读到的信息，不是一行都没有。
    const broken = jd.list(500).rows.find((row) => row.jobId === '4002');
    expect(broken).toMatchObject({
      title: '资深前端工程师 4002',
      company: '示例科技',
      description: '',
      detailCapturedAt: null,
    });
  });

  it('列表整屏一张卡都读不到不报错：第二轮的「无新内容」判定把它停下来', async () => {
    const { capture } = await boot({ listContainer: pack.locators.jobCard!, list: [], detail: [] }, { maxRounds: 4 });
    const result = await capture.run({ keyword: '前端' });
    expect(result).toMatchObject({ rounds: 1, containers: 0, stored: 0, skipped: [], stoppedBy: 'no-new-content' });
  });
});

describe('抓取占的是 search 那一条额度（spec 2.7-03，并更正 2.3-11 的原判据）', () => {
  it('一轮 run 只落一条 `search` 账，且抓取期间没有别的动作记过账', async () => {
    const { capture, ledger } = await boot(twoScreenScript(['1001', '1002', '1003']), { targetCount: 3 });
    expect(ledger.count()).toBe(0);
    const run = await capture.run({ keyword: '前端' });
    // 2.3-11 的原读数理所应当保留：这两个数取样于 `perform` 落账**之前**，相等就证明
    // 「滚读与逐条详情」这条只读链路上没有任何动作记过账 —— 它证明的从来不是「抓取不入账」。
    expect(run).toMatchObject({ ledgerRowsBefore: 0, ledgerRowsAfter: 0 });
    // 而整轮 run 自己占一条 `search`：一次成功抓取 = 一条账，失败或被拒都没有。
    expect(ledger.count()).toBe(1);
    expect(ledger.summary().recent[0]).toMatchObject({ action: 'search', targetId: '前端' });
  });

  it('第 N+1 轮在开始之前就被拒：不导航、不滚动、不落账（2.7-03 的「超限即停」）', async () => {
    const { capture, fake, ledger, events } = await boot(
      twoScreenScript(['1001', '1002', '1003']),
      { targetCount: 3 },
      0,
      { mode: 'daily', dailyLimits: { ...DEFAULT_DAILY_LIMITS, search: 1 } },
    );
    await capture.run({ keyword: '前端' });
    const navigated = fake.navigated.length;
    const scrolls = fake.scrolls;
    const progressed = events.length;

    await expect(capture.run({ keyword: '后端' })).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { action: 'search' },
    });
    // 判定在编排之前（`gate.perform` 里 check 先跑），所以第二个工作轮连一次页面调用都没留下；
    // 若这里读到了新增，就说明抓取是「先跑完再说额度不够」，那正是 §7.3 要防的形态。
    expect(fake.navigated).toHaveLength(navigated);
    expect(fake.scrolls).toBe(scrolls);
    expect(events).toHaveLength(progressed);
    expect(ledger.count()).toBe(1);
  });

  it('抓满 search 之后，打招呼与投递的额度一条没少（三条互不占用）', async () => {
    const { capture, gate } = await boot(twoScreenScript(['1001', '1002', '1003']), { targetCount: 3 }, 0, {
      mode: 'daily',
      dailyLimits: { ...DEFAULT_DAILY_LIMITS, search: 1 },
    });
    await capture.run({ keyword: '前端' });
    expect(gate.check('search')).toMatchObject({ allowed: false, remaining: 0 });
    expect(gate.check('greet')).toMatchObject({ allowed: true, remaining: DEFAULT_DAILY_LIMITS.greet });
    expect(gate.check('deliver')).toMatchObject({ allowed: true, remaining: DEFAULT_DAILY_LIMITS.deliver });
  });

  it('摘掉闸门后抓取服务根本不挂载（外发必经闸门的另一半：PENDING 而不是静默少判）', async () => {
    // 这一条是 1.9-05 的结构在 `jd.capture` 上的对应物：`inject` 里有 `entitlement.gate`，
    // 依赖缺席时 cordis 把 fiber 留在 PENDING，界面点「搜索并入库」得到的是未挂载而不是「照跑但没记账」。
    const dir = mkdtempSync(join(tmpdir(), 'auto-cc-jd-capture-'));
    sandboxes.push(dir);
    const ctx = new Context();
    await ctx.plugin(ConfigService, { appName: 'auto-cc' });
    await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' });
    await ctx.plugin(FakeExecutorRegistryService, {});
    await ctx.plugin(StubBrowserPageService, { fake: createFakePage(twoScreenScript(['1001'])) });
    await ctx.plugin(StubBrowserActService, { fake: createFakeAct() });
    await ctx.plugin(StubOutboundThrottleService, { scrollGapMs: 0 });
    // 风险确认替身照样挂：这一条要验收的是「缺闸门」这一种缺席，别让它和「缺 sessions」混在一起。
    await ctx.plugin(StubSessionsService, {});
    await ctx.plugin(PlatformRegistryService, NO_CONFIG);
    await ctx.plugin(UsageLedgerService, {});
    await ctx.plugin(JdStoreService, {});
    await ctx.plugin(BossPlatformService, {});
    const captureFiber = await ctx.plugin(JdCaptureService, captureConfig());
    fibers.push(captureFiber);
    expect(fiberState(captureFiber.state)).toBe('pending');
    expect(asApp(ctx).get('jd.capture')).toBeUndefined();
  });
});

describe('进度事件（spec 2.3-07）', () => {
  it('每轮列表一条、每条详情一条，最后一条是 done', async () => {
    const { capture, events } = await boot(twoScreenScript(['1001', '1002', '1003']), { targetCount: 3 });
    await capture.run({ keyword: '前端' });
    expect(events.map((event) => event.phase)).toEqual(['listing', 'listing', 'detail', 'detail', 'detail', 'done']);
    expect(events[0]).toMatchObject({ phase: 'listing', round: 1, containers: 2, stored: 2, target: 3 });
    expect(events[2]).toMatchObject({ phase: 'detail', currentTitle: '资深前端工程师 1001' });
    const last = events.at(-1)!;
    expect(last).toMatchObject({ phase: 'done', stored: 3, target: 3 });
    expect(last.at).toBeGreaterThan(0);
  });

  it('status 回显当期配置，并在跑过之后带回最近一次运行', async () => {
    const { capture } = await boot(twoScreenScript(['1001', '1002', '1003']), { targetCount: 3, maxRounds: 4 });
    // 用 `toEqual` 而不是 `toMatchObject`：节奏归位到 `outbound.throttle` 之后，这里多出一个
    // 「固定间隔」字段就是假读数（spec 2.7-04），逐字对齐才咬得住。
    // `platform` 是 2.7-06 界面拦截点要的那一项：抓取属于哪个平台只能由持有配置的一方说出。
    expect(capture.status()).toEqual({ platform: 'boss', targetCount: 3, maxRounds: 4, lastRun: null });
    const run = await capture.run({ keyword: '前端' });
    expect(capture.status().lastRun).toEqual(run);
  });

  it('滚动与逐条详情的停顿都向节奏服务要，本服务不养自己的计时器（spec 2.7-04）', async () => {
    const { capture, pacer, fake } = await boot(twoScreenScript(['1001', '1002', '1003']), {
      targetCount: 3,
      maxRounds: 4,
    });
    await capture.run({ keyword: '前端' });
    // 取次数 ≥ 滚动次数（阶段 B 每条详情也要一次）：只要抽过水，间隔就不是写死在代码里的。
    expect(fake.scrolls).toBeGreaterThan(0);
    expect(pacer.draws).toBeGreaterThanOrEqual(fake.scrolls);
  });

  it('roundPauseMs 这类抓取侧的间隔配置已被拒（第二套节奏声明不留）', () => {
    expect(jdCaptureSchema.safeParse({ roundPauseMs: 300 }).success).toBe(false);
  });
});

describe('入库草稿的形状（spec 2.3-02 / 2.3-03）', () => {
  it('摘要草稿只有列表字段，详情字段一律留空', () => {
    const summary = {
      platform: 'boss',
      jobId: '5001',
      title: '资深前端工程师',
      company: '示例科技',
      salaryText: '25-40K·15薪',
      city: '上海',
      experience: '3-5 年',
      education: '本科',
      detailUrl: `${DETAIL_BASE}?jobId=5001`,
      capturedAt: 1_700_000_000_000,
    };
    expect(draftFromSummary(summary)).toMatchObject({
      jobId: '5001',
      sourceUrl: `${DETAIL_BASE}?jobId=5001`,
      capturedAt: 1_700_000_000_000,
      description: '',
      requirements: [],
      postedText: '',
      postedAt: null,
      detailCapturedAt: null,
      // 薪资在入库时就归一化，原文另存一列。
      salary: { min: 25, max: 40, unit: 'k', period: 'month', salaryMonths: 15, isNegotiable: false },
    });
    expect(draftFromSummary({ ...summary, salaryText: '' }).salary).toBeNull();
  });

  it('详情草稿把「这次读到的」覆盖上去，发布时间按注入的基准折算', () => {
    const summary = draftFromDetail(
      {
        summary: {
          platform: 'boss',
          jobId: '5002',
          title: '后端工程师',
          company: '示例科技',
          salaryText: '面议',
          city: '杭州',
          experience: '经验不限',
          education: '学历不限',
          detailUrl: `${DETAIL_BASE}?jobId=5002`,
          capturedAt: 1_700_000_000_000,
        },
        description: '负责抓取服务',
        requirements: ['五年经验', '熟悉 Python'],
        postedText: '3 天前',
      },
      1_700_000_000_000,
    );
    expect(summary).toMatchObject({
      description: '负责抓取服务',
      requirements: ['五年经验', '熟悉 Python'],
      postedText: '3 天前',
      postedAt: 1_700_000_000_000 - 3 * 86_400_000,
      detailCapturedAt: 1_700_000_000_000,
      salary: { min: null, max: null, unit: 'unknown', period: 'unknown', isNegotiable: true },
    });
  });
});

describe('作为工作流节点（spec 2.4-01 / 2.4-07 / 2.4-09）', () => {
  it('登记处同时收到 jd.capture 与 jd.list，卸载抓取只摘掉自己那一条', async () => {
    const { executors, captureFiber } = await boot(twoScreenScript(['1001']), { targetCount: 1 });
    // 顺序即挂载顺序：`jd.store` 在 `jd.capture` 之前，登记表因此是这两条。
    expect(executors?.list()).toEqual(['jd.list', 'jd.capture']);
    await captureFiber.dispose();
    // 摘回来只摘自己：库那条还在，否则卸载一个能力包会连带把工作流的另一半弄瞎。
    expect(executors?.list()).toEqual(['jd.list']);
  });

  it('执行函数按计划的参数名跑通整条链路（query/city/target → keyword/city/limit）', async () => {
    const { executors, capture, jd } = await boot(twoScreenScript(['1001', '1002', '1003']));
    const executor = executors?.resolve('jd.capture');
    expect(executor).toBeTypeOf('function');
    await executor?.(invocationOf(captureNodeSpec({ query: '前端工程师', city: '上海', target: 3 })));
    // 翻译只发生在执行器这一处：计划作者不需要认识本服务的内部字段名，而界面入口与共用的 `run()` 形状不变。
    expect(capture.status().lastRun).toMatchObject({ keyword: '前端工程师', city: '上海', stored: 3 });
    expect(jd.status()).toMatchObject({ total: 3, withDetail: 3 });
  });

  it('缺 query 的节点结构化报错，不猜要搜什么', async () => {
    const { executors, jd } = await boot(twoScreenScript(['1001']));
    await expect(
      executors?.resolve('jd.capture')?.(invocationOf(captureNodeSpec({ city: '上海' }))),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', path: 'jd.capture' });
    expect(jd.count()).toBe(0);
  });

  it('让出信号已 aborted 时中途收手：抛出的是让出，且一条都不入库', async () => {
    const { executors, jd, fake } = await boot(twoScreenScript(['1001', '1002', '1003']), { targetCount: 3 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      executors?.resolve('jd.capture')?.(invocationOf(captureNodeSpec({ query: '前端' }), controller.signal)),
    ).rejects.toThrowError(/工作流让出/);
    // 让出发生在列表循环的第一圈检查点：库里干净，runner 那侧据信号把它记成让出而非节点失败。
    expect(jd.count()).toBe(0);
    expect(fake.kinds).toEqual([]);
  });

  it('跑到一半才 aborted 时停在下一次检查点，已入库的行留在库里', async () => {
    // 轮间间隔给到 2s（由节奏替身给出）：取消一定落在「列表阶段之后的那次等待」里，而不是落进还没开始的空档。
    const { executors, jd, fake } = await boot(
      twoScreenScript(['1001', '1002', '1003']),
      { targetCount: 3, maxRounds: 1 },
      2_000,
    );
    const controller = new AbortController();
    const pending = executors?.resolve('jd.capture')?.(
      invocationOf(captureNodeSpec({ query: '前端', target: 3 }), controller.signal),
    );
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toThrowError(/工作流让出/);
    // 第一屏的两条已经落了库（让出不回滚已完成的行），而详情阶段一条都没碰过。
    expect(jd.count()).toBe(2);
    expect(fake.kinds).toEqual(['list']);
    expect(fake.navigated).toHaveLength(1);
  });
});

describe('接管后重新读页面（spec 2.8-11 的 C 半边）', () => {
  it('恢复=从头重放这一格：第二次读的是页面此刻的列表，不是上一次那份快照', async () => {
    // 两屏是**换掉**而不是叠加：接管期间用户在页面上动了手（清了验证码、改了筛选条件），
    // 列表里已经没有 1001、只剩 2002。抓取服务与适配器都没有页面缓存，所以第二圈必须看见新内容。
    const script: PageScript = {
      listContainer: pack.locators.jobCard!,
      list: [extractOf(LIST_URL, [cardRow(0, '1001')]), extractOf(LIST_URL, [cardRow(0, '2002')])],
      detail: ['1001', '2002'].map((jobId) => extractOf(`${DETAIL_BASE}?jobId=${jobId}`, [detailRow(jobId)])),
    };
    const { executors, jd, fake } = await boot(script, { targetCount: 1 });
    const executor = executors?.resolve('jd.capture');
    const spec = captureNodeSpec({ query: '前端工程师', city: '上海', target: 1 });

    await executor?.(invocationOf(spec));
    expect(jd.list(500).rows.map((row) => row.jobId)).toEqual(['1001']);
    // 接管前的一格：一次搜索页导航 → 一次列表抽取 → 一次详情。
    expect(fake.kinds).toEqual(['list', 'detail']);
    expect(fake.navigated[0]).toContain('query=');

    // 恢复：runner 把 `stepIndex` 指回这一步、换一只新的让出信号，再调**同一个**执行器（spec 2.4-07 的续跑形状）。
    await executor?.(invocationOf(spec));

    // 重读发生的两处读数：又一次搜索页导航、又一次列表抽取（不是从上一圈的收集里接着往下走）。
    expect(fake.kinds).toEqual(['list', 'detail', 'list', 'detail']);
    expect(fake.navigated.filter((url) => url.includes('query='))).toHaveLength(2);
    // 2002 的地址**只出现在第二屏**：适配器靠列表读出来的 `seen` 表把 jobId 翻译成详情页地址，
    // 没有重读列表的话这一步会直接抛「没见过 jobId 2002」，库里也就永远等不来这一行。
    expect(fake.navigated.at(-1)).toBe(`${DETAIL_BASE}?jobId=2002`);
    expect(
      jd
        .list(500)
        .rows.map((row) => row.jobId)
        .sort(),
    ).toEqual(['1001', '2002']);
    expect(jd.status()).toMatchObject({ total: 2, withDetail: 2 });
  });
});

describe('首次启用自动化的风险确认（spec 2.7-06 的抓取侧）', () => {
  it('没签过字：CONSENT_REQUIRED，一次页面调用都不发、一条额度也不扣', async () => {
    const { capture, sessions, gate, fake, ledger, events } = await boot(twoScreenScript(['1001', '1002']));
    sessions.revoke('boss');
    await expect(capture.run({ keyword: '前端' })).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
      details: { platform: 'boss' },
    });
    // 抓取也是「启用自动化」：没认下风险之前不许先产生站点流量（AGENTS.md §8 第 3 条）。
    expect(fake.navigated).toEqual([]);
    expect(fake.requests).toEqual([]);
    expect(events).toEqual([]);
    expect(ledger.count()).toBe(0);
    expect(gate.check('search')).toMatchObject({ allowed: true });
  });

  it('签字判据排在闸门之前：额度已见底的库，未签字给出的仍是 CONSENT_REQUIRED', async () => {
    const gateConfig: GateConfig = { mode: 'daily', dailyLimits: { ...DEFAULT_DAILY_LIMITS, search: 1 } };
    const { capture, sessions, gate, fake } = await boot(
      twoScreenScript(['1001', '1002', '1003']),
      { targetCount: 3 },
      0,
      gateConfig,
    );
    await capture.run({ keyword: '前端' });
    expect(gate.check('search')).toMatchObject({ allowed: false, remaining: 0 });
    sessions.revoke('boss');
    const navigated = fake.navigated.length;
    await expect(capture.run({ keyword: '后端' })).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    // 若是先过闸门，这里拿到的是 QUOTA_EXCEEDED（「明天再来」），而正确答案是「先点确认」。
    expect(fake.navigated).toHaveLength(navigated);
  });

  it('补上签字之后同一条链路走得通：一次 run 只问一次签字', async () => {
    const { capture, sessions, fake, ledger } = await boot(twoScreenScript(['1001', '1002', '1003']), {
      targetCount: 3,
    });
    sessions.revoke('boss');
    await expect(capture.run({ keyword: '前端' })).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    sessions.grant('boss');
    const before = sessions.asks;
    await capture.run({ keyword: '前端' });
    expect(fake.navigated.length).toBeGreaterThan(0);
    expect(ledger.count()).toBe(1);
    expect(sessions.asks - before).toBe(1);
  });
});

/**
 * agent 工具面这一侧的抓取（spec 2.8-08 / 2.8-10）。
 *
 * 抓取标 `outbound` 不是因为它往站点点东西，而是它已经在 `entitlement.gate` 里占一条 `search` 额度
 * （plan §15.7 落点 4）。工具层不重复设闸（落点 5），所以这组用例判的还是那两件事：
 * 一次工具调用只落一条账，且没签字时连一次导航都不发。
 */
describe('agent 工具路径上的抓取闸门与账本（spec 2.8-08 / 2.8-10）', () => {
  it('挂载即在注册表里登记一只外发工具，id 与服务口名一致且带「需批准」', async () => {
    const { tools } = await boot(twoScreenScript(['1001']), { targetCount: 1 }, 0, undefined, true);
    expect(tools?.list()).toEqual([{ id: 'jd.capture.run', effect: 'outbound', requiresConfirmation: true }]);
  });

  it('从工具路径跑一轮：入库读数与直调一致，且只落一条 search 账', async () => {
    const { tools, ledger } = await boot(
      twoScreenScript(['1001', '1002', '1003']),
      { targetCount: 3 },
      0,
      undefined,
      true,
    );
    const reply = await tools?.call('jd.capture.run', { criteria: { keyword: '前端', city: '上海' } });
    expect(reply).toMatchObject({
      ok: true,
      value: { platform: 'boss', keyword: '前端', city: '上海', stored: 3, total: 3 },
    });
    expect(ledger.count()).toBe(1);
    expect(ledger.summary().recent[0]).toMatchObject({ action: 'search', targetId: '前端' });
  });

  it('对话入口调抓取：没签过字被 CONSENT_REQUIRED 拦下，一次导航都不发也不落账（2.8-10）', async () => {
    const { tools, sessions, fake, ledger } = await boot(
      twoScreenScript(['1001', '1002', '1003']),
      { targetCount: 3 },
      0,
      undefined,
      true,
    );
    sessions.revoke('boss');
    await expect(tools?.call('jd.capture.run', { criteria: { keyword: '前端' } })).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });
    expect(fake.navigated).toHaveLength(0);
    expect(ledger.count()).toBe(0);
  });

  it('入参不合法时被声明自己的 schema 拦下：不进实现、不落账', async () => {
    const { tools, fake, ledger } = await boot(twoScreenScript(['1001']), { targetCount: 1 }, 0, undefined, true);
    await expect(tools?.call('jd.capture.run', {})).resolves.toEqual({ ok: false, reason: 'INPUT_INVALID' });
    await expect(tools?.call('jd.capture.run', { criteria: { keyword: '前端', limit: 0 } })).resolves.toEqual({
      ok: false,
      reason: 'INPUT_INVALID',
    });
    expect(fake.navigated).toHaveLength(0);
    expect(ledger.count()).toBe(0);
  });

  it('抓取服务卸载时工具一起摘回：清单不会留着指向旧实例的入口', async () => {
    const { tools, captureFiber } = await boot(twoScreenScript(['1001']), { targetCount: 1 }, 0, undefined, true);
    await captureFiber.dispose();
    expect(tools?.removed).toEqual(['jd.capture.run']);
    expect(tools?.list()).toEqual([]);
  });
});
