/**
 * 阈值标定的**回归锁**（plan §4.4-e 判据三，spec 4.4-03 / 4.4-04 的尺子半边）。
 *
 * 这个文件锁的不是"分数算得对不对"（那在 `requirements-compare.test.ts`），而是三件更容易悄悄坏掉的事：
 * 1. **出厂值 = 标定值 = `cordis.yml` 里的那一段**。三处任一被手改而没重跑标定，第一条用例就红——
 *    这是"改了配置忘了标定"唯一的自动防线（人判标注不会自己开口说话）。
 * 2. **翻脸条目逐条钉死**。标定不许宣称全对，所以把它宣称的那两条不一致（T24 / H12）与全部盲区
 *    写成断言：语料被改动能让这两条消失时，说明有人为了让报告好看而删了样本，用例立刻红。
 * 3. **选值判据本身**。实测这一套判据在开发过程中翻过三次车（只用错分率选出 `partial=hit=0`；
 *    只用余量被个别负值压倒一切；比较符号写反时"错分更少"反而落选），所以判据的行为要留成用例，
 *    而不是只留在 `pickBestIndex` 的注释里。
 *
 * 全程不起 store、不碰 cordis、不发请求，也不读任何真实简历或真实 JD（语料是虚构的，见 corpus 文件头）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  CALIBRATION_GRID_STEP,
  evaluateHighlight,
  evaluateText,
  highlightScoreOf,
  judgeHighlightScore,
  judgeTextScore,
  sweepHighlightThreshold,
  sweepTextThresholds,
  textScoreOf,
  type HighlightThreshold,
  type TextEvaluation,
  type TextThresholds,
} from './gap-calibration.js';
import { GAP_HIGHLIGHT_ANNOTATIONS, GAP_TEXT_ANNOTATIONS, type GapTextAnnotation } from './gap-calibration-corpus.js';
import { kbGapSchema } from './gap-service.js';
import type { GapState } from './requirements-compare.js';

/** 三态腿的扫描结果（下面每条用例都在它上面挑读数，避免同一份标定跑五遍）。 */
const TEXT_SWEEP = sweepTextThresholds();
/** 亮点腿的扫描结果。 */
const HIGHLIGHT_SWEEP = sweepHighlightThreshold();
/** schema 的出厂默认（`kbGapSchema.parse({})` 就是把所有 `.default()` 补齐）。 */
const SHIPPED = kbGapSchema.parse({});

/**
 * 取 `cordis.yml` 里 `kb-gap` 段的 `config`（装配层真正喂给插件的那几个数）。
 * @returns 键 → 原样值（未过 schema，所以类型是 `unknown`，由调用方按用途收窄）
 */
function kbGapConfigFromManifest(): Record<string, unknown> {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const manifest: unknown = parse(readFileSync(join(here, '../../../cordis.yml'), 'utf8'));
  if (typeof manifest !== 'object' || manifest === null) throw new Error('cordis.yml 顶层不是对象');
  const plugins: unknown = (manifest as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) throw new Error('cordis.yml 没有 plugins 数组');
  const entry: unknown = plugins.find(
    (candidate) =>
      typeof candidate === 'object' && candidate !== null && (candidate as { id?: unknown }).id === 'kb-gap',
  );
  if (entry === undefined) throw new Error('cordis.yml 里没有 kb-gap 段');
  const config: unknown = (entry as { config?: unknown }).config;
  if (typeof config !== 'object' || config === null) throw new Error('kb-gap 段没有 config');
  return config as Record<string, unknown>;
}

/**
 * 取某一类人判状态下**有读数**（非零重合）的标注读数。
 * @param state 人判状态
 * @returns 该类的尺子读数集合，用于量"选定阈值离最近的样本有多远"
 */
function textReadingsOf(state: GapState): number[] {
  return GAP_TEXT_ANNOTATIONS.filter((annotation) => annotation.humanState === state)
    .map((annotation) => textScoreOf(annotation))
    .filter((score): score is number => score !== null);
}

/**
 * 判断一个值是否落在扫描网格上（标定值必须是网格点，否则说明它被别处写死而不是扫出来的）。
 * @param value 待判的阈值
 * @returns 是否为 `CALIBRATION_GRID_STEP` 的整数倍
 */
function isGridPoint(value: number): boolean {
  return Math.abs(Math.round(value / CALIBRATION_GRID_STEP) * CALIBRATION_GRID_STEP - value) < 1e-9;
}

/**
 * 按 id 取一条词面标注（用例宁可报错也不要 `undefined` 静默通过）。
 * @param id 语料里的稳定号
 * @returns 对应标注
 */
