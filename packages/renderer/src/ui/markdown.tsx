/**
 * 对话屏的 Markdown 渲染（spec 6.2-36）：助手回复的文本 part 走这里，人那侧仍是纯文本。
 *
 * **为什么不引 `marked`/`markdown-it`**（AGENTS.md §6.1 的选型记录）：
 * ① `packages/resume-doc/src/richtext.ts` 在文件头已经记过一次"不引这两个包"，理由是印面要封闭文法。
 *    本文件是**另一个面**（对话屏的流式回复），不是那份文法的第二次实现，所以不违反 §2.5 的"一个入口"——
 *    两处文法不同、消费面不同，强行合并只会让印面去认 ```` ``` ```` 与 `|`。
 * ② 那两个包是 ~90KB gzip 的运行期依赖，而这里需要的能力只有十二种块；装机用户只该为一个 app 付一次代价（§4.3-06）。
 * ③ 更硬的一条：助手正文是**不可信输入**（模型刚读过 hostile 页面），而这一层能摸到特权 API。
 *    自己解析就把安全性做成结构性的——全文件没有 `dangerouslySetInnerHTML`，没有一个 HTML 字符串被拼出来，
 *    链接的 scheme 由 `safeHref` 单点放行，而不是"先拼 HTML 再想办法 sanitize"。
 *
 * **流式的半截块**：未闭合的围栏代码块不丢弃，按 `closed: false` 画出来并在左边加一根强调条——
 * 它此刻正是模型正在写的那一段，等下一片到达就补上收尾那一行。
 */
import { Fragment, memo, useMemo, type ReactNode } from 'react';

/** 行内节点。`text` 是纯文本，永远不进 HTML。 */
export type MdInline =
  | { kind: 'text'; value: string }
  | { kind: 'break' }
  | { kind: 'code'; value: string }
  | { kind: 'strong'; children: MdInline[] }
  | { kind: 'em'; children: MdInline[] }
  | { kind: 'del'; children: MdInline[] }
  | { kind: 'link'; href: string; children: MdInline[] };

/** 表格一列的对齐档（由分隔行那一排冒号决定）。 */
export type MdAlign = 'left' | 'center' | 'right';

/** 块级节点。列表项装的是**子块**而不是行内节点，于是「列表项里再放一段代码」是结构上成立的。 */
export type MdBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; children: MdInline[] }
  | { kind: 'paragraph'; children: MdInline[] }
  | { kind: 'list'; ordered: boolean; items: MdBlock[][] }
  | { kind: 'quote'; children: MdBlock[] }
  | { kind: 'code'; lang: string; value: string; closed: boolean }
  | { kind: 'table'; align: MdAlign[]; header: MdInline[][]; rows: MdInline[][][] }
  | { kind: 'hr' };

/**
 * 放行的链接 scheme。`javascript:` / `data:` / `file:` 落到别的分支——
 * 助手正文不可信，而渲染层拿到的是能调主进程的特权上下文（AGENTS.md §8.1）。
 */
const SAFE_SCHEME = /^(?:https?:|mailto:|tel:)/i;

/** 行首的围栏：三个以上反引号或三个以上波浪号，信息串跟在同一行。 */
const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^`\s]*)\s*$/;
/** ATX 标题：`#`～`######` 后必须跟空白或行尾。 */
const HEADING = /^(\s{0,3})(#{1,6})(?:\s+(.*))?$/;
/** 分隔线：同一字符连出三个以上。 */
const HR = /^\s{0,3}(?:-\s*-\s*-[\s-]*|\*\s*\*\s*\*[\s*]*|_\s*_\s*_[\s_]*)$/;
/** 无序列表项。 */
const BULLET = /^(\s*)([-*+])(\s+)(.*)$/;
/** 有序列表项；`1.` 与 `1)` 都认。 */
const ORDERED = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/;
/** 引用行首。 */
const QUOTE = /^\s{0,3}>(.*)$/;
/** 表格分隔行：`| --- | :--: |` 这种形状。 */
const TABLE_DELIMITER = /^\s{0,3}\|?[\s:|-]+\|[\s:|-]*$/;

/** 缩进一格算几列：两个空格。制表符不进这一支——流式片段里的 `\t` 多半是模型的排版习惯，不是层级。 */
const INDENT_WIDTH = 2;

/**
 * 把 URL 判成可安全放进 `href` 的那一支。
 * @param raw 模型写下的原始串（可能带首尾空白）
 * @returns 放行则返回去空白的串；不放行返回 null，调用方按纯文本画（不产 `<a>`）
 */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  return SAFE_SCHEME.test(href) ? href : null;
}

