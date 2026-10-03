/**
 * `agent.pause`：循环里某一步挂在人身上时的唯一通道（spec 5.3-08 / 09 / 10）。
 *
 * 它**不建表、不占迁移号段**，与投递确认单（2.6-c）同一个判断：待决暂停是**等待状态**而不是事实记录，
 * 经过落在既有的 `agent_step.status / code` 与 `agent_run.stop_reason` 上；做成表就得回答
 * 「进程死了谁收 in-flight 的单子」，而「超时＝未确认＝不执行」本来就把所有悬挂兜住了。
 * 单号路由、超时、收单这三件事长在 `@auto-cc/core` 的 `PendingChannel` 上（§2.2：投递那边已经有过一次），
 * 本服务留下的是领域那半边：卡片上要显示什么、两类单各能接住哪几种表态、以及推哪两条事件。
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
  type AgentPauseAnswer,
  type AgentPauseKind,
  type AgentPauseView,
  type Context,
  type PendingOutcome,
} from '@auto-cc/core';
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

  constructor(
    ctx: Context,
    private readonly config: AgentPauseConfig,
  ) {
    super(ctx, 'agent.pause');
  }

  /** 在等的单子：内存登记，按开单顺序；服务销毁即清空（没有跨重启的等待状态这一说）。 */
  private readonly channel = new PendingChannel<PausePayload, AgentPauseAnswer>();

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
    this.ctx.emit('agent/pause-requested', request);
    this.ctx.logger.info(
      `暂停单 ${request.requestId} 开出：第 ${String(request.round)} 轮 ${request.kind}（run ${request.runId} 的第 ${String(request.planStepIndex + 1)} 步 ${request.toolId}），${String(this.config.pauseTimeoutMs)}ms 内无人表态就按未批准收`,
    );
    const outcome = await ticket.outcome;
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

  [Service.init](): void {
    // 服务被重建（热改配置）或整个摘掉时，在等的单全部按「未获批准」收掉，而不是留一个没人应答的
    // `await` 悬在事件循环里。必须是「返回一个函数」：cordis 会立刻执行第一层取回收器（§9 的 1.3 实测）。
    this.ctx.effect(() => () => {
      const cancelled = this.channel.cancelAll();
      if (cancelled > 0) {
        this.ctx.logger.info(`暂停服务下线：${String(cancelled)} 张还在等的暂停单按「未表态」收掉，一律不放行`);
      }
    });
    this.ctx.logger.info(
      `对话暂停通道就绪：超时 ${String(this.config.pauseTimeoutMs)}ms · 超时＝未确认＝不执行 · 当前在等 ${String(this.channel.pending().length)} 张`,
    );
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'agent.pause': AgentPauseService;
  }
}
