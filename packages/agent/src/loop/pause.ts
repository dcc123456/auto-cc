/**
 * `agent.pause`：循环里某一步挂在人身上时的唯一通道（spec 5.3-08 / 09 / 10，持久化那半边由 5.5-05 补齐）。
 *
 * 5.3-c 当初判的是「不建表、不占迁移号段」，理由是待决暂停属于**等待状态**而不是事实记录。
 * 5.5-05 要的恰好是被那条理由放弃的性质：进程崩在人还没表态的时候，那张卡片重启后必须还在。
 * 所以本片**推翻**旧决策（改的判据是 5.3-10 的「表态要可对账」，不是觉得表方便）：
 * 通道仍旧只在内存里等（`PendingChannel` 那份登记一个字没动），库里号段 22 那一行是**这张单的账**——
 * 「谁在什么时候对哪一步表了什么态」是事实，「此刻有没有人在等」不是，两者分开之后
 * 「超时＝未确认＝不执行」才第一次有一处能对账的地方。
 * 单号路由、超时、收单这三件事长在 `@auto-cc/core` 的 `PendingChannel` 上（§2.2：投递那边已经有过一次），
 * 本服务留下的是领域那半边：卡片上要显示什么、两类单各能接住哪几种表态、推哪两条事件、以及那一行账。
 *
 * 两类暂停（`approval` / `elicitation`）共用一条通道与一套性质，分型只在载荷的 `kind` 上：
 * 拆成两条通道就会出现「错 id 被忽略」这类断言只在一侧成立（plan §5.3-c 的切法依据）。
 * `respond` 与加白撤白同一口径：**只由人按**，刻意不登记为 agent 工具——模型若能自己应答自己的确认单，
 * 5.3-04 防的「agent 自己给自己放行」就换了个名字重演（静态半边由 `check-agent-model-authority.ts` 钉）。
 */
import {
  AppError,
  PendingChannel,
  Service,
  asApp,
  type AgentPauseAnswer,
  type AgentPauseKind,
  type AgentPauseView,
  type Context,
  type PendingOutcome,
} from '@auto-cc/core';
import type { StoreService } from '@auto-cc/plugin-store';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { MAX_USER_INPUT_CHARS } from '../session.js';

/**
 * 暂停通道的配置。
 *
 * 只有超时这一格可调，且**缺省即最保守**这一条在这里的含义与档位不同：这里的保守是「别久久不放行」，
 * 上限 10 分钟、下限 200 毫秒（用例要能当场看到超时）。改这一格会连带重建 inject 它的 `agent.loop`
 * （AGENTS.md §9 的 2.5 实测），所以本服务销毁时必须收单——那条性质由 `[Service.init]` 里的 effect 兜住。
 */
export const agentPauseSchema = z.strictObject({
  /** 一张单等多久（毫秒）；到点按「未确认」收，绝不默认放行（spec 5.3-10）。 */
  pauseTimeoutMs: z.number().int().min(200).max(600000).default(120000),
});

/** 校验后的配置形状。 */
export type AgentPauseConfig = z.output<typeof agentPauseSchema>;

/**
 * 迁移号段 **22**（5.5-d）：暂停单的账，一行一张单。
 *
 * 必须新开号段而不是挂到 16 / 18 / 21 的 `up` 上：`runMigrations` 认的是 `schema_migrations` 台账，
 * 已记过账的那几版在老库上永远不重跑（§9 的 5.3-a 实测），老用户因此不会有这张表而重推逻辑照跑——
 * 表现为「重启后卡片一张都不出来」却不报错。
 */
export const AGENT_PAUSE_MIGRATION_VERSION = 22;

