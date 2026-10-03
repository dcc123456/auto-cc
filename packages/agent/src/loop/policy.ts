/**
 * `agent.policy`：一次任务里「这一步现在到底能不能执行」的唯一判定口（spec 5.2-02 / 07）。
 *
 * 循环的每一步都必须经过它，且它**只看三样东西**：当前档位、计划确认了没有、这只手在注册表里的真相。
 * 请求里没有 `effect` 也没有「模型说它安全」那一位——不是漏了，是刻意不给：
 * 副作用分级由判定者现读注册表（`list()` 里那份），模型的自述在这条口上根本没有入口，
 * 于是 5.2-07 要的不是「我们忽略了模型的话」，而是「模型没有一条可以表态的通道」。
 *
 * 5.2 立的是这个口本身；5.3-a 把档位语义钉成真值表；5.3-b 在这里接上**免确认白名单**——
 * 它是本服务自己的读数（表 + 唯一写入口 + 审计），不是请求方带进来的主张，所以判定请求那三位一个字都没改。
 * 两类暂停（审批、补充信息）的通道在 5.3-c，额度还剩多少也不在这里判——外发工具自己经
 * `entitlement.gate`（AGENTS.md §7.3），这里再问一次就是同一件事两套口径（§2.5）。
 */
import {
  AppError,
  Service,
  asApp,
  type AutonomyLevel,
  type Context,
  type ExemptAuditRow,
  type ExemptToolView,
  type ToolDescriptorView,
} from '@auto-cc/core';
import type { StoreService } from '@auto-cc/plugin-store';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { AgentToolsService } from '../tools.js';

/**
 * 判定结果码。
 *
 * `ALLOWED` 之外全是「这一步不动」，区别只在为什么不动、由谁解除：
 * `PLAN_UNCONFIRMED` 等用户确认计划；`TIER_SUGGEST_READ_ONLY` 等档位被用户显式改；
 * `CONFIRMATION_REQUIRED` 等 5.3 的审批口；`TOOL_UNAVAILABLE` 是注册表里没有或已声明 disabled。
 */
export type PolicyCode =
  'ALLOWED' | 'PLAN_UNCONFIRMED' | 'TIER_SUGGEST_READ_ONLY' | 'CONFIRMATION_REQUIRED' | 'TOOL_UNAVAILABLE';

/** 一条判定读数：可否执行 + 码 + 要显示给人看的原话。 */
export type PolicyDecision = { canRun: boolean; code: PolicyCode; message: string };

/** 判定的输入（见文件头：刻意不含副作用与模型措辞）。 */
export type StepPermissionRequest = {
  /** 当前会话档位 */
  tier: AutonomyLevel;
  /** 这份计划是否已被用户确认（5.2-03 的前置） */
  planConfirmed: boolean;
  /** 这一步要点的那只手 */
  toolId: string;
};

/**
 * 策略配置：**仍然是一个都不给**（5.3-b 也没有把它做成配置键）。
 *
 * 免确认白名单为什么不进这里（plan §5.3-b 的落点说明）：装配面板写配置走的是 `kernel.applyConfig`，
 * 那只写**内存里的运行时层**（`runtimePatches`），重启即失——"这只动作以后不必每次问我"是要跨重启成立的
 * 用户表态；而改本服务的配置会连带重建 inject 它的 `agent.loop`（§9 的 2.5 实测），
 * 那条链上可能正跑着一条 run。所以它落在库里（号段 18）+ 一个唯一写入口，形状同 2.7-e 的平台风险签字。
 * 空 strictObject 与注册表/账本同一形状，装配面板里因此还能单独摘掉本服务。
 */
export const agentPolicySchema = z.strictObject({});

/** 校验后的配置形状。 */
export type AgentPolicyConfig = z.output<typeof agentPolicySchema>;

