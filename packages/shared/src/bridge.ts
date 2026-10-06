/**
 * 渲染层与主进程之间的桥接契约（唯一真相源）。
 *
 * preload 依据 `RENDERER_ALLOWLIST` 生成代理对象，IPC 网关依据同一份名单校验入站调用，
 * 因此「渲染层能调什么」与「主进程允许什么」永远是同一个常量，不会漂移。
 */
import type {
  AgentPauseAnswer,
  AgentPauseResolvedEvent,
  AgentPauseView,
  AgentRunView,
  AppErrorPayload,
  AutonomyLevel,
  ChatDeltaEvent,
  ChatMessageView,
  ChatSessionView,
  ChatSnapshotView,
  DeliverApprovalView,
  DeliverAttachmentView,
  EvidenceRefView,
  ExemptToolView,
  JdProgressEvent,
  KbEntitiesChangedEvent,
  KernelViewLoadError,
  LocatorRelocatedEvent,
  LogLineView,
  PluginErrorView,
  RiskSignalEvent,
  SavedWorkflowPlanView,
  SelectedWorkflowPlanView,
  SedimentPreviewView,
  SessionExpiredEvent,
  WorkflowGraphLoadView,
  WorkflowGraphSaveInput,
  WorkflowGraphSaveView,
  TakeoverBeginInput,
  TakeoverEndInput,
  TakeoverStateView,
  ToolCallReply,
  ToolDescriptorView,
  WorkflowEvidenceView,
  WorkflowNodeSpec,
  WorkflowPlanOptionView,
  WorkflowPlansChangedEvent,
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
  AgentPauseAnswer,
  AgentPauseKind,
  AgentPauseResolvedEvent,
  AgentPauseView,
  AgentPlanStepView,
  AgentRunStatus,
  AgentRunView,
  AgentStepStatus,
  AgentStepView,
  AppErrorPayload,
  AutonomyLevel,
  ChatCompactionView,
  ChatDeltaEvent,
  ChatFactCard,
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
  EvidenceRefView,
  ExemptToolView,
  JdProgressEvent,
  KernelViewLoadError,
  LocatorRelocatedEvent,
  LogLineView,
  PlanParamReadoutView,
  PluginErrorView,
  RiskSignalEvent,
  SavedWorkflowPlanView,
  SelectedWorkflowPlanView,
  SedimentPreviewView,
  SedimentStepView,
  SessionExpiredEvent,
  TakeoverBeginInput,
  TakeoverEndInput,
  TakeoverStateView,
  ToolCallReply,
  ToolDescriptorView,
  ToolEffect,
  WorkflowEvidenceView,
  WorkflowGraphLoadView,
  WorkflowNodeRunView,
  WorkflowNodeSpec,
  WorkflowPlanOptionView,
  WorkflowPlansChangedEvent,
  WorkflowProgressEvent,
  WorkflowRunStateView,
  WorkflowRunStatus,
  WorkflowRunView,
  WorkflowStepId,
  WorkflowStepStatus,
  WorkflowStepView,
  WorkflowTakeoverView,
} from '@auto-cc/core';

/**
 * 算子描述表（spec 5.10-03）在渲染层的唯一入口。
 *
 * 为什么在这里再导出而不是让渲染层 import `@auto-cc/core`：渲染层只允许看见 `@auto-cc/shared`
 * （AGENTS.md §5.8 的边界），而调色板/节点格子/参数表单三处都要读同一张表——把表搬进 IPC 反而
 * 让「界面能摆出的算子」与「主进程登记的执行器」变成两份要同步的事实，所以表本身走编译期共享。
 *
 * **必须走 `@auto-cc/core/operators` 这个子路径出口，不许从 core 的 barrel 取值**（实测）：
 * 上面的类型复导出是 `export type`，编译后整条擦掉，渲染层的运行期模块图里没有 core；一旦按值 import
 * barrel，Vite 就会把 `core/src/paths.ts` 的 `node:path` 拖进浏览器包，渲染层在挂载前抛
 * `Module "node:path" has been externalized`（`#root` 留空、整个 app 起不来）。子路径出口只带
 * `operators.ts` + `zod`（纯浏览器可用），这条边界由 e 片之后的活体截图继续守着。
 */
export {
  OPERATOR_CATEGORIES,
  WORKFLOW_OPERATORS,
  groupOperatorsByCategory,
  groupOperatorsByEffect,
  operatorByKind,
  operatorParamDefaults,
  operatorParamFields,
  validateOperatorParams,
} from '@auto-cc/core/operators';

/**
 * 保存前图校验与编辑命令栈（spec 5.10-05 / 5.10-14 / 5.10-19）在渲染层的唯一入口。
 * 放 core 而渲染层经窄子路径取值的理由见 `core/src/graph-check.ts` 头注与 plan 裁定九：
 * 界面要边画边给反馈，保存口（L3）落库前要按同一套规则再拦一遍，两份规则迟早漂（§2.2）。
 */
export { WORKFLOW_GRAPH_CHECK_CODES, checkWorkflowGraph, isWorkflowGraphValid } from '@auto-cc/core/graph-check';
export type { WorkflowGraphCheckCode, WorkflowGraphIssue } from '@auto-cc/core/graph-check';