/** 建表迁移：单子本身 + 「哪些还没定局」那条查询用的索引。 */
const agentPauseMigration = {
  version: AGENT_PAUSE_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    // 时刻两列记的是**这张单第一次开出**时的那一对（重推不改写它们：重新等的那一段时长活在通道的定时器里）。
    // `resolved_at` / `resolution` 两列同时为空 = 「还没人表态」，那正是重启后要把卡片挂回去的唯一依据。
    db.exec(`CREATE TABLE IF NOT EXISTS agent_pause_requests (
      request_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      plan_step_index INTEGER NOT NULL,
      tool_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      reason TEXT NOT NULL,
      missing_json TEXT NOT NULL,
      round INTEGER NOT NULL,
      requested_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolution TEXT
    )`);
    // 重推要捞的是「还没定局的那几张」，按开单顺序；没这条索引就是每次启动全表扫。
    db.exec('CREATE INDEX IF NOT EXISTS agent_pause_requests_open ON agent_pause_requests (resolved_at, requested_at)');
  },
};

/**
 * 一张单最终落在 `resolution` 列上的四种值。
 *
 * 前三种是人真的表了态（`AgentPauseAnswer.decision` 原样入库）；第四种从通道的定局借名，
 * 而且**不许**被写成 `deny`：把「没人说话」记成「有人说了不」正是 5.3-10 要防的那种账目污染，
 * 而 5.5-05 之后这本账是要被人回看的，写错一次就一直错下去。
 * 通道第三种定局（`cancelled`）**不在这里**——它说的是等待方消失了，不是这张单有了结局，
 * 所以库里那一行保持空着，下一次启动照它重推（见 `markResolved`）。
 */
type PauseResolution = AgentPauseAnswer['decision'] | 'timed-out';

/**
 * 开一张单时由调用方填的那几格。
 *
 * `requestId / requestedAt / expiresAt` 不在这里——单号与时刻是通道的三位，调用方给就会给出一份假账（§2.5）。
 */
export type PausePayload = Omit<AgentPauseView, 'requestId' | 'requestedAt' | 'expiresAt'>;

/**
 * 一张开出去的单与它的定局（`ask` 的返回）。
 *
 * 定局本身不带请求方，而超时那句原话要说「等到什么时候」，所以把通道补齐后的读数一并交回；
 * 调用方拿到的 `request` 与界面上那张卡片是同一份形状。
 */
export type PauseReply = { request: AgentPauseView; outcome: PendingOutcome<AgentPauseAnswer> };

/**
 * 每一类单能接住的表态。
 *
 * `elicitation` 不接 `approve`：把「我补了一段信息」读成「这一步批准了」就是替用户点了一个他没点过的按钮；
 * `approval` 不接 `supply`，因为确认卡片上没有输入框，界面上不该存在一条送得出这种表态的路。
 */
const ALLOWED_DECISIONS: Record<AgentPauseKind, readonly AgentPauseAnswer['decision'][]> = {
  approval: ['approve', 'deny'],
  elicitation: ['deny', 'supply'],
};

/** 单子的中文称呼，进 `respond` 的失败原话与循环那一侧的拒因（只从这里出，见 `pauseKindLabel`）。 */
const KIND_LABEL: Record<AgentPauseKind, string> = { approval: '确认单', elicitation: '补充信息单' };

/**
 * 单子的中文称呼，进 `respond` 的失败原话与循环那一侧的拒因。
 *
 * 单独一只函数而不是把这张小表 export 出去：两侧要的都是「这句话怎么说」，
 * 留两份中文就是在同一件事上写两处（§2.2）。
 * @param kind 单的类型
 * @returns 「确认单」/「补充信息单」
 */
export function pauseKindLabel(kind: AgentPauseKind): string {
  return KIND_LABEL[kind];
}

export class AgentPauseService extends Service {
  static provide = 'agent.pause';
  static Config = agentPauseSchema;
  static inject = ['store'];

  constructor(
    ctx: Context,
    private readonly config: AgentPauseConfig,
  ) {
    super(ctx, 'agent.pause');
  }

  /** 在等的单子：内存登记，按开单顺序；服务销毁即清空（没有跨重启的等待状态这一说，跨重启的是那行账）。 */
  private readonly channel = new PendingChannel<PausePayload, AgentPauseAnswer>();

