/**
 * `chat.session` 服务（spec 1.11-02 / 03 / 07 / 08 / 13）：会话、消息、档位与流式假回复。
 *
 * 消息模型是 `parts` 的有序数组（文本段 + 工具卡片段），形状对齐 AI SDK 的 `UIMessage`
 * 但零依赖（选型证据见 plan §8.6）。助手回复由**本地确定性模板**生成：不接 LLM、不发网络请求，
 * P5 换成真模型时改的只有 `fakeReplyFor()` 与 `pump()` 的来源，界面与协议一行不动。
 *
 * 为什么正在流式的那条消息不落库：`chat_message` 只存**已完成**的消息。半截回复留在内存里，
 * 于是 app 被杀掉时不会留下一行「永远在流式」的孤儿数据，重启后读到的历史必然是完整的（1.11-08）。
 */
import {
  AUTONOMY_LEVELS,
  AppError,
  Service,
  asApp,
  sleep,
  type AutonomyLevel,
  type ChatMessageView,
  type ChatPart,
  type ChatSessionView,
  type ChatSnapshotView,
  type ChatToolPart,
  type Context,
} from '@auto-cc/core';
import type { StoreService } from '@auto-cc/plugin-store';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
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

/** 会话表的一行原始读数（列名是 snake_case，转成视图的工作收在 `toMessageView`）。 */
type SessionRow = { id: string; autonomy: string; created_at: number | bigint };

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
});

/** 校验后的配置形状（在装配面板可热改，走 1.5 的 `plugins.saveConfig`）。 */
export type ChatConfig = z.output<typeof chatConfigSchema>;

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
   * 当前会话的整份快照：会话读数 + 已落库消息 + 正在流式那一条（如果有）。
   * @returns 永不为 null——首次访问会就地建出一个默认档位的会话
   */
  current(): ChatSnapshotView {
    const session = this.readSession(this.ensureSession());
    return { session, messages: this.messagesOf(session.id) };
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
    this.insertMessage(sessionId, 'user', [{ kind: 'text', text }], at);
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
    void this.pump(message, text);
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
   * 切换自治档位（1.11-07）。P1 只写这一列，不产生任何行为差异。
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
    this.store.db.prepare('UPDATE chat_session SET autonomy = ? WHERE id = ?').run(levelRaw, id);
    return this.readSession(id);
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
      .run(randomUUID(), 'suggest', Date.now());
    return this.current();
  }

  [Service.init](): void {
    // 卸载时必须让出在跑的流式，否则 `plugins.stop('chat')` 之后定时器链还在往没人看的消息里灌字。
    this.ctx.effect(() => () => this.controller?.abort());
    this.ensureSchema();
    this.ctx.logger.info(
      `对话会话就绪：分片 ${String(this.config.chunkChars)} 字 / ${String(this.config.chunkIntervalMs)}ms，档位默认 suggest`,
    );
  }

  /**
   * 把会话表的迁移登记进 `store.migrations` 并建表。
   *
   * 幂等是硬要求：`plugins.start('chat')` 会重新构造本服务，无条件 push 同一个 version
   * 会让 `runMigrations` 直接抛「迁移版本重复」（plan §8.4 决策 5）。
   */
  private ensureSchema(): void {
    const migrations = this.store.migrations;
    if (!migrations.some((migration) => migration.version === CHAT_MIGRATION_VERSION)) {
      migrations.push(chatMigration);
    }
    this.store.upgrade();
  }

  /**
   * 取最新会话的 id；一个都没有时就地建一个默认档位的。
   * @returns 当前会话 id，永不为空
   */
  private ensureSession(): string {
    const row = this.store.db.prepare('SELECT id FROM chat_session ORDER BY created_at DESC, id DESC LIMIT 1').get() as
      { id?: string } | undefined;
    if (row?.id) return row.id;
    const id = randomUUID();
    this.store.db
      .prepare('INSERT INTO chat_session (id, autonomy, created_at) VALUES (?, ?, ?)')
      .run(id, 'suggest', Date.now());
    return id;
  }

  /**
   * 读一个会话的界面读数。
   * @param id 会话 id
   * @returns 档位 + 已落库消息条数（正在流式那条不计，它还没进表）
   */
  private readSession(id: string): ChatSessionView {
    const row = this.store.db.prepare('SELECT id, autonomy, created_at FROM chat_session WHERE id = ?').get(id) as
      SessionRow | undefined;
    if (!row) throw new Error(`会话 ${id} 的行缺失（ensureSession 之后不应发生）`);
    const count = this.store.db.prepare('SELECT COUNT(*) AS n FROM chat_message WHERE session_id = ?').get(id) as
      { n?: number | bigint } | undefined;
    return {
      id: row.id,
      autonomy: row.autonomy as AutonomyLevel,
      createdAt: Number(row.created_at),
      messageCount: Number(count?.n ?? 0),
    };
  }

  /**
   * 一个会话的消息列表：库里的历史 + 正在流式那一条（按时间排在最后）。
   * @param sessionId 会话 id
   * @returns 有序数组
   */
  private messagesOf(sessionId: string): ChatMessageView[] {
    const rows = this.store.db
      .prepare(
        'SELECT id, session_id, role, parts, created_at FROM chat_message WHERE session_id = ? ORDER BY created_at ASC, id ASC',
      )
      .all(sessionId) as unknown as MessageRow[];
    const history = rows.map(toMessageView);
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
   * @param userText 触发这次回复的用户输入，用于生成模板与判定是否演示工具
   */
  private async pump(message: ChatMessageView, userText: string): Promise<void> {
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
    if (userText.startsWith(TOOL_DEMO_PREFIX)) await this.attachToolPart(message, userText);
    this.finalize(message);
  }

  /**
   * 追加一段工具卡片并真调注册表（spec 2.8-09：`/tool`→`demo.echo` 的壳换成真调用）。
   * @param message 要追加卡片的助手消息
   * @param userText 用户原文，前缀之后的内容按 `/tool <工具id> [入参 JSON]` 解析
   */
  private async attachToolPart(message: ChatMessageView, userText: string): Promise<void> {
    const { toolId, input } = parseToolRequest(userText.slice(TOOL_DEMO_PREFIX.length).trim());
    const part: ChatToolPart = {
      kind: 'tool',
      toolCallId: randomUUID(),
      toolId,
      input,
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
      part.state = 'done';
      part.output = reply.result;
    } else {
      // §1.7 第 8 条：原样回报，卡片就是失败态。
      part.state = 'failed';
      part.errorText = `${reply.code}：${reply.message}`;
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
