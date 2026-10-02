/**
 * 机检脚本共用的仓库扫描件（AGENTS.md §2.2/§2.5：同一条口径只许有一份）。
 *
 * 这些片段原来在各检查脚本里各抄一份：`filesIn` 有 4 份、`isTestOnlyModule` 有 2 份、
 * `stringLiteralsOf` 有 1 份但被 5.1-b 的工具契约检查第二次需要。抄写的代价不是行数，
 * 是口径漂移——比如"哪些文件算测试替身"这条，两份各自的注释都在说"与另一处逐字相同"，
 * 那正是靠注释维持、而不是靠代码维持的不变量。
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

/** 仓库根：本文件在 `scripts/internal/` 下，往上两层。 */
export const repoRoot = path.resolve(import.meta.dirname, '../..');

/** 各包目录的父目录，几乎所有检查都从这里起步。 */
export const packagesDir = path.join(repoRoot, 'packages');

/** 构建产物与依赖目录，扫描时一律不进。 */
const SKIPPED_DIRS = ['node_modules', 'dist', 'out'];

/**
 * 相对仓库根的路径，报错时才指得清是哪个文件；分隔符归一成 `/` 以便与模式串比对。
 * @param file 绝对路径
 * @returns 形如 `packages/browser/src/index.ts` 的相对路径
 */
export const relative = (file: string): string => path.relative(repoRoot, file).replaceAll('\\', '/');

/**
 * 只服务于测试的文件：断言替身与用例，不是真实实现。
 *
 * 后者不能叫 `.test.ts`——那样 vitest 会把它当一个套件收集并报"没有任何用例"，
 * 而它存在的理由正是 §2.2（同一个替身在多处各抄一份就是重复实现）。
 * @param rel 相对仓库根的路径（分隔符已归一为 `/`）
 * @returns 该文件不该被当成"真实实现的落点"时为 true
 */
export const isTestOnlyModule = (rel: string): boolean =>
  /\.(?:test|spec)\.[cm]?ts$/.test(rel) || rel.endsWith('/test-doubles.ts');

/**
 * 递归列出目录下的文件（跳过构建产物与依赖）。
 * @param dir 起始目录
 * @param accept 文件名白名单，缺省收全部文件
 * @returns 绝对路径列表
 */
export async function filesIn(dir: string, accept: (name: string) => boolean = () => true): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRS.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesIn(full, accept)));
    else if (accept(entry.name)) found.push(full);
  }
  return found;
}

/**
 * 列出 `packages/*` 下的包目录（绝对路径）。
 *
 * 各检查的起点都是"每一个包都要看一眼"，只有知识包检查额外只要 `platform-*`，
 * 所以过滤留在调用点，而不是在公共层做一套包分类。
 * @param accept 包目录名的白名单，缺省收全部
 * @returns 包目录的绝对路径列表
 */
export async function packageDirs(accept: (name: string) => boolean = () => true): Promise<string[]> {
  const entries = await readdir(packagesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && accept(entry.name))
    .map((entry) => path.join(packagesDir, entry.name));
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
export function stringLiteralsOf(source: string): [string, number][] {
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

/**
 * 把字符串字面量与注释的内容抹成空格，长度与下标保持不变。
 *
 * 需要按括号配对找对象字面量边界时，必须先要一份"只剩结构"的文本：
 * `description: '这里有 } 和大括号'` 若不被抹掉，配对会在字符串内部提前收尾。
 * 口径与 `stringLiteralsOf` **故意不同**：那个要跳过 `from '…'` 的模块说明符（选择器检查不该把
 * import 路径当字面量看），这个要把一切非结构文本抹干净（配对只看结构），所以不是同一件事。
 * @param source 源码文本
 * @returns 同长度的文本，字符串与注释的内容变成空格（定界符保留）
 */
export function blankOutStringsAndComments(source: string): string {
  const chars = source.split('');
  const blank = (from: number, to: number): void => {
    for (let index = from; index < Math.min(to, chars.length); index += 1) {
      // 换行必须原样留着：抹平会让行号与列号失真，报错时指不到位置。
      if (chars[index] !== '\n') chars[index] = ' ';
    }
  };
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (char === '/' && chars[index + 1] === '/') {
      const start = index;
      while (index < chars.length && chars[index] !== '\n') index += 1;
      blank(start, index);
      index -= 1;
      continue;
    }
    if (char === '/' && chars[index + 1] === '*') {
      const start = index;
      while (index < chars.length && !(chars[index] === '*' && chars[index + 1] === '/')) index += 1;
      blank(start, index + 1);
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const start = index;
      index += 1;
      while (index < chars.length && chars[index] !== char) {
        if (chars[index] === '\\') index += 1;
        // 非反引号字符串里出现换行 = 词法错误（本仓不会有），就地停止避免把后面整段吞掉。
        if (char !== '`' && chars[index] === '\n') break;
        index += 1;
      }
      blank(start + 1, index);
      continue;
    }
  }
  return chars.join('');
}
