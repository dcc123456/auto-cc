/**
 * `funnel.query` 的聚合与「每一级都有确定结局」用例（spec 5.8-01 / 02 / 04，plan §7.6.3 的 5.8-a 半边，U 类）。
 *
 * 判据与 5.7 的引用路由口同形：五级**要么给出数字、要么给出那句原因**，两者必有其一且只有一。
 * 「没数也没原因」是漏了一支分支，「没数却报 0」是把「这段没干活」画成一条读数——5.8-07 要拦的正是后者。
 *
 * 四只归属服务一律用**结构替身**：本包按 spec 5.1-08 / AGENTS.md §5.9 不许 import 能力包
 * （eslint `AGENT_CAPABILITY` 机检，另有 `agent.test.ts` 那条 import 行审计守着），所以真服务是否
 * 真的提供 `countCaptured` / `repliedJobCount` / `countAction` / `count` 这四只手，
 * 由 `packages/main/src/metrics-link.test.ts` 的活体装配负责（plan §7.5.7 决策十二的口径：
 * 方法名存在与否在单测里查不出来，活体装配才是活证）。
 *
 * 台架里**没有 store**：本口不建表、不占号段、不读表（决策十六），能在无库的上下文里跑出五级读数，
 * 这条事实本身就是「它不碰库」的证据之一。全程不出网、不碰真实招聘平台（§7.2）。
 */
import { AppError, asApp, Context, Service, type Fiber } from '@auto-cc/core';
import {
  FUNNEL_LEVELS,
  QUOTA_ACTIONS,
  type FunnelLevel,
  type FunnelLevelView,
  type FunnelRange,
  type GateDecisionView,
  type GateQuotaView,
  type QuotaAction,
} from '@auto-cc/shared';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FunnelQueryService } from './funnel.js';

/** 拆卸清单（每个用例一套装配，跑完即拆）。 */
const opened: { dispose(): Promise<unknown> }[] = [];

afterEach(async () => {
  while (opened.length) await opened.pop()?.dispose();
});

/** 归属替身共用的空配置（与真实服务里那些无配置项的口同形）。 */
const EMPTY_CONFIG = z.strictObject({});

/**
 * 替身各家的固定读数。
 *
 * 用例断言时引用这一份而不是再写一遍数字：同一件事的第二个来源就是 `AGENTS.md` §2.5 要合并掉的东西，
 * 改一处而漏一处会让用例在替身上自证，而不是在代码上判据。
 */
const SEED = {
  captured: 12,
  greet: 7,
  repliedJobs: 3,
  deliveries: 2,
  todayUsed: { search: 5, greet: 7, deliver: 2 } as Record<QuotaAction, number>,
  limits: { search: 40, greet: 20, deliver: 10 } as Record<QuotaAction, number>,
};

/** 一次查询用的区间（一周，含头不含尾）。 */
const RANGE: FunnelRange = { fromMs: 1_700_000_000_000, toMs: 1_700_604_800_000 };

/** 「今日」的判定基准（落在上面那段区间里，用例据此核对两处读的是同一个数）。 */
const NOW_MS = 1_700_302_400_000;

/** `jd.store.countCaptured()` 的替身：记下每次问它的区间，返回 `captured`。 */
class FakeJdStoreService extends Service {
  static provide = 'jd.store';
  static Config = EMPTY_CONFIG;

  readonly ranges: FunnelRange[] = [];
  captured = 0;

  constructor(ctx: Context, _options: z.output<typeof EMPTY_CONFIG>) {
    super(ctx, 'jd.store');
  }

  /**
   * 按区间数抓到的岗位条数。
   * @param range 半开区间毫秒（替身不解释它，只原样记下）
   * @returns `captured`
   */
  countCaptured(range: FunnelRange): number {
    this.ranges.push(range);
    return this.captured;
  }
}

/** `usage.ledger` 里本口要的那两只手的替身（区间数与今日数同一张表、同一个主人）。 */
class FakeLedgerService extends Service {
  static provide = 'usage.ledger';
  static Config = EMPTY_CONFIG;

  readonly ranges: FunnelRange[] = [];
  readonly countCalls: { action: string }[] = [];
  readonly todaySeen: number[] = [];
  actionCounts: Record<string, number> = {};
  todayCounts: Record<string, number> = {};

  constructor(ctx: Context, _options: z.output<typeof EMPTY_CONFIG>) {
    super(ctx, 'usage.ledger');
  }

  /**
   * 按动作与区间数落账条数。
   * @param action 动作名（本口只问 `greet`）
   * @param range 半开区间毫秒
   * @returns 表里那个动作的数，没设过则为 0
   */
  countAction(action: string, range: FunnelRange): number {
    this.ranges.push(range);
    this.countCalls.push({ action });
    return this.actionCounts[action] ?? 0;
  }

