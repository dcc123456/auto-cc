/**
 * `browser.takeover` 的用例（spec 5.5-02 / 07 / 09 的服务半边）。
 *
 * 这里验的是**一个状态源能不能被信任**，不是界面怎么画：
 * ① 接管态只有这一处，begin / end 各留一行审计（5.5-09 的配对读数）；
 * ② 连发幂等——风控信号会连着来，覆盖会把接管起点与第一个原因一起抹掉；
 * ③ 5.5-07 的两条自动通道订的是**已有的** `browser/risk-signal` 与 `session/expired`，
 *    本包不新做检测，只把「所以现在该由人动手」收敛成状态；
 * ④ 库里的脏值不当成任何一种解释读出来（5.5-09 是回看用的，读错比读不到更糟）。
 * ⑤ 5.5-07 的三类读数（403 / 429 / 200 的验证页）另有一组从**真观测层**发出来：手造信号那两只证的是
 *    「订阅在不在」，这一组证的才是「接没接错线」（kind 与 reason 对不上时照样过前者）。
 * 一律打真的 `node:sqlite`（系统临时目录，用完删，AGENTS.md §7.5）：幂等的建表与倒序回看 mock 掉就等于没测。
 */
import { asApp, Context, NO_CONFIG, type Fiber, type RiskSignalEvent, type TakeoverStateView } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import type { WebContents } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserRiskService } from './risk-service.js';
import { BrowserTakeoverService, BROWSER_TAKEOVER_MIGRATION_VERSION } from './takeover-service.js';
import {
  FakePageService,
  FakePlatformRegistryService,
  FakeSessionsService,
  FakeShellService,
  fakeFrame,
  fakeView,
  fireViewEvent,
} from './test-doubles.js';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 开一个系统临时目录并记账（用例结束后统一删除，里面只有本用例那份库）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-takeover-'));
  sandboxes.push(dir);
  return dir;
}

/**
 * 挂起一套 config + store + browser.takeover，并把 `browser/takeover-changed` 接住。
 * @param dir 库文件目录（省略则新开一个临时目录，用例之间因此互不污染）
 * @returns 上下文、服务、它的 fiber（重启用例要先停掉它）与事件记账
 */
async function boot(dir = tempDir()) {
  const ctx = new Context();
  const events: TakeoverStateView[] = [];
  ctx.on('browser/takeover-changed', (event) => {
    events.push(event);
  });
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  const takeoverFiber = await ctx.plugin(BrowserTakeoverService, {});
  fibers.push(takeoverFiber);
  const takeover = ctx.get('browser.takeover') as BrowserTakeoverService;
  return { ctx, takeover, takeoverFiber, events };
}

/** 一条够真的风控信号（登录墙那种不必造：它走的是 `session/expired`，形状在下一只用例里）。 */
function riskSignal(): RiskSignalEvent {
  return {
    platform: 'boss',
    kind: 'page-text',
    detail: '安全验证',
    url: 'http://127.0.0.1:10233/boss',
    at: Date.now(),
  };
}

/**
 * 起一套「四只替身 + 真风控观测 + 真接管态」的联装（5.5-07 那条接线口的本体）。
 *
 * 为什么这一只单独存在：上面那三只自动接管用例喂的是**手造的信号**，它证的是「订阅在不在」；
 * 而 spec 5.5-07 写的判据是「403 / 429 / 验证码 三类响应都转人工接管」，那三类得由真观测层发出来，
 * 否则「风控服务发的是 kind=http-status，接管只认 page-text」这种接错线的形态照样过。
 * @param view 内核视图替身（文案判据只在「这块视图真属于这个平台」时才读，所以那一格必须给一块）
 * @returns 上下文、真接管服务、真风控服务问的那三只替身，与 `browser/takeover-changed` 的记账
 */
