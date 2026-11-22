/**
 * 意图路由的分类与回落（spec 10.11-16 / 2026-11-22 裁定）。
 * 判据重心：六类各一条 + 三条负对照（无关话题不调业务口、模型不可用仍回落、低置信不猜）。
 */
import { describe, expect, it } from 'vitest';
import { classifyByKeywords, explainQuery, routeIntent, ROUTE_MIN_CONFIDENCE } from './router.js';

describe('classifyByKeywords：六类各一条', () => {
  it('explain：「这个岗位为什么匹配」', () => {
    expect(classifyByKeywords('这个岗位为什么匹配').intent).toBe('explain');
  });

  it('navigate：「带我去看追踪与统计」→ 落点 trust', () => {
    const reading = classifyByKeywords('带我去看追踪与统计');
    expect(reading.intent).toBe('navigate');
    expect(reading.target?.view).toBe('trust');
  });

  it('summary：「今天投了几份」', () => {
    expect(classifyByKeywords('今天投了几份').intent).toBe('summary');
  });

  it('draft_plan：「准备一轮投递」', () => {
    expect(classifyByKeywords('准备一轮投递').intent).toBe('draft_plan');
  });

  it('act：「帮我打招呼」', () => {
    expect(classifyByKeywords('帮我打招呼').intent).toBe('act');
  });

  it('reminder：「有什么要我处理的」', () => {
    expect(classifyByKeywords('有什么要我处理的').intent).toBe('reminder');
  });
});

describe('负对照', () => {
  it('无关话题：不猜，落 unknown（处理器因此一个业务口都不调）', () => {
    const reading = classifyByKeywords('今天天气怎么样');
    expect(reading.intent).toBe('unknown');
  });

  it('模型不可用（抛错）：回落关键词，仍能跳转与汇总', async () => {
    const broken = {
      complete: (): Promise<string> => Promise.reject(new Error('LLM_UNAVAILABLE')),
    };
    const navigate = await routeIntent('带我去看追踪', broken);
    expect(navigate.via).toBe('keywords');
    expect(navigate.reading.intent).toBe('navigate');
    const summary = await routeIntent('今天投了几份', broken);
    expect(summary.reading.intent).toBe('summary');
  });

  it('模型低置信 / 乱回 JSON：回落关键词（不猜）', async () => {
    const lowConfidence = { complete: () => Promise.resolve(JSON.stringify({ intent: 'summary', confidence: 0.1 })) };
    expect((await routeIntent('带我去看追踪', lowConfidence)).reading.intent).toBe('navigate');
    const garbage = { complete: () => Promise.resolve('我觉得你想投简历') };
    expect((await routeIntent('今天投了几份', garbage)).reading.intent).toBe('summary');
  });

  it('模型高置信：按模型结果走，并且 schema 之外的多余字段当解析失败', async () => {
    const good = {
      complete: () => Promise.resolve(JSON.stringify({ intent: 'reminder', confidence: 0.9 })),
    };
    const reading = await routeIntent('今天投了几份', good);
    expect(reading.via).toBe('model');
    expect(reading.reading.intent).toBe('reminder');
    const extra = {
      complete: () => Promise.resolve(JSON.stringify({ intent: 'summary', confidence: 0.9, extra: true })),
    };
    // strict schema 不认多余字段 → 回落到关键词（同样得出 summary，但来源不同）
    const fallback = await routeIntent('今天投了几份', extra);
    expect(fallback.via).toBe('keywords');
    expect(ROUTE_MIN_CONFIDENCE).toBeGreaterThan(0);
  });
});

describe('explainQuery：去掉提问框子，只留主题', () => {
  it('「解释一下前端方向这个岗位为什么匹配」→ 留「前端方向」', () => {
    expect(explainQuery('解释一下前端方向这个岗位为什么匹配')).toBe('前端方向');
  });

  it('全是框子时退回原句（宁可查原句，不查空串）', () => {
    expect(explainQuery('为什么匹配')).toBe('为什么匹配');
  });
});
