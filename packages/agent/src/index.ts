/**
 * `@auto-cc/plugin-agent`（spec 1.11）：对话式主界面的接线面。
 *
 * 两个服务、两个清单 id（与 1.9 的 `usage` / `entitlement` 同形，可被单独摘掉）：
 * `agent.tools` 是工具注册表与调用协议，P1 是**空表**；`chat.session` 是会话、消息、档位与流式假回复。
 * 跨进程的数据模型（消息、档位、工具元数据与结果联合）不在这里，在 `@auto-cc/core`——
 * 它们要出现在界面镜像里，而注册表本身（`AgentTool` 带 schema 与 `run`）永远不出主进程。
 * 本包的硬边界由 1.11-14 守着：不 import 任何平台 / 简历 / 外发能力，也不接 LLM。
 */
export { AgentToolsService, agentToolsConfigSchema } from './tools.js';
export type { AgentTool } from './tools.js';
export { CHAT_MIGRATION_VERSION, ChatSessionService, chatConfigSchema } from './session.js';
export type { ChatConfig } from './session.js';
