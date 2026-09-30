/**
 * `jd.store` 服务（spec 2.3-02 / 2.3-04 / 2.3-05）：JD 结构化入库的唯一落点。
 *
 * 表由本服务把迁移 push 进 `store.migrations` 再 `upgrade()`，与 `usage.ledger` 同一条路（AGENTS.md §2.7：
 * 连接池只有一处），号段见下面的 `JD_MIGRATION_VERSION`。
 *
 * 幂等靠**唯一索引 + UPSERT**，不靠「先查再插」：后者在两步之间页面又跳一次就会插出两行，
 * 而且每条都要多一次读（spec 2.3-04 要的「同一岗位在库里只有一行」必须由数据库来说）。
 */
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import type { JobListResultView, JobRowView, JdStoreStatusView, SalaryView } from '@auto-cc/shared';
import type { StoreService } from '@auto-cc/plugin-store';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

/**
 * JD 表的迁移号段：**3**。号段是全局的（`usage_ledger` 占 1、`chat` 的两张表占 2），
 * 撞号不是编译期错误而是运行期抛「迁移版本重复」——所以它只能写在这里并说明前两级是谁占的（plan §8.4 决策 6）。
 */
export const JD_MIGRATION_VERSION = 3;

/**
 * 建表与回滚。
 *
 * `down` 是必需的：spec 2.3-05 要实测「升上去还能回得来」，没有 `down` 的 `rollback` 只能报错，
 * 而一张纯新增的表本来就能整张丢掉，所以这里没有理由不提供。
 */