  /** store 句柄：号段 22 那一行账的唯一去处（与 `agent.policy` 同一口径，用的时候现问，不存第二份）。 */
  private get store(): StoreService {
    return asApp(this.ctx).store;
  }

  /**
   * 当前在等的暂停单（spec 5.3-08 界面那半边的**读**路：事件负责此刻提醒，这份读数负责错过了也还在）。
   * @returns 按开单顺序的卡片读数；没有在等的单时是空数组
   */
  pending(): AgentPauseView[] {
    return this.channel.pending();
  }

  /**
   * 开一张单等人表态，并等到它定局。
   *
   * 先登记再发事件（`PendingChannel.open` 的顺序保证）：界面收到提醒后立刻 `pending()` 必读得到这张单，
   * 这条口径从 2.6-01 沿用至今。
   * @param payload 卡片要显示的那几格（run / 步序 / 工具 / 类型 / 原话 / 缺什么 / 第几轮）
   * @param signal 让出信号：叫停或本服务重建时以 `cancelled` 定局，不等超时也不接受应答
   * @returns 补齐单号与时刻的读数 + 三种定局之一；**本函数永不抛**（没人应答不是错误，是不放行）
   */
  async ask(payload: PausePayload, signal?: AbortSignal): Promise<PauseReply> {
    const ticket = this.channel.open(payload, { timeoutMs: this.config.pauseTimeoutMs, signal });
    const request: AgentPauseView = ticket.request;
    // 账在事件之前落：界面一收到提醒就能按，那一刻这张单必须已经在库里挂着，
    // 否则应答写得比开单早，重启后这张「已经表过态」的单就不在任何一本账上（5.5-05 要的对不上账形态）。
    this.writeRequestRow(request);
    this.ctx.emit('agent/pause-requested', request);
    this.ctx.logger.info(
      `暂停单 ${request.requestId} 开出：第 ${String(request.round)} 轮 ${request.kind}（run ${request.runId} 的第 ${String(request.planStepIndex + 1)} 步 ${request.toolId}），${String(this.config.pauseTimeoutMs)}ms 内无人表态就按未批准收`,
    );
    const outcome = await ticket.outcome;
    this.markResolved(request.requestId, outcome);
    // 收单信号一律发出，包括超时与让出：界面上的卡片必须由它消失，而 `outcome` 说的是「没人应答」，
    // 不是「用户拒绝了」——把这两件事混成一次广播，5.3-10 的回报超时就成了界面自己编的措辞。
    this.ctx.emit('agent/pause-resolved', { requestId: request.requestId, outcome: outcome.kind });
    this.ctx.logger.info(`暂停单 ${request.requestId} 收掉：${outcome.kind}`);
    return { request, outcome };
  }