/**
 * 迁移号段 **18**（5.3-b 起）：免确认白名单与它的变更流水，两张表一支迁移。
 *
 * 必须新开号段而不是挂到 16 / 17 的 `up` 上：`runMigrations` 认的是 `schema_migrations` 台账，
 * 已记过账的那几版在老库上永远不重跑（§9 的 5.3-a 实测，单测从空库起因此照不出来）。
 */
export const AGENT_POLICY_MIGRATION_VERSION = 18;

/** 白名单与审计两张表的建表迁移。 */
const agentPolicyMigration = {
  version: AGENT_POLICY_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_policy_exempt (
      tool_id TEXT PRIMARY KEY,
      added_at INTEGER NOT NULL,
      source TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS agent_policy_exempt_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id TEXT NOT NULL,
      action TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    // 回看某只动作的加白/撤白历史按「工具 + 时间」取，没这条索引就是全表扫。
    db.exec(
      'CREATE INDEX IF NOT EXISTS agent_policy_exempt_audit_tool_ts ON agent_policy_exempt_audit (tool_id, created_at)',
    );
  },
};

/**
 * 审计一次取多少条：与档位审计同量级，全量导出不属 5.3。
 *
 * 界面读数（`ExemptToolView` / `ExemptAuditRow`）不在这里定义——那两个类型要出现在渲染层的镜像里，
 * 而渲染层不能 import 本包（L4 依赖方向），所以它们与 `AgentRunView` 同住在 `@auto-cc/core`。
 */
const EXEMPT_AUDIT_LIMIT = 50;

export class AgentPolicyService extends Service {
  static provide = 'agent.policy';
  static Config = agentPolicySchema;
  static inject = ['store', 'agent.tools'];

  constructor(
    ctx: Context,
    private readonly config: AgentPolicyConfig,
  ) {
    super(ctx, 'agent.policy');
  }

  /** 注册表现读：不在本地存第二份工具表（AGENTS.md §9 的 2.5 实测：改配置会重建下游插件）。 */
  private get registry(): AgentToolsService {
    return asApp(this.ctx)['agent.tools'];
  }

  /** store 句柄：白名单与审计两张表的唯一去处（号段 18）。 */
  private get store(): StoreService {
    return asApp(this.ctx).store;
  }

  /**
   * 判这一步可否执行。
   * @param request 档位 + 计划是否已确认 + 工具 id
   * @returns 判定读数；**永不抛异常**——拒绝是一种正常结果，不是要把循环炸掉的错误
   */
  decide(request: StepPermissionRequest): PolicyDecision {
    if (!request.planConfirmed) {
      return {
        canRun: false,
        code: 'PLAN_UNCONFIRMED',
        message: `工具 ${request.toolId} 这一步不执行：计划尚未确认，确认前零动作是硬规定`,
      };
    }
    const descriptor = this.findDescriptor(request.toolId);
    if (!descriptor) {
      return {
        canRun: false,
        code: 'TOOL_UNAVAILABLE',
        message: `工具 ${request.toolId} 不在开放的工具面上（未登记，或已声明 disabled）`,
      };
    }
    if (request.tier === 'suggest') {
      return {
        canRun: false,
        code: 'TIER_SUGGEST_READ_ONLY',
        message: '当前档位「建议模式」只出计划不执行任何动作（要执行请由你把档位显式改掉）',
      };
    }
    // 一只自己声明要批准的手，`semi` 档下不替用户点头；`auto` 档下它仍默认要点头，
    // 除非用户在界面上把**这一只**显式加进免确认白名单（spec 5.3-06 / plan §5.3 的 2026-10-03 裁定）。
    if (descriptor.requiresConfirmation || (request.tier === 'semi' && descriptor.effect !== 'read')) {
      // 白名单只在 `auto` 生效：`semi` 的档位语义就是"每个写操作都问"，
      // 让名单在这里也管用等于把三档收成两档（主计划 §1.7 只有这三档，plan §5.3 不做第四档）。
      if (request.tier === 'auto' && this.isExempt(descriptor.id)) {
        return {
          canRun: true,
          code: 'ALLOWED',
          // 免确认≠免闸门：这一句只免掉"每次都要人点头"，额度与频控在外发工具那一侧照旧（AGENTS.md §7.3）。
          message: `档位 auto 且 ${descriptor.id} 在你显式加白的免确认名单里，这一步不再询问（额度闸门与频控照旧生效）`,
        };
      }
      return {
        canRun: false,
        code: 'CONFIRMATION_REQUIRED',
        // 这一句是人唯一会读到的下一步指引，所以它必须只说**当下真有的**那条口：5.3-b 落的是免确认白名单，
        // 5.3-c 落的是逐条批准的确认单——两句都指得到界面上真有的东西，而不是一个还没接的口子。
        message: `这一步是「${descriptor.effect}」级动作，要先由你批准（循环会为此开一张确认单，批准与拒绝都在卡片上按；全自动档下也可把这只手加进免确认白名单，之后不再每次问你）`,
      };
    }
    return {
      canRun: true,
      code: 'ALLOWED',
      message: `档位 ${request.tier} 允许执行 ${descriptor.effect} 级的 ${descriptor.id}`,
    };
  }

