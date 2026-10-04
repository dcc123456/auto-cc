/**
 * 定时任务起跑前的两道**只读**预检（spec 5.7-08 的判据原文：「调度触发同样受 `entitlement.gate` 与频控约束，
 * 额度用尽即跳过并记账」，验证操作「切『每天 N 次』实现 → 断言被拒」，M6b-01 的判据主体）。
 *
 * 为什么这条住在 `packages/main`（与 4.4-09 / 5.3-11 同一理由）：判据要的是**真闸门 `mode:'daily'`、真账本、
 * 真节流服务、真调度登记处**在同一条装配里接力。`packages/scheduler` 不依赖那三个包（AGENTS.md §4.1），
 * 在它自己包里只能拿假端口演一遍「被拒」，而假端口既不会数日额度、也不会看账本里的时刻，
 * 「间隔未到」与「今日用尽」这两句在替身上是写出来的字符串，不是算出来的读数。
 *
 * 四组判定各守一种失效模式：
 * 1. **额度见底这一跳真被跳过**（`mode:'daily'` + 某一条外发上限 1 + 当天先落一条该动作的账）：
 *    runner 一次都没被叫，界面读到的拒因是闸门自己的原话。打招呼与投递**各演一次**——
 *    `M6b-01` 的原文说的是「超限投递被拒…（手动 + 调度两条路径）」，手动那半边早已由
 *    `packages/outbound/src/deliver.test.ts:508` 以真闸门判过，本片补的就是调度这半边的投递那一条。
 *    这一组是正向证明：调度器如果在任何一处把额度判据自己编了一遍，这里就会拿到一句
 *    不同于「动作 X 今日 N 次额度已用完」的话。
 *    判据原文那句「跳过并**记账**」指的是 `schedule_triggers` 里那一行 skipped：它存在、带原话、
 *    `workflowRunId` 为空；而**用量表与被拒流水都不多一行**——预检是只读的，
 *    `usage_denials` 只由 `gate.enforce` 那一个写入口产生（spec 5.3-12），
 *    调度器"看了一眼就走"不该被记成"有人试过被拦下"，更不能吃掉任何额度或启动频控的钟。
 * 2. **频控未到这一跳真被跳过**（外发间隔 min=max=60s + 账本里有一条几十秒前的 greet）：
 *    拒因来自 `outbound.throttle`（「离上一次打招呼还差 …」），而**没有历史那一行时同一个计划点照常起跑**
 *    当正向对照——否则"跳过"可能只是调度器无条件不跑。投递那一条也单独验一次：
 *    名单是 `SCHEDULE_OUTBOUND_ACTIONS` 两条，漏一条就是"只挡打招呼"的假护栏。
 * 3. **判序**：额度与频控同时不通时，记录的是**额度**那句。两句不能混——读到「今日用尽」要人去改配置，
 *    读到「还差几十秒」什么都不用改，下一跳照跑。
 * 4. **恢复**：日界之后、以及间隔下界过了之后，计划点都照常起跑（跳过不是一次性熔断）。
 *
 * 时间一律注入（`tick(nowMs)`），用例不等真分钟；间隔与日额度的**算术**不在这里重复断言
 * （`throttle.test.ts` 与 `gate` 的用例已按精确数字判过下界与计数），这里判的是"接线"：
 * 读数来自谁、显示给人的是哪句、有没有多余副作用。
 * 起跑口是假的（真 `workflow.runner` 要浏览器宿主与登录态，那是 5.7-d 全链路的事），
 * 除此之外装配里没有替身；全程不落任何真实平台（§7.2），后台 tick 设成一小时一次，
 * 免得真实时钟在断言中间自己响一次。
 */
import { asApp, Context, maybeService, Service, type Fiber } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import {
  DEFAULT_DAILY_LIMITS,
  EntitlementGateService,
  UsageLedgerService,
  type GateConfig,
} from '@auto-cc/plugin-entitlement';
import { LogService } from '@auto-cc/plugin-logger';
import { OutboundThrottleService, throttleSchema } from '@auto-cc/plugin-outbound';
import { ScheduleRegistryService, type ScheduleJobView, type ScheduleLaunchPort } from '@auto-cc/plugin-scheduler';
import { StoreService } from '@auto-cc/plugin-store';
import { startOfDay } from '@auto-cc/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

