/**
 * 缺口比对阈值的**标定**工具（spec 4.4-03 / 4.4-04 的尺子半边，plan §4.4-e 判据三）。
 *
 * 它只回答一个问题：`coverageOf` 这把 token 尺子在人判标注集上，把分界线放在哪儿最站得住。
 * 五条立身之本：
 *
 * 1. **不重新实现任何打分**。读数一律来自 `coverageOf(tokenize(claim), tokenize(target))`，
 *    与 `compareByText` / `findHighlights` 用的是同一个函数、同一个方向（AGENTS.md §2.1/§2.5）。
 *    工具自己算一遍"理想分数"就是给标定造第二个真相。
 * 2. **零重合永远判缺失**。`coverageOf` 在两边没有任何共同 token（或一侧分词为空）时返 `null`，
 *    生产代码是直接 `continue`，所以任何阈值都动不了这类条目。它们不是"错分"而是**尺子的盲区**，
 *    单独列出来（`blindSpots`），不参与选值——否则一条语义等价的样本会把命中线拖到 0 附近，
 *    为了迁就一条本不该由词面负责的样本而毁掉整把尺子。
 * 3. **选值判据是"先错分最少，再最紧松弛量最大"**（plan §4.4-e 判据三的"取类间间隔最大，
 *    不取错分最少"）。每条标注对给定分界线有一个松弛量：判对时是"离翻脸还差多少"，
 *    判错时是"翻出去多少"（负值）。存在零错分候选时，等价于在可分带里取中点，即"间隔最大"；
 *    类带真实重叠时（本语料就有：`missing` 与 `partial` 在 0.3333 撞车）零错分点不存在，
 *    于是"间隔最大"退化成"翻出去得最少的折中"，翻脸条目全部列出来而不藏进汇总数字。
 *    两段各单独用都翻过车：只用错分条数→并列的一堆点贴着某条样本，换一条就翻；
 *    只用最紧松弛量→实测选出过 `partial=hit=0`（把有读数的东西全判成"命中"，"命中"样本到 0 线
 *    的距离反而最大）。细节见 `pickBestIndex`。
 *    最紧值本身也会并列（一条负余量把所有候选钉在同一个数上），所以第三判据是**整条松弛量
 *    剖面按位比大小**：最紧值相同就比第二紧、第三紧……于是落在类带的中间而不是贴着某条样本
 *    （实测第一版没有这一判据时选出了 `hit=0.51`，距 T14 的 0.5 只有一格——正是判据三禁止的
 *    "把阈值推到贴着某条"）。
 * 4. **一条不剩的标定等于没标**。选定值下的翻脸条目（阈值动得了的 + 阈值动不了的盲区）
 *    都逐条进报告，不汇总成"准确率 95%"。
 * 5. **评估只有一处实现**。对外的 `evaluateText` / `evaluateHighlight` 就是扫描内循环用的那套
 *    （§2.2：同一逻辑写两遍，早晚一份准一份不准）。
 *
 * 与"口径型"阈值的分工（同一小节）：`yearsPartialRatio` 是"干满几成算部分够"的产品判断
 * （年限走月区间算术，与文本阈值无关），`maxHighlights` 是界面容量。把它们也拉进"标定"
 * 等于给产品决策套上数据的外衣，所以本文件不碰这两项。
 *
 * 跑法：`pnpm --filter @auto-cc/plugin-resume-kb calibrate`（打印逐条读数、网格规模、选型依据与翻脸清单）。
 * 纯函数：不碰 cordis、不开连接、不发请求，也不藏配置——出厂阈值由调用方传进来做对照
 * （从 `kbGapSchema` 现读），这样"改了配置没重跑标定"会当场发红而不是悄悄漂移。
 */
import process from 'node:process';
import { coverageOf } from './evidence.js';
import {
  GAP_HIGHLIGHT_ANNOTATIONS,
  GAP_TEXT_ANNOTATIONS,
  type GapHighlightAnnotation,
  type GapTextAnnotation,
} from './gap-calibration-corpus.js';
import type { GapState } from './requirements-compare.js';
import { tokenize } from './tokenize.js';

/**
 * 扫描网格的步长。0.01 而不是 0.02：亮点腿的读数本来就挤在 0.1～0.2 之间（实体短、JD 长，
 * 覆盖率是 max(实体侧, JD 侧) 里较小的那一侧决定的），2 分位的格子连"不相关最高 0.1"与
 * "相关最低 0.1111"之间的带都放不下，会把一条本来可分的带扫成不可分。
 */
