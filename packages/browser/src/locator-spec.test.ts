import { describe, expect, it } from 'vitest';
import type { ElementFingerprint, LocateCandidate, LocatedReading, LocateSpec } from '@auto-cc/shared';
import {
  AMBIGUOUS_HIT_PENALTY,
  CONTAINS_DISCOUNT,
  FINGERPRINT_BASE_SCORE,
  GENERATED_VALUE,
  NOT_VISIBLE_PENALTY,
  STRATEGY_WEIGHT,
  decideLocate,
  isSafeAttributeName,
  looksGenerated,
  rankScored,
  scoreByFingerprint,
  scoreReading,
  toRankedCandidates,
  validateSpec,
} from './locator-spec.js';

/** 打分层的阈值口径与配置默认值一致（plan §9.3）。 */
const THRESHOLDS = { minScore: 70, minMargin: 12 };

/**
 * 造一条页面回读。
 * @param overrides 需要改写的字段（默认是一个可见、可点、独占命中的 testId 命中）
 * @returns 未打分的读数
 */
function reading(overrides: Partial<LocatedReading> = {}): LocatedReading {
  return {
    frameUrl: 'http://127.0.0.1:10233/locator',
    candidateIndex: 0,
    strategy: 'testId',
    siblingCount: 1,
    nodeIndex: 1,
    visible: true,
    enabled: true,
    unobstructed: true,
    tagName: 'button',
    role: 'button',
    accessibleName: '打招呼',
    text: '打招呼',
    attributes: { 'data-testid': 'apply-btn' },
    ancestorRoles: ['list'],
    nearbyTexts: ['资深前端工程师'],
    rect: { x: 0, y: 300, width: 120, height: 40 },
    ...overrides,
  };
}

/** 造一份声明。 */
function spec(candidates: LocateCandidate[], description = '打招呼按钮'): LocateSpec {
  return { description, cardinality: 'single', candidates };
}

describe('候选策略权重与声明校验（spec 2.2-01）', () => {
  it('权重按稳定性排：testId > id > role > name > text > css > xpath，且指纹自愈不占正常分', () => {
    expect(STRATEGY_WEIGHT.testId).toBeGreaterThan(STRATEGY_WEIGHT.id);
    expect(STRATEGY_WEIGHT.id).toBeGreaterThan(STRATEGY_WEIGHT.role);
    expect(STRATEGY_WEIGHT.role).toBeGreaterThan(STRATEGY_WEIGHT.name);
    expect(STRATEGY_WEIGHT.name).toBeGreaterThan(STRATEGY_WEIGHT.text);
    expect(STRATEGY_WEIGHT.text).toBeGreaterThan(STRATEGY_WEIGHT.css);
    expect(STRATEGY_WEIGHT.css).toBeGreaterThan(STRATEGY_WEIGHT.xpath);
    expect(STRATEGY_WEIGHT.fingerprint).toBe(0);
  });

  it('空候选、未知策略、role 缺可读名、testId 缺属性名都要在校验层被拦下，不进打分', () => {
    expect(validateSpec(spec([]))).toEqual(['spec 没有任何候选策略']);
    expect(validateSpec(spec([{ strategy: 'fuzz' as LocateCandidate['strategy'], value: 'x' }]))).toEqual([
      '候选 0（fuzz）：未知策略',
    ]);
    expect(validateSpec(spec([{ strategy: 'role', role: 'button' }]))).toEqual(['候选 0（role）：缺少可读名 name']);
    expect(validateSpec(spec([{ strategy: 'testId', value: 'apply-btn' }]))).toEqual([
      '候选 0（testId）：属性名非法（空）',
    ]);
    expect(validateSpec(spec([{ strategy: 'testId', attribute: 'data-testid' }]))).toEqual([
      '候选 0（testId）：缺少 value',
    ]);
    expect(validateSpec(spec([{ strategy: 'id', value: 'apply-1' }]))).toEqual([]);
  });

  it('非法属性名的判定只认 HTML 属性名字法——选择器语法一律拒收', () => {
    expect(isSafeAttributeName('data-testid')).toBe(true);
    expect(isSafeAttributeName('data-x"]')).toBe(false);
    expect(isSafeAttributeName('1abc')).toBe(false);
  });

  it('生成串识别覆盖 hash 与尾号，正常语义值不误伤', () => {
    expect(looksGenerated('a1b2c3d4e5')).toBe(true);
    expect(looksGenerated('btn-4711')).toBe(true);
    expect(looksGenerated('apply-btn')).toBe(false);
    expect(looksGenerated('资深前端工程师')).toBe(false);
    expect(GENERATED_VALUE.test('4711')).toBe(true);
  });
});