/** 打招呼每天只许一次的闸门配置（判据原文要的「切『每天 N 次』实现」就是它）。 */
const ONE_GREET_PER_DAY: GateConfig = {
  mode: 'daily',
  dailyLimits: { ...DEFAULT_DAILY_LIMITS, greet: 1 },
};

/**
 * 投递每天只许一次的闸门配置。
 * @remarks 里程碑 `M6b-01` 的原文说的是「超限**投递**被拒并给出可读原因（手动 + 调度两条路径）」：
 * 手动那一条由 `packages/outbound/src/deliver.test.ts:508` 以真闸门判过，这里补的是调度那一条，
 * 所以这条装配按 `deliver` 收口而不是只演打招呼。
 */
const ONE_DELIVER_PER_DAY: GateConfig = {
  mode: 'daily',
  dailyLimits: { ...DEFAULT_DAILY_LIMITS, deliver: 1 },
};

/** 不设限的闸门配置（频控那几格要用它，好让「被跳过」只能来自频控那一半边）。 */
const UNLIMITED: GateConfig = { mode: 'unlimited', dailyLimits: DEFAULT_DAILY_LIMITS };

/** 外发间隔取固定 60 秒（min=max 让区间下界就是它，"间隔未到"在整份用例里可复现）。 */
const GAP_MS = 60_000;

/** 上一次外发距计划点的毫秒数（小于 GAP_MS，于是间隔必然还没过）。 */
const RECENT_MS = 20_000;

/** 装配里唯一可起跑的计划 id（假起跑口只出示这一条）。 */
const PLAN_ID = 'boss-e2e';

const sandboxes: string[] = [];
const fibers: Fiber[] = [];

/** 建一个系统临时目录（`afterAll` 负责清理，产物不进仓库，§7.5）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-schedule-gate-'));
  sandboxes.push(dir);
  return dir;
}

/**
 * 假的 `workflow.runner`：只出示调度器认识的那两只手。
 *
 * 真 runner 要浏览器宿主与登录态（那是 5.7-d 全链路判的东西），而本片判的是起跑**之前**的两道预检，
 * 所以这里只留一个读数：`starts`。判据「一次 run 都不起」看的就是它空不空。
 */
class FakeRunnerService extends Service implements ScheduleLaunchPort {
  static provide = 'workflow.runner';
  static Config = z.strictObject({});

  /** 每次 `start` 收到的计划 id，按顺序记下来。 */
  starts: string[] = [];

  constructor(ctx: Context, _options: Record<string, never>) {
    super(ctx, 'workflow.runner');
  }

  /** 契约见 `ScheduleLaunchPort.plans`：只出示那一条内置计划。 */
  plans() {
    return [{ id: PLAN_ID }];
  }

  /** 契约见 `ScheduleLaunchPort.start`。 */
  start(planId: string) {
    this.starts.push(planId);
    return { runId: `run-${String(this.starts.length)}` };
  }
}

/**
 * 撑起「真闸门 + 真账本 + 真频控 + 真调度登记处」的装配。
 * @param options.gate 闸门配置（日额度见底那一组与不设限那一组共用本函数，不各抄一份装配）
 * @param options.gapMs 外发间隔（min=max）；传 0 表示"频控不掺进来"，好让跳过只能来自额度
 * @returns 三个真服务与假起跑口的句柄
 */
