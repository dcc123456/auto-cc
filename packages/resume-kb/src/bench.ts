/**
 * 千级切片检索基准（spec 4.3-09 的验收工具，plan §4.3-e 实现形状 1）。
 *
 * 它测的是**用户实际等的那个函数**：`kb.profile.search()` 的全链路——分词、FTS5 召回、子串兜底、
 * 应用层 BM25 重算、词面覆盖、排序、视图组装、向量腿短路。4.3-a 那份 spike 读数只覆盖其中**裸 FTS5
 * 一条腿**（2000 行双写 11.1ms、单次查询 0.30～0.61ms），拿它当 4.3-09 的证据等于把没测的那几条腿
 * 当成免费的（plan §4.3-e 候选表第 1 行的否决理由）。
 *
 * 跑法：`pnpm bench:kb`（根脚本，等价于 `pnpm --filter @auto-cc/plugin-resume-kb bench`）。
 * 每次运行开头清掉上一轮的库，所以量级读数永远来自本次灌进去的数据。
 *
 * 语料与查询都是**确定性生成**（按序号做混合进制组合，不用随机数）：换一次运行必须得到同一份库，
 * 否则 P95 复跑不可比——BM25 的 N/df/avgdl 随语料变是它的定义的一部分（4.3-c 已把这条写进文档）。
 *
 * 三条判据同时成立才算过：
 * 1. P95 ≤ `cordis.yml` 里 `bench.kb-search.p95BudgetMs`（超了就 exit 1；阈值在配置里而不在脚本里，
 *    与 4.3-03「代码内无魔法数」同一口径）；
 * 2. 全程 `globalThis.fetch` 零调用（4.3-04 的离线冒烟。比拔网线可复跑，而且证的是"代码根本没用网络"
 *    而不是"恰好没网"——存根做成调用即抛，任何出网都会当场炸而不是被静默吞掉）；
 * 3. 库里的切片数确实到了配置要的量级，且 `kb_chunks` 与倒排行数一致、倒排无孤儿行
 *    ——否则读数来自一个空库或半份库，P95 当然漂亮。
 */
import { asApp, Context } from '@auto-cc/core';
import { ConfigService } from '@auto-cc/plugin-config';
import { LogService } from '@auto-cc/plugin-logger';
import { ResumeDocService } from '@auto-cc/plugin-resume-doc';
import { storeSchema, StoreService } from '@auto-cc/plugin-store';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { KB_ENTITY_KINDS, type KbEntityKind } from './entities.js';
import { kbProfileSchema, KbProfileService } from './profile-service.js';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const manifestPath = path.join(repoRoot, 'cordis.yml');
/** 基准库的落点：被 git 忽略的 `tmp/` 下（AGENTS.md §7.5），产物一律不进仓库。 */
const benchDir = path.join(repoRoot, 'tmp', 'kb-bench');

/** `bench.kb-search` 段的形状；三个键都必填——缺配置就是验收脚本在瞎跑，必须报错而不是取默认值。 */
const benchConfigSchema = z.strictObject({
  /** 灌进库的切片条数（千级判据里的"千级"）。 */
  chunks: z.number().int().min(200).max(50_000),
  /** 采样次数；太小（几十次）会让 P95 退化成最大值。 */
  queries: z.number().int().min(20).max(5000),
  /** P95 预算（毫秒），超出即验收失败。 */
  p95BudgetMs: z.number().int().min(1).max(60_000),
});

/** 混合进制语料词表：六张表的乘积远大于 `chunks`，所以每条序号都落在唯一的组合上（切片之间不重复）。 */
const COMPANIES = ['星桥科技', '沧海数据', '北辰智能', '云枢网络', '长江金服', '昆仑软件', '天润医疗', '极光出行'];
const ROLES = ['后端工程师', '算法工程师', '数据分析师', '全栈工程师', '架构师', '测试工程师', '运维工程师', '实习生'];
const LOADS = ['高并发', '千万级', '跨端', '离线', '实时', '存量', '增量', '混合部署'];
const OBJECTS = ['订单服务', '推荐算法链路', '风控引擎', '日志平台', '发布流水线', '数据仓库', '消息队列', '缓存层'];
const ACTIONS = ['主导', '负责', '参与', '重构', '搭建', '优化'];
const METRICS = [
  'P99 延迟下降 40%',
  '机器成本节省 30%',
  '吞吐提升 3 倍',
  '线上故障率减半',
  '上线周期压缩到 6 小时',
  '用例覆盖率提到 90%',
];
/** 只在部分行尾追加，用来把切片长度拉开——整库平均长度一致会让 BM25 的长度归一那条腿测不出东西。 */
const TAILS = [
  '沉淀了 Java 与 Go 两栈的排查手册',
  '并推动链路追踪与告警口径统一',
  '带教两名实习生完成灰度发布改造',
  '相关方案在部门内做过一次分享',
];