describe('打分与排序（spec 2.2-02）', () => {
  it('每条折价都在 reasons 里留下对应文字——「为什么它赢」必须可解释，不只是有个数', () => {
    const scored = scoreReading(reading({ strategy: 'text', siblingCount: 3, visible: false }), {
      strategy: 'text',
      value: '打招呼',
    });
    expect(scored.score).toBe(STRATEGY_WEIGHT.text - CONTAINS_DISCOUNT - AMBIGUOUS_HIT_PENALTY - NOT_VISIBLE_PENALTY);
    expect(scored.reasons.join('/')).toContain('包含匹配');
    expect(scored.reasons.join('/')).toContain('同条件命中 3 个');
    expect(scored.reasons.join('/')).toContain('不可见');
  });

  it('像生成串的匹配值直接封顶 10，精确文本不折价', () => {
    const generated = scoreReading(reading({ strategy: 'id' }), { strategy: 'id', value: 'btn-4711' });
    expect(generated.score).toBe(10);
    expect(generated.reasons.join('/')).toContain('封顶 10');
    const exact = scoreReading(reading({ strategy: 'text' }), { strategy: 'text', value: '打招呼', exact: true });
    expect(exact.score).toBe(STRATEGY_WEIGHT.text);
  });

  it('同一元素被多条策略命中时只留声明最靠前的那条，不会被误判成歧义', () => {
    const ranked = toRankedCandidates(
      [
        reading({ candidateIndex: 1, strategy: 'css', nodeIndex: 7 }),
        reading({ candidateIndex: 0, strategy: 'testId', nodeIndex: 7 }),
        reading({ candidateIndex: 2, strategy: 'text', nodeIndex: 9 }),
      ],
      [
        { strategy: 'testId', attribute: 'data-testid', value: 'apply-btn' },
        { strategy: 'css', value: 'button' },
        { strategy: 'text', value: '打招呼' },
      ],
    );
    expect(ranked.map((item) => item.candidateIndex)).toEqual([0, 2]);
  });

  it('平分候选按声明顺序排，跑几次顺序都不变（top-N 排序稳定）', () => {
    const tied = [
      reading({ candidateIndex: 2, strategy: 'css', nodeIndex: 30 }),
      reading({ candidateIndex: 0, strategy: 'css', nodeIndex: 12 }),
      reading({ candidateIndex: 1, strategy: 'css', nodeIndex: 20 }),
    ].map((item) => scoreReading(item, { strategy: 'css', value: 'x' }));
    const first = rankScored(tied);
    expect(first.map((item) => item.candidateIndex)).toEqual([0, 1, 2]);
    expect(rankScored([...tied].reverse()).map((item) => item.candidateIndex)).toEqual([0, 1, 2]);
  });
});

