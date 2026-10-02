/**
 * 三态比对与反向比对的离线用例（spec 4.4-03 / 4.4-04 / 4.4-06 / 4.4-07 的比对层半边）。
 *
 * 这里断言的是**判据**，所以全部打在纯函数上（不起 store、不挂载插件；只有出厂阈值经
 * `kbGapSchema` 现读，以免这份用例跑在一把已经没人用的尺子上）：
 * 1. 四类要求不共用一把尺子（plan §4.4-c 判据一）——年限的判据是算术，词面尺子在它上面必然给假读数；
 * 2. 「今天」是入参（判据二的前半）——同一份输入换 `nowMonth` 就该换结论，函数内部读时钟做不到这条；
 * 3. 反向比对的两道闸（判据二的后半）——只判「JD 没提」会把驾照推成亮点，那会让整份报告失去可信度；
 * 4. 非命中的每一行都带建议，且建议只有 i18n key 与参数（4.4-06 的结构断言，§5.5 / §5.7）；
 * 5. 同一输入两次运行 hash 逐字相同，且**与实体传入次序无关**（4.4-07）。
 *
 * 语料全是写在文件里的虚构内容（4.4-08 / AGENTS.md §7.2），没有一个字节来自真实招聘平台。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GAP_SUGGESTION_KEYS,
  compareRequirements,
  mergedMonthsOf,
  type GapCompareOptions,
  type GapLibraryEntity,
} from './requirements-compare.js';
import type { KbEntityKind } from './entities.js';
import { kbGapSchema } from './gap-service.js';
import type { RequirementItem, RequirementKind } from './requirements.js';

/** 「今天」= 2026 年 10 月的绝对月序号（`年 × 12 + 月`，与 `monthSpanOf` 同尺度）。 */
const NOW_MONTH = 2026 * 12 + 10;

/**
 * 与出厂配置同源的默认阈值：从 `kbGapSchema` 的 `.default()` 现读，不在这里抄第二份数字。
 * 4.4-e 标定后这三条文本阈值是量出来的（`gap-calibration.test.ts` 锁"标定值 = 出厂值"）；
 * 抄一份写死的旧阈值，这份用例就会永远跑在一把没人用的尺子上。
 */
const SHIPPED_GAP_CONFIG = kbGapSchema.parse({});
const BASE_OPTIONS: GapCompareOptions = {
  evidenceTopK: SHIPPED_GAP_CONFIG.evidenceTopK,
  hitMinScore: SHIPPED_GAP_CONFIG.evidenceHitMinScore,
  partialMinScore: SHIPPED_GAP_CONFIG.evidencePartialMinScore,
  yearsPartialRatio: SHIPPED_GAP_CONFIG.yearsPartialRatio,
  highlightMinScore: SHIPPED_GAP_CONFIG.highlightMinScore,
  maxHighlights: SHIPPED_GAP_CONFIG.maxHighlights,
  nowMonth: NOW_MONTH,
};

/**
 * 覆盖默认可调项，得到本次比对用的选项。
 * @param overrides 只覆盖写出来的那几项（用例要靠它验「阈值来自配置」）
 * @returns 完整的比对选项
 */
function options(overrides: Partial<GapCompareOptions> = {}): GapCompareOptions {
  return { ...BASE_OPTIONS, ...overrides };
}

/**
 * 造一条拆解腿产出的要求条目。
 * @param kind 四类之一
 * @param label 代表词（比对真正吃的字段）
 * @param years 年限数字，仅 `experience_years` 有意义；其余传 `null`
 * @returns 条目；`start/end` 在比对层不参与判定，只为形状完整而按引文长度填
 */
function requirement(kind: RequirementKind, label: string, years: number | null = null): RequirementItem {
  return { kind, label, quote: label, start: 0, end: label.length, years, via: 'lexicon' };
}

