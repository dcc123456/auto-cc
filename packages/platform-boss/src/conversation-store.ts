/**
 * `conversation.store` 服务（spec 2.5-07）：会话消息的唯一落点。
 *
 * 为什么表放在这个包而不是 `plugin-browser`：`browser` 是内核层，它不认识任何平台，
 * 而「读到一条消息」的判定（哪算正文、哪个属性是稳定 id）全部来自站点知识。
 * 与 `jobs` 表同一条先例——表的形状是通用的，读它的那只手是平台的（plan §12.10 第 1 条）。
 *
 * 去重靠**唯一索引**而不是「先查再插」：`readReplies` 每次都是全量读页面（真实平台不给游标，
 * §12.6.2 第 3 条），所以同一条消息会被读到第二次，这是预期用法而不是异常。
 */
import { AppError, asApp, Service, type Context } from '@auto-cc/core';
import type {
  ConversationListResultView,
  ConversationRowView,
  ConversationStatusView,
  ConversationSyncView,
  FunnelRange,
} from '@auto-cc/shared';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { PlatformRegistryService, ReplyMessage } from '@auto-cc/plugin-browser';
import type { StoreService } from '@auto-cc/plugin-store';
import { LIST_LIMIT } from './jd-store.js';

/**
 * 会话表的迁移号段：**5**。号段全局唯一（1 账本、2 agent 会话、3 JD、4 工作流 run），
 * 撞号不是编译期错误而是运行期抛「迁移版本重复」，所以只能在这里定一次（plan §8.4 决策 6）。
 */
export const CONVERSATION_MIGRATION_VERSION = 5;

/**
 * 建表与回滚。
 *
 * 唯一索引建在 `(platform, job_id, dedupe_key)` 而不是 `external_id` 上：页面不带稳定 id 时
 * `dedupe_key` 退到「方向 + 正文摘要」（见 `dedupeKeyOf`），那种站点也不该每轮都长出重复行；
 * 两种键共用一条索引，去重规则就只有一条（AGENTS.md §2.5）。
 *
 * 导出给用例装配用：`jd.store.list` 要左连这张表（spec 2.5-08），测那张表的行为时只需要 DDL 本身，
 * 不需要整条会话链路（登记处 + 适配器 + 页面手），也不需要动迁移台账。
 */
