/**
 * 渲染层与主进程之间的桥接契约（唯一真相源）。
 *
 * preload 依据 `RENDERER_ALLOWLIST` 生成代理对象，IPC 网关依据同一份名单校验入站调用，
 * 因此「渲染层能调什么」与「主进程允许什么」永远是同一个常量，不会漂移。
 */
import type {
  AppErrorPayload,
  AutonomyLevel,
  ChatDeltaEvent,
  ChatMessageView,
  ChatSessionView,
  ChatSnapshotView,
  DeliverApprovalView,
  DeliverAttachmentView,
  JdProgressEvent,
  KernelViewLoadError,
  LocatorRelocatedEvent,
  LogLineView,
  PluginErrorView,
  RiskSignalEvent,
  SessionExpiredEvent,
  ToolCallReply,
  ToolDescriptorView,
  WorkflowEvidenceView,
  WorkflowNodeSpec,
  WorkflowProgressEvent,
  WorkflowRunStateView,
  WorkflowRunView,
} from '@auto-cc/core';

/**
 * 错误载荷、日志行、插件失败、会话/视图事件与工作流 run 数据模型都定义在 `@auto-cc/core`
 * （那里是跨进程契约与 cordis 事件声明的归属地），这里原样转出，渲染层只认 `@auto-cc/shared`
 * 一个入口。转出**只用 `export type`**：core 会带进 cordis，而渲染层的 bundle 里不该出现它。
 * 步骤 id 常量 `WORKFLOW_STEP_IDS` 只有主进程执行器需要（界面渲染服务返回的 `run.steps`），
 * 所以不在此转出。
 */
export type {
  AppErrorPayload,
  AutonomyLevel,
  ChatDeltaEvent,
  ChatMessageView,
  ChatPart,
  ChatSessionView,
  ChatSnapshotView,
  ChatRole,
  ChatTextPart,
  ChatToolPart,
  ChatToolPartState,
  DeliverApprovalView,
  DeliverAttachmentView,
  JdProgressEvent,
  KernelViewLoadError,
  LocatorRelocatedEvent,
  LogLineView,
  PluginErrorView,
  RiskSignalEvent,
  SessionExpiredEvent,
  ToolCallReply,
  ToolDescriptorView,
  ToolEffect,
  WorkflowEvidenceView,
  WorkflowNodeRunView,
  WorkflowNodeSpec,
  WorkflowProgressEvent,
  WorkflowRunStateView,
  WorkflowRunStatus,
  WorkflowRunView,
  WorkflowStepId,
  WorkflowStepStatus,
  WorkflowStepView,
  WorkflowTakeoverView,
} from '@auto-cc/core';

/** 渲染层可调用的 `service.method` 全限定名白名单（spec 1.4-07 的唯一依据）。 */
export const RENDERER_ALLOWLIST = [
  'shell.getStatus',
  'shell.setKernelViewVisible',
  'shell.probeMainCrash',
  'shell.probeRedact',
  'kernel.tree',
  'log.tail',
  'log.status',
  'ipc.probeReject',
  // 1.5 的运行时管理：一次快照 + 启停 + 配置读写 + 泄漏巡检。
  'plugins.status',
  'plugins.stop',
  'plugins.start',
  'plugins.readConfig',
  'plugins.saveConfig',
  'plugins.cycle',
  // 1.6 的自测通道：网关入站统计（1.6-12）与主进程侧目标对照（1.6-01 / 1.6-06）。
  'ipc.stats',
  'devtools.status',
  // 1.8 的内置内核会话：分区清单与登录态读数、打开站点、探测、登出。
  'sessions.status',
  'sessions.open',
  'sessions.probe',
  'sessions.logout',
  'sessions.close',
  // 2.7-06 的首次风险确认：读签字状态 + 写一次签字。写入口**只接受平台名**，
  // 不接受任意 scope，否则这条口就变成万能 KV 写入口（plan §14.3 第 6 条）。
  'sessions.consentStatus',
  'sessions.grantConsent',
  // 2.1 的页面操作：只允许导航到已登记平台的同源地址，快照是只读。
  'browser.page.navigate',
  'browser.page.snapshot',
  // 2.3 的批量抽取与滚动：只读页面内容，不产生任何外发（spec 2.3-11）。
  'browser.page.extract',
  'browser.page.scroll',
  // 2.2 的定位层：一次打分定位 + 一次指纹自愈。
  'browser.locate.find',
  'browser.locate.refind',
  'browser.locate.status',
  // 2.2 的动作层：点击/输入走 CDP 受信通道，等待走页面内观察器。
  'browser.act.click',
  'browser.act.type',
  'browser.act.select',
  'browser.act.waitFor',
  // 2.2 的平台登记面：只读清单（适配器本身不给渲染层，外发口在 2.5/2.6 另接闸门）。
  'platform.registry.list',
  // 2.3 的抓取入口与 JD 库读数：抓取只有读动作，外发一行都不产生。
  'jd.capture.run',
  'jd.capture.status',
  'jd.store.list',
  'jd.store.status',
  // 2.5 的会话面：三条都是**读**（读页面、读库、读概况）。打招呼走 `outbound.greet.perform`
  // 而不是直连适配器——界面能调的那一口必须已经在闸门里（1.9-05 要拦的就是绕过闸门的外发口）。
  'conversation.store.syncFrom',
  'conversation.store.list',
  'conversation.store.status',
  // 1.9 的外发额度闸门：判定、账本回看、以及唯一的外发样例入口。
  // 服务名带点（`域.能力`），所以界面侧拿到的是 `bridge.entitlement['gate.check']()`。
  'entitlement.gate.check',
  'usage.ledger.summary',
  'outbound.sample.send',
  // 2.5-e 的打招呼编排（闸门→幂等→黑名单→频控→发送→落账都在主进程一侧，界面拿不到绕过路径）。
  'outbound.greet.perform',
  // 2.6-c 的投递编排：确认卡片要能把「现在有哪些单子等人表态」读出来，并把表态送回去。
  // 外发口只有 `perform` 一条，且它在主进程一侧必经闸门（AGENTS.md §7.3）。
  'outbound.deliver.perform',
  'outbound.deliver.pending',
  'outbound.deliver.resolveApproval',
  // 1.10 的工作流 runner：五个动作口 + 一个只读快照。
  'workflow.runner.current',
  'workflow.runner.start',
  'workflow.runner.pause',
  'workflow.runner.resume',
  'workflow.runner.retryStep',
  // 2.4 的节点化 runner：计划声明、落库真相、以及「从库里那次中断续上」。
  'workflow.runner.nodes',
  'workflow.runner.state',
  'workflow.runner.resumable',
  'workflow.runner.resumeRun',
  // 2.8-a：中止（停在可恢复点上并落库 interrupted）与失败证据的读回。
  'workflow.runner.abort',
  'workflow.runner.readEvidence',
  // 1.11 的对话骨架：工具面（P1 为空表）与会话 / 消息 / 档位。
  'agent.tools.list',
  'agent.tools.call',
  'chat.session.current',
  'chat.session.send',
  'chat.session.stop',
  'chat.session.setAutonomy',
  'chat.session.startSession',
  // 3.3 生成轨导出面：预览/导出只认 docId + 模板 + 语言，文档正文不过进程边界（编辑轨 3.5 才引入 resume.doc.* 写入面）。
  // seedDemo 是 3.5 之前给端到端自测喂一份固定内容文档的口（spec 3.3-10）。
  'resume.export.seedDemo',
  'resume.export.preview',
  'resume.export.toPdf',
  // 3.7 快照的只读面（spec 3.7-03）：列历史 + 比对两份快照。正文不过进程边界，
  // 界面拿到的是「哪个快照、模板与时刻」与「条目级 / 字段级差异」两种读数。
  'resume.snapshot.list',
  'resume.snapshot.diff',
  // 4.1 简历导入面（spec 4.1-c）：渲染层没有读文件的通道（无 showOpenDialog / File），
  // 所以入参是**绝对路径**（同 `outbound.deliver` 的 `resumeFile` 口径）；回执只带区块计数与待确认清单，
  // 文档正文留在主进程侧的库里（spec 4.1-09 / 4.1-10 的边界）。
  'resume.parse.fromFile',
  'resume.parse.pending',
] as const;

export type BridgeCallId = (typeof RENDERER_ALLOWLIST)[number];

/**
 * 判定某个调用名是否在白名单内。
 * @param id 形如 `shell.getStatus` 的调用名，来自不可信输入（渲染层）
 * @returns 命中白名单为 true；未登记的能力一律 false
 */
export const isAllowedCall = (id: string): id is BridgeCallId => (RENDERER_ALLOWLIST as readonly string[]).includes(id);

