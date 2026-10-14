/**
 * 封闭文法的形状断言（spec 3.9-01，片 64-a）。
 * 每一例只钉一件事：文法认什么、不认什么，以及「无标记时不许改变产物字节」这一条负对照。
 */
import { describe, expect, it } from 'vitest';
import {
  BULLET_MARK,
  NESTED_INDENT,
  editableToRaw,
  renderRichValue,
  stripRichMarkers,
  type EditableNode,
} from './richtext.js';
import { normalizeRichLine, stripLineMarkup } from './header.js';

describe('renderRichValue：段落', () => {
  it('空串原样返回，不抛异常', () => {
    expect(renderRichValue('')).toEqual({ block: false, html: '' });
  });

  it('单行无标记 = 与旧的 span 内容逐字节相同（3.9-01 的负对照）', () => {
    expect(renderRichValue('主导订单服务重构')).toEqual({ block: false, html: '主导订单服务重构' });
  });

  it('多行进到块级：每行一只 <p>，换行不再塌成空白', () => {
    const rich = renderRichValue('第一行\n第二行');
    expect(rich.block).toBe(true);
    expect(rich.html).toBe('<p>第一行</p><p>第二行</p>');
  });

  it('空行断开段落但不产出空块', () => {
    expect(renderRichValue('上\n\n下').html).toBe('<p>上</p><p>下</p>');
  });
});

describe('renderRichValue：两级列表', () => {
  it('- 开一级，装配成 list-disc 的 ul', () => {
    expect(renderRichValue(`${BULLET_MARK}甲`).html).toBe('<ul class="list-disc pl-4 mt-1"><li>甲</li></ul>');
  });

  it('两个空格加 - 开二级，挂在上一条一级 li 之内', () => {
    const html = renderRichValue(`${BULLET_MARK}甲\n${NESTED_INDENT}${BULLET_MARK}甲之一`).html;
    expect(html).toBe(
      '<ul class="list-disc pl-4 mt-1"><li>甲<ul class="list-circle pl-4"><li>甲之一</li></ul></li></ul>',
    );
  });

  it('三级及更深按二级折叠（两级封顶）', () => {
    const html = renderRichValue(`${BULLET_MARK}甲\n    ${BULLET_MARK}深`).html;
    expect(html).toContain('<ul class="list-circle pl-4"><li>深</li></ul>');
    expect(html.match(/list-disc/g)).toHaveLength(1);
  });

  it('没有前置一级项的孤立二级项升为一级，一行不丢', () => {
    expect(renderRichValue(`${NESTED_INDENT}${BULLET_MARK}孤`).html).toBe(
      '<ul class="list-disc pl-4 mt-1"><li>孤</li></ul>',
    );
  });

  it('列表被段落行断开后另起一只 ul', () => {
    const html = renderRichValue(`${BULLET_MARK}甲\n说明\n${BULLET_MARK}乙`).html;
    expect(html).toBe(
      '<ul class="list-disc pl-4 mt-1"><li>甲</li></ul><p>说明</p><ul class="list-disc pl-4 mt-1"><li>乙</li></ul>',
    );
  });

  it('有序列表刻意不认（4.5-15 反向验证的那一处歧义源）', () => {
    expect(renderRichValue('1. 甲\n2. 乙').html).toBe('<p>1. 甲</p><p>2. 乙</p>');
  });
});

describe('renderRichValue：行内加重', () => {
  it('成对 ** 转 strong，单行仍走行内格', () => {
    expect(renderRichValue('P99 **下降 40%**').html).toBe('P99 <strong class="font-bold">下降 40%</strong>');
  });

  it('落单的 ** 原样留着——那是内容不是格式', () => {
    expect(renderRichValue('甲 ** 乙').html).toBe('甲 ** 乙');
  });

  it('列表项里的成对 ** 照样生效', () => {
    expect(renderRichValue(`${BULLET_MARK}**成本降 30%**`).html).toBe(
      '<ul class="list-disc pl-4 mt-1"><li><strong class="font-bold">成本降 30%</strong></li></ul>',
    );
  });
});

describe('renderRichValue：注入面（转义在 bind.ts 那一处，本文件不得重新解释）', () => {
  it('正文里的字面 <b> 到这一步已是 &lt;b&gt;，产物里不出现真标签', () => {
    const html = renderRichValue('&lt;b&gt;label&lt;/b&gt;').html;
    expect(html).not.toContain('<b>');
    expect(html).toBe('&lt;b&gt;label&lt;/b&gt;');
  });

  it('正文里落单的一个星号与 & 都不会被拼成标签', () => {
    expect(renderRichValue('甲* &amp; **乙**').html).toBe('甲* &amp; <strong class="font-bold">乙</strong>');
  });
});