/**
 * 造一条库内实体投影（真库里它由 `libraryEntityOf` 从 `kb.profile.list()` 投影而来）。
 * @param entityId 实体 id，同分排序的第二判据靠它
 * @param kind 实体种类
 * @param text 载荷拼出的可比文本
 * @param periodText 时间段原文（只有经历/项目有），无则 `null`
 * @returns 比对输入里的一条实体
 */
function entity(
  entityId: string,
  kind: KbEntityKind,
  text: string,
  periodText: string | null = null,
): GapLibraryEntity {
  return { entityId, kind, text, periodText };
}

/** 五类要求 + 四类实体的主场景：每一行落在哪一态、证据从哪来，全在这里一次验完。 */
const MAIN_JD = '后端工程师：负责推荐接口，要求 Java、本科及以上学历，5 年以上经验，具备跨部门沟通机制设计能力。';
const MAIN_ENTITIES = [
  entity('exp-1', 'experience', '星桥科技｜后端工程师，负责推荐接口与订单服务', '2019.03-至今'),
  entity('skill-java', 'skill', 'Java 微服务'),
  entity('skill-comm', 'skill', '具备跨部门沟通机制设计'),
  entity('skill-nosql', 'skill', 'NoSQL 选型'),
];
const MAIN_ITEMS = [
  requirement('hard_skill', 'Java'),
  requirement('hard_skill', 'Flink'),
  requirement('soft_skill', '沟通表达'),
  requirement('education', '本科'),
  requirement('experience_years', '5 年以上经验', 5),
];
const MAIN_EDUCATION_CHUNKS = [{ chunkId: 'chunk-edu', text: '江海大学｜软件工程 本科 2017.09-2021.06' }];

/** 主场景的比对读数（各用例在它上面挑，避免同一份判定写五遍）。 */
const MAIN = compareRequirements(
  { jdText: MAIN_JD, items: MAIN_ITEMS, entities: MAIN_ENTITIES, educationChunks: MAIN_EDUCATION_CHUNKS },
  options(),
);

/**
 * 按 label 取主场景里的某一行。
 * @param label 要求条目的代表词
 * @returns 对应的比对行
 */
function mainRow(label: string) {
  const row = MAIN.rows.find((candidate) => candidate.item.label === label);
  if (row === undefined) throw new Error(`主场景没有这条要求：${label}`);
  return row;
}

