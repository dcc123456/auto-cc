/**
 * `outbound.deliveries` 服务（spec 3.7-02）：一次「确认送达」的投递留一条可追溯记录，唯一落点是 `delivery_records` 表。
 *
 * 为什么是一张**独立的表**而不是给 `usage_ledger` 加一列（spec 2.6-05 当年正是按「不加列不加迁移」把这半个凭据推给 P3）：
 * 账本的行是**消耗**——按动作数今天用掉几个，它必须永远只回答额度问题；
 * 投递记录的行是**经过**——这条递给了哪个 JD、用的是哪一版简历。分成两张表之后，
 * 账本不因领域字段变宽，投递域也不必把「发出去几条」背成第二套额度状态（AGENTS.md §2.7 禁第二套状态存储）。
 * 两表以 `ledger_id` 一一对齐：一次成功投递正好一条账 + 一条记录，缺任何一条都是缺陷。
 *
 * 只存**引用**不存正文：`snapshot_id` 指向 `resume_snapshots`，内容经 `resume.snapshot.restore` 读回。
 * 「当时内容是什么」因此是两个服务之间的一次关联，而不是把文档 JSON 抄进投递域存第二份（§2.2）。
 *
 * 没有 `status` 列是有意的：这一行只在页面确认送达、账本落账**之后**才写——被拒 / 超时 / 已下架 /
 * 页面没确认那几路连账本都没有行，这里更不会有的。「已送达」是这行存在的前提，不是它的一个取值。
 */
import { asApp, Service, type Context } from '@auto-cc/core';
import type { FunnelRange } from '@auto-cc/shared';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 迁移号段：**9**（账本 1、agent 会话 2、jobs 3、workflow run 4、conversation_messages 5、consent 6、resume_docs 7、resume_snapshots 8）。
 * 撞号不是编译错误而是运行期「静默不建表」——`ensureSchema` 的幂等 push 见号已存在就跳过，
 * 后挂载的那个服务于是读不到自己的表（no such table）。所以占位必须在这里列全，测试里也留一条护栏。
 */
export const DELIVERY_RECORD_MIGRATION_VERSION = 9;

/**
 * 建 `delivery_records` 表：一次成功投递一行，主键就是账本行 id（同一笔消耗写不进第二条经过）。
 * `(job_id, ts)` 服务「这个 JD 收过哪几版简历」，`(snapshot_id)` 服务反查「这一版简历递给了谁」。
 */
const deliveryRecordMigration = {
  version: DELIVERY_RECORD_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS delivery_records (
      ledger_id INTEGER PRIMARY KEY,
      platform TEXT NOT NULL,
      job_id TEXT NOT NULL,
      snapshot_id TEXT,
      ts INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_delivery_records_job ON delivery_records (job_id, ts)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_delivery_records_snapshot ON delivery_records (snapshot_id)');
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS delivery_records');
  },
};

/**
 * 投递时间索引的迁移号段：**27**（表 9、会话表 5、会话时间索引 26；号段全局，撞号在运行期才炸）。
 *
 * 理由与 `conversation_read_at` 那条一模一样（plan §7.6.2 决策十七）：`(job_id, ts)` 与 `(snapshot_id)`
 * 两条既有索引的前缀都不是 `ts`，只按时间范围数这张表就是全表扫——而 spec 5.8-05 要的
 * "万级记录下的响应时间有记录"必须是有依据的读数，不是"应该挺快"。
 * 单开一条迁移而不是往号段 9 里加一行：已记「9 已应用」的老库永远不会重跑那支迁移。
 */
export const DELIVERY_TIME_INDEX_MIGRATION_VERSION = 27;

/** 见 `DELIVERY_TIME_INDEX_MIGRATION_VERSION`：只建/只删一条索引，不动数据。 */
export const deliveryTimeIndexMigration = {
  version: DELIVERY_TIME_INDEX_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec('CREATE INDEX IF NOT EXISTS idx_delivery_records_ts ON delivery_records (ts)');
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP INDEX IF EXISTS idx_delivery_records_ts');
  },
};

/**
 * 投递记录加「会话坐标」那一列的迁移号段：**35**（表 9、时间索引 27、会话表的同名列 33；号段全局，撞号在运行期才炸）。
 *
 * 为什么这张表也要加一列（P8 裁定⑲ 的同一形状搬到投递，plan §7 第 14 条）：真 BOSS 的投递口长在会话里，
 * 那一发**根本没有岗位 id 可记**。把联系人的名字写进 `job_id` 会让这一列同时装两种实体，
 * 而它正是「这个 JD 收过哪几版简历」那句问话的键——与 8.4-C 给会话表另立一列的理由逐字相同。
 *
 * 写在**新号段**而不是补进号段 9：`runMigrations` 的判据是台账里记过账没有（§9 实测 5.3-a），
 * 老库永远不会重跑那支迁移，列因此静默缺失、运行期以 `no such column` 失败。
 * 单测同样看不见（每个用例从空库起，所有迁移头一回跑），所以这里留一条"老库升到 35"的用例。
 */
export const DELIVERY_CONVERSATION_TARGET_MIGRATION_VERSION = 35;