describe('stripRichMarkers：数字守恒之前的一层（spec 4.5-16）', () => {
  it('标记字符不进分母：带标记与不带标记剥完是同一串', () => {
    expect(stripRichMarkers(`${BULLET_MARK}**P99 延迟下降 40%**`)).toBe('P99 延迟下降 40%');
    expect(stripRichMarkers('P99 延迟下降 40%')).toBe('P99 延迟下降 40%');
  });

  it('落单的 ** 与缩进一并剥掉，行序保持', () => {
    expect(stripRichMarkers(`  ${BULLET_MARK}甲 * 乙\n${BULLET_MARK}丙`)).toBe('甲 * 乙\n丙');
  });

  it('剥标记不吃数字：1. 这种未认的有序项原样留着（它确实带数字，应当参与守恒）', () => {
    expect(stripRichMarkers('1. 提升 2 倍')).toBe('1. 提升 2 倍');
  });
});

describe('normalizeRichLine：导入侧把符号归一成标记（spec 4.1-18）', () => {
  it('• / · / - 三种符号都归一成 `- `，其余装饰照旧剥掉', () => {
    expect(normalizeRichLine('• 主导订单服务重构')).toBe('- 主导订单服务重构');
    expect(normalizeRichLine('· 日均 2 亿单')).toBe('- 日均 2 亿单');
    expect(normalizeRichLine('- 已有标记')).toBe('- 已有标记');
    expect(normalizeRichLine('### 标题行')).toBe('标题行');
  });

  it('版面圆点后面紧跟文字也算条目，而 ASCII 符号必须带空格（pdf.js 的两种拼法各自成立）', () => {
    // 实测形状：同一行的两列之间若没有空格项，`str` 是直接拼起来的（`•订单服务重构`），
    // 所以圆点族不强制空格；反过来 `-2024.06` 这种被换行切断的日期片段必须**不**被造成长列表项。
    expect(normalizeRichLine('•订单服务重构')).toBe('- 订单服务重构');
    expect(normalizeRichLine(`${NESTED_INDENT}·日均 2 亿单`)).toBe(`${NESTED_INDENT}- 日均 2 亿单`);
    // 无空格的 ASCII 符号走回旧口径（`stripLineMarkup` 本来就会剥掉行首标点），关键是它不产出列表项
    expect(normalizeRichLine('-2024.06')).toBe(stripLineMarkup('-2024.06'));
    expect(normalizeRichLine('-2024.06')).not.toMatch(/^- /);
    expect(normalizeRichLine('*号外的写法')).not.toMatch(/^- /);
  });

  it('source.ts 按左 x 写进来的那一档缩进读成二级', () => {
    expect(normalizeRichLine(`${NESTED_INDENT}• 子项`)).toBe(`${NESTED_INDENT}${BULLET_MARK}子项`);
  });

  it('正文行里的 `**`：成对的保留、落单的删除（spec 4.1-18 原文那半句）', () => {
    // 成对的那对交给渲染层换成 `<strong>`——导入的 Markdown / DOCX 语料里本来就写对的加重不能在这一格被吃掉。
    expect(normalizeRichLine('  **星桥科技** 2021.03 - 2023.06')).toBe('**星桥科技** 2021.03 - 2023.06');
    expect(normalizeRichLine('- 日均 **2 亿** 单')).toBe('- 日均 **2 亿** 单');
    // 落单的那些删除，否则纸面上会印出给招聘者看的星号；抬头那一支（stripLineMarkup）仍然全删。
    expect(normalizeRichLine('主导 **订单服务重构')).toBe('主导 订单服务重构');
    expect(normalizeRichLine('- 主导 **订单服务重构')).toBe('- 主导 订单服务重构');
    expect(stripLineMarkup('  **星桥科技** 2021.03 - 2023.06')).toBe('星桥科技 2021.03 - 2023.06');
    // 行首装饰的处理与过去逐字相同（`#` 那一族照旧剥掉）
    expect(normalizeRichLine('### 小节 **标题**')).toBe('小节 **标题**');
  });

  it('序号 `1.` / `（二）` 不当列表项（与 4.5-15 反向验证同一条口径）', () => {
    expect(normalizeRichLine('1. 提升 2 倍')).toBe('提升 2 倍');
    expect(normalizeRichLine('（二）项目经历')).toBe('项目经历');
  });

  it('只有符号、没有内容的一行不产出空列表项', () => {
    expect(normalizeRichLine('- ')).toBe('');
    expect(normalizeRichLine('•')).toBe('');
  });
});