/** 该下标前面是不是一个反斜杠转义（数**连续**的反斜杠，奇数才算转义）。 */
function isEscaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/** 从 `index` 起数同一串定界字符连着有几个（`***` 的三星定界靠它）。 */
function runLength(source: string, index: number, char: string): number {
  let length = 0;
  while (source[index + length] === char) length += 1;
  return length;
}

/** 定界落在词中间就不算强调（`snake_case_name` 不是强调）。CJK 两边都不算词内，所以中文照样能加粗。 */
function isIntraWord(source: string, index: number, length: number): boolean {
  const before = source[index - 1];
  if (before === undefined || before === ' ') return false;
  const after = source[index + length];
  return after !== undefined && after !== ' ' && /[\w]/.test(after);
}

/**
 * 从 `from` 起找与 `delimiter` 配对的收尾定界。
 * @returns 收尾定界的起点；没找到返回 -1
 */
function findCloser(source: string, from: number, delimiter: string): number {
  let cursor = from;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source.startsWith(delimiter, cursor) && !isIntraWord(source, cursor, delimiter.length)) return cursor;
    cursor += 1;
  }
  return -1;
}

/** 纯文本并进节点序列，相邻两段合并成一段（分片拼接时最容易攒出一堆碎 text 节点）。 */
function pushText(nodes: MdInline[], value: string): void {
  if (value === '') return;
  const tail = nodes[nodes.length - 1];
  if (tail?.kind === 'text') tail.value += value;
  else nodes.push({ kind: 'text', value });
}

/**
 * 解析一行内的强调/删除，产出节点与新的扫描位。
 * @returns 命中则返回节点与下一位；没命中返回 null，调用方按字面量处理这一段
 */
function readEmphasis(source: string, start: number): { node: MdInline; next: number } | null {
  const char = source[start];
  if (char === '~') {
    if (!source.startsWith('~~', start) || isEscaped(source, start)) return null;
    const closer = findCloser(source, start + 2, '~~');
    if (closer < 0) return null;
    return { node: { kind: 'del', children: parseInline(source.slice(start + 2, closer)) }, next: closer + 2 };
  }
  if (char !== '*' && char !== '_') return null;
  // 一到三星：三星是「先强调再加重」，两星是加重，一星是强调。
  const length = Math.min(runLength(source, start, char), 3);
  const delimiter = char.repeat(length);
  if (isIntraWord(source, start, length)) return null;
  const closer = findCloser(source, start + length, delimiter);
  if (closer < 0) return null;
  const inner = source.slice(start + length, closer);
  const node: MdInline =
    length === 3
      ? { kind: 'strong', children: [{ kind: 'em', children: parseInline(inner) }] }
      : length === 2
        ? { kind: 'strong', children: parseInline(inner) }
        : { kind: 'em', children: parseInline(inner) };
  return { node, next: closer + length };
}

/** 反引号定界的行内代码：扫到同长度的收尾反引号为止；扫不到就把剩下的全吃进来（流式半截代码）。 */
function readCodeSpan(source: string, start: number): { value: string; next: number } {
  const length = runLength(source, start, '`');
  for (let cursor = start + length; cursor < source.length; cursor += 1) {
    if (source[cursor] !== '`') continue;
    if (runLength(source, cursor, '`') === length)
      return { value: source.slice(start + length, cursor), next: cursor + length };
  }
  return { value: source.slice(start + length), next: source.length };
}

/**
 * 解析 `[文字](地址)`，括号配平（地址里带 `)` 的写法很常见）。
 * @returns 命中则返回子节点、`href`（不放行时为 null）与下一位；括号没配平返回 null
 */
