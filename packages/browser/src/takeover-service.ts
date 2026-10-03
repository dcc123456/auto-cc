/**
 * `browser.takeover`：「这块页面正在被人用手操作」这件事的**唯一状态源**（spec 5.5-01 / 02 / 09，plan §7.3 决策 1）。
 *
 * 为什么长在 `packages/browser` 而不是新建一个包、也不是并进 `workflow`：接管的事实是「那块内核视图
 * 当前在谁手里」，属浏览器域（AGENTS.md §4.3 先问属于哪个已有包）。今天接管只有工作流那一路有
 * （`WorkflowRunView.requiresHuman`），agent 这一路根本没有这个概念，于是「人去页面上点了验证码」
 * 系统里没有任何一处知道——那正是 5.5-02 要拦的情形。
 *
 * 三条对外形状：`begin` / `end` 两个写入点 + `held` 一口现读，加一条 `browser/takeover-changed` 事件。
 * 两件事分得很开，不要混：
 * - **内存里那份是「此刻的读数」**，给判定口与界面用；进程重启它就回落到「没在接管」，那是如实
 *   （没人能证明重启之后仍然有一双手停在页面上），与 `WorkflowRunView.takeoverHandled` 只活在内存里同口径；
 * - **表里那份是「发生过什么」**，号段 21 的 `takeover_events`，5.5-09 要的「谁在何时动了页面」只从这儿回答。
 *   所以它必须落库而不是配置键：装配面板写配置只改内存里的运行时层，重启即失（AGENTS.md §9 的 5.3-b 实测条）。
 *
 * 消费侧的分工写在各自的注释里：`agent.policy.decide` 问它「这一步能不能动手」（5.5-02 的判据本体），
 * `agent.loop` 问它「这条 run 该落成什么终态」（5.5-09 要说清是谁拦的）。
 */
import {
  Service,
  asApp,
  type Context,
  type TakeoverActor,
  type TakeoverAuditRow,
  type TakeoverBeginInput,
  type TakeoverEndInput,
  type TakeoverEventKind,
  type TakeoverReason,
  type TakeoverStateView,
} from '@auto-cc/core';
import type { StoreService } from '@auto-cc/plugin-store';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

/**
 * 接管态服务**无可调项**（空 strictObject，形状同 `agent.policy`）。
 *
 * 为什么连「审计取多少条」都不放进来：`audit(limit)` 的实参每次由调用方给，做成配置键就等于
 * 同一件事有两个答案来源（§2.5）；更硬的一条是——本服务被 `agent.policy` 与 `agent.loop` 写进了
 * `static inject`，改它的配置会连带重建正在跑循环的那两个插件（AGENTS.md §9 的 2.5 实测），
 * 而「改一个审计条数把在途的 run 打断」绝不是这一口的本意。
 */
export const browserTakeoverSchema = z.strictObject({});

/** 校验后的配置形状（调用点与测试引用它，而不是手写一遍 zod 推断）。 */
export type BrowserTakeoverConfig = z.output<typeof browserTakeoverSchema>;

/**
 * 迁移号段 **21**（5.5-a 起）：接管事件表一张。
 *
 * 必须新开号段而不是挂到 20（`workflow_plans`）的 `up` 上：`runMigrations` 的判据是
 * 「`schema_migrations` 台账里这一版记过账没有」，**已记账的版本永不重跑**（§9 的 5.3-a 实测条），
 * 挂上去的 DDL 在老库（含本机开发实例）上根本执行不到，运行期才以 `no such table` 失败。
 * 单测照不出来：每个用例都从空库起，所有迁移都是头一回跑。
 */
export const BROWSER_TAKEOVER_MIGRATION_VERSION = 21;

