/**
 * `journey` 服务的编排判据（M2-B 10.3-01…03 的服务半边）。
 *
 * 这里用**同形状替身**只替七只 L2 服务的结果，判的是本服务自己的编排：
 * 版本键是否一致、匹配理由是否只来自比对、事实违规是否整份失败、模型不可用/冲突事实是否明确失败。
 * 真实的 `kb.gap` / `resume.generate` / `jd.capture` 装配与仿站活体在 `packages/main` 与 V 类证据里判，
 * 这里不重造第二套判据（AGENTS.md §2.5）。
 */
import { AppError, asApp, Context, NO_CONFIG, Service, type Fiber } from '@auto-cc/core';
import { createEmptyDocument, contentHash } from '@auto-cc/plugin-resume-doc';
import type { GapReportView, KbIntentView } from '@auto-cc/plugin-resume-kb';
import type { JobRowView } from '@auto-cc/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JourneyService, journeySchema } from './journey-service.js';
import { criteriaFromIntent, jdVersionOf, requirementIdOf } from './match.js';

const fibers: Fiber[] = [];
const sandboxes: string[] = [];
const DOC_ID = 'journey-doc';
const NOW = new Date(2026, 10, 19, 12).getTime();
const JD = '前端工程师（虚构）：负责 React 与 TypeScript 页面开发，3 年以上经验，本科及以上。';

/** 造一份最小合法文档（只有抬头，内容不参与本文件的判据）。 */
function docOf(): ReturnType<typeof createEmptyDocument> {
  const doc = createEmptyDocument(DOC_ID, NOW);
  doc.profile = { name: '测试候选人', contact: { email: null, phone: null, location: '上海' } };
  return doc;
}

/** 一份带两条要求的缺口报告（要求 id 由服务派生，报告本身只给条目与证据）。 */
function reportOf(): GapReportView {
  const item = (label: string, quote: string, start: number): GapReportView['items'][number] => ({
    kind: 'hard_skill',
    label,
    quote,
    start,
    end: start + quote.length,
    years: null,
    via: 'lexicon',
  });
  const rows: GapReportView['rows'] = [
    {
      item: item('React', 'React', 0),
      state: 'matched',
      evidence: [{ id: 'entity-react', origin: 'entity', kind: 'skill', score: 0.9, matchedTokens: ['react'] }],
      bestScore: 0.9,
      suggestion: null,
    },
    {
      item: item('TypeScript', 'TypeScript', 6),
      state: 'partial',
      evidence: [{ id: 'entity-ts', origin: 'entity', kind: 'skill', score: 0.5, matchedTokens: ['typescript'] }],
      bestScore: 0.5,
      suggestion: { key: 'strengthen_evidence', params: { evidenceId: 'entity-ts' } },
    },
    {
      item: item('硕士', '本科及以上', 20),
      state: 'missing',
      evidence: [],
      bestScore: null,
      suggestion: { key: 'add_evidence', params: { label: '硕士' } },
    },
  ];
  return {
    items: rows.map((row) => row.item),
    inputChars: JD.length,
    droppedByLimit: 0,
    lexiconVersion: 'lex-v1',
    modelStatus: 'disabled',
    modelReason: null,
    model: null,
    modelAdded: 0,
    modelDropped: 0,
    promptVersion: null,
    rows,
    highlights: [],
    highlightsDropped: 0,
    counts: { matched: 1, partial: 1, missing: 1 },
    totalExperienceMonths: 48,
    libraryEducationRank: 2,
    entityCount: 2,
    asOfMonth: '2026-11',
  };
}

/** 库内岗位行（只填服务真正读的字段）。 */
function jobRow(jobId: string, title: string): JobRowView {
  return {
    id: Number(jobId.replace(/[^0-9]/g, '')) || 1,
    platform: 'boss',
    jobId,
    title,
    company: '虚构公司',
    salaryText: '面议',
    salary: null,
    city: '上海',
    experience: '3-5 年',
    education: '本科',
    description: JD,
    requirements: ['React', 'TypeScript'],
    postedText: '刚刚',
    postedAt: null,
    sourceUrl: `http://127.0.0.1:10233/boss/detail?jobId=${jobId}`,
    capturedAt: NOW,
    detailCapturedAt: NOW,
    replied: false,
    inboundCount: 0,
  };
}

const empty = z.strictObject({});

