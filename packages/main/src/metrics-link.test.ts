/**
 * `funnel.query` 的**真装配**判定（spec 5.8-01 / 02 / 04 的接线半边，plan §7.6.3 的 5.8-a）。
 *
 * 与 `evidence-link.test.ts` 同一条理由住在 `packages/main`：`agent` 包按 §4.1 / 5.1-08 不许 import
 * 能力包，所以聚合那侧的四只归属手只能按**结构接口**取（`JdCountReader` / `LedgerCountReader` /
 * `RepliedCountReader` / `DeliveryCountReader`）。于是「真服务到底提不提供 `countCaptured` /
 * `countAction` / `repliedJobCount` / `count` 这四只手、名字有没有拼错、区间口径对不对得上」
 * 在包内**编译期查不出来**（决策十二：方法名存在与否正则与原型都查不出来，活体装配才是活证）。
 * 装配本体在 `metrics-assembly.ts`（5.8-c 的万级计时判定用的是同一套装配，§2.2 不抄第二份），
 * 本文件负责的是「写几条行内行外的数、数出来对不对」。
 *
 * 三条判定各守一种只在真装配里才会出现的失效：
 * 1. **五级从真库数得出**：岗位、打招呼、回话岗位、投递各写进行内与行外的数据，
 *    数出来的只有行内那些——半开区间在替身上测的是形状，在这里测的是真列名与真时刻。
 * 2. **额度块读的是真闸门**：上限来自它的配置侧、今日已用来自真账本，两处在同一份装配里对齐。
 * 3. **摘掉一条能力腿只影响那一级**：本服务没有 `inject`，所以装配面板单个摘包时
 *    给的是那句「此刻没有挂载」，而不是整只服务降为 PENDING 或一片 0。
 *
 * `funnel.query` 进渲染层白名单、界面把这张读数画出来是 5.8-b 的事（V 类，见切片表），
 * 所以本文件只断言网关**切得动**这条路径，不断言它在白名单里。
 * 语料全是虚构中文，全程零出网、不碰真实招聘平台（AGENTS.md §7.2）。
 */
import { FunnelQueryService } from '@auto-cc/plugin-agent';
import { DEFAULT_DAILY_LIMITS } from '@auto-cc/plugin-entitlement';
import { resolveCall } from '@auto-cc/plugin-ipc';
import {
  FUNNEL_LEVELS,
  isAllowedCall,
  RENDERER_ALLOWLIST,
  startOfDay,
  type FunnelRange,
  type QuotaAction,
} from '@auto-cc/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { bootFunnelAssembly, jobSeed, type FunnelAssembly } from './metrics-assembly.js';

/** 判定基准：本机时区中午十二点，保证「今日」的日界与它同一天（跨时区也不会漂到前一天）。 */
const AS_OF_MS = new Date(2026, 9, 15, 12).getTime();
const DAY_MS = 86_400_000;

/** 看板窗口：往前两天、往后一天，基准时刻落在里面。 */
const WINDOW: FunnelRange = { fromMs: AS_OF_MS - 2 * DAY_MS, toMs: AS_OF_MS + DAY_MS };

/** 窗口外的时刻（三日之前，`fromMs` 之下）：每条腿各写一条，用来证明区间真的在挡行。 */
const BEFORE_WINDOW = AS_OF_MS - 3 * DAY_MS;

const assemblies: FunnelAssembly[] = [];

/**
 * 装配一份真库并把行内与行外的数据写进去。
 *
 * 写一律走各服务的**公开写入口**，不手搓 SQL：手搓会把「服务真认得这一行」判成假。
 * @param options.without 摘掉哪些服务的装配（服务名数组），用来演「那条能力腿没装」的现场
 * @returns 上下文、应用句柄、聚合口句柄（本装配写进去的各条腿的期望数见下面各用例的字面量）
 */
