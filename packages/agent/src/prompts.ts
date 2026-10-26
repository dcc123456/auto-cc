/**
 * `agent` 包的计划器提示词注册表（spec 4.6-09 / plan 2026-10-26 §3.1）。
 *
 * 本包内**唯一**允许出现「发给模型的消息字面量」与「提示词版本常量」的文件，由
 * `scripts/check-prompts.ts` 机检（判据：别处的源码里出现 `role: 'system'` 消息对象或
 * `*_PROMPT_VERSION` 声明即 lint 失败）。收在一处的三条理由与 `outbound` / `resume-kb` 相同：
 * 改文案必须同一次改动里改版本；§8.4 的事实锁定与 §8.5 的脱敏要盯的就是这几句约束；
 * 这里只拼字符串、不碰任何传输（模型出口唯一性由 `check-llm-single-entry` 守着）。
 *
 * 计划器的两句提示词各管一件事：起草时把工具面与目标摆给模型，观察摘要时只许收成一句回报。
 * 业务映射一概不写进提示词——agent 层不认识平台与简历，候选只从注册表现给的清单里选。
 */
import type { ObservationRequest, PlanDraftRequest } from './loop/model.js';

/** 计划器提示词版本：改任何一句都要与文案同批改它，复盘靠这一列分辨产出属于哪一版。 */
export const PLANNER_PROMPT_VERSION = 'planner-v1';

/** 观察摘要提示词版本（与计划器分开：两句改动的理由不同，混成一个版本就分不清是哪一处变了）。 */
export const OBSERVER_PROMPT_VERSION = 'observer-v1';

/**
 * 规划提示词（system）。
 *
 * 工具清单在调用时拼在后面：模型只能从注册表里选，提示词里不写死任何业务映射
 * （agent 层不认识平台与简历，§3.4 也要求意图里说清取材走了哪一路）。
 */
export const PLAN_SYSTEM_PROMPT = [
  '你是一次求职自动化任务里的计划器。只输出严格 JSON，不要解释、不要 markdown 代码块。',
  '输出形状：{"steps":[{"toolId":"工具 id","intent":"一句中文说明","input":{}}]}',
  '规则：',
  '1. toolId 只能从下面清单里选，一个都不许自造；',
  '2. input 按该工具自己的参数形状给，缺的字段可以不写；',
  '3. 岗位 id 只能取自已落步的观察或抓取工具交回的清单，不许自己编号；',
  '4. 搜岗位的关键词与城市优先取「在线简历」里的求职意向；没有意向时用技能与经历推导，并在 intent 里写明用了哪一路；',
  '5. 只读工具不需要人批准，写与出网的动作按工具清单里的副作用级自行安排顺序；',
  '6. 实在没有可执行的步骤就输出 {"steps":[]}。',
].join('\n');

/** 观察摘要提示词（system）：只要一句话，不要复述整段工具正文。 */
export const SUMMARY_SYSTEM_PROMPT =
  '把一条工具执行结果收成一句中文回报，不超过 80 字；不要复述参数、不要编造没出现过的结果。只输出这一句。';

/**
 * 把工具清单拼成提示词里的可读行。
 * @param request 起草请求（`tools` 缺省时只有 id，仍能列出，但少了用途说明）
 * @returns 每行 `- <id>（<effect>）：<description>`
 */
function renderToolCatalog(request: PlanDraftRequest): string {
  const briefs =
    request.tools ?? request.knownToolIds.map((id) => ({ id, description: '', effect: 'unknown' as const }));
  return briefs.map((tool) => `- ${tool.id}（${tool.effect}）：${tool.description}`).join('\n');
}

/**
 * 组装起草计划的两条消息（system 定规矩，user 给目标、已有上下文与工具面）。
 * @param request 起草请求（`context.text` 里可能带着循环取来的在线简历摘要）
 * @returns 直接可交给 `llm.chat.complete` 的消息数组
 */
export function buildPlanMessages(request: PlanDraftRequest): Array<{ role: 'system' | 'user'; content: string }> {
  const user = [
    `任务目标：${request.goal}`,
    request.context.text ? `已有上下文：\n${request.context.text}` : '',
    `可用工具：\n${renderToolCatalog(request)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return [
    { role: 'system', content: PLAN_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/**
 * 组装观察摘要的两条消息（system 只要一句，user 给这一步的工具、状态与读数）。
 * @param request 该步读数与状态
 * @returns 直接可交给 `llm.chat.complete` 的消息数组
 */
export function buildObservationMessages(
  request: ObservationRequest,
): Array<{ role: 'system' | 'user'; content: string }> {
  const input = [`工具：${request.step.toolId}`, `状态：${request.outcome}`, `读数：${request.reading}`].join('\n');
  return [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: input },
  ];
}
