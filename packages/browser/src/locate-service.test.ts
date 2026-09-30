/**
 * `browser.locate` 服务用例（spec 2.2-01 / 02 / 04 / 05 / 08 的服务侧口径）。
 *
 * 打分规则本身由 `locator-spec.test.ts` 覆盖，这里验的是**服务把它们拼成结局**的那一段：
 * 什么时候拒绝猜测、什么时候读快照、什么时候自愈、什么时候发 `locator/relocated`。
 * 视图用替身，所以这三条分支不需要开 Electron 窗口就能机检。
 */
import { AppError, Context, NO_CONFIG, type Fiber } from '@auto-cc/core';
import type { ElementFingerprint, LocateSpec } from '@auto-cc/shared';
import type { WebContents } from 'electron';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserLocateService, type BrowserLocateConfig } from './locate-service.js';
import {
  errorDetails,
  FakePageService,
  FakeShellService,
  fakeFrame,
  fakeReading,
  fakeView,
  type ScriptKind,
} from './test-doubles.js';

const frameUrl = 'http://127.0.0.1:10233/locator';

/** 服务配置的默认值（zod schema 会补齐，但直接调用点的类型是补齐**之后**的形状，所以这里显式写全）。 */
const DEFAULT_LOCATE_CONFIG: BrowserLocateConfig = {
  minScore: 70,
  minMargin: 12,
  candidateLimit: 5,
  textNormalizationLimit: 80,
};

const fibers: Fiber[] = [];

/** 定位声明：一条 testId 候选（声明顺序即优先级）。 */
const specOf = (description: string, candidates: LocateSpec['candidates']): LocateSpec => ({
  description,
  cardinality: 'single',
  candidates,
});

const testIdSpec = specOf('打招呼按钮', [{ strategy: 'testId', attribute: 'data-testid', value: 'greet-button' }]);

/** 上一次成功定位留下的指纹（两处以上独立特征吻合，才够格让自愈过线）。 */
const greetFingerprint = (overrides: Partial<ElementFingerprint> = {}): ElementFingerprint => ({
  tagName: 'button',
  role: 'button',
  accessibleName: '打招呼',
  text: '打招呼',
  attributes: { 'data-testid': 'greet-button' },
  ancestorRoles: ['list'],
  nearbyTexts: ['资深前端工程师'],
  rect: { x: 10, y: 20, width: 100, height: 40 },
  ...overrides,
});

/**
 * 起一套「shell 替身 + page 替身 + 真定位服务」。
 * @param config 覆盖默认阈值的项（默认值由服务自己的 schema 补，这里只写差异）
 * @param view 内核视图替身；null 表示还没有挂载会话
 * @returns 服务实例、页面替身（数快照次数）与视图替身所在的 shell 替身
 */
async function boot(config: Partial<BrowserLocateConfig> = {}, view: WebContents | null = null) {
  const ctx = new Context();
  const shellFiber = await ctx.plugin(FakeShellService, NO_CONFIG);
  const pageFiber = await ctx.plugin(FakePageService, NO_CONFIG);
  const locateFiber = await ctx.plugin(BrowserLocateService, { ...DEFAULT_LOCATE_CONFIG, ...config });
  fibers.push(shellFiber, pageFiber, locateFiber);
  const shell = ctx.get('shell') as unknown as FakeShellService;
  shell.contents = view;
  return {
    ctx,
    locate: ctx.get('browser.locate') as BrowserLocateService,
    page: ctx.get('browser.page') as unknown as FakePageService,
    shell,
  };
}

/**
 * 造一块只有一帧的视图，并按脚本类别给出回读。
 * @param scripts 各类注入脚本的返回值（缺的类别回落到空数组，即「这帧里什么都没命中」）
 * @returns 视图替身
 */
function labView(scripts: Partial<Record<ScriptKind, unknown>> = {}): WebContents {
  const main = fakeFrame(frameUrl, { scripts });
  return fakeView(main, [main], { url: frameUrl });
}

afterAll(async () => {
  for (const fiber of fibers) await fiber.dispose();
});