/**
 * 见上一段：只加一列，不动既有行。
 *
 * 那一格为什么是 `TEXT NOT NULL DEFAULT ''` 而不是 NULL：与 `conversation_messages` 的同名列同一口径
 * （空串只在库里存在，读回视图时归 null，见 `coordinateOf`），于是不给"这一列两种实体"留出第三种读数，
 * 也不必在每条查询里区分 NULL 与空串。既有行拿到默认空串 = 「这次投递记的是岗位，没有会话坐标」，是实话。
 */
export const deliveryConversationTargetMigration = {
  version: DELIVERY_CONVERSATION_TARGET_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec("ALTER TABLE delivery_records ADD COLUMN conversation_target TEXT NOT NULL DEFAULT ''");
  },
  down: (db: DatabaseSync) => {
    // 回滚就是"退回这支功能之前"：按会话落的那些行在旧形状下没有岗位坐标，留着会读成一条空 job_id 的投递，
    // 与号段 33 的 `down` 同一处置（plan §8.4 裁定⑲）。
    db.exec("DELETE FROM delivery_records WHERE conversation_target <> ''");
    db.exec('ALTER TABLE delivery_records DROP COLUMN conversation_target');
  },
};

/** 记录表没有运行期可调项（保留上限属于快照域 3.7-05，额度属于账本域），空 schema 只为让配置口径与其他服务一致。 */
export const deliveryRecordSchema = z.strictObject({});
export type DeliveryRecordConfig = z.infer<typeof deliveryRecordSchema>;

/**
 * 一条投递记录（既是写入的入参也是读出的行）。
 *
 * 输入输出同形：写侧的值全部来自 `outbound.deliver` 已经算好的读数（账本行 id、目标、请求带来的快照引用、
 * 与账本同一个基准毫秒），没有第二个来源，因此不需要一对形状相同的「入参类型 / 视图类型」（§2.6）。
 */
export type DeliveryRecord = {
  /** `usage_ledger` 里那次落账的行 id，本表主键 */
  ledgerId: number;
  /** 投递打到哪个平台（账本不存平台，所以「哪个 JD 在哪个平台」要靠这一列才问得出） */
  platform: string;
  /** 目标岗位 id，与账本的 `target_id` 同源；按会话列表行投递那一路是 null（裁定⑲ 搬到投递） */
  jobId: string | null;
  /** 会话坐标（真 BOSS 是会话行上的那个对象）；按岗位地址投递那一路是 null */
  conversationTarget: string | null;
  /** 指向 `resume_snapshots.snapshot_id`；只给文件路径、没有导出上下文的投递为 null */
  snapshotId: string | null;
  /** 落账基准毫秒（`stage` 冻结的 `nowMs` + 频控实际等待），与账本行的 `ts` 同值 */
  ts: number;
};

/** `delivery_records` 一行的原始读数（node:sqlite 的整数列可能是 number 或 bigint）。 */
type DeliveryRow = {
  ledger_id: number | bigint | null;
  platform: string | null;
  job_id: string | null;
  conversation_target: string | null;
  snapshot_id: string | null;
  ts: number | bigint | null;
};

/** 库里那一格的空串读回视图时归 null：跨进程一侧只需要知道"这一行没有那个坐标"（同会话表 33 的口径）。 */
const coordinateOf = (stored: string | null): string | null => (stored ? stored : null);

export class DeliveryRecordService extends Service {
  static provide = 'outbound.deliveries';
  static Config = deliveryRecordSchema;
  // 只依赖 1.3 的那一条共享连接：复用 `store`，不自建第二条 SQLite 连接（§2.7 禁第二个连接池）。
  static inject = ['store'];

  constructor(ctx: Context, _options: DeliveryRecordConfig) {
    // 必须接住第二个实参：cordis 递的是校验后的配置（AGENTS.md §9 实测 1.3）。
    super(ctx, 'outbound.deliveries');
  }

  private get store() {
    return asApp(this.ctx).store;
  }