  /**
   * 按动作数「本地今日」的落账条数。
   * @param action 动作名
   * @param nowMs 今日判定基准毫秒（本口传下去的那一个，用例据此核对两读同源）
   * @returns 表里那个动作的数，没设过则为 0
   */
  countToday(action: string, nowMs: number): number {
    this.todaySeen.push(nowMs);
    return this.todayCounts[action] ?? 0;
  }
}

/** `conversation.store.repliedJobCount()` 的替身。 */
class FakeConversationService extends Service {
  static provide = 'conversation.store';
  static Config = EMPTY_CONFIG;

  readonly ranges: FunnelRange[] = [];
  repliedJobs = 0;

  constructor(ctx: Context, _options: z.output<typeof EMPTY_CONFIG>) {
    super(ctx, 'conversation.store');
  }

  /**
   * 按区间数「招聘方回过话的岗位数」。
   * @param range 半开区间毫秒
   * @returns `repliedJobs`
   */
  repliedJobCount(range: FunnelRange): number {
    this.ranges.push(range);
    return this.repliedJobs;
  }
}

/** `outbound.deliveries.count()` 的替身。 */
class FakeDeliveryService extends Service {
  static provide = 'outbound.deliveries';
  static Config = EMPTY_CONFIG;

  readonly ranges: FunnelRange[] = [];
  deliveries = 0;

  constructor(ctx: Context, _options: z.output<typeof EMPTY_CONFIG>) {
    super(ctx, 'outbound.deliveries');
  }

  /**
   * 按区间数投递成功记录条数。
   * @param range 半开区间毫秒
   * @returns `deliveries`
   */
  count(range: FunnelRange): number {
    this.ranges.push(range);
    return this.deliveries;
  }
}

/**
 * `entitlement.gate` 的替身：`quota()` 给配置那一面，`check()` 按「已用 vs 上限」给判定。
 *
 * `remaining` 故意与真闸门一样夹在 0——spec 5.8-03 要验的正是看板**不**用「已用 + 剩余」反推上限，
 * 所以这里必须能演「用光甚至超过上限」那一档。
 */
class FakeGateService extends Service {
  static provide = 'entitlement.gate';
  static Config = EMPTY_CONFIG;

  readonly checkSeen: (number | undefined)[] = [];
  mode: GateQuotaView['mode'] = 'daily';
  limits: Record<QuotaAction, number> = { ...SEED.limits };
  used: Record<QuotaAction, number> = { ...SEED.todayUsed };

  constructor(ctx: Context, _options: z.output<typeof EMPTY_CONFIG>) {
    super(ctx, 'entitlement.gate');
  }

  /**
   * 读额度的静态那一面（模式 + 按动作日上限）。
   * @returns 替身字段的一份拷贝（与真闸门的 `quota()` 同形：给读数，不给可变引用）
   */
  quota(): GateQuotaView {
    return { mode: this.mode, dailyLimits: { ...this.limits } };
  }

  /**
   * 判一次「此刻还能不能做」。
   * @param action 额度动作名
   * @param context 判定基准；`nowMs` 只被记下来用于「两读同源」断言
   * @returns `unlimited` 给无限剩余，`daily` 给夹在 0 的剩余（与真闸门同口径）
   */
  check(action: QuotaAction, context: { nowMs?: number } = {}): GateDecisionView {
    this.checkSeen.push(context.nowMs);
    if (this.mode === 'unlimited') return { allowed: true, remaining: null, reason: null };
    const remaining = Math.max(0, this.limits[action] - this.used[action]);
    return { allowed: remaining > 0, remaining, reason: remaining > 0 ? null : '模拟：今天的量用完了' };
  }
}

/** 台架要装的五只替身及其服务名（`without` 就是「摘掉这一行装配」）。 */
const OWNERS = [
  ['jd.store', FakeJdStoreService],
  ['usage.ledger', FakeLedgerService],
  ['conversation.store', FakeConversationService],
  ['outbound.deliveries', FakeDeliveryService],
  ['entitlement.gate', FakeGateService],
] as const;

/**
 * 装一套「真聚合口 + 结构替身」，并给替身喂上 `SEED` 里的数。
 *
 * 刻意不装 `store.db`：本口不该需要库才能出读数（spec 5.8-02），装了就看不出它有没有偷偷开连接。
 * @param without 摘掉哪些服务的装配（服务名数组，用来演「此刻没挂载」那一支）
 * @returns 聚合口句柄与替身实例表（按服务名取，缺席即 undefined）
 */