async function boot(options: { gate: GateConfig; gapMs: number }) {
  const dir = tempDir();
  const ctx = new Context();
  /** 挂一个插件并把它的 fiber 记进收尾清单（`ctx.plugin` 返回 thenable 的 fiber，不是 `Promise<Fiber>`）。 */
  const mount = async (fiber: Fiber | PromiseLike<Fiber>): Promise<void> => {
    fibers.push(await fiber);
  };
  await mount(ctx.plugin(ConfigService, { appName: 'auto-cc', paths: { userDataDir: dir } }));
  await mount(ctx.plugin(LogService, { level: 'info', buffer: 200, file: 'auto-cc.log', dir, redact: false }));
  await mount(ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  // 空配置服务传字面量 `{}`：账本的 `Config` 是 `z.strictObject({})`（口径同 `gap-quota-link.test.ts`）。
  await mount(ctx.plugin(UsageLedgerService, {}));
  await mount(ctx.plugin(EntitlementGateService, options.gate));
  await mount(
    ctx.plugin(
      OutboundThrottleService,
      throttleSchema.parse({
        minGapMs: options.gapMs,
        maxGapMs: options.gapMs,
        scrollMinGapMs: 0,
        scrollMaxGapMs: 0,
      }),
    ),
  );
  // 起跑口先于登记处上岗：`createJob` 当场要问 `plans()` 校验计划 id，晚挂载就是"没有可校验的清单"。
  await mount(ctx.plugin(FakeRunnerService, {}));
  // `tickIntervalMs` 带默认值，直接挂载点必须显式给（AGENTS.md §9 的 1.3 实测条）；一小时是为了让
  // 触发只来自用例里显式的 `tick(nowMs)`，而不是真实时钟在两条断言之间自己响了一次。
  await mount(ctx.plugin(ScheduleRegistryService, { tickIntervalMs: 3_600_000 }));
  const app = asApp(ctx);
  return {
    schedule: app['schedule.registry'],
    gate: app['entitlement.gate'],
    ledger: app['usage.ledger'],
    runner: maybeService<FakeRunnerService>(ctx, 'workflow.runner')!,
  };
}

/**
 * 喂给 `gate.perform` 的假外发动作（种子那一行用它）。
 *
 * `perform` 的 `task` 签名是 `() => Promise<T>`（它要 `await` 真动作再落账），而这里没有真动作：
 * 写成 `async () => 'x'` 会被 eslint 的 `require-await` 判成"async 里没有 await"，
 * 所以显式返回一个已完成的 Promise（同 `gap-quota-link.test.ts` 的先例）。
 * @returns 永远成功的假动作结果
 */
const fakeDispatch = (): Promise<string> => Promise.resolve('fixture 侧已发生的一次外发');

/**
 * 建一条"每分钟"的启用任务。
 * @param schedule 真调度登记处
 * @returns 落库后的任务读数，`nextRunAt` 就是本次用例要 tick 的计划点
 */
function everyMinute(schedule: ScheduleRegistryService): ScheduleJobView {
  return schedule.createJob({ name: '每分钟跑一遍主线', planId: PLAN_ID, expression: '* * * * *' });
}

/**
 * 取任务的下一次计划点。
 * @param job 任务读数（`jobs()[0]` 这种取法在类型上是"可能没有"）
 * @returns 毫秒时间戳
 * @throws 任务不存在或没有下一次时抛——用例预期它一直启用且有下一次，静默拿到 undefined 会把断言变成假绿
 */
function nextAt(job: ScheduleJobView | undefined): number {
  if (!job || job.nextRunAt === null) throw new Error('用例预期这条任务有下一次计划点');
  return job.nextRunAt;
}

/**
 * 种下"最近一次外发"的时刻：既要早于计划点（让间隔真的没过），也要落在计划点的**同一个本地日**
 * （否则 `countToday` 数不到它，日额度那一格就变成放行）。取两者里较晚的那个，
 * 用例就不依赖"现在几点"——否则在本地零点前半分钟跑到这份用例会假红。
 * @param plannedAt 本次计划点（毫秒）
 * @returns 种子时刻（毫秒）
 */
function seedAt(plannedAt: number): number {
  return Math.max(plannedAt - RECENT_MS, startOfDay(plannedAt) + 1);
}

/**
 * 某时刻所在本地日的**次日同一时刻**（跨日界那一格用它，而不是加 86400000：
 * 有夏令时的机器上那会是差一小时的两个读数，而判据说的是"第二天"）。
 * @param ms 基准毫秒
 * @returns 次日同一壁钟时刻的毫秒
 */
function sameTimeNextDay(ms: number): number {
  const date = new Date(ms);
  date.setDate(date.getDate() + 1);
  return date.getTime();
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  // 日志写流是异步开文件的：不等一下就先删目录会在收尾之后冒出 ENOENT 的未处理异常（同 4.4-09 那份用例）。
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟释放，清理失败不该把一次通过的验收判成失败。
    }
  }
});

