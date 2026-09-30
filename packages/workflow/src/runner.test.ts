/**
 * `workflow.runner` 的服务侧行为测试（spec 1.10-02 / 04 / 05 / 06 / 07 / 09 → 2.4-01…2.4-10）。
 *
 * 2.4 之后这里测的不再是「六个占位步骤空转」，而是四件事：
 * ① 槽位来自计划且每一次推进同时落库（2.4-01/02）；② 退避重试的次数与时长（2.4-03）；
 * ③ 失败现场的证据（2.4-04）；④ 进程死过一次以后怎么续、以及外发为什么不敢盲重放（2.4-05/06）。
 *
 * **一律打假执行器 + 真 sqlite**：登记处（`workflow.executors`）存在的意义就是让 runner 不认识
 * 任何平台包，所以整条链在这里用三个假函数跑通本身就是 2.4-08 的证据；而「已完成节点不重放」
 * 是数据库语义，mock 掉存储等于没测（AGENTS.md §7.2 也不允许这里碰真实平台）。
 * 被 kill 的那一次用 `dispose` 模拟进程死亡——真正的 kill + 重启是 2.4-05 的可视验收项，压在这里
 * 只是把「读库→判中断→续跑」这条逻辑先钉住。
 */
import {
  AppError,
  asApp,
  Context,
  Service,
  type Fiber,
  type WorkflowNodeExecutor,
  type WorkflowNodeInvocation,
  type WorkflowProgressEvent,
} from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WorkflowExecutorRegistryService } from './executors.js';
import { WorkflowRunnerService, type WorkflowConfig } from './index.js';
import { BOSS_BASIC_PLAN, buildPlan, WORKFLOW_PLANS, type PlanInput } from './plan.js';
import { WorkflowRunStoreService } from './run-store.js';

/** 计划里三个节点的执行器名，假登记按它逐个覆盖（不与 `plan.ts` 各说一份）。 */
const PLAN_KINDS = buildPlan(BOSS_BASIC_PLAN).nodes.map((node) => node.kind);

/** 节点 id 顺序即槽位顺序，断言里直接用而不重排。 */
const NODE_IDS = ['jd-capture', 'jd-list', 'flaky'];

/**
 * 直接调用点必须给全所有带默认值的键（AGENTS.md §9 的 1.3 实测条）。
 * 退避基数取小值：单位测试要的是次数与顺序，不是等满 500ms。
 */
const BASE_CONFIG: WorkflowConfig = {
  planId: 'boss-basic',
  retryTimes: 2,
  retryBackoffMs: 20,
  retryBackoffCapMs: 40,
  maxNodesPerRun: 200,
  evidenceDomChars: 800,
  evidenceTextChars: 300,
  evidenceDir: 'evidence',
  retentionRuns: 20,
};

/** 某个 kind 在一次用例里的行为：正常返回即成功，抛错即失败。 */
type FakeBehavior = (invocation: WorkflowNodeInvocation) => void | Promise<void>;

/** 证据文件的形状（`index.ts` 里的 `NodeEvidence` 是包内私有类型，测试按读数断言）。 */
type EvidenceFile = {
  runId: string;
  nodeId: string;
  kind: string;
  effect: string;
  target: string;
  attempt: number;
  at: number;
  error: { code: string; message: string; details?: unknown };
  page: { url: string; title: string; bodyText: string } | null;
  screenshot: { ref: string; width: number; height: number } | null;
};

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 假页面服务交出的那帧像素（只带 PNG 文件签名，够断言「写到磁盘的就是通道给回来的那份」）。 */
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 开一个系统临时目录并记账（用例结束后统一删除，AGENTS.md §7.5）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-runner-'));
  sandboxes.push(dir);
  return dir;
}

/**
 * 假的 `browser.page`：只提供证据要用的那两只手（快照与截图）。
 * 挂它不是为了测浏览器，而是为了证明证据里的现场读数**来自可选依赖**（2.4-04 与 2.4-08 的分界）。
 */
class FakePageService extends Service {
  static provide = 'browser.page';
  static Config = z.strictObject({});

  /** 用例把它置 true 就演「取不到画面」那条分支（视图隐藏 / 页面还没绘制）。 */
  screenshotFails = false;

  constructor(ctx: Context, _options: Record<string, never>) {
    super(ctx, 'browser.page');
  }

  /**
   * 固定的一帧现场读数。
   * @param _maxChars 调用方要的 DOM 上限（本假实现不设限，截断由 runner 负责）
   * @returns 超长正文，用于断言证据按 `evidenceTextChars` 截断而不是全文入库
   */
  snapshot(_maxChars?: number): Promise<{ url: string; title: string; bodyText: string }> {
    return Promise.resolve({
      url: 'https://fixture.invalid/search',
      title: '职位列表 - 测试夹具',
      bodyText: '前端工程师'.repeat(200),
    });
  }

  /**
   * 固定的一帧像素。
   * @returns 尺寸与 PNG 字节；`screenshotFails` 为真时以拒绝的 Promise 失败，与真实页面服务同形
   */
  screenshot(): Promise<{ width: number; height: number; png: Uint8Array }> {
    return this.screenshotFails
      ? Promise.reject(new Error('内核视图当前没有可截取的画面'))
      : Promise.resolve({ width: 1_280, height: 720, png: FAKE_PNG });
  }
}

