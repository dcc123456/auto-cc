/**
 * `@auto-cc/plugin-agent`（spec 1.11 / 5.1 / 5.2）：对话式主界面的接线面。
 *
 * 七个服务、七个清单 id（与 1.9 的 `usage` / `entitlement` 同形，可被单独摘掉）：
 * `agent.tools` 是工具注册表与调用协议；`chat.session` 是会话、消息、档位与流式回复；
 * `agent.policy` 是「这一步现在能不能执行」的唯一判定口（5.2-02 / 07）；
 * `agent.pause` 是「这一步要人表态」时唯一的等待通道（5.3-08 / 09 / 10）；
 * `agent.loop` 是一次任务的「规划 → 执行 → 观察 → 续推」循环与它的落库记录（5.2-01 / 05 / 08 / 11）；
 * `agent.sediment` 是把跑通的对话投影成工作流计划的唯一口（5.4-01 / 02 / 09，落库经 `workflow.runner`）；
 * `agent.run` 是按引用回看那一步读数的唯一口（5.7-02，只读，路由到各归属服务）。
 * 跨进程的数据模型（消息、档位、工具元数据与结果联合、run 与步读数）不在这里，在 `@auto-cc/core`——
 * 它们要出现在界面镜像里，而注册表本身（`AgentTool` 带 schema 与 `run`）永远不出主进程。
 * 本包的硬边界由 1.11-14 与 5.1-08/09 守着：不 import 任何平台 / 简历 / 外发能力，5.2 也不接真 LLM。
 */
export { AgentToolsService, agentToolsConfigSchema } from './tools.js';
export type { AgentTool } from './tools.js';
export {
  CHAT_AUTONOMY_AUDIT_MIGRATION_VERSION,
  CHAT_MIGRATION_VERSION,
  ChatSessionService,
  chatConfigSchema,
  MAX_USER_INPUT_CHARS,
} from './session.js';
export type { ChatConfig } from './session.js';
export { AGENT_RUN_MIGRATION_VERSION, AgentLoopService, agentLoopSchema } from './loop/loop.js';
export type { AgentLoopConfig } from './loop/loop.js';
export { AGENT_POLICY_MIGRATION_VERSION, AgentPolicyService, agentPolicySchema } from './loop/policy.js';
export type { AgentPolicyConfig, PolicyCode, PolicyDecision, StepPermissionRequest } from './loop/policy.js';
export { AgentPauseService, agentPauseSchema, pauseKindLabel } from './loop/pause.js';
export type { AgentPauseConfig, PausePayload, PauseReply } from './loop/pause.js';
export { StubLoopModel } from './loop/model.js';
export type {
  LoopModel,
  ModelContext,
  ModelUsage,
  ObservationRequest,
  ObservationResult,
  PlanDraftRequest,
  PlanDraftResult,
  PlanStepDraft,
} from './loop/model.js';
export { AgentSedimentService, agentSedimentSchema, projectRun } from './loop/sediment.js';
export type { AgentSedimentConfig, SedimentLookups } from './loop/sediment.js';
export { agentEvidenceSchema, EvidenceRefService } from './loop/evidence.js';
export type { AgentEvidenceConfig } from './loop/evidence.js';