/**
 * 一次桥接调用的线格式。
 *
 * `path` 是**未收窄的字符串**：入站数据来自渲染层，类型不能替它说话，
 * 是否合法由网关按 `isAllowedCall` 判定。
 */
export type BridgeRequest = { path: string; args: unknown[] };

/**
 * 桥接调用的统一回复形态：失败带结构化错误（code/path/message），
 * 裸 `Error` 过不了 structuredClone，消息会整条丢掉（spec 1.4-04）。
 */
export type BridgeReply<T> = { ok: true; value: T } | { ok: false; error: AppErrorPayload };

/** 主进程状态快照，供渲染层首屏与错误态展示。 */
export type ShellStatus = {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  windowVisible: boolean;
  kernelViewVisible: boolean;
  kernelViewBounds: { x: number; y: number; width: number; height: number };
  /** 内核视图当前所占的会话分区；未挂载站点时是占位页的分区。 */
  kernelViewPartition: string;
  /** 内核视图当前 URL（占位页会以 `data:` 原样出现）。 */
  kernelViewUrl: string;
  /**
   * 用户当前实际看到的页面地址：有 `window.open` / target=_blank 接管子视图时是栈顶那一个，
   * 否则就是 `kernelViewUrl`（spec 2.2-11：接管不逃逸、且与父视图同分区，所以分区仍读 `kernelViewPartition`）。
   */
  activeKernelViewUrl: string;
  /** 接管进来的子视图个数（0 = 只有内核视图本身）；与 `devtools.status().targetCount` 的增量互为对照。 */
  kernelViewTakeoverCount: number;
  /** 最近一次加载失败；成功加载后为 null，因此它总是「关于当前这个 URL」的。 */
  kernelViewLoadError: KernelViewLoadError | null;
  lastError: string | undefined;
};

/**
 * 一个平台的会话读数（spec 1.8-01 / 1.8-04 / 1.8-06）。
 *
 * 只带 cookie 的**名字**与过期时间，绝不含取值：这条快照会被渲染层显示、也会被 harness
 * 原样写进证据文件，一旦带上值就等于把登录凭证抄进日志与截图（AGENTS.md §8.5）。
 */
export type SessionPlatformView = {
  id: string;
  partition: string;
  startUrl: string;
  isPersistent: boolean;
  /** 分区在磁盘上的实际目录；in-memory 会话为 null，用于证明「落盘了」。 */
  storagePath: string | null;
  cookieNames: string[];
  /** 判定登录态所依据的 cookie 名。 */
  sessionCookieName: string;
  auth: 'active' | 'expired';
  /** 该 cookie 的过期时间戳（毫秒）；会话型 cookie 与缺席时为 null。 */
  expiresAt: number | null;
};

/** 会话总览：所有已配置平台 + 内核视图当前承载的是哪一个。 */
export type SessionsStatusView = { platforms: SessionPlatformView[]; activePlatform: string | null };

/**
 * 一个平台的首次自动化风险签字读数（spec 2.7-06）。
 *
 * `scope` 是库里的主键原文（`automation:<platform>`），把它一起交出去是为了让界面与证据文件
 * 能指认「这条读数读的是哪一行」，而不用靠平台名反推拼接规则——拼接规则只有一个实现，
 * 但证据里写着你不必信这句话，直接写值。
 */
export type SessionConsentView = {
  platform: string;
  scope: string;
  /** 库里是否已有这一行；false 时界面必须先拿到用户点头，动作才发出去。 */
  granted: boolean;
  /** 首次确认的毫秒时间戳；未签为 null（不用 0 冒充「1970 年签过」）。 */
  acknowledgedAt: number | null;
};

/**
 * 内核视图所在页面的一次读取（spec 2.1-03）。
 *
 * 正文是**截断后的节选**，同时给出截断前的长度：验收要的是「snapshot 与渲染页一致」，
 * 只给截断串不给出总长度，就分不清「页面就这么点字」和「被切了」。
 */
export type KernelPageSnapshotView = {
  /** 页面 `document.title`。 */
  title: string;
  /** 页面当前地址（装载中可能是上一个）。 */
  url: string;
  /** 装载态：`loading` / `interactive` / `complete`。 */
  readyState: 'loading' | 'interactive' | 'complete';
  /** 元素总数，用来和截图对照「页面确实渲染了东西」。 */
  elementCount: number;
  /** 截断前的正文长度（字符）。 */
  textLength: number;
  /** 正文节选。 */
  bodyText: string;
  /** 页面主要标题文本（h1/h2/h3，最多 12 条）。 */
  headings: string[];
  /** 该页面所在的会话分区；空串表示还没挂任何平台。 */
  partition: string;
};

/**
 * 有独立日上限的动作名（spec 2.7-03）——**闸门配置、渲染层入参、界面行三处共用的唯一来源**。
 *
 * 为什么这份表在 `shared` 而不是 `entitlement`：`outbound.sample` 的入参校验、`UsagePanel` 的循环、
 * 闸门的 `dailyLimits` 键都要引用同一批名字，任何一处自己抄一遍，就会出现
 * 「界面能发明一个闸门没有配额条目的动作名」——那正是 2.7-03 要堵的口子（plan §14.4 第 4 条）。
 * `search` 与另两个的差别：它是**只读**动作，额度管的是「今天允许发起几轮抓取」，不消耗任何外发机会。
 */
export const QUOTA_ACTIONS = ['search', 'greet', 'deliver'] as const;

/** 闸门认得的额度动作名。 */
export type QuotaAction = (typeof QUOTA_ACTIONS)[number];

/**
 * 渲染层可以**主动发起**的外发动作（spec 1.9-03 / 2.7-03）。
 *
 * 少了 `search`：抓取那一条账由 `jd.capture` 在跑完一轮后自己经闸门落，界面没有「发一次搜索」这张按钮。
 */
export const OUTBOUND_SAMPLE_ACTIONS = ['greet', 'deliver'] as const;

/** 样例/编排外发入口允许的动作名。 */
export type OutboundSampleAction = (typeof OUTBOUND_SAMPLE_ACTIONS)[number];

/**
 * 闸门一次判定的结果（spec 1.9-01）。
 *
 * `remaining` 用 `null` 表示「无限」而不是 `Infinity`：后者过不了 `structuredClone` 的语义期待，
 * 而且界面读到「剩余 ∞」和「剩余 0」的区别会被一个数字糊过去。
 * `reason` 只在被拒时非空，它是要**显示给用户看**的一句话，不是调试信息。
 */
export type GateDecisionView = { allowed: boolean; remaining: number | null; reason: string | null };

/** 账本里的一行（spec 1.9-04 / 1.9-08）。 */
export type LedgerRowView = {
  id: number;
  action: string;
  targetId: string | null;
  /** P1 还没有工作流执行器，所以这一列多为 null；列存在本身就是接线面的证据。 */
  workflowRunId: string | null;
  /** 毫秒时间戳，本地时区。 */
  ts: number;
  /** 可空：未来接 SaaS 后区分「本地记账」与「远端授权」。 */
  source: string | null;
  /** 可空：远端账单/流水的外部 id。 */
  remoteRef: string | null;
};

/** 用量回看的聚合读数（spec 1.9-07）：总数、按天分组、按动作分组，外加最近几行。 */
export type UsageSummaryView = {
  total: number;
  /** 本地「今天」的条数，与闸门日额度用的是同一个日界。 */
  today: number;
  byDay: { day: string; count: number; actions: { action: string; count: number }[] }[];
  byAction: { action: string; count: number }[];
  recent: LedgerRowView[];
};

/** 一次外发样例的入参（spec 1.9-03 / 1.9-04 / 2.7-03：动作名是枚举，不是任意字符串）。 */
export type SendSampleRequest = {
  action: OutboundSampleAction;
  targetId: string;
  message: string;
  workflowRunId?: string | null;
};

/** 外发成功后的回执：账本行 + 对端计数（P1 的「确实发出去了」由 fixture 的收件数证明）。 */
export type SendReceiptView = {
  action: OutboundSampleAction;
  targetId: string;
  /** 本次落账的账本行 id；被拒时根本走不到回执（决策 1：被拒不记账）。 */
  ledgerId: number;
  /** fixture 侧累计收到的条数。 */
  delivered: number;
};

/**
 * 打一次招呼的入参（spec 2.5-02 / 2.5-13）。
 *
 * `text` 与 `script` 二选一：前者是用户在界面上改过的现成文案，后者交给 `outbound.script` 生成。
 * 两个都给时以 `text` 为准——改过的就是要发出去的。
 */