export const CALIBRATION_GRID_STEP = 0.01;

/** 文本比对腿的两个阈值（与 `GapCompareOptions` 里的同名两项一一对应）。 */
export interface TextThresholds {
  readonly partialMinScore: number;
  readonly hitMinScore: number;
}

/** 二态判定用的单个阈值（亮点腿）。 */
export interface HighlightThreshold {
  readonly highlightMinScore: number;
}

/** 一条标注在某个选择下的翻脸读数。 */
export interface CalibrationFlip {
  readonly id: string;
  /** `coverageOf` 的读数；零重合为 `null`（盲区） */
  readonly score: number | null;
  /** 人判（三态腿是状态，亮点腿是布尔） */
  readonly human: GapState | boolean;
  /** 该选择下尺子判出来的 */
  readonly judged: GapState | boolean;
  /** 这条标注在该选择下的松弛量（负值 = 翻出去多少） */
  readonly slack: number | null;
  readonly reason: string;
  /** 是不是刻意收进来的边界样本（报告里靠它区分"意外翻脸"与"预期翻脸"） */
  readonly isBoundary: boolean;
}

/** 三态腿在给定阈值下的完整读数。 */
export interface TextEvaluation {
  readonly thresholds: TextThresholds;
  /** 与人判不一致、且**阈值动得了**的条目（真正要靠选值解决的） */
  readonly misfits: readonly CalibrationFlip[];
  /** 零重合且人判不是"缺失"的条目（阈值动不了的盲区） */
  readonly blindSpots: readonly CalibrationFlip[];
  /** 全部有读数标注的松弛量剖面，升序（最紧的那条在前）；选值的第二、第三判据按它逐位比 */
  readonly slackProfile: readonly number[];
  /** 松弛量剖面的第一位，即最紧的那条；一条有读数的都没有时为 `null` */
  readonly margin: number | null;
}

/** 亮点腿在给定阈值下的完整读数。 */
export interface HighlightEvaluation {
  readonly threshold: HighlightThreshold;
  readonly misfits: readonly CalibrationFlip[];
  readonly blindSpots: readonly CalibrationFlip[];
  readonly slackProfile: readonly number[];
  readonly margin: number | null;
}

/** 扫描结果：选中的阈值 + 选型依据。 */
export interface SweepResult<TEvaluation> {
  readonly chosen: TEvaluation;
  /** 实际评估过的候选数（被 `partial ≤ hit` 约束排除的不算） */
  readonly gridPoints: number;
  /** 与最优最紧值并列的候选数（>1 说明选值还有余地，报告里要看得见） */
  readonly tiedCandidates: number;
  /** 类间可分带宽的端点；某一侧没有有读数的样本时为 `null` */
  readonly band: { readonly lower: number | null; readonly upper: number | null } | null;
}

/** 预读好尺子读数的一条词面标注（分词代价摊到网格外面，扫描内循环只用读数）。 */
interface ScoredText {
  readonly annotation: GapTextAnnotation;
  readonly score: number | null;
}

/** 预读好尺子读数的一条亮点标注。 */
interface ScoredHighlight {
  readonly annotation: GapHighlightAnnotation;
  readonly score: number | null;
}

/**
 * 保留四位小数（`coverageOf` 本身给四位，网格点落在两位；混算时浮点尾巴会造出 0.30999999999999994）。
 * @param value 任意数
 * @returns 四位精度的数
 */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * 一条词面标注的尺子读数。
 * @param annotation 人判标注
 * @returns `coverageOf` 的强度；两边没有任何共同 token（或一侧分词为空）时为 `null`，
 *          与 `compareByText` 里那句 `continue` 同一语义
 */
export function textScoreOf(annotation: GapTextAnnotation): number | null {
  return coverageOf(tokenize(annotation.claim), tokenize(annotation.target))?.score ?? null;
}

/**
 * 一条亮点标注的尺子读数（方向与 `findHighlights` 的第二道闸一致：实体 → JD 全文）。
 * @param annotation 人判标注
 * @returns 覆盖率强度；零重合为 `null`
 */
export function highlightScoreOf(annotation: GapHighlightAnnotation): number | null {
  return coverageOf(tokenize(annotation.entityText), tokenize(annotation.jdText))?.score ?? null;
}

