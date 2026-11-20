/**
 * `@auto-cc/plugin-journey`（M2-B spec 10.3）：求职主链的编排层。
 *
 * 对外只给服务与纯判据：编排层不认识任何选择器、不自己拼提示词、不自己校验事实。
 * 服务名 `journey`；三只 agent 工具与三个工作流节点共用同一组方法（§5.9 的「不许孤岛」）。
 */
export {
  JourneyService,
  journeySchema,
  JOURNEY_INTERVIEW_KIND,
  JOURNEY_SEARCH_KIND,
  JOURNEY_TAILOR_KIND,
  type JourneyConfig,
} from './journey-service.js';
// 纯判据对外是为了让单测直接打它们；服务层不再各自复制一份派生规则（AGENTS.md §2.2）。
export {
  criteriaFromIntent,
  intentViewOf,
  jdVersionOf,
  matchJob,
  parseInterviewJson,
  requirementIdOf,
  resumeVersionOf,
  sortMatches,
  validateInterviewKit,
  type IntentCriteria,
  type InterviewContext,
  type InterviewValidation,
} from './match.js';
export {
  buildInterviewMessages,
  JOURNEY_INTERVIEW_MAX_TOKENS,
  JOURNEY_INTERVIEW_PROMPT_VERSION,
  JOURNEY_MIN_CHECKLIST,
  JOURNEY_MIN_QA,
  JOURNEY_MODEL_ID,
  type InterviewFact,
  type InterviewRequirement,
  type PromptMessage,
} from './prompts.js';
// 无人值守执行器（第 5 片）：只按授权单顺序调既有服务，不建第二套 runner/存储/计数。
export * from './unattended.js';