describe('三态比对：每类要求各用各的尺子（spec 4.4-03）', () => {
  it('技能命中：单 token 的代表词被实体点名即 contains，证据带 id 与命中词', () => {
    const row = mainRow('Java');
    expect(row.state).toBe('matched');
    expect(row.bestScore).toBe(1);
    expect(row.evidence[0]?.id).toBe('skill-java');
    expect(row.evidence[0]?.origin).toBe('entity');
    expect(row.evidence[0]?.matchedTokens).toEqual(['java']);
    expect(row.suggestion).toBeNull();
  });

  it('技能部分命中：只沾上一个 bigram 时判 partial 而不是硬凑成 matched，并给出用哪条证据改写的建议', () => {
    const row = mainRow('沟通表达');
    expect(row.state).toBe('partial');
    expect(row.bestScore ?? 0).toBeGreaterThanOrEqual(0.3);
    expect(row.bestScore ?? 1).toBeLessThan(0.62);
    expect(row.suggestion?.key).toBe('strengthen_evidence');
    expect(row.suggestion?.params.evidenceId).toBe('skill-comm');
  });

  it('技能缺失：库里没有的词判 missing，证据恒为空数组而不是塞一条弱据圆场', () => {
    const row = mainRow('Flink');
    expect(row.state).toBe('missing');
    expect(row.evidence).toEqual([]);
    expect(row.bestScore).toBeNull();
    expect(row.suggestion?.key).toBe('add_evidence');
    expect(row.suggestion?.params.label).toBe('Flink');
  });

  it('学历走档位比较，证据 id 落在区块切片上（4.2 裁定二：学历不产实体行）', () => {
    const row = mainRow('本科');
    expect(row.state).toBe('matched');
    expect(row.evidence[0]?.origin).toBe('section_chunk');
    expect(row.evidence[0]?.id).toBe('chunk-edu');
    expect(MAIN.libraryEducationRank).toBe(2);
  });

  it('年限走算术：JD 与库内文本零共同 token，词面尺子在这里只能给假读数', () => {
    const row = mainRow('5 年以上经验');
    // 2019.03 到 2026.10 = 92 个月 = 7 年 ≥ 5 年
    expect(row.state).toBe('matched');
    expect(row.evidence.map((one) => one.id)).toEqual(['exp-1']);
    expect(MAIN.totalExperienceMonths).toBe(92);
    expect(row.suggestion).toBeNull();
  });

  it('三态计数与行序：counts 对得上，rows 与拆解序一致（界面分栏不再二次排序）', () => {
    expect(MAIN.counts).toEqual({ matched: 3, partial: 1, missing: 1 });
    expect(MAIN.rows.map((row) => row.item.label)).toEqual(MAIN_ITEMS.map((item) => item.label));
  });

  it('阈值来自配置：把 hitMinScore 抬到 1 以上，同一份输入全部退成 partial', () => {
    const strict = compareRequirements(
      { jdText: MAIN_JD, items: [requirement('hard_skill', 'Java')], entities: MAIN_ENTITIES, educationChunks: [] },
      options({ hitMinScore: 1.5 }),
    );
    expect(strict.rows[0]?.state).toBe('partial');
    const lenient = compareRequirements(
      { jdText: MAIN_JD, items: [requirement('hard_skill', 'Java')], entities: MAIN_ENTITIES, educationChunks: [] },
      options({ partialMinScore: 1.5 }),
    );
    expect(lenient.rows[0]?.state).toBe('missing');
  });
});