export type GreetRequestView = {
  /** 平台标识，决定向 `platform.registry` 问哪个平台的打招呼渠道（问不到即 `OUTBOUND_CHANNEL_MISSING`） */
  platform: string;
  /** 会话目标（P2 起是平台侧 jobid） */
  jobId: string;
  /** 现成文案（用户改过的）；省略时按 `script` 生成 */
  text?: string;
  /** 话术生成入参的最小必需集：岗位名与公司名缺一即拒，不生成空话术 */
  script?: { jdId: string; title: string; company: string; keywords?: string[]; evidence?: { fact: string }[] };
  /** 属于哪一次工作流运行；界面单次触发时为空 */
  workflowRunId?: string | null;
  /** 判定与落账的基准毫秒；省略取当前时间（单测靠它造「刚发过一次」，不必真等一个频控周期） */
  nowMs?: number;
};

/**
 * 打招呼的成功回执（spec 2.5-03）：任何字段缺失都到不了这里，失败一律以结构化错误上浮。
 *
 * 有回执 = 页面回读确认发出去了 = 账本上有行了，三件事同源，所以这里不再重复一个 `sent: true`。
 */
export type GreetReceiptView = {
  platform: string;
  jobId: string;
  /** 页面是怎么确认这条发送的（状态行回读到的原文） */
  reason: string;
  /** 本次落账的账本行 id */
  ledgerId: number;
  /** 为满足频控实际等待的毫秒数；第一次发送为 0 */
  waitedMs: number;
  /** 可追溯来源：`模板版本:JD id`，用户手改的文案写成 `manual:JD id`（spec 2.5-09） */
  source: string;
  /** 内容来源：模型产出 / 模板回落 / 用户手改 */
  origin: 'model' | 'template' | 'manual';
};

/**
 * 投递请求（spec 2.6-01 / 06）：一次「把这份简历递给这个岗位」的意图。
 *
 * 与打招呼不同，这里没有文案字段——2.6-b 只递文件，随信正文留给 P3 之后（plan §13.7 第 2 条）。
 */
export type DeliverRequestView = {
  /** 平台标识，决定向 `platform.registry` 问哪个平台的投递渠道（问不到即 `OUTBOUND_CHANNEL_MISSING`） */
  platform: string;
  /** 目标岗位（P2 起是平台侧 jobid），也是幂等键里的 target */
  jobId: string;
  /** 简历文件绝对路径；省略时用 `outbound.deliver` 配置里的 `resumeFile`（P3 之前的临时入口） */
  filePath?: string;
  /** 岗位名：只用于确认卡片与回执展示，不参与任何判据（JD 行的查询面还没接，见 plan §13.7 第 1 条） */
  title?: string;
  /** 公司名：同上，纯展示 */
  company?: string;
  /**
   * 这一版简历的快照 id（`resume_snapshots.snapshot_id`，来自 `resume.export` 的回执）。
   * 省略时投递记录里的引用为 null——「只给了一个文件路径」这种投递没有可还原的当时内容（spec 3.7-02）。
   */
  snapshotId?: string;
  /** 属于哪一次工作流运行；界面单次触发时为空 */
  workflowRunId?: string | null;
  /** 判定与落账的基准毫秒；省略取当前时间（单测靠它造「刚递过一次」，不必真等一个频控周期） */
  nowMs?: number;
};

/**
 * 投递回执（spec 2.6-01 / 03 / 06）。
 *
 * `committed` 是唯一一个「有没有离开 app」的读数：`suggest` 档只 stage，因此没有账本行也不该有。
 * 真的发出去了但页面没确认，那一路是抛 `OUTBOUND_NOT_DELIVERED` 而不是回一个 `committed:false`——
 * 与打招呼同一条口径（失败以结构化错误上浮，回执只描述成功）。
 */
export type DeliverReceiptView = {
  platform: string;
  jobId: string;
  title: string;
  company: string;
  attachment: DeliverAttachmentView;
  /** 页面怎么确认这次投递的；只准备未发送时是「为什么没发」的说明 */
  reason: string;
  /** 本次落账的账本行 id；`suggest` 档没发出去因此为 null */
  ledgerId: number | null;
  /** 为满足频控实际等待的毫秒数；第一次发送为 0 */
  waitedMs: number;
  /** 可追溯来源：`resume:<sha256 前 12 位>@<文件名>`（spec 2.6-05，复用账本已有的 `source` 列） */
  source: string;
  /**
   * 这次递出去的是哪一版（`delivery_records.snapshot_id`，spec 3.7-02）。
   * null 是实话：请求本来就只带了文件路径，没有可还原的当时内容。
   */
  snapshotId: string | null;
  /** 这次有没有真的离开 app */
  committed: boolean;
};

/**
 * 内嵌内核视图占位区宽度占客户区宽度的比例。
 * 主进程用它摆 `WebContentsView`，渲染层用它摆对应的 Tailwind 槽位，两侧必须同源。
 */
export const KERNEL_VIEW_WIDTH_RATIO = 0.38;

/**
 * app 界面自己占的会话分区。
 * 主窗口刻意不用 default session：给了显式分区之后，「界面读不到站点 cookie」是分区名不同
 * 带来的结构事实，而不是恰好没共享（spec 1.8-02）。
 */
export const APP_PARTITION = 'persist:app';

/**
 * 平台站点分区名的唯一生成处（spec 1.8-01）。
 * @param platform 平台标识（如 `fixture` / `boss`），必须是 ASCII 短名
 * @returns `persist:` 前缀的分区名 —— Chromium 据此把该会话的 cookie/storage 落盘
 */
export const partitionFor = (platform: string): string => `persist:${platform}`;

/**
 * 插件树节点（spec 1.3-01 / 1.3-09 / 1.3-10 的界面证据）。
 * 1.4 起由 `kernel.tree` 直连给出，不再经 shell 代理。
 * 1.5 起带 `stack`：面板折叠显示完整调用栈（spec 1.5-07）。
 */
export type PluginNodeView = {
  id: string;
  state: 'pending' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading';
  dependsOn: string[];
  keys: string[];
  error?: string;
  stack?: string;
};

/** 内核快照：树 + 清单自身的错误（清单写坏时树可能是空的）。 */
export type PluginTreeSnapshot = { nodes: PluginNodeView[]; manifestError?: string };

/**
 * 运行时指标（spec 1.5-01 / 1.5-08）。
 * `registrySize` 回基线是「不泄漏」的判据；`registryCounter` 是单调挂载序号，只用于展示。
 */
export type PluginMetricsView = {
  registrySize: number;
  registryCounter: number;
  effectTotal: number;
  effects: { id: string; effects: number }[];
  activeResources: number;
};

/** 调试面板的一次性快照：指标 + 卸载闸门 + 错误历史。 */
export type PluginStatusView = {
  metrics: PluginMetricsView;
  /** 不允许从界面卸载的插件 id；面板据此决定要不要给某一行摆 Stop 按钮。 */
  guarded: string[];
  errorCount: number;
  errors: PluginErrorView[];
};

/** 反复启停后的对照（spec 1.5-08）：三个漂移都为 0 才算没泄漏。 */
export type PluginCycleView = {
  id: string;
  rounds: number;
  before: PluginMetricsView;
  after: PluginMetricsView;
  sizeDrift: number;
  effectDrift: number;
  resourceDrift: number;
};

/** 面板配置编辑器的读取结果（spec 1.5-06）：`mounted` 为 false 时新配置要等 Start 才生效。 */
export type PluginConfigView = { id: string; values: Record<string, unknown>; mounted: boolean };

/** 日志出口状态：落盘路径与生效级别。 */
export type LogStatusView = { file?: string; level: string };

/**
 * 网关入站统计（spec 1.6-12）：面板与 harness 的「调用成功率」同源。
 * `denied` 只数白名单拒绝，不含服务内部抛出的业务错误——那类失败在错误历史里看。
 */
export type IpcStatsView = { inFlight: number; completed: number; denied: number };

/** 主进程侧看到的一个页面目标（spec 1.6-06 的对照项）。 */
export type DevtoolsTargetView = {
  id: number;
  title: string;
  url: string;
  /** 是否主窗口的 webContents；剩下的就是内嵌内核视图等兄弟目标。 */
  isMainWindow: boolean;
  /** 当前是否持有键盘焦点：harness 点完一下就靠它确认焦点真的落到了这个目标上。 */
  isFocused: boolean;
};

/** 自测通道读数（spec 1.6-01 / 1.6-08）：CDP 开在哪个端口、主进程有几个目标。 */
export type DevtoolsStatusView = {
  isPackaged: boolean;
  isCdpEnabled: boolean;
  cdpPort: number | null;
  targetCount: number;
  targets: DevtoolsTargetView[];
};

/**
 * 简历语言档（镜像 resume-doc 的 `TemplateLocale`）。
 * shared 不认识领域包（依赖方向 + 不让 cordis 泄进渲染层产物），故线格式在此独立声明。
 */
export type ResumeLocaleView = 'zh-CN' | 'en';

