/**
 * 对话式主界面（spec 1.11）：首页第一入口，工作流面板退居第二视图（AGENTS.md §5.9）。
 *
 * 这里画的是**主进程那份会话**的镜像：消息一律来自 `chat.session.current()` 与 `chat/delta` 事件，
 * 组件不自己拼句子、不自己判进度。助手回复目前是本地确定性模板（P1 不接 LLM），
 * P5 换成真模型时改的是主进程的生成函数，这个文件一行不用改。
 * 5.2-c 起，`/plan` 开头的那一句走 agent 循环：计划卡与逐步卡片流插在**同一段对话流**里
 * （plan 5.2-c 的切法），读数来自 `agent.loop.read` 与 `agent/run-progress`，同样不在这里推导。
 */
import {
  Bot,
  Gauge,
  GripHorizontal,
  ListOrdered,
  LoaderCircle,
  Send,
  Square,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AutonomyLevel,
  ChatMessageView,
  ChatPart,
  ChatSnapshotView,
  ChatToolPart,
  ToolDescriptorView,
} from '@auto-cc/shared';
import { AgentPauseCards } from './AgentPauseCards';
import { AgentPolicyPanel } from './AgentPolicyPanel';
import { AgentRunPanel } from './AgentRunPanel';
import { ChatCompactionBanner } from './ChatCompactionBanner';
import { ChatSessionBar } from './ChatSessionBar';
import { SedimentCard } from './SedimentCard';
import { TakeoverBanner } from './TakeoverBanner';
import { ToolCard } from './ToolCard';
import { WorkflowRunCard } from './WorkflowRunCard';
import { DeskButton, DeskSegmented, DeskTextarea } from './ui/controls';
import { DeskExplainer, DeskSection } from './ui/disclosure';
import { MarkdownBody } from './ui/markdown';
import { useAgentPause } from './useAgentPause';
import { useAgentRun } from './useAgentRun';
import { useBridgeAction } from './useBridgeAction';
import { reportDeskTier } from './deskStatus';
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
 * 交给 agent 循环的那一句的前缀：`/plan` 之后是任务目标原文。
 *
 * 走前缀而不是加第三个输入框，是因为 5.2-c 要的判据形状就是「自然语言输入后先产出可见计划」——
 * 入口得还在对话里。它**不**进 `chat.session.send`：那条链会产出一句模板回复，
 * 于是同一句话既有对话答案又有计划，两个都能用就是 §2.5 禁的形态。
 * 这个词从 `/run` 改成 `/plan`（用户 2026-10-09 裁定）：这条前缀真正买到的就是"先出一份看得见的计划"，
 * 动手与否仍然由确认与档位决定，命令叫 run 会让人以为敲下去就发了。
 * 历史验收读数里写的是旧词（§4.5 既有条目不改写），按新词复现那些条目时要读 `/plan`。
 */
const RUN_COMMAND_PREFIX = '/plan';

/**
 * 气泡的几何与排版，按"谁在说"分两侧（历史消息与正在累加的那条共用同一处画法，§2.2）。
 *
 * 2026-10-19 按 browser-copilot 的对话屏改：那边**没有头像**，人那侧靠右（上限 92%），
 * 助手那侧是左侧满宽的一张 turn 面；正文 13px/1.5 并开中文禁则
 * （`[line-break:strict]` 是 Tailwind 任意属性，§5.1 禁手写 CSS 与内联 style）。
 *
 * 底色仍用本仓的 ink 档而不是照抄那边的 `color-mix(accent 22%, panel-2)`：
 * 那一条要么新造一枚令牌（机检第 12 节的双案表）、要么写 `*-wash`（第 9 节禁在面板层），
 * 为一块气泡扩一张令牌表不划算。
 */
