/**
 * `funnel.query` 在**万级记录**下的计时与查询计划判定（spec 5.8-05，plan §7.6.3 的 5.8-c）。
 *
 * 这条判据要拦的失效不是"数字算错"（那是 5.8-01 的 `metrics-link.test.ts`），而是
 * **看板把主进程拖死**：用户跑一个月，岗位库上万行是常态，而打开诊断页看漏斗是一个
 * 随时会做的动作。如果那四条计数里有一条长成全表扫，症状是"一点看板整个 app 卡住"，
 * 且**在小库上永远测不出来**——所以必须灌到万级再测，且必须看查询计划。
 *
 * 三条独立证据，各钉一件事：
 * 1. **一万行真的进库了**：四张表按 `COUNT(*)` 逐张数，四腿之和等于灌入总数；
 *    少了这一条，"计时很快"就只是"表是空的"。
 * 2. **聚合口的读数与灌数时的逐行点数一致**：期望值由灌数循环自己累加（与 SQL 无关的第二条路），
 *    所以这里对平的是"区间口径 + 时刻列 + 去重键"三件事，而不只是"没报错"。
 * 3. **四条计数都走时间索引**：对每条 SQL 取 `EXPLAIN QUERY PLAN`，要求出现 `SEARCH` 与那四条索引的名字，
 *    出现 `SCAN`（逐行过表）即失败。SQL 文本在本文件里是一份副本，
 *    于是同时钉住"生产源码里仍是这条 SQL"（下面 `assertSourceStillUses`），免得测的是一条已经没人走的形状。
 *
 * 计时为什么取中位数而不是单次：Windows 上一次 SQLite 查询会被页面缓存冷热与调度抖动影响，
 * 单样本既可能假绿也可能假红。`FunnelView.tookMs` 是本服务自己的 `performance.now()` 差值
 * （不含 IPC 往返与界面绘制），5.8-05 要的就是"聚合这件事本身的代价"。
 *
 * 装配与写入口与 `metrics-link.test.ts` 同一份（`metrics-assembly.ts`，§2.2），
 * 一万条逐条自动提交会把时间全花在 fsync 上、测不到聚合，所以灌数区间套一层显式事务——
 * **写仍然走各服务的公开方法**，只有事务边界在外面。语料全是虚构中文，零出网（§7.2）。
 */
import type { AppContext } from '@auto-cc/core';
import { type QuotaAction } from '@auto-cc/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootFunnelAssembly, jobSeed, type FunnelAssembly } from './metrics-assembly.js';

/** 灌入总数（判据原文的"万级"取 10 000 行，四腿相加正好落在这一位数上）。 */
const SCALE_TOTAL_ROWS = 10_000;

/** 四腿各灌多少行：岗位库最重（真实使用里抓一轮就是几百条），投递最轻。 */
const LEG_ROWS = { jobs: 4000, ledger: 3000, conversation: 2000, delivery: 1000 };

const DAY_MS = 86_400_000;

/** 数据铺开的跨度（天）：30 天比看板最宽的预设档（近 30 天）还宽一天，保证"整段区间"也在测范围内。 */
const SPAN_DAYS = 30;

/** 看板预设档之一（天），与渲染层的 `7d` 同口径；日界由发起方算（决策十七）。 */
const WINDOW_DAYS = 7;

/** 计时重复次数：取中位数与最大值，避免单样本被 Windows 的调度抖动带偏。 */
const TIMING_REPEATS = 5;

/**
 * 计时预算（毫秒），由本机实测标定后写死，不是"看着像个阈值"。
 *
 * 实测（一万行，见 `docs/acceptance/5.8/5.8-05-scale-timing.md`）：近 7 天窗口 `tookMs` 五次全是 1ms，
 * 覆盖全部 31 天的窗口五次全是 2ms。这里把上限放到 **200ms**（实测的两百倍余量）——
 * 判据要拦的是"全表扫在数据涨上去之后变成秒级卡顿"，不是把毫秒级读数钉死；
 * 阈值写得太紧会让一台慢机器把一条本来成立的判据跑成假红，而真正的护栏是下面那条查询计划。
 */