describe('5.7-08 额度见底：到点即跳过并留下那一行账（真闸门 mode:daily + 真账本）', () => {
  it('打招呼今日 1 次已用尽 → 不起 run、拒因是闸门原话，而"记账"落在触发记录而不是用量表', async () => {
    const { schedule, gate, ledger, runner } = await boot({ gate: ONE_GREET_PER_DAY, gapMs: 0 });
    const job = everyMinute(schedule);
    const plannedAt = nextAt(job);
    await gate.perform('greet', { targetId: 'job-seed', nowMs: seedAt(plannedAt) }, fakeDispatch);
    expect(gate.check('greet', { nowMs: plannedAt })).toMatchObject({ allowed: false, remaining: 0 });
    const usageBefore = ledger.count();

    expect(schedule.tick(plannedAt)).toBe(1);
    expect(runner.starts).toEqual([]);
    const [record] = schedule.triggers(job.id);
    expect(record).toMatchObject({ result: 'skipped', workflowRunId: null, plannedAt, firedAt: plannedAt });
    expect(record?.reason).toContain('动作 greet 今日 1 次额度已用完');
    // 只读预检的两条硬性质：不吃额度、不伪造"有人试过被拦下"的审计流水。
    expect(ledger.count()).toBe(usageBefore);
    expect(ledger.recentDenials(10)).toEqual([]);
    // 计划点照常推进：这一跳跳过不等于任务被停用。
    expect(nextAt(schedule.jobs()[0]) > plannedAt).toBe(true);
  });

  it('投递超限同样被拒并给出可读原因（M6b-01 说的是"超限投递 + 调度路径"那一条）', async () => {
    const { schedule, gate, ledger, runner } = await boot({ gate: ONE_DELIVER_PER_DAY, gapMs: 0 });
    const job = everyMinute(schedule);
    const plannedAt = nextAt(job);
    await gate.perform('deliver', { targetId: 'job-seed', nowMs: seedAt(plannedAt) }, fakeDispatch);

    expect(schedule.tick(plannedAt)).toBe(1);
    expect(runner.starts).toEqual([]);
    const [record] = schedule.triggers(job.id);
    expect(record).toMatchObject({ result: 'skipped', workflowRunId: null });
    expect(record?.reason).toBe('动作 deliver 今日 1 次额度已用完');
    // 名单是 greet / deliver 两条，第二条见底时同样按得住；而"按不住"的那半边由上一条打招呼用例判。
    expect(ledger.recentDenials(10)).toEqual([]);
  });

  it('次日额度恢复 → 下一个计划点照常起跑（跳过不是一次性熔断）', async () => {
    const { schedule, gate, ledger, runner } = await boot({ gate: ONE_GREET_PER_DAY, gapMs: 0 });
    const job = everyMinute(schedule);
    const plannedAt = nextAt(job);
    await gate.perform('greet', { targetId: 'job-seed', nowMs: seedAt(plannedAt) }, fakeDispatch);
    expect(schedule.tick(plannedAt)).toBe(1);
    expect(runner.starts).toEqual([]);

    const nextPlannedAt = nextAt(schedule.jobs()[0]);
    expect(schedule.tick(sameTimeNextDay(plannedAt))).toBe(1);
    expect(runner.starts).toEqual([PLAN_ID]);
    const [latest] = schedule.triggers(job.id);
    expect(latest).toMatchObject({ result: 'started', reason: null, workflowRunId: 'run-1', plannedAt: nextPlannedAt });
    // 起跑本身不落账：额度是在节点里由 `perform` 扣的（§7.3），调度器只负责"叫它起来"。
    expect(ledger.count()).toBe(1);
  });
});

