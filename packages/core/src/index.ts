/**
 * Single re-export surface for cordis.
 *
 * Every other package imports cordis primitives from here (enforced by the
 * `no-restricted-imports` rule) so that a cordis RC bump — its API is not stable —
 * is absorbed in one file instead of across the plugin tree.
 */
export { Context, CordisError, Fiber, Inject, Logger, Service } from 'cordis';
export type { Effect, EffectMeta, Exporter, LoggerType, Message as LoggerMessage, Plugin } from 'cordis';

import type { Context, Plugin } from 'cordis';
import type {
  AgentToolDeclaration,
  AgentToolRegistry,
  ChatGateway,
  ConsentGate,
  EmbedGateway,
  GreetChannelSource,
  JdKeySource,
  JdReplyStatusSource,
  PagePacer,
  ResumeChannelSource,
  TakeoverStateSource,
  WorkflowExecutorRegistry,
} from './events.js';

/**
 * cordis declares FiberState as an ambient const enum, which cannot be re-exported
 * under verbatimModuleSyntax — so the app maps the numeric state itself.
 */
export type PluginState = 'pending' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading';

export function fiberState(state: number): PluginState {
  return (['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'] as const)[state] ?? 'pending';
}

/** Typed authoring helper for the object form of a cordis plugin. */
export function definePlugin<T>(plugin: Plugin.Object<T>): Plugin.Object<T> {
  return plugin;
}

/**
 * 「确实没有可调项」的插件在直接挂载点的空配置实参。
 *
 * cordis 从构造器第二个参数反推 `ctx.plugin()` 调用点的配置类型，无键 schema 因此被推成
 * `undefined`（AGENTS.md §9 的 1.3 实测条），而运行期仍会拿 schema 解析一次实参：
 * 传 `undefined` 会被 strictObject 判成「期望对象却收到 undefined」，挂载当场就抛。
 * 放在这里而不是各包自己写一遍，是因为这是 cordis 的类型坑、不是某个包的私事。
 */
export const NO_CONFIG = Object.freeze({}) as unknown as undefined;

/** Augmentable map of app services; plugins add entries via module augmentation. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AppServices {}

/** Context plus every service a plugin has provided, so `ctx.<name>` is typed. */
export type AppContext = Context & AppServices;

/**
 * `Service.ctx` 的声明类型是 cordis 的 `Context`，看不到各包增补进来的服务名。
 * 需要访问兄弟服务时统一走这一次收窄（缺失时返回 undefined，由调用方判空）。
 */
export function asApp(ctx: Context): AppContext {
  // 断言看起来多余，是因为 core 自己的编译单元里 `AppServices` 还是空的；
  // 各插件包增补服务名之后，这一步收窄就不可省。
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return ctx as unknown as AppContext;
}

/**
 * 按服务名**可选**地取实例：未挂载（或上下文已销毁）一律收成 undefined，不抛。
 *
 * 与 `asApp` 的分工是「必需依赖 vs 可选增强」：必需依赖写进 `static inject`，由装配层
 * 保证存在，取不到就是 bug；可选依赖（如执行器登记、失败证据的页面通道）不能让整个服务
 * 因为对方没装而拒绝启动，只能就地降级。cordis 的 `ctx.get` 对未知名会抛，所以 try 是必要的，
 * 这不是「为假想场景加异常处理」（AGENTS.md §2.6）——它是这条口的既有行为（1.4 网关同款）。
 * @param ctx 当前服务的上下文
 * @param id 服务名（`域.能力` 约定）
 * @returns 已挂载的实例，未挂载为 undefined
 */
export function maybeService<T>(ctx: Context, id: string): T | undefined {
  try {
    return ctx.get(id) as T | undefined;
  } catch {
    return undefined;
  }
}

/**
 * 取工作流节点执行器的登记处（spec 2.4-01 的登记口）。
 *
 * 这只手放在 `core` 而不是 `plugin-workflow`：登记由各能力包（L2 领域）在自己的 init 里发起，
 * 而登记处属于 L3 流水线，让下层 import 上层会打破 AGENTS.md §4.1 的依赖方向。
 * @param ctx 调用方的上下文
 * @returns 登记处实例；工作流没装时为 undefined，此时能力包只是没有节点可登记，自身照常启动
 */
export function executorRegistryOf(ctx: Context): WorkflowExecutorRegistry | undefined {
  return maybeService<WorkflowExecutorRegistry>(ctx, 'workflow.executors');
}

