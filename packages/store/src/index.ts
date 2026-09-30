/**
 * `store` 服务（spec 1.3-06 / 1.3-07 / 1.3-08）。
 *
 * 数据库用 `node:sqlite`（Electron 44 主进程内实测可用，见
 * `docs/acceptance/1.3/1.3-06-node-sqlite-in-electron.txt`），因此**没有原生编译依赖**，
 * 也就不需要 electron-rebuild——这是「用户只下载这一个 app」的前提。
 */
import { asApp, Service, type Context } from '@auto-cc/core';
import type { ConfigService } from '@auto-cc/plugin-config';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  readVersion,
  rollback,
  runMigrations,
  type Migration,
  type MigrationResult,
  type RollbackResult,
} from './migrate.js';

export const storeSchema = z.strictObject({
  /** 库文件目录；缺省用 `config.paths().userDataDir`（主进程会覆盖成 `app.getPath('userData')`）。 */
  dir: z.string().min(1).optional(),
  file: z.string().min(1).default('store.db'),
  journal: z.enum(['wal', 'delete']).default('wal'),
});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type StoreConfig = z.infer<typeof storeSchema>;

export class StoreService extends Service {
  static provide = 'store';
  static Config = storeSchema;
  static inject = ['config'];
  static envMap = { dir: 'AUTOCC_STORE_DIR' };

  /** cordis 把 `static Config` 校验后的配置作为构造器第二个实参传入，类型也从这里推导出调用点。 */
  private readonly options: StoreConfig;
  private database: DatabaseSync | undefined;
  private lastResult: MigrationResult = { from: 0, to: 0, applied: [] };

  /** 迁移清单：P1 阶段为空，1.9 的 `usage.ledger` 由业务插件 push 进来后再 `upgrade()`。 */
  readonly migrations: Migration[] = [];

  constructor(ctx: Context, options: StoreConfig) {
    super(ctx, 'store');
    this.options = options;
  }

  get db(): DatabaseSync {
    if (!this.database) throw new Error('store 尚未完成挂载');
    return this.database;
  }

  get isOpen(): boolean {
    return this.database !== undefined;
  }

  /** 当前 schema 版本（`PRAGMA user_version`，spec 1.3-07）。 */
  get version(): number {
    return readVersion(this.db);
  }

  get migrationResult(): MigrationResult {
    return this.lastResult;
  }

  /** 驱动与版本信息，供 1.3-06 的「主进程日志打印 sqlite 驱动与版本」断言。 */
  driverInfo(): string {
    const row = this.db.prepare('select sqlite_version() as v').get() as { v?: string };
    return `node:sqlite / sqlite ${row?.v ?? 'unknown'}`;
  }

  /** 执行未应用的迁移；重复调用是安全的（版本已到的一律跳过）。 */
  upgrade(): MigrationResult {
    this.lastResult = runMigrations(this.db, this.migrations);
    return this.lastResult;
  }

  /**
   * 把 schema 倒回指定版本（spec 2.3-05 的「migration 可回滚」实测入口）。
   * @param toVersion 回到的版本号，0 表示回到一张表都没有
   * @returns 实际倒回去的版本列表；途中遇到缺 `down` 的迁移会抛出且版本不动
   * @throws 目标版本非法、高于当前版本，或迁移没有 `down`
   */
  rollback(toVersion: number): RollbackResult {
    const result = rollback(this.db, this.migrations, toVersion);
    this.ctx.logger.info(
      `schema 已回滚：${String(result.from)}→${String(result.to)}（倒回 ${String(result.reverted.length)} 版）`,
    );
    return result;
  }

  /**
   * `config` 服务句柄（库文件目录的来源）。
   *
   * 为什么要显式写这个类型：`asApp(ctx).config` 能读全靠 `plugin-config` 对 `AppServices` 的增补，
   * 而那份增补只有在它的模块被类型图看见时才存在。本包过去只在自己的测试里 import 它，
   * 于是任何把 `store/src` 拉进编译的生产包（1.9 的 entitlement 是第一个）都会报「config 不存在」。
   */
  private get configService(): ConfigService {
    return asApp(this.ctx).config;
  }

  [Service.init](): void {
    const dir = this.options.dir ?? this.configService.paths().userDataDir;
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, this.options.file));
    db.exec(`PRAGMA journal_mode = ${this.options.journal}`);
    this.database = db;
    // 连接由 effect 回收：依赖失效、restart、退出都走这里，只 close 不删文件。
    // 注意 `ctx.effect(fn)` 会**立刻执行 fn 拿回收器**，所以必须是「返回函数」的函数，
    // 写成单层箭头就是刚挂载就把连接关掉了。
    this.ctx.effect(
      () => () => {
        db.close();
        if (this.database === db) this.database = undefined;
      },
      'store.db',
    );

    const result = this.upgrade();
    this.ctx.logger.info(
      `store 就绪：${join(dir, this.options.file)}｜${this.driverInfo()}｜schema ${String(result.from)}→${String(result.to)}`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    store: StoreService;
  }
}