/** 画布命令栈：加节点/连线/改参数三类编辑的撤销重做，位置不进栈（5.10-06 的口径）。 */
export { createWorkflowGraphEditor, workflowEdgeIdOf } from '@auto-cc/core/graph-edit';
export type { WorkflowGraphDraft, WorkflowGraphEditor } from '@auto-cc/core/graph-edit';
export type {
  OperatorCategory,
  OperatorDescriptor,
  OperatorParamField,
  OperatorParamType,
} from '@auto-cc/core/operators';

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
  // 5.5-a 的人工接管态（spec 5.5-01 / 02）：`held` 只读当下，`begin` / `end` 是界面上那两只按钮
  //（UI 那一路是 5.5-b，这里只先把口立起来；`audit` 不进白名单——审计流水是给主进程看的，
  // 界面上那张接管历史属于 5.5-d，届时要连着红线条款一起过）。
  // 与 `agent.loop.confirm`、`agent.policy.setExempt` 同一口径：刻意**不登记为 agent 工具**——
  // 模型若能自己接管或自己交还页面，5.5-02 那道「接管期间一步都不发」就成了它可以自己开关的东西。
  'browser.takeover.held',
  'browser.takeover.begin',
  'browser.takeover.end',
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
  // 5.4-a 的计划管理面（spec 5.4-03 的挑中它跑 + 5.4-08 的列表三操作）：列表 / 改名 / 复制 / 删。
  // 四条都**只由人按**，刻意不登记为 agent 工具：沉淀出来的计划是「以后每次都这么跑」的授权，
  // 模型若能自己改计划，等于给自己铺了一条不必每次问人的路（与 `agent.loop.confirm` 同一口径，§8.4）。
  // 这里**没有** `savePlan`：写入口只有一条 `agent.sediment.save`（投影 + 校验都在服务侧），
  // 界面上再开一条直存路径就是 §2.5 禁止的「两个都能用」，而 5.4 的界面根本没有节点编辑器。
  'workflow.runner.plans',
  'workflow.runner.renamePlan',
  'workflow.runner.duplicatePlan',
  'workflow.runner.removePlan',
  // 5.10-j / plan 裁定七：把「当前计划」换成下拉里挑中的那条。它与上面四条同口径——**只由人按**、
  // 不登记为 agent 工具（换掉当前计划等于换掉后续所有动作的走向，模型若能自己换，就能给自己铺一条
  // 把旧 run 续到别的计划上的路），且它**不起 run、不写 `workflow_runs`**：续跑要的正是"先认计划、
  // 再按库里那条 run 的进度续"，一次点击里长出两条 run 就成了另一件事。
  // 落点写法是 `workflow.runner.selectPlan` 而不是裁定原文那句 `workflow.plan.select`：网关按
  // **最长前缀**拆 `service.method`（`packages/ipc/src/resolve.ts`），后者会被切成一只不存在的
  // 服务 `workflow.plan`，而带点的方法名 `pickMethod` 直接不收。
  'workflow.runner.selectPlan',
  // 5.10-e 的画布读写口（spec 5.10-10 / 5.10-17）：与上面四条同一口径，**只由人按**、刻意不登记为 agent 工具——
  // 画布上按一次保存改的就是「以后每次都这么跑」的那份计划，模型若能自己改图，等于给自己铺了免问的路（§8.4）。
  // 这里没有 `deleteGraph`：图列属于计划那一行，删计划（上面那条）就把图一起带走，不留「有图无计划」。
  'workflow.graph.load',
  'workflow.graph.save',
  // 1.11 的对话骨架：工具面（P1 为空表）与会话 / 消息 / 档位。
  'agent.tools.list',
  'agent.tools.call',
  // 5.2-c 的循环入口面（spec 5.2-03 / 04 / 10）：起草可见计划、人确认后才动、中途叫停、随时读整份进度。
  // `confirm` 与 `resume.generate.accept` 同一口径：**只由人按**，刻意不登记为 agent 工具——
  // 让模型自己确认自己的计划，等于把「人逐项过目」那道闸取消掉（AGENTS.md §8.4）。
  'agent.loop.propose',
  'agent.loop.confirm',
  'agent.loop.stop',
  'agent.loop.read',
  // 5.6-b 的挂载回看（spec 5.6-01）：界面重新挂载（含重启）时按**当前会话**取最近一次 run 的读数，
  // 计划卡与逐步卡片流因此能从 SQLite 画回来，而不是只活在 `agent/run-progress` 那一推里。
  // 与 `agent.loop.read` 同为只读口，不改变任何状态，也不在人表态的那几只手里。
  'agent.loop.latestRun',
  // 5.5-a 的恢复口（spec 5.5-01）：把人做完的那一段交还之后，从被按住的那一步接着跑。
  // 与 `agent.loop.confirm` 同族、同一口径——**只由人按**，刻意不登记为 agent 工具（机检 ⑧）。
  // 接管那一段的历史（谁、何时、因为什么）不在这里开新口：它在号段 21 的 `takeover_events` 里，
  // 界面上那张回看属于 5.5-d，届时再连着红线条款一起过白名单。
  'agent.loop.resume',
  // 5.4-a 的对话 → 工作流沉淀（spec 5.4-01 / 02）：`preview` 只读、`save` 是人在预览卡上按的那一格。
  // 与 `agent.loop.confirm` 同一口径，刻意不登记为 agent 工具：沉淀改变的是「以后每次都怎么跑」，
  // 让模型自己把一次对话固化成工作流，就是 5.3-04 防的「agent 给自己放宽」换了个更省事的写法。
  'agent.sediment.preview',
  'agent.sediment.save',
  // 5.7-02 的按引用回看（plan §7.5.7 决策十一）：整条链只有这一只口认识引用前缀。
  // 刻意**不登记为 agent 工具**，也不按每种前缀各开一只：界面若自己分派「哪条引用归谁管」，
  // 就等于把主进程的路由表抄第二份（§2.5）；而它是只读口，既不是外发也不是表态，闸门与审计都不涉及。
  'agent.run.evidence',
  // 5.3-b 的免确认白名单（spec 5.3-06 / 07）：`auto` 档下「哪些动作不再每次问我」是**用户**的显式设置，
  // 所以这三条口只出现在界面上，和 `agent.loop.confirm`、`chat.session.setAutonomy` 同一口径——
  // 刻意不登记为 agent 工具：模型若能自己加白，5.3-04 防的「agent 自己给自己放宽」就换了个名字重演。
  // 静态那半边由 `scripts/check-agent-model-authority.ts` 的 ⑥ 钉住（全仓只有这三份文件能提这两个方法名）。
  'agent.policy.exemptList',
  'agent.policy.setExempt',
  'agent.policy.clearExempt',
  // 5.3-c 的暂停单（spec 5.3-08 / 09）：`pending()` 负责「错过了也还在」，`respond()` 是**人**按的那一格。
  // 与 `agent.loop.confirm`、`agent.policy.setExempt` 同一口径：刻意不登记为 agent 工具——
  // 模型若能自己应答自己的确认单，5.3-04 防的「agent 自己给自己放行」就换了个名字重演。
  // 静态那半边由 `scripts/check-agent-model-authority.ts` 的 ⑦ 钉住。
  'agent.pause.pending',
  'agent.pause.respond',
  'chat.session.current',
  'chat.session.send',
  'chat.session.stop',
  'chat.session.setAutonomy',
  'chat.session.startSession',
  // 5.6-c 的会话三操作（spec 5.6-07）：改名、软删、恢复都是**人**对会话这件事的表态，
  // 与 `chat.session.setAutonomy`、`agent.pause.respond` 同一口径刻意不登记为 agent 工具——
  // 模型若能自己删会话，「它跑过什么」就可被它自己抹掉，那是 5.3-04 防的另一种形态。
  'chat.session.rename',
  'chat.session.remove',
  'chat.session.restore',
  // 软删过的会话要有份读数，那句「可恢复」才不是随重启消失的谎话（spec 5.6-07 的恢复途径）。
  'chat.session.trashed',
  // 3.3 生成轨导出面：预览/导出只认 docId + 模板 + 语言，文档正文不过进程边界（编辑轨 3.5 才引入 resume.doc.* 写入面）。
  // seedDemo 是 3.5 之前给端到端自测喂一份固定内容文档的口（spec 3.3-10）。
  'resume.export.seedDemo',
  'resume.export.preview',
  'resume.export.toPdf',
  // 3.6 排版编辑器的会话面（plan §8.3）：九行全是**人**在编辑器面板里的动作（打开、拖、推滑杆、换模板、
  // 撤销/重做、预览、另存），一律**不登记为 agent 工具**——它改的是"以后投出去的那份简历长什么样"，
  // 与 §3 第 1 条的事实锁定同一条线（口径照 5.10-e 那四条写口与 `pdf.*` 那两行）。
  // 过界的只有 docId、结构 id 与度量数：正文不过界（见上面 `resume.export.preview` 那行的注释），
  // 界面要看内容走 `.preview` 那份打印 HTML，与导出同一份源。
  'resume.editor.open',
  'resume.editor.view',
  'resume.editor.move',
  'resume.editor.metric',
  'resume.editor.use',
  'resume.editor.preview',
  'resume.editor.undo',
  'resume.editor.redo',
  'resume.editor.save',
  // 3.7 快照的只读面（spec 3.7-03）：列历史 + 比对两份快照。正文不过进程边界，
  // 界面拿到的是「哪个快照、模板与时刻」与「条目级 / 字段级差异」两种读数。
  'resume.snapshot.list',
  'resume.snapshot.diff',
  // 3.5 编辑轨的打开腿（spec 3.4-03 / plan §7.4）：入参是**绝对路径**（渲染层没有读文件的通道，
  // 与上面 4.1 的导入腿同一口径），回执只有页数与每页宽高——整页原文不过进程边界。
  // `pdf.*` 一律**不登记为 agent 工具**（plan §7.4 末行）：编辑的是用户手里的文件，判据里没有「让模型改 PDF」这一条。
  'pdf.io.open',
  // 3.5 编辑轨的另存腿（spec 3.5-02 / 3.5-09，plan §7.4）：源路径 + 覆盖区 + 产物路径 → 新文件。
  // 边界上过的只有**比例坐标**与回执三个字段——整页原文与 PDF 字节都不过界（同上面 `pdf.io.open` 的取向）。
  'pdf.export.saveAs',
  // 3.5 编辑轨的文本块线框腿（spec 3.5-01，plan §7.4 的 `pdf.layout`）：绝对路径 + 页号 → 这一页的矩形列表。
  // **回传里没有任何原文**——`textItemRect` 只把 `transform/width/height` 换成视觉比例矩形，
  // `str` 在主进程侧用完判空就丢掉（plan §7.15 记了这条相对 §7.4 原表的收窄）。
  'pdf.layout.textItems',
  // 4.1 简历导入面（spec 4.1-c）：渲染层没有读文件的通道（无 showOpenDialog / File），
  // 所以入参是**绝对路径**（同 `outbound.deliver` 的 `resumeFile` 口径）；回执只带区块计数与待确认清单，
  // 文档正文留在主进程侧的库里（spec 4.1-09 / 4.1-10 的边界）。
  'resume.parse.fromFile',
  'resume.parse.pending',
  // 4.2-d 的知识库管理面（spec 4.2-05 / 06）：读库、反查证据、手工实体的增删改、按简历工作副本重新同步，
  // 以及 4.2-08 的备份导出 / 导入。渲染层没有 SQL 通道，也没有读文件的通道——备份路径同样是绝对路径口径。
  // `remove` 对派生实体必然以 `KB_ENTITY_DERIVED` 失败（4.2-04），界面据 `sourceDocId` 分两套处置而不是挂个必失败的按钮。
  'kb.profile.list',
  // 4.3-c 的本地检索（spec 4.3-10）：只读，查询串原样交给主进程的预分词，命中理由与分数全在服务侧算完。
  'kb.profile.search',
  'kb.profile.evidenceFor',
  'kb.profile.create',
  'kb.profile.update',
  'kb.profile.remove',
  'kb.profile.sync',
  'kb.profile.exportBackup',
  'kb.profile.importBackup',
  // 4.4-d 的缺口报告双入口（spec 4.4-05）：报告是「JD × 库」的现算投影，只读本地库，
  // 三态、分数、五种模型腿结局全在主进程算完（同 `kb.profile.search` 的口径）。
  // 证据正文单独一条只读口：报告里每条证据只有 id，把正文并进报告就等于让一次比对把半本库
  // 推过进程边界——而界面上一次只会展开一条。
  'kb.gap.report',
  'kb.profile.evidenceBody',
  // 4.5-b 的定向生成双入口（spec 4.5-01 / 09 / 10）：与 `kb.gap.report` 同一口径，**只给读数与提议内容**，
  // P3.1 文档本体不过进程边界——`shared` 在 L1、不许依赖 L2 的 `resume-doc`，在 L1 再镜像一份文档模型
  // 就是造第二个真相源（§2.5），而界面要显示的"改了哪几处、为什么提前"全在下面那几行读数里。
  'resume.generate.run',
  // 4.5-c 的接受口（spec 4.5-11）：4.5 那条链上**唯一**会写工作副本的一口，入站只有 `receiptId` + 下标。
  // 它刻意**不**登记为 agent 工具——让模型自己接受自己生成的内容，等于把 4.5-11 的"人逐项过目"取消掉，
  // 而事实锁定的最后一道闸就是那道过目（§8.4）。界面侧调用点在 `GeneratePanel`。
  'resume.generate.accept',
  // 4.6-d 的话术候选面板（spec 4.6-07）：以前界面只能经 `outbound.greet.perform` **间接**触发话术生成
  // （生成入参藏在 greet 的 `script` 字段里），拿不到候选、也看不见「模板」标识与回落原因。
  // 这里开的是一条**只生成、不外发**的口：它不现问渠道、不过闸门、不产生任何离开 app 的字节，
  // 真正发出去仍然只有 `greet.perform` / `deliver.perform` 那两条（AGENTS.md §7.3 的红线没有被这条口绕过）。
  'outbound.script.generate',
  // 5.7-b 的定时任务面（spec 5.7-05 / 06 / 09）：两条只读（任务列表、触发史）+ 三条写（建、启停、删）
  // + 一条"现在跑一次"。`triggerNow` 与到点触发走的是同一条腿（同一个 `launch`），所以它同样先问额度、
  // 同样落一条触发记录——手工跑不等于额外出发（§7.3）。
  // 刻意**不登记** `tick` / `accountForMissedRuns`：那是调度器自己的心跳与追账。界面若能手动画一次"到点"
  // 或"补跑"，5.7-09 的"关闭期间不补跑"就变成渲染层可以发明的第二种结局，而这条判据要的恰恰是它不可选。
  // 计划下拉复用既有的 `workflow.runner.plans`（§2.1：不为调度再开一条读计划的口）。
  'schedule.registry.jobs',
  'schedule.registry.triggers',
  'schedule.registry.createJob',
  'schedule.registry.setEnabled',
  'schedule.registry.removeJob',
  'schedule.registry.triggerNow',
  // 5.8-b 的指标看板口（spec 5.8-01 / 03 / 04 / 07 / 08）：**唯一一条只读聚合**，五级漏斗与额度三量一次取齐。
  // 之所以要在白名单里立这一条而不是让界面去分别敲四张表的主人：那等于把主进程的归属表抄到渲染层第二份
  // （AGENTS.md §2.5 实测：热改配置会重建下游，抄的那份会静默变空），而且四只现成的计数口全不带时间范围。
  // 刻意**不登记为 agent 工具**：看板是给人核对用的读数，模型若能自己按"近 7 天转化率低"去凑数，
  // 就可能为了把数字做上去自己触发抓取（§8.3 的频控红线不该由一只读口引出来）。
  'funnel.query',
  // 更新通道（spec 5.9-03）：四条口全是**人按下去才有动作**的一问一答——`status` 只读内存里上一次读数、
  // `check` 只在被点时发一次元数据请求、`download` 与 `install` 只在上一态成立时才动手。
  // 刻意不登记为 agent 工具：模型若能自己触发检查/下载，"零首启动下载"就变成"模型想下就下"。
  // 三条自动开飞开关（autoDownload / autoInstallOnAppQuit / autoRunAppAfterInstall）在 service 侧
  // 关死并有测试兜住，见 `packages/shell/src/update.ts`。
  'update.status',
  'update.check',
  'update.download',
  'update.install',
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

/**
 * 额度的静态那一面（spec 5.8-03）：模式 + 按动作的日上限表。
 *
 * 上限必须由闸门给，不能让看板从「已用 + 剩余」推算：超限时 `remaining` 被夹在 0，
 * 那条加法在「用光之后」就不再等于上限，界面于是会把「40 用完」显示成「上限 20」。
 */
export type GateQuotaView = {
  /** `unlimited` 时界面该说「当前不设上限」，而不是把 `dailyLimits` 的数当真上限画出来。 */
  mode: 'unlimited' | 'daily';
  /** 每动作每天允许的条数（按本地自然日），与闸门判定读的是同一份配置。 */
  dailyLimits: { search: number; greet: number; deliver: number };
};

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

/**
 * 被闸门拦下的一次动作（spec 5.3-12）。
 *
 * 它与 `LedgerRowView` 是两张表：这一份**不是用量**（那一次动作什么都没消耗），
 * 只是"有人试过了、被谁以什么理由拦下"的审计读数。分成两张表是为了让日上限、
 * 重复发送防护、频控那三处计数结构上读不到被拒行（详见 `entitlement/src/ledger.ts` 的头注释）。
 */
export type LedgerDenialView = {
  id: number;
  action: string;
  targetId: string | null;
  workflowRunId: string | null;
  /** 毫秒时间戳，本地时区。 */
  ts: number;
  /** 拒因码（当前只有 `QUOTA_EXCEEDED`），给用例断言用，不给人读。 */
  code: string;
  /** 要显示给人看的原话（闸门 `check()` 那句 reason）。 */
  reason: string;
};