describe('择优判定：达不到阈值就拒绝猜测（spec 2.2-02 / 2.2-04）', () => {
  it('候选全空是 not-found，不是一次「分数不够」', () => {
    expect(decideLocate([], THRESHOLDS)).toMatchObject({ status: 'not-found', chosen: null });
  });

  it('最优分低于 minScore 判 below-score，并把分数写进理由里给界面显示', () => {
    const ranked = [scoreReading(reading({ strategy: 'css' }), { strategy: 'css', value: 'button' })];
    const decision = decideLocate(ranked, THRESHOLDS);
    expect(decision.status).toBe('below-score');
    expect(decision.chosen).toBeNull();
    expect(decision.reason).toContain(String(ranked[0]!.score));
    expect(decision.reason).toContain('最低可用分 70');
  });

  it('与次优分差不足 minMargin 判 ambiguous——两条都点得下去时宁可不动', () => {
    const best = {
      ...scoreReading(reading({ strategy: 'role' }), { strategy: 'role', role: 'button', name: '打招呼' }),
    };
    const runnerUp = {
      ...scoreReading(reading({ strategy: 'name', nodeIndex: 2 }), { strategy: 'name', value: 'apply' }),
    };
    runnerUp.score = best.score - 5;
    const decision = decideLocate(rankScored([best, runnerUp]), THRESHOLDS);
    expect(decision.status).toBe('ambiguous');
    expect(decision.reason).toContain('小于最小分差 12');
  });

  it('分差够就是 matched，胜出候选与理由一起带回', () => {
    const best = scoreReading(reading(), { strategy: 'testId', attribute: 'data-testid', value: 'apply-btn' });
    const runnerUp = {
      ...scoreReading(reading({ strategy: 'css', nodeIndex: 2 }), { strategy: 'css', value: 'button' }),
    };
    const decision = decideLocate(rankScored([best, runnerUp]), THRESHOLDS);
    expect(decision).toMatchObject({ status: 'matched', chosen: best });
    expect(decision.reason).toContain('testId');
  });

  it('阈值是配置不是常量：同一批候选换一套阈值结局就换', () => {
    const ranked = [scoreReading(reading({ strategy: 'text' }), { strategy: 'text', value: '打招呼', exact: true })];
    expect(decideLocate(ranked, THRESHOLDS).status).toBe('matched');
    expect(decideLocate(ranked, { minScore: 90, minMargin: 12 }).status).toBe('below-score');
  });
});

describe('指纹自愈打分（spec 2.2-05）', () => {
  /** 一份上次成功留下的指纹。 */
  const fingerprint: ElementFingerprint = {
    tagName: 'button',
    role: 'button',
    accessibleName: '打招呼',
    text: '打招呼',
    attributes: { 'data-testid': 'apply-btn', type: 'button' },
    ancestorRoles: ['list'],
    nearbyTexts: ['资深前端工程师'],
    rect: { x: 0, y: 300, width: 120, height: 40 },
  };

  it('标签名不同直接 0 分：不是同一个控件，长得再像也不自愈', () => {
    const scored = scoreByFingerprint(fingerprint, reading({ tagName: 'a', strategy: 'fingerprint' }));
    expect(scored.score).toBe(0);
    expect(scored.reasons).toEqual(['标签名不同，不是同一个控件']);
  });

  it('字段逐项累计：角色 +6、可读名 +8、文本 +4、稳定属性每项 +3（封顶 4 项）、祖先链 +4、锚点每处 +2', () => {
    const matched = reading({
      strategy: 'fingerprint',
      candidateIndex: -1,
      attributes: { 'data-testid': 'apply-btn', type: 'button' },
    });
    const scored = scoreByFingerprint(fingerprint, matched);
    expect(scored.score).toBe(FINGERPRINT_BASE_SCORE + 6 + 8 + 4 + 3 * 2 + 4 + 2 * fingerprint.nearbyTexts.length);
    expect(scored.reasons.join('/')).toContain('可读名一致 +8');
  });

  it('改版只剩标签名和一处锚点时，分数落在 minScore 之下——宁可不点，也不点到别人身上', () => {
    const drifted = reading({
      strategy: 'fingerprint',
      candidateIndex: -1,
      role: '',
      accessibleName: '',
      text: '',
      attributes: {},
      ancestorRoles: ['div'],
      nearbyTexts: ['别的区块'],
    });
    const scored = scoreByFingerprint(fingerprint, drifted);
    expect(scored.score).toBeLessThan(THRESHOLDS.minScore);
    expect(decideLocate([scored], THRESHOLDS).status).toBe('below-score');
  });

  it('自愈候选也走同一套阈值：不设第二个旋钮，配置里就只有 minScore / minMargin', () => {
    const scored = scoreByFingerprint(fingerprint, {
      ...reading({ strategy: 'fingerprint', candidateIndex: -1 }),
      attributes: { 'data-testid': 'apply-btn', type: 'button' },
    });
    expect(decideLocate([scored], THRESHOLDS).status).toBe('matched');
    expect(decideLocate([scored], { minScore: 200, minMargin: 12 }).status).toBe('below-score');
  });
});