  /**
   * 落一条投递记录（spec 3.7-02 的写入半边，由 `outbound.deliver` 在成功落账之后调用）。
   *
   * 不做快照存在性校验：`snapshot_id` 是个引用，写的时候那条快照行必然已经存在（导出成功才有 id），
   * 而读的一侧 `resume.snapshot.restore` 本来就把「查无此快照」报成 `missing`——在这里再数一遍是第二套判据（§2.7）。
   * @param record 账本行 id + 平台 + 两只坐标（其一为 null，看这一发按哪一路寻址）+ 快照引用 + 落账基准毫秒
   * @throws 同一个 `ledgerId` 重复写时由主键直接拒掉——一次投递只有一条经过，写第二遍就是编排层出了 bug
   */
  record = (record: DeliveryRecord): void => {
    this.store.db
      .prepare(
        `INSERT INTO delivery_records (ledger_id, platform, job_id, conversation_target, snapshot_id, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      // 缺的那一格写空串（列是 NOT NULL，与 conversation_messages 同一条口径，见上面的注释）。
      .run(
        record.ledgerId,
        record.platform,
        record.jobId ?? '',
        record.conversationTarget ?? '',
        record.snapshotId,
        record.ts,
      );
  };

  /**
   * 按账本行 id 取那条投递记录（回执里的 `ledgerId` 就是这里的钥匙）。
   * @param ledgerId 账本行 id
   * @returns 记录行；那次投递没有留下经过（或从未落账）时为 null，不抛异常
   */
  get = (ledgerId: number): DeliveryRecord | null => {
    const row = this.store.db
      .prepare(
        'SELECT ledger_id, platform, job_id, conversation_target, snapshot_id, ts FROM delivery_records WHERE ledger_id = ?',
      )
      .get(ledgerId) as DeliveryRow | undefined;
    return row ? toRecord(row) : null;
  };

  /**
   * 列出某个 JD 收到过的投递（最新的在前）——「这份简历投给了哪个 JD」那句问话的另一半。
   * @param jobId 目标岗位 id
   * @returns 记录行数组；没递过是空数组
   */
  listFor = (jobId: string): DeliveryRecord[] => {
    const rows = this.store.db
      .prepare(
        `SELECT ledger_id, platform, job_id, conversation_target, snapshot_id, ts
         FROM delivery_records WHERE job_id = ?
         ORDER BY ts DESC, ledger_id DESC`,
      )
      .all(jobId) as DeliveryRow[];
    return rows.map(toRecord);
  };

  /**
   * 反查某一版简历都递给了哪些岗位（快照 → 投递的去处）。
   * @param snapshotId 快照 id
   * @returns 记录行数组，按时间正序；从未递过是空数组
   */
  listBySnapshot = (snapshotId: string): DeliveryRecord[] => {
    const rows = this.store.db
      .prepare(
        `SELECT ledger_id, platform, job_id, conversation_target, snapshot_id, ts
         FROM delivery_records WHERE snapshot_id = ?
         ORDER BY ts ASC, ledger_id ASC`,
      )
      .all(snapshotId) as DeliveryRow[];
    return rows.map(toRecord);
  };

  /**
   * **半开区间** `[fromMs, toMs)` 内确认送达了几次投递（spec 5.8-01 的"投递数"那一级）。
   *
   * 这张表此前连 `count` 都没有（plan §7.6.1 F12）——不是遗漏，是 3.7-02 时没有消费者：额度侧数的是
   * `usage_ledger`，这张表只管"经过"。看板要的"投出去几条"因此有两种读法：数账本的 `deliver` 行，
   * 或数这张表。选后者（决策十六）：这张表的一行只在**账本落账之后**才写（见文件头"没有 status 列"那段），
   * 所以它是"真的递成功了"，而账本行还在的那一路如果记录写入失败会多算一条——分母该是成功数。
   * 时刻列取 `ts`（与账本行同值），走号段 27 那条 `idx_delivery_records_ts` 索引。
   * @param range 半开区间毫秒时间戳，`fromMs` 含、`toMs` 不含
   * @returns 区间内的投递次数；没有递过为 0
   */
  count = (range: FunnelRange): number => {
    const row = this.store.db
      .prepare('SELECT COUNT(*) AS n FROM delivery_records WHERE ts >= ? AND ts < ?')
      .get(range.fromMs, range.toMs) as { n?: number | bigint };
    return Number(row?.n ?? 0);
  };

  /** 幂等地把本表迁移推进共享迁移列表并升级到最新（表 9、时间索引 27、会话坐标列 35 各守自己的号）。 */
  private ensureSchema(): void {
    const { migrations } = this.store;
    for (const migration of [
      deliveryRecordMigration,
      deliveryTimeIndexMigration,
      deliveryConversationTargetMigration,
    ]) {
      if (!migrations.some((item) => item.version === migration.version)) {
        migrations.push(migration);
      }
    }
    this.store.upgrade();
  }

  [Service.init](): void {
    this.ensureSchema();
    this.ctx.logger.info(
      `[outbound-delivery-records] delivery_records 表就绪，迁移号段 ${String(DELIVERY_RECORD_MIGRATION_VERSION)}：` +
        '一次成功投递一行，主键即账本行 id（额度与经过分列两表，号段 1 的 usage_ledger 只数额度）·' +
        ` 会话坐标那一列取号段 ${String(DELIVERY_CONVERSATION_TARGET_MIGRATION_VERSION)}（按行选中的投递没有岗位 id 可记）`,
    );
  }
}

/**
 * 把一行的裸读数收窄成 `DeliveryRecord`（整数列按 number 处理，与账本/快照表同一口径）。
 * @param row `node:sqlite` 读出的原始行
 * @returns 类型收全的记录；两只坐标里缺的那一格从空串读回 null
 */
function toRecord(row: DeliveryRow): DeliveryRecord {
  return {
    ledgerId: Number(row.ledger_id ?? 0),
    platform: String(row.platform),
    jobId: coordinateOf(row.job_id),
    conversationTarget: coordinateOf(row.conversation_target),
    snapshotId: row.snapshot_id ?? null,
    ts: Number(row.ts ?? 0),
  };
}

declare module '@auto-cc/core' {
  interface AppServices {
    'outbound.deliveries': DeliveryRecordService;
  }
}