const BUBBLE_CLASS = {
  user: 'max-w-[92%] whitespace-pre-wrap break-words rounded-xl border border-line-strong bg-ink-800 px-3 py-2 text-[13px] leading-[1.5] [line-break:strict]',
  // 助手那侧不写 `whitespace-pre-wrap`：Markdown 的块级元素自带段间距，再叠一层预格式化会把
  // JSX 里那些换行印成可见空格。行内换行由解析器按「软换行并空格、硬换行才 `<br>`」处理。
  assistant: 'min-w-0 break-words text-[13px] leading-[1.5] [line-break:strict]',
} as const;

/** 一段对话里连着属于同一方的若干条消息，画面上并成一颗 turn（参考实现的 `groupEntries`）。 */
type Turn = { key: string; role: 'user' | 'assistant'; messages: ChatMessageView[] };

/**
 * 把消息序列折成 turn：**只有助手那侧并**，人那侧一句就是一颗气泡。
 *
 * 依据只有"连着"：一条 user 出现就断开；助手那边不管几条（含正在流式的那条）都进同一张 turn 面。
 * 人那侧不并的理由是两次发言之间必然隔着一次助手回复，并成一格等于把两句话画成同一句。
 * @param messages 快照里的消息（流式那条已被滤掉）
 * @param live 正在累加的那条助手消息；并进末尾那张 turn，末尾不是助手就自己起一张
 * @returns 画面上一格一个 turn
 */
function groupTurns(messages: ChatMessageView[], live: LiveStream | undefined): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    const tail = turns[turns.length - 1];
    if (tail && tail.role === 'assistant' && message.role === 'assistant') {
      tail.messages.push(message);
      tail.key = `${tail.key}-${message.id}`;
      continue;
    }
    turns.push({ key: message.id, role: message.role, messages: [message] });
  }
  if (!live) return turns;
  const parts: ChatPart[] = live.text === '' ? [] : [{ kind: 'text', text: live.text }];
  if (live.tool) parts.push(live.tool);
  const streaming: ChatMessageView = {
    id: live.messageId,
    sessionId: live.sessionId,
    role: 'assistant',
    createdAt: 0,
    isStreaming: true,
    parts,
  };
  const tail = turns[turns.length - 1];
  if (tail?.role === 'assistant') {
    tail.messages.push(streaming);
    tail.key = `${tail.key}-${streaming.id}`;
    return turns;
  }
  return [...turns, { key: streaming.id, role: 'assistant', messages: [streaming] }];
}

/**
 * 一个 turn：一颗气泡（人那侧）或一张 turn 面（助手那侧），里面的工具卡与正文同列。
 *
 * 三支读数锚点 `data-message-id` / `data-message-role` / `data-message-who` 逐条原样保留在
 * **每一条消息**的容器上（5.6-01、5.2-13、6.2-34 的历史读数都解它们）：形状从头像格挪到了
 * 消息容器上，锚点一个没少。
 * @param turn 这一格要画的一串消息
 * @param toolMetas 注册表读数按 id 建的索引，卡片用它显示副作用分级
 * @returns 消息流里的一格
 */
function MessageTurn({ turn, toolMetas }: { turn: Turn; toolMetas: Map<string, ToolDescriptorView> }) {
  const isUser = turn.role === 'user';
  return (
    <li
      data-turn-role={turn.role}
      className={
        isUser ? 'flex justify-end' : 'flex flex-col gap-2 rounded-xl border border-line bg-ink-900/60 px-3 py-2.5'
      }
    >
      {turn.messages.map((message) => (
        <div
          key={message.id}
          data-message-id={message.id}
          data-message-role={message.role}
          data-message-who={message.role}
          // 1.11-02/03 的活体读数靠这支锚点轮询「还在不在打字」，它跟着的是那条正在流式的消息，不是某一格 turn。
          data-testid={message.isStreaming ? 'chat-streaming-message' : undefined}
          className={`flex min-w-0 flex-col gap-2 ${isUser ? 'max-w-[92%] items-end' : ''}`}
        >
          {message.parts.map((part, index) =>
            part.kind === 'text' ? (
              // 人那侧保持纯文本：气泡只有一格，等宽换行之外的花活会让人以为那不是自己打的那句话。
              // 助手那侧走 Markdown（spec 6.2-36）：模型输出里的标题、列表与代码块是内容的一部分，压成一段就是丢信息。
              isUser ? (
                <p key={`${message.id}-text-${String(index)}`} className={BUBBLE_CLASS.user} data-part-kind="text">
                  {part.text}
                </p>
              ) : (
                <div
                  key={`${message.id}-text-${String(index)}`}
                  className={BUBBLE_CLASS.assistant}
                  data-part-kind="text"
                >
                  <MarkdownBody text={part.text} />
                </div>
              )
            ) : (
              <ToolCard key={`${message.id}-tool-${String(index)}`} part={part} meta={toolMetas.get(part.toolId)} />
            ),
          )}
        </div>
      ))}
    </li>
  );
}