/**
 * 演示种子的版本（镜像 resume-doc 的 `ResumeSeedVariant`）。
 * `edited` 只为在编辑轨（3.5）落地前给 3.7-03 的 diff 界面造出第二版内容；真实编辑入口上线后它就该退场。
 */
export type ResumeSeedVariantView = 'base' | 'edited';

/** 演示种子的回执（镜像 `resume.export.seedDemo` 的返回）。 */
export interface ResumeSeedView {
  docId: string;
  hash: string;
}

/**
 * 导入源格式（镜像 resume-kb 的 `ResumeSourceFormat`）：按魔数判定，与文件扩展名无关。
 * shared 不认识领域包（依赖方向 + 不让 cordis 泄进渲染层产物），故线格式在此独立声明。
 */
export type ResumeSourceFormatView = 'pdf' | 'docx' | 'markdown' | 'text';

/** 一次导入的结论（镜像 resume-kb 的 `ImportStatus`）。`scanned` 是「疑似扫描件」这条**正常结论**，不是异常（spec 4.1-05）。 */
export type ImportStatusView = 'imported' | 'scanned';

/** 解析不确定标记的种类（镜像 resume-kb 的 `ParseIssueCode`，spec 4.1-04 的清单按它归类）。 */
export type ParseIssueCodeView =
  'text-too-short' | 'missing-field' | 'unparsable-field' | 'sensitive-redacted' | 'unknown-section';

/** 一条待确认记录（镜像 resume-kb 的 `ParseIssue`）：`excerpt` 主进程侧已脱敏，界面直接显示、不再二次加工。 */
export interface ParseIssueView {
  code: ParseIssueCodeView;
  /** 出问题的区块种类；文档级问题（过短、姓名缺失）为 null。 */
  sectionKind: string | null;
  entryId: string | null;
  fieldKey: string | null;
  excerpt: string;
}

/** 一个区块的条目计数（导入回执的片段）：正文不过进程边界，界面只拿到「读到了哪几块、各几条」。 */
export interface ImportSectionView {
  kind: string;
  title: string;
  entries: number;
}

/** 一次导入的回执（镜像 resume-kb 的 `ImportReceipt`）。 */
export interface ImportReceiptView {
  status: ImportStatusView;
  docId: string;
  /** 来源哈希（spec 4.1-07 的幂等键），界面用它指认「这份文件已经导过」。 */
  sourceHash: string;
  format: ResumeSourceFormatView;
  /** false 表示同哈希的二次导入：库里的行数不变。 */
  isNew: boolean;
  textLength: number;
  sections: ImportSectionView[];
  issues: ParseIssueView[];
}

/** 待确认清单的一行（镜像 resume-kb 的 `PendingImportView`，spec 4.1-04 界面的数据源）。 */
export interface PendingImportRowView {
  docId: string;
  sourceHash: string;
  format: ResumeSourceFormatView;
  status: ImportStatusView;
  textLength: number;
  updatedAt: number;
  issues: ParseIssueView[];
}

/** 一次导出的回执（镜像 resume-doc 的 `ExportReceipt`）。 */
export interface ExportReceiptView {
  docId: string;
  path: string;
  pages: number;
  bytes: number;
  hash: string;
  /**
   * 这次导出留下的快照 id（spec 3.7-01）：投递要引用它才答得出「当时内容是什么」（spec 3.7-02）。
   * 界面把它接住再交给 `outbound.deliver.perform`，一条可追溯链因此在两个域之间接通。
   */
  snapshotId: string;
}

/** 一条快照的摘要（镜像 resume-doc 的 `SnapshotMeta`，spec 3.7-03 列表要摆的那几行读数）。 */
export interface SnapshotMetaView {
  snapshotId: string;
  docId: string;
  templateId: string;
  fontSet: string;
  /** 内容 hash（3.1-05 那一条），界面用它指认「这两版其实一模一样」 */
  hash: string;
  /** 快照时刻（毫秒），由主进程格式化前原样递出，界面按 locale 显示 */
  createdAt: number;
}

/** 区块种类（镜像 resume-doc 的 `SectionKind`；界面的区块标签按它走 i18n，见 3.2-06 同一口径）。 */
export type ResumeSectionKindView = 'summary' | 'experience' | 'education' | 'skills' | 'project' | 'campus';

/** 变更类型（镜像 resume-doc 的 `ChangeType`）。 */
export type SnapshotChangeTypeView = 'added' | 'removed' | 'modified';

/**
 * 字段级变化（镜像 `FieldChange`）。
 * `locked` 为真表示这个字段是事实锁定字段——它的变化在界面上要标成「待确认」而不是普通改动（spec 3.1-03）。
 */
export interface SnapshotFieldChangeView {
  key: string;
  change: SnapshotChangeTypeView;
  before: string | null;
  after: string | null;
  locked: boolean;
}

/** 条目级变化（镜像 `EntryChange`）：整条增删时 `fields` 里全部按同一类型标出。 */
export interface SnapshotEntryChangeView {
  entryId: string;
  change: SnapshotChangeTypeView;
  fields: SnapshotFieldChangeView[];
}

/** 区块级变化（镜像 `SectionChange`）：只出现在真的有条目变动的区块上。 */
export interface SnapshotSectionChangeView {
  sectionId: string;
  kind: ResumeSectionKindView;
  change: SnapshotChangeTypeView;
  entries: SnapshotEntryChangeView[];
}

/** 两份快照的差异（镜像 resume-doc 的 `DocDiff`，spec 3.7-03 的界面读数；无变化时 `isEmpty` 为真）。 */
export interface SnapshotDiffView {
  sections: SnapshotSectionChangeView[];
  isEmpty: boolean;
}