describe('年限腿的区间合并与「今天」夹取（spec 4.4-03 / 4.4-07）', () => {
  it('重叠区间只算一次：两段共 60 个月，合并后 53 个月', () => {
    const result = compareRequirements(
      {
        jdText: '要求 5 年以上经验。',
        items: [requirement('experience_years', '5 年以上经验', 5)],
        entities: [
          entity('exp-a', 'experience', '第一段经历', '2020.01-2022.12'),
          entity('exp-b', 'experience', '第二段经历', '2022.06-2024.05'),
        ],
        educationChunks: [],
      },
      options(),
    );
    expect(result.totalExperienceMonths).toBe(53);
    const row = result.rows[0];
    // 4 年 < 5 年，但 ≥ 5×0.6 → partial；证据占比按各自月数 / 两段之和（60），不是合并后的 53。
    expect(row?.state).toBe('partial');
    expect(row?.evidence.map((one) => one.score)).toEqual([0.6, 0.4]);
    expect(row?.suggestion?.key).toBe('years_gap');
    expect(row?.suggestion?.params).toMatchObject({ required: 5, haveYears: 4 });
  });

  it('相邻区间连成一段：中间不断档的两段按一段连续经验计', () => {
    expect(
      mergedMonthsOf([
        { start: 2020 * 12 + 1, end: 2020 * 12 + 6 },
        { start: 2020 * 12 + 7, end: 2021 * 12 + 1 },
      ]),
    ).toBe(13);
    expect(mergedMonthsOf([])).toBe(0);
  });

  it('「至今」夹到入参的 nowMonth：换一个月就换一个结论，函数内部不读时钟', () => {
    const input = {
      jdText: '要求 8 年以上经验。',
      items: [requirement('experience_years', '8 年以上经验', 8)],
      entities: [entity('exp-open', 'experience', '当前岗位', '2019.03-至今')],
      educationChunks: [],
    };
    const in2026 = compareRequirements(input, options({ nowMonth: 2026 * 12 + 10 }));
    const in2021 = compareRequirements(input, options({ nowMonth: 2021 * 12 + 6 }));
    // 2019.03→2026.10 是 7 整年（≥ 8×0.6 → partial）；→2021.06 只有 2 年（< 4.8 → missing）。
    expect(in2026.totalExperienceMonths).toBe(92);
    expect(in2026.rows[0]?.state).toBe('partial');
    expect(in2021.totalExperienceMonths).toBe(28);
    expect(in2021.rows[0]?.state).toBe('missing');
  });

  it('起点在未来的区间直接不计，而不是贡献负数月', () => {
    const result = compareRequirements(
      {
        jdText: '要求 1 年以上经验。',
        items: [requirement('experience_years', '1 年以上经验', 1)],
        entities: [
          entity('exp-past', 'experience', '已完成的经历', '2019.01-2019.12'),
          entity('exp-future', 'experience', '写错了时间的经历', '2027.01-2027.06'),
        ],
        educationChunks: [],
      },
      options(),
    );
    // 12 个月 = 1 整年，对「1 年以上」正好够；未来那段既不贡献月数，也不进证据链。
    expect(result.totalExperienceMonths).toBe(12);
    expect(result.rows[0]?.state).toBe('matched');
    expect(result.rows[0]?.evidence.map((one) => one.id)).toEqual(['exp-past']);
  });

  it('库里一条经历都没有时判缺失并标明「补时间」，而不是判成 0 年满足 0 年', () => {
    const result = compareRequirements(
      {
        jdText: '要求 3 年以上经验。',
        items: [requirement('experience_years', '3 年以上经验', 3)],
        entities: [entity('skill-only', 'skill', 'Java 微服务')],
        educationChunks: [],
      },
      options(),
    );
    expect(result.totalExperienceMonths).toBe(0);
    expect(result.rows[0]?.state).toBe('missing');
    expect(result.rows[0]?.bestScore).toBeNull();
    expect(result.rows[0]?.suggestion?.params.noPeriod).toBe(1);
  });
});

describe('学历腿的档位比较与退回文本（spec 4.4-03）', () => {
  /**
   * 组一份只有学历要求的最小输入。
   * @param requiredLabel JD 里的学历 label
   * @param chunks 库内学历区块
   * @returns 比对读数
   */
  function educationCase(requiredLabel: string, chunks: { chunkId: string; text: string }[]) {
    return compareRequirements(
      {
        jdText: `任职要求：${requiredLabel}及以上学历。`,
        items: [requirement('education', requiredLabel)],
        entities: [
          entity('skill-java', 'skill', 'Java 微服务'),
          entity('edu-text', 'experience', '中专在读，随后从事后端开发'),
        ],
        educationChunks: chunks,
      },
      options(),
    );
  }

  it('库内低一档算 partial，并把「差多少档」给到界面', () => {
    const result = educationCase('硕士', [{ chunkId: 'chunk-edu', text: '江海大学 本科' }]);
    expect(result.rows[0]?.state).toBe('partial');
    expect(result.rows[0]?.suggestion?.key).toBe('education_gap');
    expect(result.rows[0]?.suggestion?.params).toMatchObject({ requiredLabel: '硕士', haveRank: 2 });
    expect(result.rows[0]?.bestScore).toBeCloseTo(2 / 3, 4);
  });

  it('库内低两档算 missing，证据仍然为空', () => {
    const result = educationCase('博士', [{ chunkId: 'chunk-edu', text: '江海大学 本科' }]);
    expect(result.rows[0]?.state).toBe('missing');
    expect(result.rows[0]?.evidence).toEqual([]);
    expect(result.rows[0]?.suggestion?.key).toBe('education_gap');
  });

  it('库里没有学历区块 = 无据（education_missing），而不是读成「差一点」', () => {
    const result = educationCase('本科', []);
    expect(result.libraryEducationRank).toBeNull();
    expect(result.rows[0]?.state).toBe('missing');
    expect(result.rows[0]?.suggestion?.key).toBe('education_missing');
  });

  it('档位表外的 label（模型腿给的「中专」）退回文本反查，不猜一档', () => {
    const result = educationCase('中专', [{ chunkId: 'chunk-edu', text: '江海大学 本科' }]);
    const row = result.rows[0];
    expect(row?.evidence[0]?.origin).toBe('entity');
    expect(row?.evidence[0]?.id).toBe('edu-text');
  });

  it('并列取 id 最小的那条切片：与传入顺序无关（4.4-07）', () => {
    const forward = educationCase('硕士', [
      { chunkId: 'a-chunk', text: '第一大学 本科' },
      { chunkId: 'b-chunk', text: '第二大学 本科' },
    ]);
    const reversed = educationCase('硕士', [
      { chunkId: 'b-chunk', text: '第二大学 本科' },
      { chunkId: 'a-chunk', text: '第一大学 本科' },
    ]);
    expect(forward.rows[0]?.evidence[0]?.id).toBe('a-chunk');
    expect(JSON.stringify(forward.rows)).toBe(JSON.stringify(reversed.rows));
  });
});