/** 一次基准的延迟读数（原样打到 stdout，归档进 `docs/acceptance/4.3/4.3-09-*.txt`）。 */
interface BenchReport {
  readonly budgetMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

/**
 * 取装配清单里某个插件的 `config` 段（原样返回，交给各自的 schema 去校验）。
 * @param doc `cordis.yml` 解析出的根对象
 * @param id 插件 id（如 `kb-profile`）
 * @returns 该插件的文件层配置
 * @throws 清单里没有该插件时抛错——基准的前提就是"跑的是 app 平时那套装配参数"，缺了就无从谈起
 */
function manifestConfig(doc: unknown, id: string): Record<string, unknown> {
  const plugins = (doc as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) throw new Error(`cordis.yml 没有 plugins 数组：${manifestPath}`);
  const entry = plugins.find((item) => (item as { id?: string }).id === id) as { config?: unknown } | undefined;
  if (entry === undefined) throw new Error(`cordis.yml 的装配清单里没有 ${id} 插件，基准无法复用它的配置`);
  const config = entry.config;
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error(`装配清单里 ${id} 的 config 段不是对象`);
  }
  return config as Record<string, unknown>;
}

/**
 * 按序号做混合进制组合，生成一条确定性的中文简历句式。
 * @param index 序号（0 起）；同序号永远同一句话，这是"P95 可复跑比对"的前提
 * @returns 切片正文（长度随 `TAILS` 的追加条件拉开档次）
 */
function corpusText(index: number): string {
  /**
   * 按下标取一个词。
   * @param list 词表
   * @param place 下标（由混合进制取模得到，本应在表内）
   * @returns 词；越界说明序号与表乘积不匹配（语料生成的 bug），直接炸而不是给空串——
   *          空串会悄悄产出一堆雷同句子，把基准的负载测轻。
   */
  const pick = (list: readonly string[], place: number): string => {
    const word = list[place];
    if (word === undefined) throw new Error(`语料词表下标越界：${String(place)}（序号 ${String(index)}）`);
    return word;
  };
  // 六张表的乘积是 147456，远大于 schema 允许的 `chunks` 上限，所以同序号永远同一句、不同序号不撞句。
  let rest = index;
  const company = pick(COMPANIES, rest % COMPANIES.length);
  rest = Math.floor(rest / COMPANIES.length);
  const role = pick(ROLES, rest % ROLES.length);
  rest = Math.floor(rest / ROLES.length);
  const load = pick(LOADS, rest % LOADS.length);
  rest = Math.floor(rest / LOADS.length);
  const object = pick(OBJECTS, rest % OBJECTS.length);
  rest = Math.floor(rest / OBJECTS.length);
  const action = pick(ACTIONS, rest % ACTIONS.length);
  rest = Math.floor(rest / ACTIONS.length);
  const metric = pick(METRICS, rest % METRICS.length);
  const tail = index % 3 === 0 ? `，${pick(TAILS, Math.floor(index / 3) % TAILS.length)}` : '';
  return `${company}｜${role}：${action}了${load}场景下的${object}，${metric}${tail}。`;
}

/**
 * 本次基准要跑的查询（真实中文关键词，含三个故意冷门的，用来把"库里没有"那条腿也跑到）。
 * @returns 查询数组；采样时按序号循环，条数与配置的 `queries` 不必整除
 */
function querySet(): string[] {
  return [
    '高并发',
    '推荐算法',
    '订单',
    'Java',
    '实习生',
    '发布流水线',
    '风控引擎',
    '数据仓库',
    '消息队列',
    '缓存层',
    '链路追踪',
    '灰度发布',
    '成本',
    '故障率',
    '覆盖率',
    '日志平台',
    '千万级',
    '排查手册',
    '云枢网络',
    '北极光半导体',
    '量化交易',
    '元宇宙',
  ];
}

/**
 * 最近秩法取百分位（P95 = 第 `ceil(n·rank)` 个样本，不做插值——插值会把两个相邻样本的差摊成假精度）。
 * @param sortedMs 升序排好的耗时数组（毫秒）
 * @param rank 百分位（0～1）
 * @returns 该位的毫秒数；数组为空时返回 0（调用方保证非空，这里只是免掉一处 `| undefined`）
 */
function percentile(sortedMs: readonly number[], rank: number): number {
  if (sortedMs.length === 0) return 0;
  const position = Math.max(0, Math.min(sortedMs.length - 1, Math.ceil(rank * sortedMs.length) - 1));
  return sortedMs[position] ?? 0;
}

