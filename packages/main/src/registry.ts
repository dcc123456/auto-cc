/**
 * 插件 id → 实现类（spec 1.3-01）。
 *
 * `cordis.yml` 只写 id、顺序与配置，不写模块路径：主进程被 esbuild 打成单文件，
 * `import(变量)` 在运行时拿不到路径。因此清单负责「装哪些」，这里负责「用哪个类装」。
 * 新增插件时同时改两处——清单漏了它就不装，注册表漏了它在插件树里显示 failed。
 */
import {
  AgentLoopService,
  AgentPauseService,
  AgentPolicyService,
  AgentSedimentService,
  AgentToolsService,
  ChatSessionService,
  EvidenceRefService,
  FunnelQueryService,
} from '@auto-cc/plugin-agent';
import {
  BrowserActService,
  BrowserLocateService,
  BrowserPageService,
  BrowserRiskService,
  BrowserTakeoverService,
  PlatformRegistryService,
} from '@auto-cc/plugin-browser';
import { ConfigService } from '@auto-cc/plugin-config';
import { DevtoolsService } from '@auto-cc/plugin-devtools';
import { EntitlementGateService, UsageLedgerService } from '@auto-cc/plugin-entitlement';
import { IpcGatewayService } from '@auto-cc/plugin-ipc';
import type { Registry } from '@auto-cc/plugin-kernel';
import { LlmChatService, LlmEmbedService } from '@auto-cc/plugin-llm';
import { LogService } from '@auto-cc/plugin-logger';
import {
  DeliveryRecordService,
  OutboundDeliverService,
  OutboundGreetService,
  OutboundSampleService,
  OutboundScriptService,
  OutboundThrottleService,
} from '@auto-cc/plugin-outbound';
import { PdfExportService, PdfIoService, PdfLayoutService } from '@auto-cc/plugin-pdf-edit';
import {
  BossPlatformService,
  ConversationStoreService,
  JdCaptureService,
  JdStoreService,
} from '@auto-cc/plugin-platform-boss';
import { PluginsService } from '@auto-cc/plugin-plugins';
import {
  ResumeDocService,
  ResumeEditorService,
  ResumeExportService,
  ResumeSnapshotService,
} from '@auto-cc/plugin-resume-doc';
import { KbGapService, KbProfileService, ResumeGenerateService, ResumeParseService } from '@auto-cc/plugin-resume-kb';
import { ScheduleRegistryService } from '@auto-cc/plugin-scheduler';
import { SessionsService } from '@auto-cc/plugin-sessions';
import { StoreService } from '@auto-cc/plugin-store';
import {
  WorkflowExecutorRegistryService,
  WorkflowGraphService,
  WorkflowRunnerService,
  WorkflowRunStoreService,
} from '@auto-cc/plugin-workflow';
import { ResumePrintService, ShellService, UpdateService } from '@auto-cc/shell';