/**
 * 取 agent 工具注册表的登记面（spec 2.8-08 的登记口），实现方是 `agent.tools`。
 *
 * 放在 core 的理由与 `executorRegistryOf` 完全同形：登记由各能力包（L2）在自己的 init 里发起，
 * 注册表却在对话插件（L3）里。做成**软取**（不写 `static inject`）是有意的：硬依赖会把浏览器层 /
 * 会话层 / 外发层绑成对话插件的下游，「在调试面板里单独摘掉 agent」就会连带把 L2 降为 PENDING，
 * 而插件可单独摘是 1.5-03/04 已验收过的行为。这条选择的代价与补偿写在 plan §15.7 落点 2。
 * @param ctx 调用方的上下文
 * @returns 登记面；对话插件没装时为 undefined，此时能力包只是没有工具可登记，自身照常启动
 */
export function agentToolsOf(ctx: Context): AgentToolRegistry | undefined {
  return maybeService<AgentToolRegistry>(ctx, 'agent.tools');
}

/** 声明表的宿主：`WeakMap` 让「摘掉整个 app」不留引用，也不给测试之间共享状态（每 boot 一个新 Context）。 */
const toolTables = new WeakMap<Context, Map<string, AgentToolDeclaration>>();

/**
 * 每个应用上下文一份的工具声明表（spec 2.8-08 活体实测之后的补偿）。
 *
 * 为什么要按上下文存而不是存在注册表服务的实例字段里：2.8-b 的活体收口实测过一次
 * `plugins.saveConfig('agent', {})`——cordis 把 `agent` 这一组 fiber 整个重建，新的
 * `AgentToolsService` 实例带着一张空表上岗，而九个工具的主人（L2 能力包）没有被重建，
 * 于是清单从 9 条变成 0 条，界面上从此「什么都调不到」却没有任何一处报错（plan §15.7 落点 2
 * 要求实测的正是这一条）。表的生命周期属于「这个 app」，登记动作也属于这个 app，
 * 所以它跟着 app 走；服务实例只是这张表的一张读面，重建多少次都不会丢内容。
 * 摘掉某个能力包仍然会让它的工具消失：`registerAgentTools` 挂的清理是从这张表里删。
 *
 * 键取 `ctx.root` 而不是 `ctx` 本身，是本机实测出来的（同 AGENTS.md §6.2「文档转述不可信」）：
 * cordis 每次 `ctx.plugin` 都 `parent.extend({ fiber })` 造一个作用域上下文，方法经代理调用时
 * `this.ctx` 还会指向 caller 那侧的影子上下文——按 `ctx` 存的话登记表会随调用点裂成好几张，
 * 连「在同一个实例上 register 之后 list」都不成立。`root` 则是构造时就冻结的那个 app 代理。
 * @param ctx 当前服务的上下文（内部只取它的 `root`）
 * @returns 该 app 独有的声明表；顺序即登记顺序
 */
export function agentToolTable(ctx: Context): Map<string, AgentToolDeclaration> {
  const host = ctx.root;
  const existing = toolTables.get(host);
  if (existing) return existing;
  const created = new Map<string, AgentToolDeclaration>();
  toolTables.set(host, created);
  return created;
}

/**
 * 原样返回一份工具声明，只为把 `input` 的解析结果类型推给 `run` 的入参（spec 2.8-08）。
 *
 * 直接把对象字面量塞进 `registerAgentTools` 的数组里时，`run` 的入参只能按声明的默认 `unknown`
 * 处理，解构出来的字段就成了 `any`——那条路把「schema 收窄之后才递给实现」这个保证在类型上抹平了
 * （AGENTS.md §2.6：边界校验只在系统边界做，而工具入参正是边界）。
 * 套上这一层之后 `I` 由 schema 反推，字段名写错就是编译期错误。
 * @template I schema 解析后的入参类型（由 `input` 推出，不需要手写）
 * @template R 本次产出类型（由 `run` 返回的 `ToolResult.value` 推出）
 * @param tool 工具声明
 * @returns 同一个声明，只是带着收窄后的类型参数
 */
export function agentTool<I, R>(tool: AgentToolDeclaration<I, R>): AgentToolDeclaration<I, R> {
  return tool;
}