interface BootOptions {
  /** 库与 userData 的根；省略则新开临时目录（续跑用例要传同一个）。 */
  dir?: string;
  config?: Partial<WorkflowConfig>;
  /** 按 kind 覆盖执行行为；未覆盖的 kind 立刻成功。 */
  behavior?: Record<string, FakeBehavior>;
  /** 是否额外挂一个假 `browser.page`。 */
  withPage?: boolean;
}

/**
 * 装一套完整的执行器依赖：config + store + workflow.store + 登记处 + runner。
 *
 * 顺序是硬的：runner `static inject` 那三个服务，cordis 要求挂载前就位。
 * 假执行器在登记处**自己登记之后**覆盖，所以 `demo.flaky` 那个打真 HTTP 的内置实现永远不会被调到
 * （登记是最后写入者说话，见 `executors.ts`）。
 * @param options 见 `BootOptions`
 * @returns 上下文、runner、原始 `workflow.store`、执行器登记处、页面替身（没挂就是 null），以及进度事件与调用序列两份账
 */
async function boot(options: BootOptions = {}) {
  const dir = options.dir ?? tempDir();
  const ctx = new Context();
  // 证据写在 userData 下面，所以把 userData 一起拐进临时目录，测试产物不进仓库（§7.5）。
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc', paths: { userDataDir: dir } }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(WorkflowRunStoreService, {}));
  fibers.push(await ctx.plugin(WorkflowExecutorRegistryService, {}));

  const registry = asApp(ctx)['workflow.executors'];
  const calls: string[] = [];
  for (const kind of PLAN_KINDS) {
    const executor: WorkflowNodeExecutor = async (invocation) => {
      calls.push(`${invocation.spec.id}#${String(invocation.attempt)}`);
      await options.behavior?.[kind]?.(invocation);
    };
    registry.register(kind, executor);
  }
  if (options.withPage) fibers.push(await ctx.plugin(FakePageService, {}));
  // 替身要在挂载之后取：`ctx.get` 返回的是那个真实例，用例才改得动它的开关。
  const page = options.withPage ? (ctx.get('browser.page') as unknown as FakePageService) : null;

  const events: WorkflowProgressEvent[] = [];
  // 先订阅再挂载：`[Service.init]` 会推一次 idle 快照，晚一行就漏掉它。
  ctx.on('workflow/progress', (event) => events.push(event));
  const runnerFiber = await ctx.plugin(WorkflowRunnerService, { ...BASE_CONFIG, ...options.config });
  fibers.push(runnerFiber);

  const app = asApp(ctx);
  return {
    ctx,
    dir,
    runner: app['workflow.runner'],
    runs: app['workflow.store'],
    db: app.store.db,
    registry,
    page,
    events,
    calls,
    // 单独卸 runner 用（等价于 `plugins.stop('workflow')`：进程没死，库与登记处都还在）。
    runnerFiber,
  };
}

/** 倒序回收全部 fiber（模拟进程死亡时也用它）。 */
async function shutDown(): Promise<void> {
  // 倒序：先卸掉的可能已被后卸的依赖，正序 dispose 会撞 PENDING 警告。
  while (fibers.length) await fibers.pop()?.dispose();
}

afterEach(shutDown);

afterAll(() => {
  // 先释放 fiber（关连接）再删目录：Windows 上句柄延迟释放会挡住删除。
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不该把一次通过的验收判成失败。
    }
  }
});

/**
 * 轮询等待条件成立。
 * @param predicate 每 5ms 调一次，返回 true 即结束
 * @param timeoutMs 上限（毫秒），默认 2000；到点抛错而不是静默返回，避免测试假通过
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 等一小段时间，用来确认「没有再发生任何事」。 */
async function settle(ms = 120): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 本线程当前挂着的定时器句柄数（2.4-09 的机读判据）。
 * @returns 活跃的 `Timeout` 资源个数；退避中的 `sleep()` 会让它 +1，被 abort 后应回到原值
 */
function pendingTimers(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
}

/** 相位序列读数（`节点:相位`），比逐条 `toMatchObject` 更能看出「顺序对不对」。 */
function phases(events: WorkflowProgressEvent[]): string[] {
  return events
    .filter((event) => event.phase !== null && event.stepId !== null)
    .map((event) => `${String(event.stepId)}:${String(event.phase)}`);
}

/**
 * 取某个 kind 的执行行为：前 `failTimes` 次抛错，之后成功。
 * @param failTimes 前几次失败
 * @param message 抛出的错误文案
 * @returns 可塞进 `BootOptions.behavior` 的行为
 */
function failThenSucceed(failTimes: number, message = '对端不可达'): FakeBehavior {
  return ({ attempt }) => {
    if (attempt <= failTimes) throw new AppError('WORKFLOW_STEP_FAILED', message, 'workflow.executors');
  };
}

/**
 * 协作式让出的执行器：收到 abort 才收手（2.4-07 的「暂停时正在跑的那一步自己停下」）。
 * @returns 可塞进 `BootOptions.behavior` 的行为
 */