/** 每个白名单调用的入参元组与返回值，渲染层类型的来源。 */
export interface BridgeSignatures {
  'shell.getStatus': { args: []; returns: ShellStatus };
  'shell.setKernelViewVisible': { args: [visible: boolean]; returns: { kernelViewVisible: boolean } };
  'shell.probeMainCrash': { args: []; returns: never };
  /** 仅开发态：写一条含敏感字段的日志，回读走 `log.tail` 与事件推送。 */
  'shell.probeRedact': { args: []; returns: { written: true } };
  'kernel.tree': { args: []; returns: PluginTreeSnapshot };
  'log.tail': { args: [limit?: number]; returns: LogLineView[] };
  'log.status': { args: []; returns: LogStatusView };
  /**
   * 仅开发态：按给定 path 走一遍网关，网关放行时带回返回值，网关拒绝时以结构化错误失败
   * （1.4-04 / 1.4-07）。返回值刻意是 `unknown` 而不是 `BridgeReply`——信封只有一层。
   */
  'ipc.probeReject': { args: [path: string]; returns: unknown };
  /** 运行时快照：指标 + 卸载闸门 + 错误历史（spec 1.5-01 / 1.5-07）。 */
  'plugins.status': { args: []; returns: PluginStatusView };
  'plugins.stop': { args: [id: string]; returns: PluginNodeView };
  'plugins.start': { args: [id: string]; returns: PluginNodeView };
  'plugins.readConfig': { args: [id: string]; returns: PluginConfigView };
  /** 保存并即时生效（spec 1.5-06）；非法字段以 `CONFIG_INVALID` 结构化错误失败。 */
  'plugins.saveConfig': { args: [id: string, patch: Record<string, unknown>]; returns: PluginNodeView };
  /** 反复启停做泄漏巡检（spec 1.5-08）。 */
  'plugins.cycle': { args: [id: string, rounds?: number]; returns: PluginCycleView };
  /** 网关入站统计（spec 1.6-12）：在途 / 已完成 / 白名单拒绝。 */
  'ipc.stats': { args: []; returns: IpcStatsView };
  /** 主进程侧的自测通道读数（spec 1.6-01 / 1.6-06），与 CDP `/json/list` 交叉核对。 */
  'devtools.status': { args: []; returns: DevtoolsStatusView };
  /** 会话总览：分区、落盘路径、cookie 名与登录判定（spec 1.8-01 / 1.8-04）。 */
  'sessions.status': { args: []; returns: SessionsStatusView };
  /** 让内核视图按该平台的分区打开起始地址（spec 1.8-02 / 1.8-08）。 */
  'sessions.open': { args: [platform: string]; returns: SessionsStatusView };
  /** 只读 cookie 判登录态，不发站点请求；失效时顺带推 `session/expired`（spec 1.8-06）。 */
  'sessions.probe': { args: [platform: string]; returns: SessionPlatformView };
  /** 清掉该平台分区的 cookie，用于验收「退出登录即清除」（spec 1.8-04）。 */
  'sessions.logout': { args: [platform: string]; returns: SessionPlatformView };
  /** 收回内核视图里的站点页面；分区与登录态一条都不动（spec 2.1-11 的「关」）。 */
  'sessions.close': { args: []; returns: SessionsStatusView };
  /**
   * 读一个平台的首次自动化风险签字状态（spec 2.7-06）：界面在发起抓取/打招呼/投递/工作流**之前**问这一句。
   * 未登记的平台以 `PLATFORM_NOT_CONFIGURED` 结构化失败，不静默回「没签」。
   */
  'sessions.consentStatus': { args: [platform: string]; returns: SessionConsentView };
  /**
   * 写一次签字（spec 2.7-06）：只接受平台名，scope 由主进程拼，界面传不进任意键。
   * 重复调用不刷新首次时刻——审计问的是「风险从哪一刻被承担」。
   */
  'sessions.grantConsent': { args: [platform: string]; returns: SessionConsentView };
  /** 导航到已登记平台的同源地址，装载落定后回一份页面快照（spec 2.1-03）。 */
  'browser.page.navigate': { args: [url: string]; returns: KernelPageSnapshotView };
  /** 读取当前页面快照；可选参数是本次正文上限（字符），上限受服务配置钳制。 */
  'browser.page.snapshot': { args: [maxChars?: number]; returns: KernelPageSnapshotView };
  /** 2.3-01：按「容器 + 字段声明」批量读一页，一次调用读完 N 个容器 × M 个字段。 */
  'browser.page.extract': { args: [request: ExtractRequest]; returns: ExtractResultView };
  /** 2.3-06：滚到页底触发无限滚动，回读滚动位置与是否到底。 */
  'browser.page.scroll': { args: []; returns: PageScrollReading };
  /**
   * 按声明顺序尝试多策略候选并打分（spec 2.2-01 / 2.2-02）。
   * `lastKnown` 是上一次成功定位留下的指纹：候选全部失配时用它做自愈重定位（spec 2.2-05）。
   */
  'browser.locate.find': { args: [spec: LocateSpec, lastKnown?: ElementFingerprint]; returns: LocateResultView };
  /** 只用指纹在当前页面重找（改版后的显式自愈口，spec 2.2-05）。 */
  'browser.locate.refind': { args: [fingerprint: ElementFingerprint]; returns: LocateResultView };
  /** 定位层的当期读数：阈值配置与最近几次失败，供界面解释「为什么这条不确定」。 */
  'browser.locate.status': { args: []; returns: LocateStatusView };
  /** 真实点击：定位 → 算视口坐标 → CDP `Input.dispatchMouseEvent`（spec 2.2-12）。 */
  'browser.act.click': { args: [spec: LocateSpec]; returns: ActResultView };
  /** 文本输入：定位 → 聚焦 → CDP `Input.insertText`（中文/emoji 不乱码，spec 2.2-13）。 */
  'browser.act.type': { args: [spec: LocateSpec, text: string]; returns: ActResultView };
  /** 下拉选择：定位 → 页面内设值并派发 change。通道在结果里如实标注为 `dom`。 */
  'browser.act.select': { args: [spec: LocateSpec, value: string]; returns: ActResultView };
  /** 谓词等待：页面内 MutationObserver 触发，超时是结构化失败而不是抛错（spec 2.2-03 / 2.2-04）。 */
  'browser.act.waitFor': { args: [predicate: WaitPredicate]; returns: ActResultView };
  /** 已登记平台清单（spec 2.2-07）：内核侧只读，不返回适配器本身。 */
  'platform.registry.list': { args: []; returns: PlatformRegistryView };
  /** 2.3-01 / 2.3-09：跑一轮抓取（列表滚动 + 详情读取 + 入库），回传本轮结局。 */
  'jd.capture.run': { args: [criteria: JobSearchCriteriaView]; returns: CaptureRunView };
  /** 抓取层的当期配置与最近一次运行（面板解释「上次抓到哪」用）。 */
  'jd.capture.status': { args: []; returns: CaptureStatusView };
  /** JD 库只读清单（默认最近 20 条）。 */
  'jd.store.list': { args: [limit?: number]; returns: JobListResultView };
  /** JD 库概况与 schema 版本（spec 2.3-05 的实测读数）。 */
  'jd.store.status': { args: []; returns: JdStoreStatusView };
  /**
   * 读某个目标的会话页并落库（spec 2.5-07）。只读动作：不点发送、不进额度闸门，
   * 所以它可以摆在界面上反复按——第二遍全是 `duplicate` 正是这条验收要的读数。
   */
  'conversation.store.syncFrom': { args: [jobId: string, platform?: string]; returns: ConversationSyncView };
  /** 某个目标已落库的消息，按读取时间升序（默认最近 50 条）。 */
  'conversation.store.list': { args: [jobId: string, limit?: number]; returns: ConversationListResultView };
  /** 会话库概况与 schema 版本。 */
  'conversation.store.status': { args: []; returns: ConversationStatusView };
  /**
   * 闸门判定（spec 1.9-01 / 1.9-02 / 2.7-03）。界面只用它显示剩余额度，
   * **放行口是 `entitlement.gate.perform`**，它不在白名单里也不该在：越过账本的外发正是 1.9-05 要拦的形态。
   * 入参是 `QuotaAction` 而不是任意字符串：日上限按动作取值之后，任意字符串就等于从渲染层发明免限的动作名。
   */
  'entitlement.gate.check': { args: [action: QuotaAction]; returns: GateDecisionView };
  /** 账本回看：总数、按天、按动作，外加最近几行（spec 1.9-07 / 1.9-08）。 */
  'usage.ledger.summary': { args: [recentLimit?: number]; returns: UsageSummaryView };
  /** 外发样例：唯一经过闸门的外发入口，目标只有本地 fixture（AGENTS.md §7.2）。 */
  'outbound.sample.send': { args: [request: SendSampleRequest]; returns: SendReceiptView };
  /**
   * 打招呼编排入口（spec 2.5-02 / 03 / 04 / 09 / 10 / 13）：幂等 → 内容 → 黑名单 → 额度 → 频控 → 发送 → 落账，
   * 全在主进程一侧完成，界面拿到的是回执或被拒的结构化错误，没有绕过闸门的第二条口。
   */
  'outbound.greet.perform': { args: [request: GreetRequestView]; returns: GreetReceiptView };
  /**
   * 投递编排入口（spec 2.6-01 / 02 / 03 / 05 / 06）：stage → 闸门 → 频控 → 审批 → 现问渠道
   * 二次校验 → 页面投递 → 落账，全在主进程一侧。`semi` 档会在这里挂起等 `resolveApproval`，
   * 所以界面的那一次调用是「按下发送键并等用户表态」，不是「立刻发出去」。
   */
  'outbound.deliver.perform': { args: [request: DeliverRequestView]; returns: DeliverReceiptView };
  /**
   * 此刻有哪些投递单在等人表态（spec 2.6-01 的「待发送态」）：界面刷新/重进视图时靠它**重画**卡片，
   * 而不是只接住那一次 `outbound/approval-requested` 事件。
   */
  'outbound.deliver.pending': { args: []; returns: DeliverApprovalView[] };
  /**
   * 用户对某张单子表态（spec 2.6-01 / 08）：`approved:false` 与「超时没人点」走同一条拒绝路径。
   * 单子已经不存在（已结算，或配置热重载把服务重建了）以 `APPROVAL_NOT_FOUND` 结构化失败上浮——
   * 查不到就绝不放行任何一次投递，界面按「这张卡片已经没了」提示。
   */
  'outbound.deliver.resolveApproval': {
    args: [approvalId: string, approved: boolean];
    returns: DeliverApprovalView;
  };
  /**
   * 当前 run 的快照（spec 1.10-04）；挂载即是 `idle` 快照，槽位数等于当前计划的节点数（spec 2.4-02），
   * 所以永不为 null，界面不必为空态另写一套。
   * P1 只有一个「当前 run」，所以这几个动作口都不带 runId（plan §8.5「不做 run 历史列表」）。
   */
  'workflow.runner.current': { args: []; returns: WorkflowRunView };
  /** 起一次真实计划驱动的 run（2.4 之后不再是「六步空转」），返回初始状态。 */
  'workflow.runner.start': { args: []; returns: WorkflowRunView };
  /** 请求暂停：等当前步协作让出，不强杀（spec 1.10-05 / 2.4-07）。 */
  'workflow.runner.pause': { args: []; returns: WorkflowRunView };
  /** 从当前步续跑，不重置已完成步（spec 1.10-05）。 */
  'workflow.runner.resume': { args: []; returns: WorkflowRunView };
  /** 单独重试某一个失败步或接管步（spec 1.10-06 / 2.4-06）；步 id 来自界面，越界即结构化失败。 */
  'workflow.runner.retryStep': { args: [stepId: string]; returns: WorkflowRunView };
  /** 当前计划的节点声明（spec 2.4-01）：面板与 2.8 的工具卡片用它列节点，只读。 */
  'workflow.runner.nodes': { args: []; returns: WorkflowNodeSpec[] };
  /** **内存里这次** run 的落库真相（spec 2.4-04 的 `evidenceRef`、2.4-03 的 `attempts` 从这里读）。 */
  'workflow.runner.state': { args: []; returns: WorkflowRunStateView | null };
  /** 库里最近一次可续的 run（spec 2.4-05）：重启后 `state()` 还没有行，界面靠这条显示「上次中断在第 i 个节点」。 */
  'workflow.runner.resumable': { args: []; returns: WorkflowRunStateView | null };
  /**
   * 从库里续上一次的 run（spec 2.4-05），与 `resume`（本次运行内的续跑）不是一回事。
   * 省略 `runId` 时按当前计划指纹取最近一次；计划改过就结构化失败，不会按老下标瞎跑。
   */
  'workflow.runner.resumeRun': { args: [runId?: string]; returns: WorkflowRunView };
  /**
   * 中止本次 run（spec 2.8-03）：停在可恢复点上，并把库里这一行判成 `interrupted` + `USER_ABORT`。
   * 与 `pause` 的区别只有一句：中止会在落库上留下「是用户按的」这个码，且之后靠 `resumeRun` 而不是 `resume` 续。
   */
  'workflow.runner.abort': { args: []; returns: WorkflowRunView };
  /**
   * 读回一个失败节点的证据（spec 2.8-04）：错误码 + 已脱敏的正文 + 现场截图（data URL）。
   * 两个 id 都来自界面读数而不是用户输入，主进程仍然按不可信输入处理（查不到就不读盘）。
   */
  'workflow.runner.readEvidence': { args: [runId: string, nodeId: string]; returns: WorkflowEvidenceView };
  /**
   * 列举当前可见的工具（spec 1.11-04）；P1 恒返回空数组，
   * 界面把它摆在档位旁边，「工具面是空表」这件事本身就看得见。
   */
  'agent.tools.list': { args: []; returns: ToolDescriptorView[] };
  /**
   * 调用一个工具（spec 1.11-09）。返回值是**协议内的结果联合**而不是抛错：
   * 工具失败要变成卡片上的一条内容，不能让整条消息消失。
   */
  'agent.tools.call': { args: [toolId: string, input: unknown]; returns: ToolCallReply };
  /** 当前会话的整份快照（spec 1.11-08）；首次访问就地建会话，永不为 null。 */
  'chat.session.current': { args: []; returns: ChatSnapshotView };
  /** 发一条用户消息并起一次流式回复，返回刚进入流式态的助手消息（spec 1.11-02 / 03）。 */
  'chat.session.send': { args: [text: string]; returns: ChatMessageView };
  /** 中止正在流式的回复并把已产出的部分如实落库（spec 1.11-13）。 */
  'chat.session.stop': { args: []; returns: ChatMessageView | null };
  /** 切换自治档位（spec 1.11-07）；P1 只写这一列，不产生行为差异。 */
  'chat.session.setAutonomy': { args: [level: AutonomyLevel]; returns: ChatSessionView };
  /** 另起一个新会话，旧会话的行一条都不动（spec 1.11-08）。 */
  'chat.session.startSession': { args: []; returns: ChatSnapshotView };
  /**
   * 落一份固定内容演示简历（spec 3.3-10「本机先用固定内容验」，编辑轨 3.5 之前导出链的唯一文档来源）；
   * 返回种子 id 与落库 hash，界面据此再去预览/导出。`variant='edited'` 会在同一 docId 上落一份内容不同的第二版
   * （3.7-03 的 diff 界面在没有录入入口时的唯一来源）。
   */
  'resume.export.seedDemo': { args: [variant?: ResumeSeedVariantView]; returns: ResumeSeedView };
  /**
   * 渲染预览 HTML（spec 3.3-01「预览即导出所见」）：返回与 `toPdf` **同一份**打印 HTML 字符串，
   * 界面塞进 iframe 即可所见即所得。文档内容不过进程边界，只传 docId + 模板 + 语言。
   */
  'resume.export.preview': { args: [docId: string, templateId: string, locale?: ResumeLocaleView]; returns: string };
  /**
   * 导出 PDF（spec 3.3-04 / 05 / 09）：主进程离屏视图 printToPDF → 落 userData/exports → 回写页数，
   * 界面拿到的是产物回执（路径 / 页数 / 字节 / hash）或结构化失败。
   */
  'resume.export.toPdf': {
    args: [docId: string, templateId: string, locale?: ResumeLocaleView];
    returns: ExportReceiptView;
  };
  /**
   * 列出某文档的导出快照历史（spec 3.7-01 的读数，界面「比哪两版」的选择器数据源）：最新的在前，只回摘要不回正文。
   */
  'resume.snapshot.list': { args: [docId: string]; returns: SnapshotMetaView[] };
  /**
   * 比对两份快照（spec 3.7-03）：主进程把两侧各自 `restore` 成合法文档后交 3.1-06 的 `diff()`，
   * 界面拿到的是条目级 + 字段级差异；任一侧查无此快照或内容已损坏以 `INVALID_ARGUMENT` 结构化失败上浮。
   */
  'resume.snapshot.diff': { args: [fromSnapshotId: string, toSnapshotId: string]; returns: SnapshotDiffView };
  /**
   * 导入一份简历文件（spec 4.1-01 / 06 / 07）：主进程按绝对路径读字节、判格式、抽文本、幂等入库。
   * 失败以 `AppErrorPayload`（`RESUME_IMPORT_FAILED`）上浮，界面给一句中文；疑似扫描件不算失败，
   * 而是 `status: 'scanned'` 的正常回执（spec 4.1-05）。
   */
  'resume.parse.fromFile': { args: [filePath: string]; returns: ImportReceiptView };
  /**
   * 列出还带着未处理条目的导入记录（spec 4.1-04 的待确认清单）：按更新时间倒序，
   * issues 已清空的历史记录不出现。
   */
  'resume.parse.pending': { args: []; returns: PendingImportRowView[] };
}

