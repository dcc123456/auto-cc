/**
 * `outbound.authorization` 服务（plan §12.2 / spec 10.6-01～10.6-08）：无人值守投递的**一次性授权单**。
 *
 * 它只回答一个问题：「这一笔外发现在合不合法」。判定之外的每一件事都还给既有服务，本服务不建第二份事实：
 * - 额度、被拒流水、四元组去重、停用开关、成功账与投递记录仍归 `entitlement.gate` / `usage.ledger`
 *   （`dispatch()` 只是先判授权、再把闭包原样交给 `gate.performOutbound()`）；
 * - 节奏仍归 `outbound.throttle`（本服务不掷间隔、不 sleep）；
 * - 风控观测仍归 `browser.risk`（本服务只订阅它已经发出的 `browser/risk-signal`，不识别、不规避、不重试）。
 *
 * 授权单三要素（日限额 / 岗位范围 / 简历版本）写死在一行里，缺一项就不许开跑；「平台 + 岗位范围」按显式勾选
 * 的集合判，不做「全部岗位」或关键词扩展（plan §12.2.1）。窗口是「本自然日 + 本次运行」：跨日由 `day_key`
 * 判、应用重启由 `[Service.init]` 把上一次进程留下的 `active/paused` 行改成 `restart-required`，
 * 于是**自动续跑在结构上不存在**——没有任何代码路径会自己把状态改回 `active`，只有 `reconfirm()`（人的入口）
 * 会。风控命中同样只做暂停，恢复也必须由人确认（plan §12.2.4）。
 *
 * 为什么表放在 `store` 的共享连接上而不是内存：重启后「未完成岗位转待办」要靠它活下来（10.6-02）。
 * 迁移号段取 **44**（本工作树已核到 43：`OUTBOUND_STATE_MIGRATION_VERSION`），两条声明形状都已核。
 */
import { AppError, asApp, maybeService, Service, type AppErrorCode, type Context } from '@auto-cc/core';
import {
  dayKey,
  startOfDay,
  type OutboundAttemptKey,
  type ResumeDocSummaryView,
  type RiskSignalEvent,
  type UnattendedAuthorizationStatus,
  type UnattendedAuthorizationView,
  type UnattendedGrantInput,
} from '@auto-cc/shared';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { ActionContext } from '@auto-cc/plugin-entitlement';

/**
 * 授权单表的迁移号段（plan §12.2；号段全局，撞号会在运行期以「迁移版本重复」抛）。
 *
 * 取 44 而不是回填既有号段：`runMigrations` 认的是台账里「这一版记过账没有」，把建表语句塞进
 * 已应用的号段里，在老库上根本执行不到（AGENTS.md §9 的 5.3-a 实测条）。
 */
export const UNATTENDED_AUTHORIZATION_MIGRATION_VERSION = 44;

/** 授权单允许的日限额区间（plan §12.2.1：整数 1–10 岗）。 */
export const UNATTENDED_DAILY_LIMIT_MIN = 1;
export const UNATTENDED_DAILY_LIMIT_MAX = 10;

/** 同岗 24 小时上限的窗口宽度（spec 10.6-08：同岗同动作 24 小时内最多一次，换版本也不叠加）。 */
export const SAME_JOB_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 开一张授权单的入参：跨进程形状来自 `@auto-cc/shared`，这里只多一个可注入的判定时刻。 */
export type UnattendedGrantRequest = UnattendedGrantInput & {
  /** 判定基准（毫秒）；省略取当前时间。界面不给它，用例靠它造跨日。 */
  nowMs?: number;
};

/**
 * 从版本串里取 doc id：`journey.*` 的版本口径是 `doc:<id>:<hash>`，内部调用也可以直接给 doc id。
 * @param version 版本串或 doc id
 * @returns doc id；空串返回 null
 */
function docIdOf(version: string): string | null {
  const raw = version.trim();
  if (raw === '') return null;
  const [prefix, id] = raw.split(':');
  if (raw.includes(':') && prefix === 'doc' && id !== undefined && id.trim() !== '') return id.trim();
  return raw;
}