function readLink(source: string, start: number): { href: string | null; children: MdInline[]; next: number } | null {
  let depth = 0;
  let labelEnd = -1;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    if (source[cursor] === '\\') {
      cursor += 1;
      continue;
    }
    if (source[cursor] === '[') depth += 1;
    else if (source[cursor] === ']') {
      depth -= 1;
      if (depth === 0) {
        labelEnd = cursor;
        break;
      }
    }
  }
  if (labelEnd < 0 || source[labelEnd + 1] !== '(') return null;
  let parens = 0;
  let hrefEnd = -1;
  for (let cursor = labelEnd + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === '\\') {
      cursor += 1;
      continue;
    }
    if (source[cursor] === '(') parens += 1;
    else if (source[cursor] === ')') {
      parens -= 1;
      if (parens === 0) {
        hrefEnd = cursor;
        break;
      }
    }
  }
  if (hrefEnd < 0) return null;
  return {
    href: safeHref(source.slice(labelEnd + 2, hrefEnd)),
    children: parseInline(source.slice(start + 1, labelEnd)),
    next: hrefEnd + 1,
  };
}

/**
 * 一行正文 → 行内节点序列。
 *
 * 支持的最小集：转义、`code`、`strong`、`em`、`del`、`link`、硬换行（行尾两个空格或反斜杠）。
 * 认不出来的构造**按字面量原样留下**（一个多出来的 `*` 不该吃掉半句话）。
 * @param text 一行正文
 * @returns 行内节点序列；空串返回空数组
 */
export function parseInline(text: string): MdInline[] {
  const nodes: MdInline[] = [];
  let plain = '';
  let cursor = 0;
  const flush = () => {
    pushText(nodes, plain);
    plain = '';
  };
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === '\\' && cursor + 1 < text.length) {
      if (text[cursor + 1] === '\n') {
        flush();
        nodes.push({ kind: 'break' });
      } else plain += text[cursor + 1];
      cursor += 2;
      continue;
    }
    if (char === '\n') {
      // 裸换行是软换行（并成空格）；硬换行由 `parseParagraph` 写成行尾反斜杠，走上面那一支。
      plain += ' ';
      cursor += 1;
      continue;
    }
    if (char === '`') {
      const span = readCodeSpan(text, cursor);
      flush();
      nodes.push({ kind: 'code', value: span.value.trim() });
      cursor = span.next;
      continue;
    }
    if (char === '[') {
      const link = readLink(text, cursor);
      if (link) {
        flush();
        // scheme 不放行时不产 `<a>`，只留文字：画一个点得动的链接却让它什么都不做，比不画更坏。
        if (link.href === null) nodes.push(...link.children);
        else nodes.push({ kind: 'link', href: link.href, children: link.children });
        cursor = link.next;
        continue;
      }
    }
    if (char === '*' || char === '_' || char === '~') {
      const token = readEmphasis(text, cursor);
      if (token) {
        flush();
        nodes.push(token.node);
        cursor = token.next;
        continue;
      }
    }
    plain += char;
    cursor += 1;
  }
  flush();
  return nodes;
}

/** 行是不是空白（只含空格与制表）。 */
function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** 行首缩进折成几级列表（一级 = 两列）。 */
function indentLevel(line: string): number {
  let spaces = 0;
  while (line[spaces] === ' ') spaces += 1;
  return Math.floor(spaces / INDENT_WIDTH);
}

/** 切表格的一行：去首尾竖线后按竖线切，逐格 trim（格内 `\|` 不做转义——少一根竖线比多一个反斜杠好）。 */
function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** 由分隔行读出逐列对齐档。 */
function readAlign(line: string): MdAlign[] {
  return splitRow(line).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    return right ? 'right' : 'left';
  });
}