/** 输入框高度的档位下标与字面量 class（见 `composerStep` 那条注释：Tailwind 只认源码里的字面量）。 */
const COMPOSER_HEIGHT_CLASS = ['h-[72px]', 'h-[140px]', 'h-[220px]', 'h-[320px]', 'h-[520px]'] as const;
/** 与上表逐档对齐的像素数，只为手柄那句读数报得出台面高度（class 里那个数字不给界面读）。 */
const COMPOSER_HEIGHT_PX = [72, 140, 220, 320, 520] as const;
const COMPOSER_DEFAULT_STEP = 1;
const COMPOSER_HEIGHT_KEY = 'auto-cc.composerHeight';
/** 每拖 40 像素换一档：档位之间落差很大（72→140→220），按像素逐格算只会一直停在同一档。 */
const COMPOSER_DRAG_PIXELS_PER_STEP = 40;

/**
 * 从本机读回上次的高度档位。
 * @returns 落在表内的下标；没存过、存的不是数字或越界时回缺省档（输入框读不出来时不该是一片空白）
 */
function readComposerStep(): number {
  const stored = localStorage.getItem(COMPOSER_HEIGHT_KEY);
  // 判空必须走在 `Number()` 前面：`Number(null)` 是 0，会把"没存过"静默读成最矮那一档。
  if (stored === null) return COMPOSER_DEFAULT_STEP;
  const saved = Number(stored);
  return Number.isInteger(saved) && saved >= 0 && saved < COMPOSER_HEIGHT_CLASS.length ? saved : COMPOSER_DEFAULT_STEP;
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
    if (reply?.ok) {
      setSnapshot(reply.value);
      // 档位是会话上的一项读数，本面板重读时顺手报给状态条：状态条不另开一条调用（spec 6.3-05）。
      reportDeskTier(reply.value.session.autonomy);
    }
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
  /** 排着等发出去的那些（spec 1.11-16）；空数组就是没插话。事实由主进程给，界面不自己数。 */
  const queued = snapshot?.queued ?? [];
  /** 画面上一格一个 turn（助手那侧连着的那几条并成一格，见 `groupTurns`）。 */
  const turns = useMemo(() => groupTurns(messages, liveStream), [messages, liveStream]);
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
   * 发送输入框里的话。流式期间**照发**——主进程把它排进队列（spec 1.11-16），上一条收完自动轮到它。
   * `/plan` 开头那一句走 agent 循环：它不进对话表，只在同一段流里起一张计划卡（spec 5.2-03）。
   */
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
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
   * 发送按钮按不动的原因是哪一个：两个判据按"离手最近"排（先说在飞的那一次调用，再说没内容）。
   * **流式不再是一支原因码**——那条话现在进队列而不是被拒（1.11-16），按下去就是排上的意思。
   * 原因码进 `data-disabled-reason`，同一句话的人话版走语言包（6.2-06：禁用必须说得出为什么）。
   */
  const sendReason = busy !== undefined ? 'BUSY' : draft.trim() === '' ? 'INPUT_EMPTY' : undefined;
  const isSendDisabled = sendReason !== undefined;

  /** 中文输入法候选词上敲的那一下回车属于 IME，不属于"发送"。 */
  const composingRef = useRef(false);

  /**
   * 回车发送、Shift+回车换行（spec 1.11-02）。
   *
   * `isComposing` 与 `composingRef` 两个判据都要：前者覆盖多数浏览器，后者兜住
   * `compositionend` 晚于 `keydown` 到达的那种顺序（中文输入法在部分平台上正是这个次序）。
   * 不守卫的后果很具体：正在选词时敲回车，半句拼音连着候选框一起被发出去。
   * @param event 键盘事件
   */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || composingRef.current) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  /**
   * 输入框的高度档位（2026-10-19 按参考对话屏：缺省 140px，可拖到 72–520px）。
   *
   * 做成**吸附档**而不是连续高度，是因为连续高度只能靠内联 `style` 或运行期写 CSS 变量落到 DOM 上，
   * §5.1 两条都禁；于是拖拽按位移折算档位、class 从上表取字面量（Tailwind 只认源码里出现过的类名）。
   */
  const [composerStep, setComposerStep] = useState(readComposerStep);
  useEffect(() => {
    localStorage.setItem(COMPOSER_HEIGHT_KEY, String(composerStep));
  }, [composerStep]);
  /** 拖拽起点：记下按下时的 y 与当时的档位，移动时按位移折算而不是逐帧累加（累加会漂）。 */
  const composerDragRef = useRef<{ y: number; step: number } | null>(null);

  const onComposerDragStart = (event: PointerEvent<HTMLButtonElement>): void => {
    composerDragRef.current = { y: event.clientY, step: composerStep };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onComposerDragMove = (event: PointerEvent<HTMLButtonElement>): void => {
    const start = composerDragRef.current;
    if (!start) return;
    const moved = Math.round((start.y - event.clientY) / COMPOSER_DRAG_PIXELS_PER_STEP);
    setComposerStep(Math.min(Math.max(start.step + moved, 0), COMPOSER_HEIGHT_CLASS.length - 1));
  };

  const onComposerDragEnd = (event: PointerEvent<HTMLButtonElement>): void => {
    composerDragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  /**
   * 这一轮已经吐了多少秒（running 那一行上的读数）。
   * 只在流式期间挂定时器，`setInterval` 在这个文件里只服务这一件事——机检第 5/7 条禁的是
   * 「在定时器里读 workflow 服务」与「画布自读进度」，本地计时不在其中。
   */
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!isStreaming) return;
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [isStreaming]);

  return (
    <section data-testid="chat-panel" className="flex h-full flex-col rounded-xl border border-line bg-ink-900/60">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-200">
          <Bot size={16} />
          {t('chat.heading')}
        </h2>
        <div className="ml-auto flex items-center gap-2">
          {workflowRun ? (
            <span
              data-testid="chat-workflow-mirror"
              className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[10px] text-slate-400"
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

      {/* 压缩读数是一条独立的窄带（spec 5.6-04）：它说的是「这段对话还有多少没画出来」，
          与消息流、与会话操作带都不是同一件事，画成一条假消息会让人以为模型说过那句话。 */}
      <ChatCompactionBanner compaction={snapshot?.compaction} />

      {/* 档位与「哪些动作已免确认」是同一件事的两半（spec 5.3-07），所以收成**同一格、一起开合**：
          只收其中一半会让人读不出「这一档下这一步到底问不问我」，而这条常驻带原先要吃掉 90–116px 的
          消息流空间。收起态仍把当下档位留在 summary 那一行（`chat-autonomy-current` 这支读数没挪走），
          人不点开也知道此刻是谁在做主。 */}
      <DeskSection
        id="agent.autonomy"
        markers={{ testid: 'chat-autonomy-section' }}
        className="mx-4 my-3"
        title={
          <span className="flex items-center gap-1.5">
            <Gauge size={12} />
            {t('agent.autonomy.section')}
          </span>
        }
        summary={
          <span data-testid="chat-autonomy-current">
            {snapshot ? t(`agent.autonomy.${snapshot.session.autonomy}`) : t('chat.loading')}
          </span>
        }
      >
        <DeskSegmented
          action="chat-autonomy"
          markers={{ testid: 'chat-autonomy-switch' }}
          value={snapshot?.session.autonomy}
          busy={busy !== undefined}
          onSelect={(level) =>
            void call(t('chat.actionAutonomy', { level: t(`agent.autonomy.${level}`) }), () =>
              bridge?.chat['session.setAutonomy'](level),
            )
          }
          options={AUTONOMY_OPTIONS.map((level) => ({
            value: level,
            label: t(`agent.autonomy.${level}`),
            // 全自动=风险档，选中那一格涂朱砂；其余两档只是"选中"，不预支任何语气
            isRisk: level === 'auto',
            markers: { autonomy: level, 'autonomy-on': String(snapshot?.session.autonomy === level) },
          }))}
        />
        {/* 当下这一档"替我做主到哪一步"必须明面上说一句（档位是人选的，选错了界面不替他兜），
            三档的完整对比进披露层——那是教材，不是此刻的读数。 */}
        <p data-testid="chat-autonomy-why" className="mt-2 text-[11px] leading-relaxed text-slate-400">
          {snapshot ? t(`agent.autonomy.why.${snapshot.session.autonomy}`) : t('chat.loading')}
        </p>
        <DeskExplainer id="agent.autonomy-compare" className="mt-1.5" label={t('agent.autonomy.compareToggle')}>
          <span className="flex flex-col gap-1.5">
            {AUTONOMY_OPTIONS.map((level) => (
              <span key={level} className="flex gap-1.5">
                <span className="shrink-0 font-semibold text-slate-200">{t(`agent.autonomy.${level}`)}</span>
                <span className="min-w-0">{t(`agent.autonomy.compare.${level}`)}</span>
              </span>
            ))}
          </span>
        </DeskExplainer>
        <AgentPolicyPanel tools={tools} autonomy={snapshot?.session.autonomy} />
      </DeskSection>

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

      {/* 滚动位置在这一层（外层 section 是 h-full 永不溢出），testid 是 harness 比对换视图前后读数的抓手。
          消息流留 120px 地板：上面几条常驻读数带（会话条、压缩读数、档位、免确认白名单、接管横幅）
          在 737px 高的窗口里没有地板时会被挤成 24px 的一条缝，任务卡整个看不见（5.7-d 实测）。 */}
      <div ref={scrollRef} data-testid="chat-scroll" className="min-h-[120px] flex-1 overflow-y-auto px-4 py-3">
        {turns.length === 0 && !agentRun.run && !workflowRunView ? (
          <p className="mx-auto py-6 text-center text-xs text-slate-400" data-testid="chat-empty">
            {t('chat.empty')}
          </p>
        ) : (
          <ul data-testid="chat-messages" className="flex flex-col gap-3">
            {turns.map((turn) => (
              <MessageTurn key={turn.key} turn={turn} toolMetas={toolMetas} />
            ))}
            {/* 计划卡与逐步卡片流插在同一段对话流末尾（plan 5.2-c：五条 V 共用这段流，不另开一条历史）。 */}
            {agentRun.run ? (
              <AgentRunPanel
                run={agentRun.run}
                toolMetas={toolMetas}
                busy={agentRun.busy}
                notice={agentRun.notice}
                noticeTone={agentRun.noticeTone}
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
                noticeTone={sediment.noticeTone}
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
          className="flex items-center gap-2 border-t border-line px-4 py-1.5 text-[10px] text-celadon"
          data-testid="chat-running"
        >
          <LoaderCircle size={11} className="animate-spin" />
          {t('chat.streaming')}
          <span className="ml-auto text-slate-400">{t('chat.streamingElapsed', { seconds: elapsedSeconds })}</span>
        </p>
      ) : null}

      {notice ? (
        <p
          className="border-t border-line bg-ink-950/70 px-4 py-2 text-[11px] text-slate-300"
          data-testid="chat-notice"
        >
          {notice}
        </p>
      ) : null}

      {/* 流式期间发送键照常可按——按下去是排进队列（spec 1.11-16），不再是拒发。
          拖拽手柄走原件层：裸 `<button>` 在面板里会被机检第 10 条拦下。 */}
      <footer className="border-t border-line px-4 py-3">
        <DeskButton
          action="chat-composer-resize"
          variant="ghost"
          className="mb-1 flex h-4 w-full cursor-ns-resize touch-none items-center justify-center"
          aria-label={t('chat.composerHeight', {
            index: composerStep + 1,
            height: COMPOSER_HEIGHT_PX[composerStep] ?? COMPOSER_HEIGHT_PX[COMPOSER_DEFAULT_STEP],
          })}
          title={t('chat.composerResize')}
          markers={{ testid: 'chat-composer-resize' }}
          onPointerDown={onComposerDragStart}
          onPointerMove={onComposerDragMove}
          onPointerUp={onComposerDragEnd}
        >
          <GripHorizontal size={12} />
        </DeskButton>
        {/* 队列读数（spec 1.11-16）紧贴输入框上沿：它是「这句话还没发出去」的证据，
            画在消息流里会被当成一条消息，而它那时还不是消息。 */}
        {queued.length > 0 ? (
          <p
            data-testid="chat-queued"
            className="mb-1.5 flex items-center gap-1.5 text-[11px] text-celadon"
            data-queued-count={queued.length}
          >
            <ListOrdered size={11} />
            {t('chat.queued', { count: queued.length })}
          </p>
        ) : null}
        <DeskTextarea
          action="chat-input"
          size="composer"
          data-testid="chat-input"
          rows={2}
          value={draft}
          onValueChange={setDraft}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          placeholder={t('chat.inputPlaceholder')}
          className={`w-full resize-none ${COMPOSER_HEIGHT_CLASS[composerStep] ?? ''}`}
        />
        <div className="mt-2 flex items-center gap-2">
          <DeskButton
            action="send"
            variant="solid"
            busy={busy !== undefined}
            disabled={isSendDisabled}
            disabledReason={sendReason}
            disabledReasonLabel={sendReason ? t(`chat.reason.${sendReason}`) : undefined}
            onClick={submit}
          >
            <Send size={12} />
            {isStreaming ? t('chat.sendQueued') : t('chat.send')}
          </DeskButton>
          <DeskButton
            action="stop"
            variant="line"
            busy={busy !== undefined}
            disabled={!isStreaming}
            disabledReason={!isStreaming ? 'NOT_STREAMING' : undefined}
            disabledReasonLabel={!isStreaming ? t('chat.reason.NOT_STREAMING') : undefined}
            onClick={() => void call(t('chat.actionStop'), () => bridge?.chat['session.stop']())}
          >
            <Square size={12} />
            {t('chat.stop')}
          </DeskButton>
          {/* 两条命令说明原先平铺在动作行右侧（40 字 + 42 字），在 369px 的右栏宽度里会把整行撑到
              换行、把发送键挤成半截。收进披露层：明面只留一行短问句，正文按需展开，
              两支既有 testid 跟着搬进正文（改名等于拆掉 5.2-03 的验收通道）。 */}
          <DeskExplainer
            id="chat.hints"
            className="ml-auto shrink-0"
            label={t('chat.hints.toggle')}
            markers={{ testid: 'chat-hint' }}
          >
            <p data-testid="chat-tool-hint">{t('chat.toolHint')}</p>
            {/* 循环入口写在提示里而不是加第三个输入框：`/plan` 起计划卡，其余句子照常走对话（spec 5.2-03）。 */}
            <p className="mt-1" data-testid="chat-run-hint">
              {t('chat.runHint', { prefix: RUN_COMMAND_PREFIX })}
            </p>
          </DeskExplainer>
        </div>
      </footer>
    </section>
  );
}
