/**
 * 对话式主界面（spec 1.11）：首页第一入口，工作流面板退居第二视图（AGENTS.md §5.9）。
 *
 * 这里画的是**主进程那份会话**的镜像：消息一律来自 `chat.session.current()` 与 `chat/delta` 事件，
 * 组件不自己拼句子、不自己判进度。助手回复目前是本地确定性模板（P1 不接 LLM），
 * P5 换成真模型时改的是主进程的生成函数，这个文件一行不用改。
 */
import { Bot, Gauge, LoaderCircle, Plus, Send, Square, User, Workflow as WorkflowIcon, Wrench } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AutonomyLevel,
  ChatMessageView,
  ChatSnapshotView,
  ChatToolPart,
  ToolDescriptorView,
} from '@auto-cc/shared';
import { useBridgeAction } from './useBridgeAction';
import { useWorkflowRun } from './useWorkflowRun';

/**
 * 自治档位的三个入口。
 * 主进程侧的枚举在 `@auto-cc/core`，渲染层引它会把 cordis 拖进 bundle，所以这里本地列一遍，
 * 用 `satisfies` 钉在同一个联合类型上：档位名一改，这里编译期就断。
 */
const AUTONOMY_OPTIONS = ['suggest', 'semi', 'auto'] as const satisfies readonly AutonomyLevel[];

/** 工具卡片的状态配色；状态本身来自主进程写在 `parts[]` 里的那一份。 */
const TOOL_STATE_STYLE: Record<ChatToolPart['state'], string> = {
  running: 'border-amber-900 bg-amber-950/30 text-amber-200',
  done: 'border-emerald-900 bg-emerald-950/30 text-emerald-300',
  failed: 'border-rose-900 bg-rose-950/40 text-rose-200',
};

/**
 * 工具 id → 界面标题的 i18n key，九个已登记的能力各一条（spec 2.8-09）。
 * id 里带点，而语言包按点分层，所以键用短码；映射表在编译期钉住，未落进来的 id 走 `agent.tool.unregistered`。
 */
const TOOL_LABEL_KEY: Record<string, string> = {
  'browser.act.click': 'agent.tool.labels.actClick',
  'browser.act.type': 'agent.tool.labels.actType',
  'browser.locate.find': 'agent.tool.labels.locateFind',
  'browser.page.navigate': 'agent.tool.labels.pageNavigate',
  'browser.page.snapshot': 'agent.tool.labels.pageSnapshot',
  'jd.capture.run': 'agent.tool.labels.jdCapture',
  'outbound.deliver.perform': 'agent.tool.labels.deliverPerform',
  'outbound.greet.perform': 'agent.tool.labels.greetPerform',
  'sessions.open': 'agent.tool.labels.sessionsOpen',
};

/** 界面上正在累加的那条助手回复（主进程快照在流式期间也带这条，两边同时画会重复，所以过滤掉它）。 */
type LiveStream = { sessionId: string; messageId: string; text: string; tool?: ChatToolPart };

/**
 * 一张工具调用卡片（spec 2.8-09：工具名、关键参数、状态、耗时，外加副作用分级）。
 *
 * 卡片是**一条消息的一部分**，不是另一条消息：agent 一次输出「文本 + 工具调用」时不需要改表。
 * @param part 主进程写进 `parts[]`（或经 `chat/delta` 带出）的工具段
 * @param meta 注册表里这只工具的声明（`agent.tools.list()` 的读数）；未登记或读数未回来时为 undefined
 * @returns 标题 + 入参摘要 + 状态 + 分级；失败时把结构化原因原样显示，不改口成「已完成」
 */