export const REGISTRY: Registry = {
  config: ConfigService,
  logger: LogService,
  store: StoreService,
  // 模型出口（spec 2.5-12）：全仓唯一的 LLM 入口，`scripts/check-llm-single-entry.ts` 机器守住这一条。
  // 未配置（缺 baseUrl / model / 环境变量里的 key）时它照样挂载，只是 `complete()` 以 `LLM_UNAVAILABLE`
  // 结构化失败且一次网络都不发 —— 话术生成因此能走模板回落并在界面播报，而不是静默空串。
  llm: LlmChatService,
  // 向量出口（spec 4.3-07 / 08）：同一个客户端的第二个方法，但**配置独立**——DeepSeek 没有 embeddings
  // 端点而硅基流动有，绑在一起配就会变成「为了向量增强改坏话术生成」（plan §4.3-d 证据 [4]）。
  // 未配置时它照样挂载且一次网络都不发，知识库因此能纯词面 + 倒排检索（4.3-04 的离线可用）。
  'llm-embed': LlmEmbedService,
  // 账本与闸门是同一个域的两个服务，所以各占一个清单 id：`gate` 能单独被摘掉，
  // 1.9-05 的「闸门缺席即拦不住就不许装」才有可演示的形态（摘掉闸门时账本还活着）。
  usage: UsageLedgerService,
  entitlement: EntitlementGateService,
  // 闸门之外的最薄消费者：它存在是为了让 1.9-06 的 grep 有对象可查（plan §8.4）。
  outbound: OutboundSampleService,
  // 话术生成（spec 2.5-01）：内容侧入口，依赖 `llm.chat`；模型未配置时它仍挂载，只是每次都走模板回落。
  'outbound-script': OutboundScriptService,
  // 频控间隔（spec 2.5-04 / 05）：抽样是纯的，但 5.7-08 起它多一个**只读**问法（`checkGap` 要看账本里
  // 最近一次外发的时刻），依赖是 `maybeService` 现问的、不是 inject 的——摘掉 `usage` 时预检一律放行，
  // 真正的间隔仍在节点侧执行，所以它仍然可以单独摘掉而不牵连别人。
  // 单独占一行是为了让「节奏策略」能在装配面板里被单独摘掉/改区间——摘掉后 2.5-e 的打招呼编排连同进 PENDING，
  // 缺节奏时宁可装不上也不要发得一模一样。
  'outbound-throttle': OutboundThrottleService,
  // 打招呼编排（spec 2.5-02…13）：把上面三条加上闸门串成唯一外发口，也是 `greeting.send` 节点的登记方。
  // 单独一个 id 是为了在装配面板上把它单独摘掉——摘掉后界面与工作流都得到结构化失败，而不是「发出去了但没计量」。
  'outbound-greet': OutboundGreetService,
  // 投递记录（spec 3.7-02）：`delivery_records` 表的唯一落点，迁移号段 9。账本数额度、这张表记经过，
  // 一次成功投递一行并以 `ledger_id` 与账本对齐；摘掉它 `outbound-deliver` 连同进 PENDING——
  // 「递出去但没留下可追溯的经过」不是一种可接受的半成功。
  'outbound-delivery-records': DeliveryRecordService,
  // 投递编排（spec 2.6-01…07）：`resume.deliver` 节点的登记方，也是待确认单（`pending()`）的持有者。
  'outbound-deliver': OutboundDeliverService,
  ipc: IpcGatewayService,
  plugins: PluginsService,
  devtools: DevtoolsService,
  sessions: SessionsService,
  // 页面操作入口（spec 2.1）：服务名是 `browser.page`，清单 id 用短名 `browser`（同 1.9 的 usage/entitlement 关系）。
  browser: BrowserPageService,
  // 2.2 的定位与动作层：各自是独立服务，所以各占一个清单 id——注掉 `browser-locate` 之后
  // `browser-act` 会连同进 PENDING（它的 `inject` 里有它），界面上点定位得到结构化错误。
  'browser-locate': BrowserLocateService,
  'browser-act': BrowserActService,
  // 风控观测（spec 2.7-01）：它是每个分区 `onResponseStarted` 那个**唯一槽位**的独占者，
  // 所以单独占一个清单 id 是可演示的——摘掉它之后验证码页会被照常翻页，而暂停只能由它触发。
  'browser-risk': BrowserRiskService,
  // 人工接管态（spec 5.5-01 / 02 / 09）：「这块页面此刻在谁手里」的唯一状态源，号段 21 的接管流水在它名下。
  // 摘掉它时 `agent.policy` 与 `agent.loop` 一起不进装配（那两个服务把它列成硬依赖）——刻意不是软降级：
  // 读不到接管态还照动手，等于「接管期间一步都不发」这条护栏在少一行配置之后静默失效。
  'browser-takeover': BrowserTakeoverService,
  // 平台登记处（spec 2.2-07）：适配器实例只在这里流通，渲染层只拿得到 `platform.registry.list`。
  'platform-registry': PlatformRegistryService,
  // BOSS 适配器（spec 2.2-06）：它在自己的 init 里把自己登记进上一行，`browser` 一行都不认识它。
  'platform-boss': BossPlatformService,
  // JD 库（spec 2.3-02 / 2.3-04）：`jobs` 表的唯一落点，迁移号段 3。摘掉它，`jd-capture` 连同进 PENDING。
  'jd-store': JdStoreService,
  // 会话消息库（spec 2.5-07）：`conversation_messages` 的唯一落点，迁移号段 5。
  // 摘掉它，界面读会话得到「服务未挂载」的结构化失败，而适配器那侧读页面照旧——「读到」与「记住」分属两条。
  'conversation-store': ConversationStoreService,
  // 抓取编排（spec 2.3-01 / 2.3-06…2.3-11）：从 2.7-b 起它也过闸门与频控——搜索额度按 `search` 记账，
  // 轮间停顿由 `outbound.throttle` 抽样给出，所以「只读动作不占额度」这句旧话已经不成立。
  'jd-capture': JdCaptureService,
  // 工作流三件套（spec 2.4）：登记处、落库、执行器各占一个清单 id，所以每一条都能被单独摘掉。
  // 摘掉 `workflow-executors` 之后 `jd.capture` 无人登记，界面得到「执行器未登记」的结构化失败；
  // 摘掉 `workflow-store` 之后 `workflow` 连同进 PENDING，界面上读不到任何 run 状态（而不是「跑完但没记录」）。
  'workflow-executors': WorkflowExecutorRegistryService,
  'workflow-store': WorkflowRunStoreService,
  // 2.4 起槽位来自计划、进度同时落库；1.10 的六步占位流水线已被节点模型替换。
  workflow: WorkflowRunnerService,
  // 5.10-e 的画布图读写口（spec 5.10-10）：单独占一个 id 是为了让它能被单独摘掉——摘掉之后画布读不到图，
  // 而计划列表、run 进度、沉淀那一套照旧（它只在 `workflow_plans` 上多开四列，不另建表）。
  'workflow-graph': WorkflowGraphService,
  // 简历文档存储（spec 3.1-08）：`resume_docs` 表的唯一落点，迁移号段 7。P3 生成轨的地基，
  // 只落库不做渲染——3.2 的模板、3.3 的打印轨都从这张表读同一份合法文档，故它是 P3 的第一块积木。
  'resume-doc': ResumeDocService,
  // 打印执行器（spec 3.3）：全仓唯一调 `webContents.printToPDF` 的地方，落在 L1 shell（它才认识 Electron）。
  // 单独一个 id 是为了让「渲染层无 electron」这条边界可视化——摘掉它，`resume-export` 连同进 PENDING。
  'resume-print': ResumePrintService,
  // 导出编排（spec 3.3-11）：把「读合法文档 → 装配打印请求 → 交给打印轨 → 落盘 + 回写页数」串成 `resume.export` 服务，
  // 自身不认识 Electron，只经 `resume.print` 端口消费打印能力（ports-and-adapters，见 plan §3.3 分层落点）。
  'resume-export': ResumeExportService,
  // 排版编辑器（spec 3.6 / plan §8.3）：编辑会话的持有者。它在 `cordis.yml` 里必须排在 `resume-doc` 之后
  // （§9 的 5.1-c：清单顺序就是挂载顺序，早挂的问不到晚注册的），且**不登记为 agent 工具**——改版面是人对"投出去的那份"的表态。
  // 摘掉这一行，界面九条 `resume.editor.*` 全部得到「服务未挂载」的结构化失败，而预览/导出照旧：
  // 「排一版」与「印一版」分属两件事（草稿不落库，见 plan §8.5 裁定⑨）。
  'resume-editor': ResumeEditorService,
  // 导出快照（spec 3.7-01）：`resume_snapshots` 表的唯一落点，迁移号段 8。每次 `resume.export` 成功后记一行不可变快照，
  // 供 3.7-04 的按 id 还原与后续 3.7-02 的投递追溯读取。摘掉它，`resume-export` 连同进 PENDING（它的 `inject` 里有它），
  // 界面点「导出 PDF」给出结构化错误——「导出」与「导出即留档」因此是可分别摘除的两件事，而不是悄悄少记一份历史。
  'resume-snapshot': ResumeSnapshotService,
  // 简历导入（spec 4.1-06 / 07 / 09 / 10）：`resume_imports` 表的唯一落点，迁移号段 10，也是 PDF / DOCX /
  // Markdown 三条输入腿在桌面端的唯一入口（pdf.js 与 mammoth 是外置依赖，见 plan §1.2 与 1.7-15）。
  // 摘掉它，界面的「导入简历」得到「服务未挂载」的结构化失败，而导出轨照旧——「读进来」与「排出去」分属两条。
  'resume-parse': ResumeParseService,
  // 知识库实体（spec 4.2-01 / 02）：`kb_entities` 表的唯一落点，迁移号段 11。四类实体从 `resume_docs`
  // 的当前工作副本派生（plan §1.4 裁定一/二），因此它依赖文档存储而不是出处表。
  // 摘掉它，4.2-d 的实体面板与 4.3 的检索都失去数据源；本切片（4.2-a）它还没有界面调用方，这是刻意留下的
  // 可见缺口——表先在真实 app 里建好，界面与 agent 工具在 4.2-d 接，两侧都不许对着内存假数据验收。
  'kb-profile': KbProfileService,
  // JD 能力要求拆解（spec 4.4-01）：4.4-a 只有词面腿，所以它**不建表、不依赖 store**，
  // 拆解是纯派生、用时现算（plan §4.4 口径 3：可重建的投影不落库，`jobs.requirements_json` 仍是 2.3 抓取的原样真相）。
  // 与 `kb-profile` 一样，本切片它没有界面调用方——缺口报告在 4.4-d 接，届时两侧共用这一个入口（§5.9）。
  'kb-gap': KbGapService,
  // 定向内容生成（spec 4.5-01 / 05 / 09 / 10）：`resume_generations` 表的唯一落点，迁移号段 15。
  // 摘掉这一行，4.5-c 的预览面板与 agent 的 `resume.generate.run` 同时得到结构化失败，
  // 而知识库、缺口报告、导出轨照旧——「算出改了什么」与「按改动出 PDF」分属两条。
  // 它不 `inject` `kb.gap`（用的时候现问），所以摘掉上面那行它不会连带 PENDING，只会在调用时报库未装配。
  'kb-generate': ResumeGenerateService,
  // 轻编辑的打开腿（spec 3.4-03 / plan §7.4）：`pdf.io` 只做「绝对路径 → 页数与每页宽高」。
  // 它**不建表、不占迁移号段**——编辑会话只活在一次操作里，产物是一份新文件，没有跨重启还在的状态要存。
  // 摘掉 `cordis.yml` 里这一行，`pdf.io.open` 得到「服务未挂载」的结构化失败，而导入轨与导出轨照旧：
  // 「在用户那份 PDF 上改」与「按文档模型排出去」分属两条。本切片（3.5-a）它还没有界面调用方，
  // 这是刻意留下的可见缺口——引擎腿先在真实装配里装好，界面与另存腿在 3.5-b 接（同 4.2-a 的口径）。
  'pdf-io': PdfIoService,
  // 轻编辑的另存腿（spec 3.5-02 / 3.5-09 / plan §7.4）：`pdf.export` 只做「源路径 + 覆盖区 + 产物路径 → 新文件」。
  // 与 `pdf-io` 一样不建表、不占迁移号段、不 inject；它**只写产物、从不写源文件**，
  // 于是摘掉 `pdf-io` 只是打不开，摘掉本行是「改完了存不出去」——两件事分开占行（§4.1 一个包只做一件事的装配版）。
  // 本切片（3.5-b 前半）它同样还没有界面调用方：界面在 3.5-b 后半与 3.5-c 接，中文叠加腿按裁定⑧ 随字体资产再落。
  'pdf-export': PdfExportService,
  // 轻编辑的文本块线框腿（spec 3.5-01 / plan §7.4 的 `pdf.layout`）：`pdf.layout` 只做「源路径 + 页号 → 矩形」。
  // 与上面两行一样不建表、不占迁移号段、不 inject，也**不登记为 agent 工具**。
  // 摘掉本行只是界面上看不见线框，打开与另存照旧——「看得见有哪些块」和「改」「存」是三件分开的事。
  'pdf-layout': PdfLayoutService,
  // 定时任务登记处（spec 5.7-05 / 06 / 09 / 10）：`schedule_jobs` + `schedule_triggers` 两张表的唯一落点，
  // 迁移号段 25，也是全仓唯一持有调度 `setInterval` 的地方（`scripts/check-scheduler-no-external-cron.ts` 钉住）。
  // 摘掉这一行：界面点「定时任务」得到「服务未挂载」的结构化失败，而对话、循环、工作流三条照旧——
  // 「有人排着跑」与「现在跑一次」分属两条。它 `inject` 只有 `store`，起跑口与额度都是用的时候现问（§9 的 2.5）。
  schedule: ScheduleRegistryService,
  // 1.11 的对话骨架：注册表与会话各占一个清单 id，所以 `agent` 能被单独摘掉——
  // 摘掉后发消息仍然流式，只是工具调用一律 `TOOL_NOT_REGISTERED`（1.11-09 的可演示形态）。
  agent: AgentToolsService,
  chat: ChatSessionService,
  // 判定口（spec 5.2-02 / 07）：整条循环里「这一步能不能执行」只有它一个答案来源。
  // 单独占一个清单 id 是为了让 5.2-d 的反向验证可演——摘掉它，循环就拿不到判定而整条停住，
  // 而不是悄悄退回「没人判，照跑」。它只依赖注册表，档位从请求里带进来，不认 `chat`。
  'agent-policy': AgentPolicyService,
  // 暂停通道（spec 5.3-08 / 09 / 10）：确认单与补充信息单的唯一等待处，不建表、不占号段。
  // 单独占一个清单 id 是为了让「摘掉它」可演示：`agent-loop` inject 了它，摘掉这一行整条循环停在挂载期，
  // 而不是悄悄退回「没人可等，照跑」——与上面 `agent-policy` 同一口径。
  'agent-pause': AgentPauseService,
  // 循环（spec 5.2-01 / 05 / 08 / 11）：`agent_run` + `agent_step` 两张表的唯一落点，迁移号段 16。
  // 摘掉它，run 与步记录都不再产生（界面读不到任何进度），而工具面照旧可单点调用——
  // 「有一只手」与「有人排着计划用它」分属两条，与 1.11 的 agent/chat 分法同一口径。
  'agent-loop': AgentLoopService,
  // 对话 → 工作流沉淀（spec 5.4-01 / 02 / 09）：投影 + 唯一写入口，自己不建表、不占号段。
  // 单独占一个清单 id 是为了让「摘掉它」可演示：沉淀按钮得到「服务未挂载」的结构化失败，
  // 而对话、循环、工作流三条都照旧——「跑过一次」与「固化成以后每次都这么跑」分属两条。
  // 它只 `inject` `agent.loop`；计划存储经 `maybeService` 现问，所以摘掉 `workflow` 不会把它一起带进 PENDING，
  // 只在按「沉淀」那一刻报「没有可写入的计划存储口」（§9 的 2.5 实测：存第二份事实会静默变空）。
  'agent-sediment': AgentSedimentService,
  // 按引用回看（spec 5.7-02 / plan §7.5.7 决策十一）：对话卡片上每条证据引用唯一的读数口，只读、不建表。
  // id 取 `agent-run` 与 provide 名 `agent.run` 对齐（点换横线），白名单里的 `agent.run.evidence` 因此可机械对上。
  // 单独占一个清单 id 是为了让「摘掉它」可演示：点引用得到「服务未挂载」的结构化失败，
  // 而对话、循环、卡片流照旧——「跑过一步并留下引用」与「把引用读回成人看得懂的记录」分属两条。
  // 归属服务一律 `maybeService` 现问（§9 的 2.5 实测：热改配置会重建下游，存第二份路由表会静默变空）。
  'agent-run': EvidenceRefService,
  // 漏斗与额度的只读聚合口（spec 5.8-01 / 02 / 03 / 04）：看板的唯一数据源，id 与 provide 名同为 `funnel`
  // （点换横线那条对齐规则），于是白名单里的 `funnel.query` 可机械对上「服务 funnel 的方法 query」。
  // 它没有 `inject`：归属服务一律现问，摘掉任何一条能力腿都只会让那一级带上「没挂载」那句原话，
  // 而注掉本行让看板整块读不到数——「有几级数」与「有一个地方把它们拼起来」分属两条。
  funnel: FunnelQueryService,
  shell: ShellService,
  // 更新通道（spec 5.9-03）：唯一会读 `latest.yml` 的服务，三条口全要人按。
  // 它没有 `inject`，也不在挂载期碰更新器单例——取单例、关三条自动开飞开关、发请求都发生在被调用的那一刻，
  // 所以「注掉这一行」的效果是界面四条口得到「服务未挂载」，而 app 照常启动、照常能用。
  update: UpdateService,
};