/**
 * 编译期保险丝：白名单新增一项而 `BridgeSignatures` 忘了补签名，这里立刻报错，
 * 不会出现「主进程允许、渲染层无类型」的漂移。
 */
export type BridgeSignaturesCovered = { [K in BridgeCallId]: BridgeSignatures[K] };

/** 从 `service.method` 里取出服务名段。 */
type NamespaceOf<Id extends BridgeCallId> = Id extends `${infer Service}.${string}` ? Service : never;

/**
 * 由 `BridgeSignatures` 推导的命名空间形状：`service` 段 → `method` 段 → 调用。
 *
 * 必须先用 `NamespaceOf` 把命名空间提成一层键：在 mapped type 的值位置里 `K` 仍是原始的
 * 完整调用名，直接拿它去 `Extract<..., `${K}.${string}`>` 会一个都不命中，整个命名空间就变成 `{}`。
 */
export type BridgeNamespaces = {
  [Service in NamespaceOf<BridgeCallId>]: {
    [Id in Extract<BridgeCallId, `${Service}.${string}`> as Id extends `${Service}.${infer Method}` ? Method : never]: (
      ...args: BridgeSignatures[Id]['args']
    ) => Promise<BridgeReply<BridgeSignatures[Id]['returns']>>;
  };
};

/**
 * 主进程→渲染层的事件白名单（spec 1.4-03）：没登记的事件在网关处就不出进程。
 * 事件是「推」的，界面靠它自增，不轮询。
 */
export const RENDERER_EVENTS = [
  'log/line',
  'session/expired',
  'shell/view-error',
  'workflow/progress',
  'chat/delta',
  // 自愈重定位成功（spec 2.2-05）：选择器腐化要被看见，而不是藏在日志里。
  'locator/relocated',
  // 抓取进度（spec 2.3-07）：面板实时显示「第 N 轮 · 已入库 M 条」，不靠轮询。
  'jd/progress',
  // 投递单等人表态（spec 2.6-01）：确认卡片由它弹出，`outbound.deliver.pending()` 保证错过也补得回。
  'outbound/approval-requested',
  // 风控信号（spec 2.7-01）：暂停由 `workflow.runner` 在主进程做，界面只负责把「卡在哪、为什么」说出来。
  'browser/risk-signal',
] as const;

export type RendererEventName = (typeof RENDERER_EVENTS)[number];

/** 每个事件的载荷形状，preload 的 `on` 据此收窄类型。 */
export interface RendererEventSignatures {
  'log/line': LogLineView;
  'session/expired': SessionExpiredEvent;
  'shell/view-error': KernelViewLoadError;
  'workflow/progress': WorkflowProgressEvent;
  'chat/delta': ChatDeltaEvent;
  'locator/relocated': LocatorRelocatedEvent;
  'jd/progress': JdProgressEvent;
  'outbound/approval-requested': DeliverApprovalView;
  'browser/risk-signal': RiskSignalEvent;
}

