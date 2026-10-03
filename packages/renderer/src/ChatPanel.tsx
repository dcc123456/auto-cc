/**
 * 对话式主界面（spec 1.11）：首页第一入口，工作流面板退居第二视图（AGENTS.md §5.9）。
 *
 * 这里画的是**主进程那份会话**的镜像：消息一律来自 `chat.session.current()` 与 `chat/delta` 事件，
 * 组件不自己拼句子、不自己判进度。助手回复目前是本地确定性模板（P1 不接 LLM），
 * P5 换成真模型时改的是主进程的生成函数，这个文件一行不用改。
 * 5.2-c 起，`/run` 开头的那一句走 agent 循环：计划卡与逐步卡片流插在**同一段对话流**里
 * （plan 5.2-c 的切法），读数来自 `agent.loop.read` 与 `agent/run-progress`，同样不在这里推导。
 */
import { Bot, Gauge, LoaderCircle, Send, Square, User, Workflow as WorkflowIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AutonomyLevel,
  ChatMessageView,
  ChatSnapshotView,
  ChatToolPart,
  ToolDescriptorView,
} from '@auto-cc/shared';
import { AgentPauseCards } from './AgentPauseCards';
import { AgentPolicyPanel } from './AgentPolicyPanel';
import { AgentRunPanel } from './AgentRunPanel';
import { ChatSessionBar } from './ChatSessionBar';
import { SedimentCard } from './SedimentCard';
import { TakeoverBanner } from './TakeoverBanner';
import { ToolCard } from './ToolCard';
import { WorkflowRunCard } from './WorkflowRunCard';
import { useAgentPause } from './useAgentPause';
import { useAgentRun } from './useAgentRun';
import { useBridgeAction } from './useBridgeAction';
import { useSediment } from './useSediment';
import { useTakeover } from './useTakeover';
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
 * 对话面板：消息流 + 输入区 + 运行中指示三块最小结构（spec 1.11-02），加档位一行与 `ChatSessionBar` 那条会话操作带。
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
  // 5.4-c 起这条订阅在对话侧有两个用户：表头那只徽标显示状态，流末尾那张卡显示进度（同一份读数，spec 5.4-07）。
  const { run: workflowRun, live: workflowLive } = useWorkflowRun();
  // agent 循环的进度独立于 chat 的忙碌态：跑任务的时候输入区照常能用（spec 5.2-12）。
  // 会话 id 递进去是挂载回看的认领依据：重新挂载（含重启）后按这一段会话取最近一次 run 把计划卡画回来（spec 5.6-01）。
  const agentRun = useAgentRun(snapshot?.session.id);
  // 挂在人身上的那些单自成一条读数：它跟着 run 走，但按不按是人的手，不能被循环的忙碌态盖掉（spec 5.3-08）。
  const agentPause = useAgentPause();
  // 沉淀卡挂在 run 上而不是挂在会话上：预览读数按 runId 认领，换一条对话不会沿用上一段的投影（spec 5.4-01）。
  const sediment = useSediment();
  // 接管态是「这块页面此刻在谁手里」的唯一读数（spec 5.5-01 / 02）：横幅与两只按钮都只画它，
  // 界面不再存一份「我按过接管」的本地标志——按了却没生效的那一条就是谎报。
  // 把当前 run 的 id 跟着递进 `begin`，审计里那一条才说得出「这次接管按住的是哪条 run」（spec 5.5-09）。
  const takeover = useTakeover(agentRun.run?.runId);

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
  /**
   * 当前这条 run 的局部绑定。
   * 沉淀卡的两个动作要把 runId 交给主进程，而 `agentRun.run` 是属性访问、进了闭包就不再收窄，
   * 用局部常量钉一份既保住类型收窄，也省掉一个永远不会走到的兜底（§2.6）。
   */
  const agentRunView = agentRun.run;
  /**
   * 值得在对话流里回显的工作流运行（spec 5.4-07）。
   * `idle`（挂载后一次都没跑过）不占一行：那时格子全是待执行，画出来只是一张空表。
   * 这里的三元已经把类型收窄成非 undefined，卡片 props 因此不必再判一次空（§2.6：不加不会发生的分支）。
   */
  const workflowRunView = workflowRun && workflowRun.status !== 'idle' ? workflowRun : undefined;

  // 新片段落在最下面，滚动位置跟过去，否则连拍截图看到的是上面几行。
  // `workflowRun` 也在依赖里：工作流是从面板起跑的，卡片出现在这一段流末尾，不跟下去就拍不到它（spec 5.4-07）。
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [snapshot, liveStream, agentRun.run, agentPause.pending, workflowRun]);

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
          {workflowRun ? (
            <span
              data-testid="chat-workflow-mirror"
              className="flex items-center gap-1 rounded-md border border-slate-800 px-2 py-1 text-[10px] text-slate-400"
            >
              <WorkflowIcon size={11} />
              {t('chat.workflowMirror', { status: t(`workflow.status.${workflowRun.status}`) })}
            </span>
          ) : null}
        </div>
      </header>

      {/* 会话三操作（新建/改名/软删 + 已删栏）自成一条带（spec 5.6-07）：
          它们改的是 `chat_session` 那一行，与下面的档位、白名单、消息流都不是一件事。 */}
      <ChatSessionBar session={snapshot?.session} read={read} />

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

      {/* 免确认白名单贴在档位行下方（spec 5.3-07）：档位与「哪些动作已免确认」是同一件事的两半，
          分成两处看就没人能一眼读出「全自动档下这个动作到底会不会问我」。 */}
      <AgentPolicyPanel tools={tools} autonomy={snapshot?.session.autonomy} />

      {/* 接管横幅贴在档位/白名单之下、消息流之上（spec 5.5-01）：它说的是「这块页面此刻在谁手里」，
          与档位（授权范围）和卡片（某一步的等待）都不是一件事，塞进任何一张卡里都会让人漏看它。 */}
      <TakeoverBanner
        state={takeover.state}
        elapsedMs={takeover.elapsedMs}
        busy={takeover.busy}
        notice={takeover.notice}
        onHold={() => void takeover.hold()}
        onRelease={() => void takeover.release()}
      />

      {/* 滚动位置在这一层（外层 section 是 h-full 永不溢出），testid 是 harness 比对换视图前后读数的抓手。 */}
      <div ref={scrollRef} data-testid="chat-scroll" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 && !isStreaming && !agentRun.run && !workflowRunView ? (
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
                pageHeld={takeover.state?.isHeld ?? false}
                onConfirm={() => void agentRun.confirm()}
                onStop={() => void agentRun.stop()}
                onResume={() => void agentRun.resume()}
                onDismiss={agentRun.dismiss}
              />
            ) : null}
            {/* 沉淀卡紧跟计划卡（spec 5.4-01）：判「能不能沉淀」的那一口发生在人刚看完这份进度的一屏里，
                把它挪到工作流面板就等于让人拿着记忆去另一处重述一遍这次跑了什么。 */}
            {agentRunView ? (
              <SedimentCard
                runId={agentRunView.runId}
                runStatus={agentRunView.status}
                preview={sediment.preview}
                saved={sediment.saved}
                nameDraft={sediment.nameDraft}
                busy={sediment.busy}
                notice={sediment.notice}
                onNameChange={sediment.setNameDraft}
                onOpen={() => void sediment.open(agentRunView.runId)}
                onSave={() => void sediment.save(agentRunView.runId, sediment.nameDraft)}
                onClose={sediment.close}
              />
            ) : null}
            {/* 挂在人身上的单跟在计划卡后面（spec 5.3-08）：批准与补充信息都同属这一段对话流，
                另开一条历史就没人能在同一屏里看到「这一步为什么停」和「它现在等谁」。 */}
            <AgentPauseCards
              cards={agentPause.pending}
              resolved={agentPause.resolved}
              toolMetas={toolMetas}
              busy={agentPause.busy}
              notice={agentPause.notice}
              onRespond={(card, answer) => void agentPause.respond(card, answer)}
            />
            {/* 工作流运行卡放在这一段最末尾（spec 5.4-07）：它是「面板那一次起跑现在到哪了」的回显，
                与上面三张卡同源但不同事——那三张属于 agent 这条循环，这一张属于 `workflow.runner`。
                数据仍然只有那一口订阅：这里没有第二次 `runner.current()`，也没有定时器（2.8-12 的机检会红）。 */}
            {workflowRunView ? <WorkflowRunCard run={workflowRunView} live={workflowLive} /> : null}
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