/** 事实校验回执的只读口（`resume.generate.receiptOf` 的窄形状；本包不 import 简历包）。 */
interface FactCheckRecordSource {
  receiptOf(receiptId: string): {
    readonly docId: string;
    readonly jdId: string | null;
    readonly outcome: string;
    readonly violations: readonly unknown[];
  } | null;
}

/** 简历版本归属的只读口（`resume.doc.list()` 的窄形状：只认 id 与血缘）。 */
interface ResumeDocSource {
  list(): readonly Pick<ResumeDocSummaryView, 'id' | 'parentDocId' | 'jdId'>[];
}

/** `outbound_authorizations` 的裸行；出口统一收成 number 与 camelCase。 */
interface AuthorizationRow {
  id: number | bigint;
  platform: string;
  day_key: string;
  daily_limit: number | bigint;
  master_resume_version: string;
  resume_version: string;
  fact_check_receipt: string;
  targets_json: string;
  status: UnattendedAuthorizationStatus;
  pause_reason: string | null;
  updated_at: number | bigint;
}

/** 授权单表：一行 = 一张授权单；同一时刻最多一张处于 `active/paused/restart-required`。 */
const authorizationMigration = {
  version: UNATTENDED_AUTHORIZATION_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS outbound_authorizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      day_key TEXT NOT NULL,
      daily_limit INTEGER NOT NULL CHECK (daily_limit BETWEEN 1 AND 10),
      master_resume_version TEXT NOT NULL,
      resume_version TEXT NOT NULL,
      fact_check_receipt TEXT NOT NULL,
      targets_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'restart-required', 'expired', 'revoked')),
      pause_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    // 判据只查「当前那张单」与「今天推进了几个岗位」，两条索引各服务一条查询形态。
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_outbound_authorizations_status ON outbound_authorizations (status, updated_at)',
    );
  },
  down: (db: DatabaseSync) => {
    db.exec('DROP TABLE IF EXISTS outbound_authorizations');
  },
};

/** 无配置项：授权口径全部由入参与库里的那张单决定。 */
export const authorizationSchema = z.strictObject({});

/** 校验后的配置形状（调用点与测试引用它）。 */
export type AuthorizationConfig = z.infer<typeof authorizationSchema>;

export class OutboundAuthorizationService extends Service {
  static provide = 'outbound.authorization';
  static Config = authorizationSchema;
  /** 迁移与账本共用唯一那条 store 连接；放行口与账本同域（§2.7 禁第二个连接池）。 */
  static inject = ['store', 'usage.ledger', 'entitlement.gate'];

  constructor(ctx: Context, _options: AuthorizationConfig) {
    // 无配置项也要接住第二个实参：cordis 递的是校验后的配置（AGENTS.md §9 实测 1.3）。
    super(ctx, 'outbound.authorization');
  }

  /** 共享连接；审计读数与授权单落库都只走它。 */
  private get store() {
    return asApp(this.ctx).store;
  }

  /** 账本句柄：被拒流水、岗位名额与 24 小时窗口都从这一处现问，不另存内存副本。 */
  private get ledger() {
    return asApp(this.ctx)['usage.ledger'];
  }

  /** 放行口：`dispatch()` 判完授权后把闭包原样交给它，四元组去重与原子落账仍在那一处。 */
  private get gate() {
    return asApp(this.ctx)['entitlement.gate'];
  }