describe('择优与拒绝猜测（spec 2.2-01 / 2.2-02）', () => {
  it('声明候选过线时返回 matched，且不带快照——成功的一次定位不该背几 KB 正文', async () => {
    const { locate, page } = await boot({}, labView({ locate: [fakeReading(frameUrl)] }));
    const result = await locate.find(testIdSpec);
    expect(result.status).toBe('matched');
    expect(result.chosen).toMatchObject({ strategy: 'testId', score: 100, frameUrl });
    expect(result.relocated).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(page.snapshotCalls).toBe(0);
    expect(result.reason).toContain('胜出候选');
  });

  it('最优候选低于 minScore 判 below-score，并随行一份页面快照（spec 2.2-04）', async () => {
    const { locate, page } = await boot({}, labView({ locate: [fakeReading(frameUrl, { strategy: 'css' })] }));
    const result = await locate.find(specOf('申请入口', [{ strategy: 'css', value: 'a.job-card__apply' }]));
    expect(result.status).toBe('below-score');
    expect(result.chosen).toBeNull();
    expect(result.reason).toContain('低于最低可用分');
    expect(page.snapshotCalls).toBe(1);
    expect(result.snapshot).not.toBeNull();
  });

  it('两条候选平分秋色时判 ambiguous：宁可不动，也不猜一个点下去', async () => {
    const { locate } = await boot(
      {},
      labView({
        locate: [fakeReading(frameUrl, { nodeIndex: 1 }), fakeReading(frameUrl, { nodeIndex: 2, candidateIndex: 1 })],
      }),
    );
    const result = await locate.find(
      specOf('打招呼按钮', [
        { strategy: 'testId', attribute: 'data-testid', value: 'greet-a' },
        { strategy: 'testId', attribute: 'data-testid', value: 'greet-b' },
      ]),
    );
    expect(result.status).toBe('ambiguous');
    expect(result.reason).toContain('小于最小分差');
  });

  it('一帧里什么都没命中是 not-found，和「命中了但没过线」是两个状态', async () => {
    const { locate } = await boot({}, labView({ locate: [] }));
    const result = await locate.find(testIdSpec);
    expect(result.status).toBe('not-found');
    expect(result.ranked).toEqual([]);
  });

  it('阈值来自配置：把 minScore 抬到 100，就只剩满分候选能过线（数值没写死在代码里）', async () => {
    const { locate } = await boot(
      { minScore: 100, minMargin: 0 },
      labView({ locate: [fakeReading(frameUrl, { strategy: 'id' })] }),
    );
    expect((await locate.find(specOf('申请入口', [{ strategy: 'id', value: 'greet-button' }]))).status).toBe(
      'below-score',
    );
  });

  it('candidateLimit 决定 top-N：命中再多也只回传前 N 条', async () => {
    const { locate } = await boot(
      { candidateLimit: 2, minMargin: 0 },
      labView({
        locate: [
          fakeReading(frameUrl, { nodeIndex: 1, strategy: 'testId' }),
          fakeReading(frameUrl, { nodeIndex: 2, strategy: 'id', candidateIndex: 1 }),
          fakeReading(frameUrl, { nodeIndex: 3, strategy: 'role', candidateIndex: 2 }),
        ],
      }),
    );
    const result = await locate.find(
      specOf('打招呼按钮', [
        { strategy: 'testId', attribute: 'data-testid', value: 'greet-a' },
        { strategy: 'id', value: 'greet-b' },
        { strategy: 'role', role: 'button', name: '打招呼' },
      ]),
    );
    expect(result.status).toBe('matched');
    expect(result.ranked.map((item) => item.strategy)).toEqual(['testId', 'id']);
  });

  it('帧读数是畸形形状时按空处理，而不是让整次定位炸掉', async () => {
    const { locate } = await boot({}, labView({ locate: { notAnArray: true } }));
    expect((await locate.find(testIdSpec)).status).toBe('not-found');
  });
});

describe('声明非法与会话缺失（spec 2.2-01 / 2.1-10 的错误口径）', () => {
  it('空候选列表抛 LOCATE_SPEC_INVALID，且在取视图之前就拦下', async () => {
    const { locate } = await boot({}, null);
    await expect(locate.find(specOf('没有候选', []))).rejects.toBeInstanceOf(AppError);
    try {
      await locate.find(specOf('没有候选', []));
    } catch (error) {
      expect((error as AppError).code).toBe('LOCATE_SPEC_INVALID');
      expect(errorDetails(error).problems).toEqual(['spec 没有任何候选策略']);
    }
  });

  it('testId 的属性名非法时整条声明被拒——它会被拼进 CSS 选择器，是注入面', async () => {
    const { locate } = await boot({}, labView({ locate: [] }));
    await expect(
      locate.find(specOf('坏属性名', [{ strategy: 'testId', attribute: 'data-x"]', value: 'y' }])),
    ).rejects.toThrow(/属性名非法/);
  });

  it('还没有挂载会话时是 NO_KERNEL_SESSION，不去跑任何页面脚本', async () => {
    const { locate, page } = await boot({}, null);
    try {
      await locate.find(testIdSpec);
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('NO_KERNEL_SESSION');
      expect(errorDetails(error).partition).toBe('');
      expect(page.snapshotCalls).toBe(0);
    }
  });

  it('所有帧都读失败是 PAGE_SCRIPT_FAILED，与「读到了但没命中」区分开', async () => {
    const main = fakeFrame(frameUrl, { error: 'Frame is detached' });
    const { locate } = await boot({}, fakeView(main, [main], { url: frameUrl }));
    try {
      await locate.find(testIdSpec);
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('PAGE_SCRIPT_FAILED');
    }
  });
});