function textAnnotation(id: string): GapTextAnnotation {
  const annotation = GAP_TEXT_ANNOTATIONS.find((candidate) => candidate.id === id);
  if (annotation === undefined) throw new Error(`语料里没有 ${id} 这条标注`);
  return annotation;
}

/**
 * 独立复算一遍三态腿的候选（0.05 粗网格，只用于验证选值判据本身，不与工具共用实现）。
 * @returns 每个满足 `partial ≤ hit` 的候选的评估读数
 */
function coarseTextCandidates(): TextEvaluation[] {
  const candidates: TextEvaluation[] = [];
  for (let partial = 0; partial <= 1; partial += 0.05) {
    for (let hit = 0; hit <= 1; hit += 0.05) {
      if (partial > hit) continue;
      candidates.push(
        evaluateText(GAP_TEXT_ANNOTATIONS, {
          partialMinScore: Math.round(partial * 100) / 100,
          hitMinScore: Math.round(hit * 100) / 100,
        }),
      );
    }
  }
  return candidates;
}

describe('标定值与出厂值对齐（plan §4.4-e 的落地口径）', () => {
  it('三态腿扫出的 partial / hit 就是 schema 默认，且 cordis.yml 的 kb-gap 段写的是同一组数', () => {
    expect(TEXT_SWEEP.chosen.thresholds.partialMinScore).toBe(SHIPPED.evidencePartialMinScore);
    expect(TEXT_SWEEP.chosen.thresholds.hitMinScore).toBe(SHIPPED.evidenceHitMinScore);
    expect(HIGHLIGHT_SWEEP.chosen.threshold.highlightMinScore).toBe(SHIPPED.highlightMinScore);

    const manifestConfig = kbGapConfigFromManifest();
    expect(manifestConfig.evidencePartialMinScore).toBe(TEXT_SWEEP.chosen.thresholds.partialMinScore);
    expect(manifestConfig.evidenceHitMinScore).toBe(TEXT_SWEEP.chosen.thresholds.hitMinScore);
    expect(manifestConfig.highlightMinScore).toBe(HIGHLIGHT_SWEEP.chosen.threshold.highlightMinScore);
  });

  it('标定值都是网格点、且满足 schema 的有序约束（partial ≤ hit）', () => {
    const { partialMinScore, hitMinScore } = TEXT_SWEEP.chosen.thresholds;
    expect(isGridPoint(partialMinScore)).toBe(true);
    expect(isGridPoint(hitMinScore)).toBe(true);
    expect(isGridPoint(HIGHLIGHT_SWEEP.chosen.threshold.highlightMinScore)).toBe(true);
    expect(partialMinScore).toBeLessThanOrEqual(hitMinScore);
    // 有序约束真被 schema 拦着：把两条线写反的配置必须在装配期就报错，不是运行期猜
    expect(kbGapSchema.safeParse({ evidencePartialMinScore: 0.8, evidenceHitMinScore: 0.2 }).success).toBe(false);
  });
});

