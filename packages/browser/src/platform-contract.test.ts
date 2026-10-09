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
import { parseKnowledgePack, resolveCityParam } from './platform-contract.js';
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
    // 许可名单的来源（spec 8.1-01）：默认与 startUrl 同源，用例只在自己关心的那一项上写坏它。
    origins: ['https://www.zhipin.com'],
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
    return minimalPack({
      capabilities: ['search', 'chat', 'readReplies'],
      locators: {
        searchInput: chatLocator(false),
        chatInput: chatLocator(false),
        chatSend: chatLocator(false),
        chatStatus: chatLocator(false),
        chatMessage: chatLocator(true),
        chatMessageBody: chatLocator(false),
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

  it('配齐选行那两只时原样落地，两条定位名都参与存在性检查（spec 8.4-01）', () => {
    const pack = chatPack({
      locators: {
        ...chatLocators(),
        chatRow: chatLocator(true),
        chatRowLabel: chatLocator(true),
      },
      chat: { ...chatSection, conversationRow: 'chatRow', conversationRowLabel: 'chatRowLabel' },
    });
    expect(pack.chat).toMatchObject({ conversationRow: 'chatRow', conversationRowLabel: 'chatRowLabel' });
  });

  it('选行只声明一只时拒收：有行没标签不知道认哪个字，有标签没行等不到列表长出来', () => {
    const rowOnly = {
      capabilities: ['search', 'chat', 'readReplies'],
      locators: { ...chatLocators(), chatRow: chatLocator(true) },
      chat: { ...chatSection, conversationRow: 'chatRow' },
    };
    const labelOnly = {
      capabilities: ['search', 'chat', 'readReplies'],
      locators: { ...chatLocators(), chatRowLabel: chatLocator(true) },
      chat: { ...chatSection, conversationRowLabel: 'chatRowLabel' },
    };
    for (const overrides of [rowOnly, labelOnly]) {
      try {
        parseKnowledgePack(chatPack(overrides));
        expect.unreachable('应当抛出结构化错误');
      } catch (error) {
        expect(errorDetails(error).problems).toEqual([
          'chat：conversationRow 与 conversationRowLabel 必须成对出现（选行这一步两只都要用）',
        ]);
      }
    }
  });

  it('既不能按 URL 切会话、也不能按列表行选会话时拒收：动作只能落在屏幕恰好选中的那条上', () => {
    try {
      parseKnowledgePack(
        chatPack({
          chat: { ...chatSection, targetParam: undefined, conversationRow: undefined, conversationRowLabel: undefined },
        }),
      );
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect(errorDetails(error).problems).toEqual([
        'chat：既没有 targetParam（URL 能直接定位会话）也没有 conversationRow/conversationRowLabel（按列表行选中），无法确定动作要落在哪条会话上',
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

/**
 * 造一条只写 css 的定位声明（候选顺序不是本组验收的对象）。
 * @param actionable 是否需要「可被指点」判据（隐藏 input 必须豁免，plan §13.6 第 3 条）
 * @returns 合法的定位声明
 */
const pageLocatorOf = (actionable: boolean): Record<string, unknown> => ({
  description: '投递页节点',
  cardinality: 'single',
  ...(actionable ? {} : { requireActionable: false }),
  candidates: [{ strategy: 'css', value: '.node' }],
});

describe('投递页知识（spec 2.6-04 / 2.6-07）', () => {
  /**
   * 造一份带完整投递页知识的知识包：三处被 `deliver` 段引用的定位名与那一段本身。
   * @param overrides 覆盖项（用于把其中一处写坏）
   * @returns 交给 `parseKnowledgePack` 的未知值
   */
  function deliverPack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return minimalPack({
      capabilities: ['search', 'sendResume'],
      locators: {
        searchInput: pageLocatorOf(true),
        resumeUploadInput: pageLocatorOf(false),
        resumeSend: pageLocatorOf(true),
        deliverStatus: pageLocatorOf(true),
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

  it('缺 offlinePattern 是合法的中间态：这家平台还没登记下架文案，代码里不许有默认值（裁定㉑ 之外的 ㉒）', () => {
    // 缺这一格**不是**「默认还在招」——适配器据此跳过预校验并在结局里如实写明，见 adapter 的那条用例。
    const pack = parseKnowledgePack(deliverPack({ deliver: { ...deliverSection, offlinePattern: undefined } }));
    expect(pack.deliver!.offlinePattern).toBeUndefined();
  });

  it('缺 sendButton 与 sentPattern 也是合法的中间态：只注入不点（spec 8.5-01 的裁定）', () => {
    // 真 BOSS 的投递口长在会话里，而"注完文件以后要点哪一颗"从来没有在场读数（证据 8.0-06 第五节）。
    // 这两只从必填变可选，缺的那一格才在数据里看得出来：适配器停在注入之后，结局恒为 `sent:false`。
    const pack = parseKnowledgePack(
      deliverPack({ deliver: { uploadInput: deliverSection.uploadInput, statusLine: deliverSection.statusLine } }),
    );
    expect(pack.deliver!.uploadInput).toBe('resumeUploadInput');
    expect(pack.deliver!.sendButton).toBeUndefined();
    expect(pack.deliver!.sentPattern).toBeUndefined();
  });

  it('sendButton 与 sentPattern 只登记一只就拒包：半配的形状在页面上必输', () => {
    // 只有键 = 点出去之后没有成功凭据（账却已经落了）；只有样式 = 永远不会去点（等一次不发生的变化）。
    for (const half of ['sendButton', 'sentPattern'] as const) {
      const other = half === 'sendButton' ? 'sentPattern' : 'sendButton';
      try {
        parseKnowledgePack(deliverPack({ deliver: { ...deliverSection, [other]: undefined } }));
        expect.unreachable(`只登记 ${half} 应当拒包`);
      } catch (error) {
        expect(errorDetails(error).problems, `${half} 单独出现`).toEqual([
          'deliver：sendButton 与 sentPattern 必须成对出现（只注入不点就两只都省，缺一不可）',
        ]);
      }
    }
  });

  it('只有 deliver.uploadInput 能用注入档：发送键借这一档降分即拒包（裁定㉑）', () => {
    try {
      parseKnowledgePack(
        deliverPack({
          locators: {
            searchInput: { ...pageLocatorOf(true), effect: 'read' },
            resumeUploadInput: { ...pageLocatorOf(false), effect: 'inject' },
            resumeSend: { ...pageLocatorOf(true), effect: 'inject' },
            deliverStatus: pageLocatorOf(true),
          },
        }),
      );
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect(String(errorDetails(error).problems)).toContain(
        "resumeSend：effect:'inject' 是注入档，只有 deliver.uploadInput 一条能用（裁定㉑）",
      );
    }
  });

  it('声明注入档却不带 requireActionable:false 同样拒包：两条在真站点上是同一件事', () => {
    try {
      parseKnowledgePack(
        deliverPack({
          locators: {
            searchInput: pageLocatorOf(true),
            // 隐藏的上传控件读不到盒模型：只降分数不豁免可点判据，等于"过了线也注不进去"。
            resumeUploadInput: { ...pageLocatorOf(true), effect: 'inject' },
            resumeSend: pageLocatorOf(true),
            deliverStatus: pageLocatorOf(true),
          },
        }),
      );
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect(String(errorDetails(error).problems)).toContain(
        "resumeUploadInput：声明 effect:'inject' 必须同时带 requireActionable:false",
      );
    }
  });

  it('uploadInput 的合法形状：注入档 + 可点豁免一起声明时原样落地', () => {
    const pack = parseKnowledgePack(
      deliverPack({
        locators: {
          searchInput: pageLocatorOf(true),
          resumeUploadInput: { ...pageLocatorOf(false), effect: 'inject' },
          resumeSend: pageLocatorOf(true),
          deliverStatus: pageLocatorOf(true),
        },
      }),
    );
    expect(pack.locators.resumeUploadInput).toMatchObject({ effect: 'inject', requireActionable: false });
  });
});

describe('风控文案判据段（spec 2.7-01：那句拦下页的话是站点知识，不是代码）', () => {
  it('配了 risk 段时原样落地，观测层拿到的就是这份源码', () => {
    const pack = parseKnowledgePack(minimalPack({ risk: { riskPattern: '安全验证|访问验证' } }));
    expect(pack.risk).toEqual({ riskPattern: '安全验证|访问验证' });
  });

  it('没有 risk 段是合法的知识包：这条站只按 HTTP 状态码判，正文判据不靠代码猜', () => {
    expect(parseKnowledgePack(minimalPack()).risk).toBeUndefined();
  });

  it('riskPattern 编译不过就在加载当场报错，而不是等到真撞风控时静默不命中', () => {
    // 报错消息里的 V8 原文随引擎变，所以只钉「哪一处、为什么」这一段，不钉它后面那句。
    try {
      parseKnowledgePack(minimalPack({ risk: { riskPattern: '[未闭合' } }));
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('KNOWLEDGE_PACK_INVALID');
      expect(String(errorDetails(error).problems)).toMatch(/^risk\.riskPattern：不是合法的正则源码（/);
    }
  });

  it('空串同样非法：空判据匹配一切，那等于把每一页都判成被风控拦下', () => {
    const error = errorOf(() => parseKnowledgePack(minimalPack({ risk: { riskPattern: '' } }))) as AppError;
    expect(error.code).toBe('KNOWLEDGE_PACK_INVALID');
  });

  it('risk 段里的未知键被拒收：判据只有这一条口径，不留第二种写法', () => {
    try {
      parseKnowledgePack(minimalPack({ risk: { riskPattern: '安全验证', flags: 'i' } }));
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('KNOWLEDGE_PACK_INVALID');
      expect(String(errorDetails(error).problems)).toContain('Unrecognized key: "flags"');
    }
  });
});

/**
 * 上线包与许可名单（P8 8.1-01 / 8.1-02）。
 *
 * 这一组是「真实站点驱动」的地基：`origins` 是导航许可的唯一来源，`packStatus` 决定
 * 「写这份包的人到底看过页面没有」能不能机检。两者的失败都必须落在加载期，
 * 而不是到了真站点上以「读不到 / 点不动」的形式出现。
 */
describe('上线包与许可名单（spec 8.1-01 / 8.1-02）', () => {
  /** 一份合格的在场取证读数（字段形状取自 `locatorEvidenceSchema`）。 */
  const evidence = {
    ref: 'docs/acceptance/08-real-platform-driving/8.0-03-list-dom-evidence.txt',
    url: 'https://www.zhipin.com/web/geek/jobs?query=前端',
    verifiedAt: 1,
    hits: 1,
  };

  it('缺 origins 或空数组都不合法：许可名单不能靠代码里的默认值兜', () => {
    const missing = errorOf(() => parseKnowledgePack({ ...minimalPack(), origins: undefined })) as AppError;
    expect(missing.code).toBe('KNOWLEDGE_PACK_INVALID');
    expect(String(errorDetails(missing).problems)).toContain('origins');
    const empty = errorOf(() => parseKnowledgePack(minimalPack({ origins: [] }))) as AppError;
    expect(String(errorDetails(empty).problems)).toContain('origins');
  });

  it('origin 写成带路径的地址被拒：那是把「源」与「页面」混成一件东西', () => {
    const error = errorOf(() => parseKnowledgePack(minimalPack({ origins: ['https://www.zhipin.com/web/geek'] })));
    expect(errorDetails(error as AppError).problems).toEqual([
      'origins.0：origin 不许带路径、查询或锚（形如 https://example.com）',
    ]);
  });

  it('名单不含 startUrl 自己的源时拒收：否则适配器第一个导航动作就会被自己的包挡掉', () => {
    try {
      parseKnowledgePack(minimalPack({ origins: ['https://fixture.example.com'] }));
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect(errorDetails(error).problems).toEqual([
        'origins：不含 startUrl 的源「https://www.zhipin.com」（许可名单必须覆盖自己的起始页）',
      ]);
    }
  });

  it('缺省 packStatus 是 draft：仿站包与取证中的包不该被证据判据挡住', () => {
    expect(parseKnowledgePack(minimalPack()).packStatus).toBe('draft');
  });

  it('shipped 包里既没证据又没标 unverified 的候选逐条点名（spec 8.1-02）', () => {
    try {
      parseKnowledgePack(minimalPack({ packStatus: 'shipped' }));
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect((error as AppError).code).toBe('KNOWLEDGE_PACK_INVALID');
      expect(errorDetails(error).problems).toEqual([
        'searchInput 候选 0（testId）：上线包里的每条候选要么带 evidence，要么显式 unverified:true',
      ]);
    }
  });

  it('shipped 包两种记号都认：有证据的过，显式未取证的也过（后者由外发通道自己停手）', () => {
    const pack = parseKnowledgePack(
      minimalPack({
        packStatus: 'shipped',
        locators: {
          searched: {
            description: '已录证据的容器',
            cardinality: 'single',
            candidates: [{ strategy: 'css', value: '.card-area', evidence }],
          },
          guessed: {
            description: '还没录证据的控件',
            cardinality: 'single',
            candidates: [{ strategy: 'css', value: '.not-tested', unverified: true }],
          },
        },
      }),
    );
    expect(pack.locators.searched!.candidates[0]!.evidence).toEqual(evidence);
    expect(pack.locators.guessed!.candidates[0]!.unverified).toBe(true);
  });

  it('外发通道引用的定位声明 effect:"read" 时拒收：那是去够读档的低阈值，与裁定⑤ 相反', () => {
    try {
      parseKnowledgePack(
        minimalPack({
          capabilities: ['search', 'chat', 'readReplies'],
          locators: {
            chatInput: {
              description: '输入框',
              cardinality: 'single',
              candidates: [{ strategy: 'css', value: '.chat-input' }],
            },
            chatSend: {
              description: '发送键',
              cardinality: 'single',
              effect: 'read',
              candidates: [{ strategy: 'css', value: '.btn-send' }],
            },
            chatStatus: {
              description: '状态行',
              cardinality: 'single',
              candidates: [{ strategy: 'css', value: '.status' }],
            },
            chatMessage: {
              description: '消息项',
              cardinality: 'many',
              candidates: [{ strategy: 'css', value: '.message-item' }],
            },
            chatMessageBody: {
              description: '消息正文',
              cardinality: 'single',
              candidates: [{ strategy: 'css', value: '.text' }],
            },
          },
          chat: chatSection,
        }),
      );
      expect.unreachable('应当抛出结构化错误');
    } catch (error) {
      expect(String(errorDetails(error).problems)).toContain(
        "chatSend：外发通道引用的定位不许声明 effect:'read'（那是去够读档的低阈值，与裁定⑤ 相反）",
      );
    }
  });

  it('方向判据两种形状都合法，但只能填一种、且不许都不填', () => {
    const tokenPack = {
      ...chatSection,
      directionAttribute: undefined,
      inboundValue: undefined,
      inboundClassToken: 'item-friend',
    };
    expect(
      parseKnowledgePack(
        minimalPack({ capabilities: ['search', 'chat', 'readReplies'], locators: chatLocators(), chat: tokenPack }),
      ).chat?.inboundClassToken,
    ).toBe('item-friend');

    const both = errorOf(() =>
      parseKnowledgePack(
        minimalPack({
          capabilities: ['search', 'chat', 'readReplies'],
          locators: chatLocators(),
          chat: { ...chatSection, inboundClassToken: 'item-friend' },
        }),
      ),
    ) as AppError;
    expect(String(errorDetails(both).problems)).toContain('只能填一种');

    const neither = errorOf(() =>
      parseKnowledgePack(
        minimalPack({
          capabilities: ['search', 'chat', 'readReplies'],
          locators: chatLocators(),
          chat: { ...chatSection, directionAttribute: undefined, inboundValue: undefined },
        }),
      ),
    ) as AppError;
    expect(String(errorDetails(neither).problems)).toContain('方向判据缺失');
  });
});

/**
 * 造一条 css 级的定位声明（会话页控件的候选顺序不是本组用例的对象）。
 * @param many 页面里有多个这样的节点（消息项、列表行）还是只有一个
 * @returns 合法的定位声明
 */
function chatLocator(many: boolean): Record<string, unknown> {
  return {
    description: '会话页节点',
    cardinality: many ? 'many' : 'single',
    candidates: [{ strategy: 'css', value: '.node' }],
  };
}

/**
 * 造一组会话页定位声明（方向判据那两条用例要用，形状与被 `chat` 段引用的五处一致）。
 * @returns 五个定位名的声明表
 */
function chatLocators(): Record<string, unknown> {
  return {
    searchInput: chatLocator(false),
    chatInput: chatLocator(false),
    chatSend: chatLocator(false),
    chatStatus: chatLocator(false),
    chatMessage: chatLocator(true),
    chatMessageBody: chatLocator(false),
  };
}

describe('城市名 → 城市码（spec 8.3-05）', () => {
  const table = { 上海: '101020100', 北京: '101010100' };

  it('登记过的名字换成站点码', () => {
    expect(resolveCityParam('上海', table, 'boss')).toBe('101020100');
  });

  it('纯数字原样传：表还没补全时，知道码的人不该被堵死', () => {
    expect(resolveCityParam('101020100', table, 'boss')).toBe('101020100');
    expect(resolveCityParam(' 101020100 ', table, 'boss')).toBe('101020100');
  });

  it('空值与全空白都回 undefined，调用方因此不带这个参数', () => {
    expect(resolveCityParam(undefined, table, 'boss')).toBeUndefined();
    expect(resolveCityParam('   ', table, 'boss')).toBeUndefined();
  });

  it('表为空的平台原样传值：未标定不等于标定失败（仿站那份包本来就没有城市码表）', () => {
    expect(resolveCityParam('上海', {}, 'boss')).toBe('上海');
  });

  it('表非空却查不到这个名字 ⇒ 以 INVALID_ARGUMENT 停下，并把可填的名字交回去', () => {
    // 这条是整张表的理由：把人话塞进 URL，站点不报错，它静默忽略参数按定位城市出结果，
    // 于是"筛了上海"变成一句谎话。明知有表还查不到，就是明知故犯。
    expect(() => resolveCityParam('杭州', table, 'boss')).toThrowError(/城市码表里没有/);
    try {
      resolveCityParam('杭州', table, 'boss');
      expect.unreachable('上面那一句必须抛');
    } catch (error) {
      expect((error as AppError).code).toBe('INVALID_ARGUMENT');
      expect(errorDetails(error).known).toEqual(['上海', '北京']);
    }
  });

  it('search.cities 缺省是空表，城市码写成非数字在装载期就被拒', () => {
    expect(parseKnowledgePack(minimalPack()).search.cities).toEqual({});
    const error = errorOf(() =>
      parseKnowledgePack(
        minimalPack({ search: { params: { keyword: 'query', city: 'city' }, cities: { 上海: '沪' } } }),
      ),
    ) as AppError;
    expect(error.code).toBe('KNOWLEDGE_PACK_INVALID');
    // 报错要落在「哪一格」上：路径里带着 cities 与那枚键名，改包的人不必再猜。
    expect(String(errorDetails(error).problems)).toContain('城市码');
    expect(String(errorDetails(error).problems)).toContain('cities');
  });
});
