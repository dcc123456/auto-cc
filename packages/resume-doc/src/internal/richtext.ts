/**
 * 一段正文 → 块级结构（spec 3.9-01；封闭文法与裁定㉘ 见 plan `03-resume-pdf` §14）。
 *
 * **为什么存在**：`toEntryView` 递出来的正文是一个已转义的多行字符串，而渲染层过去把它塞进**一只** `<span>`
 * （`template-kit.ts` 的正文格）——HTML 里换行只是空白字符，于是 22 行的项目经历在纸面上塌成一整段自动换行。
 * 用户要的「简介也支持列表、项目经历按列表、甚至分层、关键字加重」在这一格里从来**没有过入口**：
 * 内容一直都在，是渲染把它压平了。本文件就是那只入口，且是全仓唯一的一处（AGENTS.md §2.5）。
 *
 * **文法是封闭的**（不是 Markdown 子集，因此不引 `marked`/`markdown-it`，见 spec 3.9-04 的反向验证）：
 * `- ` 开一级列表项、两个 ASCII 空格 + `- ` 开二级列表项（**最多两级**，更深按二级折叠）、
 * 成对 `**…**` 是行内加重，其余非空行是段落，空行断开列表。
 * **有序列表刻意不认**：`1.` 里的数字会进 4.5-08 的数字守恒判据，认了就等于给事实校验埋一个歧义源
 * （记账在 spec 4.5-15 的反向验证段）。
 *
 * 分层口径：模板仍然「只排版不加工数据」（3.2-05）——本文件只产结构，**类名挂在调用方给的槽位上**；
 * 转义仍然只在 `bind.ts` 那一处（3.2-07 的注入面防护），本文件吃的是**已转义**的文本：
 * 标记字符（`-` 空格 `*`）都不在 `escapeHtml` 的改写集合里，所以在转义之后切块与在转义之前切块等价，
 * 而正文里的字面 `<b>` 到这一步已经是 `&lt;b&gt;`，永远不可能被本文件解释成标签。
 */

/** 一级列表项的行首标记：导入轨归一后写进来、生成轨按提示词写进来的都是这一串。 */
export const BULLET_MARK = '- ';

/** 二级列表项在一级之外多出的缩进（两个 ASCII 空格，不用制表符——PDF 文本层的 `str` 里 `\t` 不可靠）。 */
export const NESTED_INDENT = '  ';

/** 列表项的层级：0 段落、1 一级、2 二级（再深的缩进按 2 折叠，见文件头的两级封顶）。 */
type RichLevel = 0 | 1 | 2;

/** 一行的解析结果。`content` 是去掉行首标记后的行内文本（仍为已转义串）。 */
interface RichLine {
  level: RichLevel;
  content: string;
}

/**
 * 把一段已转义正文切成逻辑行（`RichValue` 的第一半，块与列表的装配只看这个）。
 * 判定顺序固定为「先数行首空格 → 再认 `- `」，因为二级标记的定义就是「缩进 + 一级标记」；
 * 空行不产出条目，它的作用是**断开列表**（由装配阶段按不连续处切分）。
 * @param escaped 已转义的正文（`toEntryView` 递出来的那格）
 * @returns 非空逻辑行数组，顺序与原文一致
 */
function toRichLines(escaped: string): RichLine[] {
  const lines: RichLine[] = [];
  for (const physical of escaped.split('\n')) {
    if (physical.trim() === '') continue;
    const indentLength = physical.length - physical.replace(/^ +/, '').length;
    const rest = physical.slice(indentLength);
    if (rest.startsWith(BULLET_MARK) && rest.slice(BULLET_MARK.length).trim() !== '') {
      lines.push({ level: indentLength >= NESTED_INDENT.length ? 2 : 1, content: rest.slice(BULLET_MARK.length) });
      continue;
    }
    lines.push({ level: 0, content: physical.trim() });
  }
  return lines;
}

/**
 * 行内加重：成对 `**…**` 换成 `<strong>`，落单的那个原样留着（正文里真有一个星号组不成的串时，
 * 那是内容而不是格式——猜它是格式会把用户的字面量吃掉）。
 * @param content 单行行内文本（已转义）
 * @returns 可以塞进 `<p>` / `<li>` 的行内 HTML
 */
function inlineHtml(content: string): string {
  return content.replace(PAIRED_EMPHASIS, '<strong class="font-bold">$1</strong>');
}

/** 成对的行内加重：与 `inlineHtml` 共用同一个模式，因此「渲染认成加粗的」与「保留标记的」永远是同一批字符。 */
const PAIRED_EMPHASIS = /\*\*([^*]+)\*\*/g;

/**
 * 只保留**成对**的 `**`，把落单的那些删掉（spec 4.1-18 的「`**` 成对时保留、落单时删除」）。
 *
 * 为什么导入轨需要这一支而不是直接用 `stripLineMarkup`：删掉全部星号会让 DOCX / Markdown 语料里
 * 本来就写对的加重在纸面上消失（那正是用户要的「关键字加重」），而**留着**落单的那些又会在渲染层
 * 原样打印出 `**` 给招聘者看。这一支把两种结局分开：落在 `PAIRED_EMPHASIS` 命中区间外的 `**` 删，
 * 命中的整段（含标记）留给渲染层。与 `stripRichMarkers` 的分工不同——那一支服务于事实校验，
 * 它必须连成对的一起删掉，因为校验比的是纯文本。
 * @param text 行内文本（可含任意位置的 `**`）
 * @returns 成对标记原样保留、其余 `**` 已删除的文本
 */