/** 用量回看的聚合读数（spec 1.9-07 / 5.3-12）：总数、按天分组、按动作分组，外加最近几行与被拒几行。 */
export type UsageSummaryView = {
  total: number;
  /** 本地「今天」的条数，与闸门日额度用的是同一个日界。 */
  today: number;
  byDay: { day: string; count: number; actions: { action: string; count: number }[] }[];
  byAction: { action: string; count: number }[];
  recent: LedgerRowView[];
  /** 最近被闸门拦下的几行（spec 5.3-12），按时间倒序；不计进上面任何一项。 */
  recentDenials: LedgerDenialView[];
};

/** 漏斗的一级（spec 5.8-01）。名字是稳定的机器键，界面上的中文走语言包（§5.5）。 */
export const FUNNEL_LEVELS = ['search', 'greet', 'reply', 'deliver', 'interview'] as const;

/** 漏斗级别名（顺序即主计划 §5.8 的五级顺序）。 */
export type FunnelLevel = (typeof FUNNEL_LEVELS)[number];

/**
 * 漏斗里的一级读数（spec 5.8-01 / 5.8-08）。
 *
 * 最重要的一条是 `count` 为 null 时**必须**有 `unavailableReason`，二者必有其一：
 * 「没有这个数据源」（面试级，plan §7.6.2 决策十五）与「那个服务此刻没挂载」都绝不降级成 0，
 * 因为 0 在看板上读起来就是「一条都没发生」——那正是 5.8-07 反向验证要拦的假象。
 */
export type FunnelLevelView = {
  level: FunnelLevel;
  /** 区间内的条数；无数据源或归属服务未挂载时为 null */
  count: number | null;
  /** 为什么没有数字（主进程给的原话，与 `EvidenceRefView.unavailableReason` 同口径）；有数字时为 null */
  unavailableReason: string | null;
};

/** 看板的区间入参：毫秒时间戳，**含头不含尾**（`fromMs <= ts < toMs`），日界由发起方按本地时区算。 */
export type FunnelRange = { fromMs: number; toMs: number };

/** 额度消耗那一块（spec 5.8-03）：三条动作各一行「今日已用 / 上限 / 剩余」。 */
export type FunnelQuotaView = {
  /** 闸门未挂载时整个额度块为 null（界面上要说出"没挂载"，不画三个 0）。 */
  mode: 'unlimited' | 'daily' | null;
  actions: {
    action: QuotaAction;
    /** 本地今日已落账的条数；账本未挂载为 null */
    usedToday: number | null;
    /** 配置里的日上限（条/本地自然日）；闸门未挂载为 null，`unlimited` 模式下界面不按它判定 */
    dailyLimit: number | null;
    /** 闸门给的剩余（`unlimited` 模式恒为 null）；闸门未挂载为 null */
    remaining: number | null;
  }[];
};

/**
 * 一次漏斗 + 额度的聚合读数（spec 5.8-01 / 03 / 05）。
 *
 * `tookMs` 是主进程这次聚合的真实耗时（spec 5.8-05 的计时证据就取这一位，界面原样显示、不自测），
 * 单测与验收脚本因此能在同一份读数里同时核对数字与代价。
 */
export type FunnelView = {
  range: FunnelRange;
  levels: FunnelLevelView[];
  quota: FunnelQuotaView;
  tookMs: number;
};

/**
 * 更新通道的一次读数（spec 5.9-03）。
 *
 * 状态是**枚举**，界面按它取 i18n 文案；`detail` 只装上游原话（HTTP 错误、被拒原因），
 * 属于数据而不是文案，所以不翻译、原样显示——主进程不产中文界面文字（§5.5）。
 */
export type UpdateState =
  /** 还没点过「检查更新」 */
  | 'idle'
  /** 配置里没有更新源：一次请求都不发（默认不指向 GitHub 直连，见 plan §7.7.2.1 第 3 条） */
  | 'no-feed'
  /** dev 且未开 `forceDevUpdateConfig`：库自己就不发请求，不能拿它当验收证据 */
  | 'unavailable-in-dev'
  /** 已检查过，当前版本就是最新 */
  | 'up-to-date'
  /** 有新版本，等用户点「下载」 */
  | 'available'
  /** 用户已点下载，正在取安装包 */
  | 'downloading'
  /** 安装包已在本地，等用户点「重启并安装」 */
  | 'downloaded'
  /** 失败：只落一句原话，不阻塞使用 */
  | 'failed';