async function bootMetricsAssembly(options: { without?: string[] } = {}) {
  const without = new Set(options.without ?? []);
  const assembly = await bootFunnelAssembly({ without, prefix: 'auto-cc-metrics-link-' });
  assemblies.push(assembly);
  const { app } = assembly;
  /** 装某一类时先问它被没被摘掉，被摘掉的连数据也不写（写不了）。 */
  const mounted = (name: string): boolean => !without.has(name);

  // 行内两条 + 行外一条：区间真的在挡行，而不是数了整张表。
  if (mounted('jd.store')) {
    app['jd.store'].upsert(jobSeed('j-1', AS_OF_MS - DAY_MS));
    app['jd.store'].upsert(jobSeed('j-2', AS_OF_MS));
    app['jd.store'].upsert(jobSeed('j-3', BEFORE_WINDOW));
  }
  if (mounted('usage.ledger')) {
    app['usage.ledger'].record({ action: 'greet', targetId: 'boss/j-1', nowMs: AS_OF_MS });
    app['usage.ledger'].record({ action: 'greet', targetId: 'boss/j-2', nowMs: AS_OF_MS });
    app['usage.ledger'].record({ action: 'greet', targetId: 'boss/j-4', nowMs: AS_OF_MS - DAY_MS });
    app['usage.ledger'].record({ action: 'greet', targetId: 'boss/j-3', nowMs: BEFORE_WINDOW });
  }
  if (mounted('conversation.store')) {
    const conversation = app['conversation.store'];
    conversation.record({
      platform: 'boss',
      jobId: 'j-1',
      conversationTarget: null,
      from: 'recruiter',
      text: '方便聊聊',
      externalId: 'r-1',
      at: AS_OF_MS,
    });
    // 同一岗位的第二条回话不重计：这一级数的是岗位，与「打招呼数」同量纲才能看出转化。
    conversation.record({
      platform: 'boss',
      jobId: 'j-1',
      conversationTarget: null,
      from: 'recruiter',
      text: '我们在上海',
      externalId: 'r-2',
      at: AS_OF_MS,
    });
    conversation.record({
      platform: 'boss',
      jobId: 'j-2',
      conversationTarget: null,
      from: 'recruiter',
      text: '发份简历看看',
      externalId: 'r-3',
      at: AS_OF_MS - DAY_MS,
    });
    conversation.record({
      platform: 'boss',
      jobId: 'j-3',
      conversationTarget: null,
      from: 'recruiter',
      text: '窗口外的那条',
      externalId: 'r-4',
      at: BEFORE_WINDOW,
    });
    conversation.record({
      platform: 'boss',
      jobId: 'j-9',
      conversationTarget: null,
      from: 'self',
      text: '自己发出去的不算回复',
      externalId: 'r-5',
      at: AS_OF_MS,
    });
  }
  if (mounted('outbound.deliveries')) {
    app['outbound.deliveries'].record({
      ledgerId: 1,
      platform: 'boss',
      jobId: 'j-1',
      conversationTarget: null,
      snapshotId: 'snap-1',
      ts: AS_OF_MS,
    });
    app['outbound.deliveries'].record({
      ledgerId: 2,
      platform: 'boss',
      jobId: 'j-2',
      conversationTarget: null,
      snapshotId: 'snap-1',
      ts: AS_OF_MS - DAY_MS,
    });
    app['outbound.deliveries'].record({
      ledgerId: 3,
      platform: 'boss',
      jobId: 'j-3',
      conversationTarget: null,
      snapshotId: 'snap-1',
      ts: BEFORE_WINDOW,
    });
  }
  return { ctx: assembly.ctx, app, funnel: app.funnel };
}

afterAll(async () => {
  for (const assembly of assemblies) await assembly.dispose();
});

describe('5.8-01 五级从真库数得出', () => {
  it('四只手在真服务上都在，且区间口径数得出行内条数', async () => {
    const { app } = await bootMetricsAssembly();
    // 编译期这一行就查得出方法名（不存在即 TS 报错），运行期这一行查的是列名与时刻口径。
    expect(app['jd.store'].countCaptured(WINDOW)).toBe(2);
    expect(app['usage.ledger'].countAction('greet', WINDOW)).toBe(3);
    expect(app['conversation.store'].repliedJobCount(WINDOW)).toBe(2);
    expect(app['outbound.deliveries'].count(WINDOW)).toBe(2);
    // 今日只算基准时刻那两条，昨日与窗口外的都不进这一档。
    expect(app['usage.ledger'].countToday('greet', AS_OF_MS)).toBe(2);
    expect(
      app['usage.ledger'].countAction('greet', { fromMs: startOfDay(AS_OF_MS), toMs: Number.MAX_SAFE_INTEGER }),
    ).toBe(app['usage.ledger'].countToday('greet', AS_OF_MS));
  });

  it('聚合口在真装配里给出五级：四个真数 + 面试级那句无源原话', async () => {
    const { funnel } = await bootMetricsAssembly();
    const view = funnel.query(WINDOW, { nowMs: AS_OF_MS });
    expect(view.levels.map((item) => item.level)).toEqual([...FUNNEL_LEVELS]);
    expect(view.levels.map((item) => item.count)).toEqual([2, 3, 2, 2, null]);
    expect(view.levels[4]?.unavailableReason).toContain('没有面试字段');
    // 读数必须是纯数据：它要过 IPC 的结构化克隆，带函数或不可克隆成员的形状到进程边界才丢。
    expect(structuredClone(view)).toEqual(view);
  });

  it('额度块在真闸门下对得上：上限来自配置、今日已用来自真账本、剩余来自判定', async () => {
    const { funnel } = await bootMetricsAssembly();
    const quota = funnel.query(WINDOW, { nowMs: AS_OF_MS }).quota;
    expect(quota.mode).toBe('daily');
    const byAction = new Map(quota.actions.map((item) => [item.action, item]));
    for (const action of ['search', 'greet', 'deliver'] as QuotaAction[]) {
      expect(byAction.get(action)?.dailyLimit).toBe(DEFAULT_DAILY_LIMITS[action]);
    }
    expect(byAction.get('greet')).toMatchObject({ usedToday: 2, dailyLimit: DEFAULT_DAILY_LIMITS.greet });
    expect(byAction.get('greet')?.remaining).toBe(DEFAULT_DAILY_LIMITS.greet - 2);
  });
});

