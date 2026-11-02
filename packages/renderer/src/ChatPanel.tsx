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
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Gauge,
  ListOrdered,
  LoaderCircle,
  Settings2,
  Sparkles,
  Square,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AutonomyLevel,
  ChatMessageView,
  ChatPart,
  ChatSnapshotView,
  ChatToolPart,
  FullAutoConsentView,
  LlmSettingsView,
  ToolDescriptorView,
} from '@auto-cc/shared';
import { AgentPauseCards } from './AgentPauseCards';
import { AgentPolicyPanel } from './AgentPolicyPanel';
import { AgentRunPanel } from './AgentRunPanel';
import { ChatCompactionBanner } from './ChatCompactionBanner';
import { ChatSessionBar } from './ChatSessionBar';
import { FullAutoConsentNotice } from './FullAutoConsentNotice';
import { SedimentCard } from './SedimentCard';
import { TakeoverBanner } from './TakeoverBanner';
import { ToolCard } from './ToolCard';
import { WorkflowRunCard } from './WorkflowRunCard';
import { Banner, DeskButton, DeskSegmented, DeskTextarea } from './ui/controls';
import { DeskHint } from './ui/disclosure';
import { MarkdownBody } from './ui/markdown';
import { DeskPopover, Drawer } from './ui/overlays';
import { formatClock } from './format';
import { pushDeskToast } from './deskToast';
import { useAgentPause } from './useAgentPause';
import { useAgentRun } from './useAgentRun';
import { useBridgeAction } from './useBridgeAction';
import { reportDeskTier } from './deskStatus';
import { useSediment } from './useSediment';
import { useTakeover } from './useTakeover';
import { useWorkflowRun } from './useWorkflowRun';
import { advanceViewTrail } from './viewTrail';

/**
 * 自治档位的三个入口。
 * 主进程侧的枚举在 `@auto-cc/core`，渲染层引它会把 cordis 拖进 bundle，所以这里本地列一遍，
 * 用 `satisfies` 钉在同一个联合类型上：档位名一改，这里编译期就断。
 */
const AUTONOMY_OPTIONS = ['suggest', 'semi', 'auto'] as const satisfies readonly AutonomyLevel[];

/** 界面上正在累加的那条助手回复（主进程快照在流式期间也带这条，两边同时画会重复，所以过滤掉它）。 */
type LiveStream = { sessionId: string; messageId: string; text: string; tool?: ChatToolPart };

/**
 * 模型气泡里的一条候选：哪家实例下的哪条已入库模型。
 *
 * 只装 `llm.settings.listModels()` 读回来的已入库行——那正是 `bindRole` 肯收的候选集，
 * 界面因此不会给出一个主进程会拒掉的选项（§2.6 不做假入口）。
 */
type ModelChoice = { providerId: string; providerLabel: string; model: string };

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
 * 正文的排版，按"谁在说"分两侧（历史消息与正在累加的那条共用同一处画法，§2.2）。
 *
 * 2026-10-19 按设计稿 v2 换成**通栏无泡**（`.msg .prose`）：整列没有一只气泡，人那侧也只是通栏纯文本，
 * 靠字色与一段留白分开——参考图里人的话同样不涂底色。字号跟着稿上的 15px/1.95 走（原 13px/1.5 太密），
 * 并开中文禁则（`[line-break:strict]` 是 Tailwind 任意属性，§5.1 禁手写 CSS 与内联 style）。
 *
 * 人那侧的 `text-slate-50` 是稿上 `.msg[data-message-role='user'] .prose` 那一档"更实"的字色；
 * 助手那侧不写色由面板基色继承，Markdown 的标题与列表自己带字色。
 *
 * 底色与边框一并退掉：它们原本只是"这是两个人说的话"的画法，而 `data-message-role` 那一行读数
 * 与消息之间的虚线分隔已经说了同一件事。
 */
