/**
 * 站点知识包的校验用例（spec 2.2-08）。
 *
 * 知识包是**外部数据**（站点改版就会改它），所以它的入口必须把两层检查都做完：
 * zod 管形状（枚举、必填、范围），`validateSpec` 管语义（一条候选缺 value、testId 的属性名非法，
 * 结构层面全都合法，但下发到页面只会得到「找不到」）。错误里要按 `定位名：问题` 逐条列出，
 * 否则改一份知识包的人只能靠猜是哪一条写错了。
 */
import type { AppError } from '@auto-cc/core';
import { describe, expect, it } from 'vitest';
import { parseKnowledgePack } from './platform-contract.js';
import { errorDetails } from './test-doubles.js';

/**
 * 一份「什么都能过」的最小知识包，用例只改动自己关心的那一项。
 *
 * `capture` 与 `search` 是 2.3 起必填的两节，但它们是**跟随定位表**生成的：用例替换整个
 * `locators` 时不必同时改抓取声明，否则每条报错用例都要重复写一遍引用关系（噪音会盖掉被检的那一项）。
 * @param overrides 覆盖项（未知键会被 zod 拒收，所以这里保持宽松）
 * @returns 可以直接交给 `parseKnowledgePack` 的未知值
 */
function minimalPack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    platform: 'boss',
    displayName: 'BOSS 直聘',
    startUrl: 'https://www.zhipin.com',
    capabilities: ['search', 'chat'],
    locators: {
      searchInput: {
        description: '关键词输入框',
        cardinality: 'single',
        candidates: [{ strategy: 'testId', attribute: 'data-testid', value: 'job-search-input' }],
      },
    },
    fieldOrder: ['title', 'company', 'salaryText'],
    pacing: { minActionGapMs: 3_000, maxDailyActions: 20 },
    ...overrides,
  };
  const [firstName] = Object.keys(merged.locators ?? {});
  const container = String(firstName);
  merged.capture ??= {
    list: { container, fields: [{ name: 'title', locator: container }] },
    detail: { container, fields: [{ name: 'description', locator: container }] },
  };
  merged.search ??= { params: { keyword: 'query', city: 'city', experience: 'experience' } };
  return merged;
}

describe('知识包通过校验（spec 2.2-08）', () => {
  it('一份合规的知识包原样落地，缺省的节奏参数由 schema 补齐', () => {
    const pack = parseKnowledgePack(
      minimalPack({
        capabilities: ['search'],
        fieldOrder: [],
        locators: {
          greetButton: {
            description: '打招呼按钮',
            cardinality: 'single',
            candidates: [{ strategy: 'role', role: 'button', name: '打招呼' }],
          },
        },
      }),
    );

    expect(pack).toMatchObject({
      platform: 'boss',
      fieldOrder: [],
      pacing: { minActionGapMs: 3_000, maxDailyActions: 20 },
      search: { params: { keyword: 'query', city: 'city', experience: 'experience' } },
    });
    expect(pack.locators.greetButton!.candidates[0]).toMatchObject({ strategy: 'role', role: 'button' });
  });

  it('抓取声明引用了不存在的定位名时在加载时就报错，而不是等到抓取时「某字段永远读不到」（spec 2.3-02）', () => {
    try {
      parseKnowledgePack(
        minimalPack({
          // 只把 list 这一处写坏：detail 仍指向真实存在的定位名，好证明报错落在「哪一处」。
          capture: {
            list: { container: 'ghostCard', fields: [{ name: 'title', locator: 'ghostTitle' }] },
            detail: { container: 'searchInput', fields: [{ name: 'description', locator: 'searchInput' }] },
          },
        }),
      );
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('KNOWLEDGE_PACK_INVALID');
      expect(errorDetails(error).problems).toEqual([
        'capture.list.container：引用了不存在的定位名「ghostCard」',
        'capture.list.title：引用了不存在的定位名「ghostTitle」',
      ]);
    }
  });

  it('缺 capture 或 search 任一节都不算一份可用的知识包（2.3 起是必填项）', () => {
    const withoutCapture = { ...minimalPack(), capture: undefined };
    const withoutSearch = { ...minimalPack(), search: undefined };
    expect((errorOf(() => parseKnowledgePack(withoutCapture)) as AppError).code).toBe('KNOWLEDGE_PACK_INVALID');
    expect((errorOf(() => parseKnowledgePack(withoutSearch)) as AppError).code).toBe('KNOWLEDGE_PACK_INVALID');
  });

  it('多种定位策略混在一条 spec 里是合法的（候选顺序就是优先级）', () => {
    const pack = parseKnowledgePack(
      minimalPack({
        locators: {
          jobCard: {
            description: '岗位卡片',
            cardinality: 'many',
            candidates: [
              { strategy: 'testId', attribute: 'data-testid', value: 'job-card' },
              { strategy: 'id', value: 'job-card' },
              { strategy: 'name', value: 'job' },
              { strategy: 'role', role: 'link', name: '前端' },
              { strategy: 'text', value: '岗位职责', exact: false },
              { strategy: 'css', value: 'li.job-card-wrapper' },
              { strategy: 'xpath', value: '//li[contains(@class,"job-card")]' },
            ],
          },
        },
      }),
    );
    expect(pack.locators.jobCard!.candidates.map((c) => c.strategy)).toEqual([
      'testId',
      'id',
      'name',
      'role',
      'text',
      'css',
      'xpath',
    ]);
  });

  it('fingerprint 不能当知识包候选——它是运行期自愈读数，页面扫描里永远匹配不上', () => {
    try {
      parseKnowledgePack(
        minimalPack({
          locators: {
            greetButton: {
              description: '打招呼按钮',
              cardinality: 'single',
              candidates: [{ strategy: 'fingerprint' }],
            },
          },
        }),
      );
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect(errorDetails(error).problems).toEqual(['greetButton：候选 0（fingerprint）：缺少 value']);
    }
  });
});