/** 接管事件表的建表迁移；`up` 只写 DDL（与号段 18 同一口径）。 */
const browserTakeoverMigration = {
  version: BROWSER_TAKEOVER_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS takeover_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      reason TEXT,
      actor TEXT,
      run_id TEXT,
      node_id TEXT,
      created_at INTEGER NOT NULL
    )`);
    // 审计的两种查法各一条索引：按时间倒序回看整段接管史，按 run 查「那次任务期间谁动过页面」
    // （5.5-09 的验证操作就是「查 run 记录含接管时间段」，没这两条就是全表扫）。
    db.exec('CREATE INDEX IF NOT EXISTS takeover_events_created ON takeover_events (created_at, id)');
    db.exec('CREATE INDEX IF NOT EXISTS takeover_events_run ON takeover_events (run_id, created_at)');
  },
};

/**
 * `begin` / `end` 的入参形状**不在这里定义**：它们是跨进程契约的一部分（渲染层要按它调那两只按钮），
 * 而 `packages/shared` 不能 import 领域包，所以两张形状与 `TakeoverStateView` 同住在 `@auto-cc/core`
 * （`WorkflowNodeSpec` 同例）。本文件把它们转出，是为了让 `src/index.ts` 这一个包入口仍然给得出完整的一套。
 */
export type { TakeoverBeginInput, TakeoverEndInput } from '@auto-cc/core';

/**
 * 接管态的一次读数（内存里那份，`TakeoverStateView` 的宿主）。
 *
 * 只有这一个出口能改它，所以不需要 getter/setter：`reason` 与 `startedAt` 只在 `isHeld` 为真时有值，
 * 三者同生同灭，于是界面不可能读到「没在接管却带着一个原因」。
 */
type HeldState = {
  isHeld: boolean;
  reason: TakeoverReason | null;
  startedAt: number | null;
  beginCount: number;
  endCount: number;
};

export class BrowserTakeoverService extends Service {
  static provide = 'browser.takeover';
  static Config = browserTakeoverSchema;
  static inject = ['store'];

  /** 当前接管态；进程内状态，重启回落到「没在接管」（见文件头第二条分工）。 */
  private readonly state: HeldState = { isHeld: false, reason: null, startedAt: null, beginCount: 0, endCount: 0 };

  constructor(
    ctx: Context,
    private readonly config: BrowserTakeoverConfig,
  ) {
    super(ctx, 'browser.takeover');
  }

  /** store 句柄：审计那张表的唯一去处（号段 21）。 */
  private get store(): StoreService {
    return asApp(this.ctx).store;
  }

  /**
   * 进入接管（spec 5.5-01 的「任意时刻用户可接管」的写入半边）。
   *
   * **已在接管中时幂等**：不写第二条 `begin` 行、不改 `startedAt`、不发事件，只把当前读数回给调用方。
   * 为什么必须是幂等而不是「后一次覆盖前一次」：风控信号会连发（一次导航 403 之后页面自己跳转又撞一次 429），
   * 覆盖就把接管起点往后推、把第一个原因抹掉，于是「已经卡在这儿多久、到底因为什么」这两件
   * 界面上要说的话与审计要对的账全丢了。
   * @param input 原因 + 归属（run / 节点）+ 由谁写下
   * @returns 变更后的接管读数；连发时返回的就是那**第一轮**接管的读数，不抛异常
   */
  begin(input: TakeoverBeginInput): TakeoverStateView {
    if (this.state.isHeld) return this.view();
    const at = Date.now();
    this.state.isHeld = true;
    this.state.reason = input.reason;
    this.state.startedAt = at;
    this.state.beginCount += 1;
    this.writeEvent('begin', input.reason, input.actor, input.runId ?? null, input.nodeId ?? null, at);
    this.ctx.logger.warn(`页面已交给人工接管（原因：${input.reason} · 由 ${input.actor} 写下）`);
    return this.publish();
  }

  /**
   * 解除接管（spec 5.5-09 的另一半：恢复也要留下一行，不然审计只看得见开始）。
   *
   * 不在接管中时同样幂等返回：界面上的「恢复」按钮与循环里的收尾都可能被按/被调第二次，
   * 那不该凭空多出一条「解除了一次从未发生的接管」——那种行会把 5.5-09 的配对读数弄脏。
   * @param input 归属信息（只为把 `end` 行对上它结束的那一轮）与解除者
   * @returns 变更后的接管读数（`isHeld` 为 false），不抛异常
   */
  end(input: TakeoverEndInput = {}): TakeoverStateView {
    if (!this.state.isHeld) return this.view();
    const at = Date.now();
    // 原因写在 end 行里而不是留空：回看时「这一轮解除的是因为风控的那次接管」必须一眼对得上。
    const reason = this.state.reason;
    this.state.isHeld = false;
    this.state.reason = null;
    this.state.startedAt = null;
    this.state.endCount += 1;
    this.writeEvent('end', reason, input.actor ?? 'user', input.runId ?? null, input.nodeId ?? null, at);
    this.ctx.logger.info(`人工接管已解除（原先因为：${String(reason)}），自动化可以在下一个安全点恢复`);
    return this.publish();
  }

  /**
   * 现读接管态（判定口与界面的唯一读路，spec 5.5-02 的判据对象）。
   *
   * 「现读」指的是不缓存**别人的**状态：调用方每次问都从这一处取，本服务也不去问别人（§9 的 2.5 实测条——
   * 在本地存第二份事实，改配置重建插件之后就会静默变空）。
   * @returns 当前读数；没在接管时 `isHeld` 为 false、原因与开始时刻为 null，永不抛异常
   */
  held(): TakeoverStateView {
    return this.view();
  }

  /**
   * 回看最近的接管 / 解除流水（spec 5.5-09 的「可审计谁在何时动了页面」）。
   * @param limit 最多取多少条；由调用方每次显式给（见 `browserTakeoverSchema` 的注释），
   *   非正数与 NaN 一律钳到 1，超过 500 钳到 500——审计是回看用的，不打算做成全量导出（同 5.3-b 的白名单审计口径）
   * @returns 按时刻倒序（最新在前）的行；从没接管过是空数组
   */
  audit(limit: number): TakeoverAuditRow[] {
    const bounded = Math.min(500, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 1)));
    const rows = this.store.db
      .prepare(
        `SELECT id, kind, reason, actor, run_id, node_id, created_at FROM takeover_events
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(bounded) as unknown as {
      id: number | bigint;
      kind: string;
      reason: string | null;
      actor: string | null;
      run_id: string | null;
      node_id: string | null;
      created_at: number | bigint;
    }[];
    return rows.map((row) => ({
      id: Number(row.id),
      // 认不出的值不当成任何一类：这两列各只有两个写点，读成别的就是把脏值放行（同 5.3-b 的审计读法）。
      kind: row.kind === 'begin' || row.kind === 'end' ? row.kind : 'end',
      reason: isTakeoverReason(row.reason) ? row.reason : null,
      actor: row.actor === 'user' || row.actor === 'system' ? row.actor : null,
      runId: row.run_id,
      nodeId: row.node_id,
      createdAt: Number(row.created_at),
    }));
  }

  [Service.init](): void {
    this.ensureSchema();
    // 5.5-07 的自动接管：登录失效与风控（含验证码，判据就是风控文案那一条）都直接把页面交回给人。
    // 订阅的是**已有的两条信号**，不新做检测——`browser.risk` 负责观测（2.7-c）、`sessions` 负责登录态，
    // 本服务只是把「所以现在该由人动手」这件事收敛成一个状态源 + 一行审计，别处不再各存一份标志（§2.5）。
    // 摘除函数交给 effect：插件被停掉时不留一个还在往里写接管的哑 listener。
    const offRisk = this.ctx.on('browser/risk-signal', (event) => {
      this.begin({ reason: 'risk', actor: 'system' });
      this.ctx.logger.warn(`风控已把页面交回人工接管（${event.platform} · ${event.kind}：${event.detail}）`);
    });
    this.ctx.effect(() => offRisk, 'browser.takeover.risk-signal');
    const offExpired = this.ctx.on('session/expired', () => {
      this.begin({ reason: 'session-expired', actor: 'system' });
    });
    this.ctx.effect(() => offExpired, 'browser.takeover.session-expired');
    this.ctx.logger.info(
      `人工接管态就绪（无可调项，配置 ${JSON.stringify(this.config)}）：begin / end 各落一行审计，` +
        `当前 ${this.state.isHeld ? '在接管中' : '未接管'}`,
    );
  }

  /**
   * 把当前内存读数拼成对外视图。
   * @returns 可以直接进事件载荷与跨进程返回值的那份对象（每次新造，调用方改不坏内部状态）
   */
  private view(): TakeoverStateView {
    return {
      isHeld: this.state.isHeld,
      reason: this.state.reason,
      startedAt: this.state.startedAt,
      beginCount: this.state.beginCount,
      endCount: this.state.endCount,
    };
  }

  /**
   * 发一条 `browser/takeover-changed` 并回载荷（两个写入点共用，§2.2）。
   * @returns 刚发出去的那份读数，调用方直接把它当返回值
   */
  private publish(): TakeoverStateView {
    const view = this.view();
    this.ctx.emit('browser/takeover-changed', view);
    return view;
  }

  /**
   * 落一行接管审计。
   *
   * 与状态变更**同一次调用里顺序执行**、不包事务：这张表只记「发生过」，读它的人要的是时刻对得上，
   * 而不是一个「也许写进去了」的批量账（§2.6：不为不会发生的场景加异常处理）。
   * @param kind begin 还是 end
   * @param reason 这一轮接管的原因（end 行带的是它结束的那一轮的原因）
   * @param actor 由谁写下
   * @param runId 归属的 run；无归属为 null
   * @param nodeId 归属的节点；无归属为 null
   * @param at 毫秒时刻（由调用点取一次，保证 `startedAt` 与审计行是同一个数）
   */
  private writeEvent(
    kind: TakeoverEventKind,
    reason: TakeoverReason | null,
    actor: TakeoverActor,
    runId: string | null,
    nodeId: string | null,
    at: number,
  ): void {
    this.store.db
      .prepare(
        `INSERT INTO takeover_events (kind, reason, actor, run_id, node_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(kind, reason, actor, runId, nodeId, at);
  }

  /**
   * 幂等登记号段 21 并建表。
   *
   * 幂等是硬要求：`plugins.start('browser-takeover')` 会重新构造本服务，无条件 push 同一个 version
   * 会让 `runMigrations` 抛「迁移版本重复」（与 `agent.policy` 的 `ensureSchema` 同一口径）。
   */
  private ensureSchema(): void {
    const migrations = this.store.migrations;
    if (!migrations.some((registered) => registered.version === BROWSER_TAKEOVER_MIGRATION_VERSION)) {
      migrations.push(browserTakeoverMigration);
    }
    this.store.upgrade();
  }
}

/**
 * 认一下库里读回来的 reason 是不是枚举里的值。
 * @param raw 列的原始读数（可空，也可能是改名之前的旧值）
 * @returns 收窄后的判定；不认的一律当「这一行的原因已不可解释」，由调用方读成 null
 */
function isTakeoverReason(raw: string | null): raw is TakeoverReason {
  return raw === 'manual' || raw === 'risk' || raw === 'session-expired';
}

declare module '@auto-cc/core' {
  interface AppServices {
    'browser.takeover': BrowserTakeoverService;
  }
}