function hangUntilAbort(): FakeBehavior {
  return ({ signal }) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
}

/**
 * 只让第一次调用挂住，之后立刻成功——用来演「暂停之后续跑把同一步重跑一遍」。
 * @returns 可塞进 `BootOptions.behavior` 的行为
 */
function hangOnceThenSucceed(): FakeBehavior {
  let hung = false;
  return ({ signal }) => {
    if (hung) return;
    hung = true;
    return new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  };
}

describe('计划驱动的顺序推进（2.4-01 / 02，回补 1.10-02 / 07）', () => {
  it('挂载即有一个 idle run：槽位数等于计划的节点数，而库里还没有任何行', async () => {
    const { runner, events } = await boot();
    const idle = runner.current();
    expect(idle.status).toBe('idle');
    expect(idle.stepIndex).toBe(0);
    expect(idle.steps.map((step) => step.id)).toEqual(NODE_IDS);
    expect(idle.steps.every((step) => step.status === 'pending')).toBe(true);
    // 这个初始 run 只是给界面的空格子：它不在库里，所以「真相读数」必须是 null。
    expect(runner.state()).toBeNull();
    expect(runner.nodes().map((node) => node.id)).toEqual(NODE_IDS);
    expect(events[0]).toMatchObject({ run: { status: 'idle' }, stepId: null, phase: null, message: null });
  });

  it('三个节点按顺序跑完，每一次迁移都带 phase，并同时写进两张表', async () => {
    const { runner, events } = await boot();
    const initial = runner.start();
    expect(initial.status).toBe('running');

    await waitFor(() => runner.current().status === 'done');
    // 开跑那一句带计划 id：2.4 之后界面要能看出「跑的是哪条计划」，而不只是「在动」。
    expect(events.map((event) => event.message)).toEqual([
      null,
      '计划 boss-basic 开跑',
      '开始 jd-capture',
      'jd-capture 完成',
      '开始 jd-list',
      'jd-list 完成',
      '开始 flaky',
      'flaky 完成',
    ]);
    expect(phases(events)).toEqual([
      'jd-capture:started',
      'jd-capture:finished',
      'jd-list:started',
      'jd-list:finished',
      'flaky:started',
      'flaky:finished',
    ]);
    // 事件里带的是整份 run 快照，界面直接镜像即可（2.4-02 要的就是这条频道，不是新频道）。
    expect(events.at(-1)?.run.runId).toBe(runner.current().runId);

    const stored = runner.state();
    expect(stored).not.toBeNull();
    expect(stored).toMatchObject({ status: 'done', nodeIndex: 3, totalNodes: 3, lastError: null });
    expect(stored?.nodes.map((node) => node.status)).toEqual(['done', 'done', 'done']);
    expect(stored?.nodes.every((node) => node.attempts === 1)).toBe(true);
    expect(stored?.nodes.every((node) => (node.durationMs ?? -1) >= 0)).toBe(true);
    // 只读节点不占副作用位，会动外面世界的那个收成 done（spec 2.4-06 的判据）。
    expect(stored?.nodes[0]?.sideEffect).toBeNull();
    expect(stored?.nodes[2]?.sideEffect).toBe('done');
  });

  it('执行器没登记时 start 直接拒绝，并一次报全缺的 kind（2.4-08 的装配期判据）', async () => {
    const { runner, registry } = await boot();
    for (const kind of ['jd.capture', 'jd.list']) registry.unregister(kind);
    expect(() => runner.start()).toThrow(/这条计划现在跑不了/);
    try {
      runner.start();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('INVALID_ARGUMENT');
      expect((error as AppError).message).toContain('jd.capture');
      expect((error as AppError).message).toContain('jd.list');
    }
    // 拒绝必须是不动的：不能留下一个跑不动的 run 行。
    expect(runner.current().status).toBe('idle');
    expect(runner.state()).toBeNull();
  });
});

