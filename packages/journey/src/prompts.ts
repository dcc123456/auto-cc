/**
 * 面试材料的提示词注册表（M2-B 10.3-03）。
 *
 * 本项目把「发给模型的消息字面量」与版本常量的唯一落点钉在各包的 `src/prompts.ts`
 * （spec 4.6-09，`scripts/check-prompts.ts` 机检）。本包也遵守同一条：服务只拿这里产出的
 * 消息序列，不在 service 里拼第二份提示词。
 */
/** 本片提示词版本；改了提示词结构必须同步改它，回执里会带出去供复盘。 */
export const JOURNEY_INTERVIEW_PROMPT_VERSION = 'journey-interview-v1';

/** 一条可用的简历事实（正文已脱敏，来源 id 用于回指）。 */
export interface InterviewFact {
  readonly factId: string;
  readonly text: string;
}

/** 一条 JD 要求（id 由 `jdVersion` + 序号稳定派生，不允许模型另编）。 */
export interface InterviewRequirement {
  readonly requirementId: string;
  readonly label: string;
  readonly kind: string;
}

/** 发给模型的消息序列形状（与 `llm.chat` 的 `messages` 同形）。 */
export interface PromptMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

/**
 * 拼面试材料那一趟的提示词。
 * @param jdText 所选岗位的 JD 正文（与匹配解释用的是同一份字符串）
 * @param facts 母版事实清单（只含 id 与正文，不含联系方式）
 * @param requirements 本次 JD 的要求清单（id 已派生好）
 * @returns system + user 两条消息
 */
export function buildInterviewMessages(
  jdText: string,
  facts: readonly InterviewFact[],
  requirements: readonly InterviewRequirement[],
): PromptMessage[] {
  const factsJson = JSON.stringify(
    facts.map((fact) => ({ id: fact.factId, text: fact.text })),
    null,
    2,
  );
  const requirementsJson = JSON.stringify(
    requirements.map((item) => ({ id: item.requirementId, label: item.label, kind: item.kind })),
    null,
    2,
  );
  return [
    {
      role: 'system',
      content:
        '你是求职者的面试教练。只允许使用用户提供的简历事实与岗位要求作答：' +
        '不得编造公司、职位、时间、学历、数字或任何未提供的经历；' +
        '每条问答必须同时给出至少一个 resumeFactId 与一个 requirementId，且只能取给定清单里的 id。' +
        '输出必须是单个 JSON 对象，不要 Markdown 代码围栏。',
    },
    {
      role: 'user',
      content:
        `岗位 JD 原文：\n${jdText.trim()}\n\n` +
        `简历事实（JSON，id 必须原样引用）：\n${factsJson}\n\n` +
        `岗位要求（JSON，id 必须原样引用）：\n${requirementsJson}\n\n` +
        '请输出 JSON：{"selfIntro": string, "qa": [{"question": string, "answer": string, ' +
        '"resumeFactIds": string[], "requirementIds": string[]}], "checklist": string[]}。' +
        '要求：qa 至少 8 条；每题都要有具体问题与回答；checklist 至少 3 条准备事项。',
    },
  ];
}

/**
 * 一次请求使用的输出上限（token）：8 条问答加自我介绍需要比短话术更长的余量。
 * 写成常量而不是散在调用点，便于版本复盘时看清这一趟的预算。
 */
export const JOURNEY_INTERVIEW_MAX_TOKENS = 4096;

/** 提示词里那条「至少八条问答」的判据值；校验侧读同一个常量，避免两处各写一个 8。 */
export const JOURNEY_MIN_QA = 8;

/** 准备清单的下限（spec 10.3-03 的「准备清单」不得为空壳）。 */
export const JOURNEY_MIN_CHECKLIST = 3;

/** 本包的模型标识（回执里如实上报；未配置时由 `llm.chat` 抛 `LLM_UNAVAILABLE`，不回落样例）。 */
export const JOURNEY_MODEL_ID = 'journey-interview';
