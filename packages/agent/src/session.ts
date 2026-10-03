/**
 * `chat.session` 服务（spec 1.11-02 / 03 / 07 / 08 / 13）：会话、消息、档位与流式假回复。
 *
 * 消息模型是 `parts` 的有序数组（文本段 + 工具卡片段），形状对齐 AI SDK 的 `UIMessage`
 * 但零依赖（选型证据见 plan §8.6）。助手回复由**本地确定性模板**生成：不接 LLM、不发网络请求，
 * P5 换成真模型时改的只有 `fakeReplyFor()` 与 `pump()` 的来源，界面与协议一行不动。
 *
 * 为什么正在流式的那条消息不落库：`chat_message` 只存**已完成**的消息。半截回复留在内存里，
 * 于是 app 被杀掉时不会留下一行「永远在流式」的孤儿数据，重启后读到的历史必然是完整的（1.11-08）。
 *
 * 为什么脱敏收在「进入对话记录」那两处，而不是收在写库那一行（spec 5.6-05）：判据要的是**展示与存储都不可还原**，
 * 而卡片正文有三条去路——`chat/delta` 事件、`current()` 的内存镜像、`chat_message` 行。只遮最后一条会漏前两条。
 * 收在入口则三条去路天然同一份，且只用 core 那一份正则（§2.5 禁第二套实现）。
 */
import {
  AUTONOMY_LEVELS,
  AppError,
  Service,
  asApp,
  maybeService,
  redactText,
  redactValue,
  sleep,
  type AgentRunView,
  type AutonomyLevel,
  type ChatCompactionView,
  type ChatFactCard,
  type ChatMessageView,
  type ChatPart,
  type ChatSessionView,
  type ChatSnapshotView,
  type ChatToolPart,
  type Context,
} from '@auto-cc/core';
import type { StoreService } from '@auto-cc/plugin-store';
/**
 * 额度动作名与闸门/账本的读数形状取自契约包，不在这份文件里抄一遍名单：
 * `QUOTA_ACTIONS` 的注释就写着「任何一处自己抄一遍，就会出现界面能发明一个闸门没有的动作名」，
 * 事实卡这一侧同样适用（§2.7 禁第二份事实）。契约包只有类型与常量，不带任何一只「手」，
 * 所以它不在 spec 5.1-08 那份「agent 不得 import 能力包」的名单里。
 */
import { QUOTA_ACTIONS, type GateDecisionView, type QuotaAction, type UsageSummaryView } from '@auto-cc/shared';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { estimateTokens } from './loop/model.js';
import { splitToolRequest } from './tool-request.js';
import type { AgentToolsService } from './tools.js';

/**
 * 迁移号段（plan §8.4 决策 6 更正）：`chat_session` + `chat_message` 同一次迁移建出，取 **2**，
 * 因此 P2 的第一张真表从 3 起。
 */
export const CHAT_MIGRATION_VERSION = 2;

/**
 * 用户单条输入的字数上限：这是系统边界（渲染层来的不可信输入），也防止一条超长输入把验收截图拖到几十秒。
 * 5.2-a 的 `agent.loop.propose` 收的是同一类输入，因此共用这一个常量而不是各写一份 2000（§2.2）。
 */
export const MAX_USER_INPUT_CHARS = 2000;

/**
 * 会话标题的字数上限（spec 5.6-07 的系统边界：渲染层来的不可信输入）。
 *
 * 为什么不复用上面那个 2000：标题是画在头部一行里的，不是正文；给它 2000 等于允许人把整段对话
 * 粘成标题，头部那一行就没了。60 字是「一句像样的名字」的量。
 */
export const MAX_SESSION_TITLE_CHARS = 60;

/**
 * 以该前缀开头的输入会真调一次注册表，形态是 `/tool <工具id> [入参 JSON]`。
 * 纯前缀命中，不做任何意图识别（1.11-14 + plan §15.8 落点 1）。
 */
const TOOL_DEMO_PREFIX = '/tool';

/** 裸 `/tool` 不指名时落到的那只工具：2.8-09 的判据是「从对话发起一次搜索」，而它只打本地仿站。 */
const DEFAULT_TOOL_ID = 'jd.capture.run';

/** 默认入参（`limit: 3` 让验收截图不必等一整轮节流跑完）。 */
const DEFAULT_TOOL_INPUT = { criteria: { keyword: '前端', city: '上海', limit: 3 } } as const;

/**
 * 把 `/tool` 之后的原文切成「工具 id + 入参」。
 * @param raw 前缀之后的原文（已去空）
 * @returns 缺 id 时用默认的那只与默认入参；其余切法走 `splitToolRequest`（与桩模型共用，§2.2），
 *   入参不是合法 JSON 时**把原始字符串照交给注册表**，由 schema 回 `TOOL_INPUT_INVALID`
 *   ——会话层不另造一套入参校验（plan §15.8 落点 1，AGENTS.md §2.6）
 */
function parseToolRequest(raw: string): { toolId: string; input: unknown } {
  const split = splitToolRequest(raw);
  return split.toolId ? split : { toolId: DEFAULT_TOOL_ID, input: DEFAULT_TOOL_INPUT };
}

/** 会话与消息两张表的建表迁移；`up` 只写 DDL。 */
const chatMigration = {
  version: CHAT_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_session (
      id TEXT PRIMARY KEY,
      autonomy TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS chat_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      parts TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    // 每次读快照都是「某个会话的消息按时间排」，没这条索引就是全表扫。
    db.exec('CREATE INDEX IF NOT EXISTS chat_message_session_ts ON chat_message (session_id, created_at)');
  },
};