export function keepPairedEmphasis(text: string): string {
  let kept = '';
  let cursor = 0;
  for (const match of text.matchAll(PAIRED_EMPHASIS)) {
    const matchedFrom = match.index ?? cursor;
    kept += text.slice(cursor, matchedFrom).replace(/\*\*/g, '') + match[0];
    cursor = matchedFrom + match[0].length;
  }
  return kept + text.slice(cursor).replace(/\*\*/g, '');
}

/**
 * 装配一段列表：一级开一只 `<ul>`，其后的二级项挂进**上一条一级 `<li>` 内部**的 `<ul>`。
 * 一条二级项前面没有一级项时按一级处理（容错口径见判据：不许因为导入轨多写了一档缩进就丢整行）。
 * @param run 连续的同一段列表逻辑行（调用方保证至少一条是列表项）
 * @returns `<ul>` 串
 */
function renderListRun(run: RichLine[]): string {
  // 存的是每条一级项的**内部** HTML，`<li>` 外壳留到最后统一包——否则二级列表会被接到 `</li>` 之后，
  // 成了一只悬在 `<ul>` 直属位置的第二层，浏览器会把它折回同级，分层就在纸面上消失了。
  const items: string[] = [];
  let nested: string[] = [];
  const flushNested = (): void => {
    if (nested.length === 0) return;
    items[items.length - 1] += `<ul class="list-circle pl-4">${nested.join('')}</ul>`;
    nested = [];
  };
  for (const line of run) {
    if (line.level === 2 && items.length > 0) {
      nested.push(`<li>${inlineHtml(line.content)}</li>`);
      continue;
    }
    flushNested();
    items.push(inlineHtml(line.content));
  }
  flushNested();
  return `<ul class="list-disc pl-4 mt-1">${items.map((inner) => `<li>${inner}</li>`).join('')}</ul>`;
}

/**
 * 解析一段正文并装配成块。
 * @param escaped 已转义的正文
 * @returns 块级 HTML 串（段落 `<p>` 与列表 `<ul>` 依次拼接）；空正文得空串
 */
function renderBlocks(escaped: string): string {
  const lines = toRichLines(escaped);
  const blocks: string[] = [];
  let listRun: RichLine[] = [];
  const flushList = (): void => {
    if (listRun.length === 0) return;
    blocks.push(renderListRun(listRun));
    listRun = [];
  };
  for (const line of lines) {
    if (line.level > 0) {
      listRun.push(line);
      continue;
    }
    // 段落行断开上一条列表：空行在 `toRichLines` 里已被丢弃，所以「换到一个段落」就是断开的信号。
    flushList();
    blocks.push(`<p>${inlineHtml(line.content)}</p>`);
  }
  flushList();
  return blocks.join('');
}

/** 一段正文的渲染决定：`block` 为 false 时 `html` 是行内串（沿用调用方原来的 `<span>` 那一格）。 */
export interface RichValue {
  /** 是否需要块级容器（true = 调用方要把这一格从 `<span>` 换成 `<div>`）。 */
  block: boolean;
  /** 该格的内容 HTML：行内时是纯文本或 `<strong>`，块级时是 `<p>`/`<ul>` 序列。 */
  html: string;
}

/**
 * 一段正文 → 渲染决定（渲染轨唯一的那只入口，`template-kit.ts` 的正文格只调它）。
 *
 * 三条判定与它们各自守的判据：
 * ① 空正文 → `{block:false, html:''}`，与转换前逐字节相同（3.1-04 的容错：缺格不报错）；
 * ② **单行且不带列表标记** → 行内串，无 `**` 时与旧的 `<span>` 内容**逐字节相同**（spec 3.9-01 的负对照）；
 * ③ 其余（多行 / 任意列表项）→ 块级 HTML，这是本片要修的那个「全是自动换行」的形态。
 * @param escaped 已转义的正文
 * @returns 渲染决定
 */
export function renderRichValue(escaped: string): RichValue {
  if (escaped.trim() === '') return { block: false, html: escaped };
  const lines = toRichLines(escaped);
  const onlyLine = lines.length === 1 ? lines[0] : undefined;
  if (onlyLine !== undefined && onlyLine.level === 0) {
    return { block: false, html: inlineHtml(onlyLine.content) };
  }
  return { block: true, html: renderBlocks(escaped) };
}

/**
 * 剥掉行标记只留纯文本（spec 4.5-16：事实校验比数字之前先过这一层）。
 *
 * **为什么必须存在**：数字守恒（`fact-check.ts` 走 `core/src/numbers.ts` 的 `NUMBER_RUN`）是按字符扫的，
 * 而裁定㉘ 第 1 条要模型自己在成果词外面包 `**`、把长段拆成 `- `。少了这一层，
 * 模型**如实**改写出的 `- **P99 延迟下降 40%**` 会因为多了几个字符而被判成数字被改动，
 * 于是「鼓励标注」直接等于「标注即作废」。
 * 吃原始串与吃已转义串结果一致——标记字符不在转义改写集合里，因此这一处不需要区分两者（§2.1 名单只一份）。
 * @param text 正文（模型的产出或文档里的值，可含行标记）
 * @returns 去掉 `- ` 前缀、缩进与成对/落单 `**` 后的纯文本，行与行之间以单个换行相接
 */
export function stripRichMarkers(text: string): string {
  return toRichLines(text)
    .map((line) => line.content.replace(/\*\*/g, ''))
    .join('\n');
}
