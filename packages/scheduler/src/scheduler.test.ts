/**
 * `schedule.registry` 的行为测试（spec 5.7-05 / 06 / 07 / 08 / 09 的服务半边）。
 *
 * 一律打**假端口**：起跑口、闸门与频控预检都只声明"调度器需要的那件事"，
 * 于是这几条判据是可断言的结构事实，而不是对真实现的猜测——
 * ① 调度能做的最远一步就是 `start(planId)`（5.7-07）；
 * ② 拒因来自闸门、频控与 runner 的原话，调度器不自己编（5.7-06 / 08）；
 * ③ 时间全部注入，用例不等真分钟（plan §7.5.3 决策六）。
 * 真闸门 `mode:'daily'` 与真频控服务在同一条装配里怎么接力，由 `packages/main/src/schedule-gate-link.test.ts` 判；
 * 真工作流跑起来是什么样子由 5.7-d 的全链路负责，这里不重复。
 */
import { AppError, Context, Service, asApp, maybeService } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { nextRunAtMs } from './internal/cron.js';
import {
  SCHEDULE_MIGRATION_VERSION,
  SCHEDULE_MISSED_REASON,
  SCHEDULE_OUTBOUND_ACTIONS,
  ScheduleRegistryService,
} from './registry.js';
import type { ScheduleJobView } from './types.js';

const fibers: { dispose(): Promise<unknown> }[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (fibers.length) await fibers.pop()?.dispose();
  while (dirs.length) rmSync(dirs.shift() ?? '', { recursive: true, force: true });
});

/** 假的 `workflow.runner`：只出示调度器认识的那两只手。 */
class FakeRunnerService extends Service {
  static provide = 'workflow.runner';
  static Config = z.strictObject({});

  /** 每次 `start` 收到的 id，按顺序记下来——5.7-07 的断言就看这一列。 */
  starts: string[] = [];
  /** 用例把它置一句原因，下一次 `start` 就抛结构化失败（演"已有 run 在跑"与"计划被人删了"）。 */
  failWith: string | null = null;
  /** 可起跑清单；`plan-` 前缀那条是"用户存下来的"，`boss-e2e` 是内置目录里的。 */
  planIds = ['boss-e2e', 'plan-salvaged'];

  constructor(ctx: Context, _options: Record<string, never>) {
    super(ctx, 'workflow.runner');
  }

  plans() {
    return this.planIds.map((id) => ({ id }));
  }

  start(planId: string) {
    this.starts.push(planId);
    if (this.failWith) {
      const reason = this.failWith;
      this.failWith = null;
      throw new AppError('WORKFLOW_INVALID_STATE', reason, 'workflow.runner');
    }
    return { runId: `run-${String(this.starts.length)}` };
  }
}

/** 假的 `entitlement.gate`：只有只读的 `check`，因为调度侧不许记账（§7.3 的记账仍在节点里）。 */
class FakeGateService extends Service {
  static provide = 'entitlement.gate';
  static Config = z.strictObject({});

  /** 动作名 → 拒因；没配的动作一律放行。 */
  denials: Record<string, string> = {};

  constructor(ctx: Context, _options: Record<string, never>) {
    super(ctx, 'entitlement.gate');
  }

  check(action: string) {
    const reason = this.denials[action];
    if (reason) return { allowed: false, remaining: 0, reason };
    return { allowed: true, remaining: null, reason: null };
  }
}

/**
 * 假的 `outbound.throttle`：只有只读的预检那一只手（spec 5.7-08 的频控半边）。
 *
 * 区间数字刻意写死在用例里而不是让假服务持有配置：本包判的是"拿到拒因就跳过、不起 run"，
 * 至于下界怎么算出来的，由 `packages/outbound/src/throttle.test.ts` 与真装配那份链路用例负责。
 */
class FakeThrottleService extends Service {
  static provide = 'outbound.throttle';
  static Config = z.strictObject({});

  /** 动作名 → 拒因；没配的动作一律放行。 */
  refusals: Record<string, string> = {};
  /** 被问了几次（现问的读数：一次触发每条外发动作各问一次，不该更多） */
  asks = 0;

  constructor(ctx: Context, _options: Record<string, never>) {
    super(ctx, 'outbound.throttle');
  }

  checkGap(action: string) {
    this.asks += 1;
    const reason = this.refusals[action];
    if (reason) return { allowed: false, remainingMs: 25_000, reason };
    return { allowed: true, remainingMs: 0, reason: null };
  }
}

