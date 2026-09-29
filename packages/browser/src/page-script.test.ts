import { describe, expect, it } from 'vitest';
import { buildSnapshotScript, SNAPSHOT_HEADING_LIMIT, SNAPSHOT_TEXT_LIMIT, toSnapshotReading } from './page-script.js';

/** 标题节点的最小替身：注入脚本只碰 `textContent`。 */
type HeadingNode = { textContent: string };

/** 注入脚本用到的节点集合面：只有 `length` 与按下标取节点，普通数组就满足它。 */
type NodeSet = { length: number; [index: number]: HeadingNode };

/** 页面替身：注入脚本用到的每个 DOM 面都在这里，仅此而已。 */
type FakePage = {
  document: {
    title: string;
    readyState: 'loading' | 'interactive' | 'complete';
    body: { innerText: string } | null;
    querySelectorAll: (selector: string) => NodeSet;
  };
  location: { href: string };
};

/** 一次替身页面的可改字段。 */
type PageShape = {
  title: string;
  innerText: string;
  headings: string[];
  readyState: FakePage['document']['readyState'];
  href: string;
  hasBody: boolean;
};

/**
 * 造一份页面替身。
 * @param overrides 需要改写的字段（默认是一个有标题、两个标题、正文 7 字的完整页面）
 * @returns 可直接喂给注入脚本的替身
 */
const fakePage = (overrides: Partial<PageShape> = {}): FakePage => {
  const headings: NodeSet = (overrides.headings ?? ['资深前端工程师', '任职要求']).map((text) => ({
    textContent: text,
  }));
  const allNodes: NodeSet = Array.from({ length: 12 }, () => ({ textContent: '' }));
  return {
    document: {
      title: overrides.title ?? '求职仿站 · 职位搜索（本地 fixture）',
      readyState: overrides.readyState ?? 'complete',
      body: overrides.hasBody === false ? null : { innerText: overrides.innerText ?? '共 6 条职位' },
      querySelectorAll: (selector) => (selector === '*' ? allNodes : headings),
    },
    location: { href: overrides.href ?? 'http://127.0.0.1:10233/boss' },
  };
};

/**
 * 在替身页面上求值注入脚本——与 `executeJavaScript` 走的是同一段源码。
 *
 * 这里必须真的把源码跑起来：只断言字符串里出现了 `document.title` 证明不了脚本读得对。
 * 求值的对象是本包自己生成的常量源码，不来自页面或用户，所以这条 eval 是被允许的形态。
 * @param page 页面替身
 * @param maxChars 正文上限（字符）
 * @param headingLimit 标题上限
 * @returns 脚本返回的原始读数
 */
const run = (page: FakePage, maxChars = SNAPSHOT_TEXT_LIMIT, headingLimit = SNAPSHOT_HEADING_LIMIT): unknown => {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 被测对象本身是一段注入脚本，绕开求值就只剩断言字符串
  const factory = new Function('document', 'location', `return ${buildSnapshotScript(maxChars, headingLimit)}`);
  return factory(page.document, page.location);
};

describe('页面读取脚本（spec 2.1-03）', () => {
  it('同一段源码在页面里读得出标题、正文与元素数，字段与真实 DOM 对得上', () => {
    expect(run(fakePage())).toMatchObject({
      title: '求职仿站 · 职位搜索（本地 fixture）',
      url: 'http://127.0.0.1:10233/boss',
      readyState: 'complete',
      elementCount: 12,
      textLength: 7,
      bodyText: '共 6 条职位',
      headings: ['资深前端工程师', '任职要求'],
    });
  });

  it('正文按上限截断，但 textLength 仍是截断前的长度——分不清这两者就无法判断取回的是不是一小段', () => {
    const reading = run(fakePage({ innerText: 'x'.repeat(500) }), 120) as { textLength: number; bodyText: string };
    expect(reading.textLength).toBe(500);
    expect(reading.bodyText).toHaveLength(120);
  });

  it('标题按 headingLimit 截断，并把跨行空白压成一个空格', () => {
    const reading = run(
      fakePage({ headings: ['第一\n标题', '第二 标题', '第三标题', ''] }),
      SNAPSHOT_TEXT_LIMIT,
      2,
    ) as { headings: string[] };
    expect(reading.headings).toEqual(['第一 标题', '第二 标题']);
  });

  it('没有 body 时正文收成空串而不是抛错（装载极早期就会这样）', () => {
    expect(run(fakePage({ hasBody: false }))).toMatchObject({ bodyText: '', textLength: 0 });
  });
});

describe('页面读数钳制（spec 2.1-03：外部页面是不可信输入）', () => {
  it('字段缺失或类型不对时用中性值补齐，整次读取不崩', () => {
    expect(toSnapshotReading({ title: 1, elementCount: 'many', headings: 'h1' })).toEqual({
      title: '',
      url: '',
      readyState: 'complete',
      elementCount: 0,
      textLength: 0,
      bodyText: '',
      headings: [],
    });
  });

  it('null / undefined 整个返回体也钳成空读数', () => {
    expect(toSnapshotReading(null)).toEqual({
      title: '',
      url: '',
      readyState: 'complete',
      elementCount: 0,
      textLength: 0,
      bodyText: '',
      headings: [],
    });
    expect(toSnapshotReading(undefined).bodyText).toBe('');
  });

  it('readyState 只认三种取值，站点自造的第四态归为 complete', () => {
    expect(toSnapshotReading({ readyState: 'loading' }).readyState).toBe('loading');
    expect(toSnapshotReading({ readyState: 'interactive' }).readyState).toBe('interactive');
    expect(toSnapshotReading({ readyState: 'prerender' }).readyState).toBe('complete');
  });

  it('headings 里的非字符串项被剔除，界面不会渲染出 [object Object]', () => {
    expect(toSnapshotReading({ headings: ['a', 1, null, 'b'] }).headings).toEqual(['a', 'b']);
  });
});