describe('反向比对的两道闸（spec 4.4-04）', () => {
  const JD = '后端工程师：负责推荐接口，要求 Java。加分项：做过 P99 优化，熟悉高并发。';
  const ITEMS = [requirement('hard_skill', 'Java')];

  /**
   * 只喂「库内有、JD 没提、且与岗位无关」的一条实体，验第二道闸确实拦得住。
   * @returns 比对读数
   */
  function unrelatedCase() {
    return compareRequirements(
      {
        jdText: JD,
        items: ITEMS,
        entities: [entity('skill-java', 'skill', 'Java 微服务'), entity('skill-license', 'skill', 'C1 驾照')],
        educationChunks: [],
      },
      options(),
    );
  }

  it('JD 提过的能力不当亮点（第一道闸）', () => {
    const result = compareRequirements(
      { jdText: JD, items: ITEMS, entities: [entity('skill-java', 'skill', 'Java 微服务')], educationChunks: [] },
      options(),
    );
    expect(result.highlights).toEqual([]);
    expect(result.highlightsDropped).toBe(0);
  });

  it('与这个岗位无关的实体不当亮点（第二道闸）：驾照、六级不是差异化优势', () => {
    expect(unrelatedCase().highlights).toEqual([]);
  });

  it('库里具备、JD 没提、且与岗位相关时进候选，并给「相关在哪几个词」', () => {
    const result = compareRequirements(
      {
        jdText: JD,
        items: ITEMS,
        entities: [entity('ach-p99', 'achievement', '推荐接口 P99 优化')],
        educationChunks: [],
      },
      options(),
    );
    expect(result.highlights).toHaveLength(1);
    expect(result.highlights[0]?.entityId).toBe('ach-p99');
    expect(result.highlights[0]?.score).toBe(1);
    expect(result.highlights[0]?.relatedTokens).toContain('p99');
  });

  it('经历/项目不当亮点候选：它们的技能面已由 skill / achievement 代表', () => {
    const result = compareRequirements(
      {
        jdText: JD,
        items: ITEMS,
        entities: [entity('exp-1', 'experience', '负责推荐接口与 P99 优化', '2019.03-2024.06')],
        educationChunks: [],
      },
      options(),
    );
    expect(result.highlights).toEqual([]);
  });

  it('条数上限来自配置，被截掉的条数如实报出', () => {
    const result = compareRequirements(
      {
        jdText: JD,
        items: ITEMS,
        entities: [
          entity('ach-1', 'achievement', '推荐接口 P99 优化'),
          entity('ach-2', 'achievement', '高并发场景下的容量规划'),
        ],
        educationChunks: [],
      },
      options({ maxHighlights: 1 }),
    );
    expect(result.highlights).toHaveLength(1);
    expect(result.highlightsDropped).toBe(1);
    const capped = compareRequirements(
      {
        jdText: JD,
        items: ITEMS,
        entities: [entity('ach-p99', 'achievement', '推荐接口 P99 优化')],
        educationChunks: [],
      },
      options({ maxHighlights: 0 }),
    );
    expect(capped.highlights).toEqual([]);
    expect(capped.highlightsDropped).toBe(1);
  });
});