/**
 * 把一组工具登记进 agent 工具注册表，并在本服务销毁时摘回去（spec 2.8-08）。
 *
 * 六个能力包要做的是同一件事，所以抽在这里（AGENTS.md §2.2）；摘回这一步尤其不能各写一遍：
 * 服务被热改配置重建之后，旧实例登记的 `run` 闭包还吊在表里，下一次调用会打进一个已经销毁的实例，
 * 得到的是无法解释的错误（同 `jd-capture.ts:349` 记过的那条理由）。
 * `ctx.effect` 的回调必须**返回**清理函数——写成单层箭头就是刚挂载就清理（AGENTS.md §9 的 1.3 实测条）。
 * @param ctx 登记方（能力包服务）的上下文
 * @param tools 本包对外声明的工具契约，数组顺序即注册表清单顺序
 * @returns 实际登记的条数；注册表没装时返回 0，调用方要把这个数打进日志，别让它静默
 */
export function registerAgentTools(ctx: Context, tools: readonly AgentToolDeclaration[]): number {
  const registry = agentToolsOf(ctx);
  if (!registry) return 0;
  for (const tool of tools) registry.register(tool);
  ctx.effect(() => () => tools.forEach((tool) => registry.unregister(tool.id)));
  return tools.length;
}

/**
 * 取打招呼渠道的询问面（spec 2.5-02 的外发口），实现方是 `platform.registry`。
 *
 * 为什么按服务名要而不是 `asApp`：outbound 与 browser 同级，import 包会新开一条横向依赖
 * （AGENTS.md §4.1），所以形状留在 L0、由 core 露手；`platform.registry` 结构上满足它即可。
 * @param ctx 调用方的上下文
 * @returns 询问面实例；浏览器层没装时为 undefined，此时打招呼一律以缺渠道失败
 */
export function greetChannelsOf(ctx: Context): GreetChannelSource | undefined {
  return maybeService<GreetChannelSource>(ctx, 'platform.registry');
}

/**
 * 取简历投递渠道的询问面（spec 2.6-01 / 02 的外发口），实现方同样是 `platform.registry`。
 *
 * 与 `greetChannelsOf` 分两个函数而不是并成一个接口：两个能力的**判据不同**
 * （`chat` 能力 vs `sendResume` 能力），合并会让「装了会话页但还没有上传靶页」这种中间态
 * 在类型上无法表达。名字仍按服务名要，理由同上一条（AGENTS.md §4.1）。
 * @param ctx 调用方的上下文
 * @returns 询问面实例；浏览器层没装时为 undefined，此时投递一律以缺渠道失败
 */
export function deliverChannelsOf(ctx: Context): ResumeChannelSource | undefined {
  return maybeService<ResumeChannelSource>(ctx, 'platform.registry');
}

/**
 * 取「这条岗位等到回复没有」的询问面（spec 5.7-03），实现方是 `jd.store`。
 *
 * 做成**可选**而不是硬依赖：择机规则只在无人值守那一路生效，而投递服务在只装了平台适配器、
 * 还没跑过抓取的进程里也要能用——那时问不到回复状态，规则按「不猜」处理（见 `JdReplyStatusSource`）。
 * @param ctx 调用方的上下文
 * @returns 询问面实例；JD 库没挂载时为 undefined
 */
export function jdReplyStatusOf(ctx: Context): JdReplyStatusSource | undefined {
  return maybeService<JdReplyStatusSource>(ctx, 'jd.store');
}

/**
 * 取「这个岗位键在库里有没有一条记录」的询问面（spec 5.7-f），实现方同样是 `jd.store`。
 *
 * 与上面一问同为**可选**：话术服务在只装了 outbound、没装平台包的进程里也要能产文案
 * （界面手填一条岗位也能生成），那时问不到就放行——这是有意为之的弱保证，
 * 判据与理由都写进 spec，不让它变成一个悄悄生效的开关。
 * @param ctx 调用方的上下文
 * @returns 询问面实例；JD 库没挂载时为 undefined
 */
export function jdKeySourceOf(ctx: Context): JdKeySource | undefined {
  return maybeService<JdKeySource>(ctx, 'jd.store');
}

/**
 * 取页面动作的节奏（spec 2.7-04），实现方是 `outbound.throttle`。
 *
 * 与上面两问不同，这里**不做可选降级**：调用方把 `outbound.throttle` 写进了 `static inject`，
 * 依赖没满足时它根本不会 init，所以取不到就是装配被改坏了，让 cordis 的 `ctx.get` 直接抛。
 * 降级成「没有节流就立刻动手」才是真正危险的——那等于给抓取开了一个绕过唯一节奏归属的默认分支。
 * @param ctx 调用方的上下文
 * @returns 节奏服务的窄投影（只有 `nextScrollGapMs`）
 */