/**
 * 按给定阈值把一条读数折成三态（判定顺序与 `compareByText` 逐字一致：先 `hit` 再 `partial`）。
 * @param score `textScoreOf` 的读数，`null` 表示零重合
 * @param thresholds 两条分界线
 * @returns 三态之一；`null` 恒为 `missing`——尺子在那里根本没产出可解释的重合
 */
export function judgeTextScore(score: number | null, thresholds: TextThresholds): GapState {
  if (score === null) return 'missing';
  if (score >= thresholds.hitMinScore) return 'matched';
  if (score >= thresholds.partialMinScore) return 'partial';
  return 'missing';
}

/**
 * 按给定阈值判一条亮点标注是否"与岗位相关"（低于线就被第二道闸挡掉）。
 * @param score `highlightScoreOf` 的读数，`null` 表示零重合
 * @param threshold 相关性下限
 * @returns 相关 / 不相关
 */
export function judgeHighlightScore(score: number | null, threshold: HighlightThreshold): boolean {
  if (score === null) return false;
  return score >= threshold.highlightMinScore;
}

/**
 * 一条三态标注对给定阈值的松弛量。
 *
 * 正数 = 判对且离翻脸还差这么多；负数 = 已经翻出去这么多。人判"命中"看 `hit` 线，
 * "部分命中"看两条线里更近的那条，"缺失"看 `partial` 线（有读数才量，零重合由盲区表达）。
 * @param score 尺子读数（调用方保证非 `null`）
 * @param state 人判状态
 * @param thresholds 两条分界线
 * @returns 松弛量
 */
export function textSlack(score: number, state: GapState, thresholds: TextThresholds): number {
  if (state === 'matched') return round4(score - thresholds.hitMinScore);
  if (state === 'partial') {
    return round4(Math.min(score - thresholds.partialMinScore, thresholds.hitMinScore - score));
  }
  return round4(thresholds.partialMinScore - score);
}

/**
 * 一条亮点标注对给定阈值的松弛量（相关 = 在线上方，不相关 = 在线下方）。
 * @param score 尺子读数（调用方保证非 `null`）
 * @param isRelated 人判
 * @param threshold 相关性下限
 * @returns 松弛量
 */
export function highlightSlack(score: number, isRelated: boolean, threshold: HighlightThreshold): number {
  const signed = isRelated ? score - threshold.highlightMinScore : threshold.highlightMinScore - score;
  return round4(signed);
}

/**
 * 造一条翻脸读数（两条腿共用）。
 * @param annotation 原标注（词面或亮点）
 * @param score 尺子读数
 * @param judged 该选择下尺子判出的
 * @param slack 该选择下的松弛量
 * @returns 一条可直接打印的翻脸记录
 */
function flipOf(
  annotation: GapTextAnnotation | GapHighlightAnnotation,
  score: number | null,
  judged: GapState | boolean,
  slack: number | null,
): CalibrationFlip {
  const human = 'humanState' in annotation ? annotation.humanState : annotation.isRelated;
  return {
    id: annotation.id,
    score,
    human,
    judged,
    slack,
    reason: annotation.reason,
    isBoundary: annotation.isBoundary,
  };
}

/**
 * 把一组松弛量折成选值用的剖面（升序 + 取首位作最紧值）。两条腿共用同一份换算（§2.2）。
 * @param slacks 全部**有读数**标注的松弛量（盲区不参与，见文件头第 2 条）
 * @returns `slackProfile` 为空数组时 `margin` 为 `null`
 */
function profileOf(slacks: readonly number[]): { slackProfile: number[]; margin: number | null } {
  const sorted = [...slacks].sort((left, right) => left - right);
  const tightest = sorted[0];
  return { slackProfile: sorted, margin: tightest === undefined ? null : tightest };
}

/**
 * 在给定阈值下评估词面标注集（**扫描内循环与对外评估同一实现**）。
 * @param scored 预读好读数的标注
 * @param thresholds 待评估的两条分界线
 * @returns 错分清单、盲区清单与松弛量剖面
 */