async function bootMetrics(without: readonly string[] = []): Promise<{
  funnel: FunnelQueryService;
  owners: Map<string, Service>;
}> {
  const ctx = new Context();
  const owners = new Map<string, Service>();
  const fibers: Fiber[] = [];
  for (const [name, plugin] of OWNERS) {
    if (without.includes(name)) continue;
    const fiber = ctx.plugin(plugin, {});
    await fiber;
    fibers.push(fiber);
    owners.set(name, ctx.get(name));
  }
  const funnelFiber = ctx.plugin(FunnelQueryService, {});
  await funnelFiber;
  opened.push(funnelFiber, ...fibers.reverse());
  seedOwners(owners);
  return { funnel: asApp(ctx).funnel, owners };
}

/**
 * 给在座的替身喂 `SEED` 里的数（缺哪一只就跳过哪只，配合 `without` 演「没挂载」）。
 * @param owners 服务名 → 替身实例
 */
function seedOwners(owners: Map<string, Service>): void {
  const jd = owners.get('jd.store') as FakeJdStoreService | undefined;
  if (jd) jd.captured = SEED.captured;
  const ledger = owners.get('usage.ledger') as FakeLedgerService | undefined;
  if (ledger) {
    ledger.actionCounts = { greet: SEED.greet };
    ledger.todayCounts = { ...SEED.todayUsed };
  }
  const conversation = owners.get('conversation.store') as FakeConversationService | undefined;
  if (conversation) conversation.repliedJobs = SEED.repliedJobs;
  const deliveries = owners.get('outbound.deliveries') as FakeDeliveryService | undefined;
  if (deliveries) deliveries.deliveries = SEED.deliveries;
}

/**
 * 按级别名取那一条读数（用例都按名字点，不按下标——五级的顺序本身是一条断言，单独测它）。
 * @param levels 一次聚合给出的五级
 * @param level 级别名
 * @returns 那一条读数
 * @throws 用例点了一个不存在的级别名时直接炸，不让它静默拿到 undefined 后在下一行报个不相干的错
 */
function levelOf(levels: FunnelLevelView[], level: FunnelLevel): FunnelLevelView {
  const found = levels.find((item) => item.level === level);
  if (!found) throw new Error(`用例点了一个不存在的级别名：${level}`);
  return found;
}

/**
 * 「今日已用」同时写到账本替身与闸门替身上。
 *
 * 真服务里两边读的是同一张表的同一个日界，替身也必须同步——否则用例判的是替身自己的不一致。
 * @param owners 替身表
 * @param action 额度动作名
 * @param used 今日已用条数
 */
function setTodayUsed(owners: Map<string, Service>, action: QuotaAction, used: number): void {
  const ledger = owners.get('usage.ledger') as FakeLedgerService | undefined;
  if (ledger) ledger.todayCounts[action] = used;
  const gate = owners.get('entitlement.gate') as FakeGateService | undefined;
  if (gate) gate.used[action] = used;
}