describe('5.7-08 频控间隔未到：到点即跳过（真 outbound.throttle + 账本里那一刻的钟）', () => {
  it('上一次打招呼还在下界之内 → 跳过，拒因来自节流服务且零副作用', async () => {
    const { schedule, gate, ledger, runner } = await boot({ gate: UNLIMITED, gapMs: GAP_MS });
    const job = everyMinute(schedule);
    const plannedAt = nextAt(job);
    await gate.perform('greet', { targetId: 'job-seed', nowMs: seedAt(plannedAt) }, fakeDispatch);
    const usageBefore = ledger.count();

    expect(schedule.tick(plannedAt)).toBe(1);
    expect(runner.starts).toEqual([]);
    const [record] = schedule.triggers(job.id);
    expect(record).toMatchObject({ result: 'skipped', workflowRunId: null });
    // 「还差几秒」的具体算术在 `throttle.test.ts` 判过，这里判的是这句话确实来自节流而不是调度器编的。
    expect(record?.reason).toContain('离上一次打招呼还差');
    expect(record?.reason).toContain('按频控此刻不动手');
    expect(ledger.count()).toBe(usageBefore);
    expect(ledger.recentDenials(10)).toEqual([]);
    expect(nextAt(schedule.jobs()[0]) > plannedAt).toBe(true);
  });

  it('正向对照：同样的装配里账本没有那一行时，同一个计划点照常起跑且不落账', async () => {
    const { schedule, runner, ledger } = await boot({ gate: UNLIMITED, gapMs: GAP_MS });
    const job = everyMinute(schedule);

    // 上一格的"跳过"只有在下一次真能起跑时才是频控造成的，而不是调度器无条件不跑。
    expect(ledger.count()).toBe(0);
    expect(schedule.tick(nextAt(job))).toBe(1);
    expect(runner.starts).toEqual([PLAN_ID]);
    expect(schedule.triggers(job.id)[0]).toMatchObject({ result: 'started', workflowRunId: 'run-1' });
    expect(ledger.count()).toBe(0);
  });

  it('间隔下界过了之后 → 下一个计划点照常起跑', async () => {
    const { schedule, gate, runner } = await boot({ gate: UNLIMITED, gapMs: GAP_MS });
    const job = everyMinute(schedule);
    const plannedAt = nextAt(job);
    await gate.perform('greet', { targetId: 'job-seed', nowMs: seedAt(plannedAt) }, fakeDispatch);
    expect(schedule.tick(plannedAt)).toBe(1);
    expect(runner.starts).toEqual([]);

    // 分钟级 cron 的下一个计划点必然晚于「种子时刻 + 一个完整间隔」，所以下一跳已经跨过下界。
    expect(schedule.tick(nextAt(schedule.jobs()[0]))).toBe(1);
    expect(runner.starts).toEqual([PLAN_ID]);
    expect(schedule.triggers(job.id)[0]).toMatchObject({ result: 'started', reason: null });
  });

  it('投递也在预检名单里：最近一次投递同样会按住这一跳（名单漏一条就是假护栏）', async () => {
    const { schedule, gate, runner } = await boot({ gate: UNLIMITED, gapMs: GAP_MS });
    const job = everyMinute(schedule);
    const plannedAt = nextAt(job);
    await gate.perform('deliver', { targetId: 'job-seed', nowMs: seedAt(plannedAt) }, fakeDispatch);

    expect(schedule.tick(plannedAt)).toBe(1);
    expect(runner.starts).toEqual([]);
    expect(schedule.triggers(job.id)[0]?.reason).toContain('离上一次投递还差');
  });
});

describe('5.7-08 判序：额度先于频控（两句拒因不许混成一句）', () => {
  it('今日用尽且间隔也没到 → 记录的是额度那句', async () => {
    const { schedule, gate, runner } = await boot({ gate: ONE_GREET_PER_DAY, gapMs: GAP_MS });
    const job = everyMinute(schedule);
    const plannedAt = nextAt(job);
    // 同一条种子行同时把两样都打掉：greet 用到 1/1 见底，而那次外发就在几十秒前。
    await gate.perform('greet', { targetId: 'job-seed', nowMs: seedAt(plannedAt) }, fakeDispatch);

    expect(schedule.tick(plannedAt)).toBe(1);
    expect(runner.starts).toEqual([]);
    const reason = schedule.triggers(job.id)[0]?.reason ?? '';
    expect(reason).toContain('额度已用完');
    expect(reason).not.toContain('还差');
  });
});
