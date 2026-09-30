/**
 * locator 的**纯逻辑层**（spec 2.2-01 / 2.2-02 / 2.2-05）。
 *
 * 分成两层是刻意的：页面里那段脚本只负责「把元素长成数据」（`locator-script.ts`），
 * 而**所有打分与判定都在这里**，于是「为什么这条候选赢」「什么时候拒绝猜测」
 * 可以不开 Electron 窗口就在单测里断言——这是 2.2 那三条 U 项能机检的原因。
 *
 * 判定口径沿用业界共识的三件套：策略稳定性权重 + 最低分阈值 + 与次优的最小分差，
 * 达不到就 **fail closed**（宁可报「不确定」也不猜一个点下去）。数值来自 plan §9.1 的取证，
 * 但阈值本身走配置（`browser.locate` 的 `minScore` / `minMargin`），代码里不写死（AGENTS.md §2.7）。
 */
import type {
  ElementFingerprint,
  LocateCandidate,
  LocatedReading,
  LocatedView,
  LocateSpec,
  LocateStatus,
  LocateStrategy,
} from '@auto-cc/shared';

/** 各策略的稳定性满分：越不依赖页面结构、越不会随改版漂移，分越高。 */
export const STRATEGY_WEIGHT: Record<LocateStrategy, number> = {
  testId: 100,
  id: 90,
  role: 85,
  name: 80,
  text: 70,
  css: 35,
  xpath: 25,
  // 指纹自愈不是「声明出来的策略」，它只在结果里出现，所以基线为 0：
  // 正常候选永远优先，自愈只在候选全部失配后才可能被选中（spec 2.2-05）。
  fingerprint: 0,
};

/** 文本「包含匹配」的折价：它比精确文本更容易撞到别的元素。 */
export const CONTAINS_DISCOUNT = 15;

/** 同一条件命中多个元素（真歧义）的折价。 */
export const AMBIGUOUS_HIT_PENALTY = 25;

/** 不可见 / 未启用 / 被遮挡的折价：动作前置判据不满足时不该赢，但也不清零（页面可能正在装载）。 */
export const NOT_VISIBLE_PENALTY = 30;
export const NOT_ENABLED_PENALTY = 20;
export const OBSTRUCTED_PENALTY = 20;

/**
 * 指纹自愈命中的基础分：够格用，但低于正经候选，保证正常路径永远优先。
 *
 * 必须**低于 `minScore`**：只剩标签名相同的元素不是「同一个控件」，而是页面上任意一个同类标签——
 * 基础分一旦过了线，改版后就会自愈到陌生人身上并点下去。过线要靠字段累计（角色 + 可读名 …），
 * 也就是说自愈至少需要两处独立特征吻合才允许动手（spec 2.2-05 的 fail-closed 底线）。
 */
export const FINGERPRINT_BASE_SCORE = 60;

/** 指纹重找时可比的属性键数上限——再多就是噪声，不是特征。 */
const FINGERPRINT_ATTRIBUTE_CAP = 4;

/** 像机器生成串的形状：长十六进制、hash 后缀、尾部一段数字。这类值下次构建就变了，不配拿高分。 */
export const GENERATED_VALUE = /^(?:[0-9a-f]{6,}|\w+-[0-9a-f]{5,}|\w*[-_]?\d{3,})$/i;

/** 可以安全拼进属性选择器的 HTML 属性名（知识包 → 页面脚本的边界校验）。 */
export const SAFE_ATTRIBUTE_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:.-]*$/;

/**
 * 判定一个 `data-*` 属性名能否拼进选择器。
 * @param name 知识包给出的属性名，例如 `data-testid`
 * @returns 合法属性名为 true；带引号、括号等选择器语法的一律 false（拒收，不让它进 CSS）
 */
export function isSafeAttributeName(name: string): boolean {
  return SAFE_ATTRIBUTE_NAME.test(name);
}

/**
 * 判定取值是否像机器生成的（构建 hash、自增 id 这类）。
 * @param value 属性值或文本
 * @returns 生成的为 true——这类候选会被硬压到低分，因为下次改版它就不存在了
 */
export function looksGenerated(value: string): boolean {
  return GENERATED_VALUE.test(value.trim());
}

/**
 * 校验一份定位声明是否可用。
 * @param spec 待校验的定位声明
 * @returns 非法原因列表；空数组即合法。校验失败**不进打分**，直接结构化失败
 */
