/**
 * 简历定制内容的**模型腿**纯函数面（spec 4.5-01 / 03 / 05 / 07 的代码半边，plan §4.5 判据四 / 六）。
 *
 * 这一层不认识 cordis、不开连接、不发请求（同 4.4-b 的 `requirements-model.ts`）：它只做三件事——
 * 把要改写的散文递给模型看、把它的回答读成一份可判的改写清单、把清单装回文档。
 * 请求、重试、落库、播报都在 `generate-service.ts`。
 *
 * 四条刻意的形状（都是判据，不是风格）：
 *
 * 1. **回答的形状只有「改写」，没有「新增」**（4.5-07 的强保证在结构面）：契约是
 *    `{entries:[{sectionId, entryId, fieldKey, text}]}` 的 `strictObject`，四个键之外多一个键即非法。
 *    模型**表达不出**「新增一段经历 / 新增一个区块 / 新增一个字段」，所以「编出一段没做过的经历」
 *    不需要一条比对规则去抓——它在数据结构上不成立（plan §4.5 判据六）。
 *    词面的组织名回查（`fact-check.ts`）只是补刀，不是这一条的主力。
 * 2. **位置由服务给，不由模型挑**：清单来自 `generationTargetFields()`（散文键白名单），
 *    模型只能在这份清单里回填三个 id。对不上清单的回答按丢弃计数，绝不「就近猜一个位置」——
 *    把改写落到哪条经历上是产品决定，不是解码器决定。
 * 3. **原文一起给它看**：不让模型凭 JD 编内容，而是让它**改写这一句**，并把
 *    「数字必须原样保留、不得出现清单外的机构 / 人名」写进 system。说归说，真正的把关在
 *    `verifyGeneration()`（4.5-04 的确定性代码），模型自述一律不采信。
 * 4. **一次改写 = 一处位置**：与原文逐字相同的条目直接丢弃（计入 `droppedUnchanged`），
 *    于是「模型一条都没改」收敛成 `accepted` 为空 → 服务播报 `rejected`，
 *    而不是产出一份与基线完全相同、看起来像成功过的产物。
 *
 * 隐私口径（AGENTS.md §8.5）：提示词**会把库内正文发给已配置的模型**——这是 4.5 的功能本身
 * （与 4.4 把 JD 正文发出去拆解、2.5 把岗位信息发出去写话术同一条路），不是泄露；
 * 所以 `allowModelLeg=false` 就是纯本地路径（4.5-09 的保守版），而日志与生成记录表仍只落计数与路径。
 */
import type { ResumeDocument } from '@auto-cc/plugin-resume-doc';
import { z } from 'zod';
import type { GenerationField } from './fact-check.js';
import { stripFence } from './requirements-model.js';

/**
 * 生成腿的提示词版本（沿用 4.4-a 的 `jdreq-v1` 与 2.5-09 的 `scriptVersion` 口径）：
 * 改提示词必须同时改它，否则 4.5-10 复盘时分不清某份产物是哪一版产的。
 */
export const GENERATE_PROMPT_VERSION = 'resume-generate-v1';

/** 一条通过契约与位置校验的改写（带着原文，装回文档时按位置逐处替换）。 */
export interface GeneratedRewrite {
  readonly sectionId: string;
  readonly entryId: string;
  readonly fieldKey: string;
  /** 清单里那一处的原正文（位置对不对的第二道确认，也是校验腿的基线侧）。 */
  readonly originalText: string;
  readonly rewrittenText: string;
}

