/**
 * 「一句陈述 → 支撑它的实体」的确定性反查（spec 4.2-03，plan §1.4 4.2-b）。
 *
 * 为什么必须是确定性算法而不是让模型自评：4.5-06 与 §8.4 要求「LLM 不得编造公司/职位/时间/数字」，
 * 而「这句话有没有证据支撑」正是编造最顺手的地方——把判定交给模型，模型既当运动员又当裁判，
 * 事实锁定就退化成一句提示词。这里只用 token 集合的包含与重叠，同样的输入永远给同样的排序，
 * 单测才能把「命中正确项目」写成断言（4.2-03 的验证操作）。
 *
 * 计分口径（两个方向取大，而不是先判包含再算重叠）：
 * - `陈述覆盖率 = |交集| / |陈述 token|`：陈述里的词有多少落在这条实体上（短句整段命中时为 1）。
 * - `实体覆盖率 = |交集| / |实体 token|`：实体内容有多少被这句话提到（技能这种单 token 实体被点名时为 1）。
 * 取两者的最大值，就同时得到「归一化包含」与「词重叠」两种语义。
 * **不用 `String.includes` 判包含**：技能 `Go` 会被 `logo` 里的两个字母命中，
 * 而按 token 比时 `go` 与 `logo` 是两个不同的词，误命中不会发生。
 */
import type { KbEntityKind } from './entities.js';
import { tokenize } from './tokenize.js';

/** 命中理由：`contains` 一侧被另一侧完全覆盖，`overlap` 只有部分词重合。界面按码取 i18n 文案，不显示英文。 */
export type EvidenceReason = 'contains' | 'overlap';

/** 参与反查的一条候选（由 `kb.profile` 从库里投影出来，本文件不认识 SQLite）。 */
export interface EvidenceTarget {
  readonly entityId: string;
  readonly kind: KbEntityKind;
  /** 该实体所有载荷字段拼成的可比文本。 */
  readonly text: string;
}

/** 一条反查命中。 */
export interface EvidenceRef {
  readonly entityId: string;
  readonly kind: KbEntityKind;
  /** 0～1 的匹配强度，已按 4 位小数取整（浮点尾差会让断言和去重都不稳定）。 */
  readonly score: number;
  readonly reason: EvidenceReason;
  /** 命中的 token（升序），用于界面解释「为什么是这条」。 */
  readonly matchedTokens: readonly string[];
}

/** 反查的可调项（来自 `kb.profile` 的配置，代码内不留魔法数，同 4.3-03 的口径）。 */
export interface EvidenceOptions {
  readonly topK: number;
  readonly minScore: number;
}

/**
 * 实体载荷 → 可比文本。
 *
 * 键先排序再拼接：载荷的键序来自派生顺序，同一内容换了键序不该给出不同分数。
 * @param payload 实体载荷
 * @returns 换行连接的文本；空载荷返回空串（调用方会把它当「没有可比内容」跳过）
 */
export function evidenceTextOf(payload: Readonly<Record<string, string>>): string {
  return Object.keys(payload)
    .sort()
    .map((key) => payload[key])
    .join('\n');
}

/**
 * 两个 token 集合之间的词面覆盖强度（4.2-03 与 4.3-01 共用的一份尺子）。
 *
 * 抽成函数而不是在 `rankEvidence` 里内联：4.3-b 的检索要把同一份覆盖率与 BM25 分数合并排序，
 * 同一段判定出现第二次就必须抽公共层（AGENTS.md §2.2），否则反查与检索会在「什么算沾边」上走散。
 * @param claimTokens 一侧的 token 集合（陈述或查询，方向不影响结果）
 * @param targetTokens 另一侧的 token 集合（实体正文或切片正文）
 * @returns 命中为 0 时返回 `null`（「没有任何词重合」不是 0 分而是「无从解释」，调用方据此跳过）；
 *          否则给 0～1 的强度、命中的 token（升序）、以及 `contains` / `overlap` 判定
 */
export function coverageOf(
  claimTokens: ReadonlySet<string>,
  targetTokens: ReadonlySet<string>,
): { score: number; matched: string[]; reason: EvidenceReason } | null {
  if (claimTokens.size === 0 || targetTokens.size === 0) return null;
  const matched: string[] = [];
  for (const token of claimTokens) {
    if (targetTokens.has(token)) matched.push(token);
  }
  if (matched.length === 0) return null;
  const score = Math.max(matched.length / claimTokens.size, matched.length / targetTokens.size);
  return {
    score: Math.round(score * 10_000) / 10_000,
    matched: matched.sort(),
    reason: score >= 0.9999 ? 'contains' : 'overlap',
  };
}

/**
 * 给一句陈述找支撑实体，按强度排序返回。
 * @param claim 待反查的陈述（简历里的一句话、或 JD 的一条要求）
 * @param targets 候选实体（通常是某次 `list()` 的投影）
 * @param options `topK` 最多返回几条、`minScore` 低于此强度不算支撑
 * @returns 命中列表；陈述或候选分词后为空时返回空数组，不抛错——「查无支撑」是正常态，
 *          不是失败（4.5 的可解释性靠它区分「有证据」与「这条是模型编的」）
 */
export function rankEvidence(
  claim: string,
  targets: readonly EvidenceTarget[],
  options: EvidenceOptions,
): EvidenceRef[] {
  const claimTokens = tokenize(claim);
  if (claimTokens.size === 0 || options.topK <= 0) return [];

  const hits: EvidenceRef[] = [];
  for (const target of targets) {
    const covered = coverageOf(claimTokens, tokenize(target.text));
    if (covered === null || covered.score < options.minScore) continue;
    hits.push({
      entityId: target.entityId,
      kind: target.kind,
      score: covered.score,
      reason: covered.reason,
      matchedTokens: covered.matched,
    });
  }
  // 分数相同的按 id 升序：不依赖候选来自 `list()` 的排序，两次调用必然同一结果。
  return hits
    .sort((left, right) => right.score - left.score || (left.entityId < right.entityId ? -1 : 1))
    .slice(0, options.topK);
}