describe('5.8-02 装配面：摘腿与挂载', () => {
  it('摘掉会话库只让「回过话」那一级给原因，其余三级照旧是真数', async () => {
    const { funnel } = await bootMetricsAssembly({ without: ['conversation.store'] });
    const view = funnel.query(WINDOW, { nowMs: AS_OF_MS });
    const reply = view.levels.find((item) => item.level === 'reply');
    expect(reply).toMatchObject({ count: null });
    expect(reply?.unavailableReason).toContain('conversation.store');
    expect(view.levels.filter((item) => item.count !== null).map((item) => item.count)).toEqual([2, 3, 2]);
    // 摘掉别的包不该把本服务一起带进 PENDING：没有 `inject`，所以它自己仍然装得上、答得出。
    expect((FunnelQueryService as unknown as { inject?: unknown }).inject).toBeUndefined();
  });

  it('清单与装配都认得这一只：注册表把它接到 `funnel`，`cordis.yml` 挂了它', () => {
    // 注册表读源文本而不是 import 进来：`registry.ts` 连带 import `@auto-cc/shell`，而那个模块在
    // 模块顶层读 `app.isPackaged`——纯 Node 测试宿主里 `electron` 导出的是二进制路径字符串，一装就崩。
    // 装配面的另一半读装配文件本体（同 `deliver.test.ts` 里「规则只存在于测试里」那条的先例）。
    const registrySource = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'registry.ts'), 'utf8');
    expect(registrySource).toMatch(/^ {2}funnel: FunnelQueryService,$/m);
    // 只写注册表不进清单，app 启动时同样不会装它——所以两条都要有。
    const cordisYml = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '../../../cordis.yml'), 'utf8');
    expect(cordisYml).toMatch(/\n {2}- id: funnel\n/);
  });
});

describe('5.8-04 网关切得动这条路径（白名单与界面在 5.8-b）', () => {
  it('`funnel.query` 切成服务 `funnel` + 方法 `query` 并调得通', async () => {
    const { ctx, funnel } = await bootMetricsAssembly();
    const resolution = resolveCall('funnel.query', (name) => {
      try {
        return ctx.get(name) as object;
      } catch {
        return undefined;
      }
    });
    // 服务名不带点、方法名单段：这条路径正好是计划 §3 表里写的那一条（决策十六的更正记在落地记录）。
    expect(resolution).toMatchObject({ ok: true, service: 'funnel', method: 'query' });
    if (!resolution.ok) throw new Error('分派失败');
    const invoked = resolution.invoke(WINDOW, { nowMs: AS_OF_MS }) as ReturnType<FunnelQueryService['query']>;
    expect(invoked.levels).toEqual(funnel.query(WINDOW, { nowMs: AS_OF_MS }).levels);
  });

  it('真闸门与真账本都在位时，非法区间结构化失败且一条计数都不发', async () => {
    const { app, ctx } = await bootMetricsAssembly();
    let caught: unknown;
    try {
      app.funnel.query({ fromMs: WINDOW.toMs, toMs: WINDOW.fromMs });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'FUNNEL_RANGE_INVALID', path: 'funnel.query' });
    // 坏入参不改状态：本口只读，而这条断言钉的是「校验发生在读数之前」。
    expect(ctx.get('funnel')).toBeInstanceOf(FunnelQueryService);
    expect(app['jd.store'].countCaptured(WINDOW)).toBe(2);
  });

  it('白名单里只有这一条 `funnel.*`，且它正是网关切出来的那一对（5.8-b 的界面口）', () => {
    // preload 按同一条名单生成 `window.autoCC`，所以「网关切得出路径」与「界面调得到」之间
    // 缺的就是登记这一步；这一条把它钉成用例，免得界面写完才发现 403 式的未登记。
    expect(RENDERER_ALLOWLIST.filter((id) => id.startsWith('funnel.'))).toEqual(['funnel.query']);
    expect(isAllowedCall('funnel.query')).toBe(true);
    // 抄错的两种形状必须进不来：带点的方法名（`funnel.query.all`）与整名小写。
    expect(isAllowedCall('funnel.query.all')).toBe(false);
    expect(isAllowedCall('Funnel.query')).toBe(false);
  });
});