/** 一次模型输出的读取结果。 */
export interface ModelRewriteRead {
  /** 通过契约、位置对得上、且确实改写了的条目 */
  readonly accepted: readonly GeneratedRewrite[];
  /** 整份回答不可用时的原因（供界面播报）；可用时为 null */
  readonly reason: string | null;
  /** 不合契约（缺键、多键、类型不对、正文超上限）而被丢弃的条数 */
  readonly droppedInvalid: number;
  /** 位置不在待改写清单里的条数（模型自造位置 = 4.5-07 想拦的那类，按丢弃处理） */
  readonly droppedUnknown: number;
  /** 同一个位置被回答多次而丢弃的条数（保留第一条） */
  readonly droppedDuplicate: number;
  /** 与原文逐字相同而丢弃的条数（不算违规，但要能看出「模型其实没改」） */
  readonly droppedUnchanged: number;
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
): Array<{ role: 'system' | 'user'; content: string }> {
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

/** 模型契约的一条：四个键之外多一个键即非法（判据六的形状保证就落在这个 `strictObject` 上）。 */
const rewriteSchema = z.strictObject({
  sectionId: z.string().min(1).max(80),
  entryId: z.string().min(1).max(80),
  fieldKey: z.string().min(1).max(40),
  text: z.string().min(1),
});

/**
 * 位置定位键：三段 id 拼一条不可歧义的串。
 *
 * 为什么带 `sectionId` 而不只用 `entryId`：条目 id 只在区块内保证唯一（解析层按
 * `${kind}-${序号}` 生成，手工文档不保证），少一段就可能把改写落到另一个区块的同名条目上。
 * @param location 位置的三个 id
 * @returns 以竖线连接的键（三类 id 里都不出现竖线，所以不会互相吃掉）
 */
function locationKeyOf(location: { sectionId: string; entryId: string; fieldKey: string }): string {
  return `${location.sectionId}|${location.entryId}|${location.fieldKey}`;
}

/**
 * 读一份模型输出：解析 JSON、逐条校验契约、逐条对回待改写清单。
 *
 * 与 4.4 的拆解腿同一个口径：**能对回本地方位的才收**，收不下就计数并给一句可播报的原因，
 * 不"就近猜位置"，也不把整份回答因为一条乱写就全丢（那样一条幻觉会打断合法改写）。
 * @param rawText 模型回复正文（可能带代码围栏）
 * @param targets 提示词里给出的那份清单（同一个数组，位置才对得回去）
 * @param maxRewriteChars 单段改写的长度上限（模型跑飞时的一句保险，值来自 `kb.generate` 配置）
 * @returns 可安装的改写 + 四个丢弃计数；整份不可用时 `reason` 非 null 且 `accepted` 为空
 */
export function readModelRewrites(
  rawText: string,
  targets: readonly GenerationField[],
  maxRewriteChars: number,
): ModelRewriteRead {
  const empty = {
    accepted: [] as GeneratedRewrite[],
    droppedInvalid: 0,
    droppedUnknown: 0,
    droppedDuplicate: 0,
    droppedUnchanged: 0,
  };
  const text = stripFence(rawText);
  if (text.length === 0) return { ...empty, reason: '模型返回空内容' };
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ...empty, reason: '模型产出不是合法 JSON' };
  }
  const claims = (payload as { entries?: unknown }).entries;
  if (!Array.isArray(claims)) return { ...empty, reason: '模型产出缺少 entries 数组' };

  const byLocation = new Map(targets.map((target) => [locationKeyOf(target), target]));
  const accepted: GeneratedRewrite[] = [];
  const taken = new Set<string>();
  let droppedInvalid = 0;
  let droppedUnknown = 0;
  let droppedDuplicate = 0;
  let droppedUnchanged = 0;

  for (const claim of claims) {
    const parsed = rewriteSchema.safeParse(claim);
    if (!parsed.success || parsed.data.text.length > maxRewriteChars) {
      droppedInvalid += 1;
      continue;
    }
    const key = locationKeyOf(parsed.data);
    const target = byLocation.get(key);
    // 位置对不上清单 = 模型在指一个我们没给它的位置（多半是它自己拼的 id），整条丢。
    if (target === undefined) {
      droppedUnknown += 1;
      continue;
    }
    if (taken.has(key)) {
      droppedDuplicate += 1;
      continue;
    }
    if (parsed.data.text === target.text) {
      droppedUnchanged += 1;
      continue;
    }
    taken.add(key);
    const validated = parsed.data;
    accepted.push({
      sectionId: validated.sectionId,
      entryId: validated.entryId,
      fieldKey: validated.fieldKey,
      originalText: target.text,
      rewrittenText: validated.text,
    });
  }

  if (accepted.length === 0) {
    const dropped = droppedInvalid + droppedUnknown + droppedDuplicate + droppedUnchanged;
    const reason =
      claims.length === 0
        ? '模型未提出任何改写'
        : dropped === droppedUnchanged
          ? `模型返回的 ${String(droppedUnchanged)} 条与原文逐字相同，等于没有改写`
          : `模型产出的 ${String(claims.length)} 条均无法采信（位置对不上清单或不合契约）`;
    return { accepted, droppedInvalid, droppedUnknown, droppedDuplicate, droppedUnchanged, reason };
  }
  return { accepted, droppedInvalid, droppedUnknown, droppedDuplicate, droppedUnchanged, reason: null };
}

/**
 * 把改写装回文档，产出一份**提议态**文档（不改入参，也不碰 `updatedAt`）。
 *
 * 只替换命中的那几个 `field.value`，其余对象一律沿用同一份引用：`verifyGeneration` 按 id 对齐比对，
 * 因此它看到的"未被要求改动的地方"必然逐字相同（4.5-03 的原样引用一半由这条构造保证，一半由校验拦）。
 * `locked` / `factKey` 原样保留——被改写的 `achievement` 在模型里仍是标锁字段，
 * 允许它被改写的是 `GENERATION_EDITABLE_KEYS` 那份白名单，不是把标记改掉。
 * @param document 基线文档
 * @param rewrites `readModelRewrites` 收录的改写
 * @returns 新文档；`rewrites` 为空时返回一份 sections 数组相同、内容逐字相同的文档
 */
export function applyRewrites(document: ResumeDocument, rewrites: readonly GeneratedRewrite[]): ResumeDocument {
  const byLocation = new Map(rewrites.map((rewrite) => [locationKeyOf(rewrite), rewrite]));
  const sections = document.sections.map((section) => {
    const entries = section.entries.map((entry) => {
      let changed = false;
      const fields = entry.fields.map((field) => {
        const rewrite = byLocation.get(`${section.id}|${entry.id}|${field.key}`);
        if (rewrite === undefined) return field;
        changed = true;
        return { ...field, value: rewrite.rewrittenText };
      });
      return changed ? { ...entry, fields } : entry;
    });
    return entries.some((entry, index) => entry !== section.entries[index]) ? { ...section, entries } : section;
  });
  return { ...document, sections };
}