  /**
   * 把一句表态按单号路由回那张单（spec 5.3-09 的应答口，只有界面这一条路）。
   *
   * 三道校验都在系统边界上做（AGENTS.md §2.6）：单号要在等、表态种类要与单的 `kind` 相配、
   * 补充信息的长度要过与会话输入同一个上限。校验不过就**结构化失败且不落地**，那张单照旧在等。
   * @param requestIdRaw 单号，来自 `pending()` 或 `agent/pause-requested`，按不可信输入处理
   * @param answer 人的表态：`approve` / `deny` / 带文本的 `supply`
   * @returns 表态落地之后**还在等的**整份清单（界面一次调用即可刷新，与策略那边改完名单回整份同一形状）
   * @throws 查无此单或单已定局 `APPROVAL_NOT_FOUND`（附还等着的哪几张）；种类或长度不合 `INVALID_ARGUMENT`
   */
  respond(requestIdRaw: string, answer: AgentPauseAnswer): AgentPauseView[] {
    const waiting = this.channel.pending().find((request) => request.requestId === requestIdRaw);
    if (!waiting) {
      throw new AppError(
        'APPROVAL_NOT_FOUND',
        `暂停单 ${requestIdRaw} 已不在等待中（已应答、已超时，或本来就没有这张单）`,
        'agent.pause',
        { requestId: requestIdRaw, pending: this.channel.pendingIds() },
      );
    }
    if (!ALLOWED_DECISIONS[waiting.kind].includes(answer.decision)) {
      throw new AppError(
        'INVALID_ARGUMENT',
        `${KIND_LABEL[waiting.kind]}接不住「${answer.decision}」这种表态（这张单在等的是：${ALLOWED_DECISIONS[waiting.kind].join(' / ')}）`,
        'agent.pause',
        { requestId: requestIdRaw, kind: waiting.kind, decision: answer.decision },
      );
    }
    if (answer.decision === 'supply' && answer.text.length > MAX_USER_INPUT_CHARS) {
      throw new AppError('INVALID_ARGUMENT', `补充信息最长 ${String(MAX_USER_INPUT_CHARS)} 字`, 'agent.pause', {
        requestId: requestIdRaw,
        length: answer.text.length,
      });
    }
    // 到这里单一定还挂着（本函数从头到尾没有 `await`，JS 是单线程的），所以不必再判返回值。
    this.channel.answer(requestIdRaw, answer);
    return this.pending();
  }

  /**
   * 建表（幂等登记号段 22）。
   *
   * 幂等是硬要求：`plugins.start` 会重新构造本服务，无条件 push 同一个 version 会让 `runMigrations`
   * 抛「迁移版本重复」（与 `agent.policy` / `chat.session` 的 `ensureSchema` 同一口径）。
   */
  private ensureSchema(): void {
    const migrations = this.store.migrations;
    if (!migrations.some((migration) => migration.version === AGENT_PAUSE_MIGRATION_VERSION)) {
      migrations.push(agentPauseMigration);
    }
    this.store.upgrade();
  }

