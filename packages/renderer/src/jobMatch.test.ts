import { describe, expect, it } from 'vitest';
import type { JobRowView } from '@auto-cc/shared';
import { matchHits, salaryRangeOf } from './jobMatch.js';

/** 造一行最小可用的岗位读数（只填这条判据用到的字段）。 */
const row = (patch: Partial<JobRowView> = {}): JobRowView => ({
  id: 1,
  platform: 'boss',
  jobId: 'job-1',
  title: '高级前端工程师（可视化方向）',
  company: '某公司',
  salaryText: '15-25K·14薪',
  salary: null,
  city: '上海·徐汇区',
  experience: '3-5年',
  education: '本科',
  description: '负责前端架构，要求熟悉 React 与数据可视化',
  requirements: [],
  postedText: '2 天前',
  postedAt: null,
  sourceUrl: 'https://example.com/job/1',
  capturedAt: 1,
  detailCapturedAt: 1,
  replied: false,
  inboundCount: 0,
  ...patch,
});

describe('匹配理由的确定性推导（2026-11-23 裁定：真理由，不调模型）', () => {
  it('薪资原文读出区间：多值取上下界，面议认不出', () => {
    expect(salaryRangeOf('15-25K·14薪')).toEqual([14, 25]);
    expect(salaryRangeOf('20K以上')).toEqual([20, 20]);
    expect(salaryRangeOf('面议')).toBeNull();
  });

  it('逐条命中：关键词 / 城市 / 区 / 经验 / 学历 / 薪资相交，每条都带具体值', () => {
    const hits = matchHits(row(), {
      keyword: '前端',
      city: '上海',
      cityDistrict: '徐汇区',
      experience: '3-5年',
      degree: '本科',
      salary: '10-20K',
    });
    expect(hits.map((hit) => hit.kind)).toEqual(['keywordTitle', 'city', 'district', 'experience', 'degree', 'salary']);
    expect(hits[0]?.value).toBe('前端');
    expect(hits.at(-1)).toEqual({ kind: 'salary', value: '10-20K', extra: '15-25K·14薪' });
  });

  it('条件不命中就不编：空条件 → 空清单；城市不符不出现城市理由', () => {
    expect(matchHits(row(), {})).toEqual([]);
    const hits = matchHits(row(), { city: '北京', experience: '5-10年' });
    expect(hits).toEqual([]);
  });

  it('关键词只在正文出现时，理由是「JD 正文含」而不是「标题含」', () => {
    const hits = matchHits(row(), { keyword: 'React' });
    expect(hits).toEqual([{ kind: 'keywordBody', value: 'React', extra: '' }]);
  });

  it('薪资区间不相交就不算命中（不硬凑「接近」这种词）', () => {
    const hits = matchHits(row({ salaryText: '30-40K' }), { salary: '10-20K' });
    expect(hits).toEqual([]);
  });
});
