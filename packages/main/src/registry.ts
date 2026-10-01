/**
 * 插件 id → 实现类（spec 1.3-01）。
 *
 * `cordis.yml` 只写 id、顺序与配置，不写模块路径：主进程被 esbuild 打成单文件，
 * `import(变量)` 在运行时拿不到路径。因此清单负责「装哪些」，这里负责「用哪个类装」。
 * 新增插件时同时改两处——清单漏了它就不装，注册表漏了它在插件树里显示 failed。
 */
import { AgentToolsService, ChatSessionService } from '@auto-cc/plugin-agent';
import {
  BrowserActService,
  BrowserLocateService,
  BrowserPageService,
  BrowserRiskService,
  PlatformRegistryService,
} from '@auto-cc/plugin-browser';
import { ConfigService } from '@auto-cc/plugin-config';
import { DevtoolsService } from '@auto-cc/plugin-devtools';
import { EntitlementGateService, UsageLedgerService } from '@auto-cc/plugin-entitlement';
import { IpcGatewayService } from '@auto-cc/plugin-ipc';
import type { Registry } from '@auto-cc/plugin-kernel';
import { LlmChatService } from '@auto-cc/plugin-llm';
import { LogService } from '@auto-cc/plugin-logger';
import {
  DeliveryRecordService,
  OutboundDeliverService,
  OutboundGreetService,
  OutboundSampleService,
  OutboundScriptService,
  OutboundThrottleService,
} from '@auto-cc/plugin-outbound';
import {
  BossPlatformService,
  ConversationStoreService,
  JdCaptureService,
  JdStoreService,
} from '@auto-cc/plugin-platform-boss';
import { PluginsService } from '@auto-cc/plugin-plugins';
import { ResumeDocService, ResumeExportService, ResumeSnapshotService } from '@auto-cc/plugin-resume-doc';
import { ResumeParseService } from '@auto-cc/plugin-resume-kb';
import { SessionsService } from '@auto-cc/plugin-sessions';
import { StoreService } from '@auto-cc/plugin-store';
import {
  WorkflowExecutorRegistryService,
  WorkflowRunnerService,
  WorkflowRunStoreService,
} from '@auto-cc/plugin-workflow';
import { ResumePrintService, ShellService } from '@auto-cc/shell';

export const REGISTRY: Registry = {
  config: ConfigService,
  logger: LogService,
  store: StoreService,
  // 模型出口（spec 2.5-12）：全仓唯一的 LLM 入口，`scripts/check-llm-single-entry.ts` 机器守住这一条。
  // 未配置（缺 baseUrl / model / 环境变量里的 key）时它照样挂载，只是 `complete()` 以 `LLM_UNAVAILABLE`
  // 结构化失败且一次网络都不发 —— 话术生成因此能走模板回落并在界面播报，而不是静默空串。
  llm: LlmChatService,
  // 账本与闸门是同一个域的两个服务，所以各占一个清单 id：`gate` 能单独被摘掉，
  // 1.9-05 的「闸门缺席即拦不住就不许装」才有可演示的形态（摘掉闸门时账本还活着）。
  usage: UsageLedgerService,
  entitlement: EntitlementGateService,
  // 闸门之外的最薄消费者：它存在是为了让 1.9-06 的 grep 有对象可查（plan §8.4）。
  outbound: OutboundSampleService,
  // 话术生成（spec 2.5-01）：内容侧入口，依赖 `llm.chat`；模型未配置时它仍挂载，只是每次都走模板回落。
  'outbound-script': OutboundScriptService,
  // 频控间隔（spec 2.5-04 / 05）：纯抽样服务，无依赖。它单独占一行是为了让「节奏策略」能在装配面板里
  // 被单独摘掉/改区间——摘掉后 2.5-e 的打招呼编排连同进 PENDING，缺节奏时宁可装不上也不要发得一模一样。
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
  // 简历文档存储（spec 3.1-08）：`resume_docs` 表的唯一落点，迁移号段 7。P3 生成轨的地基，
  // 只落库不做渲染——3.2 的模板、3.3 的打印轨都从这张表读同一份合法文档，故它是 P3 的第一块积木。
  'resume-doc': ResumeDocService,
  // 打印执行器（spec 3.3）：全仓唯一调 `webContents.printToPDF` 的地方，落在 L1 shell（它才认识 Electron）。
  // 单独一个 id 是为了让「渲染层无 electron」这条边界可视化——摘掉它，`resume-export` 连同进 PENDING。
  'resume-print': ResumePrintService,
  // 导出编排（spec 3.3-11）：把「读合法文档 → 装配打印请求 → 交给打印轨 → 落盘 + 回写页数」串成 `resume.export` 服务，
  // 自身不认识 Electron，只经 `resume.print` 端口消费打印能力（ports-and-adapters，见 plan §3.3 分层落点）。
  'resume-export': ResumeExportService,
  // 导出快照（spec 3.7-01）：`resume_snapshots` 表的唯一落点，迁移号段 8。每次 `resume.export` 成功后记一行不可变快照，
  // 供 3.7-04 的按 id 还原与后续 3.7-02 的投递追溯读取。摘掉它，`resume-export` 连同进 PENDING（它的 `inject` 里有它），
  // 界面点「导出 PDF」给出结构化错误——「导出」与「导出即留档」因此是可分别摘除的两件事，而不是悄悄少记一份历史。
  'resume-snapshot': ResumeSnapshotService,
  // 简历导入（spec 4.1-06 / 07 / 09 / 10）：`resume_imports` 表的唯一落点，迁移号段 10，也是 PDF / DOCX /
  // Markdown 三条输入腿在桌面端的唯一入口（pdf.js 与 mammoth 是外置依赖，见 plan §1.2 与 1.7-15）。
  // 摘掉它，界面的「导入简历」得到「服务未挂载」的结构化失败，而导出轨照旧——「读进来」与「排出去」分属两条。
  'resume-parse': ResumeParseService,
  // 1.11 的对话骨架：注册表与会话各占一个清单 id，所以 `agent` 能被单独摘掉——
  // 摘掉后发消息仍然流式，只是工具调用一律 `TOOL_NOT_REGISTERED`（1.11-09 的可演示形态）。
  agent: AgentToolsService,
  chat: ChatSessionService,
  shell: ShellService,
};