async function bootLinked(view: WebContents | null = null) {
  const ctx = new Context();
  const events: TakeoverStateView[] = [];
  ctx.on('browser/takeover-changed', (event) => {
    events.push(event);
  });
  fibers.push(
    await ctx.plugin(ConfigService, { appName: 'auto-cc' }),
    await ctx.plugin(StoreService, { dir: tempDir(), file: 'store.db', journal: 'delete' }),
    await ctx.plugin(FakeShellService, NO_CONFIG),
    await ctx.plugin(FakeSessionsService, NO_CONFIG),
    await ctx.plugin(FakePageService, NO_CONFIG),
    await ctx.plugin(FakePlatformRegistryService, NO_CONFIG),
  );
  // 视图要在风控服务挂载之前递进去：它挂 listener 时就问一次「现在有没有会话」，晚给的视图这一趟看不见。
  const shell = ctx.get('shell') as unknown as FakeShellService;
  shell.contents = view;
  fibers.push(
    await ctx.plugin(BrowserTakeoverService, {}),
    // 状态码口径给的就是产品口径那两条：这一片判的是「命中之后转不转接管」，不是口径本身（那在 2.7-01）。
    await ctx.plugin(BrowserRiskService, { riskStatusCodes: [403, 429], pageSettleTimeoutMs: 500 }),
  );
  return {
    ctx,
    events,
    takeover: ctx.get('browser.takeover') as BrowserTakeoverService,
    sessions: ctx.get('sessions') as unknown as FakeSessionsService,
    registry: ctx.get('platform.registry') as unknown as FakePlatformRegistryService,
    page: ctx.get('browser.page') as unknown as FakePageService,
  };
}