describe('翻脸清单逐条钉死（"一条不剩的标定等于没标"）', () => {
  it('三态腿在选定值下只剩 T24 一条错分，亮点腿只剩 H12', () => {
    expect(TEXT_SWEEP.chosen.misfits.map((flip) => flip.id)).toEqual(['T24']);
    expect(HIGHLIGHT_SWEEP.chosen.misfits.map((flip) => flip.id)).toEqual(['H12']);
  });

  it('T24 与 T15 是同读数撞车：任何阈值都分不开，所以它不是选值失误而是刻度上限', () => {
    const collision = textScoreOf(textAnnotation('T24'));
    expect(collision).not.toBeNull();
    // 人判「部分命中」的 T15 与人判「缺失」的 T24 给同一个读数——这条断言就是"换阈值解决不了"的证据
    expect(textScoreOf(textAnnotation('T15'))).toBe(collision);
    expect(textAnnotation('T15').humanState).toBe('partial');
    expect(textAnnotation('T24').humanState).toBe('missing');
    // 而且该读数落在标定线的 partial 侧，所以 T24 被判成 partial（唯一可能的错分方向）
    expect(judgeTextScore(collision, TEXT_SWEEP.chosen.thresholds)).toBe('partial');
  });

  it('零重合是尺子的盲区：恒判缺失 / 不相关，单独列清单且不参与选值', () => {
    expect(judgeTextScore(null, TEXT_SWEEP.chosen.thresholds)).toBe('missing');
    expect(judgeHighlightScore(null, HIGHLIGHT_SWEEP.chosen.threshold)).toBe(false);
    // 清单内容与语料里"零重合且人判不是缺失"的条目一致，一条不多一条不少
    expect(TEXT_SWEEP.chosen.blindSpots.map((flip) => flip.id)).toEqual(['T16', 'T17', 'T18', 'T19', 'T20', 'T21']);
    expect(HIGHLIGHT_SWEEP.chosen.blindSpots.map((flip) => flip.id)).toEqual(['H09', 'H10']);
    // 盲区不进错分也不进余量：它们没有 `slack`
    expect(TEXT_SWEEP.chosen.blindSpots.every((flip) => flip.slack === null)).toBe(true);
    expect(TEXT_SWEEP.chosen.slackProfile.length).toBe(
      GAP_TEXT_ANNOTATIONS.filter((annotation) => textScoreOf(annotation) !== null).length,
    );
  });

  it('语料里的边界样本确实翻了脸或进了盲区，反循环检查不是摆设', () => {
    // 边界条 = 人判与朴素词面覆盖不一致的那类。它们要么在错分清单里，要么在盲区里，
    // 要么读数恰好与人判一致但被标注为"刻度勉强够"（T13 那类单 token 命中）。
    const flipped = new Set(
      [
        ...TEXT_SWEEP.chosen.misfits,
        ...TEXT_SWEEP.chosen.blindSpots,
        ...HIGHLIGHT_SWEEP.chosen.misfits,
        ...HIGHLIGHT_SWEEP.chosen.blindSpots,
      ].map((flip) => flip.id),
    );
    const boundaryIds = [
      ...GAP_TEXT_ANNOTATIONS.filter((annotation) => annotation.isBoundary).map((one) => one.id),
      ...GAP_HIGHLIGHT_ANNOTATIONS.filter((annotation) => annotation.isBoundary).map((one) => one.id),
    ];
    expect(boundaryIds.length).toBeGreaterThanOrEqual(10);
    // 至少一半边界样本给了负面读数——否则这批样本是"为了让尺子好看"摆的棋子
    expect(boundaryIds.filter((id) => flipped.has(id)).length).toBeGreaterThanOrEqual(
      Math.ceil(boundaryIds.length / 2),
    );
  });
});

describe('选值判据本身（三段各拦一种翻车方式）', () => {
  it('选值判据两段都在起作用：选定值错分全局最少，且在该家族里余量最大', () => {
    // 独立复算一遍（粗网格，避开 5050 组的开销），判据若被改坏这里就红。
    const coarse = coarseTextCandidates();
    const minMisfits = Math.min(...coarse.map((one) => one.misfits.length));
    expect(TEXT_SWEEP.chosen.misfits.length).toBe(minMisfits);
    const bestMarginInFamily = Math.max(
      ...coarse.filter((one) => one.misfits.length === minMisfits).map((one) => one.margin ?? 0),
    );
    expect(TEXT_SWEEP.chosen.margin).toBeGreaterThanOrEqual(bestMarginInFamily - 1e-9);

    // 只看余量会被"把一切判成命中"的退化点骗走：它的错分严格更多，所以必须落选
    const everythingMatches = evaluateText(GAP_TEXT_ANNOTATIONS, {
      partialMinScore: 0,
      hitMinScore: 0,
    });
    expect(everythingMatches.misfits.length).toBeGreaterThan(TEXT_SWEEP.chosen.misfits.length);
  });

  it('同样错分时不贴着样本：选定值离两侧最近的读数各留 ≥0.05，而 0.51 那种点只差一格', () => {
    const hit = TEXT_SWEEP.chosen.thresholds.hitMinScore;
    const below = Math.max(...textReadingsOf('partial').filter((score) => score < hit));
    const above = Math.min(...textReadingsOf('matched').filter((score) => score >= hit));
    expect(Math.min(hit - below, above - hit)).toBeGreaterThanOrEqual(0.05);

    // 把 hit 线推到贴着 0.5 那档：错分条数与选定值相同，但最紧余量之后的第二、第三位更差
    const hugging: TextThresholds = { partialMinScore: 0.33, hitMinScore: 0.51 };
    const hugEval = evaluateText(GAP_TEXT_ANNOTATIONS, hugging);
    expect(hugEval.misfits.length).toBe(TEXT_SWEEP.chosen.misfits.length);
    expect(hugEval.margin).toBe(TEXT_SWEEP.chosen.margin);
    const chosenProfile = TEXT_SWEEP.chosen.slackProfile;
    const hugProfile = hugEval.slackProfile;
    expect(chosenProfile.length).toBe(hugProfile.length);
    // 剖面按位比：前两位（那条负余量 + 最紧的命中）相同，第三位起选定值更宽松
    expect(chosenProfile[2]).toBeGreaterThan(hugProfile[2] ?? Number.NEGATIVE_INFINITY);
  });

  it('改数确有依据：亮点腿从 0.12 换到标定值后错分严格变少，三态腿不变差', () => {
    const previous: HighlightThreshold = { highlightMinScore: 0.12 };
    expect(evaluateHighlight(GAP_HIGHLIGHT_ANNOTATIONS, previous).misfits.length).toBeGreaterThan(
      HIGHLIGHT_SWEEP.chosen.misfits.length,
    );
    expect(
      evaluateText(GAP_TEXT_ANNOTATIONS, { partialMinScore: 0.3, hitMinScore: 0.62 }).misfits.length,
    ).toBeGreaterThanOrEqual(TEXT_SWEEP.chosen.misfits.length);
  });

  it('同一份语料两次扫出的选值与并列数逐位相同（4.4-07 的确定性口径）', () => {
    const again = sweepTextThresholds();
    const highlightAgain = sweepHighlightThreshold();
    expect(again.chosen.thresholds).toEqual(TEXT_SWEEP.chosen.thresholds);
    expect(again.tiedCandidates).toBe(TEXT_SWEEP.tiedCandidates);
    expect(again.gridPoints).toBe(TEXT_SWEEP.gridPoints);
    expect(highlightAgain.chosen.threshold).toEqual(HIGHLIGHT_SWEEP.chosen.threshold);
    expect(highlightAgain.tiedCandidates).toBe(HIGHLIGHT_SWEEP.tiedCandidates);
  });

  it('标定不碰两条口径型阈值：工具与语料两个文件里根本不出现这两个键', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const sources = ['gap-calibration.ts', 'gap-calibration-corpus.ts']
      .map((file) => readFileSync(join(here, file), 'utf8'))
      .join('\n')
      // 注释里允许出现（分工说明正是写在注释里的），只拦代码里的引用
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n');
    expect(sources).not.toMatch(/yearsPartialRatio/);
    expect(sources).not.toMatch(/maxHighlights/);
  });
});

