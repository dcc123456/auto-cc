/**
 * 对话式主界面（spec 1.11）：首页第一入口，工作流面板退居第二视图（AGENTS.md §5.9）。
 *
 * 这里画的是**主进程那份会话**的镜像：消息一律来自 `chat.session.current()` 与 `chat/delta` 事件，
 * 组件不自己拼句子、不自己判进度。助手回复目前是本地确定性模板（P1 不接 LLM），
 * P5 换成真模型时改的是主进程的生成函数，这个文件一行不用改。
 * 5.2-c 起，`/run` 开头的那一句走 agent 循环：计划卡与逐步卡片流插在**同一段对话流**里
 * （plan 5.2-c 的切法），读数来自 `agent.loop.read` 与 `agent/run-progress`，同样不在这里推导。
 */
import { Bot, Gauge, LoaderCircle, Plus, Send, Square, User, Workflow as WorkflowIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AutonomyLevel,
  ChatMessageView,
  ChatSnapshotView,
  ChatToolPart,
  ToolDescriptorView,
} from '@auto-cc/shared';
import { AgentRunPanel } from './AgentRunPanel';
import { ToolCard } from './ToolCard';
import { useAgentRun } from './useAgentRun';
import { useBridgeAction } from './useBridgeAction';
import { useWorkflowRun } from './useWorkflowRun';

/**
 * 自治档位的三个入口。
 * 主进程侧的枚举在 `@auto-cc/core`，渲染层引它会把 cordis 拖进 bundle，所以这里本地列一遍，
 * 用 `satisfies` 钉在同一个联合类型上：档位名一改，这里编译期就断。
 */
const AUTONOMY_OPTIONS = ['suggest', 'semi', 'auto'] as const satisfies readonly AutonomyLevel[];

/** 界面上正在累加的那条助手回复（主进程快照在流式期间也带这条，两边同时画会重复，所以过滤掉它）。 */
type LiveStream = { sessionId: string; messageId: string; text: string; tool?: ChatToolPart };

/**
 * 交给 agent 循环的那一句的前缀：`/run` 之后是任务目标原文。
 *
 * 走前缀而不是加第三个输入框，是因为 5.2-c 要的判据形状就是「自然语言输入后先产出可见计划」——
 * 入口得还在对话里。它**不**进 `chat.session.send`：那条链会产出一句模板回复，
 * 于是同一句话既有对话答案又有计划，两个都能用就是 §2.5 禁的形态。
 */
const RUN_COMMAND_PREFIX = '/run';

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
  // agent 循环的进度独立于 chat 的忙碌态：跑任务的时候输入区照常能用（spec 5.2-12）。
  const agentRun = useAgentRun();

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
  }, [snapshot, liveStream, agentRun.run]);

  const { busy, notice, run: call } = useBridgeAction(read);

  /**
   * 发送输入框里的话；流式期间不发（主进程会以 `CHAT_BUSY` 结构化拒绝，但按钮先禁用更清楚）。
   * `/run` 开头那一句走 agent 循环：它不进对话表，只在同一段流里起一张计划卡（spec 5.2-03）。
   */
  const submit = () => {
    const text = draft.trim();
    if (!text || isStreaming) return;
    if (text.startsWith(RUN_COMMAND_PREFIX)) {
      // 先清输入框再派发：`propose` 是异步的，而输入区在任务跑起来时不该留着上一条命令（5.2-12）。
      // 前缀后面是空的也照样交给主进程——它用 `AGENT_LOOP_EMPTY_GOAL` 结构化拒绝，
      // 那句原话会出现在面板提示行里，界面不必再编一条自己的判定（§2.6）。
      setDraft('');
      void agentRun.propose(text.slice(RUN_COMMAND_PREFIX.length).trim());
      return;
    }
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
        {messages.length === 0 && !isStreaming && !agentRun.run ? (
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
            {/* 计划卡与逐步卡片流插在同一段对话流末尾（plan 5.2-c：五条 V 共用这段流，不另开一条历史）。 */}
            {agentRun.run ? (
              <AgentRunPanel
                run={agentRun.run}
                toolMetas={toolMetas}
                busy={agentRun.busy}
                notice={agentRun.notice}
                stopAccepted={agentRun.stopAccepted}
                onConfirm={() => void agentRun.confirm()}
                onStop={() => void agentRun.stop()}
                onDismiss={agentRun.dismiss}
              />
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
          {/* 循环入口写在提示里而不是加第三个输入框：`/run` 起计划卡，其余句子照常走对话（spec 5.2-03）。 */}
          <p className="text-[10px] text-slate-500" data-testid="chat-run-hint">
            {t('chat.runHint', { prefix: RUN_COMMAND_PREFIX })}
          </p>
        </div>
      </footer>
    </section>
  );
}