const jdMigration = {
  version: JD_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      job_id TEXT NOT NULL,
      title TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      salary_text TEXT NOT NULL DEFAULT '',
      salary_json TEXT,
      city TEXT NOT NULL DEFAULT '',
      experience TEXT NOT NULL DEFAULT '',
      education TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      requirements_json TEXT NOT NULL DEFAULT '[]',
      posted_text TEXT NOT NULL DEFAULT '',
      posted_at INTEGER,
      source_url TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      detail_captured_at INTEGER
    )`);
    // 幂等键：同一详情页地址 + 同一标题只允许一行（spec 2.3-04）。
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS jobs_source_title ON jobs (source_url, title)');
    // 界面按「最近抓到的」倒序列出，没这条索引就是每次全表排序。
    db.exec('CREATE INDEX IF NOT EXISTS jobs_captured_at ON jobs (captured_at DESC)');
  },
  down: (db: DatabaseSync) => {
    // 索引随表一起消失，不必单独 DROP：这张表没有需要保留的数据，回滚就是整张丢掉。
    db.exec('DROP TABLE IF EXISTS jobs');
  },
};

/** 落库一条 JD 的入参（跨进程视图 `JobRowView` 的写侧对应物，不含自增 id）。 */
export type JobDraft = {
  platform: string;
  jobId: string;
  title: string;
  company?: string;
  salaryText?: string;
  salary?: SalaryView | null;
  city?: string;
  experience?: string;
  education?: string;
  description?: string;
  requirements?: string[];
  postedText?: string;
  postedAt?: number | null;
  sourceUrl: string;
  capturedAt: number;
  detailCapturedAt?: number | null;
};

/** 一次 UPSERT 的结局，抓取循环靠它决定「这条还要不要去读详情」。 */
export type JobUpsertResult = {
  id: number;
  /** 本次是新建行还是更新了已有行 */
  created: boolean;
  /** 合并之后这行有没有详情（已有详情的行在重复抓取时不必再跑一遍详情页） */
  hasDetail: boolean;
};

/** 库内一行的原始读数（列名与视图的驼峰字段不同，转换收在 `toRowView`）。 */
type JobRow = {
  id: number | bigint;
  platform: string;
  job_id: string;
  title: string;
  company: string;
  salary_text: string;
  salary_json: string | null;
  city: string;
  experience: string;
  education: string;
  description: string;
  requirements_json: string;
  posted_text: string;
  posted_at: number | bigint | null;
  source_url: string;
  captured_at: number | bigint;
  detail_captured_at: number | bigint | null;
};

/**
 * 解析库里存的薪资 JSON。
 * @param raw 列里的 JSON 文本（可能为 null，也可能是别的程序写进来的坏值）
 * @returns 归一化薪资；缺失或坏值时为 null，界面据 `salaryText` 显示原文
 */
function parseSalaryJson(raw: string | null): SalaryView | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const units = ['k', 'wan', 'yuan', 'unknown'] as const;
    const periods = ['month', 'year', 'unknown'] as const;
    if (
      !units.includes(value.unit as (typeof units)[number]) ||
      !periods.includes(value.period as (typeof periods)[number])
    ) {
      return null;
    }
    return {
      min: typeof value.min === 'number' ? value.min : null,
      max: typeof value.max === 'number' ? value.max : null,
      unit: value.unit as SalaryView['unit'],
      period: value.period as SalaryView['period'],
      salaryMonths: typeof value.salaryMonths === 'number' ? value.salaryMonths : null,
      isNegotiable: value.isNegotiable === true,
    };
  } catch {
    return null;
  }
}

/**
 * 解析库里存的任职要求 JSON 数组。
 * @param raw 列里的 JSON 文本
 * @returns 字符串数组；坏值回空数组而不是抛出
 */
function parseRequirementsJson(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** node:sqlite 读出的整数可能是 `bigint`，在出口处统一收成 number。 */
const asInt = (value: number | bigint | null): number | null =>
  value === null || value === undefined ? null : Number(value);

/** 把数据库行转成跨进程视图。 */
function toRowView(row: JobRow): JobRowView {
  return {
    id: Number(row.id),
    platform: row.platform,
    jobId: row.job_id,
    title: row.title,
    company: row.company,
    salaryText: row.salary_text,
    salary: parseSalaryJson(row.salary_json),
    city: row.city,
    experience: row.experience,
    education: row.education,
    description: row.description,
    requirements: parseRequirementsJson(row.requirements_json),
    postedText: row.posted_text,
    postedAt: asInt(row.posted_at),
    sourceUrl: row.source_url,
    capturedAt: Number(row.captured_at),
    detailCapturedAt: asInt(row.detail_captured_at),
  };
}

/** 列表条数的钳制区间：界面不需要一万行，SQL 注入面也不在 `?` 参数上，但上限能防一次误传。 */
const LIST_LIMIT = { min: 1, max: 500, fallback: 50 };

export const jdStoreSchema = z.strictObject({});

/** 校验后的配置形状。 */
export type JdStoreConfig = z.infer<typeof jdStoreSchema>;

export class JdStoreService extends Service {
  static provide = 'jd.store';
  static Config = jdStoreSchema;
  static inject = ['store'];

  constructor(ctx: Context, _options: JdStoreConfig) {
    // 无配置项也要接住第二个实参：cordis 递的是校验后的配置对象（AGENTS.md §9 实测 1.3）。
    super(ctx, 'jd.store');
  }

  /** store 服务句柄；连接尚未打开时由 `store.db` 的 getter 抛出「尚未完成挂载」。 */
  private get store(): StoreService {
    return asApp(this.ctx).store;
  }

  /**
   * 登记迁移并把表建出来。
   *
   * 幂等 push 是硬要求：插件重启会重新构造本服务，无条件 push 会在共享清单里留下两个 `version: 2`。
   */
  private ensureSchema(): void {
    const { migrations } = this.store;
    if (!migrations.some((item) => item.version === JD_MIGRATION_VERSION)) {
      migrations.push(jdMigration);
    }
    this.store.upgrade();
  }

  /**
   * 写入或合并一条 JD（幂等键：`source_url + title`）。
   *
   * 合并方向是「新值非空才覆盖」：详情页读到空描述不应该把上次读到的正文抹掉，
   * 而 `captured_at` 反过来——它是「最后一次看到」的读数，永远取新。
   * @param draft 一条 JD 的字段（列表页能读到的先写，详情字段读不到就留空）
   * @returns 合并后那一行的 id、本次是新建还是合并、这行现在有没有详情
   * @throws 标题或来源地址为空时 `INVALID_ARGUMENT`（这两列是幂等键，空就等于行间互相覆盖）
   */
  upsert = (draft: JobDraft): JobUpsertResult => {
    if (!draft.title.trim() || !draft.sourceUrl.trim()) {
      throw new AppError('INVALID_ARGUMENT', '入库一条 JD 需要同时有标题与来源地址', 'jd.store', {
        title: draft.title,
        sourceUrl: draft.sourceUrl,
      });
    }
    const sourceUrl = draft.sourceUrl.trim();
    const title = draft.title.trim();
    // 「是否新建」必须在写之前问：UPSERT 之后两种分支都在表里留了一行，就分不出是哪一种了。
    const existedBefore = this.existsBefore(sourceUrl, title);
    // `RETURNING` 让「合并后的行」与写入在同一条语句里拿到：`lastInsertRowid` 在走 DO UPDATE 分支时
    // 是不变的（实测 Node 24 / sqlite 3.53），照它返回会在更新分支给出别的行的 id。
    const row = this.store.db
      .prepare(
        `INSERT INTO jobs (
          platform, job_id, title, company, salary_text, salary_json, city, experience, education,
          description, requirements_json, posted_text, posted_at, source_url, captured_at, detail_captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (source_url, title) DO UPDATE SET
          platform = excluded.platform,
          job_id = excluded.job_id,
          company = CASE WHEN excluded.company <> '' THEN excluded.company ELSE jobs.company END,
          salary_text = CASE WHEN excluded.salary_text <> '' THEN excluded.salary_text ELSE jobs.salary_text END,
          salary_json = COALESCE(excluded.salary_json, jobs.salary_json),
          city = CASE WHEN excluded.city <> '' THEN excluded.city ELSE jobs.city END,
          experience = CASE WHEN excluded.experience <> '' THEN excluded.experience ELSE jobs.experience END,
          education = CASE WHEN excluded.education <> '' THEN excluded.education ELSE jobs.education END,
          description = CASE WHEN excluded.description <> '' THEN excluded.description ELSE jobs.description END,
          requirements_json = CASE WHEN excluded.requirements_json <> '[]' THEN excluded.requirements_json ELSE jobs.requirements_json END,
          posted_text = CASE WHEN excluded.posted_text <> '' THEN excluded.posted_text ELSE jobs.posted_text END,
          posted_at = COALESCE(excluded.posted_at, jobs.posted_at),
          captured_at = excluded.captured_at,
          detail_captured_at = COALESCE(excluded.detail_captured_at, jobs.detail_captured_at)
        RETURNING id, detail_captured_at`,
      )
      .get(
        draft.platform,
        draft.jobId,
        title,
        draft.company ?? '',
        draft.salaryText ?? '',
        draft.salary ? JSON.stringify(draft.salary) : null,
        draft.city ?? '',
        draft.experience ?? '',
        draft.education ?? '',
        draft.description ?? '',
        JSON.stringify(draft.requirements ?? []),
        draft.postedText ?? '',
        draft.postedAt ?? null,
        sourceUrl,
        draft.capturedAt,
        draft.detailCapturedAt ?? null,
      ) as unknown as { id: number | bigint; detail_captured_at: number | bigint | null };
    return {
      id: Number(row.id),
      created: !existedBefore,
      // 合并后的真相，而不是「这次有没有带详情」：上轮抓到的详情不会因为这轮没读到就被判成没有。
      hasDetail: row.detail_captured_at !== null && row.detail_captured_at !== undefined,
    };
  };

  /**
   * 按幂等键查一行是否已存在（在写入**之前**调用，用来区分「新建」与「合并」）。
   * @param sourceUrl 详情页地址
   * @param title 标题
   * @returns 写入前已存在为 true
   */
  private existsBefore(sourceUrl: string, title: string): boolean {
    const row = this.store.db
      .prepare('SELECT 1 AS hit FROM jobs WHERE source_url = ? AND title = ? LIMIT 1')
      .get(sourceUrl, title) as { hit?: number } | undefined;
    return row !== undefined;
  }

  /**
   * 列出库里最近的 JD。
   * @param limit 条数（钳到 1～500，省略用 50）
   * @returns 总数（不受 limit 影响）与按 `captured_at` 倒序的行
   */
  list = (limit?: number): JobListResultView => {
    const requested = typeof limit === 'number' && Number.isFinite(limit) ? Math.trunc(limit) : LIST_LIMIT.fallback;
    const capped = Math.min(Math.max(requested, LIST_LIMIT.min), LIST_LIMIT.max);
    const total = this.count();
    const rows = this.store.db
      .prepare('SELECT * FROM jobs ORDER BY captured_at DESC, id DESC LIMIT ?')
      .all(capped) as unknown as JobRow[];
    return { total, rows: rows.map(toRowView) };
  };

  /**
   * 库内总行数。
   * @returns 行数；空表为 0
   */
  count = (): number => {
    const row = this.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n?: number | bigint };
    return Number(row?.n ?? 0);
  };

  /**
   * 库内概况（界面与验收脚本共用的一份读数）。
   * @returns 总数、有详情的条数、当前 schema 版本、最近一次抓到的来源地址
   */
  status = (): JdStoreStatusView => {
    const withDetail = this.store.db
      .prepare('SELECT COUNT(*) AS n FROM jobs WHERE detail_captured_at IS NOT NULL')
      .get() as { n?: number | bigint };
    const newest = this.store.db
      .prepare('SELECT source_url FROM jobs ORDER BY captured_at DESC, id DESC LIMIT 1')
      .get() as { source_url?: string } | undefined;
    return {
      total: this.count(),
      withDetail: Number(withDetail?.n ?? 0),
      schemaVersion: this.store.version,
      newestSourceUrl: newest?.source_url ?? null,
    };
  };

  [Service.init](): void {
    this.ensureSchema();
    this.ctx.logger.info(
      `JD 库就绪：表 jobs（schema v${String(JD_MIGRATION_VERSION)}）· 现有 ${String(this.count())} 行`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'jd.store': JdStoreService;
  }
}