describe('五级读数的形状与归属（spec 5.8-01）', () => {
  it('五级按漏斗顺序各给一条，前四级是真数、第五级给那句无源原话', async () => {
    const { funnel } = await bootMetrics();
    const view = funnel.query(RANGE, { nowMs: NOW_MS });
    expect(view.levels.map((item) => item.level)).toEqual([...FUNNEL_LEVELS]);
    expect(levelOf(view.levels, 'search')).toEqual({ level: 'search', count: SEED.captured, unavailableReason: null });
    expect(levelOf(view.levels, 'greet')).toEqual({ level: 'greet', count: SEED.greet, unavailableReason: null });
    expect(levelOf(view.levels, 'reply')).toEqual({ level: 'reply', count: SEED.repliedJobs, unavailableReason: null });
    expect(levelOf(view.levels, 'deliver')).toEqual({
      level: 'deliver',
      count: SEED.deliveries,
      unavailableReason: null,
    });
    const interview = levelOf(view.levels, 'interview');
    // 决策十五：这一级没有可数的东西，说清「不是 0」比给一个 0 有用——它挡的是「漏斗末端零转化」这个假象。
    expect(interview.count).toBeNull();
    expect(interview.unavailableReason).toContain('没有面试字段');
    expect(interview.unavailableReason).toContain('不是 0');
  });

  it('每一级要么有数要么有原因，两者必有其一且只有一', async () => {
    const full = await bootMetrics();
    const views = [full.funnel.query(RANGE, { nowMs: NOW_MS })];
    // 逐只摘掉归属服务再各查一遍：这条性质在「有腿被摘」的装配上更要紧。
    for (const name of ['jd.store', 'usage.ledger', 'conversation.store', 'outbound.deliveries']) {
      const { funnel } = await bootMetrics([name]);
      views.push(funnel.query(RANGE, { nowMs: NOW_MS }));
    }
    for (const view of views) {
      for (const item of view.levels) {
        expect(item.count === null).toBe(item.unavailableReason !== null);
      }
    }
  });

  it('区间含头不含尾且原样透传——四只归属服务收到的就是这次进来的那一对', async () => {
    const { funnel, owners } = await bootMetrics();
    const view = funnel.query(RANGE, { nowMs: NOW_MS });
    expect(view.range).toEqual(RANGE);
    const ledger = owners.get('usage.ledger') as FakeLedgerService;
    expect((owners.get('jd.store') as FakeJdStoreService).ranges).toEqual([RANGE]);
    expect((owners.get('conversation.store') as FakeConversationService).ranges).toEqual([RANGE]);
    expect((owners.get('outbound.deliveries') as FakeDeliveryService).ranges).toEqual([RANGE]);
    expect(ledger.ranges).toEqual([RANGE]);
    // 打招呼那一级走账本：本口只问 `greet`，不去数别的动作（口径归账本的主人，不在这里发明）。
    expect(ledger.countCalls).toEqual([{ action: 'greet' }]);
  });

  it('归属服务此刻没挂载时只影响那一级，别处照旧有数（不整块失败）', async () => {
    const cases: { removed: string; affected: FunnelLevel }[] = [
      { removed: 'jd.store', affected: 'search' },
      { removed: 'usage.ledger', affected: 'greet' },
      { removed: 'conversation.store', affected: 'reply' },
      { removed: 'outbound.deliveries', affected: 'deliver' },
    ];
    for (const { removed, affected } of cases) {
      const { funnel } = await bootMetrics([removed]);
      const view = funnel.query(RANGE, { nowMs: NOW_MS });
      const missing = levelOf(view.levels, affected);
      expect(missing.count).toBeNull();
      expect(missing.unavailableReason).toContain(removed);
      const counted = view.levels.filter((item) => item.level !== affected && item.level !== 'interview');
      expect(counted).toHaveLength(3);
      for (const item of counted) expect(item.count).not.toBeNull();
    }
  });
});

describe('额度那一块（spec 5.8-03）', () => {
  it('三条动作各一行，上限取自闸门配置而不是「已用 + 剩余」', async () => {
    const { funnel } = await bootMetrics();
    const quota = funnel.query(RANGE, { nowMs: NOW_MS }).quota;
    expect(quota.mode).toBe('daily');
    expect(quota.actions.map((item) => item.action)).toEqual([...QUOTA_ACTIONS]);
    for (const item of quota.actions) {
      expect(item.usedToday).toBe(SEED.todayUsed[item.action]);
      expect(item.dailyLimit).toBe(SEED.limits[item.action]);
      expect(item.remaining).toBe(SEED.limits[item.action] - SEED.todayUsed[item.action]);
    }
  });

  it('量用光那一档仍显示配置里的上限——那条加法在超限时算不出上限', async () => {
    const { funnel, owners } = await bootMetrics();
    // 25 > 20 是「白天把上限调小过」的真实可能：闸门夹在 0，若看板反推就会显示「上限 25」。
    setTodayUsed(owners, 'greet', SEED.limits.greet + 5);
    const row = funnel.query(RANGE, { nowMs: NOW_MS }).quota.actions.find((item) => item.action === 'greet');
    expect(row).toMatchObject({ usedToday: SEED.limits.greet + 5, dailyLimit: SEED.limits.greet, remaining: 0 });
  });

  it('闸门没挂载时额度整块给 null，但今日已用仍从账本来', async () => {
    const { funnel } = await bootMetrics(['entitlement.gate']);
    const quota = funnel.query(RANGE, { nowMs: NOW_MS }).quota;
    // 「没装闸门」与「额度用光了」在屏幕上必须长得不一样，所以这里是 null 而不是三个 0。
    expect(quota.mode).toBeNull();
    for (const item of quota.actions) {
      expect(item.dailyLimit).toBeNull();
      expect(item.remaining).toBeNull();
      expect(item.usedToday).toBe(SEED.todayUsed[item.action]);
    }
  });

  it('账本没挂载时今日已用为 null，模式与上限那两侧照给', async () => {
    const { funnel } = await bootMetrics(['usage.ledger']);
    const view = funnel.query(RANGE, { nowMs: NOW_MS });
    expect(view.quota.mode).toBe('daily');
    for (const item of view.quota.actions) {
      expect(item.usedToday).toBeNull();
      expect(item.dailyLimit).toBe(SEED.limits[item.action]);
    }
    // 同一只缺席在漏斗那一侧的结局：打招呼那一级没有数，也没有一句 0。
    expect(levelOf(view.levels, 'greet')).toMatchObject({ count: null });
  });

  it('`unlimited` 模式下剩余为 null 而上限仍给（界面据此说「当前不设上限」）', async () => {
    const { funnel, owners } = await bootMetrics();
    (owners.get('entitlement.gate') as FakeGateService).mode = 'unlimited';
    const quota = funnel.query(RANGE, { nowMs: NOW_MS }).quota;
    expect(quota.mode).toBe('unlimited');
    for (const item of quota.actions) {
      expect(item.remaining).toBeNull();
      expect(item.dailyLimit).toBe(SEED.limits[item.action]);
    }
  });

  it('同一个 `nowMs` 同时喂给闸门与账本，不出跨零点的两读', async () => {
    const { funnel, owners } = await bootMetrics();
    funnel.query(RANGE, { nowMs: NOW_MS });
    const ledger = owners.get('usage.ledger') as FakeLedgerService;
    const gate = owners.get('entitlement.gate') as FakeGateService;
    // 三条动作各问一次今日已用与一次剩余，两边收到的是同一个数：跨零点时不会出现「已用算昨天、剩余算今天」。
    expect(ledger.todaySeen).toEqual(new Array(QUOTA_ACTIONS.length).fill(NOW_MS));
    expect(gate.checkSeen).toEqual(new Array(QUOTA_ACTIONS.length).fill(NOW_MS));
  });
});