/**
 * 装一套 config + store + 调度登记处（+ 可选的三个假端口）。
 * @param options.withGate 是否挂闸门；不挂就演"闸门缺席时照跑，而不是调度器自己发明免限"
 * @param options.withThrottle 是否挂频控预检口；同上，缺席时调度器也不自己造间隔
 * @returns 上下文、调度服务、三个假服务句柄、本次临时目录
 */
async function boot(options: { withGate?: boolean; withThrottle?: boolean; dir?: string } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'auto-cc-schedule-'));
  if (!options.dir) dirs.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(ConfigService, { appName: 'auto-cc', paths: { userDataDir: dir } }));
  fibers.push(await ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  fibers.push(await ctx.plugin(FakeRunnerService, {}));
  // 假端口用 `maybeService` 取：`workflow.runner` / `entitlement.gate` 的类型增补住在各自的包里，
  // 本包不依赖它们（§4.1），所以 `asApp(ctx)['…']` 在这里根本没有那两个键——这恰好也是被测形状的侧面证明。
  const runner = maybeService<FakeRunnerService>(ctx, 'workflow.runner')!;
  let gate: FakeGateService | null = null;
  if (options.withGate !== false) {
    fibers.push(await ctx.plugin(FakeGateService, {}));
    gate = maybeService<FakeGateService>(ctx, 'entitlement.gate')!;
  }
  let throttle: FakeThrottleService | null = null;
  if (options.withThrottle !== false) {
    fibers.push(await ctx.plugin(FakeThrottleService, {}));
    throttle = maybeService<FakeThrottleService>(ctx, 'outbound.throttle')!;
  }
  // `tickIntervalMs` 带默认值，直接挂载点必须显式给（AGENTS.md §9 的 1.3 实测条）；
  // 这里给一小时，是为了让用例里的"触发"只来自显式的 `tick(nowMs)` 调用，而不是后台真的响了一次。
  fibers.push(await ctx.plugin(ScheduleRegistryService, { tickIntervalMs: 3_600_000 }));
  const schedule = asApp(ctx)['schedule.registry'];
  return { ctx, dir, schedule, runner, gate, throttle };
}

/** 取一次失败的错误码，用于断言"结构化失败而不是抛个字符串"。 */
function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof AppError ? error.code : `not-AppError:${String(error)}`;
  }
}

/** 建一条"每分钟"的任务并回到它的读数。 */
function everyMinute(schedule: ScheduleRegistryService): ScheduleJobView {
  return schedule.createJob({ name: '每分钟跑一遍主线', planId: 'boss-e2e', expression: '* * * * *' });
}

/**
 * 取任务的下一次计划点。
 * @param job 任务读数（`jobs()[0]` 这种取法在类型上是"可能没有"）
 * @returns 毫秒时间戳
 * @throws 任务不存在或没有下一次时直接抛——用例里出现它就是被测行为出了问题，比让断言拿到 undefined 更好读
 */
function nextAt(job: ScheduleJobView | undefined): number {
  if (!job || job.nextRunAt === null) throw new Error('用例预期这条任务有下一次计划点');
  return job.nextRunAt;
}

describe('cron 求值与本地时区口径（plan §7.5.2 的实测条）', () => {
  it('工作日 9 点算出来的是「本地 9 点、周一到周五」的第一个点', () => {
    const fromMs = Date.parse('2026-10-03T15:00:00Z');
    const nextMs = nextRunAtMs('0 9 * * 1-5', fromMs);
    const next = new Date(nextMs);
    // 断言用本地读法而不是写死 UTC 串：本机 UTC+8 时实测得到 2026-10-05T01:00Z（= 本地周一 09:00），
    // 换一台 UTC 机器写死串就假红了——判据是"本地 9 点"，不是"某个固定时刻"。
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDay()).toBeGreaterThanOrEqual(1);
    expect(next.getDay()).toBeLessThanOrEqual(5);
    expect(nextMs).toBeGreaterThan(fromMs);
    expect(nextMs - fromMs).toBeLessThan(8 * 24 * 60 * 60 * 1000);
  });

  it('永不成立的表达式（2 月 31 日）在求值期就结构化失败', () => {
    expect(codeOf(() => nextRunAtMs('0 0 31 2 *', Date.now()))).toBe('INVALID_ARGUMENT');
  });
});