function ToolCard({ part, meta }: { part: ChatToolPart; meta?: ToolDescriptorView }) {
  const { t } = useTranslation();
  const labelKey = TOOL_LABEL_KEY[part.toolId];
  return (
    <div
      data-testid="chat-tool-card"
      data-tool-id={part.toolId}
      data-tool-state={part.state}
      data-tool-effect={meta?.effect ?? 'unknown'}
      data-tool-confirm={meta ? String(meta.requiresConfirmation) : 'unknown'}
      className={`mt-2 rounded-lg border px-3 py-2 text-[11px] ${TOOL_STATE_STYLE[part.state]}`}
    >
      <div className="flex items-center gap-2">
        <Wrench size={12} />
        <span className="font-medium">{t(labelKey ?? 'agent.tool.unregistered')}</span>
        <span className="font-mono text-slate-500">{part.toolId}</span>
        <span className="ml-auto" data-tool-status={t(`agent.tool.state.${part.state}`)}>
          {t(`agent.tool.state.${part.state}`)}
        </span>
      </div>
      <p className="mt-1 break-all text-slate-400" data-tool-input={JSON.stringify(part.input)}>
        {t('agent.tool.input', { input: JSON.stringify(part.input) })}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-slate-500">
        {part.durationMs !== null ? (
          <span data-tool-duration={String(part.durationMs)}>{t('agent.tool.duration', { ms: part.durationMs })}</span>
        ) : null}
        {meta ? <span>{t(`agent.tool.effect.${meta.effect}`)}</span> : null}
        {meta?.requiresConfirmation ? <span data-tool-needs-approval>{t('agent.tool.needsConfirm')}</span> : null}
        {part.errorText ? (
          <span className="break-all text-rose-300" data-tool-error={part.errorText}>
            {part.errorText}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 一条消息：用户右对齐、助手左对齐，`parts[]` 按顺序渲染（文本段 + 工具卡片段）。
 * @param message 主进程返回的消息视图
 * @param toolMetas 注册表读数按 id 建的索引，卡片用它显示副作用分级
 * @returns 气泡节点
 */
function MessageBubble({
  message,
  toolMetas,
}: {
  message: ChatMessageView;
  toolMetas: Map<string, ToolDescriptorView>;
}) {
  const isUser = message.role === 'user';
  return (
    <li
      data-message-id={message.id}
      data-message-role={message.role}
      className={`flex gap-2 ${isUser ? 'flex-row-reverse' : ''}`}
    >
      <span className="mt-1 shrink-0 text-slate-500">{isUser ? <User size={14} /> : <Bot size={14} />}</span>
      <div
        className={`max-w-[85%] rounded-xl border px-3 py-2 text-xs ${isUser ? 'border-sky-900 bg-sky-950/40 text-sky-100' : 'border-slate-800 bg-slate-900/70 text-slate-200'}`}
      >
        {message.parts.map((part, index) =>
          part.kind === 'text' ? (
            <p
              key={`${message.id}-text-${String(index)}`}
              className="whitespace-pre-wrap break-words"
              data-part-kind="text"
            >
              {part.text}
            </p>
          ) : (
            <ToolCard key={`${message.id}-tool-${String(index)}`} part={part} meta={toolMetas.get(part.toolId)} />
          ),
        )}
      </div>
    </li>
  );
}

/**
 * 对话面板：消息流 + 输入区 + 运行中指示三块最小结构（spec 1.11-02），加档位与新建会话两个入口。
 * @returns 占满可用高度的聊天面板；主进程快照未回来之前消息流显示占位文案
 */
export function ChatPanel() {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<ChatSnapshotView>();
  const [liveStream, setLiveStream] = useState<LiveStream>();
  const [tools, setTools] = useState<ToolDescriptorView[]>([]);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const bridge = window.autoCC;
  // 对话与工作流镜像同一个 runner 实例（spec 1.10-08 的后半句判据）。
  const { run } = useWorkflowRun();

  const read = useCallback(async () => {
    const reply = await bridge?.chat['session.current']();
    if (reply?.ok) setSnapshot(reply.value);
  }, [bridge]);

  /** 读注册表声明（卡片上的副作用分级由主进程给，界面不自己标）。 */
  const readTools = useCallback(async () => {
    const reply = await bridge?.agent['tools.list']();
    if (reply?.ok) setTools(reply.value);
  }, [bridge]);

  useEffect(() => {
    void read();
    void readTools();
  }, [read, readTools]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.on('chat/delta', (event) => {
      if (event.done) {
        // 收尾以主进程的重读为准：那条消息已经从内存挪进 `chat_message`，快照里才有完整文本与工具段。
        setLiveStream(undefined);
        void read();
        return;
      }
      setLiveStream((prev) => {
        const base =
          prev && prev.messageId === event.messageId
            ? { ...prev, text: prev.text + event.text }
            : { sessionId: event.sessionId, messageId: event.messageId, text: event.text };
        // 卡片的两跳（running → 终态）都靠这一位带出来：流式期间那条消息不在快照的可画集合里。
        return event.tool ? { ...base, tool: event.tool } : base;
      });
    });
  }, [bridge, read]);

  const toolMetas = useMemo(() => new Map(tools.map((tool) => [tool.id, tool])), [tools]);
  const messages = snapshot?.messages.filter((message) => !message.isStreaming) ?? [];
  const isStreaming = liveStream !== undefined;

  // 新片段落在最下面，滚动位置跟过去，否则连拍截图看到的是上面几行。
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [snapshot, liveStream]);

  const { busy, notice, run: call } = useBridgeAction(read);

  /** 发送输入框里的话；流式期间不发（主进程会以 `CHAT_BUSY` 结构化拒绝，但按钮先禁用更清楚）。 */
  const submit = () => {
    const text = draft.trim();
    if (!text || isStreaming) return;
    void call(t('chat.actionSend'), () => bridge?.chat['session.send'](text), {
      apply: () => setDraft(''),
    });
  };

  /**
   * 回车发送、Shift+回车换行（spec 1.11-02）。
   * @param event 键盘事件
   */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <section
      data-testid="chat-panel"
      className="flex h-full flex-col rounded-xl border border-slate-800 bg-slate-900/60"
    >
      <header className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Bot size={16} />
          {t('chat.heading')}
        </h2>
        <div className="ml-auto flex items-center gap-2">
          {run ? (
            <span
              data-testid="chat-workflow-mirror"
              className="flex items-center gap-1 rounded-md border border-slate-800 px-2 py-1 text-[10px] text-slate-400"
            >
              <WorkflowIcon size={11} />
              {t('chat.workflowMirror', { status: t(`workflow.status.${run.status}`) })}
            </span>
          ) : null}
          <button
            type="button"
            data-action="new-session"
            disabled={busy !== undefined}
            onClick={() =>
              void call(t('chat.actionNewSession'), () => bridge?.chat['session.startSession'](), {
                apply: (view) => setSnapshot(view),
              })
            }
            className="flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            <Plus size={12} />
            {t('chat.newSession')}
          </button>
        </div>
      </header>

      <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-2">
        <span className="flex items-center gap-1 text-[10px] text-slate-500">
          <Gauge size={11} />
          {t('agent.autonomy.heading')}
        </span>
        {AUTONOMY_OPTIONS.map((level) => (
          <button
            key={level}
            type="button"
            data-autonomy={level}
            disabled={busy !== undefined}
            onClick={() =>
              void call(t('chat.actionAutonomy', { level: t(`agent.autonomy.${level}`) }), () =>
                bridge?.chat['session.setAutonomy'](level),
              )
            }
            className={`rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-40 ${
              snapshot?.session.autonomy === level
                ? 'border-sky-800 bg-sky-950/40 text-sky-200'
                : 'border-slate-800 text-slate-400 hover:bg-slate-800'
            }`}
          >
            {t(`agent.autonomy.${level}`)}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-slate-500" data-testid="chat-autonomy-current">
          {snapshot ? t(`agent.autonomy.${snapshot.session.autonomy}`) : t('chat.loading')}
        </span>
      </div>

      {/* 滚动位置在这一层（外层 section 是 h-full 永不溢出），testid 是 harness 比对换视图前后读数的抓手。 */}
      <div ref={scrollRef} data-testid="chat-scroll" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 && !isStreaming ? (
          <p className="text-[11px] text-slate-500" data-testid="chat-empty">
            {t('chat.empty')}
          </p>
        ) : (
          <ul data-testid="chat-messages" className="flex flex-col gap-3">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} toolMetas={toolMetas} />
            ))}
            {liveStream ? (
              <li
                data-testid="chat-streaming-message"
                data-message-id={liveStream.messageId}
                data-message-role="assistant"
                className="flex gap-2"
              >
                <span className="mt-1 shrink-0 text-slate-500">
                  <Bot size={14} />
                </span>
                <div className="max-w-[85%] rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-xs text-slate-200">
                  <p className="whitespace-pre-wrap break-words" data-part-kind="text">
                    {liveStream.text}
                  </p>
                  {liveStream.tool ? (
                    <ToolCard part={liveStream.tool} meta={toolMetas.get(liveStream.tool.toolId)} />
                  ) : null}
                </div>
              </li>
            ) : null}
          </ul>
        )}
      </div>

      {isStreaming ? (
        <p
          className="flex items-center gap-2 border-t border-slate-800 px-4 py-1.5 text-[10px] text-slate-400"
          data-testid="chat-running"
        >
          <LoaderCircle size={11} className="animate-spin" />
          {t('chat.streaming')}
        </p>
      ) : null}

      {notice ? (
        <p
          className="border-t border-slate-800 bg-slate-950/70 px-4 py-2 text-[11px] text-slate-300"
          data-testid="chat-notice"
        >
          {notice}
        </p>
      ) : null}

      {/* 流式期间只禁用发送按钮，输入区一直能用（spec 1.11-13：运行中要能打出「停一下」）。 */}
      <footer className="border-t border-slate-800 px-4 py-3">
        <textarea
          data-testid="chat-input"
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('chat.inputPlaceholder')}
          className="w-full resize-none rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-xs text-slate-100 outline-none focus:border-sky-800"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            data-action="send"
            disabled={busy !== undefined || isStreaming || draft.trim() === ''}
            onClick={submit}
            className="flex items-center gap-1 rounded-md border border-sky-800 px-3 py-1 text-xs text-sky-300 hover:bg-sky-950 disabled:opacity-40"
          >
            <Send size={12} />
            {t('chat.send')}
          </button>
          <button
            type="button"
            data-action="stop"
            disabled={busy !== undefined || !isStreaming}
            onClick={() => void call(t('chat.actionStop'), () => bridge?.chat['session.stop']())}
            className="flex items-center gap-1 rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            <Square size={12} />
            {t('chat.stop')}
          </button>
          <p className="ml-auto text-[10px] text-slate-500" data-testid="chat-hint">
            {t('chat.toolHint')}
          </p>
        </div>
      </footer>
    </section>
  );
}