describe('指纹自愈（spec 2.2-05）', () => {
  it('声明候选全部失配、指纹两处特征吻合时自愈命中，并发出 locator/relocated 事件', async () => {
    const { ctx, locate } = await boot(
      {},
      labView({ locate: [], fingerprint: [fakeReading(frameUrl, { strategy: 'fingerprint', candidateIndex: -1 })] }),
    );
    const events: { description: string; strategy: string; score: number; because: string }[] = [];
    ctx.on('locator/relocated', (event) => events.push(event));
    const result = await locate.find(testIdSpec, greetFingerprint());
    expect(result.status).toBe('matched');
    expect(result.relocated).toBe(true);
    expect(result.chosen).toMatchObject({ strategy: 'fingerprint', score: 81 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ description: '打招呼按钮', strategy: 'fingerprint', score: 81 });
    // `because` 装的是**声明候选的落空原因**（界面把它标成「原始失败」），不能是自愈后的得分：
    // 两个字段写成同一句，2.7 的腐化统计就看不出「改版到底打掉了哪条通道」。
    expect(events[0]?.because).not.toBe(result.reason);
    expect(events[0]?.because).not.toContain('fingerprint');
  });

  it('只有标签名相同不足以自愈——基础分低于 minScore，改版后不会点到陌生人身上', async () => {
    const { ctx, locate } = await boot(
      {},
      labView({
        locate: [],
        fingerprint: [
          fakeReading(frameUrl, {
            strategy: 'fingerprint',
            candidateIndex: -1,
            role: '',
            accessibleName: '关闭弹窗',
            text: '关闭',
            attributes: {},
          }),
        ],
      }),
    );
    const events: unknown[] = [];
    ctx.on('locator/relocated', (event) => events.push(event));
    const result = await locate.find(testIdSpec, greetFingerprint({ ancestorRoles: [], nearbyTexts: [] }));
    expect(result.status).toBe('not-found');
    expect(result.relocated).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('声明候选本来就过线时不跑自愈，也不发事件（自愈只补候选失配的那一次）', async () => {
    const { ctx, locate } = await boot({}, labView({ locate: [fakeReading(frameUrl)], fingerprint: [] }));
    const events: unknown[] = [];
    ctx.on('locator/relocated', (event) => events.push(event));
    const result = await locate.find(testIdSpec, greetFingerprint());
    expect(result.status).toBe('matched');
    expect(result.relocated).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('refind 是指纹的独立入口：命中时 relocated 为 true，没命中时如实 not-found', async () => {
    const { locate } = await boot(
      {},
      labView({ fingerprint: [fakeReading(frameUrl, { strategy: 'fingerprint', candidateIndex: -1 })] }),
    );
    const healed = await locate.refind(greetFingerprint());
    expect(healed).toMatchObject({ status: 'matched', relocated: true });
    expect(healed.snapshot).toBeNull();

    const missing = await locate.refind(greetFingerprint({ tagName: 'section' }));
    expect(missing.status).toBe('below-score');
    expect(missing.relocated).toBe(false);
    expect(missing.ranked[0]!.score).toBe(0);
  });
});

describe('定位层读数（spec 2.2-04 的可解释性）', () => {
  it('失败摘要只留最近 8 条，且最新在前', async () => {
    const { locate } = await boot({}, labView({ locate: [] }));
    for (let index = 0; index < 10; index += 1) {
      await locate.find(specOf(`声明 ${String(index)}`, [{ strategy: 'css', value: 'a' }]));
    }
    const status = locate.status();
    expect(status.recentFailures).toHaveLength(8);
    expect(status.recentFailures[0]!.description).toBe('声明 9');
    expect(status.recentFailures.at(-1)!.description).toBe('声明 2');
  });

  it('status 回的是当期阈值，且回传的数组是副本——界面改它不该改到服务内部', async () => {
    const { locate } = await boot(
      { minScore: 88, minMargin: 5, candidateLimit: 3 },
      labView({ locate: [fakeReading(frameUrl, { strategy: 'role' })] }),
    );
    const result = await locate.find(testIdSpec);
    expect(result.status).toBe('below-score');
    expect(result.snapshotRef).toContain(`${frameUrl}@`);
    const status = locate.status();
    expect(status).toMatchObject({ minScore: 88, minMargin: 5, candidateLimit: 3 });
    expect(status.recentFailures).toHaveLength(1);
    status.recentFailures.length = 0;
    expect(locate.status().recentFailures).toHaveLength(1);
  });

  it('成功定位不进失败摘要', async () => {
    const { locate } = await boot({}, labView({ locate: [fakeReading(frameUrl)] }));
    await locate.find(testIdSpec);
    expect(locate.status().recentFailures).toEqual([]);
  });
});