describe('建任务即校验（spec 5.7-05 / 5.7-07）', () => {
  it('表达式与计划 id 都过得落库一条，且带上算好的下一次', async () => {
    const { schedule } = await boot();
    const job = schedule.createJob({ name: '工作日晚 9 点', planId: 'plan-salvaged', expression: '0 21 * * 1-5' });
    expect(job.planId).toBe('plan-salvaged');
    expect(job.isEnabled).toBe(true);
    expect(job.nextRunAt).not.toBeNull();
    expect(job.nextRunAt! > job.createdAt).toBe(true);
    expect(schedule.jobs().map((row) => row.id)).toEqual([job.id]);
  });

  it('未知计划 id 直接被拒，并把可用值列出来——定时任务只能触发已保存的工作流', async () => {
    const { schedule, runner } = await boot();
    expect(
      codeOf(() => schedule.createJob({ name: '随便', planId: 'boss-basic-not-here', expression: '@daily' })),
    ).toBe('INVALID_ARGUMENT');
    expect(runner.starts).toEqual([]);
    expect(schedule.jobs()).toEqual([]);
  });

  it('入参里没有「一段话」这个形状：多塞 goal 就是 unrecognized key', async () => {
    const { schedule } = await boot();
    let message = '';
    try {
      schedule.createJob({
        name: '替我找工作',
        planId: 'boss-e2e',
        expression: '@daily',
        // 故意越形：无人值守下不临场规划外发（5.7-07），端口与入参都没有这条路
        goal: '每天搜一遍并挨个打招呼',
      } as never);
    } catch (error) {
      message = error instanceof AppError ? error.message : String(error);
    }
    expect(message).toContain('goal');
    expect(schedule.jobs()).toEqual([]);
  });
});

describe('到点触发与触发记录（spec 5.7-06）', () => {
  it('到点起一次跑、落一行 started、计划点推进', async () => {
    const { schedule, runner } = await boot();
    const job = everyMinute(schedule);
    const plannedAt = job.nextRunAt!;
    const firedAt = plannedAt + 1000;

    expect(schedule.tick(firedAt)).toBe(1);
    expect(runner.starts).toEqual(['boss-e2e']);
    const [record] = schedule.triggers(job.id);
    expect(record?.result).toBe('started');
    expect(record?.plannedAt).toBe(plannedAt);
    expect(record?.firedAt).toBe(firedAt);
    expect(record?.workflowRunId).toBe('run-1');
    expect(record?.reason).toBeNull();

    const after = schedule.jobs()[0];
    expect(after?.lastPlannedAt).toBe(plannedAt);
    expect(nextAt(after) > firedAt).toBe(true);
  });

  it('起跑失败记一行 failed、带上 runner 的原话，且不影响下一次', async () => {
    const { schedule, runner } = await boot();
    const job = everyMinute(schedule);
    runner.failWith = '已有 run 处于 running 态，先处理完它';

    const firstPlanned = job.nextRunAt!;
    schedule.tick(firstPlanned);
    const [failed] = schedule.triggers(job.id);
    expect(failed?.result).toBe('failed');
    expect(failed?.reason).toBe('已有 run 处于 running 态，先处理完它');
    expect(failed?.workflowRunId).toBeNull();

    // 关键判据：失败之后 schedule 仍被推进，下一个计划点照触发（不补跑、也不"因为上次失败就停"）。
    const next = schedule.jobs()[0];
    expect(next?.nextRunAt).not.toBe(firstPlanned);
    schedule.tick(next!.nextRunAt!);
    expect(runner.starts).toHaveLength(2);
    expect(schedule.triggers(job.id)[0]?.result).toBe('started');
  });

  it('手工「跑一次」走同一条腿：也记账、也推进', async () => {
    const { schedule, runner } = await boot();
    const job = everyMinute(schedule);
    const record = schedule.triggerNow(job.id, job.nextRunAt! + 5000);
    expect(record.result).toBe('started');
    expect(runner.starts).toEqual(['boss-e2e']);
    expect(nextAt(schedule.jobs()[0]) > job.nextRunAt! + 5000).toBe(true);
  });
});