export function validateSpec(spec: LocateSpec): string[] {
  const problems: string[] = [];
  if (spec.candidates.length === 0) problems.push('spec 没有任何候选策略');
  spec.candidates.forEach((candidate, index) => {
    const label = `候选 ${String(index)}（${candidate.strategy}）`;
    if (!(candidate.strategy in STRATEGY_WEIGHT)) {
      problems.push(`${label}：未知策略`);
      return;
    }
    if (candidate.strategy === 'role') {
      if (!candidate.role) problems.push(`${label}：缺少 role`);
      if (!candidate.name) problems.push(`${label}：缺少可读名 name`);
      return;
    }
    if (candidate.strategy === 'testId') {
      if (!candidate.attribute || !isSafeAttributeName(candidate.attribute)) {
        problems.push(`${label}：属性名非法（${candidate.attribute ?? '空'}）`);
      }
      if (!candidate.value) problems.push(`${label}：缺少 value`);
      return;
    }
    if (!candidate.value) problems.push(`${label}：缺少 value`);
  });
  return problems;
}

/** 一条候选的「匹配值」——打分时判断它像不像生成串用的那个串。 */
const matchValueOf = (candidate: LocateCandidate): string =>
  candidate.strategy === 'role' ? `${candidate.role ?? ''} ${candidate.name ?? ''}` : (candidate.value ?? '');

/**
 * 给一条页面回读打分。
 * @param reading 页面里读出的一条候选命中（还没分数）
 * @param candidate 它对应的声明项（用来判断是否精确文本匹配）
 * @returns 带 `score` 与逐条 `reasons` 的可解释结果
 */
export function scoreReading(reading: LocatedReading, candidate: LocateCandidate): LocatedView {
  const reasons: string[] = [`${reading.strategy} 基线 ${String(STRATEGY_WEIGHT[reading.strategy])}`];
  let score = STRATEGY_WEIGHT[reading.strategy];

  const value = matchValueOf(candidate);
  if (value && looksGenerated(value)) {
    score = Math.min(score, 10);
    reasons.push('匹配值像生成串，封顶 10');
  }
  if (candidate.strategy === 'text' && candidate.exact !== true) {
    score -= CONTAINS_DISCOUNT;
    reasons.push(`包含匹配 -${String(CONTAINS_DISCOUNT)}`);
  }
  if (reading.siblingCount > 1) {
    score -= AMBIGUOUS_HIT_PENALTY;
    reasons.push(`同条件命中 ${String(reading.siblingCount)} 个 -${String(AMBIGUOUS_HIT_PENALTY)}`);
  }
  if (!reading.visible) {
    score -= NOT_VISIBLE_PENALTY;
    reasons.push(`不可见 -${String(NOT_VISIBLE_PENALTY)}`);
  }
  if (!reading.enabled) {
    score -= NOT_ENABLED_PENALTY;
    reasons.push(`未启用 -${String(NOT_ENABLED_PENALTY)}`);
  }
  if (!reading.unobstructed) {
    score -= OBSTRUCTED_PENALTY;
    reasons.push(`被遮挡 -${String(OBSTRUCTED_PENALTY)}`);
  }
  return { ...reading, score, reasons };
}

/**
 * 排序：分数降序 → 候选声明顺序升序 → 帧内身份号升序。
 *
 * 后两个键保证**同样好的两个候选永远以同一顺序出现**（spec 2.2-02 要的「top-N 排序稳定」），
 * 也让「声明顺序即优先级」这条规则在平分时真正生效。
 * @param views 已打分的候选
 * @returns 新数组，不改入参
 */
export function rankScored(views: LocatedView[]): LocatedView[] {
  return [...views].sort(
    (left, right) =>
      right.score - left.score ||
      left.candidateIndex - right.candidateIndex ||
      left.frameUrl.localeCompare(right.frameUrl) ||
      left.nodeIndex - right.nodeIndex,
  );
}

/**
 * 把多条回读拍平成打分候选：先按元素身份去重（同一元素被多条策略命中只保留声明最靠前的），
 * 再排序。
 * @param readings 各帧各候选的命中
 * @param candidates 声明里的候选数组（用来取 `exact` 等判定字段）
 * @returns 排好序、带分数的候选列表
 */