describe('平台解耦（2.4-08）', () => {
  /**
   * 一条 5 节点的计划，只为本用例存在。
   *
   * spec 2.4-08 写的是「mock 跑 5 节点」，而产品计划表里只有那条 3 节点主线（plan §11.8：不做分支与并行），
   * 所以这里往计划表临时塞一条、`finally` 里立刻摘掉——要证的是「节点数与 kind 都不写死在 runner 里」，
   * 不是给产品新增一条用不上的计划。
   */
  const FIVE_NODE_PLAN: PlanInput = {
    id: 'five-mock',
    nodes: [
      { id: 'n-1', kind: 'mock.one', effect: 'read' },
      { id: 'n-2', kind: 'mock.two', effect: 'read' },
      { id: 'n-3', kind: 'mock.three', target: 'mock://three', effect: 'local-write' },
      { id: 'n-4', kind: 'mock.four', effect: 'read' },
      { id: 'n-5', kind: 'mock.five', effect: 'read' },
    ],
  };

  it('换一条 5 节点计划 + 五个 mock 执行器就能跑完整条链：不挂页面通道、不发一次网络请求', async () => {
    const plans = WORKFLOW_PLANS as Record<string, PlanInput>;
    plans['five-mock'] = FIVE_NODE_PLAN;
    try {
      const booted = await boot({ config: { planId: 'five-mock' } });
      // 执行器按 kind 现登记：runner 从头到尾没问过「这是哪个平台」。
      for (const node of FIVE_NODE_PLAN.nodes) {
        booted.registry.register(node.kind, ({ spec, attempt }) => {
          booted.calls.push(`${spec.id}#${String(attempt)}`);
          return Promise.resolve();
        });
      }
      expect(booted.page).toBeNull();

      booted.runner.start();
      await waitFor(() => booted.runner.current().status === 'done');
      expect(booted.calls).toEqual(['n-1#1', 'n-2#1', 'n-3#1', 'n-4#1', 'n-5#1']);
      expect(phases(booted.events)).toEqual([
        'n-1:started',
        'n-1:finished',
        'n-2:started',
        'n-2:finished',
        'n-3:started',
        'n-3:finished',
        'n-4:started',
        'n-4:finished',
        'n-5:started',
        'n-5:finished',
      ]);

      const stored = booted.runner.state();
      expect(stored).toMatchObject({ status: 'done', nodeIndex: 5, totalNodes: 5, lastError: null });
      expect(stored?.nodes.map((node) => node.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
      // 槽位数量来自计划，界面因此不用为「这条计划有几个节点」写任何判断（回补 1.10-02/03）。
      expect(booted.runner.current().steps.map((step) => step.id)).toEqual(['n-1', 'n-2', 'n-3', 'n-4', 'n-5']);
    } finally {
      delete plans['five-mock'];
    }
    expect(Object.keys(WORKFLOW_PLANS)).toEqual(['boss-basic', 'boss-deliver']);
  });
});

describe('退避重试（2.4-03）', () => {
  it('第 3 次才成功：两次 retrying 播报、退避 20ms 再 40ms，库里 attempts 记总次数', async () => {
    const { runner, events, calls } = await boot({ behavior: { 'demo.flaky': failThenSucceed(2) } });
    runner.start();
    await waitFor(() => runner.current().status === 'done');

    expect(calls).toEqual(['jd-capture#1', 'jd-list#1', 'flaky#1', 'flaky#2', 'flaky#3']);
    expect(phases(events)).toContain('flaky:retrying');
    expect(events.map((event) => event.message)).toEqual(
      expect.arrayContaining(['flaky 第 1 次失败，20ms 后重试', 'flaky 第 2 次失败，40ms 后重试']),
    );
    expect(runner.state()?.nodes[2]).toMatchObject({ status: 'done', attempts: 3 });
  });

  it('全局 retryTimes 为 0 时不重试，第一次失败就判失败', async () => {
    const { runner, calls } = await boot({ config: { retryTimes: 0 }, behavior: { 'jd.capture': failThenSucceed(9) } });
    runner.start();
    await waitFor(() => runner.current().status === 'failed');
    expect(calls).toEqual(['jd-capture#1']);
    expect(runner.current().stepIndex).toBe(0);
    expect(runner.state()).toMatchObject({ status: 'failed', nodeIndex: 0, lastError: '对端不可达' });
  });

  it('节点声明的 retryTimes 覆盖全局：全局 0 也照样退避到第 3 次', async () => {
    const { runner, calls } = await boot({ config: { retryTimes: 0 }, behavior: { 'demo.flaky': failThenSucceed(2) } });
    runner.start();
    await waitFor(() => runner.current().status === 'done');
    // `flaky` 在计划里写了 `retryTimes: 2`，所以它有自己的三次机会，前面的读节点仍然一次过。
    expect(calls).toEqual(['jd-capture#1', 'jd-list#1', 'flaky#1', 'flaky#2', 'flaky#3']);
    expect(runner.state()?.nodes[2]?.attempts).toBe(3);
  });

  it('重试上限用尽才判失败，且退避睡在取消信号上——暂停不会等满退避（2.4-09）', async () => {
    const { runner, calls } = await boot({
      config: { retryBackoffMs: 2000, retryBackoffCapMs: 2000 },
      behavior: { 'demo.flaky': failThenSucceed(9) },
    });
    runner.start();
    await waitFor(() => calls.includes('flaky#1'));

    const countAtPause = runner.pause();
    expect(countAtPause.status).toBe('paused');
    // 退避睡 2000ms，而暂停必须在几十毫秒内生效：让出之后不许再动执行器。
    await settle(80);
    expect(calls).toEqual(['jd-capture#1', 'jd-list#1', 'flaky#1']);
    expect(runner.current().status).toBe('paused');
  });
});

describe('失败证据（2.4-04）', () => {
  it('判失败时把错误 payload 写成文件，库里只存相对路径；没挂页面通道时现场两位都是 null', async () => {
    const { runner, dir } = await boot({
      config: { retryTimes: 0 },
      behavior: { 'jd.capture': failThenSucceed(9, '选择器没命中') },
    });
    runner.start();
    await waitFor(() => runner.current().status === 'failed');

    const stored = runner.state();
    const runId = String(stored?.runId);
    expect(stored?.nodes[0]?.evidenceRef).toBe(`evidence/${runId}-jd-capture.json`);
    const file = JSON.parse(readFileSync(join(dir, 'evidence', `${runId}-jd-capture.json`), 'utf8')) as EvidenceFile;
    expect(file).toMatchObject({
      runId,
      nodeId: 'jd-capture',
      kind: 'jd.capture',
      effect: 'read',
      attempt: 1,
      error: { code: 'WORKFLOW_STEP_FAILED', message: '选择器没命中' },
    });
    // 这一条同时是 2.4-08 的反证：整条链没有 `browser` 也能跑完并留下证据。
    expect(file.page).toBeNull();
    expect(file.screenshot).toBeNull();
    expect(existsSync(join(dir, 'evidence', `${runId}-jd-capture.png`))).toBe(false);
    expect(typeof file.at).toBe('number');
  });

  it('挂了页面通道时证据带上现场读数与同名截图，正文按 evidenceTextChars 截断（不谎称是全文）', async () => {
    const { runner, dir } = await boot({
      config: { retryTimes: 0, evidenceTextChars: 50 },
      behavior: { 'jd.capture': failThenSucceed(9, '选择器没命中') },
      withPage: true,
    });
    runner.start();
    await waitFor(() => runner.current().status === 'failed');

    const runId = String(runner.state()?.runId);
    const file = JSON.parse(readFileSync(join(dir, 'evidence', `${runId}-jd-capture.json`), 'utf8')) as EvidenceFile;
    expect(file.page?.url).toBe('https://fixture.invalid/search');
    expect(file.page?.bodyText).toHaveLength(50 + '…（已截断）'.length);
    expect(file.page?.bodyText.endsWith('…（已截断）')).toBe(true);
    // 截图与证据 JSON 同名同目录：库里存的就是这个相对路径，人翻文件时一眼对得上。
    expect(file.screenshot).toEqual({ ref: `evidence/${runId}-jd-capture.png`, width: 1_280, height: 720 });
    expect(readFileSync(join(dir, 'evidence', `${runId}-jd-capture.png`))).toEqual(FAKE_PNG);
  });

  it('页面服务取不到画面时截图位记 null，错误 payload 与读数仍然落盘', async () => {
    const { runner, dir, page } = await boot({
      config: { retryTimes: 0 },
      behavior: { 'jd.capture': failThenSucceed(9, '站点改版') },
      withPage: true,
    });
    page!.screenshotFails = true;
    runner.start();
    await waitFor(() => runner.current().status === 'failed');

    const runId = String(runner.state()?.runId);
    const file = JSON.parse(readFileSync(join(dir, 'evidence', `${runId}-jd-capture.json`), 'utf8')) as EvidenceFile;
    expect(file.screenshot).toBeNull();
    expect(file.page?.title).toBe('职位列表 - 测试夹具');
    expect(file.error.message).toBe('站点改版');
    expect(existsSync(join(dir, 'evidence', `${runId}-jd-capture.png`))).toBe(false);
  });
});

describe('断点续跑与幂等闸门（2.4-05 / 06）', () => {
  /**
   * 跑到第 3 个节点时把进程「杀掉」：前两个节点已完成，第三个外发起过却没观察到完成。
   * @returns 临时目录、第一次的调用序列，以及被留下的 run 读数
   */
  async function killAtThirdNode() {
    const dir = tempDir();
    const first = await boot({ dir, behavior: { 'demo.flaky': hangUntilAbort() } });
    first.runner.start();
    await waitFor(() => first.calls.includes('flaky#1'));
    const runId = first.runner.current().runId;
    // 「进程死亡」= 倒序卸载全部 fiber，库里最后一行 `running` 就此成为孤儿。
    await shutDown();
    return { dir, first, runId };
  }

  it('重启后先判中断，已完成节点一次都不重放，未观察完成的外发停在接管点', async () => {
    const { dir, first, runId } = await killAtThirdNode();
    expect(first.calls).toEqual(['jd-capture#1', 'jd-list#1', 'flaky#1']);

    const second = await boot({ dir });
    // 开机扫描：那个「运行中」属于一个已经不存在的进程，必须在第一次读数之前就改成中断。
    const stored = second.runs.state(runId);
    expect(stored).toMatchObject({ status: 'interrupted', nodeIndex: 2, lastError: 'RUN_INTERRUPTED' });
    expect(stored?.nodes.map((node) => node.status)).toEqual(['done', 'done', 'running']);
    expect(stored?.nodes[2]).toMatchObject({ attempts: 1, sideEffect: 'started' });

    second.runner.resumeRun();
    await waitFor(() => second.runner.current().status === 'paused');
    // 前两个位置在库里已有结局：闸门判 `already-done`，连执行器都不许调（2.4-05 的「不重放」）。
    expect(second.calls).toEqual([]);
    // 第三个位置是「外发开始了却没看到完成」——重放一遍就是做两次，只能转人工（2.4-06）。
    expect(second.runner.current().requiresHuman).toMatchObject({
      subject: 'demo.flaky',
      reason: 'unobserved-side-effect',
      stepId: 'flaky',
    });
    expect(second.runs.state(runId)?.nodes[2]?.attempts).toBe(1);
  });

  it('resumable() 给的是「续跑将要挑中的那条」：刚重启时 state() 为 null，它却能报出中断在第几个节点', async () => {
    const { dir, runId } = await killAtThirdNode();
    const second = await boot({ dir });
    // 初始镜像在库里没有行：界面只看 `state()` 的话，重启后永远是「未开始」，续跑按钮也就永远点不亮。
    expect(second.runner.state()).toBeNull();
    expect(second.runner.resumable()).toMatchObject({ runId, status: 'interrupted', nodeIndex: 2 });

    // 两只手共用同一个 `resumeCandidate` 判据：显示的第 i 个节点与点下去真正续上的那次 run 必然同一条。
    expect(second.runner.resumeRun().runId).toBe(runId);
    expect(second.runner.state()?.runId).toBe(runId);
  });

  it('库里没有可续的 run 时 resumable() 返回 null 而不是抛错（界面据此把续跑按钮置灰）', async () => {
    const { runner } = await boot();
    expect(runner.resumable()).toBeNull();
  });

  it('接管点上的一次重试只放行一次重放：闸门仍写这笔账，跑完这次 run', async () => {
    const { dir, runId } = await killAtThirdNode();
    const second = await boot({ dir });
    second.runner.resumeRun();
    await waitFor(() => second.runner.current().status === 'paused');

    second.runner.retryStep('flaky');
    await waitFor(() => second.runner.current().status === 'done');
    // 只有第三个节点被执行，且尝试次数接的是上一个进程用掉的那一次（跨进程的账是连着的）。
    expect(second.calls).toEqual(['flaky#2']);
    const stored = second.runs.state(runId);
    expect(stored).toMatchObject({ status: 'done', nodeIndex: 3 });
    expect(stored?.nodes[2]).toMatchObject({ status: 'done', attempts: 2, sideEffect: 'done' });
  });

  it('计划指纹对不上就拒绝续跑，内存态原样停住（串档判据）', async () => {
    const { dir, runId } = await killAtThirdNode();
    const second = await boot({ dir });
    // 手工把 run 行的指纹列改掉：等价于「计划文本被换过，而库里还写着旧指纹」。
    second.db.prepare("UPDATE workflow_runs SET plan_fingerprint = 'deadbeef' WHERE run_id = ?").run(runId);

    // 不带 id 时按当前计划找候选：指纹不符，因此根本找不到。
    expect(() => second.runner.resumeRun()).toThrow(/库里没有按当前计划/);
    // 指定 id 时读数自身要重算指纹并拒绝，绝不按一个没人核对过的下标走下去。
    expect(() => second.runner.resumeRun(runId)).toThrow(/指纹/);
    expect(second.runner.current().status).toBe('idle');
    expect(second.calls).toEqual([]);
  });

  it('已经跑完的 run 再点续跑：原样返回并播一句，不重跑任何节点', async () => {
    const { runner, calls, events } = await boot();
    runner.start();
    await waitFor(() => runner.current().status === 'done');
    const before = calls.length;

    const again = runner.resumeRun(runner.current().runId);
    expect(again.status).toBe('done');
    expect(calls).toHaveLength(before);
    expect(events.at(-1)?.message).toBe('这次 run 已经跑完，无需续跑');
  });
});

describe('暂停与续跑（1.10-05 / 2.4-07）', () => {
  it('暂停等到当前步让出，stepIndex 不动；续跑把这一步重跑并跑完，库里不出现假的 done', async () => {
    const { runner, runs, calls } = await boot({ behavior: { 'jd.capture': hangOnceThenSucceed() } });
    runner.start();
    await waitFor(() => runner.current().steps[0]?.status === 'running');

    const paused = runner.pause();
    expect(paused.status).toBe('paused');
    expect(paused.stepIndex).toBe(0);
    expect(paused.steps[0]).toMatchObject({ status: 'pending', startedAt: null });
    // 让出不是完成：这一步在库里必须还是 running，否则续跑会跳过它（2.4-07 的核心）。
    const runId = paused.runId;
    expect(runs.state(runId)?.nodes[0]?.status).toBe('running');

    const countAtPause = calls.length;
    await settle(120);
    expect(calls).toHaveLength(countAtPause);

    runner.resume();
    await waitFor(() => runner.current().status === 'done');
    expect(calls).toEqual(['jd-capture#1', 'jd-capture#2', 'jd-list#1', 'flaky#1']);
    const stored = runner.state();
    expect(stored?.nodes[0]).toMatchObject({ status: 'done', attempts: 2 });
    expect(stored?.nodes.map((node) => node.status)).toEqual(['done', 'done', 'done']);
  });

  it('同进程内的重试不占用幂等闸门：读节点暂停后续跑照常重跑', async () => {
    const { runner, calls } = await boot({ behavior: { 'jd.list': hangOnceThenSucceed() } });
    runner.start();
    await waitFor(() => calls.includes('jd-list#1'));
    runner.pause();
    // 暂停前 `jd-capture` 已经在本进程声明过：`claimedPositions` 让续跑直接放行，
    // 而不是把它当成「跨进程的外发」转接管（那会把 1.10-05 这条路打断）。
    expect(runner.current().requiresHuman).toBeNull();
    runner.resume();
    await waitFor(() => runner.current().status === 'done');
    expect(calls).toEqual(['jd-capture#1', 'jd-list#1', 'jd-list#2', 'flaky#1']);
  });

  it('没在运行时暂停 / 暂停中另起 run / 重复续跑，都是结构化失败（1.10-09）', async () => {
    const { runner } = await boot();
    let idlePause: unknown;
    try {
      runner.pause();
    } catch (error) {
      idlePause = error;
    }
    expect(idlePause).toBeInstanceOf(AppError);
    expect((idlePause as AppError | undefined)?.code).toBe('WORKFLOW_INVALID_STATE');

    runner.start();
    runner.pause();
    expect(() => runner.start()).toThrow(/已有 run 处于 paused 态/);
    expect(runner.resume().status).toBe('running');
    expect(() => runner.resume()).toThrow(/只有暂停中的 run 可以续跑/);
  });

  it('重试不认识的步 id、或重试一个既没失败也没挂接管的步，都结构化失败', async () => {
    const { runner } = await boot();
    expect(() => runner.retryStep('nope')).toThrow(/当前计划里没有步骤 nope/);
    runner.start();
    await waitFor(() => runner.current().status === 'done');
    // 已经 done 的位置上没有可重试的东西：必须被拒，而不是把它重跑一遍（幂等的界面侧）。
    expect(() => runner.retryStep('jd-capture')).toThrow(AppError);
    expect(runner.current().status).toBe('done');
  });
});

describe('会话失效停在可恢复点（1.8-07 / 2.1-08）', () => {
  /** 向全局事件总线推一次登录态失效，等同于 `sessions.probe` 判出失效。 */
  function expire(ctx: Context, platform = 'boss', reason: 'missing' | 'expired' = 'expired'): void {
    ctx.emit('session/expired', { platform, reason, at: Date.now() });
  }

  it('运行中收到失效：停在当前步、接管点带平台名与原因，续跑把这一步重跑并跑完', async () => {
    const { ctx, runner, calls, events } = await boot({ behavior: { 'jd.list': hangOnceThenSucceed() } });
    runner.start();
    await waitFor(() => calls.includes('jd-list#1'));

    expire(ctx);
    const paused = runner.current();
    expect(paused.status).toBe('paused');
    expect(paused.stepIndex).toBe(1);
    expect(paused.steps[0]?.status).toBe('done');
    expect(paused.steps[1]).toMatchObject({ status: 'pending', durationMs: null });
    // 接管点是**数据**：会话类原因时 `subject` 装平台名，界面按语言组织句子（AGENTS.md §5.5）。
    expect(paused.requiresHuman).toMatchObject({ subject: 'boss', reason: 'expired', stepId: 'jd-list' });
    expect(events.at(-1)).toMatchObject({ message: null, run: { status: 'paused' } });

    const countAtPause = calls.length;
    await settle(120);
    expect(calls).toHaveLength(countAtPause);

    runner.resume();
    await waitFor(() => runner.current().status === 'done');
    expect(calls).toEqual(['jd-capture#1', 'jd-list#1', 'jd-list#2', 'flaky#1']);
    expect(runner.current().requiresHuman).toBeNull();
  });

  it('没在运行时收到失效：什么都不做，不报错也不把 idle 拽成 paused', async () => {
    const { ctx, runner, events } = await boot();
    expire(ctx);
    expect(runner.current().status).toBe('idle');
    expect(events.length).toBe(1);

    runner.start();
    runner.pause();
    const countAtPause = events.length;
    expire(ctx, 'liepin', 'missing');
    // 已经是 paused 的 run 不能被二次暂停（迁移表会拒），所以这里必须被忽略而不是抛错。
    expect(runner.current().status).toBe('paused');
    expect(events.length).toBe(countAtPause);
  });
});

describe('风控信号停在可恢复点（spec 2.7-01）', () => {
  /**
   * 向全局事件总线推一次风控信号，等同于 `browser.risk` 判出「这一页被拦下来了」。
   * @param ctx 用例的插件上下文
   * @param platform 被拦下的平台
   * @param kind 判据类别（状态码 / 页面文案）
   */
  function signal(ctx: Context, platform = 'boss', kind: 'http-status' | 'page-text' = 'http-status'): void {
    ctx.emit('browser/risk-signal', {
      platform,
      kind,
      detail: kind === 'http-status' ? 'HTTP 403' : '安全验证',
      url: 'http://127.0.0.1:10233/boss',
      at: Date.now(),
    });
  }

  it('运行中撞上风控：停在当前步、接管点说 risk-control，续跑把这一步重跑并跑完', async () => {
    const { ctx, runner, calls, events } = await boot({ behavior: { 'jd.list': hangOnceThenSucceed() } });
    runner.start();
    await waitFor(() => calls.includes('jd-list#1'));

    signal(ctx);
    const paused = runner.current();
    expect(paused.status).toBe('paused');
    expect(paused.stepIndex).toBe(1);
    // 与登录态失效共用同一个 `stop()`：接管点的形状一模一样，只有 `reason` 不同，界面因此能说清是不同的两件事。
    expect(paused.requiresHuman).toMatchObject({ subject: 'boss', reason: 'risk-control', stepId: 'jd-list' });
    expect(events.at(-1)).toMatchObject({ message: null, run: { status: 'paused' } });

    const countAtPause = calls.length;
    await settle(120);
    expect(calls).toHaveLength(countAtPause);

    runner.resume();
    await waitFor(() => runner.current().status === 'done');
    expect(calls).toEqual(['jd-capture#1', 'jd-list#1', 'jd-list#2', 'flaky#1']);
    expect(runner.current().requiresHuman).toBeNull();
  });

  it('没在运行时收到信号：什么都不做，不报错也不把 idle 拽成 paused', async () => {
    const { ctx, runner, events } = await boot();
    signal(ctx, 'fixture', 'page-text');
    expect(runner.current().status).toBe('idle');
    expect(events.length).toBe(1);
  });
});

describe('卸载让出（1.10-04 / 2.4-07 / 2.4-09）', () => {
  it('卸载在跑的执行器会收到 abort，之后不再有任何进度事件', async () => {
    const { runner, runnerFiber, events } = await boot({ behavior: { 'jd.capture': hangUntilAbort() } });
    runner.start();
    await waitFor(() => events.some((event) => event.phase === 'started'));

    const countAtDispose = events.length;
    await runnerFiber.dispose();
    // 已经卸掉的那条从记账里摘掉，免得 afterEach 再卸一次。
    fibers.splice(fibers.indexOf(runnerFiber), 1);
    await settle(150);
    // 卸载只让出，不写结局：这条 run 留在库里的 `running` 行由下次开机的扫描判成中断（2.4-05 那一组）。
    expect(events.length).toBe(countAtDispose);
    expect(events.at(-1)?.phase).toBe('started');
  });

  it('卸载把退避定时器一起带走：句柄数回到基线，且不等到退避睡满才返回（2.4-09 的「无悬挂句柄」）', async () => {
    const { runner, runnerFiber, events } = await boot({
      config: { retryTimes: 2, retryBackoffMs: 1_200, retryBackoffCapMs: 1_200 },
      behavior: { 'jd.capture': failThenSucceed(9, '对端不可达') },
    });
    const baseline = pendingTimers();
    runner.start();
    await waitFor(() => events.some((event) => event.phase === 'retrying'));
    // 先确认「此刻真有一个在途定时器」，否则下面那句「回到基线」就是句空话。
    expect(pendingTimers()).toBeGreaterThan(baseline);

    const startedAt = Date.now();
    await runnerFiber.dispose();
    fibers.splice(fibers.indexOf(runnerFiber), 1);
    await settle(30);
    expect(pendingTimers()).toBe(baseline);
    // 等满 1.2s 才返回是悬挂句柄的另一种表现：卸载必须立刻让出，`plugins.stop` 不能变成「等这条 run 睡完」。
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(events.at(-1)?.phase).toBe('retrying');
  });
});

describe('保留上限（2.4-10 的清理侧）', () => {
  it('超出 retentionRuns 的旧 run 连它的证据文件（含截图）一起清掉', async () => {
    let shouldFail = true;
    const { runner, dir, db } = await boot({
      config: { retryTimes: 0, retentionRuns: 1 },
      behavior: {
        'jd.capture': () => {
          if (shouldFail) throw new AppError('WORKFLOW_STEP_FAILED', '站点改版', 'workflow.executors');
        },
      },
      // 挂上页面通道才会产生 .png：这条要证的正是「截图也跟着 run 一起清」，而不是只清 JSON。
      withPage: true,
    });

    runner.start();
    await waitFor(() => runner.current().status === 'failed');
    const firstRunId = runner.current().runId;
    const evidenceFile = join(dir, 'evidence', `${firstRunId}-jd-capture.json`);
    expect(existsSync(evidenceFile)).toBe(true);
    expect(existsSync(join(dir, 'evidence', `${firstRunId}-jd-capture.png`))).toBe(true);

    // 第一次 run 修好再跑完它，然后连起两次新 run：第三次起步时保留上限才会真的丢东西。
    shouldFail = false;
    runner.retryStep('jd-capture');
    await waitFor(() => runner.current().status === 'done');

    await settle(5);
    runner.start();
    await waitFor(() => runner.current().status === 'done');

    await settle(5);
    runner.start();
    await waitFor(() => runner.current().status === 'done');

    expect(existsSync(evidenceFile)).toBe(false);
    expect(readdirSync(join(dir, 'evidence'))).toEqual([]);
    // 保留 1 次：第三次起步时最旧的那次（run 1）连同节点行一起被丢，库里只剩后两次。
    const remaining = db.prepare('SELECT run_id FROM workflow_runs ORDER BY started_at DESC').all() as {
      run_id: string;
    }[];
    expect(remaining).toHaveLength(2);
    expect(remaining.some((row) => row.run_id === firstRunId)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM workflow_nodes WHERE run_id = ?').get(firstRunId)).toMatchObject({
      n: 0,
    });
  });
});