describe('语料规模守门（防止用删样本的方式"提高"标定质量）', () => {
  it('id 唯一、每条都有依据、有读数的样本三类各有覆盖', () => {
    const ids = [...GAP_TEXT_ANNOTATIONS.map((one) => one.id), ...GAP_HIGHLIGHT_ANNOTATIONS.map((one) => one.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(GAP_TEXT_ANNOTATIONS.every((one) => one.reason.length > 4)).toBe(true);
    expect(GAP_HIGHLIGHT_ANNOTATIONS.every((one) => one.reason.length > 4)).toBe(true);
    expect(textReadingsOf('matched').length).toBeGreaterThanOrEqual(8);
    expect(textReadingsOf('partial').length).toBeGreaterThanOrEqual(2);
    expect(textReadingsOf('missing').length).toBeGreaterThanOrEqual(1);
    const related = GAP_HIGHLIGHT_ANNOTATIONS.filter((one) => one.isRelated)
      .map((one) => highlightScoreOf(one))
      .filter((score): score is number => score !== null);
    const unrelated = GAP_HIGHLIGHT_ANNOTATIONS.filter((one) => !one.isRelated)
      .map((one) => highlightScoreOf(one))
      .filter((score): score is number => score !== null);
    expect(related.length).toBeGreaterThanOrEqual(4);
    expect(unrelated.length).toBeGreaterThanOrEqual(2);
  });

  it('可分带宽的两侧都来自真实读数，不是把某一类抽空后得到的假干净', () => {
    expect(TEXT_SWEEP.band).not.toBeNull();
    expect(HIGHLIGHT_SWEEP.band).not.toBeNull();
    // 三态腿：缺失侧最高 < 命中侧最低 → 两个类之间存在可放分界线的空带
    expect(TEXT_SWEEP.band?.lower).toBeLessThan(TEXT_SWEEP.band?.upper ?? Number.POSITIVE_INFINITY);
    // 亮点腿：band.lower（不相关最高 0.1429）> band.upper（相关最低 0.1111）→ 类带真重叠，
    // 这正是 H12 一定翻脸的原因，标定不假装它能分开
    expect((HIGHLIGHT_SWEEP.band?.lower ?? 0) > (HIGHLIGHT_SWEEP.band?.upper ?? 1)).toBe(true);
    expect(HIGHLIGHT_SWEEP.chosen.misfits).toHaveLength(1);
  });
});
