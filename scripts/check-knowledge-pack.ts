/**
 * 站点知识包机检（spec 2.2-08，AGENTS.md §2.6「边界校验只在系统边界做」的反面用法）。
 *
 * 要守住的只有一件事：**选择器是数据，不是代码**。于是两条断言：
 * 1. `packages/platform-…/src` 里，知识包目录之外不许出现任何选择器字面量
 *    （适配器只按语义名向 `browser.locate` 要东西，plan §3 规则 3）；
 * 2. 每个 `src/knowledge/*.json` 必须能被 `parseKnowledgePack` 收下——
 *    即结构过 zod、每条定位声明过 `validateSpec`，装不上线的包在 lint 阶段就红，而不是等运行时。
 *
 * 第 2 条故意复用 `browser` 的同一份实现（相对路径直接指向源码）：知识包的判定只能有一个入口，
 * 脚本里再写一遍 zod 就是第二套基础设施（AGENTS.md §2.2 / §2.5）。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseKnowledgePack } from '../packages/browser/src/platform-contract.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(repoRoot, 'packages');
/** 知识包目录名：只有这里的文件允许写选择器。 */
const KNOWLEDGE_DIR = 'knowledge';

const failures: string[] = [];

/** 一条选择器字面量的形状特征（命中任意一条就判「这是选择器，不该写在代码里」）。 */
const SELECTOR_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/^\/\//, 'XPath（以 // 开头）'],
  [/\[@/, 'XPath 的属性谓词（[@…]）'],
  [/#[\w-]+/, 'id 选择器（#…）'],
  [/>/, '选择器组合符（>）'],
  [/\[[^\]]+\]/, '属性选择器（[…]）'],
  [/:(?:nth-|first-|last-|eq|not|empty|hover|contains)/, '伪类（:nth-… 等）'],
  [/(^|\s)\.[a-zA-Z_-]/, 'class 选择器（.name）'],
];

/** 地址与模块说明符不是选择器：`http://…` 里的 `//`、`from './x.js'` 里的 `./` 都是误报源。 */
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * 判断一个字符串字面量像不像选择器。
 * @param text 字符串的内容（已去掉引号，不含模板插值）
 * @returns 命中的特征描述；不像选择器时返回 null
 */
function selectorShapeOf(text: string): string | null {
  if (!text.trim() || URL_LIKE.test(text)) return null;
  // 形如 `a.b` / `platform.boss` / `./adapter.js` 这种**不含空格、方括号、井号、尖括号**的点号串
  // 是 service 名、模块路径或小数，不是选择器（选择器要么有组合结构，要么有 .name 前导点）。
  if (!/[[\]#>/:]/.test(text) && !text.startsWith('.')) return null;
  for (const [pattern, label] of SELECTOR_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

/**
 * 从一份 TS/JS 源码里摘出**字符串字面量**，注释与模板插值一律不算。
 *
 * 只做词法级别的扫描（不引解析器）：三态推进——代码、行注释、块注释——外加字符串态。
 * 落在 `from` / `import` / `require` 之后的字面量是模块说明符，直接跳过，
 * 因为 `import … from './x.js'` 里的 `./` 长成 XPath 的样子。
 * @param source 源码文本
 * @returns `[字符串内容, 起始下标]` 的列表，起始下标用来把命中换算成行号
 */
function stringLiteralsOf(source: string): [string, number][] {
  const found: [string, number][] = [];
  const previousWord = (at: number): string => {
    const before = source.slice(0, at).match(/(\w+)(\s*)$/);
    return before?.[1] ?? '';
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      const start = index;
      let text = '';
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') {
          text += source[index + 1] ?? '';
          index += 2;
          continue;
        }
        // 模板插值里装的是表达式（`DELIVERED_BY[method]` 这类），不是页面结构，整段跳过。
        if (quote === '`' && source[index] === '$' && source[index + 1] === '{') {
          index += 2;
          let depth = 1;
          while (index < source.length && depth > 0) {
            if (source[index] === '{') depth += 1;
            if (source[index] === '}') depth -= 1;
            index += 1;
          }
          continue;
        }
        if (quote !== '`' && source[index] === '\n') break;
        text += source[index] ?? '';
        index += 1;
      }
      const specifierKeyword = previousWord(start);
      if (!['from', 'import', 'require'].includes(specifierKeyword)) found.push([text, start]);
      continue;
    }
  }
  return found;
}

/** 递归列出目录下的文件。 */
async function filesIn(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesIn(full)));
    else found.push(full);
  }
  return found;
}

/** 相对仓库根的路径，报错时才指得清是哪个文件。 */
const relative = (file: string): string => path.relative(repoRoot, file).replaceAll('\\', '/');

/** 这个文件属于知识包目录吗（只有那里允许写选择器）。 */
const isKnowledgeFile = (file: string): boolean => relative(file).includes(`/${KNOWLEDGE_DIR}/`);

const platformPackages = (await readdir(packagesDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('platform-'))
  .map((entry) => path.join(packagesDir, entry.name, 'src'));

for (const srcDir of platformPackages) {
  let files: string[];
  try {
    files = await filesIn(srcDir);
  } catch {
    // 平台包的 `src` 缺席说明这个目录是空的占位，交给 §4.4 的孤儿文件条目处理，这里不编造失败。
    continue;
  }

  // 1) 选择器字面量只许出现在知识包目录里（spec 2.2-08 的前半条）
  for (const file of files.filter((item) => !isKnowledgeFile(item) && /\.(ts|tsx|mts|cts)$/.test(item))) {
    const source = await readFile(file, 'utf8');
    for (const [text, start] of stringLiteralsOf(source)) {
      const shape = selectorShapeOf(text);
      if (!shape) continue;
      const line = source.slice(0, start).split('\n').length;
      failures.push(
        `${relative(file)}:${String(line)} 出现选择器字面量（${shape}）：${text}\n      选择器属于站点知识包，请写进 src/${KNOWLEDGE_DIR}/*.json 后用语义名取用（spec 2.2-08）`,
      );
    }
  }

  // 2) 每个知识包都必须能被内核侧那份唯一实现收下（spec 2.2-08 的后半条）
  for (const file of files.filter((item) => isKnowledgeFile(item) && item.endsWith('.json'))) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
    } catch (error) {
      failures.push(`${relative(file)} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    try {
      const pack = parseKnowledgePack(raw);
      // 空 locators 的包能过 schema，但没有任何可定位的东西，等于没交付；这里补一条语义下限。
      if (Object.keys(pack.locators).length === 0) {
        failures.push(`${relative(file)} 里一条定位声明都没有，适配器无从按语义名取用`);
      }
    } catch (error) {
      const problems = (error as { details?: { problems?: string[] } }).details?.problems;
      failures.push(
        `${relative(file)} 未通过 parseKnowledgePack：${error instanceof Error ? error.message : String(error)}${
          problems ? `\n      ${problems.join('\n      ')}` : ''
        }`,
      );
    }
  }
}

if (failures.length) {
  console.error('✖ 站点知识包检查未通过（spec 2.2-08：选择器是数据，不是代码）：');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`✔ 站点知识包检查通过（扫描 ${String(platformPackages.length)} 个平台包，选择器只在知识包目录里）`);
