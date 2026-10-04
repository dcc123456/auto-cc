/**
 * `funnel.query` 判定的**共用装配**（spec 5.8-01 / 02 / 04 / 05，plan §7.6.3 的 5.8-a 与 5.8-c）。
 *
 * 为什么单独一个文件：同一份「真库 + 四只归属服务 + 真闸门 + 真聚合口」的装配被两个判定共用——
 * `metrics-link.test.ts` 数的是几条精心安排的行（区间真的在挡行），`metrics-scale.test.ts` 数的是
 * 一万行（计时与查询计划）。把装配抄第二份就是 AGENTS.md §2.2 禁止的那件事，
 * 而且两份装配一旦漂移，"计时是在同一套服务上测的"这条前提就不成立了。
 *
 * 装配本身为什么住在 `packages/main`：`agent` 包按 §4.1 / 5.1-08 不许 import 能力包
 * （eslint `AGENT_CAPABILITY` 机检），聚合那侧的四只归属手只能按结构接口取，
 * 于是"真服务到底提不提供这四只手"只能在把两边一起装起来的包里变成运行期事实。
 */
import { asApp, Context, NO_CONFIG, type AppContext, type Fiber } from '@auto-cc/core';
import { FunnelQueryService } from '@auto-cc/plugin-agent';
import { PlatformRegistryService } from '@auto-cc/plugin-browser';
import { ConfigService } from '@auto-cc/plugin-config';
import { DEFAULT_DAILY_LIMITS, EntitlementGateService, UsageLedgerService } from '@auto-cc/plugin-entitlement';
import { DeliveryRecordService } from '@auto-cc/plugin-outbound';
import { ConversationStoreService, JdStoreService } from '@auto-cc/plugin-platform-boss';
import { StoreService } from '@auto-cc/plugin-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 一次装配的句柄：上下文、按服务名取真服务的应用口，以及收尾用的 `dispose`。 */
export interface FunnelAssembly {
  readonly ctx: Context;
  readonly app: AppContext;
  /** 先释放 fiber（关 SQLite 连接）再删目录：Windows 上句柄延迟释放会挡住删除。 */
  dispose(): Promise<void>;
}

/**
 * 造一条来源地址唯一的岗位草稿（幂等键是来源地址 + 标题，不给各自地址会并成一行）。
 * @param jobId 岗位标识
 * @param capturedAt 抓取入库时刻毫秒
 * @returns 交给 `jd.store.upsert` 的入参（语料全是虚构中文，来源地址是保留的不可解析域，§7.2）
 */
export function jobSeed(jobId: string, capturedAt: number) {
  return {
    platform: 'boss',
    jobId,
    title: `前端工程师 ${jobId}`,
    company: '假司',
    salaryText: '20-30K',
    city: '上海',
    experience: '3-5 年',
    education: '本科',
    requirements: ['TypeScript'],
    sourceUrl: `https://fixture.test.invalid/job/${jobId}`,
    capturedAt,
  };
}

/**
 * 撑起「真库 + 四只归属服务 + 真闸门 + 真聚合口」的装配。
 *
 * 只装配、不写数据：写由各判定文件经各服务的**公开写入口**进行（手搓 SQL 会把
 * 「服务真认得这一行」判成假），所以本函数返回的 `app` 就是它们写数的口。
 * @param options.without 摘掉哪些服务的装配（服务名集合，数组或 `Set` 都收：判定时要按名字查，
 *                        调用方手里已经有一份 `Set` 就不必再摊平成数组），用来演「那条能力腿没装」的现场
 * @param options.prefix 临时目录前缀（分开命名便于在测试输出里认出是哪条判定）
 * @returns 装配句柄；调用方负责在收尾时 `await dispose()`
 */
export async function bootFunnelAssembly(
  options: { without?: Iterable<string>; prefix?: string } = {},
): Promise<FunnelAssembly> {
  const without = new Set(options.without ?? []);
  const dir = mkdtempSync(join(tmpdir(), options.prefix ?? 'auto-cc-metrics-'));
  const ctx = new Context();
  const fibers: Fiber[] = [];
  /**
   * 挂一个插件并把 fiber 记进收尾清单（未点名的腿直接跳过）。
   * 传**函数**而不是 fiber：`ctx.plugin(...)` 在实参位置就会真的挂载，
   * 摘腿分支于是变成「只不入清单」，否则测试会拿到一只仍然在装的会话库。
   * @param name 服务名（与 `without` 里写的同一个字符串）
   * @param open 挂载动作（延迟到确认没被摘掉才执行）
   */
  const mount = async (name: string, open: () => Fiber | PromiseLike<Fiber>): Promise<void> => {
    if (without.has(name)) return;
    fibers.push(await open());
  };

  await mount('config', () => ctx.plugin(ConfigService, { appName: 'auto-cc' }));
  await mount('store', () => ctx.plugin(StoreService, { dir, file: 'store.db', journal: 'delete' }));
  await mount('usage.ledger', () => ctx.plugin(UsageLedgerService, {}));
  await mount('entitlement.gate', () =>
    ctx.plugin(EntitlementGateService, { mode: 'daily', dailyLimits: DEFAULT_DAILY_LIMITS }),
  );
  // 会话库要按平台找适配器，注册表是它的依赖；岗位库与它会话库同库时「已回复」才连得上。
  await mount('platform.registry', () => ctx.plugin(PlatformRegistryService, NO_CONFIG));
  await mount('jd.store', () => ctx.plugin(JdStoreService, {}));
  await mount('conversation.store', () => ctx.plugin(ConversationStoreService, { platform: 'boss' }));
  await mount('outbound.deliveries', () => ctx.plugin(DeliveryRecordService, {}));
  await mount('funnel', () => ctx.plugin(FunnelQueryService, {}));

  return {
    ctx,
    app: asApp(ctx),
    dispose: async (): Promise<void> => {
      for (const fiber of fibers) await fiber.dispose();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 清理失败不该把一次通过的验收判成失败。
      }
    },
  };
}
