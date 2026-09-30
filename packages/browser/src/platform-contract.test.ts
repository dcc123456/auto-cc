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
 * `capabilities` 默认只声明 `search` 同理——挂了 `chat` 就必须同时挂出 `chat` 段（2.5-05 的一致性检查），
 * 那些与它无关的报错用例不该被这条问题污染。
 * @param overrides 覆盖项（未知键会被 zod 拒收，所以这里保持宽松）
 * @returns 可以直接交给 `parseKnowledgePack` 的未知值
 */
function minimalPack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    platform: 'boss',
    displayName: 'BOSS 直聘',
    startUrl: 'https://www.zhipin.com',
    capabilities: ['search'],
    locators: {
      searchInput: {
        description: '关键词输入框',
        cardinality: 'single',
        candidates: [{ strategy: 'testId', attribute: 'data-testid', value: 'job-search-input' }],
      },
    },
    fieldOrder: ['title', 'company', 'salaryText'],
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
  it('一份合规的知识包原样落地，缺省字段由 schema 补齐', () => {
    const pack = parseKnowledgePack(
      minimalPack({
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
      search: { params: { keyword: 'query', city: 'city', experience: 'experience' } },
    });
    expect(pack.locators.greetButton!.candidates[0]).toMatchObject({ strategy: 'role', role: 'button' });
  });

  it('知识包再声明 pacing 段会被拒收（spec 2.7-04：节奏的唯一归属是 outbound.throttle）', () => {
    // 删掉一段数据不等于删掉了诱因：旧知识包（或照旧抄的一份）里还写着 pacing 时，
    // 必须在加载当场报错，而不是"读到了但没人用"——那正是 2.7-a 判死的那套第二节奏声明。
    const error = errorOf(() => parseKnowledgePack(minimalPack({ pacing: { minActionGapMs: 5_000 } }))) as AppError;
    expect(error.code).toBe('KNOWLEDGE_PACK_INVALID');
    // 顶层未知键的 path 是空数组（zod 把键名放在 message 里），所以读数长成「：Unrecognized key: "pacing"」。
    expect(errorDetails(error).problems).toEqual(['：Unrecognized key: "pacing"']);
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

/** 一份配齐的会话页声明，用例只在要写坏某一项时替换它。 */
const chatSection = {
  entryPath: '/chat',
  targetParam: 'targetId',
  input: 'chatInput',
  sendButton: 'chatSend',
  statusLine: 'chatStatus',
  sentPattern: '已送达服务端',
  messageItem: 'chatMessage',
  messageBody: 'chatMessageBody',
  messageIdAttribute: 'data-message-id',
  directionAttribute: 'data-direction',
  inboundValue: 'inbound',
};

describe('会话页知识（spec 2.5-05）', () => {
  /**
   * 造一份带完整会话页知识的知识包：五个被 `chat` 段引用的定位名与那一段本身。
   * @param overrides 覆盖项（用于把其中一处写坏）
   * @returns 交给 `parseKnowledgePack` 的未知值
   */
  function chatPack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    /**
     * 造一条只写 css 的定位声明（会话页控件的候选顺序不是本条验收的对象）。
     * @param many 页面里有多个这样的节点（消息项）还是只有一个
     * @returns 合法的定位声明
     */
    const pageLocator = (many: boolean) => ({
      description: '会话页节点',
      cardinality: many ? 'many' : 'single',
      candidates: [{ strategy: 'css', value: '.node' }],
    });
    return minimalPack({
      capabilities: ['search', 'chat', 'readReplies'],
      locators: {
        searchInput: pageLocator(false),
        chatInput: pageLocator(false),
        chatSend: pageLocator(false),
        chatStatus: pageLocator(false),
        chatMessage: pageLocator(true),
        chatMessageBody: pageLocator(false),
      },
      chat: chatSection,
      ...overrides,
    });
  }

  it('会话页知识配齐时原样落地，适配器读到的就是知识包写的', () => {
    const pack = chatPack();
    expect(pack.chat).toMatchObject({
      targetParam: 'targetId',
      statusLine: 'chatStatus',
      sentPattern: '已送达服务端',
      messageItem: 'chatMessage',
      messageBody: 'chatMessageBody',
      inboundValue: 'inbound',
    });
  });

  it('没有 messageBody 的包在加载时就拒绝：正文读哪个节点不能由代码猜', () => {
    try {
      parseKnowledgePack(chatPack({ chat: { ...chatSection, messageBody: undefined } }));
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect(errorDetails(error).problems).toEqual([
        'chat.messageBody：Invalid input: expected string, received undefined',
      ]);
    }
  });

  it('声明了 chat / readReplies 却没有 chat 段：加载时就报错，适配器拿不到猜出来的选择器', () => {
    try {
      parseKnowledgePack(minimalPack({ capabilities: ['search', 'chat'] }));
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect(errorDetails(error).problems).toEqual([
        'chat：capabilities 含 chat / readReplies，但知识包没有 chat 段（页面知识不能靠猜）',
      ]);
    }
  });

  it('chat 段引用了不存在的定位名时逐条点名是哪一处', () => {
    try {
      parseKnowledgePack(chatPack({ chat: { ...chatSection, statusLine: 'ghostStatus', input: 'ghostInput' } }));
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect(errorDetails(error).problems).toEqual([
        'chat.input：引用了不存在的定位名「ghostInput」',
        'chat.statusLine：引用了不存在的定位名「ghostStatus」',
      ]);
    }
  });
});

/** 一份配齐的投递页声明，用例只在要写坏某一项时替换它。 */
const deliverSection = {
  entryPath: '/deliver',
  targetParam: 'targetId',
  uploadInput: 'resumeUploadInput',
  sendButton: 'resumeSend',
  statusLine: 'deliverStatus',
  sentPattern: '简历已送达',
  offlinePattern: '岗位已下架',
};

describe('投递页知识（spec 2.6-04 / 2.6-07）', () => {
  /**
   * 造一份带完整投递页知识的知识包：三处被 `deliver` 段引用的定位名与那一段本身。
   * @param overrides 覆盖项（用于把其中一处写坏）
   * @returns 交给 `parseKnowledgePack` 的未知值
   */
  function deliverPack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    /**
     * 造一条只写 css 的定位声明（上传控件的候选顺序不是本条验收的对象）。
     * @param actionable 是否需要「可被指点」判据（隐藏 input 必须豁免，plan §13.6 第 3 条）
     * @returns 合法的定位声明
     */
    const pageLocator = (actionable: boolean) => ({
      description: '投递页节点',
      cardinality: 'single',
      ...(actionable ? {} : { requireActionable: false }),
      candidates: [{ strategy: 'css', value: '.node' }],
    });
    return minimalPack({
      capabilities: ['search', 'sendResume'],
      locators: {
        searchInput: pageLocator(true),
        resumeUploadInput: pageLocator(false),
        resumeSend: pageLocator(true),
        deliverStatus: pageLocator(true),
      },
      deliver: deliverSection,
      ...overrides,
    });
  }

  it('投递页知识配齐时原样落地，隐藏的上传控件带着豁免一起过校验', () => {
    const pack = parseKnowledgePack(deliverPack());
    expect(pack.deliver).toMatchObject({
      targetParam: 'targetId',
      uploadInput: 'resumeUploadInput',
      statusLine: 'deliverStatus',
      sentPattern: '简历已送达',
      offlinePattern: '岗位已下架',
    });
    // 隐藏 input 读不到盒模型：这条声明若按默认可点判据，注入类动作在定位阶段就必失败。
    expect(pack.locators.resumeUploadInput!.requireActionable).toBe(false);
    expect(pack.locators.resumeSend!.requireActionable).toBeUndefined();
  });

  it('声明了 sendResume 却没有 deliver 段：加载时就报错，适配器拿不到猜出来的选择器', () => {
    try {
      parseKnowledgePack(minimalPack({ capabilities: ['search', 'sendResume'] }));
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect(errorDetails(error).problems).toEqual([
        'deliver：capabilities 含 sendResume，但知识包没有 deliver 段（页面知识不能靠猜）',
      ]);
    }
  });

  it('deliver 段引用了不存在的定位名时逐条点名是哪一处', () => {
    try {
      parseKnowledgePack(
        deliverPack({ deliver: { ...deliverSection, statusLine: 'ghostStatus', uploadInput: 'ghostInput' } }),
      );
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect(errorDetails(error).problems).toEqual([
        'deliver.uploadInput：引用了不存在的定位名「ghostInput」',
        'deliver.statusLine：引用了不存在的定位名「ghostStatus」',
      ]);
    }
  });

  it('缺 offlinePattern 直接判非法：「还在不在招」只能由页面数据回答，不给代码留默认值', () => {
    try {
      parseKnowledgePack(deliverPack({ deliver: { ...deliverSection, offlinePattern: undefined } }));
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect(errorDetails(error).problems).toEqual([
        'deliver.offlinePattern：Invalid input: expected string, received undefined',
      ]);
    }
  });
});