export function pagePacerOf(ctx: Context): PagePacer {
  const pacer = ctx.get('outbound.throttle') as PagePacer;
  return pacer;
}

/**
 * 取首次风险签字的询问面（spec 2.7-06 的释放路径硬拦），实现方是 `sessions`。
 *
 * 与 `pagePacerOf` 同一条理由做**硬依赖**（不做 undefined 降级）：签字记录读不到就等于没签过，
 * 降级成「拿不到判据就放行」正是这条护栏要防的那件事。调用方（`outbound.greet` / `outbound.deliver` /
 * `jd.capture`）都把 `sessions` 写进了 `static inject`，依赖没满足时它们根本不会 init。
 * @param ctx 调用方的上下文
 * @returns 签字询问面的窄投影（`hasConsent` / `ensureConsent`）
 */
export function consentGateOf(ctx: Context): ConsentGate {
  return ctx.get('sessions') as ConsentGate;
}

/**
 * 取人工接管态的询问面（spec 5.5-02），实现方是 `browser.takeover`。
 *
 * 与 `pagePacerOf` / `consentGateOf` 同一条理由做**硬依赖**（不返回 undefined）：要把它的是判定口
 * 与循环，两者都把 `browser.takeover` 写进了 `static inject`，装配没满足时它们根本不会 init。
 * 做成「拿不到就当没在接管」的软降级恰好是这条护栏要防的那件事——**接管态未知就照动手**，
 * 于是 5.5-02 判的「接管期间 agent 不发出任何动作」会在摘掉一个插件之后静默失效。
 * @param ctx 调用方的上下文
 * @returns 接管态的窄询问面（只有 `held()`，没有 begin / end：解除是人的手，见 `TakeoverStateSource`）
 */
export function takeoverStateOf(ctx: Context): TakeoverStateSource {
  return ctx.get('browser.takeover') as TakeoverStateSource;
}

/**
 * 取向量网关（spec 4.3-07 / 08 的可选增强），实现方是 `llm.embed`。
 *
 * 做成**软取**（不写 `static inject`）是 4.3-04 的前提：知识库必须在「没装向量插件、没配 key、
 * 断了网」时照常检索，硬依赖会让摘掉 `llm-embed` 连带把 `kb-profile` 降成 PENDING。
 * 与 `agentToolsOf` / `greetChannelsOf` 同一套路：形状在 L0，实现方结构上满足，调用方现问现用
 * （AGENTS.md §9 的 2.5 实测条——存第二份事实会在热改配置后静默变空）。
 * @param ctx 调用方的上下文
 * @returns 询问面；`llm.embed` 没装时为 undefined，此时调用方退回纯词面检索并如实报 `unavailable`
 */
export function embedGatewayOf(ctx: Context): EmbedGateway | undefined {
  return maybeService<EmbedGateway>(ctx, 'llm.embed');
}

/**
 * 取对话模型网关（spec 4.4-02 的可选增强），实现方是 `llm.chat`。
 *
 * 与 `embedGatewayOf` 同一条理由做成**软取**：4.4-02 要的是「模型不可用时词面拆解照常出结果、
 * 功能不中断」，而 `static inject = ['llm.chat']` 会把这条腿变成硬依赖——摘掉 `llm-chat` 就连带
 * 让 `kb-gap` 降成 PENDING，那是与本条目相反的验收。`outbound.script` 之所以敢用硬依赖，是因为
 * 它没有「没有模型也照样成立」的形态（模板回落到最后仍要产出话术），而本服务在词面腿就有独立产出。
 * @param ctx 调用方的上下文
 * @returns 询问面；`llm.chat` 没装时为 undefined，此时调用方退回纯词面拆解并如实报 `disabled` / `unavailable`
 */
export function chatGatewayOf(ctx: Context): ChatGateway | undefined {
  return maybeService<ChatGateway>(ctx, 'llm.chat');
}

/** Service name convention: `域.能力`, e.g. `store.db`, `jd.store`. */
export type ServiceName = string & {};

export * from './errors.js';
export * from './events.js';
export * from './operators.js';
export * from './paths.js';
export * from './sql.js';
export * from './concurrency.js';
export * from './pending-channel.js';
export * from './redact.js';
export * from './numbers.js';
