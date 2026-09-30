/**
 * 批量抽取脚本的用例（spec 2.3-01 / 2.3-02 的读页面那一半，加 2.5-07 的 `scope:'self'`）。
 *
 * 这里跑的是**生成的那段源码本身**：`new Function` 在替身 DOM 上求值。桩掉它等于没测——
 * 模板字面量里写进一个反引号就会让整段脚本提前闭合（本次踩过），只有真的编译它才报得出来；
 * 而 `scope:'self'` 的语义（读容器整棵子树，永远不是子节点）也只能在真 DOM 形状上验。
 * 替身只实现脚本真正碰到的那几个面，多一个都不写（同 `locator-script.test.ts` 的做法）。
 */
import { describe, expect, it } from 'vitest';
import type { ExtractFieldReading, ExtractFieldSpec, ExtractRowReading, LocateCandidate } from '@auto-cc/shared';
import { buildExtractScript, toExtractFrameReading, type ExtractLimits } from './extract-script.js';

/** 替身节点：注入脚本只碰这几个面。 */
type FakeNode = {
  tagName: string;
  attrs: Record<string, string>;
  kids: FakeNode[];
  /** 与真实 DOM 一致：容器自身的正文包含所有后代的正文。 */
  innerText: string;
  textContent: string;
  getAttribute: (name: string) => string | null;
  querySelectorAll: (selector: string) => FakeNode[];
};

/**
 * 造一个替身节点。
 * @param tagName 标签名（`role` 候选会拿它当隐式角色）
 * @param init 属性表、自身文案、子节点
 * @returns 具备 `querySelectorAll` 的替身节点
 */
function fakeNode(
  tagName: string,
  init: { attrs?: Record<string, string>; text?: string; kids?: FakeNode[] } = {},
): FakeNode {
  const attrs = init.attrs ?? {};
  const kids = init.kids ?? [];
  const subtreeText = [init.text ?? '', ...kids.map((kid) => kid.innerText)].join(' ').trim();
  return {
    tagName,
    attrs,
    kids,
    innerText: subtreeText,
    textContent: subtreeText,
    getAttribute: (name: string) => attrs[name] ?? null,
    querySelectorAll: (selector: string) => descendantsOf(kids).filter((node) => matchesSelector(node, selector)),
  };
}

/** 展开成「这些节点本身 + 它们的全部后代」。 */
function descendantsOf(nodes: FakeNode[]): FakeNode[] {
  return nodes.flatMap((node) => [node, ...descendantsOf(node.kids)]);
}