function evaluateScoredText(scored: readonly ScoredText[], thresholds: TextThresholds): TextEvaluation {
  const misfits: CalibrationFlip[] = [];
  const blindSpots: CalibrationFlip[] = [];
  const slacks: number[] = [];
  for (const { annotation, score } of scored) {
    if (score === null) {
      if (annotation.humanState !== 'missing') blindSpots.push(flipOf(annotation, null, 'missing', null));
      continue;
    }
    const slack = textSlack(score, annotation.humanState, thresholds);
    slacks.push(slack);
    const judged = judgeTextScore(score, thresholds);
    if (judged !== annotation.humanState) misfits.push(flipOf(annotation, score, judged, slack));
  }
  return { thresholds, misfits, blindSpots, ...profileOf(slacks) };
}

/**
 * 在给定阈值下评估亮点标注集。
 * @param scored 预读好读数的标注
 * @param threshold 相关性下限
 * @returns 错分清单、盲区清单与松弛量剖面
 */
function evaluateScoredHighlight(
  scored: readonly ScoredHighlight[],
  threshold: HighlightThreshold,
): HighlightEvaluation {
  const misfits: CalibrationFlip[] = [];
  const blindSpots: CalibrationFlip[] = [];
  const slacks: number[] = [];
  for (const { annotation, score } of scored) {
    if (score === null) {
      if (annotation.isRelated) blindSpots.push(flipOf(annotation, null, false, null));
      continue;
    }
    const slack = highlightSlack(score, annotation.isRelated, threshold);
    slacks.push(slack);
    const judged = judgeHighlightScore(score, threshold);
    if (judged !== annotation.isRelated) misfits.push(flipOf(annotation, score, judged, slack));
  }
  return { threshold, misfits, blindSpots, ...profileOf(slacks) };
}

/**
 * 在给定阈值下评估词面标注集（对外入口，自己读一遍尺子）。
 * @param annotations 人判标注
 * @param thresholds 待评估的两条分界线
 * @returns 与扫描内部完全同一套判定的评估读数
 */
export function evaluateText(annotations: readonly GapTextAnnotation[], thresholds: TextThresholds): TextEvaluation {
  return evaluateScoredText(withTextScores(annotations), thresholds);
}

/**
 * 在给定阈值下评估亮点标注集（对外入口，自己读一遍尺子）。
 * @param annotations 人判标注
 * @param threshold 相关性下限
 * @returns 与扫描内部完全同一套判定的评估读数
 */
export function evaluateHighlight(
  annotations: readonly GapHighlightAnnotation[],
  threshold: HighlightThreshold,
): HighlightEvaluation {
  return evaluateScoredHighlight(withHighlightScores(annotations), threshold);
}

/**
 * 把词面标注预读成「标注 + 尺子读数」。
 * @param annotations 人判标注
 * @returns 扫描可直接复用的读数数组（分词只在这里发生）
 */
function withTextScores(annotations: readonly GapTextAnnotation[]): ScoredText[] {
  return annotations.map((annotation) => ({ annotation, score: textScoreOf(annotation) }));
}

/**
 * 把亮点标注预读成「标注 + 尺子读数」。
 * @param annotations 人判标注
 * @returns 扫描可直接复用的读数数组
 */
function withHighlightScores(annotations: readonly GapHighlightAnnotation[]): ScoredHighlight[] {
  return annotations.map((annotation) => ({ annotation, score: highlightScoreOf(annotation) }));
}

/**
 * 生成 0～1 的网格点（含端点）。
 * @param step 步长
 * @returns 升序网格点
 */
function gridValues(step: number): number[] {
  const points: number[] = [];
  for (let value = 0; value <= 1 + Number.EPSILON; value += step) points.push(round4(value));
  return points;
}

/**
 * 一个候选分界线的排序键（`TextEvaluation` / `HighlightEvaluation` 都提供这两个量）。
 */
interface CandidateKeys {
  /** 阈值动得了的错分条数 */
  readonly misfitCount: number;
  /** 松弛量剖面（升序）；候选下没有任何有读数的标注时为 `null` */
  readonly slackProfile: readonly number[] | null;
}

/**
 * 比两个剖面的优劣：升序序列按位比，第一位（最紧的那条）大者胜，平则比第二位……
 * 等价于"最紧值相同时再看第二紧"，于是并列候选里选到类带中间而不是贴着某条样本。
 * @param left 左候选剖面（调用方保证非 `null`）
 * @param right 右候选剖面（调用方保证非 `null`）
 * @returns 正数 = left 更优，负数 = right 更优，0 = 逐位相同
 */