const TIMING_BUDGET_MS = 200;

/** 基准时刻：本机时区中午十二点，与 `metrics-link.test.ts` 同一选法（日界不漂到前一天）。 */
const AS_OF_MS = new Date(2026, 9, 15, 12).getTime();

/** 近 7 天窗口：含头不含尾，上界取基准时刻的次日零点，把基准当天整条都算进来。 */
const RECENT_WINDOW = { fromMs: AS_OF_MS - WINDOW_DAYS * DAY_MS, toMs: AS_OF_MS + DAY_MS };

/** 覆盖全部灌入数据的窗口（30 天再加一天）：这一档是"最坏情况"，行数最多。 */
const WHOLE_WINDOW = { fromMs: AS_OF_MS - (SPAN_DAYS + 1) * DAY_MS, toMs: AS_OF_MS + DAY_MS };

/** 灌数时逐行累加出来的期望读数（与 SQL 无关的第二条路，用来对平区间口径）。 */
const expected = { jobs: 0, greet: 0, repliedJobs: 0, deliveries: 0 };

let assembly: FunnelAssembly;
let app: AppContext;

/**
 * 判断某个时刻落不落在给定的半开区间里（灌数时的期望累加与 SQL 各算一遍，两条路对平才叫判据）。
 *
 * 这里刻意按 `>= fromMs` / `< toMs` 写：基准时刻取的是中午、行又铺在整天的格子上，
 * 于是 `offset = 7` 那一档正好压在 `fromMs` 这条边界上——含头这一件在万级库上也被真数验证了一次，
 * 而不是只在 5.8-a 的替身上验过形状。
 * @param ts 行自己的时刻毫秒
 * @param range 半开区间（含头不含尾，决策十七）
 * @returns 该行是否落在区间内
 */
function isInWindow(ts: number, range: { fromMs: number; toMs: number }): boolean {
  return ts >= range.fromMs && ts < range.toMs;
}

/**
 * 把一万行从各服务的公开写入口灌进去，并在灌的同时累加期望读数。
 * @returns 无返回值（期望写进 `expected`，行落进 `app.store.db`）
 */
function seedTenThousandRows(): void {
  const db = app.store.db;
  db.exec('BEGIN');
  try {
    for (let index = 0; index < LEG_ROWS.jobs; index += 1) {
      const capturedAt = AS_OF_MS - (index % SPAN_DAYS) * DAY_MS;
      app['jd.store'].upsert(jobSeed(`scale-j-${String(index)}`, capturedAt));
      if (isInWindow(capturedAt, RECENT_WINDOW)) expected.jobs += 1;
    }
    for (let index = 0; index < LEG_ROWS.ledger; index += 1) {
      const at = AS_OF_MS - (index % SPAN_DAYS) * DAY_MS;
      app['usage.ledger'].record({ action: 'greet', targetId: `boss/scale-j-${String(index)}`, nowMs: at });
      if (isInWindow(at, RECENT_WINDOW)) expected.greet += 1;
    }
    for (let index = 0; index < LEG_ROWS.conversation; index += 1) {
      const at = AS_OF_MS - (index % SPAN_DAYS) * DAY_MS;
      app['conversation.store'].record({
        platform: 'boss',
        // 每条消息一个目标岗位：这一级数的是「有多少个岗位被回复过」，去重键在这里必须真的生效。
        jobId: `scale-c-${String(index)}`,
        conversationTarget: null,
        from: 'recruiter',
        text: '方便聊聊',
        externalId: `scale-r-${String(index)}`,
        at,
      });
      if (isInWindow(at, RECENT_WINDOW)) expected.repliedJobs += 1;
    }
    for (let index = 0; index < LEG_ROWS.delivery; index += 1) {
      const at = AS_OF_MS - (index % SPAN_DAYS) * DAY_MS;
      app['outbound.deliveries'].record({
        ledgerId: index + 1,
        platform: 'boss',
        jobId: `scale-d-${String(index)}`,
        snapshotId: 'scale-snap',
        ts: at,
      });
      if (isInWindow(at, RECENT_WINDOW)) expected.deliveries += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 取一条 SQL 的 `EXPLAIN QUERY PLAN` 明细文本。
 * @param sql 待解释的查询（与生产源码里那条同形状，见 `assertSourceStillUses`）
 * @returns 计划行的 `detail` 拼接成的一段文本
 */
function queryPlanDetail(sql: string): string {
  const rows = app.store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as unknown as { detail?: string }[];
  return rows.map((row) => row.detail ?? '').join(' / ');
}

/**
 * 钉住"本文件里这条 SQL 仍然是生产代码在走的那一条"。
 *
 * 查询计划测的是 SQL 形状，而形状抄自服务源码；服务改了形状（加列、换索引、退化成全表）
 * 时，只靠本文件的副本会测出一条"已经没人走的查询很快"。所以逐条比对源码文本
 * （空白折叠后包含），漂移即失败。
 * @param relPath 服务源文件相对本目录的路径
 * @param sql 本文件用于解释计划的那条 SQL
 */
function assertSourceStillUses(relPath: string, sql: string): void {
  const source = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), relPath), 'utf8');
  const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
  expect(normalize(source)).toContain(normalize(sql));
}