/** 行首的列表定界符：不是列表项返回 null。 */
function matchListItem(line: string): { indent: number; ordered: boolean; body: string } | null {
  const bullet = BULLET.exec(line);
  if (bullet) {
    return { indent: Math.floor((bullet[1] ?? '').length / INDENT_WIDTH), ordered: false, body: bullet[4] ?? '' };
  }
  const ordered = ORDERED.exec(line);
  if (ordered) {
    return { indent: Math.floor((ordered[1] ?? '').length / INDENT_WIDTH), ordered: true, body: ordered[5] ?? '' };
  }
  return null;
}

/** 列表解析的一层：`items` 是这一层的条目，`open` 是当前正在写的那个条目。 */
interface ListFrame {
  readonly indent: number;
  readonly ordered: boolean;
  readonly items: MdBlock[][];
  open: MdBlock[] | null;
}

/**
 * 解析一段列表（从 `start` 到第一行不再是它的续行为止），支持按缩进嵌套。
 *
 * 嵌套靠一个栈：进到更深的缩进就压一层，收口时把那一层**作为子列表块挂回上一个条目的尾部**。
 * 同一层上换序（`1.` 之后接 `- `）不另起嵌套，而是把当前层成块收口、另开一节——
 * 两节都要留在块序列里，所以这一支返回的是「若干个列表块」而不是一块。
 * @param lines 全篇行
 * @param start 第一行列表项的下标
 * @returns 这一段产出的列表块与下一段起始下标
 */
function parseList(lines: string[], start: number): { blocks: MdBlock[]; next: number } {
  const baseIndent = matchListItem(lines[start] ?? '')?.indent ?? 0;
  const blocks: MdBlock[] = [];
  const frames: ListFrame[] = [];
  /** 把栈里最浅的那一层成块收口（它是同层的另一节）；更深的那几层挂回上层条目。 */
  const closeDeeperThan = (indent: number, ordered: boolean) => {
    while (frames.length > 1) {
      const top = frames[frames.length - 1];
      const parent = frames[frames.length - 2];
      if (top === undefined || parent === undefined || parent.open === null) break;
      if (top.indent < indent) break;
      if (top.indent === indent && top.ordered === ordered) break;
      frames.pop();
      parent.open.push({ kind: 'list', ordered: top.ordered, items: top.items });
      parent.open = null;
    }
  };
  let cursor = start;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';
    const marker = matchListItem(line);
    if (marker && marker.indent >= baseIndent) {
      closeDeeperThan(marker.indent, marker.ordered);
      const open = frames[frames.length - 1];
      if (open && open.indent === marker.indent && open.ordered !== marker.ordered) {
        frames.pop();
        blocks.push({ kind: 'list', ordered: open.ordered, items: open.items });
      }
      let frame = frames[frames.length - 1];
      if (!frame || frame.indent !== marker.indent || frame.ordered !== marker.ordered) {
        frame = { indent: marker.indent, ordered: marker.ordered, items: [], open: null };
        frames.push(frame);
      }
      const itemBlocks: MdBlock[] = [{ kind: 'paragraph', children: parseInline(marker.body) }];
      frame.items.push(itemBlocks);
      frame.open = itemBlocks;
      cursor += 1;
      continue;
    }
    if (isBlank(line)) {
      // 空行之后若还是这一节的列表项，列表继续；否则收口。
      const following = matchListItem(lines[cursor + 1] ?? '');
      if (following && following.indent >= baseIndent) {
        cursor += 1;
        continue;
      }
      break;
    }
    // 非列表项：缩进比最外层深就是当前条目的续行，否则这一节到此为止。
    if (indentLevel(line) > baseIndent && (frames[frames.length - 1]?.open ?? null) !== null) {
      frames[frames.length - 1]?.open?.push({ kind: 'paragraph', children: parseInline(line.trim()) });
      cursor += 1;
      continue;
    }
    break;
  }
  while (frames.length > 0) {
    const frame = frames.pop();
    if (!frame) break;
    const parent = frames[frames.length - 1];
    if (parent?.open) {
      parent.open.push({ kind: 'list', ordered: frame.ordered, items: frame.items });
      parent.open = null;
    } else blocks.push({ kind: 'list', ordered: frame.ordered, items: frame.items });
  }
  return { blocks, next: cursor };
}