describe('额度闸门（spec 5.7-08）', () => {
  it('外发额度用尽即跳过并记账，一次 run 都不起', async () => {
    const { schedule, runner, gate } = await boot();
    const job = everyMinute(schedule);
    gate!.denials.deliver = '动作 deliver 今日 10 次额度已用完';

    expect(schedule.tick(job.nextRunAt!)).toBe(1);
    expect(runner.starts).toEqual([]);
    const [record] = schedule.triggers(job.id);
    expect(record?.result).toBe('skipped');
    expect(record?.reason).toBe('动作 deliver 今日 10 次额度已用完');

    // 额度回来之后，下一个计划点照常触发——跳过不是一次性熔断。
    delete gate!.denials.deliver;
    const next = schedule.jobs()[0];
    schedule.tick(next!.nextRunAt!);
    expect(runner.starts).toEqual(['boss-e2e']);
  });

  it('预检查覆盖两条外发动作，名字来自闸门而不是调度器自己', async () => {
    const { schedule } = await boot();
    const job = everyMinute(schedule);
    // 名单只可能是 greet / deliver：抓取失败只是白跑一趟，不需要在这里预检（plan §7.5.3 决策四）
    expect([...SCHEDULE_OUTBOUND_ACTIONS]).toEqual(['greet', 'deliver']);
    expect(schedule.triggers(job.id)).toEqual([]);
  });

  it('闸门未挂载时照跑，而不是让调度器自己发明一套额度', async () => {
    const { schedule, runner } = await boot({ withGate: false });
    const job = everyMinute(schedule);
    schedule.tick(job.nextRunAt!);
    expect(runner.starts).toEqual(['boss-e2e']);
    expect(schedule.triggers(job.id)[0]?.result).toBe('started');
  });
});

describe('频控预检（spec 5.7-08 的频控半边）', () => {
  it('间隔未到即跳过并记账，一次 run 都不起，且下一跳照跑', async () => {
    const { schedule, runner, throttle } = await boot();
    const job = everyMinute(schedule);
    throttle!.refusals.greet = '离上一次打招呼还差 25 秒（外发间隔 45.0s – 150.0s 的下界还没过），按频控此刻不动手';

    expect(schedule.tick(job.nextRunAt!)).toBe(1);
    expect(runner.starts).toEqual([]);
    const [record] = schedule.triggers(job.id);
    // 拒因是节流服务的原话，调度器不翻译（同 5.7-a 对 runner 失败的口径：证据链要对着原话而不是转述）。
    expect(record?.result).toBe('skipped');
    expect(record?.reason).toBe('离上一次打招呼还差 25 秒（外发间隔 45.0s – 150.0s 的下界还没过），按频控此刻不动手');

    // 跳过的这一跳照样把计划点推进：不推进就会每分钟重试一次、把触发记录写成一行行重复的等待。
    expect(schedule.jobs()[0]!.nextRunAt).toBeGreaterThan(job.nextRunAt!);

    // 间隔过去之后（这里等于"预检放行"），下一个计划点正常起跑——频控不是熔断。
    delete throttle!.refusals.greet;
    schedule.tick(schedule.jobs()[0]!.nextRunAt!);
    expect(runner.starts).toEqual(['boss-e2e']);
  });

  it('两条外发动作各问一次且只问一次，用的名单与额度预检同一份', async () => {
    const { schedule, throttle } = await boot();
    const job = everyMinute(schedule);
    schedule.tick(job.nextRunAt!);
    expect(throttle!.asks).toBe(SCHEDULE_OUTBOUND_ACTIONS.length);
    expect([...SCHEDULE_OUTBOUND_ACTIONS]).toEqual(['greet', 'deliver']);
  });

  it('节流服务未挂载时照跑，而不是让调度器自己造一个间隔', async () => {
    const { schedule, runner } = await boot({ withThrottle: false });
    const job = everyMinute(schedule);
    schedule.tick(job.nextRunAt!);
    expect(runner.starts).toEqual(['boss-e2e']);
    expect(schedule.triggers(job.id)[0]?.result).toBe('started');
  });

  it('额度与频控同时被拒时报的是额度那句（判序固定：今天没了 ≠ 再等一会儿）', async () => {
    const { schedule, gate, throttle } = await boot();
    const job = everyMinute(schedule);
    gate!.denials.deliver = '动作 deliver 今日 10 次额度已用完';
    throttle!.refusals.deliver = '离上一次投递还差 40 秒，按频控此刻不动手';
    schedule.tick(job.nextRunAt!);
    expect(schedule.triggers(job.id)[0]?.reason).toBe('动作 deliver 今日 10 次额度已用完');
    // 频控那一句根本没被问到：闸门已经判死，不必再问还要等多久。
    expect(throttle!.asks).toBe(0);
  });

  it('手工「跑一次」也被频控挡住：它不是后门，走的是同一条腿', async () => {
    const { schedule, runner, throttle } = await boot();
    const job = everyMinute(schedule);
    throttle!.refusals.greet = '离上一次打招呼还差 12 秒，按频控此刻不动手';
    const trigger = schedule.triggerNow(job.id, job.nextRunAt!);
    expect(trigger.result).toBe('skipped');
    expect(runner.starts).toEqual([]);
  });
});