/**
 * 迁移号段 **17**（5.3-a 起）：`chat_autonomy_audit` 单独一支。
 *
 * 为什么不能挂在号段 2 的 `up` 里（我最初的判断，已被实测推翻并更正在这里）：`runMigrations` 认的是
 * `schema_migrations` 台账，不是 DDL 幂等——开发实例的库里早就记着「2 已应用」，把建表语句塞进
 * 号段 2 永远不会重跑，老用户机上第一次切档位就会以 `no such table` 失败。单测每个用例都从空库起，
 * 因此全绿也照不出这条腿（回看证据见 plan §5.3-a 的更正）。
 */
export const CHAT_AUTONOMY_AUDIT_MIGRATION_VERSION = 17;

/** 档位变更审计表；`down` 与号段 2 / 16 同一口径不写（同包惯例：省略即「这张表回不去」，回滚会显式失败）。 */
const chatAutonomyAuditMigration = {
  version: CHAT_AUTONOMY_AUDIT_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_autonomy_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      from_autonomy TEXT NOT NULL,
      to_autonomy TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    // 回看一个会话的档位历史是「按时间倒序取最近若干条」，没这条索引就是全表扫。
    db.exec(
      'CREATE INDEX IF NOT EXISTS chat_autonomy_audit_session_ts ON chat_autonomy_audit (session_id, created_at)',
    );
  },
};

/**
 * 迁移号段 **23**（5.6-c 起）：给 `chat_session` 补「人起的名字」与「软删标记」两列（spec 5.6-07）。
 *
 * 为什么单开一支而不是塞进号段 2 的 `up`：`runMigrations` 认的是 `schema_migrations` 台账而不是
 * DDL 幂等，老库里「2 已应用」永远不会重跑（号段 17 就是栽过一次才更正的，见上面那段）。
 * 为什么用 `ADD COLUMN` 而不是重建表：两列都可空、无默认值依赖，重建表要连消息行的归属一起搬，
 * 风险远大于收益；而「软删」要的恰恰是**不动任何既有行**。
 */
export const CHAT_SESSION_META_MIGRATION_VERSION = 23;

/** 会话标题与软删标记两列；`down` 与号段 2 / 17 / 22 同一口径不写（同包惯例：回滚会显式失败）。 */
const chatSessionMetaMigration = {
  version: CHAT_SESSION_META_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec('ALTER TABLE chat_session ADD COLUMN title TEXT');
    db.exec('ALTER TABLE chat_session ADD COLUMN deleted_at INTEGER');
  },
};

/**
 * 迁移号段 **24**（5.6-d 起）：`chat_compaction` —— 一段被折叠的较早消息的读数（spec 5.6-02 / 04 / 10）。
 *
 * 为什么新建一张表而不是给 `chat_message` 加一位「已折叠」标记：判据是「压缩不改写事实、失败不丢原文」，
 * 而标记位写在原文行上就意味着原文被压缩这件事改写过了它——一次 UPDATE 就是把「没折」和「折过」压成一位。
 * 独立一张表让「折叠」是**附加的一层读数**：删掉这行历史就整段回来了，原文行自始至终没被碰过。
 * 为什么存 `covered_ids` 而不是只存 `from_ts` / `to_ts`：读的一侧要能判定「这行摘要点名的原文还在不在」，
 * 只按时间区间筛的话，一条被外部删掉的消息会静默变成「那段不见了」——那正是 5.6-10 要防的丢消息。
 */
export const CHAT_COMPACTION_MIGRATION_VERSION = 24;