/** 毫秒读数保留两位，方便逐字节比对归档文本。 */
function ms(value: number): string {
  return value.toFixed(2);
}

/**
 * 数一张表有多少行（基准要证明"读的是千级库"，不能只报配置里写的那个数）。
 * @param db 已挂载的裸连接
 * @param sql 表名（本文件只数 `kb_chunks` / `kb_chunks_fts` 这两张派生表与它们的孤儿行）
 * @returns 行数
 */
function countRows(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { total: number | bigint };
  return Number(row.total);
}

/**
 * 跑完整一次基准并打印读数。
 * @param budget 来自 `cordis.yml` 的 `bench.kb-search` 段
 * @returns 延迟报告（调用方据此决定退出码）
 */
async function runBench(budget: z.output<typeof benchConfigSchema>): Promise<BenchReport> {
  // 出网拦栽：任何一次 fetch 都当场炸。本基准不挂 `llm-embed`、也不给 key，
  // 所以这里守的是"检索这条链根本没有出网这条路"（4.3-04 / 4.3-08）。
  let fetchCalls = 0;
  globalThis.fetch = (input: unknown) => {
    fetchCalls += 1;
    throw new Error(`检索基准禁止出网（spec 4.3-04）：拦到对 ${String(input)} 的请求`);
  };

  const doc = parseYaml(readFileSync(manifestPath, 'utf8')) as unknown;
  // 检索参数**从清单来**：经 `config` 服务的分层解析拿到，与 app 平时那一条通道完全相同
  //（§2.7 禁的是第二套配置系统，所以这里不自己拼默认值）。
  const ctx = new Context();
  await ctx.plugin(ConfigService, { appName: 'auto-cc' });
  const config = asApp(ctx).config;
  config.setFile('kb-profile', manifestConfig(doc, 'kb-profile'));
  const profileConfig = config.resolve('kb-profile', { schema: kbProfileSchema });

  const storeConfig = storeSchema.parse({ ...manifestConfig(doc, 'store'), dir: benchDir });
  await ctx.plugin(LogService, { level: 'info', buffer: 500, file: 'auto-cc.log', dir: benchDir, redact: false });
  await ctx.plugin(StoreService, storeConfig);
  await ctx.plugin(ResumeDocService, {});
  await ctx.plugin(KbProfileService, profileConfig);
  const kb = asApp(ctx)['kb.profile'];
  const db = asApp(ctx).store.db;

  const writeStartedAt = performance.now();
  for (let index = 0; index < budget.chunks; index += 1) {
    const kind: KbEntityKind = KB_ENTITY_KINDS[index % KB_ENTITY_KINDS.length] ?? 'experience';
    kb.create({ kind, payload: { text: corpusText(index) } }, index);
  }
  const writeMs = performance.now() - writeStartedAt;

  const chunkRows = countRows(db, 'SELECT COUNT(*) AS total FROM kb_chunks');
  const ftsRows = countRows(db, 'SELECT COUNT(*) AS total FROM kb_chunks_fts');
  const orphanFtsRows = countRows(
    db,
    'SELECT COUNT(*) AS total FROM kb_chunks_fts WHERE rowid NOT IN (SELECT seq FROM kb_chunks)',
  );
  // 量级与一致性不过关，后面所有延迟数都没有意义——直接炸，不要打印一份好看的假读数。
  if (chunkRows !== budget.chunks || ftsRows !== chunkRows || orphanFtsRows !== 0) {
    throw new Error(
      `切片量级不符：kb_chunks=${String(chunkRows)}（期望 ${String(budget.chunks)}）/ 倒排行=${String(ftsRows)} / ` +
        `孤儿倒排行=${String(orphanFtsRows)}`,
    );
  }

  const queries = querySet();
  // 预热一整轮再采样：第一次检索要把页读进 SQLite 的页缓存，把"首次读盘"混进 P95 就不是用户平时的等待了。
  const warmupRounds = Math.floor(budget.queries / queries.length) + 1;
  for (let round = 0; round < warmupRounds; round += 1) {
    for (const query of queries) await kb.search(query);
  }
  const latencies: number[] = [];
  const hitCounts: number[] = [];
  const vectorStatuses = new Map<string, number>();
  for (let sample = 0; sample < budget.queries; sample += 1) {
    const query = queries[sample % queries.length] ?? '';
    const startedAt = performance.now();
    const result = await kb.search(query);
    latencies.push(performance.now() - startedAt);
    hitCounts.push(result.hits.length);
    vectorStatuses.set(result.vectorStatus, (vectorStatuses.get(result.vectorStatus) ?? 0) + 1);
  }

  const sorted = [...latencies].sort((left, right) => left - right);
  const report: BenchReport = {
    budgetMs: budget.p95BudgetMs,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1] ?? 0,
    meanMs: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
  };

  const zeroHit = hitCounts.filter((count) => count === 0).length;
  const avgHits = hitCounts.reduce((sum, count) => sum + count, 0) / hitCounts.length;
  console.log('=== 4.3-09 千级切片检索基准（spec 4.3-09 / 4.3-04 / 4.3-03）===');
  console.log(
    `配置来源：${path.relative(repoRoot, manifestPath)} 的 bench.kb-search → chunks=${String(budget.chunks)} ` +
      `queries=${String(budget.queries)} p95BudgetMs=${String(budget.p95BudgetMs)}`,
  );
  console.log(
    `检索参数（同一份清单的 kb-profile 段，经 config 服务分层解析）：topK=${String(profileConfig.searchTopK)} ` +
      `minScore=${String(profileConfig.searchMinScore)} k1=${String(profileConfig.bm25K1)} ` +
      `b=${String(profileConfig.bm25B)} 权重=${String(profileConfig.bm25Weight)}/${String(
        profileConfig.lexicalWeight,
      )} 子串折扣=${String(profileConfig.substringFloorScore)} rrfK=${String(profileConfig.rrfK)} ` +
      `vectorMinCosine=${String(profileConfig.vectorMinCosine)}`,
  );
  console.log(
    `装配：config + log + store(journal=${storeConfig.journal}) + resume.doc + kb.profile；` +
      '未挂 llm-embed、未给 embedding key',
  );
  console.log(`库文件：${path.relative(repoRoot, path.join(benchDir, 'store.db'))}`);
  console.log(
    `写入侧：${String(budget.chunks)} 条实体（实体行 + 切片 + 倒排三写，真实事务路径）用时 ${ms(writeMs)}ms ` +
      `＝ ${String(Math.round(budget.chunks / (writeMs / 1000)))} 条/秒`,
  );
  console.log(`库内读数：kb_chunks=${String(chunkRows)} / kb_chunks_fts=${String(ftsRows)} / 孤儿倒排行=0`);
  console.log(
    `采样：预热 ${String(queries.length)} × ${String(warmupRounds)} 轮（不计入），再取 ${String(budget.queries)} 个样本`,
  );
  console.log(
    `延迟：P50=${ms(report.p50Ms)}ms  P95=${ms(report.p95Ms)}ms  P99=${ms(report.p99Ms)}ms  ` +
      `max=${ms(report.maxMs)}ms  mean=${ms(report.meanMs)}ms`,
  );
  console.log(
    `命中分布：0 命中 ${String(zeroHit)} 次 / 平均 ${avgHits.toFixed(2)} 条 / 上限 topK=${String(
      profileConfig.searchTopK,
    )}`,
  );
  console.log(
    `向量腿：${[...vectorStatuses]
      .map(([status, count]) => `${status}×${String(count)}`)
      .join('  ')}（没有 key 就必须全是降级态）`,
  );
  console.log(`出网：globalThis.fetch 存根被调用 ${String(fetchCalls)} 次（判据：0）`);
  if (fetchCalls !== 0) throw new Error(`检索链路出网了 ${String(fetchCalls)} 次，与 spec 4.3-04 冲突`);
  return report;
}