/** 与 `BridgeSignaturesCovered` 同样的保险丝：新增事件名必须补载荷类型。 */
export type RendererEventSignaturesCovered = { [K in RendererEventName]: RendererEventSignatures[K] };

export const isAllowedEvent = (name: string): name is RendererEventName =>
  (RENDERER_EVENTS as readonly string[]).includes(name);

/* ------------------------------------------------------------------ *
 * 2.2 locator 层与平台登记面的数据形状
 * ------------------------------------------------------------------ */

/**
 * 候选策略。顺序不代表优先级——**优先级由 spec 里的声明顺序决定**（spec 2.2-01），
 * 这里只决定「这类候选满分上限是多少」，即稳定性来源的权重。
 */
export type LocateStrategy = 'testId' | 'id' | 'name' | 'role' | 'text' | 'css' | 'xpath' | 'fingerprint';

/** 一条候选：策略 + 该策略所需的那几个字段（多余的字段被忽略，不报错，方便知识包共用一个形状）。 */
export interface LocateCandidate {
  strategy: LocateStrategy;
  /** testId / id / name / css / xpath 的取值 */
  value?: string;
  /** testId 用的属性名（如 `data-testid`），必须是合法 HTML 属性名，否则整条候选被判非法 */
  attribute?: string;
  /** role 策略：期望的 ARIA 角色（button / link / textbox …） */
  role?: string;
  /** role 策略：期望的可读名（accessible name） */
  name?: string;
  /** text 策略：是否要求全等（默认 false，即归一化后的包含匹配） */
  exact?: boolean;
}

/** 一个「要定位的东西」的完整声明，语义描述用于日志与界面，不参与匹配。 */
export interface LocateSpec {
  description: string;
  cardinality: 'single' | 'many';
  candidates: LocateCandidate[];
  /**
   * 是否要求元素**可被指点**（可见、启用、中心点不被遮挡），默认 true。
   *
   * 设 false 的场景只有一种：注入类动作（`browser.act.upload`）。站点普遍把
   * `<input type=file>` 藏成 `display:none`，那三条前置判据对注入毫无意义——
   * 不关掉就会永远判 `below-score`，而关掉之后仍然要靠声明的策略权重过线，
   * 所以这条不是「放松定位」，是「按用途取用对应的判据」（见 plan §13.3 第 4 条）。
   */
  requireActionable?: boolean;
}

/** 元素在所属帧视口里的位置（CSS 像素，与 CDP 输入同一坐标系）。 */
export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 元素指纹（spec 2.2-05 的自愈依据）。
 *
 * 只收**稳定**的东西：`attributes` 是白名单内的键值，class 永不入选（改版最常改的就是 class），
 * 值像机器生成的也会被丢掉。`nearbyTexts` 是周围文本锚点，用来在结构变化后仍能认出现场。
 */
export interface ElementFingerprint {
  tagName: string;
  role: string;
  accessibleName: string;
  text: string;
  attributes: Record<string, string>;
  ancestorRoles: string[];
  nearbyTexts: string[];
  rect: ElementRect;
}

/** 页面回读的一条候选命中（尚未打分）。 */
export interface LocatedReading extends ElementFingerprint {
  /** 命中元素所在帧的地址 */
  frameUrl: string;
  /** 该元素在 spec 里对应的候选下标（声明顺序） */
  candidateIndex: number;
  strategy: LocateStrategy;
  /** 同一条候选在本帧内命中的元素个数——大于 1 就是歧义，要扣分（spec 2.2-02） */
  siblingCount: number;
  /**
   * 帧内的元素身份号（由注入脚本用 WeakMap 现场编号）。
   * 两条候选命中**同一个元素**时靠它去重，否则「testId 和 css 都中了同一个按钮」会被误判成歧义。
   *
   * 它是**某个 JS world 内部的编号**，跨 world 不通用：隔离世界（CDP 取节点引用用的那一个）里
   * 的注册表是另一张表，所以 CDP 那条路改用 `hitIndex` 寻址，不用这个字段。
   */
  nodeIndex: number;
  /**
   * 该元素在「这条候选在本帧里命中的元素列表」里的下标，从 0 起。
   *
   * 与 `nodeIndex` 的区别是它只依赖文档顺序，因此在主帧世界与隔离世界里算出的是同一个数——
   * `browser.act.upload` 要靠它把「定位胜出的那一个」交给 CDP（spec 2.6-04 / plan §13.3 第 4 条）。
   */
  hitIndex: number;
  /** 是否可见 / 可点：动作前置判据，与 `siblingCount` 一起决定分数 */
  visible: boolean;
  enabled: boolean;
  unobstructed: boolean;
}

/** 打分后的候选，`reasons` 让「为什么它赢」可解释（spec 2.2-02）。 */
export interface LocatedView extends LocatedReading {
  score: number;
  reasons: string[];
}

/** 一次定位的结局。`ambiguous` 与 `below-score` 都是**拒绝猜测**，不是失败重试的理由。 */
export type LocateStatus = 'matched' | 'ambiguous' | 'below-score' | 'not-found';

/** `browser.locate.find` 的返回值。 */
export interface LocateResultView {
  status: LocateStatus;
  spec: LocateSpec;
  /** 胜出候选；非 `matched` 时为 null */
  chosen: LocatedView | null;
  /** 排序稳定的 top-N（N 由服务配置 `candidateLimit` 决定） */
  ranked: LocatedView[];
  /** 人类可读的判定理由（`below minScore 70` 这类，界面直接显示） */
  reason: string;
  /** 是否由指纹自愈命中（spec 2.2-05） */
  relocated: boolean;
  /**
   * 最后一次页面读数的引用（`<帧地址>@<时间戳>`）。
   * 失败时同一份响应里带着 `snapshot`，这个串是给 2.4 留证据用的指针，不是可解引用的水地址。
   */
  snapshotRef: string;
  /** 失败时随行的最后一次 DOM 快照；成功时为 null（spec 2.2-04） */
  snapshot: KernelPageSnapshotView | null;
  at: number;
}

/** 等待谓词（spec 2.2-03 的五类）。 */
export type WaitPredicate =
  | { kind: 'appear'; spec: LocateSpec }
  | { kind: 'disappear'; spec: LocateSpec }
  | { kind: 'visible'; spec: LocateSpec }
  | { kind: 'clickable'; spec: LocateSpec }
  | { kind: 'textChanges'; spec: LocateSpec };

/** 一次页面动作的结局，`channel` 与 `trusted` 如实说明事件是怎么产生的（spec 2.2-12）。 */
export interface ActResultView {
  action: 'click' | 'type' | 'select' | 'wait' | 'upload';
  status: 'done' | 'timeout';
  waitedMs: number;
  channel: 'cdp' | 'dom';
  trusted: boolean;
  located: LocatedView | null;
  /**
   * 输入/选择/注入之后页面回读到的值；点击与等待为 null。
   * `upload` 时是**那个 input 自己报上来的** `files[0].name`，不是请求路径的文件名（spec 2.6-04）。
   */
  valueAfter: string | null;
  /** 等待类动作的结局读数；其他动作为 null */
  predicate: { kind: WaitPredicate['kind']; satisfied: boolean } | null;
}

/** 平台元信息（适配器自我声明，不含选择器）。 */
export interface PlatformMetaView {
  id: string;
  displayName: string;
  startUrl: string;
  /** 该适配器声明支持的能力名（`search` / `detail` / `chat` / `sendResume` / `readReplies`） */
  capabilities: string[];
}

/** `platform.registry` 的只读清单。 */
export interface PlatformRegistryView {
  platforms: PlatformMetaView[];
}

/* ------------------------------------------------------------------ *
 * 2.3 页面批量抽取与 JD 库的数据形状
 * ------------------------------------------------------------------ */

/**
 * 抽取请求里的一个字段：定位候选 + 可选属性名。
 *
 * 抽取**不打分也不自愈**（plan §10.3 规则 2）：按声明顺序取第一条能匹配的候选，
 * 命不中就把 `matched:false` 如实报出来。字段读错一条只是少一条数据，
 * 把整轮抓取卡住才是更糟的失败——所以这里没有 fail-closed。
 */
export interface ExtractFieldSpec {
  /** 字段名（由站点知识包定义，适配器按名取用） */
  name: string;
  /** 该字段的定位候选，声明顺序即优先级；`scope:'self'` 时不参与查找，只保留声明形状 */
  candidates: LocateCandidate[];
  /**
   * 取值范围（默认 `subtree`）：`subtree` 在容器子树里找，`self` 直接读容器自身。
   *
   * `self` 是给「一条消息的 id / 方向 / 正文都挂在那个节点上」的页面用的（spec 2.5-07）——
   * 容器本身永远不会出现在子树查找的结果里，没有这条路就只能再造一套读页面的实现。
   */
  scope?: 'subtree' | 'self';
  /** 要读的属性名（如 `href`）；省略则读元素正文 */
  attribute?: string;
  /** 必填声明：抽取阶段只原样带回，完整率判定归调用方（spec 2.3-01） */
  required?: boolean;
}