/** 压缩读数表；`down` 与本包其余号段同一口径不写（回滚会显式失败）。 */
const chatCompactionMigration = {
  version: CHAT_COMPACTION_MIGRATION_VERSION,
  up: (db: DatabaseSync) => {
    db.exec(`CREATE TABLE IF NOT EXISTS chat_compaction (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      from_ts INTEGER NOT NULL,
      to_ts INTEGER NOT NULL,
      covered_ids TEXT NOT NULL,
      covered_count INTEGER NOT NULL,
      tokens_before INTEGER NOT NULL,
      tokens_after INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    // 读的一侧每次都要「取这段会话里 to_ts 最大的那一条」，没这条索引就是全表扫。
    db.exec('CREATE INDEX IF NOT EXISTS chat_compaction_session_ts ON chat_compaction (session_id, to_ts)');
  },
};

/** `chat_compaction` 的一行原始读数；`covered_ids` 是 JSON 数组文本。 */
type CompactionRow = {
  id: string;
  session_id: string;
  from_ts: number | bigint;
  to_ts: number | bigint;
  covered_ids: string;
  covered_count: number | bigint;
  tokens_before: number | bigint;
  tokens_after: number | bigint;
  created_at: number | bigint;
};

/** 会话表的一行原始读数（列名是 snake_case，转成视图的工作收在 `toMessageView`）。 */
type SessionRow = {
  id: string;
  autonomy: string;
  created_at: number | bigint;
  title: string | null;
  deleted_at: number | bigint | null;
};

/** 消息表的一行原始读数；`parts` 是 JSON 文本。 */
type MessageRow = {
  id: string;
  session_id: string;
  role: string;
  parts: string;
  created_at: number | bigint;
};

export const chatConfigSchema = z.strictObject({
  /** 每片吐出的字数上限。默认 6：连拍两三张截图就能看见字数在涨（1.11-03 的判据）。 */
  chunkChars: z.number().int().min(1).max(50).default(6),
  /** 两片之间的间隔（毫秒）。上限 1 秒：再慢就演示不到「运行中仍可输入」。 */
  chunkIntervalMs: z.number().int().min(0).max(1000).default(120),
  /**
   * 新会话的起始档位（spec 5.3-02）。缺省即最保守档 `suggest`——只出计划不动手。
   *
   * 为什么做成配置而不是留字面量：5.3-02 的验证操作是「删配置 → 断言档位为建议模式」，
   * 代码里写死 `'suggest'` 就删不动任何东西，「回落」也无从断言。装配文件 `cordis.yml` 里
   * **故意不给这一行**，缺省值因此是被装配本身证明的。能配成 `auto` 是刻意留的口子：
   * 那是用户在装配面板上的**显式**表态（5.3-04 要防的是 agent 自己升档，不是人改默认值）。
   */
  defaultAutonomy: z.enum(AUTONOMY_LEVELS).default('suggest'),
  /**
   * 触发折叠的 token 估计阈值（spec 5.6-02「长会话触发压缩」，plan §7.4 取证 2）。
   *
   * 尺子是 `estimateTokens`（约 2 字 ≈ 1 token），与循环那条 token 上限用的是同一把粗估——不引 tokenizer：
   * 判据要的是「下降可量化」（5.6-04），同一把尺前后一比就够，换成精确尺反而要让两处口径一致。
   * 为什么默认 600 而不是模型上下文长度：这段会话的助手回复是本地模板（F1），今天的成本是**界面长度**
   * 而不是出网长度，600 大约是十几轮短对话；真模型接上后该按上下文窗口重标，那一改只动这一行配置。
   */
  compactTriggerTokens: z.number().int().min(20).max(200000).default(600),
  /**
   * 折叠时保留不动的最近条数（spec 5.6-02：白名单之外的当下语境要看得见）。
   *
   * 下限 2 是有意的：一条问 + 一条答是最小有意义的窗口，允许折到只剩 1 条就等于把语境折没了。
   */
  compactKeepRecentMessages: z.number().int().min(2).max(200).default(8),
});

/** 校验后的配置形状（在装配面板可热改，走 1.5 的 `plugins.saveConfig`）。 */
export type ChatConfig = z.output<typeof chatConfigSchema>;

/**
 * 一次档位变更的审计读数（spec 5.3-05）。
 *
 * `source` 只可能是 `'user'`：写这一列的唯一入口是 `setAutonomy`，而它只由界面点击触发
 * （5.3-04 的另一半由 `scripts/check-agent-model-authority.ts` 静态钉住）。这一位不是冗余——
 * 它把「谁动的」写进证据里，将来若有第二条来源必须显式新增枚举值，机检与用例都会因此被要求更新。
 */
export type AutonomyAuditRow = {
  id: number;
  sessionId: string;
  fromAutonomy: AutonomyLevel;
  toAutonomy: AutonomyLevel;
  source: string;
  createdAt: number;
};

/** 审计一次取多少条：界面只展示最近这几次改档，全量导出不属 5.3。 */
const AUTONOMY_AUDIT_LIMIT = 50;

/**
 * 把库里读到的档位列收成合法档位。
 * @param stored `chat_session.autonomy` 的原始文本（可能是历史脏值或被外部改过）
 * @returns 认识的档位名；未知一律回落最保守档 `suggest`（5.3-02「配置缺失亦回落到最保守」的库侧半边）
 */
function coerceAutonomy(stored: string): AutonomyLevel {
  return (AUTONOMY_LEVELS as readonly string[]).includes(stored) ? (stored as AutonomyLevel) : 'suggest';
}

/** 把库里的消息行转成跨进程视图：JSON 还原成 parts，bigint 收成 number。 */
function toMessageView(row: MessageRow): ChatMessageView {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role === 'user' ? 'user' : 'assistant',
    parts: JSON.parse(row.parts) as ChatPart[],
    createdAt: Number(row.created_at),
    // 库里只有已完成的消息，所以这一位恒为 false——真正的流式那一条走内存镜像，不落库。
    isStreaming: false,
  };
}

/** 会话与消息的持有者：界面的消息流只是它的读数镜像。 */
export class ChatSessionService extends Service {
  static provide = 'chat.session';
  static Config = chatConfigSchema;
  static inject = ['store', 'agent.tools'];

  constructor(
    ctx: Context,
    private readonly config: ChatConfig,
  ) {
    super(ctx, 'chat.session');
  }

  /** 正在流式的那一条助手消息；没有则为 undefined（P1 一个会话只允许一条在跑）。 */
  private live: ChatMessageView | undefined;

  /** 本次流式的取消句柄；停止/新建会话都会换一个新的，避免复用已 abort 的信号。 */
  private controller: AbortController | undefined;

  /** store 服务句柄；连接未打开时由 `store.db` 的 getter 抛出「尚未完成挂载」。 */
  private get store(): StoreService {
    return asApp(this.ctx).store;
  }

  /** 工具注册表：对话链路触达工具的唯一去处。 */
  private get registry(): AgentToolsService {
    return asApp(this.ctx)['agent.tools'];
  }

  /**
   * 当前会话的整份快照：会话读数 + 未被折叠的消息 + 正在流式那一条（如果有）+ 压缩读数。
   *
   * 消息这一侧只给「折叠窗口之外」的那些（spec 5.6-04 的「较早消息已压缩」就是这么来的）：
   * 原文行一条都没少，只是不再逐条画出来，界面上那一行摘要带的是条数与 token 前后对照。
   * 摘要是**附加的一层读数**而不是改写：那行压缩记录一旦被删、或它点名的原文行不在库里，这里就退回全文。
   * @returns 永不为 null——首次访问会就地建出一个默认档位的会话
   */
  current(): ChatSnapshotView {
    const session = this.readSession(this.ensureSession());
    const compaction = this.validCompactionRow(session.id);
    const coveredIds = new Set(compaction ? (JSON.parse(compaction.covered_ids) as string[]) : []);
    const messages = this.messagesOf(session.id).filter((message) => !coveredIds.has(message.id));
    return { session, messages, compaction: compaction ? this.viewOfRow(compaction) : null };
  }

  /**
   * 折掉这段会话里较早的一截（spec 5.6-02，plan §7.4 决策二）。
   *
   * 两条门槛都要过才动库里那一行：行数超过保留条数、整段 token 估计超过阈值；否则**什么都不写**。
   * 原文行既不移动也不改写，所以 5.6-03（数值逐字相同）与 5.6-10（失败不丢消息）不靠断言补救，
   * 最坏情况就是「没折」。折叠单位是**整条消息行**：一条 run 的步卡片就长在它所属那条消息的 `parts` 里，
   * 行边界天然就是原子组（取证 1 说的「不许把调用和结果拆开的」那件事，在这里是结构上成立的）。
   * 触发点只有 `finalize()` 一处（不另开按需口）：压缩是读的一侧的呈现问题，不是一个该让模型或界面
   * 自己按下扳机的动作——多一个入口就多一份「什么时候折」的口径（§2.5）。
   * 返回值刻意是 void 而不是刚写下的那行读数：事实卡属于**读的那一侧**（见 `factCard()` 的注释），
   * 折的时候把它算出来存下，就成了第二份会过期的真值（§9 的 2.5-e 教训）。
   * @param sessionId 要折叠的会话 id——指**那条消息自己的**会话，而不是「此刻界面在看的那一条」，
   *   因为流式收尾时用户可能已经新建了会话
   * @returns 无。不满足触发条件时什么都不写；满足时库里多一行压缩读数
   */
  private compactSession(sessionId: string): void {
    const keep = this.config.compactKeepRecentMessages;
    const rows = this.storedRows(sessionId);
    if (rows.length <= keep) return;
    const tokensBefore = rows.reduce((total, row) => total + estimateTokens(row.parts), 0);
    if (tokensBefore <= this.config.compactTriggerTokens) return;
    const covered = rows.slice(0, rows.length - keep);
    const kept = rows.slice(rows.length - keep);
    const coveredIds = covered.map((row) => row.id);
    const fromTs = Number(covered[0]?.created_at ?? 0);
    const toTs = Number(covered[covered.length - 1]?.created_at ?? 0);
    const tokensAfter = kept.reduce((total, row) => total + estimateTokens(row.parts), 0);
    const existing = this.store.db
      .prepare('SELECT id FROM chat_compaction WHERE session_id = ? LIMIT 1')
      .get(sessionId) as { id?: string } | undefined;
    if (existing?.id) {
      // 一段会话只留**一行**压缩读数：折得越多次，那一行覆盖的前缀越长、`to_ts` 越靠后。
      // 每次插一行的写法会让「哪段被折了」有了多个答案，而读的一侧本来就只认一个（§2.5），
      // 而且那张表会随着对话无上限地长。
      this.store.db
        .prepare(
          `UPDATE chat_compaction SET from_ts = ?, to_ts = ?, covered_ids = ?, covered_count = ?,
           tokens_before = ?, tokens_after = ?, created_at = ? WHERE id = ?`,
        )
        .run(
          fromTs,
          toTs,
          JSON.stringify(coveredIds),
          coveredIds.length,
          tokensBefore,
          tokensAfter,
          Date.now(),
          existing.id,
        );
      return;
    }
    this.store.db
      .prepare(
        `INSERT INTO chat_compaction (id, session_id, from_ts, to_ts, covered_ids, covered_count,
         tokens_before, tokens_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        sessionId,
        fromTs,
        toTs,
        JSON.stringify(coveredIds),
        coveredIds.length,
        tokensBefore,
        tokensAfter,
        Date.now(),
      );
  }

  /**
   * 把一行压缩读数转成跨进程形状：bigint 收成 number，事实卡在这一步现问。
   * @param row `chat_compaction` 的一行（已由 `validCompactionRow` 验过原文还在）
   * @returns 界面与单测读的那一份
   */
  private viewOfRow(row: CompactionRow): ChatCompactionView {
    return {
      id: row.id,
      sessionId: row.session_id,
      fromTs: Number(row.from_ts),
      toTs: Number(row.to_ts),
      coveredCount: Number(row.covered_count),
      tokensBefore: Number(row.tokens_before),
      tokensAfter: Number(row.tokens_after),
      createdAt: Number(row.created_at),
      factCard: this.factCard(row.session_id),
    };
  }

  /**
   * 取这段会话里 `to_ts` 最大的那条压缩读数，并验它点名的原文行**都还在**库里。
   *
   * 对不上就返回 null（界面上整体退回原文）：这是 5.6-10 的结构半边——摘要行说丢了 12 条而库里只有 9 条，
   * 那就是摘要行错了，此时**看得全**比**看得短**重要，绝不让一段对不上号的摘要盖住原文。
   * @param sessionId 会话 id
   * @returns 有效的压缩读数行；没有或无效时为 null
   */
  private validCompactionRow(sessionId: string): CompactionRow | null {
    const row = this.store.db
      .prepare(
        `SELECT id, session_id, from_ts, to_ts, covered_ids, covered_count, tokens_before, tokens_after, created_at
         FROM chat_compaction WHERE session_id = ? ORDER BY to_ts DESC, created_at DESC LIMIT 1`,
      )
      .get(sessionId) as CompactionRow | undefined;
    if (!row) return null;
    const ids = JSON.parse(row.covered_ids) as string[];
    if (!ids.length || ids.length !== Number(row.covered_count)) return null;
    const placeholders = ids.map(() => '?').join(',');
    const present = this.store.db
      .prepare(`SELECT COUNT(*) AS n FROM chat_message WHERE session_id = ? AND id IN (${placeholders})`)
      .get(sessionId, ...ids) as { n?: number | bigint } | undefined;
    return Number(present?.n ?? 0) === ids.length ? row : null;
  }

  /**
   * 关键事实卡：五类白名单事实一律**此刻从真相问一遍**，不进摘要文本（spec 5.6-02，plan F5 + 决策三）。
   *
   * 为什么现问而不是折的时候一起存：§9 那条实测教训——本地存第二份事实，早晚会与真值不一致
   * （2.5-e 的打招呼渠道表就是被热改配置清空过）。而 5.6-03 要的「数值逐字不变」如果靠从旧消息里
   * 摘数字，永远只是近似；现问回来的那一位则是真值本身。
   * 问不到的那一位留 `null` / 空数组而不是猜：「这台机器没挂那只服务」与「额度剩 0」是两件事。
   * @param sessionId 会话 id
   * @returns 事实卡；跨服务的一律按名字现问（不写进 `static inject`，避免会话域与循环域互相依赖成环）
   */
  private factCard(sessionId: string): ChatFactCard {
    const gate = maybeService<{ check: (action: QuotaAction) => GateDecisionView }>(this.ctx, 'entitlement.gate');
    const ledger = maybeService<{ summary: (recentLimit?: number) => UsageSummaryView }>(this.ctx, 'usage.ledger');
    const loop = maybeService<{ latestRun: (sessionId: string) => AgentRunView | null }>(this.ctx, 'agent.loop');
    const run = loop?.latestRun(sessionId) ?? null;
    const summary = ledger?.summary(30) ?? null;
    return {
      autonomy: this.readSession(sessionId).autonomy,
      // 闸门没挂载时给**空数组**而不是三项 null：`remaining: null` 在 1.9-02 里说的是「不限额」，
      // 用它兼表「问不到」就会把「这台机器没挂闸门」画成「额度无限」——那是最贵的一种误读。
      remainingByAction: gate
        ? QUOTA_ACTIONS.map((action) => ({ action, remaining: gate.check(action).remaining }))
        : [],
      lastStopReason: run?.stopReason ?? null,
      refusedSteps:
        run?.steps
          .filter((step) => step.status === 'refused')
          .map((step) => ({ toolId: step.toolId, code: step.code })) ?? [],
      deliveredTargetIds: (summary?.recent ?? [])
        .filter((row) => row.action === 'deliver' && row.targetId)
        .map((row) => row.targetId as string),
    };
  }

  /**
   * 库里已落定的消息行（不含正在流式那一条），按时间升序。
   * @param sessionId 会话 id
   * @returns 原始行；`messagesOf()` 与 `compactSession()` 共用这一份查询（§2.2）
   */
  private storedRows(sessionId: string): MessageRow[] {
    // 次级排序用 `rowid` 而不是 `id`：同一毫秒里落的两行（用户那条与流式收尾那条）时间戳相同，
    // 而 id 是随机 UUID——按 id 排会把「后落的那条」排到前面，折叠因此可能折掉最新的一行。
    // `chat_message` 不是 WITHOUT ROWID 表，rowid 就是落库顺序。
    return this.store.db
      .prepare(
        'SELECT id, session_id, role, parts, created_at FROM chat_message WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(sessionId) as unknown as MessageRow[];
  }

  /**
   * 发一条用户消息并起一次假回复的流式。
   * @param textRaw 渲染层传来的原文，按系统边界校验（去空、限长）
   * @returns 刚进入流式态的助手消息（`isStreaming: true`），界面据此摆运行中指示
   * @throws 空输入 `CHAT_EMPTY_INPUT`；超长 `CHAT_INPUT_TOO_LONG`；上一条还在跑 `CHAT_BUSY`
   */
  send(textRaw: string): ChatMessageView {
    const text = textRaw.trim();
    if (!text) throw new AppError('CHAT_EMPTY_INPUT', '消息内容为空，不写入会话', 'chat.session', {});
    if (text.length > MAX_USER_INPUT_CHARS) {
      throw new AppError(
        'CHAT_INPUT_TOO_LONG',
        `消息最长 ${String(MAX_USER_INPUT_CHARS)} 字，当前 ${String(text.length)} 字`,
        'chat.session',
        {
          length: text.length,
        },
      );
    }
    if (this.live) {
      throw new AppError('CHAT_BUSY', '上一条回复还在生成中，先按「停止」再发送', 'chat.session', {
        messageId: this.live.id,
      });
    }
    const sessionId = this.ensureSession();
    const at = Date.now();
    // 进入对话记录之前先脱敏（spec 5.6-05）：事件、内存镜像、落库三条去路共用这一份值，遮一处不如遮源头。
    const safeText = redactText(text);
    this.insertMessage(sessionId, 'user', [{ kind: 'text', text: safeText }], at);
    const message: ChatMessageView = {
      id: randomUUID(),
      sessionId,
      role: 'assistant',
      parts: [{ kind: 'text', text: '' }],
      createdAt: at + 1,
      isStreaming: true,
    };
    this.live = message;
    this.controller = new AbortController();
    // `text` 只多带这一层：`/tool` 的入参要按原样交给注册表，见 `pump` 的 `rawText` 注释。
    void this.pump(message, safeText, text);
    return message;
  }

  /**
   * 中止正在进行的流式，并把已经吐出的部分**如实**落库（不做「假装说完」）。
   * @returns 落库后的那条消息；没有在流式时返回 null
   */
  stop(): ChatMessageView | null {
    const message = this.live;
    if (!message) return null;
    this.controller?.abort();
    return this.finalize(message);
  }

  /**
   * 切换自治档位（1.11-07）——**档位列全仓唯一的写入口**，且只由界面点击触发（spec 5.3-04）。
   *
   * 循环拿不到这只手：它没有对应的 agent 工具，`loop.ts` 里也只读 `current()`（这条由
   * `scripts/check-agent-model-authority.ts` 静态钉住）。每次真的改了值都落一条审计（5.3-05）；
   * 传进同一个档位是「没发生变更」，不写审计行——审计记的是变更，不是点击次数。
   * @param levelRaw 档位名，来自渲染层，按不可信输入校验
   * @returns 更新后的会话读数
   * @throws 非法档位以 `CHAT_AUTONOMY_INVALID` 结构化失败
   */
  setAutonomy(levelRaw: string): ChatSessionView {
    if (!(AUTONOMY_LEVELS as readonly string[]).includes(levelRaw)) {
      throw new AppError('CHAT_AUTONOMY_INVALID', `未知自治档位 ${levelRaw}`, 'chat.session', {
        level: levelRaw,
        known: [...AUTONOMY_LEVELS],
      });
    }
    const id = this.ensureSession();
    const before = this.readSession(id).autonomy;
    this.store.db.prepare('UPDATE chat_session SET autonomy = ? WHERE id = ?').run(levelRaw, id);
    if (before !== levelRaw) {
      this.store.db
        .prepare(
          `INSERT INTO chat_autonomy_audit (session_id, from_autonomy, to_autonomy, source, created_at)
           VALUES (?, ?, ?, 'user', ?)`,
        )
        .run(id, before, levelRaw, Date.now());
    }
    return this.readSession(id);
  }

  /**
   * 读档位变更审计（spec 5.3-05 的「可查询」半边）。
   * @param sessionId 会话 id；省略时取当前会话
   * @returns 最近 `AUTONOMY_AUDIT_LIMIT` 条变更，按时间倒序（最新在前）；从没改过档时是空数组
   */
  autonomyAudit(sessionId?: string): AutonomyAuditRow[] {
    const id = sessionId ?? this.ensureSession();
    const rows = this.store.db
      .prepare(
        `SELECT id, session_id, from_autonomy, to_autonomy, source, created_at FROM chat_autonomy_audit
         WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(id, AUTONOMY_AUDIT_LIMIT) as unknown as {
      id: number | bigint;
      session_id: string;
      from_autonomy: string;
      to_autonomy: string;
      source: string;
      created_at: number | bigint;
    }[];
    return rows.map((row) => ({
      id: Number(row.id),
      sessionId: row.session_id,
      fromAutonomy: coerceAutonomy(row.from_autonomy),
      toAutonomy: coerceAutonomy(row.to_autonomy),
      source: row.source,
      createdAt: Number(row.created_at),
    }));
  }

  /**
   * 另起一个新会话（1.11-08 的「新建会话不影响旧会话」）。
   *
   * 旧会话的行一条都不动，只是不再是「最新的那一个」；正在流式的回复先如实收尾。
   * @returns 新会话的整份快照（消息为空）
   */
  startSession(): ChatSnapshotView {
    this.stop();
    this.store.db
      .prepare('INSERT INTO chat_session (id, autonomy, created_at) VALUES (?, ?, ?)')
      .run(randomUUID(), this.config.defaultAutonomy, Date.now());
    return this.current();
  }

  /**
   * 给**当前**会话起一个名字（spec 5.6-07 的「重命名」）。
   *
   * 只作用于当前会话、不接 sessionId：界面上此刻就只有这一条会话可看（没有切换口），
   * 而「改哪一条」由界面决定会变成「猜另一条也许可爱的会话」。
   * @param titleRaw 渲染层传来的原文（去空、限长，进库之前脱敏）
   * @returns 更新后的会话读数
   * @throws 空标题 `CHAT_TITLE_EMPTY`；超长 `CHAT_TITLE_TOO_LONG`
   */
  rename(titleRaw: string): ChatSessionView {
    const title = titleRaw.trim();
    if (!title) throw new AppError('CHAT_TITLE_EMPTY', '会话标题不能为空，起个名字总得有几个字', 'chat.session', {});
    if (title.length > MAX_SESSION_TITLE_CHARS) {
      throw new AppError(
        'CHAT_TITLE_TOO_LONG',
        `会话标题最长 ${String(MAX_SESSION_TITLE_CHARS)} 字，当前 ${String(title.length)} 字`,
        'chat.session',
        { length: title.length },
      );
    }
    const id = this.ensureSession();
    // 标题也是「进对话记录」的一条：它会画在头部、也会跟着 5.6 的导出一起走，所以同一只 redactText 手（spec 5.6-05）。
    this.store.db.prepare('UPDATE chat_session SET title = ? WHERE id = ?').run(redactText(title), id);
    return this.readSession(id);
  }

  /**
   * 软删**当前**会话（spec 5.6-07 的「删除」）：只给这一行打个时间戳，消息与 run 的行一条都不动。
   *
   * 为什么不做硬删：判据要「提示恢复途径」，而那条途径之所以是真的，就是因为数据还在库里。
   * 为什么删完不需要另立「选中会话」状态：当前会话的定义本来就是「未删会话里最新的那一条」
   * （`currentSessionId`），打上标记之后 `current()` 自然落到上一条，多存一份指针就是 §2.7 禁的第二份事实。
   * @returns 被删那一行的读数（带着刚打上的 `deletedAt`），界面拿它的 id 作「撤销」的凭据
   * @throws 库里没有任何未删会话时 `CHAT_SESSION_NOT_FOUND`（不去删一条本就不存在的东西）
   */
  remove(): ChatSessionView {
    const id = this.currentSessionId();
    if (!id) throw new AppError('CHAT_SESSION_NOT_FOUND', '没有可删除的会话', 'chat.session', {});
    this.store.db.prepare('UPDATE chat_session SET deleted_at = ? WHERE id = ?').run(Date.now(), id);
    return this.readSession(id);
  }

  /**
   * 撤销一次软删（spec 5.6-07 的「恢复途径」：界面上那句提示必须指向一只真按得下去的按钮）。
   * @param sessionId 要恢复的会话 id，来自 `remove()` 或 `trashed()` 的读数；不取「最近被删的那条」——那会让误点变成第二次删除的续命
   * @returns 恢复后的会话读数（`deletedAt` 回到 null）
   * @throws 没有这一行 `CHAT_SESSION_NOT_FOUND`；这一行根本没被删过 `CHAT_SESSION_NOT_DELETED`
   */
  restore(sessionId: string): ChatSessionView {
    const row = this.store.db.prepare('SELECT deleted_at FROM chat_session WHERE id = ?').get(sessionId) as
      { deleted_at?: number | bigint | null } | undefined;
    if (!row) {
      throw new AppError('CHAT_SESSION_NOT_FOUND', `找不到会话 ${sessionId}`, 'chat.session', { sessionId });
    }
    if (row.deleted_at === null || row.deleted_at === undefined) {
      throw new AppError('CHAT_SESSION_NOT_DELETED', `会话 ${sessionId} 并没有被删除，无需恢复`, 'chat.session', {
        sessionId,
      });
    }
    this.store.db.prepare('UPDATE chat_session SET deleted_at = NULL WHERE id = ?').run(sessionId);
    return this.readSession(sessionId);
  }

  /**
   * 列出被软删的会话（spec 5.6-07 的「恢复途径」要有的一份读数）。
   *
   * 为什么不能只把刚删的那条的 id 存在前端内存里：那句撤销提示一旦随重启消失，库里那一行就再没有途径捞回来，
   * 「软删」在用户眼里就等同于硬删——正是判据要防的那件事。这一口只查已删的那些，不是会话切换器（5.6 之外的事）。
   * @returns 按删除时间倒序的会话读数；一条都没删过时为空数组（界面据此整块不渲染，不占一行）
   */
  trashed(): ChatSessionView[] {
    const rows = this.store.db
      .prepare('SELECT id FROM chat_session WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC')
      .all() as { id: string }[];
    return rows.map((row) => this.readSession(row.id));
  }

  [Service.init](): void {
    // 卸载时必须让出在跑的流式，否则 `plugins.stop('chat')` 之后定时器链还在往没人看的消息里灌字。
    this.ctx.effect(() => () => this.controller?.abort());
    this.ensureSchema();
    this.ctx.logger.info(
      `对话会话就绪：分片 ${String(this.config.chunkChars)} 字 / ${String(this.config.chunkIntervalMs)}ms，` +
        `新会话默认档位 ${this.config.defaultAutonomy}`,
    );
  }

  /**
   * 把会话域的迁移登记进 `store.migrations` 并建表（号段 2 的会话/消息 + 号段 17 的档位审计 + 号段 23 的标题与软删）。
   *
   * 幂等是硬要求：`plugins.start('chat')` 会重新构造本服务，无条件 push 同一个 version
   * 会让 `runMigrations` 直接抛「迁移版本重复」（plan §8.4 决策 5）。
   */
  private ensureSchema(): void {
    const migrations = this.store.migrations;
    for (const migration of [
      chatMigration,
      chatAutonomyAuditMigration,
      chatSessionMetaMigration,
      chatCompactionMigration,
    ]) {
      if (!migrations.some((registered) => registered.version === migration.version)) {
        migrations.push(migration);
      }
    }
    this.store.upgrade();
  }

  /**
   * 取最新**未删**会话的 id；一个都没有时就地建一个**默认档位**的（5.3-02：默认值来自配置，缺省即最保守）。
   * @returns 当前会话 id，永不为空
   */
  private ensureSession(): string {
    const existing = this.currentSessionId();
    if (existing) return existing;
    const id = randomUUID();
    this.store.db
      .prepare('INSERT INTO chat_session (id, autonomy, created_at) VALUES (?, ?, ?)')
      .run(id, this.config.defaultAutonomy, Date.now());
    return id;
  }

  /**
   * 「当前会话」的唯一判定口径：未删会话里按创建时间最新的那一条。
   *
   * 为什么按 `created_at DESC, id DESC` 而不是另存一个指针：软删之后这条口径自己就会落到上一条，
   * 再存一份「选中的会话」就是第二处事实，两处不一致时界面上会出现「删掉的会话还在画消息」（§2.7）。
   * `id DESC` 是并列时间戳时的稳定 tiebreaker（同一毫秒建出两条会话是可能的）。
   * @returns 会话 id；一条未删的都没有时为 undefined——调用方决定是报错（`remove`）还是就地建一条（`ensureSession`）
   */
  private currentSessionId(): string | undefined {
    const row = this.store.db
      .prepare('SELECT id FROM chat_session WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1')
      .get() as { id?: string } | undefined;
    return row?.id;
  }

  /**
   * 读一个会话的界面读数。
   * @param id 会话 id
   * @returns 档位 + 标题 + 软删标记 + 已落库消息条数（正在流式那条不计，它还没进表）
   */
  private readSession(id: string): ChatSessionView {
    const row = this.store.db
      .prepare('SELECT id, autonomy, created_at, title, deleted_at FROM chat_session WHERE id = ?')
      .get(id) as SessionRow | undefined;
    if (!row) throw new Error(`会话 ${id} 的行缺失（ensureSession 之后不应发生）`);
    const count = this.store.db.prepare('SELECT COUNT(*) AS n FROM chat_message WHERE session_id = ?').get(id) as
      { n?: number | bigint } | undefined;
    return {
      id: row.id,
      // 未知值一律收成最保守档：这一列可能被外部改过，而「读不懂」绝不能读成一个更宽的档（5.3-02）。
      autonomy: coerceAutonomy(row.autonomy),
      createdAt: Number(row.created_at),
      messageCount: Number(count?.n ?? 0),
      // 标题为 null 就是「人没起过名」，界面自己用 i18n 的默认称呼补（主进程不造文案，见 ChatSessionView 的注释）。
      title: row.title,
      deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
    };
  }

  /**
   * 一个会话的消息列表：库里的历史 + 正在流式那一条（按时间排在最后）。
   * @param sessionId 会话 id
   * @returns 有序数组
   */
  private messagesOf(sessionId: string): ChatMessageView[] {
    const history = this.storedRows(sessionId).map(toMessageView);
    if (this.live?.sessionId === sessionId) history.push(this.live);
    return history;
  }

  /**
   * 落库一条已完成的消息。
   * @param sessionId 会话 id
   * @param role 作者
   * @param parts 内容段数组（必须可 JSON 序列化）
   * @param at 时间戳（毫秒）
   */
  private insertMessage(sessionId: string, role: 'user' | 'assistant', parts: ChatPart[], at: number): void {
    this.store.db
      .prepare('INSERT INTO chat_message (id, session_id, role, parts, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), sessionId, role, JSON.stringify(parts), at);
  }

  /**
   * 流式推进：一片一片把模板回复吐出去，每片推一条 `chat/delta`。
   * @param message 本次要填充的助手消息（内存镜像）
   * @param userText 已脱敏的用户文本，用于生成模板与判定是否演示工具（回复里回显的就是这一份）
   * @param rawText 用户原文，**只**交给 `attachToolPart` 解析一次入参：`/tool` 打给注册表的那份
   *   必须是原样，否则一个 11 位岗位 id 会被手机号规则吃掉，脱敏就变成了破坏功能。它不进事件、不落库、不写进卡片。
   */
  private async pump(message: ChatMessageView, userText: string, rawText: string): Promise<void> {
    const controller = this.controller;
    const reply = this.fakeReplyFor(userText);
    for (let cursor = 0; cursor < reply.length; cursor += this.config.chunkChars) {
      const piece = reply.slice(cursor, cursor + this.config.chunkChars);
      const first = message.parts[0];
      if (first?.kind === 'text') first.text += piece;
      this.ctx.emit('chat/delta', { sessionId: message.sessionId, messageId: message.id, text: piece, done: false });
      await sleep(this.config.chunkIntervalMs, controller?.signal);
      // 让出之后必须先确认「这次让出是谁引起的」：stop()/新建会话已经把它落库并从内存摘掉了。
      if (controller?.signal.aborted || this.live !== message) return;
    }
    if (userText.startsWith(TOOL_DEMO_PREFIX)) await this.attachToolPart(message, rawText);
    this.finalize(message);
  }

  /**
   * 追加一段工具卡片并真调注册表（spec 2.8-09：`/tool`→`demo.echo` 的壳换成真调用）。
   * @param message 要追加卡片的助手消息
   * @param userText 用户**原文**，前缀之后的内容按 `/tool <工具id> [入参 JSON]` 解析；
   *   卡片与落库拿的是解析后脱敏的那一份（spec 5.6-05），真调注册表用原样那一份（见 `pump` 的 `rawText`）
   */
  private async attachToolPart(message: ChatMessageView, userText: string): Promise<void> {
    const { toolId, input } = parseToolRequest(userText.slice(TOOL_DEMO_PREFIX.length).trim());
    const part: ChatToolPart = {
      kind: 'tool',
      toolCallId: randomUUID(),
      toolId,
      input: redactValue(input),
      state: 'running',
      output: null,
      durationMs: null,
      errorText: null,
    };
    message.parts.push(part);
    // `running` 必须推出去：正在流式的那条消息被 ChatPanel 从快照里滤掉（plan §15.8 落点 2），
    // 不让卡片经事件带一线，界面上就永远看不见「执行中」这一态。
    this.emitTool(message, part);
    const at = Date.now();
    const reply = await this.registry.call(toolId, input);
    part.durationMs = Date.now() - at;
    if (reply.ok) {
      // 工具产出是从页面上读来的原文，可能带着 HR 的手机号与邮箱（§8.5 默认脱敏，spec 5.6-05）。
      part.state = 'done';
      part.output = redactValue(reply.result);
    } else {
      // §1.7 第 8 条：原样回报，卡片就是失败态——"原样"说的是代码与原因不改写，不是把 PII 也照抄。
      part.state = 'failed';
      part.errorText = redactText(`${reply.code}：${reply.message}`);
    }
    this.emitTool(message, part);
  }

  /**
   * 推一次工具卡片的状态跳变。
   * @param message 卡片所属的助手消息
   * @param part 卡片当前读数（含最新状态）；复制一份，避免界面持有可变引用
   */
  private emitTool(message: ChatMessageView, part: ChatToolPart): void {
    this.ctx.emit('chat/delta', {
      sessionId: message.sessionId,
      messageId: message.id,
      text: '',
      done: false,
      tool: { ...part },
    });
  }

  /**
   * 收尾：落库、推 `done`、把内存镜像摘掉。
   * @param message 要收尾的助手消息
   * @returns 落库后的读数（`isStreaming` 归 false）
   */
  private finalize(message: ChatMessageView): ChatMessageView {
    this.insertMessage(message.sessionId, 'assistant', message.parts, message.createdAt);
    if (this.live === message) this.live = undefined;
    // 「长会话触发压缩」的触发点在这里而不是在 `send()`：一条回复落定之后这段对话才完整，
    // 而折叠的门槛是行数与 token（都不满足就返回 null，什么都不写）。它不改变返回给界面的那一条消息，
    // 界面下一次 `current()` 自然看见少掉的那一截 + 一行摘要（原文行一条都没动，见 `compactSession()` 的注释）。
    this.compactSession(message.sessionId);
    this.ctx.emit('chat/delta', { sessionId: message.sessionId, messageId: message.id, text: '', done: true });
    return { ...message, isStreaming: false };
  }

  /**
   * 本地确定性假回复（P1 唯一的「生成」）。
   * @param userText 用户原文（已去空）
   * @returns 一整句要分片吐出去的文本；纯函数，因此单测可以直接断言长度与内容
   */
  private fakeReplyFor(userText: string): string {
    const hint = userText.startsWith(TOOL_DEMO_PREFIX)
      ? '工具名称、关键参数、状态与耗时显示在下方卡片里。'
      : '想演示工具卡片，把消息以 /tool 开头再发一次（可跟工具 id 与入参 JSON，缺省走 jd.capture.run）。';
    return `已收到：「${userText}」。这是对话骨架的本地确定性回复——不接 LLM、不发网络请求；以 /tool 开头的那条会真调注册表，外发级工具按 2.8-10 经额度闸门与账本。${hint}`;
  }
}

declare module '@auto-cc/core' {
  interface AppServices {
    'chat.session': ChatSessionService;
  }
}
