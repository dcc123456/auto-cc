/**
 * 遮罩脚本的用例（spec 2.7-07）。
 *
 * 跑的是**生成的那段源码本身**：`new Function` 在替身 DOM 上求值，桩掉它等于没测——
 * 本包另外几条注入脚本（`page-script.test.ts` / `extract-script.test.ts`）同一条路。
 * 真实像素那一步在这里断不出来，交给 harness 打 fixture 靶页验收。
 */
import { PII_VALUE_PATTERNS } from '@auto-cc/core';
import { describe, expect, it } from 'vitest';
import { buildMaskScript, buildUnmaskScript, PII_MASK_ATTR, type MaskScriptResult } from './mask-script.js';

type FakeRect = { left: number; top: number; width: number; height: number };

/** 替身节点：够脚本用到的那几样（树结构、属性、矩形），不做布局。 */
type FakeNode = {
  nodeType: number;
  nodeValue: string;
  childNodes: FakeNode[];
  parent: FakeNode | null;
  attrs: Record<string, string>;
  style: { cssText: string };
  /** 该节点渲染出来的位置；宽度为 0 表示「没有像素」（脚本里的 display:none / script 文本）。 */
  rects: FakeRect[];
  setAttribute: (name: string, value: string) => void;
  appendChild: (child: FakeNode) => void;
  remove: () => void;
};

/** 一个文本节点的声明。 */
type TextSpec = { text: string; rects?: FakeRect[] };

function node(nodeType: number, nodeValue: string): FakeNode {
  const self: FakeNode = {
    nodeType,
    nodeValue,
    childNodes: [],
    parent: null,
    attrs: {},
    style: { cssText: '' },
    rects: [],
    setAttribute: (name, value) => {
      self.attrs[name] = value;
    },
    appendChild: (child) => {
      child.parent = self;
      self.childNodes.push(child);
    },
    remove: () => {
      const parent = self.parent;
      if (parent) parent.childNodes = parent.childNodes.filter((item) => item !== self);
    },
  };
  return self;
}

/**
 * 造一个最小可走的 DOM。
 *
 * 矩形按「一个字符 1px」折算：断言要的是「盖在哪、盖多宽」这个对应关系，不是真实排版。
 * @param specs 正文里的文本节点（每个一段），缺省矩形为一行、高 18px
 * @returns 文档替身与 body（用例数遮罩块用）
 */
function fakeDom(specs: TextSpec[]) {
  const body = node(1, '');
  let order = 0;
  for (const spec of specs) {
    order += 1;
    const text = node(3, spec.text);
    text.rects = spec.rects ?? [{ left: 20, top: order * 24, width: spec.text.length, height: 18 }];
    body.appendChild(text);
  }
  const document = {
    body,
    documentElement: body,
    createElement: () => node(1, ''),
    createRange: () => {
      let target: FakeNode | null = null;
      let start = 0;
      let end = 0;
      return {
        setStart(rangeNode: FakeNode, offset: number) {
          target = rangeNode;
          start = offset;
        },
        setEnd(_rangeNode: FakeNode, offset: number) {
          end = offset;
        },
        getClientRects: () =>
          (target?.rects ?? []).map((rect) => ({
            left: rect.left + start,
            top: rect.top,
            width: end - start,
            height: rect.height,
          })),
      };
    },
    querySelectorAll: (selector: string) => {
      const name = selector.slice(1, -1);
      const found: FakeNode[] = [];
      const stack: FakeNode[] = [body];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (current.attrs[name] !== undefined) found.push(current);
        stack.push(...current.childNodes);
      }
      return found;
    },
  };
  return { document, body };
}

/**
 * 在替身 DOM 上求值脚本。
 * @param source 生成的表达式源码
 * @param document 文档替身
 * @returns 脚本返回值（遮罩脚本返回 Promise，这里一并 await）
 */
async function evaluate(source: string, document: unknown): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 被测对象本身就是一段注入脚本，绕开求值就只剩断言字符串
  const factory = new Function('document', 'window', 'requestAnimationFrame', `return ${source}`) as (
    doc: unknown,
    win: unknown,
    raf: (callback: () => void) => void,
  ) => unknown;
  // 真页面里 rAF 由合成器驱动；替身回落到 0ms 定时器，只为让「等两帧」那条 await 能走通。
  const raf = (callback: () => void): void => {
    setTimeout(callback, 0);
  };
  return await factory(document, { scrollX: 0, scrollY: 4 }, raf);
}