describe('关机期间不补跑（spec 5.7-09）', () => {
  it('重启追账：越过的点记 skipped、不起 run，下一次推到当下之后', async () => {
    const { schedule, runner } = await boot();
    const job = everyMinute(schedule);
    const missedPlannedAt = job.nextRunAt!;
    // 模拟"关机"：那个计划点上没有任何 tick 发生（进程不在），重启后先追账。
    const restartedAt = missedPlannedAt + 5 * 60_000;

    expect(schedule.accountForMissedRuns(restartedAt)).toBe(1);
    expect(runner.starts).toEqual([]);
    const [record] = schedule.triggers(job.id);
    expect(record?.result).toBe('skipped');
    expect(record?.reason).toBe(SCHEDULE_MISSED_REASON);
    expect(record?.plannedAt).toBe(missedPlannedAt);
    // firedAt 为 null 是诚实读数：那一刻 app 根本没在跑，没有"动手时刻"可报。
    expect(record?.firedAt).toBeNull();

    const after = schedule.jobs()[0];
    expect(nextAt(after) > restartedAt).toBe(true);
    expect(after?.lastPlannedAt).toBe(missedPlannedAt);

    // 追账只吞掉那一个越过点：之后到点照常触发。
    schedule.tick(after!.nextRunAt!);
    expect(runner.starts).toEqual(['boss-e2e']);
  });

  it('挂载即追账：init 里那一次把历史遗留的过去点标掉', async () => {
    const first = await boot();
    const job = everyMinute(first.schedule);
    // 直接改表造出"上次会话遗留的过去计划点"——下一个用例复用同一个库文件，那就是一次重启。
    const past = job.nextRunAt! - 60_000;
    asApp(first.ctx).store.db.prepare('UPDATE schedule_jobs SET next_run_at = ? WHERE id = ?').run(past, job.id);
    while (fibers.length) await fibers.pop()?.dispose();

    const second = await boot({ dir: first.dir });
    expect(second.runner.starts).toEqual([]);
    const [record] = second.schedule.triggers(job.id);
    expect(record?.result).toBe('skipped');
    expect(record?.plannedAt).toBe(past);
    expect(nextAt(second.schedule.jobs()[0]) > Date.now()).toBe(true);
  });
});

describe('停用与启用（spec 5.7-05 的启停半边）', () => {
  it('停用后到点不触发，重新启用按当时重算且不记为错过', async () => {
    const { schedule, runner } = await boot();
    const job = everyMinute(schedule);
    schedule.setEnabled(job.id, false, job.nextRunAt! + 1000);

    expect(schedule.tick(job.nextRunAt! + 2000)).toBe(0);
    // 停用期间的越过点不该被追账成"已跳过"：用户停了它就是不打算让它跑。
    expect(schedule.accountForMissedRuns(job.nextRunAt! + 30 * 60_000)).toBe(0);
    expect(runner.starts).toEqual([]);
    expect(schedule.triggers(job.id)).toEqual([]);

    const reEnabledAt = job.nextRunAt! + 40 * 60_000;
    const revived = schedule.setEnabled(job.id, true, reEnabledAt);
    expect(revived.isEnabled).toBe(true);
    expect(revived.nextRunAt! > reEnabledAt).toBe(true);
    expect(schedule.triggers(job.id)).toEqual([]);
  });

  it('删除任务保留触发历史（那是账），并让不存在的 id 结构化失败', async () => {
    const { ctx, schedule } = await boot();
    const job = everyMinute(schedule);
    schedule.tick(job.nextRunAt!);
    schedule.removeJob(job.id);
    expect(schedule.jobs()).toEqual([]);
    expect(codeOf(() => schedule.removeJob(job.id))).toBe('INVALID_ARGUMENT');
    // 记录还在：任务没了，但它跑过这件事仍然是事实（5.7-06 的账不跟着消失）。
    const rows = asApp(ctx).store.db.prepare('SELECT result FROM schedule_triggers').all() as unknown as {
      result: string;
    }[];
    expect(rows.map((row) => row.result)).toEqual(['started']);
  });
});

describe('号段与建表（AGENTS.md §4 的存储口径）', () => {
  it('号段 25 进了台账，两张表都在', async () => {
    const { ctx } = await boot();
    expect(SCHEDULE_MIGRATION_VERSION).toBe(25);
    const store = asApp(ctx).store;
    const applied = store.db
      .prepare('SELECT version FROM schema_migrations WHERE version = ?')
      .get(SCHEDULE_MIGRATION_VERSION);
    expect(applied).toBeTruthy();
    const tables = (
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'schedule_%' ORDER BY name")
        .all() as unknown as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(tables).toEqual(['schedule_jobs', 'schedule_triggers']);
  });
});