describe('不得只输出负面结论（spec 4.4-06）', () => {
  it('每一行非命中的比对都带建议，且建议只有 i18n key 与参数', () => {
    const rows = [...MAIN.rows, ...mergedYearsRows()];
    for (const row of rows) {
      if (row.state === 'matched') {
        expect(row.suggestion).toBeNull();
        continue;
      }
      expect(row.suggestion).not.toBeNull();
      expect(GAP_SUGGESTION_KEYS).toContain(row.suggestion?.key);
      for (const value of Object.values(row.suggestion?.params ?? {})) {
        expect(typeof value).toMatch(/^(string|number)$/);
      }
    }
  });
});

/**
 * 年限与学历那两路的非命中行（4.4-06 的用例要把它们和技能路一起看）。
 * @returns 两条 partial 行所在的比对结果里的 rows
 */
function mergedYearsRows() {
  return compareRequirements(
    {
      jdText: '要求 5 年以上经验，硕士学历。',
      items: [requirement('experience_years', '5 年以上经验', 5), requirement('education', '硕士')],
      entities: [
        entity('exp-a', 'experience', '第一段经历', '2020.01-2022.12'),
        entity('exp-b', 'experience', '第二段经历', '2022.06-2024.05'),
      ],
      educationChunks: [{ chunkId: 'chunk-edu', text: '江海大学 本科' }],
    },
    options(),
  ).rows;
}

describe('比对层的确定性（spec 4.4-07 的比对半边）', () => {
  /**
   * 把一份比对读数序列化后取 sha256，用于"两次运行一致"的硬判据。
   * @param result 比对读数
   * @returns 十六进制摘要
   */
  function fingerprint(result: ReturnType<typeof compareRequirements>): string {
    return createHash('sha256').update(JSON.stringify(result)).digest('hex');
  }

  it('同一输入两次运行的 hash 逐字相同', () => {
    const again = compareRequirements(
      { jdText: MAIN_JD, items: MAIN_ITEMS, entities: MAIN_ENTITIES, educationChunks: MAIN_EDUCATION_CHUNKS },
      options(),
    );
    expect(fingerprint(again)).toBe(fingerprint(MAIN));
  });

  it('与实体、学历切片的传入次序无关：证据同分时的次序由 id 定死', () => {
    const shuffled = compareRequirements(
      {
        jdText: MAIN_JD,
        items: MAIN_ITEMS,
        entities: [...MAIN_ENTITIES].reverse(),
        educationChunks: [...MAIN_EDUCATION_CHUNKS].reverse(),
      },
      options(),
    );
    expect(fingerprint(shuffled)).toBe(fingerprint(MAIN));
  });

  it('证据条数受 topK 约束，界面不会因为库里实体多而滚动到没边', () => {
    const crowded = compareRequirements(
      {
        jdText: MAIN_JD,
        items: [requirement('hard_skill', 'Java')],
        entities: [
          entity('e-1', 'skill', 'Java 微服务'),
          entity('e-2', 'skill', 'Java 高并发'),
          entity('e-3', 'skill', 'Java 性能调优'),
          entity('e-4', 'skill', 'Java 网关'),
        ],
        educationChunks: [],
      },
      options({ evidenceTopK: 2 }),
    );
    expect(crowded.rows[0]?.evidence.map((one) => one.id)).toEqual(['e-1', 'e-2']);
  });
});