/**
 * 解析围栏代码块。收尾定界必须与开围栏同字符、长度不少于开围栏、且不带信息串。
 * @param fence 开围栏那一行的匹配结果（由调用点判定行首是不是围栏后递进来）
 * @returns 该代码块与下一段起始下标
 */
function parseFence(lines: string[], start: number, fence: RegExpExecArray): { block: MdBlock; next: number } {
  const marker = fence[2] ?? '```';
  const lang = (fence[3] ?? '').trim();
  const body: string[] = [];
  let cursor = start + 1;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';
    const closer = FENCE.exec(line);
    if (closer && (closer[2] ?? '')[0] === marker[0] && (closer[2] ?? '').length >= marker.length) {
      return { block: { kind: 'code', lang, value: body.join('\n'), closed: true }, next: cursor + 1 };
    }
    body.push(line);
    cursor += 1;
  }
  // 没等到收尾：这是流式途中的半截块，照画（见文件头），只把 `closed` 记成 false。
  return { block: { kind: 'code', lang, value: body.join('\n'), closed: false }, next: cursor };
}

/** 引用块：剥掉行首 `>` 后按同一套块级文法再解一遍，于是引用里能有列表与代码。 */
function parseQuote(lines: string[], start: number): { block: MdBlock; next: number } {
  const body: string[] = [];
  let cursor = start;
  while (cursor < lines.length) {
    const quote = QUOTE.exec(lines[cursor] ?? '');
    if (!quote) break;
    body.push(quote[1] ?? '');
    cursor += 1;
  }
  return { block: { kind: 'quote', children: parseBlocks(body) }, next: cursor };
}

/** 表格：表头行 + 分隔行 + 若干正文行。列数对不上就整段回落成段落（半个表格比没有表格更难读）。 */
function parseTable(lines: string[], start: number): { block: MdBlock; next: number } | null {
  const header = lines[start] ?? '';
  const delimiter = lines[start + 1] ?? '';
  if (!header.includes('|') || !TABLE_DELIMITER.test(delimiter)) return null;
  const align = readAlign(delimiter);
  const headerCells = splitRow(header);
  if (align.length !== headerCells.length) return null;
  const rows: MdInline[][][] = [];
  let cursor = start + 2;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';
    if (isBlank(line) || !line.includes('|')) break;
    rows.push(splitRow(line).map((cell) => parseInline(cell)));
    cursor += 1;
  }
  return { block: { kind: 'table', align, header: headerCells.map((cell) => parseInline(cell)), rows }, next: cursor };
}

/**
 * 这一行是否要另起一块。判据必须与 `parseBlocks` 里的分支**逐条对齐**——
 * 多认一个（比如四空格缩进的 `>`）会让段落立刻收口却又没人接那一行，调用循环原地不前进。
 */
function startsNewBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  return (
    FENCE.test(line) ||
    HR.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    matchListItem(line) !== null ||
    (line.includes('|') && TABLE_DELIMITER.test(lines[index + 1] ?? ''))
  );
}

/** 逐段解块。段落里的软换行按空格接续；行尾两个空格或反斜杠的行升级成硬换行。 */
function parseParagraph(lines: string[], start: number): { block: MdBlock; next: number } {
  const buffer: string[] = [];
  let cursor = start;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';
    if (isBlank(line)) break;
    if (cursor > start && startsNewBlock(lines, cursor)) break;
    const hardBreak = /\s{2,}$/.test(line) || line.endsWith('\\');
    // 硬换行写成行尾反斜杠：`parseInline` 靠它认「这一处要断行」，裸换行一律当软换行并成空格。
    buffer.push(hardBreak ? `${line.replace(/(?:\s{2,}|\\)$/, '')}\\\n` : line);
    cursor += 1;
  }
  return { block: { kind: 'paragraph', children: parseInline(buffer.join(' ')) }, next: cursor };
}