export const conversationMigration = {
  version: CONVERSATION_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      job_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      text TEXT NOT NULL,
      external_id TEXT,
      dedupe_key TEXT NOT NULL,
      read_at INTEGER NOT NULL
    )`);
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS conversation_dedupe ON conversation_messages (platform, job_id, dedupe_key)',
    );
    // 界面按目标看时间线，没这条索引就是每次全表排序。
    db.exec('CREATE INDEX IF NOT EXISTS conversation_job ON conversation_messages (platform, job_id, read_at ASC)');
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS conversation_messages');
  },
};

/**
 * 时间索引的迁移号段：**26**（此前最大是 5.7-b 调度登记处的 25，号段全局、撞号在运行期才炸）。
 *
 * 为什么要单开一条迁移而不是往号段 5 里加一行：已记「5 已应用」的老库永远不会重跑那支迁移
 * （§9 的 5.3-a 实测），新库会建出索引而装机用户的库里没有——按时间范围数这张表就退成全表扫，
 * 而 spec 5.8-05 要的恰恰是"万级记录下的响应时间有依据"。索引形状与既有那张不同，也不能复用：
 * `(platform, job_id, read_at)` 服务的是"某个岗位的时间线"，前缀不是 `read_at`，
 * 只给时间范围时 SQLite 用不上它（plan §7.6.1 F13）。
 */
export const CONVERSATION_TIME_INDEX_MIGRATION_VERSION = 26;

/** 见 `CONVERSATION_TIME_INDEX_MIGRATION_VERSION`：只建/只删一条索引，不动数据。 */
export const conversationTimeIndexMigration = {
  version: CONVERSATION_TIME_INDEX_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec('CREATE INDEX IF NOT EXISTS conversation_read_at ON conversation_messages (read_at)');
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP INDEX IF EXISTS conversation_read_at');
  },
};

/** 库里一行的原始读数（列名与视图的驼峰字段不同，转换收在 `toRowView`）。 */
type ConversationRow = {
  id: number | bigint;
  platform: string;
  job_id: string;
  direction: string;
  text: string;
  external_id: string | null;
  read_at: number | bigint;
};

/**
 * 一条消息的去重键。
 * @param message 适配器从页面读到的一条消息
 * @returns 页面带稳定标识时是 `id:<externalId>`；没带时是 `t:<方向:正文 的 sha1>`。
 *          后者意味着「同一句话发两遍」会被并成一行——对候选消息来说这是可接受的取舍，
 *          真实招聘者不会把同一句原话发两次，而每次全量读都会重复落库才是更大的问题。
 */
function dedupeKeyOf(message: ReplyMessage): string {
  if (message.externalId) return `id:${message.externalId}`;
  return `t:${createHash('sha1').update(`${message.from}:${message.text}`).digest('hex')}`;
}

/**
 * 把数据库行转成跨进程视图。
 * @param row 库里的一行（列名是下划线）
 * @returns 视图行；`direction` 只认 `recruiter`，其余一律归为 `self`
 */
function toRowView(row: ConversationRow): ConversationRowView {
  return {
    id: Number(row.id),
    platform: row.platform,
    jobId: row.job_id,
    from: row.direction === 'recruiter' ? 'recruiter' : 'self',
    text: row.text,
    externalId: row.external_id,
    at: Number(row.read_at),
  };
}

/** 不指定平台时同步哪个平台：装配期决定、写在 `cordis.yml`，本服务不写死（同 `jd.capture`）。 */
export const conversationStoreSchema = z.strictObject({
  platform: z.string().min(1).default('boss'),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type ConversationStoreConfig = z.output<typeof conversationStoreSchema>;

export class ConversationStoreService extends Service {
  static provide = 'conversation.store';
  static Config = conversationStoreSchema;
  static inject = ['store', 'platform.registry'];

  constructor(
    ctx: Context,
    private readonly config: ConversationStoreConfig,
  ) {
    super(ctx, 'conversation.store');
  }

  /** store 服务句柄；连接尚未打开时由 `store.db` 的 getter 抛出「尚未完成挂载」。 */
  private get store(): StoreService {
    return asApp(this.ctx).store;
  }

  /** 平台登记处：同步时要按名字拿到适配器去读页面。 */
  private get registry(): Pick<PlatformRegistryService, 'get'> {
    return asApp(this.ctx)['platform.registry'];
  }

  /**
   * 落库一条消息（幂等键：`platform + job_id + dedupe_key`）。
   * @param message 适配器从页面读到的一条消息
   * @returns 本次是新建行还是「已经见过」；合并分支什么都不做，因为消息不改写
   */
  record = (message: ReplyMessage): boolean => {
    const changes = this.store.db
      .prepare(
        `INSERT INTO conversation_messages (platform, job_id, direction, text, external_id, dedupe_key, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (platform, job_id, dedupe_key) DO NOTHING`,
      )
      .run(
        message.platform,
        message.jobId,
        message.from,
        message.text,
        message.externalId,
        dedupeKeyOf(message),
        message.at,
      );
    return changes.changes > 0;
  };

  /**
   * 读某个目标的会话页并把见到的消息落库（spec 2.5-07 的完整一轮）。
   *
   * 编排只有「读 + 逐条 record」两行，因此就地写完不再起一个 `conversation.capture` 服务：
   * 它与 `jd.capture` 的差别是会话页一屏就是全量，没有滚动攒批那件事要做（AGENTS.md §2.6）。
   * @param jobId 目标岗位标识
   * @param platform 平台标识；省略时取配置 `platform`
   * @returns 本次读到多少行、新增多少行、按去重键跳过多少行——第二遍轮询应当 `inserted:0`
   * @throws 目标未登记 `PLATFORM_NOT_REGISTERED`；jobId 为空 `INVALID_ARGUMENT`；
   *         页面读不到由适配器照 `browser.act` / `browser.page` 的原样抛出
   */
  syncFrom = async (jobId: string, platform?: string): Promise<ConversationSyncView> => {
    const target = jobId?.trim();
    if (!target) throw new AppError('INVALID_ARGUMENT', '同步会话必须给出目标岗位', 'conversation.store');
    const key = platform?.trim() || this.config.platform;
    const messages = await this.registry.get(key).readReplies(target);
    let inserted = 0;
    for (const message of messages) if (this.record(message)) inserted += 1;
    const at = Date.now();
    this.ctx.logger.info(
      `同步会话 ${key}/${target}：页面读到 ${String(messages.length)} 条 · 新增 ${String(inserted)} 条 · 已见过 ${String(messages.length - inserted)} 条`,
    );
    return {
      platform: key,
      jobId: target,
      read: messages.length,
      inserted,
      duplicate: messages.length - inserted,
      at,
    };
  };

  /**
   * 列出某个目标已落库的消息（按读取时间升序，即页面的时间线方向）。
   * @param jobId 目标岗位标识
   * @param limit 条数（钳到 1～500，省略用 50）
   * @returns 该目标的总条数（不受 limit 影响）与行；只查配置里那个平台，跨平台看数走 `status`
   */
  list = (jobId: string, limit?: number): ConversationListResultView => {
    const requested = typeof limit === 'number' && Number.isFinite(limit) ? Math.trunc(limit) : LIST_LIMIT.fallback;
    const capped = Math.min(Math.max(requested, LIST_LIMIT.min), LIST_LIMIT.max);
    const target = jobId?.trim() ?? '';
    const total = this.store.db
      .prepare('SELECT COUNT(*) AS n FROM conversation_messages WHERE platform = ? AND job_id = ?')
      .get(this.config.platform, target) as { n?: number | bigint };
    const rows = this.store.db
      .prepare(
        'SELECT * FROM conversation_messages WHERE platform = ? AND job_id = ? ORDER BY read_at ASC, id ASC LIMIT ?',
      )
      .all(this.config.platform, target, capped) as unknown as ConversationRow[];
    return { total: Number(total?.n ?? 0), rows: rows.map(toRowView) };
  };

  /**
   * 库内概况（界面与验收脚本共用的一份读数）。
   * @returns 总条数、招聘者发来的条数、涉及多少个目标、当前 schema 版本、最近读到消息的那个目标
   */
  status = (): ConversationStatusView => {
    const counts = this.store.db
      .prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN direction = 'recruiter' THEN 1 ELSE 0 END) AS inbound,
                COUNT(DISTINCT platform || '|' || job_id) AS jobs
         FROM conversation_messages`,
      )
      .get() as { n?: number | bigint; inbound?: number | bigint; jobs?: number | bigint };
    const newest = this.store.db
      .prepare('SELECT job_id FROM conversation_messages ORDER BY read_at DESC, id DESC LIMIT 1')
      .get() as { job_id?: string } | undefined;
    return {
      total: Number(counts?.n ?? 0),
      recruiterMessages: Number(counts?.inbound ?? 0),
      jobs: Number(counts?.jobs ?? 0),
      schemaVersion: this.store.version,
      newestJobId: newest?.job_id ?? null,
    };
  };

  /**
   * **半开区间** `[fromMs, toMs)` 内"有招聘方回过话"的目标有几个（spec 5.8-01 的"回复数"那一级）。
   *
   * 为什么数**岗位**而不是数**消息条数**：漏斗的上一级是"打了几个招呼"，同量纲才谈得上转化率；
   * 一条回过话的岗位平均来三条消息，数条数会把"3 个人理你"显示成"12 条回复"，
   * 那是把同一个岗位重复计进分子（plan §7.6.2 决策十六）。
   * 时刻列取 `read_at`（本表只有这一列时刻——它是"读到的时刻"，不是"对方发出的时刻"，页面不给后者），
   * 区间含头不含尾，走号段 26 那条 `conversation_read_at` 索引。
   * 去重键取 `(platform, job_id)` 而不是裸 `job_id`：与 `status().jobs` 同一个口径（§2.5 只留一条数法），
   * 两个平台的同一个岗位 id 是两次不同的回复。
   * @param range 半开区间毫秒时间戳，`fromMs` 含、`toMs` 不含
   * @returns 该区间内至少有一条招聘方消息的目标数；库里没有回复为 0
   */
  repliedJobCount = (range: FunnelRange): number => {
    const row = this.store.db
      .prepare(
        `SELECT COUNT(DISTINCT platform || '|' || job_id) AS n FROM conversation_messages
         WHERE direction = 'recruiter' AND read_at >= ? AND read_at < ?`,
      )
      .get(range.fromMs, range.toMs) as { n?: number | bigint };
    return Number(row?.n ?? 0);
  };

  /**
   * 登记迁移并把表建出来。
   *
   * 幂等 push 是硬要求：插件重启会重新构造本服务，无条件 push 会在共享清单里留下两个 `version: 5`。
   * 两条迁移各自守自己的号（表 5、时间索引 26），老库升级时只有第二条会跑。
   */
  private ensureSchema(): void {
    const { migrations } = this.store;
    for (const migration of [conversationMigration, conversationTimeIndexMigration]) {
      if (!migrations.some((item) => item.version === migration.version)) {
        migrations.push(migration);
      }
    }
    this.store.upgrade();
  }

  [Service.init](): void {
    this.ensureSchema();
    this.ctx.logger.info(
      `会话库就绪：表 conversation_messages（schema v${String(CONVERSATION_MIGRATION_VERSION)}）· 现有 ${String(this.status().total)} 行 · 默认平台 ${this.config.platform}`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'conversation.store': ConversationStoreService;
  }
}
