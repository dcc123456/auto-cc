import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, safeHref, type MdBlock } from './markdown';

/** 把块序列压成一行 `kind` 串，断言结构时看这个比逐字比对 AST 短得多。 */
function kinds(blocks: MdBlock[]): string {
  return blocks.map((block) => block.kind).join(',');
}

/** 取出第一块里第一个文本节点的值；用来断言"没被标记吃掉的那半句话还在"。 */
function firstText(blocks: MdBlock[]): string {
  const paragraph = blocks[0];
  if (paragraph?.kind !== 'paragraph') throw new Error('第一块不是段落');
  return paragraph.children
    .filter((node) => node.kind === 'text')
    .map((node) => (node.kind === 'text' ? node.value : ''))
    .join('');
}

describe('对话屏的 Markdown 文法（spec 6.2-36）', () => {
  it('标题只认 h1–h4，更深的落回同一档而不是堆字号', () => {
    const blocks = parseMarkdown('# 一\n\n###### 六');
    expect(kinds(blocks)).toBe('heading,heading');
    expect(blocks.map((block) => (block.kind === 'heading' ? block.level : 0))).toEqual([1, 4]);
  });

  it('段落里的软换行并成空格，行尾两个空格升级成硬换行', () => {
    expect(parseInline('前半句\n后半句').filter((node) => node.kind === 'break')).toHaveLength(0);
    // 硬换行由 `parseParagraph` 削掉行尾空格、补一个反斜杠后才轮到行内文法，所以这条断言落在块这一层。
    const [soft] = parseMarkdown('前半句\n后半句');
    expect(firstText(soft ? [soft] : [])).toBe('前半句 后半句');
    const [hard] = parseMarkdown('前半句  \n后半句');
    if (hard?.kind !== 'paragraph') throw new Error('不是段落');
    expect(hard.children.filter((node) => node.kind === 'break')).toHaveLength(1);
  });

  it('强调三档：`***` 是加重套强调，`**` 只加重，`*` 只强调', () => {
    const nodes = parseInline('***全***');
    expect(nodes[0]?.kind).toBe('strong');
    const strong = nodes[0];
    if (strong?.kind !== 'strong') throw new Error('不是 strong');
    expect(strong.children[0]?.kind).toBe('em');
    expect(parseInline('**粗**')[0]?.kind).toBe('strong');
    expect(parseInline('*斜*')[0]?.kind).toBe('em');
  });

  it('词中间的下划线不算强调（snake_case 不该被吃掉）', () => {
    const nodes = parseInline('snake_case_name');
    expect(nodes.every((node) => node.kind === 'text')).toBe(true);
  });

  it('认不出来的定界按字面量留下，不吃掉半句话', () => {
    expect(firstText(parseMarkdown('2 * 3 是乘法'))).toBe('2 * 3 是乘法');
  });

  it('不安全 scheme 的链接不产 anchor，只留文字', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<script>')).toBeNull();
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a');
    const nodes = parseInline('[点我](javascript:alert(1))');
    expect(nodes.some((node) => node.kind === 'link')).toBe(false);
    expect(nodes.map((node) => (node.kind === 'text' ? node.value : '')).join('')).toBe('点我');
  });

  it('链接地址里带括号仍然配平', () => {
    const nodes = parseInline('[维基](https://example.com/a_(b))');
    const link = nodes[0];
    expect(link?.kind).toBe('link');
    if (link?.kind !== 'link') throw new Error('不是 link');
    expect(link.href).toBe('https://example.com/a_(b)');
  });

  it('无序列表按缩进嵌套，深层条目挂回上一级而不是消失', () => {
    const blocks = parseMarkdown('- 一级甲\n  - 二级乙\n  - 二级丙\n- 一级丁');
    expect(kinds(blocks)).toBe('list');
    const list = blocks[0];
    if (list?.kind !== 'list') throw new Error('不是列表');
    expect(list.items).toHaveLength(2);
    const nested = list.items[0]?.[1];
    expect(nested?.kind).toBe('list');
    if (nested?.kind !== 'list') throw new Error('二级不是列表');
    expect(nested.items).toHaveLength(2);
  });

  it('有序与无序交替算两节，各归各的序', () => {
    const blocks = parseMarkdown('1. 甲\n2. 乙\n- 丙\n- 丁');
    expect(kinds(blocks)).toBe('list,list');
    expect(blocks.map((block) => (block.kind === 'list' ? block.ordered : null))).toEqual([true, false]);
  });

  it('未闭合的围栏照画并记成半截（流式途中正是这个形状）', () => {
    const blocks = parseMarkdown('```ts\nconst a = 1;');
    const code = blocks[0];
    expect(code?.kind).toBe('code');
    if (code?.kind !== 'code') throw new Error('不是代码块');
    expect(code.closed).toBe(false);
    expect(code.lang).toBe('ts');
    expect(code.value).toBe('const a = 1;');
  });

  it('闭合的围栏带上语言与正文，收尾行不再算块', () => {
    const blocks = parseMarkdown('```py\nprint(1)\n```\n后面这段是段落');
    expect(kinds(blocks)).toBe('code,paragraph');
    const code = blocks[0];
    if (code?.kind !== 'code') throw new Error('不是代码块');
    expect(code.closed).toBe(true);
    expect(code.value).toBe('print(1)');
  });

  it('表格读出逐列对齐档；列数对不上整段回落成段落', () => {
    const table = parseMarkdown('| 名字 | 数量 |\n| :--- | ---: |\n| 甲 | 1 |');
    expect(kinds(table)).toBe('table');
    const block = table[0];
    if (block?.kind !== 'table') throw new Error('不是表格');
    expect(block.align).toEqual(['left', 'right']);
    expect(block.rows).toHaveLength(1);

    const broken = parseMarkdown('| 名字 | 数量 |\n| --- |\n| 甲 | 1 |');
    expect(kinds(broken)).toBe('paragraph');
  });

  it('引用块剥掉 `>` 之后按同一套文法再解一遍', () => {
    const blocks = parseMarkdown('> 引一句\n> - 甲\n> - 乙');
    expect(kinds(blocks)).toBe('quote');
    const quote = blocks[0];
    if (quote?.kind !== 'quote') throw new Error('不是引用');
    expect(kinds(quote.children)).toBe('paragraph,list');
  });

  it('四空格缩进的 `>` 不是引用：原样当一段文字，也不会让段落原地卡住', () => {
    const blocks = parseMarkdown('    > 这只是缩进的一行');
    expect(kinds(blocks)).toBe('paragraph');
    expect(firstText(blocks)).toBe('    > 这只是缩进的一行');
  });

  it('分隔线与空行不产内容，但会把段落断开', () => {
    expect(kinds(parseMarkdown('甲段\n\n---\n\n乙段'))).toBe('paragraph,hr,paragraph');
  });

  it('空正文返回空序列（流式刚开始那一刻的形状）', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseInline('')).toEqual([]);
  });

  it('行内代码不被强调规则吃掉', () => {
    const nodes = parseInline('`a * b * c`');
    expect(nodes[0]?.kind).toBe('code');
    if (nodes[0]?.kind !== 'code') throw new Error('不是 code');
    expect(nodes[0].value).toBe('a * b * c');
  });
});