export function toRankedCandidates(readings: LocatedReading[], candidates: LocateCandidate[]): LocatedView[] {
  const byIdentity = new Map<string, LocatedReading>();
  for (const reading of readings) {
    const key = `${reading.frameUrl}#${String(reading.nodeIndex)}`;
    const kept = byIdentity.get(key);
    if (!kept || reading.candidateIndex < kept.candidateIndex) byIdentity.set(key, reading);
  }
  return rankScored(
    [...byIdentity.values()].map((reading) =>
      scoreReading(reading, candidates[reading.candidateIndex] ?? { strategy: reading.strategy }),
    ),
  );
}

/** 择优判定的输入阈值。 */
export type LocateThresholds = { minScore: number; minMargin: number };

/** 一次择优判定的结果。 */
export type LocateDecision = { status: LocateStatus; chosen: LocatedView | null; reason: string };

/**
 * 从排好序的候选里择优，**达不到阈值就拒绝猜测**。
 * @param ranked `rankScored` 的输出（可以为空）
 * @param thresholds 最低分与最小分差（来自服务配置，不写在代码里）
 * @returns 状态、胜出候选与一句可显示的判定理由
 */
export function decideLocate(ranked: LocatedView[], thresholds: LocateThresholds): LocateDecision {
  const best = ranked[0];
  if (!best) return { status: 'not-found', chosen: null, reason: '所有候选都没命中元素' };
  if (best.score < thresholds.minScore) {
    return {
      status: 'below-score',
      chosen: null,
      reason: `最优候选 ${String(best.score)} 分低于最低可用分 ${String(thresholds.minScore)}`,
    };
  }
  const runnerUp = ranked[1];
  if (runnerUp && best.score - runnerUp.score < thresholds.minMargin) {
    return {
      status: 'ambiguous',
      chosen: null,
      reason: `与次优候选只差 ${String(best.score - runnerUp.score)} 分，小于最小分差 ${String(thresholds.minMargin)}`,
    };
  }
  return { status: 'matched', chosen: best, reason: `胜出候选 ${String(best.score)} 分（${best.strategy}）` };
}

/**
 * 用指纹给一条回读打分（spec 2.2-05 的自愈依据）。
 *
 * 一致度按字段累计：标签名必须相同（不同标签不是同一个控件，直接 0 分），
 * 其余字段命中一项加一分。**不做相似度阈值**——阈值交给 `decideLocate` 的 minScore，
 * 保持「一套阈值管两种来源」，否则配置里会长出第二个旋钮。
 * @param target 上一次成功定位留下的指纹
 * @param reading 当前页面里读出的一条元素描述
 * @returns 带分数与理由的候选（`candidateIndex` 固定 -1，表示它不来自声明候选）
 */
export function scoreByFingerprint(target: ElementFingerprint, reading: LocatedReading): LocatedView {
  const reasons: string[] = [];
  if (target.tagName.toLowerCase() !== reading.tagName.toLowerCase()) {
    return { ...reading, strategy: reading.strategy, score: 0, reasons: ['标签名不同，不是同一个控件'] };
  }
  reasons.push(`标签名 ${reading.tagName.toLowerCase()} 一致`);
  let score = FINGERPRINT_BASE_SCORE;
  if (target.role && target.role === reading.role) {
    score += 6;
    reasons.push(`角色 ${target.role} 一致 +6`);
  }
  if (target.accessibleName && target.accessibleName === reading.accessibleName) {
    score += 8;
    reasons.push(`可读名一致 +8`);
  }
  if (target.text && target.text === reading.text) {
    score += 4;
    reasons.push(`文本一致 +4`);
  }
  const matchedAttributes = Object.entries(target.attributes).filter(
    ([key, value]) => reading.attributes[key] === value,
  ).length;
  if (matchedAttributes > 0) {
    score += Math.min(matchedAttributes, FINGERPRINT_ATTRIBUTE_CAP) * 3;
    reasons.push(`稳定属性命中 ${String(matchedAttributes)} 项`);
  }
  if (target.ancestorRoles.join('/') === reading.ancestorRoles.join('/')) {
    score += 4;
    reasons.push('祖先角色链一致 +4');
  }
  const sharedAnchors = target.nearbyTexts.filter((text) => reading.nearbyTexts.includes(text)).length;
  if (sharedAnchors > 0) {
    score += sharedAnchors * 2;
    reasons.push(`周围文本锚点相同 ${String(sharedAnchors)} 处`);
  }
  return { ...reading, strategy: reading.strategy, score, reasons };
}