/**
 * 入口：读配置 → 清库 → 跑基准 → 按预算决定退出码。
 * @returns 无返回值（超预算时置 `process.exitCode = 1`，让 Node 自然退出以刷完日志流）
 */
async function main(): Promise<void> {
  const doc = parseYaml(readFileSync(manifestPath, 'utf8')) as { bench?: Record<string, unknown> };
  const section = doc.bench?.['kb-search'];
  if (section === undefined) {
    throw new Error('cordis.yml 缺少 bench.kb-search 段：基准的量级与预算必须在配置里（spec 4.3-09）');
  }
  const budget = benchConfigSchema.parse(section);
  rmSync(benchDir, { recursive: true, force: true });
  mkdirSync(benchDir, { recursive: true });

  const report = await runBench(budget);
  const passed = report.p95Ms <= report.budgetMs;
  console.log(
    `RESULT 4.3-09 p95=${ms(report.p95Ms)}ms budget=${String(report.budgetMs)}ms verdict=${passed ? 'PASS' : 'FAIL'}`,
  );
  if (!passed) {
    console.error('P95 超出配置预算：这就是 4.3-09 的验收失败。不要调预算，要去看是哪条腿慢（plan §4.3-e 的边界条）。');
    process.exitCode = 1;
  }
}

await main();