describe('截图前遮罩脚本（spec 2.7-07）', () => {
  it('命中的手机 / 邮箱 / 证件号各盖一块，且盖在命中段落自己的位置上', async () => {
    const { document, body } = fakeDom([
      { text: '联系人手机：13800138000（工作日可联系）' },
      { text: '投递邮箱：zhaopin.huang@example.com.cn' },
      { text: '证件号码：330106199001011234' },
    ]);
    const reading = (await evaluate(buildMaskScript(1_000), document)) as MaskScriptResult;
    expect(reading).toEqual({ hits: 3, covers: 3 });
    const covers = body.childNodes.filter((item) => item.attrs[PII_MASK_ATTR] !== undefined);
    expect(covers.map((item) => item.attrs[PII_MASK_ATTR])).toEqual(['phone', 'email', 'id']);
    // 左边界 = 文本节点左边界(20) + 命中段在节点内的下标(6)；宽度 = 命中段长度(11)；
    // top 加了 scrollY(4)。遮的是那几个字，不是整行。
    expect(covers[0]!.style.cssText).toContain('left:26px');
    expect(covers[0]!.style.cssText).toContain('width:11px');
    expect(covers[0]!.style.cssText).toContain('top:28px');
    expect(covers[2]!.style.cssText).toContain('left:25px');
    expect(covers[2]!.style.cssText).toContain('width:18px');
  });

  it('只盖像素：站点文本节点的值一个字都不改', async () => {
    const { document, body } = fakeDom([{ text: '手机 13800138000' }]);
    await evaluate(buildMaskScript(1_000), document);
    const textNode = body.childNodes.find((item) => item.nodeType === 3)!;
    expect(textNode.nodeValue).toBe('手机 13800138000');
  });

  it('命中段落没有像素（矩形宽度为 0）时不盖块，但命中数照记', async () => {
    const { document, body } = fakeDom([
      { text: '手机 13800138000', rects: [{ left: 0, top: 0, width: 0, height: 0 }] },
    ]);
    const reading = (await evaluate(buildMaskScript(1_000), document)) as MaskScriptResult;
    expect(reading).toEqual({ hits: 1, covers: 0 });
    expect(body.childNodes.filter((item) => item.attrs[PII_MASK_ATTR] !== undefined)).toHaveLength(0);
  });

  it('一处命中跨两行（两个矩形）时两块都盖——只盖第一块等于把后半截留在图上', async () => {
    const { document, body } = fakeDom([
      {
        text: '邮箱 zhaopin.huang@example.com.cn',
        rects: [
          { left: 10, top: 100, width: 40, height: 18 },
          { left: 10, top: 122, width: 40, height: 18 },
        ],
      },
    ]);
    const reading = (await evaluate(buildMaskScript(1_000), document)) as MaskScriptResult;
    expect(reading).toEqual({ hits: 1, covers: 2 });
    expect(body.childNodes.filter((item) => item.attrs[PII_MASK_ATTR] !== undefined)).toHaveLength(2);
  });

  it('重复调用幂等：上一轮的块先摘掉，不会在遮罩上叠遮罩', async () => {
    const { document, body } = fakeDom([{ text: '手机 13800138000' }]);
    await evaluate(buildMaskScript(1_000), document);
    await evaluate(buildMaskScript(1_000), document);
    expect(body.childNodes.filter((item) => item.attrs[PII_MASK_ATTR] !== undefined)).toHaveLength(1);
  });

  it('薪资 / 编号这类同形数字不盖——遮错了等于把 JD 废掉', async () => {
    const { document, body } = fakeDom([{ text: '薪资 15000-25000，编号 123456，成立于 2019' }]);
    const reading = (await evaluate(buildMaskScript(1_000), document)) as MaskScriptResult;
    expect(reading).toEqual({ hits: 0, covers: 0 });
    expect(body.childNodes).toHaveLength(1);
  });

  it('判据从 core 内联过来，不是这里抄的第二份', () => {
    const source = buildMaskScript(1_000);
    for (const pattern of PII_VALUE_PATTERNS) {
      expect(source).toContain(JSON.stringify(pattern.source));
      expect(source).toContain(`"kind":"${pattern.kind}"`);
    }
  });

  it('摘除脚本只按标记属性动手，摘完回数量', async () => {
    const { document, body } = fakeDom([{ text: '手机 13800138000' }]);
    await evaluate(buildMaskScript(1_000), document);
    const reading = (await evaluate(buildUnmaskScript(), document)) as { removed: number };
    expect(reading).toEqual({ removed: 1 });
    expect(body.childNodes.filter((item) => item.attrs[PII_MASK_ATTR] !== undefined)).toHaveLength(0);
  });
});
