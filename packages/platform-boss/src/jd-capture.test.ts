/**
 * `jd.capture` 的编排用例（spec 2.3-01 / 2.3-04 / 2.3-06 / 2.3-07 / 2.3-08 / 2.3-11）
 * 与节点执行器用例（spec 2.4-01 / 2.4-07 / 2.4-09）。
 *
 * 这条链路挂**真实**的平台适配器、库与账本，只替一只读页面的手和一张登记处的表：
 * 「停止条件」「阶段先后」「单条失败隔离」「抓取不记账」都是这几位协作的行为，
 * 任何一位被 mock 掉都会让对应的那条验收变成自证。页面读数来自 `test-doubles.ts` 的脚本，
 * 全程不访问真实平台（AGENTS.md §7.2）。登记处之所以能用替身：平台包不能 import L3 的
 * `plugin-workflow`（AGENTS.md §4.1），而这里要验收的是「init 有没有交出去、让出有没有中途收手」，
 * 登记处那张表本身由 `packages/workflow/src/runner.test.ts` 用真服务覆盖。
 */
import {
  asApp,
  Context,
  executorRegistryOf,
  NO_CONFIG,
  type Fiber,
  type WorkflowNodeInvocation,
  type WorkflowNodeSpec,
} from '@auto-cc/core';
import { PlatformRegistryService } from '@auto-cc/plugin-browser';
import { ConfigService } from '@auto-cc/plugin-config';
import { UsageLedgerService } from '@auto-cc/plugin-entitlement';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BossPlatformService, loadBossKnowledgePack } from './index.js';
import { JdCaptureService, draftFromDetail, draftFromSummary, type JdCaptureConfig } from './jd-capture.js';
import { JdStoreService } from './jd-store.js';
import {
  cardRow,
  createFakeAct,
  createFakePage,
  DETAIL_BASE,
  detailRow,
  extractOf,
  FakeExecutorRegistryService,
  LIST_URL,
  StubBrowserActService,
  StubBrowserPageService,
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
  roundPauseMs: 0,
  ...overrides,
});

/**
 * 挂起一整条抓取链路。
 * @param script 页面读数脚本
 * @param config 抓取配置覆盖项
 * @returns 上下文、`jd.capture` / `jd.store` 服务、执行器登记处替身、`jd.capture` 的 fiber（卸载用例要先停它）、
 *          假手记账与进度事件列表
 */
async function boot(script: PageScript, config: Partial<JdCaptureConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-jd-capture-'));
  sandboxes.push(dir);
  const ctx = new Context();
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
  fibers.push(await ctx.plugin(PlatformRegistryService, NO_CONFIG));
  fibers.push(await ctx.plugin(UsageLedgerService, {}));
  fibers.push(await ctx.plugin(JdStoreService, {}));
  // 真实适配器：`browser.page` 那一步取到的是上面那只替身。
  fibers.push(await ctx.plugin(BossPlatformService, {}));
  const captureFiber = await ctx.plugin(JdCaptureService, captureConfig(config));
  fibers.push(captureFiber);

  const app = asApp(ctx);
  return {
    ctx,
    capture: app['jd.capture'],
    jd: app['jd.store'],
    ledger: app['usage.ledger'],
    executors: executorRegistryOf(ctx),
    captureFiber,
    fake,
    events,
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

describe('抓取是只读动作（spec 2.3-11）', () => {
  it('本轮前后的账本行数相同，一行都没多', async () => {
    const { capture, ledger } = await boot(twoScreenScript(['1001', '1002', '1003']), { targetCount: 3 });
    expect(ledger.count()).toBe(0);
    const run = await capture.run({ keyword: '前端' });
    expect(run).toMatchObject({ ledgerRowsBefore: 0, ledgerRowsAfter: 0 });
    expect(ledger.count()).toBe(0);
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
    expect(capture.status()).toMatchObject({ targetCount: 3, maxRounds: 4, roundPauseMs: 0, lastRun: null });
    const run = await capture.run({ keyword: '前端' });
    expect(capture.status().lastRun).toEqual(run);
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
    // 轮间间隔给到 2s：取消一定落在「列表阶段之后的那次等待」里，而不是落进还没开始的空档。
    const { executors, jd, fake } = await boot(twoScreenScript(['1001', '1002', '1003']), {
      targetCount: 3,
      maxRounds: 1,
      roundPauseMs: 2_000,
    });
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