/** 取出一次调用抛出的错误：报错用例断言的是错误本身，而不是「它有没有抛」。 */
function errorOf(call: () => unknown): unknown {
  try {
    call();
    return new Error('未抛出错误');
  } catch (error) {
    return error;
  }
}

describe('结构与语义分层报错（spec 2.2-08）', () => {
  it('平台标识写成大写或带空格时，报的是 path 而不是整包静默失败', () => {
    try {
      parseKnowledgePack(minimalPack({ platform: 'BOSS Zhipin' }));
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('KNOWLEDGE_PACK_INVALID');
      expect(errorDetails(error).problems).toEqual(['platform：平台标识要用小写字母开头的短名']);
    }
  });

  it('未知能力名被拒—— capabilities 是闭集，写错就永远匹配不上', () => {
    try {
      parseKnowledgePack(minimalPack({ capabilities: ['search', 'crawlEverything'] }));
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('KNOWLEDGE_PACK_INVALID');
      expect(String((errorDetails(error).problems as string[])[0])).toContain('capabilities.1');
    }
  });

  it('多余的键一律拒收，防止把「以为生效」的旧字段带进站点改版', () => {
    try {
      parseKnowledgePack(minimalPack({ timeoutMs: 3_000 }));
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('KNOWLEDGE_PACK_INVALID');
      expect(String((errorDetails(error).problems as string[])[0])).toContain('timeoutMs');
    }
  });

  it('candidates 为空数组过不了 zod，报错落在 locators.<名>.candidates', () => {
    try {
      parseKnowledgePack(
        minimalPack({
          locators: { chatInput: { description: '聊天输入框', cardinality: 'single', candidates: [] } },
        }),
      );
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('KNOWLEDGE_PACK_INVALID');
      expect(errorDetails(error).problems).toEqual([
        'locators.chatInput.candidates：Too small: expected array to have >=1 items',
      ]);
    }
  });

  it('形状合法但语义不可用（role 少了可读名）由第二层校验兜住，并带上定位名', () => {
    try {
      parseKnowledgePack(
        minimalPack({
          locators: {
            chatInput: { description: '聊天输入框', cardinality: 'single', candidates: [{ strategy: 'role' }] },
          },
        }),
      );
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('KNOWLEDGE_PACK_INVALID');
      expect(errorDetails(error).problems).toEqual([
        'chatInput：候选 0（role）：缺少 role',
        'chatInput：候选 0（role）：缺少可读名 name',
      ]);
      expect((error as AppError).message).toContain('chatInput');
    }
  });

  it('testId 的属性名写成选择器时直接判非法——那是注入进 querySelector 的口子', () => {
    try {
      parseKnowledgePack(
        minimalPack({
          locators: {
            greetButton: {
              description: '打招呼按钮',
              cardinality: 'single',
              candidates: [{ strategy: 'testId', attribute: 'data-testid][onclick', value: 'greet' }],
            },
          },
        }),
      );
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect(errorDetails(error).problems).toEqual([
        'greetButton：候选 0（testId）：属性名非法（data-testid][onclick）',
      ]);
    }
  });

  it('多处同时写错时，语义问题按声明顺序全量列出而不是只报第一条', () => {
    try {
      parseKnowledgePack(
        minimalPack({
          locators: {
            zebraLocator: {
              description: '字典序在后',
              cardinality: 'single',
              candidates: [{ strategy: 'testId', value: 'x' }],
            },
            alphaLocator: { description: '字典序在前', cardinality: 'single', candidates: [{ strategy: 'css' }] },
          },
        }),
      );
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect(errorDetails(error).problems).toEqual([
        'zebraLocator：候选 0（testId）：属性名非法（空）',
        'alphaLocator：候选 0（css）：缺少 value',
      ]);
    }
  });
});