/** 全文 → 块序列（引用块内部再走这一支）。 */
function parseBlocks(lines: string[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';
    if (isBlank(line)) {
      cursor += 1;
      continue;
    }
    const fenceLine = FENCE.exec(line);
    if (fenceLine) {
      const fence = parseFence(lines, cursor, fenceLine);
      blocks.push(fence.block);
      cursor = fence.next;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ kind: 'hr' });
      cursor += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const marks = heading[2] ?? '#';
      blocks.push({
        kind: 'heading',
        // 只画 h1–h4：15px 正文里再往下的层级已经分不出轻重，落回段落比堆六档字号好。
        level: Math.min(marks.length, 4) as 1 | 2 | 3 | 4,
        children: parseInline((heading[3] ?? '').replace(/#+\s*$/, '').trim()),
      });
      cursor += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const quote = parseQuote(lines, cursor);
      blocks.push(quote.block);
      cursor = quote.next;
      continue;
    }
    if (matchListItem(line)) {
      const list = parseList(lines, cursor);
      blocks.push(...list.blocks);
      cursor = list.next;
      continue;
    }
    const table = parseTable(lines, cursor);
    if (table) {
      blocks.push(table.block);
      cursor = table.next;
      continue;
    }
    const paragraph = parseParagraph(lines, cursor);
    blocks.push(paragraph.block);
    cursor = paragraph.next;
  }
  return blocks;
}

/**
 * 助手正文 → 块序列。
 * @param source 模型写下的原文（可能正处在流式途中的半截）
 * @returns 块序列；空串返回空数组
 */
export function parseMarkdown(source: string): MdBlock[] {
  return parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'));
}

/**
 * 标题四档的字号与字重。
 * 2026-10-19 设计稿 v2：正文升到 15px 后标题只往下压半档到一档（17/16/15.5/15），
 * 层级靠**字重 + 一根 hairline 下边线**分，不靠字号阶梯——13px 那一族里六档字号本来就分不出轻重。
 */
const HEADING_CLASS: Record<1 | 2 | 3 | 4, string> = {
  1: 'mt-[0.5em] first:mt-0 border-b border-line pb-[0.3em] text-[17px] font-semibold leading-snug text-slate-50',
  2: 'mt-[0.5em] first:mt-0 border-b border-line pb-[0.3em] text-[16px] font-semibold leading-snug text-slate-50',
  3: 'mt-[0.5em] first:mt-0 border-b border-line pb-[0.3em] text-[15.5px] font-semibold leading-snug text-slate-50',
  4: 'mt-[0.5em] first:mt-0 border-b border-line pb-[0.3em] text-[15px] font-semibold leading-snug text-slate-50',
};

/** 表格单元格的三个对齐档。 */
const ALIGN_CLASS: Record<MdAlign, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

/** 未闭合的围栏块：左侧一根强调条，标出「这一段还在写」。 */
const STREAMING_FENCE_CLASS =
  'relative pl-2 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:rounded-full before:bg-celadon';

/**
 * 块与块之间的间距（设计稿 v2 的 `.prose > * + *{margin-top:.95em}`）。
 * 挂在每一块的下沿而不是下一格的上沿：相邻块级外边距会折叠，写在两侧只会让标题那一档读不准。
 */
const BLOCK_GAP = 'mb-[0.95em] last:mb-0';

/** 加重与删除线在 15px 正文里的两档：`strong` 提字重并把颜色提到最亮一档，`del` 只压暗不压小。 */
const STRONG_CLASS = 'font-semibold text-slate-50';
const DEL_CLASS = 'text-slate-400';

/** 把行内节点画成 React。key 用下标——每次重渲染都是同一棵树，不存在跨渲染的节点复用需求。 */
function renderInline(nodes: MdInline[]): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `md-${String(index)}`;
    switch (node.kind) {
      case 'text':
        return <Fragment key={key}>{node.value}</Fragment>;
      case 'break':
        return <br key={key} />;
      case 'code':
        return (
          <code
            key={key}
            className="rounded-chip bg-ink-800 px-1.5 py-0.5 font-mono text-[13px] leading-normal text-slate-100"
          >
            {node.value}
          </code>
        );
      case 'strong':
        return (
          <strong key={key} className={STRONG_CLASS}>
            {renderInline(node.children)}
          </strong>
        );
      case 'em':
        return <em key={key}>{renderInline(node.children)}</em>;
      case 'del':
        return (
          <del key={key} className={DEL_CLASS}>
            {renderInline(node.children)}
          </del>
        );
      case 'link':
        return (
          <a
            key={key}
            href={node.href}
            className="text-celadon underline underline-offset-2"
            target="_blank"
            // 无权打开的页面没有业务知道本面板链到了它，两个 rel 都要（AGENTS.md §8.1 外链默认拒绝）。
            rel="noopener noreferrer"
          >
            {renderInline(node.children)}
          </a>
        );
      default:
        return null;
    }
  });
}