  /**
   * 列出当前免确认的动作（spec 5.3-07 的「可列出」半边）。
   * @returns 按加白时刻升序；名单为空时是空数组——**缺省即空**是 5.3-06「仍默认需要确认」的前提
   */
  exemptList(): ExemptToolView[] {
    const rows = this.store.db
      .prepare('SELECT tool_id, added_at FROM agent_policy_exempt ORDER BY added_at ASC, tool_id ASC')
      .all() as unknown as { tool_id: string; added_at: number | bigint }[];
    // 副作用级与标题键现读注册表：名单里存的那一位只有「免不免确认」，其余都是注册表的投影（§2.5）。
    return rows.map((row) => ({
      toolId: row.tool_id,
      addedAt: Number(row.added_at),
      descriptor: this.findDescriptor(row.tool_id) ?? null,
    }));
  }

  /**
   * 把一只动作加进免确认名单——这条链上**唯一的加白入口**，且只由界面点击触发（spec 5.3-06 / 07）。
   *
   * 它刻意不登记为 agent 工具：让模型自己把自己下一步要用的那只手加白，等于把 5.3-04 防的
   * 「agent 自己给自己放宽」换成另一种形态重演一遍（静态半边由 `scripts/check-agent-model-authority.ts` 钉住）。
   * @param toolIdRaw 工具 id，来自渲染层，按不可信输入处理
   * @returns 加白后的整份名单（界面一次调用就能刷新列表，不必再读一遍）
   * @throws 不在开放面上时以 `AGENT_POLICY_EXEMPT_UNKNOWN` 结构化失败：不猜名字，也不留「以后登记上就自动生效」的口子
   */
  setExempt(toolIdRaw: string): ExemptToolView[] {
    if (!this.findDescriptor(toolIdRaw)) {
      throw new AppError(
        'AGENT_POLICY_EXEMPT_UNKNOWN',
        `工具 ${toolIdRaw} 不在开放的工具面上，无法加白`,
        'agent.policy',
        { toolId: toolIdRaw },
      );
    }
    const at = Date.now();
    const inserted = this.store.db
      .prepare(
        `INSERT INTO agent_policy_exempt (tool_id, added_at, source) VALUES (?, ?, 'user')
                ON CONFLICT(tool_id) DO NOTHING`,
      )
      .run(toolIdRaw, at);
    // 已在名单里不算一次变更：审计记的是变更而不是点击次数（与 5.3-a 的档位审计同口径，免得名单里全是噪音行）。
    if (Number(inserted.changes) > 0) this.writeExemptAudit('add', toolIdRaw, at);
    return this.exemptList();
  }