  /**
   * 开一张授权单：三要素与两份证据全部过关才落库，且新单一开就把上一张未结束的单作废。
   * @param input 平台、日限额、显式勾选的岗位集合、母版与定制版本、事实校验回执 id
   * @returns 新单的跨进程视图（`remaining` 按今天账本现算）
   * @throws `INVALID_ARGUMENT` 三要素形状不合法；`AUTHORIZATION_EVIDENCE_MISSING` / `AUTHORIZATION_FACT_CHECK_FAILED` /
   *         `AUTHORIZATION_VERSION_NOT_BOUND` 证据对不上——这三种都是「先去重新生成/定制」，不是改入参能过的
   */
  grant = (input: UnattendedGrantRequest): UnattendedAuthorizationView => {
    const nowMs = input.nowMs ?? Date.now();
    const platform = input.platform.trim();
    if (platform === '') throw new AppError('INVALID_ARGUMENT', '授权单缺少平台，不能开跑', 'outbound.authorization');
    const { dailyLimit, targets } = this.validateElements(input);
    const masterResumeVersion = input.masterResumeVersion.trim();
    const resumeVersion = input.resumeVersion.trim();
    if (masterResumeVersion === '' || resumeVersion === '') {
      throw new AppError(
        'INVALID_ARGUMENT',
        '授权单缺少简历版本：母版与定制版都必须绑定，缺一维不能开跑',
        'outbound.authorization',
      );
    }
    if (masterResumeVersion === resumeVersion) {
      throw new AppError(
        'INVALID_ARGUMENT',
        '授权单绑的定制简历版本与母版相同：定制版必须是独立的那一份变体',
        'outbound.authorization',
        { masterResumeVersion, resumeVersion },
      );
    }
    const factCheckReceiptId = input.factCheckReceiptId.trim();
    if (factCheckReceiptId === '') {
      throw new AppError(
        'INVALID_ARGUMENT',
        '授权单缺少事实校验回执 id，不能证明这一版过过校验',
        'outbound.authorization',
      );
    }
    this.assertEvidence(masterResumeVersion, resumeVersion, factCheckReceiptId);

    this.store.db
      .prepare(
        `UPDATE outbound_authorizations SET status = 'revoked', updated_at = ?
         WHERE status IN ('active', 'paused', 'restart-required')`,
      )
      .run(nowMs);
    this.store.db
      .prepare(
        `INSERT INTO outbound_authorizations
           (platform, day_key, daily_limit, master_resume_version, resume_version, fact_check_receipt,
            targets_json, status, pause_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
      )
      .run(
        platform,
        dayKey(nowMs),
        dailyLimit,
        masterResumeVersion,
        resumeVersion,
        factCheckReceiptId,
        JSON.stringify(targets),
        nowMs,
        nowMs,
      );
    const view = this.current(nowMs);
    if (view === null) throw new Error('授权单写入后读不到，停止外发');
    this.ctx.logger.info(
      `无人值守授权单已开：${platform} · ${dayKey(nowMs)} · 日限额 ${String(dailyLimit)} 岗 · ` +
        `岗位 ${targets.join('、')} · 定制版本 ${resumeVersion}`,
    );
    return view;
  };

  /**
   * 校验三要素里可离线判的两项（日限额与岗位范围），并归一化岗位集合。
   * @param input 原始入参
   * @returns 整数日限额与去重后的岗位集合
   * @throws `INVALID_ARGUMENT`：非整数、越界、空集合、超限额、重复项或空岗位名
   */
  private validateElements(input: UnattendedGrantRequest): { dailyLimit: number; targets: string[] } {
    const dailyLimit = input.dailyLimit;
    if (
      !Number.isInteger(dailyLimit) ||
      dailyLimit < UNATTENDED_DAILY_LIMIT_MIN ||
      dailyLimit > UNATTENDED_DAILY_LIMIT_MAX
    ) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `授权单的日限额必须是 ${String(UNATTENDED_DAILY_LIMIT_MIN)}–${String(UNATTENDED_DAILY_LIMIT_MAX)} 的整数岗位数`,
        'outbound.authorization',
        { dailyLimit },
      );
    }
    const targets = input.targets.map((target) => target.trim());
    if (targets.length === 0) {
      throw new AppError(
        'INVALID_ARGUMENT',
        '授权单没有勾选任何岗位：空集合不启动，也不代表"全部岗位"',
        'outbound.authorization',
      );
    }
    if (targets.some((target) => target === '')) {
      throw new AppError('INVALID_ARGUMENT', '授权单的岗位集合里有空值', 'outbound.authorization');
    }
    if (new Set(targets).size !== targets.length) {
      throw new AppError('INVALID_ARGUMENT', '授权单的岗位集合有重复项，数量口径会因此虚高', 'outbound.authorization');
    }
    if (targets.length > dailyLimit) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `授权单勾选了 ${String(targets.length)} 个岗位，超过日限额 ${String(dailyLimit)} 岗`,
        'outbound.authorization',
        { targetCount: targets.length, dailyLimit },
      );
    }
    return { dailyLimit, targets };
  }

  /**
   * 核对「这一版真的过过事实校验，且确实是母版为某段 JD 定制的变体」。
   *
   * 两条证据都按服务名现问（§2.7）：回执来自 `resume.generate`，版本血缘来自 `resume.doc`。
   * 任一只没挂载一律失败——「核不了」不等于「没问题」，绝不能静默放行（plan §12.2.1）。
   * @param masterResumeVersion 母版 id
   * @param resumeVersion 定制变体 id
   * @param receiptId 事实校验回执 id
   * @throws `AUTHORIZATION_EVIDENCE_MISSING` / `AUTHORIZATION_FACT_CHECK_FAILED` / `AUTHORIZATION_VERSION_NOT_BOUND`
   */
  private assertEvidence(masterResumeVersion: string, resumeVersion: string, receiptId: string): void {
    const generate = maybeService<FactCheckRecordSource>(this.ctx, 'resume.generate');
    const docs = maybeService<ResumeDocSource>(this.ctx, 'resume.doc');
    if (!generate || !docs) {
      throw new AppError(
        'AUTHORIZATION_EVIDENCE_MISSING',
        '授权单要核对事实校验回执与简历版本血缘，但生成/简历服务没有挂载，无法证明这一版可以外发',
        'outbound.authorization',
        { hasGenerate: generate !== undefined, hasDocs: docs !== undefined },
      );
    }
    const receipt = generate.receiptOf(receiptId);
    if (!receipt) {
      throw new AppError(
        'AUTHORIZATION_EVIDENCE_MISSING',
        `授权单引用的生成回执 ${receiptId} 查无此单，先重新生成一次再授权`,
        'outbound.authorization',
        { receiptId },
      );
    }
    if (receipt.outcome === 'rejected' || receipt.violations.length > 0) {
      throw new AppError(
        'AUTHORIZATION_FACT_CHECK_FAILED',
        `生成回执 ${receiptId} 没过事实校验（${String(receipt.violations.length)} 处违规），这一版不得外发`,
        'outbound.authorization',
        { receiptId, outcome: receipt.outcome },
      );
    }
    const masterDocId = docIdOf(masterResumeVersion);
    const tailoredDocId = docIdOf(resumeVersion);
    if (masterDocId === null || tailoredDocId === null) {
      throw new AppError(
        'AUTHORIZATION_VERSION_NOT_BOUND',
        '授权单的简历版本串解析不出 doc id：应为 doc:<id>:<hash> 或 doc id 本身',
        'outbound.authorization',
        { masterResumeVersion, resumeVersion },
      );
    }
    if (receipt.docId !== masterDocId) {
      throw new AppError(
        'AUTHORIZATION_VERSION_NOT_BOUND',
        `生成回执 ${receiptId} 属于母版 ${receipt.docId}，与授权单绑定的 ${masterResumeVersion} 对不上`,
        'outbound.authorization',
        { receiptId, receiptDocId: receipt.docId, masterResumeVersion },
      );
    }
    const variant = docs.list().find((doc) => doc.id === tailoredDocId);
    if (!variant || variant.parentDocId !== masterDocId) {
      throw new AppError(
        'AUTHORIZATION_VERSION_NOT_BOUND',
        `定制版本 ${resumeVersion} 不是母版 ${masterResumeVersion} 的变体，授权单不能拿它当外发版本`,
        'outbound.authorization',
        { resumeVersion, masterResumeVersion, found: variant !== undefined },
      );
    }
    if (receipt.jdId !== null && variant.jdId !== null && receipt.jdId !== variant.jdId) {
      throw new AppError(
        'AUTHORIZATION_VERSION_NOT_BOUND',
        `定制版本 ${resumeVersion} 是为另一段 JD 生成的，与回执 ${receiptId} 对不上`,
        'outbound.authorization',
        { receiptId, receiptJdId: receipt.jdId, variantJdId: variant.jdId },
      );
    }
  }

  /**
   * 判定「这一笔外发现在合不合法」。五种越权情形都在这一处判完（spec 10.6-06）：
   * ①岗位不在集合 ②超日限额 ③简历版本不匹配 ④窗口外 ⑤重启未重新确认；另加停用与风控暂停。
   * 被拒一律先记一条 `usage_denials`（失败侧不落成功账），再以结构化错误上浮。
   * @param action greet/deliver
   * @param context 平台、岗位、简历版本与判定时刻
   * @throws `UNATTENDED_NOT_AUTHORIZED` / `AUTHORIZATION_RECONFIRM_REQUIRED` / `OUTBOUND_RISK_PAUSED` /
   *         `OUTBOUND_DISABLED` / `AUTHORIZATION_WINDOW_CLOSED` / `OUTBOUND_TARGET_NOT_AUTHORIZED` /
   *         `OUTBOUND_RESUME_VERSION_NOT_AUTHORIZED` / `AUTHORIZATION_QUOTA_EXHAUSTED` / `OUTBOUND_SAME_JOB_WINDOW`
   */
  authorize = (action: OutboundAttemptKey['action'], context: ActionContext = {}): void => {
    const nowMs = context.nowMs ?? Date.now();
    const platform = context.platform?.trim() ?? '';
    const targetId = context.targetId?.trim() ?? '';
    const resumeVersion = context.resumeVersion?.trim() ?? '';
    if (platform === '' || targetId === '' || resumeVersion === '') {
      throw new AppError(
        'INVALID_ARGUMENT',
        '无人值守外发必须给全 platform + targetId + resumeVersion，缺一维就无法判定是否越权',
        'outbound.authorization',
        { action, platform, targetId, hasResumeVersion: resumeVersion.length > 0 },
      );
    }
    const row = this.currentRow();
    if (row === null || row.status === 'revoked' || row.status === 'expired') {
      this.deny(action, context, nowMs, 'UNATTENDED_NOT_AUTHORIZED', '没有有效的无人值守授权单，先由人开一张再跑');
    }
    if (row.status === 'restart-required') {
      this.deny(
        action,
        context,
        nowMs,
        'AUTHORIZATION_RECONFIRM_REQUIRED',
        '授权单来自上一次运行（或应用重启过）：未完成岗位已转待办，需要人再确认一次才能续跑',
      );
    }
    if (row.status === 'paused') {
      this.deny(action, context, nowMs, 'OUTBOUND_RISK_PAUSED', row.pause_reason ?? '本轮已暂停，需要人确认后才能续跑');
    }
    if (this.ledger.outboundStatus().stopped) {
      this.deny(action, context, nowMs, 'OUTBOUND_DISABLED', '动作未执行：外发已一键停用；恢复后仍需重新确认与对账');
    }
    if (row.day_key !== dayKey(nowMs)) {
      this.markExpired(Number(row.id), nowMs);
      this.deny(
        action,
        context,
        nowMs,
        'AUTHORIZATION_WINDOW_CLOSED',
        `授权单只对 ${row.day_key} 有效，今天是 ${dayKey(nowMs)}：跨日不自动续跑`,
      );
    }
    if (row.platform !== platform) {
      this.deny(
        action,
        context,
        nowMs,
        'OUTBOUND_TARGET_NOT_AUTHORIZED',
        `授权单只覆盖 ${row.platform}，不覆盖 ${platform}`,
      );
    }
    const targets = JSON.parse(row.targets_json) as readonly string[];
    if (!targets.includes(targetId)) {
      this.deny(action, context, nowMs, 'OUTBOUND_TARGET_NOT_AUTHORIZED', `岗位 ${targetId} 不在本次授权集合里`);
    }
    // 版本维度：授权单上那一版直接放行；批量执行器逐岗定制出的**同一母版变体**也放行，
    // 但必须满足两个可核条件——血缘指回授权母版、JD 归因正好是本笔的岗位（否则就是拿别的岗位的稿子套这单）。
    // 它来自 generate.accept 的产物，事实校验已在生成/接受那一步把门（10.3-02），这里不重复跑模型。
    if (row.resume_version !== resumeVersion) {
      const docs = maybeService<ResumeDocSource>(this.ctx, 'resume.doc');
      const masterDocId = docIdOf(row.master_resume_version);
      const variantDocId = docIdOf(resumeVersion);
      const variant =
        docs === undefined || masterDocId === null || variantDocId === null
          ? undefined
          : docs.list().find((doc) => doc.id === variantDocId);
      const derivedForTarget =
        variant !== undefined && variant.parentDocId === masterDocId && variant.jdId === targetId;
      if (!derivedForTarget) {
        this.deny(
          action,
          context,
          nowMs,
          'OUTBOUND_RESUME_VERSION_NOT_AUTHORIZED',
          `简历版本 ${resumeVersion} 未在本次授权单上，也不是授权母版为岗位 ${targetId} 定制的变体`,
        );
      }
    }
    // 岗位名额按账本现算（不是本表自己记数）：同一岗位的打招呼与投递共享一个名额。
    const advanced = new Set(this.ledger.advancedTargetsSince(platform, startOfDay(nowMs)));
    if (!advanced.has(targetId) && advanced.size >= Number(row.daily_limit)) {
      this.deny(
        action,
        context,
        nowMs,
        'AUTHORIZATION_QUOTA_EXHAUSTED',
        `今日已推进 ${String(advanced.size)} 个岗位，达到授权日限额 ${String(row.daily_limit)} 岗；用尽即停`,
      );
    }
    // 精确四元组的重放交给闸门报 `OUTBOUND_ALREADY_SENT` / `OUTBOUND_RECONCILIATION_REQUIRED`（同一份持久化事实，
    // 别在这里编第二种说法）；这一条只在「同一岗位 + 同一动作、换了版本」时才补刀。
    const exact = this.gate.outboundAttempt(action, context);
    if (exact === null && this.ledger.hasAttemptSince(platform, targetId, action, nowMs - SAME_JOB_WINDOW_MS)) {
      this.deny(
        action,
        context,
        nowMs,
        'OUTBOUND_SAME_JOB_WINDOW',
        `同一岗位 24 小时内已经${action === 'greet' ? '打过招呼' : '投递过'}，换简历版本也不叠加`,
      );
    }
  };

  /**
   * 无人值守外发的唯一执行口：先判授权，再把闭包原样交给 `entitlement.gate.performOutbound`。
   *
   * 刻意不在本方法里掷间隔或 `sleep`：节奏归 `outbound.throttle`，而编排层要在**等间隔之前**先问额度与授权，
   * 否则被拒的一笔会先白等一个频控周期（与 `gate.enforce` 的顺序口径一致）。
   * @param action greet/deliver
   * @param context 平台、岗位、简历版本与判定时刻
   * @param task 真正的页面动作；只允许执行一次
   * @param writeDelivery 成功时与账本同事务写 `delivery_records` 的回调
   * @returns 页面返回值与一对一账本行
   * @throws 授权拒绝见 `authorize`；重放/未知/额度等沿用闸门的结构化错误
   */
  dispatch = async <T>(
    action: OutboundAttemptKey['action'],
    context: ActionContext,
    task: () => Promise<{ value: T; receiptId?: string | null }>,
    writeDelivery?: (ledgerId: number) => void,
  ): Promise<{ value: T; ledgerId: number }> => {
    this.authorize(action, context);
    return this.gate.performOutbound(action, context, task, writeDelivery);
  };

  /**
   * 当前授权单（界面与测试的读口）；没有任何单时为 null。
   * @param nowMs 计算剩余名额的基准（毫秒），省略取当前时间
   * @returns 最近一张单的视图，含今日剩余岗位名额
   */
  current = (nowMs = Date.now()): UnattendedAuthorizationView | null => {
    const row = this.currentRow();
    if (row === null) return null;
    const targets = JSON.parse(row.targets_json) as readonly string[];
    const sameDay = row.day_key === dayKey(nowMs);
    // 跨日或已作废的单不把「今天的账本」当成自己的进度：剩余名额报 0、待办报全量，界面据此说「要重新授权」。
    const advanced = sameDay
      ? new Set(this.ledger.advancedTargetsSince(row.platform, startOfDay(nowMs)))
      : new Set<string>();
    const isOpen = row.status === 'active' || row.status === 'paused' || row.status === 'restart-required';
    const remaining = isOpen && sameDay ? Math.max(0, Number(row.daily_limit) - advanced.size) : 0;
    return {
      id: Number(row.id),
      platform: row.platform,
      dayKey: row.day_key,
      dailyLimit: Number(row.daily_limit),
      targets: [...targets],
      masterResumeVersion: row.master_resume_version,
      resumeVersion: row.resume_version,
      factCheckReceiptId: row.fact_check_receipt,
      status: row.status,
      pauseReason: row.pause_reason,
      remaining,
      pendingTargets: [...targets.filter((target) => !advanced.has(target))],
      updatedAt: Number(row.updated_at),
    };
  };

  /**
   * 人确认「从断点继续」：只对仍然存在的那张单生效，状态回到 `active` 并把窗口改成今天。
   *
   * 它是**唯一**能把状态改回 `active` 的入口，且必须由人显式调用；服务自身从不自动调用它
   * （plan §12.2.2：重启与跨日都不自动续跑，暂停也不自动恢复）。续跑前应先对账（由调用方按账本做）。
   * @param nowMs 确认时刻（毫秒）
   * @returns 恢复后的授权单视图
   * @throws `UNATTENDED_NOT_AUTHORIZED`：没有可续跑的单；`OUTBOUND_DISABLED`：外发总开关还停着
   */
  reconfirm = (nowMs = Date.now()): UnattendedAuthorizationView => {
    const row = this.currentRow();
    if (row === null || row.status === 'revoked') {
      throw new AppError('UNATTENDED_NOT_AUTHORIZED', '没有可续跑的授权单，请重新开一张', 'outbound.authorization');
    }
    if (this.ledger.outboundStatus().stopped) {
      throw new AppError(
        'OUTBOUND_DISABLED',
        '外发仍处于一键停用状态，先恢复总开关再确认续跑',
        'outbound.authorization',
      );
    }
    this.store.db
      .prepare(
        `UPDATE outbound_authorizations SET status = 'active', day_key = ?, pause_reason = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(dayKey(nowMs), nowMs, row.id);
    const view = this.current(nowMs);
    if (view === null) throw new Error('授权单续跑后读不到，停止外发');
    this.ctx.logger.info(
      `无人值守授权单已由人确认续跑：${view.platform} · ${view.dayKey} · 剩余 ${String(view.remaining)} 岗`,
    );
    return view;
  };

  /**
   * 作废当前授权单（人主动收回范围时用）；停用总开关另有 `entitlement.gate.setOutboundStopped`。
   * @param nowMs 作废时刻（毫秒）
   * @returns 作废后的视图；本来就没有单时为 null
   */
  revoke = (nowMs = Date.now()): UnattendedAuthorizationView | null => {
    const row = this.currentRow();
    if (row === null) return null;
    this.store.db
      .prepare(`UPDATE outbound_authorizations SET status = 'revoked', updated_at = ? WHERE id = ?`)
      .run(nowMs, row.id);
    return this.current(nowMs);
  };

  /**
   * 风控信号到达：把本轮整轮暂停，记住信号原文；不重试、不识别、不自动恢复（plan §12.2.4）。
   * @param event `browser.risk` 发出的信号（只读当事人）
   */
  private handleRiskSignal = (event: RiskSignalEvent): void => {
    const row = this.currentRow();
    if (row === null || row.status !== 'active') return;
    if (row.platform !== event.platform) return;
    if (row.day_key !== dayKey(event.at)) return;
    const reason = `命中风控（${event.kind}：${event.detail}），整轮已暂停，需要你来确认；在此之前不再外发`;
    this.store.db
      .prepare(`UPDATE outbound_authorizations SET status = 'paused', pause_reason = ?, updated_at = ? WHERE id = ?`)
      .run(reason, event.at, row.id);
    this.ctx.emit('outbound/authorization-paused', { platform: row.platform, reason, at: event.at });
    this.ctx.logger.warn(`无人值守投递已整轮暂停：${reason}`);
  };

  /**
   * 记一条被拒流水并按同一码抛错——五种越权与停用/风控共用这一条路径，不留「拒了但没留痕」的缝。
   * @param action 动作名
   * @param context 判定上下文
   * @param nowMs 判定时刻
   * @param code 错误码（也是被拒流水的 code 列）
   * @param reason 给人读的拒因原文
   * @throws 恒抛 `AppError(code, reason, 'outbound.authorization')`
   */
  private deny(
    action: OutboundAttemptKey['action'],
    context: ActionContext,
    nowMs: number,
    code: AppErrorCode,
    reason: string,
  ): never {
    this.ledger.recordDenial({
      action,
      targetId: context.targetId ?? null,
      workflowRunId: context.workflowRunId ?? null,
      nowMs,
      code,
      reason,
    });
    throw new AppError(code, reason, 'outbound.authorization', {
      action,
      platform: context.platform ?? null,
      targetId: context.targetId ?? null,
    });
  }

  /** 读当前那张单（最近一张），不判断状态。 */
  private currentRow(): AuthorizationRow | null {
    const row = this.store.db
      .prepare(
        `SELECT id, platform, day_key, daily_limit, master_resume_version, resume_version, fact_check_receipt,
                targets_json, status, pause_reason, updated_at
         FROM outbound_authorizations ORDER BY id DESC LIMIT 1`,
      )
      .get() as AuthorizationRow | undefined;
    return row ?? null;
  }

  /** 跨日判定后把那张单标成 `expired`（幂等：本来就是 expired 时不写库）。 */
  private markExpired(id: number, nowMs: number): void {
    this.store.db
      .prepare(
        `UPDATE outbound_authorizations SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'active'`,
      )
      .run(nowMs, id);
  }

  /**
   * 把上一次进程留下的未结束授权单改成 `restart-required`。
   *
   * 这就是「重启后不自动续跑」的结构保证：新进程启动时没有任何路径能把旧单直接当成 `active`，
   * 未完成岗位因此只能等人 `reconfirm()`（10.6-02）。
   * @param nowMs 本次挂载时刻（毫秒）
   */
  private markStaleRuns(nowMs: number): void {
    const result = this.store.db
      .prepare(
        `UPDATE outbound_authorizations SET status = 'restart-required', updated_at = ?
         WHERE status IN ('active', 'paused')`,
      )
      .run(nowMs);
    if (Number(result.changes) > 0) {
      this.ctx.logger.info(`发现 ${String(result.changes)} 张上次运行留下的授权单：已转待办，需人重新确认后才续跑`);
    }
  }

  [Service.init](): void {
    const migrations = this.store.migrations;
    if (!migrations.some((migration) => migration.version === UNATTENDED_AUTHORIZATION_MIGRATION_VERSION)) {
      migrations.push(authorizationMigration);
    }
    this.store.upgrade();
    this.markStaleRuns(Date.now());
    // 风控暂停只订阅既有的信号：识别、规避与重试都不在这里（AGENTS.md §8.3）。
    const offRisk = this.ctx.on('browser/risk-signal', this.handleRiskSignal);
    this.ctx.effect(() => offRisk, 'outbound.authorization.risk-signal');
    this.ctx.logger.info(
      `无人值守授权闸门就绪：日限额 ${String(UNATTENDED_DAILY_LIMIT_MIN)}–${String(UNATTENDED_DAILY_LIMIT_MAX)} 岗 · ` +
        `同岗 ${String(SAME_JOB_WINDOW_MS / 3_600_000)} 小时上限 · 表 schema v${String(UNATTENDED_AUTHORIZATION_MIGRATION_VERSION)}`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'outbound.authorization': OutboundAuthorizationService;
  }
}