/** 一次批量抽取的请求：一个容器声明 + 若干字段声明。 */
export interface ExtractRequest {
  container: LocateSpec;
  fields: ExtractFieldSpec[];
}

/** 一个字段在一个容器里的读数。 */
export interface ExtractFieldReading {
  name: string;
  /** 该字段的候选是否有任一命中容器子树 */
  matched: boolean;
  /** 归一并钳制后的正文文本；未命中为空串 */
  text: string;
  /** 请求了属性时回读的属性值；未请求或未命中为 null */
  attribute: string | null;
}

/** 一个容器抽出来的一行（`frameUrl` 用来把相对 href 解析成绝对地址）。 */
export interface ExtractRowReading {
  containerIndex: number;
  frameUrl: string;
  fields: ExtractFieldReading[];
}

/** 一次抽取的结局。 */
export interface ExtractResultView {
  rows: ExtractRowReading[];
  /** 本帧里容器候选实际匹配到的元素总数（可能大于 `rows.length`，被上限截断） */
  containers: number;
  /** 是否因 `extractRowLimit` 截断过容器数量 */
  truncated: boolean;
  /** 逐帧读数摘要，解释「哪一帧没读到」 */
  frames: { url: string; ok: boolean; error: string | null }[];
}

/** 一次页面滚动的回读（无限滚动站点的加载扳机）。 */
export interface PageScrollReading {
  scrollY: number;
  scrollHeight: number;
  atBottom: boolean;
}

/** 归一化后的薪资（spec 2.3-03）。原文始终另存一列，归一化不做「猜不出来就编」的事。 */
export interface SalaryView {
  min: number | null;
  max: number | null;
  unit: 'k' | 'wan' | 'yuan' | 'unknown';
  period: 'month' | 'year' | 'unknown';
  /** 「·15薪」的年薪月数；没有该后缀为 null */
  salaryMonths: number | null;
  /** 面议 / 读不懂时为 true，此时上面几个字段都是中性值 */
  isNegotiable: boolean;
}

/** JD 库的一行（spec 2.3-02 的字段集 + 抓取时间与来源）。 */
export interface JobRowView {
  id: number;
  platform: string;
  jobId: string;
  title: string;
  company: string;
  salaryText: string;
  salary: SalaryView | null;
  city: string;
  experience: string;
  education: string;
  description: string;
  requirements: string[];
  postedText: string;
  /** 发布时间折算的时间戳（毫秒）；原文认不出来时为 null（spec 2.3-03：归一化不猜） */
  postedAt: number | null;
  /** 详情页地址，幂等键的一半（spec 2.3-04：来源 URL + 标题） */
  sourceUrl: string;
  /** 列表页读到摘要的时间戳（毫秒） */
  capturedAt: number;
  /** 详情读成功的时间戳；只抓到摘要时为 null */
  detailCapturedAt: number | null;
  /** 对方回过话没有——由 `conversation_messages` 里方向为招聘者的行数算出，`jobs` 表没有这一列（spec 2.5-14） */
  replied: boolean;
  /** 对方发来的消息条数；一行会话都没入库时为 0（不是「未知」，未知在 2.5-f 里就是查询失败） */
  inboundCount: number;
}

/**
 * `jd.store.list` 的返回值。
 *
 * 行序是「已回复优先，其余按抓取时间倒序」（spec 2.5-08 的『后续步骤优先这些目标』落在这里，
 * 不在界面里再排一遍）。
 */
export interface JobListResultView {
  total: number;
  rows: JobRowView[];
}

/** `jd.store.status` 的读数：库内概况 + schema 版本（2.3-05 的实测依据）。 */
export interface JdStoreStatusView {
  total: number;
  withDetail: number;
  schemaVersion: number;
  newestSourceUrl: string | null;
}

/* ------------------------------------------------------------------ *
 * 2.5 会话消息落库的数据形状
 * ------------------------------------------------------------------ */

/**
 * 会话里的一行消息（spec 2.5-07）。
 *
 * `text` 是**正文本身**，不含页面上的方向标记：标记从哪个节点读由站点知识包声明
 * （`chat.messageBody`），所以这里既不需要、也不应该在代码里写死一句「去掉『对方：』」。
 * 谁说的另有 `from` 字段。
 */
export interface ConversationRowView {
  id: number;
  platform: string;
  jobId: string;
  /** 这条是谁说的：招聘者 / 求职者自己 */
  from: 'recruiter' | 'self';
  text: string;
  /** 页面自带的稳定标识；页面上没有则 null，此时这一行的去重键退到「方向 + 正文摘要」 */
  externalId: string | null;
  /** 读到这行的时间戳（毫秒），不是页面给的发送时间 */
  at: number;
}

/** `conversation.store.list` 的返回值。 */
export interface ConversationListResultView {
  total: number;
  rows: ConversationRowView[];
}

/** 一次「读页面 → 落库」的结局（spec 2.5-07 的判据就落在这三个数上）。 */
export interface ConversationSyncView {
  platform: string;
  jobId: string;
  /** 页面上读到多少行消息 */
  read: number;
  /** 本次新增多少行 */
  inserted: number;
  /** 本次因为「已经见过」而跳过的行数——第二遍轮询必须全是这个，否则去重没生效 */
  duplicate: number;
  at: number;
}

/** 会话库概况。 */
export interface ConversationStatusView {
  total: number;
  recruiterMessages: number;
  jobs: number;
  schemaVersion: number;
  /** 最近一次读到消息的那个目标；空库为 null */
  newestJobId: string | null;
}

/** 一条被跳过的抓取（spec 2.3-08：单条失败不中断整轮）。 */
export interface CaptureFailureView {
  title: string;
  sourceUrl: string;
  reason: string;
}

/** 一次抓取运行的结局。 */
export interface CaptureRunView {
  platform: string;
  keyword: string;
  city: string | null;
  rounds: number;
  /** 列表里读到过的容器数 */
  containers: number;
  /** 本轮新入库 + 更新的行数 */
  stored: number;
  skipped: CaptureFailureView[];
  /** 停止原因（spec 2.3-06 的「停止条件明确」） */
  stoppedBy: 'target-count' | 'no-new-content' | 'max-rounds';
  /** 运行结束后的库内总行数 */
  total: number;
  finishedAt: number;
  /** 本轮前后的账本行数（spec 2.3-11：两值必须相等；它证明的是「抓取没记别的动作」，不是「抓取不入账」，见 2.7-03） */
  ledgerRowsBefore: number;
  ledgerRowsAfter: number;
}

/** `jd.capture.status` 的读数：当期配置 + 最近一次运行（间隔不在此列，节奏归 `outbound.throttle`，spec 2.7-04）。 */
export interface CaptureStatusView {
  /**
   * 本服务抓取的那个平台标识（`jd-capture` 配置的 `platform`）。
   * 界面拦截点要问「抓取的这次动作属于哪个平台」（spec 2.7-06 ①），
   * 只能由持有配置的一方交出来——让界面自己猜平台名就是第二套判定。
   */
  platform: string;
  targetCount: number;
  maxRounds: number;
  lastRun: CaptureRunView | null;
}

/** 搜索条件的界面视图（spec 2.3-01 的三个维度）。 */
export interface JobSearchCriteriaView {
  keyword: string;
  city?: string;
  experience?: string;
  limit?: number;
}

/** `jd/progress` 事件载荷定义在 `@auto-cc/core`（同 `locator/relocated`：cordis 的事件声明在下面那层）。 */

/** 定位层读数：当期阈值配置 + 最近几次判定摘要（界面解释「为什么这条不确定」用）。 */
export interface LocateStatusView {
  minScore: number;
  minMargin: number;
  candidateLimit: number;
  recentFailures: { description: string; status: LocateStatus; reason: string; at: number }[];
}

/** `locator/relocated` 事件载荷定义在 `@auto-cc/core`（见上面的转出说明）。 */

/** 一次事件推送的线格式。 */
export type RendererEvent = {
  [K in RendererEventName]: { event: K; payload: RendererEventSignatures[K] };
}[RendererEventName];

/** `window.autoCC` 的形状：preload 依白名单生成，渲染层只认这一个出口。 */
export type RendererBridge = BridgeNamespaces & {
  /** 订阅主进程推送的事件（spec 1.4-03）；返回退订函数。 */
  on: <N extends RendererEventName>(event: N, handler: (payload: RendererEventSignatures[N]) => void) => () => void;
};
