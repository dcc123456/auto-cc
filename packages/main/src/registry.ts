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
  PlatformRegistryService,
} from '@auto-cc/plugin-browser';
import { ConfigService } from '@auto-cc/plugin-config';
import { DevtoolsService } from '@auto-cc/plugin-devtools';
import { EntitlementGateService, UsageLedgerService } from '@auto-cc/plugin-entitlement';
import { IpcGatewayService } from '@auto-cc/plugin-ipc';
import type { Registry } from '@auto-cc/plugin-kernel';
import { LogService } from '@auto-cc/plugin-logger';
import { OutboundSampleService } from '@auto-cc/plugin-outbound';
import { BossPlatformService } from '@auto-cc/plugin-platform-boss';
import { PluginsService } from '@auto-cc/plugin-plugins';
import { SessionsService } from '@auto-cc/plugin-sessions';
import { StoreService } from '@auto-cc/plugin-store';
import { WorkflowRunnerService } from '@auto-cc/plugin-workflow';
import { ShellService } from '@auto-cc/shell';

export const REGISTRY: Registry = {
  config: ConfigService,
  logger: LogService,
  store: StoreService,
  // 账本与闸门是同一个域的两个服务，所以各占一个清单 id：`gate` 能单独被摘掉，
  // 1.9-05 的「闸门缺席即拦不住就不许装」才有可演示的形态（摘掉闸门时账本还活着）。
  usage: UsageLedgerService,
  entitlement: EntitlementGateService,
  // 闸门之外的最薄消费者：它存在是为了让 1.9-06 的 grep 有对象可查（plan §8.4）。
  outbound: OutboundSampleService,
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
  // 平台登记处（spec 2.2-07）：适配器实例只在这里流通，渲染层只拿得到 `platform.registry.list`。
  'platform-registry': PlatformRegistryService,
  // BOSS 适配器（spec 2.2-06）：它在自己的 init 里把自己登记进上一行，`browser` 一行都不认识它。
  'platform-boss': BossPlatformService,
  // 工作流执行器骨架（spec 1.10）：六步占位流水线，真实步骤在 P2 换进来。
  workflow: WorkflowRunnerService,
  // 1.11 的对话骨架：注册表与会话各占一个清单 id，所以 `agent` 能被单独摘掉——
  // 摘掉后发消息仍然流式，只是工具调用一律 `TOOL_NOT_REGISTERED`（1.11-09 的可演示形态）。
  agent: AgentToolsService,
  chat: ChatSessionService,
  shell: ShellService,
};