const PROSE_CLASS = {
  // 人那侧保持纯文本：等宽换行之外的花活会让人以为那不是自己打的那句话。
  user: 'whitespace-pre-wrap break-words text-[15px] leading-[1.95] text-slate-50 [line-break:strict]',
  // 助手那侧不写 `whitespace-pre-wrap`：Markdown 的块级元素自带段间距，再叠一层预格式化会把
  // JSX 里那些换行印成可见空格。行内换行由解析器按「软换行并空格、硬换行才 `<br>`」处理。
  assistant: 'min-w-0 break-words text-[15px] leading-[1.95] [line-break:strict]',
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
 * 顶栏与消息行上的图标档键的几何（设计稿 v2 的 `.icon`：一枚 30px 的 ghost 方块）。
 * 文案一律收进 `sr-only` 与气泡（`tip`），
 * 图标居中靠 `justify-center`：原件的 `compact` 档给的是 `px-2`，不居中时 13px 的图标会贴在左边。
 */
const ICON_CELL_CLASS = 'h-[30px] w-[30px] justify-center';

/**
 * 消息下面那一行的图标档（稿 `.actions .icon`：28px 见方，比顶栏那一排小一档）。
 * 稿上 `.actions` 自己高 28、`gap:1px`、离正文 10px，所以这一行的 class 全在这里，不与顶栏共用。
 */
const ACTION_CELL_CLASS = 'h-7 w-7 justify-center';

/**
 * 一条助手回复收完之后，它下面那一行：复制 + 落款（设计稿 v2 的 `.actions`）。
 *
 * 稿上这一行有六格（复制 / 有用 / 不对 / 转发 / 钉为事实 / 更多）+ 落款 +「由 AI 生成」那句，
 * 用户 2026-10-19 裁定**只补有真读数的**：复制走渲染层自己的剪贴板（`navigator.clipboard`，
 * 与 `overlays.tsx` 里 `navigator.userAgent` 同源的一族浏览器能力，不过界），落款是主进程给的落库时间。
 * 顶/踩要一条反馈通道（全仓没有表、没有桥调用）、「钉为事实」要沉淀入口按 run 认领、
 * 「由 AI 生成」在助手回复仍是本地确定性模板时（`packages/agent/src/session.ts`）是谎报，
 * 所以那几格继续不画（§2.6 不拿假控件凑版面）。
 * @param message 那条已经落库的助手消息（`createdAt` 为 0 的流式那条不进这一行）
 * @returns 28px 高的一行；正文为空时整行不渲染
 */
function MessageActions({ message }: { message: ChatMessageView }) {
  const { t } = useTranslation();
  // 只把正文交给剪贴板：工具行是界面读数，不是模型说过的话，复制出来该是人能直接贴走的那段文字。
  const text = message.parts
    .filter((part) => part.kind === 'text')
    .map((part) => part.text)
    .join('\n\n');
  if (!text) return null;

  /** 写剪贴板。回执走左下角那只 toast：结果不在当前视野里（它在剪贴板里），而面板里没有别的地方放这句。 */
  const copy = (): void => {
    navigator.clipboard.writeText(text).then(
      () => pushDeskToast({ action: 'chat-copy-message', tone: 'jade', message: t('chat.copied') }),
      (error: unknown) =>
        pushDeskToast({
          action: 'chat-copy-message',
          tone: 'seal',
          message: t('chat.copyFailed', { reason: error instanceof Error ? error.message : String(error) }),
        }),
    );
  };

  return (
    <div className="mt-[10px] flex h-7 items-center gap-px">
      <DeskButton
        action="copy-message"
        variant="ghost"
        compact
        className={ACTION_CELL_CLASS}
        tip={t('chat.copy')}
        tipAlign="start"
        markers={{ testid: 'chat-copy-message', 'message-id': message.id }}
        onClick={copy}
      >
        <Copy size={13} />
        <span className="sr-only">{t('chat.copy')}</span>
      </DeskButton>
      {/* 落款只画主进程给得起的那一位：`createdAt` 是落库时间戳，正在累加的那条还没有（合成读数是 0）。
          只挂助手那侧也是稿上的画法（`.msg[data-message-role=user]` 里没有 `footer`）：人那句的时间
          由它上面那条虚线和上一条落款推得出来，两行并排各敲一个时间戳读起来像台账。 */}
      <span className="ml-1.5 text-[12px] leading-none text-slate-400" data-message-stamp={String(message.createdAt)}>
        {formatClock(message.createdAt, '', 'minute')}
      </span>
    </div>
  );
}

/**
 * 一个 turn：人那侧一串纯文本，助手那侧一张通栏稿面，里面的工具行与正文同列。
 *
 * 三支读数锚点 `data-message-id` / `data-message-role` / `data-message-who` 逐条原样保留在
 * **每一条消息**的容器上（5.6-01、5.2-13、6.2-34 的历史读数都解它们）。
 * 两侧都不再涂底色、不再描边（设计稿 v2 的通栏结构）：区分说话人靠的是字色、左侧那行落款时间，
 * 以及消息之间的一条虚线，不是气泡。
 * @param turn 这一格要画的一串消息
 * @param toolMetas 注册表读数按 id 建的索引，卡片用它显示副作用分级
 * @returns 消息流里的一格
 */
function MessageTurn({ turn, toolMetas }: { turn: Turn; toolMetas: Map<string, ToolDescriptorView> }) {
  const isUser = turn.role === 'user';
  return (
    <li data-turn-role={turn.role} className="flex flex-col gap-2 py-2.5">
      {turn.messages.map((message) => (
        <div
          key={message.id}
          data-message-id={message.id}
          data-message-role={message.role}
          data-message-who={message.role}
          // 1.11-02/03 的活体读数靠这支锚点轮询「还在不在打字」，它跟着的是那条正在流式的消息，不是某一格 turn。
          data-testid={message.isStreaming ? 'chat-streaming-message' : undefined}
          className="flex min-w-0 flex-col gap-2"
        >
          {message.parts.map((part, index) =>
            part.kind === 'text' ? (
              // 人那侧保持纯文本：通栏等宽换行之外的花活会让人以为那不是自己打的那句话。
              // 助手那侧走 Markdown（spec 6.2-36）：模型输出里的标题、列表与代码块是内容的一部分，压成一段就是丢信息。
              isUser ? (
                <p key={`${message.id}-text-${String(index)}`} className={PROSE_CLASS.user} data-part-kind="text">
                  {part.text}
                </p>
              ) : (
                <div
                  key={`${message.id}-text-${String(index)}`}
                  className={PROSE_CLASS.assistant}
                  data-part-kind="text"
                >
                  <MarkdownBody text={part.text} />
                </div>
              )
            ) : (
              <ToolCard key={`${message.id}-tool-${String(index)}`} part={part} meta={toolMetas.get(part.toolId)} />
            ),
          )}
          {!isUser && message.createdAt > 0 ? <MessageActions message={message} /> : null}
        </div>
      ))}
    </li>
  );
}

/** 输入框高度的档位下标与字面量 class（见 `composerStep` 那条注释：Tailwind 只认源码里的字面量）。 */
const COMPOSER_HEIGHT_CLASS = ['h-[66px]', 'h-[140px]', 'h-[220px]', 'h-[320px]', 'h-[520px]'] as const;
/** 与上表逐档对齐的像素数，只为手柄那句读数报得出台面高度（class 里那个数字不给界面读）。 */
const COMPOSER_HEIGHT_PX = [66, 140, 220, 320, 520] as const;
const COMPOSER_DEFAULT_STEP = 0;
const COMPOSER_HEIGHT_KEY = 'auto-cc.composerHeight';

/**
 * 发送那颗圆片（设计稿 v2 的 `.send`：实心圆 + 反色箭头，没有文案）。
 *
 * 两态**分属两条字面量**（机检第 13 节①：按不动的那一态不许长出 hover）。
 * `bg-slate-50 / text-ink-900` 是一对会随主题翻面的档：毡案上是深墨圆片压在浅毡上，
 * 墨案上是亮片压在深桌上，同一写法两案都成立——这也是它不用朱砂的理由（本仓的色相约定里
 * `seal` 专指"会离开这台机器"，发一条本地对话不配用它）。
 * **它盖得住 `solid` 档的 `bg-ink-750`** 靠的是本仓 `bg-*` 按令牌声明顺序出样式（`--color-ink-*`
 * 在 `--color-slate-*` 之前，产物偏移实测 23122 → 26115），`rounded-full` 同理压在原件的
 * `rounded-control` 上（16841 → 16894）。
 * 箭头字色挂在图标**自己那一格**：`text-*` 那一组里 slate 排在 ink 之后，挂在按钮上会被原件的
 * `text-slate-50` 盖回去，而子节点自己的声明永远赢过继承。
 * 悬停那一档不写在这里（`hover:bg-slate-100` 挂在那一格自己的 className 上）：第 13 节②要面板层的
 * hover 与交互凭据落在同一片行窗口里，而这张常量表离 `action="send"` 有整一段 JSX 那么远。
 */
const SEND_LIVE_CLASS = 'h-8 w-8 justify-center rounded-full bg-slate-50';
/** 按不动那一态的圆片：底色、字色都由 `buttonClass` 的禁用分支给（六档同色，spec 6.2-10）。 */
const SEND_DEAD_CLASS = 'h-8 w-8 justify-center rounded-full';

/**
 * 档位那颗胶囊的几何（稿 `.pill`：28px 高的圆角胶囊）。按下它弹的是**档位气泡**（2026-11-02 用户裁定：
 * 模式设置只在输入框底部展示与选择），不再开右侧抽屉。
 *
 * 字号不挂在这里：原件的 `compact` 档已经挂了 `text-[11px]`，而活体实测**同族两条按样式表顺序决胜**，
 * 且任意属性那一族排在 utility 前面（本轮读数：`[font-size:12.5px]` 偏移 47881、`text-[11px]` 48164，
 * 于是计算值仍是 11px）。12.5px 因此挂在**标签那一格**（`data-testid="chat-autonomy-current"`）——
 * 子节点自己的声明永远赢过继承，与发送键箭头字色挂在图标自己那一格是同一条办法。
 */
const TIER_PILL_CLASS = 'h-7 max-w-[150px] justify-center rounded-full';

/**
 * 卡内工具条上那颗「当前对话模型」的几何（稿 `.pill` 的展示档）。
 *
 * 2026-11-02 起它**是一颗键**：按下弹出模型气泡，里面能直接切到别家已入库的模型，
 * 也留一只「模型配置」把入口接到信任栏的模型设置。底色取 `bg-ink-850` 一档：
 * 卡片自己是 `bg-ink-800`，同一块底色会把读数糊进卡面。
 */
const MODEL_PILL_CLASS = 'h-7 max-w-[190px] justify-center rounded-full bg-ink-850 px-2.5 text-[12.5px]';

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
 * 对话面板：一条 46px 顶栏（会话名 + 改名 + 白名单/历史/新建）+ 消息流（含流内那条压缩窄行）+
 * 一张输入卡（档位气泡、模型气泡、合并后的发送/停止键）+ 一只按需展开的设置抽屉（只留免确认白名单）。
 * @returns 占满可用高度的聊天面板；主进程快照未回来之前消息流显示占位文案
 */
export function ChatPanel() {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<ChatSnapshotView>();
  const [liveStream, setLiveStream] = useState<LiveStream>();
  const [tools, setTools] = useState<ToolDescriptorView[]>([]);
  const [draft, setDraft] = useState('');
  /**
   * 右侧设置抽屉的开合（2026-10-26 片一收成一颗图标键 + `Drawer`；2026-11-02 用户裁定
   * 「点开后的页面只保留白名单功能」）。
   *
   * 档位从这一格退场：它现在只在输入框底部那颗胶囊的气泡里展示与选择，抽屉里不再有第二个写口。
   * 抽屉仍然是**浮层**——读它的时候版面一像素不动，不必把输入卡往上顶。
   */
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  /** 当前对话通道用的模型名（稿 `.pill` 右侧那一颗的读数）；没配齐时为 undefined，画「未配置」那句。 */
  const [chatModel, setChatModel] = useState<string>();
  /** 模型气泡的候选：各家实例下已入库的模型；打开气泡时现问，不在本地存第二份清单（§2.7）。 */
  const [modelChoices, setModelChoices] = useState<ModelChoice[]>();
  /**
   * 那份一次性的「全自动授权」（spec 8.10-01）。
   *
   * `undefined` 是还没读回来（此时不拦发送：拦了也只是一瞬的假禁用）；`acknowledgedAt: null` 才是
   * 「还没答应过」——全自动档在这之前一步都不执行，界面上据此摆出那句明示并禁用发送键。
   * 读数来自主进程（`agent.policy.fullAutoConsent`），界面不存第二份「我答应过」的本地标志。
   */
  const [fullAutoConsent, setFullAutoConsent] = useState<FullAutoConsentView>();
  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * 屏上此刻那条会话的 id（事件过滤用）。
   *
   * 历史抽屉可以在流式期间切走会话（`chat.session.select` 会先把旧回复收尾）：旧会话剩余的分片与
   * `done` 仍会经同一条事件通道推来，不认一下会话 id 就会把上一段的字画到这一段的画面里。
   */
  const currentSessionIdRef = useRef<string | undefined>(undefined);
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

  /**
   * 读对话通道当下用的那个模型名（卡内工具条右侧那颗 pill 的读数）。
   *
   * 事实只有 `llm.settings.read` 那一份（`LlmLegView.model`，端点/模型名/key 三项没齐时是 null），
   * 界面不猜也不留第二份（§2.7）。
   * @param view 主进程刚返回的整份读数；省略时现问一次
   */
  const applyModelView = useCallback((view: LlmSettingsView) => {
    setChatModel(view.legs.find((leg) => leg.leg === 'chat')?.model ?? undefined);
  }, []);
  const readModel = useCallback(async () => {
    const reply = await bridge?.llm['settings.read']();
    if (reply?.ok) applyModelView(reply.value);
  }, [applyModelView, bridge]);

  /**
   * 现问模型气泡的候选：池里每家实例 × 它已入库的模型。
   *
   * 候选只取 `llm.settings.listModels()`（已入库那些），与 `llm.settings.bindRole` 肯收的集合是同一份；
   * 问不到时留空数组，气泡里如实说「还没有可选的模型」，不编一条假选项。
   */
  const readModelChoices = useCallback(async () => {
    const providers = await bridge?.llm['settings.listProviders']();
    if (!providers?.ok) {
      setModelChoices([]);
      return;
    }
    const lists = await Promise.all(
      providers.value.map(async (provider) => {
        const reply = await bridge?.llm['settings.listModels'](provider.id);
        return reply?.ok
          ? reply.value.map((row) => ({ providerId: provider.id, providerLabel: provider.label, model: row.model }))
          : [];
      }),
    );
    setModelChoices(lists.flat());
  }, [bridge]);

  /** 读那份一次性全自动授权：与档位一起进来，界面据此决定要不要摆那句明示、能不能直接跑。 */
  const readConsent = useCallback(async () => {
    const reply = await bridge?.agent['policy.fullAutoConsent']();
    if (reply?.ok) setFullAutoConsent(reply.value);
  }, [bridge]);

  useEffect(() => {
    void read();
    void readTools();
    void readModel();
    void readConsent();
  }, [read, readTools, readModel, readConsent]);

  useEffect(() => {
    currentSessionIdRef.current = snapshot?.session.id;
  }, [snapshot?.session.id]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.on('chat/delta', (event) => {
      // 别的会话（切走之前那条）的片段不进当前画面：事件里带 sessionId 正是为了让读的一侧能认领。
      if (event.sessionId !== currentSessionIdRef.current) return;
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
  /**
   * 这一段会话的压缩读数（5.6-04）：`undefined` = 这段还没折过。
   * 同一个引用喂两处——流内那条窄行（`ChatCompactionBanner`）与卡下那条长度读数，
   * 两边都只是画它，不在界面侧算第二个数（§2.5）。
   */
  const compaction = snapshot?.compaction;
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
   *
   * 全自动档下**普通一句话也进 agent 循环**（2026-10-26 片三）：「帮我找一份前端开发工作」不该先得到
   * 一句模板回复、再让用户换种写法敲 `/plan`。起草成功就立刻确认并开跑——那一次确认用的是用户
   * 在档位上做过的**一次性授权**，不是逐步问；没有那份授权时发送键本身是禁用的（见 `sendReason`）。
   * 半自动与建议档仍保持原分工：普通句子走对话，`/plan` 才起计划卡。
   */
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    const isAuto = snapshot?.session.autonomy === 'auto';
    const isPlanCommand = text.startsWith(RUN_COMMAND_PREFIX);
    const goal = isPlanCommand ? text.slice(RUN_COMMAND_PREFIX.length).trim() : isAuto ? text : undefined;
    if (goal !== undefined) {
      // 先清输入框再派发：`propose` 是异步的，而输入区在任务跑起来时不该留着上一条命令（5.2-12）。
      // 前缀后面是空的也照样交给主进程——它用 `AGENT_LOOP_EMPTY_GOAL` 结构化拒绝，
      // 那句原话会出现在面板提示行里，界面不必再编一条自己的判定（§2.6）。
      setDraft('');
      void (async () => {
        const drafted = await agentRun.propose(goal);
        if (drafted && isAuto) await agentRun.confirm();
      })();
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
   *
   * 全自动档少了那份一次性授权时排在最前：那不是"输入有毛病"，而是整条链路此刻不能开跑
   * （判定口会以 `FULL_AUTO_CONSENT_REQUIRED` 拒掉每一步），所以要让人先看见那句话与那颗按键。
   */
  const needsFullAutoConsent = snapshot?.session.autonomy === 'auto' && fullAutoConsent?.acknowledgedAt === null;
  const sendReason =
    busy !== undefined
      ? 'BUSY'
      : needsFullAutoConsent
        ? 'FULL_AUTO_CONSENT_REQUIRED'
        : draft.trim() === ''
          ? 'INPUT_EMPTY'
          : undefined;
  const isSendDisabled = sendReason !== undefined;

  /**
   * 人在明示卡上按下「我了解，开始全自动」：登记进库（一次性，跨重启有效）后读数立刻更新。
   * 这是**人**的表态，不走 agent 工具；桥接口同样刻意不登记成工具（`check-agent-model-authority` ⑥ 同族）。
   */
  const grantFullAuto = () =>
    void call(t('agent.fullAuto.actionGrant'), () => bridge?.agent['policy.grantFullAutoConsent'](), {
      apply: setFullAutoConsent,
    });

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
   * 输入框的高度档位（2026-10-20 按稿 `.card textarea`：缺省 66px，可拖到 66–520px）。
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
  /** 是否正在拖：气泡在这期间改报当前高度，手一松就回到「拖动改高度」那句。 */
  const [composerDragging, setComposerDragging] = useState(false);

  /**
   * 手柄贴在卡片的**上沿**：卡片是底边锚定的，加高时只有上沿跟着指针走——手柄若挂在卡底，
   * 拖动时它自己一动不动、只有远处的顶边在跳，这就是 2026-10-20 那句「拖拽也不对」的观感来源。
   */
  const onComposerDragStart = (event: PointerEvent<HTMLButtonElement>): void => {
    composerDragRef.current = { y: event.clientY, step: composerStep };
    setComposerDragging(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 合成事件或指针已不在途时捕获会抛；拖动本身不依赖它（move 仍派发在节点上）。
    }
  };

  /**
   * 按**高度差就近吸附**：每档之间的落差是 74–200px，按固定 40px 一档折算会让手柄落后指针一大截。
   * @param event 指针移动事件；`clientY` 与起点相减得到「想加/减多少像素」
   */
  const onComposerDragMove = (event: PointerEvent<HTMLButtonElement>): void => {
    const start = composerDragRef.current;
    if (!start) return;
    if (event.buttons === 0) {
      composerDragRef.current = null;
      setComposerDragging(false);
      return;
    }
    const startHeight = COMPOSER_HEIGHT_PX[start.step] ?? COMPOSER_HEIGHT_PX[COMPOSER_DEFAULT_STEP] ?? 66;
    const wanted = startHeight + (start.y - event.clientY);
    let nearestStep = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    COMPOSER_HEIGHT_PX.forEach((height, step) => {
      const distance = Math.abs(height - wanted);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestStep = step;
      }
    });
    setComposerStep(nearestStep);
  };

  const onComposerDragEnd = (event: PointerEvent<HTMLButtonElement>): void => {
    if (!composerDragRef.current) return;
    composerDragRef.current = null;
    setComposerDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
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
      {/* 顶栏只有一条（设计稿 v2 的 `.bar`）：会话名 + 改名 + 右端的白名单/历史/新建。
          2026-11-02 用户裁定把前两颗「没什么作用的」图标拿掉——runner 那枚只读徽标与顶栏的档位入口
          不再占位；档位只在输入卡底部那颗胶囊的气泡里展示与选择，白名单留在设置抽屉里。 */}
      <ChatSessionBar
        session={snapshot?.session}
        read={read}
        rightActions={
          <DeskButton
            action="agent-policy-toggle"
            variant={isSettingsOpen ? 'solid' : 'ghost'}
            compact
            className={ICON_CELL_CLASS}
            tip={t('chat.settings.title')}
            tipPlacement="bottom"
            tipAlign="end"
            markers={{ 'desk-panel': isSettingsOpen ? 'policy' : 'none' }}
            onClick={() => setIsSettingsOpen((previous) => !previous)}
          >
            <Settings2 size={13} />
            <span className="sr-only">{t('chat.settings.title')}</span>
          </DeskButton>
        }
      />

      {/* 接管横幅压在顶栏之下、消息流之上，并收成**一行**（spec 5.5-01；用户 2026-10-19 裁定）：
          它说的是「这块页面此刻在谁手里」，与档位（授权范围）和卡片（某一步的等待）都不是一件事，
          塞进任何一张卡里都会让人漏看它——但它自己不该再占成一条 36px 的带。 */}
      <TakeoverBanner
        state={takeover.state}
        elapsedMs={takeover.elapsedMs}
        busy={takeover.busy}
        notice={takeover.notice}
        onHold={() => void takeover.hold()}
        onRelease={() => void takeover.release()}
      />

      {/* 滚动位置在这一层（外层 section 是 h-full 永不溢出），testid 是 harness 比对换视图前后读数的抓手。
          消息流留 120px 地板：5.7-d 那条实测（737px 高的窗口里没有地板时流会被挤成 24px 的一条缝）
          说的就是这一层，如今流上方只剩顶栏与那一行接管读数，地板照留。
          压缩读数现在画成**流内第一条虚线窄行**（用户裁定）：它说的正是"上面那些折掉了"，位置自己就得贴着流。 */}
      <div
        ref={scrollRef}
        data-testid="chat-scroll"
        className="flex min-h-[120px] flex-1 flex-col overflow-y-auto px-4 pb-[18px] pt-1"
      >
        <ChatCompactionBanner compaction={compaction} />
        {turns.length === 0 && !agentRun.run && !workflowRunView && agentRun.notice === undefined ? (
          // 空会话那句提示原先贴在流顶（py-6 之后就是一大片空白），看起来像"内容没加载出来"；
          // 让它占满流内剩余高度、垂直居中，空屏才读成"等你开口"而不是"上面还有东西"。
          <div className="flex flex-1 items-center justify-center">
            <p className="py-6 text-center text-xs text-slate-400" data-testid="chat-empty">
              {t('chat.empty')}
            </p>
          </div>
        ) : (
          // 消息之间的一条虚线（稿 `.divide`）替掉了原先的气泡与卡片外框：两侧都是通栏文本，
          // 靠这一条说"这又是一句"，所以 ul 自己不留 gap（缝由每条 `<li>` 的 py 与这条分隔线出）。
          <ul data-testid="chat-messages" className="flex flex-col divide-y divide-dashed divide-line-strong">
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
        {/* 起草就失败时库里有 run、界面却拿不到它（`propose` 的 apply 只在成功时跑），提示行因此必须
            在**没有计划卡**的这一侧也画得出来（spec 8.10-06 的反向验证：计划器不可用要如实说，
            不能表现成"什么都没发生"）。有卡时这一格让位给面板自己那条同类提示，避免同一句话出现两次。 */}
        {agentRun.run === undefined && agentRun.notice !== undefined ? (
          <Banner tone={agentRun.noticeTone} markers={{ testid: 'agent-run-notice' }} className="mt-2">
            {agentRun.notice}
          </Banner>
        ) : null}
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

      {/* 输入区收成**一张卡**（设计稿 v2 的 `.composer > .card`）：档位那颗胶囊、当前模型读数、
          停止与发送全部落在卡内的工具条上；卡外只剩队列那一条读数与卡下面那条薄读数带（稿 `.understrip`）。
          2026-10-26 片一再收一档：免确认白名单搬进右侧抽屉（见本文件末尾的 `chat-settings`）；
          2026-11-02 起档位只在卡内那颗胶囊的气泡里改，不再在卡上方撑开任何格子——那一格展开时
          把输入卡往上顶、消息流跟着缩，正是 5.7-d 那条实测的病。
          拖拽手柄走原件层：裸 `<button>` 在面板里会被机检第 10 条拦下；它现在贴在卡的下沿（拖着下沿加高）。 */}
      <footer className="px-4 pb-3 pt-1">
        {/* 队列读数（spec 1.11-16）紧贴卡片上沿：它是「这句话还没发出去」的证据，
            画在消息流里会被当成一条消息，而它那时还不是消息。 */}
        {queued.length > 0 ? (
          <p
            data-testid="chat-queued"
            data-queued-count={queued.length}
            className="mb-2 flex items-center gap-2 rounded-control border border-celadon/34 bg-ink-800 px-3 py-1.5 text-[12.5px] text-celadon-ink"
          >
            <ListOrdered size={13} />
            {t('chat.queued', { count: queued.length })}
          </p>
        ) : null}
        {/* 全自动档还没做过那一次明示：这句话摆在这里而不是弹窗——弹窗的入场条件是"不可逆、必须读完整风险"，
            而它挡住的只是"还没答应"，抽屉一开就能读到同一句话（见下面档位那一格）。 */}
        {needsFullAutoConsent && !isSettingsOpen ? (
          <FullAutoConsentNotice busy={busy !== undefined} onGrant={grantFullAuto} />
        ) : null}
        <div className="rounded-2xl border border-line bg-ink-800 shadow-card transition-[border-color,box-shadow] duration-150 focus-within:border-celadon/50 focus-within:ring-[3px] focus-within:ring-celadon/15">
          {/* 文本域走原件的 `bare` 档（不铺自己的底、不描边），字号与字色挂在这一层包裹节点上——
              这正是 `bare` 那一档的设计（spec 3.11-06：字档一律 inherit，由调用方挂在包裹节点）。
              `[line-height:1.8]` 是**任意属性**那一族：原件在文本域自己那一格挂了 `leading-[1.2]`，
              同族两条谁赢取决于样式表顺序（本仓已实测过一次，见 controls.tsx 那条 `fieldClass` 注释），
              所以这里不与它同名，用 property 级写法压过去（稿 `.card textarea` 要的正是 1.8）。 */}
          <div className="relative px-[15px] pt-[13px] text-[14.5px] text-slate-100">
            {/* 高度手柄贴在卡的**上沿**、浮在那 13px 上内边距里（见 `onComposerDragStart` 那条注释）：
              卡片底边锚定，加高时只有上沿跟着指针走——手柄挂在卡底时它自己一动不动、只有远处的顶边在跳，
              那正是「拖拽也不对」的观感。外边再包一层定位层而不是给原件写 `absolute`：基座里那句
              `relative` 与 `absolute` 同族、谁赢按样式表顺序算（本仓已为这种字面量打架付过一次账，
              见 `SEND_LIVE_CLASS` 那条注释），包一层就不用赌；且按钮成为 flex item 后被块化，
              `inline-flex` 不再制造行盒——流内直挂时实测卡片凭空高出 9px。 */}
            <div className="absolute inset-x-3 top-0 z-10 flex justify-center">
              <DeskButton
                action="chat-composer-resize"
                variant="ghost"
                compact
                className="flex h-3 w-full cursor-ns-resize touch-none justify-center"
                aria-label={t('chat.composerHeight', {
                  index: composerStep + 1,
                  height: COMPOSER_HEIGHT_PX[composerStep] ?? COMPOSER_HEIGHT_PX[COMPOSER_DEFAULT_STEP],
                })}
                tip={
                  composerDragging
                    ? t('chat.composerHeightChip', {
                        height: COMPOSER_HEIGHT_PX[composerStep] ?? COMPOSER_HEIGHT_PX[COMPOSER_DEFAULT_STEP],
                      })
                    : t('chat.composerResize')
                }
                markers={{ testid: 'chat-composer-resize', dragging: String(composerDragging) }}
                onPointerDown={onComposerDragStart}
                onPointerMove={onComposerDragMove}
                onPointerUp={onComposerDragEnd}
                onPointerCancel={onComposerDragEnd}
                onLostPointerCapture={() => {
                  composerDragRef.current = null;
                  setComposerDragging(false);
                }}
              >
                <span
                  className={`h-1 w-9 rounded-full transition-colors ${
                    composerDragging ? 'bg-celadon' : 'bg-slate-500 group-hover/desk-tip:bg-slate-400'
                  }`}
                />
              </DeskButton>
            </div>
            <DeskTextarea
              action="chat-input"
              bare
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
              className={`block resize-none placeholder:text-slate-400 [line-height:1.8] ${
                COMPOSER_HEIGHT_CLASS[composerStep] ?? ''
              }`}
            />
          </div>
          <div className="flex items-center gap-1 px-2 pb-2 pt-1.5">
            {/* 说明收成**一枚**裸 icon + 气泡（2026-11-02 用户裁定把左端两枚合成一枚）：
                原先 tool/run 一组、会话改名/删除一组各占一颗问号；删除入口搬进历史抽屉之后，
                后一组只剩一句改名规矩，并进同一只气泡即可。三支既有 testid 跟着正文留在里面，不改名。 */}
            <DeskHint id="chat.hints" iconOnly label={t('chat.hints.toggle')} markers={{ testid: 'chat-hint' }}>
              <p data-testid="chat-tool-hint">{t('chat.toolHint')}</p>
              {/* 循环入口写在提示里而不是加第三个输入框：`/plan` 起计划卡，其余句子照常走对话（spec 5.2-03）。 */}
              <p className="mt-1" data-testid="chat-run-hint">
                {t('chat.runHint', { prefix: RUN_COMMAND_PREFIX })}
              </p>
              <p className="mt-1" data-testid="chat-session-title-hint">
                {t('chat.session.titleHint')}
              </p>
            </DeskHint>
            {/* 档位那一颗：明面只留当下那一档的名字，按下弹出**档位气泡**——那里是唯一的切换入口
                （2026-11-02 用户裁定：模式设置只在对话框底部展示与选择）。
                `chat-autonomy-current` 仍跟着那句档位名；`data-tier` 与 `chat-autonomy-pill` 原位不动。 */}
            <DeskPopover
              action="chat-autonomy-menu"
              label={t('agent.autonomy.section')}
              align="start"
              trigger={({ open, toggle }) => (
                <DeskButton
                  action="chat-autonomy-toggle"
                  variant="ghost"
                  compact
                  className={TIER_PILL_CLASS}
                  markers={{ testid: 'chat-autonomy-pill', tier: snapshot?.session.autonomy ?? 'unknown' }}
                  tip={t('agent.autonomy.section')}
                  tipAlign="start"
                  aria-expanded={open}
                  onClick={toggle}
                >
                  <Gauge size={13} className={snapshot?.session.autonomy === 'auto' ? 'text-seal' : undefined} />
                  <span
                    data-testid="chat-autonomy-current"
                    className={`text-[12.5px] ${snapshot?.session.autonomy === 'auto' ? 'text-seal-ink' : ''}`}
                  >
                    {snapshot ? t(`agent.autonomy.${snapshot.session.autonomy}`) : t('chat.loading')}
                  </span>
                  <ChevronDown size={13} className="opacity-70" />
                </DeskButton>
              )}
            >
              {({ close }) => (
                <DeskSegmented
                  action="chat-autonomy"
                  markers={{ testid: 'chat-autonomy-switch' }}
                  value={snapshot?.session.autonomy}
                  busy={busy !== undefined}
                  onSelect={(level) => {
                    close();
                    void call(t('chat.actionAutonomy', { level: t(`agent.autonomy.${level}`) }), () =>
                      bridge?.chat['session.setAutonomy'](level),
                    );
                  }}
                  options={AUTONOMY_OPTIONS.map((level) => ({
                    value: level,
                    label: t(`agent.autonomy.${level}`),
                    // 全自动=风险档，选中那一格涂朱砂；其余两档只是"选中"，不预支任何语气
                    isRisk: level === 'auto',
                    markers: { autonomy: level, 'autonomy-on': String(snapshot?.session.autonomy === level) },
                  }))}
                />
              )}
            </DeskPopover>
            {/* 模型那一颗（2026-11-02 用户裁定：支持下拉换模型 + 一个模型配置入口，气泡下拉框样式）。
                候选只取已入库清单，选中即 `llm.settings.bindRole` 写 chat 通道；配置入口走跨视图推进，
                落到信任栏的模型设置。 */}
            <DeskPopover
              action="chat-model-menu"
              label={t('chat.modelMenu')}
              align="end"
              className="ml-auto"
              trigger={({ open, toggle }) => (
                <DeskButton
                  action="chat-model-toggle"
                  variant="ghost"
                  compact
                  className={MODEL_PILL_CLASS}
                  markers={{ testid: 'chat-model-pill', model: chatModel ?? '' }}
                  tip={t('chat.modelMenu')}
                  tipAlign="end"
                  aria-expanded={open}
                  onClick={() => {
                    // 每次展开都现问一遍：人在模型设置里刚加的模型不该等到重启才出现。
                    if (!open) void readModelChoices();
                    toggle();
                  }}
                >
                  <Sparkles size={13} className="shrink-0 text-slate-400" aria-hidden="true" />
                  <span className="min-w-0 truncate text-slate-200">{chatModel ?? t('chat.modelNone')}</span>
                  <ChevronDown size={13} className="opacity-70" />
                </DeskButton>
              )}
            >
              {({ close }) => (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2 px-1 pb-1">
                    <span className="text-[10.5px] text-slate-500">{t('chat.modelMenu')}</span>
                    <DeskButton
                      action="chat-model-config"
                      variant="ghost"
                      compact
                      onClick={() => {
                        close();
                        advanceViewTrail({
                          sourceView: 'chat',
                          sourceTitle: t('nav.chat'),
                          targetView: 'models',
                          targetTitle: t('desk.models.title'),
                          targetDetail: t('models.defaults.heading'),
                        });
                      }}
                    >
                      <Settings2 size={11} />
                      {t('chat.modelConfig')}
                    </DeskButton>
                  </div>
                  {modelChoices === undefined ? (
                    <p className="px-1 py-1 text-[11px] text-slate-400">{t('chat.loading')}</p>
                  ) : modelChoices.length === 0 ? (
                    <p data-testid="chat-model-empty" className="px-1 py-1 text-[11px] text-slate-400">
                      {t('chat.modelEmpty')}
                    </p>
                  ) : (
                    <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
                      {modelChoices.map((choice) => {
                        const isCurrent = choice.model === chatModel;
                        return (
                          <DeskButton
                            key={`${choice.providerId}:${choice.model}`}
                            action="chat-model-pick"
                            variant={isCurrent ? 'solid' : 'ghost'}
                            compact
                            className="w-full justify-start"
                            markers={{
                              testid: 'chat-model-option',
                              model: choice.model,
                              provider: choice.providerId,
                            }}
                            onClick={() => {
                              close();
                              void call(
                                t('chat.actionModelSwitch', { model: choice.model }),
                                () =>
                                  bridge?.llm['settings.bindRole']({
                                    leg: 'chat',
                                    providerId: choice.providerId,
                                    model: choice.model,
                                  }),
                                { apply: applyModelView },
                              );
                            }}
                          >
                            <span className="min-w-0 truncate">
                              {choice.providerLabel} · {choice.model}
                            </span>
                            {isCurrent ? <Check size={12} className="ml-auto shrink-0 text-jade-ink" /> : null}
                          </DeskButton>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </DeskPopover>
            {/* 发送与停止合成**一颗**键（2026-11-02 用户裁定）：没在回复时是发送圆片，
                正在回复时变成停止图标档。流式期间仍然可以用 Enter 把下一句排进队列（spec 1.11-16）。 */}
            <DeskButton
              action={isStreaming ? 'stop' : 'send'}
              variant={isStreaming ? 'ghost' : 'solid'}
              compact
              busy={busy !== undefined}
              disabled={isStreaming ? false : isSendDisabled}
              disabledReason={isStreaming ? undefined : sendReason}
              disabledReasonLabel={!isStreaming && sendReason ? t(`chat.reason.${sendReason}`) : undefined}
              className={
                // 悬停档与这一格的凭据同处一行邻域（机检第 13 节②），所以挂在调用点而不是常量表里。
                isStreaming
                  ? ICON_CELL_CLASS
                  : isSendDisabled
                    ? SEND_DEAD_CLASS
                    : `${SEND_LIVE_CLASS} hover:bg-slate-100`
              }
              markers={{ 'send-mode': isStreaming ? 'stop' : 'now' }}
              tip={isStreaming ? t('chat.stop') : t('chat.send')}
              tipAlign="end"
              onClick={
                isStreaming ? () => void call(t('chat.actionStop'), () => bridge?.chat['session.stop']()) : submit
              }
            >
              {isStreaming ? (
                <Square size={12} />
              ) : (
                <ArrowUp size={15} className={isSendDisabled ? undefined : 'text-ink-900'} />
              )}
              <span className="sr-only">{isStreaming ? t('chat.stop') : t('chat.send')}</span>
            </DeskButton>
          </div>
        </div>
        {/* 卡下那条薄读数带（稿 `.understrip`：12px、`slate-400`、不描边）现在**只剩一个读数**：
            说明搬进了工具条上那一枚裸 icon（气泡形态，见上）。
            于是整条带只在**真折过一次**时出现——这一对数字是 `snapshot.compaction` 的现读数，
            没折过时这里根本不会有长度可言（界面上不摆一个"还没发生的读数"，也不留一条空带占高度）。 */}
        {compaction ? (
          <div className="mt-1.5 flex min-w-0 items-center px-1 text-[12px] text-slate-400">
            <span
              data-testid="chat-context-tokens"
              data-tokens-before={String(compaction.tokensBefore)}
              data-tokens-after={String(compaction.tokensAfter)}
              className="ml-auto"
            >
              {t('chat.compress.tokens', { before: compaction.tokensBefore, after: compaction.tokensAfter })}
            </span>
          </div>
        ) : null}
      </footer>

      {/* 设置抽屉（09 稿形态④「读与对照」）——2026-11-02 用户裁定后**只留免确认白名单**。
          档位不在这一格里了：它只在输入卡底部那颗胶囊的气泡里展示与选择，抽屉里不再有第二个写口。
          为什么仍然用抽屉而不是弹窗：名单是**边看边改**的东西，抽屉的遮罩让出左栏，鼠标随时能切走。
          正文是一张常开的块：抽屉里只有这一件事，再套一层可折叠段头等于让人多点一次才看得见按钮。 */}
      <Drawer
        action="chat-settings"
        open={isSettingsOpen}
        title={t('chat.settings.title')}
        subtitle={t('chat.settings.subtitle')}
        onClose={() => setIsSettingsOpen(false)}
      >
        <section className="rounded-xl border border-line bg-ink-900/60 px-4 py-3">
          <h4 className="mb-2 text-xs font-semibold text-slate-50">{t('agent.policy.heading')}</h4>
          <AgentPolicyPanel tools={tools} autonomy={snapshot?.session.autonomy} />
        </section>
      </Drawer>
    </section>
  );
}