/** 简历文档替身：只回答 load，内容固定，版本哈希由真实 `contentHash` 算。 */
class FakeDocService extends Service {
  static provide = 'resume.doc';
  static Config = empty;
  constructor(ctx: Context) {
    super(ctx, 'resume.doc');
  }
  load = (id: string) =>
    id === DOC_ID || id === `${DOC_ID}-variant`
      ? { status: 'found' as const, document: docOf() }
      : { status: 'missing' as const };
}

/** 知识库替身：意向四格 + 两条事实正文。 */
class FakeProfileService extends Service {
  static provide = 'kb.profile';
  static Config = empty;
  constructor(ctx: Context) {
    super(ctx, 'kb.profile');
  }
  intent = (_docId?: string | null): KbIntentView | null => ({
    docId: DOC_ID,
    expectRole: '前端工程师',
    expectCity: '上海',
    expectSalary: '25-40K',
    expectStart: '两周内',
  });
  list = (_filter?: unknown) => [
    {
      entityId: 'entity-react',
      kind: 'skill' as const,
      parentId: null,
      sourceDocId: DOC_ID,
      payload: { text: 'React' },
      normalizedHash: 'h1',
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      entityId: 'entity-ts',
      kind: 'skill' as const,
      parentId: null,
      sourceDocId: DOC_ID,
      payload: { text: 'TypeScript' },
      normalizedHash: 'h2',
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  evidenceBody = (id: string) =>
    id === 'entity-react' || id === 'entity-ts'
      ? {
          id,
          origin: 'entity' as const,
          text: id === 'entity-react' ? 'React 前端开发' : 'TypeScript 页面开发',
          sourceDocId: DOC_ID,
        }
      : null;
}

/** 缺口替身：固定一份报告，证明匹配理由只抄比对结果。 */
class FakeGapService extends Service {
  static provide = 'kb.gap';
  static Config = empty;
  constructor(ctx: Context) {
    super(ctx, 'kb.gap');
  }
  report = (_jdText: string, _filter?: unknown, _nowMs?: number) => Promise.resolve(reportOf());
}

/** 生成替身：默认成功；`tampered` 时返回违规，证明服务整份失败且不生成招呼。 */
class FakeGenerateService extends Service {
  static provide = 'resume.generate';
  static Config = empty;
  constructor(ctx: Context) {
    super(ctx, 'resume.generate');
  }
  /** 事实篡改负对照开关：为真时返回「被拦下」的生成读数。 */
  tampered = false;
  run = (_jdText: string, _filter?: unknown, _nowMs?: number) =>
    Promise.resolve({
      document: this.tampered ? null : docOf(),
      rewrites: this.tampered ? [] : [{ sectionId: 'exp', entryId: 'e1', fieldKey: 'text', before: 'a', after: 'b' }],
      evidence: [],
      reorderBases: [],
      checks: this.tampered
        ? { ok: false, retried: false, violations: ['number:91%', 'entity:虚构公司'], violationCount: 2 }
        : { ok: true, retried: false, violations: [], violationCount: 0 },
      receipt: { id: this.tampered ? 'gen-bad' : 'gen-1', docId: DOC_ID, jdId: 'job-1' },
      requiredBefore: [],
      requiredAfter: [],
      skillSource: null,
      skillChars: 0,
    });
  accept = (receiptId: string) => ({
    docId: `${DOC_ID}-variant`,
    receiptId,
    appliedRewrites: 1,
    reorderApplied: true,
    movedSections: 0,
    movedEntries: 0,
    updatedAt: NOW,
  });
}

/** 抓取替身：回五个岗位键。 */
class FakeCaptureService extends Service {
  static provide = 'jd.capture';
  static Config = empty;
  constructor(ctx: Context) {
    super(ctx, 'jd.capture');
  }
  /** 只回几个岗位键（演「可解释岗位不足三个」）。 */
  capturedCount = 3;
  status = () => ({ platform: 'boss', platforms: ['boss'], targetCount: 5 });
  run = (criteria: { keyword: string }) =>
    Promise.resolve({
      platform: 'boss',
      keyword: criteria.keyword,
      city: null,
      rounds: 1,
      containers: 5,
      stored: 3,
      captured: ['job-1', 'job-2', 'job-3']
        .slice(0, this.capturedCount)
        .map((jobId) => ({ jobId, title: `岗位 ${jobId}` })),
      skipped: [],
      stoppedBy: 'target-count' as const,
      total: 3,
      finishedAt: NOW,
      ledgerRowsBefore: 0,
      ledgerRowsAfter: 0,
    });
}

/** JD 库替身：三个岗位 + 一份不在库里的。 */
class FakeJdStoreService extends Service {
  static provide = 'jd.store';
  static Config = empty;
  constructor(ctx: Context) {
    super(ctx, 'jd.store');
  }
  list = () => ({
    total: 3,
    matched: 3,
    rows: [jobRow('job-1', '前端工程师 A'), jobRow('job-2', '前端工程师 B'), jobRow('job-3', '前端工程师 C')],
  });
}

/** 话术替身：模板回落也能出草稿。 */
class FakeScriptService extends Service {
  static provide = 'outbound.script';
  static Config = empty;
  constructor(ctx: Context) {
    super(ctx, 'outbound.script');
  }
  generate = () =>
    Promise.resolve({
      text: '您好，看到贵司在招前端工程师，想进一步沟通。',
      origin: 'template' as const,
      scriptVersion: 'script-v1',
      jdId: 'job-1',
      kind: 'greeting' as const,
      evidenceRefs: ['entity-react'],
    });
}

/** 模型替身：按用例剧本回 JSON 或抛不可用。 */
class FakeLlmService extends Service {
  static provide = 'llm.chat';
  static Config = empty;
  /** 由用例设置：`ok` 正常材料、`bad-json` 非 JSON、`conflict` 数字冲突、`unavailable` 断模型。 */
  mode: 'ok' | 'bad-json' | 'conflict' | 'unavailable' = 'ok';
  constructor(ctx: Context) {
    super(ctx, 'llm.chat');
  }
  complete = () => {
    if (this.mode === 'unavailable') {
      return Promise.reject(new AppError('LLM_UNAVAILABLE', '模型未配置', 'llm.chat'));
    }
    if (this.mode === 'bad-json') return Promise.resolve({ text: '不是 JSON', model: 'fake', usage: null });
    const qa = Array.from({ length: 8 }, (_, index) => ({
      question: `问题 ${String(index + 1)}：你在 React 上的经验？`,
      answer:
        this.mode === 'conflict'
          ? '我用 React 把页面性能提升了 91%。'
          : '我用 React 做过 3 个项目的页面开发，并负责 TypeScript 类型治理。',
      resumeFactIds: ['entity-react'],
      requirementIds: [requirementIdOf(jdVersionOf(JD), 0)],
    }));
    return Promise.resolve({
      text: JSON.stringify({
        selfIntro: '我有 React 与 TypeScript 的前端开发经验。',
        qa,
        checklist: ['准备项目介绍', '复习 React', '确认面试时间'],
      }),
      model: 'fake-journey',
      usage: null,
    });
  };
}

/**
 * 起一套「真 store + 七只同形替身 + 真 journey」的装配。
 * @returns journey 句柄、替身与上下文
 */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-cc-journey-'));
  sandboxes.push(dir);
  const ctx = new Context();
  fibers.push(await ctx.plugin(FakeDocService, NO_CONFIG));
  fibers.push(await ctx.plugin(FakeProfileService, NO_CONFIG));
  fibers.push(await ctx.plugin(FakeGapService, NO_CONFIG));
  fibers.push(await ctx.plugin(FakeGenerateService, NO_CONFIG));
  fibers.push(await ctx.plugin(FakeCaptureService, NO_CONFIG));
  fibers.push(await ctx.plugin(FakeJdStoreService, NO_CONFIG));
  fibers.push(await ctx.plugin(FakeScriptService, NO_CONFIG));
  fibers.push(await ctx.plugin(FakeLlmService, NO_CONFIG));
  fibers.push(await ctx.plugin(JourneyService, journeySchema.parse({})));
  return {
    journey: asApp(ctx).journey,
    llm: ctx.get('llm.chat') as unknown as FakeLlmService,
    gen: ctx.get('resume.generate') as unknown as FakeGenerateService,
    capture: ctx.get('jd.capture') as unknown as FakeCaptureService,
    dir,
  };
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

describe('意向与版本键（10.3-01）', () => {
  it('意向缺期望岗位时不代替人决定搜什么', async () => {
    const { journey } = await boot();
    const view = journey.intent(DOC_ID);
    expect(view.resumeVersion).toBe(`doc:${DOC_ID}:${contentHash(docOf()).slice(0, 12)}`);
    expect(view.criteria).toEqual({ keyword: '前端工程师', city: '上海' });
    expect(
      criteriaFromIntent({ docId: DOC_ID, expectRole: '', expectCity: '', expectSalary: '', expectStart: '' }),
    ).toMatchObject({
      keyword: '',
      city: null,
    });
  });

  it('版本键随 JD 正文变化，要求 id 由版本派生且稳定', () => {
    expect(jdVersionOf(JD)).toBe(jdVersionOf(` ${JD} `));
    expect(jdVersionOf(`${JD} 另有要求`)).not.toBe(jdVersionOf(JD));
    expect(requirementIdOf('v1', 0)).toBe('v1:R1');
    expect(requirementIdOf('v1', 2)).toBe('v1:R3');
  });
});

describe('按意向搜岗与可解释匹配（10.3-01）', () => {
  it('至少三个岗位，每条理由都能回指要求 id 与事实 id', async () => {
    const { journey } = await boot();
    const view = await journey.search({ docId: DOC_ID });
    expect(view.jobs).toHaveLength(3);
    const first = view.jobs[0]!;
    expect(first.requirements[0]).toMatchObject({
      requirementId: `${first.jdVersion}:R1`,
      state: 'matched',
      factIds: ['entity-react'],
    });
    expect(first.requirements[2]).toMatchObject({ state: 'missing', factIds: [] });
    expect(view.jobs.every((job) => job.jdVersion === jdVersionOf(JD))).toBe(true);
  });

  it('不足三个可解释岗位时明确失败，不补样例', async () => {
    const { journey, capture } = await boot();
    capture.capturedCount = 2;
    await expect(journey.search({ docId: DOC_ID })).rejects.toMatchObject({
      code: 'JOURNEY_MATCH_INSUFFICIENT',
      details: { eligible: 2 },
    });
  });
});

describe('定制与招呼草稿（10.3-02）', () => {
  it('成功时版本三元组一致，招呼草稿带证据引用', async () => {
    const { journey } = await boot();
    const view = await journey.tailor({ docId: DOC_ID, jobId: 'job-1' });
    expect(view.resumeVersion).toBe(`doc:${DOC_ID}:${contentHash(docOf()).slice(0, 12)}`);
    expect(view.tailoredResumeVersion).toBe(`doc:${DOC_ID}-variant:${contentHash(docOf()).slice(0, 12)}`);
    expect(view.jdVersion).toBe(jdVersionOf(JD));
    expect(view.greeting?.evidenceRefs).toEqual(['entity-react']);
  });

  it('事实校验不过时整份失败，不产生招呼草稿', async () => {
    const { journey, gen } = await boot();
    gen.tampered = true;
    await expect(journey.tailor({ docId: DOC_ID, jobId: 'job-1' })).rejects.toMatchObject({
      code: 'JOURNEY_FACT_BLOCKED',
      details: { violations: ['number:91%', 'entity:虚构公司'] },
    });
  });
});

describe('面试材料（10.3-03）', () => {
  it('正常路径：八条问答、三条准备、每条带事实与要求来源', async () => {
    const { journey } = await boot();
    const view = await journey.interview({ docId: DOC_ID, jobId: 'job-1' });
    expect(view.qa).toHaveLength(8);
    expect(view.checklist).toHaveLength(3);
    expect(view.qa.every((item) => item.resumeFactIds.length > 0 && item.requirementIds.length > 0)).toBe(true);
  });

  it('断模型：LLM_UNAVAILABLE 原样上浮，不回落样例', async () => {
    const { journey, llm } = await boot();
    llm.mode = 'unavailable';
    await expect(journey.interview({ docId: DOC_ID, jobId: 'job-1' })).rejects.toMatchObject({
      code: 'LLM_UNAVAILABLE',
    });
  });

  it('注入冲突数字：JOURNEY_MATERIAL_INVALID 明确失败', async () => {
    const { journey, llm } = await boot();
    llm.mode = 'conflict';
    await expect(journey.interview({ docId: DOC_ID, jobId: 'job-1' })).rejects.toMatchObject({
      code: 'JOURNEY_MATERIAL_INVALID',
    });
  });

  it('模型回答不是 JSON：同样明确失败', async () => {
    const { journey, llm } = await boot();
    llm.mode = 'bad-json';
    await expect(journey.interview({ docId: DOC_ID, jobId: 'job-1' })).rejects.toMatchObject({
      code: 'JOURNEY_MATERIAL_INVALID',
    });
  });
});