describe('入参校验与只读性（spec 5.8-04 / 5.8-02 的服务半边）', () => {
  it('非法区间结构化失败，且一次归属服务都不问（坏入参零副作用）', async () => {
    const { funnel, owners } = await bootMetrics();
    const badRanges: FunnelRange[] = [
      { fromMs: Number.NaN, toMs: RANGE.toMs },
      { fromMs: RANGE.fromMs, toMs: Number.POSITIVE_INFINITY },
      { fromMs: 1_700_000_000_000.5, toMs: RANGE.toMs },
      { fromMs: RANGE.toMs, toMs: RANGE.fromMs },
      { fromMs: RANGE.fromMs, toMs: RANGE.fromMs },
    ];
    for (const bad of badRanges) {
      let caught: unknown;
      try {
        funnel.query(bad);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect(caught).toMatchObject({ code: 'FUNNEL_RANGE_INVALID', path: 'funnel.query' });
    }
    expect(owners.get('jd.store') as FakeJdStoreService).toMatchObject({ ranges: [] });
    expect(owners.get('usage.ledger') as FakeLedgerService).toMatchObject({ ranges: [], countCalls: [] });
    expect(owners.get('conversation.store') as FakeConversationService).toMatchObject({ ranges: [] });
    expect(owners.get('outbound.deliveries') as FakeDeliveryService).toMatchObject({ ranges: [] });
    expect(owners.get('entitlement.gate') as FakeGateService).toMatchObject({ checkSeen: [] });
  });

  it('本口不写一行 SQL、不碰库、不声明依赖（只读聚合的结构证据）', async () => {
    // 剔掉注释再查：头注释里写着「自己不写一行 SQL」，那是说明不是代码。
    const source = readFileSync(fileURLToPath(new URL('./funnel.ts', import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/SELECT|INSERT|UPDATE|DELETE|prepare\(|\bmigrations\b|upgrade\(/i);
    expect(source).not.toContain('node:sqlite');
    expect(source).not.toMatch(/plugin-(store|outbound|platform|entitlement|resume|kb|browser)/);
    // 没有 `inject`：摘掉任何一条能力腿都不会把本服务一起带进 PENDING（决策十六的装配取向）。
    expect((FunnelQueryService as unknown as { inject?: unknown }).inject).toBeUndefined();
    // 台架里根本没有 store 插件，五级读数照样出得来——它不碰库不是承诺而是事实。
    const { funnel } = await bootMetrics();
    expect(funnel.query(RANGE, { nowMs: NOW_MS }).levels).toHaveLength(FUNNEL_LEVELS.length);
  });

  it('给了耗时读数：同一次聚合的真实代价随读数一起出去（spec 5.8-05 要读的就是这一位）', async () => {
    const { funnel } = await bootMetrics();
    const view = funnel.query(RANGE, { nowMs: NOW_MS });
    expect(Number.isFinite(view.tookMs)).toBe(true);
    expect(view.tookMs).toBeGreaterThanOrEqual(0);
  });
});