beforeAll(async () => {
  assembly = await bootFunnelAssembly({ prefix: 'auto-cc-metrics-scale-' });
  app = assembly.app;
  seedTenThousandRows();
});

afterAll(async () => {
  await assembly?.dispose();
});

describe('5.8-05 万级记录下的计时与不做无界全表扫描', () => {
  it('一万行确实进了四张表（否则"计时很快"只是"表是空的"）', () => {
    const countOf = (table: string): number => {
      const row = app.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number | bigint };
      return Number(row?.n ?? 0);
    };
    const jobs = countOf('jobs');
    const ledger = countOf('usage_ledger');
    const conversation = countOf('conversation_messages');
    const deliveries = countOf('delivery_records');
    expect([jobs, ledger, conversation, deliveries]).toEqual([
      LEG_ROWS.jobs,
      LEG_ROWS.ledger,
      LEG_ROWS.conversation,
      LEG_ROWS.delivery,
    ]);
    expect(jobs + ledger + conversation + deliveries).toBe(SCALE_TOTAL_ROWS);
  });

  it('聚合口在万级库上的五级读数与灌数时的逐行点数逐格一致', () => {
    const view = app.funnel.query(RECENT_WINDOW, { nowMs: AS_OF_MS });
    expect(view.levels.map((level) => level.count)).toEqual([
      expected.jobs,
      expected.greet,
      expected.repliedJobs,
      expected.deliveries,
      null,
    ]);
    // 期望值不是从表里数回来的：区间挡住的那一部分必须真的存在，否则这条对平是空的。
    expect(expected.jobs).toBeLessThan(LEG_ROWS.jobs);
    expect(expected.jobs).toBeGreaterThan(0);
    // 覆盖全部数据的那一档必须数到灌入的每一行（区间口径在两档下都成立，不只是"近 7 天恰好对"）。
    expect(app.funnel.query(WHOLE_WINDOW, { nowMs: AS_OF_MS }).levels.map((level) => level.count)).toEqual([
      LEG_ROWS.jobs,
      LEG_ROWS.ledger,
      LEG_ROWS.conversation,
      LEG_ROWS.delivery,
      null,
    ]);
  });

  it('额度块在万级账本下仍然答得出（`daily` 模式下用光也只是剩余夹到 0，不慢也不抛）', () => {
    const quota = app.funnel.query(RECENT_WINDOW, { nowMs: AS_OF_MS }).quota;
    expect(quota.mode).toBe('daily');
    expect(quota.actions.map((action) => action.action)).toEqual(['search', 'greet', 'deliver']);
    const greet = quota.actions.find((action) => action.action === ('greet' as QuotaAction));
    expect(greet?.usedToday).toBeGreaterThan(0);
    expect(greet?.remaining).toBeGreaterThanOrEqual(0);
  });

  it('`FunnelView.tookMs` 在万级库上有记录且落在预算内（中位数与最大值各一条）', () => {
    const recentSamples: number[] = [];
    const wholeSamples: number[] = [];
    for (let repeat = 0; repeat < TIMING_REPEATS; repeat += 1) {
      recentSamples.push(app.funnel.query(RECENT_WINDOW, { nowMs: AS_OF_MS }).tookMs);
      wholeSamples.push(app.funnel.query(WHOLE_WINDOW, { nowMs: AS_OF_MS }).tookMs);
    }
    const medianOf = (samples: number[]): number => {
      const sorted = [...samples].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
    };
    const recentMedian = medianOf(recentSamples);
    const wholeWorst = Math.max(...wholeSamples);
    // 读数随视图一起出去、界面原样显示（5.8-b 的 `metrics.took`），所以这里判的就是屏上那个数。
    expect(recentMedian).toBeLessThanOrEqual(TIMING_BUDGET_MS);
    expect(wholeWorst).toBeLessThanOrEqual(TIMING_BUDGET_MS);
    console.info(
      `5.8-05 万级计时实测（${String(SCALE_TOTAL_ROWS)} 行）：近 ${String(WINDOW_DAYS)} 天 ` +
        `tookMs=${recentSamples.join('/')}（中位 ${String(recentMedian)}）· ` +
        `整段 ${String(SPAN_DAYS + 1)} 天 tookMs=${wholeSamples.join('/')}（最差 ${String(wholeWorst)}）`,
    );
  });

  it('四条计数 SQL 的查询计划都走时间索引，没有一条是全表扫（SCAN）', () => {
    const shapes = [
      {
        name: 'jd.store.countCaptured',
        source: '../../platform-boss/src/jd-store.ts',
        sql: 'SELECT COUNT(*) AS n FROM jobs WHERE captured_at >= ? AND captured_at < ?',
        index: 'jobs_captured_at',
      },
      {
        name: 'usage.ledger.countAction',
        source: '../../entitlement/src/ledger.ts',
        sql: 'SELECT COUNT(*) AS n FROM usage_ledger WHERE action = ? AND ts >= ? AND ts < ?',
        index: 'usage_ledger_action_ts',
      },
      {
        name: 'conversation.store.repliedJobCount',
        source: '../../platform-boss/src/conversation-store.ts',
        sql: `SELECT COUNT(DISTINCT platform || '|' || job_id || '|' || conversation_target) AS n FROM conversation_messages
              WHERE direction = 'recruiter' AND read_at >= ? AND read_at < ?`,
        index: 'conversation_read_at',
      },
      {
        name: 'outbound.deliveries.count',
        source: '../../outbound/src/delivery-record-store.ts',
        sql: 'SELECT COUNT(*) AS n FROM delivery_records WHERE ts >= ? AND ts < ?',
        index: 'idx_delivery_records_ts',
      },
    ];
    const plans: string[] = [];
    for (const shape of shapes) {
      assertSourceStillUses(shape.source, shape.sql);
      const detail = queryPlanDetail(shape.sql);
      plans.push(`${shape.name}: ${detail}`);
      // `SEARCH` = 按索引定位；`SCAN` = 逐行过表。`USING COVERING INDEX` 是最好的一种
      // （计数只需要索引本身，不回表），所以这里判的是索引名与 SEARCH，不判 "USING INDEX" 这个字面。
      expect(detail, shape.name).toContain('SEARCH');
      expect(detail, shape.name).toContain(shape.index);
      expect(detail, shape.name).not.toContain('SCAN');
    }
    console.info(`5.8-05 查询计划：\n  ${plans.join('\n  ')}`);
  });
});