export type UpdateView = {
  state: UpdateState;
  /** 运行中的版本号，取 `app.getVersion()`，界面上与 `latestVersion` 并排显示 */
  currentVersion: string;
  /** 更新源报出的版本号；只在 available/downloading/downloaded 三态有值 */
  latestVersion: string | null;
  /** 上游原话或本服务给出的拒因（ASCII 或上游语言），无则为 null */
  detail: string | null;
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
 * 一条已生成候选的来源字段（spec 4.6-02 / 4.6-11）：`ScriptDraftRowView` 里除正文与内容来源之外的那几项。
 *
 * 单独列一个类型而不是直接复用 draft 视图，是因为消费方（`outbound.greet`）只需要这四样就能记账，
 * 把 `text` / `origin` / `fallbackReason` 一起收进来只会让人以为发送口会重新判一遍内容来源。
 */
export type ScriptProvenanceView = {
  /** 归属的 JD 标识，与 `GreetRequestView.jobId` 同源，账本按它回指 */
  jdId: string;
  /** 话术分型（spec 4.6-01）：记进账本才能分清"发出去的是开场白还是追问" */
  kind: ScriptKindView;
  /** 提示词与模板的版本号（注册表常量，spec 4.6-09） */
  scriptVersion: string;
  /** 这条候选引用的知识库证据 id（spec 4.6-02 的回指清单，可为空 = 未引用经历） */
  evidenceRefs: string[];
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
  /**
   * 话术生成入参的最小必需集：岗位名与公司名缺一即拒，不生成空话术。
   * `evidence` 每条必带 `refId`（spec 4.6-02：产物要能回指到库里哪一行），值取 `kb.profile.search` 的 `chunkId`。
   */
  script?: {
    jdId: string;
    title: string;
    company: string;
    keywords?: string[];
    evidence?: { fact: string; refId: string }[];
  };
  /**
   * 现成文案的**来源记账**（spec 4.6-02 / M4 的"留生成来源"在界面选定那一路的落点）。
   *
   * 只在带 `text` 时有意义：界面上"选中一条候选再发送"走的是现成文案那一路（服务不该再生成一遍），
   * 于是账本本来只剩 `manual:<jdId>`，那条候选引用的知识库经历就此丢掉。这里把它补回去。
   * **它不参与任何判据**——不改正文、不决定回落、不触发第二次生成，只进账本 `source` 列；
   * 也因此**没有动 `script` 的形状**（4.6-11 的接口定型判据要的就是 P2 那口的入参不被界面带着长）。
   */
  provenance?: ScriptProvenanceView;
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
  /**
   * 可追溯来源（spec 2.5-09 + 4.6-02）：`模板版本:话术类型:JD id[#证据 id 列表]`；
   * 用户手改/界面选定的现成文案写成 `manual:` 打头的同一条链，没带来源就只有 `manual:JD id`。
   */
  source: string;
  /** 内容来源：模型产出 / 模板回落 / 用户手改 */
  origin: 'model' | 'template' | 'manual';
};

/**
 * 一次话术生成的入参（镜像 `outbound.script` 的 `scriptRequestSchema`，spec 4.6-01 / 02）。
 *
 * 与上面 `GreetRequestView.script` 的区别只有一点：这里是**独立生成**那条口的入参，所以带上
 * `kind` 与 `recruiterMessage`（4.6-c 刻意把它们留给本片裁定）。打招呼那一路的镜像仍保持最小必需集，
 * 免得 P2 的入参形状被界面面板带着长（4.6-11 的接口定型判据看的是那一口）。
 */
export type ScriptGenerateRequestView = {
  /** 归属的 JD 标识：界面用库内行 id，产物与账本都按它回指 */
  jdId: string;
  /** 岗位名（缺失即被服务判 `INVALID_ARGUMENT`，不做空话术） */
  title: string;
  /** 公司名（同上） */
  company: string;
  /** 方向关键词：只进提示词与模板的「方向」短语，不参与任何判据 */
  keywords?: string[];
  /** 证据：每条必带 `refId`（取 `kb.profile.search` 命中的 `chunkId`），spec 4.6-02 */
  evidence?: { fact: string; refId: string }[];
  /** 话术分型，省略为 `greeting`（spec 4.6-01） */
  kind?: ScriptKindView;
  /** 对方最后一条消息原文：追问与拒绝应对缺它会被服务拒掉 */
  recruiterMessage?: string;
};

/** 话术分型的界面视图取值（镜像 `SCRIPT_KINDS`，文案按它在语言包里取）。 */
export type ScriptKindView = 'greeting' | 'follow-up' | 'rejection';

/**
 * 一条话术候选的读数（镜像 `ScriptDraftView`，spec 4.6-06 / 07 的界面数据源）。
 *
 * `origin` 与 `fallbackReason` 是这条口存在的理由：模板回落必须**看得见**，否则界面把一句套壳文案
 * 摆成"为你个性化生成的"（4.6-06）。`evidenceRefs` 为空数组是有意义的读数，不是缺字段。
 */
export type ScriptDraftRowView = {
  /** 已过黑名单与长度校验的正文 */
  text: string;
  origin: 'model' | 'template';
  /** `template` 时的原因，界面原样播报，不二次加工 */
  fallbackReason?: string;
  scriptVersion: string;
  jdId: string;
  kind: ScriptKindView;
  evidenceRefs: string[];
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

/** 一页的宽高读数（镜像 pdf-edit 的 `PdfPageMetric`，单位是 PDF 点，1 pt = 1/72 英寸）。 */
export interface PdfPageMetricView {
  /** 页序，从 1 起（界面显示是 1 基，主进程里的数组是 0 基，换算在这条边界上做完） */
  number: number;
  widthPt: number;
  heightPt: number;
}

/**
 * 打开一份 PDF 的回执（镜像 `pdf.io` 的 `PdfOpenReceipt`，spec 3.4-03 / 3.5-01 的打开半边）：
 * 只有来源哈希、页数与每页宽高——**整页原文不过进程边界**（plan §7.4 沿用 3.7-03 的取向）。
 */
export interface PdfOpenReceiptView {
  /** 源文件的 sha256，3.5-09「另存之后源文件仍是这一份」的基准 */
  sourceHash: string;
  pageCount: number;
  pages: PdfPageMetricView[];
}

/**
 * 覆盖区的矩形（镜像 `PdfOverlayRect`，spec 3.5-03）：**比例坐标** 0..1，原点左上、y 向下——
 * 与界面上拖出来的框同一个方向，所以渲染层不需要自己翻轴（翻轴在 `pdf-edit` 里做，判据也在那儿测）。
 */
export interface PdfOverlayRectView {
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
}

/**
 * 一条覆盖区（镜像 `PdfOverlayInput`，spec 3.5-02）：白底矩形 + 可选的叠加文字。
 * 文字过界前不校验，越界与非法都在主进程侧拒（`details.code`），因为字号、面积这些尺度是服务配置。
 */
export interface PdfOverlayInputView {
  /** 界面给的稳定标识：错误信息里用它指认是哪一区 */
  id: string;
  /** **源**页号，从 1 起（与 `PdfPageMetricView.number` 同一个口径；排过页之后同一源可以对应产物的多页） */
  pageNumber: number;
  rect: PdfOverlayRectView;
  /** 叠加文字：拉丁与中日韩都能画（中文经随包 `Noto Sans SC` 子集内嵌）；白名单外的码位以 `text-not-supported` 结构化失败 */
  text?: string;
  /** 字号（pt），省略取服务配置的 `defaultTextSizePt` */
  sizePt?: number;
}

/**
 * 另存回执（镜像 `pdf.export` 的 `PdfSaveAsReceipt`，spec 3.5-02 / 3.5-09）：产物路径、产物指纹与页数。
 * `sha256` 是**产物**的摘要，与 `PdfOpenReceiptView.sourceHash` 永远不同——源文件从头到尾没被写过。
 */
export interface PdfSaveAsReceiptView {
  outPath: string;
  sha256: string;
  pageCount: number;
}

/**
 * 一个文本块的线框（镜像 `pdf-edit` 的 `PdfTextBox`，spec 3.5-01）：`index` 是主进程侧那份文本项的次序编号
 * （界面用它编号并做「第几块」的读数，跨页不连续——它只是这一页内的位置标识）。
 * `rect` 与覆盖区共用 `PdfOverlayRectView`，所以线框框住的地方直接就能变成人框的区（plan §7.5 第 2 行）。
 */
export interface PdfTextBoxView {
  index: number;
  rect: PdfOverlayRectView;
}

/**
 * 一页文本块矩形（镜像 `pdf-edit` 的 `PdfTextItemsReading`）：**没有任何原文**，只有矩形与计数。
 * `pageCount` 回带是为了让界面在页号越界被拒之前先把「共几页」说对（同 `PdfOpenReceiptView` 的读数口径）。
 */
export interface PdfTextItemsView {
  pageNumber: number;
  pageCount: number;
  boxes: PdfTextBoxView[];
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

/**
 * 排版编辑器过进程边界的读数（spec 3.6，plan §8.3）。
 *
 * 与上面那组同样是主进程侧同名类型的**镜像**，而且这里刻意只镜像"界面要摆出来的东西"：
 * 3.3 立下的口径（见白名单里那段注释）——文档正文不过界，界面只认 docId——在编辑器里照样成立。
 * 于是界面拿到的是**结构**（区块 id / kind / 条目 id 序列）与**度量**（数），拿不到一句简历原文；
 * 它要看内容靠的是 `resume.editor.preview` 那份打印 HTML，与导出所见同一份源（spec 3.3-01 的口径续用）。
 */
/** 可调度量的键（镜像 `MetricKey`；`columns` 不在其中——它只有 1..2 两档，由模型 schema 管着，不给人一根两档滑杆）。 */
export type EditorMetricKeyView = 'baseFontPt' | 'lineHeight' | 'topMm' | 'rightMm' | 'bottomMm' | 'leftMm';

/** 一条度量的上下界（镜像 `MetricBound`；单位随键：pt / 倍数 / mm）。 */
export interface EditorMetricBoundView {
  readonly min: number;
  readonly max: number;
}

/** 版面度量（镜像 `Layout`）：**只有数**，简历的一个字都不在这里。 */
export interface ResumeEditorLayoutView {
  readonly pageSize: 'A4';
  readonly margin: {
    readonly topMm: number;
    readonly rightMm: number;
    readonly bottomMm: number;
    readonly leftMm: number;
  };
  readonly baseFontPt: number;
  readonly lineHeight: number;
  readonly columns: number;
}

/** 编辑器里的一个区块（标签由界面按 kind 取 i18n，同 3.2-06 的口径；`entryIds` 是条目级拖拽的把手数据）。 */
export interface ResumeEditorSectionView {
  readonly id: string;
  readonly kind: ResumeSectionKindView;
  readonly entryIds: string[];
}

/**
 * `resume.editor.*` 每一次动作后的统一读数（镜像 `ResumeEditorState`）。
 * `metricBounds` 与主进程判界用的是同一张表：滑杆的 min/max 从这里来，界面不许自己抄一份（§2.5）。
 */
export interface ResumeEditorView {
  readonly docId: string;
  readonly sections: ResumeEditorSectionView[];
  readonly layout: ResumeEditorLayoutView;
  readonly templateId: string;
  readonly locale: ResumeLocaleView;
  /** 可用模板 id（下拉的数据源；模板名是渲染期标签，不过界）。 */
  readonly templates: string[];
  readonly metricBounds: Readonly<Record<EditorMetricKeyView, EditorMetricBoundView>>;
  /** 3.6-08 的两只阈值：来自 `resume.editor` 自己的 `static Config`，界面不新开一套配置读取（§2）。 */
  readonly timing: { readonly maxPreviewResponseMs: number; readonly largeDocumentSectionCount: number };
  readonly isDirty: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

/** 每个白名单调用的入参元组与返回值，渲染层类型的来源。 */
/**
 * 知识库实体过进程边界的形状（4.2-05 的实体树数据源）。
 *
 * 这是 `@auto-cc/plugin-resume-kb` 里 `KbEntityView` 的**镜像**而不是 import：`shared` 在 L1，
 * 不允许依赖 L2 的能力包（AGENTS.md §4.1），同 `PendingImportRowView` 之于 `PendingImportView` 的做法。
 * `normalizedHash` 在界面上没有用处，但它是 4.2-06「改完确实落库」的可比读数，所以照样带过来。
 */
export interface KbEntityRowView {
  readonly entityId: string;
  readonly kind: KbEntityKindView;
  readonly parentId: string | null;
  /** 来源简历文档 id；`null` 表示用户手工建的实体（永远不会被同步清理，见 4.2-04） */
  readonly sourceDocId: string | null;
  readonly payload: Readonly<Record<string, string>>;
  readonly normalizedHash: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 实体种类（镜像 `KbEntityKind`；界面按它取 i18n 文案，英文串不直接上界面，对齐 §5.5）。 */
export type KbEntityKindView = 'experience' | 'project' | 'skill' | 'achievement';

/**
 * 一次证据反查的命中项（镜像 `EvidenceRef`，4.2-05 展开态的数据源）。
 * `reason` 是判定码（`contains` = 一侧完全覆盖另一侧，`overlap` = 部分词重合），文案由界面按码取。
 */
export interface KbEvidenceRowView {
  readonly entityId: string;
  readonly kind: KbEntityKindView;
  /** 0～1 的匹配强度，主进程已按 4 位小数取整 */
  readonly score: number;
  readonly reason: 'contains' | 'overlap';
  readonly matchedTokens: readonly string[];
}

/**
 * 一条检索命中（镜像 `KbSearchHit`，4.3-10 的结果行数据源）。
 *
 * `reasons` 与 `coverageReason` 是判定码不是文案：界面按码取 i18n（§5.5），
 * 而「BM25 腿 / 词面覆盖腿 / 子串通道」这套说法属于主进程的实现细节，不该在渲染层再拼一遍（§2.5）。
 */
export interface KbSearchRowHit {
  readonly chunkId: string;
  readonly chunkKind: 'entity' | 'section';
  readonly sourceDocId: string | null;
  readonly sectionKind: ResumeSectionKindView | null;
  /** 切片正文（原文不在倒排索引里，主进程按 seq join 回主表） */
  readonly text: string;
  /** 合并后的 0～1 分数，主进程已按 4 位小数取整 */
  readonly score: number;
  readonly bm25Score: number;
  readonly lexicalScore: number;
  /**
   * 向量腿的余弦读数（4 位小数）；本次没用向量腿、或这条没进向量名单时为 `null`。
   *
   * 与 `score` 分开放而不是合成一个数：词面分是 0～1 的证据强度，余弦是 0～1 的几何夹角，
   * 量纲不同源，界面要能分别说「词面有多强」和「语义有多近」（spec 4.3-07）。
   */
  readonly vectorScore: number | null;
  readonly coverageReason: 'contains' | 'overlap' | null;
  readonly reasons: readonly ('bm25' | 'lexical' | 'substring' | 'vector')[];
  readonly matchedTokens: readonly string[];
}

/** 一次本地检索的读数（镜像 `KbSearchResult`）。 */
export interface KbSearchRowResult {
  /** `no_query_tokens` = 这句话切不出可检索的 token（全是标点/空白），与「库里没有」是两件事 */
  readonly status: 'ok' | 'no_query_tokens';
  readonly hits: readonly KbSearchRowHit[];
  readonly queryTokens: readonly string[];
  /**
   * 本次检索的向量腿状态（镜像 `KbVectorStatus`，spec 4.3-08 的播报依据）。
   *
   * 降级必须看得见：`unavailable` / `no_vectors` / `failed` 三种情况下界面给出的都是「只有词面命中」，
   * 没有这一项用户读不出原因，只能靠猜（4.3-08 的判据半边就在这一列上）。
   */
  readonly vectorStatus: 'ok' | 'unavailable' | 'no_vectors' | 'failed' | 'not_attempted';
}

/**
 * 缺口报告过进程边界的形状（4.4-05 的缺口面板数据源）。
 *
 * 这一组全是 `@auto-cc/plugin-resume-kb` 里同名类型的**镜像**：`shared` 在 L1，不许依赖 L2 能力包
 * （AGENTS.md §4.1），与上面 `KbEntityRowView` 之于 `KbEntityView` 同一做法。
 * 镜像的取舍口径是"界面上要出现的东西才过来"：三态、建议 key、五种模型腿结局、证据 id 与分数都要，
 * 而 `RequirementItem.label` 这类词表内部字段虽然是判据的一部分，界面要用它做「要求是什么」的标题，所以照带。
 */

/** JD 要求的四类（镜像 `RequirementKind`；下划线形式与主进程一致，界面按它取 i18n 文案）。 */
export type GapRequirementKindView = 'hard_skill' | 'soft_skill' | 'education' | 'experience_years';

/** 三态之一（镜像 `GapState`）。列与列的归属就是它，不是要求种类（plan §4.4-d 判据二）。 */
export type GapStateView = 'matched' | 'partial' | 'missing';

/** 证据 id 的来源（镜像 `GapEvidenceOrigin`）：库内实体，还是学历区块的切片。 */
export type GapEvidenceOriginView = 'entity' | 'section_chunk';

/** 模型腿的五种结局（镜像 `GapModelStatus`，spec 4.4-02 的 V 半边：五态五句文案，不许合成一句"没用上模型"）。 */
export type GapModelStatusView = 'merged' | 'rejected' | 'failed' | 'unavailable' | 'disabled';

/** 补救建议的 i18n key（镜像 `GapSuggestionKey`）：文案本体在语言包，主进程只给 key 与参数（§5.5 / §5.7）。 */
export type GapSuggestionKeyView =
  'add_evidence' | 'strengthen_evidence' | 'years_gap' | 'education_gap' | 'education_missing';

/** 一条 JD 要求（镜像 `RequirementItem`）。`start` / `end` 是 JD 正文里的 UTF-16 下标，`end` 不含。 */
export interface GapRequirementRowItem {
  readonly kind: GapRequirementKindView;
  readonly label: string;
  /** JD 原文里实际出现的形式（界面上的原文高亮就打它） */
  readonly quote: string;
  readonly start: number;
  readonly end: number;
  /** 年限类要求的年数；其余三类为 `null`（0 是合法读数，不能拿来表示"没有"） */
  readonly years: number | null;
  /** 这条来自哪条腿：词面还是模型（4.4-02 的 V 类：界面上"模型补的"要能被看出来） */
  readonly via: 'lexicon' | 'model';
}

/** 一条证据引用（镜像 `GapEvidence`）：只有 id，正文由界面另问 `kb.profile.evidenceBody`。 */
export interface GapEvidenceRowItem {
  readonly id: string;
  readonly origin: GapEvidenceOriginView;
  /** 实体种类；区块切片给 `'education'`（学历区块不产实体行，它的据只能在区块级） */
  readonly kind: KbEntityKindView | 'education';
  readonly score: number;
  readonly matchedTokens: readonly string[];
}

/** 一条补救建议（镜像 `GapSuggestion`）：`params` 只放 id 与数字，不放库内正文。 */
export interface GapSuggestionRow {
  readonly key: GapSuggestionKeyView;
  readonly params: Readonly<Record<string, string | number>>;
}

/** 一条要求的比对结果（镜像 `GapRequirementView`）。 */
export interface GapRequirementRowView {
  readonly item: GapRequirementRowItem;
  readonly state: GapStateView;
  /** `missing` 时恒为空数组——"没有据"不靠塞弱据圆场 */
  readonly evidence: readonly GapEvidenceRowItem[];
  /** 最强那条的强度；完全无命中为 `null`（与"0 分"区分开） */
  readonly bestScore: number | null;
  /** 非 `matched` 时必不为 `null`（spec 4.4-06 的结构断言，界面因此可以无脑渲染建议行） */
  readonly suggestion: GapSuggestionRow | null;
}

/** 反向比对的一条亮点候选（镜像 `GapHighlightView`）。 */
export interface GapHighlightRowView {
  readonly entityId: string;
  readonly kind: KbEntityKindView;
  /** 与 **JD 全文** 的覆盖率，衡量"相关"而不是"具备" */
  readonly score: number;
  readonly relatedTokens: readonly string[];
}

/** 一次缺口报告的完整读数（镜像 `GapReportView` = 拆解视图 + 比对投影）。 */
export interface GapReportRowView {
  readonly items: readonly GapRequirementRowItem[];
  readonly inputChars: number;
  readonly droppedByLimit: number;
  readonly lexiconVersion: string;
  readonly modelStatus: GapModelStatusView;
  /** 非 `merged` 时是"为什么没用上模型"的一句原因（主进程写的句子，界面按 `modelStatus` 取文案、把它作参数插进去） */
  readonly modelReason: string | null;
  readonly model: string | null;
  readonly modelAdded: number;
  readonly modelDropped: number;
  readonly promptVersion: string | null;
  readonly rows: readonly GapRequirementRowView[];
  readonly highlights: readonly GapHighlightRowView[];
  readonly highlightsDropped: number;
  /** 三态各自的条数——界面上的计数读这里，不在渲染层重算一遍（§2.5） */
  readonly counts: Readonly<Record<GapStateView, number>>;
  readonly totalExperienceMonths: number;
  readonly libraryEducationRank: number | null;
  /** 参与比对的库内实体条数；0 时界面要说清"是没录简历，不是你不合格" */
  readonly entityCount: number;
  /** 「至今」夹到的那个月（`YYYY-MM`），年限读数的时间基准，必须播出去 */
  readonly asOfMonth: string;
}

/** 一条证据的正文（镜像 `KbEvidenceBodyView`，spec 4.4-05 的证据链跳转；查无为主进程的 `null`）。 */
export interface KbEvidenceBodyRowView {
  readonly id: string;
  readonly origin: GapEvidenceOriginView;
  readonly text: string;
  readonly sourceDocId: string | null;
}

/**
 * 定向生成过进程边界的形状（4.5-11 预览面板的数据源）。
 *
 * 与上面那组同样是 `@auto-cc/plugin-resume-kb` 同名类型的**镜像**，口径也是"界面上要出现的东西才过来"，
 * 但这里多一条刻意的取舍：**不镜像 `ResumeDocument`**。三条理由叠在一起——
 * ① `shared` 在 L1，不许依赖 L2 的 `resume-doc`，在 L1 抄一份文档模型就是第二个真相源（§2.5）；
 * ② 3.3 / 4.1 已定下「文档正文不过进程边界，界面只认 docId」这条（见上面白名单那一段的注释）；
 * ③ 4.5-11 的逐项接受要的是「哪一处改成了什么 + 为什么提前」，`rewrites` / `reorderBases` /
 *   `evidence` 三行读数就够。**原文随改写行一起过来（4.5-c 更正，此前这里写的是"界面自己去读"）**：
 *   渲染层的白名单里一条 `resume.doc.*` 都没有，"自己去读工作副本"无从落地；而逐项接受要人判断的
 *   正是「这句改得对不对」，只给新写法等于让人蒙着签字。过界的仍然只是**被改动的那一个字段**的
 *   那一份正文，不是文档模型本体——后者照样不过桥（判据二）。
 * `rejected` 的判定按 `outcome` 读，不看"文档是否为 null"——服务侧 `document` 与 `outcome` 是同一处
 * 三元表达式产出的（`generate-service.ts` 的返回体），所以带 `outcome` 就等于带了"有没有产物"。
 */

/** 一次定向生成的三种结局（镜像 `GenerationOutcome`，spec 4.5-05 / 09 的播报依据）。 */
export type GenerationOutcomeView = 'rewritten' | 'reorder_only' | 'rejected';

/**
 * 一条改写（镜像 `GenerationRewriteView`）：位置三 id + 改前改后两份正文 + 出处 id。
 * 原文在这里是**逐项接受的判据**而不是文档正文的透传——只有被改动的那个字段过界（见本节头注释 ③）。
 */
export interface GenerationRewriteRowView {
  readonly sectionId: string;
  readonly entryId: string;
  readonly fieldKey: string;
  /** 区块标题（界面用它说"改的是哪一段"） */
  readonly sectionTitle: string;
  /** 条目标签（该条目里被事实锁定的字段值拼出来的"这是哪一条"） */
  readonly entryLabel: string;
  /** 改写前的正文，逐字取自工作副本 */
  readonly originalText: string;
  readonly rewrittenText: string;
  /**
   * 这段原文在知识库里的出处实体 id（4.5-06）。为空只有两种情况，靠下面那一位分开，各给一句播报。
   */
  readonly sourceEvidenceIds: readonly string[];
  /**
   * 该条目在库里是否派生出了实体行（`false` = 所属区块按 4.2 裁定二不产实体行）。
   * 界面用它把两种空态分开：不产实体行是**结构使然**，产了却回查不到逐字载荷是**要人工确认**。
   */
  readonly entryModeled: boolean;
}

/** 一条证据引用（镜像 `GenerationEvidenceView`）：正文另问 `kb.profile.evidenceBody`（§8.5）。 */
export interface GenerationEvidenceRowView {
  readonly sectionId: string;
  readonly entryId: string;
  readonly evidenceId: string;
  readonly kind: GapRequirementKindView;
  /** JD 里那条要求的代表词（JD 内容，不是用户的个人信息） */
  readonly label: string;
  readonly score: number;
  readonly tokens: readonly string[];
}

/** 撑起一次换位的一条命中（镜像 `ReorderHit`）。 */
export interface GenerationHitRowView {
  readonly evidenceId: string;
  readonly label: string;
  readonly kind: GapRequirementKindView;
  readonly score: number;
  readonly tokens: readonly string[];
}

/** 一次换位的依据（镜像 `GenerationReorderView`，spec 4.5-02 的"依据可解释"就是这一行）。 */
export interface GenerationReorderRowView {
  /** 区块之间换序，还是区块内的条目换序 */
  readonly level: 'section' | 'entry';
  readonly id: string;
  /** 换了位置的那一段叫什么（区块标题 / 条目标签，取自文档，界面上不许只报 id） */
  readonly label: string;
  readonly score: number;
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly hits: readonly GenerationHitRowView[];
}

/** 事实校验的读数（镜像 `GenerationChecksView`）：违规行只到「路径 + 判据 + 长度」的形状。 */
export interface GenerationChecksRowView {
  readonly ok: boolean;
  /** 是否重跑过那一轮（4.5-05 的"自动重试一次"只有这一次） */
  readonly retried: boolean;
  readonly violations: readonly string[];
  readonly violationCount: number;
}

/** 一次生成的凭证（镜像 `GenerationReceipt`，与 `resume_generations` 那一行同内容，4.5-10）。 */
export interface GenerationReceiptRowView {
  readonly id: string;
  readonly docId: string;
  readonly jdId: string | null;
  readonly createdAt: number;
  /** 实际发过提示词才有版本号；`disabled` / `unavailable` 时为 null */
  readonly promptVersion: string | null;
  readonly model: string | null;
  readonly modelStatus: GapModelStatusView;
  readonly modelReason: string | null;
  readonly outcome: GenerationOutcomeView;
  readonly retried: boolean;
  readonly movedSections: number;
  readonly movedEntries: number;
  readonly rewritesApplied: number;
  readonly rewritesDropped: number;
}

/** `resume.generate.run` 过界的那一份（镜像 `GenerationView` 去掉 `document`，理由见本节头注释）。 */
export interface GenerationRunRowView {
  readonly rewrites: readonly GenerationRewriteRowView[];
  readonly evidence: readonly GenerationEvidenceRowView[];
  /** 只含真正换了位置的对象（没动的不进这里，界面不会把"本来就在第一位"报成一次调整） */
  readonly reorderBases: readonly GenerationReorderRowView[];
  readonly checks: GenerationChecksRowView;
  readonly receipt: GenerationReceiptRowView;
}

/**
 * 界面上的逐项表态（镜像 `GenerationDecision`，spec 4.5-11）。
 * 只回传**下标**：正文与位置三键都不经界面来回，改写清单是随产物给出去的，回来的是"第几行我同意"。
 */
export interface GenerationDecisionRowInput {
  /** 以 `GenerationRunRowView.rewrites` 的顺序为准（界面显示的那一份） */
  readonly acceptedIndexes: readonly number[];
  /** 重排整组接受 / 整组回退（逐条回退会让判据一的稳定序变成二次猜测） */
  readonly applyReorder: boolean;
}

/** 接受成功后的读数（镜像 `GenerationAcceptResult`）。 */
export interface GenerationAcceptRowResult {
  readonly docId: string;
  readonly receiptId: string;
  readonly appliedRewrites: number;
  readonly reorderApplied: boolean;
  readonly movedSections: number;
  readonly movedEntries: number;
  /** 写入后工作副本的 `updatedAt`（毫秒） */
  readonly updatedAt: number;
}

/** 手工新建实体的入站形状（镜像 `KbCreateInput`）。 */
export interface KbCreateRowInput {
  readonly kind: KbEntityKindView;
  readonly payload: Readonly<Record<string, string>>;
  readonly parentId?: string | null;
}

/** 一次同步的读数（镜像 `KbSyncResult`）。 */
export interface KbSyncRowResult {
  readonly docId: string;
  readonly created: number;
  readonly updated: number;
  readonly removed: number;
}

/** 一次删除的读数（镜像 `KbRemoveResult`：删了几条 + 解除归属几条）。 */
export interface KbRemoveRowResult {
  readonly entityId: string;
  readonly removed: number;
  readonly detached: number;
}

/** 一次备份导出的回执（镜像 `KbExportResult`）。 */
export interface KbExportRowResult {
  readonly filePath: string;
  readonly exported: number;
}

/** 备份导入的冲突策略（镜像 `KbImportMode`，默认 `skip`）。 */
export type KbImportModeView = 'skip' | 'overwrite';

/** 一次备份导入的读数（镜像 `KbImportResult`）。 */
export interface KbImportRowResult {
  readonly filePath: string;
  readonly total: number;
  readonly created: number;
  readonly overwritten: number;
  readonly skipped: number;
  readonly danglingParents: number;
}

/**
 * 定时任务的跨进程读数（spec 5.7-05 / 09 的界面入口）。
 *
 * 为什么住在本契约包而不是调度包自己那份：渲染层只认 `@auto-cc/shared` 一个入口（§5.8），
 * 而调度包在 L3，契约层不许反向依赖它。口径与 `SendReceiptView` 一致——类型在这里定型一次，
 * 生产方（`packages/scheduler`）经 `@auto-cc/shared` 取**同一份**，不在两处各写一遍（§2.5）。
 */
export type ScheduleJobView = {
  id: string;
  /** 用户给任务起的名字，只用于界面辨认，不参与任何判定 */
  name: string;
  /** 被触发的那条**已保存工作流**的 id（5.7-07：只能是它，不能是一段自由对话） */
  planId: string;
  /** cron 表达式原文；回显用，判定一律走重算（见调度包的 `internal/cron.ts`） */
  expression: string;
  isEnabled: boolean;
  /**
   * 下一个计划时刻（毫秒，绝对时间点，按运行机器本地时区算出）。
   * 停用任务为 null——它没有"下一次"，重新启用时按当时重算，于是停用期间自然越过的那些点不算"错过"。
   */
  nextRunAt: number | null;
  /** 上一次被处理掉的计划点（触发成功、被跳过、失败都算处理过），null = 从来没处理过 */
  lastPlannedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * 单次触发的结局。
 * `started` 只说"起跑口返回了一条 run"，不说"这轮工作流跑成了"——那是 `workflow` 侧的读数（5.7-02 的证据链）。
 */
export type ScheduleTriggerResult = 'started' | 'skipped' | 'failed';

/** 每一次触发都追加一行（5.7-06）：结果写在记录上而不是 job 行上，才答得出"失败有没有影响下一次"。 */
export type ScheduleTriggerView = {
  id: string;
  jobId: string;
  /** 这一次对应的那个计划点 */
  plannedAt: number;
  /** 实际动手的时刻（毫秒）；`skipped` 里"错过补记"那一条为 null，因为那一刻 app 根本没在跑 */
  firedAt: number | null;
  result: ScheduleTriggerResult;
  /** 跳过/失败的**原话**：额度拒因来自闸门，起跑失败的原因来自 `workflow.runner`，调度器不自己编 */
  reason: string | null;
  /** 起成功时 `workflow.runner` 给的 run id；其余为 null */
  workflowRunId: string | null;
  createdAt: number;
};

/**
 * 建任务的入站形状（与调度服务 `createJobSchema` 的输入同形）。
 * 这里**没有** `goal` 一类的自由文本键：5.7-07「调度只能触发已保存工作流」在契约层就是没有那个字段，
 * 而服务侧的 `strictObject` 会把越形键原话拒出来。
 */
export type ScheduleJobCreateInput = {
  name: string;
  planId: string;
  expression: string;
  isEnabled?: boolean;
};

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
  /** 读当下是否处于人工接管中（spec 5.5-01 的界面态；`isHeld` 为 false 就是自动化照旧，不是返回 null）。 */
  'browser.takeover.held': { args: []; returns: TakeoverStateView };
  /** 由人发起接管（界面上那只「我来接手」）；`actor` 由调用方给，渲染层那一路恒为 `user`。 */
  'browser.takeover.begin': { args: [input: TakeoverBeginInput]; returns: TakeoverStateView };
  /** 交还页面；**不**顺带恢复任何 run（恢复由人再按一次 `agent.loop.resume`，spec 5.5-01）。 */
  'browser.takeover.end': { args: [input?: TakeoverEndInput]; returns: TakeoverStateView };
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
  /**
   * 漏斗五级 + 额度三量的一次只读聚合（spec 5.8-01 / 03 / 04 / 07 / 08，plan §7.6.2 决策十六）。
   *
   * `range` 是**含头不含尾**的毫秒区间，日界由发起方按本地时区算（决策十七）——主进程不猜"近 7 天"
   * 从哪一刻起，所以界面传错时以 `FUNNEL_RANGE_INVALID` 结构化失败，而不是画一条假漏斗。
   * `context.nowMs` 只影响「今日已用/剩余」那一块，省略则取主进程当前时间。
   */
  'funnel.query': { args: [range: FunnelRange, context?: { nowMs?: number }]; returns: FunnelView };
  /** 更新通道四条口（spec 5.9-03）：`status` 只读上一次读数，其余三条只在人按下去时动作。 */
  'update.status': { args: []; returns: UpdateView };
  /** 向配置里的更新源问一次版本号；没有配置更新源时返回 `no-feed`，一条请求都不发。 */
  'update.check': { args: []; returns: UpdateView };
  /** 用户看过新版本后主动下载安装包；上一态不是 `available` 即拒绝。 */
  'update.download': { args: []; returns: UpdateView };
  /** 用户主动重启并安装；上一态不是 `downloaded` 即拒绝。 */
  'update.install': { args: []; returns: UpdateView };
  /** 外发样例：唯一经过闸门的外发入口，目标只有本地 fixture（AGENTS.md §7.2）。 */
  'outbound.sample.send': { args: [request: SendSampleRequest]; returns: SendReceiptView };
  /**
   * 打招呼编排入口（spec 2.5-02 / 03 / 04 / 09 / 10 / 13）：幂等 → 内容 → 黑名单 → 额度 → 频控 → 发送 → 落账，
   * 全在主进程一侧完成，界面拿到的是回执或被拒的结构化错误，没有绕过闸门的第二条口。
   */
  'outbound.greet.perform': { args: [request: GreetRequestView]; returns: GreetReceiptView };
  /**
   * 生成一条话术候选（spec 4.6-01 / 02 / 06 / 07）：只产内容，不发送、不过闸门。
   *
   * 界面一次点按会按"每条证据一条 + 一条不引用证据的"逐条调它（候选的条数与去重在界面侧，
   * 判据全在服务侧）；被入参校验拒掉时以结构化错误上浮，与其它口同一条口径。
   */
  'outbound.script.generate': { args: [request: ScriptGenerateRequestView]; returns: ScriptDraftRowView };
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
  'workflow.runner.start': { args: [planId?: string]; returns: WorkflowRunView };
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
   * 可选计划清单（spec 5.4-03 的下拉 + 5.4-08 的列表）：库里存的自定义计划在前，内置目录在后，两者都带指纹与节点数。
   * 每次现读不缓存——「存了一条新计划之后下拉里必须能看到它」是 5.4-01 / 08 的判据，缓存就成了一句看运气的话。
   */
  'workflow.runner.plans': { args: []; returns: WorkflowPlanOptionView[] };
  /**
   * 改一条自定义计划的名字（spec 5.4-08 的重命名）：只动 `name` 这一列，`plan_json` 与指纹原样留着——
   * 名字是人读的，指纹是 run 读的，改名不该让历史 run 的快照失去对应（5.4-06 的反向验证）。
   * @param id 计划 id；库里没有这条时返回 null（不是错误：列表刚被另一个窗口删过是常态）
   * @param nameRaw 新名字原值，校验与 trim 在 `workflow_plans` 那一份实现里做（唯一口径，见 5.4-05）
   */
  'workflow.runner.renamePlan': { args: [id: string, nameRaw: string]; returns: SavedWorkflowPlanView | null };
  /**
   * 复制一条计划（spec 5.4-08 的复制）：新 id、新名字，节点内容与源一致；内置计划想改就先复制一份。
   * 内置计划也可以复制——复制出来的是一条普通自定义计划，内置目录本身仍只读。
   * @param id 源计划 id；找不到返回 null
   * @param nameRaw 新名字原值
   */
  'workflow.runner.duplicatePlan': { args: [id: string, nameRaw: string]; returns: SavedWorkflowPlanView | null };
  /**
   * 删一条自定义计划。
   * 只删登记，**不动任何历史 run 的 `plan_json`**：那一份快照是「当时到底跑了什么」的唯一凭据（2.4-04），
   * 删掉它等于把跑过的 run 变成无法解释的行。
   * @param id 计划 id
   * @returns 是否真的删掉了一条（false = 没这条，或那是内置计划——内置目录不可删）
   */
  'workflow.runner.removePlan': { args: [id: string]; returns: boolean };
  /**
   * 把「当前计划」换成下拉里挑中的那条（plan 裁定七 / 5.10-j）。
   *
   * 与 `workflow.runner.start` 的区别就是这一口存在的全部理由：`start` 是"照这条计划**起一条新的**"，
   * 这里是"我现在认这条为当前计划"——它不起 run、不写 `workflow_runs`、不动推进态，
   * 所以被 kill 的自定义计划 run 在重启后终于有了界面入口（先 select，再 `runner.resumeRun`）。
   * 回执里的 `fingerprint` 是给界面回读的那一眼：它和那条 run 登记的值不相符时，
   * `resumeRun` 照旧按 2.4-05 拒绝，这道串档护栏没有因为能换计划而松掉。
   * @param planId 要选中的计划 id（内置目录或 `workflow_plans`）；两处都没有时结构化失败并列出可用值，
   *               当前计划原样不动
   * @returns 切过去后的 `{ planId, fingerprint }`
   */
  'workflow.runner.selectPlan': { args: [planId: string]; returns: SelectedWorkflowPlanView };
  /**
   * 读一条计划的画布图（spec 5.10-10）：库里存过就读人存下来的那一份；内置那三条与 5.4 沉淀行没有
   * `graph_json`，由 `plan_json` 线性投影现算（`isCustom: false`），所以「能选出来的计划就能画」
   * 在 IPC 这一侧同样成立，而不只是 5.10-b 的单测里成立（5.10-02）。
   * @param planId 计划 id；库里与内置目录都没有时结构化失败——不返回空图，否则画布会画成「一条都没有」
   */
  'workflow.graph.load': { args: [planId: string]; returns: WorkflowGraphLoadView };
  /**
   * 保存画布图（spec 5.10-10 的写入口 + 5.10-15 的硬拦）。
   * 界面上那圈红环只是**预览**，五条图校验在服务侧再跑一遍：不合法就结构化拒绝、逐条原因带回去，
   * 库里那一版原样不动。`expectedRevision` 与库里不等时拒写而不是静默覆盖另一个窗口那一版。
   * @param input 计划 id + 图本体 + 落点（视图层，不进指纹）+ 期望版本
   */
  'workflow.graph.save': { args: [input: WorkflowGraphSaveInput]; returns: WorkflowGraphSaveView };
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
  /**
   * 起草一份计划并落一条 `proposed` 的 run（spec 5.2-03）：**这一步不执行任何动作**，
   * 返回的就是计划卡要画的那份读数（步骤 + 每步副作用级 + 档位快照 + 两条上限）。
   * @param goal 用户原文，主进程侧按系统边界校验（去空、限长）
   */
  'agent.loop.propose': { args: [goal: string]; returns: AgentRunView };
  /**
   * 确认这份计划并开始逐步执行（spec 5.2-03 / 04）。只有界面点出来的这一条路，
   * 不登记为 agent 工具（见 `RENDERER_ALLOWLIST` 同处的说明）。
   * @param runId 待确认的 run；不在 `proposed` 态时结构化失败，不会「再跑一遍」
   */
  'agent.loop.confirm': { args: [runId: string]; returns: AgentRunView };
  /**
   * 叫停（spec 5.2-10）：正在跑的那一步不被硬切，停在**下一个安全点**。
   * @param runId 要停的 run；已终态的原样返回读数，不报错
   */
  'agent.loop.stop': { args: [runId: string]; returns: AgentRunView };
  /**
   * 现读一次 run 的整份落库读数（spec 5.2-04 / 09 的界面半边）：进度**主要由 `agent/run-progress` 推**，
   * 这条负责「错过了也还在」（与 `outbound.deliver.pending()` 同一分工）。
   * @param runId 运行 id
   */
  'agent.loop.read': { args: [runId: string]; returns: AgentRunView };
  /**
   * 读一个会话最近一次 run 的界面读数（spec 5.6-01 的运行半边）：重新挂载（含重启）时用它把
   * 计划卡与逐步卡片流从库里画回来；返回的是 `agent.loop.read` 那一份形状（含 5.6-05 的掩码），不是第二份投影。
   * @param sessionId 当前会话 id，来自 `chat.session.current()`；该会话没起草过 run 时返回 null（不是错误）
   */
  'agent.loop.latestRun': { args: [sessionId: string]; returns: AgentRunView | null };
  /** 人交还页面之后按的那次「继续」：只吃被接管按住的 `paused`，其余态结构化失败（spec 5.5-01）。 */
  'agent.loop.resume': { args: [runId: string]; returns: AgentRunView };
  /**
   * 沉淀预览（spec 5.4-01）：这次对话能不能变成一条工作流、每一步会变成哪个节点、
   * 不能沉淀的那一格为什么不行（逐格读数 + 整段第一句拒因）。**只读**，不写库。
   * @param runId 来自对话卡片的 run id
   */
  'agent.sediment.preview': { args: [runId: string]; returns: SedimentPreviewView };
  /**
   * 把这次对话存成一条自定义计划（spec 5.4-01 的落库半边）：先按 `preview` 同一条投影判一次，
   * 不合格就以 `INVALID_ARGUMENT` 结构化失败并带回逐格读数——界面上的勾与这里的放行永远不会各说各话。
   * @param runId 要沉淀的 run
   * @param nameRaw 人填的工作流名字；校验只在 `workflow_plans` 那一处（空 / 超长 / 符号 → 结构化失败）
   * @returns 刚落库的计划读数，界面据此把计划下拉指过去
   */
  'agent.sediment.save': { args: [runId: string, nameRaw: string]; returns: SavedWorkflowPlanView };
  /**
   * 按引用回看一步上的证据读数（spec 5.7-02 / plan §7.5.7 决策十一）：整条链只有这一只手认识引用前缀，
   * 界面拿到的是统一视图，**不需要知道哪条引用归哪个服务管**。
   * 三种结局都在返回值里（读到正文 / 这类引用本就不落正文 / 归属服务此刻没挂载），这只口从不抛——
   * 跨进程抛裸异常会丢掉原因，界面上就只剩「An error occurred」，而这里要给人看的正是那句原因。
   * @param runId 来自对话卡片的 run id
   * @param planStepIndex 那一步的下标（与 `AgentStepView.planStepIndex` 同源）；先验归属再读记录
   * @param ref 被点的那一条引用原文，须与步记录上的 `evidenceRefs` 逐字相同
   */
  'agent.run.evidence': { args: [runId: string, planStepIndex: number, ref: string]; returns: EvidenceRefView };
  /**
   * 列出当前免确认的动作（spec 5.3-07）：每项带注册表现读的副作用级与标题键，
   * 名单为空就画空态——**缺省为空**是「默认仍需每次确认」的界面证据。
   */
  'agent.policy.exemptList': { args: []; returns: ExemptToolView[] };
  /**
   * 把一只动作加进免确认名单（spec 5.3-06 / 07，只在 `auto` 档生效，且不豁免额度闸门与频控）。
   * @param toolId 工具 id；不在开放面上时以 `AGENT_POLICY_EXEMPT_UNKNOWN` 结构化失败
   * @returns 变更后的整份名单，界面一次调用即可刷新
   */
  'agent.policy.setExempt': { args: [toolId: string]; returns: ExemptToolView[] };
  /**
   * 撤销一只动作的免确认（spec 5.3-07 的「可逐条撤销」）。
   * @param toolId 工具 id；不在名单里时读数与调用前一致，不报错也不写审计
   */
  'agent.policy.clearExempt': { args: [toolId: string]; returns: ExemptToolView[] };
  /**
   * 当前在等的暂停单（spec 5.3-08 的读路）：两种卡片都从这一份现读，事件只负责「此刻提醒一下」。
   * 没有在等的单时是空数组——界面因此没有「以为还有卡片」的余地。
   */
  'agent.pause.pending': { args: []; returns: AgentPauseView[] };
  /**
   * 把一句表态按单号送回那张单（spec 5.3-09）。返回值是**变更后的整份在等清单**，
   * 与 `agent.policy.setExempt` 同一形状：界面一次调用即可刷新，不必自己把那张卡从列表里摘掉。
   * @param requestId 单号，来自 `agent.pause.pending()` 或 `agent/pause-requested`
   * @param answer `approve` / `deny` / 带文本的 `supply`；种类与单不相配、或查无此单时结构化失败且不落地
   */
  'agent.pause.respond': { args: [requestId: string, answer: AgentPauseAnswer]; returns: AgentPauseView[] };
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
   * 给当前会话起个名字（spec 5.6-07）。标题进库之前先过那只 `redactText` 手——它属于对话记录面。
   * @param title 人去空格后的名字；空串或超 `MAX_SESSION_TITLE_CHARS` 时结构化失败（`CHAT_TITLE_EMPTY` / `CHAT_TITLE_TOO_LONG`），不落库
   * @returns 变更后的会话读数，界面一次调用即可刷新标题位
   */
  'chat.session.rename': { args: [title: string]; returns: ChatSessionView };
  /**
   * 软删当前会话（spec 5.6-07）：只把 `deleted_at` 打上位，消息、run、档位审计的行一条都不动，
   * 因此这一格是可逆的——返回值里带着会话 id，界面把它当成「撤销」的凭据。
   * @returns 变更后的（已删除）会话读数；一个可删的会话都没有时结构化失败 `CHAT_SESSION_NOT_FOUND`
   */
  'chat.session.remove': { args: []; returns: ChatSessionView };
  /**
   * 恢复一个软删的会话（spec 5.6-07 的「恢复途径」）：清掉 `deleted_at`，它又变回「最新的那一个」。
   * @param sessionId 会话 id，来自 `chat.session.remove()` 的返回（界面上就是那条撤销提示）
   * @returns 变更后的会话读数；查无此单 `CHAT_SESSION_NOT_FOUND`，本来没删 `CHAT_SESSION_NOT_DELETED`
   */
  'chat.session.restore': { args: [sessionId: string]; returns: ChatSessionView };
  /**
   * 被软删的会话清单（spec 5.6-07 的恢复途径）：界面拿它把「可恢复」画成一只只按得下去的按钮，
   * 而不是一个随重启就消失的撤销提示。
   * 末段与 `ChatSessionService.trashed()` 一字不差：网关是按 `service.method` 现取方法，名字对不上只在运行期炸（5.6-c 活体验收踩到）。
   * @returns 按删除时间倒序的会话读数；一条都没删过时为空数组（界面整块不渲染）
   */
  'chat.session.trashed': { args: []; returns: ChatSessionView[] };
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
   * 打开一份文档的编辑会话（spec 3.6，plan §8.3）：正文留在主进程，界面从这里拿到的是投影。
   * 重新 open＝放弃上一份未保存的 draft（3.6-09 的"只拦不存"：拦截提示之后没有恢复途径）。
   */
  'resume.editor.open': {
    args: [docId: string, templateId?: string, locale?: ResumeLocaleView];
    returns: ResumeEditorView;
  };
  /** 只读当前会话投影（界面重挂或只要刷新读数时用；未 open 则 `RESUME_EDITOR_NOT_OPEN`）。 */
  'resume.editor.view': { args: [docId: string]; returns: ResumeEditorView };
  /**
   * 拖一次：不给 `entryId` 是搬整个区块（3.6-01），给了就是在该区块内搬条目。
   * 落点下标是**结果序列里的位置**；被拒时上浮 `RESUME_EDITOR_EDIT_REJECTED`，子原因在 `details.reason`。
   */
  'resume.editor.move': {
    args: [docId: string, sectionId: string, toIndex: number, entryId?: string];
    returns: ResumeEditorView;
  };
  /**
   * 改一条度量（3.6-02）。界值以 `.view` 的 `metricBounds` 为准（滑杆摆的就是那一份），
   * 界外与非有限数都被拒——**message 跨进程不丢**，界面上那句提示由主进程的原因拼。
   */
  'resume.editor.metric': { args: [docId: string, key: EditorMetricKeyView, value: number]; returns: ResumeEditorView };
  /**
   * 换预览模板或语言（3.6-04）。它不碰文档、不产生撤销单元，所以"切模板丢数据"在这套形状里无从发生。
   * 两个参数都不给就是只刷新读数；未知模板 id 以 `RESUME_EDITOR_TEMPLATE_UNKNOWN` 失败。
   */
  'resume.editor.use': {
    args: [docId: string, templateId?: string, locale?: ResumeLocaleView];
    returns: ResumeEditorView;
  };
  /**
   * 当前 draft 的预览 HTML（3.6-01「松开即预览更新」的数据源）：与 `resume.export.preview` 用
   * **同一份** builder 与同一个字体 base，区别只在这里喂的是**未保存**的那一份文档。
   */
  'resume.editor.preview': { args: [docId: string]; returns: string };
  /** 回退一步（3.6-03）：返回新的投影，`canUndo` / `isDirty` 一起更新。 */
  'resume.editor.undo': { args: [docId: string]; returns: ResumeEditorView };
  /** 重做一步（3.6-03）。 */
  'resume.editor.redo': { args: [docId: string]; returns: ResumeEditorView };
  /**
   * 保存（3.6-09 的另一半）：把当前 draft 交给 `resume.doc` 那唯一的写入入口，成功后 dirty 归零、
   * 撤销历史照旧保留。界面**不**直接调 `resume.doc.save`——正文不过界，它手里也没有正文。
   */
  'resume.editor.save': { args: [docId: string]; returns: ResumeEditorView };
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
   * 打开一份 PDF（spec 3.4-03 / 3.5-01 的打开半边，plan §7.4 的第一条编辑轨口）：只回来源哈希、页数与每页宽高。
   * 失败以 `AppErrorPayload`（`PDF_EDIT_READ_FAILED`）上浮，`details.code` 说清是哪一种
   * （`empty` / `encrypted` / `invalid-pdf`），界面给三句不同的中文而不是同一句「打不开」。
   */
  'pdf.io.open': { args: [filePath: string]; returns: PdfOpenReceiptView };
  /**
   * 另存一份带覆盖区与页序的 PDF（spec 3.5-02 / 3.5-07 / 3.5-09，plan §7.4 的 `pdf.export`）：
   * 源文件只读，覆盖区以比例坐标进、以内容流里的新笔画出，产物写到 `outPath`。
   * `pageOrder` 是产物的逐页来源页号（1 起）：重复一项即增一页（副本）、缺一项即删一页、换序即重排，
   * 覆盖区跟着**来源页**走——同一源的每一张副本都会盖上，不留"改了一份、另一份还露着旧话"的口子。
   * 失败以 `AppErrorPayload`（`PDF_EDIT_SAVE_FAILED`）上浮，`details.code` 说清是哪一种
   * （`out-is-source` / `out-path-not-absolute` / `invalid-pdf` / `encrypted` / `empty` /
   * `too-many` / `out-of-page` / `out-of-bounds` / `too-small` / `bad-size` / `text-not-supported` /
   * `empty-order` / `page-out-of-range` / `too-many-pages` / `draw-failed` / `write-failed`），
   * 而抛出时磁盘上既没有 `outPath` 也没有 `outPath.part`（plan §7.10 的「失败不落半成品」）。
   */
  'pdf.export.saveAs': {
    args: [filePath: string, overlays: PdfOverlayInputView[], pageOrder: number[], outPath: string];
    returns: PdfSaveAsReceiptView;
  };
  /**
   * 量一份 PDF 某一页上的文本块矩形（spec 3.5-01 的线框半边，plan §7.4 的 `pdf.layout`）：
   * 入参照旧是**绝对路径** + 页号（1 起），回传的每一项**只有比例矩形和一个次序编号**——
   * 文本内容一个字都不过进程边界（同上面 `pdf.io.open` 的取向，界面画线框不需要知道写了什么）。
   * 失败以 `AppErrorPayload`（`PDF_EDIT_READ_FAILED`）上浮，`details.code` 说清是哪一种
   * （`empty` / `encrypted` / `invalid-pdf` / `page-out-of-range` / `layout-failed`）。
   */
  'pdf.layout.textItems': { args: [filePath: string, pageNumber: number]; returns: PdfTextItemsView };
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
  /**
   * 列出知识库实体（spec 4.2-05）：可按种类与来源文档过滤，按更新时间倒序。
   * 界面拿到的是整棵树的平铺读数，父子关系靠 `parentId` 在渲染层组织——关系是库里的真相，不另存一份。
   */
  'kb.profile.list': {
    args: [filter?: { kind?: KbEntityKindView; sourceDocId?: string | null }];
    returns: KbEntityRowView[];
  };
  /**
   * 本地检索（spec 4.3-01 / 4.3-10）：倒排召回 ∪ 子串召回，分数、理由与命中词全在主进程算完再过来。
   * 空结果不是失败：切不出 token 给 `status: 'no_query_tokens'`，库里没有相关就给 `status: 'ok'` + 空 `hits`，
   * 界面据这两个态给不同的提示与可行动建议（4.3-10 的判据）。
   */
  'kb.profile.search': { args: [query: string]; returns: KbSearchRowResult };
  /**
   * 由一句陈述反查支撑它的实体（spec 4.2-03 / 05 的展开态）：分数与判定全在主进程的纯函数里算，
   * **不经过模型**；查无支撑返回空数组而不是失败（4.5 要靠它区分「有证据」与「模型编的」）。
   */
  'kb.profile.evidenceFor': {
    args: [claim: string, filter?: { kind?: KbEntityKindView; sourceDocId?: string | null }];
    returns: KbEvidenceRowView[];
  };
  /**
   * 手工新建一条实体（spec 4.2-02）：`sourceDocId` 在服务侧恒为 `null`，
   * 因此这条永远不会被下一次同步当成「已不在简历里」而清掉。
   */
  'kb.profile.create': { args: [input: KbCreateRowInput]; returns: KbEntityRowView };
  /**
   * 更新一条实体的载荷（spec 4.2-06 的编辑口）：整体覆盖，归属与来源不变。
   * 派生实体在这里仍可编辑，但界面不给出这个入口——它的下一次 `sync()` 会按简历工作副本重写。
   */
  'kb.profile.update': {
    args: [entityId: string, payload: Readonly<Record<string, string>>];
    returns: KbEntityRowView;
  };
  /**
   * 删除一条**手工**实体（spec 4.2-04）：下属解除归属而不是连带删除。
   * 派生实体以 `KB_ENTITY_DERIVED` 结构化失败上浮，界面据此给「去简历里删」的指引。
   */
  'kb.profile.remove': { args: [entityId: string]; returns: KbRemoveRowResult };
  /**
   * 从简历工作副本重新派生实体（spec 4.2-01 的幂等同步）：界面「导入后建库」与 4.2-04 的
   * 「在简历里删掉再同步」都走这一口，工作副本不存在时以 `KB_SOURCE_MISSING` 失败。
   */
  'kb.profile.sync': { args: [docId: string]; returns: KbSyncRowResult };
  /** 导出全库为本地 JSON 备份（spec 4.2-08）：路径由用户给，父目录必须已存在。 */
  'kb.profile.exportBackup': { args: [filePath: string]; returns: KbExportRowResult };
  /** 从本地 JSON 备份导入（spec 4.2-08）：单事务，中途失败整批回滚；默认策略 `skip` 不动用户已有数据。 */
  'kb.profile.importBackup': { args: [filePath: string, mode?: KbImportModeView]; returns: KbImportRowResult };
  /**
   * 缺口报告（spec 4.4-03 / 04 / 05 / 06）：一段 JD 正文与本地库现算一次三态比对。
   *
   * 只有 `filter`，**没有 `nowMs`**：年限读数的"今天"由主进程取，界面与 agent 都不许递时间戳
   * （plan §4.4-d 判据六——让调用方填日期等于让它决定报告该不该变红）。
   * 两种结构化失败上浮给界面分别播报：`INVALID_ARGUMENT`（JD 过短）、`KB_LIBRARY_MISSING`（库里还没东西）。
   */
  'kb.gap.report': {
    args: [jdText: string, filter?: { kind?: KbEntityKindView; sourceDocId?: string | null }];
    returns: GapReportRowView;
  };
  /**
   * 按 id 取一条证据的正文（spec 4.4-05 的证据链跳转）：先查实体表、再查区块切片表，
   * 两表都查无返回 `null` 而不是失败——报告是现算的，用户停在旧报告上时那条实体可能已经被删了。
   */
  'kb.profile.evidenceBody': { args: [id: string]; returns: KbEvidenceBodyRowView | null };
  /**
   * 按一段 JD 定制这份简历（spec 4.5-01 / 05 / 09 / 10 / 11 的界面入口）。
   *
   * 与 `kb.gap.report` 一样**没有 `nowMs`**：记录行的时间戳由主进程取，调用方不许决定"这次生成算哪一天"。
   * `docId` 省略时只在库里恰好一份简历的情况下自动选，多份则以 `INVALID_ARGUMENT` 上浮（"要定制哪一份"是人来答的）。
   * 三种结构化失败各有界面口径：`INVALID_ARGUMENT`（JD 过短 / 多份简历未指明）、`KB_SOURCE_MISSING`（还没导入简历）、
   * `KB_LIBRARY_MISSING`（缺口腿未装配，只能报"功能不可用"）。
   * 返回体**不含文档本体**（见上面那组镜像的头注释）：产物是否存在的判据是 `receipt.outcome`，
   * `rejected` 时界面只给违规明细与"需人工确认"，不给一份看起来像成功过的空壳（判据三）。
   */
  'resume.generate.run': {
    args: [jdText: string, filter?: { docId?: string; jdId?: string | null }];
    returns: GenerationRunRowView;
  };
  /**
   * 把人逐项过目后选中的那几处改写与（可选的）重排写进工作副本（spec 4.5-11）。
   *
   * 入站只有 `receiptId` 与下标：正文、位置三键、时间戳都不由界面提供（主进程那份提议态里都有，
   * 界面回传正文等于让渲染层决定"往哪一格写什么字"）。四种失败各给一句不同的话：
   * `KB_GENERATION_PROPOSAL_MISSING`（重新生成）、`KB_GENERATION_STALE_BASELINE`（你在生成后自己改过简历）、
   * `KB_GENERATION_CHECK_FAILED`（选中的组合没过事实校验，本次不写入）、`INVALID_ARGUMENT`（下标越界）。
   * 全片唯一会改用户简历的调用点在这里，所以服务侧写之前复验一次基线、再复验一次校验（见 `accept()`）。
   */
  'resume.generate.accept': {
    args: [receiptId: string, decision: GenerationDecisionRowInput];
    returns: GenerationAcceptRowResult;
  };
  /**
   * 定时任务列表（spec 5.7-05）：按"下一次什么时候跑"排序的只读读数，停用任务的 `nextRunAt` 为 null。
   * 界面每次现读、不缓存第二份（§9 的 2.5 实测：热改配置会重建下游，本地存一份就静默变空）。
   */
  'schedule.registry.jobs': { args: []; returns: ScheduleJobView[] };
  /**
   * 触发记录（spec 5.7-06 / 09）：`jobId` 省略时取全局最近若干条。
   * `result='skipped'` 且 `reason` 是那句"app 关闭期间越过了这个计划点"的那一行，就是界面上的"已跳过"标记。
   */
  'schedule.registry.triggers': { args: [jobId?: string, limit?: number]; returns: ScheduleTriggerView[] };
  /**
   * 建一条定时任务（spec 5.7-05）。
   * 三种失败都在落库之前，因此都是"零副作用"：`INVALID_ARGUMENT`（名字空/越形键）、
   * cron 求值不出下一个点（同一条码，拒因带表达式）、`planId` 不在计划库目录里（`INVALID_ARGUMENT` 带原话）。
   */
  'schedule.registry.createJob': { args: [input: ScheduleJobCreateInput]; returns: ScheduleJobView };
  /**
   * 启停一条任务（spec 5.7-05 的列表可见启停）。
   * 重新启用按当时重算下一个点，所以停用期间越过的那些点不会被记成"错过"——那是人的决定，不是 app 的失约。
   */
  'schedule.registry.setEnabled': { args: [jobId: string, enabled: boolean]; returns: ScheduleJobView };
  /** 删除任务（触发记录保留，5.7-06 的账不能跟着任务一起消失）。 */
  'schedule.registry.removeJob': { args: [jobId: string]; returns: void };
  /**
   * 立刻跑一次（把"到点"这件事交给人按一次，用于验证 5.7-06 的失败不影响下次）。
   * 与到点触发同一条腿：先问额度、被拒即落 `skipped` 并带回闸门原话，一次 `start` 都不发。
   */
  'schedule.registry.triggerNow': { args: [jobId: string]; returns: ScheduleTriggerView };
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
  // 页面「在谁手里」变了（spec 5.5-01 / 02）：接管条与那两只按钮由它驱动，载荷就是 `browser.takeover.held()`
  // 那份读数——不另包一层，免得渲染层再推一次「现在到底谁在操作」（§2.7 禁的第二份事实）。
  'browser/takeover-changed',
  // 知识库实体表被写过（spec 4.2-06）：编辑即时生效靠它，界面不轮询也不靠用户手动刷新。
  'kb/entities-changed',
  // 计划库被写过（spec 5.4-01）：沉淀卡在对话侧，它存成一条计划时计划库界面并不经手，
  // 只靠界面自己刷新就漏这一类写入——与 `kb/entities-changed` 同一个道理。
  'workflow/plans-changed',
  // 5.2-c 的循环进度（spec 5.2-04）：逐步卡片流靠它推进，载荷就是 `agent.loop.read` 那份读数。
  'agent/run-progress',
  // 5.3-c 的暂停单开与收（spec 5.3-08 / 10）：前者弹卡片，后者把卡片收掉——**超时与叫停也发这一条**，
  // 界面上那张卡才不会悬着；它带的 `outcome` 说的是「没人应答」，不是「用户拒绝了」，措辞由此分开。
  'agent/pause-requested',
  'agent/pause-resolved',
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
  'browser/takeover-changed': TakeoverStateView;
  'kb/entities-changed': KbEntitiesChangedEvent;
  'workflow/plans-changed': WorkflowPlansChangedEvent;
  'agent/run-progress': AgentRunView;
  'agent/pause-requested': AgentPauseView;
  'agent/pause-resolved': AgentPauseResolvedEvent;
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
  /**
   * 本轮读到并落库的岗位键（spec 5.7-f）。抓取只回计数时，下游（尤其是对话的规划器）手上
   * 没有任何可指的真实 id，只能编一个——5.7-d 那次就是这样产出 `jdId:"1009"` 的。
   * 键是平台侧 `job_id`，与 `job:` / `jd:` 引用的那一把同源，不是库内自增 id。
   */
  captured: { jobId: string; title: string }[];
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
