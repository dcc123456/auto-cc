/**
 * 纸上那一格的**读回**口（spec 3.12-01 / 03 / 04；plan `03-resume-pdf` §18 的路线甲）。
 *
 * **为什么单独立一格**：整屏编辑页把打印面上的块直接交给浏览器改（父页给那一格挂 `contenteditable`），
 * 于是"纸上的形状"要有一条回文档的路。这条路只有两件事可做：**把 DOM 机械地摘成一棵语法树**，
 * 以及按写入坐标找回那一格。格式的语义（`- ` / 两空格缩进 / 成对 `**`）一概不在这里解释——
 * 那一份文法住在 `@auto-cc/plugin-resume-doc/richtext` 的 `editableToRaw`（§2.5：正向与反向同一个文件，全仓只一份）。
 * 帧是 `sandbox="allow-same-origin"`（不放开 `allow-scripts`），所以这一格读得到 `childNodes`，
 * 而帧内没有一行脚本在跑（§8.1）。
 */
import type { EditableNode } from '@auto-cc/plugin-resume-doc/richtext';

/** 一格的写入坐标：与 `resume.editor.text` 的前四个实参同一形状（spec 3.11-04）。 */
export interface PaperBlockTarget {
  sectionId: string;
  entryId: string;
  fieldKey: string;
}

/** 焦点落进一格时读回来的那一格：坐标 + 文档里那一格的原文。 */
export interface PaperBlock extends PaperBlockTarget {
  /** 承字的那个节点（打字只改它，改不到「成果:」那一枚标签）。`HTMLElement` 而不是 `Element`：Esc 那一条要能 `blur`。 */
  node: HTMLElement;
  /** 文档里那一格的**原文**（未转义，与 `editableNodesOf` 的产出同一形状，所以能逐字比）。 */
  raw: string;
}

/**
 * 跨 realm 的 duck-typing：帧文档里的节点与父页的构造器**不是同一个**（`instanceof Element` 在跨 realm 恒 false）。
 * @param node 指针事件的目标（可能是帧里的任何节点，也可能根本不是节点）
 * @returns 这一枚能不能往上找祖先
 */
function hasClosest(node: EventTarget | Element | null): node is Element {
  return !!node && typeof (node as Element).closest === 'function';
}

/**
 * 把打印面铺好的每一条格交给编辑态：`contenteditable` 挂在**承字的那个节点**上。
 *
 * 为什么挂那里而不是整格：带标签的那一格（「成果: …」）在 DOM 里是标签 `<span>` + 值节点两只，
 * 整格进编辑态就能把人家的标签一起删掉——那不是"改正文"（spec 3.12-06）。
 * 值节点恒为最后一个元素子节点（标签在前）；标题那一格是纯 `<span>`，没有元素子节点就取它自己。
 * @param paperDoc 纸面帧的文档
 * @returns 铺好的格数（0 = 这一版纸上一个写入坐标都没有）
 */
export function armPaperBlocks(paperDoc: Document): number {
  const cells = Array.from(paperDoc.querySelectorAll('[data-rz-field]'));
  for (const cell of cells) {
    const node = cell.lastElementChild ?? cell;
    node.setAttribute('contenteditable', 'true');
    // 拼写检查在简历上只会添乱：红色波浪线进不了 PDF，却会在纸上画出根本不存在的缺陷。
    node.setAttribute('spellcheck', 'false');
  }
  return cells.length;
}

/**
 * 读回焦点落进的那一格：坐标 + 原文 + 承字节点。
 *
 * 原文从 `data-rz-raw` 读而不是从 `textContent` 抄：正文格被 `renderRichValue` 消化成列表与粗体，
 * 判"这一趟到底改没改"要拿**摘出来的树回成的那一串**与文档里那一格比（spec 3.12-01），
 * 与纸面 HTML 比会把"同一个意思两种写法"当成改动。
 * @param target 事件目标（帧内任意节点，祖先里带 `data-rz-field` 才算一格）
 * @returns 那一格；不是可写格、或 `data-rz-raw` 读不出字符串时回 `undefined`（这一格就不接）
 */
export function paperBlockOf(target: EventTarget | Element | null): PaperBlock | undefined {
  if (!hasClosest(target)) return undefined;
  const cell = target.closest('[data-rz-field]');
  const fieldKey = cell?.getAttribute('data-rz-field');
  const entryId = cell?.closest('[data-rz-entry]')?.getAttribute('data-rz-entry');
  const sectionId = cell?.closest('[data-rz-section]')?.getAttribute('data-rz-section');
  if (!cell || !fieldKey || !entryId || !sectionId) return undefined;
  // 锚点是主进程 `JSON.stringify` 写进去的，读回来仍按那条形状判：帧里的 DOM 是外部面，读不出字符串就当没这一格。
  const parsed: unknown = JSON.parse(cell.getAttribute('data-rz-raw') ?? '""');
  if (typeof parsed !== 'string') return undefined;
  // 打印面在每一格里只写 `<span>`/`<div>`/`<p>`/`<ul>` 这些（`template-kit.ts` 那一份），全是 HTMLElement，
  // 所以这一处收窄不会有运行期风险；类型要它是因为 Esc 那一条要 `blur`。
  return { sectionId, entryId, fieldKey, node: (cell.lastElementChild ?? cell) as HTMLElement, raw: parsed };
}

/** 文本节点的 `nodeType`（跨 realm 只有这个数字是同一份事实，构造器不是）。 */
const TEXT_NODE = 3;
/** 元素节点的 `nodeType`。 */
const ELEMENT_NODE = 1;

/**
 * DOM → 语法树（**只搬形状，不解释格式**）。
 * @param node 那一格的承字节点
 * @returns 它的子节点树：文本节点带 `text`，元素节点带小写标签名与子节点
 */
export function editableNodesOf(node: Node): EditableNode[] {
  const nodes: EditableNode[] = [];
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      nodes.push({ tag: '#text', text: child.nodeValue ?? '', children: [] });
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    nodes.push({
      tag: (child as Element).tagName.toLowerCase(),
      text: '',
      children: editableNodesOf(child),
    });
  }
  return nodes;
}