/** 等风控那趟异步判定跑到尾：观测 listener 是同步交出、异步处置（与 2.7-c 的用例同一个口径）。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

describe('接管态单源（spec 5.5-02）', () => {
  it('挂载即「未接管」：三个字段同生同灭，界面不可能读到没接管却带一个原因', async () => {
    const { takeover } = await boot();
    expect(takeover.held()).toEqual({
      isHeld: false,
      reason: null,
      startedAt: null,
      beginCount: 0,
      endCount: 0,
    });
    expect(takeover.audit(10)).toEqual([]);
  });

  it('held() 每次给新对象：调用方改坏自己那份也改不坏状态源', async () => {
    const { takeover } = await boot();
    const first = takeover.held();
    first.isHeld = true;
    expect(takeover.held().isHeld).toBe(false);
  });

  it('begin 写一行审计、发一条事件，并把归属信息原样记下', async () => {
    const { takeover, events } = await boot();
    const view = takeover.begin({ reason: 'manual', actor: 'user', runId: 'run-1', nodeId: 'node-2' });

    expect(view).toMatchObject({ isHeld: true, reason: 'manual', beginCount: 1, endCount: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(view);
    expect(takeover.audit(10)).toEqual([
      {
        id: expect.any(Number),
        kind: 'begin',
        reason: 'manual',
        actor: 'user',
        runId: 'run-1',
        nodeId: 'node-2',
        createdAt: expect.any(Number),
      },
    ]);
  });

  it('接管中连发 begin 幂等：不写第二行、不推后起点、不再发事件', async () => {
    const { takeover, events } = await boot();
    const first = takeover.begin({ reason: 'risk', actor: 'system' });
    // 风控连发是真实形状：一次导航 403 之后页面自己跳转又撞一次 429。
    const second = takeover.begin({ reason: 'manual', actor: 'user' });

    expect(second).toEqual(first);
    expect(events).toHaveLength(1);
    expect(takeover.audit(10)).toHaveLength(1);
  });

  it('end 成对收掉这一轮：读数回到未接管，end 行带上它结束的那轮原因', async () => {
    const { takeover, events } = await boot();
    takeover.begin({ reason: 'risk', actor: 'system', runId: 'run-9' });
    const view = takeover.end({ runId: 'run-9' });

    expect(view).toEqual({ isHeld: false, reason: null, startedAt: null, beginCount: 1, endCount: 1 });
    expect(events).toHaveLength(2);
    // actor 省略按 user 记：解除接管在 5.5 的口径里只有人的手（spec 5.5-01）。
    expect(takeover.audit(2)).toEqual([
      {
        id: expect.any(Number),
        kind: 'end',
        reason: 'risk',
        actor: 'user',
        runId: 'run-9',
        nodeId: null,
        createdAt: expect.any(Number),
      },
      {
        id: expect.any(Number),
        kind: 'begin',
        reason: 'risk',
        actor: 'system',
        runId: 'run-9',
        nodeId: null,
        createdAt: expect.any(Number),
      },
    ]);
  });

  it('未接管时 end 幂等：不凭空记一次「解除了从未发生的接管」', async () => {
    const { takeover, events } = await boot();
    const view = takeover.end();

    expect(view.isHeld).toBe(false);
    expect(view.endCount).toBe(0);
    expect(events).toHaveLength(0);
    expect(takeover.audit(10)).toEqual([]);
  });

  it('解除之后再 begin 是新一轮：起点重算、计数各自累加，审计四行两两配对', async () => {
    const { takeover } = await boot();
    takeover.begin({ reason: 'manual', actor: 'user' });
    takeover.end();
    const second = takeover.begin({ reason: 'session-expired', actor: 'system' });

    expect(second).toMatchObject({ isHeld: true, reason: 'session-expired', beginCount: 2, endCount: 1 });
    expect(takeover.audit(4).map((row) => `${row.kind}:${row.reason}`)).toEqual([
      'begin:session-expired',
      'end:manual',
      'begin:manual',
    ]);
  });
});

describe('自动接管（spec 5.5-07：风控与登录失效都交回给人）', () => {
  it('风控信号一到就接管，审计里的 actor 是 system', async () => {
    const { ctx, takeover, events } = await boot();
    ctx.emit('browser/risk-signal', riskSignal());

    expect(takeover.held()).toMatchObject({ isHeld: true, reason: 'risk', beginCount: 1 });
    expect(events).toHaveLength(1);
    expect(takeover.audit(1)[0]).toMatchObject({ kind: 'begin', reason: 'risk', actor: 'system' });
  });

  it('登录态失效同样自动接管，原因是 session-expired', async () => {
    const { ctx, takeover } = await boot();
    ctx.emit('session/expired', { platform: 'boss', reason: 'expired', at: Date.now() });

    expect(takeover.held()).toMatchObject({ isHeld: true, reason: 'session-expired' });
    expect(takeover.audit(1)[0]).toMatchObject({ kind: 'begin', reason: 'session-expired', actor: 'system' });
  });

  it('自动接管不覆盖人已按下的那次：原因停在人写下的那一条', async () => {
    const { ctx, takeover } = await boot();
    takeover.begin({ reason: 'manual', actor: 'user' });
    ctx.emit('browser/risk-signal', riskSignal());

    expect(takeover.held().reason).toBe('manual');
    expect(takeover.audit(10)).toHaveLength(1);
  });

  it('解除本服务后信号不再写状态：不留一个还在往里写接管的哑 listener', async () => {
    const { ctx, takeover, takeoverFiber, events } = await boot();
    await takeoverFiber.dispose();
    fibers.splice(fibers.indexOf(takeoverFiber), 1);

    expect(() => ctx.emit('browser/risk-signal', riskSignal())).not.toThrow();
    // 摘掉的正是「状态源已经不在，但 listener 还在替它写」那一半：事件一条不发，内存读数也不动。
    expect(events).toHaveLength(0);
    expect(takeover.held()).toMatchObject({ isHeld: false, beginCount: 0 });
  });
});

describe('三类风控读数都转成接管（spec 5.5-07 的接线口）', () => {
  it('主文档 403 与 429：状态码那一类一命中就把页面交回人手', async () => {
    for (const statusCode of [403, 429]) {
      const { takeover, sessions, events } = await bootLinked();
      sessions.fireMainFrameResponse({
        url: 'http://127.0.0.1:10233/boss',
        statusCode,
        statusLine: `HTTP/1.1 ${String(statusCode)} Blocked`,
      });
      await flush();

      // 原因记 risk、actor 记 system：5.5-09 要说清「这一趟是谁把页面要过去的」，读的就是这两格。
      expect(takeover.held()).toMatchObject({ isHeld: true, reason: 'risk', beginCount: 1 });
      expect(takeover.audit(1)[0]).toMatchObject({ kind: 'begin', reason: 'risk', actor: 'system' });
      // 界面拿到的是变更后的读数而不是旧值：banner 慢一帧就是「已经接管了还显示能自动跑」。
      expect(events.at(-1)).toMatchObject({ isHeld: true, reason: 'risk' });
    }
  });

  it('200 的验证页（验证码那一类）也转成接管：接管只认信号，不自己判风控', async () => {
    const view = fakeView(fakeFrame('http://127.0.0.1:10233/boss'));
    const { takeover, sessions, registry, page } = await bootLinked(view);
    registry.riskPattern = '安全验证|访问验证';
    page.snapshotOverride = { title: '安全验证 - 本地仿站', bodyText: '检测到异常访问，请输入验证码后继续。' };
    sessions.fireMainFrameResponse({
      url: 'http://127.0.0.1:10233/boss',
      statusCode: 200,
      statusLine: 'HTTP/1.1 200 OK',
    });
    fireViewEvent(view, 'did-finish-load');
    await flush();

    // 本包对「什么是验证码」没有任何判据（§8.3 不识别不规避）：它只把观测层那一条信号换成状态。
    expect(takeover.held()).toMatchObject({ isHeld: true, reason: 'risk' });
    expect(takeover.audit(2).map((row) => row.kind)).toEqual(['begin']);
  });

  it('同一趟导航连着命中两次也只开一轮接管：起点与第一个原因不会被后一次抹掉', async () => {
    const { takeover, sessions } = await bootLinked();
    sessions.fireMainFrameResponse({ url: 'http://127.0.0.1:10233/boss', statusCode: 403, statusLine: 'HTTP/1.1 403' });
    await flush();
    const startedAt = takeover.held().startedAt;
    sessions.fireMainFrameResponse({
      url: 'http://127.0.0.1:10233/boss?q=1',
      statusCode: 429,
      statusLine: 'HTTP/1.1 429',
    });
    await flush();

    expect(takeover.held()).toMatchObject({ isHeld: true, beginCount: 1, startedAt });
    expect(takeover.audit(10)).toHaveLength(1);
  });
});

describe('审计回看（spec 5.5-09）', () => {
  it('倒序取最新若干条，limit 越界一律钳住而不是报错', async () => {
    const { takeover } = await boot();
    for (let index = 0; index < 3; index += 1) {
      takeover.begin({ reason: 'manual', actor: 'user', runId: `run-${String(index)}` });
      takeover.end({ runId: `run-${String(index)}` });
    }

    expect(takeover.audit(1).map((row) => row.runId)).toEqual(['run-2']);
    expect(takeover.audit(0)).toHaveLength(1);
    expect(takeover.audit(Number.NaN)).toHaveLength(1);
    expect(takeover.audit(-5)).toHaveLength(1);
    expect(takeover.audit(1000)).toHaveLength(6);
  });

  it('库里的脏值读成 null，不冒充任何一种已知原因', async () => {
    const { ctx, takeover } = await boot();
    takeover.begin({ reason: 'manual', actor: 'user' });
    // 直接手写一行库里的坏值：这张表可能被别的版本或别的程序写过（同 5.3-b 的审计读法）。
    asApp(ctx)
      .store.db.prepare(
        `INSERT INTO takeover_events (kind, reason, actor, run_id, node_id, created_at)
         VALUES ('begin', 'legacy-cause', 'robot', NULL, NULL, ?)`,
      )
      .run(Date.now());

    const [dirty] = takeover.audit(1);
    expect(dirty).toMatchObject({ kind: 'begin', reason: null, actor: null });
    expect(takeover.audit(2)[1]).toMatchObject({ reason: 'manual', actor: 'user' });
  });
});

describe('建表与号段（AGENTS.md §9 的 5.3-a 实测条）', () => {
  it('服务重挂不重复 push 号段 21，台账里始终只有一条', async () => {
    const dir = tempDir();
    const first = await boot(dir);
    expect(registeredTakeoverMigrations(first.ctx)).toBe(1);
    // 留下一行接管审计再重启：内存态会丢，账不会丢（5.5-09 的回看靠这一点）。
    first.takeover.begin({ reason: 'risk', actor: 'system' });

    await first.takeoverFiber.dispose();
    fibers.splice(fibers.indexOf(first.takeoverFiber), 1);
    // 在同一个库上重新挂载：迁移已在 `schema_migrations` 里记过账，若本服务无条件 push 就直接抛
    // 「迁移版本重复」；若把 DDL 挂在别的号段上，这一版在老库上根本执行不到（§9 的实测条）。
    const second = await boot(dir);
    expect(registeredTakeoverMigrations(second.ctx)).toBe(1);
    // 老库里那行接管记录还在：丢的是内存态，不是账。
    expect(second.takeover.audit(10)).toHaveLength(1);
    expect(second.takeover.held()).toMatchObject({ isHeld: false, reason: null, beginCount: 0, endCount: 0 });
  });
});

/** 数一下本上下文的迁移登记里有几条号段 21（重挂必须仍是 1 条）。 */
function registeredTakeoverMigrations(ctx: Context): number {
  return asApp(ctx).store.migrations.filter((registered) => registered.version === BROWSER_TAKEOVER_MIGRATION_VERSION)
    .length;
}
