/**
 * `resume-kb` 包的提示词注册表（spec 4.6-09）。
 *
 * 本包内**唯一**允许出现「发给模型的消息字面量」与提示词版本常量的文件，
 * 由 `scripts/check-prompts.ts` 机检（别处出现 `role: 'system'` 的消息对象或 `*_PROMPT_VERSION`
 * 声明即 lint 失败）。4.6-a 之前它们是散在两个模型腿文件里的（`generate-model.ts` 的改写腿、
 * `requirements-model.ts` 的拆解腿），本次**只搬家、不改一个字**——行为零变化由既有的
 * 4.4 / 4.5 用例（81 + 8 例）复跑自证，而不是靠"看起来一样"。
 *
 * 为什么要收在一处：这两段约束就是 §8.4 事实锁定红线的**唯一一处自然语言表达**（其余全在数据结构里：
 * `Field.locked`、`z.strictObject`、数字多重集守恒），散落时没人逐字读，改名与调措辞也无从核对版本。
 *
 * 全部文案为本仓库自写的中文表达：`.research-repos` 里 ai-resume 的 `server/src/prompts/*` 只借了
 * 「四类划分」与「重试附一段约束」这两个**口径**，本文案逐字未抄（plan §4.4-b 证据 [1]、§4.5 取证二）。
 */
import type { GenerationField } from './fact-check.js';

/**
 * JD 拆解腿的提示词版本（同 2.5-09 的 `scriptVersion` 与 4.4-a 的 `lexiconVersion` 口径）：
 * 改提示词必须同时改它，否则 4.4-07 复盘时分不清某份报告是哪一版产的。
 */
export const REQUIREMENT_PROMPT_VERSION = 'jdreq-v1';

/**
 * 生成腿的提示词版本（沿用上面的 `jdreq-v1` 与 2.5-09 的 `scriptVersion` 口径）：
 * 改提示词必须同时改它，否则 4.5-10 复盘时分不清某份产物是哪一版产的。
 */
export const GENERATE_PROMPT_VERSION = 'resume-generate-v1';

/** 发给模型的消息序列形状（与 `ChatGateway` 的请求侧一致，这里只拼字符串、不碰传输）。 */
export type PromptMessages = Array<{ role: 'system' | 'user'; content: string }>;

/**
 * 拼给模型的两句消息（system 定规矩，user 给原文）。
 *
 * 里面没有端点、没有模型名、也没有 key（AGENTS.md §2.7 的入口唯一性由 `check-llm-single-entry` 机检），
 * 传输全在 `llm.chat`。
 * @param jdText 待拆解的 JD 正文（去空白后）
 * @param limitPerKind 每类最多几条，进提示词约束模型别把整段技术清单倒出来
 * @returns 可直接交给 `ChatGateway.complete` 的消息序列
 */
export function buildRequirementMessages(jdText: string, limitPerKind: number): PromptMessages {
  const system =
    '你在帮中国求职者拆解招聘 JD 里的能力要求。只依据我给出的 JD 原文，不得引入原文没有的要求，' +
    '不得编造公司、岗位、技术名词或年限。' +
    `每一项给出：类别 kind（只能是 hard_skill / soft_skill / education / experience_years）、` +
    `代表词 label（用业界通用写法，同一能力只算一项）、原文引文 quote（必须逐字摘自 JD 原文，不超过 40 字）。` +
    `每类最多 ${String(limitPerKind)} 项。只输出 JSON，形如 {"items":[{"kind":"hard_skill","label":"React","quote":"精通 React"}]}，` +
    '不要输出解释、注释或代码块以外的任何文字。';
  return [
    { role: 'system', content: system },
    { role: 'user', content: `请拆解以下 JD 原文中的能力要求：\n${jdText}` },
  ];
}

/**
 * 重试那一轮的约束补强（spec 4.5-05 的「RETRY_APPEND 式」）。
 *
 * 拼在 system 后面而不是重发一遍清单：第一轮失败几乎都是「动了不该动的东西」，
 * 把上一轮的具体违规行原样贴回去，比再加一句「请谨慎」有用。
 * @param violationLines `describeViolations()` 的读数（已过脱敏，不含字段原文）
 * @returns 一段可直接追加的中文约束；没有读数时返回空串（调用方据此决定要不要追加）
 */
export function buildRetryAppendix(violationLines: readonly string[]): string {
  if (violationLines.length === 0) return '';
  return (
    '\n\n上一轮的改写未通过事实校验，违规项如下（只给路径与判据，不含原文）：\n' +
    violationLines.map((line) => `- ${line}`).join('\n') +
    '\n这一轮请只修掉这些问题：数值一个都不许增减或改写，机构名与专业名一律照抄，' +
    '拿不准就原样返回该条，不要为了润色而改动事实。'
  );
}

/**
 * 拼给模型的两句消息（system 定规矩，user 给清单与原文）。
 *
 * 里面没有端点、模型名、密钥（AGENTS.md §2.7 的入口唯一性由 `check-llm-single-entry` 机检），
 * 传输全在 `llm.chat`。
 * @param jdText 岗位 JD 正文（改写要贴合的方向，与 4.4 拆解用的是同一份字符串）
 * @param requirementLines 已拆出的要求短句（与缺口报告共用同一份读数，不让模型再拆一遍）
 * @param targets 待改写的散文位置（`generationTargetFields` 的产物，已按重排后的相关性顺序）
 * @param retryAppendix 第二轮才有的约束补强
 * @returns 可直接交给 `ChatGateway.complete` 的消息序列
 */
export function buildGenerateMessages(
  jdText: string,
  requirementLines: readonly string[],
  targets: readonly GenerationField[],
  retryAppendix = '',
): PromptMessages {
  const system =
    '你在帮中国求职者把已有简历改写得更贴合一个具体岗位。你只能改写我给出的句子，不能新增、不能编造。\n' +
    '规则：\n' +
    '1. 只输出 JSON，形如 {"entries":[{"sectionId":"experience","entryId":"experience-1","fieldKey":"achievement","text":"改写后的整段"}]}，' +
    '不要解释、不要注释；代码围栏可以有。\n' +
    '2. 每条必须原样回填我给它的 sectionId / entryId / fieldKey 三个值，text 是这一整段的新写法。\n' +
    '3. 数字与百分比一个都不许增减、不许改写成「大幅 / 显著」这类模糊词，也不许反过来凭空补一个数。\n' +
    '4. 公司名、学校名、专业名、职位名、时间范围一律照抄我给过的写法，不许出现任何新的机构名或人名。\n' +
    '5. 只在确实能更贴合岗位要求时改写；无话可改就把原文逐字返回。\n' +
    '6. 只改写清单里的位置，清单外的 sectionId / entryId / fieldKey 会被整条丢弃。' +
    retryAppendix;
  const listed = targets.map((target) => ({
    sectionId: target.sectionId,
    entryId: target.entryId,
    fieldKey: target.fieldKey,
    text: target.text,
  }));
  const user =
    `岗位 JD：\n${jdText.trim()}\n\n` +
    `这个岗位的能力要求：${requirementLines.length === 0 ? '（未拆出明确要求）' : requirementLines.join('、')}\n\n` +
    `待改写的段落清单（JSON）：\n${JSON.stringify(listed)}\n\n请按要求输出改写结果。`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