  /**
   * 从免确认名单里撤销一只动作（spec 5.3-07 的「可逐条撤销」）。
   *
   * 不要求这只手此刻还在注册表里：能力包被摘掉之后，用户仍要能把当初加的白撤掉，
   * 否则名单里会留一条「撤不掉的免确认」——那比一条失效的记录危险得多。
   * @param toolIdRaw 工具 id
   * @returns 撤销后的整份名单；本来就不在名单里时不写审计，读数与调用前一致
   */
  clearExempt(toolIdRaw: string): ExemptToolView[] {
    const at = Date.now();
    const deleted = this.store.db.prepare('DELETE FROM agent_policy_exempt WHERE tool_id = ?').run(toolIdRaw);
    if (Number(deleted.changes) > 0) this.writeExemptAudit('revoke', toolIdRaw, at);
    return this.exemptList();
  }

  /**
   * 读加白 / 撤白的流水（spec 5.3-05 的同族判据：白名单的变更也是用户的显式表态，要能回看）。
   * @returns 最近 `EXEMPT_AUDIT_LIMIT` 条，按时刻倒序（最新在前）；从没动过名单时是空数组
   */
  exemptAudit(): ExemptAuditRow[] {
    const rows = this.store.db
      .prepare(
        `SELECT id, tool_id, action, source, created_at FROM agent_policy_exempt_audit
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(EXEMPT_AUDIT_LIMIT) as unknown as {
      id: number | bigint;
      tool_id: string;
      action: string;
      source: string;
      created_at: number | bigint;
    }[];
    return rows.map((row) => ({
      id: Number(row.id),
      toolId: row.tool_id,
      // 认不出的动作名不当成任何一类：这一列只有 `add` / `revoke` 两个写点，读成别的就是把脏值放行。
      action: row.action === 'add' || row.action === 'revoke' ? row.action : 'revoke',
      source: row.source,
      createdAt: Number(row.created_at),
    }));
  }

  [Service.init](): void {
    this.ensureSchema();
    this.ctx.logger.info(
      `自治策略判定口就绪（无可调项，配置 ${JSON.stringify(this.config)}；` +
        `免确认名单 ${String(this.exemptList().length)} 只，只在档位为全自动时生效）`,
    );
  }

  /**
   * 把号段 18 的两张表登记进 `store.migrations` 并建表。
   *
   * 幂等是硬要求：`plugins.start('agent-policy')` 会重新构造本服务，无条件 push 同一个 version
   * 会让 `runMigrations` 抛「迁移版本重复」（与 `chat.session` 的 `ensureSchema` 同一口径）。
   */
  private ensureSchema(): void {
    const migrations = this.store.migrations;
    if (!migrations.some((registered) => registered.version === agentPolicyMigration.version)) {
      migrations.push(agentPolicyMigration);
    }
    this.store.upgrade();
  }

  /**
   * 这只动作当前是否免确认（判定者的私有读数；对外的是 `exemptList`）。
   * @param toolId 工具 id
   * @returns 在名单里为 true
   */
  private isExempt(toolId: string): boolean {
    const row = this.store.db.prepare('SELECT tool_id FROM agent_policy_exempt WHERE tool_id = ?').get(toolId) as
      { tool_id?: string } | undefined;
    return row?.tool_id !== undefined;
  }

  /**
   * 落一条加白 / 撤白的审计（`source` 恒为 `user`：写入口只有界面那一条，见 `setExempt` 的注释）。
   * @param action 变更类型
   * @param toolId 被加白 / 撤销的动作 id
   * @param at 变更时刻（毫秒）
   */
  private writeExemptAudit(action: 'add' | 'revoke', toolId: string, at: number): void {
    this.store.db
      .prepare(`INSERT INTO agent_policy_exempt_audit (tool_id, action, source, created_at) VALUES (?, ?, 'user', ?)`)
      .run(toolId, action, at);
  }

  /**
   * 按 id 现读注册表里的那份真相。
   * @param toolId 工具 id
   * @returns 描述符；不在开放面上时返回 null（`list()` 已经把 disabled 的那批滤掉，判定因此与清单同口径）
   */
  private findDescriptor(toolId: string): ToolDescriptorView | undefined {
    return this.registry.list().find((entry) => entry.id === toolId);
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'agent.policy': AgentPolicyService;
  }
}