/**
 * 反向文法（spec 3.12-01 / 02，片 65-A）。
 * 树是**手写的正向产物形状**：本仓没有 DOM，而渲染层摘下来的树与此同形（`tag` 小写、文本节点 `#text`），
 * 所以这一批用例钉的是「纸上的那一格被改成什么形状 → 交回文档的是哪一串」这一件事。
 */
const el = (tag: string, ...children: EditableNode[]): EditableNode => ({ tag, text: '', children });
const txt = (text: string): EditableNode => ({ tag: '#text', text, children: [] });

describe('editableToRaw：与 renderRichValue 互逆（spec 3.12-01）', () => {
  it('单行原样回，不带任何标记', () => {
    expect(editableToRaw([txt('主导订单服务重构')])).toBe('主导订单服务重构');
  });

  it('多个 `<p>` 回多行，`\n` 在行与行之间', () => {
    const tree = [el('p', txt('上')), el('p', txt('下'))];
    expect(editableToRaw(tree)).toBe('上\n下');
    // 正向的同一档：这棵树就是 `renderRichValue('上\n下')` 该产出的那两个 `<p>`
    expect(renderRichValue('上\n下').html).toBe('<p>上</p><p>下</p>');
  });

  it('一级与两级列表各自回 `- ` 与两空格 + `- `', () => {
    const flat = [el('ul', el('li', txt('甲')), el('li', txt('乙')))];
    expect(editableToRaw(flat)).toBe(`${BULLET_MARK}甲\n${BULLET_MARK}乙`);
    const nested = [el('ul', el('li', txt('甲'), el('ul', el('li', txt('乙')))))];
    expect(editableToRaw(nested)).toBe(`${BULLET_MARK}甲\n${NESTED_INDENT}${BULLET_MARK}乙`);
  });

  it('行内加重回成对 `**`，`<b>` 与 `<strong>` 是同一档（spec 3.12-02）', () => {
    const fromGrammar = [txt('P99 '), el('strong', txt('下降 40%')), txt(' 稳定')];
    const fromExecCommand = [txt('P99 '), el('b', txt('下降 40%')), txt(' 稳定')];
    expect(editableToRaw(fromGrammar)).toBe('P99 **下降 40%** 稳定');
    expect(editableToRaw(fromExecCommand)).toBe(editableToRaw(fromGrammar));
    // 反向永远产成对：落单星号一种也不会出现（3.12-07 的「再按一次取消」靠这一条成立）
    expect(editableToRaw(fromGrammar).split('**').length % 2).toBe(1);
  });

  it('第三层列表折回第二档，与正向的两级封顶同一条（spec 3.12-02）', () => {
    const levelThree = el('ul', el('li', txt('丙')));
    const levelTwo = el('ul', el('li', txt('乙'), levelThree));
    const deep = [el('ul', el('li', txt('甲'), levelTwo))];
    expect(editableToRaw(deep)).toBe(
      `${BULLET_MARK}甲\n${NESTED_INDENT}${BULLET_MARK}乙\n${NESTED_INDENT}${BULLET_MARK}丙`,
    );
  });

  it('`<br>` 与块级兄弟一样换行；空的块不产行（与 `toRichLines` 丢空行同口径）', () => {
    expect(editableToRaw([txt('甲'), el('br'), txt('乙')])).toBe('甲\n乙');
    expect(editableToRaw([el('p'), el('p', txt('甲'))])).toBe(editableToRaw([el('p', txt('甲'))]));
  });

  it('浏览器包装出来的 `<span>` / `<font>` 不改动行的切分，只把里面的字与加重留下', () => {
    expect(editableToRaw([el('p', el('span', txt('甲 '), el('b', txt('乙')))), el('p', txt('丙'))])).toBe(
      '甲 **乙**\n丙',
    );
  });

  it('反向的产物再喂正向，形状不变（一条经历的四行成果来回各一次）', () => {
    const raw = [
      '负责交易链路的稳定性。',
      `${BULLET_MARK}**P99 延迟下降 40%**`,
      `${BULLET_MARK}日均 2 亿单`,
      `${NESTED_INDENT}${BULLET_MARK}库存扣减幂等`,
    ].join('\n');
    const tree = [
      el('p', txt('负责交易链路的稳定性。')),
      el(
        'ul',
        el('li', el('strong', txt('P99 延迟下降 40%'))),
        el('li', txt('日均 2 亿单'), el('ul', el('li', txt('库存扣减幂等')))),
      ),
    ];
    expect(editableToRaw(tree)).toBe(raw);
    expect(stripRichMarkers(editableToRaw(tree))).toBe(stripRichMarkers(raw));
  });
});