/** 把块序列画成 React。 */
function renderBlocks(blocks: MdBlock[]): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `mdb-${String(index)}`;
    switch (block.kind) {
      case 'heading': {
        const Tag = `h${String(block.level)}` as 'h1';
        return (
          <Tag key={key} className={HEADING_CLASS[block.level]}>
            {renderInline(block.children)}
          </Tag>
        );
      }
      case 'paragraph':
        return (
          <p key={key} className={BLOCK_GAP}>
            {renderInline(block.children)}
          </p>
        );
      case 'list':
        return block.ordered ? (
          <ol key={key} className={`${BLOCK_GAP} list-decimal space-y-[0.42em] pl-[1.6em] marker:text-slate-400`}>
            {block.items.map((item, itemIndex) => (
              <li key={`${key}-${String(itemIndex)}`}>{renderBlocks(item)}</li>
            ))}
          </ol>
        ) : (
          <ul key={key} className={`${BLOCK_GAP} list-disc space-y-[0.42em] pl-[1.6em] marker:text-slate-400`}>
            {block.items.map((item, itemIndex) => (
              <li key={`${key}-${String(itemIndex)}`}>{renderBlocks(item)}</li>
            ))}
          </ul>
        );
      case 'quote':
        return (
          <blockquote key={key} className={`${BLOCK_GAP} border-l-2 border-line-strong pl-[14px] text-slate-300`}>
            {renderBlocks(block.children)}
          </blockquote>
        );
      case 'code':
        return (
          <pre
            key={key}
            data-markdown-code={block.lang}
            data-markdown-closed={String(block.closed)}
            className={`${BLOCK_GAP} overflow-x-auto rounded-control bg-ink-850 px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] text-slate-200 ${block.closed ? '' : STREAMING_FENCE_CLASS}`}
          >
            <code>{block.value}</code>
          </pre>
        );
      case 'table':
        return (
          <div key={key} className={BLOCK_GAP}>
            <table className="w-full border-collapse text-[13px] leading-[1.7]">
              <thead>
                <tr>
                  {block.header.map((cell, cellIndex) => (
                    <th
                      key={`${key}-h-${String(cellIndex)}`}
                      className={`border-b border-line-strong py-1.5 pr-2.5 font-mono text-[11px] font-medium tracking-[0.1em] text-slate-400 ${ALIGN_CLASS[block.align[cellIndex] ?? 'left']}`}
                    >
                      {renderInline(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="[&>tr:last-child>td]:border-b-0">
                {block.rows.map((row, rowIndex) => (
                  <tr key={`${key}-r-${String(rowIndex)}`}>
                    {row.map((cell, cellIndex) => (
                      <td
                        key={`${key}-c-${String(cellIndex)}`}
                        className={`border-b border-line py-[7px] pr-2.5 text-slate-200 ${ALIGN_CLASS[block.align[cellIndex] ?? 'left']}`}
                      >
                        {renderInline(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'hr':
        return <hr key={key} className="my-[1.4em] border-0 border-t border-dashed border-line-strong" />;
      default:
        return null;
    }
  });
}

/**
 * 助手正文 → React 节点树（对话屏唯一的 Markdown 渲染入口）。
 *
 * `memo` 不是省事：流式期间每一片到达都会让整棵对话树重渲染，而这一段文本没变时
 * 重新解一遍文法并重建 DOM 是纯浪费。
 * @param text 助手正文原文
 * @returns 块级 React 节点
 */
export const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <>{renderBlocks(blocks)}</>;
});