  /**
   * 开单那一刻把这张单落进账里（`resolved_at` / `resolution` 留空，等定局那一只手去补）。
   * @param request 通道补齐单号与两个时刻之后的完整读数（界面上那张卡片就是这一份）
   */
  private writeRequestRow(request: AgentPauseView): void {
    this.store.db
      .prepare(
        `INSERT INTO agent_pause_requests
         (request_id, run_id, plan_step_index, tool_id, kind, reason, missing_json, round, requested_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.requestId,
        request.runId,
        request.planStepIndex,
        request.toolId,
        request.kind,
        request.reason,
        JSON.stringify(request.missing),
        request.round,
        request.requestedAt,
        request.expiresAt,
      );
  }

  /**
   * 定局那一刻补上两列：什么时候不再等人、以及那一句是哪种定局。
   *
   * `cancelled` **不写**这一笔：那不是这张单的结局，是等待方消失了（叫停、服务被重建、进程干净退出）。
   * 把「没人表过态」记成任何一种定局，重启后就没有依据把这张单重推回来，而循环那一侧的经过本来就落在
   * `agent_step` 与 `agent_run` 上——两边各记各的，`resolution` 空着恰恰是此刻唯一诚实的读数（5.5-05）。
   * @param requestId 单号
   * @param outcome 通道交回的三种定局之一；`answered` 记人给的表态，`timed-out` 原样记成自己的名字
   */
  private markResolved(requestId: string, outcome: PendingOutcome<AgentPauseAnswer>): void {
    if (outcome.kind === 'cancelled') return;
    const resolution: PauseResolution = outcome.kind === 'answered' ? outcome.answer.decision : outcome.kind;
    this.store.db
      .prepare('UPDATE agent_pause_requests SET resolved_at = ?, resolution = ? WHERE request_id = ?')
      .run(Date.now(), resolution, requestId);
  }

  /**
   * 库里还没定局的那几张单（重启重推的唯一查询，按第一次开出的先后排）。
   * @returns 每张单的卡片载荷 + 单号；一张都没有是空数组
   */
  private openRequests(): (PausePayload & { requestId: string })[] {
    const rows = this.store.db
      .prepare(
        `SELECT request_id, run_id, plan_step_index, tool_id, kind, reason, missing_json, round
         FROM agent_pause_requests WHERE resolved_at IS NULL ORDER BY requested_at`,
      )
      .all() as unknown as {
      request_id: string;
      run_id: string;
      plan_step_index: number | bigint;
      tool_id: string;
      kind: string;
      reason: string;
      missing_json: string;
      round: number | bigint;
    }[];
    return rows.map((row) => ({
      requestId: row.request_id,
      runId: row.run_id,
      planStepIndex: Number(row.plan_step_index),
      toolId: row.tool_id,
      // 认不出的种别当 `approval` 处理：本服务只有两个写点，读到别的就是库被改动过，
      // 而这一列决定「这张卡能接住哪几种表态」，宁可少给一种（`elicitation` 的 `supply`）也不猜。
      kind: row.kind === 'elicitation' ? 'elicitation' : 'approval',
      reason: row.reason,
      missing: JSON.parse(row.missing_json) as string[],
      round: Number(row.round),
    }));
  }

  /**
   * 重启后把库里还挂着的单重新登记回通道、重新等一次，并照旧推一遍事件（spec 5.5-05）。
   *
   * 三条刻意的取舍：
   * ① **沿用老单号**——界面上那张卡片带着重启前的 id，换新号就等于把用户按下去的那一下变成「查无此单」；
   * ② **超时从这一拍重新等**——旧的到点时刻在进程停摆期间已经烧完，照搬就是一张死卡（时刻由通道重算，
   *    账上那一行的 `requested_at` / `expires_at` 不改写，它记的是「这张单第一次怎么开出来的」）；
   * ③ **这一次没有人 `await`**——循环那一侧的手早就随进程死了，所以定局只落两件事：把账补上、把卡片收掉。
   *    绝不把库里那句「重启前有人按过批准」读成放行凭证：要放行得由循环重新开一张单、重新问一次（5.3-10）。
   * @returns 重推的张数（进 init 的日志，别让这条恢复静默）
   */
  private rePushOpenRequests(): number {
    const open = this.openRequests();
    for (const payload of open) {
      const { requestId, ...card } = payload;
      const ticket = this.channel.open(card, { timeoutMs: this.config.pauseTimeoutMs, requestId });
      this.ctx.emit('agent/pause-requested', ticket.request);
      void ticket.outcome.then((outcome) => {
        this.markResolved(requestId, outcome);
        this.ctx.emit('agent/pause-resolved', { requestId, outcome: outcome.kind });
        this.ctx.logger.info(`重启前那张暂停单 ${requestId} 定局：${outcome.kind}（这一次等没有人接，只补账与收卡片）`);
      });
    }
    return open.length;
  }

  [Service.init](): void {
    this.ensureSchema();
    const repushed = this.rePushOpenRequests();
    // 服务被重建（热改配置）或整个摘掉时，在等的单全部按「未获批准」收掉，而不是留一个没人应答的
    // `await` 悬在事件循环里。必须是「返回一个函数」：cordis 会立刻执行第一层取回收器（§9 的 1.3 实测）。
    this.ctx.effect(() => () => {
      const cancelled = this.channel.cancelAll();
      if (cancelled > 0) {
        this.ctx.logger.info(`暂停服务下线：${String(cancelled)} 张还在等的暂停单按「未表态」收掉，一律不放行`);
      }
    });
    this.ctx.logger.info(
      `对话暂停通道就绪：超时 ${String(this.config.pauseTimeoutMs)}ms · 超时＝未确认＝不执行 ·` +
        ` 当前在等 ${String(this.channel.pending().length)} 张` +
        (repushed > 0 ? `（其中 ${String(repushed)} 张是重启前没等到表态的老单，按新超时重新挂出）` : ''),
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'agent.pause': AgentPauseService;
  }
}