function compareProfiles(left: readonly number[], right: readonly number[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/**
 * 挑候选：**错分条数升序 → 松弛量剖面逐位降序 → 网格更靠前**。
 * 升序枚举 + 严格优才替换，于是结果只由网格顺序决定，与遍历实现无关（4.4-07 的同一口径）。
 *
 * 三段缺一不可，前两段各自单独用都在这份标定上翻过车：
 * - 只用错分条数：类带真实重叠时一堆点并列在同一个最小错分数上，选出来的那条贴着某一类样本，
 *   换一条新样本就翻脸（判据三禁止"把阈值推到贴着某条"）。
 * - 只用最紧松弛量：实测（本文件第一版）它选出过 `partial=hit=0`——把所有有读数的东西都判成
 *   "命中"，此时"命中"样本到 0 线的距离最大，而错分与诚实配置一模一样；第二版语料修好后它又
 *   落在 `partial=0`，因为个别负余量的绝对值压过了错分条数。**错分更少这件事必须先赢**，
 *   余量只在同样错分时才拿来挑"更不容易被下一条样本推翻"的那条。
 * - 只比到最紧值仍不够：一条负余量会把整片可行带钉在同一个最紧值上（实测 16 组并列），
 *   于是并列时落到网格第一位 `hit=0.51`——距 T14 的 0.5 只差一格。剖面逐位比把它推到带中间。
 * @param keys 各候选的排序键（按网格升序）
 * @returns 最优下标与并列数（并列数 >1 说明选值还有余地，报告里要看得见）
 */
function pickBestIndex(keys: readonly CandidateKeys[]): { index: number; tied: number } {
  let bestIndex = -1;
  let bestMisfits = Number.POSITIVE_INFINITY;
  let bestProfile: readonly number[] | null = null;
  let tied = 0;
  keys.forEach((candidate, index) => {
    const profile = candidate.slackProfile;
    if (profile === null) return;
    const rank =
      bestProfile === null
        ? 1
        : candidate.misfitCount !== bestMisfits
          ? bestMisfits - candidate.misfitCount
          : compareProfiles(profile, bestProfile);
    if (rank > 0) {
      bestIndex = index;
      bestMisfits = candidate.misfitCount;
      bestProfile = profile;
      tied = 1;
      return;
    }
    if (rank === 0) tied += 1;
  });
  if (bestIndex < 0) throw new Error('标注集里没有任何有读数的条目，无法标定');
  return { index: bestIndex, tied };
}

/**
 * 扫三态腿的两条分界线（`partial ≤ hit` 是 schema 的有序约束，违反它等于造一把
 * 任何命中都先被判成缺失的尺子，所以直接不生成这类候选）。
 * @param annotations 人判标注（默认为仓库里那份）
 * @param step 网格步长
 * @returns 选中阈值的评估读数、扫描规模与可分带宽
 */
export function sweepTextThresholds(
  annotations: readonly GapTextAnnotation[] = GAP_TEXT_ANNOTATIONS,
  step: number = CALIBRATION_GRID_STEP,
): SweepResult<TextEvaluation> {
  const scored = withTextScores(annotations);
  const values = gridValues(step);
  const evaluations: TextEvaluation[] = [];
  for (const partial of values) {
    for (const hit of values) {
      if (partial > hit) continue;
      evaluations.push(evaluateScoredText(scored, { partialMinScore: partial, hitMinScore: hit }));
    }
  }
  const { index, tied } = pickBestIndex(
    evaluations.map((one) => ({ misfitCount: one.misfits.length, slackProfile: one.slackProfile })),
  );
  const chosen = evaluations[index];
  if (chosen === undefined) throw new Error('标定网格为空：检查步长与标注集');
  return {
    chosen,
    gridPoints: evaluations.length,
    tiedCandidates: tied,
    band: textBandOf(scored),
  };
}

/**
 * 扫亮点腿的相关性下限。
 * @param annotations 人判标注（默认为仓库里那份）
 * @param step 网格步长
 * @returns 选中阈值的评估读数、扫描规模与可分带宽
 */
export function sweepHighlightThreshold(
  annotations: readonly GapHighlightAnnotation[] = GAP_HIGHLIGHT_ANNOTATIONS,
  step: number = CALIBRATION_GRID_STEP,
): SweepResult<HighlightEvaluation> {
  const scored = withHighlightScores(annotations);
  const evaluations = gridValues(step).map((value) => evaluateScoredHighlight(scored, { highlightMinScore: value }));
  const { index, tied } = pickBestIndex(
    evaluations.map((one) => ({ misfitCount: one.misfits.length, slackProfile: one.slackProfile })),
  );
  const chosen = evaluations[index];
  if (chosen === undefined) throw new Error('亮点标定网格为空：检查步长与标注集');
  return {
    chosen,
    gridPoints: evaluations.length,
    tiedCandidates: tied,
    band: highlightBandOf(scored),
  };
}

/**
 * 三态腿的可分带宽：缺失类有读数样本的最高分 ↔ 命中类有读数样本的最低分。
 * @param scored 预读好的标注读数
 * @returns 两个端点；任一所需类别没有有读数样本时为 `null`
 */
function textBandOf(scored: readonly ScoredText[]): SweepResult<TextEvaluation>['band'] {
  const side = (state: GapState): number[] =>
    scored
      .filter((one) => one.annotation.humanState === state && one.score !== null)
      .map((one) => one.score ?? Number.NaN);
  const missing = side('missing');
  const partial = side('partial');
  const matched = side('matched');
  if (missing.length === 0 || partial.length === 0 || matched.length === 0) return null;
  return { lower: round4(Math.max(...missing)), upper: round4(Math.min(...matched)) };
}

/**
 * 亮点二态的可分带宽：不相关类最高分 ↔ 相关类最低分。
 * @param scored 预读好的标注读数
 * @returns 两个端点；任一侧没有有读数样本时为 `null`
 */
function highlightBandOf(scored: readonly ScoredHighlight[]): SweepResult<HighlightEvaluation>['band'] {
  const unrelated = scored
    .filter((one) => !one.annotation.isRelated && one.score !== null)
    .map((one) => one.score ?? Number.NaN);
  const related = scored
    .filter((one) => one.annotation.isRelated && one.score !== null)
    .map((one) => one.score ?? Number.NaN);
  if (unrelated.length === 0 || related.length === 0) return null;
  return { lower: round4(Math.max(...unrelated)), upper: round4(Math.min(...related)) };
}

/**
 * 打印一份完整标定报告（`pnpm calibrate` 的产出，进 `docs/acceptance/4.4/` 当验收证据）。
 * @param shipped 出厂阈值（调用方从 `kbGapSchema` 现读，本文件不藏第二份配置）
 * @param annotations 词面标注集
 * @param highlightAnnotations 亮点标注集
 * @returns 报告正文（逐条读数、选型依据、翻脸清单、盲区清单）
 */
export function formatReport(
  shipped: TextThresholds & HighlightThreshold,
  annotations: readonly GapTextAnnotation[] = GAP_TEXT_ANNOTATIONS,
  highlightAnnotations: readonly GapHighlightAnnotation[] = GAP_HIGHLIGHT_ANNOTATIONS,
): string {
  const textSweep = sweepTextThresholds(annotations);
  const highlightSweep = sweepHighlightThreshold(highlightAnnotations);
  const lines: string[] = [];
  lines.push(`标注集：词面 ${String(annotations.length)} 条 / 亮点 ${String(highlightAnnotations.length)} 条`);
  lines.push(
    `网格步长 ${String(CALIBRATION_GRID_STEP)}：三态腿评估 ${String(textSweep.gridPoints)} 组，亮点腿评估 ${String(highlightSweep.gridPoints)} 个点`,
  );
  lines.push('');
  lines.push('—— 词面腿逐条读数（尺子 = coverageOf(claim, target)，与 compareByText 同一调用）——');
  for (const annotation of annotations) {
    const score = textScoreOf(annotation);
    const slack =
      score === null ? 'n/a（盲区）' : String(textSlack(score, annotation.humanState, textSweep.chosen.thresholds));
    lines.push(
      `${annotation.id} [${annotation.humanState}]${annotation.isBoundary ? ' 边界' : '     '} ` +
        `读数 ${String(score ?? '零重合')} 选定值下余量 ${slack} 「${annotation.claim}」×「${annotation.target.slice(0, 26)}」：${annotation.reason}`,
    );
  }
  lines.push('');
  lines.push('—— 亮点腿逐条读数（尺子 = coverageOf(entity, jdText)，与 findHighlights 第二道闸同一调用）——');
  for (const annotation of highlightAnnotations) {
    const score = highlightScoreOf(annotation);
    const slack =
      score === null
        ? 'n/a（盲区）'
        : String(highlightSlack(score, annotation.isRelated, highlightSweep.chosen.threshold));
    lines.push(
      `${annotation.id} [${annotation.isRelated ? '相关  ' : '不相关'}]${annotation.isBoundary ? ' 边界' : '     '} ` +
        `读数 ${String(score ?? '零重合')} 选定值下余量 ${slack} 「${annotation.entityText.slice(0, 26)}」：${annotation.reason}`,
    );
  }
  lines.push('');
  lines.push('—— 选型 ——');
  lines.push(
    `三态腿 选中 partial=${String(textSweep.chosen.thresholds.partialMinScore)} ` +
      `hit=${String(textSweep.chosen.thresholds.hitMinScore)}｜错分 ${String(textSweep.chosen.misfits.length)} 条` +
      `｜最紧余量 ${String(textSweep.chosen.margin)}｜出厂 ` +
      `partial=${String(shipped.partialMinScore)} hit=${String(shipped.hitMinScore)}`,
  );
  lines.push(
    `亮点腿 选中 highlight=${String(highlightSweep.chosen.threshold.highlightMinScore)}｜` +
      `错分 ${String(highlightSweep.chosen.misfits.length)} 条｜` +
      `最紧余量 ${String(highlightSweep.chosen.margin)}｜出厂 ${String(shipped.highlightMinScore)}`,
  );
  lines.push(
    `可分带宽：三态腿 [缺失最高 ${String(textSweep.band?.lower ?? 'n/a')}, 命中最低 ${String(textSweep.band?.upper ?? 'n/a')}]` +
      `；亮点腿 [不相关最高 ${String(highlightSweep.band?.lower ?? 'n/a')}, 相关最低 ${String(highlightSweep.band?.upper ?? 'n/a')}]`,
  );
  lines.push(
    `并列候选：三态腿 ${String(textSweep.tiedCandidates)} 组 / 亮点腿 ${String(highlightSweep.tiedCandidates)} 个点` +
      '（并列取网格上更靠前者；判据是错分最少 → 最紧余量最大 → 剖面逐位比，见 `pickBestIndex`）',
  );
  const shippedText = evaluateText(annotations, shipped);
  const shippedHighlight = evaluateHighlight(highlightAnnotations, shipped);
  lines.push(
    `出厂值在标注集上的错分：三态腿 ${String(shippedText.misfits.length)} 条` +
      `（${shippedText.misfits.map((one) => one.id).join(' / ') || '无'}）/ ` +
      `亮点腿 ${String(shippedHighlight.misfits.length)} 条` +
      `（${shippedHighlight.misfits.map((one) => one.id).join(' / ') || '无'}）`,
  );
  lines.push('');
  lines.push('—— 阈值动得了的错分（选定值下仍翻脸，逐条列）——');
  appendFlips(lines, [...textSweep.chosen.misfits, ...highlightSweep.chosen.misfits]);
  lines.push('—— 阈值动不了的盲区（零重合，词面尺子的能力边界，不是选值失误）——');
  appendFlips(lines, [...textSweep.chosen.blindSpots, ...highlightSweep.chosen.blindSpots]);
  return lines.join('\n');
}

/**
 * 打印翻脸清单。
 * @param lines 目标缓冲区（就地追加）
 * @param flips 翻脸读数
 * @returns 无返回值
 */
function appendFlips(lines: string[], flips: readonly CalibrationFlip[]): void {
  if (flips.length === 0) {
    lines.push('（无）');
    return;
  }
  for (const flip of flips) {
    lines.push(
      `${flip.id} 人判 ${String(flip.human)} → 尺子 ${String(flip.judged)}（读数 ${String(flip.score ?? '零重合')}，余量 ${String(flip.slack ?? 'n/a')}）：${flip.reason}`,
    );
  }
}

/** 直接执行时才打印报告（被测试 import 时不产生任何输出）。 */
if (process.argv[1] === import.meta.filename) {
  const { kbGapSchema } = await import('./gap-service.js');
  const config = kbGapSchema.parse({});
  console.log(
    formatReport({
      partialMinScore: config.evidencePartialMinScore,
      hitMinScore: config.evidenceHitMinScore,
      highlightMinScore: config.highlightMinScore,
    }),
  );
}