/** 极简选择器匹配：只认 `tag` / `.class` / `[attr]` / `[attr="v"]` 的串联，遇到组合器就抛错。 */
function matchesSelector(node: FakeNode, selector: string): boolean {
  if (/[\s>]/.test(selector) || selector.includes(':')) throw new Error(`替身选择器引擎不支持：${selector}`);
  if (selector === '*') return true;
  const parts = selector.match(/^[a-zA-Z0-9]+|\.[a-zA-Z0-9_-]+|\[[^\]]+\]/g) ?? [];
  return parts.every((part) => {
    if (part.startsWith('.')) return (node.attrs.class ?? '').split(' ').includes(part.slice(1));
    if (part.startsWith('[')) {
      const [name = '', rawValue] = part.slice(1, -1).split('=');
      if (rawValue === undefined) return node.attrs[name] !== undefined;
      return node.attrs[name] === rawValue.replace(/^["']|["']$/g, '');
    }
    return node.tagName.toLowerCase() === part.toLowerCase();
  });
}

/** 抽取的取回上限：正文 200 字、最多 10 个容器，够用例表达「钳制」这件事。 */
const limits: ExtractLimits = { textLimit: 200, rowLimit: 10 };

/** css 策略的单候选定位声明（候选顺序不是本文件的验收对象）。 */
const byCss = (value: string): LocateCandidate => ({ strategy: 'css', value });

/**
 * 在替身页面上真跑一遍生成的脚本。
 * @param containerSelector 容器的 css 选择器（脚本按声明顺序取第一条命中的候选）
 * @param fields 字段声明列表
 * @param page 页面根节点集合
 * @param overrides 取回上限的改动（只用于截断类用例）
 * @returns 钳制后的抽取读数
 */
function runExtract(
  containerSelector: string,
  fields: ExtractFieldSpec[],
  page: FakeNode[],
  overrides: Partial<ExtractLimits> = {},
) {
  const everyNode = descendantsOf(page);
  const document = {
    querySelectorAll: (selector: string) => everyNode.filter((node) => matchesSelector(node, selector)),
    evaluate: () => {
      throw new Error('替身不实现 XPath');
    },
  };
  const source = buildExtractScript({ candidates: [byCss(containerSelector)] }, fields, { ...limits, ...overrides });
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 被测对象本身就是一段注入脚本，绕开求值就只剩断言字符串
  const factory = new Function('document', 'XPathResult', `return ${source}`);
  return toExtractFrameReading(factory(document, undefined));
}

/** 列表页替身：两张卡片，标题是可点链接（href 是详情页地址），薪资是子节点。 */
const cardPage = (jobIds: string[]): FakeNode[] =>
  jobIds.map((jobId) =>
    fakeNode('li', {
      attrs: { 'data-testid': 'jd-card' },
      kids: [
        fakeNode('a', { attrs: { class: 'title', href: `/boss/detail?jobId=${jobId}` }, text: '资深前端工程师' }),
        fakeNode('span', { attrs: { class: 'salary' }, text: '25-40K·14薪' }),
      ],
    }),
  );

/** 列表页的字段声明：正文与属性混在一张表里，正是 2.3 的实际用法。 */
const cardFields: ExtractFieldSpec[] = [
  { name: 'title', candidates: [byCss('.title')], required: true },
  { name: 'salary', candidates: [byCss('.salary')] },
  { name: 'detailHref', candidates: [byCss('.title')], attribute: 'href', required: true },
];

/** 会话页替身：消息的正文、id、方向全挂在 `li` 自己身上（仿站 `scripts/fixture-server.ts` 的现页形状）。 */
const chatPage = (): FakeNode[] => [
  fakeNode('ul', {
    kids: [
      fakeNode('li', {
        attrs: { 'data-testid': 'chat-log-item', 'data-message-id': 'reply-0', 'data-direction': 'inbound' },
        text: '方便聊聊吗',
      }),
      fakeNode('li', {
        attrs: { 'data-testid': 'chat-log-item', 'data-message-id': 'reply-1', 'data-direction': 'outbound' },
        text: '好的，期望薪资 35K',
      }),
    ],
  }),
];

/** 把一行的字段读数按名索引，省得每处都 `find`。 */
const readingsOf = (row: ExtractRowReading): Map<string, ExtractFieldReading> =>
  new Map(row.fields.map((field) => [field.name, field]));

describe('一次调用读回「容器 × 字段」（spec 2.3-01）', () => {
  it('两张卡片各成一行，正文与属性按声明顺序回读', () => {
    const result = runExtract('[data-testid="jd-card"]', cardFields, cardPage(['1001', '1002']));
    expect(result).toMatchObject({ containers: 2, truncated: false });
    expect(result.rows.map((row) => row.containerIndex)).toEqual([0, 1]);
    const first = readingsOf(result.rows[0]!);
    expect(first.get('title')).toMatchObject({ matched: true, text: '资深前端工程师' });
    expect(first.get('salary')!.text).toBe('25-40K·14薪');
    // href 是属性读数，跨行相对地址由适配器按帧地址折算，脚本只负责原样带回。
    expect(first.get('detailHref')).toMatchObject({ matched: true, attribute: '/boss/detail?jobId=1001' });
  });

  it('子树里没有该字段时回 matched:false，同一行其他字段照常读出', () => {
    const result = runExtract(
      '[data-testid="jd-card"]',
      [{ name: 'city', candidates: [byCss('.city')], required: true }, ...cardFields],
      cardPage(['1001']),
    );
    const fields = readingsOf(result.rows[0]!);
    expect(fields.get('city')).toMatchObject({ matched: false, text: '', attribute: null });
    expect(fields.get('title')!.matched).toBe(true);
  });

  it('一条候选是非法选择器时只让这一条失效，下一条候选继续命中', () => {
    const result = runExtract(
      '[data-testid="jd-card"]',
      [{ name: 'salary', candidates: [{ strategy: 'css', value: 'span .nested >> x' }, byCss('.salary')] }],
      cardPage(['1001']),
    );
    expect(readingsOf(result.rows[0]!).get('salary')).toMatchObject({ matched: true, text: '25-40K·14薪' });
  });

  it('rowLimit 截断回传的行数，containers 仍是页面上的真实数量', () => {
    const result = runExtract('[data-testid="jd-card"]', cardFields, cardPage(['1001', '1002', '1003']), {
      rowLimit: 2,
    });
    expect(result).toMatchObject({ containers: 3, truncated: true });
    expect(result.rows).toHaveLength(2);
  });

  it('textLimit 钳住单个字段的正文，跨行空白先压成一个空格', () => {
    const page = [
      fakeNode('li', {
        attrs: { 'data-testid': 'jd-card' },
        kids: [fakeNode('div', { attrs: { class: 'title' }, text: '资深   前端\n工程师 上海' })],
      }),
    ];
    const result = runExtract('[data-testid="jd-card"]', [{ name: 'title', candidates: [byCss('.title')] }], page, {
      textLimit: 8,
    });
    expect(readingsOf(result.rows[0]!).get('title')!.text).toBe('资深 前端 工程');
  });

  it('请求了属性而节点上没有该属性回空串，没请求属性回 null——「没有」与「没问」不是一回事', () => {
    const result = runExtract(
      '[data-testid="jd-card"]',
      [
        { name: 'linkHref', candidates: [byCss('.salary')], attribute: 'href' },
        { name: 'salary', candidates: [byCss('.salary')] },
      ],
      cardPage(['1001']),
    );
    const fields = readingsOf(result.rows[0]!);
    expect(fields.get('linkHref')).toMatchObject({ matched: true, attribute: '' });
    expect(fields.get('salary')!.attribute).toBeNull();
  });
});

describe('scope：self 读容器自身（spec 2.5-07）', () => {
  /** 消息项的三个读数都挂在容器上，因此全部声明成 self。 */
  const messageFields: ExtractFieldSpec[] = [
    { name: 'text', candidates: [], scope: 'self' },
    { name: 'externalId', candidates: [], scope: 'self', attribute: 'data-message-id' },
    { name: 'direction', candidates: [], scope: 'self', attribute: 'data-direction' },
  ];

  it('正文 / id / 方向从消息节点自身读出，页面顺序就是回读顺序', () => {
    const result = runExtract('[data-testid="chat-log-item"]', messageFields, chatPage());
    expect(result.rows).toHaveLength(2);
    const first = readingsOf(result.rows[0]!);
    expect(first.get('text')).toMatchObject({ matched: true, text: '方便聊聊吗' });
    expect(first.get('externalId')!.attribute).toBe('reply-0');
    expect(first.get('direction')!.attribute).toBe('inbound');
    const second = readingsOf(result.rows[1]!);
    expect(second.get('text')!.text).toBe('好的，期望薪资 35K');
    expect(second.get('direction')!.attribute).toBe('outbound');
  });

  it('同样的声明去掉 self 就读不到——子树查找永远不会返回容器本身', () => {
    const sameCandidates = [byCss('[data-testid="chat-log-item"]')];
    const result = runExtract(
      '[data-testid="chat-log-item"]',
      [
        { name: 'text', candidates: sameCandidates },
        { name: 'textSelf', candidates: sameCandidates, scope: 'self' },
      ],
      chatPage(),
    );
    const fields = readingsOf(result.rows[0]!);
    expect(fields.get('text')!.matched).toBe(false);
    expect(fields.get('textSelf')).toMatchObject({ matched: true, text: '方便聊聊吗' });
  });

  it('self 读的是整棵子树的正文：消息节点里嵌了子节点就会一起进来（真实 DOM 语义）', () => {
    const page = [
      fakeNode('li', {
        attrs: { 'data-testid': 'chat-log-item', 'data-message-id': 'reply-9' },
        text: '方便聊聊吗',
        kids: [fakeNode('span', { text: '3 分钟前' })],
      }),
    ];
    const result = runExtract(
      '[data-testid="chat-log-item"]',
      [
        { name: 'text', candidates: [], scope: 'self' },
        { name: 'time', candidates: [byCss('span')] },
      ],
      page,
    );
    const fields = readingsOf(result.rows[0]!);
    expect(fields.get('text')!.text).toBe('方便聊聊吗 3 分钟前');
    expect(fields.get('time')!.text).toBe('3 分钟前');
  });
});

describe('页面回读的钳制（外部页面不可信）', () => {
  it('坏形状逐项收窄：rows 不是数组、索引是 NaN、正文不是字符串都不至于让本次抽取崩掉', () => {
    const reading = toExtractFrameReading({
      containers: '3',
      truncated: 'yes',
      rows: [{ containerIndex: Number.NaN, fields: 'oops', extra: 1 }],
    });
    expect(reading).toEqual({
      containers: 0,
      truncated: false,
      rows: [{ containerIndex: 0, frameUrl: '', fields: [] }],
    });
  });

  it('整个回传是 undefined 时收成空读数，而不是抛错', () => {
    expect(toExtractFrameReading(undefined)).toEqual({ containers: 0, truncated: false, rows: [] });
  });
});
